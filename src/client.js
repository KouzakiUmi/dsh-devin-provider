// dsh-devin-provider —— 设置页（Client 侧）
//
// 实现约束：React createElement（无 JSX）、无 Node 依赖、无第三方新增安装。
// 与 Host 通过 remote.devinProvider.invoke({ op, ... }) 单一 RPC 通信。

const react = typeof require === 'function' ? require('react') : globalThis.React;
const h = (type, props, ...children) => {
  const control = ['button', 'input', 'select', 'textarea'].includes(type);
  const buttonClass = type === 'button'
    ? `ddp-button${props?.style === style.primary ? ' ddp-button-primary' : ''}${props?.className ? ` ${props.className}` : ''}`
    : props?.className;
  const themedProps = buttonClass === props?.className ? props : { ...props, className: buttonClass };
  const visibleProps = control && props?.disabled
    ? { ...themedProps, style: { ...props.style, opacity: 0.5, cursor: 'not-allowed' } }
    : themedProps;
  return react.createElement(type, visibleProps, ...children);
};

// ── 常量 ─────────────────────────────────────────────────────────────────────

const LOGIN_ACTIVE_STATES = ['launching', 'waiting', 'verifying'];
const NEW_LOGIN_ACCOUNT = '__new__';
const SERVICE_DEADLINE_MS = 20000;
const LOGIN_POLL_MS = 1000;
const KNOWN_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const AUTH_MODE_LABELS = {
  oauth: '浏览器 PKCE 登录',
  cli: '本机 devin CLI',
  'api-key': 'API Key / Session Token',
  reference: 'DSH 凭据引用名'
};

const CATALOG_SOURCE_LABELS = {
  'local-snapshot': '本地快照',
  remote: 'Devin 远程接口',
  cli: 'devin CLI'
};

const LOGIN_STATE_LABELS = {
  idle: '尚未开始登录。',
  launching: '正在启动本地回调并生成 Devin 登录链接…',
  waiting: '请点击下方链接在浏览器中完成 Devin 登录，完成后页面会自动更新。',
  verifying: '正在交换凭据并核验账号身份…',
  success: '登录成功，凭据已安全保存。',
  cancelled: '登录已取消。',
  error: '登录失败。'
};

const LOGIN_CONFIRM_NOTES = [
  '插件会在本机 127.0.0.1 临时监听随机端口用于接收 PKCE 回调，并生成官方 app.devin.ai 授权链接；插件不会自动启动浏览器，由你手动点击链接完成授权。',
  '拿到的 session token 会保存至 DSH 凭据存储（或插件隔离凭据文件），不会写入 state.json，也不会改动本机 devin CLI 自身的 credentials.toml。',
  '取消登录或超时会自动关闭临时回调端口。'
];

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const SAFE_LOGIN_PATHS = new Map([
  ['app.devin.ai', /^\/auth\/cli\/continue\/?$/]
]);

const THINKING_PRESETS = [
  { value: 'inherit', label: '继承目录默认' },
  { value: 'server', label: '服务端默认（不强制）' },
  { value: 'saver', label: '省 token（低档位）' },
  { value: 'max', label: '最强思考（高档位）' },
  { value: 'off', label: '关闭思考（如支持）' }
];
const SAVER_TIER_ORDER = ['low', 'minimal', 'medium'];
const MAX_TIER_ORDER = ['max', 'xhigh', 'high'];

const MODEL_FIELD_LABELS = {
  contextWindow: '上下文长度 contextWindow',
  maxTokens: '最大输出 token maxTokens',
  temperature: '温度 temperature'
};

const CAPACITY_LEVELS = {
  contextWindow: [131072, 262144, 524288, 1048576],
  maxTokens: [32768, 65536, 131072, 262144]
};

// ── 样式 ─────────────────────────────────────────────────────────────────────

const style = {
  root: { display: 'flex', flexDirection: 'column', gap: 12 },
  title: { margin: 0, fontSize: 18, fontWeight: 650, lineHeight: 1.35, letterSpacing: '-.015em' },
  card: {
    minWidth: 0,
    border: '1px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2, rgba(128,128,128,.24)))',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.025))'
  },
  cardTitle: { margin: 0, fontSize: 15, lineHeight: 1.4, fontWeight: 650 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 180px', minWidth: 0 },
  label: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary, inherit)' },
  input: {
    width: '100%', minWidth: 0, minHeight: 32, boxSizing: 'border-box', padding: '6px 9px',
    borderRadius: 7, fontSize: 12,
    border: '1px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2, rgba(128,128,128,.35)))',
    background: 'var(--dsw-alias-bg-layer-2, Canvas)', color: 'inherit', font: 'inherit'
  },
  btn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 32,
    padding: '6px 10px', borderRadius: 7, fontSize: 12,
    border: '1px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2, rgba(128,128,128,.3)))',
    background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))', color: 'inherit', cursor: 'pointer', font: 'inherit'
  },
  primary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 32,
    padding: '6px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600,
    border: '1px solid var(--dsw-alias-brand-primary, #2563eb)',
    background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #2563eb))',
    color: 'var(--dsw-alias-label-primary-foreground, #fff)',
    cursor: 'pointer', font: 'inherit'
  },
  danger: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 32,
    padding: '6px 10px', borderRadius: 7, fontSize: 12,
    border: '1px solid var(--dsw-alias-state-error-primary, rgba(220,38,38,.55))',
    background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
    cursor: 'pointer', font: 'inherit'
  },
  muted: { margin: 0, lineHeight: 1.55, fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)', overflowWrap: 'anywhere' },
  error: { margin: 0, fontSize: 12, lineHeight: 1.6, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)', overflowWrap: 'anywhere' },
  warn: { margin: 0, fontSize: 12, lineHeight: 1.6, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)', overflowWrap: 'anywhere' },
  success: { margin: 0, fontSize: 12, lineHeight: 1.6, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)', overflowWrap: 'anywhere' },
  chip: {
    display: 'inline-flex', alignItems: 'center', maxWidth: '100%', fontSize: 11, lineHeight: 1.6,
    padding: '1px 8px', borderRadius: 999, whiteSpace: 'nowrap', overflowWrap: 'anywhere',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08))'
  },
  summary: { cursor: 'pointer', minHeight: 30, padding: '5px 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' }
};

