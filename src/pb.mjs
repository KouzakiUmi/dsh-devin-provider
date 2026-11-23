import { Buffer } from 'node:buffer';
import { STATUS_CODES } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';

export const DEFAULT_SERVER = 'https://server.codeium.com';
export const AUTHORIZE_URL = 'https://app.devin.ai/auth/cli/continue';
export const EXCHANGE_RPC = '/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode';
export const USER_STATUS_RPC = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
export const MODEL_CONFIGS_RPC = '/exa.api_server_pb.ApiServerService/GetCliModelConfigs';
export const CHAT_RPC = '/exa.api_server_pb.ApiServerService/GetChatMessage';
export const ASSIGN_MODEL_RPC = '/exa.api_server_pb.ApiServerService/AssignModel';
export const CLI_VERSION = '3000.11.3';
export const GZIP_AT = 8 << 10;

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const osName = () => (process.platform === 'win32' ? 'windows' : process.platform);

/**
 * Minimal hand-rolled Protobuf encoder (varint, length-delimited bytes/string, double).
 */
export class PB {
  constructor() {
    this.parts = [];
  }
  uvarint(n) {
    const b = [];
    n = BigInt(n);
    while (n >= 0x80n) {
      b.push(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    b.push(Number(n));
    this.parts.push(Uint8Array.from(b));
  }
  varint(num, v) {
    this.uvarint((num << 3) | 0);
    this.uvarint(v);
    return this;
  }
  bytes(num, v) {
    if (typeof v === 'string') v = enc.encode(v);
    else if (v instanceof PB) v = v.done();
    this.uvarint((num << 3) | 2);
    this.uvarint(v.length);
    this.parts.push(v);
    return this;
  }
  str(num, v) {
    return this.bytes(num, v);
  }
  double(num, v) {
    this.uvarint((num << 3) | 1);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.parts.push(b);
    return this;
  }
  done() {
    const n = this.parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/**
 * Decode top-level protobuf fields from a Uint8Array; drops a malformed tail.
 */
export function fields(b) {
  const out = [];
  let i = 0;
  const uvarint = () => {
    let n = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= b.length) return null;
      const c = b[i++];
      n |= BigInt(c & 0x7f) << shift;
      if (!(c & 0x80)) return n;
      shift += 7n;
    }
  };
  while (i < b.length) {
    const key = uvarint();
    if (key === null) break;
    const f = { num: Number(key >> 3n), wire: Number(key & 7n), n: 0, data: null };
    if (f.wire === 0) {
      const v = uvarint();
      if (v === null) break;
      f.n = Number(v);
    } else if (f.wire === 1) {
      if (i + 8 > b.length) break;
      i += 8;
    } else if (f.wire === 2) {
      const l = uvarint();
      if (l === null || i + Number(l) > b.length) break;
      f.data = b.subarray(i, i + Number(l));
      i += Number(l);
    } else if (f.wire === 5) {
      if (i + 4 > b.length) break;
      f.data = b.subarray(i, i + 4);
      i += 4;
    } else {
      break;
    }
    out.push(f);
  }
  return out;
}

/**
 * Wrap a protobuf message as a single Connect+Proto frame (gzipped above 8 KiB).
 */
export function frame(msg) {
  const zip = msg.length > GZIP_AT;
  const body = zip ? gzipSync(msg) : msg;
  const out = new Uint8Array(5 + body.length);
  out[0] = zip ? 1 : 0;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

/**
 * Async-iterate Connect stream frames from a ReadableStream.
 */
export async function* frames(body) {
  let buf = new Uint8Array(0);
  const reader = body.getReader();
  try {
    for (;;) {
      while (buf.length >= 5) {
        const n = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
        if (n > 64 << 20) throw new Error('a malformed stream');
        if (buf.length < 5 + n) break;
        const flags = buf[0];
        let data = buf.slice(5, 5 + n);
        buf = buf.slice(5 + n);
        if (flags & 1) data = new Uint8Array(gunzipSync(data));
        yield { end: !!(flags & 2), data };
      }
      const { value, done } = await reader.read();
      if (done) {
        if (buf.length) throw new Error('unexpected EOF');
        return;
      }
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  } finally {
    reader.releaseLock();
  }
}

export const metadata = (key) =>
  new PB()
    .str(1, 'devin-cli')
    .str(2, CLI_VERSION)
    .str(3, key)
    .str(4, 'en')
    .str(5, osName())
    .str(7, CLI_VERSION)
    .str(12, 'chisel')
    .str(28, 'chisel');

export const rpcHeaders = (key, body) => ({
  'Content-Type': 'application/connect+proto',
  'Connect-Protocol-Version': '1',
  ...(body[0] & 1 ? { 'Connect-Content-Encoding': 'gzip' } : {}),
  Authorization: 'Basic ' + key
});

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
export const outID = (id) => (SAFE_ID.test(id) && !id.startsWith('dv_') ? id : 'dv_' + Buffer.from(id).toString('base64url'));
export const inID = (id) => {
  if (typeof id !== 'string' || !id.startsWith('dv_') || !SAFE_ID.test(id)) return id;
  const raw = Buffer.from(id.slice(3), 'base64url').toString();
  return raw && outID(raw) === id ? raw : id;
};

const statusText = (s) =>
  ({ 413: 'Request Entity Too Large', 414: 'Request URI Too Long', 416: 'Requested Range Not Satisfiable', 418: "I'm a teapot", 509: '' })[s] ??
  STATUS_CODES[s] ??
  '';

export function failure(status, text) {
  let msg = String(text ?? '').trim();
  let code = '';
  try {
    const e = JSON.parse(text);
    if (e?.error && typeof e.error === 'object') [code, msg] = [e.error.code ?? '', e.error.message ?? ''];
    else if (e?.code) [code, msg] = [e.code, e.message ?? ''];
    msg ||= code;
  } catch {}
  msg ||= statusText(status) || `HTTP ${status}`;
  const low = msg.toLowerCase();
  if (code === 'unauthenticated') return { status: 401, message: msg + ' — sign in to Devin again' };
  if (code === 'resource_exhausted' || low.includes('quota') || low.includes('rate limit')) {
    return { status: 429, message: 'usage limit reached: ' + msg };
  }
  if (low.includes('content policy')) return { status: 400, message: msg };
  if (low.includes('too long') || low.includes('context length') || low.includes('too many tokens')) {
    return { status: 400, message: "input is too long for the model's context: " + msg };
  }
  if (code === 'invalid_argument') return { status: 400, message: msg };
  if (code === 'unavailable') return { status: 503, message: msg };
  if (code) return { status: 502, message: msg };
  return { status, message: msg };
}
