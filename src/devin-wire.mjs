import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CHAT_RPC, PB, dec, failure, fields, frame, frames, inID, metadata, outID, rpcHeaders } from './pb.mjs';
import { isClaude, variantFor } from './catalog.mjs';
import { keepaliveKey, keepaliveSettings, scheduleKeepalive, stopKeepalive } from './keepalive.mjs';

const USER = 1;
const ASSISTANT = 2;
const TOOL = 4;
const NO_RESULT = 'Tool use was interrupted and did not produce a result.';
const BILLING_LINE = /^x-anthropic-billing-header:(\s*[A-Za-z_]+=[^;\s]*;)*\s*(\n|$)/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const joinNonEmpty = (...s) => s.filter(Boolean).join('\n\n');

// Signature type cache for Claude thinking blocks across turns.
const sigTypes = new Map();
const SIG_TYPES_KEPT = 512;

export function rememberSigType(signature, type) {
  if (!signature || !type) return;
  sigTypes.delete(signature);
  sigTypes.set(signature, type);
  if (sigTypes.size > SIG_TYPES_KEPT) sigTypes.delete(sigTypes.keys().next().value);
}

export const sigTypeOf = (signature) => sigTypes.get(signature) ?? 'anthropic';
export const forgetSigTypes = () => sigTypes.clear();

// Gemini thought signature cache across tool turns (synced with opencode-devin-auth).
const thoughts = new Map();
const THOUGHTS_KEPT = 4096;
const isGemini = (uid) => /gemini/i.test(String(uid ?? ''));
const textKey = (text) => 'text:' + createHash('sha256').update(String(text).replace(/\s+/g, '')).digest('base64url');

export function rememberThought({ calls, text }, thought) {
  const keys = calls.length ? calls : text ? [textKey(text)] : [];
  for (const k of keys) {
    thoughts.delete(k);
    thoughts.set(k, thought);
    if (thoughts.size > THOUGHTS_KEPT) thoughts.delete(thoughts.keys().next().value);
  }
}

export function thoughtFor(uid, calls, text) {
  if (!isGemini(uid)) return null;
  for (const c of calls) {
    const t = thoughts.get(c.id);
    if (t) return t;
  }
  return (!calls.length && text && thoughts.get(textKey(text))) || null;
}

export const forgetThoughts = () => thoughts.clear();

/**
 * Fold top-level allOf/anyOf/oneOf into a plain object schema for Devin's Claude models.
 */
export function objectRoot(ps) {
  return foldRoot(ps, ps, 0);
}

function foldRoot(root, ps, depth) {
  if (!isObj(ps)) return ps;
  const has = (k) => Object.hasOwn(ps, k);
  if (ps.type === 'object' && !has('anyOf') && !has('oneOf') && !has('allOf')) return ps;
  const out = { ...ps };
  const props = { ...(isObj(ps.properties) ? ps.properties : {}) };
  let required = Array.isArray(ps.required) ? [...ps.required] : [];
  const ref = (b) => {
    if (!isObj(b)) return null;
    if (typeof b.$ref !== 'string' || !b.$ref) return b;
    for (const k of ['$defs', 'definitions']) {
      const pre = '#/' + k + '/';
      if (b.$ref.startsWith(pre)) {
        const d = root[k]?.[b.$ref.slice(pre.length)];
        return isObj(d) ? d : null;
      }
    }
    return null;
  };
  for (const b of Array.isArray(ps.allOf) ? ps.allOf : []) {
    const bm = ref(b);
    if (!bm) continue;
    if (isObj(bm.properties)) {
      for (const [k, v] of Object.entries(bm.properties)) {
        if (!Object.hasOwn(props, k)) props[k] = v;
      }
    }
    if (Array.isArray(bm.required)) required.push(...bm.required);
  }
  delete out.allOf;
  const branches = [];
  for (const k of ['anyOf', 'oneOf']) {
    for (const b of Array.isArray(ps[k]) ? ps[k] : []) {
      let bm = ref(b);
      if (!bm) continue;
      if (depth < 8 && ['anyOf', 'oneOf', 'allOf'].some((u) => Object.hasOwn(bm, u))) {
        bm = foldRoot(root, bm, depth + 1);
      }
      if (bm.type !== 'object' && !Object.hasOwn(bm, 'properties')) continue;
      branches.push(bm);
    }
    delete out[k];
  }
  let common = null;
  const from = new Map();
  for (const b of branches) {
    for (const [k, v] of Object.entries(isObj(b.properties) ? b.properties : {})) {
      if (Object.hasOwn(props, k)) continue;
      const vs = from.get(k) ?? [];
      if (!vs.some((w) => JSON.stringify(w) === JSON.stringify(v))) vs.push(v);
      from.set(k, vs);
    }
    const br = Array.isArray(b.required) ? b.required : [];
    common = common === null ? [...br] : common.filter((r) => br.includes(r));
  }
  for (const [k, vs] of from) props[k] = vs.length === 1 ? vs[0] : { anyOf: vs };
  for (const r of common ?? []) if (!required.includes(r)) required.push(r);
  required = [...new Set(required)];
  out.type = 'object';
  out.properties = props;
  if (required.length) out.required = required;
  else delete out.required;
  return out;
}

