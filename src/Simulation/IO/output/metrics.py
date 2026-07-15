"""Compute and export timing metrics from a completed SimulationState.

Two metric classes are produced:

Activity metrics  (per unique activity name)
  - execution_count    : how many times the activity fired
  - timestamps         : list of ISO timestamps when it fired
  - service_s          : list of service durations in seconds (sampled clock advance
                         at each firing — what the time policy actually produced)
  - mean_service_s     : mean of service_s  (None if no data)
  - min_service_s      : min  of service_s  (None if no data)
  - max_service_s      : max  of service_s  (None if no data)
  - wait_in_pool_s     : list of pool-wait durations (how long eligible before chosen)
  - mean_wait_in_pool_s: mean of wait_in_pool_s
  - max_wait_in_pool_s : max  of wait_in_pool_s
  - sojourn_s          : per-firing sojourn = service + wait (paired where both exist)
  - mean_sojourn_s     : mean sojourn
  - max_sojourn_s      : max  sojourn

Object metrics  (per object id)
  - object_type       : type string
  - first_event_time  : ISO timestamp of first event this object appears in
  - last_event_time   : ISO timestamp of last event
  - lifetime_s        : last − first in seconds (None if <2 events with timestamps)
  - activities        : ordered list of activity names this object participated in
  - event_count       : number of events the object appeared in
"""
from __future__ import annotations

import json
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from src.Simulation.Domain.state import SimulationState


def _iso(ts: Optional[datetime]) -> Optional[str]:
    if ts is None:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.isoformat()


def compute_metrics(state: SimulationState) -> dict[str, Any]:
    """Return a dict with 'activity_metrics' and 'object_metrics'."""

    # ── Activity metrics ──────────────────────────────────────────────────────
    act_events: dict[str, list] = {}  # activity_name -> list of ExecutedEvent
    for ev in state.executed_events:
        act_events.setdefault(ev.activity_name, []).append(ev)

    activity_metrics: dict[str, Any] = {}
    for act_name, events in sorted(act_events.items()):
        svc_s       = state.activity_service_s.get(act_name, [])
        wait_s      = state.candidate_wait_s.get(act_name, [])
        res_wait_s  = getattr(state, 'resource_wait_s', {}).get(act_name, [])
        proc_wait_s = getattr(state, 'process_wait_s', {}).get(act_name, [])

        # Sojourn = service + process_wait (pre-start) when both are available.
        # Falls back to service + pool-wait for non-DES mode.
        if proc_wait_s:
            n_paired  = min(len(svc_s), len(proc_wait_s))
            sojourn_s = [svc_s[i] + proc_wait_s[i] for i in range(n_paired)]
        else:
            n_paired  = min(len(svc_s), len(wait_s))
            sojourn_s = [svc_s[i] + wait_s[i] for i in range(n_paired)]

        activity_metrics[act_name] = {
            "execution_count":   len(events),
            "timestamps":        [_iso(ev.timestamp) for ev in events],
            # Service time (sampled clock advance at each firing)
            "service_s":         svc_s,
            "mean_service_s":    round(statistics.mean(svc_s), 3)  if svc_s    else None,
            "min_service_s":     round(min(svc_s), 3)              if svc_s    else None,
            "max_service_s":     round(max(svc_s), 3)              if svc_s    else None,
            # Process waiting time (pre-start delay sampled from discovered distribution, DES only)
            "process_wait_s":         proc_wait_s,
            "mean_process_wait_s":    round(statistics.mean(proc_wait_s), 3) if proc_wait_s else None,
            "max_process_wait_s":     round(max(proc_wait_s), 3)             if proc_wait_s else None,
            # Pool-wait time (eligible but not yet chosen — non-DES only)
            "wait_in_pool_s":    wait_s,
            "mean_wait_in_pool_s": round(statistics.mean(wait_s), 3) if wait_s else None,
            "max_wait_in_pool_s":  round(max(wait_s), 3)             if wait_s else None,
            # Sojourn = service + wait
            "sojourn_s":         sojourn_s,
            "mean_sojourn_s":    round(statistics.mean(sojourn_s), 3) if sojourn_s else None,
            "max_sojourn_s":     round(max(sojourn_s), 3)             if sojourn_s else None,
            # Resource-contention wait (DES mode only — time spent in waiting queue)
            "resource_wait_s":          res_wait_s,
            "mean_resource_wait_s":     round(statistics.mean(res_wait_s), 3) if res_wait_s else None,
            "max_resource_wait_s":      round(max(res_wait_s), 3)             if res_wait_s else None,
        }

    # ── Object metrics ────────────────────────────────────────────────────────
    obj_timeline: dict[str, list] = {}
    for ev in state.executed_events:
        for oid in ev.object_ids:
            obj_timeline.setdefault(oid, []).append((ev.timestamp, ev.activity_name))

    object_metrics: dict[str, Any] = {}
    for oid, obj in sorted(state.objects.items()):
        timeline = obj_timeline.get(oid, [])
        timestamps_with_val = [(ts, act) for ts, act in timeline if ts is not None]
        first_ts = timestamps_with_val[0][0]  if timestamps_with_val else None
        last_ts  = timestamps_with_val[-1][0] if timestamps_with_val else None
        lifetime = (last_ts - first_ts).total_seconds() if (first_ts and last_ts and last_ts != first_ts) else None

        object_metrics[oid] = {
            "object_type":      obj.object_type,
            "first_event_time": _iso(first_ts),
            "last_event_time":  _iso(last_ts),
            "lifetime_s":       round(lifetime, 3) if lifetime is not None else None,
            "activities":       [act for _, act in timeline],
            "event_count":      len(timeline),
            "attributes":       dict(obj.attributes) if obj.attributes else {},
        }

    return {
        "activity_metrics": activity_metrics,
        "object_metrics":   object_metrics,
        "total_events":     len(state.executed_events),
        "total_objects":    len(state.objects),
    }


