import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelOrientation } from './modelOrientation.mjs';

test('all five arrows keep their meaning and declared counts in the editor', () => {
  const kinds = { EF: 'response', EP: 'precedence', DF: 'chain_response', DP: 'chain_precedence', AS: 'responded_existence' };
  const raw = { constraint_orientation: 'arc', constraints: Object.keys(kinds).map(arc_type => ({
    arc_type, from: 'A', to: 'B', counts: [1, null], nmin: 8, nmax: 20,
    observed_counts: { from: [8, 20], to: [3, 5] },
  })) };
  const saved = JSON.stringify(raw);
  const converted = normalizeModelOrientation(raw);
  assert.equal(JSON.stringify(raw), saved);
  assert.equal(converted.constraint_orientation, undefined);
  for (const c of converted.constraints) {
    assert.equal(c.constraint_type, kinds[c.arc_type]);
    assert.equal(c.type, kinds[c.arc_type]);
    assert.equal(c.nmin, 1);
    assert.equal(c.nmax, null);
    assert.equal(c.source_activity, ['EP', 'DP'].includes(c.arc_type) ? 'B' : 'A');
    assert.equal(c.target_activity, ['EP', 'DP'].includes(c.arc_type) ? 'A' : 'B');
  }
  assert.equal(normalizeModelOrientation(converted), converted);
});

test('zero matching counts are preserved instead of replaced by observations', () => {
  const model = normalizeModelOrientation({constraint_orientation: 'arc', constraints: [
    { arc_type: 'DP', from: 'A', to: 'B', counts: [0, 0] },
  ]});
  assert.equal(model.constraints[0].nmin, 0);
  assert.equal(model.constraints[0].nmax, 0);
});
