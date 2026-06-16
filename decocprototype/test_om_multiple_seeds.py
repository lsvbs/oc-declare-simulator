#!/usr/bin/env python3
import sys
import os

# Add the project root to path
sys.path.insert(0, '/Users/luisschwarz/Documents/Studies/IT/decocprototype')

# Import everything from the original script
import json
from src.Simulation.Models.OCDeclare import (
    parse_ocdeclare_list,
    derive_provisional_lifecycle_from_list,
    apply_lifecycle_from_provisional_info,
)
from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Engine.simulator import Simulator
from src.ParameterDiscovery.probabilitydiscovery import discover_transition_matrix, load_event_log

# Load event log and discover probabilities
event_log_path = '/Users/luisschwarz/Documents/Studies/IT/decocprototype/src/Simulation/IO/input/eventlog/order-management.json'
event_log = load_event_log(event_log_path)
prob_matrix = discover_transition_matrix(event_log)

# Load model
model_path = '/Users/luisschwarz/Documents/Studies/IT/decocprototype/src/Simulation/IO/input/ocdeclare/ExampleOrderManagement.json'
with open(model_path, 'r') as f:
    model_data = json.load(f)

static_model = parse_ocdeclare_list(model_data)
lifecycle_info = derive_provisional_lifecycle_from_list(model_data)
static_model = apply_lifecycle_from_provisional_info(static_model, lifecycle_info)

start_policy = StartPolicy(start_activity_names=["place order"], max_case_starts=None)

# Selection wrapper
from src.Simulation.Engine.selection import select_candidate

def select_with_matrix(candidates, state, static_model, config=None, rng=None, **kwargs):
    return select_candidate(candidates=candidates, state=state, static_model=static_model, 
                          config=config, rng=rng, transition_matrix=prob_matrix)

# Test with multiple seeds
for test_seed in [42, 99, 123]:
    print(f"\n{'='*80}")
    print(f"SEED {test_seed}")
    print(f"{'='*80}")
    
    config = SimulationConfig(
        start_policy=start_policy,
        anchor_object_types=["orders"],
        max_steps=10,
        seed=test_seed
    )
    
    sim = Simulator(
        static_model=static_model,
        config=config,
        select_function=select_with_matrix
    )
    
    final_state = sim.run()
    
    print(f"Activities fired in order:")
    for i, ev in enumerate(final_state.executed_events, start=1):
        print(f"  {i}. {ev.activity_name}")
