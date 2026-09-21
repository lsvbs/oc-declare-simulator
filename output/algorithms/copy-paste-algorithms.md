# Individual algorithm snippets

Add the shared preamble once before `\begin{document}`. Paste each desired algorithm inside the document. LaTeX numbers algorithms in the order you insert them. Each snippet includes its own caption and unique label. The original full source retains the reading notes and implementation references.

## Shared preamble

```latex

% Add once before \begin{document}; do not reload packages already present.
\usepackage{algorithm}
\usepackage{algpseudocode}
\usepackage{float}
\algrenewcommand\algorithmicrequire{\textbf{Input:}}
\algrenewcommand\algorithmicensure{\textbf{Output:}}

```

## 1. Object-centric discrete-event simulation

```latex

\begin{algorithm}[H]
\caption{Object-centric discrete-event simulation}
\label{alg:object-centric-discrete-event-simulation}
\begin{algorithmic}[1]
\Require Model M, simulation configuration K, discovered parameters D, random generator R
\Ensure Simulation state S containing objects, completed events, and execution metrics
\State \hspace*{0em}S \textless{}- supplied state or an empty state; t \textless{}- K.start\_timestamp; idle \textless{}- 0
\State \hspace*{0em}initialize clock, start-activity set, and runtime timer
\State \hspace*{0em}while no user stop and no configured stopping condition do
\State \hspace*{1em}while earliest completion in S is at or before t do
\State \hspace*{2em}x \textless{}- remove earliest in-progress instance
\State \hspace*{2em}Complete(x, S)                                      // Start/Complete procedure
\State \hspace*{2em}if a stopping condition holds then break
\State \hspace*{1em}if a stopping condition holds then break
\State \hspace*{1em}C \textless{}- GenerateCandidates(M, S, D)
\State \hspace*{1em}initial \textless{}- no completed event and no in-progress instance
\State \hspace*{1em}C \textless{}- OrderCandidates(C, S, D, R)                         // Candidate ordering
\State \hspace*{1em}for each candidate c in C do
\State \hspace*{2em}if initial and c is not a configured start activity then continue
\State \hspace*{2em}if start-activity policy blocks c then continue
\State \hspace*{2em}if concurrency limit is reached then continue
\State \hspace*{2em}if activity calendar is closed then continue
\State \hspace*{2em}if any participating object is busy then continue
\State \hspace*{2em}Start(c, S)                                         // Start/Complete procedure
\State \hspace*{1em}if S has in-progress instances then
\State \hspace*{2em}idle \textless{}- 0; t \textless{}- earliest completion time
\State \hspace*{1em}else
\State \hspace*{2em}F \textless{}- scheduled arrival times strictly after t
\State \hspace*{2em}if calendars are configured then add next hour boundary to F
\State \hspace*{2em}if F is empty then break
\State \hspace*{2em}t \textless{}- min(F); idle \textless{}- idle + 1
\State \hspace*{2em}if idle \textgreater{} 1000 then break
\State \hspace*{1em}S.current\_time \textless{}- t
\State \hspace*{0em}return S
\end{algorithmic}
\end{algorithm}

```

## 2. Starting and completing an activity

```latex

\begin{algorithm}[H]
\caption{Starting and completing an activity}
\label{alg:starting-and-completing-an-activity}
\begin{algorithmic}[1]
\Require Candidate c or finishing instance x; model M; state S; time policy
\Ensure Updated objects, completion heap, event log, and obligation indexes
\State \hspace*{0em}procedure Start(c, S)
\State \hspace*{1em}N \textless{}- create objects requested by c, using attribute defaults
\State \hspace*{1em}apply conservative O2O link policy to existing participants and N
\State \hspace*{1em}P \textless{}- existing participants of c followed by N
\State \hspace*{1em}t0 \textless{}- S.current\_time
\State \hspace*{1em}t1 \textless{}- sample completion timestamp using t0 as the time-policy base
\State \hspace*{1em}restore the previous last-generated timestamp
\State \hspace*{1em}x \textless{}- (activity(c), P, N, t0, t1)
\State \hspace*{1em}insert x into the completion min-heap
\State \hspace*{1em}mark P busy; update in-progress indexes and lifecycle history
\State \hspace*{1em}increment in-progress count for activity(c)
\State \hspace*{1em}schedule its next arrival where applicable
\State \hspace*{1em}mark participants dirty; remove their affected own-activity pool entries
\State \hspace*{0em}procedure Complete(x, S)
\State \hspace*{1em}release participants; decrement activity in-progress count
\State \hspace*{1em}deactivate participants whose bindings terminate their object type
\State \hspace*{1em}apply binding attribute updates; capture configured event attributes
\State \hspace*{1em}e \textless{}- record completed event at x.completion\_time
\State \hspace*{1em}update clock and last-generated timestamp
\State \hspace*{1em}mark participants and relevant object types dirty
\State \hspace*{1em}record service-time and parallelism metrics
\State \hspace*{1em}fulfill, promote, and create response obligations
\State \hspace*{1em}update eligible precedence-satisfaction caches
\end{algorithmic}
\end{algorithm}

```

