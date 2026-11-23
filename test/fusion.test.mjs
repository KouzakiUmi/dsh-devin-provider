import test from 'node:test';
import assert from 'node:assert/strict';
import { PB, dec, fields } from '../src/pb.mjs';
import { assignModel, encodeRequest, fusionRouterUid, isFusion } from '../src/devin-wire.mjs';

const topFields = (bytes) => {
  const out = {};
  for (const f of fields(bytes)) {
    if (f.wire === 2) out[f.num] = dec.decode(f.data);
    else if (f.wire === 0) out[f.num] = f.n;
  }
  return out;
};

test('isFusion 识别 fusion 路由 id', () => {
  assert.equal(isFusion('fusion'), true);
  assert.equal(isFusion('Fusion'), true);
  assert.equal(isFusion('claude-sonnet-5-5'), false);
  assert.equal(isFusion(undefined), false);
});

test('fusionRouterUid 组合 lead+effort+sidekick+effort（照抄 CLI 格式）', () => {
  assert.equal(
    fusionRouterUid({ lead: 'claude-fable-5-2', leadEffort: 'high', sidekick: 'swe-2', sidekickEffort: 'high' }),
    'fusion-claude-fable-5-2-high-sidekick-swe-2-high'
  );
  assert.equal(
    fusionRouterUid({ lead: 'claude-opus-5-5', leadEffort: 'medium', sidekick: 'swe-2', sidekickEffort: 'medium' }),
    'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium'
  );
  // 无 effort 时直接用家族 uid
  assert.equal(fusionRouterUid({ lead: 'claude-opus-5-5', sidekick: 'swe-2' }), 'fusion-claude-opus-5-5-sidekick-swe-2');
});

test('fusionRouterUid 缺少 lead 或 sidekick 时报错', () => {
  assert.throws(() => fusionRouterUid({ lead: 'claude-opus-5-5' }), /lead 与 sidekick/);
  assert.throws(() => fusionRouterUid({ sidekick: 'swe-2' }), /lead 与 sidekick/);
  assert.throws(() => fusionRouterUid({}), /lead 与 sidekick/);
});

test('assignModel 发 unary proto 请求并解析 lead modelUid + jwt', async () => {
  const resp = new PB().bytes(1, new PB().str(1, 'jwt-abc').str(2, 'claude-opus-5-5-medium').done()).done();
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, arrayBuffer: async () => resp.buffer.slice(resp.byteOffset, resp.byteOffset + resp.byteLength) };
  };
  const result = await assignModel({
    key: 'test-key', server: 'https://server.codeium.com',
    routerUid: 'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
    cascadeId: 'cascade-123', promptText: 'hello', fetchImpl
  });
  assert.equal(result.modelUid, 'claude-opus-5-5-medium');
  assert.equal(result.jwt, 'jwt-abc');
  assert.equal(captured.url, 'https://server.codeium.com/exa.api_server_pb.ApiServerService/AssignModel');
  assert.equal(captured.init.headers['Content-Type'], 'application/proto');
  assert.equal(captured.init.headers.Authorization, 'Basic test-key');
  const req = topFields(captured.init.body);
  assert.equal(req[2], 'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium');
  assert.equal(req[3], 'cascade-123');
});

test('assignModel 服务端未返回 assignment 时报错', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(
    assignModel({ key: 'k', server: 'https://x', routerUid: 'fusion-a-sidekick-b', cascadeId: 'c', promptText: '', fetchImpl }),
    /Fusion 分配失败/
  );
});

test('assignModel HTTP 错误透传状态', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, arrayBuffer: async () => new TextEncoder().encode('{"error":{"code":"resource_exhausted","message":"quota"}}').buffer });
  await assert.rejects(
    assignModel({ key: 'k', server: 'https://x', routerUid: 'fusion-a-sidekick-b', cascadeId: 'c', promptText: '', fetchImpl }),
    (e) => e.status === 429
  );
});

test('encodeRequest 携带 cascadeId(field16) 与 assignmentJwt(field26)，缺省时不携带', () => {
  const msgs = [{ role: 1, text: 'hi' }];
  const withAssign = encodeRequest(msgs, [], { max: 1000, cascadeId: 'cas-1', assignmentJwt: 'jwt-1' }, 'claude-opus-5-5-medium', 'k');
  const f = topFields(withAssign.bytes);
  assert.equal(f[21], 'claude-opus-5-5-medium');
  assert.equal(f[16], 'cas-1');
  assert.equal(f[26], 'jwt-1');
  const plain = encodeRequest(msgs, [], { max: 1000 }, 'swe-2-medium', 'k');
  const pf = topFields(plain.bytes);
  assert.equal(pf[16], undefined);
  assert.equal(pf[26], undefined);
});
// ── 目录 / 状态集成 ──────────────────────────────────────────────────────────
import { fusionOptions, fusionDescriptor, fusionConfigOf, profileFor } from '../src/catalog.mjs';
import { normalizeFusionConfig, initialState } from '../src/state.mjs';

