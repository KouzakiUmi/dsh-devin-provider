import { DEFAULT_SERVER } from './pb.mjs';
import { streamDevinChat } from './devin-wire.mjs';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function abortOnReturn(iterator, cancellation) {
  const finish = iterator.return.bind(iterator);
  const reject = iterator.throw.bind(iterator);
  iterator.return = (value) => {
    cancellation.abort();
    return finish(value);
  };
  iterator.throw = (error) => {
    cancellation.abort();
    return reject(error);
  };
  return iterator;
}

function carriesToolCall(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  if (chunk.type === 'tool-call-delta') return true;
  if (chunk.type === 'block-start') return chunk.blockType === 'tool-call';
  if (chunk.type === 'block-end') return chunk.block?.type === 'tool-call';
  return chunk.type === 'finish' && chunk.reason?.kind === 'tool-calls';
}

export function createDevinAdapter(deps, config) {
  const { LlmAdapter, LlmError, PiAiAdapter, InMemoryCredentialStore, AssistantMessageEventStream, calculateCost } = deps;
  const fail = (message, code = 'INVALID_CONFIG') => {
    throw new LlmError(message, code);
  };
  const invalid = () => fail('Devin 模型或传输配置无效');

  if (!object(config?.profile) || !(config.facts instanceof Map) || typeof config.resolveCredential !== 'function') {
    invalid();
  }

  const input = config.profile;
  const route = input.provider;
  if (typeof route !== 'string' || !route || !Array.isArray(input.models)) invalid();

  const profile = {
    provider: route,
    displayName: input.displayName ?? 'Devin Provider',
    streamIdleTimeoutMs: 300000,
    maxRequestImageBytes: 20971520,
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
    retryPolicy: typeof deps.resolveRetryPolicy === 'function'
      ? deps.resolveRetryPolicy(input.retryPolicy, 'Devin Provider')
      : { mode: 'normal', maxRetries: 5 }
  };

  const models = [];
  const controls = new Map();
  const configuredMaxTokens = new Map();
  const seen = new Set();

  for (const entry of input.models) {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id.trim() || seen.has(entry.id)) invalid();
    seen.add(entry.id);
    const fact = config.facts.get(entry.id) ?? (entry.id === 'fusion' ? { effective: { toolsEnabled: true } } : undefined);
    if (!object(fact)) invalid();
    const toolsEnabled = fact.effective?.toolsEnabled ?? true;
    const contextWindow = entry.contextWindow;
    const maxTokens = entry.maxTokens;
    const modalities = entry.input ?? ['text'];
    const name = entry.name ?? entry.id;
    if (!positive(contextWindow) || !positive(maxTokens) || maxTokens > contextWindow || typeof name !== 'string' || !name.trim()) {
      invalid();
    }
    if (!Array.isArray(modalities) || !modalities.length || modalities.some((v) => !['text', 'image'].includes(v))) {
      invalid();
    }
    const cost = {};
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const v = entry.cost?.[k] ?? 0;
      cost[k] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    }

    const effort = entry.reasoningEfforts;
    let reasoning = false;
    let thinkingLevelMap;
    if (effort !== undefined && effort !== false) {
      if (!object(effort) || Object.keys(effort).some((k) => !LEVELS.includes(k)) || !Object.keys(effort).some((k) => k !== 'off')) {
        invalid();
      }
      thinkingLevelMap = {};
      for (const level of LEVELS) {
        const value = effort[level];
        if (value === undefined) thinkingLevelMap[level] = null;
        else if (value === null && level === 'off') thinkingLevelMap[level] = null;
        else if (typeof value === 'string' && value.trim()) thinkingLevelMap[level] = value.trim();
        else invalid();
      }
      reasoning = true;
    }

    models.push({
      id: entry.id,
      name,
      api: entry.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
      provider: route,
      baseUrl: DEFAULT_SERVER,
      contextWindow,
      maxTokens,
      input: [...modalities],
      cost,
      reasoning,
      compat: {
        supportsMidConvoSystemMessages: false
      },
      ...(thinkingLevelMap ? { thinkingLevelMap } : {})
    });
    configuredMaxTokens.set(entry.id, maxTokens);
    controls.set(entry.id, {
      effortsMap: reasoning ? effort : undefined,
      supportsOff: reasoning && Object.hasOwn(effort, 'off') && typeof effort.off === 'string',
      toolsEnabled
    });
  }

  const credentials = new InMemoryCredentialStore();
  const auth = { credentials, authContext: { env: async () => undefined, fileExists: async () => false } };
  const lifetime = new AbortController();
  const active = new Set();
  let disposed = false;

  const ensureLive = () => {
    if (disposed) fail('Devin 模型适配器已卸载', 'ADAPTER_DISPOSED');
  };
  const own = (provider, model) => {
    if (provider !== route) fail('Devin 适配器未提供此路由', 'NO_ADAPTER');
    if (model !== undefined && !controls.has(model)) fail('模型不在当前 Devin 目录中', 'UNKNOWN_MODEL');
  };

  function delegate(control, keyCapture) {
    const profiles = new Map();
    const runStream = (model, context, options) => {
      const modelCtrl = controls.get(model.id);
      const rawEffort = control?.reasoningEffort;
      const sessionId = options?.sessionId ?? control?.sessionId;
      const mappedEffort = rawEffort !== undefined && modelCtrl?.effortsMap
        ? modelCtrl.effortsMap[rawEffort] ?? rawEffort
        : undefined;
      return streamDevinChat({
        model,
        context,
        options,
        AssistantMessageEventStream,
        calculateCost,
        resolveCredential: async () => {
          const cred = await config.resolveCredential();
          if (cred?.key && keyCapture) keyCapture.value = cred.key;
          return cred;
        },
        families: input.families ?? [],
        toolsEnabled: control?.toolsEnabled ?? modelCtrl?.toolsEnabled ?? true,
        requestedEffort: mappedEffort,
        keepaliveConfig: config.keepaliveConfig?.() ?? config.keepalive,
        fusionConfig: config.resolveFusion,
        sidekickRun: config.resolveSidekickRun?.(sessionId, model.id),
        fastMode: () => (typeof config.resolveFastMode === 'function' ? config.resolveFastMode(sessionId) : Boolean(config.fastMode)),
        fetchImpl: config.fetchImpl ?? fetch
      });
    };

    profiles.set(route, {
      ...profile,
      modelErrors: new Map(),
      configuredMaxTokens: new Map(configuredMaxTokens),
      piProvider: {
        id: route,
        name: profile.displayName,
        baseUrl: DEFAULT_SERVER,
        auth: { apiKey: { name: 'DEVIN_TOKEN', resolve: async () => ({ auth: {}, source: 'request' }) } },
        getModels: () => models,
        stream: runStream,
        streamSimple: runStream
      }
    });

    return new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => {
        ensureLive();
        let cred;
        try {
          cred = await config.resolveCredential();
        } catch {
          fail('Devin 凭据解析失败', 'CREDENTIAL_RESOLUTION_FAILED');
        }
        ensureLive();
        if (!cred || typeof cred.key !== 'string' || !cred.key.trim()) fail('未配置 Devin 认证', 'MISSING_CREDENTIAL');
        if (/[^\x21-\x7e]/.test(cred.key)) fail('Devin 凭据格式无效', 'INVALID_CREDENTIAL');
        if (keyCapture) keyCapture.value = cred.key;
        return cred.key;
      },
      auth,
      resolveAttachments: config.resolveAttachments,
      resolveImageAccess: config.resolveImageAccess
    });
  }

  const metadata = delegate();
  const redact = (message, key) => (typeof message === 'string' && key ? message.split(key).join('[REDACTED]') : message);
  const safeError = (error, key) => {
    const message = redact(typeof error?.message === 'string' ? error.message : 'Devin 模型请求失败', key);
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return new DOMException(message, error.name);
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'DEVIN_TRANSPORT_ERROR';
    return new LlmError(message, code);
  };

  class DevinAdapter extends LlmAdapter {
    providerInfo(provider) {
      ensureLive();
      own(provider);
      return metadata.providerInfo(provider);
    }
    providerRetryPolicy(provider) {
      ensureLive();
      own(provider);
      return metadata.providerRetryPolicy(provider);
    }
    imageRequestPricing(provider, model) {
      ensureLive();
      own(provider, model);
      return metadata.imageRequestPricing?.(provider, model);
    }
    imageRequestTarget(provider, model, image) {
      ensureLive();
      own(provider, model);
      return metadata.imageRequestTarget(provider, model, image);
    }
    async listModels(provider) {
      ensureLive();
      own(provider);
      try {
        return await metadata.listModels(provider);
      } catch (error) {
        if (error?.code === 'MISSING_CREDENTIAL') return [];
        throw safeError(error);
      }
    }
    resolveModel(provider, model, signal) {
      ensureLive();
      own(provider, model);
      return metadata.resolveModel(provider, model, signal);
    }
    async prepareCall(provider, model, signal) {
      ensureLive();
      own(provider, model);
      if (signal?.aborted) fail('Devin 请求已取消', 'ABORTED');
      const modelCtrl = controls.get(model);
      const control = { reasoningEffort: undefined, sessionId: undefined, toolsEnabled: modelCtrl.toolsEnabled };
      const key = { value: undefined };
      const callDelegate = delegate(control, key);
      const prepared = await callDelegate.prepareCall(provider, model, signal);
      ensureLive();
      let consumed = false;
      return {
        model: prepared.model,
        stream: (options) => {
          if (consumed) fail('已准备的模型请求只能使用一次', 'PREPARED_CALL_CONSUMED');
          consumed = true;
          ensureLive();
          if (!options || options.provider !== provider || options.model !== model) {
            fail('已准备的 Devin 请求不能切换模型或路由', 'INVALID_REQUEST');
          }
          control.reasoningEffort = options.reasoningEffort;
          control.sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined;
          if (control.reasoningEffort === 'off' && !modelCtrl.supportsOff) {
            fail('当前模型未提供关闭思考档位', 'UNSUPPORTED_REASONING_EFFORT');
          }
          const cancellation = new AbortController();
          const iterator = (async function* () {
            ensureLive();
            active.add(cancellation);
            const requestSignal = AbortSignal.any([lifetime.signal, cancellation.signal, ...[signal, options.signal].filter(Boolean)]);
            try {
              if (requestSignal.aborted) fail('Devin 请求已取消', 'ABORTED');
              for await (const chunk of prepared.stream({ ...options, signal: requestSignal })) {
                if (control.toolsEnabled === false && carriesToolCall(chunk)) {
                  fail('该模型已关闭工具调用，但服务端仍返回了工具调用', 'TOOL_CALL_DISABLED');
                }
                if (chunk.type === 'finish' && chunk.reason?.failure) {
                  yield {
                    ...chunk,
                    reason: {
                      ...chunk.reason,
                      failure: { ...chunk.reason.failure, message: redact(chunk.reason.failure.message, key.value) }
                    }
                  };
                } else {
                  yield chunk;
                }
              }
            } catch (error) {
              throw safeError(error, key.value);
            } finally {
              cancellation.abort();
              active.delete(cancellation);
              key.value = undefined;
            }
          })();
          return abortOnReturn(iterator, cancellation);
        }
      };
    }
    stream(options) {
      const cancellation = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
      const adapter = this;
      const iterator = (async function* () {
        const prepared = await adapter.prepareCall(options.provider, options.model, signal);
        yield* prepared.stream({ ...options, signal });
      })();
      return abortOnReturn(iterator, cancellation);
    }
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      for (const controller of active) controller.abort();
      active.clear();
    }
  }

  return new DevinAdapter();
}
