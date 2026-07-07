import os
import sys
import json

# Adjust path to import the discovery module
sys.path.append(os.path.join(os.path.dirname(__file__), '../..'))
from src.ParameterDiscovery.probabilitydiscovery import discover_transition_matrix, load_event_log

if __name__ == "__main__":
    # Path to the event log file in the canonical input directory
    event_log_path = os.path.join(os.path.dirname(__file__), '../Simulation/IO/input/eventlog/container_logistics.json')
    event_log_path = os.path.abspath(event_log_path)
    if not os.path.exists(event_log_path):
        print(f"Event log not found: {event_log_path}")
        sys.exit(1)
    event_log = load_event_log(event_log_path)
    prob_matrix = discover_transition_matrix(event_log)
    print("Discovered transition probability matrix:")
    print(json.dumps(prob_matrix, indent=2))

    # --- Prepare the static model and simulation config (example1) ---
    from src.Simulation.Models.OCDeclare import import_first_ocdeclare_in_input
    from src.Simulation.Domain.config import SimulationConfig, StartPolicy
    from src.Simulation.Engine.simulator import Simulator
    from functools import partial
    
    static_model = import_first_ocdeclare_in_input(lifecycle_mode="simple_arcs")
    start_policy = StartPolicy(
        start_activity_names=["Register Customer Order"],
        max_case_starts=None,
    )
    config = SimulationConfig(
        start_policy=start_policy,
        anchor_object_types=["Customer Order"],
        max_steps=10,  # Very short run for detailed analysis
    )

    # --- Print static model summary for debugging ---
    print(f"\nStatic model has {len(static_model.activities)} activities:")
    for act in static_model.activities:
        bindings_info = [(b.object_type, b.min_count, b.max_count, getattr(b, 'creates', False)) for b in act.bindings]
        print(f"  - {act.name}: {bindings_info}")

    # --- Wrap the default select_candidate with the transition matrix ---
    from src.Simulation.Engine.selection import select_candidate
    
    def select_with_matrix(candidates, state, static_model, config=None, rng=None, **kwargs):
        """Wrapper that passes the transition matrix to the default selector and adds tracing."""
        # Print detailed info about this selection step
        print(f"\n{'='*80}")
        print(f"STEP {state.step_count + 1} - Selection Phase")
        print(f"{'='*80}")
        
        # Show active objects
        print(f"\nActive objects in state:")
        from collections import Counter
        active_objects = {oid: obj for oid, obj in state.objects.items() if obj.active}
        if active_objects:
            obj_types = Counter(obj.object_type for obj in active_objects.values())
            for obj_type, count in sorted(obj_types.items()):
                print(f"  - {obj_type}: {count}")
        else:
            print("  (no active objects yet)")
        
        # Show candidates
        print(f"\nCandidates available ({len(candidates)} total):")
        for i, c in enumerate(candidates):
            print(f"  {i+1}. {c.activity_name}")
            print(f"     - Participating objects: {c.participating_object_ids}")
            print(f"     - Will create: {c.object_types_to_create}")
        
        # Show last activity for transition context
        if state.executed_events:
            last_activity = state.executed_events[-1].activity_name
            print(f"\nLast executed activity: {last_activity}")
        else:
            last_activity = "__START__"
            print(f"\nLast executed activity: {last_activity} (simulation start)")
        
        # Show transition probabilities for each candidate
        transition_probs = prob_matrix.get(last_activity, {})
        print(f"\nTransition probabilities from '{last_activity}':")
        for c in candidates:
            prob = transition_probs.get(c.activity_name, 0.0)
            print(f"  - {c.activity_name}: {prob:.4f}")
        
        # Call the actual selection
        selected = select_candidate(
            candidates=candidates,
            state=state,
            static_model=static_model,
            config=config,
            rng=rng,
            transition_matrix=prob_matrix,
        )
        
        print(f"\n>>> SELECTED: {selected.activity_name}")
        print(f"    Will involve: {selected.participating_object_ids}")
        print(f"    Will create: {selected.object_types_to_create}")
        
        return selected

    # --- Run the simulation with transition-matrix-based selection ---
    simulator = Simulator(static_model, config, select_func=select_with_matrix)
    final_state = simulator.run()

    # --- Print results like the smoke scripts ---
    def print_final_state(state):
        print("\n=== FINAL SIMULATION STATE ===")
        print(f"Step count: {state.step_count}")
        print(f"Objects: {len(state.objects)}")
        print(f"Executed events: {len(state.executed_events)}")
        print(f"Pending obligations: {len(state.pending_obligations)}")
        
        # Print object types breakdown
        from collections import Counter
        # state.objects is a dict mapping object_id -> SimObject
        object_types = Counter(obj.object_type for obj in state.objects.values())
        print("\nObject types:")
        for obj_type, count in object_types.items():
            print(f"  - {obj_type}: {count}")
        
        if state.executed_events:
            print("\nExecuted events:")
            for event in state.executed_events:
                print(f"  - {event.event_id}: {event.activity_name} at {event.timestamp} with {event.object_ids}")
        else:
            print("\nExecuted events:\n  (none)")

    print_final_state(final_state)

    # --- Export OCEL 2.0 event log ---
    from src.Simulation.IO.output.OCEL2 import write_ocel2_json
    # Let the OCEL2 writer generate a timestamped filename for consistency
    # with the other scripts (it uses log_id + timestamp when filename is None).
    out_path = write_ocel2_json(
        final_state,
        log_id="probability_simulation",
        indent=2,
    )
    print(f"\nOCEL 2.0 event log written to: {out_path}\n")
