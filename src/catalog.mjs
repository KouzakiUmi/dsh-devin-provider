import { readFile } from 'node:fs/promises';
import { CLI_VERSION, DEFAULT_SERVER, MODEL_CONFIGS_RPC, PB, dec, fields, metadata } from './pb.mjs';
import { CORE_THINKING_LEVELS, FUSION_MODEL_ID, ROUTE_DISPLAY_NAME, ROUTE_ID, assertModelId } from './state.mjs';
import { fusionRouteIndex, parseFusionRoute, selectFusionRoute } from './fusion-routes.mjs';
import { isCurrentModelFamily } from './model-generations.mjs';

export const snapshotData = JSON.parse(await readFile(new URL('./catalog-snapshot.json', import.meta.url), 'utf8'));

export const isClaude = (id) => /claude/i.test(String(id));

export function familiesOf(rows) {
  return rows.map(([uid, label, aliases, vs]) => ({
    uid,
    label,
    aliases,
    models: vs.map(([id, name, context, output]) => ({ id, name, context, output }))
  }));
}

export const SNAPSHOT_FAMILIES = familiesOf(snapshotData.families);
export const SNAPSHOT_FREE = Array.isArray(snapshotData.freeIds) ? snapshotData.freeIds : [];
export const SNAPSHOT_PRICES = snapshotData.prices && typeof snapshotData.prices === 'object' ? snapshotData.prices : {};
export const SNAPSHOT_FUSION_ROUTES = snapshotData.fusionRoutes;
const NO_IMAGES = new Set(snapshotData.noImages);
export const SNAPSHOT_IMAGES = Object.fromEntries(
  snapshotData.families.flatMap(([, , , vs]) => vs.map(([id]) => [id, !NO_IMAGES.has(id)]))
);

export const LEVEL_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const LEVELS = [
  ['none', 'none'],
  ['xhigh', 'xhigh'],
  ['minimal', 'minimal'],
  ['min', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['max', 'max']
];
const TIERS = [
  ['fast', 'Fast'],
  ['priority', 'Priority'],
  ['lightning', 'Lightning']
];
const FAST_TIERS = ['lightning', 'fast', 'priority'];
const FAST_TIER_LABELS = { lightning: 'Lightning', fast: 'Fast', priority: 'Fast' };
const fastLabelOf = (tier, models) => tier === 'lightning' && models.some((m) => /\bUltrafast\b/i.test(m?.name))
  ? 'Ultrafast' : FAST_TIER_LABELS[tier] || 'Fast';
const FAST_ID_SUFFIX_RE = /-(?:lightning|fast|priority)(?:-(?:none|minimal|min|low|medium|high|xhigh|max))?$/i;

export const isFastVariantId = (id) => FAST_ID_SUFFIX_RE.test(String(id ?? ''));

export function levelOf(id) {
  const low = String(id).toLowerCase();
  for (const [word, level] of LEVELS) {
    if (low.endsWith('-' + word) || low.endsWith('_' + word)) return level;
  }
  return '';
}

export function tierOf(id) {
  const low = String(id).toLowerCase();
  for (const [word] of TIERS) {
    for (const sep of ['-', '_']) {
      if (low.endsWith(sep + word)) {
        const l = levelOf(low.slice(0, -(sep + word).length));
        if (l) return [word, l];
      }
    }
  }
  return ['', levelOf(id)];
}

const named = (f, id) => f.uid === id || (Array.isArray(f.aliases) && f.aliases.includes(id));

export function byLevel(f, tier) {
  const out = {};
  for (const m of f.models ?? []) {
    const [t, l] = tierOf(m.id);
    if (t === tier && l && m.id !== f.uid && !out[l]) out[l] = m.id;
  }
  return out;
}

export const efforts = (f, tier) => {
  const by = byLevel(f, tier);
  return LEVEL_RANK.filter((l) => by[l]);
};

export const tiers = (f) => TIERS.map(([w]) => w).filter((t) => Object.keys(byLevel(f, t)).length > 0);

function suffixed(id) {
  const i = id.lastIndexOf('-');
  if (i < 0) return false;
  const word = id.slice(i + 1).toLowerCase();
  return !TIERS.some(([w]) => w === word) && levelOf(id.slice(0, i)) !== '';
}

export function defaultModel(f) {
  return f.models.find((m) => !suffixed(m.id)) ?? f.models[0];
}

export function defaultLevel(f) {
  if (f.models.length) {
    const [t, l] = tierOf(defaultModel(f).id);
    if (!t && l) return l;
  }
  return 'medium';
}

export function nearest(want, levels) {
  const at = LEVEL_RANK.indexOf(want);
  if (at < 0 || !levels.length || levels.includes(want)) return want;
  let best = want;
  let dist = LEVEL_RANK.length;
  for (const l of levels) {
    const i = LEVEL_RANK.indexOf(l);
    const d = Math.abs(i - at);
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d];
  }
  return best;
}

