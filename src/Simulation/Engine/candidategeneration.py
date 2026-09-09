from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Optional
from collections import defaultdict

from src.Simulation.Domain.ir import Activity, ObjectBinding, StaticModel
from src.Simulation.Domain.state import SimulationState
from src.Simulation.Engine.o2o import neighbors_by_type
from src.Simulation.Engine.semantics import check_all_constraints, check_o2o_rules
from src.Simulation.Engine.attrutils import apply_guard_filter


def _apply_guard_filter(ids: list, guard: dict, state: SimulationState) -> list:
    """Thin wrapper kept for backward compatibility — delegates to attrutils."""
    return apply_guard_filter(ids, guard, state)


@dataclass
class Candidate:
    activity_name: str
    participating_object_ids: list[str] = field(default_factory=list)
    object_types_to_create: list[str] = field(default_factory=list)


def find_active_objects_of_type(state: SimulationState, object_type: str, limit: int = 0) -> list[str]:
    """Return active, non-busy objects of `object_type`. If `limit` > 0, return at most `limit` items."""
    active_set = state._active_by_type.get(object_type)
    if not active_set:
        return []
    is_resource = object_type in state._resource_types
    if not is_resource:
        if limit > 0:
            return list(itertools.islice(active_set, limit))
        return list(active_set)
    current_time = state.current_time
    result = []
    for oid in active_set:
        if current_time is not None:
            obj = state.objects.get(oid)
            if obj and obj.busy_until is not None and obj.busy_until > current_time:
                continue  # resource occupied — skip
        result.append(oid)
        if limit > 0 and len(result) >= limit:
            break
    return result


def _find_objects_preferring_linked(
    state: SimulationState,
    existing_ids: list[str],
    participating_ids: list[str],
    count: int,
) -> list[str]:
    """Return up to `count` IDs from `existing_ids`, preferring those
    already linked to any object in `participating_ids` — O(1) via index.
    """
    if not participating_ids or not state._links_by_object:
        return existing_ids[:count]

    participating_set = set(participating_ids)
    linked_ids: list[str] = []
    unlinked_ids: list[str] = []

    for oid in existing_ids:
        neighbors = state._links_by_object.get(oid)
        if neighbors and not neighbors.isdisjoint(participating_set):
            linked_ids.append(oid)
        else:
            unlinked_ids.append(oid)

    selected = linked_ids[:count]
    if len(selected) < count and not linked_ids:
        selected += unlinked_ids[: count - len(selected)]
    return selected


def build_candidate_for_activity(
    activity: Activity,
    state: SimulationState,
    resource_types: set[str] | None = None,
    force_object_id: str | None = None,
    force_object_ids: list[str] | None = None,
) -> Optional[Candidate]:
    """Build a candidate for ``activity`` from the global active-object pool.

    ``resource_types`` is the set of object type names classified as reusable
    resources. ``force_object_id`` pins the first non-creating, non-resource
    binding to exactly that object, avoiding the temporary _active_by_type
    mutation used in _generate_candidates_des (#6).
    ``force_object_ids`` pins a specific set of objects for all-mode obligations
    where all objects must participate together in the candidate event.
    """
    participating_object_ids: list[str] = []
    object_types_to_create: list[str] = []
    _resource_types = resource_types or set()
    _forced_type: str | None = None
    if force_object_id is not None:
        obj = state.objects.get(force_object_id)
        _forced_type = obj.object_type if obj else None

    # Build a lookup from type → forced ids for all-mode
    _forced_ids_by_type: dict[str, list[str]] = {}
    if force_object_ids:
        for _foid in force_object_ids:
            _fobj = state.objects.get(_foid)
            if _fobj:
                _forced_ids_by_type.setdefault(_fobj.object_type, []).append(_foid)

    for binding in activity.bindings:
        # Determine how many objects to fetch for link-preference selection.
        if binding.creates:
            fetch_limit = binding.min_count
        elif binding.max_count is not None:
            fetch_limit = max(binding.max_count * 4, 8)
        else:
            fetch_limit = 8
        existing_ids = find_active_objects_of_type(state, binding.object_type, limit=fetch_limit)

        # #6: if force_object_id pins this binding's type, replace the pool
        if (force_object_id is not None
                and not binding.creates
                and binding.object_type == _forced_type
                and len(participating_object_ids) == 0):  # only for the first/primary binding
            obj = state.objects.get(force_object_id)
            if obj is None or not obj.active:
                return None
            existing_ids = [force_object_id]

        # force_object_ids: for all-mode, force specific objects into this binding
        elif (force_object_ids is not None
              and not binding.creates
              and binding.object_type in _forced_ids_by_type):
            forced = _forced_ids_by_type[binding.object_type]
            # Verify all forced objects are active
            for _foid in forced:
                _fobj = state.objects.get(_foid)
                if _fobj is None or not _fobj.active:
                    return None
            existing_ids = forced

        # Apply attribute guard: filter out objects that don't satisfy the guard.
        guard = binding.guard
        if guard:
            before = len(existing_ids)
            existing_ids = _apply_guard_filter(existing_ids, guard, state)
            state.guard_checks_total += before
            state.guard_checks_passed += len(existing_ids)

        # Basic validation: if max_count provided but less than min_count, impossible
        if binding.max_count is not None and binding.max_count < binding.min_count:
            return None

        # Treat bindings with creates=False as pure inputs that must be
        # satisfied from existing objects. Bindings with creates=True are
        # treated as outputs: they may create new objects (subject to
        # multiplicity), but are not allowed to rely on creation to satisfy
        # input requirements.

        if not binding.creates:
            eligibility_count = binding.min_count
            target_count = binding.min_count

            # Use already existing active objects first (but do not exceed max_count)
            if binding.max_count is None:
                selected_from_existing = min(len(existing_ids), target_count)
            else:
                selected_from_existing = min(len(existing_ids), target_count, binding.max_count)

            # Resource types and case objects both prefer linked objects.
            # The distinction: resource types always fall back to any active
            # object when no linked one exists (they are shared across cases),
            # whereas case objects are only accepted when linked (once links exist).
            # _find_objects_preferring_linked already implements this: it falls
            # back to unlinked only when no linked objects exist at all.
            selected_ids = _find_objects_preferring_linked(
                state, existing_ids, participating_object_ids, selected_from_existing
            )
            if len(selected_ids) < eligibility_count:
                # Not enough input objects to satisfy this binding
                return None

            participating_object_ids.extend(selected_ids)
        else:
            # Output binding: this activity instantiates new objects of this type.
            #
            # Reuse: if max_count is set, fill up to (max_count - create_count) slots
            # with existing linked objects. If max_count is None, no reuse —
            # the newly created objects are the sole participants of this type.
            #
            # Resource types come from the pre-populated pool only.
            if binding.object_type in _resource_types:
                eligibility_count = binding.min_count
                target_count = binding.min_count
                selected_from_existing = min(len(existing_ids), target_count,
                                             binding.max_count if binding.max_count is not None else len(existing_ids))
                selected_ids = existing_ids[:selected_from_existing]
                if len(selected_ids) < eligibility_count:
                    return None
                participating_object_ids.extend(selected_ids)
                continue

            create_count = max(1, binding.min_count)

            if binding.max_count is not None:
                reuse_limit = min(len(existing_ids), max(0, binding.max_count - create_count))
            else:
                reuse_limit = 0  # no reuse when unbounded — created objects are the sole participants

            selected_ids = _find_objects_preferring_linked(
                state, existing_ids, participating_object_ids, reuse_limit
            )
            participating_object_ids.extend(selected_ids)

            object_types_to_create.extend([binding.object_type] * create_count)

    return Candidate(
        activity_name=activity.name,
        participating_object_ids=participating_object_ids,
        object_types_to_create=object_types_to_create,
    )


