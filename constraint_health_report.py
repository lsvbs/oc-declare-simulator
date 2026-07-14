"""
constraint_health_report.py
===========================
Constraint health checker for OC-Declare simulation models.

Can be run standalone (console report) or imported and called as a library
function by the backend API.

Standalone usage:
    python3 constraint_health_report.py

Library usage:
    from constraint_health_report import run_health_check
    result = run_health_check(model_dict, start_activities, event_log=ocel_dict, steps=500)
"""

import sys
import json
from pathlib import Path
from collections import defaultdict, Counter

sys.path.insert(0, '.')


# ── Core check functions ──────────────────────────────────────────────────────

def _labelled(constraint) -> str:
    ctype  = getattr(constraint, "constraint_type", "?")
    src    = getattr(constraint, "source_activity", "?")
    tgt    = getattr(constraint, "target_activity", "?")
    scope  = getattr(constraint, "scope", None)
    sk     = getattr(scope, "kind",        "global") if scope else "global"
    st     = getattr(scope, "object_type", "")       if scope else ""
    nmin   = getattr(constraint, "nmin", None)
    parts  = [f"{ctype}({src}→{tgt})"]
    if sk == "each" and st:
        parts.append(f"each {st}")
    if nmin is not None:
        parts.append(f"nmin={nmin}")
    return " ".join(parts)


def _find_cycles(constraints: list) -> list[dict]:
    """Static cycle detection on hard precedence constraints (nmin >= 1)."""
    graph: dict[str, set] = defaultdict(set)
    for c in constraints:
        ctype = getattr(c, "constraint_type", "")
        nmin  = getattr(c, "nmin", 0) or 0
        if ctype in ("precedence", "chain_precedence") and nmin >= 1:
            src = getattr(c, "source_activity", "")
            tgt = getattr(c, "target_activity", "")
            if src and tgt and src != tgt:
                graph[src].add(tgt)

    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {}
    cycles: list[dict] = []
    path: list[str] = []

    def dfs(u: str):
        color[u] = GRAY
        path.append(u)
        for v in graph.get(u, []):
            vc = color.get(v, WHITE)
            if vc == GRAY:
                idx = path.index(v)
                cycle_path = path[idx:] + [v]
                cycles.append({
                    "path": cycle_path,
                    "description": f"{' → '.join(cycle_path)} (cycle)",
                })
            elif vc == WHITE:
                dfs(v)
        path.pop()
        color[u] = BLACK

    for node in list(graph):
        if color.get(node, WHITE) == WHITE:
            dfs(node)

    # Deduplicate cycles by their sorted path
    seen: set = set()
    unique: list[dict] = []
    for cy in cycles:
        key = tuple(sorted(cy["path"]))
        if key not in seen:
            seen.add(key)
            unique.append(cy)
    return unique


def _weak_precedence_check(constraints: list, event_log: dict, threshold: float = 0.25) -> list[dict]:
    """Flag precedence constraints where source and target rarely co-occur on the same object."""
    if not event_log or not isinstance(event_log, dict):
        return []

    # Build object traces from the event log (handles both dict and list events)
    events_raw = event_log.get("events", {})
    objects_raw = event_log.get("objects", {})

    # Normalise objects: list → dict keyed by id
    if isinstance(objects_raw, list):
        objects_dict = {o["id"]: o for o in objects_raw if "id" in o}
    else:
        objects_dict = objects_raw

    # Normalise events: list → dict keyed by id
    if isinstance(events_raw, list):
        events_dict = {e.get("id", str(i)): e for i, e in enumerate(events_raw)}
    else:
        events_dict = events_raw

    # Build per-object-type traces cache
    _traces_cache: dict[str, dict] = {}

    def _get_traces(scope_type: str) -> dict[str, list]:
        if scope_type in _traces_cache:
            return _traces_cache[scope_type]
        obj_ids = {oid for oid, o in objects_dict.items()
                   if o.get("type") == scope_type}
        obj_events: dict[str, list] = defaultdict(list)
        for eid, edata in events_dict.items():
            act = edata.get("activity") or edata.get("type") or edata.get("ocel:activity")
            ts  = edata.get("time") or edata.get("timestamp") or edata.get("ocel:timestamp", "")
            # Handle both omap (list of IDs) and relationships (list of dicts)
            rels_raw = edata.get("omap") or edata.get("relationships") or []
            oids_in_event = []
            for rel in rels_raw:
                if isinstance(rel, dict):
                    oids_in_event.append(rel.get("objectId", ""))
                else:
                    oids_in_event.append(rel)
            for oid in oids_in_event:
                if oid in obj_ids:
                    obj_events[oid].append((ts, act))
        traces = {}
        for oid, evts in obj_events.items():
            evts.sort(key=lambda x: x[0])
            traces[oid] = [e[1] for e in evts]
        _traces_cache[scope_type] = traces
        return traces

    results: list[dict] = []
    seen: set = set()

    for c in constraints:
        ctype = getattr(c, "constraint_type", "")
        nmin  = getattr(c, "nmin", 0) or 0
        if ctype != "precedence" or nmin < 1:
            continue
        src  = getattr(c, "source_activity", "")
        tgt  = getattr(c, "target_activity", "")
        scope = getattr(c, "scope", None)
        st   = getattr(scope, "object_type", "") if scope else ""
        if not (src and tgt and st):
            continue
        key = (src, tgt, st)
        if key in seen:
            continue
        seen.add(key)

        traces = _get_traces(st)
        if not traces:
            continue

        both  = sum(1 for t in traces.values() if src in t and tgt in t)
        total = len(traces)
        pct   = (both / total * 100) if total else 0.0

        if pct < threshold * 100:
            results.append({
                "source":           src,
                "target":           tgt,
                "scope_type":       st,
                "co_occurrence_pct": round(pct, 1),
                "trace_count":      total,
                "message":          (
                    f"Only {pct:.1f}% of {st} traces contain both '{src}' and '{tgt}'. "
                    f"These may be alternative paths rather than a hard requirement."
                ),
            })

    results.sort(key=lambda r: r["co_occurrence_pct"])
    return results


