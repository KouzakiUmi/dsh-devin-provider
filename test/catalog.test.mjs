import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PB } from '../src/pb.mjs';
import {
  SNAPSHOT_FAMILIES,
  SNAPSHOT_FREE,
  SNAPSHOT_IMAGES,
  SNAPSHOT_PRICES,
  SNAPSHOT_RECOMMENDED,
  effectiveModel,
  fastModelMap,
  getModelRows,
  isFastVariantId,
  listed,
  modelDefaults,
  parseCliCatalog,
  parseConfigFamilies,
  parseFamilies,
  parseFree,
  parseModelConfigs,
  parsePrices,
  parseRecommended,
  profileFor,
  variantFor
} from '../src/catalog.mjs';
import { initialState } from '../src/state.mjs';

test('variantFor resolves family id, DSH off->none, nearest effort, and fast tier', () => {
  // SWE-2.1（最新主力：5 档标准免费 + 5 档 lightning 快速）
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2-1', undefined), 'swe-2-1-medium');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2-1', 'low'), 'swe-2-1-low');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2-1', 'xhigh'), 'swe-2-1-xhigh');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2-1', 'high', { fast: true }), 'swe-2-1-high-lightning');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2-1', undefined, { fast: true }), 'swe-2-1-medium-lightning');

  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', undefined), 'swe-2-high');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', 'medium'), 'swe-2-medium');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', 'low'), 'swe-2-medium');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', 'max'), 'swe-2-max');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'gpt-6-sol', 'off'), 'gpt-6-sol-none');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'claude-opus-5-5-fast', 'xhigh'), 'claude-opus-5-5-xhigh-fast');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'glm-5-2-1m', undefined), 'glm-5-2-1m');
  // 快速模式（Lightning / Fast / Priority）按思考深度映射
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', 'high', { fast: true }), 'swe-2-high-lightning');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2', 'low', { fast: true }), 'swe-2-medium-lightning');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'swe-2-flash', 'max', { fast: true }), 'swe-2-flash-max-lightning');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'claude-opus-5-5', 'medium', { fast: true }), 'claude-opus-5-5-medium-fast');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'gpt-6-astra', 'high', { fast: true }), 'gpt-6-astra-high-priority');
  assert.equal(variantFor(SNAPSHOT_FAMILIES, 'kimi-k3', 'high', { fast: true }), 'kimi-k3-high');

  // 独立 sibling 快速家族折叠（如 swe-1.7 + swe-1.7-lightning / swe-1.6 + swe-1.6-fast）
  const siblingFamilies = [
    { uid: 'swe-1.7', label: 'SWE-1.7', aliases: [], models: [{ id: 'swe-1-7', name: 'SWE-1.7 Max', context: 262000, output: 128000 }, { id: 'swe-1-7-medium', name: 'SWE-1.7 Medium', context: 262000, output: 128000 }] },
    { uid: 'swe-1.7-lightning', label: 'SWE-1.7 Lightning', aliases: [], models: [{ id: 'swe-1-7-lightning', name: 'SWE-1.7 Lightning Max', context: 202752, output: 96000 }, { id: 'swe-1-7-lightning-medium', name: 'SWE-1.7 Lightning Medium', context: 202752, output: 96000 }] },
    { uid: 'swe-1.6', label: 'SWE-1.6', aliases: [], models: [{ id: 'swe-1-6', name: 'SWE-1.6', context: 200000, output: 128000 }] },
    { uid: 'swe-1.6-fast', label: 'SWE-1.6 Fast', aliases: [], models: [{ id: 'swe-1-6-fast', name: 'SWE-1.6 Fast', context: 200000, output: 128000 }] }
  ];
  assert.equal(variantFor(siblingFamilies, 'swe-1.7', 'medium', { fast: true }), 'swe-1-7-lightning-medium');
  assert.equal(variantFor(siblingFamilies, 'swe-1.7', 'high', { fast: true }), 'swe-1-7-lightning');
  assert.equal(variantFor(siblingFamilies, 'swe-1.6', 'high', { fast: true }), 'swe-1-6-fast');
  assert.equal(fastModelMap(siblingFamilies)['swe-1.7']?.tier, 'lightning');

  const fastMap = fastModelMap(SNAPSHOT_FAMILIES, { fusionFast: true });
  assert.equal(fastMap['swe-2-1']?.tier, 'lightning');
  assert.deepEqual(fastMap['swe-2-1']?.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(fastMap['swe-2']?.tier, 'lightning');
  assert.equal(fastMap['swe-2']?.label, 'Lightning');
  assert.equal(fastMap['swe-2-flash']?.tier, 'lightning');
  assert.equal(fastMap['claude-opus-5-5']?.tier, 'fast');
  assert.equal(fastMap['gpt-6-astra']?.tier, 'priority');
  assert.equal(fastMap.fusion?.tier, 'fast');
  assert.equal(fastMap['kimi-k3'], undefined);
  assert.equal(SNAPSHOT_FREE.includes('swe-2-1-medium'), true);
  assert.equal(SNAPSHOT_FREE.includes('swe-2-high'), true);
  assert.equal(SNAPSHOT_RECOMMENDED.includes('swe-2-1'), true);
  assert.equal(SNAPSHOT_PRICES['swe-2-1-medium-lightning']?.output, 25);
  assert.equal(SNAPSHOT_PRICES['swe-2-medium-lightning']?.output, 5);
});

