# OC-Declare Simulator — Semantics Reference

This document describes the simulation semantics for the Declarative Object-Centric (OC-Declare)
Process Simulator. It covers how constraints are enforced, how time works, how resources are
managed, and how the DES engine operates.

---

## 1. Simulation Modes

### DES mode (Discrete Event Simulation)
All runs use DES. Multiple activities can be in-flight simultaneously.
The simulation clock advances to the earliest completion, eligible arrival, or calendar change,
bounded by the simulation deadline.
Each activity has a `started_at` and `complete_at` timestamp.

---

## 2. Candidate Pool Construction

Each simulation step builds a pool of feasible candidates:

1. For each activity, find active objects of the primary binding type. Pin each primary object in turn,
   filling any required batch with additional eligible objects of that type. Deduplicate identical candidates.
2. Build a `Candidate(activity_name, participating_object_ids, object_types_to_create)` for each object.
3. Filter by `is_candidate_semantically_allowed` — runs all constraint and O2O checks.
   If a secondary binding fails, try eligible alternatives while keeping the primary object,
   forced response objects, binding counts and sampled creation counts unchanged.
4. Apply max-consecutive caps (global and per-object).
5. **Response obligation injection:** offer a complete binding for each ready response
   requirement not already represented by a candidate. Each/All objects are retained and
   Any groups contribute an eligible member. All normal semantic checks still apply.

Immediately before starting, recheck constraints against the current state, including
running instances. If an earlier start has claimed a secondary object, try free alternatives
using the same checks. Calendars, concurrency caps, start caps and object exclusivity still
govern admission; no clock or completion scheduling rule is changed by rebinding.

---

## 3. Constraint Semantics

### Scope
- `each <ObjectType>`: constraint applies per individual object of that type. Checked separately for each scope object in the candidate.
- `any <ObjectType>` in a response: a qualifying target event contains at least one object
  of that type from the source event.
- `all <ObjectType>` in a response: a qualifying target event contains every object of
  that type from the source event, together in the same event.
- Multiple response bindings must hold jointly in a target event. Each bindings create
  separate requirements for each combination of source objects; All and Any groups are
  retained within each requirement.
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
**Forward obligation + pool injection, with a separate eager upper bound:**

**a) Obligation creation (when A fires):**
Each completion of A creates independent requirements identified by the constraint,
source event and Each assignment. Each requirement starts with N responses remaining;
`nmin=0` creates no positive requirement. Repeated activations and different constraints
sharing the same target are tracked separately.

**b) Pool injection (Option 4 — continuous enforcement):**
Every step, ready requirements can inject B with all mandatory objects and an eligible
member of each Any group. All participants must pass binding bounds, guards, constraints,
O2O checks and availability checks. Overlapping mandatory groups are joined for a terminal
response when its binding bounds permit this. An impossible group remains outstanding;
the engine does not substitute an invalid partial event.

**c) nmax enforcement (eager):**
Completed and running B instances count toward the existing scope-based upper bound.
Global limits therefore cannot be exceeded by several starts admitted in one simulation
step. This remains the prototype's history-wide cap, rather than a separate temporal
upper-bound window for every activation.

**d) Obligation clearance:**
Each qualifying B completion decrements a requirement once, regardless of how many Any
members it contains. The requirement is fulfilled only when its remaining count reaches
zero. One B may count for several earlier activations, but never for activations that have
not occurred yet. Fulfillment runs before creation of requirements for the completing event.

**Effect:** after A, the simulator keeps attempting a feasible B until the minimum is met.
Injection does not guarantee that incompatible models or bounded runs finish all obligations.
The probability-based ordering still operates on eligible candidates. A terminal B cannot
deactivate objects while leaving its own required responses incomplete; unrelated terminal
activities retain the existing cancellation-and-violation accounting.

Response ordering follows completion processing order, including completions with equal
timestamps. Strict timestamp ordering in external evaluation can differ for tied events;
this existing convention and the history-wide upper bound must be stated as prototype
limitations when comparing with full temporal OC-Declare semantics.

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
until B fires. The constraint index includes other activities that can touch the scope type,
so the check also runs when an intervening activity is proposed. Global chain rules apply to every activity.

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
Global upper limits reserve capacity for running instances as well as completed events.
An open calendar controls when work may start; it does not grant additional execution allowance.

### Exactly `exactly(A nmin=N per ObjectType)`
A must fire exactly N times. The admission check enforces the upper bound, including
running instances for global limits; it does not guarantee the lower bound before a run stops.

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

One pure relationship planner is used both for candidate admission and immediately before
activity start. It includes existing–existing, existing–new and new–new pairs within the
candidate. Only type pairs covered by an O2O rule are linked; self-links and duplicate
partners are excluded. Unrelated objects outside the candidate are never selected here.