## 3. Candidate ordering by object-local probability

```latex

\begin{algorithm}[H]
\caption{Candidate ordering by object-local probability}
\label{alg:candidate-ordering-by-object-local-probability}
\begin{algorithmic}[1]
\Require Candidate list C, state S, per-type transition matrix P, random generator R
\Ensure Ordered candidate list for the greedy start loop
\State \hspace*{0em}if size(C) \textless{} 2 then return C
\State \hspace*{0em}if P is absent then
\State \hspace*{1em}c \textless{}- legacy candidate selector(C, S)
\State \hspace*{1em}return c followed by the remaining candidates in their original order
\State \hspace*{0em}K \textless{}- empty list
\State \hspace*{0em}for each c in C do
\State \hspace*{1em}T \textless{}- configured primary input type of activity(c)
\State \hspace*{1em}o \textless{}- first participant of c with type T, if present
\State \hspace*{1em}if no primary object or no matrix row for its state then
\State \hspace*{2em}w \textless{}- 1
\State \hspace*{1em}else
\State \hspace*{2em}a \textless{}- last activity of o, or \textless{}START\textgreater{} if none
\State \hspace*{2em}w \textless{}- P[T, a].get(activity(c), 0)
\State \hspace*{1em}w \textless{}- max(w, 0.000000001)
\State \hspace*{1em}u \textless{}- R.uniform(0, 1); replace zero by 0.000000001
\State \hspace*{1em}append (u raised to the power 1/w, c) to K
\State \hspace*{0em}sort K by key in descending order
\State \hspace*{0em}return candidates from K
\end{algorithmic}
\end{algorithm}

```

## 4. Temporal transition discovery

```latex

\begin{algorithm}[H]
\caption{Temporal transition discovery}
\label{alg:temporal-transition-discovery}
\begin{algorithmic}[1]
\Require Timestamped traces Q, ordered by event time
\Ensure Transition statistics T[a,b], including all observed time-gap samples
\State \hspace*{0em}D \textless{}- map from activity pairs to empty sample lists
\State \hspace*{0em}for each trace q in Q do
\State \hspace*{1em}for each adjacent pair ((a, ta), (b, tb)) in q do
\State \hspace*{2em}append seconds(tb - ta) to D[a,b]
\State \hspace*{0em}T \textless{}- empty map
\State \hspace*{0em}for each observed pair (a,b) with samples X = D[a,b] do
\State \hspace*{1em}n \textless{}- size(X)
\State \hspace*{1em}T[a,b] \textless{}- (n, X, mean(X), median(X), min(X), max(X))
\State \hspace*{1em}if n \textgreater{} 1 then sd \textless{}- sample standard deviation of X
\State \hspace*{1em}else sd \textless{}- 0
\State \hspace*{1em}if n \textgreater{}= 4 then
\State \hspace*{2em}(q25, q75) \textless{}- first and third Python exclusive quartiles of X
\State \hspace*{1em}else
\State \hspace*{2em}(q25, q75) \textless{}- (min(X), max(X))
\State \hspace*{1em}add sd, q25, and q75 to T[a,b]
\State \hspace*{0em}return T
\end{algorithmic}
\end{algorithm}

```

## 5. Activity timing and service-time estimation

