import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_SERVER } from './pb.mjs';
import {
  ROUTE_ID,
  StateStore,
  account,
  assertAccountId,
  assertModelId,
  normalizeIdentity,
  normalizeKeepaliveSettings,
  normalizeModelSettings,
  normalizeServerUrl,
  revision
} from './state.mjs';
import {
  SNAPSHOT_FAMILIES,
  catalogStatus,
  effectiveModel,
  fetchCliModelConfigs,
  getModelRows
} from './catalog.mjs';
import { cliIdentity, cliModels, cliPath, homeFor, readCliCredentials } from './cli.mjs';
import { DevinOAuth } from './oauth.mjs';
import { fetchUsage, whoByKey } from './quota.mjs';
import { stopAllKeepalive } from './keepalive.mjs';

function safeServer(value) {
  try { return normalizeServerUrl(value); } catch { return ''; }
}

function modelRow(state, accountId, modelId) {
  const row = getModelRows(state, accountId).find((item) => item.id === modelId);
  if (!row) throw new Error('模型不在当前目录中，请先刷新模型目录');
  return row;
}

const unknownAccountName = (key, server) =>
  `Devin · ${createHash('sha256').update(server || DEFAULT_SERVER).update('\0').update(key).digest('hex').slice(0, 12)}`;

export class DevinController {
  constructor({
    statePath,
    devinCliPath = '',
    resolveRef = async () => undefined,
    readGrant,
    writeGrant,
    deleteGrant,
    fetchImpl = fetch,
    cliCredentialsReader = readCliCredentials,
    cliIdentityReader = cliIdentity,
    cliModelsReader = cliModels
  }) {
    this.store = new StateStore(statePath);
    this.devinCliPath = devinCliPath;
    this.resolveRef = resolveRef;
    this.fetchImpl = fetchImpl;
    this.cliCredentialsReader = cliCredentialsReader;
    this.cliIdentityReader = cliIdentityReader;
    this.cliModelsReader = cliModelsReader;
    this.life = new AbortController();
    this.disposed = false;

    const credDir = join(dirname(statePath), 'credentials');
    this.readGrant =
      readGrant ??
      (async (accountId) => {
        try {
          return JSON.parse(await readFile(join(credDir, `${accountId}.json`), 'utf8'));
        } catch {
          return undefined;
        }
      });
    this.writeGrant =
      writeGrant ??
      (async (accountId, payload) => {
        await mkdir(credDir, { recursive: true, mode: 0o700 });
        await writeFile(join(credDir, `${accountId}.json`), JSON.stringify(payload), { mode: 0o600 });
      });
    this.deleteGrant =
      deleteGrant ??
      (async (accountId) => {
        await rm(join(credDir, `${accountId}.json`), { force: true }).catch(() => {});
      });

    this.quotaCache = new Map();
    this.quotaInflight = new Map();
    this.cacheGeneration = 0;
    this.oauth = new DevinOAuth({
      fetchImpl,
      onSuccess: (payload) => this.bindOAuthLogin(payload)
    });
    this.onChange = async () => {};
    this.operations = Promise.resolve();
    this.appliedAccount = undefined;
    this.routingError = undefined;
  }

  owner(id) {
    if (typeof id !== 'string' || !id) throw new Error('请选择账号');
    const found = this.store.current.accounts.find((a) => a.id === id);
    if (!found) throw new Error('账号不存在');
    return found;
  }

  clearCaches() {
    this.cacheGeneration++;
    this.quotaCache.clear();
    this.quotaInflight.clear();
  }

  serverFor(owner) {
    const envUrl = (process.env.WINDSURF_API_SERVER_URL || '').trim();
    const raw = envUrl || owner?.server || this.store.current?.settings?.serverUrl || DEFAULT_SERVER;
    return raw.replace(/\/+$/, '');
  }