/**
 * Sanitize JSON schemas for Devin's Gemini models.
 */
export function geminiSchema(s, depth = 0) {
  if (!isObj(s) || depth > 32) return s;
  let out = { ...s };
  const sub = (v) => geminiSchema(v, depth + 1);
  for (const k of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    if (isObj(out[k])) out[k] = Object.fromEntries(Object.entries(out[k]).map(([n, v]) => [n, sub(v)]));
  }
  for (const k of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(out[k])) out[k] = out[k].map(sub);
  }
  for (const k of ['additionalProperties', 'not', 'if', 'then', 'else', 'contains']) {
    if (isObj(out[k])) out[k] = sub(out[k]);
  }
  if (Array.isArray(out.type)) {
    const types = [...new Set(out.type.filter((t) => typeof t === 'string'))];
    const some = types.filter((t) => t !== 'null');
    if (some.length < types.length && some.length) out.nullable = true;
    if (some.length === 1) out.type = some[0];
    else if (!some.length) out.type = types.length ? 'null' : undefined;
    else {
      delete out.type;
      const branches = some.map((t) => ({ type: t, ...(t === 'array' ? { items: {} } : {}) }));
      out.anyOf = Array.isArray(out.anyOf) ? [...out.anyOf, ...branches] : branches;
    }
    if (out.type === undefined) delete out.type;
  }
  if (depth > 0 && out.type !== undefined && Array.isArray(out.anyOf)) {
    const isNull = (b) => isObj(b) && b.type === 'null';
    const some = out.anyOf.filter((b) => !isNull(b));
    if (some.length < out.anyOf.length) out.nullable = true;
    delete out.anyOf;
    const one = some.length === 1 && isObj(some[0]) ? some[0] : undefined;
    if (one && (one.type === undefined || one.type === out.type)) {
      out = { ...one, ...out };
    } else if (some.length) {
      if (!Array.isArray(out.oneOf)) out.oneOf = some;
      else out.allOf = [...(Array.isArray(out.allOf) ? out.allOf : []), { oneOf: some }];
    }
  }
  if (out.type === undefined && Array.isArray(out.enum)) {
    const vals = out.enum.filter((v) => v !== null);
    if (vals.length < out.enum.length) out.nullable = true;
    const kinds = new Set(vals.map((v) => (Number.isInteger(v) ? 'integer' : typeof v)));
    const one = kinds.size === 1 ? [...kinds][0] : kinds.size === 2 && kinds.has('integer') && kinds.has('number') ? 'number' : '';
    if (['string', 'integer', 'number', 'boolean'].includes(one)) {
      out.type = one;
      out.enum = vals;
    } else {
      delete out.enum;
    }
  }
  if (out.type === undefined && isObj(out.properties)) out.type = 'object';
  if (out.type === 'array' || (out.type === undefined && Object.hasOwn(out, 'items'))) {
    if (Array.isArray(out.items)) out.items = out.items.length === 1 && isObj(out.items[0]) ? sub(out.items[0]) : {};
    else out.items = isObj(out.items) ? sub(out.items) : {};
    out.type = 'array';
  }
  return out;
}

export function toolDescriptions(tools) {
  const said = tools.filter((t) => t.description);
  if (!said.length) return '';
  return (
    '<tool_descriptions>\n' +
    said.map((t) => `<tool name="${t.name}">\n${t.description.trim()}\n</tool>\n`).join('') +
    '</tool_descriptions>'
  );
}

export function encodeMsg(m) {
  const b = new PB().str(1, randomUUID()).varint(2, m.role);
  if (m.text) b.str(3, m.text);
  for (const c of m.calls ?? []) b.bytes(6, new PB().str(1, c.id ?? '').str(2, c.name ?? '').bytes(3, c.args));
  if (m.callID) b.str(7, m.callID);
  if (m.cache) b.bytes(8, new PB().varint(1, 1));
  for (const p of m.images ?? []) b.bytes(10, new PB().str(1, p.data).str(2, p.type));
  if (m.thinking?.text) b.str(11, m.thinking.text);
  if (m.thinking?.signature) {
    b.str(12, m.thinking.signature);
    if (m.thinking.type) b.str(18, m.thinking.type);
    if (m.thinking.model) b.str(22, m.thinking.model);
  }
  return b.done();
}

