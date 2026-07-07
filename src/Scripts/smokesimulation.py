from __future__ import annotations

import os
import json
from datetime import datetime
from dataclasses import replace
from typing import Any

from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Domain.state import SimulationState
from src.Simulation.Engine.candidategeneration import build_candidate_for_activity
from src.Simulation.Engine.simulator import Simulator
from src.Simulation.IO.output.OCEL2 import write_ocel2_json
from src.Simulation.Models.OCDeclare import import_first_ocdeclare_in_input, derive_provisional_lifecycle_from_list


def print_static_model_summary(static_model: Any) -> None:
    print("=== STATIC MODEL SUMMARY ===")
    print(f"Activities: {len(static_model.activities)}")
    print(f"Object types: {len(static_model.object_types)}")
    print(f"Constraints: {len(static_model.constraints)}")
    print(f"O2O rules: {len(static_model.o2o_rules)}")

    if static_model.activities:
        print("\nActivity names:")
        for activity in static_model.activities:
            binding_summary = [
                f"{binding.object_type}[{binding.min_count},{binding.max_count}]"
                for binding in getattr(activity, "bindings", [])
            ]
            print(f"  - {activity.name}: {binding_summary}")

    if static_model.constraints:
        print("\nConstraints:")
        for constraint in static_model.constraints:
            print(
                f"  - {constraint.constraint_type}: "
                f"{constraint.source_activity} -> {constraint.target_activity} "
                f"(scope={constraint.scope.kind}:{constraint.scope.object_type})"
            )


def build_ocel_like_view(state: SimulationState) -> dict[str, Any]:
    events = {
        event.event_id: {
            "type": event.activity_name,
            "time": event.timestamp.isoformat() if event.timestamp is not None else None,
            "relationships": [
                {"objectId": object_id, "qualifier": None}
                for object_id in event.object_ids
            ],
        }
        for event in state.executed_events
    }

    objects = {
        object_id: {
            "type": runtime_object.object_type,
            "attributes": {
                "status": runtime_object.status,
                "active": runtime_object.active,
            },
        }
        for object_id, runtime_object in state.objects.items()
    }

    object_links = [
        {
            "source": link.source_object_id,
            "target": link.target_object_id,
        }
        for link in state.links
    ]

    return {
        "eventTypes": sorted({event.activity_name for event in state.executed_events}),
        "objectTypes": sorted({runtime_object.object_type for runtime_object in state.objects.values()}),
        "events": events,
        "objects": objects,
        "objectRelations": object_links,
    }


def print_final_state(state: SimulationState) -> None:
    print("\n=== FINAL SIMULATION STATE ===")
    print(f"Step count: {state.step_count}")
    print(f"Objects: {len(state.objects)}")
    print(f"Executed events: {len(state.executed_events)}")
    print(f"Pending obligations: {len(state.pending_obligations)}")

    if state.executed_events:
        print("\nExecuted events:")
        for event in state.executed_events:
            print(
                f"  - {event.event_id}: {event.activity_name} "
                f"at {event.timestamp} with {event.object_ids}"
            )
    else:
        print("\nExecuted events:\n  (none)")


def print_object_lifecycle_summary(state: SimulationState) -> None:
    """Print how many objects of each type are active vs inactive.

    This provides a quick lifecycle sanity check after a simulation run.
    """
    from collections import Counter

    total = Counter()
    active = Counter()

    for obj in state.objects.values():
        total[obj.object_type] += 1
        if obj.active:
            active[obj.object_type] += 1

    print("\n=== OBJECT LIFECYCLE SUMMARY ===")
    if not total:
        print("  (no objects)")
        return

    for ot in sorted(total.keys()):
        t = total[ot]
        a = active[ot]
        print(f"  {ot}: total={t}, active={a}, inactive={t - a}")


def print_step_trace(state: SimulationState) -> None:
    """Print a readable, linear trace of what happened (based on executed events)."""

    print("\n=== SIMULATION TRACE (executed events) ===")
    if not state.executed_events:
        print("  (no events executed)")
        return

    for i, event in enumerate(state.executed_events, start=1):
        ts = event.timestamp.isoformat() if event.timestamp is not None else None
        print(f"  {i}. {event.event_id}: {event.activity_name} time={ts}")
        print(f"     objects: {event.object_ids}")


def print_candidate_diagnostics(static_model: Any) -> None:
    print("\n=== CANDIDATE GENERATION DIAGNOSTICS ===")
    empty_state = SimulationState()
    generatable = 0

    for activity in static_model.activities:
        candidate = build_candidate_for_activity(activity, empty_state)
        if candidate is not None:
            generatable += 1
            print(
                f"  + {activity.name}: candidate can be built "
                f"(existing={candidate.participating_object_ids}, creates={candidate.object_types_to_create})"
            )
            continue

        blocking_reasons: list[str] = []
        for binding in getattr(activity, "bindings", []):
            if binding.max_count is not None and binding.max_count < binding.min_count:
                blocking_reasons.append(
                    f"invalid binding {binding.object_type}: max_count < min_count"
                )
                continue

            if binding.min_count > 0 and not binding.creates:
                blocking_reasons.append(
                    f"needs {binding.min_count} existing '{binding.object_type}' objects but creates=False"
                )

        if not blocking_reasons:
            blocking_reasons.append("candidate blocked by downstream constraints or unsupported binding shape")

        print(f"  - {activity.name}: cannot build candidate")
        for reason in blocking_reasons:
            print(f"      reason: {reason}")

    print(f"\nStartable activities from empty state: {generatable} / {len(static_model.activities)}")


