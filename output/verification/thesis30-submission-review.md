# Submission review: Master_Thesis-30 and the prototype

Reviewed 28 September 2026. Code baseline: commit `d784e7c` plus the existing uncommitted timing-discovery changes. Application code and the thesis PDF were not changed by this review.

**Verdict: I would not submit the current pair as final.** The prototype is a working research artifact, but there are reproducible constraint-enforcement errors and substantial inconsistencies between the implementation, evaluation notebook, and draft. These concern the central correctness argument, not just production readiness. They do not establish that the thesis will fail; grading depends on the assessment criteria and the final evidence.

Page references below use the thesis's printed page numbers. Add 14 for the corresponding PDF page. The abstract is printed page iii / PDF page 3.

## What was verified

- All 125 existing backend tests passed.
- All nine frontend tests passed.
- The frontend production build succeeded, with existing CSS syntax warnings.
- Additional examples reproduced invalid precedence events in actual simulator runs, not merely in isolated helper calls.
- Import/discovery probes confirmed inconsistent handling of DF/DP.
- Separate Python processes with the same simulation seed produced different exports when the Python hash seed changed.
- The current reference notebook was read and compared with the application port. It has changed since that port was made.
- Relevant draft pages, including the results and requirement tables and Algorithm 1, were visually checked.

These checks do not establish correctness for arbitrary models. The multi-hour Container Logistics and BPIC experiments were not rerun, and their historical scores were not independently reproduced. This is an artifact-focused review, not a complete verification of the literature or institutional grading requirements.

## 1. Fix the precedence matching and cardinality errors

**Priority: substantive code blocker for the advertised semantics.** Relevant thesis: pp. 26, 31, 38 and 48.

The matching helper combines per-object predecessor events into one union instead of checking every Cartesian combination of Each objects. The subsequent minimum check counts that union. A separate maximum check counts occurrences of the constrained activity rather than the preceding events that an EP constraint actually bounds.

Three small simulations exposed this:

| Constraint and history | Required behavior | Observed behavior |
|---|---|---|
| EP from B to A, Each(Order), Each(Item). Earlier A events involve (o1,i1) and (o2,i2); B involves all four objects. | Reject B: combinations (o1,i2) and (o2,i1) have no matching A. | B executed; the evaluator marked its activation as violating. |
| EP from B to A, Each(Order), minimum 2. o1 has two A events; o2 has one; B involves both. | Reject B: o2 has fewer than two preceding A events. | B executed; its activation violated the minimum. |
| EP from B to A, Each(Order), bounds [1,1]. One order has A then A. | Reject B: there are two preceding A events, exceeding the maximum. | B executed; its activation violated the maximum. |

All these examples used positive durations and distinct timestamps. They do not depend on lifecycle discovery, ties, or truncating an outstanding response at the simulation horizon.

**Change needed:** count qualifying predecessor events separately for every Each assignment, combined with the joint All/Any filters, and apply both formal bounds to that count. Verify the admission prefilters against the same semantics. Keep empirical execution caps separate from the formal OC-Declare counts.

Evidence:
- [Joint predecessor matching](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Engine/semantics.py:169).
- [Precedence bounds](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Engine/semantics.py:351).
- [Runtime bound substitution](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Models/OCDeclare.py:242).

The description on p. 48 also needs correction: declarative counts do not generally mean that an event or obligation is “used up.” One later response can satisfy several earlier response activations. A cap intended to limit simulation growth is an additional execution policy.

## 2. DF/DP support depends on the import path and loses meaning

**Priority: substantive code blocker if DF/DP are claimed as supported.** Relevant thesis: pp. 27, 31, 47 and 49.

- Internal discovery serializes DF as ordinary `response` and DP as ordinary `precedence`. This removes immediacy during execution.
- External arc-list import creates `direct_response` and `direct_precedence`. Those names have no corresponding dispatch branch in the constraint checker, whose fallback returns True.
- The engine does contain `chain_response` and `chain_precedence` checkers. Their existence does not mean discovered or imported DF/DP reach them.
- AS is not eagerly enforced; the current Evaluation tab also rejects AS models.