export function encodeRequest(msgs, tools, chat, uid, key) {
  const head = metadata(key).done();
  const prompts = msgs.map(encodeMsg);
  const above0 = (v) => (v === 0 ? 1e-6 : v);
  const temp = above0(typeof chat.temperature === 'number' ? chat.temperature : 1);
  const topP = above0(typeof chat.top_p === 'number' ? chat.top_p : 0.95);
  const sampling = (max) => new PB().varint(1, 1).varint(2, max).varint(3, 400).double(5, temp).varint(7, 40).double(8, topP);

  const offered = new Set();
  const toolParts = [];
  const tool = (name, desc, schema) => {
    if (!schema || typeof schema !== 'object') schema = { type: 'object', properties: {} };
    offered.add(name);
    toolParts.push(new PB().str(1, name).str(2, desc || name).bytes(3, JSON.stringify(schema)).done());
  };
  for (const t of tools) {
    tool(t.name, t.description ? `Described under <tool name="${t.name}"> in <tool_descriptions>, in the instructions.` : '', t.schema);
  }
  for (const m of msgs) {
    for (const c of m.calls ?? []) {
      if (!offered.has(c.name)) tool(c.name, 'Tool');
    }
  }

  const assemble = (more, max) => {
    const out = new PB().bytes(1, head);
    for (const p of [...prompts, ...more]) out.bytes(3, p);
    out.varint(7, 5);
    out.bytes(8, sampling(max));
    for (const t of toolParts) out.bytes(10, t);
    return out.str(21, uid).done();
  };

  return {
    bytes: assemble([], chat.max || 128000),
    makePing: () => assemble([encodeMsg({ role: USER, text: 'continue' })], 1)
  };
}

function piImagesAndTexts(content) {
  if (typeof content === 'string') return { texts: content ? [content] : [], images: [] };
  if (!Array.isArray(content)) return { texts: [], images: [] };
  const texts = [];
  const images = [];
  for (const p of content) {
    if (p?.type === 'text' && typeof p.text === 'string' && p.text) texts.push(p.text);
    else if (p?.type === 'image' && typeof p.data === 'string' && p.data) {
      images.push({ data: p.data, type: p.mimeType || 'image/png' });
    }
  }
  return { texts, images };
}

function sanitizeAssistantHistory(text) {
  if (typeof text !== 'string' || !text.includes(HARMONY_START)) return text;
  const cleaned = text
    .replace(/<\|message_model\|>([\s\S]*?)<\|content_invoke_tool_json\|>([\s\S]*?)<\|end_message\|>/g, (_, hdr, body) => {
      let name = String(hdr ?? '').trim();
      try {
        const parsed = JSON.parse(String(body ?? '').trim());
        if (typeof parsed?.name === 'string' && parsed.name.trim()) name = parsed.name.trim();
      } catch {}
      return name ? `[attempted tool call: ${name}]` : '[attempted tool call]';
    })
    .replace(/<\|message_model\|>|<\|content_invoke_tool_json\|>|<\|end_message\|>/g, '');
  return cleaned.trim();
}

function systemMessageText(m, isInitial) {
  const { texts } = piImagesAndTexts(m?.content);
  const parts = [];
  const main = texts.join('\n\n').replace(BILLING_LINE, '').trim();
  if (main) parts.push(main);
  if (m?.sections && typeof m.sections === 'object') {
    for (const [k, v] of Object.entries(m.sections)) {
      if (v === null) {
        if (!isInitial) parts.push(`Removed system prompt section "${k}".`);
      } else if (typeof v === 'string' && v.trim()) {
        const cleaned = v.replace(BILLING_LINE, '').trim();
        if (cleaned) parts.push(isInitial ? cleaned : `Updated system prompt section "${k}":\n\n${cleaned}`);
      }
    }
  }
  return parts.join('\n\n');
}

/**
 * Convert a pi-ai Context / TranscriptContext + model + options into a Devin GetChatMessage protobuf request.
 */