```latex

\begin{algorithm}[H]
\caption{Activity timing and service-time estimation}
\label{alg:activity-timing-and-service-time-estimation}
\begin{algorithmic}[1]
\Require Normalized OCEL L, optional service anchors H, mode m in \{minimum, p25, p50\}
\Ensure Per-activity timing metrics and parameters for a lognormal time policy
\State \hspace*{0em}build each object timeline in timestamp order
\State \hspace*{0em}B \textless{}- empty per-activity metric buckets
\State \hspace*{0em}for each event e with activity a, valid time t, and participating objects do
\State \hspace*{1em}V \textless{}- valid immediately preceding timestamps on its object timelines
\State \hspace*{1em}N \textless{}- valid immediately following timestamps on its object timelines
\State \hspace*{1em}append max(0, seconds(v - t)) to B[a].direct for every v in N
\State \hspace*{1em}if V is empty then
\State \hspace*{2em}append 0 to B[a].flow and B[a].sojourn; continue
\State \hspace*{1em}early \textless{}- min(V); late \textless{}- max(V)
\State \hspace*{1em}append seconds(late - early) to B[a].sync
\State \hspace*{1em}append max(0, seconds(t - early)) to B[a].flow
\State \hspace*{1em}append max(0, seconds(t - late)) to B[a].sojourn
\State \hspace*{1em}group preceding timestamps by object type
\State \hspace*{1em}append max(type-latest) - min(type-earliest) to B[a].pooling
\State \hspace*{1em}append max(type-latest) - late to B[a].lagging
\State \hspace*{0em}for each activity a in B or H do
\State \hspace*{1em}D \textless{}- B[a].direct; Z \textless{}- positive values in B[a].sojourn
\State \hspace*{1em}if D and Z are nonempty then
\State \hspace*{2em}X \textless{}- list with smaller upper median; prefer D on a tie
\State \hspace*{1em}else X \textless{}- D if nonempty, else Z if nonempty, else B[a].sojourn
\State \hspace*{1em}if a has an anchor then use its supplied service parameters
\State \hspace*{1em}else if X is nonempty then
\State \hspace*{2em}Y \textless{}- sorted rank window of X selected by m
\State \hspace*{2em}service \textless{}- mean, population deviation, minimum, maximum of Y
\State \hspace*{1em}else service \textless{}- summary of B[a].sojourn
\State \hspace*{1em}summarize timing buckets using population standard deviations
\State \hspace*{1em}waiting\_mean \textless{}- max(0, sojourn\_mean - service\_mean), if defined
\State \hspace*{1em}emit metrics and service parameters with dist\_type = lognormal
\State \hspace*{0em}return emitted per-activity results
\end{algorithmic}
\end{algorithm}

```

## 6. Trace-based transition probability discovery

```latex

\begin{algorithm}[H]
\caption{Trace-based transition probability discovery}
\label{alg:trace-based-transition-probability-discovery}
\begin{algorithmic}[1]
\Require Activity traces Q (global, case-based, or supplied directly)
\Ensure Row-normalized directly-follows probability matrix P
\State \hspace*{0em}C \textless{}- zero-initialized transition counter
\State \hspace*{0em}for each trace q in Q do
\State \hspace*{1em}for each adjacent activity pair (a,b) in q do
\State \hspace*{2em}C[a,b] \textless{}- C[a,b] + 1
\State \hspace*{0em}P \textless{}- empty map
\State \hspace*{0em}for each source a with observed successors do
\State \hspace*{1em}total \textless{}- sum of C[a,b] over all targets b
\State \hspace*{1em}for each observed target b do
\State \hspace*{2em}P[a,b] \textless{}- C[a,b] / total
\State \hspace*{0em}return P
\end{algorithmic}
\end{algorithm}

```

## 7. Pooled object-trace probability discovery

