"""Quick smoke test: discover resource types, parse model, simulate 50 steps."""
import sys, json
sys.path.insert(0, '.')

# ── 1. Discovery ──────────────────────────────────────────────────────────────
from src.ParameterDiscovery.OCDeclarediscovery import discover_ocdeclare_model

OCEL_PATH = "src/Simulation/IO/input/eventlog/container_logistics.json"
result = discover_ocdeclare_model(OCEL_PATH, resource_threshold=50.0)

model_dict = result["model"]
params     = result["parameters"]

print("=== DISCOVERY ===")
print("resource_types   :", params.get("resource_types", "MISSING"))
print("activities       :", len(model_dict.get("activities", [])))
print("constraints      :", len(model_dict.get("constraints", [])))
print("o2o_rules        :", len(model_dict.get("o2o_rules", [])))

# ── 2. Parse into StaticModel ─────────────────────────────────────────────────
from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict

static_model = parse_ocdeclare_dict(model_dict)
print("\n=== STATIC MODEL ===")
print("resource_types in StaticModel:", static_model.resource_types)

# Auto-detect start activities (activities that create at least one object type)
start_activities = [
    act.name for act in static_model.activities
    if any(b.creates for b in act.bindings)
]
print("start_activities :", start_activities)

# ── 3. Simulate 50 steps ─────────────────────────────────────────────────────
from src.Simulation.Engine.simulator import Simulator
from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Domain.state import SimulationState

events_recorded = []

def tracer(event, payload):
    if event == "applied":
        events_recorded.append(payload.get("activity_name", "?"))

config = SimulationConfig(
    max_steps=50,
    seed=42,
    start_policy=StartPolicy(start_activity_names=start_activities),
)
sim = Simulator(static_model, config, trace_func=tracer)
final_state = sim.run()

print("\n=== SIMULATION ===")
print(f"Steps run        : {len(events_recorded)}")
print(f"Objects created  : {len(final_state.objects)}")

# Count active vs inactive per type
from collections import Counter
active_by_type   = Counter()
inactive_by_type = Counter()
for obj in final_state.objects.values():
    (active_by_type if obj.active else inactive_by_type)[obj.object_type] += 1

print("Active objects   :", dict(active_by_type))
print("Inactive objects :", dict(inactive_by_type))
print("\nActivities fired :", Counter(events_recorded).most_common(10))
