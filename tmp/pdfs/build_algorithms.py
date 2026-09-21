from pathlib import Path
import re, html, json
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
ROOT=Path.cwd()
A=[]
def add(title, inp, out, code, source, note):
    A.append(dict(title=title,inp=inp,out=out,code=code.strip().splitlines(),source=source,note=note))
SIM='src/Simulation/Engine/simulator.py'
PD='src/ParameterDiscovery/probabilitydiscovery.py'
TD='src/ParameterDiscovery/timediscovery.py'
LC='src/ParameterDiscovery/lifecycle.py'
OC='src/ParameterDiscovery/OCDeclarediscovery.py'
add('Object-centric discrete-event simulation',
    'Model M, simulation configuration K, discovered parameters D, random generator R',
    'Simulation state S containing objects, completed events, and execution metrics',
'''S <- supplied state or an empty state; t <- K.start_timestamp; idle <- 0
initialize clock, start-activity set, and runtime timer
while no user stop and no configured stopping condition do
    while earliest completion in S is at or before t do
        x <- remove earliest in-progress instance
        Complete(x, S)                                      // Algorithm 2
        if a stopping condition holds then break
    if a stopping condition holds then break
    C <- GenerateCandidates(M, S, D)
    initial <- no completed event and no in-progress instance
    C <- OrderCandidates(C, S, D, R)                         // Algorithm 3
    for each candidate c in C do
        if initial and c is not a configured start activity then continue
        if start-activity policy blocks c then continue
        if concurrency limit is reached then continue
        if activity calendar is closed then continue
        if any participating object is busy then continue
        Start(c, S)                                         // Algorithm 2
    if S has in-progress instances then
        idle <- 0; t <- earliest completion time
    else
        F <- scheduled arrival times strictly after t
        if calendars are configured then add next hour boundary to F
        if F is empty then break
        t <- min(F); idle <- idle + 1
        if idle > 1000 then break
    S.current_time <- t
return S''', SIM+' :: run, run_des, _generate_candidates_des',
'Current run() delegates to run_des(). GenerateCandidates encapsulates binding construction, semantic checks, arrival gates, and incremental candidate-pool maintenance. Resource-pool handling is disabled in this snapshot; participant exclusivity remains active. When work is running, the clock jumps to the next completion, even if an arrival is due earlier. Stopping does not drain unfinished instances.')
add('Starting and completing an activity',
    'Candidate c or finishing instance x; model M; state S; time policy',
    'Updated objects, completion heap, event log, and obligation indexes',
'''procedure Start(c, S)
    N <- create objects requested by c, using attribute defaults
    apply conservative O2O link policy to existing participants and N
    P <- existing participants of c followed by N
    t0 <- S.current_time
    t1 <- sample completion timestamp using t0 as the time-policy base
    restore the previous last-generated timestamp
    x <- (activity(c), P, N, t0, t1)
    insert x into the completion min-heap
    mark P busy; update in-progress indexes and lifecycle history
    increment in-progress count for activity(c)
    schedule its next arrival where applicable
    mark participants dirty; remove their affected own-activity pool entries
procedure Complete(x, S)
    release participants; decrement activity in-progress count
    deactivate participants whose bindings terminate their object type
    apply binding attribute updates; capture configured event attributes
    e <- record completed event at x.completion_time
    update clock and last-generated timestamp
    mark participants and relevant object types dirty
    record service-time and parallelism metrics
    fulfill, promote, and create response obligations
    update eligible precedence-satisfaction caches''',SIM+' :: _des_start_activity, _des_complete_activity',
'Objects are created when an activity starts; events are recorded when it completes. Discovered waiting_mean is descriptive and is not added to the sampled completion time. Start and Complete are abstractions of the named methods, with tracing and bookkeeping condensed.')
add('Candidate ordering by object-local probability',
    'Candidate list C, state S, per-type transition matrix P, random generator R',
    'Ordered candidate list for the greedy start loop',
'''if size(C) < 2 then return C
if P is absent then
    c <- legacy candidate selector(C, S)
    return c followed by the remaining candidates in their original order
K <- empty list
for each c in C do
    T <- configured primary input type of activity(c)
    o <- first participant of c with type T, if present
    if no primary object or no matrix row for its state then
        w <- 1
    else
        a <- last activity of o, or <START> if none
        w <- P[T, a].get(activity(c), 0)
    w <- max(w, 0.000000001)
    u <- R.uniform(0, 1); replace zero by 0.000000001
    append (u raised to the power 1/w, c) to K
sort K by key in descending order
return candidates from K''',SIM+' :: _candidate_weight, _order_candidates',
'Probability controls preference among feasible candidates. A zero weight is replaced by epsilon; it does not make a candidate semantically illegal. The primary object alone determines the weight. The fallback promotes one legacy-selected candidate and preserves the order of the rest.')
add('Temporal transition discovery',
    'Timestamped traces Q, ordered by event time',
    'Transition statistics T[a,b], including all observed time-gap samples',
'''D <- map from activity pairs to empty sample lists
for each trace q in Q do
    for each adjacent pair ((a, ta), (b, tb)) in q do
        append seconds(tb - ta) to D[a,b]
T <- empty map
for each observed pair (a,b) with samples X = D[a,b] do
    n <- size(X)
    T[a,b] <- (n, X, mean(X), median(X), min(X), max(X))
    if n > 1 then sd <- sample standard deviation of X
    else sd <- 0
    if n >= 4 then
        (q25, q75) <- first and third Python exclusive quartiles of X
    else
        (q25, q75) <- (min(X), max(X))
    add sd, q25, and q75 to T[a,b]
return T''',TD+' :: load_event_log_with_timestamps, discover_temporal_transition_matrix',
'The loader constructs either one globally ordered trace or one trace per object of a chosen case type; events without timestamps are omitted. The discovery routine assumes ordered input and does not clip negative gaps supplied directly. These are adjacent-event elapsed times, not independently measured service durations.')
add('Activity timing and service-time estimation',
    'Normalized OCEL L, optional service anchors H, mode m in {minimum, p25, p50}',
    'Per-activity timing metrics and parameters for a lognormal time policy',
'''build each object timeline in timestamp order
B <- empty per-activity metric buckets
for each event e with activity a, valid time t, and participating objects do
    V <- valid immediately preceding timestamps on its object timelines
    N <- valid immediately following timestamps on its object timelines
    append max(0, seconds(v - t)) to B[a].direct for every v in N
    if V is empty then
        append 0 to B[a].flow and B[a].sojourn; continue
    early <- min(V); late <- max(V)
    append seconds(late - early) to B[a].sync
    append max(0, seconds(t - early)) to B[a].flow
    append max(0, seconds(t - late)) to B[a].sojourn
    group preceding timestamps by object type
    append max(type-latest) - min(type-earliest) to B[a].pooling
    append max(type-latest) - late to B[a].lagging
for each activity a in B or H do
    D <- B[a].direct; Z <- positive values in B[a].sojourn
    if D and Z are nonempty then
        X <- list with smaller upper median; prefer D on a tie
    else X <- D if nonempty, else Z if nonempty, else B[a].sojourn
    if a has an anchor then use its supplied service parameters
    else if X is nonempty then
        Y <- sorted rank window of X selected by m
        service <- mean, population deviation, minimum, maximum of Y
    else service <- summary of B[a].sojourn
    summarize timing buckets using population standard deviations
    waiting_mean <- max(0, sojourn_mean - service_mean), if defined
    emit metrics and service parameters with dist_type = lognormal
return emitted per-activity results''',OC+' :: compute_ocpa_metrics; Backend/server.py :: discover_timing',
'This is the active timing endpoint. Windows (inclusive, zero-based) are: minimum [0, ceil(n/4)-1], p25 [0, ceil(n/2)-1], p50 [max(0, ceil(n/4)-1), ceil(3n/4)-1], with upper indexes floored at zero. Upper median means sorted(X)[floor(n/2)]. Service times are heuristic estimates unless anchored. In this implementation pooling equals synchronization, and lagging is zero; waiting_std copies sojourn_std. No statistical distribution-fit test is performed.')
add('Trace-based transition probability discovery',
    'Activity traces Q (global, case-based, or supplied directly)',
    'Row-normalized directly-follows probability matrix P',
'''C <- zero-initialized transition counter
for each trace q in Q do
    for each adjacent activity pair (a,b) in q do
        C[a,b] <- C[a,b] + 1
P <- empty map
for each source a with observed successors do
    total <- sum of C[a,b] over all targets b
    for each observed target b do
        P[a,b] <- C[a,b] / total
return P''',PD+' :: discover_transition_matrix',
'Self-transitions are counted. A trace ending contributes no outgoing transition; terminal-only activities have no row. Therefore each emitted row sums to one, without a separate termination probability. Global traces may contain adjacent events from unrelated objects.')
add('Pooled object-trace probability discovery',
    'OCEL L with known objects, event activities, timestamps, and relationships',
    'Transition probabilities P, ending probabilities E, boundary counts, and positions',
'''Q <- collect and timestamp-sort event activities per known object
C, F, B, Z, U <- zero-initialized counters; ntraces <- 0
for each nonempty object trace q in Q do
    n <- size(q); ntraces <- ntraces + 1
    B[first(q)] <- B[first(q)] + 1
    Z[last(q)] <- Z[last(q)] + 1
    for each zero-based position i and activity a in q do
        F[a] <- F[a] + 1
        U[a] <- U[a] + (i/(n-1) if n > 1 else 0)
    for each adjacent pair (a,b) in q do
        if a != b then C[a,b] <- C[a,b] + 1
for each activity a in F do
    P[a] <- empty row
    for each counted successor b do P[a,b] <- round(C[a,b]/F[a], 6)
    if Z[a] > 0 then E[a] <- round(Z[a]/F[a], 6)
    position[a] <- round(U[a]/F[a], 4)
return P, E, B, Z, ntraces, position''',PD+' :: discover_transition_matrix_object_centric',
'Counts are pooled across all object types; one shared event can appear in several object traces. The denominator counts every occurrence, but self-transitions are excluded from the numerator. Consequently 1 - sum(P[a,*]) includes both trace endings and omitted self-transitions; it is not generally equal to E[a].')
add('Per-object-type transition probability discovery',
    'Normalized OCEL L',
    'P[T,a,b]: probability of next activity b given type T and previous activity a',
'''E <- events with an activity and a parseable timestamp
sort E by timestamp
Q <- empty activity sequence for each referenced object
for each event e in E do
    append activity(e) to Q[o] for every referenced object o
C <- zero-initialized counter indexed by type, previous activity, next activity
for each object o with known type T and a sequence q do
    previous <- <START>
    for each activity a in q do
        C[T,previous,a] <- C[T,previous,a] + 1
        previous <- a
for each observed state (T,previous) do
    total <- sum of C[T,previous,a] over all next activities a
    P[T,previous,a] <- C[T,previous,a] / total for every observed a
return P''',OC+' :: discover_object_transition_matrix',
'This matrix supplies object-local candidate ordering (Algorithm 3). It includes self-transitions and <START> transitions, and has no explicit <END> state. Each observed row sums to one. It is an auxiliary simulation parameter, separate from behavioral OC-DECLARE mining.')
add('Object lifecycle discovery',
    'Normalized OCEL L, object type T, lifecycle threshold h (default 0.5)',
    'Creating activity set C and terminating activity set D for T',
'''Q <- timestamp-ordered, nonempty traces for objects of type T
n <- number of traces in Q
if n = 0 then return empty sets
F <- counts of first activities; Z <- counts of last activities
S <- counts of activities in single-event object traces
C <- activities a such that F[a]/n >= h
D <- empty set
for each activity a with Z[a]/n >= h do
    if a is not in C or S[a]/n >= h then add a to D
for each activity a appearing as a last activity do
    reached <- number of object traces containing a at least once
    if reached > 0 and Z[a] = reached then add a to D
return C, D''',LC+' :: discover_lifecycle',
'The last pass preserves rare but unambiguous endpoints: every object that reaches the activity ends there. An activity can be both creator and terminator. This may arise through the single-event test or the final endpoint rule. The simple-list fallback instead returns all observed first and last activities without threshold filtering.')
add('Reusable-object type discovery',
    'Normalized OCEL L, reuse threshold h (default 2.0)',
    'Sorted list R of reusable object types',
'''C <- zero-initialized counter of (object, activity) occurrences
for each event e with a nonempty activity do
    for each referenced object o do C[o,activity(e)] <- C[o,activity(e)] + 1
for each object o with known type T do
    if o has activity counts then score[o] <- max over activities of C[o,a]
    else score[o] <- 0
for each object type T do
    reuse[T] <- mean of score[o] for all objects of T
R <- all types T such that reuse[T] >= h
return sorted(R)''',LC+' :: discover_permanent_object_types',
'The reuse score is the maximum repetition of a single activity per object, averaged by type; it is not total trace length. Zero-event objects contribute zero. Discovery remains available, but dedicated permanent-object/resource-pool handling in the current simulator is disabled.')
add('Automatic reuse-threshold suggestion',
    'OCEL L',
    'Suggested threshold h, or no suggestion',
'''compute reuse[T] as in Algorithm 10
V <- reuse scores sorted ascending
if size(V) < 2 then return no suggestion
best_ratio <- 1; best_pair <- none
for each adjacent pair (lo,hi) in V do
    if lo > 0 then ratio <- hi/lo
    else ratio <- infinity if hi > 0, otherwise 1
    if ratio > best_ratio then
        best_ratio <- ratio; best_pair <- (lo,hi)
if best_pair is none or best_ratio < 3 then return no suggestion
(lo,hi) <- best_pair
h <- square root of (lo * hi) if lo > 0, otherwise hi
return round(h, 2)''',LC+' :: suggest_permanent_object_threshold',
'The algorithm chooses the first largest multiplicative gap between adjacent type scores. A ratio below three is treated as insufficient separation. This is a threshold suggestion, not a validated classification model.')
add('Creation-count distribution discovery',
    'Normalized OCEL L',
    'Empirical histograms H[activity,type,new-object count]',
'''E <- events sorted by (timestamp or empty string, event identifier)
seen <- empty set; H <- zero-initialized histogram
for each event e in E with a nonempty activity a do
    present <- zero-initialized per-type counter
    fresh <- zero-initialized per-type counter
    for each referenced object o with a known type T do
        present[T] <- present[T] + 1
        if o is not in seen then fresh[T] <- fresh[T] + 1
    for each T occurring in present do
        H[a,T,fresh[T]] <- H[a,T,fresh[T]] + 1
    add all object identifiers referenced by e to seen
remove every (activity,type) histogram with no positive creation count
return H with histogram count keys encoded as strings''',LC+' :: discover_creation_counts',
'An object is new at its first observed event. Retained histograms include zero, expressing reuse without creation. Absent types do not contribute zero samples. The implementation sorts missing timestamps as empty strings, rather than rejecting those events. These counts differ from the number of objects merely participating in an event.')
add('Interarrival-time discovery',
    'Normalized OCEL L',
    'Per-activity interarrival distribution parameters I',
'''group valid event timestamps by activity and sort each group
I <- empty map
for each activity a with timestamp sequence t do
    if size(t) < 2 then continue
    G <- seconds(t[i] - t[i-1]) for i = 1,...,size(t)-1
    retain nonnegative gaps in G
    if G is empty then continue
    mu <- mean(G); sigma <- population standard deviation of G
    kind <- exponential if mu > 0, otherwise fixed
    I[a] <- (kind, mu, sigma, min(G), max(G), size(G))
return I''',OC+' :: discover_interarrival_times, _event_times_by_activity',
'Gaps are measured between successive occurrences of the same activity, across the process. Zero gaps are retained. The distribution family is assigned from the mean; there is no goodness-of-fit selection. Arrival pacing is an auxiliary simulator mechanism.')
add('Weekly availability-calendar discovery',
    'Normalized OCEL L with valid event timestamps',
    'Global 168-slot probability calendar, observed week count, and activity names',
'''W <- empty set of observed ISO (year,week) pairs
V[s] <- empty set of weeks for s = 0,...,167
A <- activities with valid event times
for each valid timestamp t from any activity do
    w <- ISO year and ISO week of t
    s <- 24 * weekday(t) + hour(t)                     // Monday is day 0
    add w to W; add w to V[s]
if W is empty then return empty result
for s = 0,...,167 do p[s] <- size(V[s]) / size(W)
return slots_per_week = 168, global = p, per_activity = empty map,
       fallback_activities = sorted(A), weeks_observed = size(W)''',OC+' :: discover_activity_calendars',
'Each slot probability is the fraction of observed weeks with any event in that weekday/hour slot, pooled over all activities. Entirely silent weeks are absent from the denominator. Partial weeks are not exposure-corrected. The compatibility argument min_events_for_own_calendar is unused; no individual activity calendars are discovered.')
add('Activity concurrency discovery',
    'Normalized OCEL L, activity timing metrics M, safety factor f (default 1)',
    'Per-activity concurrency limits K',
'''group valid event timestamps by activity
if M is absent then compute activity timing metrics using minimum mode
for each activity a with timestamp list T do
    d <- M[a].mean_seconds, or 0 if missing
    if d <= 0 then K[a] <- 1; continue
    B <- (t,+1) and (t+d,-1) for every t in T
    sort B by timestamp, then by delta ascending
    active <- 0; peak <- 0
    for each (_,delta) in B do
        active <- active + delta; peak <- max(peak, active)
    K[a] <- max(1, ceiling(peak * f))
return K''',OC+' :: discover_activity_concurrency',
'Intervals [t,t+d) are reconstructed from event timestamps and estimated mean service times; observed starts and finishes are not available. Ends are processed before starts at equal timestamps. The simulator enforces these limits as concurrency ceilings, so this is a modeling assumption derived from the log.')
add('Observed object work-in-progress discovery',
    'Normalized OCEL L, safety factor f (default 1)',
    'Per-type scaled peak counts K for validation',
'''for each referenced object o with valid event timestamps do
    first[o] <- earliest timestamp; last[o] <- latest timestamp
for each known object type T with observed intervals do
    B <- (first[o],+1) and (last[o],-1) for objects o of type T
    sort B by timestamp, then by delta ascending
    active <- 0; peak <- 0
    for each (_,delta) in B do
        active <- active + delta; peak <- max(peak, active)
    if peak > 0 then K[T] <- max(1, ceiling(peak * f))
return K''',OC+' :: discover_wip_caps',
'The function name retains "caps", but the current code describes this as a validation measure, not an enforced WIP admission limit. End-before-start ordering means first=last intervals do not increase the peak and can transiently lower the sweep count. This panel preserves the implemented tie behavior rather than silently changing it.')
add('Start-activity discovery',
    'Normalized OCEL L, minimum percentage p (default 1.0)',
    'Ranked start activities with counts and percentages',
'''first <- empty map from object identifiers to (timestamp, activity)
for each event e with a nonempty activity a do
    for each referenced object o present in the object table do
        if o is unseen or timestamp(e) < first[o].timestamp then
            first[o] <- (timestamp(e), a)
n <- size(first)
if n = 0 then return empty list
C <- activity counts among values of first
R <- empty list
for each activity a in descending order of C[a] do
    percentage <- round(100 * C[a] / n, 1)
    if percentage >= p then append (a, C[a], percentage) to R
return R''',OC+' :: discover_start_activities',
'Only objects with a usable recorded activity enter the denominator. Percentages are rounded before threshold comparison. Equal-time first events retain the first encountered event. The method counts object starts across types, so a shared event can count for several objects.')
add('Object-binding cardinality discovery',
    'Normalized OCEL L',
    'Per-activity, per-type participation bounds B',
'''C <- map from (activity,type) to empty sample lists
for each event e with a nonempty activity a do
    N <- counts of referenced, known objects grouped by type
    for each type T present in N do append N[T] to C[a,T]
for each observed pair (a,T) with samples X do
    lo <- min(X); hi <- max(X)
    if hi >= 100 then hi <- unbounded
    B[a,T] <- (min_count = lo, max_count = hi,
               creates = false, deactivates = false)
return B''',OC+' :: discover_object_bindings',
'Only events where a type is present contribute a sample; missing types do not contribute zero. Thus the lower bound is conditional on participation. Lifecycle discovery supplies creation/deactivation flags separately. The simple-list fallback assigns each observed activity one "case" object, with both flags false.')
add('Object-to-object relationship discovery',
    'Normalized OCEL L with explicit object relationships',
    'Type-pair relationship rules with observed cardinalities',
'''links <- empty sets indexed by (source type, target type, source object)
qualifiers <- empty sets indexed by type pair
for each explicitly declared relationship from object x to object y do
    if an endpoint type is unknown or type(x) = type(y) then continue
    if x = y then continue
    add y to links[type(x),type(y),x]
    add x to links[type(y),type(x),y]
    retain nonempty qualifier for both type directions
R <- empty list
for each unordered type pair {T,U} occurring in links do
    F <- distinct-partner counts in direction T to U
    G <- distinct-partner counts in direction U to T
    (flo,fhi) <- (min(F),max(F)); (glo,ghi) <- (min(G),max(G))
    if flo = glo and fhi = ghi then
        append one bidirectional rule with bounds (flo,fhi) to R
    else
        append directed T-to-U rule with bounds (flo,fhi) to R
        append directed U-to-T rule with bounds (glo,ghi) to R
    attach sorted qualifiers to emitted rules where available
return R''',OC+' :: _declared_o2o_links, discover_o2o_rules',
'Only explicitly declared object relationships are used. Event co-participation does not infer a link. Distinct partners are counted among objects with recorded links, so unlinked objects do not add zero samples. Qualifiers are provenance, not separate enforced rule dimensions. No relationships yields no rules.')

