# Master_Thesis-20: revision list against the current prototype

Reviewed 26 September 2026. Source: `/Users/luisschwarz/Downloads/Master_Thesis-20.pdf`.
Page numbers below are the **printed thesis pages**. For numbered body pages, add
14 to obtain the PDF viewer page. The draft and application code were not edited
during that review. Follow-up: lifecycle discovery now defaults to 90%; item 17
below has been updated for that implementation change. The PDF remains unchanged.

This list distinguishes factual text corrections, results that require a new
experiment or provenance check, and semantic gaps requiring an explicit scope
restriction or code change. A limitation paragraph cannot establish a guarantee
the implementation does not provide. Historical results are not automatically
invalid, but must be attributed to the implementation and settings that produced
them rather than presented as measurements of the current version.

## 1. Requirements: replace absolute guarantees with assessable requirements

**Where:** Table 4.1, p. 22; assess fulfillment again in Chapter 5.

- **R2 currently:** generated traces must respect the constraints. **Replace with:**
  “The prototype uses OC-Declare constraints to restrict candidate execution and
  tracks supported response requirements. Conformance of generated logs is
  evaluated separately under the stated semantic and termination assumptions.”
  If universal conformance remains the requirement, assess it as **partially met**;
  do not claim that the current prototype guarantees it.
- **R3 currently:** all simulation parameters must be automatically discoverable.
  **Replace with:** “The prototype derives supported behavioral, temporal,
  lifecycle and relationship parameters from an input log and allows explicit
  user configuration where discovery is insufficient.” Manual BPIC lifecycle
  settings and user-selected seeds/stopping bounds are not automatically
  discovered parameters.
- **R4 currently:** “IEEE OCEL 2.0 standard.” **Replace with:** “OCEL 2.0 JSON
  specification,” unless an actual IEEE standard identifier is supplied. Assess
  interoperability with named readers and tested examples; do not equate successful
  JSON loading with full structural and semantic validity.
- **R5:** distinguish bounded stopping from successful completion. A run may stop
  with running work, active objects or pending obligations. Its idle-iteration
  safeguard is not a general proof that no legal future execution exists.

## 2. Replace the claim of five uniformly enforced templates

**Where:** pp. 23, 26, 40 and 42. **Scope/code decision, not merely wording.**

The draft conflates discovery, import, engine checking and external evaluation.
Replace the “five templates checked eagerly” statement with a support table for
these four stages. Current source inspection and a direct adapter check show:

| Arrow | Discovered dictionary converted for simulation | Important qualification |
| --- | --- | --- |
| EF | `response` | Response bookkeeping plus operational upper bounds |
| EP | `precedence`, reversed endpoints | Operational predecessor gate |
| DF | `response` | Direct adjacency is lost on this path |
| DP | `precedence`, reversed endpoints | Direct adjacency is lost on this path |
| AS | `coexistence` | No eager gate in the constraint dispatcher |

The separate arc-list loader maps DF/DP to `direct_response`/`direct_precedence`,
which also lack dedicated dispatcher branches. Hand-configured `chain_response`
and `chain_precedence` handlers exist, but their existence does not establish that
imported direct arrows use them. The default discovery arrow set is EF/EP/AS;
DF/DP can be enabled. The notebook-aligned conformance evaluator supports **EF/EP
only**, and rejects other arrows and indirect object labels explicitly.

**Replacement claim:** “Discovery and simulation support differ by arrow type and
input format. The evaluated semantic subset is specified explicitly; unsupported
or approximated arrows are not claimed as fully implemented.”

If full five-arrow enforcement is central to the thesis contribution, the import
and checking paths need repair and verification before making that claim. Merely
removing the sentence would not fix the behavior.

Evidence: [discovery conversion](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/ParameterDiscovery/OCDeclarediscovery.py:1016),
[dictionary adapter](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Models/OCDeclare.py:198),
[arc-list adapter](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Models/OCDeclare.py:565),
[dispatcher](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Engine/semantics.py:762),
[evaluation validation](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Evaluation/notebook_measures.py:550).

## 3. Expand the simulation parameter table

