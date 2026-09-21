# Evaluation measures: implemented formulas and current inaccuracies

Code audit dated 21 September 2026. This document describes the current implementation, including its mistakes; it does not silently substitute textbook formulas. Scope: the Evaluation UI, its backend endpoints, and the timing summaries feeding them. No application code was changed.

## Notation and conventions

- $R,S$: real and simulated logs; $a$: activity; $o$: object; $c$: constraint.
- $N_L(a)$: number of events of activity $a$ in log $L$; $O_L(t)$: number of objects of type $t$.
- $\mathbf 1[P]$: 1 when proposition $P$ holds, otherwise 0.
- $\tau_o=(a_{o,1},\ldots,a_{o,m_o})$: an object's activity trace; $h_{o,i}(a)$: count of $a$ strictly before position $i$.
- $s_c,t_c$: source and target activity; $l_c,u_c$: lower and upper bounds. An absent upper bound means infinity. Frontend bounds default to $l_c=1$.
- Scores expressed as fractions are multiplied by 100 in percentage displays. Missing denominators generally return `null`, with exceptions identified below.
- Summary statistics use the population standard deviation: $\bar x=\sum_i x_i/n$, $\sigma=\sqrt{\sum_i(x_i-\bar x)^2/n}$. Minimum and maximum are ordinary sample extrema.

## 1. Object-replay fitness

Source: [App.jsx:1875](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:1875).

Define the implemented precedence predicate

$$
E_{o,i}=\bigwedge_{c:\,\mathrm{type}(c)=\mathrm{precedence},\ t_c=a_{o,i}}
\left[(l_c\leq0\lor h_{o,i}(s_c)>0)\land(u_c=\infty\lor h_{o,i}(s_c)\leq u_c)\right].
$$

Then

$$
F_{\mathrm{replay}}=\frac{\sum_o\sum_{i=1}^{m_o}\mathbf1[E_{o,i}]}{\sum_o m_o}.
$$

Per-object fitness uses only that object's numerator and denominator. Per-type fitness pools these counts over objects of that type; it is not an unweighted average of object scores.

**Inaccuracies:** only precedence is checked. Lower bounds above one are reduced to “at least one.” The upper bound is applied to prior source counts, whereas the simulation's scoped precedence checks cap target firings. Constraint scope and multi-type bindings are ignored. Shared events are counted once for each participating object. This is a restricted precedence check, not a replay of the simulator's full enabling logic.

## 2. Declarative constraint fitness

Source: [App.jsx:2011](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:2011).

Let $n_o(a)$ be the total activity count and $p_o(a)$ its last position, with absent activities assigned position (-1). Define activation $A_{co}$ and satisfaction $Q_{co}$ exactly as follows:

| Constraint | Evaluated when $A_{co}$ | Current satisfaction predicate $Q_{co}$ |
|---|---|---|
| response | $n_o(s_c)>0$ | $n_o(t_c)\geq n_o(s_c)$ |
| precedence | $n_o(t_c)>0$ | $n_o(s_c)\geq l_c$ |
| not_coexistence | Always | Not both counts positive |
| not_succession | $n_o(s_c)>0$ | $p_o(t_c)\leq p_o(s_c)$ |
| All other types | Never | Omitted |

$$
F_{\mathrm{constraint}}=\frac{\sum_{c,o}\mathbf1[A_{co}]\mathbf1[Q_{co}]}{\sum_{c,o}\mathbf1[A_{co}]}.
$$

Per-constraint scores restrict the sums to that constraint. Labels omit scope and bounds, so distinct constraints with the same type/source/target can be merged in detail rows.

**Confirmed failures:** response and precedence both accept `B,A` for $A\to B$. `not_succession$A,B$` accepts `A,B,A`. Ordering is missing or insufficient, and most constraint types, bounds, and scopes are not evaluated.

## 3. “Declarative precision”

Source: [App.jsx:1945](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:1945).

