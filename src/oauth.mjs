import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AUTHORIZE_URL, DEFAULT_SERVER, EXCHANGE_RPC } from './pb.mjs';

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

function page(ok, title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}main{text-align:center;max-width:28rem;padding:1rem}
.d{font-size:2rem;color:${ok ? '#2a9d5c' : '#c0392b'}}</style>
<main><div class="d">${ok ? '✓' : '✕'}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></main>`;
}

export async function exchangeCode(code, verifier, redirect, { server = DEFAULT_SERVER, fetchImpl = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetchImpl(server + EXCHANGE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirect }),
    signal: combined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Devin token 交换失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  let r = {};
  try {
    r = JSON.parse(text);
  } catch {}
  const key = r.sessionToken || r.session_token;
  if (!key) throw new Error('Devin token 交换未返回 sessionToken');
  return { key, server };
}

export class DevinOAuth {
  constructor({ onSuccess, fetchImpl = fetch, server = DEFAULT_SERVER } = {}) {
    this.onSuccess = onSuccess;
    this.fetchImpl = fetchImpl;
    this.defaultServer = server;
    this.current = { jobId: null, accountId: null, state: 'idle', message: '', url: null };
    this.server = null;
    this.timer = null;
    this.controller = null;
  }

  status() {
    return { ...this.current };
  }

  async start({ accountId, revision, server }) {
    if (['launching', 'waiting', 'verifying'].includes(this.current.state)) {
      throw new Error('已有登录流程正在进行，请先完成或取消');
    }
    const jobId = randomUUID();
    const targetServer = server || this.defaultServer;
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const ctl = new AbortController();
    this.controller = ctl;

    const cleanup = () => {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.server) {
        const s = this.server;
        this.server = null;
        setTimeout(() => {
          try {
            s.close();
          } catch {}
        }, 300).unref?.();
      }
      this.controller = null;
    };

    let redirect = '';
    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const html = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(body);
      };
      if (url.pathname !== '/callback') return res.writeHead(404).end();
      const q = url.searchParams;
      if (this.current.jobId !== jobId || !['waiting', 'verifying'].includes(this.current.state)) {
        return html(200, page(false, '登录已结束', '请回到 DSH 设置页重新发起登录。'));
      }
      if (q.get('error')) {
        const msg = q.get('error_description') || q.get('error');
        this.current = { jobId, accountId, state: 'error', message: `浏览器授权失败：${msg}`, url: null };
        cleanup();
        return html(200, page(false, '登录未完成', msg));
      }
      if (q.get('state') !== state || !q.get('code')) {
        return html(200, page(false, '回调参数不匹配', '请使用当前登录生成的链接重试。'));
      }
      this.current = { jobId, accountId, state: 'verifying', message: '正在交换凭据并核验账号身份…', url: null };
      try {
        const exchanged = await exchangeCode(q.get('code'), verifier, redirect, { server: targetServer, fetchImpl: this.fetchImpl, signal: ctl.signal });
        if (ctl.signal.aborted || this.current.jobId !== jobId) return;
        await this.onSuccess({ accountId, key: exchanged.key, server: exchanged.server, revision, signal: ctl.signal });
        if (ctl.signal.aborted || this.current.jobId !== jobId) return;
        this.current = { jobId, accountId, state: 'success', message: '登录成功，凭据已安全保存。', url: null };
        cleanup();
        html(200, page(true, 'Devin 登录成功', '账号已完成绑定，可以关闭此标签页并返回 DeepSeek Harness。'));
      } catch (err) {
        if (ctl.signal.aborted || this.current.jobId !== jobId) return;
        const msg = err instanceof Error ? err.message : String(err);
        this.current = { jobId, accountId, state: 'error', message: msg, url: null };
        cleanup();
        html(200, page(false, '登录验证失败', msg));
      }
    });

    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    this.server = httpServer;
    redirect = `http://127.0.0.1:${httpServer.address().port}/callback`;

    const query = new URLSearchParams({
      redirect_uri: redirect,
      state,
      prompt: 'select_account',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      cli_pkce_marker: '1'
    });
    const authorizeUrl = `${AUTHORIZE_URL}?${query}`;
    this.current = {
      jobId,
      accountId,
      state: 'waiting',
      message: '请点击下方链接在浏览器完成 Devin 登录，完成后自动回传。',
      url: authorizeUrl
    };

    this.timer = setTimeout(() => {
      if (this.current.jobId !== jobId) return;
      this.current = { jobId, accountId, state: 'error', message: '登录超时（10 分钟），请重试。', url: null };
      ctl.abort();
      cleanup();
    }, SIGN_IN_TIMEOUT_MS);
    this.timer.unref?.();

    return this.status();
  }

  cancel(jobId) {
    if (jobId && this.current.jobId && this.current.jobId !== jobId) {
      throw new Error('登录任务标识不匹配');
    }
    if (!['launching', 'waiting', 'verifying'].includes(this.current.state)) {
      return this.status();
    }
    this.controller?.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
    this.controller = null;
    this.current = {
      jobId: this.current.jobId,
      accountId: this.current.accountId,
      state: 'cancelled',
      message: '登录已取消。',
      url: null
    };
    return this.status();
  }

  dispose() {
    this.controller?.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
    this.controller = null;
  }
}
