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
import { DEFAULT_SERVER } from '../src/pb.mjs';

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

    // Quota check
    const q = await controller.invoke({ op: 'quota', accountId: 'work', force: true });
    assert.equal(q.state, 'ok');
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
