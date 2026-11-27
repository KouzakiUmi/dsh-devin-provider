import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CLI_VERSION, DEFAULT_SERVER } from './pb.mjs';
import {
  ROUTE_ID,
  StateStore,
  account,
  assertAccountId,
  assertModelId,
  assertSessionId,
  normalizeIdentity,
  normalizeKeepaliveSettings,
  normalizeModelSettings,
  normalizeFusionConfig,
  normalizeServerUrl,
  revision
} from './state.mjs';
import {
  SNAPSHOT_FAMILIES,
  catalogStatus,
  effectiveModel,
  fastModelMap,
  fetchCliModelConfigs,
  fusionCatalogOf,
  getModelRows
} from './catalog.mjs';
import { cliCatalog, cliIdentity, cliModels, cliPath, homeFor, readCliCredentials } from './cli.mjs';
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

    this.quotaCachePath = join(dirname(statePath), 'quota-cache.json');
    this.quotaCache = new Map();
    this.quotaInflight = new Map();
    this.quotaCacheLoaded = false;
    this.quotaLoadPromise = null;
    this.quotaWriteQueue = Promise.resolve();
    this.cacheGeneration = 0;
    this.dataVersion = 0;
    this.refreshTimer = null;
    this.startupTimer = null;
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

  async ensureQuotaCacheLoaded() {
    if (this.quotaCacheLoaded) return;
    if (!this.quotaLoadPromise) {
      this.quotaLoadPromise = (async () => {
        try {
          const parsed = JSON.parse(await readFile(this.quotaCachePath, 'utf8'));
          const entries = parsed?.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)
            ? parsed.entries
            : {};
          for (const [id, item] of Object.entries(entries)) {
            if (!id || !item || typeof item !== 'object' || Array.isArray(item)) continue;
            if (!this.quotaCache.has(id)) {
              this.quotaCache.set(id, { ...item, accountId: id });
            }
          }
        } catch {}
        this.quotaCacheLoaded = true;
      })();
    }
    await this.quotaLoadPromise;
  }

  persistQuotaCache() {
    if (this.disposed) return Promise.resolve();
    const snapshot = {
      version: 1,
      entries: Object.fromEntries(
        [...this.quotaCache.entries()].map(([id, entry]) => [id, structuredClone(entry)])
      )
    };
    const task = this.quotaWriteQueue.then(async () => {
      if (this.disposed) return;
      await mkdir(dirname(this.quotaCachePath), { recursive: true, mode: 0o700 });
      if (this.disposed) return;
      const tmp = `${this.quotaCachePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
        if (this.disposed) {
          await rm(tmp, { force: true }).catch(() => {});
          return;
        }
        await rename(tmp, this.quotaCachePath);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    });
    this.quotaWriteQueue = task.catch(() => {});
    return task;
  }

  clearCaches(accountId = null, { persist = true } = {}) {
    this.cacheGeneration++;
    let changed = false;
    if (accountId) {
      changed = this.quotaCache.delete(accountId);
      this.quotaInflight.delete(accountId);
    } else {
      changed = this.quotaCache.size > 0;
      this.quotaCache.clear();
      this.quotaInflight.clear();
    }
    if (changed && persist && !this.disposed) {
      this.quotaCacheLoaded = true;
      return this.persistQuotaCache().catch(() => {});
    }
    return Promise.resolve();
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
    if (who) return { identity: normalizeIdentity(who), verified: true };
    const fallback = unknownAccountName(key, server);
    return { identity: { email: fallback, name: fallback }, verified: false };
  }

  async bindOAuthLogin({ accountId, key, server, signal }) {
    if (signal?.aborted || this.disposed) throw new Error('登录已取消');
    const owner = this.owner(accountId);
    const { identity, verified } = await this.resolveIdentity(key, server);
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
        identityVerified: verified,
        loggedAt: new Date().toISOString(),
        credentialStored: true
      });
      if (!next.activeAccountId) next.activeAccountId = accountId;
      if (catalog) next.catalogs[accountId] = catalog;
      else delete next.catalogs[accountId];
      return next;
    }, { signal });
    await this.clearCaches(accountId);
    try {
      await this.onChange();
    } catch {
      this.routingError ??= '登录身份已保存，但模型路由更新失败；此前可用路由仍保留。';
    }
  }

  quotaSnapshotFor(accountId) {
    const entry = this.quotaCache.get(accountId);
    const refreshing = this.quotaInflight.has(accountId);
    if (!entry) {
      return {
        accountId,
        state: refreshing ? 'loading' : 'idle',
        windows: [],
        refreshing,
        stale: false,
        updatedAt: null
      };
    }
    const { credHash: _ignored, ...publicEntry } = entry;
    const ttl = publicEntry.state === 'ok' ? 60_000 : 15_000;
    const fresh = typeof publicEntry.fetchedAt === 'number' && Date.now() - publicEntry.fetchedAt < ttl;
    return {
      ...structuredClone(publicEntry),
      refreshing,
      stale: Boolean(publicEntry.stale) || !fresh
    };
  }

  async read(sessionId = '') {
    const state = this.store.current;
    if (!state) throw new Error(this.routingError || '无法读取 Devin 账号元数据；原文件未覆盖');
    await this.ensureQuotaCacheLoaded();

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

    const activeStatus = catalogStatus(state, state.activeAccountId);
    const fusion = fusionCatalogOf(state, state.activeAccountId);
    const sidekickChoices = new Map(getModelRows(state, state.activeAccountId).map((row) => [row.id, row]));
    const sidekicks = fusion.options.sidekicks.map((sidekick) => {
      const row = sidekickChoices.get(sidekick.familyId);
      return { ...sidekick,
        ...(row?.enabled === false ? { unavailable: 'disabled' }
          : row?.legacy && state.settings?.hideLegacyModels !== false ? { unavailable: 'legacy' } : {}) };
    });
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';

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
        const hideLegacy = state.settings?.hideLegacyModels !== false;
        const activeModels = hideLegacy ? models.filter((m) => !m.legacy) : models;
        return {
          accountId: a.id,
          count: status.broken ? 0 : models.length,
          visibleCount: status.broken ? 0 : activeModels.length,
          legacyCount: status.broken ? 0 : models.filter((m) => m.legacy).length,
          enabledCount: activeModels.filter((m) => m.enabled).length,
          totalEnabledCount: models.filter((m) => m.enabled).length,
          source: status.source,
          ...(status.broken ? { error: '模型缓存损坏，请重新拉取模型' } : {}),
          ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
          models
        };
      }),
      quotas: Object.fromEntries(state.accounts.map((a) => [a.id, this.quotaSnapshotFor(a.id)])),
      fastMode: Boolean(sid && state.fastSessions?.[sid]),
      fastSessionsCount: Object.keys(state.fastSessions ?? {}).length,
      fastModels: activeStatus.broken
        ? {}
        : fastModelMap(activeStatus.families, { fusionFast: fusion.selection?.fastAllowed }),
      fusion: {
        config: fusion.selection?.config ?? {},
        options: { ...fusion.options, sidekicks },
        perAccount: Object.fromEntries(state.accounts.map((a) => [a.id,
          (a.id === state.activeAccountId ? fusion : fusionCatalogOf(state, a.id)).selection?.config ?? {}]))
      },
      login: this.oauth.status()
    };
  }

  // 中间持久化层纯读路径：仅从内存/磁盘缓存返回快照，绝不触发网络或阻塞在写队列上。
  async readQuota(accountId) {
    this.owner(accountId);
    await this.ensureQuotaCacheLoaded();
    return this.quotaSnapshotFor(accountId);
  }

  // 拉取与读取解耦：触发后台刷新并立即返回当前持久快照（attach refreshing: true），不卡死 UI。
  async pullQuota(accountId, force = true) {
    this.owner(accountId);
    await this.ensureQuotaCacheLoaded();
    const current = this.quotaSnapshotFor(accountId);
    if (force || current.state === 'idle' || current.stale) {
      this.startQuotaRefresh(accountId).catch(() => {});
    }
    return this.quotaSnapshotFor(accountId);
  }

  quota(accountId, force = false) {
    return this.pullQuota(accountId, force);
  }

  // 中间层后台刷新路径：并发获取用量与免费清单、写入持久化文件并支持故障时保留上次有效读数（inflight 去重）。
  startQuotaRefresh(accountId) {
    if (this.disposed) return Promise.resolve();
    if (this.quotaInflight.has(accountId)) return this.quotaInflight.get(accountId);
    const owner = this.owner(accountId);
    const generation = this.cacheGeneration;
    const task = (async () => {
      await this.ensureQuotaCacheLoaded();
      const now = Date.now();
      const base = { accountId, fetchedAt: now, updatedAt: new Date(now).toISOString() };
      const prev = this.quotaCache.get(accountId);
      let value;
      try {
        const cred = await this.resolveCredential(owner);
        if (!cred?.key) {
          value = { ...base, state: 'no-key', windows: [], error: '该账号尚未配置可用凭据，请先登录或填写 API Key。' };
        } else {
          const credHash = createHash('sha256').update(cred.server || '').update('\0').update(cred.key).digest('hex').slice(0, 16);
          const hasCachedCatalog = Boolean(this.store.current?.catalogs?.[accountId]);
          const cachedStatus = catalogStatus(this.store.current, accountId);
          const usagePromise = fetchUsage(cred.key, cred.server, {
            fetchImpl: this.fetchImpl,
            signal: this.life.signal
          });
          const cfgPromise = hasCachedCatalog
            ? Promise.resolve({ freeIds: cachedStatus.freeIds ?? [], configError: '' })
            : fetchCliModelConfigs(cred.key, cred.server, this.fetchImpl, this.life.signal)
                .then((cfgs) => ({ freeIds: cfgs.freeIds ?? [], configError: '' }))
                .catch((err) => ({ freeIds: cachedStatus.freeIds ?? [], configError: err instanceof Error ? err.message : String(err) }));
          const [usageRes, cfgRes] = await Promise.all([usagePromise, cfgPromise]);
          const freeIds = cfgRes.freeIds ?? [];
          const configError = cfgRes.configError ?? '';
          const mergedUsage =
            freeIds.length || configError
              ? {
                  ...usageRes,
                  windows: (usageRes.windows ?? []).map((w) =>
                    w.kind === '1d' || w.kind === '7d'
                      ? { ...w, ...(freeIds.length ? { notModels: freeIds } : {}) }
                      : w
                  ),
                  ...(freeIds.length ? { freeModels: freeIds } : {}),
                  ...(configError ? { freeModelsNote: `免费模型清单暂未获取（${configError}）` } : {})
                }
              : usageRes;

          if (mergedUsage.expired) {
            value = { ...base, credHash, state: 'expired', windows: [], error: mergedUsage.error };
          } else if (mergedUsage.error) {
            if (prev?.state === 'ok' && prev.credHash === credHash && Array.isArray(prev.windows) && prev.windows.length) {
              value = {
                ...prev,
                fetchedAt: now,
                stale: true,
                staleReason: mergedUsage.error
              };
            } else {
              value = { ...base, credHash, state: 'error', windows: [], error: mergedUsage.error };
            }
          } else {
            if (mergedUsage.identity && !this.disposed) {
              const nextId = normalizeIdentity(mergedUsage.identity);
              if (JSON.stringify(nextId) !== JSON.stringify(owner.identity ?? {})) {
                const syncIdentity = this.operations.then(() => {
                  if (this.disposed || !this.store.current) return undefined;
                  return this.store.mutate(revision(this.store.current), (next) => {
                    const idx = next.accounts.findIndex((a) => a.id === accountId);
                    if (idx >= 0) next.accounts[idx] = account({ ...next.accounts[idx], identity: nextId });
                    return next;
                  }, { signal: this.life.signal });
                });
                this.operations = syncIdentity.catch(() => {});
              }
            }
            value = { ...base, credHash, state: 'ok', stale: false, ...mergedUsage };
          }
        }
      } catch (err) {
        const msg = `额度读取失败：${err instanceof Error ? err.message : String(err)}`;
        if (prev?.state === 'ok' && Array.isArray(prev.windows) && prev.windows.length) {
          value = { ...prev, fetchedAt: now, stale: true, staleReason: msg };
        } else {
          value = { ...base, state: 'error', windows: [], error: msg };
        }
      }
      if (!this.disposed && generation === this.cacheGeneration) {
        this.quotaCache.set(accountId, value);
        this.dataVersion++;
        await this.persistQuotaCache().catch(() => {});
      }
      return value;
    })();
    const tracked = task.finally(() => {
      if (this.quotaInflight.get(accountId) === tracked) this.quotaInflight.delete(accountId);
    });
    this.quotaInflight.set(accountId, tracked);
    return tracked;
  }

  // 后台定时保暖：让活跃账号额度缓存与持久化文件常新，UI 只做纯读取，不因打开设置触发阻塞网络请求。
  startBackgroundRefresh() {
    if (this.disposed || this.refreshTimer) return;
    const maybeRefreshActive = async () => {
      const state = this.store.current;
      const accountId = state?.activeAccountId;
      if (this.disposed || !accountId) return;
      const owner = state.accounts.find((a) => a.id === accountId);
      if (!owner) return;
      await this.ensureQuotaCacheLoaded();
      const snap = this.quotaSnapshotFor(accountId);
      if (snap.state === 'idle' || snap.stale) {
        this.startQuotaRefresh(accountId).catch(() => {});
      }
    };
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void maybeRefreshActive();
    }, 1200);
    this.startupTimer.unref?.();
    this.refreshTimer = setInterval(() => {
      void maybeRefreshActive();
    }, 30_000);
    this.refreshTimer.unref?.();
  }

  async invoke(request) {
    if (this.disposed) throw new Error('插件已卸载');
    if (!request || typeof request !== 'object') throw new Error('请求格式错误');
    const { op } = request;
    const sid = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
    if (op === 'read') {
      const read = this.operations.then(async () => {
        if (await this.store.refresh()) {
          try {
            await this.onChange();
          } catch {
            this.routingError ??= '模型路由更新失败；设置已同步，实际路由仍为此前账号。';
          }
        }
        return this.read(sid);
      });
      this.operations = read.catch(() => {});
      return read;
    }
    if (op === 'loginStatus') return this.oauth.status();
    if (op === 'cancelLogin') return this.oauth.cancel(request.jobId);
    if (op === 'readQuota') return this.readQuota(request.accountId);
    if (op === 'pullQuota') return this.pullQuota(request.accountId, request.force !== false);
    if (op === 'quota') return this.quota(request.accountId, request.force === true);
    if (op === 'setFastMode') {
      const nextOp = this.operations.then(async () => {
        if (this.disposed) throw new Error('插件已卸载');
        await this.store.refresh().catch(() => {});
        const clearAll = request.clearAll === true;
        const targetSid = clearAll ? '' : assertSessionId(sid);
        if (!clearAll && typeof request.enabled !== 'boolean') {
          throw new Error('快速模式开关必须是布尔值');
        }
        await this.store.mutate(revision(this.store.current), (next) => {
          next.fastSessions ??= {};
          if (clearAll) {
            next.fastSessions = {};
          } else if (request.enabled) {
            // 维持最近使用上限：重新插入放到末尾并裁剪至上限内
            delete next.fastSessions[targetSid];
            next.fastSessions[targetSid] = true;
            const keys = Object.keys(next.fastSessions);
            if (keys.length > 500) {
              for (let i = 0; i < keys.length - 500; i++) delete next.fastSessions[keys[i]];
            }
          } else {
            delete next.fastSessions[targetSid];
          }
          return next;
        });
        return this.read(targetSid);
      });
      this.operations = nextOp.catch(() => {});
      return nextOp;
    }

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
      const { identity, verified } = await this.resolveIdentity(cliCred.key, server);
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
          identityVerified: verified,
          loggedAt: new Date().toISOString()
        });
        const idx = next.accounts.findIndex((a) => a.id === targetId);
        if (idx < 0) next.accounts.push(entry);
        else next.accounts[idx] = entry;
        if (!next.activeAccountId) next.activeAccountId = targetId;
        if (catalog) next.catalogs[targetId] = catalog;
        return next;
      });
      await this.clearCaches(targetId);
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
      let identityVerified = this.store.current?.accounts?.find((a) => a.id === input.id)?.identityVerified;
      const existingAcc = this.store.current?.accounts?.find((a) => a.id === input.id);
      const candidateServer = this.serverFor({ server: normalizeServerUrl(input.server) });
      const serverChanged = existingAcc && (existingAcc.server ?? '') !== normalizeServerUrl(input.server);
      const credChanged = Boolean(plaintextKey) || serverChanged || (existingAcc && existingAcc.authMode !== (input.authMode ?? 'reference'));
      if (input.authMode === 'api-key') {
        if (!plaintextKey) {
          const existing = await this.readGrant(input.id).catch(() => undefined);
          if (!existing?.key) throw new Error('请输入 Devin API Key（cog_…）或 Session Token');
        } else {
          const resolved = await this.resolveIdentity(plaintextKey, candidateServer);
          identity = resolved.identity;
          identityVerified = resolved.verified;
          await this.writeGrant(input.id, { key: plaintextKey, server: candidateServer, updatedAt: new Date().toISOString() });
        }
      }
      await this.store.mutate(request.revision, (next) => {
        const entry = account({
          ...input,
          ...(identity ? { identity } : {}),
          ...(typeof identityVerified === 'boolean' ? { identityVerified } : {}),
          ...(input.authMode === 'api-key' ? { credentialStored: true, loggedAt: new Date().toISOString() } : {})
        });
        const idx = next.accounts.findIndex((a) => a.id === entry.id);
        if (idx < 0) next.accounts.push(entry);
        else next.accounts[idx] = entry;
        if (!next.activeAccountId) next.activeAccountId = entry.id;
        return next;
      });
      if (credChanged) await this.clearCaches(input.id);
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
            const cliResult = this.cliModelsReader === cliModels
              ? await cliCatalog(home, { executable: this.devinCliPath, signal: this.life.signal })
              : await this.cliModelsReader(home, { executable: this.devinCliPath, signal: this.life.signal });
            const families = Array.isArray(cliResult) ? cliResult : (cliResult?.families ?? []);
            const cliFree = Array.isArray(cliResult) ? [] : (cliResult?.freeIds ?? []);
            const cliPrices = Array.isArray(cliResult) ? {} : (cliResult?.prices ?? {});
            const cliFusion = Array.isArray(cliResult) ? [] : (cliResult?.fusionRoutes ?? []);
            catalog = {
              families,
              images: {},
              freeIds: cliFree,
              prices: cliPrices,
              ...(cliFusion.length ? { fusionRoutes: cliFusion } : {}),
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
      // GetCliModelConfigs 不含 Fusion 组合路由；官方组合表只出现在 `devin models list` 中。
      // RPC 目录未带组合表时补一次 CLI 读取；失败则保留同一服务上次成功获取的组合表。
      if (!Array.isArray(catalog.fusionRoutes) || !catalog.fusionRoutes.length) {
        if (cliPath(this.devinCliPath)) {
          try {
            const home = await homeFor(cred.key, cred.server, join(dirname(this.store.path), 'cli-cache'));
            const cliResult = this.cliModelsReader === cliModels
              ? await cliCatalog(home, { executable: this.devinCliPath, signal: this.life.signal })
              : await this.cliModelsReader(home, { executable: this.devinCliPath, signal: this.life.signal });
            const cliFusion = Array.isArray(cliResult) ? [] : (cliResult?.fusionRoutes ?? []);
            if (cliFusion.length) catalog = { ...catalog, fusionRoutes: cliFusion };
          } catch {
            // CLI 不可用时保留 RPC 目录。
          }
        }
      }
      if (catalog.fusionRoutes?.length) {
        catalog = { ...catalog, fusionRoutesVersion: CLI_VERSION, fusionServer: cred.server };
      } else {
        const previous = this.store.current.catalogs[accountId];
        if (previous?.fusionRoutesVersion === CLI_VERSION && previous.fusionServer === cred.server) {
          catalog = { ...catalog, fusionRoutes: previous.fusionRoutes, fusionRoutesVersion: CLI_VERSION, fusionServer: cred.server };
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
        const nextHideLegacy = s.hideLegacyModels === undefined
          ? (next.settings?.hideLegacyModels !== false)
          : s.hideLegacyModels;
        if (typeof nextHideLegacy !== 'boolean') throw new Error('过滤老旧模型开关必须是布尔值');
        next.settings = {
          cacheKeepalive: normalizeKeepaliveSettings(s.cacheKeepalive),
          serverUrl: normalizeServerUrl(s.serverUrl),
          hideLegacyModels: nextHideLegacy
        };
        if (!next.settings.cacheKeepalive.enabled) stopAllKeepalive();
      } else if (op === 'setHideLegacyModels') {
        if (typeof request.enabled !== 'boolean') throw new Error('过滤老旧模型开关必须是布尔值');
        next.settings = {
          ...next.settings,
          hideLegacyModels: request.enabled
        };
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
      } else if (op === 'saveFusion') {
        this.owner(accountId);
        const config = normalizeFusionConfig(request.config ?? {});
        if (Object.keys(config).length) next.fusion[accountId] = config;
        else delete next.fusion[accountId];
      } else {
        throw new Error(`未知操作：${op}`);
      }
      return next;
    });

    if (op === 'removeAccount') {
      await this.deleteGrant(accountId).catch(() => {});
      await this.clearCaches(accountId);
    }
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
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.life.abort();
    this.oauth.dispose();
    stopAllKeepalive();
    this.clearCaches(null, { persist: false });
  }
}
