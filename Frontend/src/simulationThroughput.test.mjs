import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleSimulationThroughput } from './simulationThroughput.mjs';

test('the first poll establishes a baseline without inventing a rate', () => {
  const { next, sample } = sampleSimulationThroughput(
    { startMs: 1000, lastMs: null, lastEvents: 0 },
    { events_count: 50, total_obligations: 20 }, 2000);
  assert.equal(sample, null);
  assert.deepEqual(next, { startMs: 1000, lastMs: 2000, lastEvents: 50 });
});

test('events use the actual polling gap while pending obligations remain an absolute count', () => {
  const { sample } = sampleSimulationThroughput(
    { startMs: 1000, lastMs: 2000, lastEvents: 50 },
    { events_count: 70, total_obligations: 12, objects_count: 999 }, 4500);
  assert.deepEqual(sample, { t: 3.5, ev: 8, pending: 12, cum: 70 });
});

test('pending obligations can decrease to zero even when no events complete', () => {
  const previous = { startMs: 0, lastMs: 1000, lastEvents: 70 };
  const { next, sample } = sampleSimulationThroughput(previous,
    { events_count: 70, total_obligations: 5 }, 2000);
  assert.equal(sample.pending, 5);
  assert.equal(sample.ev, 0);
  const cleared = sampleSimulationThroughput(next, { events_count: 70, total_obligations: 0 }, 3000);
  assert.equal(cleared.sample.pending, 0);
  assert.equal(cleared.sample.cum, 70);
});

test('unavailable pending counts stay unknown rather than displaying zero', () => {
  const { sample } = sampleSimulationThroughput(
    { startMs: 0, lastMs: 1000, lastEvents: 0 }, { events_count: 5 }, 2000);
  assert.equal(sample.pending, null);
});

test('stale or too-close responses do not reset the baseline or create rate spikes', () => {
  const previous = { startMs: 0, lastMs: 2000, lastEvents: 50 };
  for (const [now, count] of [[2000, 60], [1900, 60], [2200, 60], [3000, 40]]) {
    const result = sampleSimulationThroughput(previous, { events_count: count, total_obligations: 5 }, now);
    assert.equal(result.sample, null);
    assert.strictEqual(result.next, previous);
  }
});