out=ROOT/'output/algorithms'
(out/'algorithm-panels.json').write_text(json.dumps(A,indent=2)+'\n')
# Reusable LaTeX, with one numbered algorithm per page and editable statements.
def esc(s):
    chars={'\\':r'\textbackslash{}','&':r'\&','%':r'\%','$':r'\$','#':r'\#','_':r'\_','{':r'\{','}':r'\}','~':r'\textasciitilde{}','^':r'\textasciicircum{}','<':r'\textless{}','>':r'\textgreater{}'}
    return ''.join(chars.get(c,c) for c in s)
tex=[r'\documentclass[11pt,a4paper]{article}',r'\usepackage[margin=22mm]{geometry}',r'\usepackage[T1]{fontenc}',r'\usepackage{newtxtext}',r'\usepackage{algorithm}',r'\usepackage{algpseudocode}',r'\usepackage{float}',r'\usepackage{hyperref}',r'\algrenewcommand\algorithmicrequire{\textbf{Input:}}',r'\algrenewcommand\algorithmicensure{\textbf{Output:}}',r'\begin{document}',r'\section*{Simulation and parameter discovery}',r'Implementation-derived pseudocode. Style reference: Algorithm 1, p. 14, K\"usters and van der Aalst, \emph{OC-DECLARE: Discovering Object-Centric Declarative Patterns with Synchronization}. The behavioral OC-DECLARE discovery algorithm is excluded. Auxiliary discovery routines are included even when located in OCDeclarediscovery.py. Snapshot: 20 September 2026.',r'\begin{enumerate}']
tex += [r'\item '+esc(a['title']) for a in A]
tex += [r'\end{enumerate}']
for a in A:
    tex += [r'\clearpage',r'\begin{algorithm}[H]',r'\caption{'+esc(a['title'])+'}',r'\begin{algorithmic}[1]',r'\Require '+esc(a['inp']),r'\Ensure '+esc(a['out'])]
    for line in a['code']:
        indent=(len(line)-len(line.lstrip()))//4
        tex.append(r'\State \hspace*{'+str(indent)+'em}'+esc(line.strip()))
    tex += [r'\end{algorithmic}',r'\end{algorithm}',r'\noindent\textbf{Reading notes.} '+esc(a['note']),r'\par\medskip\noindent\textbf{Implementation.} {\small\detokenize{'+a['source']+'}}']