const CLIENT_STYLES = `
.ddp-settings{color:var(--dsw-alias-label-primary,inherit);color-scheme:light;max-width:1080px;padding:4px 2px 32px;font-size:13px;line-height:1.5;container-type:inline-size;container-name:ddp;-webkit-font-smoothing:antialiased}
body[data-ds-dark-theme] .ddp-settings{color-scheme:dark}
.ddp-settings *{box-sizing:border-box}.ddp-settings :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:3px}
.ddp-settings input::placeholder,.ddp-settings textarea::placeholder{color:var(--dsw-alias-label-secondary,GrayText);opacity:1}
.ddp-settings select option{color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-1,Canvas)}
.ddp-content{display:flex;flex-direction:column;gap:14px}.ddp-content[data-empty=true] .ddp-account-panel{order:-1}
.ddp-hero{display:flex;align-items:center;gap:12px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.2));border-radius:16px;background:linear-gradient(145deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 8%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff) 58%)}
.ddp-brand-mark{display:flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;border-radius:12px;background:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-label-primary-foreground,#fff);font-size:18px;font-weight:750}
.ddp-header-copy{flex:1;min-width:0}.ddp-hero-subtitle{margin:4px 0 0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,inherit)}
.ddp-eyebrow{margin-bottom:3px;font-size:10px;font-weight:700;letter-spacing:.09em;color:var(--dsw-alias-label-secondary,inherit)}
.ddp-card{display:flex;flex-direction:column;gap:12px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.2));border-radius:14px;background:var(--dsw-alias-bg-layer-1,Canvas)}
.ddp-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px;align-items:start}
.ddp-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.ddp-heading-copy{flex:1 1 180px;min-width:0}.ddp-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}
.ddp-chip-row{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
.ddp-section{border-top:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.14));padding-top:10px;display:flex;flex-direction:column;gap:8px;min-width:0}
.ddp-notice{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.18));border-left:3px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-2,Canvas);overflow-wrap:anywhere}
.ddp-notice>p{flex:1 1 180px;min-width:0}.ddp-notice-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;border-radius:50%;background:var(--dsw-alias-label-secondary,#94a3b8);color:var(--dsw-alias-bg-layer-1,#fff);font-size:13px;font-weight:750;line-height:1}
.ddp-notice[data-tone=error]{border-left-color:var(--dsw-alias-state-error-primary,#dc2626)}.ddp-notice[data-tone=warn]{border-left-color:var(--dsw-alias-state-warn-primary,#b45309)}.ddp-notice[data-tone=success]{border-left-color:var(--dsw-alias-state-success-primary,#16a34a)}
.ddp-notice[data-tone=error] .ddp-notice-icon{background:var(--dsw-alias-state-error-primary,#dc2626)}.ddp-notice[data-tone=warn] .ddp-notice-icon{background:var(--dsw-alias-state-warn-primary,#b45309)}.ddp-notice[data-tone=success] .ddp-notice-icon{background:var(--dsw-alias-state-success-primary,#16a34a)}
.ddp-switch-input{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:34px;height:20px;margin:0;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#1f2937);cursor:pointer}
.ddp-switch-input::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:currentColor;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.ddp-switch-input:checked{border-color:var(--dsw-alias-brand-primary,#2563eb);background:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-label-primary-foreground,#fff)}.ddp-switch-input:checked::after{transform:translateX(14px)}
body[data-ds-dark-theme] .ddp-switch-input:checked{color:#11161e}.ddp-switch-input:disabled{opacity:.55;cursor:not-allowed}
.ddp-toggle{display:inline-flex;align-items:center;gap:7px;min-height:28px;font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer}
.ddp-status-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.18));border-radius:999px;font-size:11px;line-height:1.6;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.06))}
.ddp-status-chip::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
.ddp-status-chip[data-tone=success]{color:var(--dsw-alias-state-success-primary,#15803d);border-color:color-mix(in srgb,currentColor 30%,transparent);background:color-mix(in srgb,currentColor 8%,transparent)}
.ddp-status-chip[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#b45309);border-color:color-mix(in srgb,currentColor 30%,transparent);background:color-mix(in srgb,currentColor 8%,transparent)}
.ddp-quota-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:8px}
.ddp-quota-window{display:grid;gap:6px;min-width:0;padding:10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.12));background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.045))}
.ddp-quota-window[data-tone=error]{background:var(--dsw-alias-state-error-bg,rgba(220,38,38,.08))}.ddp-quota-window[data-tone=warn]{background:var(--dsw-alias-state-warn-bg,rgba(180,83,9,.08))}
.ddp-quota-line{display:flex;align-items:center;gap:7px;min-width:0}.ddp-quota-name{font-size:12px;font-weight:600}.ddp-quota-value{display:flex;align-items:baseline;gap:4px;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.ddp-quota-percent{font-size:18px;line-height:1.05;font-weight:700}.ddp-quota-track{width:100%;height:6px;border-radius:99px;overflow:hidden;background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.2))}
.ddp-quota-fill{height:100%;border-radius:99px;background:var(--dsw-alias-brand-primary,#3b82f6)}.ddp-quota-window[data-tone=error] .ddp-quota-fill{background:var(--dsw-alias-state-error-primary,#dc2626)}.ddp-quota-window[data-tone=warn] .ddp-quota-fill{background:var(--dsw-alias-state-warn-primary,#b45309)}
.ddp-quota-meta{display:grid;gap:2px;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.ddp-model-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:10px;margin-top:8px}
.ddp-model{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));border-radius:11px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.035))}
.ddp-model[data-disabled=true]{opacity:.66}.ddp-model-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0}
.ddp-model-toggle{display:flex;align-items:flex-start;gap:8px;flex:1 1 auto;min-width:0;cursor:pointer}.ddp-model-name{font-size:13px;font-weight:650;overflow-wrap:anywhere}
.ddp-model-tags{display:flex;gap:5px;flex-wrap:wrap}.ddp-model-tag{display:inline-flex;align-items:center;padding:2px 7px;border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.16));border-radius:999px;font-size:10px;line-height:1.55;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.04))}
.ddp-model-tag[data-tone=accent]{color:var(--dsw-alias-brand-primary,#2563eb);border-color:color-mix(in srgb,currentColor 25%,transparent);background:color-mix(in srgb,currentColor 6%,transparent)}
.ddp-model-tag[data-tone=success]{color:var(--dsw-alias-state-success-primary,#15803d);border-color:color-mix(in srgb,currentColor 30%,transparent);background:color-mix(in srgb,currentColor 8%,transparent)}
.ddp-model-tag[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#b45309)}
.ddp-model-actions{display:flex;justify-content:flex-end;gap:7px;flex-wrap:wrap;margin-top:auto}.ddp-model-actions .ddp-button{min-height:28px;padding:4px 9px;font-size:11px}
.ddp-model-id{font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;font-size:11px}
.ddp-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.ddp-editor,.ddp-confirm,.ddp-login-status{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.16))}
.ddp-confirm,.ddp-login-status{padding:10px 12px;border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.18));border-left:3px solid var(--dsw-alias-state-warn-primary,#b45309);border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.04))}
.ddp-account{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.14))}.ddp-account:first-child{padding-top:0;border-top:0}
.ddp-accounts-disclosure>summary{display:flex;align-items:center;gap:10px;min-height:30px;cursor:pointer;list-style:none}.ddp-accounts-disclosure>summary::-webkit-details-marker{display:none}
.ddp-accounts-disclosure>summary::after{content:'›';margin-left:auto;font-size:18px;line-height:1;transform:rotate(90deg)}.ddp-accounts-disclosure[open]>summary::after{transform:rotate(-90deg)}
.ddp-button:hover:not(:disabled){box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,Highlight)}.ddp-button:disabled{opacity:.55;cursor:not-allowed}
@media(max-width:680px){.ddp-fields{grid-template-columns:1fr}.ddp-model-list{grid-template-columns:1fr}}
@container ddp (max-width:680px){.ddp-fields{grid-template-columns:1fr}.ddp-model-list{grid-template-columns:1fr}}
@container ddp (max-width:420px){.ddp-hero{flex-wrap:wrap}.ddp-card{padding:12px}}
`;

