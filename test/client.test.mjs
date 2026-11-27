import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function createMiniReact() {
  const instances = new Map();
  const pendingEffects = [];
  let current = null;
  let dirty = false;

  const instanceOf = (path) => {
    let inst = instances.get(path);
    if (!inst) {
      inst = { state: [], refs: [], deps: [], callbacks: [], cleanups: [], index: 0 };
      instances.set(path, inst);
    }
    return inst;
  };
  const depsChanged = (inst, idx, deps) => {
    const prev = inst.deps[idx];
    if (!prev || !deps || prev.length !== deps.length) return true;
    return deps.some((d, i) => !Object.is(d, prev[i]));
  };
  function useState(initial) {
    const inst = current;
    const idx = inst.index++;
    if (!(idx in inst.state)) inst.state[idx] = typeof initial === 'function' ? initial() : initial;
    return [
      inst.state[idx],
      (v) => {
        const next = typeof v === 'function' ? v(inst.state[idx]) : v;
        if (!Object.is(next, inst.state[idx])) {
          inst.state[idx] = next;
          dirty = true;
        }
      }
    ];
  }
  function useRef(initial) {
    const inst = current;
    const idx = inst.index++;
    if (!(idx in inst.refs)) inst.refs[idx] = { current: initial };
    return inst.refs[idx];
  }
  function useCallback(fn, deps) {
    const inst = current;
    const idx = inst.index++;
    if (depsChanged(inst, idx, deps)) inst.callbacks[idx] = fn;
    inst.deps[idx] = deps ? [...deps] : undefined;
    return inst.callbacks[idx];
  }
  function useEffect(fn, deps) {
    const inst = current;
    const idx = inst.index++;
    if (!depsChanged(inst, idx, deps)) return;
    inst.deps[idx] = deps ? [...deps] : undefined;
    pendingEffects.push({ inst, idx, fn });
  }
  function useSyncExternalStore(_sub, getSnapshot) {
    return getSnapshot();
  }
  function createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
    return { type, props: props || {}, children: flat };
  }
  function renderNode(node, path = '0') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const inst = instanceOf(path);
      inst.index = 0;
      const prev = current;
      current = inst;
      let rendered;
      try {
        rendered = node.type({ ...node.props, children: node.children });
      } finally {
        current = prev;
      }
      return renderNode(rendered, path + '>0');
    }
    return {
      ...node,
      children: node.children.map((c, i) => renderNode(c, `${path}.${i}`))
    };
  }
  async function flush(rootFactory) {
    let tree;
    for (let i = 0; i < 8; i++) {
      dirty = false;
      tree = renderNode(rootFactory());
      const effects = pendingEffects.splice(0, pendingEffects.length);
      for (const e of effects) {
        if (typeof e.inst.cleanups[e.idx] === 'function') e.inst.cleanups[e.idx]();
        e.inst.cleanups[e.idx] = e.fn();
      }
      await tick(5);
      if (!dirty && !pendingEffects.length) break;
    }
    return tree;
  }
  function unmountAll() {
    for (const inst of instances.values()) {
      for (const c of inst.cleanups) if (typeof c === 'function') c();
    }
  }
  return { React: { createElement, useState, useRef, useCallback, useEffect, useSyncExternalStore }, flush, unmountAll };
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) findAll(c, pred, out);
  return out;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return (node.children ?? []).map(textOf).join('');
}

