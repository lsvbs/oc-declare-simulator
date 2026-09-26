// Lifecycle choices are advisory; activities with no object bindings still block a run.
export function getModelWarnings(model) {
  const activities = model?.activities || [];
  const bindingWarnings = activities.filter(activity => !activity.bindings?.length);
  const types = new Map();
  const ensureType = type => {
    if (type && !types.has(type)) {
      types.set(type, { type, missingCreate: true, missingDeactivate: true, sameActivity: new Set() });
    }
    return types.get(type);
  };
  (model?.object_types || []).forEach(type => ensureType(typeof type === 'string' ? type : type.name));
  activities.forEach(activity => {
    (activity.bindings || []).forEach(binding => {
      const issue = ensureType(binding.object_type);
      if (!issue) return;
      if (binding.creates) issue.missingCreate = false;
      if (binding.deactivates) issue.missingDeactivate = false;
      if (binding.creates && binding.deactivates) issue.sameActivity.add(activity.name);
    });
  });
  const lifecycleIssues = [...types.values()]
    .filter(issue => issue.missingCreate || issue.missingDeactivate || issue.sameActivity.size)
    .map(issue => ({ ...issue, sameActivity: [...issue.sameActivity].sort() }))
    .sort((a, b) => a.type.localeCompare(b.type));
  return { bindingWarnings, lifecycleIssues, hasBlockingModelIssues: bindingWarnings.length > 0 };
}
