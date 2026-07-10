from __future__ import annotations

from typing import Any, Optional

from src.Simulation.Domain.ir import StaticModel
from src.Simulation.Domain.state import SimulationState
from src.Simulation.Domain.ir import O2ORule


# ---------------------------------------------------------------------------
# Index helpers
# ---------------------------------------------------------------------------

def _events_for_object(state: SimulationState, oid: str) -> list:
    """All executed events that involve object ``oid`` — O(1) lookup."""
    return state._events_by_object.get(oid, [])


def _events_for_activity(state: SimulationState, activity: str) -> list:
    """All executed events with the given activity name — O(1) lookup."""
    return state._events_by_activity.get(activity, [])


def _events_for_activity_and_object(state: SimulationState, activity: str, oid: str) -> list:
    """All executed events with given activity that involve object ``oid`` — O(1)."""
    return state._events_by_act_obj.get((activity, oid), [])


def _activity_fired_globally(state: SimulationState, activity: str) -> bool:
    """True if ``activity`` has fired at least once anywhere."""
    return bool(state._events_by_activity.get(activity))


def _activity_fired_for_object(state: SimulationState, activity: str, oid: str) -> bool:
    """True if ``activity`` has fired at least once involving ``oid``."""
    return bool(state._events_by_act_obj.get((activity, oid)))


def _count_activity_for_object(state: SimulationState, activity: str, oid: str) -> int:
    """Count of times ``activity`` fired involving ``oid``."""
    return len(state._events_by_act_obj.get((activity, oid), []))


def _last_activity_for_scope_object(state: SimulationState, scope_object_id: str) -> Optional[str]:
    """Activity name of the most recent event involving ``scope_object_id``, or None."""
    return state._last_activity_per_object.get(scope_object_id)


# ---------------------------------------------------------------------------
# Scope helpers
# ---------------------------------------------------------------------------

def _get_scope_object_ids_from_candidate(candidate: Any, state: SimulationState, scope_object_type: str) -> list[str]:
    resource_types = getattr(state, '_resource_types', set()) or set()
    ids: list[str] = []
    for oid in getattr(candidate, "participating_object_ids", []) or []:
        runtime = state.objects.get(oid)
        if runtime is None:
            continue
        if runtime.object_type == scope_object_type:
            if runtime.object_type not in resource_types:
                ids.append(oid)
    return ids


# ---------------------------------------------------------------------------
# Constraint checkers
# ---------------------------------------------------------------------------