test('src/client.js mounts settings.section, renders quota/keepalive/models/accounts and invokes RPCs', async () => {
  const remote = readSource('src/remote.mjs').replace(/^export /gm, '');
  const client = readSource('src/client.js').replace(/^export /gm, '');
  const wrapped = `(require, React) => {\n'use strict';\n${remote}\n${client}\nreturn { name, inject, apply, DevinProviderSection };\n}`;
  const factory = eval(wrapped);
  const mini = createMiniReact();
  const mod = factory(() => mini.React, mini.React);

  const calls = [];
  const cachedQuota = {
    accountId: 'a1',
    state: 'ok',
    stale: true,
    updatedAt: new Date().toISOString(),
    windows: [{ kind: '1d', label: '每日额度', usedPercent: 10, remainingPercent: 90 }]
  };
  const refreshedQuota = {
    accountId: 'a1',
    state: 'ok',
    stale: false,
    updatedAt: new Date().toISOString(),
    windows: [{ kind: '1d', label: '每日额度', usedPercent: 20, remainingPercent: 80 }],
    overageBalance: '$5.00'
  };
  const snapshot = {
    revision: 'r1',
    route: 'devin',
    enabled: true,
    activeAccountId: 'a1',
    accounts: [{ id: 'a1', label: 'Devin Pro', displayName: 'u@example.com', authMode: 'oauth', hasCredential: true }],
    settings: { cacheKeepalive: { enabled: false, intervalSec: 285, maxPings: 6 }, serverUrl: '' },
    quotas: { a1: cachedQuota },
    fastSessionsCount: 1,
    catalogs: [
      {
        accountId: 'a1',
        count: 2,
        enabledCount: 2,
        source: 'local-snapshot',
        models: [
          {
            id: 'swe-2',
            name: 'SWE-2',
            free: true,
            fastTier: 'lightning',
            fastLabel: 'Lightning',
            fastCost: { input: 1, output: 5, cache: { read: 0.1 } },
            enabled: true,
            settings: {},
            defaults: { contextWindow: 262000, maxTokens: 128000, imageInput: true, toolsEnabled: true, reasoningEfforts: { medium: 'medium', high: 'high', max: 'max' }, defaultReasoning: null },
            effective: { contextWindow: 262000, maxTokens: 128000, imageInput: true, toolsEnabled: true, reasoningEfforts: { medium: 'medium', high: 'high', max: 'max' }, defaultReasoning: null }
          },
          {
            id: 'claude-opus-5-5',
            name: 'Claude Opus 5.5',
            free: false,
            cost: { input: 4, output: 20, cache: { read: 0.2 } },
            fastTier: 'fast',
            fastLabel: 'Fast',
            fastCost: { input: 8, output: 40, cache: { read: 0.4 } },
            enabled: true,
            settings: {},
            defaults: { contextWindow: 1000000, maxTokens: 128000, imageInput: true, toolsEnabled: true, reasoningEfforts: { medium: 'medium', high: 'high' }, defaultReasoning: null },
            effective: { contextWindow: 1000000, maxTokens: 128000, imageInput: true, toolsEnabled: true, reasoningEfforts: { medium: 'medium', high: 'high' }, defaultReasoning: null }
          }
        ]
      }
    ],
    login: { jobId: null, accountId: null, state: 'idle', message: '', url: null }
  };

  let slotEntry = null;
  const ctx = {
    effect(fn) { fn(); },
    get(name) {
      if (name === 'remote.devinProvider') {
        return {
          invoke: async (req) => {
            calls.push(req);
            if (req.op === 'read') return { ok: true, value: snapshot };
            if (req.op === 'readQuota') return { ok: true, value: refreshedQuota };
            if (req.op === 'pullQuota') return { ok: true, value: refreshedQuota };
            if (req.op === 'saveSettings') {
              return { ok: true, value: { ...snapshot, revision: 'r2', settings: req.settings } };
            }
            return { ok: true, value: snapshot };
          }
        };
      }
      return null;
    },
    inject() {},
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (_id, cb) => cb(),
      register: (meta, comp) => {
        slotEntry = { meta, comp };
        return () => {};
      }
    }
  };

  try {
    mod.apply(ctx);
    assert.equal(slotEntry.meta.id, 'devin-provider');
    assert.equal(slotEntry.meta.label(), 'Devin Provider');
    const injected = slotEntry.meta.inject();

    let tree = await mini.flush(() => mini.React.createElement(slotEntry.comp, injected));
    assert.ok(textOf(tree).includes('Devin Provider'));
    assert.ok(calls.some((c) => c.op === 'read'));
    // 打开设置时直接使用持久化 quotas 快照，绝不强行发起 pullQuota/quota 请求
    assert.equal(calls.some((c) => c.op === 'pullQuota' || c.op === 'quota'), false);
    assert.ok(textOf(tree).includes('90%'));

    // 模型名称下方直接展示标准/快速价格标签，不再渲染重复的「模型价格表」独立区块
    assert.equal(textOf(tree).includes('模型价格表'), false);
    assert.ok(textOf(tree).includes('标准免费'));
    assert.ok(textOf(tree).includes('⚡ Lightning $1 / $0.1 / $5/1M'));
    assert.ok(textOf(tree).includes('标准 $4 / $0.2 / $20/1M'));
    assert.ok(textOf(tree).includes('⚡ Fast $8 / $0.4 / $40/1M'));
    assert.ok(textOf(tree).includes('按会话独立设置'));

    // 点击「刷新额度」触发解耦后的 pullQuota，且不泄露事件循环引用
    const quotaBtn = findAll(tree, (n) => n.type === 'button' && textOf(n).includes('刷新额度'))[0];
    assert.ok(quotaBtn);
    const fakeEvent = { target: { __reactFiber: null } };
    fakeEvent.target.__reactFiber = fakeEvent;
    quotaBtn.props.onClick(fakeEvent);
    tree = await mini.flush(() => mini.React.createElement(slotEntry.comp, injected));
    assert.doesNotThrow(() => JSON.stringify(calls));
    assert.equal(calls.find((c) => c.op === 'pullQuota')?.force, true);
    assert.ok(textOf(tree).includes('80%'));
    assert.ok(textOf(tree).includes('$5.00'));

    // Save keepalive settings
    const saveSettingsBtn = findAll(tree, (n) => n.type === 'button' && textOf(n).includes('保存保活与服务设置'))[0];
    assert.ok(saveSettingsBtn);
    saveSettingsBtn.props.onClick();
    tree = await mini.flush(() => mini.React.createElement(slotEntry.comp, injected));
    assert.ok(calls.some((c) => c.op === 'saveSettings'));
  } finally {
    mini.unmountAll();
  }
});

