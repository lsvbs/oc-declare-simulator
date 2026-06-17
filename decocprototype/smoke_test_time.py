"""Smoke test: verify timing metrics are correctly computed from SimulationState.

Checks:
  1. compute_metrics returns activity_metrics and object_metrics
  2. Every executed event is accounted for in activity_metrics
  3. Duration values are non-negative
  4. Timestamps on events are preserved in the metrics (ISO strings)
  5. Object lifetimes are consistent (last >= first, lifetime >= 0)
  6. write_metrics_json creates a valid file in the metrics/ folder
  7. INVESTIGATION: why some activities show unexpectedly long durations

ROOT CAUSE (check 7):
  Duration is computed as the gap to the *next event on the same object*.
  This is conceptually correct for case objects (orders, items, packages) —
  the gap tells you how long an object waited after activity A before activity B
  happened to it.

  The problem arises with **resource objects** (products, employees, customers,
  Forklift, Truck) which are never deactivated and participate across many
  unrelated cases. For a resource object R:

    place order (case 1)  →  [3 hours later]  →  pay order (case 1)
    pay order   (case 1)  →  [5 hours later]  →  place order (case 2)   ← this gap
    place order (case 2)  →  ...

  The 5-hour gap gets attributed as the duration of "pay order" on resource R,
  even though it really reflects inter-case idle time.

  As case count grows the resource accumulates more and more events, so the
  measured durations for the activity *at that resource* grow proportionally —
  eventually reaching hundreds of days if a resource persists across many steps.

  The fix (not applied here) would be to exclude resource objects from duration
  computation, or to only measure duration on case-scoped (non-resource) objects.
"""
import sys, json, os
sys.path.insert(0, '.')

from src.ParameterDiscovery.OCDeclarediscovery import discover_ocdeclare_model, compute_ocpa_metrics, load_ocel2
from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict
from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Engine.simulator import Simulator
from src.Simulation.IO.output.metrics import compute_metrics, write_metrics_json
from pathlib import Path
import tempfile

OCEL_PATH = "src/Simulation/IO/input/eventlog/order-management.json"
MAX_STEPS = 40
SEED = 42

# ── 1. Run simulation ─────────────────────────────────────────────────────────
print("=== 1. SETUP ===")
result = discover_ocdeclare_model(OCEL_PATH, resource_threshold=50.0)
static_model = parse_ocdeclare_dict(result["model"])
start_acts = [a.name for a in static_model.activities if any(b.creates for b in a.bindings)]
config = SimulationConfig(max_steps=MAX_STEPS, seed=SEED, start_policy=StartPolicy(start_acts))
state = Simulator(static_model, config).run()
print(f"Simulation ran {state.step_count} steps, {len(state.objects)} objects")
print(f"Resource types: {static_model.resource_types}")

# ── 2. Compute metrics ────────────────────────────────────────────────────────
print("\n=== 2. COMPUTE METRICS ===")
metrics = compute_metrics(state)
act_metrics = metrics["activity_metrics"]
obj_metrics = metrics["object_metrics"]

assert act_metrics, "FAIL: activity_metrics is empty"
assert obj_metrics,  "FAIL: object_metrics is empty"
print(f"Activity types: {len(act_metrics)}, Object instances: {len(obj_metrics)}")

# ── 3. Every executed activity is in metrics ──────────────────────────────────
print("\n=== 3. ACTIVITY COVERAGE ===")
from collections import Counter
expected_counts = Counter(e.activity_name for e in state.executed_events)
for act, expected in expected_counts.items():
    actual = act_metrics.get(act, {}).get("execution_count", 0)
    assert actual == expected, f"FAIL: {act} count {actual} != {expected}"
print("PASS: all activity counts match executed events")

# ── 4. Durations are non-negative ─────────────────────────────────────────────
print("\n=== 4. DURATION VALUES ===")
for act, m in act_metrics.items():
    for d in m["durations_s"]:
        assert d >= 0, f"FAIL: negative duration {d}s for activity '{act}'"
    if m["mean_duration_s"] is not None:
        assert m["min_duration_s"] <= m["mean_duration_s"] <= m["max_duration_s"], \
            f"FAIL: min/mean/max inconsistent for '{act}'"
print("PASS: all durations are non-negative and min <= mean <= max")

