import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_SERVER } from './pb.mjs';
import { parseCliCatalog, parseFamilies } from './catalog.mjs';

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function cliPath(explicitPath = '') {
  if (explicitPath && isFile(explicitPath)) return explicitPath;
  const exe = process.platform === 'win32' ? 'devin.exe' : 'devin';
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir && isFile(join(dir, exe))) return join(dir, exe);
  }
  for (const p of [join(homedir(), '.local', 'bin', exe), '/usr/local/bin/devin', '/opt/homebrew/bin/devin']) {
    if (isFile(p)) return p;
  }
  return '';
}

export function cliCredentialsPath() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'devin', 'credentials.toml');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'devin', 'credentials.toml');
}

const tomlString = (s) => '"' + String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

export function credentials(key, server, webapp, api) {
  return [
    ['windsurf_api_key', key],
    ['api_server_url', server || DEFAULT_SERVER],
    ['devin_webapp_host', webapp || 'app.devin.ai'],
    ['devin_api_url', api || 'https://api.devin.ai']
  ]
    .map(([k, v]) => `${k} = ${tomlString(v)}\n`)
    .join('');
}

export function readCredentials(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*$/.exec(line);
    if (m) out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return out;
}

function normalizeCliServer(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_SERVER;
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return DEFAULT_SERVER;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return DEFAULT_SERVER;
  }
}

export async function homeFor(key, server, cacheBase) {
  const base = cacheBase || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dsh-devin-provider');
  const home = join(base, createHash('sha256').update(key).digest('hex').slice(0, 16));
  const file = join(home, 'devin', 'credentials.toml');
  if (!existsSync(file)) {
    await mkdir(join(home, 'devin'), { recursive: true, mode: 0o700 });
    await writeFile(file, credentials(key, server), { mode: 0o600 });
  }
  return home;
}

export function runCLI(home, args, { executable = '', spawnImpl = spawn, signal } = {}) {
  const path = cliPath(executable);
  if (!path) return Promise.reject(new Error('未找到 devin CLI 可执行文件'));
  const env = { ...process.env };
  if (home) {
    for (const k of Object.keys(env)) {
      if (['XDG_DATA_HOME', 'APPDATA'].includes(k.toUpperCase())) delete env[k];
    }
    env.XDG_DATA_HOME = home;
    env.APPDATA = home;
  }
  return new Promise((res, rej) => {
    const p = spawnImpl(path, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout?.on('data', (b) => {
      out += b;
    });
    const timer = setTimeout(() => p.kill(), 30_000);
    const onAbort = () => p.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rej(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      res({ out, code });
    });
  });
}

const signedOut = (out) =>
  ['Not logged in', 'Authentication required', 'Invalid token', 'try logging out and logging in again'].some((s) => out.includes(s));

function statusField(out, key) {
  for (const l of String(out ?? '').split(/\r?\n/)) {
    const t = l.trim();
    if (t.startsWith(key + ':')) return t.slice(key.length + 1).trim();
  }
  return '';
}

export function parseStatus(out) {
  if (!String(out ?? '').includes('Logged in')) return null;
  const field = (key) => statusField(out, key);
  const teamId = field('Team ID');
  return {
    user: field('Email') || field('Name'),
    plan: field('Tier') || field('Plan'),
    ...(teamId ? { teamId } : {})
  };
}

function inside(file, dir) {
  const real = (p) => {
    let r;
    try {
      r = realpathSync(p);
    } catch {
      r = resolve(p);
    }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const rel = relative(real(dir), real(file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function readsHome(out, home) {
  const file = statusField(out, 'File');
  return !home || !file || inside(file, home);
}

export async function cliIdentity(home, opts) {
  try {
    const { out } = await runCLI(home, ['auth', 'status'], opts);
    if (!readsHome(out, home)) return undefined;
    const st = parseStatus(out);
    if (st?.user) return st;
    if (signedOut(out)) return null;
  } catch {}
  return undefined;
}

export async function cliModels(home, opts) {
  const { out } = await runCLI(home, ['models', 'list', '--format', 'json'], opts);
  const families = parseFamilies(out);
  if (!families.length) throw new Error('devin models list 未返回模型');
  return families;
}

export async function cliCatalog(home, opts) {
  const { out } = await runCLI(home, ['models', 'list', '--format', 'json'], opts);
  const catalog = parseCliCatalog(out);
  if (!catalog.families.length) throw new Error('devin models list 未返回模型');
  return catalog;
}

export async function readCliCredentials(path = cliCredentialsPath()) {
  const c = readCredentials(await readFile(path, 'utf8'));
  return {
    key: c.windsurf_api_key || '',
    server: normalizeCliServer(process.env.WINDSURF_API_SERVER_URL || c.api_server_url || DEFAULT_SERVER)
  };
}
