# Replacements for Algorithms 1–3 in Master_Thesis-30.pdf

Use `00-preamble.tex` once in the thesis preamble. Replace the existing algorithm environments with `01-simulation.tex`, `02-timing.tex`, and `03-lifecycle.tex` in that order. LaTeX assigns their numbers automatically. Preserve your existing labels if other parts of your thesis refer to them. The combined file contains the same three environments. These snippets use `algorithm` and `algpseudocode`, not `algorithm2e`.

No LaTeX compiler is installed in this environment, so compilation and final page fit have not been verified. The snippets use standard package commands; the first two may need smaller type or an appendix if your thesis has a short text area.

## Algorithm 1 — printed page 30

The old lines 19–25 advance directly to the earliest completion whenever anything is running. Actual execution also wakes for eligible arrivals and calendar changes while work is running. The replacement computes one set of relevant wake-up times and clips it to the simulation deadline. Completions due exactly at the deadline are processed before the time-limit check; event, case, trace, and wall-clock limits can still stop earlier.

The old busy-object rule also skips immediately. The implementation first tries another valid binding while preserving required objects. Admission rechecks semantics and object relationships, and now checks the sampled completion time together with already scheduled work so that EP/DP and DF are not invalidated by zero durations or concurrent events.

Describe the helper procedures immediately below the algorithm:

- `GenerateCandidates` binds available objects, applies multiplicity, guards, precedence and other admission checks, and includes candidates for ready response obligations.
- `OrderCandidates` uses object-local transition weights for a weighted ordering of the full pool when available; otherwise it uses the existing global transition procedure. It does not choose only a single event to execute.
- `AdmitAndSchedule` revalidates constraints and obligation preservation, plans required object links, samples a completion from the current clock, and validates that completion against recorded and already scheduled events. A rejected temporal reservation restores the random-generator state and allocates nothing. A successful one creates the requested objects and links, locks all participants, schedules completion, and advances the activity's arrival schedule.
- `Complete` releases participants and concurrency capacity, records attribute updates and the event, updates indexes and response obligations, then applies deactivation and cancels impossible obligations. It also updates execution metrics.
- `catchup` allows another iteration at the current instant only after a successful start has advanced a positive-gap arrival schedule that is still overdue. Capped or blocked arrivals do not keep the clock spinning.

Do not describe `max_cases` as a count of completed object lifecycles: the current code counts completed firings of configured start activities. `max_traces` counts objects. Pending obligations at a configured stop are still possible; the loop is not a proof of completed-log conformance.

The adjacent constraint paragraph also needs adjustment: `Each` quantifies over every Cartesian combination when several types are labelled Each. `Any` is a union of matching events, intersected with other object filters; it is not a separate per-object test. Both EP bounds apply to matching earlier source events. DF/DP apply the complete object filter before selecting the nearest later/earlier timestamp. Endpoint `observed_counts` are descriptive statistics, not replacements for declared constraint bounds. The blanket inactive-type skip should not be claimed for these joint temporal constraints.

## Algorithm 2 — printed page 34

The old mode list and the old interpretation of percentile windows are outdated. The replacement uses:

- Minimum: one smallest sample; its fitted mean/min/max coincide and standard deviation is zero.
- P25 (default): the smallest `ceil(n/4)` samples.
- P50: the smallest `ceil(n/2)` samples.
- Full mean: all `n` samples.

These windows apply to the selected gap sample source. The implementation still chooses between forward gaps and positive backward sojourn gaps by their upper median, preferring forward gaps on a tie. It does **not** always fit raw sojourn values. For a sorted, nonempty list X, its upper median is X[floor(|X|/2)+1] in one-based notation. Event-gap estimates are not measured service durations. Anchors override the empirical fit; their missing mean/std default to the sojourn summary, minimum to zero, and maximum to unbounded.

The existing lagging expression is mathematically zero, because `late` is already the maximum of the per-type latest times; pooling as implemented equals the sync span. The replacement reports these formulas faithfully instead of implying an independent bottleneck measure. They are not used in the service sampling decision. Updating their statistical meaning would be a separate methodological change.

## Algorithm 3 — printed page 35

The current algorithm has three substantive mismatches:

1. The denominator is **all declared objects** of the type, including unused objects; it is not only nonempty traces.
2. Creation and deactivation are calculated **independently**. One activity can have both flags. The old single-event exception/overlap suppression is gone.
3. The old rare-ending fallback is gone. An activity below the threshold does not gain a deactivation flag simply because it always ends the few traces in which it occurs.

The replacement also records deterministic endpoint tie handling: UTC timestamp, then string event ID. Invalid relevant timestamps are rejected. No qualifying activity means an empty set, not a forced best match. Remove the draft's `REDO ALGORITHM` placeholder. These are prototype lifecycle heuristics; they are not the paper's inserted artificial init/exit events.