Let $\mathcal A$ be the model's activity names. After position $i$, the code removes candidates blocked by its precedence predicate, `not_coexistence`, and `not_succession`; call the remaining set $U_{o,i}\subseteq\mathcal A$.

$$
P_{\mathrm{displayed}}=\frac{\sum_o\sum_{i=1}^{m_o-1}\mathbf1[a_{o,i+1}\in U_{o,i}]}{\sum_o\max(m_o-1,0)}.
$$

For precedence, use the predicate in section 1 with counts through position $i$. `not_coexistence` blocks either side if the other has occurred. `not_succession` blocks the target if the source has occurred.

Per-constraint details record the number of transitions where the constraint blocks the observed next activity, divided by the number where it blocks at least one candidate.

**Mislabeling:** this measures observed-transition admissibility. It never penalizes additional allowed behavior. A model allowing every activity gets 100%, even if the log uses only a tiny fraction of its possibilities. It also inherits the scope and bound problems above. Rename it unless a separate precision definition is implemented.

## 4. Event-level OC-Declare confidence and global conformance

Sources: [App.jsx:1626](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:1626), duplicated input-log checker at [App.jsx:5653](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:5653).

For each source event $e_i$, construct candidate target indices $T_c(i)$:

- `chain_response`: $\{i+1\}$ if present; `chain_precedence`: $\{i-1\}$ if present. **These branches do not verify the adjacent activity's label.**
- `response`, `precedence`, `succession`, `alternate_response`, `alternate_precedence`: target-activity events with timestamp $\geq t_i$, excluding $i$.
- Other types: all target-activity events except $i$, without a temporal restriction.

Define $b_c(k)=\mathbf1[l_c\leq k\leq u_c]$, except for `not_coexistence` and `not_succession`, where $b_c(k)=\mathbf1[k=0]$. Let $Q_i$ be the objects of the scope type in source event $i$, and $k_o=|\{j\in T_c(i):o\in O(e_j)\}|$.

The satisfaction predicate $H_c(i)$ is:

$$
\begin{array}{ll}
\mathrm{global}:&b_c(|T_c(i)|),\\
\mathrm{each}:&\bigwedge_{o\in Q_i}b_c(k_o),\\
\mathrm{any}:&\bigvee_{o\in Q_i}b_c(k_o),\\
\mathrm{all}:&b_c(|\{j\in T_c(i):Q_i\subseteq O(e_j)\}|).
\end{array}
$$

All scoped modes return true if $Q_i$ is empty. Events not labeled $s_c$ also return true.

$$
\mathrm{Confidence}(c)=\frac{\sum_{i:a_i=s_c}\mathbf1[H_c(i)]}{|\{i:a_i=s_c\}|},\qquad
\mathrm{GlobalConformance}=\frac1{|E|}\sum_i\mathbf1[\forall c:H_c(i)].
$$

Constraints without source events are omitted from confidence results. The global denominator includes non-activating events.

**Inaccuracies:** precedence looks forward from the source instead of checking the simulator's prior-source requirement at the target. Chain constraints can accept the wrong activity (`A,C` passes chain-response `A,B`). Negative succession ignores order. Alternate and succession semantics are not fully implemented. Equal timestamps can qualify regardless of their sequence position. Multi-type bindings are ignored. The separate `LogModelConformance` implementation treats every non-global scope as `each`, including `any` and `all`.

## 5. Backend post-hoc fitness and violation rates

Source: [server.py:2877](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:2877).

For constraint $c$, let $K_c$ be its checked-object count and $V_c$ its violated-object count:

$$
\mathrm{ViolationRate}_c=\frac{V_c}{K_c},\qquad
F_{\mathrm{posthoc}}=1-\frac{\sum_cV_c}{\sum_cK_c}.
$$

Both are rounded to four decimals. The backend uses these predicates:

| Type | Checked objects | Violation condition |
|---|---|---|
| response, succession | Source occurs | No target after the **first** source |
| responded_existence | Source occurs | Target absent |
| precedence | Target occurs | No source before first target |
| not_coexistence | All scope objects | Both activities occur |
| not_succession, not_precedence | Source occurs | Target occurs anywhere |
| coexistence | Either activity occurs | Exactly one activity occurs |
| exclusive_choice | All scope objects | Both occur or neither occurs |
| existence, init, last | All scope objects | Source absent |
| absence | All scope objects | Source count exceeds $u_c$, default cap 0 |
| exactly | All scope objects | Source count differs from $l_c$, backend default 0 |
| Other types | Source occurs | Never records a violation |

**Inaccuracies:** `A,B,A` passes response despite its final unfulfilled activation. Succession omits its precedence component. `init` and `last` do not check position. Existence ignores its count bound. Negative succession/precedence are collapsed into co-occurrence checks. Unsupported activated types can add successful checks. Scope type is used, but `each`/`any`/`all`/global are not evaluated with their distinct semantics. Consequently this score is not interchangeable with sections 2 or 4.

## 6. Activity frequencies, KL divergence, and event-count WMAPE

Sources: [server.py:3050](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:3050), [App.jsx:5016](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:5016).

Activity frequency:

$$
f_L(a)=\frac{N_L(a)}{\max(|E_L|,1)}.
$$

For the union of observed categories $K$, the code uses add-one smoothing:

$$
p_k=\frac{N_R(k)+1}{\sum_jN_R(j)+|K|},\quad q_k=\frac{N_S(k)+1}{\sum_jN_S(j)+|K|},\quad
D_{KL}(R\Vert S)=\sum_{k\in K}p_k\ln\frac{p_k}{q_k}.
$$

The same formula using object-type counts gives object-type KL. KL is rounded to six decimals and uses natural logarithms. Empty unions return 0 because the loop is empty.

$$
\mathrm{WMAPE}_{\mathrm{counts}}=100\frac{\sum_a|N_S(a)-N_R(a)|}{\sum_aN_R(a)}.
$$

**Interpretation:** KL compares smoothed proportions, not total volume. Add-one smoothing depends on sample size, so equal raw proportions at different sizes need not give zero KL. Count WMAPE is sensitive to volume: doubling every activity count gives 100% despite identical activity proportions. Calling it purely frequency fidelity is misleading.

## 7. Inter-event-gap EMD / Wasserstein-1

Source: [server.py:3096](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:3096).

Globally sort events by timestamp string and collect nonnegative differences between successive parsed timestamps:

$$
g_{L,i}=t_{L,i}-t_{L,i-1}.
$$

For sample lists $X,Y$, with empirical CDFs $F_X,F_Y$ and sorted unique combined values $z_1<\cdots<z_m$:

$$
W_1(X,Y)=\sum_{j=1}^{m-1}|F_X(z_j)-F_Y(z_j)|(z_{j+1}-z_j).
$$

This endpoint rounds W1 to four decimals. Units are seconds; empty samples give `null`. Gap means use the ordinary mean. The displayed “median” is the upper middle order statistic $g_{(\lfloor n/2\rfloor+1)}$, not the average of the two middle values for even $n$.

**Limitations:** these are whole-log event gaps, not case-arrival or service durations. Timestamp strings are sorted before parsing. Stripping `+00:00` can mix timezone-naive timestamps with other offsets and cause subtraction errors; chronological UTC normalization is needed for heterogeneous offsets.

## 8. Per-activity sojourn W1 and KS

Source: [server.py:3479](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:3479).

For event $e$, let $p_o(e)$ be the most recent earlier-in-traversal event timestamp for its object $o$. The sample is

$$
x_e=t_e-\max_{o:p_o(e)\text{ exists}}p_o(e).
$$

Only events with at least one predecessor and $0\leq x_e<365\cdot86400$ seconds are retained. Samples are grouped by activity.

$$
W_{1,a}=W_1(X_{R,a},X_{S,a}),\qquad
D_{KS,a}=\max_{z\in X_{R,a}\cup X_{S,a}}|F_{R,a}(z)-F_{S,a}(z)|.
$$