def build_candidate_for_object_and_activity(
    state: SimulationState,
    scope_object_id: str,
    activity: Activity,
    anchor_object_types: set[str] | None = None,
    is_start_activity: bool = False,
) -> Optional[Candidate]:
    """Build a candidate for `activity` centered on one scope object.

    This restricts object choice to the scope object and its local neighborhood
    instead of the entire state. Object creation is governed purely by the
    static model's lifecycle (binding.creates / binding.deactivates); the
    `anchor_object_types` and `is_start_activity` flags are no longer used to
    gate creation.
    """

    if scope_object_id not in state.objects:
        return None

    neighborhood = neighbors_by_type(state, scope_object_id)
    participating_ids: list[str] = []
    object_types_to_create: list[str] = []

    # Copy neighborhood so we can deactivate objects per binding
    available_for_type: dict[str, list[str]] = {
        t: list(ids) for t, ids in neighborhood.items()
    }

    for binding in activity.bindings:
        existing_ids = available_for_type.get(binding.object_type, [])

        # Apply attribute guard (mirrors build_candidate_for_activity)
        guard = binding.guard
        if guard:
            before = len(existing_ids)
            existing_ids = apply_guard_filter(existing_ids, guard, state)
            state.guard_checks_total += before
            state.guard_checks_passed += len(existing_ids)

        # Basic validation: impossible multiplicity
        if binding.max_count is not None and binding.max_count < binding.min_count:
            return None

        if not binding.creates:
            # Pure input binding: must be satisfied entirely from the local
            # neighborhood without creating new objects.
            required = binding.min_count

            if binding.max_count is None:
                selected_from_existing = min(len(existing_ids), required)
            else:
                selected_from_existing = min(len(existing_ids), required, binding.max_count)

            selected_ids = existing_ids[:selected_from_existing]
            if len(selected_ids) < required:
                # Not enough input objects in the neighborhood
                return None

            participating_ids.extend(selected_ids)
            available_for_type[binding.object_type] = existing_ids[selected_from_existing:]
        else:
            # Output binding: always create exactly 1 new object, optionally
            # reusing existing neighbors to fill up to max_count - 1 slots.
            create_count = 1
            if binding.max_count is not None:
                reuse_limit = min(len(existing_ids), max(0, binding.max_count - create_count))
            else:
                reuse_limit = 0

            selected_ids = existing_ids[:reuse_limit]
            participating_ids.extend(selected_ids)
            available_for_type[binding.object_type] = existing_ids[reuse_limit:]

            object_types_to_create.extend([binding.object_type] * create_count)

    return Candidate(
        activity_name=activity.name,
        participating_object_ids=participating_ids,
        object_types_to_create=object_types_to_create,
    )


def is_candidate_semantically_allowed(
    static_model: StaticModel,
    candidate: Candidate,
    state: SimulationState,
) -> bool:
    """Check whether a candidate satisfies declarative constraints and O2O rules.

    This centralizes semantic validation so that candidate generation can
    produce a pool of feasible candidates, and selection can focus purely on
    choosing among them.
    """

    if not check_all_constraints(static_model, candidate, state):
        return False

    if not check_o2o_rules(static_model, candidate, state):
        return False

    return True

