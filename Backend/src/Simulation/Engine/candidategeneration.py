from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
from collections import defaultdict

from Backend.src.Simulation.Domain.ir import Activity, ObjectBinding, StaticModel
from Backend.src.Simulation.Domain.state import SimulationState
from Backend.src.Simulation.Engine.o2o import neighbors_by_type
from Backend.src.Simulation.Engine.semantics import check_all_constraints, check_o2o_rules
from Backend.src.Simulation.Engine.attrutils import apply_guard_filter


def _apply_guard_filter(ids: list, guard: dict, state: SimulationState) -> list:
    """Thin wrapper kept for backward compatibility — delegates to attrutils."""
    return apply_guard_filter(ids, guard, state)


@dataclass
class Candidate:
    activity_name: str
    participating_object_ids: list[str] = field(default_factory=list)
    object_types_to_create: list[str] = field(default_factory=list)


def find_active_objects_of_type(
    state: SimulationState,
    object_type: str,
    limit: int = 0,
    cache: dict[tuple, list[str]] | None = None,
) -> list[str]:
    """Return active, non-busy objects of `object_type`. If `limit` > 0, return at most `limit` items.

    `cache` is an optional dict scoped to a single candidate-generation pass
    (state is never mutated between calls during that pass — see
    Simulator._generate_candidates_des). Reusing identical (object_type, limit)
    lookups across the many candidates built per pass avoids rescanning the
    same active-object pool over and over for non-primary bindings.
    """
    cache_key = (object_type, limit) if cache is not None else None
    if cache_key is not None and cache_key in cache:
        return cache[cache_key]

    active_set = state._active_by_type.get(object_type)
    if not active_set:
        result: list[str] = []
        if cache_key is not None:
            cache[cache_key] = result
        return result
    # [resource/permanent-object handling — disabled, kept for reference]
    # current_time = getattr(state, 'current_time', None)
    # is_resource = object_type in getattr(state, '_resource_types', set())
    result = []
    for oid in active_set:
        # if is_resource and current_time is not None:
        #     obj = state.objects.get(oid)
        #     if obj and obj.busy_until is not None and obj.busy_until > current_time:
        #         continue  # resource occupied — skip
        result.append(oid)
        if limit > 0 and len(result) >= limit:
            break
    if cache_key is not None:
        cache[cache_key] = result
    return result


def _find_objects_preferring_linked(
    state: SimulationState,
    existing_ids: list[str],
    participating_set: set[str],
    count: int,
) -> list[str]:
    """Return up to `count` IDs from `existing_ids`, preferring those
    already linked to any object in `participating_set` — O(1) via index.

    ``participating_set`` must already be a set (the caller maintains it
    incrementally alongside its participating-ids list) — avoids rebuilding
    a set from scratch on every one of the many calls made per candidate.
    """
    if not participating_set or not state._links_by_object:
        return existing_ids[:count]

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


def _sample_create_count(binding, rng) -> int:
    """How many new objects this creating binding produces for one event.

    Draws from the binding's measured distribution (count, weight) pairs —
    ParameterDiscovery.discover_creation_counts — so the simulation reproduces
    the log's own spread rather than a fixed number or a uniform guess over
    [min_count, max_count].

    Falls back to min_count when no distribution is available: a hand-written
    model, the arc-list format, or a model loaded without an event log.
    """
    counts = getattr(binding, 'create_counts', ()) or ()
    if not counts or rng is None:
        return max(1, binding.min_count)
    total = 0
    for _c, w in counts:
        total += w
    if total <= 0:
        return max(1, binding.min_count)
    threshold = rng.random() * total
    acc = 0
    for c, w in counts:
        acc += w
        if threshold < acc:
            return c
    return counts[-1][0]