const fakeState = () => {
  const s = initialState();
  s.accounts = [{ id: 'devin-1', label: 'Test', authMode: 'api-key' }];
  s.activeAccountId = 'devin-1';
  s.catalogs['devin-1'] = {
    source: 'remote',
    families: [
      { uid: 'claude-opus-5-5', label: 'Claude Opus 5.5', aliases: [], models: [
        { id: 'claude-opus-5-5-medium', name: 'Medium', context: 1000000, output: 128000 },
        { id: 'claude-opus-5-5-high', name: 'High', context: 1000000, output: 128000 }
      ] },
      { uid: 'swe-2', label: 'SWE-2', aliases: [], models: [
        { id: 'swe-2-medium', name: 'Medium', context: 262000, output: 128000 },
        { id: 'swe-2-high', name: 'High', context: 262000, output: 128000 },
        { id: 'swe-2-medium-lightning', name: 'Medium Lightning', context: 262000, output: 128000 },
        { id: 'swe-2-high-lightning', name: 'High Lightning', context: 262000, output: 128000 }
      ] }
    ],
    images: {}, freeIds: [], prices: {}
  };
  return s;
};

test('normalizeFusionConfig 校验 lead/sidekick/effort 并拒绝未知字段', () => {
  assert.deepEqual(normalizeFusionConfig({ lead: 'claude-opus-5-5', leadEffort: 'high', sidekick: 'swe-2', sidekickEffort: 'medium' }),
    { lead: 'claude-opus-5-5', leadEffort: 'high', sidekick: 'swe-2', sidekickEffort: 'medium' });
  assert.deepEqual(normalizeFusionConfig({}), {});
  assert.throws(() => normalizeFusionConfig({ leadEffort: 'bogus' }), /档位不受支持/);
  assert.throws(() => normalizeFusionConfig({ foo: 1 }), /未知字段/);
});

test('fusionOptions 从实时目录动态分出 lead/sidekick 并带可用档位', () => {
  const opts = fusionOptions(fakeState(), 'devin-1');
  assert.deepEqual(opts.leads.map((l) => l.id), ['claude-opus-5-5']);
  assert.deepEqual(opts.sidekicks.map((l) => l.id), ['swe-2']);
  assert.deepEqual(opts.leads[0].efforts, ['medium', 'high']);
  assert.equal(opts.default.lead, 'claude-opus-5-5');
  assert.equal(opts.default.sidekick, 'swe-2');
});

test('fusionConfigOf 默认搭配 + 账号覆盖；fusionDescriptor 随 lead 定 api 与窗口', () => {
  const s = fakeState();
  assert.equal(fusionConfigOf(s, 'devin-1').lead, 'claude-opus-5-5');
  const d = fusionDescriptor(s, 'devin-1');
  assert.equal(d.id, 'fusion');
  assert.equal(d.api, 'anthropic-messages');
  assert.equal(d.contextWindow, 1000000);
  assert.equal(d.reasoningEfforts, false);
  // swe-2 不在官方 lead 表：回退到默认 lead
  s.fusion['devin-1'] = { lead: 'swe-2', sidekick: 'swe-2' };
  assert.equal(fusionConfigOf(s, 'devin-1').lead, 'claude-opus-5-5');
  // 合法非 Claude lead 走 openai-completions
  s.catalogs['devin-1'].families.push({
    uid: 'gpt-6-astra', label: 'GPT-6 Astra', aliases: [],
    models: [{ id: 'gpt-6-astra-high', name: 'High', context: 1000000, output: 128000 }]
  });
  s.fusion['devin-1'] = { lead: 'gpt-6-astra', sidekick: 'swe-2' };
  assert.equal(fusionDescriptor(s, 'devin-1').api, 'openai-completions');
});

test('profileFor 追加 Fusion 路由模型', () => {
  const profile = profileFor(fakeState());
  const fusion = profile.models.find((m) => m.id === 'fusion');
  assert.equal(profile.models.some((m) => m.id === 'fusion'), true);
  assert.equal(fusion.name, 'Fusion');
});