**Where:** Table 4.2, p. 23; parameter discussion pp. 34–35.

**Current:** start policy lists only a global cap; several parameters used by the
engine are missing. **Add:** per-activity start caps, interarrival distributions,
activity concurrency caps, weekly availability profiles, per-type object-local
transition probabilities, empirical creation-count distributions, O2O partner
bounds and multiple object-type involvement bindings. Include the optional
wall-clock runtime limit and distinguish start limits from completion/stop limits.

For the starting-count field state: “Each selected starting activity has a maximum
number of starts. The value defaults to its observed event count; users may
override it. Clearing it restores the discovered default. If no default exists,
a non-negative integer is required; zero disables that start activity.” Running
and completed starts both count toward the limit.

## 4. Update Algorithm 1 admission checks

**Where:** Algorithm 1, p. 25, especially lines 17–18.

**Current:** discard a candidate immediately when a participating object is busy.
**Replace with:** try free eligible secondary bindings while preserving primary
and forced response objects, participant counts and sampled creation counts;
skip the candidate if none succeeds. Recheck semantic constraints and relationship
capacity immediately before allocating objects and starting the instance.

State explicitly that global execution upper limits include **completed and
running** instances. An open calendar or an available concurrency slot does not
grant additional allowance under a total execution limit.

## 5. Correct Algorithm 1 clock advancement

**Where:** Algorithm 1 lines 19–27, p. 25; DES prose p. 24; timestamps p. 27.

**Current:** advance to the next completion whenever anything is running; arrivals
and calendar changes are considered only when idle. **Replace with:** construct
the next-time candidates from the earliest running completion, eligible scheduled
arrivals and relevant calendar boundaries; advance to their minimum, bounded by
the simulation deadline. These alternatives matter even while other work runs.

Retain the no-progress safeguard and stop checks. If describing arrival catch-up
in detail, note that a successfully advanced overdue arrival schedule can trigger
another iteration at the same simulation time. Replace vague references to
unprinted “Start/Complete procedure” and “Candidate ordering” with actual
subprocedures or the relevant explanatory paragraphs.

## 6. Describe the actual start/completion phases and locking

**Where:** pp. 24–26 and 35.

**Current:** only permanent object types are described as locked, and the loop
re-attempts a resource waiting queue. **Replace with:** every participating object
is exclusive to its running activity until completion. Explicit resource-pool
handling and its resource waiting queue are disabled; blocked work is reconsidered
through candidate generation.

Add the phase distinction: objects and validated O2O links are created at start;
the event, attribute effects, response bookkeeping and deactivation occur at
completion. Existing response requirements are fulfilled before lifecycle cleanup.
An object can be created and deactivated in the same completed activity.

## 7. Correct candidate construction and creation counts

**Where:** candidate generation pp. 25–26; object-population discussion pp. 35–36.

**Current:** creating bindings instantiate exactly `min_count` new objects.
**Replace with:** “Creation quantities are sampled from an empirical distribution
of first appearances for each activity/object-type pair. This distribution can
include zero, allowing reuse. Existing objects fill the participation minimum;
where a creating binding has insufficient existing objects, a bootstrap rule can
create the shortfall. The configured maximum bounds the resulting participation.”

When no empirical distribution is supplied, the implementation initially uses
`max(1, min_count)` as the creation quantity, then applies its binding maximum.

Explain that participation cardinality and number of newly created objects are
different quantities. If discussing performance, describe an incrementally
maintained candidate pool with rescans when needed, rather than an unconditional
full scan at every step. Link preference does not remove semantic checks on
alternative secondary objects.

## 8. Rewrite response obligation management

**Where:** p. 26; pp. 35 and 40–41.

**Current:** effectively one pending target per scope object, cleared by one target
event; fallback injection of the whole obligation map; all obligations touching
a deactivated object cancelled.

**Replace with:** “Each source activation and Each-object assignment creates an
independent requirement for `nmin` qualifying future target completions. Each
matching completion counts once for that requirement; it can also contribute to
other earlier activations. A zero minimum creates no positive requirement.
Requirements become ready when their tracked prerequisites are satisfied and
can inject complete target bindings subject to the ordinary admission checks.”