def _run_simulation_checks(static_model, start_activities: list, steps: int = 500):
    """Run N steps with instrumented constraint checking. Returns rejection log, step pools,
    and exclusion_log recording why activities were skipped before constraint checking."""
    import src.Simulation.Engine.semantics as _sem
    import src.Simulation.Engine.candidategeneration as _cgen
    from src.Simulation.Engine.simulator import Simulator
    from src.Simulation.Domain.config import SimulationConfig, StartPolicy

    rejection_log: list[tuple] = []
    pre_step:      list        = []
    current_step:  list[int]   = [0]

    # exclusion_log records why build_candidate_for_activity returned None
    # entries: (step, activity_name, binding_type, reason)
    # reason: "no_objects" | "guard_filtered" | "o2o_saturated"
    exclusion_pre_step: list = []
    exclusion_log: list[tuple] = []

    orig_check = _sem.check_constraint
    orig_o2o   = _sem.check_o2o_rules

    def _inst_check(constraint, candidate, state):
        result = orig_check(constraint, candidate, state)
        if not result:
            objs = ",".join(getattr(candidate, "participating_object_ids", []) or [])
            pre_step.append((
                candidate.activity_name, objs, _labelled(constraint), "CONSTRAINT"
            ))
        return result

    def _inst_o2o(sm, candidate, state):
        result = orig_o2o(sm, candidate, state)
        if not result:
            objs = ",".join(getattr(candidate, "participating_object_ids", []) or [])
            pre_step.append((candidate.activity_name, objs, "O2O_rule_violation", "O2O"))
        return result

    # Wrap build_candidate_for_activity to record exclusion reasons.
    # Must patch both the candidategeneration module AND the simulator module
    # (which imports it directly at load time as a local name).
    import src.Simulation.Engine.simulator as _sim_mod
    orig_build = _cgen.build_candidate_for_activity
    orig_build_sim = getattr(_sim_mod, 'build_candidate_for_activity', None)

    def _inst_build(activity, state, resource_types=None):
        from src.Simulation.Engine.candidategeneration import find_active_objects_of_type, _apply_guard_filter
        for binding in activity.bindings:
            if binding.creates:
                continue
            fetch_limit = max(binding.max_count * 4, 8) if binding.max_count is not None else 8
            existing_ids = find_active_objects_of_type(state, binding.object_type, limit=fetch_limit)
            if not existing_ids:
                exclusion_pre_step.append((activity.name, binding.object_type, "no_objects"))
                break
            guard = getattr(binding, 'guard', None)
            if guard:
                filtered = _apply_guard_filter(existing_ids, guard, state)
                if not filtered:
                    exclusion_pre_step.append((activity.name, binding.object_type, "guard_filtered"))
                    break
        return orig_build(activity, state, resource_types=resource_types)

    _cgen.build_candidate_for_activity = _inst_build
    if orig_build_sim is not None:
        _sim_mod.build_candidate_for_activity = _inst_build

    _sem.check_constraint = _inst_check
    _sem.check_o2o_rules  = _inst_o2o
    _cgen.check_all_constraints = lambda sm, cand, st: all(
        _inst_check(c, cand, st) for c in sm.constraints
    )
    _cgen.check_o2o_rules = _inst_o2o

    step_pool:   dict[int, list] = {}
    step_chosen: dict[int, str]  = {}

    def tracer(event, payload):
        if event == "iteration":
            step = payload.get("step_count", 0)
            current_step[0] = step
            cands = payload.get("candidates", [])
            step_pool[step] = [
                (c.get("activity_name", "?"), c.get("participating_object_ids", []))
                for c in cands
            ]
            for entry in pre_step:
                rejection_log.append((step,) + entry)
            pre_step.clear()
            for entry in exclusion_pre_step:
                exclusion_log.append((step,) + entry)
            exclusion_pre_step.clear()
        elif event == "applied":
            step_chosen[current_step[0]] = payload.get("activity_name", "?")

    try:
        cfg = SimulationConfig(
            max_steps=steps,
            seed=42,
            start_policy=StartPolicy(start_activity_names=start_activities),
        )
        sim = Simulator(static_model, cfg, trace_func=tracer)
        sim.run()
    finally:
        # Always restore original functions
        _sem.check_constraint        = orig_check
        _sem.check_o2o_rules         = orig_o2o
        _cgen.check_all_constraints  = lambda sm, cand, st: all(
            orig_check(c, cand, st) for c in sm.constraints
        )
        _cgen.check_o2o_rules = orig_o2o
        _cgen.build_candidate_for_activity = orig_build
        if orig_build_sim is not None:
            _sim_mod.build_candidate_for_activity = orig_build_sim

    return rejection_log, step_pool, step_chosen, exclusion_log