function fastSiblingOf(families, baseFamily) {
  if (!Array.isArray(families) || !baseFamily?.uid) return null;
  for (const tier of FAST_TIERS) {
    const sibling = families.find((g) => g !== baseFamily && named(g, `${baseFamily.uid}-${tier}`));
    if (sibling?.models?.length) return { tier, family: sibling };
  }
  return null;
}

function baseUidForFastFamily(families, family) {
  if (!Array.isArray(families) || !family?.uid) return null;
  for (const tier of FAST_TIERS) {
    if (!family.uid.endsWith('-' + tier)) continue;
    const base = family.uid.slice(0, -(tier.length + 1));
    if (families.some((g) => g !== family && named(g, base))) return { tier, base };
  }
  return null;
}

export function fastTierOf(family, families = []) {
  return FAST_TIERS.find((tier) => Object.keys(byLevel(family, tier)).length > 0)
    || fastSiblingOf(families, family)?.tier
    || '';
}

export function fastModelMap(families, { fusionFast = false } = {}) {
  const out = {};
  for (const f of families ?? []) {
    if (baseUidForFastFamily(families, f)) continue;
    const directTier = FAST_TIERS.find((tier) => Object.keys(byLevel(f, tier)).length > 0) ?? '';
    if (directTier) {
      const ls = efforts(f, directTier);
      if (ls.length) {
        out[f.uid] = { tier: directTier, label: fastLabelOf(directTier, f.models), efforts: ls };
        continue;
      }
    }
    const sib = fastSiblingOf(families, f);
    if (sib) {
      out[f.uid] = { tier: sib.tier, label: fastLabelOf(sib.tier, sib.family.models), efforts: efforts(sib.family, '') };
    }
  }
  if (fusionFast) {
    out[FUSION_MODEL_ID] = { tier: 'fast', label: 'Fast', efforts: [] };
  }
  return out;
}

// Map DSH effort ('off') to Devin's effort ('none') before resolving variant.
const toDevinEffort = (e) => (e === 'off' ? 'none' : e);

