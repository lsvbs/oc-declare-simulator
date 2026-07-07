"""
Interactive replay runner for simulations.

Usage (terminal):
    python -m src.Scripts.replay_runner --ocdeclare <path> --ocel <path>

Once started, use commands:
    run [max_steps] [start_activity] [seed]
    set lifecycle_mode [none|simple_arcs]
    show model
    show matrix
    help
    exit

This script loads the StaticModel and initial SimulationState once and then
instantiates a fresh Simulator for every `run` command so runs are isolated.
"""
from __future__ import annotations

import argparse
import json
import shlex
import sys
from typing import Optional

# Make sure package imports work when running as module
import os
sys.path.append(os.path.join(os.path.dirname(__file__), '../Simulation'))

from src.Simulation.Models.OCDeclare import import_ocdeclare_json, import_first_ocdeclare_in_input, derive_provisional_lifecycle_from_list, apply_lifecycle_from_provisional_info
from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Engine.simulator import Simulator
from src.ParameterDiscovery.probabilitydiscovery import discover_transition_matrix, load_event_log
from src.Simulation.Engine.selection import select_candidate
from src.Simulation.IO.output.OCEL2 import write_ocel2_json


def build_default_select_wrapper(prob_matrix: Optional[dict] = None):
    def select_with_matrix(candidates, state, static_model, config=None, rng=None, **kwargs):
        # Print detailed info about this selection step (diagnostics)
        print(f"\n{'='*80}")
        print(f"STEP {state.step_count + 1} - Selection Phase")
        print(f"{'='*80}")

        # Show active objects
        print(f"\nActive objects in state:")
        from collections import Counter
        active_objects = {oid: obj for oid, obj in state.objects.items() if getattr(obj, 'active', True)}
        if active_objects:
            obj_types = Counter(getattr(obj, 'object_type', 'UNKNOWN') for obj in active_objects.values())
            for obj_type, count in sorted(obj_types.items()):
                print(f"  - {obj_type}: {count}")
        else:
            print("  (no active objects yet)")

        # Show candidates
        print(f"\nCandidates available ({len(candidates)} total):")
        for i, c in enumerate(candidates):
            print(f"  {i+1}. {c.activity_name}")
            print(f"     - Participating objects: {getattr(c, 'participating_object_ids', [])}")
            print(f"     - Will create: {getattr(c, 'object_types_to_create', [])}")

        # Show last activity for transition context
        if getattr(state, 'executed_events', None):
            last_activity = state.executed_events[-1].activity_name
            print(f"\nLast executed activity: {last_activity}")
        else:
            last_activity = "__START__"
            print(f"\nLast executed activity: {last_activity} (simulation start)")

        # Show transition probabilities for each candidate
        transition_probs = prob_matrix.get(last_activity, {}) if prob_matrix else {}
        print(f"\nTransition probabilities from '{last_activity}':")
        for c in candidates:
            prob = transition_probs.get(c.activity_name, 0.0)
            print(f"  - {c.activity_name}: {prob:.4f}")

        # Call the actual selection
        selected = select_candidate(candidates=candidates, state=state, static_model=static_model, config=config, rng=rng, transition_matrix=prob_matrix)

        print(f"\n>>> SELECTED: {selected.activity_name}")
        print(f"    Will involve: {getattr(selected, 'participating_object_ids', [])}")
        print(f"    Will create: {getattr(selected, 'object_types_to_create', [])}")

        return selected

    return select_with_matrix


