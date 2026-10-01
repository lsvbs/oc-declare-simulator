import test from 'node:test';
import assert from 'node:assert/strict';
import { applyObservedConstraintBounds } from './modelCheck.mjs';
import { normalizeModelOrientation } from './modelOrientation.mjs';

const bounds = (constraintIndex, observedNmin, observedNmax) => ({
  constraintIndex, observedNmin, observedNmax,
});
const constraint = { constraint_type: 'response', source_activity: 'A', target_activity: 'B', nmin: 1, nmax: null };

test('same activity labels with different scopes receive their own bounds', () => {
  const model = { constraints: [
    { ...constraint, scope: { kind: 'each', object_type: 'Container' } },
    { ...constraint, scope: { kind: 'each', object_type: 'Vehicle' } },
  ] };
  const updated = applyObservedConstraintBounds(model, { constraintResults: [bounds(1, 3, 11), bounds(0, 1, 1)] });
  assert.deepEqual(updated.constraints.map(c => [c.nmin, c.nmax]), [[1, 1], [3, 11]]);
  assert.equal(updated.constraints[1].scope.object_type, 'Vehicle');
  assert.equal(model.constraints[0].nmax, null);
});

test('zero-count DP preserves its direction and type through normalization', () => {
  const model = normalizeModelOrientation({ constraint_orientation: 'arc', constraints: [
    { from: 'B', to: 'A', arc_type: 'DP', counts: [1, null], involvement_per_label: { Container: 'Each' } },
  ] });
  const updated = applyObservedConstraintBounds(model, { constraintResults: [bounds(0, 0, 0)] });
  assert.deepEqual(updated.constraints[0], { ...model.constraints[0], nmin: 0, nmax: 0, counts: [0, 0] });
  assert.equal(updated.constraints[0].constraint_type, 'chain_precedence');
  assert.equal(updated.constraints[0].source_activity, 'A');
});

test('inactive and vacuous-only constraints keep declared bounds', () => {
  const model = { constraints: [{ ...constraint, nmin: 2, nmax: 5 }] };
  assert.deepEqual(applyObservedConstraintBounds(model, { constraintResults: [bounds(0, null, null)] }), model);
});

test('incomplete, duplicate and invalid reports fail without mutating the model', () => {
  const model = { constraints: [{ ...constraint }, { ...constraint }] };
  for (const rows of [[], [bounds(0, 1, 1), bounds(0, 2, 2)], [bounds(0, 1, 1), bounds(2, 2, 2)],
    [bounds(0, 1, 1), bounds(1, 3, 2)], [bounds(0, 1, 1), bounds(1, null, 0)]]) {
    assert.throws(() => applyObservedConstraintBounds(model, { constraintResults: rows }));
    assert.equal(model.constraints[0].nmax, null);
  }
});
