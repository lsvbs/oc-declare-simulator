/* Adapt canonical OC-Declare arrows once at the model-editor boundary. */
export function normalizeModelOrientation(model) {
  if (!model || Array.isArray(model) || model.constraint_orientation !== 'arc') return model;

  const constraints = (model.constraints || []).map(c => {
    const arc = c.arc_type;
    const flip = arc === 'EP' || arc === 'DP';
    const source = flip ? c.to   : c.from;
    const target = flip ? c.from : c.to;

    // Declared matching-event bounds; endpoint occurrence statistics are
    // descriptive and must not silently change the imported constraint.
    const kind = ({EF: 'response', EP: 'precedence', DF: 'chain_response',
      DP: 'chain_precedence', AS: 'responded_existence'})[arc] || c.constraint_type || c.type;
    const bounds = c.counts || [c.nmin ?? 1, c.nmax ?? null];

    return {
      ...c,
      source_activity: source, target_activity: target,
      source: source,          target: target,
      type: kind, constraint_type: kind,
      nmin: bounds[0], nmax: bounds[1],
    };
  });

  const { constraint_orientation, ...rest } = model;
  return { ...rest, constraints };
}