export function variantFor(families, model, effort, { fast = false } = {}) {
  const devinEffort = toDevinEffort(effort);
  for (const f of families) {
    if (!named(f, model) || !f.models?.length) continue;
    if (fast) {
      const directFt = FAST_TIERS.find((t) => Object.keys(byLevel(f, t)).length > 0) ?? '';
      if (directFt) {
        const ls = efforts(f, directFt);
        const by = byLevel(f, directFt);
        if (devinEffort && ls.length) {
          const id = by[nearest(devinEffort, ls)];
          if (id) return id;
        }
        if (ls.length) return by[nearest(defaultLevel(f), ls)] || by[ls[0]];
      }
      const sib = fastSiblingOf(families, f);
      if (sib) {
        const s = sib.family;
        const ls = efforts(s, '');
        const by = byLevel(s, '');
        const pick = devinEffort && ls.length ? by[nearest(devinEffort, ls)] : undefined;
        // For sibling fast families where max-level is bare defaultModel (e.g. swe-1-7-lightning vs -medium):
        if (pick && (!devinEffort || ['none', 'minimal', 'low', 'medium'].includes(devinEffort) || ls.includes(devinEffort))) {
          return pick;
        }
        return defaultModel(s)?.id || pick || s.models[0].id;
      }
    }
    const ls = efforts(f, '');
    const by = byLevel(f, '');
    if (devinEffort && ls.length) {
      const id = by[nearest(devinEffort, ls)];
      if (id) return id;
    }
    if (defaultModel(f)) {
      if (devinEffort) {
        const id = by[nearest(devinEffort, ls)];
        if (id) return id;
      }
      return defaultModel(f).id;
    }
  }
  for (const f of families) {
    for (const tier of tiers(f)) {
      if (!model.endsWith('-' + tier) || !named(f, model.slice(0, -(tier.length + 1)))) continue;
      const by = byLevel(f, tier);
      const ls = efforts(f, tier);
      return by[nearest(devinEffort || defaultLevel(f), ls)] || by[ls[0]];
    }
  }
  if (families !== SNAPSHOT_FAMILIES && !families.some((f) => f.models?.some((m) => m.id === model))) {
    return variantFor(SNAPSHOT_FAMILIES, model, effort, { fast });
  }
  return model;
}

function familyImages(f, images) {
  let said;
  for (const m of f.models ?? []) {
    const v = images[m.id];
    if (typeof v !== 'boolean') continue;
    if (said !== undefined && said !== v) return undefined;
    said = v;
  }
  return said;
}

export function listed(families, images = {}, free = new Set(), prices = new Map()) {
  const priced = (ids) => {
    const defined = ids.map((id) => prices.get(id)).filter(Boolean);
    if (!defined.length || defined.some((p) => JSON.stringify(p) !== JSON.stringify(defined[0]))) return undefined;
    return defined[0];
  };
  const freeFlags = (ids) => {
    const any = ids.some((id) => free.has(id));
    const every = ids.length > 0 && ids.every((id) => free.has(id));
    return { free: every, ...(any && !every ? { mixedFree: true } : {}) };
  };
  const costFlags = (ids) => {
    const defined = ids.map((id) => prices.get(id)).filter(Boolean);
    if (defined.length > 1 && defined.some((p) => JSON.stringify(p) !== JSON.stringify(defined[0]))) return { mixedCost: true };
    const cost = priced(ids);
    return cost ? { cost } : {};
  };
  const own = (f, t) => {
    const ids = Object.values(byLevel(f, t));
    if (!t && f.models.length && !ids.includes(defaultModel(f).id)) ids.push(defaultModel(f).id);
    return ids;
  };
  const fastMetaFor = (f) => {
    const directTier = FAST_TIERS.find((t) => Object.keys(byLevel(f, t)).length > 0) ?? '';
    const sib = directTier ? null : fastSiblingOf(families, f);
    const ft = directTier || sib?.tier || '';
    if (!ft) return {};
    const ids = directTier ? Object.values(byLevel(f, directTier)) : (sib?.family?.models ?? []).map((m) => m.id);
    const cf = costFlags(ids);
    return {
      fastTier: ft,
      fastLabel: fastLabelOf(ft, directTier ? f.models : sib.family.models),
      ...(cf.cost ? { fastCost: cf.cost } : {}),
      ...(cf.mixedCost ? { fastMixedCost: true } : {})
    };
  };
  const out = [];
  const seen = new Set();
  const add = ({ free: isFree, cost, mixedFree, mixedCost, fastTier, fastLabel, fastCost, fastMixedCost, legacy, ...m }) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    out.push({
      ...m,
      ...(isFree ? { free: true } : {}),
      ...(mixedFree ? { mixedFree: true } : {}),
      ...(cost ? { cost } : {}),
      ...(mixedCost ? { mixedCost: true } : {}),
      ...(fastTier ? { fastTier, fastLabel } : {}),
      ...(fastCost ? { fastCost } : {}),
      ...(fastMixedCost ? { fastMixedCost: true } : {}),
      ...(legacy ? { legacy: true } : {})
    });
  };
  for (const f of families) {
    // 快速模式变体（-lightning / -fast / -priority）不在模型列表中单独展示，统一通过 ⚡ 快速模式开关触发。
    if (baseUidForFastFamily(families, f)) continue;
    const context = f.models.find((m) => m.context)?.context ?? 0;
    const output = f.models.find((m) => m.output)?.output ?? 0;
    const image = familyImages(f, images);
    const isLegacy = !isCurrentModelFamily(f.uid);
    add({
      id: f.uid,
      name: f.label,
      context,
      output,
      efforts: efforts(f, ''),
      image,
      legacy: isLegacy,
      ...freeFlags(own(f, '')),
      ...costFlags(own(f, '')),
      ...fastMetaFor(f)
    });
    if (f.models.length === 1) continue;
    for (const m of f.models) {
      if (m.id === f.uid || tierOf(m.id)[1] || isFastVariantId(m.id)) continue;
      add({
        id: m.id,
        name: m.name,
        context: m.context || context,
        output: m.output || output,
        efforts: [],
        image: images[m.id],
        free: free.has(m.id),
        cost: prices.get(m.id),
        legacy: isLegacy
      });
    }
  }
  return out;
}