**Change needed:** consistently translate supported arrows and implement/test their object-matching semantics. Until then, explicitly reject or label unsupported paths instead of silently weakening the model. Merely renaming to the chain checkers is not sufficient evidence of full mixed-involvement correctness.

Evidence:
- [Discovery translation](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/ParameterDiscovery/OCDeclarediscovery.py:1017).
- [External import translation](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Models/OCDeclare.py:573).
- [Constraint dispatch](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Engine/semantics.py:762).

## 3. The Evaluation tab no longer matches the current notebook

**Priority: evaluation validity and reproducibility blocker.** Relevant thesis: pp. 20–22, 33–34 and the evaluation results.

The current notebook at `oc-declare-simulation-evaluation/evaluationmeasures.ipynb` now:

- supports EF, EP, AS, DF and DP for direct object-type involvement;
- uses the new timing discovery with default P25;
- can normalize OCEL 1.0 inputs before evaluation.

The application's port still:

- accepts only EF and EP;
- uses the previous timing windows and defaults to the mode named Minimum;
- requires raw OCEL 2.0 object/event lists.

The recorded notebook SHA-256 is `2a02ac8efc15e923a6403d9e1080d9eebf9fc0baf80a215227c63fc60cc44aca`; the current file hashes to `9f75c3ee987fc2f37a4d217ab23a7a75e743558eb71763c7d0a1742a2c114676`. Source inspection confirms functional differences, so this is not merely a changed output cell.

For timing samples 1 through 8 seconds:

| Selected label | Simulation discovery mean | Current frontend evaluation mean |
|---|---:|---:|
| Minimum | 1.0 | 1.5 |
| P25 | 1.5 | 2.5 |
| P50 | 2.5 | 4.0 |

The application evaluation's default Minimum and simulation discovery's default P25 both happen to select the lowest quarter. Therefore, this finding does not prove that every default timing result is numerically wrong. It does prove that selecting the same named mode is inconsistent, and that the implementation does not match the current notebook.

**Change needed:** designate and freeze one evaluation implementation/version, align the frontend if it is meant to use that method, and regenerate the report fixtures. If the experiments used the notebook separately, state that explicitly and record its exact version. The thesis's five-arrow evaluator statement can describe the current notebook, but cannot currently describe the application evaluator.

Evidence:
- [Allowed evaluation arrows](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Evaluation/notebook_measures.py:564).
- [Evaluation input and mode validation](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Evaluation/service.py:177).
- [Evaluation controls](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/NotebookEvaluation.jsx:194).
- [Current simulation timing windows](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/ParameterDiscovery/timediscovery.py:14).

## 4. Reconcile the results, metric definitions and interpretations

**Priority: substantive thesis blocker.** Relevant thesis: pp. 21–22, 37–38 and 43–44.

### Inconsistent values

Table 4.3 and the prose report different BPIC values:

| Measure | Table 4.3, p. 37 | Prose, pp. 37–38 and 43 |
|---|---:|---:|
| Event KL | 2.1 / 1.8 | 3.8 / 2.6 |
| Object KL | 0.8 / 3.3 | 1.1 / 4.1 |
| NGD 2 | 0.79 | 0.88 |
| NGD 3 | 0.84 | 0.91 |
| Mean WMAPE | 91% | 95% |

The Container Logistics column and several other cells remain placeholders. These differences need to be resolved from saved reports for identified runs, not by choosing whichever number seems plausible.

### Overall coverage

The draft reports 97% “overall coverage.” Both current evaluators explicitly report separate coverage diagnostics and do not define an overall aggregate. Remove this claim or formally define and justify a separate aggregate, then recompute it. Do not imply the current tool produced that measure.

### Violation units

Formula 6 counts constraints with at least one failing activation. The prose reports percentages without consistently identifying the denominator. Page 44 further explains the difference using multiple failing object combinations per activation, but both current evaluators count a failed event–constraint activation once.

