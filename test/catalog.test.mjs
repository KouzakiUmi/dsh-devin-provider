import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PB } from '../src/pb.mjs';
import {
  SNAPSHOT_FAMILIES,
  SNAPSHOT_IMAGES,
  effectiveModel,
  getModelRows,
  listed,
  modelDefaults,
  parseConfigFamilies,
  parseFamilies,
  parseFree,
  parseModelConfigs,
  parsePrices,
  profileFor,
  variantFor
} from '../src/catalog.mjs';
import { initialState } from '../src/state.mjs';

test('variantFor resolves family id, DSH off->none, nearest effort, and fast tier', () => {
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', undefined), 'swe-2-high');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', 'medium'), 'swe-2-medium');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', 'low'), 'swe-2-medium');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', 'max'), 'swe-2-max');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'gpt-6-sol', 'off'), 'gpt-6-sol-none');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'claude-opus-5-5-fast', 'xhigh'), 'claude-opus-5-5-xhigh-fast');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'glm-5-2-1m', undefined), 'glm-5-2-1m');
});

test('listed collapses families, keeps fast/priority & no-effort variants, and marks free/prices', () => {
  const free = new Set(['swe-2-high', 'swe-2-medium', 'swe-2-max']);
  const prices = new Map([['claude-opus-5-5-medium', { input: 5, output: 25, cache: { read: 0.5 } }]]);
  const entries = listed(SNAPSHOT_FAMILIES, SNAPSHOT_IMAGES, free, prices);
  const swe = entries.find((m) => m.id === 'swe-2');
  assert.ok(swe);
  assert.equal(swe.free, true);
  assert.equal(swe.image, true);
  assert.deepEqual(swe.efforts, ['medium', 'high', 'max']);

  const glm1m = entries.find((m) => m.id === 'glm-5-2-1m');
  assert.ok(glm1m);
  assert.equal(glm1m.image, false);

  const opusFast = entries.find((m) => m.id === 'claude-opus-5-5-fast');
  assert.ok(opusFast);
  assert.deepEqual(opusFast.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('listed marks partially-free and mixed-price families', () => {
  const free = new Set(['swe-2-high']);
  const prices = new Map([
    ['swe-2-medium', { input: 1, output: 2, cache: { read: 0 } }],
    ['swe-2-high', { input: 3, output: 4, cache: { read: 0 } }]
  ]);
  const entries = listed(SNAPSHOT_FAMILIES, SNAPSHOT_IMAGES, free, prices);
  const swe = entries.find((m) => m.id === 'swe-2');
  assert.ok(swe);
  assert.equal(swe.free, undefined);
  assert.equal(swe.mixedFree, true);
  assert.equal(swe.cost, undefined);
  assert.equal(swe.mixedCost, true);
});

test('protobuf GetCliModelConfigs parsers read images, free tier, prices, and families', () => {
  const floatBytes = new Uint8Array(4);
  new DataView(floatBytes.buffer).setFloat32(0, 3.5, true);
  const priceMsg = new PB().str(1, 'Input').bytes(2, floatBytes).str(3, '1M tokens').done();
  // Wait: PB.bytes writes wire type 2, whereas field 2 in priceMsg is fixed32 (wire type 5)!
  // Let's hand-encode wire type 5 for field 2: tag = (2 << 3) | 5 = 0x15
  const fixedPrice = Uint8Array.from([
    ...new PB().str(1, 'Input').done(),
    0x15, ...floatBytes,
    ...new PB().str(3, '1M tokens').done()
  ]);

  const cfg1 = new PB()
    .str(1, 'SWE-2 High')
    .varint(5, 1)
    .varint(18, 262000)
    .str(22, 'swe-2-high')
    .bytes(23, new PB().varint(13, 128000).str(23, 'swe-2'))
    .varint(24, 4)
    .bytes(30, new PB().str(1, 'SWE-2'))
    .done();
  const cfg2 = new PB()
    .str(1, 'Custom Model')
    .varint(5, 0)
    .varint(18, 128000)
    .str(22, 'custom-high')
    .bytes(23, new PB().varint(13, 32000).str(23, 'custom'))
    .bytes(30, new PB().str(1, 'Custom'))
    .bytes(32, fixedPrice)
    .done();

  const buf = new PB().bytes(1, cfg1).bytes(1, cfg2).done();
  assert.deepEqual(parseModelConfigs(buf), { 'swe-2-high': true, 'custom-high': false });
  assert.deepEqual([...parseFree(buf)], ['swe-2-high']);
  const prices = parsePrices(buf);
  assert.equal(prices.get('custom-high')?.input, 3.5);
  const fams = parseConfigFamilies(buf);
  assert.equal(fams.length, 2);
  assert.equal(fams[0].uid, 'swe-2');
  assert.equal(fams[1].models[0].output, 32000);
});

test('parseFamilies filters adaptive/fusion and parses devin models list JSON', () => {
  const json = JSON.stringify({
    families: [
      { family_uid: 'adaptive', family_label: 'Adaptive', variants: [{ model_uid: 'adaptive-1' }] },
      { family_uid: 'fusion', family_label: 'Fusion', variants: [{ model_uid: 'fusion-1' }] },
      {
        family_uid: 'swe-2',
        family_label: 'SWE-2',
        aliases: ['swe'],
        variants: [{ model_uid: 'swe-2-high', label: 'SWE-2 High', max_context_tokens: 262000, max_output_tokens: 128000 }]
      }
    ]
  });
  const parsed = parseFamilies(json);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].uid, 'swe-2');
  assert.equal(parsed[0].models[0].context, 262000);
});

test('per-model defaults, overrides, and profileFor filtering', () => {
  const state = initialState();
  state.accounts.push({ id: 'a1', label: 'Main', authMode: 'api-key', credentialStored: true });
  state.activeAccountId = 'a1';
  state.modelSettings.a1 = {
    'swe-2': { enabled: false },
    'gpt-6-sol': { contextWindow: 500000, maxTokens: 64000, imageInput: false, toolsEnabled: false, defaultReasoning: 'off' }
  };

  const rows = getModelRows(state, 'a1');
  const sol = rows.find((r) => r.id === 'gpt-6-sol');
  assert.ok(sol);
  assert.equal(sol.effective.contextWindow, 500000);
  assert.equal(sol.effective.maxTokens, 64000);
  assert.equal(sol.effective.imageInput, false);
  assert.equal(sol.effective.toolsEnabled, false);
  assert.equal(sol.effective.defaultReasoning, 'off');

  const profile = profileFor(state);
  assert.ok(profile);
  assert.equal(profile.provider, 'devin');
  assert.equal(profile.models.some((m) => m.id === 'swe-2'), false);
  const coreSol = profile.models.find((m) => m.id === 'gpt-6-sol');
  assert.ok(coreSol);
  assert.deepEqual(coreSol.input, ['text']);
  assert.equal(coreSol.contextWindow, 500000);
  assert.equal(coreSol.reasoningEfforts.off, 'none');

  const d = modelDefaults({ context: 100000, output: 16000, efforts: ['low', 'high'], image: true });
  const eff = effectiveModel(d, { maxTokens: 8000 });
  assert.equal(eff.maxTokens, 8000);
  assert.equal(eff.imageInput, true);
});