```latex

\begin{algorithm}[H]
\caption{Pooled object-trace probability discovery}
\label{alg:pooled-object-trace-probability-discovery}
\begin{algorithmic}[1]
\Require OCEL L with known objects, event activities, timestamps, and relationships
\Ensure Transition probabilities P, ending probabilities E, boundary counts, and positions
\State \hspace*{0em}Q \textless{}- collect and timestamp-sort event activities per known object
\State \hspace*{0em}C, F, B, Z, U \textless{}- zero-initialized counters; ntraces \textless{}- 0
\State \hspace*{0em}for each nonempty object trace q in Q do
\State \hspace*{1em}n \textless{}- size(q); ntraces \textless{}- ntraces + 1
\State \hspace*{1em}B[first(q)] \textless{}- B[first(q)] + 1
\State \hspace*{1em}Z[last(q)] \textless{}- Z[last(q)] + 1
\State \hspace*{1em}for each zero-based position i and activity a in q do
\State \hspace*{2em}F[a] \textless{}- F[a] + 1
\State \hspace*{2em}U[a] \textless{}- U[a] + (i/(n-1) if n \textgreater{} 1 else 0)
\State \hspace*{1em}for each adjacent pair (a,b) in q do
\State \hspace*{2em}if a != b then C[a,b] \textless{}- C[a,b] + 1
\State \hspace*{0em}for each activity a in F do
\State \hspace*{1em}P[a] \textless{}- empty row
\State \hspace*{1em}for each counted successor b do P[a,b] \textless{}- round(C[a,b]/F[a], 6)
\State \hspace*{1em}if Z[a] \textgreater{} 0 then E[a] \textless{}- round(Z[a]/F[a], 6)
\State \hspace*{1em}position[a] \textless{}- round(U[a]/F[a], 4)
\State \hspace*{0em}return P, E, B, Z, ntraces, position
\end{algorithmic}
\end{algorithm}

```

## 8. Per-object-type transition probability discovery

```latex

\begin{algorithm}[H]
\caption{Per-object-type transition probability discovery}
\label{alg:per-object-type-transition-probability-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L
\Ensure P[T,a,b]: probability of next activity b given type T and previous activity a
\State \hspace*{0em}E \textless{}- events with an activity and a parseable timestamp
\State \hspace*{0em}sort E by timestamp
\State \hspace*{0em}Q \textless{}- empty activity sequence for each referenced object
\State \hspace*{0em}for each event e in E do
\State \hspace*{1em}append activity(e) to Q[o] for every referenced object o
\State \hspace*{0em}C \textless{}- zero-initialized counter indexed by type, previous activity, next activity
\State \hspace*{0em}for each object o with known type T and a sequence q do
\State \hspace*{1em}previous \textless{}- \textless{}START\textgreater{}
\State \hspace*{1em}for each activity a in q do
\State \hspace*{2em}C[T,previous,a] \textless{}- C[T,previous,a] + 1
\State \hspace*{2em}previous \textless{}- a
\State \hspace*{0em}for each observed state (T,previous) do
\State \hspace*{1em}total \textless{}- sum of C[T,previous,a] over all next activities a
\State \hspace*{1em}P[T,previous,a] \textless{}- C[T,previous,a] / total for every observed a
\State \hspace*{0em}return P
\end{algorithmic}
\end{algorithm}

```

## 9. Object lifecycle discovery

```latex

\begin{algorithm}[H]
\caption{Object lifecycle discovery}
\label{alg:object-lifecycle-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L, object type T, lifecycle threshold h (default 0.5)
\Ensure Creating activity set C and terminating activity set D for T
\State \hspace*{0em}Q \textless{}- timestamp-ordered, nonempty traces for objects of type T
\State \hspace*{0em}n \textless{}- number of traces in Q
\State \hspace*{0em}if n = 0 then return empty sets
\State \hspace*{0em}F \textless{}- counts of first activities; Z \textless{}- counts of last activities
\State \hspace*{0em}S \textless{}- counts of activities in single-event object traces
\State \hspace*{0em}C \textless{}- activities a such that F[a]/n \textgreater{}= h
\State \hspace*{0em}D \textless{}- empty set
\State \hspace*{0em}for each activity a with Z[a]/n \textgreater{}= h do
\State \hspace*{1em}if a is not in C or S[a]/n \textgreater{}= h then add a to D
\State \hspace*{0em}for each activity a appearing as a last activity do
\State \hspace*{1em}reached \textless{}- number of object traces containing a at least once
\State \hspace*{1em}if reached \textgreater{} 0 and Z[a] = reached then add a to D
\State \hspace*{0em}return C, D
\end{algorithmic}
\end{algorithm}

```

## 10. Reusable-object type discovery