def check_not_coexistence(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    if candidate.activity_name == constraint.source_activity:
        forbidden = constraint.target_activity
    elif candidate.activity_name == constraint.target_activity:
        forbidden = constraint.source_activity
    else:
        return True

    if constraint.scope.kind == "each":
        scope_ids = _get_scope_object_ids_from_candidate(candidate, state, constraint.scope.object_type)
        if not scope_ids:
            return True
        for oid in scope_ids:
            if _activity_fired_for_object(state, forbidden, oid):
                return False
        return True

    return not _activity_fired_globally(state, forbidden)


def check_response(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    """Lazy response enforcement — only upper-bound (nmax) is enforced eagerly."""
    required_target = constraint.target_activity
    nmax = getattr(constraint, "nmax", None)

    if candidate.activity_name == required_target:
        if constraint.scope.kind == "each" and nmax is not None:
            scope_ids = _get_scope_object_ids_from_candidate(candidate, state, constraint.scope.object_type)
            for oid in scope_ids:
                if _count_activity_for_object(state, required_target, oid) >= nmax:
                    return False
        return True

    return True


def check_precedence(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    source = constraint.source_activity
    target = constraint.target_activity
    nmin = getattr(constraint, "nmin", 0)
    nmax = getattr(constraint, "nmax", None)

    if candidate.activity_name != target:
        return True

    if constraint.scope.kind == "each":
        scope_ids = _get_scope_object_ids_from_candidate(candidate, state, constraint.scope.object_type)

        created_scope_count = sum(
            1 for t in (getattr(candidate, "object_types_to_create", []) or [])
            if t == constraint.scope.object_type
        )

        if not scope_ids and created_scope_count == 0:
            if nmin > 0:
                return _activity_fired_globally(state, source)
            return True

        if created_scope_count > 0:
            if constraint.scope.object_type not in (candidate.object_types_to_create or []):
                return False

        for oid in scope_ids:
            a_count = _count_activity_for_object(state, source, oid)
            if nmin > 0 and a_count == 0:
                return False
            if nmax is not None and a_count > nmax:
                return False

        return True

    # Global fallback
    return _activity_fired_globally(state, source)


def check_not_precedence(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    source = constraint.source_activity
    target = constraint.target_activity

    if candidate.activity_name != target:
        return True

    if constraint.scope.kind == "each":
        scope_ids = _get_scope_object_ids_from_candidate(candidate, state, constraint.scope.object_type)
        if not scope_ids:
            return True
        for oid in scope_ids:
            if _activity_fired_for_object(state, source, oid):
                return False
        return True

    return not _activity_fired_globally(state, source)


def check_chain_precedence(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    source = constraint.source_activity
    target = constraint.target_activity

    if candidate.activity_name != target:
        return True

    if constraint.scope.kind == "each":
        scope_ids = _get_scope_object_ids_from_candidate(candidate, state, constraint.scope.object_type)

        created_scope_count = sum(
            1 for t in (getattr(candidate, "object_types_to_create", []) or [])
            if t == constraint.scope.object_type
        )

        if not scope_ids and created_scope_count == 0:
            return True
        if created_scope_count > 0:
            return False

        for oid in scope_ids:
            if _last_activity_for_scope_object(state, oid) != source:
                return False
        return True

    if not state.executed_events:
        return False
    return state.executed_events[-1].activity_name == source


def check_chain_response(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    source = constraint.source_activity
    target = constraint.target_activity

    if constraint.scope.kind == "each":
        scope_ids = _get_scope_object_ids_from_candidate(candidate, state, constraint.scope.object_type)

        # Check existing scope objects: if any are armed (last event = source),
        # only the target activity may fire next that touches them.
        for oid in scope_ids:
            if _last_activity_for_scope_object(state, oid) == source:
                if candidate.activity_name != target:
                    return False

        # If this candidate IS the source and creates new scope objects, check whether
        # any previously-created scope objects of this source are still armed (awaiting
        # their target).  If so, firing source again would leave even more objects armed
        # and the target would never catch up — block it.
        if candidate.activity_name == source and candidate.activity_name != target:
            created_scope = sum(
                1 for t in (getattr(candidate, "object_types_to_create", []) or [])
                if t == constraint.scope.object_type
            )
            if created_scope > 0:
                # Count existing armed (source-last-seen) scope objects
                armed = sum(
                    1 for oid in state._active_by_type.get(constraint.scope.object_type, ())
                    if _last_activity_for_scope_object(state, oid) == source
                )
                if armed > 0:
                    return False

        return True

    if state.executed_events:
        if state.executed_events[-1].activity_name == source and candidate.activity_name != target:
            return False
    return True


def check_constraint(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    kind = getattr(constraint, "constraint_type", None)
    if kind == "not_coexistence":
        return check_not_coexistence(constraint, candidate, state)
    if kind == "response":
        return check_response(constraint, candidate, state)
    if kind == "precedence":
        return check_precedence(constraint, candidate, state)
    if kind == "not_precedence":
        return check_not_precedence(constraint, candidate, state)
    if kind == "responded_existence":
        return True
    if kind == "chain_response":
        return check_chain_response(constraint, candidate, state)
    if kind == "chain_precedence":
        return check_chain_precedence(constraint, candidate, state)
    return True


def check_all_constraints(static_model: StaticModel, candidate: Any, state: SimulationState) -> bool:
    relevant = static_model.constraints_for_activity(candidate.activity_name)
    for constraint in relevant:
        if not check_constraint(constraint, candidate, state):
            return False
    return True


# ---------------------------------------------------------------------------
# O2O rule checks
# ---------------------------------------------------------------------------

def _count_links_for_object(state: SimulationState, object_id: str, other_type: str) -> int:
    """Count links from object_id to runtime objects of `other_type` — O(degree)."""
    count = 0
    for neighbor_id in state._links_by_object.get(object_id, ()):
        obj = state.objects.get(neighbor_id)
        if obj and obj.object_type == other_type:
            count += 1
    return count


def check_o2o_rules(static_model: StaticModel, candidate: Any, state: SimulationState) -> bool:
    if not static_model.o2o_rules:
        return True

    created_counts: dict[str, int] = {}
    for t in getattr(candidate, "object_types_to_create", []) or []:
        created_counts[t] = created_counts.get(t, 0) + 1

    participating_ids = getattr(candidate, "participating_object_ids", []) or []

    # Pre-compute types of all participants
    participant_types: dict[str, str] = {}
    for oid in participating_ids:
        t = state._type_of_object.get(oid)
        if t:
            participant_types[oid] = t

    for rule in static_model.o2o_rules:
        if rule.max_links is None:
            continue
        for oid in participating_ids:
            otype = participant_types.get(oid)
            if otype is None:
                continue

            if otype == rule.source_type:
                existing = _count_links_for_object(state, oid, rule.target_type)
                # New links from created objects of target_type
                new_from_created = created_counts.get(rule.target_type, 0)
                # New links from other participating objects of target_type not yet linked
                new_from_participants = sum(
                    1 for other_id, other_type in participant_types.items()
                    if other_id != oid and other_type == rule.target_type
                    and other_id not in state._links_by_object.get(oid, set())
                )
                if existing + new_from_created + new_from_participants > rule.max_links:
                    return False

            if otype == rule.target_type:
                existing = _count_links_for_object(state, oid, rule.source_type)
                new_from_created = created_counts.get(rule.source_type, 0)
                new_from_participants = sum(
                    1 for other_id, other_type in participant_types.items()
                    if other_id != oid and other_type == rule.source_type
                    and other_id not in state._links_by_object.get(oid, set())
                )
                if existing + new_from_created + new_from_participants > rule.max_links:
                    return False

    return True
