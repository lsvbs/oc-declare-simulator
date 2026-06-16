from __future__ import annotations

import os
from datetime import datetime
from dataclasses import replace
from typing import Any

from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Domain.state import SimulationState
from src.Simulation.Engine.candidategeneration import build_candidate_for_activity
from src.Simulation.Engine.simulator import Simulator
from src.Simulation.IO.output.OCEL2 import write_ocel2_json
from src.Simulation.Models.OCDeclare import (
    IO_INPUT_DIR,
    parse_ocdeclare_list,
    derive_provisional_lifecycle_from_list,
    apply_lifecycle_from_provisional_info,
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
    """Print how many objects of each type are active vs inactive."""
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


def apply_start_activity_override(static_model: Any, activity_name: str, object_type: str) -> Any:
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


def _load_example2_static_model() -> tuple[Any, dict[str, Any]]:
    """Load `example2.json` from the OC-DECLARE input folder with lifecycle info.

    This mirrors the logic from `smokesimulation.py` but pins the chosen file
    to `example2.json` when it exists.
    """
    import json as _json

    # Prefer example2.json explicitly; fall back to first JSON if missing.
    chosen = IO_INPUT_DIR / "example2.json"
    if not chosen.exists():
        files = sorted(IO_INPUT_DIR.glob("*.json"))
        if not files:
            raise FileNotFoundError(f"No OC-Declare JSON files found in {IO_INPUT_DIR}")
        chosen = files[0]

    with chosen.open("r", encoding="utf-8") as fh:
        raw_data = _json.load(fh)

    lifecycle_info: dict[str, Any] = {}
    if isinstance(raw_data, list):
        lifecycle_info = derive_provisional_lifecycle_from_list(raw_data)
        static_model = parse_ocdeclare_list(raw_data)
        static_model = apply_lifecycle_from_provisional_info(static_model, lifecycle_info)
    else:
        # For dict-style OC-DECLARE we could import via parse_ocdeclare_dict,
        # but for now we assume example2.json follows the list-of-arcs schema.
        static_model = parse_ocdeclare_list(raw_data)  # type: ignore[arg-type]

    return static_model, lifecycle_info


def main() -> None:
    static_model, lifecycle_info = _load_example2_static_model()

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

    start_policy = StartPolicy(
        start_activity_names=["Register Customer Order"],
        max_case_starts=None,
    )

    config = SimulationConfig(
        start_policy=start_policy,
        anchor_object_types=["Customer Order"],
        max_steps=50,
    )

    def trace_func(event: str, payload: dict) -> None:
        if event == "iteration":
            print(
                f"[iter] step={payload.get('step_count')} candidates={payload.get('num_candidates')}"
            )
            for i, cand in enumerate(payload.get("candidates", []), start=1):
                print(
                    f"    cand[{i}]: act={cand.get('activity_name')} "
                    f"objs={cand.get('participating_object_ids')} "
                    f"create={cand.get('object_types_to_create')}"
                )
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

    if os.getenv("SMOKE_TRACE", "0") == "1":
        print_step_trace(final_state)

    filename = f"smokesimulation2_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out_path = write_ocel2_json(final_state, filename=filename, log_id="smokesimulation2")
    print(f"\nWrote OCEL 2.0 JSON to: {out_path}")


if __name__ == "__main__":
    main()
