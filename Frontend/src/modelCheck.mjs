// Apply only to the model snapshot submitted for checking. Display labels are
// not identifiers: constraints can share endpoints but have different scopes.
export function applyObservedConstraintBounds(model, report) {
  const constraints = model.constraints || [];
  const rows = report?.constraintResults;
  if (!Array.isArray(rows) || rows.length !== constraints.length) {
    throw new Error('Incomplete model check. Run parameter discovery again.');
  }
  const byIndex = new Map();
  for (const row of rows) {
    const index = row.constraintIndex;
    if (!Number.isInteger(index) || index < 0 || index >= constraints.length || byIndex.has(index)) {
      throw new Error('Invalid model check. Run parameter discovery again.');
    }
    byIndex.set(index, row);
  }
  return {
    ...model,
    constraints: constraints.map((constraint, index) => {
      const { observedNmin, observedNmax } = byIndex.get(index);
      // No activations / no Each bindings means no observed bound, not zero.
      if (observedNmin == null && observedNmax == null) return constraint;
      if (!Number.isInteger(observedNmin) || !Number.isInteger(observedNmax)
          || observedNmin < 0 || observedNmax < observedNmin) {
        throw new Error('Invalid observed bounds. No bounds were applied.');
      }
      // In particular, DP with [0,0] remains DP. Converting it into a negative
      // succession rule reverses its direction and changes its semantics.
      return {
        ...constraint, nmin: observedNmin, nmax: observedNmax,
        ...(Array.isArray(constraint.counts) ? { counts: [observedNmin, observedNmax] } : {}),
      };
    }),
  };
}