def build_candidate_for_activity(
    activity: Activity,
    state: SimulationState,
    resource_types: set[str] | None = None,
    force_object_id: str | None = None,
    force_object_ids: list[str] | None = None,
    pool_cache: dict[tuple, list[str]] | None = None,
    rng=None,
) -> Optional[Candidate]:
    """Build a candidate for ``activity`` from the global active-object pool.

    ``resource_types`` is the set of object type names classified as reusable
    resources. ``force_object_id`` pins the first non-creating, non-resource
    binding to exactly that object, avoiding the temporary _active_by_type
    mutation used in _generate_candidates_des (#6).
    ``force_object_ids`` pins a specific set of objects for all-mode obligations
    where all objects must participate together in the candidate event.
    ``pool_cache`` memoizes find_active_objects_of_type(object_type, limit)
    results across the many candidates built within one read-only
    candidate-generation pass (state does not mutate mid-pass — see
    Simulator._generate_candidates_des).
    ``rng`` is the simulator's seeded generator, used to sample how many
    objects a creating binding produces (see _sample_create_count). Passing
    None keeps the old fixed min_count behaviour, which is what the smoke
    scripts and any caller without a simulator get.
    """
    participating_object_ids: list[str] = []
    # Maintained alongside participating_object_ids so _find_objects_preferring_linked
    # doesn't have to rebuild a set from the list on every call within this candidate.
    participating_object_ids_set: set[str] = set()
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

    # Whether force_object_id has been pinned yet. Tracked explicitly rather
    # than inferred from `len(participating_object_ids) == 0`: a creates-binding
    # that appears earlier in activity.bindings can reuse an existing object and
    # so make the participant list non-empty before the primary binding is
    # reached (e.g. Order Empty Containers, whose Container binding precedes its
    # Transport Document binding). The old test then silently failed to pin the
    # forced object, and the normal link-preference path picked an arbitrary
    # instance of that type instead — so _generate_candidates_des believed it
    # was producing one candidate per active primary object while actually
    # producing duplicates for one object and skipping others entirely.
    _forced_primary_used = False
    for binding in activity.bindings:
        # #6: if force_object_id pins this binding's type, the pool is replaced
        # outright below — skip the (potentially expensive) full-pool lookup.
        is_forced_primary = (
            force_object_id is not None
            and not _forced_primary_used
            and not binding.creates
            and binding.object_type == _forced_type
        )
        is_forced_set = (
            not is_forced_primary
            and force_object_ids is not None
            and not binding.creates
            and binding.object_type in _forced_ids_by_type
        )

        if is_forced_primary:
            _forced_primary_used = True
            obj = state.objects.get(force_object_id)
            if obj is None or not obj.active:
                return None
            existing_ids = [force_object_id]
        elif is_forced_set:
            forced = _forced_ids_by_type[binding.object_type]
            # Verify all forced objects are active
            for _foid in forced:
                _fobj = state.objects.get(_foid)
                if _fobj is None or not _fobj.active:
                    return None
            existing_ids = forced
        else:
            # Determine how many objects to fetch for link-preference selection.
            if binding.creates:
                fetch_limit = binding.min_count
            elif binding.max_count is not None:
                fetch_limit = max(binding.max_count * 4, 8)
            else:
                fetch_limit = 8
            existing_ids = find_active_objects_of_type(
                state, binding.object_type, limit=fetch_limit, cache=pool_cache
            )

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
                state, existing_ids, participating_object_ids_set, selected_from_existing
            )
            if len(selected_ids) < eligibility_count:
                # Not enough input objects to satisfy this binding
                return None

            participating_object_ids.extend(selected_ids)
            participating_object_ids_set.update(selected_ids)
        else:
            # Output binding: this activity brings new objects of this type into
            # existence. How many is SAMPLED FROM THE LOG — see
            # ParameterDiscovery.discover_creation_counts, merged onto the
            # binding as create_counts — and the event is NOT topped up to
            # max_count with objects that already exist.
            #
            # What this replaces: create min_count objects, then fill the
            # remaining (max_count - min_count) slots from the active pool,
            # preferring linked objects but falling back to arbitrary unlinked
            # ones. Both halves were wrong.
            #
            #   * min_count under-creates. `Order Empty Containers` is
            #     Container[C 1..5] and the log creates 1-5 per event, mean
            #     3.38 — the engine always made exactly 1, which starved every
            #     downstream Container activity.
            #   * the top-up models something the log never shows for a genuine
            #     creator: 0 of 593 `Order Empty Containers` events involve a
            #     container seen earlier. Worse, the unlinked fallback pulls an
            #     object away from the o2o partner it already has. The log says
            #     `Container -> Transport Document` is 1..1, so a recycled
            #     container arriving alongside a second document is correctly
            #     refused by check_o2o_rules and the activity stops firing.
            #
            # min_count/max_count still describe how many objects of this type
            # are *present* in the event, which for a creating binding is a
            # different quantity from how many are new. Re-use therefore covers
            # only the shortfall against min_count — never the gap up to
            # max_count. That is what lets an activity the log shows as a
            # near-pure re-user work correctly: `Load Truck` is Truck[C 1..1]
            # but creates a new Truck in 6 of 10553 events, so it samples 0 and
            # takes the truck the container is already linked to.
            #
            # [resource/permanent-object handling — disabled, kept for reference]
            # Resource types come from the pre-populated pool only.
            # if binding.object_type in _resource_types:
            #     eligibility_count = binding.min_count
            #     target_count = binding.min_count
            #     selected_from_existing = min(len(existing_ids), target_count,
            #                                  binding.max_count if binding.max_count is not None else len(existing_ids))
            #     selected_ids = existing_ids[:selected_from_existing]
            #     if len(selected_ids) < eligibility_count:
            #         return None
            #     participating_object_ids.extend(selected_ids)
            #     participating_object_ids_set.update(selected_ids)
            #     continue

            create_count = _sample_create_count(binding, rng)

            need_existing = max(0, binding.min_count - create_count)
            selected_ids = _find_objects_preferring_linked(
                state, existing_ids, participating_object_ids_set, need_existing
            )

            shortfall = need_existing - len(selected_ids)
            if shortfall > 0:
                # Bootstrap. The log says this event normally re-uses objects,
                # but not enough exist yet — on an empty pool a distribution
                # dominated by 0 would stall the activity forever, and nothing
                # else would ever create the first instance. Create the
                # shortfall instead.
                create_count += shortfall

            if binding.max_count is not None:
                # Defensive: a sampled count cannot exceed what the log showed,
                # but a hand-edited max_count could be lower than the measured
                # distribution.
                create_count = max(0, min(create_count,
                                          binding.max_count - len(selected_ids)))

            participating_object_ids.extend(selected_ids)
            participating_object_ids_set.update(selected_ids)

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
        guard = getattr(binding, 'guard', None)
        if guard:
            existing_ids = apply_guard_filter(existing_ids, guard, state)

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

