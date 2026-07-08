"""Diagnostic: why does the discovered Bundestag OC-Declare model not simulate?

This script does NOT modify any production code. It reproduces exactly what the
backend `/api/simulate` endpoint does (parse the model, build a SimulationConfig
with a single start activity, run the Simulator with tracing) and reports:

  1. Model summary (activities / object types / constraints).
  2. Which activities are "start-capable" from an empty state — i.e. they have
     NO `creates=False` input binding, so the engine can bootstrap them.
     (build_candidate_for_activity returns None for any activity that needs a
     pre-existing object, because the state starts empty.)
  3. Which object types are never created by any activity (dead inputs).
  4. The alphabetically-first activity = what the UI auto-selects as start.
  5. Run A: simulate with the UI-default start activity  -> reproduce failure.
  6. Run B: simulate with a sensible start activity      -> show it can run.

Usage:
    python3.13 src/Scripts/diagnose_bundestag_simulation.py
"""
from __future__ import annotations

import os
import sys
import json
from collections import Counter

# Ensure the project root is importable when run as `python3.13 src/Scripts/...`
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict
from src.Simulation.Engine.simulator import Simulator
from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Domain.state import SimulationState

OCDECLARE_DIR = os.path.join(
    os.path.dirname(__file__), "..", "Simulation", "IO", "input", "ocdeclare"
)
MODEL_FILE = os.path.join(
    OCDECLARE_DIR,
    "discovered_Period20_procedure_steps_all_additional_event_types_filtered_20260609_163340.json",
)


def start_capable(activity) -> bool:
    """True if the activity can fire from an empty state.

    The candidate builder requires >=1 existing object for every binding with
    creates=False. From an empty state none exist, so an activity is only
    bootstrappable if it has zero creates=False bindings.
    """
    return all(b.creates for b in activity.bindings) and len(activity.bindings) > 0


def run_once(static_model, start_activity: str, max_steps: int = 50):
    """Replicate the server's Simulator run (without the transition matrix,
    which is irrelevant to whether candidates exist) and capture the stop reason.
    """
    traces = []

    def trace_func(event: str, payload: dict):
        if event in ("iteration", "stop", "chosen"):
            traces.append((event, payload))

    config = SimulationConfig(
        max_steps=max_steps,
        seed=42,
        start_policy=StartPolicy(start_activity_names=[start_activity], max_case_starts=None),
        anchor_object_types=[ot.name for ot in static_model.object_types],
    )
    sim = Simulator(static_model, config, rng=None, trace_func=trace_func)
    final_state = sim.run(state=SimulationState())

    n_events = len(final_state.executed_events)
    # First iteration's candidate count
    first_iter = next((p for e, p in traces if e == "iteration"), None)
    first_num_candidates = first_iter.get("num_candidates") if first_iter else None
    # Candidate-pool size across all iterations (KiP "everything enabled" signal)
    cand_counts = [p.get("num_candidates", 0) for e, p in traces if e == "iteration"]
    max_candidates = max(cand_counts) if cand_counts else 0
    avg_candidates = round(sum(cand_counts) / len(cand_counts), 1) if cand_counts else 0
    stop = next((p for e, p in traces if e == "stop"), None)
    seq = [e.activity_name for e in final_state.executed_events]
    return {
        "events": n_events,
        "first_num_candidates": first_num_candidates,
        "avg_candidates_per_step": avg_candidates,
        "max_candidates_per_step": max_candidates,
        "stop_reason": (stop or {}).get("reason"),
        "stop_step": (stop or {}).get("step_count"),
        "sequence_head": seq[:12],
        "objects_created": len(final_state.objects),
    }


def main() -> None:
    print(f"Loading model: {os.path.basename(MODEL_FILE)}\n")
    with open(MODEL_FILE, "r", encoding="utf-8") as f:
        model_data = json.load(f)
    static_model = parse_ocdeclare_dict(model_data)

    acts = static_model.activities
    print("== MODEL SUMMARY ==")
    print(f"object types : {len(static_model.object_types)}")
    print(f"activities   : {len(acts)}")
    print(f"constraints  : {len(static_model.constraints)}")
    print(f"o2o rules    : {len(static_model.o2o_rules)}")

    # Which object types are created by some activity?
    created_types = set()
    for a in acts:
        for b in a.bindings:
            if b.creates:
                created_types.add(b.object_type)
    all_types = {ot.name for ot in static_model.object_types}
    never_created = sorted(all_types - created_types)

    # Start-capable activities (can bootstrap from empty state)
    capable = [a for a in acts if start_capable(a)]
    print("\n== START-CAPABLE ACTIVITIES (no creates=False binding) ==")
    print(f"count: {len(capable)} of {len(acts)}")
    for a in capable[:40]:
        creates = sorted({b.object_type for b in a.bindings if b.creates})
        print(f"   {a.name!r}  creates -> {creates}")

    print(f"\n== OBJECT TYPES NEVER CREATED BY ANY ACTIVITY ({len(never_created)}) ==")
    for t in never_created:
        print(f"   {t}")

    # What the UI auto-selects: first activity in the list (alphabetical here)
    ui_default_start = acts[0].name if acts else None
    print("\n== UI DEFAULT START ACTIVITY (modelActivities[0]) ==")
    print(f"   {ui_default_start!r}")
    ui_default_act = acts[0]
    print(f"   start-capable? {start_capable(ui_default_act)}")
    print(f"   bindings: {[(b.object_type, 'create' if b.creates else 'input') for b in ui_default_act.bindings]}")

    # ── Run A: reproduce failure with UI default start activity ──
    print("\n" + "=" * 70)
    print(f"RUN A — start activity = UI default {ui_default_start!r}")
    print("=" * 70)
    res_a = run_once(static_model, ui_default_start)
    for k, v in res_a.items():
        print(f"   {k}: {v}")

    # ── Run B: pick a sensible start that creates 'Gesetzgebung' if available ──
    preferred = None
    for a in capable:
        if any(b.object_type == "Gesetzgebung" and b.creates for b in a.bindings):
            preferred = a.name
            break
    if preferred is None and capable:
        preferred = capable[0].name

    print("\n" + "=" * 70)
    print(f"RUN B — start activity = sensible start {preferred!r}")
    print("=" * 70)
    if preferred:
        res_b = run_once(static_model, preferred)
        for k, v in res_b.items():
            print(f"   {k}: {v}")
    else:
        print("   No start-capable activity exists — model cannot bootstrap at all.")

    # ── Verdict ──
    print("\n" + "=" * 70)
    print("DIAGNOSIS")
    print("=" * 70)
    if not start_capable(ui_default_act):
        print(f"- UI default start {ui_default_start!r} has creates=False input bindings,")
        print("  so from an empty state the candidate builder returns None -> 0 candidates")
        print(f"  -> simulation stops immediately (reason={res_a['stop_reason']}).")
    if preferred and start_capable(acts_by_name(acts, preferred)):
        print(f"- A start-capable activity like {preferred!r} DOES run "
              f"({locals().get('res_b', {}).get('events')} events).")
    print(f"- {len(never_created)} object types are never created by any activity;")
    print("  activities depending only on those can never fire from an empty state.")


def acts_by_name(acts, name):
    return next(a for a in acts if a.name == name)


if __name__ == "__main__":
    main()
