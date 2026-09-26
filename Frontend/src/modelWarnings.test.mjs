import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelWarnings } from './modelWarnings.mjs';

const activity = (name, type, creates = false, deactivates = false) => ({
  name, bindings: [{ object_type: type, creates, deactivates }],
});

test('each lifecycle warning permits simulation, including both missing flags', () => {
  for (const [creates, deactivates] of [[true, true], [true, false], [false, true], [false, false]]) {
    const result = getModelWarnings({ activities: [activity('A', 'Order', creates, deactivates)] });
    assert.equal(result.hasBlockingModelIssues, false);
    assert.deepEqual(result.lifecycleIssues, [{
      type: 'Order', missingCreate: !creates, missingDeactivate: !deactivates,
      sameActivity: creates && deactivates ? ['A'] : [],
    }]);
  }
});

test('create and deactivate on different activities or types are not combined', () => {
  const result = getModelWarnings({ activities: [
    { name: 'Start', bindings: [...activity('Start', 'Order', true).bindings,
      ...activity('Start', 'Item', false, true).bindings] },
    activity('Finish', 'Order', false, true), activity('Pack', 'Item', true),
  ] });
  assert.deepEqual(result.lifecycleIssues, []);
  assert.equal(result.hasBlockingModelIssues, false);
});

test('same-activity warnings identify every affected activity and type', () => {
  const result = getModelWarnings({ activities: [
    activity('B', 'Order', true, true), activity('A', 'Order', true, true),
    activity('Pack', 'Item', true, true),
  ] });
  assert.deepEqual(result.lifecycleIssues.map(({ type, sameActivity }) => ({ type, sameActivity })), [
    { type: 'Item', sameActivity: ['Pack'] }, { type: 'Order', sameActivity: ['A', 'B'] },
  ]);
});

test('declared types without flags are warned about, including permanent types', () => {
  const result = getModelWarnings({ object_types: ['Order', { name: 'Machine' }], resource_types: ['Machine'] });
  assert.deepEqual(result.lifecycleIssues.map(i => [i.type, i.missingCreate, i.missingDeactivate]),
    [['Machine', true, true], ['Order', true, true]]);
  assert.equal(result.hasBlockingModelIssues, false);
});

test('base and alternative model warnings remain independent and do not modify either model', () => {
  const base = { activities: [activity('A', 'Order', true, true)] };
  const alternative = { activities: [activity('Start', 'Order', true), activity('Finish', 'Order', false, true)] };
  const before = JSON.stringify([base, alternative]);
  assert.equal(getModelWarnings(base).lifecycleIssues.length, 1);
  assert.equal(getModelWarnings(alternative).lifecycleIssues.length, 0);
  assert.equal(JSON.stringify([base, alternative]), before);
});

test('missing object bindings still block simulation while an unloaded model has no warnings', () => {
  const result = getModelWarnings({ activities: [{ name: 'Unbound', bindings: [] }] });
  assert.equal(result.hasBlockingModelIssues, true);
  assert.deepEqual(result.bindingWarnings.map(a => a.name), ['Unbound']);
  assert.deepEqual(getModelWarnings(null), { bindingWarnings: [], lifecycleIssues: [], hasBlockingModelIssues: false });
});