tex += [r'\end{document}']
(out/'algorithm-visualizations.tex').write_text('\n'.join(tex)+'\n')
# PDF panels: restrained academic typesetting, rules, numbered rows, hanging indent.
for name,filename in [('Serif','Times New Roman.ttf'),('SerifBold','Times New Roman Bold.ttf'),('SerifItalic','Times New Roman Italic.ttf')]:
    pdfmetrics.registerFont(TTFont(name,'/System/Library/Fonts/Supplemental/'+filename))
pdfmetrics.registerFontFamily('Serif',normal='Serif',bold='SerifBold',italic='SerifItalic',boldItalic='SerifBold')
pdf=ROOT/'output/pdf/algorithm-visualizations.pdf'
c=canvas.Canvas(str(pdf),pagesize=A4)
c.setTitle('Simulation and parameter discovery - algorithm visualizations')
c.setAuthor('Implementation-derived algorithm reference')
W,H=A4; left=54; right=W-54; width=right-left
styles={k:ParagraphStyle(k,fontName='Serif',fontSize=s,leading=l) for k,s,l in [('body',11,15),('small',9.5,13),('code',10.6,14.8)]}
def para(text,y,style='body',x=left,w=width):
    p=Paragraph(text,styles[style]); _,height=p.wrap(w,1000)
    p.drawOn(c,x,y-height)
    return y-height

