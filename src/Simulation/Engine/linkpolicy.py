from __future__ import annotations

from typing import Iterable

from src.Simulation.Domain.ir import StaticModel
from src.Simulation.Domain.state import SimulationState


def apply_conservative_link_policy(static_model: StaticModel, participating_ids: Iterable[str], created_object_ids: Iterable[str], state: SimulationState) -> None:
    """Conservative default link-creation policy.

    For each newly created object, try to create a single link between it and the
    first matching participating runtime object according to static_model.o2o_rules.

    This preserves the previous behavior but centralizes the policy so it can be
    replaced or extended without modifying Simulator.
    """
    # map runtime object ids to types for fast lookup
    for created_id in created_object_ids:
        created_obj = state.objects.get(created_id)
        if created_obj is None:
            continue
        created_type = created_obj.object_type

        linked = False
        for pid in participating_ids:
            p_obj = state.objects.get(pid)
            if p_obj is None:
                continue
            p_type = p_obj.object_type

            for rule in static_model.o2o_rules:
                # If rule describes a link from participating object type -> created object type
                if rule.source_type == p_type and rule.target_type == created_type:
                    state.add_link(source_object_id=pid, target_object_id=created_id)
                    linked = True
                    break

                # If rule describes a link from created object type -> participating object type
                if rule.source_type == created_type and rule.target_type == p_type:
                    state.add_link(source_object_id=created_id, target_object_id=pid)
                    linked = True
                    break

            if linked:
                break
