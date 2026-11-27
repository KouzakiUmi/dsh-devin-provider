import test from 'node:test';
import assert from 'node:assert/strict';
import { registerFusionHandoff } from '../src/fusion-handoff.mjs';
import { DEFAULT_SERVER, PB, dec, fields } from '../src/pb.mjs';
import { fusionCatalogOf, profileFor } from '../src/catalog.mjs';
import { initialState } from '../src/state.mjs';

function fixture({ returned = 'swe-2-1-medium', stopReason = 'completed', depth = 1, held = false } = {}) {
  const state = initialState();
  const owner = { id: 'account', authMode: 'api-key' };
  state.accounts.push(owner);
  state.activeAccountId = owner.id;
  state.fusion.account = { sidekick: 'swe-2-1' };
  const { selection: fusion } = fusionCatalogOf(state, owner.id);
  const calls = [];
  const runs = new Map();
  let tool, opts, removed, complete, activationDisposed = false;
  const activationResult = new Promise(resolve => { complete = resolve; });
  const parent = { id: 'parent', model: { current: () => ({ provider: 'devin', model: 'fusion' }) } };
  const cleanup = registerFusionHandoff({
    tools: { register(def, options) { tool = def; opts = options; return () => { removed = true; }; } },
    subagents: {
      getProvider: name => name === 'spawn' && { capabilities: { agentOptions: true, depthLimit: true } },
      resolveMaxDepth: () => depth,
      async startActivation(args) {
        calls.push(args);
        assert.equal(runs.get(args.childId).modelUid, returned);
        if (!held) complete({ stopReason, output: [{ type: 'text', text: '42' }] });
        return { result: activationResult, async dispose() { activationDisposed = true; complete({ stopReason: 'cancelled' }); } };
      }
    }
  }, {
    runs, live: () => ({ fusion, owner, profile: profileFor(state), fastMode: false }),
    resolveCredential: async () => ({ key: 'test', server: DEFAULT_SERVER }),
    fetchImpl: async (_url, init) => {
      calls.push(Object.fromEntries([...fields(init.body)].filter(f => f.num >= 2).map(f => [f.num, dec.decode(f.data)])));
      return new Response(new PB().bytes(1, new PB().str(1, 'jwt').str(2, returned)).done());
    }
  });
  return { tool, opts, parent, runs, calls, cleanup, removed: () => removed, activationDisposed: () => activationDisposed };
}

test('Sidekick 只向 Fusion 暴露，工具卡显示交接，子代理返回报告供 Lead 审查', async () => {
  const f = fixture();
  try {
    assert.equal(f.opts.when({ agent: f.parent, modelSelection: { provider: 'devin', model: 'swe-2' } }), false);
    assert.equal(f.opts.when({ agent: f.parent, modelSelection: { provider: 'devin', model: 'fusion' } }), true);
    assert.match(f.tool.presentCall({ message: 'calculate' }).title, /正在交接/);
    const result = await f.tool.execute({ message: 'calculate' }, { agent: f.parent, signal: new AbortController().signal });
    assert.deepEqual(result, { model: 'SWE-2.1', report: '42' });
    assert.deepEqual(f.calls[0][2], f.calls[0][6]);
    assert.equal(f.calls[1].agentOptions.model, 'swe-2-1');
    assert.equal(f.calls[1].delivery, 'caller');
    assert.equal(f.calls[1].maxDepth, 1);
    assert.match(f.tool.presentResult(null, { meta: { model: result.model } }).title, /已完成 · SWE-2.1/);
    assert.equal(f.runs.size, 0);
  } finally { f.cleanup(); }
  assert.equal(f.removed(), true);
});

test('副模型分配不符或用户停用子代理时不启动子会话', async () => {
  for (const options of [{ returned: 'other' }, { depth: 0 }]) {
    const f = fixture(options);
    try {
      await assert.rejects(f.tool.execute({ message: 'calculate' }, { agent: f.parent, signal: new AbortController().signal }), /不同的 Sidekick|已停用/);
      assert.equal(f.calls.length, options.depth === 0 ? 0 : 1);
      assert.equal(f.runs.size, 0);
    } finally { f.cleanup(); }
  }
});

test('取消交接时等待子代理退出并回收模型绑定', async () => {
  const f = fixture({ held: true });
  try {
    const control = new AbortController();
    const result = f.tool.execute({ message: 'calculate' }, { agent: f.parent, signal: control.signal });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.runs.size, 1);
    control.abort();
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(f.activationDisposed(), true);
    assert.equal(f.runs.size, 0);
  } finally { f.cleanup(); }
});