```latex

\begin{algorithm}[H]
\caption{Reusable-object type discovery}
\label{alg:reusable-object-type-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L, reuse threshold h (default 2.0)
\Ensure Sorted list R of reusable object types
\State \hspace*{0em}C \textless{}- zero-initialized counter of (object, activity) occurrences
\State \hspace*{0em}for each event e with a nonempty activity do
\State \hspace*{1em}for each referenced object o do C[o,activity(e)] \textless{}- C[o,activity(e)] + 1
\State \hspace*{0em}for each object o with known type T do
\State \hspace*{1em}if o has activity counts then score[o] \textless{}- max over activities of C[o,a]
\State \hspace*{1em}else score[o] \textless{}- 0
\State \hspace*{0em}for each object type T do
\State \hspace*{1em}reuse[T] \textless{}- mean of score[o] for all objects of T
\State \hspace*{0em}R \textless{}- all types T such that reuse[T] \textgreater{}= h
\State \hspace*{0em}return sorted(R)
\end{algorithmic}
\end{algorithm}

```

## 11. Automatic reuse-threshold suggestion

```latex

\begin{algorithm}[H]
\caption{Automatic reuse-threshold suggestion}
\label{alg:automatic-reuse-threshold-suggestion}
\begin{algorithmic}[1]
\Require OCEL L
\Ensure Suggested threshold h, or no suggestion
\State \hspace*{0em}compute reuse[T] as in reusable-object type discovery
\State \hspace*{0em}V \textless{}- reuse scores sorted ascending
\State \hspace*{0em}if size(V) \textless{} 2 then return no suggestion
\State \hspace*{0em}best\_ratio \textless{}- 1; best\_pair \textless{}- none
\State \hspace*{0em}for each adjacent pair (lo,hi) in V do
\State \hspace*{1em}if lo \textgreater{} 0 then ratio \textless{}- hi/lo
\State \hspace*{1em}else ratio \textless{}- infinity if hi \textgreater{} 0, otherwise 1
\State \hspace*{1em}if ratio \textgreater{} best\_ratio then
\State \hspace*{2em}best\_ratio \textless{}- ratio; best\_pair \textless{}- (lo,hi)
\State \hspace*{0em}if best\_pair is none or best\_ratio \textless{} 3 then return no suggestion
\State \hspace*{0em}(lo,hi) \textless{}- best\_pair
\State \hspace*{0em}h \textless{}- square root of (lo * hi) if lo \textgreater{} 0, otherwise hi
\State \hspace*{0em}return round(h, 2)
\end{algorithmic}
\end{algorithm}

```

## 12. Creation-count distribution discovery

```latex

\begin{algorithm}[H]
\caption{Creation-count distribution discovery}
\label{alg:creation-count-distribution-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L
\Ensure Empirical histograms H[activity,type,new-object count]
\State \hspace*{0em}E \textless{}- events sorted by (timestamp or empty string, event identifier)
\State \hspace*{0em}seen \textless{}- empty set; H \textless{}- zero-initialized histogram
\State \hspace*{0em}for each event e in E with a nonempty activity a do
\State \hspace*{1em}present \textless{}- zero-initialized per-type counter
\State \hspace*{1em}fresh \textless{}- zero-initialized per-type counter
\State \hspace*{1em}for each referenced object o with a known type T do
\State \hspace*{2em}present[T] \textless{}- present[T] + 1
\State \hspace*{2em}if o is not in seen then fresh[T] \textless{}- fresh[T] + 1
\State \hspace*{1em}for each T occurring in present do
\State \hspace*{2em}H[a,T,fresh[T]] \textless{}- H[a,T,fresh[T]] + 1
\State \hspace*{1em}add all object identifiers referenced by e to seen
\State \hspace*{0em}remove every (activity,type) histogram with no positive creation count
\State \hspace*{0em}return H with histogram count keys encoded as strings
\end{algorithmic}
\end{algorithm}

```

## 13. Interarrival-time discovery

