from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal, Set

from src.Simulation.Domain.ir import StaticModel
from src.Simulation.Domain.state import SimulationState


@dataclass(frozen=True)
class TransitiveType:
    """Simple representation of a transitive object type (ot1,>,ot2) or (ot1,<,ot2).

    - from_type: starting object type (ot1)
    - direction: ">" means we follow O2O edges forward from from_type towards to_type,
                 "<" means we conceptually follow edges backwards.
    - to_type: target object type (ot2)
    """

    from_type: str
    direction: Literal["<", ">"]
    to_type: str


def neighbors_by_type(state: SimulationState, start_object_id: str) -> dict[str, list[str]]:
    """Return 1-hop neighbors of `start_object_id` grouped by object_type — O(degree)."""
    result: dict[str, list[str]] = {}

    start_obj = state.objects.get(start_object_id)
    if start_obj is not None and start_obj.active:
        result.setdefault(start_obj.object_type, []).append(start_object_id)

    for other_id in state._links_by_object.get(start_object_id, ()):
        other = state.objects.get(other_id)
        if other is None or not other.active:
            continue
        result.setdefault(other.object_type, []).append(other_id)

    return result


def _event_object_ids(event_like: object) -> Iterable[str]:
    """Extract object_ids from either an ExecutedEvent or a Candidate-like object.

    - ExecutedEvent: expects attribute `object_ids` (list[str])
    - Candidate: expects attribute `participating_object_ids` (list[str])
    """

    ids = getattr(event_like, "object_ids", None)
    if ids is None:
        ids = getattr(event_like, "participating_object_ids", [])
    return list(ids or [])


def obj_L_direct(event_like: object, state: SimulationState, object_type: str) -> Set[str]:
    """Return direct objects of the given type that are attached to an event-like object.

    This corresponds to obj^L_ot(e) without traversing O2O: we only look at
    the event's own object ids.
    """

    result: set[str] = set()
    for oid in _event_object_ids(event_like):
        robj = state.objects.get(oid)
        if robj is None or not robj.active:
            continue
        if robj.object_type == object_type:
            result.add(oid)
    return result


def obj_L_transitive(
    event_like: object,
    state: SimulationState,
    static_model: StaticModel,
    ttype: TransitiveType,
) -> Set[str]:
    """Return objects of `ttype.to_type` indirectly associated with an event.

    This is a first implementation of the paper-style obj^L_{(ot1,>,ot2)}(e):
    starting from direct objects of `from_type` in the event, we follow O2O
    edges defined in the static model until we reach objects of `to_type`.

    Traversal respects O2ORule direction and bidirectionality:
    - direction == ">": we follow edges that go from from_type towards to_type
      (using O2ORule.source_type -> target_type when bidirectional is False).
    - direction == "<": we conceptually follow edges backwards.

    For now this is an unbounded BFS without depth limit; it can be adapted
    later if you want to restrict the radius.
    """

    # Use the pre-built index from state instead of rebuilding it each call
    links_by_object = state._links_by_object

    # Helper to decide if we may traverse from `cur_id` to `nbr_id` given desired
    # logical direction and the types of the two runtime objects.
    def _can_traverse(cur_id: str, nbr_id: str) -> bool:
        cur = state.objects.get(cur_id)
        nbr = state.objects.get(nbr_id)
        if cur is None or nbr is None:
            return False

        ct = cur.object_type
        nt = nbr.object_type

        for rule in static_model.o2o_rules:
            if ttype.direction == ">":
                # We want paths that go "outwards" from from_type towards to_type.
                if rule.bidirectional:
                    if (ct == rule.source_type and nt == rule.target_type) or (
                        ct == rule.target_type and nt == rule.source_type
                    ):
                        return True
                else:
                    if ct == rule.source_type and nt == rule.target_type:
                        return True
            else:  # direction == "<"
                # Invert interpretation for backwards paths.
                if rule.bidirectional:
                    if (ct == rule.source_type and nt == rule.target_type) or (
                        ct == rule.target_type and nt == rule.source_type
                    ):
                        return True
                else:
                    if ct == rule.target_type and nt == rule.source_type:
                        return True
        return False

    # Start from direct from_type objects in the event
    start_ids: set[str] = obj_L_direct(event_like, state, ttype.from_type)
    if not start_ids:
        return set()

    visited: set[str] = set(start_ids)
    frontier: list[str] = list(start_ids)

    reached_to_type: set[str] = set()

    while frontier:
        cur_id = frontier.pop()
        cur_obj = state.objects.get(cur_id)
        if cur_obj is None:
            continue

        if cur_obj.object_type == ttype.to_type and cur_id not in start_ids:
            reached_to_type.add(cur_id)

        for neighbor_id in links_by_object.get(cur_id, ()):
            if neighbor_id in visited:
                continue
            if not _can_traverse(cur_id, neighbor_id):
                continue
            visited.add(neighbor_id)
            frontier.append(neighbor_id)

    return reached_to_type
