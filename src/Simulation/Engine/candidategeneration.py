from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
from collections import defaultdict

from src.Simulation.Domain.ir import Activity, ObjectBinding, StaticModel
from src.Simulation.Domain.state import SimulationState
from src.Simulation.Engine.o2o import neighbors_by_type
from src.Simulation.Engine.semantics import check_all_constraints, check_o2o_rules


def _apply_guard_filter(ids: list, guard: dict, state: SimulationState) -> list:
    """Filter object ids by a binding attribute guard.

    Objects that do not have the named attribute are excluded (fail-absent).
    Both sides are cast to numeric types when possible for numeric comparisons.
    """
    attr_name = guard.get('attribute', '')
    op        = guard.get('op', '==')
    raw_val   = guard.get('value')

    def _coerce(a, b):
        try:
            return float(a), float(b)
        except (TypeError, ValueError):
            return str(a), str(b)

    result = []
    for oid in ids:
        obj = state.objects.get(oid)
        if obj is None:
            continue
        attrs = obj.attributes or {}
        if attr_name not in attrs:
            continue  # fail-absent
        obj_val = attrs[attr_name]
        a, b = _coerce(obj_val, raw_val)
        try:
            if   op == '==': match = a == b
            elif op == '!=': match = a != b
            elif op == '>' : match = a >  b
            elif op == '<' : match = a <  b
            elif op == '>=': match = a >= b
            elif op == '<=': match = a <= b
            else:            match = False
        except TypeError:
            match = False
        if match:
            result.append(oid)
    return result


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
    current_time = getattr(state, 'current_time', None)
    is_resource = object_type in getattr(state, '_resource_types', set())
    result = []
    for oid in active_set:
        if is_resource and current_time is not None:
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
        if neighbors and (neighbors & participating_set):
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
) -> Optional[Candidate]:
    """Build a candidate for ``activity`` from the global active-object pool.

    ``resource_types`` is the set of object type names that are classified as
    reusable resources (e.g. Forklift, Truck).  Resource-typed objects are
    always selected globally (first-available), bypassing link-preference
    synchronisation, because they are shared across all case chains.
    """
    participating_object_ids: list[str] = []
    object_types_to_create: list[str] = []
    _resource_types = resource_types or set()

    for binding in activity.bindings:
        # Determine how many objects to fetch for link-preference selection.
        # For input (non-creating) bindings we fetch more than max_count so that
        # link-preference can choose the best-linked object from the pool,
        # rather than being forced to accept the first one from the set.
        # A small pool of 8 is enough: linked objects sort to the front so the
        # correct one will be selected even if many exist globally.
        if binding.creates:
            fetch_limit = binding.min_count  # output: only reuse up to min_count
        elif binding.max_count is not None:
            fetch_limit = max(binding.max_count * 4, 8)  # widen pool for link-preference
        else:
            fetch_limit = 8
        existing_ids = find_active_objects_of_type(state, binding.object_type, limit=fetch_limit)

        # Apply attribute guard: filter out objects that don't satisfy the guard.
        guard = getattr(binding, 'guard', None)
        if guard:
            existing_ids = _apply_guard_filter(existing_ids, guard, state)

        # Basic validation: if max_count provided but less than min_count, impossible
        if binding.max_count is not None and binding.max_count < binding.min_count:
            return None

        # Treat bindings with creates=False as pure inputs that must be
        # satisfied from existing objects. Bindings with creates=True are
        # treated as outputs: they may create new objects (subject to
        # multiplicity), but are not allowed to rely on creation to satisfy
        # input requirements.

        if not binding.creates:
            # For simulation eligibility, require at least 1 object regardless of
            # binding.min_count.  Log-derived min_counts are batch-size statistics
            # (e.g. Depart: min=2 because ships always left with ≥2 containers),
            # NOT logical preconditions.  We still try to select min_count objects
            # when they are available, but we never block the activity if only 1 exists.
            eligibility_count = 1
            target_count = max(binding.min_count, eligibility_count)

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
            # Output binding: this activity instantiates a new object of this type.
            #
            # Creation count is always exactly 1 per firing — regardless of
            # min_count. min_count comes from log-discovery and represents the
            # average NUMBER OF OBJECTS THAT PARTICIPATED in events of this
            # activity (including existing ones), not how many new ones to
            # create on each firing. Using it directly causes an explosion
            # (e.g. min_count=50 containers → 50 new objects every step).
            #
            # Reuse: if max_count is set, fill up to (max_count - 1) slots
            # with existing linked objects. If max_count is None, no reuse —
            # the newly created object is the sole participant of this type.
            #
            # Resource types come from the pre-populated pool only.
            if binding.object_type in _resource_types:
                eligibility_count = 1
                target_count = max(binding.min_count, eligibility_count)
                selected_from_existing = min(len(existing_ids), target_count,
                                             binding.max_count if binding.max_count is not None else len(existing_ids))
                selected_ids = existing_ids[:selected_from_existing]
                if len(selected_ids) < eligibility_count:
                    return None
                participating_object_ids.extend(selected_ids)
                continue

            create_count = 1  # always create exactly one new instance

            if binding.max_count is not None:
                reuse_limit = min(len(existing_ids), max(0, binding.max_count - create_count))
            else:
                reuse_limit = 0  # no reuse when unbounded — created object is the sole participant

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

