# Runtime improvements — 29 September 2026

Baseline: `b7088fde37559023d2699838dc545698afc8b92e`.

## Changes

- Scheduled completions are indexed by activity and object within a single admission check. Matching reservations retain their original order, duplicate entries and equal-time ties. Precedence checks are dispatched only to their target activities; direct-response checks still apply to intervening activities.
- Ordinary precedence checks during candidate generation use the maintained event-ID indexes to count the same joint Each/All/Any scope. Checks with a sampled timestamp, projected events or direct temporal windows retain timestamp filtering and nearest-event selection.
- Response candidate generation reuses deterministic binding-validation results only within its read-only pass. Candidate creation still happens each time, preserving creation-distribution random draws. Negative and positive results are discarded before the simulation state can change.
- Linked-object selection returns once the requested number of preferred objects is found, and immediately when zero are requested. Forced-object construction now also uses the existing per-pass active-object lookup cache.

The event loop, admission rules, lifecycle effects, timing distributions, selection probabilities, response bookkeeping and random-number calls were not relaxed or replaced. The changes avoid repeated work; they do not change configured limits or disable conformance checks.

## Verification

`python3 -m unittest discover -s Backend/tests -p 'test_*.py' -q`

**159 tests passed.** New verification includes:

- 2,000 varied admission states compared with the original unindexed schedule checker: EP, DP, DF, direct aliases, multiple scopes, bounds, guards, prospective creation, untimed histories and timestamp ties.
- 432 joint-scope predecessor-count comparisons plus a global-scope case against direct event filtering. Checks also verify that index sets remain unchanged.
- Twelve paired complete simulations with identical exported logs, pending obligations, reservations, fulfillment/cancellation counters and final random-number state.
- Repeated failed response bindings reuse validation while consuming every original creation-count draw. A subsequent history change triggers fresh validation.
- Link-preference equivalence, reservation-filter ordering and duplication, and cache invalidation between admission checks.

`git diff --check` passed. The running local backend returned `{"status":"ok"}` after reloading.

## Container-logistics comparison

Both versions used the saved model and durations from the 24 September container-logistics run, its transition matrix, 100 starts per starting activity, seed 42, `PYTHONHASHSEED=1`, and a fixed start timestamp. No parameter or pacing rediscovery was performed. This is a reproducible bounded workload based on that saved configuration, not a reproduction of the interrupted 20,000-event experiment or the current unsaved UI settings.

The baseline engine, candidate builder and semantic checker were loaded from copies taken before these edits. Both engines used the same unchanged parser/domain/exporter. Benchmarks ran sequentially, without profiling overhead.

| Event limit | Before | After | Runtime reduction | Identical results |
| --- | ---: | ---: | ---: | --- |
| 500 | 3.179 s | 2.872 s | 9.7% | Yes |
| 2,000 | 21.825 s | 15.142 s | 30.6% | Yes |

Both versions reached each event limit; neither reached the real-time safety limit. Results compared include the complete exported OCEL, pending obligation counts, running activity reservations and final random-number state. The 500-event runs created 135 objects; the 2,000-event runs created 221 objects.

An isolated schedule-check benchmark with 20,000 historical events and 1,000 running activities improved from approximately 41.2 ms to 11.2 ms (3.7×). That is a component measurement, not a claim that full simulations become 3.7× faster.

## Remaining limits

Candidate generation and response-binding search still become more expensive as the active state and unresolved requirements grow. The full 20,000-event experiment was not rerun. These bounded checks establish equivalent behavior on the tested fixtures and a measured runtime improvement; they do not guarantee a particular speedup for every model.

Keep the machine awake when measuring computation time. The displayed elapsed timer still includes time spent asleep. A real-time stopping budget can produce more events after an optimization because more work fits within the same wall-clock budget; use event/simulated-time limits for comparisons of generated behavior.
