import { randomUUID } from 'node:crypto';
import { assignModel } from './devin-wire.mjs';
import { parseFusionRoute } from './fusion-routes.mjs';
import { FUSION_MODEL_ID, ROUTE_ID } from './state.mjs';

const backend = 'spawn';
const toolName = 'devin_sidekick';
const text = (value) => [{ type: 'text', text: value }];

export function registerFusionHandoff(ctx, { live, resolveCredential, runs, fetchImpl = fetch }) {
  const lifetime = new AbortController();
  const pending = new Set();
  const enabled = (agent, modelSelection) => {
    const backendInfo = ctx.subagents.getProvider(backend);
    const current = live(agent.id);
    return !lifetime.signal.aborted && modelSelection?.provider === ROUTE_ID && modelSelection.model === FUSION_MODEL_ID
      && !runs.has(agent.id) && Boolean(current?.fusion)
      && backendInfo?.capabilities.agentOptions === true && backendInfo.capabilities.depthLimit === true;
  };
  const dispose = ctx.tools.register({
    name: toolName,
    description: 'Hand off a bounded implementation, routine investigation, or verification task to the configured Devin Fusion Sidekick, then wait for its report. As Lead, retain planning, difficult decisions, and final review. Give the Sidekick a self-contained brief; it starts in a fresh session in your working directory.',
    parameters: { type: 'object', additionalProperties: false, required: ['message'], properties: {
      message: { type: 'string', description: 'Task, necessary context, and the expected report.' }
    } },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['model', 'report'], properties: {
        model: { type: 'string' }, report: { type: 'string' }
      } },
      render: (_args, value) => text(value.report),
      presentationMeta: (_args, value) => ({ model: value.model })
    },
    presentCall: (args) => ({ card: 'generic', title: 'Fusion：正在交接给 Sidekick', rawInput: args?.message }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError
      ? 'Fusion：Sidekick 交接未完成' : `Fusion：Sidekick 已完成${result.meta?.model ? ` · ${result.meta.model}` : ''}` }),
    async execute(args, exec) {
      const parent = exec.agent;
      const selection = parent?.model?.current() ?? parent?.options;
      if (!parent || !enabled(parent, selection)) throw new Error('当前会话未启用 Devin Fusion Sidekick');
      const message = typeof args?.message === 'string' ? args.message.trim() : '';
      if (!message || message.length > 32000) throw new Error('Sidekick 简报须为 1 到 32000 个字符');
      if (pending.has(parent.id)) throw new Error('当前会话已有 Sidekick 在工作');
      const runtime = live(parent.id);
      const maxDepth = ctx.subagents.resolveMaxDepth();
      if (maxDepth === 0) throw new Error('当前 DSH 设置已停用子代理');
      const signal = AbortSignal.any([lifetime.signal, exec.signal]);
      signal.throwIfAborted();
      const cascadeId = randomUUID();
      const childId = randomUUID();
      const routerUid = ((runtime.fastMode || runtime.fusion.fastMode) && runtime.fusion.fastRouteUid) || runtime.fusion.routeUid;
      const expected = parseFusionRoute(routerUid)?.sidekick.uid;
      if (!expected) throw new Error('当前目录暂无可用的 Fusion Sidekick');
      const model = runtime.fusion.config.sidekick;
      const family = runtime.profile.families.find((item) => item.models.some((m) => m?.id === runtime.fusion.sidekickUid));
      if (!family) throw new Error(`当前模型目录缺少 Sidekick ${model}；请刷新模型目录`);
      const childModel = runtime.profile.models.find((item) => item.id === family.uid);
      if (!childModel) throw new Error(`请先在 Devin Provider 模型列表启用 ${family.label}；老旧模型需关闭过滤`);

      pending.add(parent.id);
      let activation;
      let onAbort;
      try {
        const cred = await resolveCredential(runtime.owner);
        if (!cred?.key) throw new Error('Devin 尚未登录');
        let assignment;
        try { assignment = await assignModel({ ...cred, routerUid, cascadeId, sidekick: true, fetchImpl, signal }); }
        catch { signal.throwIfAborted(); throw new Error('Devin 未能分配 Fusion Sidekick，请重试交接'); }
        if (assignment.modelUid !== expected) throw new Error('Devin 返回了与所选搭配不同的 Sidekick；请刷新模型目录');
        signal.throwIfAborted();
        const current = live(parent.id);
        if (!current || current.generation !== runtime.generation) throw new Error('Devin 账号或模型目录已变更，请重试交接');
        runs.set(childId, { ownerId: runtime.owner.id, providerServer: cred.server, model: childModel.id, modelUid: assignment.modelUid, cascadeId });
        activation = await ctx.subagents.startActivation({
          provider: backend, parent, childId, label: `Fusion Sidekick · ${runtime.fusion.sidekickName || model}`,
          prompt: text(`You are the Devin Fusion Sidekick. Complete the delegated brief and return a concise report for the Lead's review.\n\n${message}`),
          agentOptions: { provider: ROUTE_ID, model: childModel.id, reasoningEffort: undefined },
          ...(maxDepth === undefined ? {} : { maxDepth }), signal, delivery: 'caller'
        });
        onAbort = () => { void activation.dispose().catch(() => {}); };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        const result = await activation.result;
        signal.throwIfAborted();
        if (result.stopReason !== 'completed') throw new Error('Sidekick 未完成任务，请查看子会话或重试');
        const report = result.output?.filter((item) => item.type === 'text').map((item) => item.text).join('\n\n');
        if (!report?.trim()) throw new Error('Sidekick 没有返回工作报告，请查看子会话');
        return { model: runtime.fusion.sidekickName || model, report };
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        runs.delete(childId);
        pending.delete(parent.id);
      }
    }
  }, { when: ({ agent, modelSelection }) => enabled(agent, modelSelection) });
  return () => { lifetime.abort(); dispose(); };
}
