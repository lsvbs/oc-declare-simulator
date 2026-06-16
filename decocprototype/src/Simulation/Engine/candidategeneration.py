from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
from collections import defaultdict

from src.Simulation.Domain.ir import Activity, ObjectBinding, StaticModel
from src.Simulation.Domain.state import SimulationState
from src.Simulation.Engine.o2o import neighbors_by_type
from src.Simulation.Engine.semantics import check_all_constraints, check_o2o_rules


@dataclass
class Candidate:
    activity_name: str
    participating_object_ids: list[str] = field(default_factory=list)
    object_types_to_create: list[str] = field(default_factory=list)


def find_active_objects_of_type(state: SimulationState, object_type: str) -> list[str]:
    result: list[str] = []
    for object_id, runtime_object in state.objects.items():
        if runtime_object.object_type == object_type and runtime_object.active:
            result.append(object_id)
    return result


def _find_objects_preferring_linked(
    state: SimulationState,
    existing_ids: list[str],
    participating_ids: list[str],
    count: int,
) -> list[str]:
    """Return up to `count` IDs from `existing_ids`, preferring those
    already linked in state.links to any object in `participating_ids`.

    Once links exist in the state (i.e. after the first activity has fired and
    created relational structure), only linked objects are used.  Unlinked
    objects are only accepted as a fallback when no links exist at all yet —
    which is the normal situation at the very start of simulation before any
    O2O links have been established.

    This implements inter-object synchronisation: objects from different case
    chains are kept separate by preferring — and once links exist, enforcing —
    relational groupings built up during the simulation.
    """
    if not participating_ids or not state.links:
        # No links yet (early simulation) or no anchor — fall back to global
        return existing_ids[:count]

    participating_set = set(participating_ids)
    linked_ids: list[str] = []
    unlinked_ids: list[str] = []

    for oid in existing_ids:
        is_linked = any(
            (lnk.source_object_id == oid and lnk.target_object_id in participating_set)
            or (lnk.target_object_id == oid and lnk.source_object_id in participating_set)
            for lnk in state.links
        )
        if is_linked:
            linked_ids.append(oid)
        else:
            unlinked_ids.append(oid)

    selected = linked_ids[:count]
    # Hard enforcement: once links exist, only accept unlinked objects if there
    # are genuinely not enough linked ones (e.g. first event for a new object type).
    if len(selected) < count and not linked_ids:
        # No linked candidates at all for this type — fall back to unlinked
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
        existing_ids = find_active_objects_of_type(state, binding.object_type)

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

            # Resource types are shared across case chains — select globally.
            # Case objects prefer objects already linked to current participants.
            if binding.object_type in _resource_types:
                selected_ids = existing_ids[:selected_from_existing]
            else:
                selected_ids = _find_objects_preferring_linked(
                    state, existing_ids, participating_object_ids, selected_from_existing
                )
            if len(selected_ids) < eligibility_count:
                # Not enough input objects to satisfy this binding
                return None

            participating_object_ids.extend(selected_ids)
        else:
            # Output binding: always create min_count new objects first, then
            # optionally reuse existing ones up to the remaining capacity.
            # This ordering is critical: computing reuse_limit BEFORE create_count
            # would cause reuse + created > max_count → spurious None returns
            # (e.g. place order: customers max=1, 1 existing → reuse=1, create=1, 2>1 → None).
            create_count = binding.min_count

            if binding.max_count is None:
                reuse_limit = len(existing_ids)
            else:
                remaining = binding.max_count - create_count
                if remaining < 0:
                    # min_count alone exceeds max_count — model inconsistency, skip
                    return None
                reuse_limit = min(len(existing_ids), remaining)

            if binding.object_type in _resource_types:
                selected_ids = existing_ids[:reuse_limit]
            else:
                selected_ids = _find_objects_preferring_linked(
                    state, existing_ids, participating_object_ids, reuse_limit
                )
            participating_object_ids.extend(selected_ids)

            if create_count > 0:
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
            # Output binding: this activity may create objects of this type.
            # Creation is governed only by the lifecycle flags on the binding
            # ("creates" / "deactivates") and multiplicities; there is no
            # additional restriction based on anchors or start activities.

            # Optionally reuse existing objects as participants, but they are
            # not required for outputs.
            if binding.max_count is None:
                reuse_limit = len(existing_ids)
            else:
                reuse_limit = min(len(existing_ids), binding.max_count)

            selected_ids = existing_ids[:reuse_limit]
            participating_ids.extend(selected_ids)
            available_for_type[binding.object_type] = existing_ids[reuse_limit:]

            # Create as many new objects as min_count requests, while
            # respecting max_count when combined with any reused objects.
            create_count = binding.min_count
            if binding.max_count is not None and len(selected_ids) + create_count > binding.max_count:
                return None

            if create_count > 0:
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

