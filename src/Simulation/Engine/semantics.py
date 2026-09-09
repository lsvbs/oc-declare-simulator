from __future__ import annotations

from typing import Any, Optional

from src.Simulation.Domain.ir import StaticModel
from src.Simulation.Domain.state import SimulationState
from src.Simulation.Domain.ir import O2ORule
from src.Simulation.Engine.attrutils import apply_guard_filter
_EMPTY_SET: frozenset = frozenset()  # #14: reusable empty set to avoid alloc in O2O checks



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
    resource_types = state._resource_types
    ids: list[str] = []
    for oid in candidate.participating_object_ids:
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

def _scope_ids(candidate: Any, state: SimulationState, scope_type: str,
               cache: dict | None = None) -> list[str]:
    """Return scope object IDs, using pre-computed cache when available (#12)."""
    if cache is not None:
        return cache.get(scope_type, [])
    return _get_scope_object_ids_from_candidate(candidate, state, scope_type)


def _joint_scope_event_ids(
    candidate: Any,
    state: SimulationState,
    scope: Any,
    source_activity: str,
) -> frozenset:
    """Return event IDs of source_activity events jointly satisfying all multi-type bindings.

    For each binding (obj_type, involvement):
      'any' → any candidate object of that type must appear in the source event
      'all' → all candidate objects of that type must appear in the source event
      'each' (single obj) → that object must appear in the source event
      'each' (multi obj) → each object individually must have a qualifying source
                            event (per-object existential check against joint_base)

    Returns empty frozenset if no qualifying event exists (constraint not satisfied).
    """
    bindings = scope.bindings
    if not bindings:
        return frozenset()

    cand_by_type: dict = {}
    for oid in candidate.participating_object_ids:
        rt = state.objects.get(oid)
        if rt:
            cand_by_type.setdefault(rt.object_type, []).append(oid)

    def _src_eids_for_obj(oid: str) -> frozenset:
        return frozenset(state._events_by_act_obj.get((source_activity, oid), ()))

    single_sets: list = []
    each_multi_groups: list = []  # list of [frozenset, ...] per "each" group with multiple objects

    for obj_type, inv in bindings:
        A_objs = cand_by_type.get(obj_type, [])
        if not A_objs:
            return frozenset()
        if inv == 'any':
            s: set = set()
            for oid in A_objs:
                s.update(state._events_by_act_obj.get((source_activity, oid), ()))
            single_sets.append(frozenset(s))
        elif inv == 'all':
            combined = None
            for oid in A_objs:
                es = _src_eids_for_obj(oid)
                combined = es if combined is None else combined & es
            single_sets.append(combined if combined is not None else frozenset())
        else:  # each
            if len(A_objs) <= 1:
                single_sets.append(_src_eids_for_obj(A_objs[0]))
            else:
                each_multi_groups.append([_src_eids_for_obj(oid) for oid in A_objs])

    joint_base = single_sets[0] if single_sets else frozenset(
        e.event_id for e in _events_for_activity(state, source_activity)
    )
    for s in single_sets[1:]:
        joint_base = joint_base & s

    if not joint_base:
        return frozenset()

    if not each_multi_groups:
        return joint_base

    # Per-object existential check: each individual object in an "each" group must
    # have at least one qualifying source event within joint_base.  Collect all such
    # events into the return set so the caller can count them.
    qualifying: set = set()
    for group_event_sets in each_multi_groups:
        for obj_events in group_event_sets:
            local = joint_base & obj_events
            if not local:
                return frozenset()  # this object has no qualifying source event
            qualifying.update(local)

    return frozenset(qualifying)


def check_not_coexistence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    if candidate.activity_name == constraint.source_activity:
        forbidden = constraint.target_activity
    elif candidate.activity_name == constraint.target_activity:
        forbidden = constraint.source_activity
    else:
        return True

    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        for oid in scope_ids:
            if _activity_fired_for_object(state, forbidden, oid):
                return False
        return True

    if constraint.scope.kind in ("any", "all"):
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        results = [_activity_fired_for_object(state, forbidden, oid) for oid in scope_ids]
        if constraint.scope.kind == "any":
            return not any(results)   # fail if any object has the forbidden activity
        else:  # all
            return not all(results)   # fail only if all objects have it

    return not _activity_fired_globally(state, forbidden)