```latex

\begin{algorithm}[H]
\caption{Interarrival-time discovery}
\label{alg:interarrival-time-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L
\Ensure Per-activity interarrival distribution parameters I
\State \hspace*{0em}group valid event timestamps by activity and sort each group
\State \hspace*{0em}I \textless{}- empty map
\State \hspace*{0em}for each activity a with timestamp sequence t do
\State \hspace*{1em}if size(t) \textless{} 2 then continue
\State \hspace*{1em}G \textless{}- seconds(t[i] - t[i-1]) for i = 1,...,size(t)-1
\State \hspace*{1em}retain nonnegative gaps in G
\State \hspace*{1em}if G is empty then continue
\State \hspace*{1em}mu \textless{}- mean(G); sigma \textless{}- population standard deviation of G
\State \hspace*{1em}kind \textless{}- exponential if mu \textgreater{} 0, otherwise fixed
\State \hspace*{1em}I[a] \textless{}- (kind, mu, sigma, min(G), max(G), size(G))
\State \hspace*{0em}return I
\end{algorithmic}
\end{algorithm}

```

## 14. Weekly availability-calendar discovery

```latex

\begin{algorithm}[H]
\caption{Weekly availability-calendar discovery}
\label{alg:weekly-availability-calendar-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L with valid event timestamps
\Ensure Global 168-slot probability calendar, observed week count, and activity names
\State \hspace*{0em}W \textless{}- empty set of observed ISO (year,week) pairs
\State \hspace*{0em}V[s] \textless{}- empty set of weeks for s = 0,...,167
\State \hspace*{0em}A \textless{}- activities with valid event times
\State \hspace*{0em}for each valid timestamp t from any activity do
\State \hspace*{1em}w \textless{}- ISO year and ISO week of t
\State \hspace*{1em}s \textless{}- 24 * weekday(t) + hour(t)                     // Monday is day 0
\State \hspace*{1em}add w to W; add w to V[s]
\State \hspace*{0em}if W is empty then return empty result
\State \hspace*{0em}for s = 0,...,167 do p[s] \textless{}- size(V[s]) / size(W)
\State \hspace*{0em}return slots\_per\_week = 168, global = p, per\_activity = empty map,
\State \hspace*{1em}fallback\_activities = sorted(A), weeks\_observed = size(W)
\end{algorithmic}
\end{algorithm}

```

## 15. Activity concurrency discovery

```latex

\begin{algorithm}[H]
\caption{Activity concurrency discovery}
\label{alg:activity-concurrency-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L, activity timing metrics M, safety factor f (default 1)
\Ensure Per-activity concurrency limits K
\State \hspace*{0em}group valid event timestamps by activity
\State \hspace*{0em}if M is absent then compute activity timing metrics using minimum mode
\State \hspace*{0em}for each activity a with timestamp list T do
\State \hspace*{1em}d \textless{}- M[a].mean\_seconds, or 0 if missing
\State \hspace*{1em}if d \textless{}= 0 then K[a] \textless{}- 1; continue
\State \hspace*{1em}B \textless{}- (t,+1) and (t+d,-1) for every t in T
\State \hspace*{1em}sort B by timestamp, then by delta ascending
\State \hspace*{1em}active \textless{}- 0; peak \textless{}- 0
\State \hspace*{1em}for each (\_,delta) in B do
\State \hspace*{2em}active \textless{}- active + delta; peak \textless{}- max(peak, active)
\State \hspace*{1em}K[a] \textless{}- max(1, ceiling(peak * f))
\State \hspace*{0em}return K
\end{algorithmic}
\end{algorithm}

```

## 16. Observed object work-in-progress discovery

```latex

\begin{algorithm}[H]
\caption{Observed object work-in-progress discovery}
\label{alg:observed-object-work-in-progress-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L, safety factor f (default 1)
\Ensure Per-type scaled peak counts K for validation
\State \hspace*{0em}for each referenced object o with valid event timestamps do
\State \hspace*{1em}first[o] \textless{}- earliest timestamp; last[o] \textless{}- latest timestamp
\State \hspace*{0em}for each known object type T with observed intervals do
\State \hspace*{1em}B \textless{}- (first[o],+1) and (last[o],-1) for objects o of type T
\State \hspace*{1em}sort B by timestamp, then by delta ascending
\State \hspace*{1em}active \textless{}- 0; peak \textless{}- 0
\State \hspace*{1em}for each (\_,delta) in B do
\State \hspace*{2em}active \textless{}- active + delta; peak \textless{}- max(peak, active)
\State \hspace*{1em}if peak \textgreater{} 0 then K[T] \textless{}- max(1, ceiling(peak * f))
\State \hspace*{0em}return K
\end{algorithmic}
\end{algorithm}

```