test('Model catalog defaults to filtering legacy models, sorts enabled models first, and toggles setHideLegacyModels', async () => {
  const remote = readSource('src/remote.mjs').replace(/^export /gm, '');
  const client = readSource('src/client.js').replace(/^export /gm, '');
  const wrapped = `(require, React) => {\n'use strict';\n${remote}\n${client}\nreturn { name, inject, apply };\n}`;
  const mini = createMiniReact();
  const mod = eval(wrapped)(() => mini.React, mini.React);

  const calls = [];
  let hideLegacy = true;
  const makeModel = (id, name, { enabled = true, legacy = false } = {}) => ({
    id,
    name,
    free: false,
    legacy,
    enabled,
    settings: enabled ? {} : { enabled: false },
    defaults: { contextWindow: 262144, maxTokens: 65536, imageInput: true, toolsEnabled: true, reasoningEfforts: { medium: 'medium', high: 'high' }, defaultReasoning: null },
    effective: { contextWindow: 262144, maxTokens: 65536, imageInput: true, toolsEnabled: true, reasoningEfforts: { medium: 'medium', high: 'high' }, defaultReasoning: null }
  });
  const makeSnapshot = () => ({
    revision: hideLegacy ? 'r-on' : 'r-off',
    route: 'devin',
    enabled: true,
    activeAccountId: 'a1',
    accounts: [{ id: 'a1', label: 'Devin', displayName: 'u@example.com', authMode: 'oauth', hasCredential: true }],
    settings: { cacheKeepalive: { enabled: false, intervalSec: 285, maxPings: 6 }, serverUrl: '', hideLegacyModels: hideLegacy },
    quotas: {},
    fastSessionsCount: 0,
    catalogs: [{
      accountId: 'a1',
      count: 4,
      source: 'remote',
      // 故意把已停用模型放在前面，验证前端渲染仍保证已启用置顶
      models: [
        makeModel('swe-2', 'SWE-2', { enabled: false, legacy: false }),
        makeModel('swe-2-1', 'SWE-2.1', { enabled: true, legacy: false }),
        makeModel('claude-opus-4.6', 'Claude Opus 4.6', { enabled: true, legacy: true }),
        makeModel('claude-opus-5-5', 'Claude Opus 5.5', { enabled: true, legacy: false })
      ]
    }],
    login: { jobId: null, accountId: null, state: 'idle', message: '', url: null }
  });

  let slotEntry = null;
  const ctx = {
    effect(fn) { fn(); },
    get(name) {
      if (name === 'remote.devinProvider') {
        return {
          invoke: async (req) => {
            calls.push(req);
            if (req.op === 'setHideLegacyModels') hideLegacy = Boolean(req.enabled);
            return { ok: true, value: makeSnapshot() };
          }
        };
      }
      return null;
    },
    inject() {},
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (_id, cb) => cb(),
      register: (meta, comp) => { slotEntry = { meta, comp }; return () => {}; }
    }
  };

  try {
    mod.apply(ctx);
    const injected = slotEntry.meta.inject();
    let tree = await mini.flush(() => mini.React.createElement(slotEntry.comp, injected));

    // 默认开启过滤老旧模型开关
    const filterSwitch = findAll(tree, (n) => n.type === 'input' && n.props?.['aria-label'] === '过滤老旧模型')[0];
    assert.ok(filterSwitch, '应渲染「过滤老旧模型」开关');
    assert.equal(filterSwitch.props.checked, true);

    const renderedIds = (t) => findAll(t, (n) => n.props?.className === 'ddp-model-id').map(textOf);
    // 开启过滤时只展示 3 个主力模型，且已启用的 swe-2-1 / claude-opus-5-5 排在已停用的 swe-2 前面
    assert.deepEqual(renderedIds(tree), ['swe-2-1', 'claude-opus-5-5', 'swe-2']);
    assert.equal(textOf(tree).includes('Claude Opus 4.6'), false);

    // 关闭过滤开关后触发 setHideLegacyModels(false)，显示老旧模型并带「老旧」标签，且已启用依然排在前面
    filterSwitch.props.onChange({ target: { checked: false } });
    tree = await mini.flush(() => mini.React.createElement(slotEntry.comp, injected));
    assert.ok(calls.some((c) => c.op === 'setHideLegacyModels' && c.enabled === false));
    assert.deepEqual(renderedIds(tree), ['swe-2-1', 'claude-opus-4.6', 'claude-opus-5-5', 'swe-2']);
    assert.ok(textOf(tree).includes('老旧'));
  } finally {
    mini.unmountAll();
  }
});