test('fusionRouterUid 支持 fastMode 与含点家族名（GPT sidekick 追加 -priority）', () => {
  assert.equal(
    fusionRouterUid({ lead: 'claude-opus-5-5', leadEffort: 'medium', sidekick: 'swe-2', sidekickEffort: 'medium', fastMode: true }),
    'fusion-claude-opus-5-5-medium-fast-sidekick-swe-2-medium'
  );
  assert.equal(
    fusionRouterUid({ lead: 'claude-opus-5-5', leadEffort: 'medium', sidekick: 'gpt-6-luna', sidekickEffort: 'high', fastMode: true }),
    'fusion-claude-opus-5-5-medium-fast-sidekick-gpt-6-luna-high-priority'
  );
  assert.equal(
    fusionRouterUid({ lead: 'gpt-5.6-sol', leadEffort: 'high', sidekick: 'glm-5.2', sidekickEffort: '', fastMode: true }),
    'fusion-gpt-5-6-sol-high-fast-sidekick-glm-5-2'
  );
});

test('fusionOptions 按官方 CLI 搭配表校验并支持服务端 fusionRoutes 解析', async () => {
  const { SNAPSHOT_FAMILIES, parseFusionRoutesFromFamilies } = await import('../src/catalog.mjs');
  const s = initialState();
  s.accounts = [{ id: 'devin-1', label: 'Snap', authMode: 'api-key' }];
  s.activeAccountId = 'devin-1';
  s.catalogs['devin-1'] = { source: 'local-snapshot', families: SNAPSHOT_FAMILIES, images: {}, freeIds: [], prices: {} };
  const opts = fusionOptions(s, 'devin-1');
  const leadIds = new Set(opts.leads.map((l) => l.id));
  const sideIds = new Set(opts.sidekicks.map((k) => k.id));
  assert.ok(leadIds.has('gpt-5-6-sol'));
  assert.ok(!leadIds.has('claude-opus-4-8'));
  assert.equal(opts.leads.find((l) => l.id === 'claude-opus-5-5')?.fast, true);
  assert.equal(opts.leads.find((l) => l.id === 'claude-sonnet-5-5')?.fast, true);
  assert.equal(opts.leads.find((l) => l.id === 'claude-fable-5-1')?.fast, true);
  assert.ok(sideIds.has('swe-2'));
  assert.ok(sideIds.has('swe-2-flash'));
  assert.ok(sideIds.has('claude-haiku-5-5'));
  assert.ok(sideIds.has('glm-5-2'));
  assert.deepEqual(opts.sidekicks.find((k) => k.id === 'swe-2').efforts, ['medium', 'high']);
  assert.deepEqual(opts.sidekicks.find((k) => k.id === 'swe-2-flash').efforts, ['max']);
  assert.deepEqual(opts.sidekicks.find((k) => k.id === 'glm-5-2').efforts, []);

  // 选中无 effort 的 glm-5-2 不应被默认 sidekickEffort: medium 污染
  s.fusion['devin-1'] = { lead: 'claude-opus-5-5', leadEffort: 'high', sidekick: 'glm-5-2' };
  const cfg = fusionConfigOf(s, 'devin-1');
  assert.equal(cfg.sidekick, 'glm-5-2');
  assert.equal(cfg.sidekickEffort, '');

  // 从 devin models list JSON 提取 fusionRoutes
  const routes = parseFusionRoutesFromFamilies(JSON.stringify({
    families: [{
      family_uid: 'fusion',
      variants: [
        { model_uid: 'fusion-claude-opus-5-5-high-fast-sidekick-swe-2-flash-max' },
        { model_uid: 'fusion-claude-opus-5-5-high-sidekick-glm-5-2' }
      ]
    }]
  }));
  assert.equal(routes.length, 2);
});

test('createDevinAdapter 接受 profileFor 含 fusion 的完整目录且不报 facts 缺失', async () => {
  const { getModelRows } = await import('../src/catalog.mjs');
  const { createDevinAdapter } = await import('../src/devin-adapter.mjs');
  const s = fakeState();
  const profile = profileFor(s);
  const facts = new Map(getModelRows(s, 'devin-1').map((r) => [r.id, r]));
  class Base {}
  const adapter = createDevinAdapter(
    { LlmAdapter: Base, LlmError: Error, PiAiAdapter: Base, InMemoryCredentialStore: Base, AssistantMessageEventStream: Base, calculateCost: () => {} },
    { profile, facts, resolveCredential: async () => ({ key: 'k', server: 'https://server.codeium.com' }) }
  );
  assert.ok(adapter);
  adapter.dispose();
});