def frame(page,label):
    c.setFont('Serif',9); c.drawString(left,H-33,'Simulation and parameter discovery')
    c.drawRightString(right,H-33,label)
    c.setFont('Serif',9); c.drawString(left,30,'Implementation snapshot: 20 September 2026')
    c.drawRightString(right,30,str(page))
frame(1,'Algorithm reference')
y=H-88
c.setFont('SerifBold',22); c.drawString(left,y,'Simulation and parameter discovery'); y-=30
c.setFont('SerifItalic',13); c.drawString(left,y,'Numbered algorithm panels in the style of the reference paper'); y-=30
y=para('These panels describe the current project implementation. They use the ruled, numbered pseudocode format of Algorithm 1 on page 14 of the supplied OC-DECLARE paper. They do not reproduce its behavioral discovery algorithm.',y)-13
y=para('Scope: simulation and auxiliary parameter discovery, including methods housed in OCDeclarediscovery.py. Inputs to most panels are normalized OCEL dictionaries: object identifiers map to types, and events contain activity, timestamp, and object identifiers. Preparation, validation, and logging details are condensed.',y)-18
for i,a in enumerate(A,1):
    c.setFont('Serif',10.6); c.drawString(left,y,f'{i:2}.  '+a['title']); c.drawRightString(right,y,str(i+1)); y-=19