  async resolveCredential(owner) {
    if (!owner) return undefined;
    if (this.disposed) throw new Error('插件已卸载');
    if (owner.authMode === 'cli') {
      const cliCred = await this.cliCredentialsReader().catch(() => null);
      if (cliCred?.key) {
        return { key: cliCred.key, server: this.serverFor({ server: cliCred.server }) };
      }
      // Fall back to stored grant if CLI file is temporarily absent
      const grant = await this.readGrant(owner.id).catch(() => undefined);
      if (grant?.key) return { key: grant.key, server: this.serverFor({ server: safeServer(grant.server || owner.server) }) };
      return undefined;
    }
    if (owner.authMode === 'reference') {
      const value = owner.apiKeyRef ? await this.resolveRef(owner.apiKeyRef) : undefined;
      if (!value) return undefined;
      return { key: value, server: this.serverFor(owner) };
    }
    const grant = await this.readGrant(owner.id).catch(() => undefined);
    if (grant?.key) {
      return { key: grant.key, server: this.serverFor({ server: safeServer(grant.server || owner.server) }) };
    }
    return undefined;
  }

  async resolveIdentity(key, server) {
    let who = await whoByKey(key, server, { fetchImpl: this.fetchImpl, signal: this.life.signal });
    if (who === undefined && cliPath(this.devinCliPath)) {
      try {
        const home = await homeFor(key, server, join(dirname(this.store.path), 'cli-cache'));
        const st = await this.cliIdentityReader(home, { executable: this.devinCliPath, signal: this.life.signal });
        if (st === null) who = null;
        else if (st?.user) who = { email: st.user, name: st.user, plan: st.plan || '', ...(st.teamId ? { teamId: st.teamId } : {}) };
      } catch {}
    }
    if (who === null) throw new Error('Devin 拒绝了该凭据：未处于已登录状态');
    if (who) return normalizeIdentity(who);
    const fallback = unknownAccountName(key, server);
    return { email: fallback, name: fallback };
  }

  async bindOAuthLogin({ accountId, key, server, signal }) {
    if (signal?.aborted || this.disposed) throw new Error('登录已取消');
    const owner = this.owner(accountId);
    const identity = await this.resolveIdentity(key, server);
    if (signal?.aborted || this.disposed) throw new Error('登录已取消');
    await this.writeGrant(accountId, { key, server, updatedAt: new Date().toISOString() });
    let catalog;
    try {
      catalog = await fetchCliModelConfigs(key, server, this.fetchImpl, signal);
    } catch {}
    await this.store.mutate(revision(this.store.current), (next) => {
      const idx = next.accounts.findIndex((a) => a.id === accountId);
      if (idx < 0) throw new Error('账号不存在');
      next.accounts[idx] = account({
        ...next.accounts[idx],
        authMode: 'oauth',
        label: identity.email || owner.label,
        identity,
        loggedAt: new Date().toISOString(),
        credentialStored: true
      });
      if (!next.activeAccountId) next.activeAccountId = accountId;
      if (catalog) next.catalogs[accountId] = catalog;
      else delete next.catalogs[accountId];
      return next;
    }, { signal });
    this.clearCaches();
    try {
      await this.onChange();
    } catch {
      this.routingError ??= '登录身份已保存，但模型路由更新失败；此前可用路由仍保留。';
    }
  }

  async read() {
    const state = this.store.current;
    if (!state) throw new Error(this.routingError || '无法读取 Devin 账号元数据；原文件未覆盖');

    const accounts = await Promise.all(
      state.accounts.map(async (owner) => {
        let hasCredential = false;
        let credentialError = '';
        try {
          const cred = await this.resolveCredential(owner);
          hasCredential = Boolean(cred?.key);
        } catch {
          credentialError = '凭据读取失败；可检查凭据配置或重新登录。';
        }
        const displayName = owner.identity?.email || owner.identity?.name || owner.label || owner.id;
        return {
          ...owner,
          displayName,
          hasCredential,
          ...(credentialError ? { credentialError } : {})
        };
      })
    );

    return {
      revision: revision(state),
      route: ROUTE_ID,
      enabled: state.enabled !== false,
      activeAccountId: state.activeAccountId ?? null,
      accounts,
      settings: structuredClone(state.settings),
      ...(this.routingError ? { routingError: this.routingError } : {}),
      ...(this.appliedAccount !== undefined ? { appliedAccount: structuredClone(this.appliedAccount) } : {}),
      catalogs: state.accounts.map((a) => {
        const status = catalogStatus(state, a.id);
        const models = getModelRows(state, a.id);
        return {
          accountId: a.id,
          count: status.broken ? 0 : models.length,
          enabledCount: models.filter((m) => m.enabled).length,
          source: status.source,
          ...(status.broken ? { error: '模型缓存损坏，请重新拉取模型' } : {}),
          ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
          models
        };
      }),
      login: this.oauth.status()
    };
  }