## 17. Start-activity discovery

```latex

\begin{algorithm}[H]
\caption{Start-activity discovery}
\label{alg:start-activity-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L, minimum percentage p (default 1.0)
\Ensure Ranked start activities with counts and percentages
\State \hspace*{0em}first \textless{}- empty map from object identifiers to (timestamp, activity)
\State \hspace*{0em}for each event e with a nonempty activity a do
\State \hspace*{1em}for each referenced object o present in the object table do
\State \hspace*{2em}if o is unseen or timestamp(e) \textless{} first[o].timestamp then
\State \hspace*{3em}first[o] \textless{}- (timestamp(e), a)
\State \hspace*{0em}n \textless{}- size(first)
\State \hspace*{0em}if n = 0 then return empty list
\State \hspace*{0em}C \textless{}- activity counts among values of first
\State \hspace*{0em}R \textless{}- empty list
\State \hspace*{0em}for each activity a in descending order of C[a] do
\State \hspace*{1em}percentage \textless{}- round(100 * C[a] / n, 1)
\State \hspace*{1em}if percentage \textgreater{}= p then append (a, C[a], percentage) to R
\State \hspace*{0em}return R
\end{algorithmic}
\end{algorithm}

```

## 18. Object-binding cardinality discovery

```latex

\begin{algorithm}[H]
\caption{Object-binding cardinality discovery}
\label{alg:object-binding-cardinality-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L
\Ensure Per-activity, per-type participation bounds B
\State \hspace*{0em}C \textless{}- map from (activity,type) to empty sample lists
\State \hspace*{0em}for each event e with a nonempty activity a do
\State \hspace*{1em}N \textless{}- counts of referenced, known objects grouped by type
\State \hspace*{1em}for each type T present in N do append N[T] to C[a,T]
\State \hspace*{0em}for each observed pair (a,T) with samples X do
\State \hspace*{1em}lo \textless{}- min(X); hi \textless{}- max(X)
\State \hspace*{1em}if hi \textgreater{}= 100 then hi \textless{}- unbounded
\State \hspace*{1em}B[a,T] \textless{}- (min\_count = lo, max\_count = hi,
\State \hspace*{3em}creates = false, deactivates = false)
\State \hspace*{0em}return B
\end{algorithmic}
\end{algorithm}

```

## 19. Object-to-object relationship discovery

```latex

\begin{algorithm}[H]
\caption{Object-to-object relationship discovery}
\label{alg:object-to-object-relationship-discovery}
\begin{algorithmic}[1]
\Require Normalized OCEL L with explicit object relationships
\Ensure Type-pair relationship rules with observed cardinalities
\State \hspace*{0em}links \textless{}- empty sets indexed by (source type, target type, source object)
\State \hspace*{0em}qualifiers \textless{}- empty sets indexed by type pair
\State \hspace*{0em}for each explicitly declared relationship from object x to object y do
\State \hspace*{1em}if an endpoint type is unknown or type(x) = type(y) then continue
\State \hspace*{1em}if x = y then continue
\State \hspace*{1em}add y to links[type(x),type(y),x]
\State \hspace*{1em}add x to links[type(y),type(x),y]
\State \hspace*{1em}retain nonempty qualifier for both type directions
\State \hspace*{0em}R \textless{}- empty list
\State \hspace*{0em}for each unordered type pair \{T,U\} occurring in links do
\State \hspace*{1em}F \textless{}- distinct-partner counts in direction T to U
\State \hspace*{1em}G \textless{}- distinct-partner counts in direction U to T
\State \hspace*{1em}(flo,fhi) \textless{}- (min(F),max(F)); (glo,ghi) \textless{}- (min(G),max(G))
\State \hspace*{1em}if flo = glo and fhi = ghi then
\State \hspace*{2em}append one bidirectional rule with bounds (flo,fhi) to R
\State \hspace*{1em}else
\State \hspace*{2em}append directed T-to-U rule with bounds (flo,fhi) to R
\State \hspace*{2em}append directed U-to-T rule with bounds (glo,ghi) to R
\State \hspace*{1em}attach sorted qualifiers to emitted rules where available
\State \hspace*{0em}return R
\end{algorithmic}
\end{algorithm}

```
