"""
smoke_constraint_check.py
=========================
Runs the simulator for 50 steps using the latest container_logistics parameters
and the latest discovered OC-Declare file.  For each step it prints:
  - the candidate pool (activity + participating objects)
  - for EACH REJECTED candidate: which constraint(s) blocked it and why
  - the chosen activity

The constraint checkers from semantics.py are monkey-patched with thin wrappers
that log the first failing constraint per candidate.  No production code is modified.
"""

import sys, json, os
sys.path.insert(0, '.')

from pathlib import Path
from collections import defaultdict

# ── 1. Find latest parameters and OC-Declare files ───────────────────────────
PARAMS_DIR   = Path("src/Simulation/IO/input/parameters")
OCDECL_DIR   = Path("src/Simulation/IO/input/ocdeclare")

params_file = max(
    PARAMS_DIR.glob("parameters_container_logistics_*.json"),
    key=lambda p: p.stat().st_mtime,
)
ocdecl_file = max(
    OCDECL_DIR.glob("discovered_container_logistics_*.json"),
    key=lambda p: p.stat().st_mtime,
)

print(f"Parameters : {params_file.name}")
print(f"OC-Declare : {ocdecl_file.name}")
print()

# ── 2. Load and parse ─────────────────────────────────────────────────────────
with open(params_file) as f:
    params_dict = json.load(f)

with open(ocdecl_file) as f:
    ocdecl_dict = json.load(f)

# Merge OC-Declare constraints into the parameters model dict.
# Parameters already contains activities/o2o_rules; constraints come from ocdecl.
model_dict = dict(params_dict)
model_dict["constraints"] = ocdecl_dict if isinstance(ocdecl_dict, list) else ocdecl_dict.get("constraints", [])

from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict
static_model = parse_ocdeclare_dict(model_dict)

print(f"Activities   : {len(static_model.activities)}")
print(f"Constraints  : {len(static_model.constraints)}")
print(f"O2O rules    : {len(static_model.o2o_rules)}")
print()

# ── 3. Instrumented constraint checker ───────────────────────────────────────
import src.Simulation.Engine.semantics as _sem

_rejection_log: list[tuple]    = []   # (step, activity, objects, constraint_desc, reason)
_pre_step_rejections: list     = []   # buffer while step is not yet known
_current_step: list[int]       = [0]  # mutable cell so closures can read it

_ORIG_check_constraint = _sem.check_constraint

def _labelled(constraint) -> str:
    """Short human-readable label for a constraint."""
    ctype  = getattr(constraint, "constraint_type", "?")
    src    = getattr(constraint, "source_activity", "?")
    tgt    = getattr(constraint, "target_activity", "?")
    scope  = getattr(constraint, "scope", None)
    sk     = getattr(scope, "kind",        "global") if scope else "global"
    st     = getattr(scope, "object_type", "")       if scope else ""
    nmin   = getattr(constraint, "nmin", None)
    nmax   = getattr(constraint, "nmax", None)
    parts  = [f"{ctype}({src}→{tgt})"]
    if sk == "each" and st:
        parts.append(f"each {st}")
    if nmin is not None:
        parts.append(f"nmin={nmin}")
    if nmax is not None:
        parts.append(f"nmax={nmax}")
    return " ".join(parts)


def _record(activity, objs_str, label, kind):
    """Buffer rejection — flushed into _rejection_log once the step is known."""
    entry = (activity, objs_str, label, kind)
    _pre_step_rejections.append(entry)


def _instrumented_check_constraint(constraint, candidate, state):
    result = _ORIG_check_constraint(constraint, candidate, state)
    if not result:
        objs = ",".join(getattr(candidate, "participating_object_ids", []) or [])
        _record(candidate.activity_name, objs, _labelled(constraint), "CONSTRAINT")
    return result


_sem.check_constraint = _instrumented_check_constraint

# Also patch check_o2o_rules to record rejections
_ORIG_check_o2o = _sem.check_o2o_rules

def _instrumented_check_o2o(static_model_arg, candidate, state):
    result = _ORIG_check_o2o(static_model_arg, candidate, state)
    if not result:
        objs = ",".join(getattr(candidate, "participating_object_ids", []) or [])
        _record(candidate.activity_name, objs, "O2O_rule_violation", "O2O")
    return result