  async quota(accountId, force = false) {
    const owner = this.owner(accountId);
    const key = `${accountId}:${revision(owner)}`;
    if (force) this.quotaCache.delete(key);
    const cached = this.quotaCache.get(key);
    if (!force && cached && Date.now() - cached.at < 60_000) return structuredClone(cached.value);
    if (this.quotaInflight.has(key)) return this.quotaInflight.get(key);

    const generation = this.cacheGeneration;
    const task = (async () => {
      await Promise.resolve();
      const base = { accountId, updatedAt: new Date().toISOString() };
      try {
        const cred = await this.resolveCredential(owner);
        if (!cred?.key) {
          return { ...base, state: 'no-key', windows: [], error: '该账号尚未配置可用凭据，请先登录或填写 API Key。' };
        }
        let freeIds = [];
        let configError = '';
        try {
          const cfgs = await fetchCliModelConfigs(cred.key, cred.server, this.fetchImpl, this.life.signal);
          freeIds = cfgs.freeIds ?? [];
        } catch (err) {
          configError = err instanceof Error ? err.message : String(err);
        }
        const usage = await fetchUsage(cred.key, cred.server, {
          fetchImpl: this.fetchImpl,
          signal: this.life.signal,
          freeIds,
          configError
        });
        if (usage.expired) {
          return { ...base, state: 'expired', windows: [], error: usage.error };
        }
        if (usage.error) {
          return { ...base, state: 'error', windows: [], error: usage.error };
        }
        if (usage.identity && !this.disposed) {
          // Silently refresh cached non-secret identity metadata if changed
          const nextId = normalizeIdentity(usage.identity);
          if (JSON.stringify(nextId) !== JSON.stringify(owner.identity ?? {})) {
            await this.store
              .mutate(revision(this.store.current), (next) => {
                const idx = next.accounts.findIndex((a) => a.id === accountId);
                if (idx >= 0) next.accounts[idx] = account({ ...next.accounts[idx], identity: nextId });
                return next;
              })
              .catch(() => {});
          }
        }
        const value = { ...base, state: 'ok', ...usage };
        if (!this.disposed && generation === this.cacheGeneration) {
          this.quotaCache.set(key, { at: Date.now(), value });
        }
        return structuredClone(value);
      } catch (err) {
        return {
          ...base,
          state: 'error',
          windows: [],
          error: `额度读取失败：${err instanceof Error ? err.message : String(err)}`
        };
      } finally {
        if (this.quotaInflight.get(key) === task) this.quotaInflight.delete(key);
      }
    })();

    this.quotaInflight.set(key, task);
    return task;
  }

  async invoke(request) {
    if (this.disposed) throw new Error('插件已卸载');
    if (!request || typeof request !== 'object') throw new Error('请求格式错误');
    const { op } = request;
    if (op === 'read') {
      const read = this.operations.then(async () => {
        if (await this.store.refresh()) {
          this.clearCaches();
          try {
            await this.onChange();
          } catch {
            this.routingError ??= '模型路由更新失败；设置已同步，实际路由仍为此前账号。';
          }
        }
        return this.read();
      });
      this.operations = read.catch(() => {});
      return read;
    }
    if (op === 'loginStatus') return this.oauth.status();
    if (op === 'cancelLogin') return this.oauth.cancel(request.jobId);
    if (op === 'quota') return this.quota(request.accountId, request.force === true);

    const next = this.operations.then(() => this.change(request));
    this.operations = next.catch(() => {});
    return next;
  }