c.line(left,y+3,right,y+3); y-=15
y=para('<b>How to read.</b> Indentation defines control scope; &lt;- denotes assignment. Undefined map entries used as counters are zero. Event-order ties follow the corresponding implementation. Notes identify approximations, defaults, and consequential edge cases.',y,'small')-10
y=para('<b>Style reference.</b> A. K\u00fcsters and W. M. P. van der Aalst, <i>OC-DECLARE: Discovering Object-Centric Declarative Patterns with Synchronization</i>, Algorithm 1, p. 14. The algorithm content here is derived from the local project, not attributed to that paper.',y,'small')
assert y>50,y
c.showPage()
for i,a in enumerate(A,1):
    frame(i+1,f'Algorithm {i} of {len(A)}')
    y=H-73
    c.setLineWidth(.7); c.line(left,y,right,y); y-=6
    y=para(f'<b>Algorithm {i}</b>  '+html.escape(a['title']),y)-6
    c.setLineWidth(.4); c.line(left,y,right,y); y-=8
    y=para('<b>Input:</b> '+html.escape(a['inp']),y,'small')-3
    y=para('<b>Output:</b> '+html.escape(a['out']),y,'small')-9
    for n,line in enumerate(a['code'],1):
        indent=(len(line)-len(line.lstrip()))//4
        raw=line.strip(); s=html.escape(raw)
        s=re.sub(r'^(procedure|while|for each|for |if |else if |else|return |sort |initialize )',lambda m:'<b>'+m.group(0)+'</b>',s)
        x=left+25+indent*13
        c.setFont('Serif',9.5); c.drawRightString(left+18,y-10.6,f'{n}:')
        y=para(s,y,'code',x,right-x)-1
    y-=4; c.line(left,y,right,y); y-=17
    y=para('<b>Reading notes.</b> '+html.escape(a['note']),y,'small')-12
    # Source paths wrap cleanly at slashes without adding text.
    source=html.escape(a['source']).replace('/', '/<wbr/>').replace(' :: ','<br/>')
    y=para('<b>Implementation.</b> '+source,y,'small')
    assert y>55,(i,y)
    c.showPage()
c.save()
print(f'Created {len(A)} algorithm panels; PDF: {pdf}')
