import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, initialState, revision } from '../src/state.mjs';
import { DevinController } from '../src/manager.mjs';
import { DevinOAuth } from '../src/oauth.mjs';
import { parseUsageResponse } from '../src/quota.mjs';
import { readCliCredentials } from '../src/cli.mjs';
import { DEFAULT_SERVER, PB } from '../src/pb.mjs';

test('StateStore enforces revision check, atomic write, and keeps secrets out of state.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-state-'));
  try {
    const path = join(dir, 'state.json');
    const store = new StateStore(path);
    await store.load();
    assert.deepEqual(store.current, initialState());

    const rev1 = revision(store.current);
    const next = await store.mutate(rev1, (s) => {
      s.accounts.push({ id: 'main', label: 'Main', authMode: 'api-key', credentialStored: true });
      s.activeAccountId = 'main';
      return s;
    });
    assert.equal(next.accounts.length, 1);

    await assert.rejects(() => store.mutate(rev1, (s) => s), /设置已改变/);

    await assert.rejects(
      () => store.mutate(revision(next), (s) => {
        s.accounts[0].apiKey = 'cog_secret';
        return s;
      }),
      /不支持的字段|明文凭据/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseUsageResponse normalizes daily, weekly, ACU, and overage balance', () => {
  const parsed = parseUsageResponse(
    {
      email: 'u@example.com',
      teamsTier: 'TEAMS_TIER_DEVIN_PRO',
      planStatus: {
        planInfo: { billingStrategy: 'BILLING_STRATEGY_QUOTA', planName: 'Pro' },
        dailyQuotaRemainingPercent: 75,
        dailyQuotaResetAtUnix: 1794600000,
        weeklyQuotaRemainingPercent: 0,
        weeklyQuotaResetAtUnix: 1795000000,
        acuConsumed: 12.5,
        acuLimit: 100,
        overageBalanceMicros: 4250000,
        planEnd: 1796000000
      }
    },
    { freeIds: ['swe-2-high'] }
  );
  assert.equal(parsed.identity.email, 'u@example.com');
  assert.equal(parsed.identity.plan, 'Devin Pro');
  assert.equal(parsed.overageBalance, '$4.25');
  assert.equal(parsed.windows.length, 3);
  assert.equal(parsed.windows[0].remainingPercent, 75);
  assert.equal(parsed.windows[1].usedPercent, 100); // 0 remaining with quota strategy
  assert.equal(parsed.windows[2].detail.limit, 100);
});