// ── Protobuf & CLI catalog parsing ──────────────────────────────────────────────

export function parseModelConfigs(b) {
  const out = {};
  for (const f of fields(b)) {
    if (f.num !== 1 || f.wire !== 2) continue;
    let uid = '';
    let images = false;
    for (const g of fields(f.data)) {
      if (g.num === 22 && g.wire === 2) uid = dec.decode(g.data);
      else if (g.num === 5 && g.wire === 0) images = g.n !== 0;
    }
    if (uid) out[uid] = images;
  }
  return Object.keys(out).length ? out : null;
}

const FREE_TIER = 4;

export function parseFree(b) {
  const out = new Set();
  for (const f of fields(b)) {
    if (f.num !== 1 || f.wire !== 2) continue;
    let uid = '';
    let tier = 0;
    for (const g of fields(f.data)) {
      if (g.num === 22 && g.wire === 2) uid = dec.decode(g.data);
      else if (g.num === 24 && g.wire === 0) tier = g.n;
    }
    if (uid && tier === FREE_TIER) out.add(uid);
  }
  return out;
}

export function parsePrices(b) {
  const out = new Map();
  const words = { Input: 'input', 'Cached input': 'read', Output: 'output' };
  for (const f of fields(b)) {
    if (f.num !== 1 || f.wire !== 2) continue;
    let uid = '';
    const p = {};
    for (const g of fields(f.data)) {
      if (g.num === 22 && g.wire === 2) uid = dec.decode(g.data);
      else if (g.num === 32 && g.wire === 2) {
        let label = '';
        let unit = '';
        let v = NaN;
        for (const h of fields(g.data)) {
          if (h.num === 1 && h.wire === 2) label = dec.decode(h.data);
          else if (h.num === 3 && h.wire === 2) unit = dec.decode(h.data);
          else if (h.num === 2 && h.wire === 5) v = new DataView(h.data.buffer, h.data.byteOffset, 4).getFloat32(0, true);
        }
        if (words[label] && unit === '1M tokens' && Number.isFinite(v) && v >= 0) p[words[label]] = +v.toPrecision(6);
      }
    }
    if (uid && (p.input > 0 || p.output > 0)) {
      out.set(uid, { input: p.input ?? 0, output: p.output ?? 0, cache: { read: p.read ?? 0 } });
    }
  }
  return out;
}

