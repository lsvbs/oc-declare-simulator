from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from typing import Optional

from src.Simulation.Domain.ir import StaticModel, Activity
from src.Simulation.Domain.state import SimulationState, PendingObligation, InProgressActivity, WaitingCandidate
from src.Simulation.Domain.config import SimulationConfig
from src.Simulation.Engine.selection import select_candidate as default_select_candidate
from src.Simulation.Engine.candidategeneration import (
    Candidate,
    build_candidate_for_activity,
    find_active_objects_of_type,
    build_candidate_for_object_and_activity,
    is_candidate_semantically_allowed,
)
from src.Simulation.Engine.semantics import _count_activity_for_object


def _apply_attribute_update(obj, upd: dict) -> None:
    """Apply a single attribute update dict to a RuntimeObject in-place."""
    attr = upd.get('attribute', '')
    op   = upd.get('op', 'set')
    if not attr:
        return
    if op == 'set':
        obj.attributes[attr] = upd.get('value')
    elif op == 'increment':
        obj.attributes[attr] = obj.attributes.get(attr, 0) + upd.get('by', 1)
    elif op == 'decrement':
        obj.attributes[attr] = obj.attributes.get(attr, 0) - upd.get('by', 1)


def apply_conservative_link_policy(static_model, participating_ids, created_object_ids, state):
    """Create O2O links after an activity fires.

    Only writes a link between two objects if:
      1. An O2O rule covers their types, AND
      2. The link does not already exist, AND
      3. Neither object would exceed the rule's max_links by adding this link.

    This prevents pre-existing objects from other cases being spuriously linked
    to newly created objects, which would saturate O2O caps and block future
    activities on those objects.
    """

    def _link_exists(src: str, tgt: str) -> bool:
        neighbors = state._links_by_object.get(src)
        return neighbors is not None and tgt in neighbors

    def _count_links(oid: str, other_type: str) -> int:
        # O(1) via typed index if available, else O(degree) fallback
        lbt = getattr(state, '_linked_by_type', None)
        if lbt is not None:
            return len(lbt.get(oid, {}).get(other_type, frozenset()))
        count = 0
        for neighbor_id in state._links_by_object.get(oid, ()):
            obj = state.objects.get(neighbor_id)
            if obj and obj.object_type == other_type:
                count += 1
        return count

    def _can_link(id_a: str, type_a: str, id_b: str, type_b: str, rule) -> bool:
        """True if adding this link would not exceed max_links on either side."""
        if rule.max_links is None:
            return True
        if rule.source_type == type_a and rule.target_type == type_b:
            return (_count_links(id_a, type_b) < rule.max_links and
                    _count_links(id_b, type_a) < rule.max_links)
        if rule.source_type == type_b and rule.target_type == type_a:
            return (_count_links(id_b, type_a) < rule.max_links and
                    _count_links(id_a, type_b) < rule.max_links)
        return True

    # 1. Link every newly created object to every applicable participating object
    for created_id in created_object_ids:
        created_obj = state.objects.get(created_id)
        if created_obj is None:
            continue
        created_type = created_obj.object_type

        for pid in participating_ids:
            p_obj = state.objects.get(pid)
            if p_obj is None:
                continue
            p_type = p_obj.object_type

            for rule in static_model.o2o_rules:
                if rule.source_type == p_type and rule.target_type == created_type:
                    if not _link_exists(pid, created_id) and _can_link(pid, p_type, created_id, created_type, rule):
                        state.add_link(source_object_id=pid, target_object_id=created_id)
                elif rule.source_type == created_type and rule.target_type == p_type:
                    if not _link_exists(created_id, pid) and _can_link(created_id, created_type, pid, p_type, rule):
                        state.add_link(source_object_id=created_id, target_object_id=pid)

    # 2. Also link participating objects to each other where an O2O rule applies
    for i, pid1 in enumerate(participating_ids):
        p1_obj = state.objects.get(pid1)
        if p1_obj is None:
            continue
        for pid2 in participating_ids[i + 1:]:
            p2_obj = state.objects.get(pid2)
            if p2_obj is None:
                continue
            for rule in static_model.o2o_rules:
                if rule.source_type == p1_obj.object_type and rule.target_type == p2_obj.object_type:
                    if not _link_exists(pid1, pid2) and _can_link(pid1, p1_obj.object_type, pid2, p2_obj.object_type, rule):
                        state.add_link(source_object_id=pid1, target_object_id=pid2)
                elif rule.source_type == p2_obj.object_type and rule.target_type == p1_obj.object_type:
                    if not _link_exists(pid2, pid1) and _can_link(pid2, p2_obj.object_type, pid1, p1_obj.object_type, rule):
                        state.add_link(source_object_id=pid2, target_object_id=pid1)