export function buildFromPiContext(model, context, options, uid, key, { toolsEnabled = true } = {}) {
  const claude = isClaude(uid);
  const msgs = [];
  const notices = [];
  let pending = [];

  // Resolve initial + transcript-delta tools (pi-ai >=1.4.0 moves context.tools
  // and context.systemPrompt into messages[0] with role === 'system' and toolsAdded).
  const toolMap = new Map();
  for (const t of context?.tools ?? []) {
    if (t?.name) toolMap.set(t.name, t);
  }

  const rawMessages = context?.messages ?? [];
  const leadingParts = [];
  if (typeof context?.systemPrompt === 'string') {
    const cleaned = context.systemPrompt.replace(BILLING_LINE, '').trim();
    if (cleaned) leadingParts.push(cleaned);
  }
  let startIdx = 0;
  if (rawMessages[0]?.role === 'system') {
    const firstSys = rawMessages[0];
    for (const t of firstSys.toolsRemoved ?? []) toolMap.delete(t.name);
    for (const t of firstSys.toolsAdded ?? []) if (t?.name) toolMap.set(t.name, t);
    const firstText = systemMessageText(firstSys, true);
    if (firstText) leadingParts.push(firstText);
    startIdx = 1;
  }

  const pushUser = (text, images = []) => {
    const prev = msgs[msgs.length - 1];
    if (prev?.role === USER) {
      prev.text = joinNonEmpty(prev.text, text);
      if (images.length) prev.images = [...(prev.images ?? []), ...images];
      return;
    }
    msgs.push({ role: USER, text, images });
  };

  const answer = () => {
    for (const c of pending) msgs.push({ role: TOOL, callID: c.id, text: NO_RESULT });
    pending = [];
    for (const n of notices) pushUser(n.text, n.images);
    notices.length = 0;
  };

  for (let idx = startIdx; idx < rawMessages.length; idx++) {
    const m = rawMessages[idx];
    if (m?.role === 'system') {
      for (const t of m.toolsRemoved ?? []) toolMap.delete(t.name);
      for (const t of m.toolsAdded ?? []) if (t?.name) toolMap.set(t.name, t);
      const text = systemMessageText(m, false);
      if (!text) continue;
      if (pending.length) notices.push({ text, images: [] });
      else pushUser(text);
      continue;
    }

    if (m?.role === 'assistant') {
      const own = [];
      const calls = [];
      let thought = null;
      const take = (p) => {
        if (thought) [p.thinking, thought] = [thought, null];
        return p;
      };
      for (const b of m.content ?? []) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
          const text = sanitizeAssistantHistory(b.text);
          if (text) own.push(take({ role: ASSISTANT, text, calls: [] }));
        } else if (b?.type === 'toolCall' && b.name) {
          calls.push({ id: inID(b.id), name: b.name, args: JSON.stringify(b.arguments ?? {}) });
        } else if (b?.type === 'thinking' && claude && typeof b.thinkingSignature === 'string' && b.thinkingSignature) {
          if (thought) own.push(take({ role: ASSISTANT, text: '', calls: [] }));
          thought = {
            text: typeof b.thinking === 'string' ? b.thinking : '',
            signature: b.thinkingSignature,
            type: sigTypeOf(b.thinkingSignature)
          };
        } else if (b?.type === 'thinking' && !claude && typeof b.thinking === 'string' && b.thinking) {
          if (thought) own.push(take({ role: ASSISTANT, text: '', calls: [] }));
          thought = { text: b.thinking };
        }
      }
      if (calls.length) {
        if (!own.length || (thought && own[own.length - 1].thinking)) own.push({ role: ASSISTANT, text: '', calls: [] });
        take(own[own.length - 1]);
        own[own.length - 1].calls = calls;
      } else if (thought && own.length && !own[own.length - 1].thinking) {
        take(own[own.length - 1]);
      }
      if (!own.length) continue;
      const signed = thoughtFor(uid, calls, own.map((p) => p.text).join(''));
      if (signed) {
        const lastOwn = own[own.length - 1];
        lastOwn.thinking = { text: lastOwn.thinking?.text ?? '', ...signed };
      }
      answer();
      msgs.push(...own);
      pending = [...calls];
      continue;
    }

    if (m?.role === 'toolResult') {
      const i = pending.findIndex((c) => c.id === inID(m.toolCallId));
      if (i >= 0) {
        const { texts, images } = piImagesAndTexts(m.content);
        const said = texts.join('\n\n') || '(no output)';
        msgs.push({ role: TOOL, callID: pending[i].id, text: m.isError ? 'Error: ' + said : said, images });
        pending.splice(i, 1);
        if (!pending.length) answer();
      }
      continue;
    }

    if (m?.role === 'user') {
      const { texts, images } = piImagesAndTexts(m.content);
      const text = texts.join('\n\n');
      if (!text && !images.length) continue;
      answer();
      pushUser(text, images);
    }
  }

  answer();
  const last = msgs[msgs.length - 1];
  if (!last || (last.role === ASSISTANT && !last.calls.length)) {
    msgs.push({ role: USER, text: 'Please proceed with the task.' });
  }

  let tools = toolsEnabled
    ? [...toolMap.values()]
        .filter((t) => t?.name)
        .map((t) => ({ name: t.name, description: t.description ?? '', schema: objectRoot(t.parameters) }))
    : [];
  if (/gemini/i.test(uid)) tools = tools.map((t) => ({ ...t, schema: geminiSchema(t.schema) }));

  const cleanedSystem = leadingParts.join('\n\n');
  const described = toolDescriptions(tools);

  if (claude) {
    // Claude models: separate USER prompts preserve Anthropic cache_control boundaries.
    const system = [];
    if (described) system.push({ role: USER, text: described, cache: false });
    if (cleanedSystem) system.push({ role: USER, text: cleanedSystem, cache: true });
    if (system.length) {
      system[system.length - 1].cache = true;
      const at = msgs.findIndex((m) => m.role === USER);
      msgs.splice(at < 0 ? 0 : at, 0, ...system);
    }
    if (msgs.length) msgs[msgs.length - 1].cache = true;
  } else {
    // Non-Claude models (swe-2, swe-2-flash, gpt, gemini, glm, etc.):
    // match opencode-devin-auth build() — merge systemPrompt first, then <tool_descriptions>,
    // into the head of the first USER prompt with no field-8 prompt_cache_options.
    const instructions = joinNonEmpty(cleanedSystem, described);
    if (instructions) {
      let at = msgs.findIndex((m) => m.role === USER);
      if (at < 0) {
        msgs.unshift({ role: USER, text: '' });
        at = 0;
      }
      msgs[at].text = joinNonEmpty(instructions, msgs[at].text);
    }
  }

  const max = options?.maxTokens ?? model?.maxTokens ?? 128000;
  const req = encodeRequest(msgs, tools, { max, temperature: options?.temperature }, uid, key);
  req.offeredToolNames = new Set(tools.map((t) => t.name));
  return req;
}

