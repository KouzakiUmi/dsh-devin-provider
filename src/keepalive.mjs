import { createHash } from 'node:crypto';
import { CHAT_RPC, dec, failure, fields, frame, frames, rpcHeaders } from './pb.mjs';

export const KEEPALIVE_INTERVAL = 285;
export const KEEPALIVE_MAX = 6;
export const KEEPALIVE_KEPT = 32;
const KEEPALIVE_STOP = new Set([401, 402, 429]);

const realTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t),
  now: () => Date.now()
};
let timers = realTimers;
const now = () => (timers.now ?? Date.now)();

const keeps = new Map();
const firsts = new Map();
const FIRSTS_KEPT = 256;

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

export function useTimers(t) {
  timers = t ?? realTimers;
}

export function keepaliveSettings(options = {}) {
  const sec = Number(options?.intervalSec ?? options?.cacheKeepaliveInterval);
  const max = Number(options?.maxPings ?? options?.cacheKeepaliveMaxPings);
  return {
    enabled: options?.enabled === true,
    interval: (Number.isFinite(sec) && sec >= 30 && sec <= 299 ? sec : KEEPALIVE_INTERVAL) * 1000,
    max: Number.isInteger(max) && max >= 1 && max <= 50 ? max : KEEPALIVE_MAX
  };
}

function firstOf(group, first) {
  const hashes = first.map(sha);
  let best;
  let most;
  for (const [id, f] of firsts) {
    if (f.group !== group || f.n > first.length || (f.n === 0) !== (first.length === 0)) continue;
    if (f.n > 0) {
      const t = first[f.n - 1];
      if (f.blocks.some((x, j) => x !== hashes[j]) || t.length < f.last.len || sha(t.slice(0, f.last.len)) !== f.last.hash) continue;
    }
    if (!best || f.n > most.n || (f.n === most.n && f.last.len > most.last.len)) {
      best = id;
      most = f;
    }
  }
  const id = best ?? [group, sha(JSON.stringify(first))].join('\n');
  const t = first.at(-1) ?? '';
  firsts.delete(id);
  firsts.set(id, { group, n: first.length, blocks: hashes.slice(0, -1), last: { len: t.length, hash: sha(t) } });
  while (firsts.size > FIRSTS_KEPT) firsts.delete(firsts.keys().next().value);
  return id;
}

function textsOfPiContent(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : b?.type ?? ''));
}

export function keepaliveKey(context, options = {}) {
  const session = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  const system = context?.systemPrompt ? [String(context.systemPrompt)] : [];
  const tools = (context?.tools ?? []).map((t) => t?.name ?? '');
  const group = [session, sha(JSON.stringify([system, tools]))].join('\n');
  if (session) return group;
  const firstMsg = (context?.messages ?? []).find((m) => m?.role === 'user');
  const first = textsOfPiContent(firstMsg?.content);
  return firstOf(group, first);
}

export function stopKeepalive(id) {
  const k = keeps.get(id);
  if (!k) return;
  keeps.delete(id);
  if (k.timer) timers.clear(k.timer);
  k.ctl?.abort();
}

export function stopAllKeepalive() {
  for (const id of [...keeps.keys()]) stopKeepalive(id);
}

export function keeping() {
  return [...keeps.keys()];
}

let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.once?.('exit', stopAllKeepalive);
}

export async function pingOnce(server, key, body, signal, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(server + CHAT_RPC, { method: 'POST', headers: rpcHeaders(key, body), body, signal });
  } catch (e) {
    return { status: 0, error: String(e?.message || e || 'fetch failed') };
  }
  const failed = (e) => ({ status: e.status, error: e.message });
  if (!res.ok) return failed(failure(res.status, (await res.text().catch(() => '')).slice(0, 1 << 16)));
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  try {
    for await (const f of frames(res.body)) {
      if (f.end) {
        const e = failure(200, dec.decode(f.data));
        if (e.status >= 300) return failed(e);
        break;
      }
      for (const x of fields(f.data)) {
        if (x.num !== 7 || x.wire !== 2) continue;
        for (const g of fields(x.data)) {
          if (g.wire !== 0) continue;
          if (g.num === 2) tokens.input = g.n;
          else if (g.num === 3) tokens.output = g.n;
          else if (g.num === 4) tokens.cacheWrite = g.n;
          else if (g.num === 5) tokens.cacheRead = g.n;
        }
      }
    }
  } catch (e) {
    return { status: 0, error: String(e?.message || e || '回复中断') };
  }
  return { status: 200, tokens };
}

export function scheduleKeepalive(keep, key, server, pingBytes, sentAt = now(), fetchImpl = fetch) {
  const { id, interval, max } = keep;
  if (!pingBytes) return;
  stopKeepalive(id);
  while (keeps.size >= KEEPALIVE_KEPT) stopKeepalive(keeps.keys().next().value);
  const body = frame(pingBytes);
  const k = { n: 0, misses: 0, timer: null, ctl: null };
  keeps.set(id, k);
  hookExit();
  const next = (from) => {
    k.timer = timers.set(run, Math.max(0, interval - Math.max(0, now() - from)));
    k.timer?.unref?.();
  };
  const run = async () => {
    k.timer = null;
    if (keeps.get(id) !== k) return;
    k.n++;
    const ctl = (k.ctl = new AbortController());
    const at = now();
    const r = await pingOnce(server, key, body, ctl.signal, fetchImpl);
    k.ctl = null;
    if (keeps.get(id) !== k) return;
    if (KEEPALIVE_STOP.has(r.status)) return stopKeepalive(id);
    const t = r.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const hit = r.status === 200 && t.cacheRead > 0 && t.cacheRead * 2 >= t.input + t.cacheRead + t.cacheWrite;
    k.misses = hit ? 0 : k.misses + 1;
    if (k.misses >= 2 || k.n >= max) return stopKeepalive(id);
    next(at);
  };
  next(sentAt);
}