For $I$, the activities with samples on both sides, and $n_{R,a}=|X_{R,a}|$:

$$
\overline W_1=\frac{\sum_{a\in I}n_{R,a}W_{1,a}}{\sum_{a\in I}n_{R,a}},\qquad
\overline D_{KS}=\frac{\sum_{a\in I}n_{R,a}D_{KS,a}}{\sum_{a\in I}n_{R,a}}.
$$

Per-activity W1 is rounded to two decimals and KS to four **before** weighted aggregation; aggregates use the same respective precision. KS is dimensionless despite the `_s` response-field suffix. These are statistics, not significance tests; no p-values are calculated.

**Limitations:** missing activities are excluded from the aggregate rather than penalized. Initial events and gaps of at least a year are discarded. “Overall KS” is a weighted average of activity-level statistics, not the KS statistic of pooled samples. The endpoint docstring incorrectly says KS is computed on activity frequencies. This extractor also differs from the timing discovery function, which inserts zero sojourns for initial events.

## 9. Timing discovery and estimated service/waiting time

Source: [OCDeclarediscovery.py:2642](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/src/ParameterDiscovery/OCDeclarediscovery.py:2642).

For an event with predecessor timestamps, set $\alpha_e=\min_o p_o(e)$, $\beta_e=\max_o p_o(e)$, and completion time $t_e$. Then:

$$
\mathrm{Sojourn}_e=t_e-\beta_e,\quad
\mathrm{Synchronization}_e=\beta_e-\alpha_e,\quad
\mathrm{Flow}_e=t_e-\alpha_e.
$$

Differences are floored at zero. Events with no predecessor contribute zero flow and zero sojourn, but no synchronization/pooling/lagging sample.

For type $u$, let $\alpha_{e,u},\beta_{e,u}$ be its earliest and latest predecessor timestamps. The current implementation is:

$$
\mathrm{Pooling}_e=\max_u\beta_{e,u}-\min_u\alpha_{e,u}=\mathrm{Synchronization}_e,
$$
$$
\mathrm{Lagging}_e=\max_u\beta_{e,u}-\beta_e=0.
$$

**Confirmed defect:** pooling duplicates synchronization, and lagging is identically zero. These measures cannot provide distinct information as implemented.

Service is estimated, not observed. For each activity:

1. Collect forward gaps $D_a=\{t_{\mathrm{next}(e,o)}-t_e\}$, one per event-object pair with a next event.
2. Collect strictly positive backward sojourns $B_a^+$.
3. If both exist, use $D_a$ when its upper-middle median is no larger than the upper-middle median of $B_a^+$; otherwise use $B_a^+$. If only one exists, use it. If neither exists, use the sojourn list, which may contain zeros.
4. Sort the selected list $x_{(1)},\ldots,x_{(n)}$. `minimum` and any unrecognized mode use indices $1\ldots\lceil0.25n\rceil$; `p25` uses $1\ldots\lceil0.50n\rceil$; `p50` uses $\max(1,\lceil0.25n\rceil)\ldots\lceil0.75n\rceil$.
5. Service mean/std/min/max are the statistics of that window. Supplied anchors override these values. An empty source falls back to the sojourn statistics.

$$
\overline{\mathrm{Waiting}}_a=\max(0,\overline{\mathrm{Sojourn}}_a-\overline{\mathrm{Service}}_a),\qquad
\mathrm{WaitingStd}_a=\mathrm{SojournStd}_a.
$$

**Inaccuracies/approximations:** forward gaps include subsequent waiting/reuse and weight multi-object events repeatedly. The heuristic does not identify true processing duration. Waiting standard deviation is copied, not estimated from waiting samples. The `using_fallback` condition is false whenever the fallback list is nonempty, so the comment promising forced minimum-window estimation for fallback samples is not implemented. The comparison endpoint's default `sojourn` mode falls through to the minimum window. Empty metric lists become zero-valued statistics, which hides absence of evidence.