# ── Main health check function (library entry point) ─────────────────────────

def run_health_check(
    model_dict: dict,
    start_activities: list,
    event_log=None,
    steps: int = 500,
    weak_threshold: float = 0.25,
) -> dict:
    """Run all four health checks and return a structured result dict.

    Args:
        model_dict:        The parsed model dict (activities, constraints, o2o_rules, …)
        start_activities:  List of start activity names
        event_log:         Optional OCEL 2.0 log dict for weak-precedence check
        steps:             Number of simulation steps for the blocked-activity check
        weak_threshold:    Co-occurrence fraction below which a precedence is flagged as weak

    Returns:
        {
            "permanently_blocked": [...],
            "top_blocking_constraints": [...],
            "cycles": [...],
            "weak_precedences": [...],
            "exclusion_reasons": {activity: [{binding_type, reason, count}]},
            "summary": {"errors": N, "warnings": M}
        }
    """
    from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict

    static_model = parse_ocdeclare_dict(model_dict)
    constraints  = static_model.constraints
    all_act_names = [a.name for a in static_model.activities]

    # ── Check A+B: run simulation ─────────────────────────────────────────────
    rejection_log, step_pool, step_chosen, exclusion_log = _run_simulation_checks(
        static_model, start_activities, steps=steps
    )

    # Activities that appeared in any pool
    seen_in_pool: set[str] = set()
    for pool in step_pool.values():
        for act_name, _ in pool:
            seen_in_pool.add(act_name)

    # ── Build exclusion_reasons: per-activity dominant reason for not entering pool ──
    # Count (activity, binding_type, reason) occurrences across all steps
    excl_counts: dict = defaultdict(lambda: defaultdict(int))
    for step, act_name, binding_type, reason in exclusion_log:
        excl_counts[act_name][(binding_type, reason)] += 1

    exclusion_reasons: dict[str, list] = {}
    for act_name, counts in excl_counts.items():
        if act_name in seen_in_pool:
            continue  # only report for activities that never entered the pool
        reasons_list = [
            {"binding_type": bt, "reason": reason, "count": cnt}
            for (bt, reason), cnt in sorted(counts.items(), key=lambda x: -x[1])
        ]
        if reasons_list:
            exclusion_reasons[act_name] = reasons_list

    # Permanently blocked = defined in model but never reached the pool
    permanently_blocked: list[dict] = []
    for act_name in all_act_names:
        if act_name not in seen_in_pool and act_name not in start_activities:
            # Find the top blocking constraint for this activity
            top_reason = None
            top_count  = 0
            for step, activity, objs, label, kind in rejection_log:
                if activity == act_name:
                    top_count += 1
                    if top_reason is None:
                        top_reason = label
            # Enrich with exclusion reason if no constraint rejection was found
            excl = exclusion_reasons.get(act_name, [])
            dominant_excl = excl[0]["reason"] if excl else None
            permanently_blocked.append({
                "activity":         act_name,
                "top_blocker":      top_reason or (
                    f"no_objects:{excl[0]['binding_type']}" if dominant_excl == "no_objects" else
                    f"guard_filtered:{excl[0]['binding_type']}" if dominant_excl == "guard_filtered" else
                    "never attempted"
                ),
                "block_count":      top_count,
                "exclusion_reason": dominant_excl,
                "exclusion_detail": excl,
            })

    # Top blocking constraints with affected activities
    label_counter: Counter = Counter()
    label_blocks:  dict[str, set] = defaultdict(set)
    for step, activity, objs, label, kind in rejection_log:
        label_counter[label] += 1
        label_blocks[label].add(activity)

    top_blocking = [
        {
            "label":  label,
            "count":  count,
            "blocks": sorted(label_blocks[label]),
            "is_chain": label.startswith("chain_"),
        }
        for label, count in label_counter.most_common(15)
    ]

    # ── Check C: static cycle detection ──────────────────────────────────────
    cycles = _find_cycles(constraints)

    # ── Check D: weak precedences ─────────────────────────────────────────────
    weak_precedences = _weak_precedence_check(constraints, event_log, threshold=weak_threshold)

    # ── Check E: activities with no incoming constraints ──────────────────────
    # For each such activity, list its input bindings and enrich with which
    # activities create / deactivate each bound object type.
    target_acts = {c.target_activity for c in constraints}
    creators:     dict[str, list[str]] = {}
    deactivators: dict[str, list[str]] = {}
    for a in static_model.activities:
        for b in a.bindings:
            if b.creates:
                creators.setdefault(b.object_type, []).append(a.name)
            if b.deactivates:
                deactivators.setdefault(b.object_type, []).append(a.name)

    no_input_activities = []
    for a in static_model.activities:
        if a.name in target_acts:
            continue
        input_bindings = [b for b in a.bindings if not b.creates]
        binding_info = [
            {
                "object_type":    b.object_type,
                "is_resource":    b.object_type in set(static_model.resource_types or []),
                "created_by":     creators.get(b.object_type, []),
                "deactivated_by": deactivators.get(b.object_type, []),
            }
            for b in input_bindings
        ]
        no_input_activities.append({
            "activity":      a.name,
            "input_bindings": binding_info,
            "is_pure_start": len(input_bindings) == 0,
        })

    # ── Summary ───────────────────────────────────────────────────────────────
    errors   = len(cycles) + len(permanently_blocked)
    warnings = len([c for c in top_blocking if c["is_chain"]]) + len(weak_precedences)

    return {
        "permanently_blocked":      permanently_blocked,
        "top_blocking_constraints": top_blocking,
        "cycles":                   cycles,
        "weak_precedences":         weak_precedences,
        "exclusion_reasons":        exclusion_reasons,
        "no_input_activities":      no_input_activities,
        "summary":                  {"errors": errors, "warnings": warnings},
    }


