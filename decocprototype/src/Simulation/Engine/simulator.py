from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from src.Simulation.Domain.ir import StaticModel, Activity
from src.Simulation.Domain.state import SimulationState, PendingObligation
from src.Simulation.Domain.config import SimulationConfig
from src.Simulation.Engine.selection import select_candidate as default_select_candidate
from src.Simulation.Engine.candidategeneration import (
    Candidate,
    build_candidate_for_activity,
    find_active_objects_of_type,
    build_candidate_for_object_and_activity,
    is_candidate_semantically_allowed,
)
 

def apply_conservative_link_policy(static_model, participating_ids, created_object_ids, state):
    """Create ALL applicable O2O links after an activity fires.

    Previous version stopped after the first matching rule per created object,
    leaving many required links unwritten.  This version iterates every
    (created, participating) pair and every applicable O2O rule, creating every
    link that is structurally required and does not already exist.

    Additionally, participating objects are linked to each other when an O2O
    rule applies between their types — ensuring that co-participants in the
    same event are connected in the link graph even if neither was newly
    created.  This is the foundation for link-preference object selection in
    subsequent steps.
    """

    def _link_exists(src: str, tgt: str) -> bool:
        neighbors = state._links_by_object.get(src)
        return neighbors is not None and tgt in neighbors

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
                    if not _link_exists(pid, created_id):
                        state.add_link(source_object_id=pid, target_object_id=created_id)
                elif rule.source_type == created_type and rule.target_type == p_type:
                    if not _link_exists(created_id, pid):
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
                    if not _link_exists(pid1, pid2):
                        state.add_link(source_object_id=pid1, target_object_id=pid2)
                elif rule.source_type == p2_obj.object_type and rule.target_type == p1_obj.object_type:
                    if not _link_exists(pid2, pid1):
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

    def _trace(self, event: str, payload: dict) -> None:
        if self.trace_func is None:
            return
        try:
            self.trace_func(event, payload)
        except Exception:
            # Tracing should never break the simulation.
            return
    def run(self, state: Optional[SimulationState] = None) -> SimulationState:
        if state is None:
            state = SimulationState()

        # Seed the start-event counter index so _start_event_count is maintained
        # correctly by record_event throughout the run.
        state._start_activity_names = set(self.config.start_policy.start_activity_names)
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
                        "active_objects": [
                            {
                                "id": oid,
                                "type": obj.object_type,
                                "active": obj.active,
                            }
                            for oid, obj in state.objects.items()
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
        return state.step_count >= self.config.max_steps
        # later add: no more candidates, all obligations fulfilled, end state reached, etc.

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
        resource_types: set[str] = set(getattr(self.static_model, "resource_types", []) or [])

        # At simulation start (no events executed), only allow start activities
        is_simulation_start = len(state.executed_events) == 0
        start_activity_names = set(self.config.start_policy.start_activity_names)

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

            # Max-consecutive enforcement: skip if activity has been the last
            # N events in a row and N >= the configured cap.
            max_consec: dict = getattr(self.static_model, "max_consecutive", {}) or {}
            if candidate.activity_name in max_consec:
                cap = max_consec[candidate.activity_name]
                streak = 0
                for ev in reversed(state.executed_events):
                    if ev.activity_name == candidate.activity_name:
                        streak += 1
                    else:
                        break
                if streak >= cap:
                    continue

            # Per-object max-consecutive: skip if the same activity has fired
            # N times in a row on any of the candidate's participating objects.
            # A "run" ends when any other activity touches that object.
            max_consec_obj: dict = getattr(self.static_model, "max_consecutive_per_object", {}) or {}
            if candidate.activity_name in max_consec_obj:
                cap_obj = max_consec_obj[candidate.activity_name]
                blocked_by_obj = False
                for oid in candidate.participating_object_ids:
                    streak_obj = 0
                    for ev in reversed(state._events_by_object.get(oid, [])):
                        if ev.activity_name == candidate.activity_name:
                            streak_obj += 1
                        else:
                            break
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

        for object_type in candidate.object_types_to_create:
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

        resource_types: set[str] = set(getattr(self.static_model, "resource_types", []) or [])

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

        if executed_event is None and state.executed_events:
            executed_event = state.executed_events[-1]

        if executed_event is not None:
            self._update_obligations_after_event(executed_event, state)

    def _update_obligations_after_event(self, executed_event, state: SimulationState) -> None:
        self._fulfill_response_obligations(executed_event, state)
        self._create_response_obligations(executed_event, state)

    def _fulfill_response_obligations(self, executed_event, state: SimulationState) -> None:
        act = executed_event.activity_name
        # Discharge unscoped obligations for this target activity
        state._obligations_count.pop((act, None), None)
        # Discharge scoped obligations for each scope object in this event
        for oid in executed_event.object_ids:
            state._obligations_count.pop((act, oid), None)

    def _create_response_obligations(self, executed_event, state: SimulationState) -> None:
        for constraint in self.static_model.constraints:
            if constraint.constraint_type != "response":
                continue
            if executed_event.activity_name != constraint.source_activity:
                continue

            if constraint.scope.kind == "each":
                scope_object_ids = self._get_event_scope_object_ids(
                    executed_event=executed_event,
                    state=state,
                    scope_object_type=constraint.scope.object_type,
                )
                for scope_object_id in scope_object_ids:
                    key = (constraint.target_activity, scope_object_id)
                    state._obligations_count[key] = state._obligations_count.get(key, 0) + 1
            else:
                key = (constraint.target_activity, None)
                state._obligations_count[key] = state._obligations_count.get(key, 0) + 1

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

    def _get_activity_by_name(self, activity_name: str) -> Optional[Activity]:
        for activity in self.static_model.activities:
            if activity.name == activity_name:
                return activity
        return None

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