test('DevinController handles api-key grants, keepalive settings, model overrides, CLI import, and quota', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-ctrl-'));
  try {
    const statePath = join(dir, 'state.json');
    const grants = new Map();
    const mockFetch = async (url) => {
      if (url.endsWith('/GetUserStatus')) {
        return Response.json({
          userStatus: {
            email: 'devin@example.com',
            teamsTier: 'TEAMS_TIER_DEVIN_PRO',
            planStatus: {
              planInfo: { billingStrategy: 'BILLING_STRATEGY_QUOTA' },
              dailyQuotaRemainingPercent: 80,
              dailyQuotaResetAtUnix: Math.floor(Date.now() / 1000) + 3600
            }
          }
        });
      }
      return new Response('not found', { status: 404 });
    };

    const controller = new DevinController({
      statePath,
      fetchImpl: mockFetch,
      readGrant: async (id) => grants.get(id),
      writeGrant: async (id, val) => { grants.set(id, val); },
      deleteGrant: async (id) => { grants.delete(id); },
      cliCredentialsReader: async () => ({ key: 'devin-session-token$cli', server: 'https://server.codeium.com' })
    });
    await controller.store.load();

    // Save api-key account (secret goes to grants map, NOT state.json)
    const snap1 = await controller.invoke({
      op: 'saveAccount',
      revision: revision(controller.store.current),
      account: { id: 'work', label: 'Work', authMode: 'api-key' },
      apiKey: 'cog_test_secret_123'
    });
    assert.equal(snap1.accounts.length, 1);
    assert.equal(snap1.accounts[0].hasCredential, true);
    assert.equal(grants.get('work')?.key, 'cog_test_secret_123');
    const disk = await readFile(statePath, 'utf8');
    assert.equal(disk.includes('cog_test_secret_123'), false);

    // Quota check —— 中间层契约：即时返回缓存/占位（不阻塞上游），后台回填后再读
    const q0 = await controller.invoke({ op: 'quota', accountId: 'work', force: true });
    assert.equal(q0.refreshing, true);
    let q = q0;
    const deadline = Date.now() + 2000;
    while (q.refreshing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      q = await controller.invoke({ op: 'quota', accountId: 'work' });
    }
    assert.equal(q.state, 'ok');
    assert.equal(q.refreshing, false);
    assert.equal(q.windows[0].remainingPercent, 80);

    // Save keepalive settings
    const snap2 = await controller.invoke({
      op: 'saveSettings',
      revision: snap1.revision,
      settings: { cacheKeepalive: { enabled: true, intervalSec: 200, maxPings: 4 }, serverUrl: '' }
    });
    assert.deepEqual(snap2.settings.cacheKeepalive, { enabled: true, intervalSec: 200, maxPings: 4 });

    // Model toggle & settings override & reset
    const snap3 = await controller.invoke({
      op: 'saveModelSettings',
      revision: snap2.revision,
      accountId: 'work',
      modelId: 'gpt-6-sol',
      settings: { temperature: 0.4, toolsEnabled: false, defaultReasoning: 'off' }
    });
    const sol = snap3.catalogs[0].models.find((m) => m.id === 'gpt-6-sol');
    assert.equal(sol.effective.temperature, 0.4);
    assert.equal(sol.effective.toolsEnabled, false);
    assert.equal(sol.effective.defaultReasoning, 'off');

    const snap4 = await controller.invoke({
      op: 'resetModelSettings',
      revision: snap3.revision,
      accountId: 'work',
      modelId: 'gpt-6-sol'
    });
    const solReset = snap4.catalogs[0].models.find((m) => m.id === 'gpt-6-sol');
    assert.equal(solReset.effective.toolsEnabled, true);

    // Import CLI account
    const snap5 = await controller.invoke({ op: 'importCli', revision: snap4.revision });
    assert.equal(snap5.accounts.length, 2);
    assert.equal(snap5.accounts[1].authMode, 'cli');

    // Remove account deletes grant
    const snap6 = await controller.invoke({ op: 'removeAccount', revision: snap5.revision, accountId: 'work' });
    assert.equal(grants.has('work'), false);
    assert.equal(snap6.accounts.length, 1);

    controller.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DevinOAuth PKCE roundtrip exchanges callback code and settles cleanly', async () => {
  let bound = null;
  const oauth = new DevinOAuth({
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/ExchangeDevinCLIPKCECode'));
      const body = JSON.parse(init.body);
      assert.equal(body.code, 'auth_code_xyz');
      return Response.json({ sessionToken: 'devin-session-token$pkce' });
    },
    onSuccess: async (payload) => {
      bound = payload;
    }
  });

  const started = await oauth.start({ accountId: 'devin-1', revision: 'rev-1' });
  assert.equal(started.state, 'waiting');
  const authUrl = new URL(started.url);
  assert.equal(authUrl.origin, 'https://app.devin.ai');
  const redirect = authUrl.searchParams.get('redirect_uri');
  const state = authUrl.searchParams.get('state');

  const cbRes = await fetch(`${redirect}?code=auth_code_xyz&state=${encodeURIComponent(state)}`);
  assert.equal(cbRes.status, 200);
  const html = await cbRes.text();
  assert.ok(html.includes('Devin 登录成功'));
  assert.equal(oauth.status().state, 'success');
  assert.equal(bound.key, 'devin-session-token$pkce');
  oauth.dispose();
});

