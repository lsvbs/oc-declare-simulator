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
        svc_s      = state.activity_service_s.get(act_name, [])
        wait_s     = state.candidate_wait_s.get(act_name, [])
        res_wait_s = getattr(state, 'resource_wait_s', {}).get(act_name, [])

        # Sojourn = service + wait, paired by index.  We zip the two lists so
        # only firings where both values exist contribute (first firing typically
        # has no pre-fire base so service list may be one shorter than wait list).
        n_paired = min(len(svc_s), len(wait_s))
        sojourn_s = [svc_s[i] + wait_s[i] for i in range(n_paired)]

        activity_metrics[act_name] = {
            "execution_count":   len(events),
            "timestamps":        [_iso(ev.timestamp) for ev in events],
            # Service time (sampled clock advance at each firing)
            "service_s":         svc_s,
            "mean_service_s":    round(statistics.mean(svc_s), 3)  if svc_s    else None,
            "min_service_s":     round(min(svc_s), 3)              if svc_s    else None,
            "max_service_s":     round(max(svc_s), 3)              if svc_s    else None,
            # Pool-wait time (eligible but not yet chosen)
            "wait_in_pool_s":    wait_s,
            "mean_wait_in_pool_s": round(statistics.mean(wait_s), 3) if wait_s else None,
            "max_wait_in_pool_s":  round(max(wait_s), 3)             if wait_s else None,
            # Sojourn = service + wait (paired)
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