def apply_start_activity_override(static_model: Any, activity_name: str, object_type: str) -> None:
    """Bootstrap helper for smoke testing.

    Marks the binding for `object_type` on `activity_name` as `creates=True` so the
    activity can act as an initial creator from an empty simulation state.
    """
    new_activities = []

    for activity in static_model.activities:
        if activity.name != activity_name:
            new_activities.append(activity)
            continue

        new_bindings = []
        for binding in activity.bindings:
            if binding.object_type == object_type:
                new_bindings.append(replace(binding, creates=True))
            else:
                new_bindings.append(binding)

        new_activities.append(replace(activity, bindings=new_bindings))

    return replace(static_model, activities=new_activities)


def main() -> None:
    # Load the first OC-Declare JSON. When the file is a list of arcs (as in
    # example1.json), we can also derive a *provisional* notion of where
    # objects of each type are "initialized" and "exit" the process based on
    # tuple structure alone. This is **only** for diagnostics; in a full
    # evaluation setting, such lifecycle information should be derived from an
    # OCEL log by looking at first/last related events per object.

    # For now, we re-open the JSON here to feed the arc list into the
    # lifecycle helper. This keeps the StaticModel clean of creation semantics.
    from pathlib import Path
    import json as _json
    from src.Simulation.Models.OCDeclare import IO_INPUT_DIR

    # Reuse the same choice logic as import_first_ocdeclare_in_input
    files = sorted(IO_INPUT_DIR.glob("*.json"))
    if not files:
        raise FileNotFoundError(f"No OC-Declare JSON files found in {IO_INPUT_DIR}")

    chosen = None
    for f in files:
        if f.name == "example1.json":
            chosen = f
            break
    if chosen is None:
        chosen = files[0]

    with chosen.open("r", encoding="utf-8") as fh:
        raw_data = _json.load(fh)

    lifecycle_info = {}
    if isinstance(raw_data, list):
        lifecycle_info = derive_provisional_lifecycle_from_list(raw_data)

    static_model = import_first_ocdeclare_in_input(lifecycle_mode="simple_arcs")
    static_model = apply_start_activity_override(
        static_model,
        activity_name="Register Customer Order",
        object_type="Customer Order",
    )
    print_static_model_summary(static_model)

    if lifecycle_info:
        print("\n=== PROVISIONAL OBJECT LIFECYCLE (from OC-DECLARE arcs) ===")
        entry = lifecycle_info.get("entry", {})
        exit_ = lifecycle_info.get("exit", {})

        for ot in sorted(set(entry.keys()) | set(exit_.keys())):
            e_acts = sorted(entry.get(ot, []))
            x_acts = sorted(exit_.get(ot, []))
            print(f"  - {ot}:")
            print(f"      entry activities: {e_acts if e_acts else '[] (none derived)'}")
            print(f"      exit activities:  {x_acts if x_acts else '[] (none derived)'}")
    print_candidate_diagnostics(static_model)

    # Configure simulation with an explicit start policy and case anchor types.
    # For this smoke model, "Register Customer Order" is the case-start activity
    # and "Customer Order" is the primary case anchor object type.
    start_policy = StartPolicy(
        start_activity_names=["Register Customer Order"],
        max_case_starts=None,  # no explicit global limit for now
    )

    # For debugging, cap the run at a small number of steps so we can
    # comfortably inspect per-iteration diagnostics.
    config = SimulationConfig(
        start_policy=start_policy,
        anchor_object_types=["Customer Order"],
        max_steps=10,
    )

    def trace_func(event: str, payload: dict) -> None:
        # Keep it compact and readable.
        if event == "iteration":
            print(
                f"[iter] step={payload.get('step_count')} candidates={payload.get('num_candidates')}"
            )
            # Detailed candidate pool
            for i, cand in enumerate(payload.get("candidates", []), start=1):
                print(
                    f"    cand[{i}]: act={cand.get('activity_name')} "
                    f"objs={cand.get('participating_object_ids')} "
                    f"create={cand.get('object_types_to_create')}"
                )
            # Snapshot of active objects
            active_objects = payload.get("active_objects", [])
            if active_objects:
                print("    active objects:")
                for obj in active_objects:
                    print(
                        f"      - id={obj.get('id')} type={obj.get('type')} "
                        f"active={obj.get('active')}"
                    )
        elif event == "chosen":
            print(
                f"[pick] {payload.get('activity_name')} create={payload.get('object_types_to_create')}"
            )
        elif event == "applied":
            print(
                f"[done] {payload.get('event_id')} time={payload.get('timestamp')} objects={payload.get('object_ids')}"
            )
        elif event == "stop":
            print(f"[stop] reason={payload.get('reason')} step={payload.get('step_count')}")

    iter_trace_enabled = os.getenv("SMOKE_ITER_TRACE", "0") == "1"
    simulator = Simulator(static_model, config, trace_func=trace_func if iter_trace_enabled else None)
    final_state = simulator.run()

    print_final_state(final_state)
    print_object_lifecycle_summary(final_state)

    if not static_model.activities:
        print("\nWARNING: The imported static model has no activities, so the simulator cannot generate any events.")
    elif not final_state.executed_events:
        print("\nWARNING: The model loaded, but the simulator produced no events. This usually means no valid candidates could be generated.")

    # Optional trace printing (useful when something feels off)
    if os.getenv("SMOKE_TRACE", "0") == "1":
        print_step_trace(final_state)

    # Always export a proper OCEL 2.0 JSON file into eventlogs/.
    filename = f"smokesimulation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out_path = write_ocel2_json(final_state, filename=filename, log_id="smokesimulation")
    print(f"\nWrote OCEL 2.0 JSON to: {out_path}")


if __name__ == "__main__":
    main()