export function parseConfigFamilies(b) {
  const fams = new Map();
  for (const f of fields(b)) {
    if (f.num !== 1 || f.wire !== 2) continue;
    let uid = '';
    let name = '';
    let context = 0;
    let output = 0;
    let fam = '';
    let famLabel = '';
    for (const g of fields(f.data)) {
      if (g.num === 22 && g.wire === 2) uid = dec.decode(g.data);
      else if (g.num === 1 && g.wire === 2) name = dec.decode(g.data);
      else if (g.num === 18 && g.wire === 0) context = g.n;
      else if (g.num === 23 && g.wire === 2) {
        for (const h of fields(g.data)) {
          if (h.num === 13 && h.wire === 0) output = h.n;
          else if (h.num === 23 && h.wire === 2) fam = dec.decode(h.data);
        }
      } else if (g.num === 30 && g.wire === 2) {
        for (const h of fields(g.data)) if (h.num === 1 && h.wire === 2) famLabel = dec.decode(h.data);
      }
    }
    if (!uid) continue;
    const id = fam || famLabel || name || uid;
    const low = id.toLowerCase();
    if (low === 'adaptive' || low === 'fusion' || parseFusionRoute(uid)) continue;
    let e = fams.get(id);
    if (!e) {
      const known = snapshotData.families.find(([u]) => u === id);
      fams.set(id, (e = { uid: id, label: famLabel || name || id, aliases: known ? known[2] : [], models: [] }));
    }
    e.models.push({ id: uid, name: name || uid, context, output });
  }
  return [...fams.values()];
}

export function parseFamilies(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  for (const f of list?.families ?? []) {
    if (!f?.family_uid) continue;
    const low = String(f.family_uid).toLowerCase();
    if (low === 'adaptive' || low === 'fusion') continue;
    out.push({
      uid: f.family_uid,
      label: f.family_label || f.family_uid,
      aliases: f.aliases ?? [],
      models: (f.variants ?? [])
        .filter((v) => v?.model_uid)
        .map((v) => ({
          id: v.model_uid,
          name: v.label || v.model_uid,
          context: v.max_context_tokens || 0,
          output: v.max_output_tokens || 0
        }))
    });
  }
  return out;
}

export function parseFusionRoutesFromConfig(b) {
  const routes = new Set();
  for (const f of fields(b)) {
    if (f.num !== 1 || f.wire !== 2) continue;
    for (const g of fields(f.data)) {
      if (g.num !== 22 || g.wire !== 2) continue;
      const uid = dec.decode(g.data);
      if (parseFusionRoute(uid)) routes.add(uid);
    }
  }
  return [...routes];
}

export function parseCostSummary(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const pick = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : 0;
  };
  const input = pick(/\$([\d.]+)\s*\/\s*1M\s*Input/i);
  const read = pick(/\$([\d.]+)\s*\/\s*1M\s*Cached\s*input/i);
  const output = pick(/\$([\d.]+)\s*\/\s*1M\s*Output/i);
  return input > 0 || output > 0 ? { input, output, cache: { read } } : null;
}

export function parseCliCatalog(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return { families: [], freeIds: [], prices: {}, fusionRoutes: [] };
  }
  const families = [];
  const freeIds = [];
  const prices = {};
  const fusionRoutes = [];
  const seenFusion = new Set();
  for (const f of list?.families ?? []) {
    if (!f?.family_uid) continue;
    const low = String(f.family_uid).toLowerCase();
    if (low === 'fusion') {
      for (const v of Array.isArray(f.variants) ? f.variants : []) {
        const uid = v?.model_uid;
        if (parseFusionRoute(uid) && !seenFusion.has(uid)) {
          seenFusion.add(uid);
          fusionRoutes.push(uid);
        }
      }
      continue;
    }
    if (low === 'adaptive') continue;
    const models = [];
    for (const v of f.variants ?? []) {
      if (!v?.model_uid) continue;
      if (v.cost_tier === 'Free') freeIds.push(v.model_uid);
      const cost = parseCostSummary(v.cost_summary);
      if (cost) prices[v.model_uid] = cost;
      models.push({
        id: v.model_uid,
        name: v.label || v.model_uid,
        context: v.max_context_tokens || 0,
        output: v.max_output_tokens || 0
      });
    }
    families.push({
      uid: f.family_uid,
      label: f.family_label || f.family_uid,
      aliases: f.aliases ?? [],
      models
    });
  }
  return { families, freeIds, prices, fusionRoutes };
}