function installStyles() {
  if (typeof document === 'undefined' || !document.head || !document.createElement) return () => {};
  const element = document.createElement('style');
  element.dataset.devinProvider = '';
  element.textContent = CLIENT_STYLES;
  document.head.append(element);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    element.remove();
  };
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function redactSecrets(value) {
  if (typeof value !== 'string' || !value) return '';
  return value
    .replace(/\b(code|access_token|id_token|refresh_token|authorization_code|token|sessionToken)\s*=\s*[^\s&"',;]+/gi, '$1=[REDACTED]')
    .replace(/devin-session-token\$[^\s"']+/gi, 'devin-session-token$[REDACTED]')
    .replace(/\bcog_[A-Za-z0-9_-]+/g, 'cog_[REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9._~+/-]+=*/gi, 'Basic [REDACTED]');
}

function describeError(error) {
  if (!error) return '未知错误。';
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof error.message === 'string'
        ? error.message
        : String(error);
  return redactSecrets(raw) || '未知错误。';
}

function isRevisionConflict(error) {
  return /设置已改变|请刷新后重试|revision|冲突/i.test(describeError(error));
}

function safeLoginUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const allowedPath = SAFE_LOGIN_PATHS.get(url.hostname.toLowerCase());
  if (!allowedPath || !allowedPath.test(url.pathname)) return null;
  return value;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value ?? '');
}

function resetEpoch(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetCountdown(value, now) {
  const target = resetEpoch(value);
  if (target === null) return value ? '重置时间不可用' : '重置时间未提供';
  const seconds = Math.ceil((target - now) / 1000);
  if (seconds <= 0) return '已到重置时间，请刷新额度';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (days) return `距重置 ${days}天${hours ? ` ${hours}小时` : ''}`;
  if (hours) return `距重置 ${hours}小时${minutes ? ` ${minutes}分钟` : ''}`;
  return `距重置 ${minutes ? `${minutes}分 ` : ''}${remainder}秒`;
}

function formatPercent(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return Number.isFinite(rounded) ? String(rounded) : '0';
}

function formatTokenCount(value) {
  if (!Number.isFinite(value) || value <= 0) return '未知';
  if (value >= 1024 * 1024) {
    const amount = value / (1024 * 1024);
    return `${Number.isInteger(amount) ? amount : amount.toFixed(1)}M`;
  }
  if (value >= 1024) {
    const amount = value / 1024;
    return `${Number.isInteger(amount) ? amount : amount.toFixed(1)}K`;
  }
  return String(value);
}

function accountName(account) {
  return account?.displayName || account?.label || account?.id || '未知账号';
}

function normalizeLogin(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    jobId: typeof source.jobId === 'string' ? source.jobId : null,
    accountId: typeof source.accountId === 'string' ? source.accountId : null,
    state: typeof source.state === 'string' ? source.state : 'idle',
    message: typeof source.message === 'string' ? redactSecrets(source.message) : '',
    url: typeof source.url === 'string' ? source.url : null
  };
}

function busyMessage(key) {
  if (!key) return '';
  const [op, arg] = key.split(':');
  const map = {
    select: '正在切换 Devin 账号…',
    provider: '正在更新 Devin Provider 启用状态…',
    settings: '正在保存缓存保活与服务设置…',
    models: '正在拉取 Devin 模型列表…',
    model: `正在更新模型 ${arg || ''} 启用状态…`,
    'model-settings': `正在保存模型 ${arg || ''} 参数…`,
    'model-reset': `正在恢复模型 ${arg || ''} 默认参数…`,
    login: '正在启动 Devin 浏览器登录…',
    'cancel-login': '正在取消登录…',
    'import-cli': '正在读取本机 devin CLI 登录…',
    save: '正在保存账号…',
    delete: '正在删除账号…'
  };
  return map[op] || '正在处理…';
}

// ── 小组件 ───────────────────────────────────────────────────────────────────

function Notice({ tone = 'muted', role, children, action }) {
  return h('div', { className: 'ddp-notice', 'data-tone': tone },
    h('span', { className: 'ddp-notice-icon', 'aria-hidden': 'true' }, ({ error: '×', warn: '!', success: '✓', muted: '…' })[tone] || 'i'),
    h('p', { role, style: style[tone] || style.muted }, children),
    action ?? null);
}

function StatusChip({ tone = 'muted', children }) {
  return h('span', { className: 'ddp-status-chip', 'data-tone': tone }, children);
}

function ModelTag({ tone = 'muted', title, children }) {
  return h('span', { className: 'ddp-model-tag', 'data-tone': tone, title }, children);
}

function SectionHeading({ eyebrow, title, description, action }) {
  return h('div', { className: 'ddp-heading' },
    h('div', { className: 'ddp-heading-copy' },
      eyebrow ? h('div', { className: 'ddp-eyebrow' }, eyebrow) : null,
      h('h3', { style: style.cardTitle }, title),
      description ? h('p', { style: style.muted }, description) : null),
    action ?? null);
}

// ── 额度展示 ─────────────────────────────────────────────────────────────────

function QuotaWindows({ quota }) {
  const windows = Array.isArray(quota?.windows) ? quota.windows : [];
  const hasTickingReset = windows.some((w) => {
    const t = resetEpoch(w?.resetsAt);
    return t !== null && t > Date.now();
  });
  const [now, setNow] = react.useState(() => Date.now());
  react.useEffect(() => {
    if (!hasTickingReset) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasTickingReset, quota?.updatedAt]);

  if (!quota) return h('p', { style: style.muted }, '点击「刷新额度」查看每日、每周额度、ACU 用量及重置倒计时。');
  if (quota.state === 'expired') {
    return h(Notice, { tone: 'error', role: 'alert' }, quota.error || 'Devin 登录已失效，请重新登录。');
  }
  if (quota.state === 'no-key') return h(Notice, { tone: 'warn' }, quota.error || '当前账号未配置凭据。');
  if (quota.state === 'error') return h(Notice, { tone: 'error', role: 'alert' }, quota.error || '额度读取失败。');

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    windows.length
      ? h('div', { className: 'ddp-quota-grid' },
        windows.map((w, idx) => {
          const used = Math.min(100, Math.max(0, Number(w.usedPercent) || 0));
          const remaining = Math.min(100, Math.max(0, Number(w.remainingPercent) || (100 - used)));
          const tone = used >= 95 ? 'error' : used >= 80 ? 'warn' : 'ok';
          return h('div', { key: w.kind || idx, className: 'ddp-quota-window', 'data-tone': tone },
            h('div', { className: 'ddp-quota-line' },
              h('span', { className: 'ddp-quota-name' }, w.label || w.kind),
              h('span', { className: 'ddp-quota-value' },
                h('span', { className: 'ddp-quota-percent' }, `${formatPercent(remaining)}%`),
                h('span', { style: style.muted }, '剩余'))),
            h('div', { className: 'ddp-quota-track' },
              h('div', { className: 'ddp-quota-fill', style: { width: `${formatPercent(used)}%` } })),
            h('div', { className: 'ddp-quota-meta' },
              w.detail ? h('span', null, `已用 ${w.detail.used} / ${w.detail.limit} ${w.detail.unit}`) : h('span', null, `已用 ${formatPercent(used)}%`),
              w.resetsAt
                ? h('span', null, `${resetCountdown(w.resetsAt, now)}（${formatTime(w.resetsAt)}）`)
                : h('span', null, '重置时间未提供'),
              Array.isArray(w.notModels) && w.notModels.length
                ? h('span', null, `不含免费模型（${w.notModels.length} 个变体）`)
                : null));
        }))
      : h('p', { style: style.muted }, '账号未返回每日/每周配额窗口（可能是按量或团队无限制套餐）。'),
    h('div', { className: 'ddp-chip-row' },
      quota.identity?.plan ? h('span', { style: style.chip }, `套餐：${quota.identity.plan}`) : null,
      quota.overageBalance ? h('span', { style: style.chip }, `超额余额：${quota.overageBalance}`) : null,
      quota.planEnd ? h('span', { style: style.chip }, `周期结束：${formatTime(quota.planEnd)}`) : null),
    quota.freeModelsNote ? h('p', { style: style.muted }, quota.freeModelsNote) : null);
}

// ── 模型管理与参数编辑器 ──────────────────────────────────────────────────────

function inheritedEfforts(model) {
  return model?.defaults?.reasoningEfforts;
}

function thinkingPresetAvailability(model) {
  const inherited = inheritedEfforts(model);
  const tiers = inherited && typeof inherited === 'object' ? Object.keys(inherited) : [];
  const pick = (order) => order.find((tier) => tiers.includes(tier)) ?? null;
  return {
    saver: pick(SAVER_TIER_ORDER),
    max: pick(MAX_TIER_ORDER),
    off: tiers.includes('off')
  };
}

function applyThinkingPreset(preset, model) {
  const availability = thinkingPresetAvailability(model);
  if (preset === 'inherit') return { effortsMode: 'inherit', effortsText: '', defaultReasoning: 'inherit' };
  if (preset === 'server') return { effortsMode: 'inherit', effortsText: '', defaultReasoning: 'none' };
  if (preset === 'saver' && availability.saver) return { effortsMode: 'inherit', effortsText: '', defaultReasoning: availability.saver };
  if (preset === 'max' && availability.max) return { effortsMode: 'inherit', effortsText: '', defaultReasoning: availability.max };
  if (preset === 'off' && availability.off) return { effortsMode: 'inherit', effortsText: '', defaultReasoning: 'off' };
  return null;
}

function modelDraftFrom(model) {
  const settings = model?.settings && typeof model.settings === 'object' ? model.settings : {};
  const efforts = settings.reasoningEfforts;
  let effortsMode = 'inherit';
  let effortsText = '';
  if (efforts === false) effortsMode = 'none';
  else if (efforts && typeof efforts === 'object') {
    effortsMode = 'map';
    effortsText = JSON.stringify(efforts);
  }
  const defaultReasoning = settings.defaultReasoning === undefined
    ? 'inherit'
    : settings.defaultReasoning === null
      ? 'none'
      : String(settings.defaultReasoning);
  return {
    contextWindow: settings.contextWindow === undefined ? '' : String(settings.contextWindow),
    maxTokens: settings.maxTokens === undefined ? '' : String(settings.maxTokens),
    temperature: settings.temperature === undefined ? '' : String(settings.temperature),
    imageInput: settings.imageInput === undefined ? 'inherit' : settings.imageInput ? 'true' : 'false',
    toolsEnabled: settings.toolsEnabled === undefined ? 'inherit' : settings.toolsEnabled ? 'true' : 'false',
    effortsMode,
    effortsText,
    defaultReasoning
  };
}

function draftTiers(draft, model) {
  const mode = draft?.effortsMode ?? 'inherit';
  if (mode === 'none') return [];
  if (mode === 'map') {
    try {
      const parsed = JSON.parse(String(draft?.effortsText ?? '').trim() || 'null');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed);
    } catch {}
  }
  const inherited = inheritedEfforts(model);
  if (inherited && typeof inherited === 'object') return Object.keys(inherited);
  return [];
}

function parseModelSettingsDraft(draft) {
  const problems = [];
  const fieldErrors = {};
  const fail = (field, message) => {
    problems.push(message);
    if (!fieldErrors[field]) fieldErrors[field] = message;
  };
  const settings = {};
  const text = (k) => String(draft?.[k] ?? '').trim();

  for (const key of ['contextWindow', 'maxTokens']) {
    const raw = text(key);
    if (!raw) continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      fail(key, `${MODEL_FIELD_LABELS[key]} 须为正整数。`);
    } else {
      settings[key] = value;
    }
  }
  const tempRaw = text('temperature');
  if (tempRaw) {
    const value = Number(tempRaw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      fail('temperature', '温度 temperature 须为 0 到 1 之间的数值。');
    } else {
      settings.temperature = value;
    }
  }
  if (settings.contextWindow !== undefined && settings.maxTokens !== undefined && settings.maxTokens > settings.contextWindow) {
    fail('maxTokens', 'maxTokens 不得超过 contextWindow。');
  }
  if (draft?.imageInput === 'true' || draft?.imageInput === 'false') {
    settings.imageInput = draft.imageInput === 'true';
  }
  if (draft?.toolsEnabled === 'true' || draft?.toolsEnabled === 'false') {
    settings.toolsEnabled = draft.toolsEnabled === 'true';
  }
  if (draft?.effortsMode === 'none') {
    settings.reasoningEfforts = false;
  } else if (draft?.effortsMode === 'map') {
    try {
      const parsed = JSON.parse(text('effortsText') || 'null');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('effortsText', '思考档位映射须为 JSON 对象。');
      } else {
        const keys = Object.keys(parsed);
        if (!keys.length || !keys.some((k) => k !== 'off')) {
          fail('effortsText', '至少需要声明一个非 off 思考档位。');
        } else if (keys.some((k) => !KNOWN_EFFORTS.includes(k))) {
          fail('effortsText', `档位键仅支持 ${KNOWN_EFFORTS.join('/')}。`);
        } else {
          settings.reasoningEfforts = parsed;
        }
      }
    } catch {
      fail('effortsText', '思考档位映射不是有效的 JSON。');
    }
  }
  if (draft?.defaultReasoning && draft.defaultReasoning !== 'inherit') {
    settings.defaultReasoning = draft.defaultReasoning === 'none' ? null : draft.defaultReasoning;
  }
  if (problems.length) return { settings: null, error: problems.join(' '), fieldErrors };
  return { settings, error: null, fieldErrors: null };
}

function capacityStops(key, baseValue, currentValue) {
  const stops = new Set(CAPACITY_LEVELS[key] ?? []);
  if (Number.isSafeInteger(baseValue) && baseValue > 0) stops.add(baseValue);
  if (Number.isSafeInteger(currentValue) && currentValue > 0) stops.add(currentValue);
  return [...stops].sort((a, b) => a - b);
}