const HARMONY_START = '<|message_model|>';
const HARMONY_END = '<|end_message|>';
const HARMONY_INVOKE = '<|content_invoke_tool_json|>';
const HARMONY_MAX_BUF = 256 * 1024;

function parseHarmonyTool(header, jsonText, offeredToolNames) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const h = header.trim();
  const hasWrapper = typeof parsed.name === 'string' && parsed.name.trim() && ('args' in parsed || 'arguments' in parsed || 'input' in parsed);
  let name = '';
  let argsObj = {};
  if (hasWrapper) {
    name = parsed.name.trim();
    const rawArgs = parsed.args ?? parsed.arguments ?? parsed.input;
    if (typeof rawArgs === 'string') {
      try {
        argsObj = JSON.parse(rawArgs || '{}');
      } catch {
        argsObj = {};
      }
    } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      argsObj = rawArgs;
    }
  } else if (h && /^[A-Za-z0-9_.:-]+$/.test(h)) {
    name = h;
    argsObj = parsed;
  }
  if (!name) return null;
  if (offeredToolNames && offeredToolNames.size > 0 && !offeredToolNames.has(name)) {
    // Allow header fallback if wrapper name wasn't offered but header was.
    if (h && offeredToolNames.has(h)) {
      name = h;
    } else {
      return null;
    }
  }
  return { name, args: JSON.stringify(argsObj ?? {}) };
}