## 10. Timing WMAPE and percentage differences

Sources: [App.jsx:4084](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:4084), [App.jsx:5378](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:5378), [server.py:3418](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:3418).

Let $s_a$ be simulated mean service, $r_a$ input-log discovered mean service, $d_a$ output-log rediscovered mean service, and $w_a=N_S(a)$, falling back to 1 for zero/missing counts.

The main UI score, over available pairs with $r_a>0$, is

$$
\mathrm{WMAPE}_{S,R}=100\frac{\sum_aw_a|s_a-r_a|}{\sum_aw_ar_a}.
$$

The “Log mean vs Discovered” card instead uses output-discovered service as its reference:

$$
\mathrm{WMAPE}_{R,D}=100\frac{\sum_aw_a|r_a-d_a|}{\sum_aw_ad_a},\quad d_a>0.
$$

The backend comparison uses nine fields $\mathcal F=\{\mathrm{service\ mean,min,max},\mathrm{waiting\ mean},\mathrm{sojourn\ mean},\mathrm{sync\ mean},\mathrm{flow\ mean},\mathrm{pooling\ mean},\mathrm{lagging\ mean}\}$:

$$
\Delta_{a,f}\%=100\frac{s_{a,f}-r_{a,f}}{|r_{a,f}|},\qquad
\mathrm{WMAPE}_a=100\frac{\sum_{f\in J_a}|s_{a,f}-r_{a,f}|}{\sum_{f\in J_a}r_{a,f}},
$$

where $J_a$ requires both values present and $r_{a,f}>0$. Global backend WMAPE uses the same ratio over all activity-field pairs, **but additionally excludes simulated values equal to zero** because it tests their truthiness.

The W1 card's color-normalization denominator is

$$
M=\frac{\sum_{a:r_a>0}w_ar_a}{\sum_{a:r_a>0}w_a},\qquad \mathrm{W1ColorPercent}=100\overline W_1/M.
$$

**Inaccuracies:** global backend WMAPE drops complete underprediction to zero, unlike the per-activity score. The frontend weights by simulated counts despite a comment saying log counts. Missing/zero reference values are excluded. Service/synchronization/pooling/flow summaries overlap, so backend WMAPE repeatedly weights related quantities. The W1 tooltip calls $M$ real mean *sojourn*, but it uses discovered mean *service*, weighted by simulated counts. These separate WMAPE formulas should not be presented as one interchangeable measure.

## 11. N-gram distance (NGD)

Source: [App.jsx:3898](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:3898).

Each nonempty object trace is padded on both sides with $n-1$ `◦` symbols. The UI uses $n=2$. Let $C_L(g)$ count occurrences of padded n-gram $g$ across all supplied object traces:

$$
\mathrm{NGD}=\frac{\sum_g|C_S(g)-C_R(g)|}{\sum_g(C_S(g)+C_R(g))}.
$$

Both empty gives 0. The result lies in ([0,1]).

**Limitations:** raw counts make it size-sensitive: two copies of `A,B` against one copy give (1/3), although their normalized behavior is identical. Object types are pooled and shared events occur in multiple traces. String-joined keys and the dummy symbol can collide with activity names containing those literals.

## 12. OCPQ-labeled schema measures

Sources: [server.py:1494](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:1494), [App.jsx:3615](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:3615).

For activity pair $a\to b$, the implementation builds connections from **consecutive events on each object**, excluding equal-activity pairs. Let $P_{ab}$ be the set of distinct connected event-ID pairs and $U_{ab},V_{ab}$ its distinct source/target events:

$$
\mathrm{Support}_{ab}=|P_{ab}|,\qquad
\mathrm{Coverage}_{ab}=|U_{ab}|/N(a),\qquad
\mathrm{Reach}_{ab}=|V_{ab}|/N(b),
$$
$$
\mathrm{Selectivity}_{ab}=|U_{ab}|/|P_{ab}|,\qquad
\mathrm{Exclusivity}_{ab}=|V_{ab}|/|P_{ab}|.
$$