function CapacitySlider({ choices, value, label, disabled, onChange }) {
  const selected = Math.max(0, choices.indexOf(value));
  const color = 'var(--dsw-alias-brand-primary, #2563eb)';
  const position = (index) => `${(index + 0.5) * 100 / choices.length}%`;
  return h('div', {
    role: 'slider',
    tabIndex: disabled ? -1 : 0,
    'aria-label': label,
    'aria-disabled': disabled,
    'aria-valuemin': 0,
    'aria-valuemax': choices.length - 1,
    'aria-valuenow': selected,
    style: { position: 'relative', width: '100%', maxWidth: 520, height: 30, userSelect: 'none', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 },
    onKeyDown: (e) => {
      if (disabled) return;
      const idx = e.key === 'ArrowLeft' ? Math.max(0, selected - 1) : e.key === 'ArrowRight' ? Math.min(choices.length - 1, selected + 1) : undefined;
      if (idx !== undefined) { e.preventDefault(); onChange(choices[idx]); }
    },
    onClick: (e) => {
      if (disabled) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width) return;
      const idx = Math.max(0, Math.min(choices.length - 1, Math.round((e.clientX - rect.left) / rect.width * choices.length - 0.5)));
      if (choices[idx] !== undefined && choices[idx] !== value) onChange(choices[idx]);
    }
  },
    h('span', { 'aria-hidden': 'true', style: { display: 'grid', gridTemplateColumns: `repeat(${choices.length}, 1fr)`, fontSize: 10, lineHeight: '16px', textAlign: 'center' } },
      choices.map((c, i) => h('span', { key: c, style: { color: i === selected ? color : 'var(--dsw-alias-label-secondary, #64748b)' } }, formatTokenCount(c)))),
    h('span', { 'aria-hidden': 'true', style: { position: 'absolute', left: position(0), right: position(0), bottom: 5, height: 2, borderRadius: 999, background: 'var(--dsw-alias-border-l2, rgba(128,128,128,.35))' } }),
    choices.map((c, i) => h('span', { key: c, 'aria-hidden': 'true', style: { position: 'absolute', left: position(i), transform: 'translateX(-50%)', bottom: 3, width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-border-l2, rgba(128,128,128,.35))' } })),
    h('span', { 'aria-hidden': 'true', style: { position: 'absolute', left: position(selected), transform: 'translateX(-50%)', bottom: 0, width: 12, height: 12, borderRadius: '50%', background: color } })
  );
}

function ModelSettingsEditor({ model, draft, error, fieldErrors, disabled, onChange, onSave, onCancel }) {
  const tiers = draftTiers(draft, model);
  const presetAvail = thinkingPresetAvailability(model);
  const selectedDefault = draft?.defaultReasoning ?? 'inherit';
  const staleDefault = !['inherit', 'none'].includes(selectedDefault) && !tiers.includes(selectedDefault);

  const capacityRow = (key, label) => {
    const inherited = (draft?.[key] ?? '') === '';
    const inheritedValue = model?.defaults?.[key];
    const draftVal = Number.parseInt(draft?.[key], 10);
    const val = inherited ? inheritedValue : draftVal;
    const stops = capacityStops(key, inheritedValue, Number.isFinite(val) ? val : undefined);
    return h('div', { style: { display: 'grid', gap: 6 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('span', { style: style.label }, label),
        h('label', { className: 'ddp-toggle' },
          h('input', {
            type: 'checkbox', checked: inherited, disabled,
            onChange: (e) => onChange({ [key]: e.target.checked ? '' : String(inheritedValue ?? stops[0] ?? '') })
          }),
          h('span', null, '继承目录默认')),
        h('span', { style: style.muted }, inherited ? `默认 ${formatTokenCount(inheritedValue)}` : `当前 ${formatTokenCount(val)} (${Number.isFinite(val) ? val : '—'})`)),
      h(CapacitySlider, {
        choices: stops,
        value: stops.includes(val) ? val : stops[0],
        label,
        disabled: disabled || inherited,
        onChange: (choice) => onChange({ [key]: String(choice) })
      }),
      fieldErrors?.[key] ? h('p', { role: 'alert', style: style.error }, fieldErrors[key]) : null);
  };

  const capCheckbox = (key, text) => {
    const mode = draft?.[key] ?? 'inherit';
    const inherited = model?.defaults?.[key];
    return h('div', { className: 'ddp-actions' },
      h('label', { className: 'ddp-toggle' },
        h('input', {
          type: 'checkbox',
          checked: mode === 'inherit' ? inherited === true : mode === 'true',
          disabled,
          onChange: (e) => onChange({ [key]: e.target.checked ? 'true' : 'false' })
        }),
        h('span', null, text)),
      h('span', { style: style.chip }, mode === 'inherit' ? `继承（${inherited ? '开启' : '关闭'}）` : `已覆盖（${mode === 'true' ? '开启' : '关闭'}）`),
      mode !== 'inherit' ? h('button', { type: 'button', style: style.btn, disabled, onClick: () => onChange({ [key]: 'inherit' }) }, '恢复继承') : null);
  };

  return h('div', { className: 'ddp-editor' },
    h('div', { style: { fontWeight: 650, fontSize: 13 } }, `模型参数：${model?.name || model?.id}`),
    h('label', { style: style.field },
      h('span', { style: style.label }, MODEL_FIELD_LABELS.temperature),
      h('input', {
        type: 'text', style: style.input, value: draft?.temperature ?? '', disabled,
        placeholder: '留空继承默认 (0 ~ 1)',
        onChange: (e) => onChange({ temperature: e.target.value })
      }),
      fieldErrors?.temperature ? h('p', { role: 'alert', style: style.error }, fieldErrors.temperature) : null),
    capacityRow('contextWindow', MODEL_FIELD_LABELS.contextWindow),
    capacityRow('maxTokens', MODEL_FIELD_LABELS.maxTokens),
    capCheckbox('imageInput', '允许图片输入'),
    capCheckbox('toolsEnabled', '允许工具调用'),
    h('div', { className: 'ddp-section' },
      h('strong', { style: { fontSize: 12 } }, '思考档位预设与映射'),
      h('div', { className: 'ddp-actions' },
        THINKING_PRESETS.map((p) => {
          const ok = p.value === 'inherit' || p.value === 'server' || Boolean(presetAvail[p.value]);
          return h('button', {
            key: p.value, type: 'button', style: style.btn, disabled: disabled || !ok,
            onClick: () => { const patch = applyThinkingPreset(p.value, model); if (patch) onChange(patch); }
          }, p.label);
        })),
      h('div', { className: 'ddp-fields' },
        h('label', { style: style.field },
          h('span', { style: style.label }, '思考档位映射 reasoningEfforts'),
          h('select', {
            style: style.input, value: draft?.effortsMode ?? 'inherit', disabled,
            onChange: (e) => onChange({ effortsMode: e.target.value })
          },
            h('option', { value: 'inherit' }, '继承目录默认'),
            h('option', { value: 'none' }, '不提供思考档位 (false)'),
            h('option', { value: 'map' }, '自定义 JSON 映射'))),
        h('label', { style: style.field },
          h('span', { style: style.label }, '默认思考档位 defaultReasoning'),
          h('select', {
            style: style.input, value: selectedDefault, disabled,
            onChange: (e) => onChange({ defaultReasoning: e.target.value })
          },
            h('option', { value: 'inherit' }, '继承目录默认'),
            h('option', { value: 'none' }, '不强制（使用家族默认）'),
            staleDefault ? h('option', { value: selectedDefault, disabled: true }, `${selectedDefault}（已失效）`) : null,
            tiers.map((t) => h('option', { key: t, value: t }, t))))),
      draft?.effortsMode === 'map'
        ? h('label', { style: style.field },
          h('span', { style: style.label }, 'JSON 映射（键为 DSH 档位，值为 Devin 档位，如 {"off":"none","low":"low","high":"high"}）'),
          h('textarea', {
            style: { ...style.input, minHeight: 56 }, value: draft?.effortsText ?? '', disabled,
            onChange: (e) => onChange({ effortsText: e.target.value })
          }),
          fieldErrors?.effortsText ? h('p', { role: 'alert', style: style.error }, fieldErrors.effortsText) : null)
        : null),
    error ? h('p', { role: 'alert', style: style.error }, error) : null,
    h('div', { className: 'ddp-actions' },
      h('button', { type: 'button', style: style.primary, disabled, onClick: onSave }, '保存参数'),
      h('button', { type: 'button', style: style.btn, disabled, onClick: onCancel }, '取消')));
}

function ModelRow({ model, disabled, editor, draftError, fieldErrors, onToggle, onOpenEditor, onCloseEditor, onChangeDraft, onSave, onReset }) {
  const enabled = model?.enabled !== false;
  const editing = editor?.modelId === model?.id;
  const values = model?.effective ?? model?.defaults ?? {};
  const hasOverrides = Object.keys(model?.settings ?? {}).length > 0;
  return h('article', { className: 'ddp-model', 'data-disabled': enabled ? 'false' : 'true' },
    h('div', { className: 'ddp-model-head' },
      h('label', { className: 'ddp-model-toggle' },
        h('input', {
          className: 'ddp-switch-input', type: 'checkbox', checked: enabled, disabled,
          'aria-label': `启用模型 ${model?.id ?? ''}`,
          onChange: (e) => onToggle(model, Boolean(e.target.checked))
        }),
        h('span', { className: 'ddp-model-name', title: model?.id }, model?.name || model?.id)),
      h('div', { className: 'ddp-chip-row' },
        model?.free ? h(ModelTag, { tone: 'success' }, '免费 · 不计额度') : null,
        !enabled ? h(ModelTag, { tone: 'warn' }, '已停用') : null)),
    h('div', { className: 'ddp-model-tags' },
      h(ModelTag, { tone: values.imageInput ? 'accent' : 'muted' }, values.imageInput ? '视觉' : '纯文本'),
      h(ModelTag, { tone: values.reasoningEfforts ? 'accent' : 'muted' }, values.reasoningEfforts ? `可调思考 (${Object.keys(values.reasoningEfforts).join('/')})` : '无思考档位'),
      h(ModelTag, null, `上下文 ${formatTokenCount(values.contextWindow)}`),
      h(ModelTag, null, `输出 ${formatTokenCount(values.maxTokens)}`),
      values.defaultReasoning ? h(ModelTag, { tone: 'accent' }, `默认 ${values.defaultReasoning}`) : null,
      values.toolsEnabled === false ? h(ModelTag, { tone: 'warn' }, '工具已停用') : null,
      model?.cost ? h(ModelTag, null, `$${model.cost.input}/$${model.cost.output} per 1M`) : null),
    h('div', { className: 'ddp-model-actions' },
      h('button', { type: 'button', style: style.btn, disabled, onClick: () => (editing ? onCloseEditor() : onOpenEditor(model)) }, editing ? '收起参数' : hasOverrides ? '参数 (已覆盖)' : '参数'),
      hasOverrides || !enabled
        ? h('button', { type: 'button', style: style.btn, disabled, onClick: () => onReset(model) }, enabled ? '恢复默认' : '恢复默认并启用')
        : null),
    h('details', null,
      h('summary', { style: style.summary }, '技术标识'),
      h('p', { className: 'ddp-model-id', style: style.muted }, `家族 / 路由 ID：${model?.id ?? ''}`)),
    model?.settingsWarning ? h('p', { role: 'alert', style: style.warn }, model.settingsWarning) : null,
    editing
      ? h(ModelSettingsEditor, {
        model, draft: editor.draft, error: draftError, fieldErrors, disabled,
        onChange: onChangeDraft, onSave: () => onSave(model), onCancel: onCloseEditor
      })
      : null);
}

// ── 缓存保活与服务设置 ────────────────────────────────────────────────────────

function SettingsCard({ settings, disabled, onSave }) {
  const initial = settings?.cacheKeepalive ?? { enabled: false, intervalSec: 285, maxPings: 6 };
  const [enabled, setEnabled] = react.useState(Boolean(initial.enabled));
  const [intervalSec, setIntervalSec] = react.useState(String(initial.intervalSec ?? 285));
  const [maxPings, setMaxPings] = react.useState(String(initial.maxPings ?? 6));
  const [serverUrl, setServerUrl] = react.useState(String(settings?.serverUrl ?? ''));
  const [localError, setLocalError] = react.useState('');

  react.useEffect(() => {
    setEnabled(Boolean(settings?.cacheKeepalive?.enabled));
    setIntervalSec(String(settings?.cacheKeepalive?.intervalSec ?? 285));
    setMaxPings(String(settings?.cacheKeepalive?.maxPings ?? 6));
    setServerUrl(String(settings?.serverUrl ?? ''));
  }, [settings?.cacheKeepalive?.enabled, settings?.cacheKeepalive?.intervalSec, settings?.cacheKeepalive?.maxPings, settings?.serverUrl]);

  const submit = () => {
    const sec = Number(intervalSec);
    const max = Number(maxPings);
    if (!Number.isSafeInteger(sec) || sec < 30 || sec > 299) {
      setLocalError('保活间隔须为 30 到 299 之间的整数（秒）。');
      return;
    }
    if (!Number.isSafeInteger(max) || max < 1 || max > 50) {
      setLocalError('最大保活次数须为 1 到 50 之间的整数。');
      return;
    }
    setLocalError('');
    onSave({
      cacheKeepalive: { enabled, intervalSec: sec, maxPings: max },
      serverUrl: serverUrl.trim()
    });
  };

  return h('section', { className: 'ddp-card', 'aria-label': '缓存保活与高级设置' },
    h(SectionHeading, {
      eyebrow: 'CACHE KEEPALIVE & TRANSPORT',
      title: '5 分钟提示词缓存保活与服务设置',
      description: 'Devin 的提示词缓存有效期为 5 分钟。开启后每次回复结束将按设定间隔自动重发一次 max_tokens=1 的续命请求（按整段上下文缓存读取计费）。默认关闭。',
      action: h('label', { className: 'ddp-toggle' },
        h('input', {
          className: 'ddp-switch-input', type: 'checkbox', checked: enabled, disabled,
          'aria-label': '启用提示词缓存保活',
          onChange: (e) => setEnabled(Boolean(e.target.checked))
        }),
        h('span', null, enabled ? '已启用保活' : '未启用'))
    }),
    h('div', { className: 'ddp-fields' },
      h('label', { style: style.field },
        h('span', { style: style.label }, '保活间隔（30–299 秒，默认 285）'),
        h('input', {
          type: 'number', min: 30, max: 299, style: style.input, value: intervalSec, disabled,
          onChange: (e) => setIntervalSec(e.target.value)
        })),
      h('label', { style: style.field },
        h('span', { style: style.label }, '单次对话最大保活次数（1–50，默认 6）'),
        h('input', {
          type: 'number', min: 1, max: 50, style: style.input, value: maxPings, disabled,
          onChange: (e) => setMaxPings(e.target.value)
        }))),
    h('label', { style: style.field },
      h('span', { style: style.label }, '全局 API 服务地址（可选，留空使用 https://server.codeium.com 或 WINDSURF_API_SERVER_URL）'),
      h('input', {
        type: 'text', style: style.input, value: serverUrl, disabled,
        placeholder: 'https://server.codeium.com',
        onChange: (e) => setServerUrl(e.target.value)
      })),
    localError ? h('p', { role: 'alert', style: style.error }, localError) : null,
    h('div', { className: 'ddp-actions' },
      h('button', { type: 'button', style: style.primary, disabled, onClick: submit }, '保存保活与服务设置'),
      h('button', {
        type: 'button', style: style.btn, disabled,
        onClick: () => { setEnabled(false); setIntervalSec('285'); setMaxPings('6'); setServerUrl(''); setLocalError(''); }
      }, '重置为推荐默认值')));
}

// ── 账号表单 ─────────────────────────────────────────────────────────────────

function emptyAccountDraft() {
  return { id: '', label: '', authMode: 'api-key', apiKey: '', apiKeyRef: '', server: '' };
}

function draftFromAccount(account) {
  return {
    id: String(account?.id ?? ''),
    label: String(account?.label ?? ''),
    authMode: account?.authMode || 'api-key',
    apiKey: '',
    apiKeyRef: String(account?.apiKeyRef ?? ''),
    server: String(account?.server ?? '')
  };
}

function AccountForm({ editor, busy, onChangeDraft, onSave, onCancel }) {
  const isNew = editor.mode === 'new';
  const draft = editor.draft;
  const disabled = busy !== null;
  return h('div', { className: 'ddp-editor' },
    h('strong', { style: { fontSize: 13 } }, isNew ? '手动添加 Devin 账号' : `编辑账号：${draft.id}`),
    h('div', { className: 'ddp-fields' },
      h('label', { style: style.field },
        h('span', { style: style.label }, '账号 ID（小写字母、数字、连字符）'),
        h('input', {
          type: 'text', style: style.input, value: draft.id, disabled: disabled || !isNew,
          placeholder: '例如 work-devin',
          onChange: (e) => onChangeDraft({ id: e.target.value })
        })),
      h('label', { style: style.field },
        h('span', { style: style.label }, '本地显示备注'),
        h('input', {
          type: 'text', style: style.input, value: draft.label, disabled,
          placeholder: '例如 Devin 主号',
          onChange: (e) => onChangeDraft({ label: e.target.value })
        }))),
    h('div', { className: 'ddp-fields' },
      h('label', { style: style.field },
        h('span', { style: style.label }, '鉴权方式'),
        h('select', {
          style: style.input, value: draft.authMode, disabled,
          onChange: (e) => onChangeDraft({ authMode: e.target.value })
        },
          h('option', { value: 'api-key' }, 'API Key / Session Token（安全存入 DSH 凭据存储）'),
          h('option', { value: 'reference' }, 'DSH 凭据引用名（环境变量 / .credentials.yaml）'),
          h('option', { value: 'oauth' }, '浏览器 PKCE 登录'),
          h('option', { value: 'cli' }, '本机 devin CLI credentials.toml'))),
      h('label', { style: style.field },
        h('span', { style: style.label }, '自定义服务地址（可选）'),
        h('input', {
          type: 'text', style: style.input, value: draft.server, disabled,
          placeholder: '留空使用全局地址',
          onChange: (e) => onChangeDraft({ server: e.target.value })
        }))),
    draft.authMode === 'api-key'
      ? h('label', { style: style.field },
        h('span', { style: style.label }, 'Devin API Key (cog_…) 或 Session Token（不会写入 state.json，仅存入受保护凭据存储）'),
        h('input', {
          type: 'password', style: style.input, value: draft.apiKey, disabled, autoComplete: 'off',
          placeholder: isNew ? 'cog_... 或 devin-session-token$...' : '留空则保留当前已存密钥',
          onChange: (e) => onChangeDraft({ apiKey: e.target.value })
        }))
      : null,
    draft.authMode === 'reference'
      ? h('label', { style: style.field },
        h('span', { style: style.label }, '凭据引用名（例如 DEVIN_API_KEY）'),
        h('input', {
          type: 'text', style: style.input, value: draft.apiKeyRef, disabled,
          placeholder: 'DEVIN_API_KEY',
          onChange: (e) => onChangeDraft({ apiKeyRef: e.target.value })
        }))
      : null,
    h('div', { className: 'ddp-actions' },
      h('button', { type: 'button', style: style.primary, disabled, onClick: onSave }, '保存账号'),
      h('button', { type: 'button', style: style.btn, disabled, onClick: onCancel }, '取消')));
}

// ── 账号管理面板 ─────────────────────────────────────────────────────────────

function AccountPanel({
  snapshot, editor, confirmDelete, loginConfirm, login, busy,
  onNew, onEdit, onCancelEdit, onChangeDraft, onSave,
  onRequestDelete, onConfirmDelete, onCancelDelete,
  onRequestLogin, onConfirmLogin, onCancelLoginConfirm, onCancelLogin,
  onImportCli, onSelectAccount
}) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const disabled = busy !== null;
  const loginActive = LOGIN_ACTIVE_STATES.includes(login.state);
  const loginUrl = safeLoginUrl(login.url);
  const [accountsOpen, setAccountsOpen] = react.useState(false);
  const mustShow = !accounts.length || loginActive || Boolean(editor || confirmDelete || loginConfirm || loginUrl);

  react.useEffect(() => {
    if (loginActive || editor || confirmDelete || loginConfirm) setAccountsOpen(true);
  }, [loginActive, editor, confirmDelete, loginConfirm]);

  return h('section', { id: 'ddp-account-panel', className: 'ddp-card ddp-account-panel', 'aria-label': '账号管理与登录' },
    h(SectionHeading, {
      eyebrow: 'ACCOUNTS & AUTH',
      title: '账号与登录方式',
      action: h('span', { style: style.chip }, `${accounts.length} 个账号`)
    }),
    h('details', {
      className: 'ddp-accounts-disclosure',
      open: mustShow || accountsOpen,
      onToggle: (e) => {
        const nextOpen = e?.target?.open ?? false;
        if (mustShow && !nextOpen && e?.target) e.target.open = true;
        if (!mustShow) setAccountsOpen(nextOpen);
      }
    },
      h('summary', null, accounts.length ? `管理账号 · ${accounts.slice(0, 2).map(accountName).join('、')}${accounts.length > 2 ? ' 等' : ''}` : '添加 Devin 账号'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 10 } },
        accounts.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            accounts.map((acc) => {
              const isActive = snapshot?.activeAccountId === acc.id;
              return h('article', { key: acc.id, className: 'ddp-account' },
                h('div', { className: 'ddp-heading' },
                  h('strong', { style: { fontSize: 13 } }, accountName(acc)),
                  h('div', { className: 'ddp-chip-row' },
                    isActive ? h(StatusChip, { tone: 'success' }, '当前使用') : null,
                    acc.identity?.plan ? h('span', { style: style.chip }, acc.identity.plan) : null,
                    h('span', { style: style.chip }, AUTH_MODE_LABELS[acc.authMode] ?? acc.authMode),
                    h(StatusChip, { tone: acc.hasCredential ? 'success' : 'warn' }, acc.hasCredential ? '凭据就绪' : '缺少凭据'))),
                acc.credentialError ? h('p', { role: 'alert', style: style.error }, acc.credentialError) : null,
                h('div', { className: 'ddp-actions' },
                  !isActive ? h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onSelectAccount(acc.id) }, '使用此账号') : null,
                  h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onRequestLogin(acc.id) }, '浏览器 PKCE 登录'),
                  h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onEdit(acc) }, '编辑'),
                  confirmDelete === acc.id
                    ? h('button', { type: 'button', style: style.danger, disabled: disabled || loginActive, onClick: () => onConfirmDelete(acc.id) }, '确认删除')
                    : h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onRequestDelete(acc.id) }, '删除'),
                  confirmDelete === acc.id ? h('button', { type: 'button', style: style.btn, disabled, onClick: onCancelDelete }, '取消') : null),
                loginConfirm === acc.id
                  ? h('div', { className: 'ddp-confirm' },
                    h('strong', { style: { fontSize: 13 } }, `发起浏览器 PKCE 登录：${accountName(acc)}`),
                    h('ul', { style: { margin: 0, paddingLeft: 18 } }, LOGIN_CONFIRM_NOTES.map((n, i) => h('li', { key: i, style: style.muted }, n))),
                    h('div', { className: 'ddp-actions' },
                      h('button', { type: 'button', style: style.primary, disabled, onClick: () => onConfirmLogin(acc.id) }, '确认生成登录链接'),
                      h('button', { type: 'button', style: style.btn, disabled, onClick: onCancelLoginConfirm }, '取消')))
                  : null);
            }))
          : h('p', { style: style.muted }, '还没有配置 Devin 账号。可直接使用浏览器 PKCE 登录、导入本机 devin CLI 登录，或填写 API Key / 凭据引用。'),

        h('div', { className: 'ddp-actions' },
          h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onRequestLogin(NEW_LOGIN_ACCOUNT) }, accounts.length ? '浏览器登录新账号' : '浏览器 PKCE 登录'),
          h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: onImportCli }, '导入本机 devin CLI 登录'),
          h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive || editor !== null, onClick: onNew }, '手动新增 (API Key / 引用名)')),

        loginConfirm === NEW_LOGIN_ACCOUNT
          ? h('div', { className: 'ddp-confirm' },
            h('strong', { style: { fontSize: 13 } }, '创建新账号并启动浏览器 PKCE 登录'),
            h('ul', { style: { margin: 0, paddingLeft: 18 } }, LOGIN_CONFIRM_NOTES.map((n, i) => h('li', { key: i, style: style.muted }, n))),
            h('div', { className: 'ddp-actions' },
              h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onConfirmLogin(NEW_LOGIN_ACCOUNT) }, '确认生成登录链接'),
              h('button', { type: 'button', style: style.btn, disabled, onClick: onCancelLoginConfirm }, '取消')))
          : null,

        editor ? h(AccountForm, { editor, busy, onChangeDraft, onSave, onCancel: onCancelEdit }) : null,

        login.state !== 'idle' || loginUrl
          ? (['success', 'cancelled', 'error'].includes(login.state)
            ? h(Notice, { tone: login.state === 'success' ? 'success' : login.state === 'cancelled' ? 'muted' : 'error', role: 'status' }, `${LOGIN_STATE_LABELS[login.state] ?? login.state}${login.message ? ` ${login.message}` : ''}`)
            : h('div', { className: 'ddp-login-status', role: 'status' },
              h('strong', { style: { fontSize: 13 } }, '浏览器 PKCE 登录进行中'),
              h('p', { style: style.muted }, LOGIN_STATE_LABELS[login.state] ?? login.state),
              login.url && !loginUrl ? h(Notice, { tone: 'error' }, '登录链接未通过安全校验（仅允许 app.devin.ai），已隐藏。') : null,
              loginUrl ? h('a', { href: loginUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: 12, color: 'var(--dsw-alias-link, #2563eb)' } }, '点击打开 Devin 官方登录页 (app.devin.ai)') : null,
              h('div', { className: 'ddp-actions' },
                h('button', { type: 'button', style: style.btn, disabled: !login.jobId, onClick: onCancelLogin }, '取消登录'))))
          : null)));
}

