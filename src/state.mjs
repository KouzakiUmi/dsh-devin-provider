import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const STATE_VERSION = 1;
export const ROUTE_ID = 'devin';
export const ROUTE_DISPLAY_NAME = 'Devin Provider';
export const AUTH_MODES = ['oauth', 'cli', 'api-key', 'reference'];
export const CORE_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL_SETTING_FIELDS = [
  'enabled',
  'contextWindow',
  'maxTokens',
  'temperature',
  'reasoningEfforts',
  'defaultReasoning',
  'imageInput',
  'toolsEnabled'
];
export const MODEL_SETTING_BOOLEAN_FIELDS = ['imageInput', 'toolsEnabled'];

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const refPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/\s-]{0,199}$/;
const reservedNames = ['constructor', 'prototype', '__proto__'];

function setKey(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return target;
}

export function assertAccountId(id) {
  if (typeof id !== 'string' || !idPattern.test(id) || reservedNames.includes(id)) {
    throw new Error('账号 ID 须为小写字母开头，仅含小写字母、数字或连字符，且不能使用保留名称');
  }
  return id;
}

export function assertModelId(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim() || !modelIdPattern.test(modelId) || reservedNames.includes(modelId)) {
    throw new Error('模型 ID 不合法');
  }
  return modelId;
}

export function normalizeServerUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error('自定义服务地址格式错误');
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('自定义服务地址不是有效的 URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('自定义服务地址只接受干净的 http(s) 原点 URL');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function normalizeIdentity(value) {
  const identity = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return identity;
  for (const key of ['email', 'name', 'plan', 'orgId', 'teamId']) {
    const text = value[key];
    if (typeof text === 'string' && text.trim() && text.length <= 200 && !/[\x00-\x1f\x7f]/.test(text)) {
      identity[key] = text.trim();
    }
  }
  return identity;
}

export function account(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('账号格式错误');
  const allowed = ['id', 'label', 'authMode', 'apiKeyRef', 'server', 'identity', 'loggedAt', 'credentialStored', 'identityVerified'];
  if (Object.keys(input).some((k) => !allowed.includes(k))) {
    throw new Error('账号数据包含不支持的字段或明文凭据');
  }
  assertAccountId(input.id);
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80) {
    throw new Error('账号名称不合法');
  }
  const authMode = input.authMode ?? 'reference';
  if (!AUTH_MODES.includes(authMode)) throw new Error('不支持的鉴权模式');
  let apiKeyRef = '';
  if (input.apiKeyRef !== undefined && input.apiKeyRef !== '') {
    if (typeof input.apiKeyRef !== 'string' || !refPattern.test(input.apiKeyRef)) {
      throw new Error('凭据引用名不合法（仅允许字母、数字和下划线，且以字母或下划线开头）');
    }
    apiKeyRef = input.apiKeyRef;
  }
  const server = normalizeServerUrl(input.server);
  const identity = normalizeIdentity(input.identity);
  const loggedAt = typeof input.loggedAt === 'string' ? input.loggedAt : '';
  const credentialStored = input.credentialStored === true;
  return {
    id: input.id,
    label: input.label.trim(),
    authMode,
    ...(apiKeyRef ? { apiKeyRef } : {}),
    ...(server ? { server } : {}),
    ...(Object.keys(identity).length ? { identity } : {}),
    ...(loggedAt ? { loggedAt } : {}),
    ...(credentialStored ? { credentialStored: true } : {}),
    ...(typeof input.identityVerified === 'boolean' ? { identityVerified: input.identityVerified } : {})
  };
}

export function normalizeReasoningEfforts(value) {
  if (value === false) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('思考档位格式错误');
  const efforts = {};
  for (const [level, wire] of Object.entries(value)) {
    if (!CORE_THINKING_LEVELS.includes(level)) throw new Error(`思考档位 ${level} 不受支持`);
    if (wire === null) {
      if (level !== 'off') throw new Error('思考档位中只有 off 允许为空值');
      setKey(efforts, level, null);
      continue;
    }
    if (typeof wire !== 'string' || !wire.trim()) throw new Error('思考档位映射必须是非空字符串');
    setKey(efforts, level, wire.trim());
  }
  const levels = Object.keys(efforts);
  if (!levels.length) throw new Error('思考档位不能为空');
  if (!levels.some((level) => level !== 'off')) throw new Error('至少需要声明一个非 off 的思考档位');
  return efforts;
}

