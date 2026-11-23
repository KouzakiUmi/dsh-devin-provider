import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { LlmAdapter, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { AssistantMessageEventStream, InMemoryCredentialStore, calculateCost } from '@earendil-works/pi-ai';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { DevinController } from './manager.mjs';
import { FUSION_MODEL_ID, ROUTE_ID, assertAccountId } from './state.mjs';
import { getModelRows, profileFor, fusionConfigOf } from './catalog.mjs';
import { devinRemote } from './remote.mjs';
import { applyModelDefaults, captureModelDefaults, describeModelDefaults, getModelDefaults } from './model-defaults.mjs';
import { createAdapterLease, leasedStream } from './adapter-lease.mjs';
import { createDevinAdapter } from './devin-adapter.mjs';
import { forgetSigTypes, forgetThoughts } from './devin-wire.mjs';

export const name = 'dsh-devin-provider';
export const inject = ['llm'];
export const Config = z.object({
  statePath: z.string().description('账号元数据文件（不存密钥）；默认使用用户目录').default(''),
  devinCliPath: z.string().description('可选：devin CLI 原生可执行文件绝对路径').default('')
});

function routingFingerprint(routes, facts, defaults) {
  return JSON.stringify([
    routes,
    [...facts.entries()].map(([id, row]) => [id, row.enabled, row.effective]),
    [...defaults.entries()]
  ]);
}

export function apply(ctx, config) {
  const root = config.statePath || join(homedir(), '.dsh', 'dsh-devin-provider', 'state.json');
  const fallbackCredDir = join(dirname(root), 'credentials');

  const readGrant = async (accountId) => {
    assertAccountId(accountId);
    const credentials = ctx.get('credentials');
    if (credentials) {
      const rec = await credentials.readRecord(credentialKey(name, accountId));
      return rec?.kind === 'grant' ? rec.payload : undefined;
    }
    try {
      return JSON.parse(await readFile(join(fallbackCredDir, `${accountId}.json`), 'utf8'));
    } catch {
      return undefined;
    }
  };

  const writeGrant = async (accountId, payload) => {
    assertAccountId(accountId);
    const credentials = ctx.get('credentials');
    if (credentials) {
      await credentials.modifyRecord(credentialKey(name, accountId), async () => ({ kind: 'grant', payload }));
      return;
    }
    await mkdir(fallbackCredDir, { recursive: true, mode: 0o700 });
    await writeFile(join(fallbackCredDir, `${accountId}.json`), JSON.stringify(payload), { mode: 0o600 });
  };

  const deleteGrant = async (accountId) => {
    assertAccountId(accountId);
    const credentials = ctx.get('credentials');
    if (credentials) {
      await credentials.deleteRecord(credentialKey(name, accountId));
      return;
    }
    await rm(join(fallbackCredDir, `${accountId}.json`), { force: true }).catch(() => {});
  };

  const controller = new DevinController({
    statePath: root,
    devinCliPath: config.devinCliPath,
    resolveRef: async (ref) => {
      const credentials = ctx.get('credentials');
      const value = credentials ? (await credentials.resolve(credentialRef(ref)))?.value : launchEnvironmentOf(ctx).get(ref)?.value;
      return typeof value === 'string' && value.length ? value : undefined;
    },
    readGrant,
    writeGrant,
    deleteGrant
  });

  let registration;
  let currentGeneration;
  const generations = new Set();
  const finalizers = new FinalizationRegistry((release) => {
    void release().catch(() => ctx.logger.error('旧 Devin 模型适配器清理失败'));
  });

  function generation() {
    if (!currentGeneration?.adapter || currentGeneration.lease.closed) throw new Error('Devin 模型路由未启用');
    return currentGeneration;
  }

  function requestOptions(options, defaults) {
    return {
      ...applyModelDefaults(options, defaults),
      signal: options.signal ? AbortSignal.any([options.signal, controller.life.signal]) : controller.life.signal
    };
  }

  async function withGeneration(operation) {
    const held = generation();
    const release = held.lease.retain();
    try {
      return await operation(held);
    } finally {
      await release();
    }
  }

  class ManagedAdapter extends LlmAdapter {
    providerInfo(provider) { return generation().adapter.providerInfo(provider); }
    providerRetryPolicy(provider) { return generation().adapter.providerRetryPolicy(provider); }
    imageRequestPricing(provider, model) { return generation().adapter.imageRequestPricing(provider, model); }
    imageRequestTarget(provider, model, image) { return generation().adapter.imageRequestTarget(provider, model, image); }
    listModels(provider) { return withGeneration((held) => held.adapter.listModels(provider)); }
    resolveModel(provider, model, signal) {
      return withGeneration(async (held) =>
        describeModelDefaults(await held.adapter.resolveModel(provider, model, signal), getModelDefaults(held.defaults, provider, model))
      );
    }
    async prepareCall(provider, model, signal) {
      const held = generation();
      const release = held.lease.retain();
      try {
        const defaults = getModelDefaults(held.defaults, provider, model);
        const prepared = await held.adapter.prepareCall(provider, model, signal);
        const token = {};
        let consumed = false;
        const wrapped = {
          ...prepared,
          model: describeModelDefaults(prepared.model, defaults),
          stream: (options) => {
            if (consumed) throw new Error('已准备的模型请求只能使用一次');
            consumed = true;
            finalizers.unregister(token);
            return leasedStream(() => prepared.stream(requestOptions(options, defaults)), held.lease, release, finalizers);
          }
        };
        finalizers.register(wrapped, release, token);
        return wrapped;
      } catch (error) {
        await release();
        throw error;
      }
    }
    stream(options) {
      const held = generation();
      const defaults = getModelDefaults(held.defaults, options.provider, options.model);
      return leasedStream(() => held.adapter.stream(requestOptions(options, defaults)), held.lease, undefined, finalizers);
    }
  }

  const managedAdapter = new ManagedAdapter();

  async function refreshAdapters() {
    if (controller.disposed) return;
    let nextGeneration;
    let nextAdapter;
    let previous;
    try {
      const state = structuredClone(controller.store.current);
      const profile = profileFor(state);
      const nextDefaults = captureModelDefaults(state);
      const routes = profile ? [ROUTE_ID] : [];
      previous = currentGeneration;

      if (!profile) {
        if (registration) registration.replace([]);
        currentGeneration = undefined;
        controller.appliedAccount = null;
        controller.routingError = undefined;
        if (previous) await previous.lease.retire().catch(() => ctx.logger.error('旧 Devin 模型适配器清理失败'));
        return;
      }

      const facts = new Map(getModelRows(state, state.activeAccountId).map((row) => [row.id, row]));
      facts.set(FUSION_MODEL_ID, { id: FUSION_MODEL_ID, enabled: true, effective: { toolsEnabled: true } });
      const fingerprint = routingFingerprint(routes, facts, nextDefaults) + ':fusion:' + JSON.stringify(state.fusion ?? {});
      if (registration && previous?.fingerprint === fingerprint) {
        const owner = state.accounts.find((a) => a.id === state.activeAccountId);
        controller.appliedAccount = owner
          ? { id: owner.id, displayName: owner.identity?.email || owner.identity?.name || owner.label }
          : null;
        controller.routingError = undefined;
        return;
      }
      nextAdapter = createDevinAdapter(
        { LlmAdapter, LlmError, PiAiAdapter, InMemoryCredentialStore, AssistantMessageEventStream, calculateCost, resolveRetryPolicy },
        {
          profile,
          facts,
          resolveCredential: async () => {
            const owner = state.accounts.find((a) => a.id === state.activeAccountId);
            return owner ? controller.resolveCredential(owner) : undefined;
          },
          keepaliveConfig: () => controller.store.current?.settings?.cacheKeepalive,
          resolveFusion: () => {
            const st = controller.store.current;
            return fusionConfigOf(st, st?.activeAccountId);
          },
          resolveFastMode: (sessionId) => {
            const id = typeof sessionId === 'string' ? sessionId.trim() : '';
            if (!id) return false;
            const st = controller.store.current;
            return Boolean(st?.fastSessions?.[id]);
          },
          resolveAttachments: () => ctx.get('attachments'),
          resolveImageAccess: (attachments, ref) =>
            resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref)
        }
      );
      if (controller.disposed) {
        await nextAdapter.dispose();
        return;
      }
      nextGeneration = { adapter: nextAdapter, defaults: nextDefaults, fingerprint };
      nextGeneration.lease = createAdapterLease(
        async () => {
          try {
            await nextAdapter.dispose();
          } finally {
            generations.delete(nextGeneration);
          }
        },
        () => ctx.logger.error('旧 Devin 模型适配器清理失败')
      );
      generations.add(nextGeneration);
      currentGeneration = nextGeneration;
      try {
        if (registration) registration.replace(routes);
        else registration = ctx.llm.registerAdapter(routes, managedAdapter);
      } catch (error) {
        currentGeneration = previous;
        throw error;
      }
      const owner = state.accounts.find((a) => a.id === state.activeAccountId);
      controller.appliedAccount = owner
        ? { id: owner.id, displayName: owner.identity?.email || owner.identity?.name || owner.label }
        : null;
      controller.routingError = undefined;
    } catch (error) {
      if (nextGeneration) await nextGeneration.lease.dispose();
      else await nextAdapter?.dispose();
      controller.routingError = 'Devin 模型路由更新失败；已保留此前可用路由。请检查路由冲突、模型缓存或 Core 兼容性后重试。';
      throw new Error(controller.routingError, { cause: error });
    }
    if (previous) await previous.lease.retire().catch(() => ctx.logger.error('旧 Devin 模型适配器清理失败'));
  }

  let routingQueue = Promise.resolve();
  const queueRoutingUpdate = () => {
    const operation = routingQueue.then(refreshAdapters).catch((error) => {
      controller.routingError ??= '模型缓存或路由校验失败；已保留此前可用路由，请重新拉取模型后重试。';
      throw error;
    });
    routingQueue = operation.catch(() => {});
    return operation;
  };
  controller.onChange = queueRoutingUpdate;

  class DevinService extends TypertRemoteService {
    constructor(scope) {
      super(scope, 'devinProvider');
    }
    async invoke(request) {
      await controller.ready;
      return controller.invoke(request);
    }
  }

  ctx.inject(['typert'], (scope) =>
    scope.effect(() =>
      scope.typert.register({
        package: devinRemote.package,
        face: 'host',
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: devinRemote.descriptors
      })
    )
  );
  ctx.plugin(DevinService);
  ctx.on('credentials/reference-updated', () => controller.clearCaches());
  ctx.on('credentials/record-updated', () => controller.clearCaches());

  controller.ready = controller.store.load().then(async () => {
    await controller.ensureQuotaCacheLoaded();
    controller.startBackgroundRefresh();
    return queueRoutingUpdate();
  }).catch(() => {
    controller.routingError ??= '初始化失败：请检查账号元数据和模型缓存；原文件未覆盖。';
    ctx.logger.error('Devin Provider 初始化失败；请在设置页查看状态');
  });

  ctx.on('dispose', async () => {
    controller.dispose();
    forgetSigTypes();
    forgetThoughts();
    if (registration) registration();
    const results = await Promise.allSettled([...generations].map((held) => held.lease.dispose()));
    if (results.some((r) => r.status === 'rejected')) ctx.logger.error('Devin 模型适配器卸载失败');
  });
}
