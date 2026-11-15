import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// This test runs under DSH_NODE_EXECUTABLE with ELECTRON_RUN_AS_NODE=1 and DSH_INSTALL_DIR set,
// exercising real @deepseek-ai/dsh-llm, @deepseek-ai/dsh-llm-pi-ai, and @earendil-works/pi-ai.
const hasDshRuntime = Boolean(process.env.DSH_INSTALL_DIR && process.versions.electron);

if (hasDshRuntime) {
  const anchorUrl = pathToFileURL(join(process.env.DSH_INSTALL_DIR, 'package.json')).href;
  const loaderCode = `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@earendil-works/')) {
        return nextResolve(specifier, { ...context, parentURL: ${JSON.stringify(anchorUrl)} });
      }
      return nextResolve(specifier, context);
    }
  `;
  module.register('data:text/javascript;base64,' + Buffer.from(loaderCode).toString('base64'));
}

test('Real DSH Core integration: DevinAdapter + PiAiAdapter + devin-wire stream', { skip: !hasDshRuntime }, async () => {
  const { LlmAdapter, LlmError, resolveRetryPolicy } = await import('@deepseek-ai/dsh-llm');
  const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai');
  const { AssistantMessageEventStream, InMemoryCredentialStore, calculateCost } = await import('@earendil-works/pi-ai');

  const { PB, frame, fields, dec } = await import('../src/pb.mjs');
  const { createDevinAdapter } = await import('../src/devin-adapter.mjs');
  const { getModelRows, profileFor } = await import('../src/catalog.mjs');
  const { initialState } = await import('../src/state.mjs');

  const state = initialState();
  state.accounts.push({ id: 'a1', label: 'Test', authMode: 'api-key', credentialStored: true });
  state.activeAccountId = 'a1';
  state.modelSettings.a1 = {
    'gpt-6-sol': { toolsEnabled: false },
    'swe-2': { defaultReasoning: 'medium' }
  };

  const profile = profileFor(state);
  const facts = new Map(getModelRows(state, 'a1').map((r) => [r.id, r]));

  let lastRequestUrl = '';
  let lastRequestPb = null;
  const mockFetch = async (url, init) => {
    lastRequestUrl = url;
    lastRequestPb = init.body.slice(5);
    const usagePb = new PB().varint(2, 12).varint(3, 5).varint(4, 0).varint(5, 8).done();
    const f1 = frame(new PB().str(9, 'thinking...').done());
    const f2 = frame(new PB().str(3, 'Hello from Devin!').done());
    const f3 = frame(new PB().varint(5, 1).bytes(7, usagePb).done());
    return new Response(
      new ReadableStream({
        start(ctl) {
          ctl.enqueue(f1);
          ctl.enqueue(f2);
          ctl.enqueue(f3);
          ctl.close();
        }
      }),
      { status: 200 }
    );
  };

  const adapter = createDevinAdapter(
    { LlmAdapter, LlmError, PiAiAdapter, InMemoryCredentialStore, AssistantMessageEventStream, calculateCost, resolveRetryPolicy },
    {
      profile,
      facts,
      resolveCredential: async () => ({ key: 'cog_test_token', server: 'https://server.codeium.com' }),
      keepalive: { enabled: false },
      fetchImpl: mockFetch
    }
  );

  // 1. listModels & resolveModel
  const models = await adapter.listModels('devin');
  assert.ok(models.length > 30);
  const resolved = await adapter.resolveModel('devin', 'gpt-6-sol');
  assert.ok(resolved.reasoning.efforts.some((e) => e.id === 'off'));

  // 2. prepareCall + stream with explicit 'off' reasoningEffort -> maps to gpt-6-sol-none (tools disabled on gpt-6-sol)
  const prepared = await adapter.prepareCall('devin', 'gpt-6-sol');
  const chunks = [];
  for await (const ch of prepared.stream({
    provider: 'devin',
    model: 'gpt-6-sol',
    reasoningEffort: 'off',
    tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]
  })) {
    chunks.push(ch);
  }
  assert.ok(lastRequestUrl.endsWith('/GetChatMessage'));
  const reqFields = fields(lastRequestPb);
  const modelUidField = reqFields.find((f) => f.num === 21);
  assert.equal(dec.decode(modelUidField.data), 'gpt-6-sol-none');
  assert.equal(reqFields.filter((f) => f.num === 10).length, 0);

  // 2b. swe-2 (toolsEnabled: true) forwards tools through PiAiAdapter TranscriptContext into field 10
  const prepSwe = await adapter.prepareCall('devin', 'swe-2');
  for await (const _ of prepSwe.stream({
    provider: 'devin',
    model: 'swe-2',
    tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]
  })) {}
  const sweFields = fields(lastRequestPb);
  const toolFields = sweFields.filter((f) => f.num === 10);
  assert.equal(toolFields.length, 1);
  assert.equal(dec.decode(fields(toolFields[0].data).find((x) => x.num === 1).data), 'read');

  assert.ok(chunks.some((c) => c.type === 'reasoning-delta' && c.text === 'thinking...'));
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'Hello from Devin!'));
  const finish = chunks.find((c) => c.type === 'finish');
  assert.equal(finish?.reason?.kind, 'stop');
  assert.equal(chunks.find((c) => c.type === 'usage')?.usage?.cacheReadTokens, 8);

  // 3. Also test tool call blocking when toolsEnabled === false
  const toolFetch = async () => {
    const tc = new PB().str(1, 'call_1').str(2, 'Bash').bytes(3, '{"cmd":"ls"}').done();
    const f1 = frame(new PB().bytes(6, tc).varint(5, 10).done());
    return new Response(
      new ReadableStream({
        start(ctl) {
          ctl.enqueue(f1);
          ctl.close();
        }
      }),
      { status: 200 }
    );
  };
  const blockedAdapter = createDevinAdapter(
    { LlmAdapter, LlmError, PiAiAdapter, InMemoryCredentialStore, AssistantMessageEventStream, calculateCost, resolveRetryPolicy },
    {
      profile,
      facts,
      resolveCredential: async () => ({ key: 'cog_test_token', server: 'https://server.codeium.com' }),
      keepalive: { enabled: false },
      fetchImpl: toolFetch
    }
  );
  await assert.rejects(async () => {
    for await (const _ of blockedAdapter.stream({
      provider: 'devin',
      model: 'gpt-6-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Run' }] }]
    })) {}
  }, /工具调用/);
  blockedAdapter.dispose();
  adapter.dispose();

  // 4. Verify src/index.mjs exports & Config schema parse under real DSH runtime
  const hostMod = await import('../src/index.mjs');
  assert.equal(hostMod.name, 'dsh-devin-provider');
  assert.deepEqual(hostMod.inject, ['llm']);
  assert.equal(typeof hostMod.apply, 'function');
  const parsedCfg = hostMod.Config({});
  assert.equal(parsedCfg.statePath, '');
  assert.equal(parsedCfg.devinCliPath, '');

  // 5. Verify DSH plugin-manager / app-boot compatibility check passes for current host
  const boot = await import('@deepseek-ai/dsh-app-boot');
  const devinPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const runtimeVersion = boot.getDshRuntimeVersion(process.env.DSH_INSTALL_DIR);
  assert.equal(boot.evaluatePluginCompatibility(devinPkg, {}, runtimeVersion), undefined);
});