export function parseFusionRoutesFromFamilies(text) {
  return parseCliCatalog(text).fusionRoutes;
}

export async function fetchCliModelConfigs(key, server, fetchImpl = fetch, signal) {
  const res = await fetchImpl(server + MODEL_CONFIGS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/proto', 'Connect-Protocol-Version': '1' },
    body: new PB().bytes(1, metadata(key)).done(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`GetCliModelConfigs: HTTP ${res.status}`);
  const b = new Uint8Array(await res.arrayBuffer());
  const images = parseModelConfigs(b);
  if (!images) throw new Error('GetCliModelConfigs: 未返回模型配置');
  const families = parseConfigFamilies(b);
  const free = [...parseFree(b)];
  const prices = Object.fromEntries(parsePrices(b));
  const fusionRoutes = parseFusionRoutesFromConfig(b);
  return {
    families: families.length ? families : SNAPSHOT_FAMILIES,
    images,
    freeIds: free,
    prices,
    ...(fusionRoutes.length ? { fusionRoutes } : {}),
    source: 'remote',
    updatedAt: new Date().toISOString()
  };
}

// ── Per-model defaults, overrides & Core projection ─────────────────────────────

const positiveInteger = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined);

function coreEffortsFromDevin(effortsList) {
  if (!Array.isArray(effortsList) || !effortsList.length) return false;
  const out = {};
  for (const e of effortsList) {
    if (e === 'none') out.off = 'none';
    else if (CORE_THINKING_LEVELS.includes(e)) out[e] = e;
  }
  return Object.keys(out).some((k) => k !== 'off') ? out : false;
}

export function defaultReasoningFor(effortsMap, declared = null) {
  if (!effortsMap || effortsMap === false || typeof effortsMap !== 'object' || Array.isArray(effortsMap)) return null;
  return typeof declared === 'string' && Object.hasOwn(effortsMap, declared) ? declared : null;
}

export function modelDefaults(entry) {
  const contextWindow = positiveInteger(entry?.context) ?? 200000;
  const maxTokens = Math.min(contextWindow, positiveInteger(entry?.output) ?? 128000);
  const reasoningEfforts = coreEffortsFromDevin(entry?.efforts);
  const imageInput = entry?.image === true;
  return {
    contextWindow,
    maxTokens,
    reasoningEfforts,
    defaultReasoning: null,
    imageInput,
    toolsEnabled: true
  };
}

export function effectiveModel(defaults, settings = {}) {
  const effective = { ...defaults };
  if (settings.contextWindow !== undefined) effective.contextWindow = settings.contextWindow;
  if (settings.maxTokens !== undefined) effective.maxTokens = settings.maxTokens;
  else if (effective.maxTokens > effective.contextWindow) effective.maxTokens = effective.contextWindow;
  if (settings.reasoningEfforts !== undefined) effective.reasoningEfforts = settings.reasoningEfforts;
  if (settings.temperature !== undefined) effective.temperature = settings.temperature;
  if (settings.imageInput !== undefined) effective.imageInput = settings.imageInput;
  if (settings.toolsEnabled !== undefined) effective.toolsEnabled = settings.toolsEnabled;
  effective.defaultReasoning = defaultReasoningFor(
    effective.reasoningEfforts,
    settings.defaultReasoning === undefined ? defaults.defaultReasoning : settings.defaultReasoning
  );
  return effective;
}

function validateCatalogFamilies(families) {
  if (!Array.isArray(families) || !families.length || families.length > 1000) {
    throw new Error('本地模型缓存格式错误');
  }
  for (const f of families) {
    if (!f || typeof f !== 'object' || typeof f.uid !== 'string' || !Array.isArray(f.models)) {
      throw new Error('本地模型缓存格式错误');
    }
    assertModelId(f.uid);
  }
  return families;
}