  async change(request) {
    if (request.revision !== revision(this.store.current)) throw new Error('设置已改变，请刷新后重试');
    if (this.disposed) throw new Error('插件已卸载');
    const { op, accountId } = request;

    if (op === 'startLogin') {
      const owner = this.owner(accountId);
      return this.oauth.start({
        accountId,
        revision: request.revision,
        server: this.serverFor(owner)
      });
    }

    if (op === 'importCli') {
      const cliCred = await this.cliCredentialsReader().catch((err) => {
        throw new Error(err?.code === 'ENOENT' ? '未找到本机 devin CLI 登录文件，请先运行 devin auth login' : err.message);
      });
      if (!cliCred?.key) throw new Error('本机 devin CLI credentials.toml 中没有 windsurf_api_key');
      const server = this.serverFor({ server: cliCred.server });
      const identity = await this.resolveIdentity(cliCred.key, server);
      let catalog;
      try {
        catalog = await fetchCliModelConfigs(cliCred.key, server, this.fetchImpl, this.life.signal);
      } catch {}
      const targetId = accountId || this.generateAccountId(this.store.current.accounts, 'devin-cli');
      await this.store.mutate(request.revision, (next) => {
        const entry = account({
          id: targetId,
          label: identity.email || 'Devin CLI',
          authMode: 'cli',
          server: cliCred.server !== DEFAULT_SERVER ? cliCred.server : '',
          identity,
          loggedAt: new Date().toISOString()
        });
        const idx = next.accounts.findIndex((a) => a.id === targetId);
        if (idx < 0) next.accounts.push(entry);
        else next.accounts[idx] = entry;
        if (!next.activeAccountId) next.activeAccountId = targetId;
        if (catalog) next.catalogs[targetId] = catalog;
        return next;
      });
      this.clearCaches();
      try {
        await this.onChange();
      } catch {
        this.routingError ??= '设置已保存，但模型路由更新失败；此前可用路由仍保留。';
      }
      return this.read();
    }

    if (op === 'saveAccount') {
      const input = request.account ?? {};
      assertAccountId(input.id);
      const plaintextKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';
      let identity = input.identity;
      const candidateServer = this.serverFor({ server: normalizeServerUrl(input.server) });
      if (input.authMode === 'api-key') {
        if (!plaintextKey) {
          const existing = await this.readGrant(input.id).catch(() => undefined);
          if (!existing?.key) throw new Error('请输入 Devin API Key（cog_…）或 Session Token');
        } else {
          identity = await this.resolveIdentity(plaintextKey, candidateServer);
          await this.writeGrant(input.id, { key: plaintextKey, server: candidateServer, updatedAt: new Date().toISOString() });
        }
      }
      await this.store.mutate(request.revision, (next) => {
        const entry = account({
          ...input,
          ...(identity ? { identity } : {}),
          ...(input.authMode === 'api-key' ? { credentialStored: true, loggedAt: new Date().toISOString() } : {})
        });
        const idx = next.accounts.findIndex((a) => a.id === entry.id);
        if (idx < 0) next.accounts.push(entry);
        else next.accounts[idx] = entry;
        if (!next.activeAccountId) next.activeAccountId = entry.id;
        return next;
      });
      this.clearCaches();
      try {
        await this.onChange();
      } catch {
        this.routingError ??= '设置已保存，但模型路由更新失败；此前可用路由仍保留。';
      }
      return this.read();
    }

    if (op === 'models') {
      const owner = this.owner(accountId);
      const cred = await this.resolveCredential(owner);
      if (!cred?.key) throw new Error('该账号未配置凭据，无法拉取实时模型列表（当前仍可使用本地快照）');
      let catalog;
      try {
        catalog = await fetchCliModelConfigs(cred.key, cred.server, this.fetchImpl, this.life.signal);
      } catch (err) {
        if (cliPath(this.devinCliPath)) {
          try {
            const home = await homeFor(cred.key, cred.server, join(dirname(this.store.path), 'cli-cache'));
            const families = await this.cliModelsReader(home, { executable: this.devinCliPath, signal: this.life.signal });
            catalog = {
              families,
              images: {},
              freeIds: [],
              prices: {},
              source: 'cli',
              updatedAt: new Date().toISOString()
            };
          } catch {
            throw err;
          }
        } else {
          throw err;
        }
      }
      await this.store.mutate(request.revision, (next) => {
        next.catalogs[accountId] = catalog;
        return next;
      });
      try {
        await this.onChange();
      } catch {
        this.routingError ??= '设置已保存，但模型路由更新失败；此前可用路由仍保留。';
      }
      return this.read();
    }

    await this.store.mutate(request.revision, (next) => {
      if (op === 'removeAccount') {
        this.owner(accountId);
        if (this.oauth.status().accountId === accountId && ['launching', 'waiting', 'verifying'].includes(this.oauth.status().state)) {
          throw new Error('请先取消该账号的登录');
        }
        next.accounts = next.accounts.filter((a) => a.id !== accountId);
        if (next.activeAccountId === accountId) {
          next.activeAccountId = next.accounts[0]?.id ?? null;
        }
        delete next.catalogs[accountId];
        delete next.modelSettings[accountId];
      } else if (op === 'selectAccount') {
        if (accountId !== null) this.owner(accountId);
        next.activeAccountId = accountId;
      } else if (op === 'setProviderEnabled') {
        if (typeof request.enabled !== 'boolean') throw new Error('Provider 启用状态必须是布尔值');
        next.enabled = request.enabled;
      } else if (op === 'saveSettings') {
        const s = request.settings ?? {};
        next.settings = {
          cacheKeepalive: normalizeKeepaliveSettings(s.cacheKeepalive),
          serverUrl: normalizeServerUrl(s.serverUrl)
        };
        if (!next.settings.cacheKeepalive.enabled) stopAllKeepalive();
      } else if (op === 'setModelEnabled') {
        this.owner(accountId);
        assertModelId(request.modelId);
        if (typeof request.enabled !== 'boolean') throw new Error('模型启用状态必须是布尔值');
        const row = modelRow(next, accountId, request.modelId);
        const bucket = { ...(next.modelSettings[accountId] ?? {}) };
        bucket[request.modelId] = { ...row.settings, enabled: request.enabled };
        next.modelSettings[accountId] = bucket;
      } else if (op === 'saveModelSettings') {
        this.owner(accountId);
        assertModelId(request.modelId);
        const settings = normalizeModelSettings(request.settings ?? {});
        const row = modelRow(next, accountId, request.modelId);
        const effective = effectiveModel(row.defaults, settings);
        if (effective.maxTokens > effective.contextWindow) {
          throw new Error('maxTokens 不得超过有效 contextWindow');
        }
        if (settings.defaultReasoning !== undefined && settings.defaultReasoning !== null) {
          const efforts = effective.reasoningEfforts;
          if (!efforts || efforts === false || !(settings.defaultReasoning in efforts)) {
            throw new Error('默认思考档位未被有效思考档位映射支持');
          }
        }
        const bucket = { ...(next.modelSettings[accountId] ?? {}) };
        const previous = row.settings;
        const { enabled, ...parameters } = settings;
        const kept = enabled === undefined && previous.enabled !== undefined ? { enabled: previous.enabled } : {};
        const merged = enabled === undefined ? { ...kept, ...parameters } : { ...settings };
        if (Object.keys(merged).length) bucket[request.modelId] = merged;
        else delete bucket[request.modelId];
        if (Object.keys(bucket).length) next.modelSettings[accountId] = bucket;
        else delete next.modelSettings[accountId];
      } else if (op === 'resetModelSettings') {
        this.owner(accountId);
        assertModelId(request.modelId);
        modelRow(next, accountId, request.modelId);
        const bucket = { ...(next.modelSettings[accountId] ?? {}) };
        delete bucket[request.modelId];
        if (Object.keys(bucket).length) next.modelSettings[accountId] = bucket;
        else delete next.modelSettings[accountId];
      } else {
        throw new Error(`未知操作：${op}`);
      }
      return next;
    });

    if (op === 'removeAccount') {
      await this.deleteGrant(accountId).catch(() => {});
    }
    this.clearCaches();
    try {
      await this.onChange();
    } catch {
      this.routingError ??= '设置已保存，但模型路由更新失败；此前可用路由仍保留。';
    }
    return this.read();
  }

  generateAccountId(accounts, prefix = 'account') {
    let i = 1;
    while (accounts.some((a) => a.id === `${prefix}-${i}`)) i++;
    return `${prefix}-${i}`;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.life.abort();
    this.oauth.dispose();
    stopAllKeepalive();
    this.clearCaches();
  }
}