def repl_loop(static_model, initial_state, prob_matrix=None, lifecycle_mode="none", case_insensitive=False):
    # Friendly startup reminder so users know exactly what to type when the
    # runner starts interactively (or when using a heredoc for non-interactive runs).
    print("Interactive replay runner. Type 'help' for commands.")
    print("Quick examples:")
    print("  - Run 30 steps interactively: type -> run 30 <enter>")
    print("  - Run with a specific start and seed: -> run 30 \"Register Customer Order\" 12345")
    print("  - Non-interactive (one-shot) from a shell: \n      python -m src.Scripts.replay_runner --lifecycle simple_arcs <<'EOF'\n      run 30\n      exit\n      EOF")
    print("If you don't see a prompt, make sure you launched this from a real terminal (TTY) and not via a detached stdin.")
    current_lifecycle_mode = lifecycle_mode
    current_prob_matrix = prob_matrix

    while True:
        try:
            raw = input("replay> ")
        except (EOFError, KeyboardInterrupt):
            print("\nExiting replay runner")
            break
        if not raw:
            continue
        parts = shlex.split(raw)
        if not parts:
            continue
        cmd = parts[0].lower()

        if cmd == "exit" or cmd == "quit":
            print("Bye")
            break
        if cmd == "help":
            print("Commands:")
            print("  run [max_steps] [start_activity] [seed]  - run a simulation")
            print("  set lifecycle_mode [none|simple_arcs]   - toggle lifecycle derivation")
            print("  show model                              - print static model summary")
            print("  show matrix                             - print transition matrix summary")
            print("  help                                    - show this help")
            print("  exit                                    - quit")
            continue

        if cmd == "set":
            if len(parts) < 3:
                print("Usage: set lifecycle_mode [none|simple_arcs]")
                continue
            if parts[1] == "lifecycle_mode":
                val = parts[2]
                if val not in ("none", "simple_arcs"):
                    print("Allowed values: none, simple_arcs")
                    continue
                current_lifecycle_mode = val
                print(f"lifecycle_mode set to: {current_lifecycle_mode}")
                continue
            print("Unknown set option")
            continue

        if cmd == "show":
            if len(parts) < 2:
                print("Usage: show model|matrix")
                continue
            if parts[1] == "model":
                print(f"StaticModel: {len(static_model.activities)} activities, {len(static_model.object_types)} object types")
                for a in static_model.activities:
                    binds = [(b.object_type, b.min_count, b.max_count, getattr(b, 'creates', False)) for b in a.bindings]
                    print(f" - {a.name}: {binds}")
                continue
            if parts[1] == "matrix":
                if not current_prob_matrix:
                    print("No transition matrix loaded")
                    continue
                print(json.dumps(current_prob_matrix, indent=2))
                continue
            print("Unknown show option")
            continue

        if cmd == "run":
            # defaults
            max_steps = 15
            start_activity = None
            seed = None
            if len(parts) >= 2:
                try:
                    max_steps = int(parts[1])
                except ValueError:
                    print("First argument must be max_steps (int)")
                    continue
            if len(parts) >= 3:
                start_activity = parts[2]
            if len(parts) >= 4:
                try:
                    seed = int(parts[3])
                except ValueError:
                    print("seed must be an int")
                    continue

            # If no seed provided, use a fixed default for reproducibility during testing
            if seed is None:
                seed = 42
                print(f"Using default seed={seed} for reproducible runs")

            # If lifecycle_mode requires reapplying, create a possibly modified static_model copy
            sm = static_model
            if current_lifecycle_mode == "simple_arcs":
                # NOTE: derive_provisional_lifecycle_from_list expects the original arc list; we don't have it here
                # so this mode only makes sense when the model originally came from the arc list and lifecycle
                # derivation was applied at load time. We'll assume the caller loaded with the desired mode.
                pass

            # Build StartPolicy
            # Prefer activities that are marked as creators (binding.creates==True)
            activity_names = [a.name for a in getattr(sm, 'activities', [])]
            creator_activities = [a.name for a in getattr(sm, 'activities', []) if any(getattr(b, 'creates', False) for b in a.bindings)]

            if start_activity:
                # Try exact match first, then case-insensitive fallback
                if start_activity in activity_names:
                    start_names = [start_activity]
                else:
                    # case-insensitive match
                    lowered = {n.lower(): n for n in activity_names}
                    if start_activity.lower() in lowered:
                        start_names = [lowered[start_activity.lower()]]
                        print(f"Note: using case-insensitive match for start activity: {start_names[0]}")
                    else:
                        print(f"Warning: requested start activity '{start_activity}' not found in model activities. Available: {activity_names}")
                        start_names = []
            else:
                # Force a domain-specific default start activity
                preferred = "Register Customer Order"
                # Map case-insensitively if needed
                lowered = {n.lower(): n for n in activity_names}
                if preferred in activity_names:
                    start_names = [preferred]
                elif preferred.lower() in lowered:
                    start_names = [lowered[preferred.lower()]]
                    print(f"Note: using case-insensitive match for preferred start activity: {start_names[0]}")
                else:
                    # Preferred not found: still use it explicitly as the start activity
                    # (engine will warn or skip if it doesn't match any activity at start)
                    print(f"Warning: preferred start activity '{preferred}' not found in model activities. It will still be used as the start name.")
                    start_names = [preferred]

            if not start_names:
                print("ERROR: No valid start activity names could be determined. Aborting run.")
                print("Hint: check your OC-Declare model for creates=True bindings or provide an explicit start activity.")
                continue

            start_policy = StartPolicy(start_activity_names=start_names, max_case_starts=None)
            print(f"Using start_policy.start_activity_names = {start_policy.start_activity_names}")

            config = SimulationConfig(max_steps=max_steps, seed=seed, start_policy=start_policy, anchor_object_types=[ot.name for ot in sm.object_types])

            select_wrapper = build_default_select_wrapper(current_prob_matrix)

            # Trace printer: prints iteration payloads emitted by Simulator._trace
            def trace_printer(event: str, payload: dict) -> None:
                try:
                    if event == "iteration":
                        step = payload.get("step_count", None)
                        num = payload.get("num_candidates", None)
                        print(f"\n[TRACE] iteration step={step}, num_candidates={num}")
                        cands = payload.get("candidates", [])
                        if cands:
                            print("[TRACE] Candidate pool:")
                            for i, c in enumerate(cands, start=1):
                                an = c.get("activity_name")
                                p = c.get("participating_object_ids", [])
                                creates = c.get("object_types_to_create", [])
                                print(f"  {i}. {an} | participants={p} | creates={creates}")
                        else:
                            print("[TRACE] Candidate pool is empty")
                except Exception:
                    # Tracing must not break execution
                    return

            print(f"Running simulation: max_steps={max_steps}, start_activity={start_activity}, seed={seed}")
            simulator = Simulator(sm, config, rng=None, select_func=select_wrapper, trace_func=trace_printer)
            # If an initial_state (OCEL) was provided at startup, use it as the
            # starting SimulationState for the run so start activities that
            # require existing objects can be generated.
            if initial_state is not None:
                final_state = simulator.run(state=initial_state)
            else:
                final_state = simulator.run()

            # Print summary
            print("\n=== RUN SUMMARY ===")
            print(f"Steps executed: {final_state.step_count}")
            print(f"Events: {len(final_state.executed_events)}")
            from collections import Counter
            obj_types = Counter(obj.object_type for obj in final_state.objects.values())
            print("Object counts:")
            for t, c in obj_types.items():
                print(f"  - {t}: {c}")

            # Print the ordered list of fired activities
            print("\nActivities fired in order:")
            if final_state.executed_events:
                for i, ev in enumerate(final_state.executed_events, start=1):
                    print(f"  {i}. {ev.activity_name}")
            else:
                print("  (none)")

            # Offer to write OCEL
            save = input("Save OCEL output? [y/N]: ").strip().lower()
            if save == 'y':
                path = write_ocel2_json(final_state)
                print(f"Wrote OCEL to: {path}")
            continue

        print("Unknown command. Type 'help' for available commands.")