test('listed collapses families, filters fast/priority models & marks free/prices/fastCost', () => {
  const free = new Set(['swe-2-high', 'swe-2-medium', 'swe-2-max']);
  const prices = new Map([
    ['swe-2-high-lightning', { input: 1, output: 5, cache: { read: 0.1 } }],
    ['swe-2-medium-lightning', { input: 1, output: 5, cache: { read: 0.1 } }],
    ['swe-2-max-lightning', { input: 1, output: 5, cache: { read: 0.1 } }],
    ['claude-opus-5-5-medium', { input: 4, output: 20, cache: { read: 0.2 } }],
    ['claude-opus-5-5-medium-fast', { input: 8, output: 40, cache: { read: 0.4 } }]
  ]);
  const entries = listed(SNAPSHOT_FAMILIES, SNAPSHOT_IMAGES, free, prices);
  const swe = entries.find((m) => m.id === 'swe-2');
  assert.ok(swe);
  assert.equal(swe.free, true);
  assert.equal(swe.image, true);
  assert.deepEqual(swe.efforts, ['medium', 'high', 'max']);
  assert.equal(swe.fastTier, 'lightning');
  assert.deepEqual(swe.fastCost, { input: 1, output: 5, cache: { read: 0.1 } });

  const opus = entries.find((m) => m.id === 'claude-opus-5-5');
  assert.ok(opus);
  assert.deepEqual(opus.cost, { input: 4, output: 20, cache: { read: 0.2 } });
  assert.deepEqual(opus.fastCost, { input: 8, output: 40, cache: { read: 0.4 } });

  const glm1m = entries.find((m) => m.id === 'glm-5-2-1m');
  assert.ok(glm1m);
  assert.equal(glm1m.image, false);

  // 所有快速模式变体均须从模型列表过滤，仅通过 ⚡ 开关启用
  for (const hiddenId of [
    'swe-2-lightning', 'swe-2-flash-lightning', 'claude-opus-5-5-fast',
    'claude-opus-5-fast', 'gpt-6-astra-priority', 'gpt-6-sol-priority',
    'swe-1.7-lightning', 'swe-1-7-lightning', 'swe-1.6-fast', 'swe-1-6-fast'
  ]) {
    assert.equal(entries.some((m) => m.id === hiddenId || isFastVariantId(m.id) && m.id === hiddenId), false, `${hiddenId} 不应出现在列表`);
  }
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
    .varint(11, 1)
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
  assert.deepEqual([...parseRecommended(buf)], ['swe-2']);
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

  const cliCatalog = parseCliCatalog(JSON.stringify({
    families: [
      {
        family_uid: 'swe-2',
        family_label: 'SWE-2',
        variants: [
          { model_uid: 'swe-2-high', label: 'SWE-2 High', cost_tier: 'Free', max_context_tokens: 262000, max_output_tokens: 128000 },
          { model_uid: 'swe-2-high-lightning', label: 'SWE-2 High Lightning', cost_tier: 'High cost', cost_summary: '$1 / 1M Input · $0.1 / 1M Cached input · $5 / 1M Output', max_context_tokens: 262144, max_output_tokens: 128000 }
        ]
      }
    ]
  }));
  assert.deepEqual(cliCatalog.freeIds, ['swe-2-high']);
  assert.deepEqual(cliCatalog.prices['swe-2-high-lightning'], { input: 1, output: 5, cache: { read: 0.1 } });
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

test('getModelRows sorts enabled models first and marks legacy models; profileFor filters legacy models by default', () => {
  const state = initialState();
  assert.equal(state.settings.hideLegacyModels, true);
  state.accounts.push({ id: 'a1', label: 'Main', authMode: 'api-key', credentialStored: true });
  state.activeAccountId = 'a1';
  // 停用排在首位的 swe-2-1 与 claude-opus-5-5，验证已启用模型稳定排在前面、停用模型沉到后面
  state.modelSettings.a1 = {
    'swe-2-1': { enabled: false },
    'claude-opus-5-5': { enabled: false }
  };

  const rows = getModelRows(state, 'a1');
  const firstDisabledIdx = rows.findIndex((r) => !r.enabled);
  assert.ok(firstDisabledIdx > 0, '已启用模型应排在前面');
  assert.equal(rows.slice(0, firstDisabledIdx).every((r) => r.enabled), true);
  assert.equal(rows.slice(firstDisabledIdx).every((r) => !r.enabled), true);
  assert.deepEqual(rows.slice(firstDisabledIdx).map((r) => r.id), ['swe-2-1', 'claude-opus-5-5']);

  // 推荐模型 legacy === false，老旧模型 legacy === true
  assert.equal(rows.find((r) => r.id === 'swe-2-1')?.legacy, false);
  assert.equal(rows.find((r) => r.id === 'swe-2')?.legacy, false);
  assert.equal(rows.find((r) => r.id === 'claude-opus-4.6')?.legacy, true);
  assert.equal(rows.find((r) => r.id === 'gpt-5.4')?.legacy, true);
  assert.equal(rows.find((r) => r.id === 'swe-1.7')?.legacy, true);

  // 默认 hideLegacyModels = true：profileFor 过滤老旧模型，保留当前推荐模型 + fusion
  const filteredProfile = profileFor(state);
  assert.equal(filteredProfile.models.some((m) => m.id === 'swe-2'), true);
  assert.equal(filteredProfile.models.some((m) => m.id === 'fusion'), true);
  assert.equal(filteredProfile.models.some((m) => m.id === 'swe-2-1'), false); // 已停用
  assert.equal(filteredProfile.models.some((m) => m.id === 'claude-opus-4.6'), false);
  assert.equal(filteredProfile.models.some((m) => m.id === 'gpt-5.4'), false);

  // 关闭过滤后，已启用的老旧模型进入 profileFor
  state.settings.hideLegacyModels = false;
  const fullProfile = profileFor(state);
  assert.equal(fullProfile.models.some((m) => m.id === 'claude-opus-4.6'), true);
  assert.equal(fullProfile.models.some((m) => m.id === 'gpt-5.4'), true);
  assert.equal(fullProfile.models.some((m) => m.id === 'swe-2-1'), false);

  // 自定义目录无任何推荐命中时不误清空列表
  state.settings.hideLegacyModels = true;
  state.catalogs.a1 = {
    source: 'remote',
    families: [{ uid: 'private-model', label: 'Private', aliases: [], models: [{ id: 'private-model', name: 'Private', context: 128000, output: 16000 }] }],
    images: {},
    freeIds: [],
    prices: {}
  };
  const customProfile = profileFor(state);
  assert.equal(customProfile.models.some((m) => m.id === 'private-model'), true);
});