export function catalogStatus(state, accountId) {
  const cached = accountId ? state?.catalogs?.[accountId] : undefined;
  if (cached === undefined || cached === null) {
    return {
      families: SNAPSHOT_FAMILIES,
      images: SNAPSHOT_IMAGES,
      freeIds: SNAPSHOT_FREE,
      prices: new Map(Object.entries(SNAPSHOT_PRICES)),
      fusionRoutes: [],
      source: 'local-snapshot'
    };
  }
  try {
    const families = validateCatalogFamilies(cached.families);
    const images = cached.images && typeof cached.images === 'object' ? { ...SNAPSHOT_IMAGES, ...cached.images } : SNAPSHOT_IMAGES;
    const rawPrices = cached.prices && typeof cached.prices === 'object' ? cached.prices : {};
    const hasCustomCatalogData = (Array.isArray(cached.freeIds) && cached.freeIds.length > 0) || Object.keys(rawPrices).length > 0;
    const freeIds = hasCustomCatalogData ? (Array.isArray(cached.freeIds) ? cached.freeIds : []) : SNAPSHOT_FREE;
    const prices = new Map(Object.entries({ ...SNAPSHOT_PRICES, ...rawPrices }));
    const fusionRoutes = cached.fusionRoutesVersion === CLI_VERSION && Array.isArray(cached.fusionRoutes)
      ? cached.fusionRoutes.filter(parseFusionRoute) : [];
    return {
      families,
      images,
      freeIds,
      prices,
      fusionRoutes,
      source: cached.source ?? 'remote',
      ...(cached.updatedAt ? { updatedAt: cached.updatedAt } : {})
    };
  } catch {
    return {
      families: [],
      images: SNAPSHOT_IMAGES,
      freeIds: [],
      prices: new Map(),
      fusionRoutes: [],
      source: 'invalid-cache',
      broken: true
    };
  }
}

export function getModelRows(state, accountId) {
  const status = catalogStatus(state, accountId);
  if (status.broken) return [];
  const entries = listed(status.families, status.images, new Set(status.freeIds), status.prices);
  const bucket = accountId && state?.modelSettings?.[accountId] && typeof state.modelSettings[accountId] === 'object'
    ? state.modelSettings[accountId]
    : {};
  const rows = entries.map((entry) => {
    const override = Object.hasOwn(bucket, entry.id) ? bucket[entry.id] : undefined;
    const settings = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
    const defaults = modelDefaults(entry);
    const effective = effectiveModel(defaults, settings);
    const warnings = [];
    if (settings.imageInput === true && defaults.imageInput === false) {
      warnings.push('已强制开启图片输入：目录未声明该模型支持图片，请确认服务端能力。');
    }
    if (typeof settings.defaultReasoning === 'string' && settings.defaultReasoning !== effective.defaultReasoning) {
      warnings.push(`已保存的默认思考档位 ${settings.defaultReasoning} 不在当前目录中；暂不强制该档位，请重新选择。`);
    }
    if (settings.maxTokens !== undefined && effective.maxTokens > effective.contextWindow) {
      const saved = effective.maxTokens;
      effective.maxTokens = effective.contextWindow;
      warnings.push(`已保存的最大输出 ${saved} 大于目录上下文 ${effective.contextWindow}：有效调用按上下文收敛，原设置保留，请按需下调或恢复默认。`);
    }
    return {
      id: entry.id,
      name: entry.name || entry.id,
      free: entry.free === true,
      ...(entry.mixedFree ? { mixedFree: true } : {}),
      ...(entry.cost ? { cost: entry.cost } : {}),
      ...(entry.mixedCost ? { mixedCost: true } : {}),
      ...(entry.fastTier ? { fastTier: entry.fastTier, fastLabel: entry.fastLabel } : {}),
      ...(entry.fastCost ? { fastCost: entry.fastCost } : {}),
      ...(entry.fastMixedCost ? { fastMixedCost: true } : {}),
      legacy: entry.legacy === true,
      enabled: settings.enabled !== false,
      settings: structuredClone(settings),
      ...(warnings.length ? { settingsWarning: warnings.join(' ') } : {}),
      defaults,
      effective
    };
  });
  // 已启用模型置顶，各自内部保持原有目录顺序。
  rows.sort((a, b) => Number(b.enabled) - Number(a.enabled));
  return rows;
}

