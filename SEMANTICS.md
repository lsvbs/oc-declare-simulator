# OC-Declare Simulator — Semantics Reference

This document describes the simulation semantics for the Declarative Object-Centric (OC-Declare)
Process Simulator. It covers how constraints are enforced, how time works, how resources are
managed, and how the DES engine operates.

---

## 1. Simulation Modes

### Step-based mode
Used when no resource types are defined. Activities fire one per step. No concurrency, no clock.
Candidate pool is rebuilt each step and one candidate is selected by the probability matrix.

### DES mode (Discrete Event Simulation)
Activated automatically when resource types are configured. Multiple activities can be in-flight
simultaneously. The simulation clock advances to the next completion time on a min-heap.
Each activity has a `started_at` and `complete_at` timestamp.

---

## 2. Candidate Pool Construction

Each simulation step builds a pool of feasible candidates:

1. For each activity, find all active non-resource objects of the primary binding type (capped at 32 per activity).
2. Build a `Candidate(activity_name, participating_object_ids, object_types_to_create)` for each object.
3. Filter by `is_candidate_semantically_allowed` — runs all constraint and O2O checks.
4. Apply max-consecutive caps (global and per-object).
5. **Response obligation injection (Option 4):** for every pending obligation `(B, scope_object_id)` in `_obligations_count`, inject B with that scope object into the pool if not already present. All normal semantic checks still apply.

---

## 3. Constraint Semantics

### Scope
- `each <ObjectType>`: constraint applies per individual object of that type. Checked separately for each scope object in the candidate.
- `global`: constraint applies across all objects of all types.

### Precedence `precedence(A → B nmin=N nmax=M per ObjectType)`
**Backwards-looking gate.** Checked when B is proposed as a candidate.

- For each scope object `o` in the candidate: count how many times A has fired on `o`.
- If `count < nmin` → B is **rejected** from the candidate pool for this object.
- If `count > nmax` → B is **rejected** (A has fired too many times).
- If no scope objects are found: falls back to global check (has A ever fired at all?).

**Effect:** B is permanently blocked until A has fired at least `nmin` times on the scope object.
Once the source count exceeds `nmax`, B is permanently blocked again (useful for capping cycles).

### Response `response(A → B nmin=N nmax=M per ObjectType)`
**Forward obligation + pool injection.** Two distinct mechanisms:

**a) Obligation creation (when A fires):**
After A fires, for each scope object `o` in the event, an obligation `(B, o)` is added to
`state._obligations_count`. This obligation persists until B fires on that object.

**b) Pool injection (Option 4 — continuous enforcement):**
Every step, for every pending obligation `(B, o)`, B is injected into the candidate pool with
object `o`. B stays a candidate until the obligation is cleared. All other checks (precedence,
O2O, resources) still apply — injection does not bypass them.

**c) nmax enforcement (eager):**
If B has already fired `nmax` times on a scope object, B is blocked regardless of pending obligations.

**d) Obligation clearance:**
When B fires on scope object `o`, all obligations `(B, o)` are cleared.

**Effect:** After A fires, B is always available as a candidate until it fires — "A fires → B must
eventually happen." The probability matrix still determines when B fires within that window.

### Not-Coexistence `not_coexistence(A, B per ObjectType)`
If A has already fired on scope object `o`, B is blocked for `o` (and vice versa).
Once one of the pair fires on an object, the other is permanently blocked for that object.

### Not-Precedence `not_precedence(A → B per ObjectType)`
Once A has fired on scope object `o`, B is permanently blocked for `o`.

### Not-Succession `not_succession(A → B per ObjectType)`
After A fires on scope object `o`, B must never follow. If A has fired, B is blocked.

### Not-Chain-Succession `not_chain_succession(A → B per ObjectType)`
B must not occur immediately after A on the same scope object (last activity ≠ A).

### Chain-Precedence `chain_precedence(A → B per ObjectType)`
The most recent activity on each scope object must be A. B is only allowed immediately after A.

### Chain-Response `chain_response(A → B per ObjectType)`
After A fires on a scope object, only B may fire next on that object. Other activities are blocked
until B fires.

### Alternate-Response `alternate_response(A → B per ObjectType)`
Between each A firing and its matching B, no other A may occur on the same scope object.
Blocks A from firing again until B has responded to the previous A.

### Alternate-Precedence `alternate_precedence(A → B per ObjectType)`
Each B firing must be preceded by an A, with no other B in between. Blocks B when the
number of B firings already equals or exceeds the number of A firings on the scope object.

### Responded-Existence `responded_existence(A, B per ObjectType)`
Post-hoc only — not enforced during the run. Audited at end of simulation.

### Absence `absence(A nmax=M per ObjectType)`
A must never fire (nmax=0) or fire at most M times on the scope object.

