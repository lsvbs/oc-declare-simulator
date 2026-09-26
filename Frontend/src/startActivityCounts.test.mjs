import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStartActivityCaps } from './startActivityCounts.mjs';

test('untouched or cleared fields use discovered counts', () => {
  assert.deepEqual(resolveStartActivityCaps(['A', 'B'], { B: '' }, { A: 7, B: 12 }), { A: 7, B: 12 });
});

test('user values, including zero, override the log and only selected activities are sent', () => {
  assert.deepEqual(resolveStartActivityCaps(['A', 'B'], { A: '3', B: '0', C: '5' }, { A: 7, B: 12 }), { A: 3, B: 0 });
});

test('missing and invalid counts require correction before running', () => {
  assert.throws(() => resolveStartActivityCaps(['A']), /Enter a starting count/);
  for (const A of ['-1', '1.5', 'bad', '9007199254740992']) {
    assert.throws(() => resolveStartActivityCaps(['A'], { A }), /whole number/);
  }
});