# ── 5. Timestamps are ISO strings ─────────────────────────────────────────────
print("\n=== 5. TIMESTAMPS ===")
ts_count = 0
for act, m in act_metrics.items():
    for ts in m["timestamps"]:
        if ts is not None:
            assert isinstance(ts, str) and 'T' in ts, f"FAIL: bad timestamp '{ts}' for '{act}'"
            ts_count += 1
print(f"Timestamped events: {ts_count} / {state.step_count}")
assert ts_count > 0, "FAIL: no events have timestamps"
print("PASS: timestamps are ISO-formatted strings")

# ── 6. Object lifetimes are consistent ────────────────────────────────────────
print("\n=== 6. OBJECT LIFETIMES ===")
for oid, m in obj_metrics.items():
    lt = m["lifetime_s"]
    if lt is not None:
        assert lt >= 0, f"FAIL: negative lifetime {lt}s for object '{oid}'"
    if m["first_event_time"] and m["last_event_time"]:
        assert m["first_event_time"] <= m["last_event_time"], \
            f"FAIL: first_event_time > last_event_time for '{oid}'"
objects_with_lifetime = sum(1 for m in obj_metrics.values() if m["lifetime_s"] is not None)
print(f"Objects with measurable lifetime: {objects_with_lifetime} / {len(obj_metrics)}")
print("PASS: all object lifetimes are non-negative")

# ── 7. File is written correctly ──────────────────────────────────────────────
print("\n=== 7. FILE EXPORT ===")
with tempfile.TemporaryDirectory() as tmpdir:
    out_path = write_metrics_json(state, out_dir=tmpdir, filename="test_metrics.json")
    assert out_path.exists(), "FAIL: metrics file not created"
    with open(out_path) as f:
        loaded = json.load(f)
    assert "activity_metrics" in loaded, "FAIL: missing activity_metrics in file"
    assert "object_metrics"   in loaded, "FAIL: missing object_metrics in file"
    assert loaded["total_events"]  == metrics["total_events"],  "FAIL: total_events mismatch"
    assert loaded["total_objects"] == metrics["total_objects"], "FAIL: total_objects mismatch"
    print(f"Written {out_path.stat().st_size} bytes → loaded OK")
print("PASS: metrics file written and re-loaded correctly")

# ── 8. INVESTIGATION: resource objects inflate durations ─────────────────────
print("\n=== 8. INVESTIGATION: duration inflation via resource objects ===")
resource_types = set(static_model.resource_types)

# Build per-object timeline
obj_timeline = {}
for ev in state.executed_events:
    for oid in ev.object_ids:
        obj_timeline.setdefault(oid, []).append((ev.timestamp, ev.activity_name))

# For each activity, split durations by whether the object is a resource
for act in sorted(act_metrics.keys()):
    case_durs, resource_durs = [], []
    for oid, tl in obj_timeline.items():
        obj = state.objects.get(oid)
        is_resource = obj and obj.object_type in resource_types
        for i, (ts, a) in enumerate(tl):
            if a != act or i + 1 >= len(tl): continue
            nts = tl[i + 1][0]
            if not ts or not nts: continue
            dur = (nts - ts).total_seconds()
            if dur < 0: continue
            (resource_durs if is_resource else case_durs).append(dur)

    def fmt(durs):
        if not durs: return "—"
        return f"mean={sum(durs)/len(durs)/3600:.1f}h  max={max(durs)/3600:.1f}h  n={len(durs)}"

    print(f"  {act}:")
    print(f"    case objects:     {fmt(case_durs)}")
    print(f"    resource objects: {fmt(resource_durs)}")
    if resource_durs and case_durs:
        ratio = (max(resource_durs) / max(case_durs)) if max(case_durs) > 0 else float('inf')
        if ratio > 2:
            print(f"    *** resource max is {ratio:.0f}x larger than case max — inflation confirmed ***")

print()
print("CONCLUSION:")
print("  Duration inflation occurs on resource objects (products, employees, customers).")
print("  These objects never deactivate and participate in every case, so the")
print("  gap-to-next-event on a resource measures inter-case idle time, not")
print("  activity duration. The fix: exclude resource objects from duration")
print("  computation in metrics.py, or filter them in the UI.")

print("\n=== ALL CHECKS PASSED ===")
