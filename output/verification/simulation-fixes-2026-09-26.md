# Simulation fixes and verification — 26 September 2026

All four requested fixes are implemented. The automated checks pass. This is
regression evidence for the implemented operational semantics, not a proof that
every discovered model can produce a complete conforming log.

## Implemented changes

1. **Secondary object selection.** If an initial secondary binding is invalid or
   becomes busy, try eligible alternatives while preserving the chosen activity,
   primary/forced objects, participant counts and sampled creation counts. Every
   replacement must pass guards, OC-Declare admission checks, relationship bounds,
   object exclusivity and streak limits. Alternatives are generated lazily and
   respect stop requests and runtime limits.
2. **Global execution limits.** Completed and running instances both count toward
   global absence/exactly/response upper limits. Admission is checked again before
   allocating objects or starting work. Calendars control when work is available;
   concurrency caps control simultaneous work. Neither replaces a total execution
   limit.
3. **Response counts.** Each source activation has its own remaining minimum count.
   A qualifying target completion decrements it once. Repeated activations and
   separate constraints remain independent; a target event can satisfy several
   earlier activations. A zero minimum creates no positive requirement.
4. **Joint responses.** Each and All objects are retained in a target candidate;
   each Any group supplies a qualifying member. Partial All events do not count.
   Overlapping mandatory groups are joined for terminal responses if their binding
   bounds permit it. An impossible group remains pending rather than executing an
   invalid terminal response.

The DES still starts activities, reserves their objects, schedules completions in
the same heap, and advances to the next completion/arrival/calendar boundary.
Events, response bookkeeping and deactivation still occur at completion. Changes
to selected participants, parallelism and response counts are intentional.

## Automated results

| Check | Result |
| --- | --- |
| Full backend unittest suite | 99 passed; no skips reported |
| Focused execution suite, `PYTHONHASHSEED=1`, pool-cache debug checks | 32 passed |
| Same focused suite, `PYTHONHASHSEED=42` | 32 passed |
| Frontend starting-count tests | 3 passed |
| Frontend production build | Passed; existing CSS syntax and Vite deprecation warnings remain |
| Python compilation and diff whitespace check | Passed |

The combined simulation regression runs 25 cases with shared machines, linked
Order/Item creation, two required Work events per case, precedence and terminal
responses. For each simulation seed 1, 7 and 42 it produces 100 events, fulfills
all 75 activation requirements, records no violations, retains all 25 links and
leaves no pending obligations, busy objects or running work. Other tests cover
calendars, stop requests, impossible joint bindings, guard exemptions, mixed
Each/Any/All scopes, repeated prerequisites, OCEL schema structure, PM4Py loading
and the Flask simulation endpoint.

The hash-seed checks verify these properties under different iteration orders;
they do not establish identical event logs across hash seeds.

Run from the project root:

```sh
MPLCONFIGDIR=/tmp/projecttest-matplotlib python3 -m unittest discover -s Backend/tests -p 'test_*.py' -q
PYTHONHASHSEED=1 SIM_DEBUG_POOL_CHECK=1 python3 -m unittest Backend.tests.test_execution_semantics -q
PYTHONHASHSEED=42 SIM_DEBUG_POOL_CHECK=1 python3 -m unittest Backend.tests.test_execution_semantics -q
node --test Frontend/src/startActivityCounts.test.mjs
npm --prefix Frontend run build
```

## Saved-model smoke runs

These were bounded verification runs, not calibrated experiments: simulation seed
7, Python hash seed 1, maximum 500 events, 30 starting events and 15 seconds runtime.
The saved models contain no timing parameters, so each activity was assigned a
fixed one-second duration in memory. Saved input files were not edited.

| Saved model | Events | Objects | Links | Fulfilled / pending / cancelled requirements |
| --- | ---: | ---: | ---: | --- |
| `discovered_container_logistics_20260915_090557.json` | 165 | 105 | 83 | 140 / 50 / 15 |
| `discovered_BPIC17RunOCELlog_20260908_092643.json` | 0 | 0 | 0 | 0 / 0 / 0 |

Container Logistics terminated without an exception or running activities. Both
PM4Py and the prototype loader recovered exactly the 83 directed object links;
the relationship audit found no upper-bound violations. Pending and cancelled
requirements mean this is **not** a fully conforming completed run.

The saved BPIC model cannot start from an empty state: its only selected start,
`A_Create Application`, requires a prior `O_Sent (mail and online)` event on
`Case_R`, with `nmin=1`. The precedence checker is structurally identical to its
version at HEAD, confirming this blocker was not introduced by these fixes.

The Container export also exposes a published-schema inconsistency: the official
downloadable schema accepts only strings as attribute values, whereas the
[official JSON example](https://www.ocel-standard.org/specification/formats/json/)
uses numeric values and documents numeric/boolean types. The unmodified schema
reports 45 numeric attribute-value errors and no other structural errors for this
export. Numeric values were retained; no blanket schema-validation claim is made
for this saved-model log. The relationship regression fixture passes the official
schema. Both readers load the saved-model export successfully.

## Remaining semantic limits

- The existing response upper-bound check is history-wide, not a distinct temporal
  window for each source activation. The fixes preserve this approximation.
- Response order follows completion processing order. Equal timestamps can differ
  from strict timestamp ordering used by external evaluation.
- Candidate injection does not solve incompatible models or guarantee completion
  before a stopping bound. Unrelated terminal activities can still cancel response
  requirements, and those cancellations remain recorded as violations.

These limits should remain explicit in the thesis. The four fixes strengthen the
existing operational behavior without replacing the simulation loop or claiming
complete equivalence to all formal temporal OC-Declare semantics.