test('FusionPillEntry shows lightning button only for fast-capable models and toggles setFastMode', async () => {
  const remote = readSource('src/remote.mjs').replace(/^export /gm, '');
  const client = readSource('src/client.js').replace(/^export /gm, '');
  const wrapped = `(require, React) => {\n'use strict';\n${remote}\n${client}\nreturn { name, inject, apply };\n}`;
  const mini = createMiniReact();
  const mod = eval(wrapped)(() => mini.React, mini.React);

  const calls = [];
  const fastBySession = {};
  let currentModel = 'swe-2';
  const baseSnap = (sid) => ({
    revision: 'r1',
    route: 'devin',
    enabled: true,
    activeAccountId: 'a1',
    fastMode: Boolean(sid && fastBySession[sid]),
    fastModels: {
      'swe-2': { tier: 'lightning', label: 'Lightning', efforts: ['medium', 'high', 'max'] },
      fusion: { tier: 'fast', label: 'Fast', efforts: [] }
    },
    fusion: {
      config: { lead: 'claude-opus-5-5', leadEffort: 'medium', sidekick: 'swe-2', sidekickEffort: 'medium' },
      options: {
        leads: [{
          id: 'claude-opus-5-5', name: 'Claude Opus 5.5', variants: [
            { effort: 'medium', sidekicks: [{ id: 'swe-2', efforts: ['medium'], fastEfforts: [] }] },
            { effort: 'high', sidekicks: [{ id: 'gpt-6-luna', efforts: ['high'], fastEfforts: ['high'] }] }
          ]
        }],
        sidekicks: [
          { id: 'swe-2', name: 'SWE-2', efforts: ['medium', 'high'] },
          { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['high'] }
        ]
      }
    }
  });

  let pillEntry = null;
  const scope = {
    effect(fn) { fn(); },
    modelDirectories: {
      directoryFor: () => ({
        store: {
          subscribe: () => () => {},
          getSnapshot: () => ({ current: { provider: 'devin', model: currentModel } })
        }
      })
    },
    slots: {
      inject: (_id, cb) => cb(),
      register: (meta, comp) => { pillEntry = { meta, comp }; return () => {}; }
    }
  };
  const ctx = {
    effect(fn) { fn(); },
    get(name) {
      if (name === 'remote.devinProvider') {
        return {
          invoke: async (req) => {
            calls.push(req);
            if (req.op === 'setFastMode' && req.sessionId) fastBySession[req.sessionId] = Boolean(req.enabled);
            return { ok: true, value: baseSnap(req.sessionId) };
          }
        };
      }
      return null;
    },
    inject(deps, fn) {
      if (deps.includes('modelDirectories')) fn(scope);
    },
    remote: { $mount: async () => () => {} },
    slots: { inject: (_id, cb) => cb(), register: () => () => {} }
  };

  try {
    mod.apply(ctx);
    assert.equal(pillEntry.meta.id, 'devin-fusion');
    const injected1 = pillEntry.meta.inject('sess-1');
    const injected2 = pillEntry.meta.inject('sess-2');
    assert.equal(injected1.sessionId, 'sess-1');

    const hasClass = (node, token) => String(node?.props?.className || '').split(/\s+/).includes(token);
    // 1) swe-2 supports Lightning: shows ⚡ button only (NO Fusion selector bar until fusion model is selected)
    let tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    const fastBtn = findAll(tree, (n) => n.type === 'button' && hasClass(n, 'ddp-fast-btn'))[0];
    assert.ok(fastBtn, 'swe-2 应显示 ⚡ 按钮');
    assert.equal(findAll(tree, (n) => n.type === 'button' && hasClass(n, 'ddp-fusion-trigger')).length, 0, '非 Fusion 模型不应显示 Fusion 模式选择条');
    assert.equal(fastBtn.props['aria-pressed'], false);

    fastBtn.props.onClick();
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    assert.ok(calls.some((c) => c.op === 'setFastMode' && c.sessionId === 'sess-1' && c.enabled === true));
    const fastBtnOn = findAll(tree, (n) => n.type === 'button' && hasClass(n, 'ddp-fast-btn'))[0];
    assert.equal(fastBtnOn.props['aria-pressed'], true);

    // 切换至另一个会话 sess-2 时必须独立，不继承 sess-1 的 ⚡ 开关
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected2));
    const fastBtnS2 = findAll(tree, (n) => n.type === 'button' && hasClass(n, 'ddp-fast-btn'))[0];
    assert.equal(fastBtnS2.props['aria-pressed'], false);

    // 2) Unsupported non-fusion model hides both ⚡ button and Fusion trigger completely
    currentModel = 'kimi-k3';
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    assert.equal(tree, null, '不支持快速模式且非 Fusion 模型时应完全隐藏药丸');
    assert.equal(findAll(tree, (n) => n.type === 'button' && hasClass(n, 'ddp-fast-btn')).length, 0);
    assert.equal(findAll(tree, (n) => n.type === 'button' && hasClass(n, 'ddp-fusion-trigger')).length, 0);

    // 3) Selecting fusion shows ⚡ button + Fusion bar, and opens popover without duplicate fast toggle
    currentModel = 'fusion';
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    assert.equal(findAll(tree, (n) => n.type === 'button' && hasClass(n, 'ddp-fast-btn')).length, 1);
    const pillTriggerActive = findAll(tree, (n) => n.type === 'button' && hasClass(n, 'ddp-fusion-trigger'))[0];
    assert.ok(pillTriggerActive);
    assert.equal(pillTriggerActive.props['data-active'], 'true');
    assert.equal(textOf(pillTriggerActive), 'Claude Opus 5.5 + SWE-2');
    assert.equal(textOf(pillTriggerActive).includes('Fusion:'), false);
    pillTriggerActive.props.onClick();
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    const popover = findAll(tree, (n) => hasClass(n, 'ddp-fusion-popover'))[0];
    assert.ok(popover, '点击 Fusion 药丸应展开统一样式的 .ddp-fusion-popover');
    assert.ok(findAll(popover, (n) => hasClass(n, 'ddp-pop-head')).length === 1);
    assert.ok(findAll(popover, (n) => hasClass(n, 'ddp-pop-close')).length === 1);
    assert.ok(textOf(popover).includes('Devin · Fusion'));
    assert.ok(textOf(popover).includes('Lead 主模型'));
    assert.ok(textOf(popover).includes('Sidekick 副模型'));
    assert.equal(textOf(popover).includes('本会话快速模式'), false, 'Fusion 弹窗内不应重复显示快速模式开关');
    assert.equal(findAll(popover, (n) => n.type === 'input' && n.props?.type === 'checkbox').length, 0);
    assert.ok(findAll(popover, (n) => hasClass(n, 'ddp-pop-foot')).length === 1);
    // 官方组合表限制：Lead 的 sidekick 下拉只保留允许项，未允许的 sidekick 不出现
    assert.ok(textOf(popover).includes('SWE-2'));
    assert.equal(textOf(popover).includes('GPT-6 Luna'), false, '未在该 Lead 官方搭配中的 sidekick 不应出现在下拉');
    assert.equal(textOf(popover).includes('支持 ⚡ 快速模式'), false, '当前 sidekick 没有 fast 组合时不显示快速模式提示');
    findAll(popover, (n) => n.type === 'select')[1].props.onChange({ target: { value: 'high' } });
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    const changed = findAll(tree, (n) => hasClass(n, 'ddp-fusion-popover'))[0];
    assert.deepEqual(findAll(changed, (n) => n.type === 'select').map(n => n.props.value), ['claude-opus-5-5', 'high', 'gpt-6-luna', 'high']);
    assert.ok(textOf(changed).includes('支持 ⚡ Fast'));

    // 切离 fusion 模型时自动收起弹窗并隐藏选择条
    currentModel = 'swe-2';
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    assert.equal(findAll(tree, (n) => hasClass(n, 'ddp-fusion-trigger')).length, 0);
    assert.equal(findAll(tree, (n) => hasClass(n, 'ddp-fusion-popover')).length, 0);

    currentModel = 'fusion';
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    findAll(tree, (n) => n.type === 'button' && hasClass(n, 'ddp-fusion-trigger'))[0].props.onClick();
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    const popoverAgain = findAll(tree, (n) => hasClass(n, 'ddp-fusion-popover'))[0];
    const saveBtn = findAll(popoverAgain, (n) => n.type === 'button' && hasClass(n, 'ddp-pop-btn-primary'))[0];
    assert.ok(saveBtn);
    saveBtn.props.onClick();
    tree = await mini.flush(() => mini.React.createElement(pillEntry.comp, injected1));
    assert.ok(calls.some((c) => c.op === 'saveFusion'));
    assert.equal(findAll(tree, (n) => hasClass(n, 'ddp-fusion-popover')).length, 0);
  } finally {
    mini.unmountAll();
  }
});

test('CLIENT_STYLES keeps pill typography compact and popover right-aligned without fixed offset drift', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes(':where(.ddp-fusion-wrap,.ddp-fusion-popover) :is(button,select,input)'), '基础字体重置应使用 :where 零权重');
  assert.ok(src.includes('.ddp-fusion-trigger{display:inline-flex;align-items:center;gap:6px;min-height:24px;max-width:min(46vw,240px);padding:3px 10px 3px 8px;border-radius:999px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;font-size:11.5px;'));
  assert.ok(src.includes('.ddp-fusion-popover{position:absolute;bottom:calc(100% + 6px);right:0;z-index:50;width:min(312px,calc(100vw - 24px))'));
  assert.equal(src.includes('font:12px/1.5 sans-serif'), false, '弹窗不应覆盖宿主字体族为 sans-serif');
  assert.equal(src.includes("position: 'fixed'"), false, '弹窗定位不应在未 portal 时强改 position: fixed 导致 Transform 祖先偏移裁切');
});