Use distinct names:
- affected constraints / all constraints;
- failed activations / all activations;
- affected events / all events.

Event violation rate equals one minus global confidence. Thus 4% global confidence implies 96% event violation rate, not 3%. A 3% value might belong to a different diagnostic or run; the available evidence does not establish which. It should not be treated as that complement.

**Change needed:** export a complete report from each frozen experiment, name every score and denominator, and use that report as the single source for tables and discussion.

## 5. Match the strength of the conclusions to the evidence

**Priority: substantive thesis blocker.** Relevant thesis: R2 on p. 26, Table 4.4 on p. 38, conclusions on pp. 51–52.

R2 says generated traces must respect the constraints. Table 4.4 labels it fulfilled while acknowledging partial support and no guarantee of conformance. This is not full fulfillment of the stated requirement.

The reported 48.5% and 4% global confidence scores, if verified, concern model satisfaction, not merely reproduction of the reference log's preferred behavior. An OC-Declare model can allow behavior unlike the reference while that behavior remains fully conformant. Low fidelity and low conformance must be discussed separately.

**Change needed:** mark R2 partially fulfilled against its present wording. Report a supported subset and demonstrate it using small completed traces checked independently. Explain the reference-log results as evidence of limitations of the current pipeline. Do not imply that passing unit tests or producing an OCEL establishes semantic correctness.

There is useful proof-of-concept evidence here, but the core errors in findings 1–2 need correction or explicit exclusion from supported use. A general “prototype limitation” sentence does not make an incorrect description of Each or EP bounds accurate.

## 6. Replace the outdated algorithms and timing descriptions

**Priority: thesis correction before submission.**

- **Algorithm 1, p. 30:** lines 19–25 choose the next completion whenever anything is running and only consider arrivals/calendars when idle. The actual loop considers completion, eligible arrival, calendar opening and deadline together. It also handles completions at the deadline before stopping and tries alternative object bindings when participants are busy.
- **Algorithm 2, pp. 33–34:** update the mode list and window definitions to Minimum = one lowest value; P25 = lowest ceil(0.25n); P50 = lowest ceil(0.5n); Full mean = all. Update the stale timing limitation on p. 48 as well.
- **Algorithm 3, p. 35:** despite the prose's 90% rule, it still includes the old single-event exception and rare-terminal fallback and excludes eventless objects from the denominator. The current implementation has independent first/last thresholds, no exceptions, and includes all declared objects. This is a stale algorithm issue separate from the lifecycle design tradeoff already discussed.

Evidence:
- [Current clock advancement](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Engine/simulator.py:1852).
- [Current lifecycle discovery](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/ParameterDiscovery/lifecycle.py:48).

## 7. Correct the reproducibility claim

**Priority: claim correction, plus experimental metadata.** Relevant thesis: p. 32.

Sorting the exported events does not make simulations byte-identical solely because they use the same RNG seed. Candidate generation iterates sets, so process hash randomization changes object ordering and which object receives which random draw.

A probe with identical model, state and simulation seed 42 produced:
- hash seed 1: export SHA-256 `bf4856cd7afff64e8cb27e82073fc6b2632f270eb56ceef7e2ab6b10a45c820b`;
- hash seed 2: export SHA-256 `f3e6a798730cbe8a8b4700a081b71c04e2793cecf0f616a222465388ca5a00f7`.

This is an environment difference, but the current thesis promises equality from the simulation seed alone. The application does not record the Python hash seed. Wall-clock-limited runs introduce another source of variation.

**Change needed:** stabilize iteration order, or narrow the claim and record the hash seed, software versions, exact configuration/model and start timestamp. Avoid wall-clock stopping when claiming reproducible event content.

Evidence: [Set iteration in object selection](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/src/Simulation/Engine/candidategeneration.py:57).

## 8. Correct secondary implementation claims

These are mostly writing/scope corrections, not reasons to abandon the prototype.