_sem.check_o2o_rules = _instrumented_check_o2o

# Patch the import inside candidategeneration too (it already imported the names)
import src.Simulation.Engine.candidategeneration as _cgen
_cgen.check_all_constraints = lambda sm, cand, st: all(
    _sem.check_constraint(c, cand, st) for c in sm.constraints
)
_cgen.check_o2o_rules = _instrumented_check_o2o

# ── 4. Simulate with a step tracer ───────────────────────────────────────────
from src.Simulation.Engine.simulator import Simulator
from src.Simulation.Domain.config import SimulationConfig, StartPolicy

start_activities = [
    act.name for act in static_model.activities
    if any(b.creates for b in act.bindings)
]

_step_pool: dict[int, list] = {}   # step -> list of (activity, objects)
_step_chosen: dict[int, str] = {}  # step -> activity chosen

# We increment _current_step at the START of each iteration (before candidate
# generation) by hooking into the "iteration" event, which carries step_count.
# Rejections emitted during _generate_candidates are attributed to that step.
_pre_step_rejections: list = []   # temp buffer for rejections before step is known

def tracer(event, payload):
    if event == "iteration":
        step = payload.get("step_count", 0)
        _current_step[0] = step
        cands_detail = payload.get("candidates", [])
        _step_pool[step] = [
            (c.get("activity_name", "?"), c.get("participating_object_ids", []))
            for c in cands_detail
        ]
        # Flush any pre-step rejections that were buffered during generation
        for entry in _pre_step_rejections:
            _rejection_log.append((step,) + entry)
        _pre_step_rejections.clear()
    elif event == "applied":
        _step_chosen[_current_step[0]] = payload.get("activity_name", "?")

config = SimulationConfig(
    max_steps=50,
    seed=42,
    start_policy=StartPolicy(start_activity_names=start_activities),
)
sim = Simulator(static_model, config, trace_func=tracer)
final_state = sim.run()

# ── 5. Build rejection index per step ────────────────────────────────────────
# group: step -> activity -> list of constraint labels
rejections: dict[int, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
for step, activity, objs, label, kind in _rejection_log:
    key = f"{activity}({objs})" if objs else activity
    rejections[step][key].append(label)

# ── 6. Print report ──────────────────────────────────────────────────────────
print("=" * 72)
print("CONSTRAINT REJECTION REPORT  —  50 steps, container_logistics")
print("=" * 72)

total_steps = max(
    (max(_step_pool.keys(), default=0), max(_step_chosen.keys(), default=0))
)

for step in range(total_steps + 1):
    pool     = _step_pool.get(step, [])
    chosen   = _step_chosen.get(step, None)
    rej_step = rejections.get(step, {})

    pool_names = [f"{a}[{','.join(oids)}]" if oids else a for a, oids in pool]
    print(f"\nStep {step}")
    print(f"  Pool ({len(pool)}): {', '.join(pool_names) if pool_names else '(empty)'}")

    if rej_step:
        print("  Blocked candidates:")
        for act_key, labels in rej_step.items():
            # deduplicate constraint labels (same constraint can fire per scope object)
            seen, unique = set(), []
            for l in labels:
                if l not in seen:
                    seen.add(l)
                    unique.append(l)
            print(f"    ✗ {act_key}")
            for lbl in unique:
                print(f"        reason: {lbl}")

    if chosen:
        print(f"  → {chosen}")
    else:
        print("  → (no candidate chosen — stopped)")

# ── 7. Summary ───────────────────────────────────────────────────────────────
print()
print("=" * 72)
print("SUMMARY: most-blocking constraints across all steps")
print("=" * 72)
from collections import Counter
label_counter: Counter = Counter()
activity_blocked: Counter = Counter()
for step, activity, objs, label, kind in _rejection_log:
    label_counter[label] += 1
    activity_blocked[activity] += 1

print("\nTop constraint labels by rejection count:")
for label, cnt in label_counter.most_common(20):
    print(f"  {cnt:4d}x  {label}")

print("\nMost-blocked activities:")
for act, cnt in activity_blocked.most_common(15):
    print(f"  {cnt:4d}x  {act}")

print(f"\nTotal rejections logged : {len(_rejection_log)}")
print(f"Steps completed         : {len(_step_chosen)}")
print(f"Objects created         : {len(final_state.objects)}")