The latter two are reciprocals of mean fan-out and fan-in on connected events. All four ratios are rounded to four decimals.

For the **non-deduplicated** connection list $C_{ab}$, including one record per shared object:

$$
\mathrm{Throughput}_{ab}=\frac{\sum_{(e,f,o)\in C_{ab},\,t_e,t_f\text{ valid}}(t_f-t_e)}{|\{(e,f,o)\in C_{ab}:t_e,t_f\text{ valid}\}|}.
$$

This is rounded to one decimal. The equivalence-class field is the first eight hexadecimal characters of MD5 over sorted strings `sourceID>targetID` joined with `|`.

Overall support sums schema supports. Overall coverage/selectivity/reach/exclusivity/throughput are unweighted means of non-null schema values. Overall equivalence classes count distinct hash strings.

**Limitations:** only observed direct-follow schemas enter the means; absent schemas are not penalized. Throughput weights shared-object multiplicity, unlike deduplicated support. The implementation is not a general evaluation of model constraint schemas. Different activity pairs cannot ordinarily have identical nonempty event-pair sets, so the ID-based hash is not a useful structural equivalence measure across these pairs or across logs.

## 13. Coverage measures and radar axes

Source: [App.jsx:3164](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:3164).

Let $A_M$ contain model activities plus constraint endpoints; $T_M$ contain declared object types plus activity-binding types. Let $A_L$ be observed activity names and $T_L$ the keys of the result's object-type-count map.

$$
\mathrm{cov}_{act}=|A_M\cap A_L|/|A_M|,\quad
\mathrm{cov}_{ot}=|T_M\cap T_L|/|T_M|,
$$
$$
\mathrm{cov}_{activation}=\frac{|\{c:N(s_c)>0\}|}{|C|}.
$$

Activation's supplementary median is the upper-middle order statistic of positive source counts, one entry per activated constraint.

Let $I(a,t)=\sum_{o:\mathrm{type}(o)=t}n_o(a)$, the **total** event-object occurrences across supplied traces. Then

$$
\mathrm{cov}_{inv}=\frac{|\{c:\mathrm{scopeType}(c)\text{ exists},\ I(s_c,\mathrm{scopeType}(c))\geq2\}|}{|\{c:\mathrm{scopeType}(c)\text{ exists}\}|},
$$
$$
\mathrm{cov}_{min}=\frac{|\{c:l_c>0,\ N(t_c)>l_c\}|}{|\{c:l_c>0\}|},\quad
\mathrm{cov}_{max}=\frac{|\{c:0<u_c<\infty,\ N(t_c)\geq u_c\}|}{|\{c:0<u_c<\infty\}|},
$$
$$
\mathrm{cov}_{neg}=\frac{|\{c:u_c=0,\ N(t_c)>0\}|}{|\{c:u_c=0\}|},\quad
\mathrm{cov}_{arrow}=\frac{|\{c:\mathrm{type}(c)\in\{response,precedence\},\ N(t_c)>0\}|}{|\{c:\mathrm{type}(c)\in\{response,precedence\}\}|}.
$$

Zero denominators yield `null`. Radar axes are:

$$
C.E=\operatorname{mean}_{\ne null}(\mathrm{cov}_{act},\mathrm{cov}_{ot}),\quad C.A=\mathrm{cov}_{activation},\quad C.I=\mathrm{cov}_{inv},
$$
$$
C.C=\operatorname{mean}_{\ne null}(\mathrm{cov}_{min},\mathrm{cov}_{max},\mathrm{cov}_{neg}),\qquad C.R=\mathrm{cov}_{arrow}.
$$

**Inaccuracies:** involvement sums over events rather than checking at least two objects in one event; one object firing twice scores as testable. Bounds use whole-log counts rather than scoped activation counts. Arrow coverage does not inspect order or distinguish eventual from direct relations. Negation only checks target presence. These are activity-count proxies, not evidence that the corresponding semantics were exercised. Scope-only object types and multi-type scope bindings are absent from some denominators.

