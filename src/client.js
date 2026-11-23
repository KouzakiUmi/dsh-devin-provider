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
  root: { display: 'flex', flexDirection: 'column', gap: 14 },
  title: { margin: 0, fontSize: 20, fontWeight: 700, lineHeight: 1.2, letterSpacing: '-.02em' },
  card: { minWidth: 0 },
  cardTitle: { margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: '.01em', opacity: 0.72 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 180px', minWidth: 0 },
  label: { fontSize: 12, lineHeight: 1.45, opacity: 0.72 },
  input: {
    width: '100%', minWidth: 0, minHeight: 32, boxSizing: 'border-box', padding: '6px 10px',
    borderRadius: 8, fontSize: 13,
    border: '1px solid var(--ddp-line-strong)',
    background: 'transparent', color: 'inherit', font: 'inherit', colorScheme: 'inherit'
  },
  btn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 30,
    padding: '4px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 500,
    border: '1px solid var(--ddp-line-strong)',
    background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit'
  },
  primary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 30,
    padding: '4px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 500,
    border: '1px solid var(--ddp-accent)',
    background: 'var(--ddp-accent)',
    color: '#fff',
    cursor: 'pointer', font: 'inherit'
  },
  danger: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 30,
    padding: '4px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 500,
    border: '1px solid color-mix(in srgb, var(--ddp-danger) 45%, transparent)',
    background: 'color-mix(in srgb, var(--ddp-danger) 10%, transparent)',
    color: 'var(--ddp-danger)',
    cursor: 'pointer', font: 'inherit'
  },
  muted: { margin: 0, lineHeight: 1.5, fontSize: 12, opacity: 0.66, overflowWrap: 'anywhere' },
  error: { margin: 0, fontSize: 12, lineHeight: 1.5, fontWeight: 600, color: 'var(--ddp-danger)', overflowWrap: 'anywhere' },
  warn: { margin: 0, fontSize: 12, lineHeight: 1.5, fontWeight: 600, color: 'var(--ddp-warn-text)', overflowWrap: 'anywhere' },
  success: { margin: 0, fontSize: 12, lineHeight: 1.5, fontWeight: 600, color: 'var(--ddp-ok)', overflowWrap: 'anywhere' },
  chip: {
    display: 'inline-flex', alignItems: 'center', maxWidth: '100%', fontSize: 11, fontWeight: 560, lineHeight: 1.5,
    padding: '1px 8px', borderRadius: 999, whiteSpace: 'nowrap', overflowWrap: 'anywhere',
    background: 'var(--ddp-surface-2)', opacity: 0.85
  },
  summary: { cursor: 'pointer', minHeight: 28, padding: '4px 0', fontSize: 12, opacity: 0.72 }
};