test('createDevinAdapter 按会话解析 resolveFastMode(sessionId) 并区分快速与标准路由', async () => {
  const { getModelRows } = await import('../src/catalog.mjs');
  const { createDevinAdapter } = await import('../src/devin-adapter.mjs');
  const s = fakeState();
  const profile = profileFor(s);
  const facts = new Map(getModelRows(s, 'devin-1').map((r) => [r.id, r]));
  const seenFastCalls = [];
  let capturedOptions = null;

  const sentModels = [];

  class MockBase {}
  class MockPiAiAdapter {
    constructor(opts) { this.opts = opts; }
    providerInfo(p) { return p; }
    async listModels() { return []; }
    resolveModel(_p, m) { return { id: m }; }
    async prepareCall(provider, model) {
      const piProvider = this.opts.profiles().get(provider).piProvider;
      const found = piProvider.getModels().find((x) => x.id === model);
      return {
        model: found,
        stream: async function* (options) {
          capturedOptions = options;
          piProvider.stream(found, { messages: [{ role: 'user', content: 'hi' }] }, options);
        }
      };
    }
  }
  class MockStream { push() {} end() {} }

  const adapter = createDevinAdapter(
    {
      LlmAdapter: MockBase,
      LlmError: Error,
      PiAiAdapter: MockPiAiAdapter,
      InMemoryCredentialStore: MockBase,
      AssistantMessageEventStream: MockStream,
      calculateCost: () => {}
    },
    {
      profile,
      facts,
      resolveCredential: async () => ({ key: 'k', server: 'https://server.codeium.com' }),
      resolveFastMode: (sid) => {
        seenFastCalls.push(sid);
        return sid === 'sess-fast';
      },
      fetchImpl: async (_url, init) => {
        const frame = new Uint8Array(init.body);
        sentModels.push(topFields(frame.subarray(5))[21]);
        return new Response('', { status: 499 });
      }
    }
  );

  for (const sid of ['sess-fast', 'sess-std', undefined]) {
    const prep = await adapter.prepareCall('devin', 'swe-2');
    for await (const _ of prep.stream({ provider: 'devin', model: 'swe-2', reasoningEffort: 'high', sessionId: sid })) {}
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seenFastCalls, ['sess-fast', 'sess-std', undefined]);
  assert.deepEqual(sentModels, ['swe-2-high-lightning', 'swe-2-high', 'swe-2-high']);
  assert.equal(capturedOptions?.provider, 'devin');
  adapter.dispose();
});

// ── 官方 Fusion 组合表（devin models list 的 fusion-* 路由）──────────────────
const OFFICIAL_FUSION_ROUTES = [
  'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-high-sidekick-swe-2-high',
  'fusion-claude-opus-5-5-high-sidekick-gpt-6-luna-high',
  'fusion-claude-opus-5-5-medium-fast-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-high-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-fable-5-2-high-sidekick-swe-2-high',
  'fusion-claude-fable-5-2-high-sidekick-gpt-6-luna-high',
  'fusion-claude-fable-5-2-high-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-sonnet-5-5-medium-sidekick-swe-2-medium',
  'fusion-claude-sonnet-5-5-medium-fast-sidekick-gpt-6-luna-high-priority'
];