def _diagnose_never_fired(act_name: str, static_model: Any, state: "SimulationState", prob_matrix: dict) -> list[str]:
    """Return a list of human-readable reasons why `act_name` never fired."""
    reasons = []
    if static_model is None:
        return reasons

    fired_acts = {ev.activity_name for ev in state.executed_events}
    existing_types = {obj.object_type for obj in state.objects.values()}

    # Find the activity definition
    act_def = next((a for a in static_model.activities if a.name == act_name), None)
    if act_def is None:
        return reasons

    # 1. Required object type never created
    for binding in act_def.bindings:
        ot = binding.object_type
        if ot not in existing_types:
            # Find which activity creates it
            creator = next(
                (a.name for a in static_model.activities
                 for b in a.bindings if b.object_type == ot and b.creates),
                None
            )
            if creator:
                reasons.append(
                    f'No active "{ot}" objects — created by "{creator}" which also never fired'
                    if creator not in fired_acts
                    else f'No active "{ot}" objects available at the time of evaluation'
                )
            else:
                reasons.append(f'Required object type "{ot}" was never created (no activity has creates=True for it)')

    # 2. Unsatisfied precedence constraints
    for c in static_model.constraints:
        if c.target_activity != act_name:
            continue
        if c.constraint_type == 'precedence' and c.source_activity not in fired_acts:
            reasons.append(f'Precedence constraint not met: "{c.source_activity}" must fire first but never did')
        elif c.constraint_type == 'chain_precedence' and c.source_activity not in fired_acts:
            reasons.append(f'Chain-precedence constraint not met: "{c.source_activity}" must immediately precede it but never fired')

    # 3. Not reachable from any fired activity in the transition matrix
    reachable_targets = {tgt for src in fired_acts for tgt in prob_matrix.get(src, {})}
    if prob_matrix and act_name not in reachable_targets and fired_acts:
        # Check if it appears anywhere in the matrix at all
        all_matrix_targets = {tgt for tgts in prob_matrix.values() for tgt in tgts}
        if act_name not in all_matrix_targets:
            reasons.append('Not present as a transition target in the discovered probability matrix')
        else:
            reasons.append('Low transition probability — never selected by chance during this run')

    return reasons if reasons else ['No specific cause identified — may be a probability/seed issue']