// ── 主设置组件 ────────────────────────────────────────────────────────────────

function DevinProviderSection({ client }) {
  const [snapshot, setSnapshot] = react.useState(null);
  const [loading, setLoading] = react.useState(true);
  const [loadError, setLoadError] = react.useState(null);
  const [busy, setBusy] = react.useState(null);
  const [notice, setNotice] = react.useState(null);
  const [quota, setQuota] = react.useState(null);
  const [quotaBusy, setQuotaBusy] = react.useState(false);
  const [editor, setEditor] = react.useState(null);
  const [confirmDelete, setConfirmDelete] = react.useState(null);
  const [loginConfirm, setLoginConfirm] = react.useState(null);
  const [login, setLogin] = react.useState(() => normalizeLogin(null));
  const [modelsOpen, setModelsOpen] = react.useState(false);
  const [modelFilter, setModelFilter] = react.useState('');
  const [modelEditor, setModelEditor] = react.useState(null);
  const [modelDraftError, setModelDraftError] = react.useState(null);
  const [modelFieldErrors, setModelFieldErrors] = react.useState(null);

  const aliveRef = react.useRef(true);
  const quotaEpochRef = react.useRef(0);
  const handledLoginRef = react.useRef('');
  react.useEffect(() => () => { aliveRef.current = false; }, []);

  const applySnapshot = react.useCallback((value) => {
    setSnapshot(value);
    if (value?.login) setLogin(normalizeLogin(value.login));
    setLoadError(null);
  }, []);

  const refresh = react.useCallback(async () => {
    setLoading(true);
    try {
      const value = await client.invoke({ op: 'read' });
      if (aliveRef.current) applySnapshot(value);
      return value;
    } catch (error) {
      if (aliveRef.current) setLoadError(describeError(error));
      return null;
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [client, applySnapshot]);

  react.useEffect(() => { void refresh(); }, [refresh]);

  const run = (key, task) => {
    setBusy(key);
    setNotice(null);
    return Promise.resolve()
      .then(task)
      .finally(() => { if (aliveRef.current) setBusy(null); });
  };

  const reportError = async (error, prefix) => {
    if (isRevisionConflict(error)) {
      await refresh();
      if (aliveRef.current) setNotice({ ok: false, text: `${prefix}：设置已在别处被改动，已刷新。` });
    } else if (aliveRef.current) {
      setNotice({ ok: false, text: `${prefix}：${describeError(error)}` });
    }
  };

  const activeAccountId = snapshot?.activeAccountId ?? null;
  const activeAccount = (snapshot?.accounts ?? []).find((a) => a.id === activeAccountId) ?? null;
  const activeCatalog = (snapshot?.catalogs ?? []).find((c) => c.accountId === activeAccountId) ?? null;
  const models = Array.isArray(activeCatalog?.models) ? activeCatalog.models : [];

  react.useEffect(() => {
    setModelEditor(null);
    setModelDraftError(null);
    setModelFieldErrors(null);
    setQuota(null);
  }, [activeAccountId]);

  const pullQuota = () => {
    if (!activeAccountId) return;
    const epoch = ++quotaEpochRef.current;
    setQuotaBusy(true);
    void client.invoke({ op: 'quota', accountId: activeAccountId, force: true })
      .then((val) => { if (aliveRef.current && quotaEpochRef.current === epoch) setQuota(val); })
      .catch((err) => {
        if (aliveRef.current && quotaEpochRef.current === epoch) {
          setQuota({ accountId: activeAccountId, state: 'error', windows: [], error: describeError(err) });
        }
      })
      .finally(() => { if (aliveRef.current && quotaEpochRef.current === epoch) setQuotaBusy(false); });
  };

  const toggleProvider = (enabled) => run('provider', async () => {
    try {
      const value = await client.invoke({ op: 'setProviderEnabled', revision: snapshot.revision, enabled });
      applySnapshot(value);
      setNotice({ ok: true, text: enabled ? '已启用 Devin Provider 路由。' : '已停用 Devin Provider 路由（账号与模型设置已保留）。' });
    } catch (e) { await reportError(e, '更新路由状态失败'); }
  });

  const selectAccount = (accountId) => run('select', async () => {
    try {
      const value = await client.invoke({ op: 'selectAccount', revision: snapshot.revision, accountId });
      applySnapshot(value);
      setNotice({ ok: true, text: '已切换当前使用的 Devin 账号。' });
    } catch (e) { await reportError(e, '切换账号失败'); }
  });

  const saveGlobalSettings = (nextSettings) => run('settings', async () => {
    try {
      const value = await client.invoke({ op: 'saveSettings', revision: snapshot.revision, settings: nextSettings });
      applySnapshot(value);
      setNotice({ ok: true, text: '缓存保活与服务设置已保存。' });
    } catch (e) { await reportError(e, '保存设置失败'); }
  });

  const pullModels = () => run('models', async () => {
    if (!activeAccountId) return;
    try {
      const value = await client.invoke({ op: 'models', revision: snapshot.revision, accountId: activeAccountId });
      applySnapshot(value);
      setNotice({ ok: true, text: '已同步账号模型目录。' });
    } catch (e) { await reportError(e, '拉取模型失败'); }
  });

  const toggleModel = (model, enabled) => run(`model:${model.id}`, async () => {
    try {
      const value = await client.invoke({ op: 'setModelEnabled', revision: snapshot.revision, accountId: activeAccountId, modelId: model.id, enabled });
      applySnapshot(value);
    } catch (e) { await reportError(e, '更新模型开关失败'); }
  });

  const saveModelSettings = (model) => {
    const parsed = parseModelSettingsDraft(modelEditor?.draft);
    if (parsed.error) {
      setModelDraftError(parsed.error);
      setModelFieldErrors(parsed.fieldErrors);
      return;
    }
    setModelDraftError(null);
    setModelFieldErrors(null);
    void run(`model-settings:${model.id}`, async () => {
      try {
        const value = await client.invoke({ op: 'saveModelSettings', revision: snapshot.revision, accountId: activeAccountId, modelId: model.id, settings: parsed.settings });
        applySnapshot(value);
        setModelEditor(null);
        setNotice({ ok: true, text: `已保存模型 ${model.name || model.id} 的参数。` });
      } catch (e) { await reportError(e, '保存模型参数失败'); }
    });
  };

  const resetModelSettings = (model) => run(`model-reset:${model.id}`, async () => {
    try {
      const value = await client.invoke({ op: 'resetModelSettings', revision: snapshot.revision, accountId: activeAccountId, modelId: model.id });
      applySnapshot(value);
      if (modelEditor?.modelId === model.id) setModelEditor(null);
      setNotice({ ok: true, text: `已恢复模型 ${model.name || model.id} 的默认参数。` });
    } catch (e) { await reportError(e, '恢复默认参数失败'); }
  });

  const importCli = () => run('import-cli', async () => {
    try {
      const value = await client.invoke({ op: 'importCli', revision: snapshot.revision });
      applySnapshot(value);
      setNotice({ ok: true, text: '已导入本机 devin CLI 登录账号。' });
    } catch (e) { await reportError(e, '导入 devin CLI 失败'); }
  });

  const saveAccount = () => run('save', async () => {
    if (!editor) return;
    const d = editor.draft;
    if (!ID_PATTERN.test(String(d.id).trim())) {
      setNotice({ ok: false, text: '账号 ID 须以小写字母开头，仅含小写字母、数字与连字符。' });
      return;
    }
    if (!String(d.label).trim()) {
      setNotice({ ok: false, text: '请填写账号名称。' });
      return;
    }
    if (d.authMode === 'reference' && !REF_PATTERN.test(String(d.apiKeyRef).trim())) {
      setNotice({ ok: false, text: '凭据引用名格式不合法（例：DEVIN_API_KEY）。' });
      return;
    }
    try {
      const value = await client.invoke({
        op: 'saveAccount',
        revision: snapshot.revision,
        account: {
          id: d.id.trim(),
          label: d.label.trim(),
          authMode: d.authMode,
          ...(d.authMode === 'reference' ? { apiKeyRef: d.apiKeyRef.trim() } : {}),
          ...(d.server.trim() ? { server: d.server.trim() } : {})
        },
        ...(d.authMode === 'api-key' && d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {})
      });
      applySnapshot(value);
      setEditor(null);
      setNotice({ ok: true, text: '账号已保存。' });
    } catch (e) { await reportError(e, '保存账号失败'); }
  });

  const removeAccount = (accountId) => run('delete', async () => {
    try {
      const value = await client.invoke({ op: 'removeAccount', revision: snapshot.revision, accountId });
      applySnapshot(value);
      if (editor?.id === accountId) setEditor(null);
      setConfirmDelete(null);
      setNotice({ ok: true, text: '账号已删除。' });
    } catch (e) { await reportError(e, '删除账号失败'); }
  });

  const confirmLogin = (target) => run('login', async () => {
    if (editor) {
      setNotice({ ok: false, text: '请先保存或取消账号编辑表单。' });
      return;
    }
    setLoginConfirm(null);
    let accountId = target;
    let rev = snapshot.revision;
    try {
      if (target === NEW_LOGIN_ACCOUNT) {
        const list = snapshot.accounts ?? [];
        let idx = 1;
        while (list.some((a) => a.id === `devin-${idx}`)) idx++;
        accountId = `devin-${idx}`;
        const saved = await client.invoke({
          op: 'saveAccount',
          revision: rev,
          account: { id: accountId, label: `Devin 账号 ${idx}`, authMode: 'oauth' }
        });
        applySnapshot(saved);
        rev = saved.revision;
      }
      const val = await client.invoke({ op: 'startLogin', revision: rev, accountId });
      if (aliveRef.current) setLogin(normalizeLogin(val));
    } catch (e) { await reportError(e, '启动浏览器登录失败'); }
  });

  const cancelLogin = () => run('cancel-login', async () => {
    try {
      const val = await client.invoke({ op: 'cancelLogin', jobId: login.jobId });
      if (aliveRef.current) setLogin(normalizeLogin(val));
    } catch (e) { await reportError(e, '取消登录失败'); }
  });

  react.useEffect(() => {
    if (!LOGIN_ACTIVE_STATES.includes(login.state)) return undefined;
    let alive = true;
    let timer = null;
    const poll = async () => {
      try {
        const val = await client.invoke({ op: login.jobId ? 'loginStatus' : 'read' });
        if (!alive) return;
        const next = normalizeLogin(login.jobId ? val : val.login);
        setLogin(next);
        if (LOGIN_ACTIVE_STATES.includes(next.state)) timer = setTimeout(poll, LOGIN_POLL_MS);
      } catch {
        if (alive) timer = setTimeout(poll, 2000);
      }
    };
    timer = setTimeout(poll, LOGIN_POLL_MS);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [client, login.jobId, login.state]);

  react.useEffect(() => {
    if (login.state !== 'success') return;
    const key = `${login.accountId ?? ''}:${login.jobId ?? ''}`;
    if (handledLoginRef.current === key) return;
    handledLoginRef.current = key;
    void refresh();
  }, [login.state, login.accountId, login.jobId, refresh]);

  const loginActive = LOGIN_ACTIVE_STATES.includes(login.state);
  const disabled = busy !== null || loginActive;
  const providerEnabled = snapshot?.enabled !== false;
  const filterQ = modelFilter.trim().toLowerCase();
  const filteredModels = filterQ
    ? models.filter((m) => m.id.toLowerCase().includes(filterQ) || (m.name && m.name.toLowerCase().includes(filterQ)))
    : models;

  return h('div', { className: 'ddp-settings', style: style.root },
    h('header', { className: 'ddp-hero' },
      h('div', { className: 'ddp-brand-mark', 'aria-hidden': 'true' }, 'D'),
      h('div', { className: 'ddp-header-copy' },
        h('h2', { style: style.title }, 'Devin Provider'),
        h('p', { className: 'ddp-hero-subtitle' }, '接入 Devin 订阅账号（浏览器 PKCE / devin CLI / API Key），支持额度与重置倒计时、模型目录同步、逐模型参数覆盖与 5 分钟缓存保活。')),
      h('div', { className: 'ddp-actions' },
        h('span', { style: style.chip }, snapshot ? `${snapshot.accounts?.length ?? 0} 个账号 · 路由 devin` : '等待连接'),
        h('button', { type: 'button', style: style.btn, disabled: busy !== null || loading, onClick: () => { void refresh(); } }, loading ? '刷新中…' : '刷新状态'))),

    busy ? h(Notice, { role: 'status' }, busyMessage(busy)) : null,
    loadError ? h(Notice, { tone: 'error', role: 'alert' }, `读取状态失败：${loadError}`) : null,
    snapshot?.routingError ? h(Notice, { tone: 'error', role: 'alert' }, describeError(snapshot.routingError)) : null,
    notice ? h(Notice, { tone: notice.ok ? 'success' : 'error', role: 'status' }, notice.text) : null,

    !snapshot
      ? h('p', { style: style.muted }, '正在读取 Devin Provider 状态…')
      : h('div', { className: 'ddp-content', 'data-empty': !(snapshot.accounts?.length) },
        h('section', { className: 'ddp-card', 'aria-label': '路由与额度' },
          h(SectionHeading, {
            eyebrow: 'ROUTE & QUOTA',
            title: 'Devin 路由与订阅额度',
            action: h('div', { className: 'ddp-actions' },
              h(StatusChip, { tone: providerEnabled && activeAccount?.hasCredential ? 'success' : 'warn' },
                !providerEnabled ? '路由已停用' : !activeAccount ? '待选择账号' : activeAccount.hasCredential ? '路由已就绪' : '缺少凭据'),
              h('label', { className: 'ddp-toggle' },
                h('input', {
                  className: 'ddp-switch-input', type: 'checkbox', checked: providerEnabled, disabled,
                  'aria-label': '启用 Devin Provider 路由',
                  onChange: (e) => toggleProvider(Boolean(e.target.checked))
                }),
                h('span', null, '启用路由')))
          }),
          h('label', { style: style.field },
            h('span', { style: style.label }, '当前使用账号'),
            h('select', {
              style: style.input, value: activeAccountId ?? '', disabled,
              onChange: (e) => selectAccount(e.target.value || null)
            },
              h('option', { value: '' }, '未选择'),
              (snapshot.accounts ?? []).map((a) => h('option', { key: a.id, value: a.id }, `${accountName(a)} (${a.id})`)))),
          h('div', { className: 'ddp-section' },
            h('div', { className: 'ddp-heading' },
              h('strong', { style: { fontSize: 13 } }, '订阅额度与重置倒计时'),
              h('button', { type: 'button', style: style.btn, disabled: disabled || quotaBusy || !activeAccount, onClick: pullQuota }, quotaBusy ? '正在查询…' : '刷新额度')),
            activeAccount ? h(QuotaWindows, { quota }) : h('p', { style: style.muted }, '选择或添加账号后可查询每日/每周配额及 ACU 用量。'),
            quota?.updatedAt ? h('p', { style: style.muted }, `额度更新时间：${formatTime(quota.updatedAt)}`) : null)),

        h(SettingsCard, { settings: snapshot.settings, disabled, onSave: saveGlobalSettings }),

        h('section', { className: 'ddp-card', 'aria-label': '模型目录与参数覆盖' },
          h(SectionHeading, {
            eyebrow: 'MODEL CATALOG',
            title: '模型目录与逐模型参数',
            description: '按模型家族折叠，通过思考档位映射到 Devin 变体；支持单独启停模型并覆盖上下文、输出上限、温度、图片输入、工具调用与思考档位。',
            action: h('button', { type: 'button', style: style.btn, disabled: disabled || !activeAccount?.hasCredential, onClick: pullModels }, '拉取最新模型')
          }),
          activeCatalog
            ? h('div', { className: 'ddp-chip-row' },
              h('span', { style: style.chip }, `来源：${CATALOG_SOURCE_LABELS[activeCatalog.source] ?? activeCatalog.source}`),
              activeCatalog.updatedAt ? h('span', { style: style.chip }, `同步于 ${formatTime(activeCatalog.updatedAt)}`) : null)
            : null,
          activeCatalog?.error ? h(Notice, { tone: 'error' }, activeCatalog.error) : null,
          models.length
            ? h('details', { open: modelsOpen },
              h('summary', {
                style: style.summary,
                onClick: (e) => { if (e?.preventDefault) e.preventDefault(); setModelsOpen((p) => !p); }
              }, `模型列表（已启用 ${activeCatalog?.enabledCount ?? models.filter((m) => m.enabled).length} / 共 ${models.length} 个家族）`),
              h('div', { style: { marginTop: 8 } },
                h('input', {
                  type: 'search', style: style.input, value: modelFilter,
                  placeholder: '按模型名称或 ID 筛选…',
                  onChange: (e) => setModelFilter(e.target.value)
                })),
              h('div', { className: 'ddp-model-list' },
                filteredModels.map((model) => h(ModelRow, {
                  key: model.id, model, disabled, editor: modelEditor, draftError: modelDraftError, fieldErrors: modelFieldErrors,
                  onToggle: toggleModel,
                  onOpenEditor: (m) => { setModelEditor({ modelId: m.id, draft: modelDraftFrom(m) }); setModelDraftError(null); setModelFieldErrors(null); },
                  onCloseEditor: () => { setModelEditor(null); setModelDraftError(null); setModelFieldErrors(null); },
                  onChangeDraft: (patch) => setModelEditor((prev) => prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev),
                  onSave: saveModelSettings,
                  onReset: resetModelSettings
                }))))
            : h('p', { style: style.muted }, activeAccount ? '暂无模型数据。' : '选择账号后可查看并调整模型目录。')),

        h(AccountPanel, {
          snapshot, editor, confirmDelete, loginConfirm, login, busy,
          onNew: () => { setEditor({ mode: 'new', id: null, draft: emptyAccountDraft() }); setNotice(null); },
          onEdit: (acc) => { setEditor({ mode: 'edit', id: acc.id, draft: draftFromAccount(acc) }); setNotice(null); },
          onCancelEdit: () => setEditor(null),
          onChangeDraft: (patch) => setEditor((prev) => prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev),
          onSave: saveAccount,
          onRequestDelete: (id) => { setLoginConfirm(null); setConfirmDelete(id); },
          onConfirmDelete: removeAccount,
          onCancelDelete: () => setConfirmDelete(null),
          onRequestLogin: (target) => { setConfirmDelete(null); setLoginConfirm(target); },
          onConfirmLogin: confirmLogin,
          onCancelLoginConfirm: () => setLoginConfirm(null),
          onCancelLogin: cancelLogin,
          onImportCli: importCli,
          onSelectAccount: selectAccount
        })));
}

export function apply(ctx) {
  const runtime = { disposed: false, service: null, unmount: null, timers: new Set(), waiters: new Set() };
  ctx.effect(installStyles, 'dsh-devin-provider: 设置页样式');

  const lookupService = () => {
    try {
      const candidate = ctx.get('remote.devinProvider');
      return candidate && typeof candidate.invoke === 'function' ? candidate : null;
    } catch {
      return null;
    }
  };

  try {
    Promise.resolve(ctx.remote.$mount(devinRemote)).then((unmount) => {
      if (runtime.disposed) {
        if (typeof unmount === 'function') unmount();
      } else {
        runtime.unmount = unmount;
      }
    }, () => {});
  } catch {}

  try {
    ctx.inject(['remote.devinProvider'], (scope) => {
      const candidate = scope?.remote?.devinProvider ?? scope?.['remote.devinProvider'] ?? null;
      if (candidate && typeof candidate.invoke === 'function') runtime.service = candidate;
    });
  } catch {}

  const resolveService = async () => {
    if (runtime.disposed) throw new Error('设置页已卸载。');
    if (runtime.service) return runtime.service;
    const direct = lookupService();
    if (direct) {
      runtime.service = direct;
      return direct;
    }
    const deadline = Date.now() + SERVICE_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (runtime.disposed) throw new Error('设置页已卸载。');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          runtime.timers.delete(timer);
          runtime.waiters.delete(waiter);
          resolve();
        }, 200);
        const waiter = { timer, resolve };
        runtime.timers.add(timer);
        runtime.waiters.add(waiter);
      });
      const candidate = lookupService();
      if (candidate) {
        runtime.service = candidate;
        return candidate;
      }
    }
    throw new Error('Devin Provider 远端服务未就绪，请稍后重试。');
  };

  const invoke = async (request) => {
    const service = await resolveService();
    const result = await service.invoke(request);
    if (!result || typeof result !== 'object') throw new Error('远端返回了无法识别的响应。');
    if (result.ok) return result.value;
    const error = result.error;
    if (error instanceof Error) throw error;
    if (error && typeof error === 'object' && typeof error.message === 'string') throw new Error(error.message);
    throw new Error(typeof error === 'string' && error ? error : '远端调用失败。');
  };

  const client = { invoke };

  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'devin-provider',
      order: 25,
      label: () => 'Devin Provider',
      inject: () => ({ client })
    }, DevinProviderSection));
  } catch (error) {
    console.error('[dsh-devin-provider] 设置页注册失败:', error);
  }

  ctx.effect(() => () => {
    runtime.disposed = true;
    for (const waiter of runtime.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    runtime.waiters.clear();
    for (const timer of runtime.timers) clearTimeout(timer);
    runtime.timers.clear();
    if (typeof runtime.unmount === 'function') {
      try { runtime.unmount(); } catch {}
    }
    runtime.unmount = null;
  }, 'dsh-devin-provider: 清理客户端资源');
}

export const name = 'dsh-devin-provider';
export const inject = ['slots', 'remote'];