function createHarmonyFilter(offeredToolNames) {
  let buf = '';
  let inBlock = false;

  const trailingPrefixLen = (s) => {
    const max = Math.min(s.length, HARMONY_START.length - 1);
    for (let len = max; len >= 1; len--) {
      if (HARMONY_START.startsWith(s.slice(-len))) return len;
    }
    return 0;
  };

  const handleCompleteBlock = (inner) => {
    const invokeIdx = inner.indexOf(HARMONY_INVOKE);
    if (invokeIdx >= 0) {
      const header = inner.slice(0, invokeIdx);
      const jsonText = inner.slice(invokeIdx + HARMONY_INVOKE.length);
      const parsed = parseHarmonyTool(header, jsonText, offeredToolNames);
      if (parsed) return [{ kind: 'tool', name: parsed.name, args: parsed.args }];
    }
    if (/^thought(?:\s|$)/i.test(inner)) {
      const body = inner.replace(/^thought[^\S\r\n]*\r?\n?/i, '');
      return body ? [{ kind: 'reasoning', text: body }] : [];
    }
    const cleaned = inner.replace(/^(?:final|assistant|commentary)[^\S\r\n]*\r?\n?/i, '');
    return cleaned ? [{ kind: 'text', text: cleaned }] : [];
  };

  const push = (chunk) => {
    if (!chunk) return [];
    buf += chunk;
    const out = [];
    for (;;) {
      if (!inBlock) {
        const startIdx = buf.indexOf(HARMONY_START);
        if (startIdx < 0) {
          const keep = trailingPrefixLen(buf);
          const emit = buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          if (emit) out.push({ kind: 'text', text: emit });
          break;
        }
        const before = buf.slice(0, startIdx);
        if (before) out.push({ kind: 'text', text: before });
        buf = buf.slice(startIdx + HARMONY_START.length);
        inBlock = true;
      } else {
        const endIdx = buf.indexOf(HARMONY_END);
        const nextStartIdx = buf.indexOf(HARMONY_START);
        if (nextStartIdx >= 0 && (endIdx < 0 || nextStartIdx < endIdx)) {
          const inner = buf.slice(0, nextStartIdx);
          buf = buf.slice(nextStartIdx + HARMONY_START.length);
          out.push(...handleCompleteBlock(inner));
          continue;
        }
        if (endIdx < 0) {
          if (buf.length > HARMONY_MAX_BUF) {
            out.push({ kind: 'text', text: HARMONY_START + buf });
            buf = '';
            inBlock = false;
          }
          break;
        }
        const inner = buf.slice(0, endIdx);
        buf = buf.slice(endIdx + HARMONY_END.length);
        inBlock = false;
        out.push(...handleCompleteBlock(inner));
      }
    }
    return out;
  };

  const flush = () => {
    if (!buf) return [];
    const text = inBlock ? HARMONY_START + buf : buf;
    buf = '';
    inBlock = false;
    return text ? [{ kind: 'text', text }] : [];
  };

  return { push, flush };
}

/**
 * Parse Connect stream frames into logical Devin stream events.
 */
export async function* events(it, uid = '', offeredToolNames = null) {
  let tools = -1;
  let stop = 0;
  let said = 0;
  const own = { calls: [], text: '', signature: '', type: '' };
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const harmony = createHarmonyFilter(offeredToolNames);

  function* emitFiltered(items) {
    for (const item of items) {
      if (item.kind === 'text') {
        own.text += item.text;
        yield { text: item.text };
      } else if (item.kind === 'reasoning') {
        yield { reasoning: item.text };
      } else if (item.kind === 'tool') {
        tools++;
        const id = 'call_' + randomBytes(12).toString('hex');
        own.calls.push(id);
        yield { tool: { index: tools, id, name: item.name } };
        yield { args: { index: tools, text: item.args } };
      }
    }
  }

  for (;;) {
    let r;
    try {
      r = await it.next();
    } catch (e) {
      yield { error: { status: 502, message: '回复中断：' + (e?.message || String(e)) } };
      return;
    }
    if (r.done) break;
    const f = r.value;
    if (f.end) {
      const e = failure(200, dec.decode(f.data));
      if (e.status >= 300) {
        yield { error: e };
        return;
      }
      break;
    }
    for (const x of fields(f.data)) {
      if (x.num === 3 && x.wire === 2 && x.data.length) {
        said += x.data.length;
        yield* emitFiltered(harmony.push(dec.decode(x.data)));
      } else if (x.num === 9 && x.wire === 2 && x.data.length) {
        said += x.data.length;
        yield { reasoning: dec.decode(x.data) };
      } else if (x.num === 10 && x.wire === 2 && x.data.length) {
        const signature = dec.decode(x.data);
        own.signature += signature;
        yield { signature };
      } else if (x.num === 21 && x.wire === 2 && x.data.length) {
        const signatureType = dec.decode(x.data);
        own.type = signatureType;
        yield { signatureType };
      } else if (x.num === 6 && x.wire === 2) {
        let id = '';
        let name = '';
        let args = '';
        for (const g of fields(x.data)) {
          if (g.num === 1) id = dec.decode(g.data ?? new Uint8Array());
          else if (g.num === 2) name = dec.decode(g.data ?? new Uint8Array());
          else if (g.num === 3) args += dec.decode(g.data ?? new Uint8Array());
        }
        if (name) {
          tools++;
          const outId = id ? outID(id) : 'call_' + randomBytes(12).toString('hex');
          own.calls.push(inID(outId));
          yield { tool: { index: tools, id: outId, name } };
        }
        if (args && tools >= 0) yield { args: { index: tools, text: args } };
      } else if (x.num === 5 && x.wire === 0) {
        stop = x.n;
      } else if (x.num === 7 && x.wire === 2) {
        for (const g of fields(x.data)) {
          if (g.wire !== 0 || !g.n) continue;
          if (g.num === 2) usage.input = g.n;
          else if (g.num === 3) usage.output = g.n;
          else if (g.num === 4) usage.cacheWrite = g.n;
          else if (g.num === 5) usage.cacheRead = g.n;
        }
      }
    }
  }
  yield* emitFiltered(harmony.flush());
  if (!said && tools < 0) {
    yield { error: { status: 502, message: '空回复（Devin 未返回文本、思考或工具调用）' } };
    return;
  }
  if (own.signature && isGemini(uid) && (own.type || 'gemini') === 'gemini') {
    rememberThought(own, { signature: own.signature, type: own.type || 'gemini', model: uid });
  }
  if (!usage.output) usage.output = Math.floor((said + 3) / 4);
  yield {
    stop: tools >= 0 || stop === 10 ? 'tool_calls' : stop === 3 ? 'length' : 'stop',
    tokens: usage
  };
}

