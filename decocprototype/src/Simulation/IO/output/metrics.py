"""Compute and export timing metrics from a completed SimulationState.

Two metric classes are produced:

Activity metrics  (per unique activity name)
  - execution_count   : how many times the activity fired
  - timestamps        : list of ISO timestamps when it fired
  - durations_s       : list of durations in seconds (gap to the *next* event
                        on any shared object — the most meaningful "how long did
                        this step take" we can derive from timestamps alone)
  - mean_duration_s   : mean of durations_s  (None if no durations)
  - min_duration_s    : min of durations_s   (None if no durations)
  - max_duration_s    : max of durations_s   (None if no durations)

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

    # For each object build its ordered event timeline so we can compute
    # inter-event durations per object.
    obj_timeline: dict[str, list] = {}  # object_id -> [(timestamp, activity)]
    for ev in state.executed_events:
        for oid in ev.object_ids:
            obj_timeline.setdefault(oid, []).append((ev.timestamp, ev.activity_name))

    # Per-activity durations: the global inter-event gap (time between this
    # event and the previous one in the simulation timeline). This directly
    # reflects what the time policy sampled — it is the actual simulated
    # clock advance, uncontaminated by resource objects or waiting time.
    act_durations: dict[str, list[float]] = {}
    sorted_events = sorted(
        (ev for ev in state.executed_events if ev.timestamp is not None),
        key=lambda e: e.timestamp,
    )
    for i, ev in enumerate(sorted_events):
        if i == 0:
            continue
        prev_ts = sorted_events[i - 1].timestamp
        dur = (ev.timestamp - prev_ts).total_seconds()
        if dur >= 0:
            act_durations.setdefault(ev.activity_name, []).append(dur)

    activity_metrics: dict[str, Any] = {}
    for act_name, events in sorted(act_events.items()):
        durs = act_durations.get(act_name, [])
        wait_s = state.candidate_wait_s.get(act_name, [])
        activity_metrics[act_name] = {
            "execution_count": len(events),
            "timestamps": [_iso(ev.timestamp) for ev in events],
            "durations_s": durs,
            "mean_duration_s": round(statistics.mean(durs), 3) if durs else None,
            "min_duration_s":  round(min(durs), 3) if durs else None,
            "max_duration_s":  round(max(durs), 3) if durs else None,
            # "available since" stats: how long the activity waited in the pool
            "wait_in_pool_s": wait_s,
            "mean_wait_in_pool_s": round(statistics.mean(wait_s), 3) if wait_s else None,
            "max_wait_in_pool_s":  round(max(wait_s), 3) if wait_s else None,
        }

    # ── Object metrics ────────────────────────────────────────────────────────
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