| Location | Correction |
|---|---|
| p. 27, “max completed cases” | The current `max_cases` check counts completed start-activity firings, not cases whose entire lifecycle has ended. Name the implemented limit accurately or implement the intended completed-case definition. |
| p. 31, canceled obligations | Deactivation cancels obligations that become impossible. An Any obligation can survive through another active eligible object; not every obligation involving a departing object is canceled. |
| p. 36, O2O discovery | Replace the co-participation wording: discovery reads declared object-to-object relationships. Co-occurrence in an event is not the source. Explain that upper bounds are admission checks while lower bounds are post-run diagnostics. |
| pp. 32, 47, 49, attributes | Optional model-defined defaults, guards, updates, event captures and timestamped object-attribute export exist in the backend. Distinguish these capabilities from automatic attribute discovery and the empty attributes of the demonstrated models. Attribute collections are arrays, not empty strings. |
| pp. 42, 49, resources | A finite reusable object pool does not inherently require attributes or qualifiers. Its absence is a prototype design/scope choice. Mutability and reusability are separate properties. |
| Table 4.4, R1 | If “quantifiers” means “qualifiers,” correct it. Each/All/Any are central to the claimed behavior and should not be casually listed as absent. |
| pp. 40, 48, timing interpretation | Small gaps are a heuristic for less waiting; they are not evidence that the selected gaps consist mostly of service time. Keep the proxy/assumption language consistent. |
| p. 43, KL interpretation | KL compares normalized distributions; a high reverse KL does not by itself prove a larger absolute object population. Support population explanations with object counts. |

## 9. Finish the draft and make the demonstrations traceable

**Priority: direct submission blocker.**

- The title page retains “A Subtitle Elaborating on Your Title.”
- The abstract's Results and Discussion contain template instructions and unrelated sleep/GPA examples.
- References and prose contain “SOURCE,” “XXX,” “UNDATED???,” “REDO ALGORITHM,” “NEEDS REVISION!!!!” and unresolved citation keys.
- “Constructed runs” on p. 36 has no demonstration results.
- The method on p. 18 says five constructed logs plus two reference logs, while p. 49 says only three runs, one constructed plus two reference runs. Distinguish input examples, executed experiments and reported runs consistently.
- The referenced OCPQ commit remains `<hash>`.
- For every reported run, include exact input/output/model filenames or hashes, discovery settings, manual edits, all stop conditions, seed and environment, termination reason and evaluation version.

The workspace history did not provide enough evidence to identify and recompute every draft result. This review does not infer that the results are fabricated; it identifies missing traceability and contradictions that need resolution.

## What can remain a proof-of-concept limitation

Incomplete fidelity, approximate service times, a small number of demonstration logs, lack of resource-specific pooling, empty qualifiers, and slow large-log execution can be acknowledged limitations if the claims are appropriately bounded.

The present DES scheduling, object locking, start-cap reservations, relationship creation and OCEL relationship round-trip have useful regression coverage. Those working components support continuing with the current architecture. The findings do not require a wholesale rewrite or adoption of artificial init/exit events before a defensible submission.

## Suggested order before submission

1. Correct the demonstrated EP matching/bound errors and make unsupported arrow/import paths explicit.
2. Align and freeze the evaluation implementation; verify the supported subset with adversarial small examples.
3. Freeze the application and experiment configuration, then rerun affected demonstrations and retain complete logs/reports.
4. Rebuild Tables 4.3–4.4 and the discussion from those reports; distinguish fidelity from conformance.
5. Replace stale algorithms and claims, finish the abstract/references, and package run instructions and evidence.

## Reproducing the code findings

From the project root:

```sh
PYTHONPATH=. python3 output/verification/thesis30-semantics-probe.py
PYTHONPATH=. PYTHONHASHSEED=1 python3 output/verification/thesis30-reproducibility-probe.py
PYTHONPATH=. PYTHONHASHSEED=2 python3 output/verification/thesis30-reproducibility-probe.py
```

These scripts are diagnostic artifacts, not new passing regression tests. They intentionally expose current behavior. The semantic probe results are saved in [thesis30-semantics-results.json](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/output/verification/thesis30-semantics-results.json).

