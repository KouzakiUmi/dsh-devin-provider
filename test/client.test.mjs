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
  return { React: { createElement, useState, useRef, useCallback, useEffect }, flush, unmountAll };
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
  const snapshot = {
    revision: 'r1',
    route: 'devin',
    enabled: true,
    activeAccountId: 'a1',
    accounts: [{ id: 'a1', label: 'Devin Pro', displayName: 'u@example.com', authMode: 'oauth', hasCredential: true }],
    settings: { cacheKeepalive: { enabled: false, intervalSec: 285, maxPings: 6 }, serverUrl: '' },
    catalogs: [
      {
        accountId: 'a1',
        count: 1,
        enabledCount: 1,
        source: 'local-snapshot',
        models: [
          {
            id: 'swe-2',
            name: 'SWE-2',
            free: true,
            enabled: true,
            settings: {},
            defaults: { contextWindow: 262000, maxTokens: 128000, imageInput: true, toolsEnabled: true, reasoningEfforts: { medium: 'medium', high: 'high', max: 'max' }, defaultReasoning: null },
            effective: { contextWindow: 262000, maxTokens: 128000, imageInput: true, toolsEnabled: true, reasoningEfforts: { medium: 'medium', high: 'high', max: 'max' }, defaultReasoning: null }
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
            if (req.op === 'quota') {
              return {
                ok: true,
                value: {
                  accountId: 'a1',
                  state: 'ok',
                  updatedAt: new Date().toISOString(),
                  windows: [{ kind: '1d', label: '每日额度', usedPercent: 20, remainingPercent: 80 }],
                  overageBalance: '$5.00'
                }
              };
            }
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

  mod.apply(ctx);
  assert.equal(slotEntry.meta.id, 'devin-provider');
  assert.equal(slotEntry.meta.label(), 'Devin Provider');
  const injected = slotEntry.meta.inject();

  let tree = await mini.flush(() => mini.React.createElement(slotEntry.comp, injected));
  assert.ok(textOf(tree).includes('Devin Provider'));
  assert.ok(calls.some((c) => c.op === 'read'));

  // Trigger quota refresh
  const quotaBtn = findAll(tree, (n) => n.type === 'button' && textOf(n).includes('刷新额度'))[0];
  assert.ok(quotaBtn);
  quotaBtn.props.onClick();
  tree = await mini.flush(() => mini.React.createElement(slotEntry.comp, injected));
  assert.ok(textOf(tree).includes('80%'));
  assert.ok(textOf(tree).includes('$5.00'));

  // Save keepalive settings
  const saveSettingsBtn = findAll(tree, (n) => n.type === 'button' && textOf(n).includes('保存保活与服务设置'))[0];
  assert.ok(saveSettingsBtn);
  saveSettingsBtn.props.onClick();
  tree = await mini.flush(() => mini.React.createElement(slotEntry.comp, injected));
  assert.ok(calls.some((c) => c.op === 'saveSettings'));

  mini.unmountAll();
});
