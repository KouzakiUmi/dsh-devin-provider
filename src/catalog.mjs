import { readFile } from 'node:fs/promises';
import { MODEL_CONFIGS_RPC, PB, dec, fields, metadata } from './pb.mjs';
import { CORE_THINKING_LEVELS, ROUTE_DISPLAY_NAME, ROUTE_ID, assertModelId } from './state.mjs';

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
  ['priority', 'Priority']
];

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

// Map DSH effort ('off') to Devin's effort ('none') before resolving variant.
const toDevinEffort = (e) => (e === 'off' ? 'none' : e);

export function variantFor(families, model, effort) {
  const devinEffort = toDevinEffort(effort);
  for (const f of families) {
    if (!named(f, model) || !f.models?.length) continue;
    if (devinEffort) {
      const id = byLevel(f, '')[nearest(devinEffort, efforts(f, ''))];
      if (id) return id;
    }
    return defaultModel(f).id;
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
    return variantFor(SNAPSHOT_FAMILIES, model, effort);
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
    const ps = ids.map((id) => prices.get(id));
    if (!ps.length || !ps[0] || ps.some((p) => JSON.stringify(p) !== JSON.stringify(ps[0]))) return undefined;
    return ps[0];
  };
  const freeFlags = (ids) => {
    const any = ids.some((id) => free.has(id));
    const every = ids.length > 0 && ids.every((id) => free.has(id));
    return { free: every, ...(any && !every ? { mixedFree: true } : {}) };
  };
  const costFlags = (ids) => {
    const ps = ids.map((id) => prices.get(id));
    if (ps.length > 1 && ps.some((p) => p && JSON.stringify(p) !== JSON.stringify(ps[0]))) return { mixedCost: true };
    const cost = priced(ids);
    return cost ? { cost } : {};
  };
  const own = (f, t) => {
    const ids = Object.values(byLevel(f, t));
    if (!t && f.models.length && !ids.includes(defaultModel(f).id)) ids.push(defaultModel(f).id);
    return ids;
  };
  const out = [];
  const seen = new Set();
  const add = ({ free: isFree, cost, mixedFree, mixedCost, ...m }) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    out.push({
      ...m,
      ...(isFree ? { free: true } : {}),
      ...(mixedFree ? { mixedFree: true } : {}),
      ...(cost ? { cost } : {}),
      ...(mixedCost ? { mixedCost: true } : {})
    });
  };
  for (const f of families) {
    const context = f.models.find((m) => m.context)?.context ?? 0;
    const output = f.models.find((m) => m.output)?.output ?? 0;
    const image = familyImages(f, images);
    add({
      id: f.uid,
      name: f.label,
      context,
      output,
      efforts: efforts(f, ''),
      image,
      ...freeFlags(own(f, '')),
      ...costFlags(own(f, ''))
    });
    for (const t of tiers(f)) {
      const id = f.uid + '-' + t;
      if (families.some((g) => named(g, id))) continue;
      add({
        id,
        name: f.label + ' ' + TIERS.find(([w]) => w === t)[1],
        context,
        output,
        efforts: efforts(f, t),
        image,
        ...freeFlags(own(f, t)),
        ...costFlags(own(f, t))
      });
    }
    if (f.models.length === 1) continue;
    for (const m of f.models) {
      if (m.id === f.uid || tierOf(m.id)[1]) continue;
      add({
        id: m.id,
        name: m.name,
        context: m.context || context,
        output: m.output || output,
        efforts: [],
        image: images[m.id],
        free: free.has(m.id),
        cost: prices.get(m.id)
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
    if (low === 'adaptive' || low === 'fusion') continue;
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
  return {
    families: families.length ? families : SNAPSHOT_FAMILIES,
    images,
    freeIds: free,
    prices,
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
      freeIds: [],
      prices: new Map(),
      source: 'local-snapshot'
    };
  }
  try {
    const families = validateCatalogFamilies(cached.families);
    const images = cached.images && typeof cached.images === 'object' ? { ...SNAPSHOT_IMAGES, ...cached.images } : SNAPSHOT_IMAGES;
    const freeIds = Array.isArray(cached.freeIds) ? cached.freeIds : [];
    const prices = new Map(cached.prices && typeof cached.prices === 'object' ? Object.entries(cached.prices) : []);
    return {
      families,
      images,
      freeIds,
      prices,
      source: cached.source ?? 'remote',
      ...(cached.updatedAt ? { updatedAt: cached.updatedAt } : {})
    };
  } catch {
    return {
      families: [],
      images: SNAPSHOT_IMAGES,
      freeIds: [],
      prices: new Map(),
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
  return entries.map((entry) => {
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
      ...(entry.cost ? { cost: entry.cost } : {}),
      enabled: settings.enabled !== false,
      settings: structuredClone(settings),
      ...(warnings.length ? { settingsWarning: warnings.join(' ') } : {}),
      defaults,
      effective
    };
  });
}

export function profileFor(state) {
  if (state.enabled === false) return null;
  const accountId = state.activeAccountId;
  const owner = state.accounts?.find((a) => a.id === accountId);
  if (!owner) return null;
  const status = catalogStatus(state, accountId);
  if (status.broken) throw new Error('模型缓存损坏，请重新拉取模型');
  const rows = getModelRows(state, accountId);
  const models = rows
    .filter((row) => row.enabled)
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
  return {
    provider: ROUTE_ID,
    displayName: ROUTE_DISPLAY_NAME,
    families: status.families,
    models
  };
}
