import { getModelRows } from './catalog.mjs';
import { ROUTE_ID } from './state.mjs';

const keyFor = (provider, model) => `${provider}\0${model}`;

export function captureModelDefaults(state) {
  const defaults = new Map();
  if (state.enabled === false || !state.activeAccountId) return defaults;
  if (!state.accounts.some((a) => a.id === state.activeAccountId)) return defaults;
  const hideLegacy = state.settings?.hideLegacyModels !== false;
  for (const row of getModelRows(state, state.activeAccountId)) {
    if (!row.enabled || (hideLegacy && row.legacy)) continue;
    const value = {};
    if (row.effective.temperature !== undefined) value.temperature = row.effective.temperature;
    if (row.effective.defaultReasoning != null) value.reasoningEffort = row.effective.defaultReasoning;
    defaults.set(keyFor(ROUTE_ID, row.id), Object.freeze(value));
  }
  return defaults;
}

export function getModelDefaults(defaults, provider, model) {
  return defaults.get(keyFor(provider, model));
}

export function applyModelDefaults(options, defaults = {}) {
  const patch = {};
  for (const field of ['temperature', 'reasoningEffort']) {
    if (options[field] === undefined && defaults[field] !== undefined) patch[field] = defaults[field];
  }
  return Object.keys(patch).length ? { ...options, ...patch } : options;
}

export function describeModelDefaults(info, defaults = {}) {
  if (!info.reasoning) {
    if (defaults.reasoningEffort !== undefined) throw new Error('非思考模型不能配置默认思考档位');
    return info;
  }
  const { defaultEffort: _previousDefault, ...reasoning } = info.reasoning;
  const effort = defaults.reasoningEffort;
  if (effort !== undefined && !reasoning.efforts.some((item) => item.id === effort)) {
    throw new Error('默认思考档位与模型能力不匹配');
  }
  return { ...info, reasoning: { ...reasoning, ...(effort === undefined ? {} : { defaultEffort: effort }) } };
}