# ── Standalone console report ─────────────────────────────────────────────────

def _console_report(result: dict, step_pool: dict, step_chosen: dict, rejection_log: list) -> None:
    from collections import defaultdict as _dd

    SEP = "=" * 72

    print(SEP)
    print("CONSTRAINT HEALTH REPORT")
    s = result["summary"]
    print(f"  {s['errors']} error(s)   {s['warnings']} warning(s)")
    print(SEP)

    # ── Cycles ────────────────────────────────────────────────────────────────
    print("\n[ERRORS] Dependency cycles")
    if result["cycles"]:
        for cy in result["cycles"]:
            print(f"  ✗ CYCLE: {cy['description']}")
    else:
        print("  ✓ No cycles detected")

    # ── Permanently blocked ───────────────────────────────────────────────────
    print("\n[ERRORS] Permanently blocked activities (never reached pool in diagnostic run)")
    if result["permanently_blocked"]:
        for b in result["permanently_blocked"]:
            print(f"  ✗ {b['activity']:35s}  blocked by: {b['top_blocker']}")
    else:
        print("  ✓ All activities reached the pool at least once")

    # ── Top blocking constraints ──────────────────────────────────────────────
    print("\n[WARNINGS] Top blocking constraints")
    chain_warn = [c for c in result["top_blocking_constraints"] if c["is_chain"]]
    other_warn = [c for c in result["top_blocking_constraints"] if not c["is_chain"]]
    if chain_warn:
        print("  Chain constraints (most likely to cause deadlocks):")
        for c in chain_warn:
            print(f"  ⚠ {c['count']:4d}×  {c['label']}")
            print(f"         blocks: {', '.join(c['blocks'])}")
    if other_warn:
        print("  Other blocking constraints:")
        for c in other_warn[:8]:
            print(f"     {c['count']:4d}×  {c['label']}")

    # ── Weak precedences ──────────────────────────────────────────────────────
    print("\n[WARNINGS] Weak precedences (rarely co-occur per object in log)")
    if result["weak_precedences"]:
        for wp in result["weak_precedences"]:
            print(f"  ⚠ precedence({wp['source']}→{wp['target']}) each {wp['scope_type']}")
            print(f"     {wp['message']}")
    else:
        print("  ✓ No weak precedences detected (or no event log provided)")

    # ── Per-step pool / rejection detail ─────────────────────────────────────
    rejections = _dd(lambda: _dd(list))
    for step, activity, objs, label, kind in rejection_log:
        key = f"{activity}({objs})" if objs else activity
        rejections[step][key].append(label)

    print()
    print(SEP)
    print("STEP-BY-STEP DETAIL")
    print(SEP)

    total_steps = max((max(step_pool.keys(), default=0), max(step_chosen.keys(), default=0)), default=0)
    for step in range(total_steps + 1):
        pool     = step_pool.get(step, [])
        chosen   = step_chosen.get(step, None)
        rej_step = rejections.get(step, {})
        pool_names = [f"{a}[{','.join(oids)}]" if oids else a for a, oids in pool]
        print(f"\nStep {step}")
        print(f"  Pool ({len(pool)}): {', '.join(pool_names) if pool_names else '(empty)'}")
        if rej_step:
            print("  Blocked:")
            for act_key, labels in rej_step.items():
                seen_l, unique_l = set(), []
                for l in labels:
                    if l not in seen_l:
                        seen_l.add(l)
                        unique_l.append(l)
                print(f"    ✗ {act_key}")
                for lbl in unique_l:
                    print(f"        {lbl}")
        if chosen:
            print(f"  → {chosen}")
        else:
            print("  → (stopped)")