const fusionMatrixState = () => {
  const s = initialState();
  s.accounts = [{ id: 'devin-1', label: 'Test', authMode: 'api-key' }];
  s.activeAccountId = 'devin-1';
  const model = (id, context = 262000) => ({ id, name: id, context, output: 128000 });
  s.catalogs['devin-1'] = {
    source: 'cli',
    families: [
      { uid: 'claude-opus-5-5', label: 'Claude Opus 5.5', aliases: [], models: [model('claude-opus-5-5-medium'), model('claude-opus-5-5-high')] },
      { uid: 'claude-fable-5-2', label: 'Claude Fable 5.2', aliases: [], models: [model('claude-fable-5-2-high')] },
      { uid: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', aliases: [], models: [model('claude-sonnet-5-5-medium')] },
      { uid: 'swe-2', label: 'SWE-2', aliases: [], models: [model('swe-2-medium'), model('swe-2-high')] },
      { uid: 'gpt-6-luna', label: 'GPT-6 Luna', aliases: [], models: [model('gpt-6-luna-high')] }
    ],
    images: {},
    freeIds: [],
    prices: {},
    fusionRoutes: [...OFFICIAL_FUSION_ROUTES]
  };
  return s;
};

test('fusionRouteMatrix 从官方路由解析 lead/sidekick 搭配与 fast 限制', async () => {
  const { fusionRouteMatrix } = await import('../src/catalog.mjs');
  const matrix = fusionRouteMatrix(OFFICIAL_FUSION_ROUTES);
  const opus = matrix.leads.get('claude-opus-5-5');
  assert.deepEqual([...opus.efforts].sort(), ['high', 'medium']);
  assert.deepEqual([...opus.sidekicks].sort(), ['gpt-6-luna', 'swe-2']);
  assert.deepEqual([...opus.fastSidekicks].sort(), ['gpt-6-luna', 'swe-2']);
  const fable = matrix.leads.get('claude-fable-5-2');
  assert.deepEqual([...fable.sidekicks].sort(), ['gpt-6-luna', 'swe-2']);
  assert.deepEqual([...fable.fastSidekicks], ['gpt-6-luna']);
  const sonnet = matrix.leads.get('claude-sonnet-5-5');
  assert.deepEqual([...sonnet.sidekicks], ['swe-2']);
  assert.deepEqual([...sonnet.fastSidekicks], ['gpt-6-luna']);
  assert.deepEqual([...matrix.sidekicks.get('swe-2').efforts].sort(), ['high', 'medium']);
  assert.deepEqual([...matrix.sidekicks.get('gpt-6-luna').efforts], ['high']);
});

test('fusionOptions 用官方组合表过滤每个 lead 的 sidekick 与 fast 能力', async () => {
  const { fusionOptions } = await import('../src/catalog.mjs');
  const s = fusionMatrixState();
  const opts = fusionOptions(s, 'devin-1');
  const lead = (id) => opts.leads.find((l) => l.id === id);
  assert.deepEqual(opts.leads.map((l) => l.id).sort(), ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(lead('claude-opus-5-5').fast, true);
  assert.deepEqual(lead('claude-opus-5-5').fastSidekicks.sort(), ['gpt-6-luna', 'swe-2']);
  assert.deepEqual(lead('claude-fable-5-2').fastSidekicks, ['gpt-6-luna']);
  assert.deepEqual(lead('claude-sonnet-5-5').sidekicks, ['swe-2']);
  assert.equal(opts.default.lead, 'claude-opus-5-5');
  assert.equal(opts.default.sidekick, 'swe-2');
});

test('fusionConfigOf 按官方组合表回退非法 lead/sidekick/effort 并给出 fastAllowed', async () => {
  const { fusionConfigOf, fusionSupportsFast } = await import('../src/catalog.mjs');
  const s = fusionMatrixState();
  s.fusion['devin-1'] = { lead: 'claude-fable-5-2', leadEffort: 'high', sidekick: 'swe-2', sidekickEffort: 'high' };
  const fableSwe = fusionConfigOf(s, 'devin-1');
  assert.equal(fableSwe.sidekick, 'swe-2');
  assert.equal(fableSwe.fastAllowed, false);
  assert.equal(fusionSupportsFast(s, 'devin-1'), false);

  s.fusion['devin-1'] = { lead: 'claude-fable-5-2', leadEffort: 'high', sidekick: 'gpt-6-luna', sidekickEffort: 'high' };
  assert.equal(fusionConfigOf(s, 'devin-1').fastAllowed, true);
  assert.equal(fusionSupportsFast(s, 'devin-1'), true);

  // sonnet 不能把自己当 sidekick：回退到合法 sidekick
  s.fusion['devin-1'] = { lead: 'claude-sonnet-5-5', leadEffort: 'medium', sidekick: 'claude-sonnet-5-5', sidekickEffort: 'medium' };
  const sonnetSelf = fusionConfigOf(s, 'devin-1');
  assert.equal(sonnetSelf.sidekick, 'swe-2');
  assert.equal(sonnetSelf.leadEffort, 'medium');

  // 非法 lead 回退到默认 lead
  s.fusion['devin-1'] = { lead: 'unknown-lead', leadEffort: 'bogus', sidekick: 'unknown-sidekick' };
  const unknown = fusionConfigOf(s, 'devin-1');
  assert.equal(unknown.lead, 'claude-opus-5-5');
  assert.equal(unknown.sidekick, 'swe-2');
});

test('fusionRouterUid 在官方组合表不允许 fast 时降级为普通路由', () => {
  const fableSwe = { lead: 'claude-fable-5-2', leadEffort: 'high', sidekick: 'swe-2', sidekickEffort: 'high', fastMode: true, fastAllowed: false };
  assert.equal(
    fusionRouterUid(fableSwe),
    'fusion-claude-fable-5-2-high-sidekick-swe-2-high'
  );
  const fableLuna = { ...fableSwe, sidekick: 'gpt-6-luna', fastAllowed: true };
  assert.equal(
    fusionRouterUid(fableLuna),
    'fusion-claude-fable-5-2-high-fast-sidekick-gpt-6-luna-high-priority'
  );
});