class Simulator:
    def __init__(
        self,
        static_model: StaticModel,
        config: SimulationConfig,
        rng: object | None = None,
        *,
        trace_func: callable | None = None,
        select_func: callable | None = None,
        stop_event=None,  # threading.Event — set to request early termination
        transition_matrix: dict | None = None,
        start_counts: dict | None = None,  # {activity: count} from OC discovery, used as fallback weights
    ):
        """Create a Simulator.

        Parameters
        - static_model: the StaticModel to simulate
        - config: SimulationConfig with max_steps and optional seed
        - rng: optional Random-like instance. If omitted, an RNG is created from config.seed
        """
        self.static_model = static_model
        self.config = config
        # deterministic RNG for reproducible selection when seed provided
        # Accept an injected RNG for testability; otherwise create one from config.seed
        from src.Simulation.Engine.rng import get_rng

        if rng is None:
            self.rng = get_rng(self.config.seed)
        else:
            # allow passing either a Random instance or an RNG provider with .rng
            self.rng = getattr(rng, "rng", rng)

        from src.Simulation.Engine.timepolicy import DefaultTimePolicy, DistributionTimePolicy
        durations = getattr(static_model, "activity_durations", {}) or {}
        concurrency_probs = getattr(static_model, "concurrency_probs", {}) or {}
        if durations:
            self.time_policy = DistributionTimePolicy(
                durations=durations,
                concurrency_probs=concurrency_probs or None,
            )
        else:
            self.time_policy = DefaultTimePolicy()

        # selection function can be overridden by tests or higher-level orchestration
        self.select_func = select_func or default_select_candidate

        # Optional tracing hook (kept generic to avoid coupling the engine to stdout/logging).
        # Signature: trace_func(event: str, payload: dict)
        self.trace_func = trace_func

        # Optional stop signal: caller sets this threading.Event to request early stop.
        self.stop_event = stop_event

        # Transition matrix used to probabilistically gate no-input start activities
        # in DES mode (prevents them from firing every single step unconditionally).
        self.transition_matrix = transition_matrix or {}
        # Trace-start counts from OC discovery: used as fallback weights for start
        # activities that don't appear in the last row of the transition matrix.
        self.start_counts = start_counts or {}

        # ── Hot-path caches (computed once, reused every step) ────────────────
        # #2: resource types as a set — avoids rebuilding set(...) in every generator call
        self._resource_types_set: set = set(getattr(static_model, 'resource_types', []) or [])

        # #3: start activity names as a set — avoids rebuilding set(...) per step
        self._start_names_set: set = set(config.start_policy.start_activity_names)

        # #4: activity name → Activity dict — avoids O(A) scan in obligation injection
        self._act_by_name: dict = {a.name: a for a in static_model.activities}

        # #4: precedence constraints indexed by target_activity — avoids O(C) scan per step
        self._prec_by_target: dict = {}
        for con in static_model.constraints:
            if con.constraint_type == 'precedence':
                self._prec_by_target.setdefault(con.target_activity, []).append(con)

        # #8: response constraints indexed by source_activity — avoids O(C) scan per event
        self._response_by_source: dict = {}
        for con in static_model.constraints:
            if con.constraint_type == 'response':
                self._response_by_source.setdefault(con.source_activity, []).append(con)

        # Phase 1: For each response target B, which precedence sources must fire first?
        # _obligation_prerequisites[target_act][scope_type] = [required_source_activities]
        self._obligation_prerequisites: dict = {}
        for con in static_model.constraints:
            if con.constraint_type not in ('response', 'chain_response'):
                continue
            tgt = con.target_activity
            scope_type = getattr(con.scope, 'object_type', None) if con.scope else None
            prec_gates = [
                p.source_activity for p in static_model.constraints
                if p.constraint_type == 'precedence'
                and p.target_activity == tgt
                and getattr(p.scope, 'object_type', None) == scope_type
                and getattr(p, 'nmin', 0) > 0
            ]
            if prec_gates:
                self._obligation_prerequisites.setdefault(tgt, {}).setdefault(
                    scope_type, []).extend(prec_gates)

        # Phase 2: Non-resource, non-creating object types required per activity
        # Used to skip activities whose required types are all inactive
        self._activity_required_types: dict = {}
        resource_set = set(getattr(static_model, 'resource_types', []) or [])
        for activity in static_model.activities:
            required = {
                b.object_type for b in activity.bindings
                if not b.creates and b.object_type not in resource_set
            }
            if required:
                self._activity_required_types[activity.name] = required

        # Reusable set for obligation dedup — cleared each step, avoids per-step allocation
        self._seen_obligation_keys: set = set()
        # Delta tracking for iteration log: last-seen cumulative counters
        self._last_deactivations: int = 0
        self._last_obligations_fulfilled: int = 0

    def _trace(self, event: str, payload: dict) -> None:
        if self.trace_func is None:
            return
        try:
            self.trace_func(event, payload)
        except Exception:
            # Tracing should never break the simulation.
            return
    def run(self, state: Optional[SimulationState] = None) -> SimulationState:
        # Auto-select DES mode whenever resource types are configured.
        # DES is required for correct resource contention (locking/waiting queue).
        # Without timing distributions the engine falls back to DefaultTimePolicy
        # (fixed clock delta), which is still valid for resource-aware simulation.
        resource_types = getattr(self.static_model, 'resource_types', []) or []
        if resource_types:
            return self.run_des(state)

        if state is None:
            state = SimulationState()

        # Seed the start-event counter index so _start_event_count is maintained
        # correctly by record_event throughout the run.
        state._start_activity_names = self._start_names_set
        state._resource_types = set(getattr(self.static_model, 'resource_types', []) or [])

        # Pre-populate resource pool objects so activities that bind resource
        # types always find existing instances without needing a creates step.
        pool_sizes = getattr(self.static_model, 'resource_pool_sizes', {}) or {}
        for res_type in state._resource_types:
            n = pool_sizes.get(res_type, 1)
            for _ in range(n):
                from src.Simulation.Domain.state import RuntimeObject
                oid = state.new_object_id(res_type)
                obj = RuntimeObject(object_id=oid, object_type=res_type, active=True)
                state.objects[oid] = obj
                state._active_by_type.setdefault(res_type, set()).add(oid)
                state._type_of_object[oid] = res_type

        while True:
            if self._should_stop(state):
                self._trace(
                    "stop",
                    {
                        "reason": "max_steps",
                        "step_count": state.step_count,
                        "max_steps": self.config.max_steps,
                    },
                )
                break

            candidates = self._generate_candidates(state)

            # Track "available since": record first time each activity appears
            # in the candidate pool. Reset the clock when an activity fires.
            now_ts = state.last_generated_timestamp
            if now_ts is not None:
                candidate_names = {c.activity_name for c in candidates}
                # Mark first appearance for newly available activities
                for name in candidate_names:
                    if name not in state._candidate_first_seen:
                        state._candidate_first_seen[name] = now_ts
                # Remove activities no longer in the pool (they lost eligibility)
                gone = set(state._candidate_first_seen) - candidate_names
                for name in gone:
                    del state._candidate_first_seen[name]
            # Emit a rich iteration payload so callers can debug candidate
            # generation and object evolution if they enable tracing.
            # Guard with trace_func check to avoid building expensive payloads
            # on every step when tracing is disabled.
            if self.trace_func is not None:
                self._trace(
                    "iteration",
                    {
                        "step_count": state.step_count,
                        "num_candidates": len(candidates),
                        "candidate_activity_names": [c.activity_name for c in candidates],
                        "candidates": [
                            {
                                "activity_name": c.activity_name,
                                "participating_object_ids": list(c.participating_object_ids),
                                "object_types_to_create": list(c.object_types_to_create),
                            }
                            for c in candidates
                        ],
                    },
                )

            if not candidates:
                self._trace(
                    "stop",
                    {
                        "reason": "no_candidates",
                        "step_count": state.step_count,
                    },
                )
                break

            chosen = self._select_candidate(candidates, state)

            # Record how long this activity was available before being chosen
            fired_ts = state.last_generated_timestamp
            first_seen = state._candidate_first_seen.get(chosen.activity_name)
            if fired_ts is not None and first_seen is not None:
                wait = (fired_ts - first_seen).total_seconds()
                if wait >= 0:
                    state.candidate_wait_s.setdefault(chosen.activity_name, []).append(wait)
            # Reset availability clock for the fired activity
            state._candidate_first_seen.pop(chosen.activity_name, None)
            self._trace(
                "chosen",
                {
                    "activity_name": chosen.activity_name,
                    "participating_object_ids": list(chosen.participating_object_ids),
                    "object_types_to_create": list(chosen.object_types_to_create),
                },
            )

            self._apply_candidate(chosen, state)
            if state.executed_events:
                last = state.executed_events[-1]
                self._trace(
                    "applied",
                    {
                        "event_id": last.event_id,
                        "activity_name": last.activity_name,
                        "timestamp": last.timestamp.isoformat() if last.timestamp is not None else None,
                        "object_ids": list(last.object_ids),
                        "step_count": state.step_count,
                    },
                )

        return state

    #def _initialize_state(self, state: SimulationState) -> None:
     #   for object_type, count in self.config.initial_objects.counts_by_type.items():
      #      for _ in range(count):
       #         state.add_object(object_type=object_type)

    def _should_stop(self, state: SimulationState) -> bool:
        # Time-based limit (primary)
        max_time = getattr(self.config, 'max_sim_time_s', None)
        if max_time is not None and state.last_generated_timestamp is not None:
            elapsed = (state.last_generated_timestamp - self.config.start_timestamp).total_seconds()
            if elapsed >= max_time:
                return True
        # Trace-based limit (primary)
        max_tr = getattr(self.config, 'max_traces', None)
        if max_tr is not None:
            if state.completed_trace_count >= max_tr:
                return True
        # Event/step cap (safety backstop — always applies)
        if state.step_count >= self.config.max_steps:
            return True
        return False

    def _generate_candidates_des(self, state: SimulationState) -> list[Candidate]:
        """Generate one candidate per (activity, non-resource object) combination for DES mode.

        Unlike the global generator which produces one candidate per activity,
        this expands across non-resource objects so that each case object (e.g.
        each order) gets its own candidate entry. Multiple candidates for the
        same activity can then compete for the same resource and queue when it
        is occupied.
        """
        resource_types: set[str] = self._resource_types_set
        is_simulation_start = len(state.executed_events) == 0 and not state.in_progress
        start_activity_names = self._start_names_set
        candidates: list[Candidate] = []
        seen_keys: set[tuple] = set()

        max_consec: dict = getattr(self.static_model, "max_consecutive", {}) or {}
        max_consec_obj: dict = getattr(self.static_model, "max_consecutive_per_object", {}) or {}
        no_parallel: set = getattr(self.static_model, "no_parallel_activities", set()) or set()
        # Pre-compute which no-parallel activities are currently in-progress
        in_progress_acts: set = {ip.candidate_activity_name for ip in state.in_progress} if no_parallel else set()

        for activity in self.static_model.activities:
            if is_simulation_start and activity.name not in start_activity_names:
                continue
            # Skip if activity disallows parallelism and is already running
            if activity.name in no_parallel and activity.name in in_progress_acts:
                continue

            # Phase 2: skip if all required object types have zero active instances
            _req_types = self._activity_required_types.get(activity.name)
            if _req_types and _req_types.issubset(state._inactive_scope_types):
                continue

            # Find the primary non-resource input binding (first creates=False, non-resource type)
            primary_bindings = [
                b for b in activity.bindings
                if not b.creates and b.object_type not in resource_types
            ]

            if not primary_bindings:
                # Activity only creates or only uses resources — generate once globally.
                # For start activities with no input objects, gate by transition probability
                # so they don't fire unconditionally every step in DES mode.
                # All no-input start activities share the same normalised pool: each gets
                # weight = row[activity] (or epsilon if absent). Dividing by the total of
                # ALL row weights (plus epsilon per start activity) preserves the relative
                # ratios between existing targets while giving start activities their fair share.
                #
                # Safety bypass: if in_progress is empty AND the candidate list is still empty
                # at this point, skip the gate for start activities — otherwise the simulation
                # could deadlock permanently if all start activities roll unlucky simultaneously.
                is_potential_deadlock = (
                    activity.name in start_activity_names
                    and not state.in_progress
                    and not candidates
                )
                if self.transition_matrix and activity.name in start_activity_names and state.executed_events and not is_potential_deadlock:
                    last_act = state.executed_events[-1].activity_name
                    row = self.transition_matrix.get(last_act, {})
                    epsilon = 1e-6
                    # For start activities absent from the row, use their trace-start
                    # count as a fallback weight so they fire at their real log frequency
                    # rather than near-zero epsilon.
                    all_keys = set(row) | start_activity_names
                    raw = {}
                    for a in all_keys:
                        if a in row:
                            raw[a] = row[a] + epsilon
                        elif a in start_activity_names and self.start_counts:
                            raw[a] = self.start_counts.get(a, 0.0) + epsilon
                        else:
                            raw[a] = epsilon
                    total = sum(raw.values())
                    prob = raw[activity.name] / total if total > 0 else epsilon
                    if self.rng.random() > prob:
                        continue

                candidate = build_candidate_for_activity(activity, state, resource_types=resource_types)
                if candidate and is_candidate_semantically_allowed(self.static_model, candidate, state):
                    key = (candidate.activity_name, tuple(sorted(candidate.participating_object_ids)),
                           tuple(sorted(candidate.object_types_to_create)))
                    if key not in seen_keys:
                        seen_keys.add(key)
                        candidates.append(candidate)
                continue

            # Expand: one candidate per active object of the primary binding type.
            # Cap at 32 to avoid O(n_objects) work when many objects accumulate.
            primary_type = primary_bindings[0].object_type
            active_ids = list(state._active_by_type.get(primary_type, set()))[:32]

            # Pre-compute cheap precedence gates for this activity (nmin and nmax)
            # using only the primary object id — avoids building the full candidate.
            prec_gates_nmin = [
                con for con in self._prec_by_target.get(activity.name, [])
                if con.scope.kind == 'each'
                and con.scope.object_type == primary_type
                and getattr(con, 'nmin', 0) > 0
            ]
            prec_gates_nmax = [
                con for con in self._prec_by_target.get(activity.name, [])
                if con.scope.kind == 'each'
                and con.scope.object_type == primary_type
                and getattr(con, 'nmax', None) is not None
            ]

            for oid in active_ids:
                if (activity.name, oid) in state._in_progress_objects:
                    continue

                # Early exit: check precedence nmin for this primary object before
                # the expensive build_candidate_for_activity call
                if prec_gates_nmin:
                    blocked = False
                    prec_satisfied = getattr(state, '_prec_satisfied', None)
                    for con in prec_gates_nmin:
                        cache_key = (con.source_activity, activity.name, 'each', oid)
                        if prec_satisfied is not None and cache_key in prec_satisfied:
                            continue  # already permanently satisfied
                        src_count = len(state._events_by_act_obj.get(
                            (con.source_activity, oid), []))
                        if src_count < con.nmin:
                            blocked = True
                            break
                    if blocked:
                        continue

                # Early exit: check precedence nmax and target count cap
                if prec_gates_nmax:
                    blocked = False
                    for con in prec_gates_nmax:
                        src_count = len(state._events_by_act_obj.get(
                            (con.source_activity, oid), []))
                        if src_count > con.nmax:
                            blocked = True
                            break
                        t_count = len(state._events_by_act_obj.get(
                            (activity.name, oid), []))
                        if t_count >= con.nmax:
                            blocked = True
                            break
                    if blocked:
                        continue

                # #6: pass force_object_id instead of mutating _active_by_type
                candidate = build_candidate_for_activity(
                    activity, state,
                    resource_types=resource_types,
                    force_object_id=oid,
                )

                if candidate is None:
                    continue
                if not is_candidate_semantically_allowed(self.static_model, candidate, state):
                    continue

                # max_consecutive checks (O(1) via cached streaks)
                if activity.name in max_consec:
                    cap = max_consec[activity.name]
                    streak = state._global_streak.get(activity.name, 0)
                    if streak >= cap:
                        continue

                if activity.name in max_consec_obj:
                    cap_obj = max_consec_obj[activity.name]
                    blocked = False
                    for pid in candidate.participating_object_ids:
                        if state._type_of_object.get(pid) in resource_types:
                            continue  # resources are freely reusable — exempt from per-object streak cap
                        streak_obj = state._object_streak.get((activity.name, pid), 0)
                        if streak_obj >= cap_obj:
                            blocked = True
                            break
                    if blocked:
                        continue

                key = (candidate.activity_name, tuple(sorted(candidate.participating_object_ids)),
                       tuple(sorted(candidate.object_types_to_create)))
                if key not in seen_keys:
                    seen_keys.add(key)
                    candidates.append(candidate)

        # ── Option 4: Response obligation injection (B + F optimised) ────────
        # B: Build a set of (activity, object) pairs already in the pool so
        #    in-pool checks are O(1) instead of O(pool_size) per obligation.
        # F: Cheap pre-filter before calling build_candidate_for_activity —
        #    skip obligations whose target activity is blocked by precedence
        #    on the scope object without doing a full semantic check.
        if state._obligations_count and not is_simulation_start:
            act_by_name = self._act_by_name

            # B: index of (activity_name, scope_oid) already covered by normal pool
            pool_index: set[tuple] = set()
            for c in candidates:
                for oid in c.participating_object_ids:
                    pool_index.add((c.activity_name, oid))
                if not c.participating_object_ids:
                    pool_index.add((c.activity_name, None))

            # Build in-progress index to prevent starting an obligated activity
            # on an object that is already in-progress for that same activity.
            # Uses state._in_progress_objects maintained in _des_start/complete_activity.
            in_progress_index = state._in_progress_objects

            prec_by_target: dict[str, list] = self._prec_by_target

            seen_obligation_keys = self._seen_obligation_keys
            seen_obligation_keys.clear()
            # Phase 1: iterate only _obligations_ready (prerequisites met) instead of all _obligations_count
            _inject_pool = state._obligations_ready if state._obligations_ready else state._obligations_count
            for (target_act, scope_oid), count in list(_inject_pool.items()):
                if count <= 0:
                    continue
                dedup_key = (target_act, scope_oid)
                if dedup_key in seen_obligation_keys:
                    continue
                seen_obligation_keys.add(dedup_key)

                # Handle all-mode frozenset obligations separately
                is_frozenset = isinstance(scope_oid, frozenset)

                if is_frozenset:
                    # All-mode: target must fire involving all objects in the frozenset
                    frozen_oids = scope_oid
                    # Skip if any object in the set is inactive
                    if any(not (state.objects.get(o) and state.objects[o].active) for o in frozen_oids):
                        continue
                    # Skip if already in pool or in-progress
                    if any((target_act, o) in pool_index for o in frozen_oids):
                        continue
                    if any((target_act, o) in in_progress_index for o in frozen_oids):
                        continue
                    # Build candidate with all frozenset objects forced
                    activity = act_by_name.get(target_act)
                    if activity is None:
                        continue
                    candidate = build_candidate_for_activity(
                        activity, state, resource_types=resource_types,
                        force_object_ids=list(frozen_oids)
                    )
                    if candidate is None:
                        continue
                    if not is_candidate_semantically_allowed(self.static_model, candidate, state):
                        continue
                    key2 = (candidate.activity_name, tuple(sorted(candidate.participating_object_ids)),
                           tuple(sorted(candidate.object_types_to_create)))
                    if key2 not in seen_keys:
                        seen_keys.add(key2)
                        candidates.append(candidate)
                    continue

                # B: O(1) pool membership check (per-object and global obligations)
                if scope_oid is not None:
                    if (target_act, scope_oid) in pool_index:
                        continue
                else:
                    if (target_act, None) in pool_index:
                        continue

                # Skip if the obligated activity is already in-progress on this
                # scope object — prevents concurrent duplicate starts that bypass
                # the event-count check (record_event hasn't run yet for in-progress)
                if scope_oid is not None and (target_act, scope_oid) in in_progress_index:
                    continue
                # Also skip if ANY non-resource binding object for this activity is
                # already in-progress — prevents the same full event being queued
                # multiple times when the obligation fires on every step while the
                # first instance is still running (e.g. Depart queued 40+ times).
                activity_def = act_by_name.get(target_act)
                if activity_def and scope_oid is not None:
                    _skip = False
                    for _b in activity_def.bindings:
                        if _b.creates or _b.object_type in resource_types:
                            continue
                        for _oid in state._active_by_type.get(_b.object_type, set()):
                            if (target_act, _oid) in in_progress_index:
                                _skip = True
                                break
                        if _skip:
                            break
                    if _skip:
                        continue

                # Scope object must exist and be active
                if scope_oid is not None:
                    scope_obj = state.objects.get(scope_oid)
                    if scope_obj is None or not scope_obj.active:
                        continue

                # F: cheap precedence pre-filter
                blocked = False
                for con in prec_by_target.get(target_act, []):
                    if scope_oid is None:
                        if not state._events_by_activity.get(con.source_activity):
                            blocked = True
                            break
                    elif con.scope.kind in ('each', 'any', 'all') and con.scope.object_type:
                        if scope_obj is not None and scope_obj.object_type == con.scope.object_type:
                            src_count = len(state._events_by_act_obj.get(
                                (con.source_activity, scope_oid), []))
                            nmin = con.nmin if con.nmin is not None else 1
                            nmax = con.nmax
                            if nmin > 0 and src_count == 0:
                                blocked = True
                                break
                            if nmax is not None and src_count > nmax:
                                blocked = True
                                break
                if blocked:
                    continue

                activity = act_by_name.get(target_act)
                if activity is None:
                    continue

                if scope_oid is not None:
                    candidate = build_candidate_for_activity(
                        activity, state, resource_types=resource_types, force_object_id=scope_oid
                    )
                else:
                    candidate = build_candidate_for_activity(
                        activity, state, resource_types=resource_types
                    )

                if candidate is None:
                    continue
                if not is_candidate_semantically_allowed(self.static_model, candidate, state):
                    continue

                key = (candidate.activity_name, tuple(sorted(candidate.participating_object_ids)),
                       tuple(sorted(candidate.object_types_to_create)))
                if key not in seen_keys:
                    seen_keys.add(key)
                    candidates.append(candidate)

        return candidates

    def _generate_candidates(self, state: SimulationState) -> list[Candidate]:
        """Generate candidates globally using all active objects.

        This uses the global candidate builder per activity, which in turn
        considers all active runtime objects of each type. Declarative
        constraints and O2O rules are applied via
        `is_candidate_semantically_allowed`.

        The earlier object-centric strategy is kept in
        `_generate_candidates_object_centric` but is not used by default
        anymore.
        """

        candidates: list[Candidate] = []
        seen_keys: set[tuple] = set()

        # Resource types bypass link-preference selection (shared across case chains)
        resource_types: set[str] = self._resource_types_set

        # At simulation start (no events executed), only allow start activities
        is_simulation_start = len(state.executed_events) == 0
        start_activity_names = self._start_names_set

        for activity in self.static_model.activities:
            candidate = build_candidate_for_activity(activity, state, resource_types=resource_types)

            if candidate is None:
                continue
            
            # Enforce start policy: only start activities can fire at the beginning
            if is_simulation_start and candidate.activity_name not in start_activity_names:
                continue

            if self._is_start_activity_blocked(candidate, state):
                continue

            if not is_candidate_semantically_allowed(self.static_model, candidate, state):
                continue

            # Max-consecutive enforcement (O(1) via cached streaks)
            max_consec: dict = getattr(self.static_model, "max_consecutive", {}) or {}
            if candidate.activity_name in max_consec:
                cap = max_consec[candidate.activity_name]
                streak = state._global_streak.get(candidate.activity_name, 0)
                if streak >= cap:
                    continue

            # Per-object max-consecutive (O(1) via cached streaks)
            max_consec_obj: dict = getattr(self.static_model, "max_consecutive_per_object", {}) or {}
            if candidate.activity_name in max_consec_obj:
                cap_obj = max_consec_obj[candidate.activity_name]
                blocked_by_obj = False
                for oid in candidate.participating_object_ids:
                    streak_obj = state._object_streak.get((candidate.activity_name, oid), 0)
                    if streak_obj >= cap_obj:
                        blocked_by_obj = True
                        break
                if blocked_by_obj:
                    continue

            key = (
                candidate.activity_name,
                tuple(sorted(candidate.participating_object_ids)),
                tuple(sorted(candidate.object_types_to_create)),
            )

            if key in seen_keys:
                continue

            seen_keys.add(key)
            candidates.append(candidate)

        return candidates

    def _generate_candidates_object_centric(self, state: SimulationState) -> list[Candidate]:
        """Generate candidates in an object-centric way.

        Instead of choosing from the global pool of objects per activity, we iterate
        over each active runtime object and attempt to build a candidate for each
        activity in the local neighborhood of that object.

        If this yields no candidates (for example, when there are no objects yet),
        we fall back to the original global candidate builder so that start
        activities that only create objects can still fire.
        """

        candidates: list[Candidate] = []

        # Use a simple key to avoid duplicate candidates that happen to be
        # discovered from multiple scope objects.
        seen_keys: set[tuple] = set()

        anchor_types = set(self.config.anchor_object_types)

        # Iterate over active objects only.
        for scope_object_id, runtime_object in state.objects.items():
            if not runtime_object.active:
                continue

            for activity in self.static_model.activities:
                is_start_activity = (
                    activity.name in self.config.start_policy.start_activity_names
                )

                candidate = build_candidate_for_object_and_activity(
                    state=state,
                    scope_object_id=scope_object_id,
                    activity=activity,
                    anchor_object_types=anchor_types,
                    is_start_activity=is_start_activity,
                )

                if candidate is None:
                    continue

                if self._is_start_activity_blocked(candidate, state):
                    continue

                # Semantic validation (constraints + O2O) is delegated to
                # candidategeneration so that the resulting pool already
                # consists of feasible candidates.
                if not is_candidate_semantically_allowed(self.static_model, candidate, state):
                    continue

                key = (
                    candidate.activity_name,
                    tuple(sorted(candidate.participating_object_ids)),
                    tuple(sorted(candidate.object_types_to_create)),
                )

                if key in seen_keys:
                    continue

                seen_keys.add(key)
                candidates.append(candidate)

        # Fallback: if nothing was found in object-centric mode (e.g., early in the
        # simulation when no objects exist yet), try the global builder so that
        # start activities that only create objects can still fire.
        if not candidates:
            for activity in self.static_model.activities:
                candidate = build_candidate_for_activity(activity, state)

                if candidate is None:
                    continue

                if self._is_start_activity_blocked(candidate, state):
                    continue

                if not is_candidate_semantically_allowed(self.static_model, candidate, state):
                    continue

                candidates.append(candidate)

        return candidates

    def _count_started_cases(self, state: SimulationState) -> int:
        return state._start_event_count

    def _is_start_activity_blocked(self, candidate: Candidate, state: SimulationState) -> bool:
        start_names = set(self.config.start_policy.start_activity_names)

        if candidate.activity_name not in start_names:
            return False

        max_starts = self.config.start_policy.max_case_starts
        if max_starts is None:
            return False

        return self._count_started_cases(state) >= max_starts

    def _build_candidate_for_activity(
        self,
        activity: Activity,
        state: SimulationState,
    ) -> Optional[Candidate]:
        # Deprecated local implementation moved to `candidategeneration.py`.
        # Keep this wrapper for backward compatibility by delegating.
        return build_candidate_for_activity(activity, state)

    def _find_active_objects_of_type(
        self,
        state: SimulationState,
        object_type: str,
    ) -> list[str]:
        # Delegated to candidategeneration.find_active_objects_of_type
        return find_active_objects_of_type(state, object_type)

    def _check_not_coexistence(self, constraint, candidate: Candidate, state: SimulationState) -> bool:
        # Deprecated local method: semantics moved to Engine/semantics.py
        # Keep as thin wrapper for backward compatibility.

        if candidate.activity_name == constraint.source_activity:
            forbidden_other_activity = constraint.target_activity
        elif candidate.activity_name == constraint.target_activity:
            forbidden_other_activity = constraint.source_activity
        else:
            return True

        if constraint.scope.kind == "each":
            scope_object_ids = self._get_candidate_scope_object_ids(
                candidate=candidate,
                state=state,
                scope_object_type=constraint.scope.object_type,
            )

            if not scope_object_ids:
                return True

            for scope_object_id in scope_object_ids:
                if state._events_by_act_obj.get((forbidden_other_activity, scope_object_id)):
                    return False

            return True

        return not bool(state._events_by_activity.get(forbidden_other_activity))

    def _select_candidate(
        self,
        candidates: list[Candidate],
        state: SimulationState,
    ) -> Candidate:
        # Delegate to selection policy module. Allows swapping strategies.
        return self.select_func(candidates, state, self.static_model, self.config, rng=self.rng)

    def _apply_candidate(self, candidate: Candidate, state: SimulationState) -> None:
        created_object_ids: list[str] = []

        attribute_defaults = getattr(self.static_model, "attribute_defaults", {}) or {}
        resource_types: set[str] = self._resource_types_set

        for object_type in candidate.object_types_to_create:
            # Resource types are never created by activities — they live in the
            # pre-populated pool only. Skip silently.
            if object_type in resource_types:
                continue
            defaults = attribute_defaults.get(object_type, {})
            obj = state.add_object(object_type=object_type, attributes=defaults)
            created_object_ids.append(obj.object_id)

        # Delegate automatic link creation to the centralized link policy.
        apply_conservative_link_policy(self.static_model, candidate.participating_object_ids, created_object_ids, state)

        participating_ids = candidate.participating_object_ids + created_object_ids

        pre_fire_ts = state.last_generated_timestamp
        event_timestamp = self.time_policy.next_timestamp(state, candidate, self.config, rng=self.rng)

        # Record service time: the sampled clock advance for this firing.
        if event_timestamp is not None and pre_fire_ts is not None:
            svc = (event_timestamp - pre_fire_ts).total_seconds()
            if svc >= 0:
                state.activity_service_s.setdefault(candidate.activity_name, []).append(svc)

        executed_event = state.record_event(
            activity_name=candidate.activity_name,
            participating_object_ids=participating_ids,
            timestamp=event_timestamp,
        )
        state.last_generated_timestamp = event_timestamp

        activity = self._get_activity_by_name(candidate.activity_name)
        if activity is None:
            return

        resource_types: set[str] = self._resource_types_set

        deactivated_types = {
            binding.object_type
            for binding in activity.bindings
            if getattr(binding, "deactivates", False)
            # Resource types are never deactivated — they are permanently
            # available shared resources regardless of the lifecycle flags.
            and binding.object_type not in resource_types
        }

        for object_id in participating_ids:
            runtime_object = state.objects.get(object_id)

            if runtime_object is None:
                continue

            if runtime_object.object_type in deactivated_types:
                state.deactivate_object(object_id)

        # Apply attribute updates from binding specs
        for binding in activity.bindings:
            updates = getattr(binding, 'attribute_updates', ()) or ()
            if not updates:
                continue
            for object_id in participating_ids:
                obj = state.objects.get(object_id)
                if obj and obj.object_type == binding.object_type:
                    for upd in updates:
                        _apply_attribute_update(obj, upd)

        if executed_event is None and state.executed_events:
            executed_event = state.executed_events[-1]

        if executed_event is not None:
            self._update_obligations_after_event(executed_event, state)

    def _update_obligations_after_event(self, executed_event, state: SimulationState) -> None:
        self._fulfill_response_obligations(executed_event, state)
        self._create_response_obligations(executed_event, state)
        self._promote_obligations(executed_event, state)

    def _update_eligibility(self, executed_event, state: SimulationState) -> None:
        """Incrementally update _eligible_for_activity after an event fires.

        When activity A fires on objects O1..On:
        - Activities unlocked by precedence(A → B): add relevant objects to B's eligible set
        - Activities blocked by not_coexistence(A, B) or not_succession(A, B): remove objects
        - nmax cap: if target hit nmax, remove from eligible
        Uses conservative approach — only handles 'each'-scoped constraints.
        Falls back gracefully: _eligible_for_activity is optional; if absent, normal loop runs.
        """
        act = executed_event.activity_name
        resource_types = self._resource_types_set
        eligible = state._eligible_for_activity

        for con in self.static_model.constraints_for_activity(act):
            if con.scope.kind != 'each':
                continue
            scope_type = getattr(con.scope, 'object_type', None)
            if not scope_type or scope_type in resource_types:
                continue
            ctype = con.constraint_type

            # A fired as source of precedence(A → B): objects of scope_type in this event
            # may now satisfy B's nmin — add them to B's eligible set
            if ctype == 'precedence' and con.source_activity == act:
                tgt = con.target_activity
                nmin = getattr(con, 'nmin', 0)
                nmax = getattr(con, 'nmax', None)
                # Only update eligibility for activities already tracked (start activities)
                if tgt not in eligible:
                    continue  # don't create new sets for non-tracked activities
                for oid in executed_event.object_ids:
                    obj = state.objects.get(oid)
                    if obj and obj.object_type == scope_type and obj.active:
                        src_count = len(state._events_by_act_obj.get((act, oid), []))
                        if src_count >= nmin:
                            eligible[tgt].add(oid)
                        # If nmax exceeded (source count), remove target eligibility
                        if nmax is not None and src_count > nmax:
                            eligible[tgt].discard(oid)

            # A fired as target of precedence(X → A): A itself may now be eligible
            # (handled by prec_satisfied cache — no action needed here)

            # not_coexistence or not_succession: remove from source's eligible set
            elif ctype in ('not_coexistence', 'not_succession'):
                other = con.target_activity if con.source_activity == act else con.source_activity
                if other in eligible:
                    for oid in executed_event.object_ids:
                        obj = state.objects.get(oid)
                        if obj and obj.object_type == scope_type:
                            eligible[other].discard(oid)

            # response nmax: if A is the target and has now hit nmax, remove from eligible
            elif ctype == 'response' and con.target_activity == act:
                nmax = getattr(con, 'nmax', None)
                if nmax is not None and act in eligible:
                    for oid in executed_event.object_ids:
                        obj = state.objects.get(oid)
                        if obj and obj.object_type == scope_type:
                            t_count = len(state._events_by_act_obj.get((act, oid), []))
                            if t_count >= nmax:
                                eligible[act].discard(oid)
        self._fulfill_response_obligations(executed_event, state)
        self._create_response_obligations(executed_event, state)
        self._promote_obligations(executed_event, state)

    def _is_obligation_ready(self, target_act: str, scope_oid: str, state: SimulationState) -> bool:
        """Check if all precedence prerequisites for target_act have fired for scope_oid."""
        prereqs = self._obligation_prerequisites.get(target_act)
        if not prereqs:
            return True
        scope_type = state._type_of_object.get(scope_oid)
        for req_source in prereqs.get(scope_type, []):
            if not state._events_by_act_obj.get((req_source, scope_oid)):
                return False
        return True

    def _promote_obligations(self, executed_event, state: SimulationState) -> None:
        """After event fires, promote blocked obligations whose blocking prerequisite just fired."""
        act = executed_event.activity_name
        for scope_oid in executed_event.object_ids:
            key = (act, scope_oid)
            to_promote = state._obligations_blocked.pop(key, None)
            if not to_promote:
                continue
            for (tgt, oblg_oid) in to_promote:
                # Only promote if obligation still exists in the authoritative count
                if (tgt, oblg_oid) not in state._obligations_count:
                    continue
                if self._is_obligation_ready(tgt, oblg_oid, state):
                    state._obligations_ready[(tgt, oblg_oid)] = 1
                else:
                    # Still blocked by another prerequisite — re-register under next blocker
                    prereqs = self._obligation_prerequisites.get(tgt, {})
                    oblg_scope_type = state._type_of_object.get(oblg_oid)
                    for req_source in prereqs.get(oblg_scope_type, []):
                        if not state._events_by_act_obj.get((req_source, oblg_oid)):
                            state._obligations_blocked.setdefault(
                                (req_source, oblg_oid), set()).add((tgt, oblg_oid))
                            break

    def _fulfill_response_obligations(self, executed_event, state: SimulationState) -> None:
        act = executed_event.activity_name
        fired_oids = set(executed_event.object_ids)

        def _record_fulfillment(key):
            c_key = state._obligation_to_constraint.pop(key, None)
            if c_key is not None:
                stats = state._constraint_obligation_stats.setdefault(
                    c_key, {"fulfilled": 0, "cancelled": 0, "violated": 0}
                )
                stats["fulfilled"] += 1
            state.total_obligations_fulfilled += 1

        # Discharge unscoped obligations for this target activity
        if state._obligations_count.pop((act, None), None) is not None:
            state._obligations_ready.pop((act, None), None)
            _record_fulfillment((act, None))
        # Discharge per-object obligations (each/any mode)
        for oid in executed_event.object_ids:
            if state._obligations_count.pop((act, oid), None) is not None:
                state._obligations_ready.pop((act, oid), None)
                _record_fulfillment((act, oid))
        # Discharge all-mode frozenset obligations
        all_keys = [k for k in list(state._obligations_count) if k[0] == act and isinstance(k[1], frozenset)]
        for k in all_keys:
            if k[1].issubset(fired_oids):
                state._obligations_count.pop(k, None)
                state._obligations_ready.pop(k, None)
                _record_fulfillment(k)

    def _create_response_obligations(self, executed_event, state: SimulationState) -> None:
        for constraint in self._response_by_source.get(executed_event.activity_name, []):
            # Constraint identity tuple used for per-constraint stats (E3/S8)
            c_key = (
                constraint.constraint_type,
                constraint.source_activity,
                constraint.target_activity,
                getattr(constraint.scope, 'kind', 'each'),
            )
            if constraint.scope.kind == "each":
                scope_object_ids = self._get_event_scope_object_ids(
                    executed_event=executed_event, state=state,
                    scope_object_type=constraint.scope.object_type,
                )
                for scope_object_id in scope_object_ids:
                    key = (constraint.target_activity, scope_object_id)
                    if key not in state._obligations_count:
                        state._obligations_count[key] = 1
                        state._obligation_to_constraint[key] = c_key
                        # Route to ready or blocked pool
                        if self._is_obligation_ready(constraint.target_activity, scope_object_id, state):
                            state._obligations_ready[key] = 1
                        else:
                            prereqs = self._obligation_prerequisites.get(constraint.target_activity, {})
                            scope_type = state._type_of_object.get(scope_object_id)
                            for req_source in prereqs.get(scope_type, []):
                                if not state._events_by_act_obj.get((req_source, scope_object_id)):
                                    state._obligations_blocked.setdefault(
                                        (req_source, scope_object_id), set()).add(key)
                                    break
            elif constraint.scope.kind == "any":
                scope_object_ids = self._get_event_scope_object_ids(
                    executed_event=executed_event, state=state,
                    scope_object_type=constraint.scope.object_type,
                )
                for scope_object_id in scope_object_ids:
                    key = (constraint.target_activity, scope_object_id)
                    if key not in state._obligations_count:
                        state._obligations_count[key] = 1
                        state._obligation_to_constraint[key] = c_key
                        if self._is_obligation_ready(constraint.target_activity, scope_object_id, state):
                            state._obligations_ready[key] = 1
                        else:
                            prereqs = self._obligation_prerequisites.get(constraint.target_activity, {})
                            scope_type = state._type_of_object.get(scope_object_id)
                            for req_source in prereqs.get(scope_type, []):
                                if not state._events_by_act_obj.get((req_source, scope_object_id)):
                                    state._obligations_blocked.setdefault(
                                        (req_source, scope_object_id), set()).add(key)
                                    break
            elif constraint.scope.kind == "all":
                scope_object_ids = self._get_event_scope_object_ids(
                    executed_event=executed_event, state=state,
                    scope_object_type=constraint.scope.object_type,
                )
                if scope_object_ids:
                    key = (constraint.target_activity, frozenset(scope_object_ids))
                    if key not in state._obligations_count:
                        state._obligations_count[key] = 1
                        state._obligation_to_constraint[key] = c_key
                        state._obligations_ready[key] = 1  # all-mode: always ready (frozenset handles sync)
            else:
                key = (constraint.target_activity, None)
                if key not in state._obligations_count:
                    state._obligations_count[key] = 1
                    state._obligation_to_constraint[key] = c_key
                    state._obligations_ready[key] = 1  # unscoped: always ready

    def _get_event_scope_object_ids(
        self,
        executed_event,
        state: SimulationState,
        scope_object_type: str,
    ) -> list[str]:
        scope_ids: list[str] = []

        for object_id in executed_event.object_ids:
            runtime_object = state.objects.get(object_id)

            if runtime_object is None:
                continue

            if runtime_object.object_type == scope_object_type:
                scope_ids.append(object_id)

        return scope_ids

        return scope_ids

    def _get_activity_by_name(self, activity_name: str) -> Optional[Activity]:
        # #1: O(1) dict lookup using cached _act_by_name built in __init__
        return self._act_by_name.get(activity_name)

    def _get_candidate_scope_object_ids(
        self,
        candidate: Candidate,
        state: SimulationState,
        scope_object_type: str,
    ) -> list[str]:
        scope_ids: list[str] = []

        for object_id in candidate.participating_object_ids:
            runtime_object = state.objects.get(object_id)

            if runtime_object is None:
                continue

            if runtime_object.object_type == scope_object_type:
                scope_ids.append(object_id)

        return scope_ids

    # ── DES (Discrete Event Simulation) methods ───────────────────────────────

    def _des_resources_available(self, candidate: Candidate, state: SimulationState) -> tuple[bool, list[str]]:
        """Check if all resource objects required by this candidate are free.
        Returns (available, held_resource_ids).
        held_resource_ids are the specific resource object IDs that will be locked.
        """
        resource_types = state._resource_types
        held: list[str] = []
        current_time = state.current_time

        for oid in candidate.participating_object_ids:
            obj = state.objects.get(oid)
            if obj is None:
                continue
            if obj.object_type not in resource_types:
                continue
            # Resource object — check if busy
            if obj.busy_until is not None and current_time is not None and obj.busy_until > current_time:
                return False, []
            held.append(oid)

        return True, held

    def _des_lock_resources(self, held_resource_ids: list[str], activity_name: str,
                             complete_at, state: SimulationState) -> None:
        """Mark resource objects as busy until complete_at."""
        for oid in held_resource_ids:
            obj = state.objects.get(oid)
            if obj:
                obj.busy_until = complete_at
                obj.busy_by = activity_name

    def _des_release_resources(self, held_resource_ids: list[str], state: SimulationState) -> None:
        """Release resource objects after activity completes."""
        for oid in held_resource_ids:
            obj = state.objects.get(oid)
            if obj:
                obj.busy_until = None
                obj.busy_by = None

    def _des_start_activity(self, candidate: Candidate, state: SimulationState,
                             held_resource_ids: list[str]) -> InProgressActivity:
        """Create objects-to-create, apply links, lock resources, push to heap."""
        created_object_ids: list[str] = []
        attribute_defaults = getattr(self.static_model, "attribute_defaults", {}) or {}
        resource_types: set[str] = self._resource_types_set

        for object_type in candidate.object_types_to_create:
            # Resource types come from the pre-populated pool only — never created mid-sim.
            if object_type in resource_types:
                continue
            defaults = attribute_defaults.get(object_type, {})
            obj = state.add_object(object_type=object_type, attributes=defaults)
            created_object_ids.append(obj.object_id)
            # Phase 3: add newly created object to eligibility for start activities only.
            # Non-start activities are updated via _update_eligibility when prerequisites fire.
            for act_name in self._start_names_set:
                elig_set = state._eligible_for_activity.get(act_name)
                if elig_set is None:
                    continue
                act_def_sa = self._act_by_name.get(act_name)
                if act_def_sa:
                    primary_sa = next((b for b in act_def_sa.bindings
                                       if not b.creates and b.object_type not in self._resource_types_set), None)
                    if primary_sa and primary_sa.object_type == object_type:
                        elig_set.add(obj.object_id)

        apply_conservative_link_policy(
            self.static_model,
            candidate.participating_object_ids,
            created_object_ids,
            state,
        )

        started_at = state.current_time
        # In DES mode the base for sampling must be current_time (when the activity
        # actually starts), not last_generated_timestamp.
        saved_ts = state.last_generated_timestamp
        state.last_generated_timestamp = state.current_time
        complete_at = self.time_policy.next_timestamp(state, candidate, self.config, rng=self.rng)
        # Restore: don't let this activity's complete_at become the base for the
        # next concurrently started activity. In DES mode all activities in the same
        # step start from current_time, not from each other's completion times.
        state.last_generated_timestamp = saved_ts

        # Record pure service time (sampled work duration only)
        if started_at is not None and complete_at is not None:
            svc = (complete_at - started_at).total_seconds()
            if svc >= 0:
                state.activity_service_s.setdefault(candidate.activity_name, []).append(svc)

        # Process waiting time from discovery (waiting_mean) is a descriptive metric
        # from the real log — it is NOT added to complete_at. Waiting in the simulation
        # emerges naturally from resource contention (resource_wait_s) and pool wait
        # (candidate_wait_s). Adding sampled waiting to the clock would inflate
        # simulation time artificially and has been removed.

        # Do NOT update last_generated_timestamp here in DES mode —
        # concurrent activities all start from current_time, not from
        # each other's completion times.

        self._des_lock_resources(held_resource_ids, candidate.activity_name, complete_at, state)

        in_prog = InProgressActivity(
            candidate_activity_name=candidate.activity_name,
            participating_object_ids=candidate.participating_object_ids + created_object_ids,
            object_types_to_create=candidate.object_types_to_create,
            started_at=started_at,
            complete_at=complete_at,
            held_resource_ids=held_resource_ids,
            created_object_ids=created_object_ids,
        )
        heapq.heappush(state.in_progress, in_prog)
        # Maintain _in_progress_objects index
        for oid in in_prog.participating_object_ids:
            state._in_progress_objects.add((in_prog.candidate_activity_name, oid))

        if self.trace_func is not None:
            self._trace("des_started", {
                "activity_name": candidate.activity_name,
                "started_at": started_at.isoformat() if started_at else None,
                "complete_at": complete_at.isoformat() if complete_at else None,
                "participating_object_ids": in_prog.participating_object_ids,
                "held_resource_ids": held_resource_ids,
            })

        return in_prog

    def _des_complete_activity(self, in_prog: InProgressActivity, state: SimulationState) -> None:
        """Write the ExecutedEvent, update indexes, release resources."""
        # Sample parallelism before releasing (counts this activity + any still running)
        state.parallelism_samples.append(len(state.in_progress) + 1)
        self._des_release_resources(in_prog.held_resource_ids, state)
        # Remove from _in_progress_objects index
        for oid in in_prog.participating_object_ids:
            state._in_progress_objects.discard((in_prog.candidate_activity_name, oid))

        activity = self._get_activity_by_name(in_prog.candidate_activity_name)
        resource_types = state._resource_types

        if activity:
            deactivated_types = {
                binding.object_type
                for binding in activity.bindings
                if getattr(binding, "deactivates", False)
                and binding.object_type not in resource_types
            }
            for oid in in_prog.participating_object_ids:
                obj = state.objects.get(oid)
                if obj and obj.object_type in deactivated_types:
                    state.deactivate_object(oid)

            # Apply attribute updates (DES: fires on completion, not on start)
            for binding in activity.bindings:
                updates = getattr(binding, 'attribute_updates', ()) or ()
                if not updates:
                    continue
                for oid in in_prog.participating_object_ids:
                    obj = state.objects.get(oid)
                    if obj and obj.object_type == binding.object_type:
                        for upd in updates:
                            _apply_attribute_update(obj, upd)

        executed_event = state.record_event(
            activity_name=in_prog.candidate_activity_name,
            participating_object_ids=in_prog.participating_object_ids,
            timestamp=in_prog.complete_at,
        )
        state.current_time = in_prog.complete_at

        # Track service time broken down by object type — enables per-(activity, type) metrics
        if in_prog.started_at and in_prog.complete_at:
            svc = (in_prog.complete_at - in_prog.started_at).total_seconds()
            if svc >= 0:
                _seen_types: set = set()
                for _oid in in_prog.participating_object_ids:
                    _obj = state.objects.get(_oid)
                    if _obj and _obj.object_type not in self._resource_types_set:
                        _key = (in_prog.candidate_activity_name, _obj.object_type)
                        if _key not in _seen_types:
                            _seen_types.add(_key)
                            state.activity_service_by_type_s.setdefault(_key, []).append(svc)
        state.last_generated_timestamp = in_prog.complete_at

        self._update_obligations_after_event(executed_event, state)
        self._update_eligibility(executed_event, state)

        # Populate precedence satisfied cache on firing: for every precedence
        # with this activity as target, mark it satisfied for each participating
        # object so future candidate checks skip the constraint for these objects.
        prec_satisfied = getattr(state, '_prec_satisfied', None)
        if prec_satisfied is not None:
            fired_act = in_prog.candidate_activity_name
            resource_types = self._resource_types_set
            for con in self._prec_by_target.get(fired_act, []):
                if con.scope.kind != 'each':
                    continue
                nmax = getattr(con, 'nmax', None)
                if nmax is not None:
                    continue  # nmax constraints can be re-violated; don't cache
                source = con.source_activity
                nmin = getattr(con, 'nmin', 0)
                cache_key_base = (source, fired_act, 'each')
                for oid in in_prog.participating_object_ids:
                    obj = state.objects.get(oid)
                    if obj is None or obj.object_type in resource_types:
                        continue
                    if obj.object_type != con.scope.object_type:
                        continue
                    if _count_activity_for_object(state, source, oid) >= max(nmin, 1):
                        prec_satisfied.add(cache_key_base + (oid,))

        if self.trace_func is not None:
            self._trace("applied", {
                "event_id": executed_event.event_id,
                "activity_name": executed_event.activity_name,
                "timestamp": executed_event.timestamp.isoformat() if executed_event.timestamp else None,
                "started_at": in_prog.started_at.isoformat() if in_prog.started_at else None,
                "duration_s": (in_prog.complete_at - in_prog.started_at).total_seconds()
                              if in_prog.started_at and in_prog.complete_at else None,
                "object_ids": list(executed_event.object_ids),
                "step_count": state.step_count,
                "concurrent": [
                    {
                        "activity": ip.candidate_activity_name,
                        "objects": list(ip.participating_object_ids),
                        "started_at": ip.started_at.isoformat() if ip.started_at else None,
                        "complete_at": ip.complete_at.isoformat() if ip.complete_at else None,
                    }
                    for ip in state.in_progress
                ],
            })

    def _des_try_start_waiting(self, state: SimulationState,
                               completed_activity: str | None = None) -> None:
        """After a resource is released, try to start any waiting candidates.

        #9: Skip full semantic re-check for candidates whose activity is not
        named in any constraint involving completed_activity. The only constraints
        that could have changed state are those with completed_activity as source
        or target — everything else is unaffected.
        """
        if not state.waiting_queue:
            return

        # Build set of activities that COULD be affected by the completed activity
        # Use _constraints_by_activity index (O(1)) instead of scanning all constraints (O(C))
        if completed_activity is not None:
            affected: set[str] | None = set()
            for con in self.static_model.constraints_for_activity(completed_activity):
                if con.source_activity:
                    affected.add(con.source_activity)
                if con.target_activity:
                    affected.add(con.target_activity)
            affected.add(completed_activity)
        else:
            affected = None  # unknown — re-check everything

        still_waiting: list[WaitingCandidate] = []
        for wc in state.waiting_queue:
            cand = Candidate(
                activity_name=wc.candidate_activity_name,
                participating_object_ids=wc.participating_object_ids,
                object_types_to_create=wc.object_types_to_create,
            )
            # #9: only re-run semantic check if this candidate's activity could
            # have been affected by the just-completed activity.
            if affected is None or wc.candidate_activity_name in affected:
                if not is_candidate_semantically_allowed(self.static_model, cand, state):
                    continue
            available, held = self._des_resources_available(cand, state)
            if available:
                if state.current_time is not None and wc.arrived_at is not None:
                    wait = (state.current_time - wc.arrived_at).total_seconds()
                    if wait >= 0:
                        state.resource_wait_s.setdefault(wc.candidate_activity_name, []).append(wait)
                self._des_start_activity(cand, state, held)
            else:
                still_waiting.append(wc)
        state.waiting_queue = still_waiting

    def run_des(self, state: Optional[SimulationState] = None) -> SimulationState:
        """DES simulation loop. Activated when resource types are configured.

        Activities start immediately when inputs and resources are available.
        Multiple activities can be in-flight simultaneously. Clock advances to
        the next completion. Resource objects are locked for the duration and
        released on completion, allowing waiting activities to start.
        """
        if state is None:
            state = SimulationState()

        state._start_activity_names = self._start_names_set
        state._resource_types = set(getattr(self.static_model, 'resource_types', []) or [])
        state.current_time = self.config.start_timestamp
        state.last_generated_timestamp = self.config.start_timestamp

        from src.Simulation.Domain.state import RuntimeObject
        pool_sizes = getattr(self.static_model, 'resource_pool_sizes', {}) or {}
        for res_type in state._resource_types:
            n = pool_sizes.get(res_type, 1)
            for _ in range(n):
                oid = state.new_object_id(res_type)
                obj = RuntimeObject(object_id=oid, object_type=res_type, active=True)
                state.objects[oid] = obj
                state._active_by_type.setdefault(res_type, set()).add(oid)
                state._type_of_object[oid] = res_type

        start_activity_names = self._start_names_set

        # Phase 3: pre-populate eligibility for start activities (no prerequisites)
        resource_types_set = state._resource_types
        for activity in self.static_model.activities:
            if activity.name not in start_activity_names:
                continue
            primary_bindings = [
                b for b in activity.bindings
                if not b.creates and b.object_type not in resource_types_set
            ]
            if primary_bindings:
                primary_type = primary_bindings[0].object_type
                state._eligible_for_activity[activity.name] = set(
                    state._active_by_type.get(primary_type, set())
                )

        while True:
            # Early stop requested by the frontend (Stop button)
            if self.stop_event is not None and self.stop_event.is_set():
                self._trace("stop", {"reason": "user_stopped", "step_count": state.step_count})
                break

            # All stop conditions: time (primary), traces (primary), events/steps (safety cap)
            if self._should_stop(state):
                self._trace("stop", {"reason": "stop_condition_met", "step_count": state.step_count})
                break

            # ── Complete all activities due at or before current_time ──────────
            while state.in_progress and state.in_progress[0].complete_at <= state.current_time:
                finishing = heapq.heappop(state.in_progress)
                self._des_complete_activity(finishing, state)
                self._des_try_start_waiting(state, finishing.candidate_activity_name)
                if self._should_stop(state):
                    break

            if self._should_stop(state):
                self._trace("stop", {"reason": "stop_condition_met", "step_count": state.step_count})
                break

            # ── Generate candidates at current_time ───────────────────────────
            candidates = self._generate_candidates_des(state)

            if self.trace_func is not None:
                self._trace("iteration", {
                    "step_count": state.step_count,
                    "num_candidates": len(candidates),
                    "candidate_activity_names": [c.activity_name for c in candidates],
                    "candidates": [
                        {
                            "activity_name": c.activity_name,
                            "participating_object_ids": list(c.participating_object_ids),
                            "object_types_to_create": list(c.object_types_to_create),
                        }
                        for c in candidates
                    ],
                    "in_progress_count": len(state.in_progress),
                    "waiting_count": len(state.waiting_queue),
                    # Active objects per type (counts only, for size tracking)
                    "active_objects": {
                        ot: len(ids)
                        for ot, ids in state._active_by_type.items()
                        if ids
                    },
                    # Obligation summary: target_activity -> number of scope objects with pending obligations
                    "obligations": (lambda obl: {
                        act: sum(1 for (a, _) in obl if a == act)
                        for act in {a for (a, _) in obl}
                    })(list(state._obligations_count.keys())) if state._obligations_count else {},
                    # Distinct obligated activities (targets with at least one pending)
                    "obligated_activities": list({t for (t, _) in state._obligations_count}),
                    # Total pending obligations count
                    "total_obligations": len(state._obligations_count),
                    # Simulated clock time
                    "sim_time": state.current_time.isoformat() if state.current_time else None,
                    # Per-step delta counters
                    "deactivations_this_step":         state.total_deactivations - self._last_deactivations,
                    "obligations_fulfilled_this_step":  state.total_obligations_fulfilled - self._last_obligations_fulfilled,
                    "total_deactivations":             state.total_deactivations,
                    "total_obligations_fulfilled":     state.total_obligations_fulfilled,
                    "total_obligations_cancelled":     state.total_obligations_cancelled,
                })

            # ── Try to start each feasible candidate (greedy, probabilistic order)
            is_simulation_start = len(state.executed_events) == 0 and not state.in_progress

            # Order by transition probability so highest-probability activity starts first
            # Update delta baseline after tracing so next step's deltas are correct
            self._last_deactivations = state.total_deactivations
            self._last_obligations_fulfilled = state.total_obligations_fulfilled
            ordered = list(candidates)
            if len(ordered) > 1:
                try:
                    top = self._select_candidate(ordered, state)
                    ordered = [top] + [c for c in ordered if c is not top]
                except Exception:
                    pass

            for cand in ordered:
                if is_simulation_start and cand.activity_name not in start_activity_names:
                    continue
                if self._is_start_activity_blocked(cand, state):
                    continue

                available, held = self._des_resources_available(cand, state)
                if available:
                    self._des_start_activity(cand, state, held)
                else:
                    key = (cand.activity_name, tuple(sorted(cand.participating_object_ids)))
                    already_waiting = any(
                        (wc.candidate_activity_name, tuple(sorted(wc.participating_object_ids))) == key
                        for wc in state.waiting_queue
                    )
                    if not already_waiting:
                        blocked_type = ""
                        for oid in cand.participating_object_ids:
                            obj = state.objects.get(oid)
                            if obj and obj.object_type in state._resource_types:
                                if obj.busy_until and obj.busy_until > state.current_time:
                                    blocked_type = obj.object_type
                                    break
                        state.waiting_queue.append(WaitingCandidate(
                            candidate_activity_name=cand.activity_name,
                            participating_object_ids=cand.participating_object_ids,
                            object_types_to_create=cand.object_types_to_create,
                            arrived_at=state.current_time,
                            blocked_resource_type=blocked_type,
                        ))

            # ── Advance clock to next completion ──────────────────────────────
            if not state.in_progress:
                self._trace("stop", {"reason": "no_candidates", "step_count": state.step_count})
                break

            state.current_time = state.in_progress[0].complete_at

        self._trace("stop", {"reason": "stop_condition_met", "step_count": state.step_count,
                              "max_events": self.config.max_steps})
        return state