// 官方快照只在默认服务可用；且必须在账号目录中找到搭配的两个标准变体。
function fusionIndexOf(state, accountId, status = catalogStatus(state, accountId)) {
  if (!accountId || status.broken) return fusionRouteIndex([], []);
  const owner = state?.accounts?.find((a) => a.id === accountId);
  const server = (process.env.WINDSURF_API_SERVER_URL?.trim() || owner?.server || state?.settings?.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
  const latestOnly = state?.settings?.hideLegacyModels !== false;
  const families = latestOnly ? status.families.filter((f) => isCurrentModelFamily(f.uid)) : status.families;
  const ids = new Set(families.flatMap((f) => f.models.map((m) => m?.id)));
  const available = (uid) => {
    const { lead, sidekick } = parseFusionRoute(uid);
    const untiered = ({ uid, tier }) => tier ? uid.slice(0, -(tier.length + 1)) : uid;
    return ids.has(untiered(lead)) && ids.has(untiered(sidekick));
  };
  if (status.fusionRoutes.length && state.catalogs?.[accountId]?.fusionServer === server) {
    return fusionRouteIndex(latestOnly ? status.fusionRoutes.filter(available) : status.fusionRoutes, families);
  }
  if (server !== DEFAULT_SERVER) return fusionRouteIndex([], []);
  return fusionRouteIndex(SNAPSHOT_FUSION_ROUTES.filter(available), families);
}

export function fusionCatalogOf(state, accountId) {
  const index = fusionIndexOf(state, accountId);
  return {
    selection: selectFusionRoute(index, state?.fusion?.[accountId]),
    options: { leads: index.leads, sidekicks: index.sidekicks }
  };
}

function fusionDescriptor(selection, families) {
  const lead = families.flatMap((f) => f.models).find((m) => m?.id === selection.leadUid);
  const contextWindow = lead?.context || 200000;
  const maxTokens = Math.min(contextWindow, lead?.output || 128000);
  return {
    id: FUSION_MODEL_ID,
    name: 'Fusion',
    api: isClaude(selection.leadUid) ? 'anthropic-messages' : 'openai-completions',
    contextWindow,
    maxTokens,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // lead 的思考档位由 Fusion 配置（leadEffort）决定，不走 DSH 逐次档位选择。
    reasoningEfforts: false
  };
}

export function profileFor(state, fusionSelection) {
  if (state.enabled === false) return null;
  const accountId = state.activeAccountId;
  const owner = state.accounts?.find((a) => a.id === accountId);
  if (!owner) return null;
  const status = catalogStatus(state, accountId);
  if (status.broken) throw new Error('模型缓存损坏，请重新拉取模型');
  const rows = getModelRows(state, accountId);
  const hideLegacy = state?.settings?.hideLegacyModels !== false;
  const models = rows
    .filter((row) => row.enabled && (!hideLegacy || !row.legacy))
    .map((row) => ({
      id: row.id,
      name: row.name,
      api: isClaude(row.id) ? 'anthropic-messages' : 'openai-completions',
      contextWindow: row.effective.contextWindow,
      maxTokens: row.effective.maxTokens,
      input: row.effective.imageInput ? ['text', 'image'] : ['text'],
      cost: {
        input: row.cost?.input ?? 0,
        output: row.cost?.output ?? 0,
        cacheRead: row.cost?.cache?.read ?? 0,
        cacheWrite: 0
      },
      ...(row.effective.reasoningEfforts ? { reasoningEfforts: row.effective.reasoningEfforts } : { reasoningEfforts: false })
    }));
  const selection = fusionSelection === undefined ? fusionCatalogOf(state, accountId).selection : fusionSelection;
  if (selection) models.push(fusionDescriptor(selection, status.families));
  return {
    provider: ROUTE_ID,
    displayName: ROUTE_DISPLAY_NAME,
    families: status.families,
    models
  };
}