Every applicable maximum is checked against existing distinct partners plus the complete
proposed set of links, including counts for newly created objects. A directional rule bounds
its source objects only; `bidirectional=True` applies the same bounds to both ends. Two
directional rules can therefore express one Order with many Items, each Item with one Order.
All applicable rules must hold. If the complete plan exceeds any maximum, the candidate is
rejected before objects, links, ID counters, locks or random samples are changed. The planner
does not select an arbitrary subset or infer a matching for ambiguous batches.

Minimums describe accumulated lifetime partner counts; they are **not immediate creation
preconditions**, since partners can be created by later activities. The post-run
`object_relationship_audit` reports objects below each minimum (active and inactive separately)
and above each maximum. Active objects can be incomplete at the chosen simulation horizon.
These diagnostics are separate from OC-Declare conformance and do not claim eventual
fulfilment of minimums. A domain requiring immediate minimums needs an explicit additional
enabling policy.

Objects and their validated links are committed at activity **start**, as before. Events,
attribute updates, obligations and deactivation remain at **completion**. The relationship
planner consumes no randomness and does not change OC-Declare scope or template evaluation,
candidate ranking, the event calendar, concurrency controls or stopping conditions. Corrected
links can intentionally change later object binding and transitive lookup. Current runtime
resource exemptions are disabled; this policy checks every configured O2O rule.

Links remain in `state.links` after object deactivation. Runtime neighbour indexes are
symmetric for binding/traversal, while export preserves the stored source/target orientation.
OCEL 2.0 output has four standard collections (`objectTypes`, `eventTypes`, `objects`, `events`),
with O2O links inside each source object's `relationships` as `{objectId, qualifier: ""}`.
There is no custom top-level `objectRelations` collection. Empty qualifiers reflect the
prototype's lack of role-specific relationship semantics.

### Thesis alignment (Master_Thesis-17 draft)

- Section 4.4, printed page 27: replace the five-collection description with the four
  collections and nested object relationships above. See the
  [official JSON specification](https://www.ocel-standard.org/specification/formats/json/).
- Section 4.5, printed page 30: the current discovery reads declared object relationships,
  not event co-participation. It emits one bidirectional rule for equal bounds, or two
  directional rules for asymmetric bounds. It does not infer individual partner identity
  from cardinalities alone; candidate-local link creation is an operational assumption.
- Section 5.1.2, printed page 34: distinguish hard O2O upper bounds from post-run minimum
  diagnostics, and distinguish O2O parameters from OC-Declare temporal constraints.
- The DES start/completion structure is preserved by this change. This is not a claim that
  every other sentence or algorithm in the draft already matches the implementation.
  Regenerate affected experimental logs and measurements: relationships that were absent
  during simulation cannot be reconstructed reliably by changing JSON structure alone.

---

## 5. Resource Handling

**Historical policy, currently disabled:** the resource-specific exemptions and cleanup
described below remain commented out in the implementation. Current runs treat these objects
like other object types, enforce their configured O2O rules, and use ordinary participant
locking. This section must not be cited as a description of the active resource policy.

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
The simulation clock `state.current_time` advances to the earliest of the next completion,
scheduled arrival with available capacity, calendar boundary, and simulation deadline.
Arrivals and calendar changes are considered even while activities are running.

All activities started at the same `current_time` are truly concurrent — they each sample
their duration from `current_time` independently, not from each other's completion.

Completions exactly at the deadline are included; no new activities start at the deadline.
Activities completing later remain unfinished and produce no completion event. Explicit event,
trace, case and runtime limits may stop a run earlier.

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

Each selected starting activity has an editable maximum number of starts in the UI.
It defaults to that activity's event count in the input log; clearing the field restores that
default. Without a discovered count, the user must enter a non-negative whole number.
Zero disables starts for that activity. Caps count both completed and in-progress instances,
preventing concurrent starts from exceeding the configured number. Reaching a start cap stops
new starts of that activity; downstream work can continue subject to the run's stop conditions.

On completion, the event fulfills response obligations before its objects are deactivated.
Lifecycle cleanup cancels only obligations still outstanding, including newly created obligations
that the deactivated objects can no longer fulfill.

---

## 8. Metrics

Computed after the run by `compute_metrics` in `Backend/src/Simulation/IO/output/metrics.py`:

| Metric | Definition |
|---|---|
| `mean_service_s` | Mean sampled work duration per firing |
| `mean_process_wait_s` | Mean sampled pre-start calendar gap |
| `mean_resource_wait_s` | Mean time queued waiting for a busy resource (DES only) |
| `mean_wait_in_pool_s` | Mean time in candidate pool before selection (step-based only) |
| `mean_sojourn_s` | service + candidate_wait (or service + process_wait if available) |

Object metrics include per-object lifetime, event count, and activity sequence.