def check_response(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Lazy response enforcement — only upper-bound (nmax) is enforced eagerly."""
    required_target = constraint.target_activity
    nmax = constraint.nmax

    if candidate.activity_name == required_target:
        if nmax is not None:
            scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
            if constraint.scope.kind == "each":
                for oid in scope_ids:
                    if _count_activity_for_object(state, required_target, oid) >= nmax:
                        return False
            elif constraint.scope.kind == "any":
                # Block only if ALL scope objects have already reached nmax
                if scope_ids and all(
                    _count_activity_for_object(state, required_target, oid) >= nmax
                    for oid in scope_ids
                ):
                    return False
            elif constraint.scope.kind == "all":
                # Block if any scope object has reached nmax
                if any(
                    _count_activity_for_object(state, required_target, oid) >= nmax
                    for oid in scope_ids
                ):
                    return False
        return True

    return True


def check_precedence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    source = constraint.source_activity
    target = constraint.target_activity
    nmin = constraint.nmin
    nmax = constraint.nmax

    if candidate.activity_name != target:
        return True

    # Multi-type binding: joint check across all object types in the binding
    if constraint.scope.bindings:
        qualifying = _joint_scope_event_ids(candidate, state, constraint.scope, source)
        count = len(qualifying)
        if nmin > 0 and count < nmin:
            return False
        return count >= 1 if nmin > 0 else True

    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)

        created_scope_count = sum(
            1 for t in candidate.object_types_to_create
            if t == constraint.scope.object_type
        )

        if not scope_ids and created_scope_count == 0:
            if nmin > 0:
                return _activity_fired_globally(state, source)
            return True

        if created_scope_count > 0:
            if constraint.scope.object_type not in candidate.object_types_to_create:
                return False

        prec_satisfied = state._prec_satisfied
        cache_key_base = (source, target, 'each')

        for oid in scope_ids:
            # Fast path: already cached as permanently satisfied for this object
            if (cache_key_base + (oid,)) in prec_satisfied:
                continue
            a_count = _count_activity_for_object(state, source, oid)
            if nmin > 0 and a_count < nmin:
                return False
            if nmax is not None:
                t_count = _count_activity_for_object(state, target, oid)
                if t_count >= nmax:
                    return False
            # Cache if permanently satisfied: nmin met and no nmax upper bound
            if a_count >= max(nmin, 1) and nmax is None:
                prec_satisfied.add(cache_key_base + (oid,))

        return True

    if constraint.scope.kind in ("any", "all"):
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return _activity_fired_globally(state, source) if nmin > 0 else True
        results = []
        for oid in scope_ids:
            a_count = _count_activity_for_object(state, source, oid)
            ok = True
            if nmin > 0 and a_count < nmin:
                ok = False
            if nmax is not None and ok:
                t_count = _count_activity_for_object(state, target, oid)
                if t_count >= nmax:
                    ok = False
            results.append(ok)
        if constraint.scope.kind == "any":
            return any(results)   # pass if at least one object satisfies
        else:  # all
            return all(results)   # pass only if all objects satisfy

    # Global fallback
    return _activity_fired_globally(state, source)


def check_not_precedence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    source = constraint.source_activity
    target = constraint.target_activity

    if candidate.activity_name != target:
        return True

    if constraint.scope.kind in ("each", "any", "all"):
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        results = [_activity_fired_for_object(state, source, oid) for oid in scope_ids]
        if constraint.scope.kind == "any":
            return not any(results)   # fail if any object has the source
        else:  # each or all
            return not any(results)   # same: fail if any scope object was preceded by source

    return not _activity_fired_globally(state, source)


def check_chain_precedence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    source = constraint.source_activity
    target = constraint.target_activity

    if candidate.activity_name != target:
        return True

    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)

        created_scope_count = sum(
            1 for t in candidate.object_types_to_create
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

    if constraint.scope.kind in ("any", "all"):
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        results = [_last_activity_for_scope_object(state, oid) == source for oid in scope_ids]
        if constraint.scope.kind == "any":
            return any(results)   # pass if at least one has source as last event
        else:  # all
            return all(results)   # pass only if all have source as last event

    if not state.executed_events:
        return False
    return state.executed_events[-1].activity_name == source


def check_chain_response(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    source = constraint.source_activity
    target = constraint.target_activity

    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)

        for oid in scope_ids:
            if _last_activity_for_scope_object(state, oid) == source:
                if candidate.activity_name != target:
                    return False

        if candidate.activity_name == source and candidate.activity_name != target:
            created_scope = sum(
                1 for t in candidate.object_types_to_create
                if t == constraint.scope.object_type
            )
            if created_scope > 0:
                armed = sum(
                    1 for oid in state._active_by_type.get(constraint.scope.object_type, ())
                    if _last_activity_for_scope_object(state, oid) == source
                )
                if armed > 0:
                    return False

        return True

    if constraint.scope.kind in ("any", "all"):
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        armed = [oid for oid in scope_ids if _last_activity_for_scope_object(state, oid) == source]
        if armed:
            if constraint.scope.kind == "any":
                # Any: if at least one is armed and this is not the target, block
                if candidate.activity_name != target:
                    return False
            else:  # all
                # All: if all are armed and this is not the target, block
                if len(armed) == len(scope_ids) and candidate.activity_name != target:
                    return False
        return True

    if state.executed_events:
        if state.executed_events[-1].activity_name == source and candidate.activity_name != target:
            return False
    return True


def check_responded_existence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Post-hoc obligation — cannot block eagerly. Always returns True."""
    return True


def check_absence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Activity must never occur (nmax=0) or at most nmax times."""
    target = constraint.target_activity or constraint.source_activity
    if candidate.activity_name != target:
        return True
    nmax = constraint.nmax
    if nmax is None:
        nmax = 0
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return len(state._events_by_activity.get(target, [])) < nmax if nmax > 0 else not _activity_fired_globally(state, target)
        for oid in scope_ids:
            cnt = _count_activity_for_object(state, target, oid)
            if nmax == 0 and cnt > 0:
                return False
            if nmax > 0 and cnt >= nmax:
                return False
        return True
    cnt = len(state._events_by_activity.get(target, []))
    return cnt < nmax if nmax > 0 else cnt == 0


def check_exactly(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Activity must occur exactly nmin times. Block after nmin firings."""
    target = constraint.target_activity or constraint.source_activity
    if candidate.activity_name != target:
        return True
    nmin = getattr(constraint, "nmin", 1) or 1
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return len(state._events_by_activity.get(target, [])) < nmin
        for oid in scope_ids:
            if _count_activity_for_object(state, target, oid) >= nmin:
                return False
        return True
    return len(state._events_by_activity.get(target, [])) < nmin


def check_init(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Activity must be the first event for each scope object.

    For 'each' scope: the target must have fired for at least one scope object
    that participates in this candidate before any other activity fires for that
    object.  Using _activity_fired_globally is incorrect in multi-case runs
    because one case's init vacuously satisfies all other concurrent cases.
    """
    target = constraint.target_activity or constraint.source_activity
    if candidate.activity_name == target:
        return True

    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            # No scope objects yet — vacuously satisfied (nothing to enforce against)
            return True
        for oid in scope_ids:
            if not _activity_fired_for_object(state, target, oid):
                return False
        return True

    if constraint.scope.kind == "any":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        return any(_activity_fired_for_object(state, target, oid) for oid in scope_ids)

    if constraint.scope.kind == "all":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        return all(_activity_fired_for_object(state, target, oid) for oid in scope_ids)

    # Global fallback (no scope type set)
    return _activity_fired_globally(state, target)


def check_exclusive_choice(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Exactly one of source or target may occur. Once one fires, block the other."""
    source = constraint.source_activity
    target = constraint.target_activity
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        for oid in scope_ids:
            if candidate.activity_name == source and _activity_fired_for_object(state, target, oid):
                return False
            if candidate.activity_name == target and _activity_fired_for_object(state, source, oid):
                return False
        return True
    if candidate.activity_name == source:
        return not _activity_fired_globally(state, target)
    if candidate.activity_name == target:
        return not _activity_fired_globally(state, source)
    return True


def check_not_succession(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """After source fires, target must never follow."""
    source = constraint.source_activity
    target = constraint.target_activity
    if candidate.activity_name != target:
        return True
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return not _activity_fired_globally(state, source)
        for oid in scope_ids:
            if _activity_fired_for_object(state, source, oid):
                return False
        return True
    return not _activity_fired_globally(state, source)


def check_not_chain_succession(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Target must not occur immediately after source."""
    source = constraint.source_activity
    target = constraint.target_activity
    if candidate.activity_name != target:
        return True
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            if not state.executed_events:
                return True
            return state.executed_events[-1].activity_name != source
        for oid in scope_ids:
            if _last_activity_for_scope_object(state, oid) == source:
                return False
        return True
    if not state.executed_events:
        return True
    return state.executed_events[-1].activity_name != source


def check_alternate_response(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Block source from firing again while it is armed (fired but target hasn't responded)."""
    source = constraint.source_activity
    target = constraint.target_activity
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        for oid in scope_ids:
            src_count = _count_activity_for_object(state, source, oid)
            tgt_count = _count_activity_for_object(state, target, oid)
            if candidate.activity_name == source and src_count > tgt_count:
                return False
        return True
    src_count = len(state._events_by_activity.get(source, []))
    tgt_count = len(state._events_by_activity.get(target, []))
    if candidate.activity_name == source and src_count > tgt_count:
        return False
    return True


def check_alternate_precedence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Each target firing must be matched by a preceding source; block target when balanced."""
    source = constraint.source_activity
    target = constraint.target_activity
    if candidate.activity_name != target:
        return True
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        for oid in scope_ids:
            src_count = _count_activity_for_object(state, source, oid)
            tgt_count = _count_activity_for_object(state, target, oid)
            if tgt_count >= src_count:
                return False
        return True
    src_count = len(state._events_by_activity.get(source, []))
    tgt_count = len(state._events_by_activity.get(target, []))
    return tgt_count < src_count


def _check_succession(c, cand, st, sc=None):
    return check_precedence(c, cand, st, sc) and check_response(c, cand, st, sc)


def _check_chain_succession(c, cand, st, sc=None):
    return check_chain_precedence(c, cand, st, sc) and check_chain_response(c, cand, st, sc)


def _check_alternate_succession(c, cand, st, sc=None):
    return check_alternate_response(c, cand, st, sc) and check_alternate_precedence(c, cand, st, sc)


_CHECKERS: dict = {
    'not_coexistence': check_not_coexistence,
    'response': check_response,
    'precedence': check_precedence,
    'not_precedence': check_not_precedence,
    'responded_existence': check_responded_existence,
    'chain_response': check_chain_response,
    'chain_precedence': check_chain_precedence,
    'absence': check_absence,
    'exactly': check_exactly,
    'init': check_init,
    'exclusive_choice': check_exclusive_choice,
    'not_succession': check_not_succession,
    'not_chain_succession': check_not_chain_succession,
    'alternate_response': check_alternate_response,
    'alternate_precedence': check_alternate_precedence,
    'succession': _check_succession,
    'chain_succession': _check_chain_succession,
    'alternate_succession': _check_alternate_succession,
}


def check_constraint(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    fn = _CHECKERS.get(constraint.constraint_type)
    return fn(constraint, candidate, state, scope_ids_cache) if fn else True


def check_all_constraints(static_model: StaticModel, candidate: Any, state: SimulationState) -> bool:
    relevant = static_model.constraints_for_activity(candidate.activity_name)
    if not relevant:
        return True
    # #12: pre-compute scope object IDs once per scope type, reused by all checkers
    resource_types = state._resource_types
    scope_ids_cache: dict[str, list[str]] = {}
    for oid in candidate.participating_object_ids:
        runtime = state.objects.get(oid)
        if runtime is None or runtime.object_type in resource_types:
            continue
        scope_ids_cache.setdefault(runtime.object_type, []).append(oid)

    # Performance: set of object types with zero active instances — constraints
    # scoped to these types pass trivially (scope_ids would be empty → True)
    inactive_types = state._inactive_scope_types
    creates_set = set(candidate.object_types_to_create)

    for constraint in relevant:
        # Skip constraint if its scope type is fully inactive and not being created now
        scope_type = constraint.scope.object_type
        if scope_type and scope_type in inactive_types and scope_type not in creates_set:
            continue

        # Phase 2: apply constraint-level object-filter guard.
        # Scope objects not satisfying the guard are exempt — filter them out
        # before passing to the checker. If no objects remain, skip (trivially passes).
        c_guard = constraint.guard
        if c_guard:
            scope_type = constraint.scope.object_type
            if scope_type:
                original_ids = scope_ids_cache.get(scope_type, [])
                guarded_ids = apply_guard_filter(original_ids, c_guard, state)
                if not guarded_ids:
                    continue  # no objects subject to this constraint — passes trivially
                local_cache = {**scope_ids_cache, scope_type: guarded_ids}
                if not check_constraint(constraint, candidate, state, local_cache):
                    return False
                continue

        if not check_constraint(constraint, candidate, state, scope_ids_cache):
            return False
    return True


# ---------------------------------------------------------------------------
# O2O rule checks
# ---------------------------------------------------------------------------

def _count_links_for_object(state: SimulationState, object_id: str, other_type: str) -> int:
    """Count links from object_id to runtime objects of `other_type` — O(1) via typed index."""
    return len(state._linked_by_type.get(object_id, {}).get(other_type, _EMPTY_SET))


_o2o_activity_cache: dict = {}  # id(static_model) → frozenset[activity_name]


def check_o2o_rules(static_model: StaticModel, candidate: Any, state: SimulationState) -> bool:
    if not static_model.o2o_rules:
        return True

    # Early-exit: skip entirely if this activity has no O2O-relevant bindings.
    model_key = id(static_model)
    applicable = _o2o_activity_cache.get(model_key)
    if applicable is None:
        o2o_types: set = set()
        for rule in static_model.o2o_rules:
            if rule.max_links is not None:
                o2o_types.add(rule.source_type)
                o2o_types.add(rule.target_type)
        applicable = frozenset(
            act.name for act in static_model.activities
            if any(b.object_type in o2o_types for b in act.bindings)
        )
        _o2o_activity_cache[model_key] = applicable
    if candidate.activity_name not in applicable:
        return True

    resource_types = state._resource_types

    created_counts: dict[str, int] = {}
    for t in candidate.object_types_to_create:
        created_counts[t] = created_counts.get(t, 0) + 1

    participating_ids = candidate.participating_object_ids

    # Pre-compute types of all participants
    participant_types: dict[str, str] = {}
    for oid in participating_ids:
        t = state._type_of_object.get(oid)
        if t:
            participant_types[oid] = t

    # Pre-filter: only check rules whose both sides appear in this candidate's types
    all_types = set(participant_types.values()) | set(created_counts.keys())

    for rule in static_model.o2o_rules:
        if rule.max_links is None:
            continue
        if rule.source_type not in all_types or rule.target_type not in all_types:
            continue
        if rule.source_type in resource_types or rule.target_type in resource_types:
            continue

        # Hoist: compute sources/targets lists once per rule (avoids O(N²) type scan)
        sources = [oid for oid, t in participant_types.items() if t == rule.source_type]
        targets = [oid for oid, t in participant_types.items() if t == rule.target_type]
        new_targets_created = created_counts.get(rule.target_type, 0)

        for oid in sources:
            existing = _count_links_for_object(state, oid, rule.target_type)
            oid_links = state._links_by_object.get(oid, _EMPTY_SET)
            new_from_participants = sum(
                1 for t_id in targets
                if t_id != oid and t_id not in oid_links
            )
            if existing + new_targets_created + new_from_participants > rule.max_links:
                return False

        if rule.bidirectional:
            new_sources_created = created_counts.get(rule.source_type, 0)
            for oid in targets:
                existing = _count_links_for_object(state, oid, rule.source_type)
                oid_links = state._links_by_object.get(oid, _EMPTY_SET)
                new_from_participants = sum(
                    1 for s_id in sources
                    if s_id != oid and s_id not in oid_links
                )
                if existing + new_sources_created + new_from_participants > rule.max_links:
                    return False

    return True