### Exactly `exactly(A nmin=N per ObjectType)`
A must fire exactly N times. Blocks A after N firings.

### Init `init(A)`
A must be the first activity to fire. All others are blocked until A fires at least once.

### Exclusive-Choice `exclusive_choice(A, B per ObjectType)`
Once one of the pair fires on a scope object, the other is permanently blocked.

### Composite types
- `succession = precedence ∧ response`
- `chain_succession = chain_precedence ∧ chain_response`
- `alternate_succession = alternate_response ∧ alternate_precedence`

---

## 4. O2O Rules

Object-to-object cardinality rules constrain how many links can exist between objects of two types.

`O2O(TypeA ↔ TypeB min=1 max=M)`

Checked when a candidate would create a new link between participating objects:
- Count existing links from the candidate's TypeA objects to TypeB objects.
- Add new links that would be created by this firing.
- If total > max_links → candidate is **rejected**.

**Resource types are exempt from O2O checks.** Resources are shared across cases and should
not accumulate permanent link caps that block future firings.

Links are stored persistently in `state.links` (for the output OCEL) but when a non-resource
object is deactivated, its links to resource objects are removed from the runtime index
`state._links_by_object`, freeing the resource for future cases.

---

## 5. Resource Handling

Resource types (e.g. Forklift, Truck) are pre-populated at simulation start from
`resource_pool_sizes`. They are:

- **Never created** by activity firings (even if `creates=True` on the binding — treated as pool selection)
- **Never deactivated** by activity firings (even if `deactivates=True` — exempt)
- **Not subject to declarative constraints** (filtered out of scope object lookups)
- **Not subject to O2O max_links** (O2O rules involving resource types are skipped)
- **Locked during DES activities:** `busy_until` is set to `complete_at` when an activity starts.
  Other candidates needing that resource are queued in `state.waiting_queue`.
- **Released on completion:** `busy_until` is cleared, waiting candidates are retried.

**Link cleanup on object deactivation:** when a non-resource case object is deactivated, its
link entries to resource objects are removed from `_links_by_object`. If the resource has no
remaining active non-resource neighbours, its entire link set is cleared — the resource is
fully free for the next case chain.

---

## 6. Timing

### Service time
Sampled from the activity's `ActivityDuration` distribution (lognormal by default):
```
σ_log = sqrt(ln(1 + std² / mean²))
μ_log = ln(mean) - 0.5 · σ_log²
sample = lognormvariate(μ_log, σ_log)
service_duration = clamp(sample, min_seconds, max_seconds)
```
`complete_at = current_time + service_duration`

Service duration is recorded in `state.activity_service_s` before any waiting is added.

### Process waiting time
`waiting_mean` and `waiting_std` from timing discovery represent real-world calendar gaps
between events (lead times, batching, administrative delays) that are not explicitly modelled.
They are sampled and added to `complete_at` to reproduce realistic time spans:
```
complete_at += sample_waiting(waiting_mean, waiting_std)
```
Recorded separately in `state.process_wait_s`. Does not affect the service time metric.

### Clock advancement (DES)
The simulation clock `state.current_time` advances to the earliest `complete_at` in the
in-progress heap:
```python
state.current_time = state.in_progress[0].complete_at
```
All activities started at the same `current_time` are truly concurrent — they each sample
their duration from `current_time` independently, not from each other's completion.

### Resource wait time
When a candidate's resource is busy, the candidate queues in `state.waiting_queue`.
When the resource is released, queue time is recorded in `state.resource_wait_s`.

### Candidate wait time (step-based mode)
Time from when an activity first appeared in the candidate pool to when it was chosen.
Recorded in `state.candidate_wait_s`.

---

## 7. Object Lifecycle

Objects are created when an activity with `creates=True` fires. They are deactivated when
an activity with `deactivates=True` fires on them. Deactivated objects are removed from
`state._active_by_type` and can no longer participate in new candidates.

Start activities (listed in `config.start_policy.start_activity_names`) are the only activities
allowed to fire at simulation start (step 0). They are typically activities that create their
primary case object (e.g. Register Customer Order creates a Customer Order).

---

## 8. Metrics

Computed after the run by `compute_metrics` in `src/Simulation/IO/output/metrics.py`:

| Metric | Definition |
|---|---|
| `mean_service_s` | Mean sampled work duration per firing |
| `mean_process_wait_s` | Mean sampled pre-start calendar gap |
| `mean_resource_wait_s` | Mean time queued waiting for a busy resource (DES only) |
| `mean_wait_in_pool_s` | Mean time in candidate pool before selection (step-based only) |
| `mean_sojourn_s` | service + candidate_wait (or service + process_wait if available) |

Object metrics include per-object lifetime, event count, and activity sequence.