def compute_audit(state: SimulationState, static_model: Any = None, prob_matrix: dict | None = None) -> dict[str, Any]:
    """Compute object lifecycle and activity participation audits from a completed run.

    Object lifecycle audit — per object type:
      instance_count      total objects created
      active_count        still active at end of run
      deactivated_count   deactivated during run
      zero_event_count    created but never participated in any event
      event_count_stats   {min, mean, max} events per instance
      classification      'healthy' | 'accumulating' | 'under_created' | 'orphaned'
      issues              list of human-readable issue descriptions

    Activity participation audit — per activity:
      execution_count     total firings
      unique_objects      distinct objects that ever participated
      objects_per_firing  {min, mean, max} participating objects per event
      reuse_rate          fraction of firings that reused a previously-seen object
      dominant_object     object_id if one object appeared in >80% of firings
      classification      'healthy' | 'never_fired' | 'object_starved' | 'high_reuse'
      issues              list of human-readable issue descriptions
    """
    # ── Object lifecycle audit ────────────────────────────────────────────────
    # Build per-object event count
    obj_event_count: dict[str, int] = {oid: 0 for oid in state.objects}
    for ev in state.executed_events:
        for oid in ev.object_ids:
            if oid in obj_event_count:
                obj_event_count[oid] += 1

    # Group by type
    from collections import defaultdict
    type_instances: dict[str, list] = defaultdict(list)
    for oid, obj in state.objects.items():
        type_instances[obj.object_type].append(oid)

    # Get all defined activity names from static model
    all_activity_names = {a.name for a in static_model.activities} if static_model else set()

    object_lifecycle_audit: dict[str, Any] = {}
    for otype, oids in sorted(type_instances.items()):
        n = len(oids)
        active_ids    = [o for o in oids if state.objects[o].active]
        deact_ids     = [o for o in oids if not state.objects[o].active]
        zero_ev_ids   = [o for o in oids if obj_event_count[o] == 0]
        counts        = [obj_event_count[o] for o in oids]

        issues = []
        if n == 0:
            classification = 'under_created'
            issues.append('No instances created — check that creates=True is set on a binding for this type')
        elif len(zero_ev_ids) == n:
            classification = 'orphaned'
            issues.append(f'All {n} instances were created but never participated in any event')
        elif len(zero_ev_ids) > 0:
            classification = 'partially_orphaned'
            issues.append(f'{len(zero_ev_ids)} of {n} instances never participated in any event')
        elif len(active_ids) == n and n > 1:
            classification = 'accumulating'
            issues.append(f'All {n} instances still active — deactivates=True may be missing on the terminal activity')
        else:
            classification = 'healthy'

        mean_evts = round(sum(counts) / n, 2) if n else 0
        object_lifecycle_audit[otype] = {
            'instance_count':    n,
            'active_count':      len(active_ids),
            'deactivated_count': len(deact_ids),
            'zero_event_count':  len(zero_ev_ids),
            'event_count_stats': {
                'min':  min(counts) if counts else 0,
                'mean': mean_evts,
                'max':  max(counts) if counts else 0,
            },
            'classification': classification,
            'issues': issues,
        }

    # Flag types defined in model but with zero instances (under_created)
    if static_model:
        model_types = {ot.name for ot in static_model.object_types}
        for otype in sorted(model_types - set(type_instances.keys())):
            object_lifecycle_audit[otype] = {
                'instance_count': 0, 'active_count': 0, 'deactivated_count': 0,
                'zero_event_count': 0,
                'event_count_stats': {'min': 0, 'mean': 0, 'max': 0},
                'classification': 'under_created',
                'issues': ['No instances created — check creates=True bindings or start activities'],
            }

    # ── Activity participation audit ─────────────────────────────────────────
    # Per-activity: which objects participated and how many times
    act_obj_firings: dict[str, list] = defaultdict(list)  # act -> [list of object_id sets per firing]
    for ev in state.executed_events:
        act_obj_firings[ev.activity_name].append(set(ev.object_ids))

    activity_participation_audit: dict[str, Any] = {}

    # Include all activities from the model (even those that never fired)
    audited_acts = all_activity_names | set(act_obj_firings.keys())
    for act_name in sorted(audited_acts):
        firings = act_obj_firings.get(act_name, [])
        n_firings = len(firings)

        if n_firings == 0:
            never_fired_reasons = _diagnose_never_fired(
                act_name, static_model, state, prob_matrix or {}
            )
            activity_participation_audit[act_name] = {
                'execution_count': 0,
                'unique_objects': 0,
                'objects_per_firing': {'min': 0, 'mean': 0, 'max': 0},
                'reuse_rate': None,
                'dominant_object': None,
                'classification': 'never_fired',
                'issues': never_fired_reasons,
            }
            continue

        # Count per firing
        sizes = [len(s) for s in firings]
        all_objs_flat = [oid for s in firings for oid in s]
        unique_objs = set(all_objs_flat)

        # Reuse rate: fraction of firings where at least one object appeared in a prior firing
        seen_so_far: set = set()
        reuse_count = 0
        for s in firings:
            if s & seen_so_far:
                reuse_count += 1
            seen_so_far |= s
        reuse_rate = round(reuse_count / n_firings, 3) if n_firings > 1 else 0.0

        # Dominant object: any single object appearing in >80% of firings
        from collections import Counter as _Counter
        obj_counts = _Counter(all_objs_flat)
        dominant = None
        for oid, cnt in obj_counts.most_common(1):
            if cnt / n_firings > 0.8:
                dominant = {'object_id': oid, 'pct': round(cnt / n_firings * 100, 1)}

        issues = []
        if len(unique_objs) == 1 and n_firings > 3:
            classification = 'object_starved'
            issues.append(f'Only 1 unique object ever participated across {n_firings} firings — model may not be creating enough instances of this type')
        elif dominant and n_firings > 5:
            classification = 'object_starved'
            issues.append(f'Object "{dominant["object_id"]}" dominated {dominant["pct"]}% of firings — other instances are not reaching this activity')
        elif reuse_rate > 0.9 and n_firings > 5:
            classification = 'high_reuse'
            issues.append(f'Object reuse rate is {round(reuse_rate*100)}% — same objects are repeatedly used; consider whether deactivation is happening correctly')
        else:
            classification = 'healthy'

        activity_participation_audit[act_name] = {
            'execution_count':   n_firings,
            'unique_objects':    len(unique_objs),
            'objects_per_firing': {
                'min':  min(sizes),
                'mean': round(sum(sizes) / n_firings, 2),
                'max':  max(sizes),
            },
            'reuse_rate':     reuse_rate,
            'dominant_object': dominant,
            'classification': classification,
            'issues':         issues,
        }

    return {
        'object_lifecycle_audit':      object_lifecycle_audit,
        'activity_participation_audit': activity_participation_audit,
    }


def default_metrics_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "metrics"


def write_metrics_json(
    state: SimulationState,
    *,
    out_dir: Path | str | None = None,
    filename: str | None = None,
    indent: int = 2,
) -> Path:
    """Write metrics JSON to the metrics/ folder and return the path."""
    out_path = Path(out_dir) if out_dir is not None else default_metrics_dir()
    out_path.mkdir(parents=True, exist_ok=True)

    if filename is None:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"metrics_{ts}.json"

    payload = compute_metrics(state)
    file_path = out_path / filename
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=indent), encoding="utf-8")
    return file_path