/**
 * Drive events() while guaranteeing the underlying frame generator is closed
 * when the consumer stops early, so frames() releases the body reader lock.
 */
async function* eventsWithCleanup(it, uid, offeredToolNames) {
  try {
    yield* events(it, uid, offeredToolNames);
  } finally {
    try { await it.return?.(); } catch {}
  }
}

async function* prepend(first, rest) {
  yield first;
  yield* rest;
}

function parseArgsWithError(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { arguments: parsed };
    return { arguments: {}, argumentsError: '工具调用参数不是有效的 JSON 对象' };
  } catch (err) {
    return { arguments: {}, argumentsError: err instanceof Error ? err.message : 'Invalid tool call JSON arguments' };
  }
}

/**
 * Stream a pi-ai model call over Devin's Connect+Proto GetChatMessage RPC,
 * emitting pi-ai AssistantMessageEvents into an AssistantMessageEventStream.
 */
export function streamDevinChat({
  model,
  context,
  options,
  resolveCredential,
  AssistantMessageEventStream,
  calculateCost,
  families = [],
  toolsEnabled = true,
  requestedEffort,
  keepaliveConfig,
  fetchImpl = fetch
}) {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const output = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: Date.now()
    };

    const failStream = (status, message) => {
      const aborted = options?.signal?.aborted === true;
      output.stopReason = aborted ? 'aborted' : 'error';
      output.errorMessage = status ? `${status} ${message}` : message;
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    };

    try {
      const cred = await resolveCredential();
      const key = cred?.key;
      const server = cred?.server;
      if (!key) return failStream(401, 'Devin 尚未登录');

      const ka = keepaliveSettings(keepaliveConfig);
      const kaId = ka.enabled ? keepaliveKey(context, options) : '';
      if (kaId) stopKeepalive(kaId);

      const effort = requestedEffort !== undefined ? requestedEffort : options?.reasoning;
      const uid = variantFor(families, model.id, effort);
      const claude = isClaude(uid);
      const { bytes, makePing, offeredToolNames } = buildFromPiContext(model, context, options, uid, key, { toolsEnabled });
      const body = frame(bytes);
      const sentAt = Date.now();

      let res;
      try {
        res = await fetchImpl(server + CHAT_RPC, {
          method: 'POST',
          headers: rpcHeaders(key, body),
          body,
          signal: options?.signal
        });
      } catch (e) {
        return failStream(502, e?.message || String(e));
      }

      if (!res.ok) {
        const err = failure(res.status, (await res.text().catch(() => '')).slice(0, 1 << 20));
        return failStream(err.status, err.message);
      }

      const fr = frames(res.body);
      let first;
      try {
        first = await fr.next();
      } catch (e) {
        return failStream(502, '回复中断：' + (e?.message || String(e)));
      }
      if (first.done) return failStream(502, '回复中断：连接提前结束');
      if (first.value.end) {
        const err = failure(200, dec.decode(first.value.data));
        return failStream(err.status < 300 ? 502 : err.status, err.status < 300 ? '空回复' : err.message);
      }

      const source = eventsWithCleanup(prepend(first.value, fr), uid, offeredToolNames);
      const head = await source.next();
      if (head.done) return failStream(502, '空回复');
      if (head.value.error) {
        await fr.return?.().catch(() => {});
        return failStream(head.value.error.status, head.value.error.message);
      }

      stream.push({ type: 'start', partial: output });

      let openKind = '';
      let openIndex = -1;
      let sigType = '';
      const toolBuffers = new Map();

      const closeOpen = () => {
        if (!openKind || openIndex < 0) return;
        const block = output.content[openIndex];
        if (openKind === 'text') {
          stream.push({ type: 'text_end', contentIndex: openIndex, content: block.text, partial: output });
        } else if (openKind === 'thinking') {
          if (block.thinkingSignature) rememberSigType(block.thinkingSignature, sigType);
          stream.push({ type: 'thinking_end', contentIndex: openIndex, content: block.thinking, partial: output });
        } else if (openKind === 'toolCall') {
          const raw = toolBuffers.get(openIndex) ?? '';
          const parsed = parseArgsWithError(raw);
          block.arguments = parsed.arguments;
          if (parsed.argumentsError) block.argumentsError = parsed.argumentsError;
          stream.push({ type: 'toolcall_end', contentIndex: openIndex, toolCall: block, partial: output });
        }
        openKind = '';
        openIndex = -1;
      };

      const startBlock = (kind, block) => {
        closeOpen();
        openIndex = output.content.length;
        openKind = kind;
        output.content.push(block);
        if (kind === 'text') stream.push({ type: 'text_start', contentIndex: openIndex, partial: output });
        else if (kind === 'thinking') stream.push({ type: 'thinking_start', contentIndex: openIndex, partial: output });
        else if (kind === 'toolCall') stream.push({ type: 'toolcall_start', contentIndex: openIndex, partial: output });
      };

      const toolContentIndexByStreamIdx = new Map();
      let lastToolStreamIdx = -1;

      for await (const e of prepend(head.value, source)) {
        if (e.error) {
          closeOpen();
          return failStream(e.error.status, e.error.message);
        }
        if (e.signatureType) {
          sigType = e.signatureType;
          const active = output.content[openIndex];
          if (openKind === 'thinking' && active?.thinkingSignature) rememberSigType(active.thinkingSignature, sigType);
          continue;
        }
        if (e.signature) {
          if (openKind === 'thinking' && claude) {
            const active = output.content[openIndex];
            active.thinkingSignature = (active.thinkingSignature ?? '') + e.signature;
          }
          continue;
        }
        if (e.reasoning) {
          if (openKind !== 'thinking') startBlock('thinking', { type: 'thinking', thinking: '' });
          output.content[openIndex].thinking += e.reasoning;
          stream.push({ type: 'thinking_delta', contentIndex: openIndex, delta: e.reasoning, partial: output });
          continue;
        }
        if (e.text) {
          if (openKind !== 'text') startBlock('text', { type: 'text', text: '' });
          output.content[openIndex].text += e.text;
          stream.push({ type: 'text_delta', contentIndex: openIndex, delta: e.text, partial: output });
          continue;
        }
        if (e.tool) {
          lastToolStreamIdx = e.tool.index;
          startBlock('toolCall', { type: 'toolCall', id: e.tool.id, name: e.tool.name, arguments: {} });
          toolContentIndexByStreamIdx.set(e.tool.index, openIndex);
          toolBuffers.set(openIndex, '');
          continue;
        }
        if (e.args) {
          const idx = toolContentIndexByStreamIdx.get(e.args.index ?? lastToolStreamIdx);
          if (idx === undefined) continue;
          toolBuffers.set(idx, (toolBuffers.get(idx) ?? '') + e.args.text);
          stream.push({ type: 'toolcall_delta', contentIndex: idx, delta: e.args.text, partial: output });
          continue;
        }
        if (e.stop) {
          closeOpen();
          const t = e.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          output.usage = {
            input: t.input,
            output: t.output,
            cacheRead: t.cacheRead,
            cacheWrite: t.cacheWrite,
            totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          };
          try { calculateCost(model, output.usage); } catch {}
          output.stopReason = e.stop === 'tool_calls' ? 'toolUse' : e.stop === 'length' ? 'length' : 'stop';
          if (ka.enabled && kaId && (t.cacheRead > 0 || t.cacheWrite > 0)) {
            scheduleKeepalive({ id: kaId, interval: ka.interval, max: ka.max }, key, server, makePing(), sentAt, fetchImpl);
          }
          stream.push({ type: 'done', reason: output.stopReason, message: output });
          stream.end();
          return;
        }
      }

      closeOpen();
      output.stopReason = 'stop';
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      failStream(502, error instanceof Error ? error.message : String(error));
    }
  })();

  return stream;
}