Remove the obsolete fallback description. Explain that Each/All requirements need
their mandatory objects, whereas an Any group can survive deactivation of one
member if another remains active. Impossible requirements are cancelled and
recorded as violations. A terminal response is blocked from destroying its own
unfinished requirement; unrelated terminal activities retain cancellation behavior.

## 9. Correct the explanation of Each, Any and All

**Where:** p. 26; Table 4.2 scope description.

**Current:** All is described as essentially the same separate per-object check as
Each, and scope appears limited to one object type. **Replace with:** for supported
response matching, Each creates separate requirements for Cartesian combinations
of the source event's Each objects; All requires the relevant source objects
**together in the same qualifying target event**; Any requires at least one object
from its group in that event. Conditions from multiple types must hold jointly.

Example: after `A({o1,o2})`, separate `B(o1)` and `B(o2)` can satisfy two Each
requirements with minimum one, but they do not satisfy an All requirement.
Do not generalize this implementation description to every legacy template without
checking its specific handler.

## 10. Update candidate ordering and Algorithm 4's context

**Where:** Selection pp. 26–27; probability discovery pp. 29–30; p. 35.

**Current:** one draw from the last global activity's row is moved to the front;
the rest remain in their original order. **Replace with:** when object-local
transition data exists, weight each candidate using its primary object's type
and last activity, then order the **whole pool** by weighted sampling without
replacement. Missing context receives a neutral weight; zero-weight successors
receive a small positive fallback. The older single-draw path remains a fallback
when object-local data is absent.

Algorithm 4's row-normalized adjacent-pair counts remain a valid building block,
but explain per-object traces, grouping by object type, the start state and how
the primary object's row is selected. Probabilities prioritize feasible candidates;
they do not guarantee reproduction of the log's transition frequencies.

## 11. Rewrite O2O discovery and explain relationship creation

**Where:** O2O paragraph p. 30; parameter discussion p. 34; candidate checking p. 26.

**Current:** rules are inferred from event co-participation and are bidirectional.
**Replace with:** “O2O discovery reads the input log's declared object relationships
and counts distinct partners in each direction. Equal directional bounds produce
one bidirectional rule; asymmetric bounds produce two directional rules. A log
without declared relationships yields no inferred O2O rules.”

For precision, the discovery extrema currently range over objects appearing in
the relevant link map; zero-degree objects are not inserted into that population.
Qualifiers are aggregated, and same-type links are outside the discovered rule
representation.

Add the simulation assumption: within a candidate, matching type-pair rules plan
links between existing and/or newly created objects. All applicable upper bounds
must permit the complete plan. This candidate-local pairing is an operational
choice; cardinalities alone do not identify the real-world partner.

Minima are post-run diagnostics, separated for active and inactive objects; they
are not an unconditional admission guarantee. Keep O2O audit results separate
from temporal OC-Declare conformance scores.

## 12. Correct the OCEL output description

**Where:** Section 4.4, p. 27.

**Current:** five standard collections, including `objectRelations`.
**Replace with:** “The output uses the four standard collections `objectTypes`,
`eventTypes`, `objects` and `events`. Object-to-object links appear in each source
object's `relationships` array. Event-to-object links appear in each event's
`relationships` array. Qualifiers are currently empty strings.”

