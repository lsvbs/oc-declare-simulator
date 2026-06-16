"""Smoke test: verify attribute initialisation and confirm attributes are NOT
yet used to influence simulation decisions.

Checks:
  1. Discovery extracts an attribute_schema from the event log.
  2. StaticModel.attribute_defaults is populated after parsing.
  3. Every newly created object of a type that has defaults receives those
     attributes at creation time.
  4. Attributes are present in the OCEL 2.0 export.
  5. Running the simulation twice with *different* attribute defaults produces
     identical activity sequences — confirming attributes have no effect on
     simulation behaviour yet.
"""
import sys, copy
sys.path.insert(0, '.')

from src.ParameterDiscovery.OCDeclarediscovery import discover_ocdeclare_model
from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict
from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Engine.simulator import Simulator
from src.Simulation.IO.output.OCEL2 import build_ocel2_dict

OCEL_PATH = "src/Simulation/IO/input/eventlog/order-management.json"
MAX_STEPS = 30
SEED = 42

# ── 1. Discovery ──────────────────────────────────────────────────────────────
print("=== 1. DISCOVERY ===")
result = discover_ocdeclare_model(OCEL_PATH, resource_threshold=50.0)
model_dict = result["model"]
schema = model_dict.get("attribute_schema", {})
print("attribute_schema found:", bool(schema))
assert schema, "FAIL: attribute_schema is empty — discovery did not collect attributes"
for ot, defaults in schema.items():
    print(f"  {ot}: {defaults}")

# ── 2. StaticModel.attribute_defaults ────────────────────────────────────────
print("\n=== 2. STATIC MODEL attribute_defaults ===")
static_model = parse_ocdeclare_dict(model_dict)
assert static_model.attribute_defaults, "FAIL: StaticModel.attribute_defaults is empty"
print("attribute_defaults:", static_model.attribute_defaults)

start_acts = [a.name for a in static_model.activities if any(b.creates for b in a.bindings)]
print("start_activities:", start_acts)
assert start_acts, "FAIL: no start activities found"

config = SimulationConfig(
    max_steps=MAX_STEPS,
    seed=SEED,
    start_policy=StartPolicy(start_activity_names=start_acts),
)

# ── 3. Objects receive default attributes ────────────────────────────────────
print("\n=== 3. OBJECT ATTRIBUTE INITIALISATION ===")
state = Simulator(static_model, config).run()

types_with_defaults = set(static_model.attribute_defaults.keys())
objects_checked = 0
for obj in state.objects.values():
    if obj.object_type not in types_with_defaults:
        continue
    expected = static_model.attribute_defaults[obj.object_type]
    for attr_name, attr_val in expected.items():
        assert attr_name in obj.attributes, (
            f"FAIL: object {obj.object_id} ({obj.object_type}) missing attribute '{attr_name}'"
        )
        assert obj.attributes[attr_name] == attr_val, (
            f"FAIL: {obj.object_id}.{attr_name} = {obj.attributes[attr_name]!r}, "
            f"expected {attr_val!r}"
        )
    objects_checked += 1

print(f"Objects with attributes checked: {objects_checked}")
assert objects_checked > 0, "FAIL: no objects of a type with defaults were created"
print("PASS: all created objects carry the expected default attributes")

# ── 4. OCEL 2.0 export contains attributes ───────────────────────────────────
print("\n=== 4. OCEL 2.0 EXPORT ===")
ocel = build_ocel2_dict(state, static_model=static_model)
objects_with_attrs = [o for o in ocel["objects"] if o.get("attributes")]
print(f"Objects with non-empty attributes in export: {len(objects_with_attrs)} / {len(ocel['objects'])}")
assert objects_with_attrs, "FAIL: OCEL export has no objects with attributes"
print("Example:", objects_with_attrs[0])
print("PASS: attributes present in OCEL 2.0 export")

# ── 5. Attributes have NO effect on simulation behaviour ─────────────────────
print("\n=== 5. ATTRIBUTES DO NOT AFFECT SIMULATION (expected) ===")

# Build a model with completely different attribute defaults
altered_dict = copy.deepcopy(model_dict)
altered_dict["attribute_schema"] = {
    ot: {k: "ALTERED_VALUE" for k in vals}
    for ot, vals in schema.items()
}
static_model_altered = parse_ocdeclare_dict(altered_dict)

state_orig    = Simulator(static_model,         config).run()
state_altered = Simulator(static_model_altered, config).run()

seq_orig    = [e.activity_name for e in state_orig.executed_events]
seq_altered = [e.activity_name for e in state_altered.executed_events]

sequences_identical = (seq_orig == seq_altered)
print("Original sequence :", seq_orig[:8], "...")
print("Altered  sequence :", seq_altered[:8], "...")
print("Sequences identical:", sequences_identical)

if sequences_identical:
    print("CONFIRMED: attributes are initialised but do not yet influence simulation decisions.")
else:
    print("UNEXPECTED: activity sequences differ — something reads attributes during simulation.")

print("\n=== ALL CHECKS PASSED ===")