test('saveAccount rejects unsafe account ids and server URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-guard-'));
  try {
    const grants = new Map();
    const controller = new DevinController({
      statePath: join(dir, 'state.json'),
      fetchImpl: async () => new Response('not found', { status: 404 }),
      readGrant: async (id) => grants.get(id),
      writeGrant: async (id, val) => { grants.set(id, val); },
      deleteGrant: async (id) => { grants.delete(id); }
    });
    await controller.store.load();
    await assert.rejects(
      () => controller.invoke({
        op: 'saveAccount',
        revision: revision(controller.store.current),
        account: { id: '../evil', label: 'Bad', authMode: 'api-key' },
        apiKey: 'cog_x'
      }),
      /账号 ID/
    );
    await assert.rejects(
      () => controller.invoke({
        op: 'saveAccount',
        revision: revision(controller.store.current),
        account: { id: 'ok', label: 'Ok', authMode: 'api-key', server: 'javascript:alert(1)' },
        apiKey: 'cog_x'
      }),
      /服务地址/
    );
    controller.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveAccount records unverified identity when online check fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-verify-'));
  try {
    const controller = new DevinController({
      statePath: join(dir, 'state.json'),
      fetchImpl: async () => { throw new Error('network down'); },
      readGrant: async () => undefined,
      writeGrant: async () => {},
      deleteGrant: async () => {}
    });
    await controller.store.load();
    const snap = await controller.invoke({
      op: 'saveAccount',
      revision: revision(controller.store.current),
      account: { id: 'offline', label: 'Offline', authMode: 'api-key' },
      apiKey: 'cog_offline'
    });
    assert.equal(snap.accounts[0].identityVerified, false);
    controller.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCliCredentials falls back to the default server for an unsafe api_server_url', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-cli-'));
  try {
    const file = join(dir, 'credentials.toml');
    await writeFile(file, 'windsurf_api_key = "cog_cli"\napi_server_url = "javascript:alert(1)"\n', 'utf8');
    const cred = await readCliCredentials(file);
    assert.equal(cred.key, 'cog_cli');
    assert.equal(cred.server, DEFAULT_SERVER);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DevinController persists per-session fastMode (fastSessions), ignores legacy global fastMode, and decouples readQuota vs pullQuota to quota-cache.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-fast-'));
  try {
    const statePath = join(dir, 'state.json');
    let usageCalls = 0;
    let shouldFail = false;
    const mockFetch = async (url) => {
      if (url.endsWith('/GetUserStatus')) {
        usageCalls++;
        if (shouldFail) return new Response('upstream error', { status: 502 });
        return Response.json({
          userStatus: {
            email: 'quota@example.com',
            teamsTier: 'TEAMS_TIER_DEVIN_PRO',
            planStatus: {
              planInfo: { billingStrategy: 'BILLING_STRATEGY_QUOTA' },
              dailyQuotaRemainingPercent: 64,
              dailyQuotaResetAtUnix: Math.floor(Date.now() / 1000) + 3600
            }
          }
        });
      }
      return new Response('not found', { status: 404 });
    };

    const controller = new DevinController({
      statePath,
      fetchImpl: mockFetch,
      readGrant: async () => ({ key: 'cog_test_key' }),
      writeGrant: async () => {},
      deleteGrant: async () => {}
    });
    await controller.store.load();
    await controller.store.mutate(revision(controller.store.current), (s) => {
      s.accounts.push({ id: 'a1', label: 'A1', authMode: 'api-key', credentialStored: true });
      s.activeAccountId = 'a1';
      return s;
    });

    // 1) 按会话单独开启快速模式，会话间严格隔离
    const r0 = await controller.invoke({ op: 'read', sessionId: 'sess-a' });
    assert.equal(r0.fastMode, false);
    assert.equal(r0.fastSessionsCount, 0);
    assert.equal(r0.fastModels['swe-2']?.tier, 'lightning');
    assert.equal(r0.quotas.a1?.state, 'idle');
    assert.equal(usageCalls, 0); // read() 绝不触发上游额度请求

    const r1 = await controller.invoke({ op: 'setFastMode', sessionId: 'sess-a', enabled: true });
    assert.equal(r1.fastMode, true);
    assert.equal(r1.fastSessionsCount, 1);
    const r1b = await controller.invoke({ op: 'read', sessionId: 'sess-b' });
    assert.equal(r1b.fastMode, false); // sess-b 保持关闭

    const reloaded = new StateStore(statePath);
    await reloaded.load();
    assert.equal(reloaded.current.fastSessions['sess-a'], true);
    assert.equal(reloaded.current.fastSessions['sess-b'], undefined);

    // 2) readQuota 纯读绝不打网络；pullQuota 后台拉取并落盘 quota-cache.json
    const qIdle = await controller.invoke({ op: 'readQuota', accountId: 'a1' });
    assert.equal(qIdle.state, 'idle');
    assert.equal(usageCalls, 0);

    let q = await controller.invoke({ op: 'pullQuota', accountId: 'a1', force: true });
    const deadline = Date.now() + 2000;
    while (q.refreshing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      q = await controller.invoke({ op: 'readQuota', accountId: 'a1' });
    }
    assert.equal(q.state, 'ok');
    assert.equal(q.windows[0].remainingPercent, 64);
    assert.equal(usageCalls, 1);
    await controller.operations;
    controller.dispose();

    // 3) 重启新实例无需再请求网络即可直接读到磁盘持久化额度；故障时保留上次有效缓存并标 stale
    const controller2 = new DevinController({
      statePath,
      fetchImpl: mockFetch,
      readGrant: async () => ({ key: 'cog_test_key' }),
      writeGrant: async () => {},
      deleteGrant: async () => {}
    });
    await controller2.store.load();
    const afterRestart = await controller2.invoke({ op: 'read', sessionId: 'sess-a' });
    assert.equal(afterRestart.fastMode, true);
    assert.equal(afterRestart.quotas.a1?.state, 'ok');
    assert.equal(afterRestart.quotas.a1?.windows[0].remainingPercent, 64);
    assert.equal(usageCalls, 1);

    shouldFail = true;
    let qErr = await controller2.invoke({ op: 'pullQuota', accountId: 'a1', force: true });
    const dl2 = Date.now() + 2000;
    while (qErr.refreshing && Date.now() < dl2) {
      await new Promise((r) => setTimeout(r, 10));
      qErr = await controller2.invoke({ op: 'readQuota', accountId: 'a1' });
    }
    assert.equal(qErr.state, 'ok');
    assert.equal(qErr.stale, true);
    assert.equal(qErr.windows[0].remainingPercent, 64);

    // 4) clearAll 关闭全部会话快速模式
    const rCleared = await controller2.invoke({ op: 'setFastMode', clearAll: true });
    assert.equal(rCleared.fastSessionsCount, 0);
    assert.equal((await controller2.invoke({ op: 'read', sessionId: 'sess-a' })).fastMode, false);
    controller2.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DevinController 拉取 RPC 目录后用 CLI 补全官方 Fusion 组合表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-fusion-routes-'));
  try {
    const statePath = join(dir, 'state.json');
    const fakeCli = join(dir, 'devin.exe');
    await writeFile(fakeCli, '');
    const grants = new Map();
    let cliUnavailable = false;
    const routes = [
      'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
      'fusion-claude-opus-5-5-medium-fast-sidekick-swe-2-medium',
      'fusion-claude-fable-5-2-high-sidekick-gpt-6-luna-high',
      'fusion-claude-fable-5-2-high-fast-sidekick-gpt-6-luna-high-priority'
    ];
    const modelMsg = new PB()
      .str(1, 'SWE-2 High')
      .str(22, 'swe-2-high')
      .varint(18, 262000)
      .bytes(23, new PB().varint(13, 128000).str(23, 'swe-2').done())
      .varint(5, 1)
      .done();
    const proto = new PB().bytes(1, modelMsg).done();
    const mockFetch = async (url) => {
      if (url.endsWith('/GetUserStatus')) {
        return Response.json({
          userStatus: {
            email: 'devin@example.com',
            teamsTier: 'TEAMS_TIER_DEVIN_PRO',
            planStatus: { planInfo: { billingStrategy: 'BILLING_STRATEGY_QUOTA' } }
          }
        });
      }
      if (url.endsWith('/GetCliModelConfigs')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => proto.buffer.slice(proto.byteOffset, proto.byteOffset + proto.byteLength)
        };
      }
      return new Response('not found', { status: 404 });
    };
    const controller = new DevinController({
      statePath,
      devinCliPath: fakeCli,
      fetchImpl: mockFetch,
      readGrant: async (id) => grants.get(id),
      writeGrant: async (id, val) => { grants.set(id, val); },
      deleteGrant: async (id) => { grants.delete(id); },
      // RPC 不含 Fusion 组合表；补全路径只读取 CLI 的 fusionRoutes。
      cliModelsReader: async () => {
        if (cliUnavailable) throw new Error('CLI unavailable');
        return { families: [], freeIds: [], prices: {}, fusionRoutes: routes };
      }
    });
    await controller.store.load();
    const snap = await controller.invoke({
      op: 'saveAccount',
      revision: revision(controller.store.current),
      account: { id: 'work', label: 'Work', authMode: 'api-key' },
      apiKey: 'cog_test_secret'
    });
    const pulled = await controller.invoke({ op: 'models', revision: snap.revision, accountId: 'work' });
    assert.deepEqual(controller.store.current.catalogs.work.fusionRoutes, routes);
    const fable = pulled.fusion.options.leads.find((lead) => lead.id === 'claude-fable-5-2');
    assert.deepEqual(fable.variants, [{ effort: 'high', sidekicks: [{ id: 'gpt-6-luna', efforts: ['high'], fastEfforts: ['high'] }] }]);
    // 快照只暴露可持久化字段
    assert.equal(Object.hasOwn(pulled.fusion.config, 'fastAllowed'), false);
    cliUnavailable = true;
    const refreshed = await controller.invoke({ op: 'models', revision: pulled.revision, accountId: 'work' });
    assert.deepEqual(refreshed.fusion.options, pulled.fusion.options);
    controller.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DevinController persists hideLegacyModels (default true), preserves it on saveSettings, and sorts enabled models first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-legacy-filter-'));
  try {
    const statePath = join(dir, 'state.json');
    // 模拟旧版 state.json（缺少 hideLegacyModels 字段）加载后应默认为 true
    await writeFile(statePath, JSON.stringify({
      version: 1,
      accounts: [{ id: 'a1', label: 'A1', authMode: 'api-key', credentialStored: true }],
      activeAccountId: 'a1',
      enabled: true,
      settings: { cacheKeepalive: { enabled: false, intervalSec: 285, maxPings: 6 }, serverUrl: '' },
      catalogs: {},
      modelSettings: { a1: { 'swe-2-1': { enabled: false } } },
      fusion: {},
      fastSessions: {}
    }), 'utf8');

    let onChangeCalls = 0;
    const controller = new DevinController({
      statePath,
      readGrant: async () => ({ key: 'cog_k' }),
      writeGrant: async () => {},
      deleteGrant: async () => {}
    });
    controller.onChange = async () => { onChangeCalls++; };
    await controller.store.load();

    const snap0 = await controller.invoke({ op: 'read' });
    assert.equal(snap0.settings.hideLegacyModels, true);
    assert.ok(snap0.catalogs[0].legacyCount > 0);
    assert.ok(snap0.catalogs[0].visibleCount < snap0.catalogs[0].count);
    // 已停用的 swe-2-1 排在所有已启用模型之后
    const models0 = snap0.catalogs[0].models;
    assert.equal(models0[models0.length - 1].id, 'swe-2-1');
    assert.equal(models0[models0.length - 1].enabled, false);
    assert.equal(models0[0].enabled, true);

    // 关闭过滤老旧模型
    const snap1 = await controller.invoke({ op: 'setHideLegacyModels', revision: snap0.revision, enabled: false });
    assert.equal(snap1.settings.hideLegacyModels, false);
    assert.equal(snap1.catalogs[0].visibleCount, snap1.catalogs[0].count);
    assert.equal(onChangeCalls, 1);

    // 保存保活/服务设置时未传 hideLegacyModels 不得误覆盖回 true
    const snap2 = await controller.invoke({
      op: 'saveSettings',
      revision: snap1.revision,
      settings: { cacheKeepalive: { enabled: true, intervalSec: 240, maxPings: 5 }, serverUrl: '' }
    });
    assert.equal(snap2.settings.hideLegacyModels, false);

    // 重新开启过滤并持久化校验
    const snap3 = await controller.invoke({ op: 'setHideLegacyModels', revision: snap2.revision, enabled: true });
    assert.equal(snap3.settings.hideLegacyModels, true);
    const reloaded = new StateStore(statePath);
    await reloaded.load();
    assert.equal(reloaded.current.settings.hideLegacyModels, true);

    controller.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