The exporter also writes metadata fields; four standard collections does not mean
there are literally only four JSON keys. Cite the
[official JSON specification](https://www.ocel-standard.org/specification/formats/json/).

Report the actual validation evidence: the relationship fixture passes the
published schema, and the tested Container export preserves its links through
PM4Py and the prototype loader. Do not claim every export passes that schema:
the numeric-attribute example encountered a mismatch between the published
string-only attribute-value schema and the specification's numeric example.

## 13. Qualify reproducibility and lifecycle reconstruction

**Where:** Section 4.4, p. 27.

**Current:** sorting makes JSON byte-identical with the same seed; lifecycle is
re-derivable from event order. **Replace with:** “Deterministic serialization orders
the recorded output. Repeatability of simulation also depends on the implementation,
Python/hash-seed environment, complete model and discovery parameters, initial
state, stopping policy and start timestamp. Fixed simulation seed alone does not
establish byte-identical output.” Wall-clock limits introduce additional variability.

Also qualify lifecycle reconstruction: exported events record completions, while
objects are created at start. First/last appearances provide observed lifecycle
proxies, not exact runtime creation/deactivation timestamps. A bounded run may
export an object whose creating activity has not completed.

## 14. Replace blanket claims that attributes and object reuse are absent

**Where:** scope p. 21; pp. 31, 35–36, 38, 40 and 42.

**Current:** attributes are not implemented/populated; their absence makes
initialization/exit flags necessary and prevents a limited object pool.
**Replace with:** “The implementation contains attribute guards, effects, event
attribute capture and object attribute history. Rich attribute-driven behavior is
not part of the evaluated scope [if this matches the experiments]. Meaningful
relationship-role qualifiers and explicit resource-pool semantics remain limited.”

Explain creation/deactivation flags as explicit runtime lifecycle decisions,
separate from attribute mutability and relationship roles. A reusable resource
does not require immutable attributes, and qualifiers do not by themselves define
resource capacity. Existing objects can be reused; the current limitation is the
absence of a general dedicated resource-pool policy and guarantee on population,
not complete inability to reuse Truck or Forklift objects.

OCEL 1.0 compatibility should be attributed to loader normalization of supported
data, not merely to omitting attributes or qualifiers.

## 15. Correct service-time estimation and percentile windows

**Where:** Section 4.5 pp. 27–28; discussion p. 34; limitations p. 41.

**Current:** vague or inconsistent windows, and all backward-sojourn estimates
are said to be forced into the conservative window.
**Replace with:** “The estimator compares forward next-event gaps with positive
backward latest-predecessor gaps and selects the source with the smaller
upper-middle median, preferring forward gaps on a tie. It summarizes an inclusive
rank window: `minimum` selects minimum–P25, `p25` selects minimum–P50, and `p50`
selects P25–P75. Supplied anchors override the estimate.”

State that these are heuristic duration estimates, not observed processing times.
The lower tail is not demonstrably pure service time. Remove the universal
conservative-window claim: the current `using_fallback` condition does not force
nonempty backward samples into that window. Align the limitations' compressed
range example with the actual mode names and empirical rank selection.

## 16. Address the degenerate extra timing calculations in Algorithm 2

**Where:** Algorithm 2 lines 13–15, p. 28; richer timing categories p. 42.

The stated pooling formula equals the synchronization range, and the lagging
formula subtracts the latest predecessor timestamp from itself, giving zero.
These are present in the discovery helper, but are not distinct informative
estimates of those timing components.

**Change to:** omit these unused quantities from a service-estimation algorithm,
with an explicit note that they are not validated timing components, or correct
and test their definitions before using them as measured results. Do not describe
the existing formulas as a successful implementation of independent pooling and
lagging measures. The current Evaluation tab's WMAPE/W1 use service estimates,
not these two auxiliary outputs.

## 17. Reconcile lifecycle threshold and endpoint rules

**Where:** p. 29, prose and Algorithm 3.

**Current:** prose says 90%; Algorithm 3 says default 0.5. **Keep 90% in the prose
and change Algorithm 3's default to 0.9.** The follow-up implementation now matches
that value in the backend and UI; explicit overrides remain possible. State the
actual setting used for each reported experiment, with saved evidence.

Update Algorithm 3 to count first and last activities independently, per object
type, using all declared instances of that type as the denominator. An object
without events contributes to the denominator but not to either activity count.
An activity qualifies at a share greater than or equal to 0.9; if none qualifies,
leave the corresponding flag unset. Both flags may apply to the same activity.
Remove the creator-exclusion/single-event exception and the rare-endpoint loop.
Events are ordered by UTC timestamp with event ID breaking ties. Rediscovery
replaces old flags and requires a log, rather than falling back to arc directions.

State that missing prefixes/suffixes can bias first/last observations; a threshold
is a heuristic, not a guarantee that incomplete logs are handled correctly. Flags
are activity-wide simulation parameters, so they do not distinguish separate
first and last occurrences of a repeated activity. Remove “REDO ALGORITHM.”

## 18. Rename and specify calendar availability

**Where:** “Calendar resources,” p. 30; pp. 35 and 39.

**Replace with:** “Process-level probabilistic availability is estimated for 168
weekly hour slots. A slot's probability is the fraction of observed weeks in which
any recorded activity occurred in that slot. Activities share this estimated
profile; the simulator samples and caches its open/closed decision per activity
and simulation hour.”

Do not call this identification of individual resource calendars. Lack of an event
does not uniquely establish lack of availability, so observation frequency is an
assumption. Distinguish this gate, per-activity concurrency, per-object locking and
total execution caps. Also document interarrival timing for eligible creating
activities; starts are not described adequately by “a chance at every iteration.”
Discovered concurrency is based on overlap of intervals constructed using estimated
durations, not direct observation of a physical resource capacity.

## 19. Replace the explanation of nmin/nmax as consumable permissions

**Where:** “Nmin/nmax scoping,” pp. 40–41; p. 34's eventual satisfaction claim.

**Current:** bounds exist to prevent a satisfied constraint from being reusable;
one precedence firing would otherwise be incorrectly reusable forever.
**Replace with:** “OC-Declare bounds constrain numbers of matching events for
specified activations and object involvement. A predecessor is not necessarily a
consumed token; the same earlier event can legitimately witness several later
precedence activations.”

Then distinguish formal bounds from the prototype's operational caps. The adapter
can derive runtime values from observed endpoint counts; the evaluator retains
the canonical model bounds. The response upper-bound check is history-wide rather
than a fresh temporal window per source activation. These choices can restrict
behavior beyond the original model and must be identified as approximations.

Replace “constraints will be satisfied at some point” with a conditional statement:
completion requires feasible bindings, compatible constraints and sufficient run
length. Neither random selection nor bounded termination guarantees it. Document
completion-order handling of timestamp ties versus the evaluator's strict EF/EP
timestamp comparisons.

## 20. Complete evaluation definitions with the implemented formulas

**Where:** Section 3.1.5, pp. 18–19; Table 4.3, p. 31.

Replace every “FORMULA” and specify inputs, denominators and exclusions:

- **KL:** compare normalized category counts on their union, add 0.5 to each
  category before normalization, use base-2 logarithms, and report both directions.
  State whether counting events, object instances or event-object attachments.
- **Relative NGD:** use per-object activity sequences, timestamp/event-ID ordering,
  `n−1` boundary padding at both ends and normalized n-gram histograms;
  `NGD = 0.5 × sum_g |p_input(g) − p_sim(g)|`, for n=2 and n=3. Specify pooled
  versus per-type reporting and undefined empty distributions.
- **WMAPE:** expand as weighted mean **absolute** percentage error, not “average.”
  For the shared activity means or standard deviations:
  `100 × sum_a |x_sim,a − x_input,a| / sum_a |x_input,a|`.
  There is no additional event-frequency weight. Report missing activities and
  undefined zero denominators rather than treating them as zero error.
- **W1:** compute empirical Wasserstein-1 per activity on the selected timing
  samples, in hours. State which aggregate is reported: the implementation offers
  input-sample-count-weighted mean, unweighted mean and median. Anchored activities
  are excluded from this sample comparison. The percentile window is not applied
  a second time.

Specify that the Evaluation tab processes full saved logs using the supplied
notebook's definitions. Do not conflate this with internal simulation counters,
the preview subset or older evaluation endpoints.

Evidence: [evaluation definitions and tests](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Evaluation/README.md).

## 21. Correct confidence and violation units, and state evaluator scope

**Where:** p. 19; results pp. 31–32; discussion p. 37.

**Current:** confidence and violations may disagree because several failing object
combinations are counted for one activation. **Replace with the current units:**

- Per-constraint confidence: satisfied source-event activations / source-event
  activations. No activations gives undefined confidence.
- Global confidence: `1 − (number of events violating at least one evaluated
  constraint / number of events)` for a nonempty log.
- Event violation rate: affected events / all events; it is exactly complementary
  to global confidence under the same model and log.
- Activation violation rate: failed event–constraint activations / all
  event–constraint activations. It has a different denominator from global confidence.
- Failed Each bindings are diagnostic details, not multiple incident rows for
  the same event–constraint activation.

Thus 4% global confidence cannot coexist with 3% **event** violation rate under
the same current evaluation. Do not simply change 3 to 96 in the thesis: rerun
and identify which measure was originally reported.

State EF/EP-only and direct-label support explicitly. An unsupported-arrow result
is unavailable, not success and not a silently filtered model. Describe this as
event/constraint evaluation; do not imply a separate automaton replay was used.

## 22. Replace the five-axis overall coverage score

**Where:** p. 19; pp. 31–32 and 37–38; Table 4.3.

The current notebook-aligned evaluator reports seven separate diagnostics:

1. Activity coverage.
2. Object-type coverage.
3. Source-activation coverage.
4. Non-vacuous activation coverage.
5. Object-presence coverage.
6. Finite-boundary coverage.
7. Matching-event coverage.

**Replace** the claimed five-axis combined “overall coverage” with these named
measures and their denominators. There is no implemented overall coverage score.
Do not use a historical 97% aggregate to establish that every relevant semantic
case was exercised. Preserve the useful distinction between coverage, conformance
and fidelity.

## 23. Replace results only after a final-version rerun or explicit historical labeling

**Where:** Section 4.6 pp. 30–32; Table 4.3; discussion pp. 33 and 36–39.
**Experiment/provenance work required.**

Table 4.3 still contains ellipses. Complete it from a saved current evaluation
report, not from manually copied incompatible metrics. Rerun simulations and
evaluation if claiming results for the current implementation. Alternatively,
retain old runs clearly as historical development experiments with their exact
code version and measurement definitions.

For each final run record input-log/model identity, code version, simulation and
Python hash seeds, timing mode, lifecycle threshold, manual changes, start caps,
stop conditions, simulated horizon, wall time, hardware, event/object/link counts,
completion state and metric aggregation. Use multiple seeds where feasible and
report variation. Preserve unsupported or undefined outputs as such.

The recent bounded smoke runs are regression evidence, not replacements for the
thesis's long experiments: they used synthetic one-second durations. One older
saved BPIC model cannot start because `A_Create Application` requires prior
`O_Sent (mail and online)` on `Case_R`. The saved Container run retains pending and
cancelled obligations. Neither result proves that the draft's historical runs
never occurred; they show why exact model/configuration provenance is essential.

## 24. Reconcile contradictory runtimes and demonstration counts

**Where:** pp. 18, 30–32, 39, 41 and 42.

- P. 31 says BPIC simulated **3 days in 259 minutes**. P. 39 says **29 days in
  1.5 hours**, with 1.2 million events. Check the run records. If these are separate
  runs, assign run IDs and separate configurations/results; otherwise correct
  the erroneous statement. Do not choose a preferred number without evidence.
- P. 18 describes **five constructed plus two reference-log demonstrations**;
  p. 41 says **three total runs, one constructed plus two reference logs**.
  Separate completed experiments from planned cases and software regression tests.
- “Constructed runs” on p. 30 is an empty placeholder. Supply each constructed
  model, expected behavior, observed result and what it establishes.

## 25. Correct result interpretation and causal overstatements

**Where:** pp. 36–39.

- **KL:** larger reverse divergence shows an asymmetric distribution mismatch;
  it does not establish that an object type has more absolute instances than in
  the input. To claim overcreation, show per-type counts, proportions, exposure
  and completion/reuse information. Resource population is a possible explanation,
  not something proved by the KL direction alone.
- **W1:** say that the implemented univariate sample-distribution comparison
  ignores sample order. The broader claim that W1 favors mean-like estimates
  needs a precise source and matching experimental context; otherwise remove it.
  Lower W1 in hours across different datasets is not by itself a comparable
  relative-fidelity ranking. Use each dataset's reference scale and complementary
  measures.
- **Scalability:** replace “double the amount of active objects and constraints”
  with possible accumulation of active objects, bindings and pending obligations.
  The static constraint set does not double, and equal population growth on each
  cycle has not been shown. Attribute a measured bottleneck only to profiling
  evidence; otherwise label candidate generation and constraint checking as
  plausible cost drivers.
- Update all rankings and explanations after the final results are available.
  Model permissiveness, discovery choices and engine approximations are possible
  contributors, not individually established causes from two runs.

## 26. Add implementation verification separately from empirical fidelity

**Where:** end of Section 4.3 or beginning of Section 4.6; cross-reference Chapter 5.

Add a short verification table based on the saved report: 99 backend tests,
3 frontend tests, successful production build with existing warnings, and 32
focused tests passing under each of two hash seeds with pool-cache checks.
The integrated scenario completed 25 cases/100 events and all 75 response
requirements for each simulation seed 1, 7 and 42, with no outstanding requirements
or busy objects.

Describe the important behaviors tested: concurrent upper limits, guarded
rebinding, multi-response counts, Each/All/Any matching, calendar gates, stop
conditions and preservation of O2O links in external readers. These observations
support tested properties; they do not establish formal soundness for all models
or predictive validity. Re-run this suite on the actual submission version.

Evidence: [verification report](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/output/verification/simulation-fixes-2026-09-26.md).

## 27. Make end-of-run and semantic limitations explicit

**Where:** pp. 33–35 and Section 5.2, pp. 40–41.

Add a compact limitations paragraph covering: history-wide response caps;
completion-order versus strict-timestamp semantics; unsupported/approximated
arrow import paths; bounded runs with unfinished work; lifecycle-induced
cancellation; O2O minima as diagnostics; and restricted conformance evaluator
support. Report pending, cancelled and fulfilled obligations separately.

A syntactically exportable log is not necessarily a completed conforming trace.
The notebook evaluates a supplied finite log as completed and does not classify
pending obligations by whether a future extension could repair them. State when
truncation can contribute to reported violations, without treating every violation
as harmless truncation.

The circular-evaluation paragraphs on pp. 19, 40–41 are useful and should remain:
the current experiments study reconstruction of observed behavior, not predictive
generalization. Preserve the distinction between conformance and similarity.

## 28. Finish document structure, references and research-question answers

**Where:** title page, abstract p. iii, pp. 17–19, 21, 27–31, bibliography p. 43,
appendices pp. 45–47, and closing discussion.

- Replace title-page template fields and the entire sample abstract about sleep
  and academic performance with the actual question, method, artifact, verified
  results and limitations.
- Replace every `SOURCE`, `XXX`, `FORMULA`, `LABEL!!!!`, `REDO ALGORITHM`,
  citation question and unfinished reference with a real item or remove it.
  In Section 4.1, the requirements reference to Section 3.2 currently points to
  Ethics; use Section 3.1.2 and Table 4.1 as appropriate. The p. 17 reference to
  requirements in Section 4.2 should point to Section 4.1/Table 4.1.
- The bibliography does not yet cover the many named works cited in prose.
  Resolve those records, including dates, titles and venues; replace the OCPQ
  commit `<hash>` with the actual version used. For algorithms adapted from papers,
  distinguish the source method from implementation-specific heuristics.
- Scope universal novelty claims such as “no existing tool” to the surveyed
  approaches and literature-search cutoff unless a broader claim is justified.
- Remove the unused consent-form and interview-question appendices if no human
  study was performed. Verification cases, run settings and full metric definitions
  would be relevant appendices instead.
- Close with explicit answers to the main question and four subquestions, and an
  achieved/partially achieved assessment of R1–R6. Full OC-Declare soundness or
  reliable what-if prediction should not be inferred from the present evidence.
- Proofread after substantive revisions: many remaining spelling errors and
  inconsistent activity/dataset names are visible, but correcting them does not
  resolve the technical mismatches above.

## Suggested revision order

First decide and disclose the semantic subset (items 1–2, 19, 21 and 27). Then
update the algorithm and implementation descriptions (3–18). Establish one final
version and reproducible run configurations, execute verification and experiments,
and update formulas/results/interpretation (20–26). Finish the abstract,
research-question answers and references last (28). Do not invent replacement
measurements to fill the unfinished results table.
