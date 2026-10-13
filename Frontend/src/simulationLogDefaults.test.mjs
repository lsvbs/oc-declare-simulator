import {test} from 'node:test';
import assert from 'node:assert/strict';
import {logStopDefaults, logStartCaps} from './simulationLogDefaults.mjs';
test('log limits preserve exact duration and manual runtime, including zero values', () => {
  const config={maxSteps: 9,maxSimTimeUnit:'days',maxRuntimeValue:'12',seed:42};
  const r=logStopDefaults(config,{total_events:123,ocel_time_span_s:90061});
  assert.equal(r.maxSteps,123); assert.equal(r.maxSimTimeValue*86400,90061);
  assert.equal(r.maxRuntimeValue,'12'); assert.equal(config.maxSteps,9);
  assert.equal(logStopDefaults(config,{total_events:0,ocel_time_span_s:0}).maxSimTimeValue,0);
});
test('missing log fields stay blank; starts reset only selected activities', () => {
  assert.equal(logStopDefaults({},{}).maxSteps,'');
  assert.deepEqual(logStartCaps(['A','B','C'],{A:0,B:4,D:10}),{A:0,B:4});
});