## 14. Satisfiability, cross-object inconsistency, and vacuity flags

Source: [App.jsx:4125](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:4125).

`Satisfiability = OK` precisely when none of these heuristics detects a problem:

1. A directed cycle in the source-to-target precedence graph.
2. A `not_coexistence$A,B$` paired with a direct response edge $A\to B$ or $B\to A$.
3. An activity marked absent (`absence` with explicit `nmax=0` or `null`) is a response target.

`Cross-object inconsistency = OK` means every checked `each` scope's type appears in the source activity's bindings and, for most constraint types, the target activity's bindings. Target checks exclude `not_coexistence`, `absence`, `exactly`, and `init`.

$$
\mathrm{VacuousCount}=|\{c:s_c\text{ exists and never occurs in supplied object traces}\}|.
$$

The vacuity flag is OK iff this count is zero.

**Mislabeling:** the first is a syntactic conflict heuristic, not a satisfiability decision procedure. A conditional conflict need not make the whole model unsatisfiable if its trigger is optional. The second checks binding presence, not contradictory ordering across types as its tooltip claims. Activation by source name is not appropriate to every constraint type and ignores scope. These flags cannot certify correctness.

## 15. Object cardinality fidelity

Source: [server.py:3313](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:3313).

For each event, $k_e=\mathrm{len}(\mathrm{relationships}(e)\text{ or }\mathrm{omap}(e)\text{ or }[])$. Per activity and log, the endpoint reports count, mean, population standard deviation, minimum and maximum:

$$
\bar k_{L,a}=\frac1{N_L(a)}\sum_{e:a_e=a}k_e,\qquad
\Delta_a=\bar k_{S,a}-\bar k_{R,a}.
$$

Means/std are rounded to three decimals; the difference is computed from the rounded means and then rounded again.

**Limitations:** it counts relationship entries, not necessarily distinct objects; repeated relationships to the same object can inflate it. Types are pooled, so different type mixtures can have identical totals. There is no aggregate cardinality-distribution distance.

## 16. Obligation fulfillment, completion, and multi-seed variance

Sources: [App.jsx:4593](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:4593), [server.py:3213](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:3213).

For recorded fulfilled/violated counters $F_c,V_c$:

$$
\mathrm{FulfillmentRate}_c=\frac{F_c}{F_c+V_c}.
$$

Zero denominator gives `null`. Pending obligations are excluded. Cancelled obligations are not an additional denominator term; the deactivation path also records attributed unfulfilled cancellations as violations. UI text claiming cancellations are never recorded as violations conflicts with this code.

For each numeric run measure $x_j$, over $m\leq20$ seeds:

$$
\mu_x=\frac1m\sum_jx_j,\qquad \sigma_x=\sqrt{\frac1m\sum_j(x_j-\mu_x)^2}.
$$

The backend reports mean/std/min/max for events, objects, completed traces, fulfilled obligations and violated obligations. Means/std are rounded to two decimals. Per-constraint seed summaries take the **unweighted mean of available per-run fulfillment rates**, excluding runs with no fulfilled or violated obligations. They do not pool counts or compute confidence intervals. Cancelled counts are returned per run but omitted from the numeric summary despite the endpoint docstring.

The Evaluation UI's object completion percentage is

$$
100\frac{\sum_{t\notin Resources}\mathrm{deactivatedCount}(t)}{\sum_{t\notin Resources}\mathrm{instanceCount}(t)},
$$

rounded to an integer, with empty denominator displayed as 0. It counts non-resource objects, not necessarily business cases. Pending work at termination can make fulfillment rates appear more favorable than full completion-based evaluation.

## 17. Direct simulation timing summaries

Sources: [metrics.py:47](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/src/Simulation/IO/output/metrics.py:47), [server.py:1335](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:1335).

For stored service samples $s_i$, process waits $p_i$, pool waits $w_i$, and resource waits $r_i$, the code exports ordinary means/extrema, rounded to three decimals. Recorded sojourn uses:

