const EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PART = /^([a-z0-9][a-z0-9.-]*?)(?:-(none|minimal|min|low|medium|high|xhigh|max))?(?:-(fast|priority|lightning))?$/;

export function parseFusionRoute(uid) {
  if (typeof uid !== 'string') return null;
  const match = /^fusion-(.+)-sidekick-(.+)$/.exec(uid);
  if (!match) return null;
  const part = (value) => {
    const m = PART.exec(value);
    if (!m) return null;
    const [, id, effort = '', tier = ''] = m;
    return { id, effort: effort === 'min' ? 'minimal' : effort, tier, uid: value };
  };
  const lead = part(match[1]);
  const sidekick = part(match[2]);
  return lead && sidekick ? { uid, lead, sidekick, fast: Boolean(lead.tier || sidekick.tier) } : null;
}

export const FUSION_DEFAULT = { lead: 'claude-opus-5-5', leadEffort: 'medium', sidekick: 'swe-2', sidekickEffort: 'medium' };
const keyOf = ({ id, effort }) => `${id}/${effort}`;
const preferredEffort = (options, preferred) => options.includes(preferred) ? preferred
  : options.includes('medium') ? 'medium' : options[0];

export function fusionRouteIndex(routes, families) {
  const models = new Map(families.flatMap((f) => f.models.map((m) => [m?.id, f])));
  const standard = new Map();
  const fast = new Map();
  const modelByRole = new Map();
  for (const uid of routes) {
    const route = parseFusionRoute(uid);
    if (!route) continue;
    const { lead, sidekick } = route;
    const key = `${keyOf(lead)}:${keyOf(sidekick)}`;
    if (route.fast) {
      fast.set(key, route.uid);
      continue;
    }
    standard.set(key, route);
    for (const role of [lead, sidekick]) {
      const family = models.get(role.uid);
      if (family) modelByRole.set(role.id, family);
    }
  }
  const leads = new Map();
  const sidekicks = new Map();
  const modelOption = (id) => {
    const family = modelByRole.get(id);
    return { id, name: family?.label || id, ...(family ? { familyId: family.uid } : {}) };
  };
  for (const [key, route] of standard) {
    const { lead, sidekick } = route;
    if (!leads.has(lead.id)) leads.set(lead.id, { ...modelOption(lead.id), byEffort: new Map() });
    const { byEffort } = leads.get(lead.id);
    if (!byEffort.has(lead.effort)) byEffort.set(lead.effort, new Map());
    const choices = byEffort.get(lead.effort);
    if (!choices.has(sidekick.id)) choices.set(sidekick.id, { id: sidekick.id, efforts: [], fastEfforts: [] });
    const choice = choices.get(sidekick.id);
    choice.efforts.push(sidekick.effort);
    if (fast.has(key)) choice.fastEfforts.push(sidekick.effort);
    if (!sidekicks.has(sidekick.id)) sidekicks.set(sidekick.id, modelOption(sidekick.id));
  }
  return {
    standard,
    fast,
    leads: [...leads.values()].map(({ byEffort, ...lead }) => ({
      ...lead,
      variants: EFFORTS.filter((e) => byEffort.has(e)).map((effort) => ({
        effort,
        sidekicks: [...byEffort.get(effort).values()].map((side) => ({
          id: side.id,
          efforts: EFFORTS.filter((e) => side.efforts.includes(e)),
          fastEfforts: EFFORTS.filter((e) => side.fastEfforts.includes(e))
        }))
      }))
    })),
    sidekicks: [...sidekicks.values()]
  };
}

export function selectFusionRoute(index, saved = {}) {
  const find = (list, id) => list.find((m) => m.id === id || m.familyId === id || m.id === id?.replace(/\.(?=\d)/g, '-'));
  const lead = find(index.leads, saved.lead) ?? find(index.leads, FUSION_DEFAULT.lead) ?? index.leads[0];
  if (!lead) return null;
  const leadEffort = preferredEffort(lead.variants.map((v) => v.effort), saved.leadEffort ?? FUSION_DEFAULT.leadEffort);
  const variant = lead.variants.find((v) => v.effort === leadEffort);
  const savedSidekick = find(index.sidekicks, saved.sidekick);
  const sidekick = variant.sidekicks.find((s) => s.id === savedSidekick?.id)
    ?? variant.sidekicks.find((s) => s.id === FUSION_DEFAULT.sidekick) ?? variant.sidekicks[0];
  const sidekickEffort = preferredEffort(sidekick.efforts, saved.sidekickEffort ?? FUSION_DEFAULT.sidekickEffort);
  const key = `${lead.id}/${leadEffort}:${sidekick.id}/${sidekickEffort}`;
  const route = index.standard.get(key);
  const fastRouteUid = index.fast.get(key);
  return {
    config: { lead: lead.id, leadEffort, sidekick: sidekick.id, sidekickEffort },
    routeUid: route.uid,
    leadUid: route.lead.uid,
    sidekickUid: route.sidekick.uid,
    sidekickName: find(index.sidekicks, sidekick.id)?.name,
    fastRouteUid,
    fastAllowed: Boolean(fastRouteUid),
    fastMode: saved.fastMode === true
  };
}