def main():
    parser = argparse.ArgumentParser(description="Interactive replay runner")
    parser.add_argument("--ocdeclare", help="Path to OC-Declare JSON (optional if IO/input/ocdeclare contains a file)", default=None)
    parser.add_argument("--ocel", help="Path to OCEL 2.0 JSON (optional)", default=None)
    parser.add_argument("--discover-matrix", help="Path to event log to discover transition matrix (optional)", default=None)
    parser.add_argument("--lifecycle", choices=("none", "simple_arcs"), default="none")
    args = parser.parse_args()

    # Load static model
    if args.ocdeclare:
        sm = import_ocdeclare_json(args.ocdeclare, lifecycle_mode=args.lifecycle)
    else:
        sm = import_first_ocdeclare_in_input(lifecycle_mode=args.lifecycle)

    # Load initial OCEL state if provided — otherwise start with empty state object
    # Do NOT convert the OCEL file into a SimulationState. The OCEL should
    # only be used for matrix discovery (or later for timestamps). Keep the
    # runner's initial_state as None and let the StaticModel / lifecycle
    # derivation determine creation semantics.
    initial_state = None
    if args.ocel:
        # We intentionally do not load the OCEL into state here. The file may
        # still be used later for matrix discovery via --discover-matrix.
        pass

    # Optional: discover transition matrix
    prob_matrix = None
    if args.discover_matrix:
        try:
            ev = load_event_log(args.discover_matrix)
            prob_matrix = discover_transition_matrix(ev)
        except Exception as e:
            print(f"Failed to discover transition matrix: {e}")
            prob_matrix = None

    repl_loop(sm, initial_state, prob_matrix=prob_matrix, lifecycle_mode=args.lifecycle)


if __name__ == "__main__":
    main()