const CLIENT_STYLES = `
:where(.ddp-settings,.ddp-fusion-wrap,.ddp-fusion-popover){
  --ddp-accent:#3b82f6;
  --ddp-ok:#22c55e;--ddp-warn:#eab308;--ddp-warn-text:#ca8a04;--ddp-fast-on:#d97706;--ddp-tight:#f97316;--ddp-danger:#ef4444;--ddp-neutral:#94a3b8;
  --ddp-line:color-mix(in srgb,currentColor 12%,transparent);
  --ddp-line-strong:color-mix(in srgb,currentColor 20%,transparent);
  --ddp-surface:color-mix(in srgb,currentColor 4%,transparent);
  --ddp-surface-2:color-mix(in srgb,currentColor 7%,transparent);
}
.ddp-settings,.ddp-fusion-wrap,.ddp-fusion-popover{color-scheme:light}
:where(body[data-ds-dark-theme],.dark,[data-theme=dark],[data-color-scheme=dark]) :is(.ddp-settings,.ddp-fusion-wrap,.ddp-fusion-popover),:is(.ddp-settings,.ddp-fusion-wrap,.ddp-fusion-popover):where(.dark,[data-theme=dark],[data-color-scheme=dark]){color-scheme:dark;--ddp-warn-text:#eab308;--ddp-fast-on:#facc15}
@media (prefers-color-scheme:dark){
  :where(:root:not(.light,[data-theme=light],[data-color-scheme=light])) :is(.ddp-settings,.ddp-fusion-wrap,.ddp-fusion-popover){color-scheme:dark;--ddp-warn-text:#eab308;--ddp-fast-on:#facc15}
}
.ddp-settings{color:var(--dsw-alias-label-primary,CanvasText);max-width:760px;margin:0 auto;padding:6px 2px 24px;font-size:13px;line-height:1.5;container-type:inline-size;container-name:ddp;-webkit-font-smoothing:antialiased}
.ddp-settings *{box-sizing:border-box}.ddp-settings :focus-visible{outline:2px solid var(--ddp-accent);outline-offset:2px}
.ddp-settings input::placeholder,.ddp-settings textarea::placeholder{opacity:.48}
.ddp-settings select option,.ddp-fusion-popover select option{color:CanvasText;background:Canvas}
.ddp-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ddp-header-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ddp-subtitle{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;opacity:.68}
.ddp-dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex:none;background:var(--ddp-neutral)}
.ddp-dot[data-tone=ok]{background:var(--ddp-ok)}.ddp-dot[data-tone=warn]{background:var(--ddp-warn)}.ddp-dot[data-tone=danger]{background:var(--ddp-danger)}
.ddp-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--ddp-line)}
.ddp-tab{flex:none;min-height:34px;padding:6px 12px;margin-bottom:-1px;border:0;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;background:transparent;color:inherit;opacity:.68;cursor:pointer;font-size:13px;font-weight:500;white-space:nowrap}
.ddp-tab:hover{opacity:.95;background:var(--ddp-surface)}
.ddp-tab[aria-selected=true]{opacity:1;font-weight:600;border-bottom-color:var(--ddp-accent)}
.ddp-tabpanel{display:flex;flex-direction:column;gap:14px;min-width:0}
.ddp-group{display:flex;flex-direction:column;gap:8px;min-width:0}
.ddp-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;min-height:24px}
.ddp-heading-copy{flex:1 1 180px;min-width:0;display:flex;flex-direction:column;gap:2px}.ddp-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}
.ddp-chip-row{display:flex;gap:6px;flex-wrap:wrap;min-width:0;align-items:center}
.ddp-list{display:flex;flex-direction:column;border:1px solid var(--ddp-line);border-radius:12px;background:var(--ddp-surface);overflow:hidden}
.ddp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;padding:10px 14px;flex-wrap:wrap}
.ddp-row+.ddp-row{border-top:1px solid var(--ddp-line)}
.ddp-row[data-disabled=true]{opacity:.58}
.ddp-row-copy{flex:1 1 200px;min-width:0;display:flex;flex-direction:column;gap:2px}
.ddp-row-title{font-size:13px;font-weight:560;overflow-wrap:anywhere}
.ddp-row-sub{font-size:11.5px;opacity:.62;overflow-wrap:anywhere}
.ddp-row-control{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.ddp-banner{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;background:color-mix(in srgb,var(--ddp-tone,var(--ddp-neutral)) 10%,transparent);border:1px solid color-mix(in srgb,var(--ddp-tone,var(--ddp-neutral)) 28%,transparent)}
.ddp-banner[data-tone=ok]{--ddp-tone:var(--ddp-ok)}.ddp-banner[data-tone=warn]{--ddp-tone:var(--ddp-warn)}.ddp-banner[data-tone=danger]{--ddp-tone:var(--ddp-danger)}.ddp-banner[data-tone=accent]{--ddp-tone:var(--ddp-accent)}
.ddp-banner-icon{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:var(--ddp-tone,var(--ddp-neutral));color:#fff;font-size:14px;font-weight:700;flex:none}
.ddp-banner[data-tone=warn] .ddp-banner-icon{color:#1f1300}
.ddp-banner-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ddp-banner-title{font-size:14px;font-weight:700;line-height:1.25}
.ddp-banner-sub{font-size:11.5px;opacity:.75;overflow-wrap:anywhere}
.ddp-notice{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--ddp-tone,var(--ddp-accent)) 28%,transparent);background:color-mix(in srgb,var(--ddp-tone,var(--ddp-accent)) 10%,transparent);overflow-wrap:anywhere}
.ddp-notice>p{flex:1 1 180px;min-width:0}.ddp-notice-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:50%;background:var(--ddp-tone,var(--ddp-accent));color:#fff;font-size:12px;font-weight:700;line-height:1}
.ddp-notice[data-tone=error]{--ddp-tone:var(--ddp-danger)}.ddp-notice[data-tone=warn]{--ddp-tone:var(--ddp-warn)}.ddp-notice[data-tone=success]{--ddp-tone:var(--ddp-ok)}
.ddp-notice[data-tone=warn] .ddp-notice-icon{color:#1f1300}
.ddp-switch-input{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:36px;height:20px;margin:0;border:0;border-radius:999px;background:var(--ddp-line-strong);cursor:pointer;transition:background .15s ease}
.ddp-switch-input::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
.ddp-switch-input:checked{background:var(--ddp-accent)}.ddp-switch-input:checked::after{transform:translateX(16px)}
.ddp-switch-input:disabled{opacity:.42;cursor:not-allowed}
.ddp-toggle{display:inline-flex;align-items:center;gap:8px;min-height:24px;font-size:12.5px;font-weight:500;white-space:nowrap;cursor:pointer}
.ddp-status-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:560;line-height:1.5;white-space:nowrap;background:var(--ddp-surface-2)}
.ddp-status-chip::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--ddp-tone,currentColor)}
.ddp-status-chip[data-tone=success]{--ddp-tone:var(--ddp-ok);background:color-mix(in srgb,var(--ddp-ok) 14%,transparent);color:var(--ddp-ok)}
.ddp-status-chip[data-tone=warn]{--ddp-tone:var(--ddp-warn);background:color-mix(in srgb,var(--ddp-warn) 14%,transparent);color:var(--ddp-warn-text)}
.ddp-quota-grid{display:flex;flex-direction:column;gap:10px}
.ddp-quota-window{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,currentColor 5%,transparent)}
.ddp-quota-window[data-tone=error]{background:color-mix(in srgb,var(--ddp-danger) 9%,transparent)}
.ddp-quota-line{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}.ddp-quota-name{font-size:13px;font-weight:600}.ddp-quota-value{display:flex;align-items:baseline;gap:3px;white-space:nowrap;font-variant-numeric:tabular-nums}
.ddp-quota-percent{font-size:18px;line-height:1.05;font-weight:700}.ddp-quota-track{width:100%;height:8px;border-radius:99px;overflow:hidden;background:rgba(128,128,128,.22)}
.ddp-quota-fill{height:100%;border-radius:99px;background:var(--ddp-ok);transition:width .25s ease}
.ddp-quota-window[data-tone=error] .ddp-quota-fill{background:var(--ddp-danger)}.ddp-quota-window[data-tone=tight] .ddp-quota-fill{background:var(--ddp-tight)}.ddp-quota-window[data-tone=warn] .ddp-quota-fill{background:var(--ddp-warn)}
.ddp-quota-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:11px;opacity:.66;overflow-wrap:anywhere}
.ddp-model-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex:1 1 220px;min-width:0}
.ddp-model-toggle{display:flex;align-items:center;gap:10px;flex:1 1 auto;min-width:0;cursor:pointer}.ddp-model-name{font-size:13px;font-weight:560;overflow-wrap:anywhere}
.ddp-model-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}.ddp-model-tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:10.5px;line-height:1.5;white-space:nowrap;background:var(--ddp-surface-2);opacity:.88}
.ddp-model-tag[data-tone=accent]{color:var(--ddp-accent);background:color-mix(in srgb,var(--ddp-accent) 13%,transparent);opacity:1}
.ddp-model-tag[data-tone=success]{color:var(--ddp-ok);background:color-mix(in srgb,var(--ddp-ok) 13%,transparent);opacity:1}
.ddp-model-tag[data-tone=warn]{color:var(--ddp-warn-text);background:color-mix(in srgb,var(--ddp-warn) 14%,transparent);opacity:1}
.ddp-model-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}.ddp-model-actions .ddp-button{min-height:24px;padding:2px 9px;font-size:12px}
.ddp-model-id{font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;font-size:11px;opacity:.56}
.ddp-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.ddp-editor{flex-basis:100%;display:flex;flex-direction:column;gap:10px;padding:10px 0 2px 12px;margin-top:4px;border-top:1px dashed var(--ddp-line);border-left:2px solid color-mix(in srgb,var(--ddp-accent) 55%,transparent)}
.ddp-confirm,.ddp-login-status{display:flex;flex-direction:column;gap:8px;padding:10px 14px;border-radius:10px;border:1px solid color-mix(in srgb,var(--ddp-warn) 28%,transparent);background:color-mix(in srgb,var(--ddp-warn) 9%,transparent)}
.ddp-section{border-top:1px solid var(--ddp-line);padding-top:10px;display:flex;flex-direction:column;gap:8px;min-width:0}
.ddp-button:hover:not(:disabled){background:var(--ddp-surface-2);border-color:color-mix(in srgb,currentColor 32%,transparent)}.ddp-button-primary:hover:not(:disabled){background:var(--ddp-accent);filter:brightness(1.06)}.ddp-button:disabled{opacity:.42;cursor:not-allowed}
:where(.ddp-fusion-wrap,.ddp-fusion-popover) *{box-sizing:border-box}
:where(.ddp-fusion-wrap,.ddp-fusion-popover) :is(button,select,input){font-family:inherit;font-size:inherit;color:inherit}
:where(.ddp-fusion-wrap,.ddp-fusion-popover) button{touch-action:manipulation}
.ddp-fusion-wrap{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;line-height:1.4}
.ddp-fast-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:24px;padding:3px 8px;border-radius:999px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;font-size:11.5px;font-weight:560;line-height:1;cursor:pointer;white-space:nowrap;transition:background .14s ease,border-color .14s ease,color .14s ease}
.ddp-fast-icon{display:inline-flex;align-items:center;line-height:1;transition:filter .14s ease,opacity .14s ease}
.ddp-fast-btn[aria-pressed=false] .ddp-fast-icon{filter:grayscale(1);opacity:.72}
.ddp-fast-btn:hover:not(:disabled){background:var(--ddp-surface-2);border-color:color-mix(in srgb,currentColor 32%,transparent)}
.ddp-fast-btn[aria-pressed=true]{border-color:color-mix(in srgb,var(--ddp-fast-on) 48%,transparent);background:color-mix(in srgb,var(--ddp-fast-on) 14%,transparent);color:var(--ddp-fast-on)}
.ddp-fast-btn[aria-pressed=true]:hover:not(:disabled){background:color-mix(in srgb,var(--ddp-fast-on) 20%,transparent);border-color:color-mix(in srgb,var(--ddp-fast-on) 58%,transparent)}
.ddp-fast-btn:disabled{opacity:.45;cursor:not-allowed}
.ddp-fusion-trigger{display:inline-flex;align-items:center;gap:6px;min-height:24px;max-width:min(46vw,240px);padding:3px 10px 3px 8px;border-radius:999px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;font-size:11.5px;font-weight:560;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;transition:background .14s ease,border-color .14s ease,color .14s ease}
.ddp-fusion-trigger:hover:not(:disabled){background:var(--ddp-surface-2);border-color:color-mix(in srgb,currentColor 32%,transparent)}
.ddp-fusion-trigger[data-active=true]{border-color:color-mix(in srgb,var(--ddp-accent) 45%,transparent);background:color-mix(in srgb,var(--ddp-accent) 10%,transparent)}
.ddp-fusion-trigger[aria-expanded=true],.ddp-fusion-trigger[data-active=true]:hover:not(:disabled){border-color:color-mix(in srgb,var(--ddp-accent) 52%,transparent);background:color-mix(in srgb,var(--ddp-accent) 16%,transparent)}
.ddp-fusion-trigger:disabled{opacity:.45;cursor:not-allowed}
.ddp-fusion-dot{width:6px;height:6px;border-radius:50%;flex:none;background:rgba(128,128,128,.6)}
.ddp-fusion-trigger[data-active=true] .ddp-fusion-dot,.ddp-fusion-trigger[aria-expanded=true] .ddp-fusion-dot{background:var(--ddp-accent)}
.ddp-fusion-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddp-fast-btn:focus-visible,.ddp-fusion-wrap :focus-visible,.ddp-fusion-popover :focus-visible{outline:2px solid var(--ddp-accent);outline-offset:2px}
.ddp-fusion-popover{position:absolute;bottom:calc(100% + 6px);right:0;z-index:50;width:min(312px,calc(100vw - 24px));max-height:min(70vh,calc(100vh - 72px));overflow-y:auto;overscroll-behavior:contain;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:var(--dsh-surface,var(--dsw-alias-bg-layer-1,Canvas));color:var(--dsh-text,var(--dsw-alias-label-primary,CanvasText));border:1px solid rgba(128,128,128,.28);box-shadow:0 12px 32px rgba(0,0,0,.28);font-family:inherit;font-size:11.5px;line-height:1.45;-webkit-font-smoothing:antialiased}
.ddp-pop-head{position:sticky;top:-12px;z-index:2;margin:-12px -12px 2px;padding:10px 12px 8px;background:var(--dsh-surface,var(--dsw-alias-bg-layer-1,Canvas));border-bottom:1px solid var(--ddp-line);display:flex;align-items:center;gap:6px}
.ddp-pop-title{font-size:12.5px;font-weight:600;line-height:1.3}
.ddp-pop-badge{padding:1px 7px;border-radius:999px;background:rgba(128,128,128,.16);font-size:10.5px;font-weight:560;line-height:1.45;white-space:nowrap}
.ddp-pop-badge[data-tone=accent]{color:var(--ddp-accent);background:color-mix(in srgb,var(--ddp-accent) 13%,transparent)}
.ddp-pop-close{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;padding:2px 6px;border:0;border-radius:6px;background:transparent;color:inherit;opacity:.6;cursor:pointer;font-size:15px;line-height:1}
.ddp-pop-close:hover:not(:disabled){opacity:1;background:var(--ddp-surface-2);border-color:transparent}
.ddp-pop-card{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;background:rgba(128,128,128,.07)}
.ddp-pop-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ddp-pop-card-title{font-size:11.5px;font-weight:600}
.ddp-pop-card-hint{font-size:10.5px;opacity:.62;white-space:nowrap}
.ddp-pop-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:8px}
.ddp-pop-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.ddp-pop-field-label{font-size:10.5px;opacity:.66}
.ddp-pop-select{width:100%;min-width:0;min-height:27px;padding:3px 7px;border-radius:7px;border:1px solid var(--ddp-line-strong);background:transparent;color:inherit;font-size:11.5px;color-scheme:inherit}
.ddp-pop-select:focus{outline:none;border-color:var(--ddp-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--ddp-accent) 18%,transparent)}
.ddp-pop-select:disabled{opacity:.48;cursor:not-allowed}
.ddp-pop-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.ddp-pop-row-copy{display:flex;flex-direction:column;gap:1px;min-width:0}
.ddp-pop-error{margin:0;padding:7px 10px;border-radius:10px;background:color-mix(in srgb,var(--ddp-danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--ddp-danger) 28%,transparent);color:var(--ddp-danger);font-size:11px;line-height:1.45;overflow-wrap:anywhere}
.ddp-pop-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px;flex-wrap:wrap}
.ddp-pop-meta{flex:1 1 110px;min-width:0;font-size:10.5px;opacity:.66}
.ddp-pop-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.ddp-pop-btn{display:inline-flex;align-items:center;justify-content:center;min-height:25px;padding:3px 10px;border-radius:7px;border:1px solid var(--ddp-line-strong);background:transparent;color:inherit;font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap}
.ddp-pop-btn:hover:not(:disabled){background:var(--ddp-surface-2);border-color:color-mix(in srgb,currentColor 32%,transparent)}
.ddp-pop-btn-primary{border:0;padding:4px 12px;background:rgba(59,130,246,.14);color:var(--ddp-accent);font-weight:600}
.ddp-pop-btn-primary:hover:not(:disabled){background:rgba(59,130,246,.22);border-color:transparent}
.ddp-pop-btn:disabled{opacity:.45;cursor:not-allowed}
.ddp-fusion-role{display:flex;flex-direction:column;gap:10px;padding:12px 14px}
.ddp-fusion-role+.ddp-fusion-role{border-top:1px solid var(--ddp-line)}
.ddp-fusion-role-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
html[data-dsh-go-island] .ddp-fusion-wrap{flex-wrap:wrap;width:100%}
html[data-dsh-go-island][data-dsh-go-island-form="panel"] .ddp-fusion-popover{position:static!important;top:auto!important;bottom:auto!important;left:auto!important;right:auto!important;width:100%!important;max-height:none!important;overflow:visible!important;margin-top:8px;box-shadow:none!important;background:transparent!important;border-color:rgba(128,128,128,.2)!important}
@media(max-width:680px){.ddp-fields{grid-template-columns:1fr}}
@container ddp (max-width:560px){.ddp-fields{grid-template-columns:1fr}.ddp-row{padding:10px 12px}}
@media(prefers-reduced-motion:reduce){.ddp-settings *,.ddp-fusion-wrap *,.ddp-fusion-popover *{transition:none!important}}
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

function StatusBanner({ tone = 'muted', icon = 'i', title, subtitle, action }) {
  return h('div', { className: 'ddp-banner', 'data-tone': tone },
    h('span', { className: 'ddp-banner-icon', 'aria-hidden': 'true' }, icon),
    h('div', { className: 'ddp-banner-copy' },
      h('span', { className: 'ddp-banner-title' }, title),
      subtitle ? h('span', { className: 'ddp-banner-sub' }, subtitle) : null),
    action ?? null);
}

function StatusChip({ tone = 'muted', children }) {
  return h('span', { className: 'ddp-status-chip', 'data-tone': tone }, children);
}

function ModelTag({ tone = 'muted', title, children }) {
  return h('span', { className: 'ddp-model-tag', 'data-tone': tone, title }, children);
}

function SectionHeading({ title, description, action }) {
  return h('div', { className: 'ddp-heading' },
    h('div', { className: 'ddp-heading-copy' },
      h('h3', { style: style.cardTitle }, title),
      description ? h('p', { style: style.muted }, description) : null),
    action ?? null);
}

// ── 额度展示 ─────────────────────────────────────────────────────────────────

function fmtUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `$${Number(value.toFixed(4))}`;
}

function formatCostTriple(cost) {
  if (!cost || typeof cost !== 'object') return '';
  return `${fmtUsd(cost.input)} / ${fmtUsd(cost.cache?.read ?? 0)} / ${fmtUsd(cost.output)}`;
}

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

  if (!quota || quota.state === 'idle') {
    return h(StatusBanner, {
      tone: 'muted', icon: 'i',
      title: '尚未拉取额度',
      subtitle: '点击「刷新额度」或等待后台自动同步后查看每日、每周额度、ACU 用量及重置倒计时。'
    });
  }
  if (quota.state === 'expired') {
    return h(StatusBanner, { tone: 'danger', icon: '×', title: 'Devin 登录已失效', subtitle: quota.error || '请前往账号页重新登录。' });
  }
  if (quota.state === 'no-key') return h(StatusBanner, { tone: 'warn', icon: '!', title: '缺少凭据', subtitle: quota.error || '当前账号未配置凭据。' });
  if (quota.state === 'error') return h(StatusBanner, { tone: 'danger', icon: '×', title: '额度读取失败', subtitle: quota.error || '请稍后重试。' });
  if (quota.state === 'loading' && !windows.length) return h('p', { style: style.muted }, '正在后台拉取额度，请稍候…');

  const worstUsed = windows.length ? Math.max(...windows.map((w) => Math.min(100, Math.max(0, Number(w.usedPercent) || 0)))) : 0;
  const bannerTone = worstUsed >= 95 ? 'danger' : worstUsed >= 75 ? 'warn' : 'ok';
  const bannerTitle = !windows.length ? '账号可用' : worstUsed >= 95 ? '额度即将耗尽' : worstUsed >= 75 ? '用量偏高' : '额度充足';
  const metaParts = [
    quota.identity?.plan ? `套餐 ${quota.identity.plan}` : null,
    quota.overageBalance ? `超额余额 ${quota.overageBalance}` : null,
    quota.planEnd ? `周期至 ${formatTime(quota.planEnd)}` : null
  ].filter(Boolean);

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h(StatusBanner, {
      tone: bannerTone,
      icon: bannerTone === 'ok' ? '✓' : bannerTone === 'warn' ? '!' : '×',
      title: bannerTitle,
      subtitle: metaParts.join(' · ') || '实时额度窗口'
    }),
    quota.staleReason ? h(Notice, { tone: 'warn', role: 'status' }, `显示上次持久化额度缓存（最近后台同步失败：${quota.staleReason}）`) : null,
    windows.length
      ? h('div', { className: 'ddp-quota-grid' },
        windows.map((w, idx) => {
          const used = Math.min(100, Math.max(0, Number(w.usedPercent) || 0));
          const remaining = Math.min(100, Math.max(0, Number(w.remainingPercent) ?? (100 - used)));
          const tone = remaining <= 10 ? 'error' : remaining <= 25 ? 'tight' : remaining <= 50 ? 'warn' : 'ok';
          return h('div', { key: w.kind || idx, className: 'ddp-quota-window', 'data-tone': tone },
            h('div', { className: 'ddp-quota-line' },
              h('div', null,
                h('span', { className: 'ddp-quota-name' }, w.label || w.kind),
                h('div', { style: { fontSize: 11.5, opacity: 0.62, fontVariantNumeric: 'tabular-nums' } },
                  w.detail ? `已用 ${w.detail.used} / ${w.detail.limit} ${w.detail.unit}` : `已用 ${formatPercent(used)}%`)),
              h('span', { className: 'ddp-quota-value' },
                h('span', { className: 'ddp-quota-percent' }, `${formatPercent(remaining)}%`),
                h('span', { style: style.muted }, '剩余'))),
            h('div', { className: 'ddp-quota-track' },
              h('div', { className: 'ddp-quota-fill', style: { width: `${formatPercent(remaining)}%` } })),
            h('div', { className: 'ddp-quota-meta' },
              w.resetsAt
                ? h('span', null, `${resetCountdown(w.resetsAt, now)}（${formatTime(w.resetsAt)}）`)
                : h('span', null, '重置时间未提供'),
              Array.isArray(w.notModels) && w.notModels.length
                ? h('span', null, `不含免费模型（${w.notModels.length} 个变体）`)
                : null));
        }))
      : h('p', { style: style.muted }, '账号未返回每日/每周配额窗口（可能是按量或团队无限制套餐）。'),
    quota.refreshing ? h('p', { style: style.muted }, '后台刷新中，已先行展示本地持久化缓存…') : null,
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
  return h('div', { className: 'ddp-row', 'data-disabled': enabled ? 'false' : 'true' },
    h('div', { className: 'ddp-row-copy' },
      h('div', { className: 'ddp-chip-row' },
        h('span', { className: 'ddp-model-name', title: model?.id }, model?.name || model?.id),
        model?.free
          ? h(ModelTag, { tone: 'success' }, '免费')
          : model?.mixedFree ? h(ModelTag, null, '部分免费') : null,
        hasOverrides ? h(ModelTag, { tone: 'accent' }, '已调参') : null,
        !enabled ? h(ModelTag, { tone: 'warn' }, '已停用') : null),
      h('div', { className: 'ddp-model-id' }, model?.id ?? ''),
      h('div', { className: 'ddp-model-tags' },
        h(ModelTag, { tone: values.imageInput ? 'accent' : 'muted' }, values.imageInput ? '视觉' : '纯文本'),
        h(ModelTag, { tone: values.reasoningEfforts ? 'accent' : 'muted' }, values.reasoningEfforts ? `思考 (${Object.keys(values.reasoningEfforts).join('/')})` : '无思考档位'),
        h(ModelTag, null, `上下文 ${formatTokenCount(values.contextWindow)}`),
        h(ModelTag, null, `输出 ${formatTokenCount(values.maxTokens)}`),
        values.defaultReasoning ? h(ModelTag, { tone: 'accent' }, `默认 ${values.defaultReasoning}`) : null,
        values.toolsEnabled === false ? h(ModelTag, { tone: 'warn' }, '工具已停用') : null,
        model?.free
          ? h(ModelTag, { tone: 'success' }, '标准免费')
          : model?.cost
            ? h(ModelTag, null, `标准 ${formatCostTriple(model.cost)}/1M`)
            : model?.mixedFree
              ? h(ModelTag, null, '部分档位免费')
              : model?.mixedCost ? h(ModelTag, null, '标准变体计费') : null,
        model?.fastTier
          ? h(ModelTag, { tone: 'warn' }, model.fastCost ? `⚡ ${model.fastLabel} ${formatCostTriple(model.fastCost)}/1M` : `⚡ ${model.fastLabel}${model.fastMixedCost ? ' · 变体计费' : ''}`)
          : null)),
    h('div', { className: 'ddp-model-actions' },
      hasOverrides || !enabled
        ? h('button', { type: 'button', style: style.btn, disabled, onClick: () => onReset(model) }, enabled ? '恢复默认' : '恢复默认并启用')
        : null,
      h('button', { type: 'button', style: style.btn, disabled, onClick: () => (editing ? onCloseEditor() : onOpenEditor(model)) }, editing ? '收起参数' : '参数'),
      h('input', {
        className: 'ddp-switch-input', type: 'checkbox', checked: enabled, disabled,
        'aria-label': `启用模型 ${model?.id ?? ''}`,
        onChange: (e) => onToggle(model, Boolean(e.target.checked))
      })),
    model?.settingsWarning ? h('p', { role: 'alert', style: { ...style.warn, flexBasis: '100%' } }, model.settingsWarning) : null,
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

  return h('section', { className: 'ddp-group', 'aria-label': '缓存保活与高级设置' },
    h(SectionHeading, {
      title: '提示词缓存保活（5 分钟）与服务连接',
      description: '开启后在回复结束按间隔自动发 max_tokens=1 续命请求（按缓存读取计费），默认关闭。',
      action: h('div', { className: 'ddp-actions' },
        h('button', {
          type: 'button', style: style.btn, disabled,
          onClick: () => { setEnabled(false); setIntervalSec('285'); setMaxPings('6'); setServerUrl(''); setLocalError(''); }
        }, '重置默认值'),
        h('button', { type: 'button', style: style.primary, disabled, onClick: submit }, '保存保活与服务设置'))
    }),
    h('div', { className: 'ddp-list' },
      h('div', { className: 'ddp-row' },
        h('div', { className: 'ddp-row-copy' },
          h('span', { className: 'ddp-row-title' }, '启用提示词缓存保活'),
          h('span', { className: 'ddp-row-sub' }, enabled ? '回复结束将自动按以下节奏续命 5 分钟缓存' : '当前关闭')),
        h('input', {
          className: 'ddp-switch-input', type: 'checkbox', checked: enabled, disabled,
          'aria-label': '启用提示词缓存保活',
          onChange: (e) => setEnabled(Boolean(e.target.checked))
        })),
      h('div', { className: 'ddp-row', 'data-disabled': enabled ? 'false' : 'true' },
        h('div', { className: 'ddp-row-copy' },
          h('span', { className: 'ddp-row-title' }, '保活间隔（秒）'),
          h('span', { className: 'ddp-row-sub' }, '范围 30–299 秒，推荐默认 285 秒')),
        h('input', {
          type: 'number', min: 30, max: 299, style: { ...style.input, width: 120, textAlign: 'right' }, value: intervalSec, disabled,
          onChange: (e) => setIntervalSec(e.target.value)
        })),
      h('div', { className: 'ddp-row', 'data-disabled': enabled ? 'false' : 'true' },
        h('div', { className: 'ddp-row-copy' },
          h('span', { className: 'ddp-row-title' }, '单次对话最大保活次数'),
          h('span', { className: 'ddp-row-sub' }, '范围 1–50 次，默认 6 次')),
        h('input', {
          type: 'number', min: 1, max: 50, style: { ...style.input, width: 120, textAlign: 'right' }, value: maxPings, disabled,
          onChange: (e) => setMaxPings(e.target.value)
        })),
      h('div', { className: 'ddp-row' },
        h('div', { className: 'ddp-row-copy' },
          h('span', { className: 'ddp-row-title' }, '全局 API 服务地址（可选）'),
          h('span', { className: 'ddp-row-sub' }, '留空使用 https://server.codeium.com；填写后账号凭据将发送至该地址')),
        h('input', {
          type: 'text', style: { ...style.input, width: 'min(100%, 280px)' }, value: serverUrl, disabled,
          placeholder: 'https://server.codeium.com',
          onChange: (e) => setServerUrl(e.target.value)
        }))),
    localError ? h(Notice, { tone: 'error', role: 'alert' }, localError) : null);
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

  return h('section', { id: 'ddp-account-panel', className: 'ddp-group ddp-account-panel', 'aria-label': '账号管理与登录' },
    h(SectionHeading, {
      title: `已配置账号（${accounts.length}）`,
      description: '支持浏览器 PKCE 登录、导入本机 devin CLI 或填写 API Key / 凭据引用名。',
      action: h('div', { className: 'ddp-actions' },
        h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: onImportCli }, '导入 CLI 登录'),
        h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive || editor !== null, onClick: onNew }, '手动新增'),
        h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onRequestLogin(NEW_LOGIN_ACCOUNT) }, accounts.length ? '浏览器登录新账号' : '浏览器 PKCE 登录'))
    }),
    accounts.length
      ? h('div', { className: 'ddp-list' },
        accounts.map((acc) => {
          const isActive = snapshot?.activeAccountId === acc.id;
          return h('div', { key: acc.id, className: 'ddp-row' },
            h('div', { className: 'ddp-row-copy' },
              h('div', { className: 'ddp-chip-row' },
                h('strong', { className: 'ddp-row-title' }, accountName(acc)),
                isActive ? h(StatusChip, { tone: 'success' }, '当前使用') : null,
                acc.identity?.plan ? h('span', { style: style.chip }, acc.identity.plan) : null,
                h(StatusChip, { tone: acc.hasCredential ? 'success' : 'warn' }, acc.hasCredential ? '凭据就绪' : '缺少凭据'),
                acc.identityVerified === false ? h(StatusChip, { tone: 'warn' }, '未验证') : null),
              h('span', { className: 'ddp-row-sub' }, `${AUTH_MODE_LABELS[acc.authMode] ?? acc.authMode} · ID: ${acc.id}`),
              acc.credentialError ? h('p', { role: 'alert', style: style.error }, acc.credentialError) : null),
            h('div', { className: 'ddp-row-control' },
              !isActive ? h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onSelectAccount(acc.id) }, '使用此账号') : null,
              h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onRequestLogin(acc.id) }, 'PKCE 登录'),
              h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onEdit(acc) }, '编辑'),
              confirmDelete === acc.id
                ? h('button', { type: 'button', style: style.danger, disabled: disabled || loginActive, onClick: () => onConfirmDelete(acc.id) }, '确认删除')
                : h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onRequestDelete(acc.id) }, '删除'),
              confirmDelete === acc.id ? h('button', { type: 'button', style: style.btn, disabled, onClick: onCancelDelete }, '取消') : null),
            loginConfirm === acc.id
              ? h('div', { className: 'ddp-confirm', style: { flexBasis: '100%', marginTop: 4 } },
                h('strong', { style: { fontSize: 13 } }, `发起浏览器 PKCE 登录：${accountName(acc)}`),
                h('ul', { style: { margin: 0, paddingLeft: 18 } }, LOGIN_CONFIRM_NOTES.map((n, i) => h('li', { key: i, style: style.muted }, n))),
                h('div', { className: 'ddp-actions' },
                  h('button', { type: 'button', style: style.primary, disabled, onClick: () => onConfirmLogin(acc.id) }, '确认生成登录链接'),
                  h('button', { type: 'button', style: style.btn, disabled, onClick: onCancelLoginConfirm }, '取消')))
              : null);
        }))
      : h(StatusBanner, {
        tone: 'warn', icon: '!',
        title: '尚未配置 Devin 账号',
        subtitle: '点击右上角「浏览器 PKCE 登录」「导入 CLI 登录」或「手动新增」完成接入。'
      }),

    loginConfirm === NEW_LOGIN_ACCOUNT
      ? h('div', { className: 'ddp-confirm' },
        h('strong', { style: { fontSize: 13 } }, '创建新账号并启动浏览器 PKCE 登录'),
        h('ul', { style: { margin: 0, paddingLeft: 18 } }, LOGIN_CONFIRM_NOTES.map((n, i) => h('li', { key: i, style: style.muted }, n))),
        h('div', { className: 'ddp-actions' },
          h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onConfirmLogin(NEW_LOGIN_ACCOUNT) }, '确认生成登录链接'),
          h('button', { type: 'button', style: style.btn, disabled, onClick: onCancelLoginConfirm }, '取消')))
      : null,

    editor ? h('div', { className: 'ddp-list', style: { padding: '12px 14px' } }, h(AccountForm, { editor, busy, onChangeDraft, onSave, onCancel: onCancelEdit })) : null,

    login.state !== 'idle' || loginUrl
      ? (['success', 'cancelled', 'error'].includes(login.state)
        ? h(Notice, { tone: login.state === 'success' ? 'success' : login.state === 'cancelled' ? 'muted' : 'error', role: 'status' }, `${LOGIN_STATE_LABELS[login.state] ?? login.state}${login.message ? ` ${login.message}` : ''}`)
        : h('div', { className: 'ddp-login-status', role: 'status' },
          h('strong', { style: { fontSize: 13 } }, '浏览器 PKCE 登录进行中'),
          h('p', { style: style.muted }, LOGIN_STATE_LABELS[login.state] ?? login.state),
          login.url && !loginUrl ? h(Notice, { tone: 'error' }, '登录链接未通过安全校验（仅允许 app.devin.ai），已隐藏。') : null,
          loginUrl ? h('a', { href: loginUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: 12, color: 'var(--ddp-accent)' } }, '点击打开 Devin 官方登录页 (app.devin.ai)') : null,
          h('div', { className: 'ddp-actions' },
            h('button', { type: 'button', style: style.btn, disabled: !login.jobId, onClick: onCancelLogin }, '取消登录'))))
      : null);
}

// ── 主设置组件 ────────────────────────────────────────────────────────────────

const fusionPickEffort = (efforts) => (efforts.includes('medium') ? 'medium' : efforts[0] ?? '');

function fusionOptionName(opts, id) {
  if (!id) return '—';
  const list = Array.isArray(opts) ? opts : [];
  const hit = list.find((o) => o?.id === id || o?.familyId === id);
  return hit?.name || id;
}

function fusionRoleState(options, draft, setDraft) {
  const leads = Array.isArray(options?.leads) ? options.leads : [];
  const allSidekicks = Array.isArray(options?.sidekicks) ? options.sidekicks : [];
  const leadObj = leads.find((l) => l.id === draft?.lead) ?? null;
  const sidekicksForLead = (leadId) => {
    const lead = leads.find((l) => l.id === leadId);
    const allowed = Array.isArray(lead?.sidekicks) && lead.sidekicks.length ? lead.sidekicks : null;
    return allowed ? allSidekicks.filter((s) => allowed.includes(s.id)) : allSidekicks;
  };
  const sidekicks = sidekicksForLead(leadObj?.id);
  const sidekickObj = sidekicks.find((s) => s.id === draft?.sidekick) ?? null;
  const fastSidekicks = Array.isArray(leadObj?.fastSidekicks) ? leadObj.fastSidekicks : null;
  const sidekickSupportsFast = Boolean(leadObj?.fast)
    && (fastSidekicks ? fastSidekicks.includes(sidekickObj?.id) : true);
  const keepSidekick = (leadId, current) => {
    const list = sidekicksForLead(leadId);
    return list.some((s) => s.id === current) ? current : (list[0]?.id ?? '');
  };
  const set = (patch) => setDraft((p) => ({ ...p, ...patch }));
  return {
    leads,
    sidekicks,
    leadObj,
    sidekickObj,
    sidekickSupportsFast,
    leadEfforts: (leadObj?.efforts ?? []).map((e) => ({ id: e, name: e })),
    sidekickEfforts: (sidekickObj?.efforts ?? []).map((e) => ({ id: e, name: e })),
    setLead: (v) => {
      const side = keepSidekick(v, draft?.sidekick);
      const obj = sidekicksForLead(v).find((s) => s.id === side);
      const keptEffort = side === draft?.sidekick && draft?.sidekickEffort;
      set({
        lead: v,
        leadEffort: fusionPickEffort(leads.find((l) => l.id === v)?.efforts ?? []),
        sidekick: side,
        sidekickEffort: keptEffort && (obj?.efforts ?? []).includes(keptEffort) ? keptEffort : fusionPickEffort(obj?.efforts ?? [])
      });
    },
    setLeadEffort: (v) => set({ leadEffort: v }),
    setSidekick: (v) => set({ sidekick: v, sidekickEffort: fusionPickEffort(allSidekicks.find((s) => s.id === v)?.efforts ?? []) }),
    setSidekickEffort: (v) => set({ sidekickEffort: v })
  };
}

function FusionCard({ fusion, disabled, onSave }) {
  const options = fusion?.options ?? { leads: [], sidekicks: [], default: {} };
  const saved = fusion?.config ?? options.default ?? {};
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = react.useState(() => JSON.parse(savedKey));
  react.useEffect(() => { setDraft(JSON.parse(savedKey)); }, [savedKey]);
  const role = fusionRoleState(options, draft, setDraft);
  const dirty = JSON.stringify(draft) !== savedKey;
  const field = (label, value, opts, onChange, placeholder) => h('label', { style: style.field },
    h('span', { style: style.label }, label),
    h('select', { style: style.input, value: value ?? '', disabled: disabled || !opts.length, onChange: (e) => onChange(e.target.value) },
      h('option', { value: '' }, opts.length ? placeholder : '无须档位'),
      opts.map((o) => h('option', { key: o.id, value: o.id }, o.name))));
  const save = () => {
    const clean = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== '' && v != null));
    onSave(clean);
  };
  return h('section', { className: 'ddp-group', 'aria-label': 'Fusion 搭配' },
    h(SectionHeading, {
      title: 'Fusion 协同搭配（Lead + Sidekick）',
      description: 'Lead 负责规划推理与审查，Sidekick 负责机械实现；默认值从实时目录读取。',
      action: h('button', { type: 'button', style: dirty ? style.primary : style.btn, disabled: disabled || !dirty, onClick: () => save() }, '保存搭配')
    }),
    !role.leads.length && !role.sidekicks.length
      ? h('p', { style: style.muted }, '当前目录暂无可用 Fusion 模型，请先拉取模型目录。')
      : h('div', { className: 'ddp-list' },
        h('div', { className: 'ddp-fusion-role' },
          h('div', { className: 'ddp-fusion-role-head' },
            h('span', { className: 'ddp-row-title' }, 'Lead 主模型'),
            h('div', { className: 'ddp-chip-row' },
              role.sidekickSupportsFast ? h('span', { className: 'ddp-model-tag', 'data-tone': 'warn' }, '支持 ⚡ 快速模式') : null,
              h('span', { style: style.muted }, '规划与审查'))),
          h('div', { className: 'ddp-fields' },
            field('Lead 模型', draft.lead, role.leads, role.setLead, '选择 lead'),
            field('Lead 档位', draft.leadEffort, role.leadEfforts, role.setLeadEffort, '选择档位'))),
        h('div', { className: 'ddp-fusion-role' },
          h('div', { className: 'ddp-fusion-role-head' },
            h('span', { className: 'ddp-row-title' }, 'Sidekick 副模型'),
            h('span', { style: style.muted }, role.sidekickEfforts.length ? '机械实现' : '机械实现 · 固定单档')),
          h('div', { className: 'ddp-fields' },
            field('Sidekick 模型', draft.sidekick, role.sidekicks, role.setSidekick, '选择 sidekick'),
            field('Sidekick 档位', draft.sidekickEffort, role.sidekickEfforts, role.setSidekickEffort, '选择档位'))),
        dirty ? h('div', { className: 'ddp-row', style: { minHeight: 0, paddingTop: 8, paddingBottom: 8 } },
          h('span', { style: style.muted }, '有未保存的改动，点击右上角「保存搭配」生效。')) : null));
}

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
  const [tab, setTab] = react.useState('overview');
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
  }, [activeAccountId]);

  const persistedQuota = activeAccountId ? (snapshot?.quotas?.[activeAccountId] ?? null) : null;
  react.useEffect(() => {
    if (!activeAccountId) {
      setQuota(null);
      setQuotaBusy(false);
      return;
    }
    if (persistedQuota) {
      setQuota(persistedQuota);
      setQuotaBusy(Boolean(persistedQuota.refreshing));
    }
  }, [activeAccountId, persistedQuota]);

  const quotaPollTimerRef = react.useRef(null);
  const pollQuotaRead = react.useCallback((accountId, epoch, startedAt) => {
    const tickRead = async () => {
      try {
        const val = await client.invoke({ op: 'readQuota', accountId });
        if (!aliveRef.current || quotaEpochRef.current !== epoch) return;
        setQuota(val);
        const refreshing = Boolean(val?.refreshing);
        setQuotaBusy(refreshing);
        if (refreshing && Date.now() - startedAt < 30_000) {
          quotaPollTimerRef.current = setTimeout(() => { quotaPollTimerRef.current = null; void tickRead(); }, 800);
        }
      } catch {}
    };
    quotaPollTimerRef.current = setTimeout(() => { quotaPollTimerRef.current = null; void tickRead(); }, 600);
  }, [client]);

  // 纯读取：绝不在打开设置或切换账号时强拉远端网络，仅同步持久化缓存或续接正在进行的后台刷新。
  const readQuotaOnce = react.useCallback(async () => {
    if (!activeAccountId) return;
    const epoch = ++quotaEpochRef.current;
    const accountId = activeAccountId;
    try {
      const val = await client.invoke({ op: 'readQuota', accountId });
      if (!aliveRef.current || quotaEpochRef.current !== epoch) return;
      setQuota(val);
      const refreshing = Boolean(val?.refreshing);
      setQuotaBusy(refreshing);
      if (refreshing && !quotaPollTimerRef.current) {
        pollQuotaRead(accountId, epoch, Date.now());
      }
    } catch {}
  }, [activeAccountId, client, pollQuotaRead]);

  // 显式拉取：仅在用户点击「刷新额度」时异步触发后台 pullQuota，并转入轻量 readQuota 轮询。
  const pullQuota = (force = true) => {
    if (!activeAccountId) return;
    const forceRefresh = typeof force === 'boolean' ? force : true;
    const epoch = ++quotaEpochRef.current;
    const accountId = activeAccountId;
    if (quotaPollTimerRef.current) { clearTimeout(quotaPollTimerRef.current); quotaPollTimerRef.current = null; }
    setQuotaBusy(true);
    const startedAt = Date.now();
    void (async () => {
      try {
        const val = await client.invoke({ op: 'pullQuota', accountId, force: Boolean(forceRefresh) });
        if (!aliveRef.current || quotaEpochRef.current !== epoch) return;
        setQuota(val);
        const refreshing = Boolean(val?.refreshing);
        setQuotaBusy(refreshing);
        if (refreshing) pollQuotaRead(accountId, epoch, startedAt);
      } catch (err) {
        if (aliveRef.current && quotaEpochRef.current === epoch) {
          setQuota({ accountId, state: 'error', windows: [], error: describeError(err) });
          setQuotaBusy(false);
        }
      }
    })();
  };

  react.useEffect(() => {
    if (!activeAccountId) return undefined;
    const id = setInterval(() => { void readQuotaOnce(); }, 60_000);
    return () => clearInterval(id);
  }, [activeAccountId, readQuotaOnce]);
  react.useEffect(() => () => { if (quotaPollTimerRef.current) clearTimeout(quotaPollTimerRef.current); }, []);

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
  const saveFusion = (config) => run('fusion', async () => {
    if (!activeAccountId) return;
    try {
      const value = await client.invoke({ op: 'saveFusion', revision: snapshot.revision, accountId: activeAccountId, config });
      applySnapshot(value);
      setNotice({ ok: true, text: 'Fusion 搭配已保存。' });
    } catch (error) { await reportError(error, '保存 Fusion'); }
  });

  const clearFastSessions = () => run('fastMode', async () => {
    try {
      const value = await client.invoke({ op: 'setFastMode', clearAll: true });
      applySnapshot(value);
      setNotice({ ok: true, text: '已关闭所有会话的快速模式。' });
    } catch (error) { await reportError(error, '重置会话快速模式'); }
  });

  const disabled = busy !== null || loginActive;
  const providerEnabled = snapshot?.enabled !== false;
  const filterQ = modelFilter.trim().toLowerCase();
  const filteredModels = filterQ
    ? models.filter((m) => m.id.toLowerCase().includes(filterQ) || (m.name && m.name.toLowerCase().includes(filterQ)))
    : models;
  const routeTone = !providerEnabled ? 'neutral' : activeAccount?.hasCredential ? 'ok' : 'warn';
  const routeLabel = !providerEnabled ? '路由已停用' : !activeAccount ? '未选择账号' : activeAccount.hasCredential ? `${accountName(activeAccount)} · 已就绪` : `${accountName(activeAccount)} · 缺少凭据`;
  const TABS = [
    { id: 'overview', label: '概览与额度' },
    { id: 'models', label: `模型与 Fusion (${models.length})` },
    { id: 'accounts', label: `账号与登录 (${snapshot?.accounts?.length ?? 0})` },
    { id: 'advanced', label: '高级设置' }
  ];

  return h('div', { className: 'ddp-settings', style: style.root },
    h('header', { className: 'ddp-header' },
      h('div', { className: 'ddp-header-copy' },
        h('h2', { style: style.title }, 'Devin Provider'),
        h('div', { className: 'ddp-subtitle' },
          h('span', { className: 'ddp-dot', 'data-tone': routeTone }),
          h('span', null, routeLabel),
          snapshot ? h('span', null, `· 已启用 ${models.filter((m) => m.enabled).length}/${models.length} 模型`) : null)),
      h('div', { className: 'ddp-actions' },
        snapshot && h('label', { className: 'ddp-toggle' },
          h('input', {
            className: 'ddp-switch-input', type: 'checkbox', checked: providerEnabled, disabled,
            'aria-label': '启用 Devin Provider 路由',
            onChange: (e) => toggleProvider(Boolean(e.target.checked))
          }),
          h('span', null, '启用路由')),
        h('button', { type: 'button', style: style.btn, disabled: busy !== null || loading, onClick: () => { void refresh(); } }, loading ? '刷新中…' : '刷新'))),

    busy ? h(Notice, { role: 'status' }, busyMessage(busy)) : null,
    loadError ? h(Notice, { tone: 'error', role: 'alert' }, `读取状态失败：${loadError}`) : null,
    snapshot?.routingError ? h(Notice, { tone: 'error', role: 'alert' }, describeError(snapshot.routingError)) : null,
    notice ? h(Notice, { tone: notice.ok ? 'success' : 'error', role: 'status' }, notice.text) : null,

    !snapshot
      ? h('p', { style: style.muted }, '正在读取 Devin Provider 状态…')
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h('div', { className: 'ddp-tabs', role: 'tablist', 'aria-label': 'Devin Provider 分区' },
          TABS.map((t) => h('button', {
            key: t.id, type: 'button', role: 'tab', className: 'ddp-tab',
            'aria-selected': tab === t.id, onClick: () => setTab(t.id)
          }, t.label))),

        // 1. 概览与额度
        h('div', { className: 'ddp-tabpanel', style: { display: tab === 'overview' ? 'flex' : 'none' }, hidden: tab !== 'overview' },
          !(snapshot.accounts?.length)
            ? h(StatusBanner, {
              tone: 'warn', icon: '!',
              title: '欢迎使用 Devin Provider',
              subtitle: '请先添加并授权一个 Devin 账号以解锁额度查询、模型列表和请求路由。',
              action: h('button', { type: 'button', style: style.primary, onClick: () => setTab('accounts') }, '前往登录')
            })
            : null,
          h('section', { className: 'ddp-group', 'aria-label': '当前账号与路由' },
            h(SectionHeading, {
              title: '路由与当前账号',
              action: h('button', { type: 'button', style: style.btn, onClick: () => setTab('accounts') }, '管理账号')
            }),
            h('div', { className: 'ddp-list' },
              h('div', { className: 'ddp-row' },
                h('div', { className: 'ddp-row-copy' },
                  h('span', { className: 'ddp-row-title' }, '当前路由账号'),
                  h('span', { className: 'ddp-row-sub' }, activeAccount ? `${AUTH_MODE_LABELS[activeAccount.authMode] ?? activeAccount.authMode}${activeAccount.identity?.plan ? ` · ${activeAccount.identity.plan}` : ''}` : '选择一个已登录账号用于对话路由')),
                h('select', {
                  style: { ...style.input, width: 'min(100%, 260px)' }, value: activeAccountId ?? '', disabled,
                  'aria-label': '当前使用账号',
                  onChange: (e) => selectAccount(e.target.value || null)
                },
                  h('option', { value: '' }, '未选择'),
                  (snapshot.accounts ?? []).map((a) => h('option', { key: a.id, value: a.id }, `${accountName(a)} (${a.id})`)))),
              h('div', { className: 'ddp-row' },
                h('div', { className: 'ddp-row-copy' },
                  h('span', { className: 'ddp-row-title' }, 'Fusion 当前搭配'),
                  h('span', { className: 'ddp-row-sub' }, snapshot.fusion?.config?.lead
                    ? `${fusionOptionName(snapshot.fusion?.options?.leads, snapshot.fusion.config.lead)} + ${fusionOptionName(snapshot.fusion?.options?.sidekicks, snapshot.fusion.config.sidekick)}`
                    : '默认（Claude Opus 5.5 + SWE-2）')),
                h('button', { type: 'button', style: style.btn, onClick: () => setTab('models') }, '调整搭配')))),
          h('section', { className: 'ddp-group', 'aria-label': '订阅额度' },
            h(SectionHeading, {
              title: '订阅额度与重置倒计时',
              description: quota?.updatedAt ? `最近更新：${formatTime(quota.updatedAt)}` : undefined,
              action: h('button', { type: 'button', style: style.btn, disabled: disabled || quotaBusy || !activeAccount, onClick: () => pullQuota(true) }, quotaBusy ? '正在查询…' : '刷新额度')
            }),
            activeAccount
              ? h(QuotaWindows, { quota })
              : h(StatusBanner, { tone: 'muted', icon: 'i', title: '等待选择账号', subtitle: '选择或添加账号后可查询每日/每周配额及 ACU 用量。' }))),

        // 2. 模型与 Fusion
        h('div', { className: 'ddp-tabpanel', style: { display: tab === 'models' ? 'flex' : 'none' }, hidden: tab !== 'models' },
          h(FusionCard, { fusion: snapshot.fusion, disabled, onSave: saveFusion }),
          h('div', { className: 'ddp-list' },
            h('div', { className: 'ddp-row' },
              h('div', { className: 'ddp-row-copy' },
                h('span', { className: 'ddp-row-title' }, '⚡ 快速模式（按会话独立设置）'),
                h('span', { className: 'ddp-row-sub' }, snapshot.fastSessionsCount
                  ? `当前有 ${snapshot.fastSessionsCount} 个会话已开启快速加速；请在对应对话输入框右侧点击 ⚡ 按钮独立开关。`
                  : '支持加速的模型按当前会话独立控制，已在模型列表隐藏快速变体；可在对话输入框右侧点击 ⚡ 开启。')),
              snapshot.fastSessionsCount
                ? h('button', { type: 'button', style: style.btn, disabled, onClick: () => clearFastSessions() }, '全部关闭')
                : h('span', { style: style.chip }, '按会话生效'))),
          h('section', { className: 'ddp-group', 'aria-label': '模型目录与参数覆盖' },
            h(SectionHeading, {
              title: `模型目录（已启用 ${activeCatalog?.enabledCount ?? models.filter((m) => m.enabled).length}/${models.length}）`,
              description: activeCatalog
                ? `来源：${CATALOG_SOURCE_LABELS[activeCatalog.source] ?? activeCatalog.source}${activeCatalog.updatedAt ? ` · 同步于 ${formatTime(activeCatalog.updatedAt)}` : ''} · 价格单位 $/1M（输入 / 缓存读取 / 输出）`
                : '按模型家族折叠，已隐藏快速模式变体；支持独立启停及覆盖上下文、输出上限与思考档位（价格单位 $/1M：输入 / 缓存读取 / 输出）。',
              action: h('button', { type: 'button', style: style.primary, disabled: disabled || !activeAccount?.hasCredential, onClick: () => pullModels() }, '拉取最新模型')
            }),
            activeCatalog?.error ? h(Notice, { tone: 'error' }, activeCatalog.error) : null,
            models.length
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h('input', {
                  type: 'search', style: style.input, value: modelFilter,
                  placeholder: '搜索模型名称或家族 ID…',
                  onChange: (e) => setModelFilter(e.target.value)
                }),
                h('div', { className: 'ddp-list' },
                  (modelsOpen || filterQ ? filteredModels : filteredModels.slice(0, 8)).map((model) => h(ModelRow, {
                    key: model.id, model, disabled, editor: modelEditor, draftError: modelDraftError, fieldErrors: modelFieldErrors,
                    onToggle: toggleModel,
                    onOpenEditor: (m) => { setModelEditor({ modelId: m.id, draft: modelDraftFrom(m) }); setModelDraftError(null); setModelFieldErrors(null); },
                    onCloseEditor: () => { setModelEditor(null); setModelDraftError(null); setModelFieldErrors(null); },
                    onChangeDraft: (patch) => setModelEditor((prev) => prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev),
                    onSave: saveModelSettings,
                    onReset: resetModelSettings
                  }))),
                !filterQ && filteredModels.length > 8
                  ? h('button', { type: 'button', style: { ...style.btn, alignSelf: 'flex-start' }, onClick: () => setModelsOpen((p) => !p) }, modelsOpen ? '仅显示前 8 个' : `展开全部 ${filteredModels.length} 个模型`)
                  : null)
              : h('p', { style: style.muted }, activeAccount ? '暂无模型数据，点击「拉取最新模型」获取。' : '请先在「账号与登录」中选择或添加账号。'))),

        // 3. 账号与登录
        h('div', { className: 'ddp-tabpanel', style: { display: tab === 'accounts' ? 'flex' : 'none' }, hidden: tab !== 'accounts' },
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
          })),

        // 4. 高级设置
        h('div', { className: 'ddp-tabpanel', style: { display: tab === 'advanced' ? 'flex' : 'none' }, hidden: tab !== 'advanced' },
          h(SettingsCard, { settings: snapshot.settings, disabled, onSave: saveGlobalSettings }))));
}

function FusionPillEntry({ client, sessionId = '', store }) {
  const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const provider = state.current?.provider ?? null;
  const modelId = state.current?.model ?? '';
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  const fusionActive = modelId === 'fusion';
  const [data, setData] = react.useState(null);
  const [open, setOpen] = react.useState(false);
  const [draft, setDraft] = react.useState({});
  const [busy, setBusy] = react.useState(false);
  const [saveError, setSaveError] = react.useState('');
  const wrapRef = react.useRef(null);
  const triggerRef = react.useRef(null);
  const popRef = react.useRef(null);
  const aliveRef = react.useRef(true);
  react.useEffect(() => () => { aliveRef.current = false; }, []);

  const toPillData = (snap, forSessionId = sid) => ({
    sessionId: forSessionId,
    config: snap.fusion?.config ?? {},
    options: snap.fusion?.options ?? { leads: [], sidekicks: [] },
    fastMode: Boolean(snap.fastMode),
    fastModels: snap.fastModels ?? {},
    accountId: snap.activeAccountId,
    revision: snap.revision
  });

  const load = react.useCallback(async () => {
    try {
      const req = sid ? { op: 'read', sessionId: sid } : { op: 'read' };
      const snap = await client.invoke(req);
      if (!aliveRef.current) return;
      setData(toPillData(snap, sid));
    } catch {}
  }, [client, sid]);

  react.useEffect(() => {
    if (provider !== 'devin') return undefined;
    void load();
    if (typeof document === 'undefined') return undefined;
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [provider, load]);

  react.useEffect(() => {
    if (provider !== 'devin' || !fusionActive) setOpen(false);
  }, [provider, fusionActive, sid]);

  react.useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const pop = popRef.current;
    const reposition = () => {
      if (!pop?.getBoundingClientRect || typeof window === 'undefined') return;
      const isGoPanel = document.documentElement?.hasAttribute('data-dsh-go-island')
        && document.documentElement.getAttribute('data-dsh-go-island-form') === 'panel';
      if (isGoPanel) return;
      pop.style.transform = '';
      pop.style.top = '';
      pop.style.bottom = '';
      pop.style.maxHeight = '';
      const vw = document.documentElement?.clientWidth || window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      if (triggerRef.current?.getBoundingClientRect && vh > 0) {
        const anchor = triggerRef.current.getBoundingClientRect();
        const rectY = pop.getBoundingClientRect();
        const above = anchor.top - 20;
        const below = vh - anchor.bottom - 20;
        if (rectY.top < 12 && below > above) {
          pop.style.top = 'calc(100% + 6px)';
          pop.style.bottom = 'auto';
          pop.style.maxHeight = `${Math.max(80, below)}px`;
        } else if (above > 0) {
          pop.style.maxHeight = `${Math.max(80, above)}px`;
        }
      }
      if (vw > 0) {
        const rectX = pop.getBoundingClientRect();
        let dx = 0;
        if (rectX.right > vw - 12) dx = (vw - 12) - rectX.right;
        else if (rectX.left < 12) dx = Math.min(12 - rectX.left, (vw - 12) - rectX.right);
        if (dx) pop.style.transform = `translate3d(${Math.round(dx)}px, 0, 0)`;
      }
    };
    reposition();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', reposition);
      window.addEventListener('scroll', reposition, true);
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus?.();
      }
    };
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
      }
      if (pop?.style) {
        pop.style.transform = '';
        pop.style.top = '';
        pop.style.bottom = '';
        pop.style.maxHeight = '';
      }
    };
  }, [open]);

  if (provider !== 'devin') return null;
  const cfg = data?.config ?? {};
  const options = data?.options ?? { leads: [], sidekicks: [] };
  const role = fusionRoleState(options, draft, setDraft);
  const fastModels = data?.fastModels ?? {};
  const fastInfo = fastModels[modelId] ?? fastModels[String(modelId).replace(/-(?=\d)/g, '.')] ?? null;
  if (!fastInfo && !fusionActive) return null;
  const fastOn = data?.sessionId === sid ? Boolean(data?.fastMode) : false;
  const canToggleFast = Boolean(!busy && data?.accountId && sid);
  const leadName = fusionOptionName(options.leads, cfg.lead);
  const sidekickName = fusionOptionName(options.sidekicks, cfg.sidekick);
  const pairLabel = cfg.lead || cfg.sidekick ? `${leadName} + ${sidekickName}` : '选择搭配';
  const cleanConfig = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== '' && v != null));
  const dirty = JSON.stringify(cleanConfig(draft)) !== JSON.stringify(cleanConfig(cfg));

  const toggle = () => { if (!open) { setDraft({ ...cfg }); setSaveError(''); void load(); } setOpen((p) => !p); };
  const sel = (label, value, opts, onChange) => h('label', { className: 'ddp-pop-field' },
    h('span', { className: 'ddp-pop-field-label' }, label),
    h('select', { className: 'ddp-pop-select', value: value ?? '', disabled: busy || !opts.length, onChange: (e) => onChange(e.target.value) },
      h('option', { value: '' }, opts.length ? '—' : '无须档位'),
      opts.map((o) => h('option', { key: o.id, value: o.id }, o.name))));
  const save = async () => {
    if (!data?.accountId) return;
    setBusy(true);
    setSaveError('');
    try {
      await client.invoke({ op: 'saveFusion', accountId: data.accountId, revision: data.revision, config: cleanConfig(draft) });
      setOpen(false);
      await load();
    } catch (error) {
      setSaveError(describeError(error));
      await load();
    } finally { if (aliveRef.current) setBusy(false); }
  };
  const toggleFast = async () => {
    if (!canToggleFast) return;
    const next = !fastOn;
    setBusy(true);
    setSaveError('');
    setData((prev) => (prev ? { ...prev, sessionId: sid, fastMode: next } : prev));
    try {
      const snap = await client.invoke({ op: 'setFastMode', sessionId: sid, accountId: data.accountId, enabled: next });
      if (!aliveRef.current) return;
      setData(toPillData(snap, sid));
    } catch (error) {
      setSaveError(describeError(error));
      await load();
    } finally { if (aliveRef.current) setBusy(false); }
  };

  const pillTip = `${leadName}${cfg.leadEffort ? ` (${cfg.leadEffort})` : ''} + ${sidekickName}${cfg.sidekickEffort ? ` (${cfg.sidekickEffort})` : ''} · 点击调整搭配`;
  const footText = !data?.accountId
    ? '请先在设置中选择账号'
    : dirty
      ? '有未保存的搭配改动'
      : '当前对话已使用 Fusion';

  return h('span', { ref: wrapRef, className: 'ddp-fusion-wrap' },
    fastInfo
      ? h('button', {
        type: 'button',
        className: 'ddp-fast-btn',
        'aria-pressed': fastOn,
        disabled: !canToggleFast,
        title: !sid
          ? '请先进入具体会话再切换快速模式'
          : fastOn
            ? `本会话已开启快速模式（映射到 ${fastInfo.label} 模型）· 点击关闭`
            : `为本会话开启快速模式（按所选思考深度映射到 ${fastInfo.label} 模型）`,
        'aria-label': fastOn ? `关闭本会话快速模式（${fastInfo.label}）` : `开启本会话快速模式（${fastInfo.label}）`,
        onClick: () => void toggleFast()
      }, h('span', { className: 'ddp-fast-icon', 'aria-hidden': 'true' }, '⚡'))
      : null,
    fusionActive
      ? h('button', {
        ref: triggerRef,
        type: 'button',
        className: 'ddp-fusion-trigger',
        'data-active': 'true',
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        title: pillTip,
        'aria-label': pillTip,
        onClick: toggle
      },
        h('span', { className: 'ddp-fusion-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'ddp-fusion-label' }, pairLabel))
      : null,
    fusionActive && open ? h('div', { ref: popRef, className: 'ddp-fusion-popover', role: 'dialog', 'aria-label': 'Fusion 搭配设置' },
      h('div', { className: 'ddp-pop-head' },
        h('strong', { className: 'ddp-pop-title' }, 'Devin · Fusion'),
        h('span', { className: 'ddp-pop-badge', 'data-tone': 'accent' }, '当前激活'),
        h('button', {
          type: 'button',
          className: 'ddp-pop-close',
          'aria-label': '关闭 Fusion 设置',
          onClick: () => { setOpen(false); triggerRef.current?.focus?.(); }
        }, '×')),
      h('section', { className: 'ddp-pop-card', 'aria-label': 'Lead 主模型' },
        h('div', { className: 'ddp-pop-card-head' },
          h('span', { className: 'ddp-pop-card-title' }, 'Lead 主模型'),
          h('span', { className: 'ddp-pop-card-hint' }, role.leadObj?.fast ? '支持 ⚡ Fast' : '规划与审查')),
        h('div', { className: 'ddp-pop-grid' },
          sel('模型', draft.lead, role.leads, role.setLead),
          sel('档位', draft.leadEffort, role.leadEfforts, role.setLeadEffort))),
      h('section', { className: 'ddp-pop-card', 'aria-label': 'Sidekick 副模型' },
        h('div', { className: 'ddp-pop-card-head' },
          h('span', { className: 'ddp-pop-card-title' }, 'Sidekick 副模型'),
          h('span', { className: 'ddp-pop-card-hint' }, role.sidekickEfforts.length ? '机械实现' : '固定单档')),
        h('div', { className: 'ddp-pop-grid' },
          sel('模型', draft.sidekick, role.sidekicks, role.setSidekick),
          sel('档位', draft.sidekickEffort, role.sidekickEfforts, role.setSidekickEffort))),
      saveError ? h('p', { role: 'alert', className: 'ddp-pop-error' }, saveError) : null,
      h('div', { className: 'ddp-pop-foot' },
        h('span', { className: 'ddp-pop-meta' }, footText),
        h('div', { className: 'ddp-pop-actions' },
          h('button', { type: 'button', className: 'ddp-pop-btn', disabled: busy, onClick: () => setOpen(false) }, '关闭'),
          h('button', { type: 'button', className: 'ddp-pop-btn ddp-pop-btn-primary', disabled: busy || !data?.accountId, onClick: () => void save() }, busy ? '保存中…' : '保存搭配')))) : null);
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

  // Fusion 即时切换药丸：注入聊天输入区右侧（参考 subusage），devin 路由激活时显示。
  try {
    ctx.inject(['modelDirectories'], (scope) => {
      try {
        scope.slots.inject('conversation.input.right', () => scope.slots.register({
          name: 'conversation.input.right',
          id: 'devin-fusion',
          order: 1002,
          inject: (sessionId) => ({ client, sessionId, store: scope.modelDirectories.directoryFor(sessionId).store })
        }, FusionPillEntry));
      } catch (error) {
        console.error('[dsh-devin-provider] Fusion 药丸注册失败:', error);
      }
    });
  } catch {}

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
