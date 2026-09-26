"""Plan the simulator's O2O effects without changing state or consuming randomness.

O2O rules are simulation parameters, not OC-Declare temporal constraints. The
conservative policy links rule-covered pairs in one candidate, including pairs
of new objects. A candidate is rejected if that complete plan exceeds a maximum;
we do not silently drop links or invent a matching between ambiguous batches.
Minimums describe accumulated lifetime relationships and are audited post-run.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from typing import Sequence

from Backend.src.Simulation.Domain.ir import StaticModel
from Backend.src.Simulation.Domain.state import SimulationState


# Strings refer to existing objects; integers refer to the ordered creation list.
ObjectRef = str | int


@dataclass(frozen=True)
class O2OLinkPlan:
    links: tuple[tuple[ObjectRef, ObjectRef], ...] = ()

    def apply(self, state: SimulationState, created_object_ids: list[str]) -> None:
        """Apply a validated plan immediately after allocating its new objects."""
        def resolve(ref: ObjectRef) -> str:
            return created_object_ids[ref] if isinstance(ref, int) else ref

        for source, target in self.links:
            state.add_link(resolve(source), resolve(target))


def plan_o2o_links(
    static_model: StaticModel,
    participating_ids: list[str],
    state: SimulationState,
    object_types_to_create: Sequence[str] = (),
) -> O2OLinkPlan | None:
    """Return all proposed links, or None when an applicable maximum is exceeded.

    Existing and proposed links count as distinct partners, using the same
    symmetric adjacency as binding and transitive-scope lookup. A directional
    rule bounds only its source objects; bidirectional rules bound both sides.
    All rules apply conjunctively, including separate asymmetric reverse rules.
    No object IDs are allocated until this plan has passed validation.
    """
    if not static_model.o2o_rules:
        return O2OLinkPlan()

    by_type: dict[str, list[ObjectRef]] = {}
    types: dict[ObjectRef, str] = {}
    for oid in sorted(set(participating_ids)):
        obj = state.objects.get(oid)
        if obj is None:
            return None
        types[oid] = obj.object_type
        by_type.setdefault(obj.object_type, []).append(oid)
    for index, object_type in enumerate(object_types_to_create):
        types[index] = object_type
        by_type.setdefault(object_type, []).append(index)

    links: dict[frozenset[ObjectRef], tuple[ObjectRef, ObjectRef]] = {}
    increments: dict[tuple[ObjectRef, str], int] = {}
    for rule in static_model.o2o_rules:
        for source, target in product(by_type.get(rule.source_type, ()),
                                      by_type.get(rule.target_type, ())):
            if source == target:
                continue
            key = frozenset((source, target))
            if key in links or target in state._links_by_object.get(source, ()):
                continue
            links[key] = (source, target)
            for obj, other in ((source, target), (target, source)):
                count_key = (obj, types[other])
                increments[count_key] = increments.get(count_key, 0) + 1

    for rule in static_model.o2o_rules:
        if rule.max_links is None:
            continue
        directions = [(rule.source_type, rule.target_type)]
        if rule.bidirectional and rule.source_type != rule.target_type:
            directions.append((rule.target_type, rule.source_type))
        for source_type, target_type in directions:
            # Preserve candidate-local enabling: an unrelated activity need not
            # repair a supplied state's existing relationship violations.
            if target_type not in by_type:
                continue
            for source in by_type.get(source_type, ()):
                existing = len(state._linked_by_type.get(source, {}).get(target_type, ()))
                if existing + increments.get((source, target_type), 0) > rule.max_links:
                    return None

    return O2OLinkPlan(tuple(links.values()))