$$
j_i=s_i+p_i\quad\text{if the process-wait list is nonempty, otherwise}\quad j_i=s_i+w_i.
$$

Lists are paired by index only up to the shorter length. Resource wait is reported separately and is not added here.

Object lifetime is the last minus first timestamp in executed-event order, but equal first/last timestamps return `null`. Thus genuine zero lifetimes are omitted. The result-level mean lifetime averages all non-null object lifetimes; contrary to its comment, it does not exclude resource objects.

Result-level average wait is

$$
\mathrm{AvgWait}=\frac{\sum_aN_S(a)(\mathrm{MeanPoolWait}_a\text{ or }0)}{\max(1,\sum_aN_S(a))}.
$$

It does not use process/resource waiting. Average parallelism is the arithmetic mean of samples $\mathrm{len(in\_progress)}+1$ at completion, not a time-weighted mean.

Connected trace duration is the mean of $\max t-\min t$ over distinct connected components of non-resource objects reached from inactive roots and having at least two timestamp entries. A component qualifies when a root is inactive; all other component objects need not be inactive. It should not automatically be interpreted as completed business-case duration.

## 18. Critical data-scope defect affecting multiple measures

Sources: [server.py:1186](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Backend/server.py:1186), [App.jsx:2119](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:2119), [App.jsx:4340](/Users/luisschwarz/Documents/Studies/IT/ProjectTest/ProjectTest/Frontend/src/App.jsx:4340).

The simulation response caps `object_traces` at the first **200 objects**, then restricts `object_types_map` to those objects. Despite a comment saying the subset is only for visualization:

- Object-replay fitness, constraint fitness, precision, NGD, involvement coverage and the vacuity flag consume that subset.
- NGD compares the simulated subset with input-log traces built from the full input log.
- Event-level conformance loads full output events but its supposedly `fullTypesMap` only copies the capped map. For objects outside the map, scoped checks can find no scope objects and return vacuous success.

This is a correctness defect, not just a performance or display issue. Evaluation should load full event/object data independently of visualization limits.

## Verification and recommended repair order

I executed the actual extracted frontend functions in Node and the actual timing-discovery function in Python on small deterministic examples. Confirmed results:

| Example | Current output | Problem |
|---|---|---|
| Response $A\to B$, trace `B,A` | Constraint fitness 1 | Wrong order accepted |
| Precedence $A\to B$, trace `B,A` | Constraint fitness 1 | Prior occurrence not checked |
| Not-succession $A\to B$, trace `A,B,A` | Constraint fitness 1 | Earlier forbidden pair missed |
| Precedence lower bound 2, trace `A,B` | Replay fitness 1 | Required count ignored |
| Chain-response $A\to B$, events `A,C` | Confidence 1 | Adjacent label not checked |
| Unrestricted model, trace `A,B` | Precision 1 | Extra allowed behavior not penalized |
| One object with two separate `A` events | Involvement coverage 1 | Repetition mistaken for simultaneous involvement |
| Two copies of `A,B` versus one | NGD (1/3) | Log-size sensitivity |
| Predecessors at 0s and 5s, completion at 10s | Sync 5s, pooling 5s, lagging 0s | Duplicate/degenerate timing measures |

These are focused implementation checks, not an end-to-end evaluation of a selected saved simulation run. Other findings above come from source inspection. Paper attributions in code comments were not independently validated against the cited publications.

Recommended order:

1. Remove evaluation's dependence on the 200-object visualization subset and load the full type map.
2. Consolidate the different conformance checkers around explicit shared semantics, bounds and scopes; reject unsupported types instead of silently passing them.
3. Rename the existing precision score or implement a measure that accounts for additional allowed behavior.
4. Repair timing identities, zero/missing-value handling and WMAPE inconsistencies.
5. Replace coverage proxies with checks on actual scoped activations; label retained heuristics clearly.
6. Make log-size sensitivity, exclusions, sample counts and the exact aggregation visible in the UI.
