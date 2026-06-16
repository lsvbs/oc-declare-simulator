from __future__ import annotations

"""Focused debug script for the 'Order Empty Containers' activity.

This script mirrors the OC-DECLARE import and simulation setup used in
`smokesimulation.py` but adds detailed diagnostics at each iteration for the
`Order Empty Containers` activity:

- Whether a candidate can be built from the current state.
- Per-binding availability (min/max, creates/deactivates, active object count).
- If a candidate exists, which declarative constraints (if any) reject it.

Run it with:

    python -m src.Scripts.testOrderEmptyContainer

Optionally set `SMOKE_ITER_TRACE=1` to enable per-iteration tracing (same
environment variable as in `smokesimulation.py`).
"""

import os
from datetime import datetime
from dataclasses import replace
from typing import Any

from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Domain.state import SimulationState
from src.Simulation.Engine.candidategeneration import (
    build_candidate_for_activity,
    find_active_objects_of_type,
    is_candidate_semantically_allowed,
)
from src.Simulation.Engine.semantics import check_constraint
from src.Simulation.Engine.simulator import Simulator
from src.Simulation.IO.output.OCEL2 import write_ocel2_json
from src.Simulation.Models.OCDeclare import (
    IO_INPUT_DIR,
    import_first_ocdeclare_in_input,
    derive_provisional_lifecycle_from_list,
)


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


def print_final_state(state: SimulationState) -> None:
    print("\n=== FINAL SIMULATION STATE ===")
    print(f"Step count: {state.step_count}")
    print(f"Objects: {len(state.objects)}")
    print(f"Executed events: {len(state.executed_events)}")

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


def apply_start_activity_override(static_model: Any, activity_name: str, object_type: str) -> Any:
    """Same helper as in smokesimulation: mark one binding as creator.

    This lets the chosen activity bootstrap objects of `object_type` from an
    empty state for smoke/debug runs.
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


def debug_order_empty_containers(static_model: Any, state: SimulationState) -> None:
    """Print detailed diagnostics for the 'Order Empty Containers' activity.

    At each call, this function:
    - Attempts to build a candidate for 'Order Empty Containers' using
      the *global* candidate builder.
    - Shows per-binding availability and lifecycle flags.
    - If a candidate exists, runs each constraint and prints which ones
      (if any) reject the candidate.
    """

    target_name = "Order Empty Containers"
    activity = next((a for a in static_model.activities if a.name == target_name), None)
    if activity is None:
        print("    [OEC-debug] Activity 'Order Empty Containers' not found in static model")
        return

    print("    [OEC-debug] ----")

    # Per-binding availability
    for b in activity.bindings:
        existing_ids = find_active_objects_of_type(state, b.object_type)
        print(
            "    [OEC-debug] binding:"  # one line per binding
            f" type={b.object_type} min={b.min_count} max={b.max_count} "
            f"creates={b.creates} deactivates={b.deactivates} "
            f"active_count={len(existing_ids)}"
        )

    # Attempt to build a global candidate for OEC
    candidate = build_candidate_for_activity(activity, state)
    if candidate is None:
        print("    [OEC-debug] candidate=None (not buildable from current state)")
        return

    print(
        "    [OEC-debug] candidate built: "
        f"objs={candidate.participating_object_ids} "
        f"create={candidate.object_types_to_create}"
    )

    # Check declarative constraints one by one
    allowed_by_all = is_candidate_semantically_allowed(static_model, candidate, state)
    print(f"    [OEC-debug] is_candidate_semantically_allowed={allowed_by_all}")

    for constraint in static_model.constraints:
        ok = check_constraint(constraint, candidate, state)
        if not ok:
            print(
                "    [OEC-debug] REJECTED by constraint: "
                f"{constraint.constraint_type} "
                f"{constraint.source_activity}->{constraint.target_activity} "
                f"(scope={constraint.scope.kind}:{constraint.scope.object_type})"
            )


def main() -> None:
    # Load OC-DECLARE JSON as in smokesimulation
    from pathlib import Path
    import json as _json

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

    # Simulation configuration (reuse smoke defaults)
    start_policy = StartPolicy(
        start_activity_names=["Register Customer Order"],
        max_case_starts=None,
    )

    config = SimulationConfig(
        start_policy=start_policy,
        anchor_object_types=["Customer Order"],
        max_steps=10,
    )

    def trace_func(event: str, payload: dict) -> None:
        # Per-iteration debug, plus focused OEC diagnostics
        if event == "iteration":
            step = payload.get("step_count")
            print(f"[iter] step={step} candidates={payload.get('num_candidates')}")
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

            # Focused diagnostics for 'Order Empty Containers'
            debug_order_empty_containers(static_model, state_ref[0])

        elif event == "chosen":
            print(
                f"[pick] {payload.get('activity_name')} "
                f"create={payload.get('object_types_to_create')}"
            )
        elif event == "applied":
            print(
                f"[done] {payload.get('event_id')} time={payload.get('timestamp')} "
                f"objects={payload.get('object_ids')}"
            )
        elif event == "stop":
            print(
                f"[stop] reason={payload.get('reason')} step={payload.get('step_count')}"
            )

    # We need a mutable reference to the state inside trace_func; we keep it in a
    # single-element list so the closure can see updates.
    state_ref: list[SimulationState] = [SimulationState()]

    # Wrap the simulator to update state_ref on each run step
    simulator = Simulator(static_model, config, trace_func=trace_func)
    final_state = simulator.run(state_ref[0])

    print_final_state(final_state)
    print_object_lifecycle_summary(final_state)

    filename = f"testOrderEmptyContainer_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out_path = write_ocel2_json(final_state, filename=filename, log_id="testOrderEmptyContainer")
    print(f"\nWrote OCEL 2.0 JSON to: {out_path}")


if __name__ == "__main__":
    main()