# ── Script entry point ────────────────────────────────────────────────────────

if __name__ == "__main__":
    from pathlib import Path

    PARAMS_DIR  = Path("src/Simulation/IO/input/parameters")
    OCDECL_DIR  = Path("src/Simulation/IO/input/ocdeclare")
    EVENTLOG_DIR = Path("src/Simulation/IO/input/eventlog")

    # Auto-detect model type from CLI arg or fall back to latest container_logistics
    target = sys.argv[1] if len(sys.argv) > 1 else "container_logistics"

    params_candidates = sorted(PARAMS_DIR.glob(f"parameters_{target}_*.json"),
                               key=lambda p: p.stat().st_mtime)
    ocdecl_candidates = sorted(OCDECL_DIR.glob(f"discovered_{target}_*.json"),
                               key=lambda p: p.stat().st_mtime)

    if not params_candidates or not ocdecl_candidates:
        print(f"No files found for target '{target}'")
        sys.exit(1)

    params_file = params_candidates[-1]
    ocdecl_file = ocdecl_candidates[-1]

    print(f"Parameters : {params_file.name}")
    print(f"OC-Declare : {ocdecl_file.name}")

    with open(params_file) as f:
        params_dict = json.load(f)
    with open(ocdecl_file) as f:
        ocdecl_dict = json.load(f)

    model_dict = dict(params_dict)
    model_dict["constraints"] = (
        ocdecl_dict if isinstance(ocdecl_dict, list)
        else ocdecl_dict.get("constraints", [])
    )

    # Try to load event log for weak-precedence check
    event_log = None
    log_candidates = list(EVENTLOG_DIR.glob(f"{target}*.json")) + \
                     list(EVENTLOG_DIR.glob(f"{target}*.xml"))
    if log_candidates:
        try:
            from src.ParameterDiscovery.OCDeclarediscovery import load_ocel2
            event_log = load_ocel2(str(log_candidates[0]))
            print(f"Event log  : {log_candidates[0].name}")
        except Exception:
            pass

    start_activities = [
        act["name"] for act in model_dict.get("activities", [])
        if any(b.get("creates") for b in act.get("bindings", []))
    ]
    print(f"Start acts : {start_activities}")
    print()

    # Run checks — capture step details for verbose console output
    import src.Simulation.Engine.semantics as _sem
    import src.Simulation.Engine.candidategeneration as _cgen
    from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict

    static_model = parse_ocdeclare_dict(model_dict)
    rejection_log_outer: list = []
    pre_step_outer:      list = []
    current_step_outer:  list = [0]

    orig_check = _sem.check_constraint
    orig_o2o   = _sem.check_o2o_rules

    def _outer_inst(c, cand, state):
        r = orig_check(c, cand, state)
        if not r:
            objs = ",".join(getattr(cand, "participating_object_ids", []) or [])
            pre_step_outer.append((cand.activity_name, objs, _labelled(c), "C"))
        return r

    def _outer_o2o(sm, cand, state):
        r = orig_o2o(sm, cand, state)
        if not r:
            objs = ",".join(getattr(cand, "participating_object_ids", []) or [])
            pre_step_outer.append((cand.activity_name, objs, "O2O_rule_violation", "O"))
        return r

    _sem.check_constraint = _outer_inst
    _sem.check_o2o_rules  = _outer_o2o
    _cgen.check_all_constraints = lambda sm, cand, st: all(_outer_inst(c, cand, st) for c in sm.constraints)
    _cgen.check_o2o_rules = _outer_o2o

    step_pool_outer:   dict = {}
    step_chosen_outer: dict = {}

    def tracer_outer(event, payload):
        if event == "iteration":
            step = payload.get("step_count", 0)
            current_step_outer[0] = step
            cands = payload.get("candidates", [])
            step_pool_outer[step] = [
                (c.get("activity_name", "?"), c.get("participating_object_ids", []))
                for c in cands
            ]
            for entry in pre_step_outer:
                rejection_log_outer.append((step,) + entry)
            pre_step_outer.clear()
        elif event == "applied":
            step_chosen_outer[current_step_outer[0]] = payload.get("activity_name", "?")

    from src.Simulation.Engine.simulator import Simulator
    from src.Simulation.Domain.config import SimulationConfig, StartPolicy

    try:
        cfg = SimulationConfig(
            max_steps=500,
            seed=42,
            start_policy=StartPolicy(start_activity_names=start_activities),
        )
        sim = Simulator(static_model, cfg, trace_func=tracer_outer)
        sim.run()
    finally:
        _sem.check_constraint = orig_check
        _sem.check_o2o_rules  = orig_o2o
        _cgen.check_all_constraints = lambda sm, cand, st: all(orig_check(c, cand, st) for c in sm.constraints)
        _cgen.check_o2o_rules = orig_o2o

    # Build result using already-collected data (avoid re-running simulation)
    all_act_names = [a.name for a in static_model.activities]
    seen_in_pool: set = set()
    for pool in step_pool_outer.values():
        for act_name, _ in pool:
            seen_in_pool.add(act_name)

    from collections import Counter as _Counter
    label_counter: _Counter = _Counter()
    label_blocks: dict = defaultdict(set)
    for step, activity, objs, label, kind in rejection_log_outer:
        label_counter[label] += 1
        label_blocks[label].add(activity)

    permanently_blocked = []
    for act_name in all_act_names:
        if act_name not in seen_in_pool and act_name not in start_activities:
            top_reason = None
            top_count  = 0
            for step, activity, objs, label, kind in rejection_log_outer:
                if activity == act_name:
                    top_count += 1
                    if top_reason is None:
                        top_reason = label
            permanently_blocked.append({
                "activity":    act_name,
                "top_blocker": top_reason or "never attempted",
                "block_count": top_count,
            })

    top_blocking = [
        {"label": label, "count": count, "blocks": sorted(label_blocks[label]),
         "is_chain": label.startswith("chain_")}
        for label, count in label_counter.most_common(15)
    ]

    cycles         = _find_cycles(static_model.constraints)
    weak_prec      = _weak_precedence_check(static_model.constraints, event_log)

    errors   = len(cycles) + len(permanently_blocked)
    warnings = len([c for c in top_blocking if c["is_chain"]]) + len(weak_prec)

    result = {
        "permanently_blocked":      permanently_blocked,
        "top_blocking_constraints": top_blocking,
        "cycles":                   cycles,
        "weak_precedences":         weak_prec,
        "summary":                  {"errors": errors, "warnings": warnings},
    }

    _console_report(result, step_pool_outer, step_chosen_outer, rejection_log_outer)