export function normalizeModelSettings(input) {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模型设置格式错误');
  for (const key of Object.keys(input)) {
    if (!MODEL_SETTING_FIELDS.includes(key)) throw new Error(`模型设置包含未知字段：${key}`);
  }
  const settings = {};
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new Error('模型启用状态必须是布尔值');
    settings.enabled = input.enabled;
  }
  for (const key of ['contextWindow', 'maxTokens']) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} 必须是正安全整数`);
    }
    settings[key] = value;
  }
  if ('temperature' in input) {
    const value = input.temperature;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('temperature 必须是 0 到 1 之间的数值');
    }
    settings.temperature = value;
  }
  for (const key of MODEL_SETTING_BOOLEAN_FIELDS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    settings[key] = input[key];
  }
  if ('reasoningEfforts' in input) settings.reasoningEfforts = normalizeReasoningEfforts(input.reasoningEfforts);
  if ('defaultReasoning' in input) {
    const value = input.defaultReasoning;
    if (value !== null) {
      if (typeof value !== 'string' || !CORE_THINKING_LEVELS.includes(value)) throw new Error('默认思考档位不受支持');
      if (settings.reasoningEfforts === false) throw new Error('该模型没有可选思考档位，不能指定默认思考档位');
      if (settings.reasoningEfforts !== undefined && !(value in settings.reasoningEfforts)) {
        throw new Error('默认思考档位未被思考档位映射支持');
      }
    }
    settings.defaultReasoning = value;
  }
  if (settings.contextWindow !== undefined && settings.maxTokens !== undefined && settings.maxTokens > settings.contextWindow) {
    throw new Error('maxTokens 不得超过 contextWindow');
  }
  return settings;
}

export function normalizeKeepaliveSettings(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : false;
  const intervalRaw = src.intervalSec ?? 285;
  const maxRaw = src.maxPings ?? 6;
  const intervalSec = Number(intervalRaw);
  const maxPings = Number(maxRaw);
  if (!Number.isSafeInteger(intervalSec) || intervalSec < 30 || intervalSec > 299) {
    throw new Error('保活间隔须为 30 到 299 之间的整数（秒）');
  }
  if (!Number.isSafeInteger(maxPings) || maxPings < 1 || maxPings > 50) {
    throw new Error('最大保活次数须为 1 到 50 之间的整数');
  }
  return { enabled, intervalSec, maxPings };
}

function normalizeModelSettingsMap(value, accounts) {
  const result = {};
  if (value === undefined || value === null) return result;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('模型设置格式错误');
  for (const [accountId, bucket] of Object.entries(value)) {
    if (!accounts.some((a) => a.id === accountId)) continue;
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error('模型设置格式错误');
    const models = {};
    for (const [modelId, settings] of Object.entries(bucket)) {
      assertModelId(modelId);
      const normalized = normalizeModelSettings(settings);
      if (!Object.keys(normalized).length) continue;
      setKey(models, modelId, normalized);
    }
    if (Object.keys(models).length) setKey(result, accountId, models);
  }
  return result;
}

export function initialState() {
  return {
    version: STATE_VERSION,
    accounts: [],
    activeAccountId: null,
    enabled: true,
    settings: {
      cacheKeepalive: { enabled: false, intervalSec: 285, maxPings: 6 },
      serverUrl: ''
    },
    catalogs: {},
    modelSettings: {}
  };
}

export function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账号状态格式不兼容');
  if (value.version !== STATE_VERSION) throw new Error('账号状态格式不兼容');
  if (!Array.isArray(value.accounts) || value.accounts.length > 50) throw new Error('账号状态格式不兼容');
  const accounts = value.accounts.map(account);
  if (new Set(accounts.map((a) => a.id)).size !== accounts.length) throw new Error('账号 ID 重复');
  const activeAccountId = value.activeAccountId ?? null;
  if (activeAccountId !== null && !accounts.some((a) => a.id === activeAccountId)) {
    throw new Error('所选账号不存在');
  }
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== 'boolean') throw new Error('Provider 启用状态必须是布尔值');
  const rawSettings = value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings) ? value.settings : {};
  const settings = {
    cacheKeepalive: normalizeKeepaliveSettings(rawSettings.cacheKeepalive),
    serverUrl: normalizeServerUrl(rawSettings.serverUrl)
  };
  const catalogs = {};
  if (value.catalogs && typeof value.catalogs === 'object' && !Array.isArray(value.catalogs)) {
    for (const [accountId, catalog] of Object.entries(value.catalogs)) {
      if (!accounts.some((a) => a.id === accountId)) continue;
      if (catalog && typeof catalog === 'object' && !Array.isArray(catalog)) {
        setKey(catalogs, accountId, catalog);
      }
    }
  }
  const modelSettings = normalizeModelSettingsMap(value.modelSettings, accounts);
  return { version: STATE_VERSION, accounts, activeAccountId, enabled, settings, catalogs, modelSettings };
}

export const revision = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class StateStore {
  constructor(path) {
    this.path = path;
    this.current = null;
    this.diskRevision = null;
    this.queue = Promise.resolve();
  }
  async load() {
    try {
      this.current = validateState(JSON.parse(await readFile(this.path, 'utf8')));
      this.diskRevision = revision(this.current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取 Devin 账号状态；原文件未被覆盖');
      this.current = initialState();
      this.diskRevision = null;
    }
    return this.current;
  }
  refresh() {
    const operation = this.queue.then(async () => {
      let disk = null;
      try {
        disk = validateState(JSON.parse(await readFile(this.path, 'utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('无法读取 Devin 账号状态；原文件未被覆盖');
      }
      const diskRevision = disk ? revision(disk) : null;
      if (diskRevision === this.diskRevision) return false;
      this.current = disk ?? initialState();
      this.diskRevision = diskRevision;
      return true;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  mutate(expectedRevision, change, { signal } = {}) {
    const operation = this.queue.then(async () => {
      signal?.throwIfAborted();
      if (expectedRevision !== revision(this.current)) throw new Error('设置已改变，请刷新后重试');
      const next = validateState(change(structuredClone(this.current)));
      await mkdir(dirname(this.path), { recursive: true });
      signal?.throwIfAborted();
      const lockPath = `${this.path}.lock`;
      let lock;
      try {
        lock = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new Error('其他实例正在写入账号设置，请稍后刷新重试；若进程异常退出，请确认无写入进程后清理状态文件旁的 .lock 文件');
        }
        throw error;
      }
      const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        signal?.throwIfAborted();
        let disk = null;
        try {
          disk = validateState(JSON.parse(await readFile(this.path, 'utf8')));
        } catch (error) {
          if (error.code !== 'ENOENT') throw new Error('无法读取 Devin 账号状态；原文件未被覆盖');
        }
        if ((disk ? revision(disk) : null) !== this.diskRevision) {
          throw new Error('设置已改变，请刷新后重试');
        }
        await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, signal });
        signal?.throwIfAborted();
        await rename(temp, this.path);
        this.diskRevision = revision(next);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      } finally {
        await lock.close();
        await rm(lockPath, { force: true });
      }
      this.current = next;
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
