import { CLI_VERSION, DEFAULT_SERVER, USER_STATUS_RPC, failure, osName } from './pb.mjs';

export const SIGNED_OUT_MESSAGE = 'Devin 登录已失效，请重新登录';

export function userStatus(key, server = DEFAULT_SERVER, { fetchImpl = fetch, signal } = {}) {
  return fetchImpl(server + USER_STATUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({
      metadata: {
        ideName: 'devin-cli',
        ideVersion: CLI_VERSION,
        extensionName: 'devin-cli',
        extensionVersion: CLI_VERSION,
        apiKey: key,
        locale: 'en',
        os: osName()
      }
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  });
}

export const tierName = (t) =>
  String(t ?? '')
    .replace(/^TEAMS_TIER_/, '')
    .split('_')
    .filter((w) => w && w !== 'UNSPECIFIED' && !/^V\d+$/.test(w))
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(' ');

export function whoOfStatus(u = {}) {
  const base = String(u.email || u.name || '').trim();
  if (!base) return undefined;
  const info = u.planStatus?.planInfo ?? {};
  const devin = info.devinInfo ?? {};
  const org = String(devin.accountDisplayName || info.teamName || u.teamName || '').trim();
  const orgId = String(devin.orgId || u.teamId || '').trim();
  const teamId = String(u.teamId || '').trim();
  const named = org && org.toLowerCase() !== base.toLowerCase();
  const display = named ? `${base} · ${org}` : base;
  return {
    email: display,
    name: display,
    plan: tierName(u.teamsTier || info.teamsTier) || info.planName || '',
    ...(orgId ? { orgId } : {}),
    ...(teamId ? { teamId } : {})
  };
}

export async function whoByKey(key, server = DEFAULT_SERVER, opts = {}) {
  let res;
  let text;
  try {
    res = await userStatus(key, server, opts);
    text = await res.text();
  } catch {
    return undefined;
  }
  if (res.status === 401 || failure(res.status, text).status === 401) return null;
  if (!res.ok) return undefined;
  let u;
  try {
    u = JSON.parse(text || '{}')?.userStatus ?? {};
  } catch {
    return undefined;
  }
  return whoOfStatus(u);
}

function isoFromEpoch(value) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  // GetUserStatus returns Unix seconds for daily/weekly resets; guard ms vs s.
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

export function parseUsageResponse(u = {}, { freeIds = [], configError = '' } = {}) {
  const st = u.planStatus ?? {};
  const info = st.planInfo ?? {};
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && !isNaN(Number(v)) ? Number(v) : 0);
  const windows = [];
  const planEnd = isoFromEpoch(st.planEnd);
  const quotaStrategy = info.billingStrategy === 'BILLING_STRATEGY_QUOTA';

  for (const [kind, label, left, reset, hide] of [
    ['1d', '每日额度（24 小时）', st.dailyQuotaRemainingPercent, st.dailyQuotaResetAtUnix, info.hideDailyQuota],
    ['7d', '每周额度（7 天）', st.weeklyQuotaRemainingPercent, st.weeklyQuotaResetAtUnix, info.hideWeeklyQuota]
  ]) {
    const at = num(reset);
    if (hide || ((left === undefined || left === null) && !(quotaStrategy && at > 0))) continue;
    const remainingPercent = Math.min(100, Math.max(0, num(left)));
    const usedPercent = Math.min(100, Math.max(0, 100 - remainingPercent));
    windows.push({
      kind,
      label,
      usedPercent,
      remainingPercent,
      ...(at > 0 ? { resetsAt: isoFromEpoch(at) } : {}),
      ...(freeIds.length ? { notModels: freeIds } : {})
    });
  }

  const limit = num(st.acuLimit);
  if (limit > 0) {
    const used = num(st.acuConsumed);
    const usedPercent = Math.min(100, (100 * used) / limit);
    windows.push({
      kind: 'acu',
      label: '周期 ACU 用量',
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      detail: { used: +used.toFixed(2), limit: +limit.toFixed(2), unit: 'ACUs' },
      ...(planEnd ? { resetsAt: planEnd } : {})
    });
  }

  const extra = num(st.overageBalanceMicros);
  const overageBalance = extra > 0 ? '$' + (extra / 1e6).toFixed(2) : undefined;
  const who = whoOfStatus(u);

  return {
    windows,
    ...(planEnd ? { planEnd } : {}),
    ...(overageBalance ? { overageBalance } : {}),
    ...(who ? { identity: who } : {}),
    ...(freeIds.length ? { freeModels: freeIds } : {}),
    ...(configError ? { freeModelsNote: `免费模型清单暂未获取（${configError}）` } : {})
  };
}

export async function fetchUsage(key, server = DEFAULT_SERVER, opts = {}) {
  const res = await userStatus(key, server, opts);
  const text = await res.text();
  if (res.status === 401 || failure(res.status, text).status === 401) {
    return { expired: true, error: SIGNED_OUT_MESSAGE, windows: [] };
  }
  if (!res.ok) {
    return { error: failure(res.status, text).message, windows: [] };
  }
  let u = {};
  try {
    u = JSON.parse(text || '{}')?.userStatus ?? {};
  } catch {
    return { error: 'Devin 接口返回了无法解析的 JSON', windows: [] };
  }
  return parseUsageResponse(u, opts);
}
