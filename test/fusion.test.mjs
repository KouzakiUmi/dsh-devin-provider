import test from 'node:test';
import assert from 'node:assert/strict';
import { CLI_VERSION, DEFAULT_SERVER, PB, dec, fields, frame } from '../src/pb.mjs';
import { assignModel, encodeRequest, isFusion, streamDevinChat } from '../src/devin-wire.mjs';

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
import { SNAPSHOT_FUSION_ROUTES, fusionCatalogOf, profileFor, parseFusionRoutesFromFamilies } from '../src/catalog.mjs';
import { normalizeFusionConfig, initialState } from '../src/state.mjs';
import { parseFusionRoute } from '../src/fusion-routes.mjs';

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

test('内置快照完整投影 438 条官方组合，每个选择发出精确 UID', () => {
  const s = fakeState();
  delete s.catalogs[s.activeAccountId];
  const { options, selection } = fusionCatalogOf(s, s.activeAccountId);
  assert.equal(options.leads.length, 6);
  assert.equal(options.sidekicks.length, 9);
  assert.ok(options.leads.some(l => l.id === 'gemini-4-neon'));
  assert.ok(options.sidekicks.some(l => l.id === 'swe-2-1'));
  assert.equal(selection.routeUid, 'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium');
  const standard = new Set();
  const fast = new Set();
  for (const uid of SNAPSHOT_FUSION_ROUTES) {
    const { lead, sidekick, fast: isFast } = parseFusionRoute(uid);
    s.fusion[s.activeAccountId] = { lead: lead.id, leadEffort: lead.effort, sidekick: sidekick.id, sidekickEffort: sidekick.effort };
    const { selection: selected } = fusionCatalogOf(s, s.activeAccountId);
    assert.equal(isFast ? selected.fastRouteUid : selected.routeUid, uid);
    (isFast ? fast : standard).add(uid);
  }
  assert.equal(standard.size, 255);
  assert.equal(fast.size, 183);
  const optionsCount = options.leads.flatMap(l => l.variants.flatMap(v => v.sidekicks));
  assert.equal(optionsCount.flatMap(x => x.efforts).length, standard.size);
  assert.equal(optionsCount.flatMap(x => x.fastEfforts).length, fast.size);
});

test('精确校验主模型档位、副模型档位以及快速变体；旧和私服缓存不合并官方组合', () => {
  const s = fakeState();
  const cached = s.catalogs[s.activeAccountId];
  cached.fusionRoutes = [
    'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
    'fusion-claude-opus-5-5-high-sidekick-swe-2-high',
    'fusion-claude-opus-5-5-high-fast-sidekick-swe-2-high',
    'fusion-claude-opus-5-5-high-fast-sidekick-swe-2-medium'
  ];
  cached.fusionRoutesVersion = CLI_VERSION;
  cached.fusionServer = DEFAULT_SERVER;
  s.fusion[s.activeAccountId] = { lead: 'claude-opus-5-5', leadEffort: 'high', sidekick: 'swe-2', sidekickEffort: 'medium' };
  const actual = fusionCatalogOf(s, s.activeAccountId);
  assert.equal(actual.selection.config.sidekickEffort, 'high');
  assert.equal(actual.selection.fastRouteUid, cached.fusionRoutes[2]);
  assert.equal(fusionCatalogOf(fakeState(), s.activeAccountId).selection.fastAllowed, true);
  assert.deepEqual(actual.options.leads[0].variants[1].sidekicks, [{ id: 'swe-2', efforts: ['high'], fastEfforts: ['high'] }]);
  assert.equal(profileFor(s).models.find(m => m.id === 'fusion').contextWindow, 1000000);
  cached.fusionRoutesVersion = 'old';
  assert.equal(fusionCatalogOf(s, s.activeAccountId).selection.config.sidekickEffort, 'medium');
  s.settings.serverUrl = 'https://custom.example';
  assert.equal(fusionCatalogOf(s, s.activeAccountId).selection, null);
  assert.equal(profileFor(s).models.some(m => m.id === 'fusion'), false);
});

test('仅接受有效 Fusion UID，从 CLI 去重提取组合', () => {
  const route = 'fusion-gemini-4-neon-high-sidekick-swe-2-1-medium';
  assert.deepEqual(parseFusionRoutesFromFamilies(JSON.stringify({ families: [{ family_uid: 'Fusion', variants: [
    { model_uid: route }, { model_uid: route }, { model_uid: 'fusion-malformed' }
  ] }] })), [route]);
});

test('Sidekick 分配用 field 6；子请求使用其专属模型和 cascadeId', async () => {
  const route = 'fusion-claude-opus-5-5-medium-sidekick-swe-2-1-medium';
  const cascadeId = 'child-cascade';
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/AssignModel')) {
      seen.push(topFields(init.body));
      return new Response(new PB().bytes(1, new PB().str(1, 'assignment').str(2, 'swe-2-1-medium')).done());
    }
    seen.push(topFields(init.body.subarray(5)));
    return new Response(frame(new PB().str(3, '42').varint(5, 1).done()));
  };
  const { modelUid } = await assignModel({ key: 'fake', server: DEFAULT_SERVER, routerUid: route, cascadeId, sidekick: true, fetchImpl });
  class Capture {
    constructor() { this.done = new Promise(resolve => { this.resolve = resolve; }); }
    push(e) { this.last = e; }
    end() { this.resolve(this.last); }
  }
  const stream = streamDevinChat({ model: { api: 'openai-completions', provider: 'devin', id: 'swe-2-1' }, options: {},
    context: { messages: [{ role: 'user', content: 'Return 42.' }] }, fetchImpl,
    resolveCredential: async () => ({ key: 'fake', server: DEFAULT_SERVER }), sidekickRun: { modelUid, cascadeId },
    AssistantMessageEventStream: Capture, calculateCost: () => {} });
  assert.equal((await stream.done).type, 'done');
  assert.equal(seen[0][6], route);
  assert.equal(seen[0][5], undefined);
  assert.equal(seen[1][16], cascadeId);
  assert.equal(seen[1][21], 'swe-2-1-medium');
  assert.equal(seen[1][26], undefined);
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
