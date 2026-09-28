"""Discover per-activity timing metrics and service-time parameters from OCEL data.

Used by timing discovery, concurrency estimation, and timing evaluation.
"""

from collections import defaultdict
import math
from typing import Any, Dict, List, Optional


TIMING_DISCOVERY_MODES = {"minimum", "p25", "p50", "mean"}


def _select_timing_window(values: List[float], mode: str) -> List[float]:
    """Select the lower-tail sample window used for timing estimation.

    ``minimum`` intentionally means the single lowest observed value.  The
    percentile modes use the lowest fraction of the ordered observations, and
    ``mean`` uses the complete sample.  At least one observation is retained
    whenever values are available so sparse activities remain estimable.
    """
    if mode not in TIMING_DISCOVERY_MODES:
        raise ValueError(
            "service_time_mode must be 'minimum', 'p25', 'p50', or 'mean'."
        )
    if not values:
        return []

    ordered = sorted(values)
    if mode == "minimum":
        count = 1
    elif mode == "p25":
        count = max(1, int(math.ceil(0.25 * len(ordered))))
    elif mode == "p50":
        count = max(1, int(math.ceil(0.50 * len(ordered))))
    else:  # full mean
        count = len(ordered)
    return ordered[:count]


def compute_ocpa_metrics(
    ocel_log: Dict[str, Any],
    anchor_activities: List[Dict[str, Any]] = None,
    service_time_mode: str = 'p25',
) -> Dict[str, Dict[str, Any]]:
    """Compute OCPA time metrics per activity from an OCEL 2.0 log.

    For each event in the log we compute:
      - Complete            = event timestamp (always available)
      - Earliest Arrival    = earliest completion timestamp among the most
                             recent preceding events for any object in this event
      - Latest Arrival      = latest of those preceding timestamps
      - Sync Time           = Latest Arrival − Earliest Arrival
      - Flow Time           = Complete − Earliest Arrival
      - Sojourn Time        = Complete − Latest Arrival
      - Pooling Time        = max(Latest(type)) − min(Earliest(type)) per type
      - Lagging Time        = max per-type latest arrival − overall latest arrival
                             (which object type is delaying synchronisation)
      - Service Time        = sampled from the anchor distribution when the
                             activity is an anchor, otherwise derived from
                             Sojourn − Waiting (requires anchor for Waiting).
      - Waiting Time        = Sojourn − Service  (requires anchor)

    Args:
        ocel_log:           OCEL 2.0 log dict.
        anchor_activities:  List of dicts with keys:
                            { name, mean_seconds, std_seconds, min_seconds, max_seconds }
                            At least one anchor is required to compute service/waiting.

    Returns:
        Dict mapping activity_name →
        {
          sojourn_mean, sojourn_std, sojourn_min, sojourn_max,
          sync_mean,    sync_std,
          flow_mean,    flow_std,
          waiting_mean, waiting_std,
          pooling_mean,
          lagging_mean,
          service_mean, service_std, service_min, service_max,  # from anchor
          sample_count,
          dist_type,    # always "lognormal" as default
          mean_seconds, std_seconds, min_seconds, max_seconds   # = service params
        }
    """
    import statistics

    if service_time_mode not in TIMING_DISCOVERY_MODES:
        raise ValueError(
            "service_time_mode must be 'minimum', 'p25', 'p50', or 'mean'."
        )

    if isinstance(ocel_log, list):
        return {}

    anchor_activities = anchor_activities or []
    anchor_map: Dict[str, Dict] = {a["name"]: a for a in anchor_activities if a.get("name")}

    events  = ocel_log.get("events", {})
    objects = ocel_log.get("objects", {})

    # ── Build object → sorted event list ──────────────────────────────────────
    # Maps obj_id → [ {ts: datetime, activity: str, event_id: str} ... ] sorted by ts
    from datetime import datetime, timezone

    def _parse_ts(raw) -> Optional[datetime]:
        if raw is None:
            return None
        if isinstance(raw, datetime):
            return raw
        try:
            s = str(raw).replace("Z", "+00:00")
            return datetime.fromisoformat(s)
        except Exception:
            return None

    # Index: obj_id → list of (ts, event_id) sorted ascending
    obj_timeline: Dict[str, List] = defaultdict(list)
    event_ts_map: Dict[str, Optional[datetime]] = {}

    for eid, edata in events.items():
        ts = _parse_ts(edata.get("timestamp") or edata.get("ocel:timestamp") or edata.get("time"))
        event_ts_map[eid] = ts
        for obj_id in (edata.get("omap") or edata.get("relationships") or []):
            obj_timeline[obj_id].append((ts, eid))

    for obj_id in obj_timeline:
        obj_timeline[obj_id].sort(key=lambda x: (x[0] is None, x[0]))

    # ── Per-event OCPA metrics collection ─────────────────────────────────────
    # activity → list of per-metric values
    from collections import defaultdict as _dd

    buckets: Dict[str, Dict[str, List[float]]] = _dd(lambda: _dd(list))

    for eid, edata in events.items():
        activity = edata.get("activity")
        if not activity:
            continue
        ts_complete = event_ts_map.get(eid)
        if ts_complete is None:
            continue

        obj_ids = edata.get("omap") or edata.get("relationships") or []
        if not obj_ids:
            continue

        # For service time estimation: find the NEXT event on each object
        # after the current one. Service time = time until the object is
        # used again (how long activity A held the object).
        next_ts_by_obj: Dict[str, Optional[datetime]] = {}
        # Also keep preceding for OCPA sync/flow/pooling metrics
        preceding_ts_by_obj: Dict[str, Optional[datetime]] = {}
        obj_type_map: Dict[str, str] = {}
        for obj_id in obj_ids:
            otype = (objects.get(obj_id) or {}).get("type", "unknown")
            obj_type_map[obj_id] = otype
            tl = obj_timeline.get(obj_id, [])
            prev_ts = None
            next_ts = None
            for i, (ts_i, eid_i) in enumerate(tl):
                if eid_i == eid:
                    if i > 0:
                        prev_ts = tl[i - 1][0]
                    if i < len(tl) - 1:
                        next_ts = tl[i + 1][0]
                    break
            preceding_ts_by_obj[obj_id] = prev_ts
            next_ts_by_obj[obj_id] = next_ts

        # Collect service time samples: time from this event to next event on same object
        valid_next = [t for t in next_ts_by_obj.values() if t is not None]
        for next_ts in valid_next:
            svc_s = max(0.0, (next_ts - ts_complete).total_seconds())
            buckets[activity]["service_direct_s"].append(svc_s)

        valid_preceding = [t for t in preceding_ts_by_obj.values() if t is not None]
        if not valid_preceding:
            # No preceding event for any object → can only record flow = 0
            buckets[activity]["flow_s"].append(0.0)
            buckets[activity]["sojourn_s"].append(0.0)
            continue

        earliest_arr = min(valid_preceding)
        latest_arr   = max(valid_preceding)

        def _sec(dt_from, dt_to) -> float:
            return max(0.0, (dt_to - dt_from).total_seconds())

        sync_s    = _sec(earliest_arr, latest_arr)
        flow_s    = _sec(earliest_arr, ts_complete)
        sojourn_s = _sec(latest_arr,   ts_complete)

        buckets[activity]["sync_s"].append(sync_s)
        buckets[activity]["flow_s"].append(flow_s)
        buckets[activity]["sojourn_s"].append(sojourn_s)

        # Pooling time per object type: span of latest arrivals across types
        type_latest: Dict[str, datetime] = {}
        type_earliest: Dict[str, datetime] = {}
        for obj_id, prev_ts in preceding_ts_by_obj.items():
            if prev_ts is None:
                continue
            otype = obj_type_map[obj_id]
            if otype not in type_latest or prev_ts > type_latest[otype]:
                type_latest[otype] = prev_ts
            if otype not in type_earliest or prev_ts < type_earliest[otype]:
                type_earliest[otype] = prev_ts

        if type_latest:
            pooling_s = _sec(min(type_earliest.values()), max(type_latest.values()))
            buckets[activity]["pooling_s"].append(pooling_s)

            # Lagging: which type's latest arrival is the bottleneck
            overall_latest_val = max(type_latest.values())
            lagging_s = _sec(latest_arr, overall_latest_val) if overall_latest_val >= latest_arr else 0.0
            buckets[activity]["lagging_s"].append(lagging_s)

    # ── Aggregate into summary stats ──────────────────────────────────────────
    def _stats(vals: List[float]) -> Dict[str, float]:
        if not vals:
            return {"mean": 0.0, "std": 0.0, "min": 0.0, "max": 0.0, "count": 0}
        mean = statistics.mean(vals)
        std  = statistics.pstdev(vals) if len(vals) > 1 else 0.0
        return {"mean": mean, "std": std, "min": min(vals), "max": max(vals), "count": len(vals)}

    result: Dict[str, Dict[str, Any]] = {}

    all_activities = set(buckets.keys()) | set(anchor_map.keys())
    for act in all_activities:
        b = buckets.get(act, _dd(list))
        soj  = _stats(b["sojourn_s"])
        sync = _stats(b["sync_s"])
        flow = _stats(b["flow_s"])
        pool = _stats(b["pooling_s"])
        lag  = _stats(b["lagging_s"])

        # Service time source selection:
        # service_direct_s = forward gap (next event on same object) — correct for
        # non-terminal activities where the primary objects are reused.
        # sojourn_s = backward gap (this event - latest preceding event on any object)
        # = time since last thing happened to any of the participating objects before
        # this activity. For terminal-like activities (e.g. Depart) where only
        # secondary objects (e.g. TDs) have next events, the forward gap is polluted
        # by unrelated reuse times. Sojourn is more reliable in that case because it
        # measures the actual waiting time before this activity fires (e.g. dwell time
        # at port = Load to Vehicle timestamp → Depart timestamp).
        # Heuristic: use service_direct_s only if its median < sojourn median.
        # When they agree (non-terminal activities) it doesn't matter which is used.
        # When they disagree (terminal), sojourn gives the more meaningful value.
        direct = b["service_direct_s"]
        soj_vals = b["sojourn_s"]
        # Filter out zero sojourn values — these occur when the activity fires as
        # the first event on a newly created object (no preceding event → sojourn=0).
        # Zero sojourn is not a real measurement and should not beat a real forward gap.
        soj_vals_nonzero = [s for s in soj_vals if s > 0]
        if direct and soj_vals_nonzero:
            direct_median = sorted(direct)[len(direct)//2]
            soj_median    = sorted(soj_vals_nonzero)[len(soj_vals_nonzero)//2]
            raw_source = direct if direct_median <= soj_median else soj_vals_nonzero
        elif direct:
            raw_source = direct
        elif soj_vals_nonzero:
            raw_source = soj_vals_nonzero
        else:
            raw_source = soj_vals  # all zeros — keep as fallback
        if act in anchor_map:
            anc = anchor_map[act]
            svc_mean = float(anc.get("mean_seconds", soj["mean"]))
            svc_std  = float(anc.get("std_seconds",  soj["std"]))
            svc_min  = float(anc.get("min_seconds",  0.0))
            svc_max  = anc.get("max_seconds")
            svc_max  = float(svc_max) if svc_max is not None else None
        elif raw_source:
            sub = _select_timing_window(raw_source, service_time_mode)

            sub_stats = _stats(sub)
            svc_mean = sub_stats["mean"]
            svc_std  = sub_stats["std"]    # std of the sub-range — coherent with mean
            svc_min  = sub_stats["min"]
            svc_max  = sub_stats["max"]
        else:
            svc_mean = soj["mean"]
            svc_std  = soj["std"]
            svc_min  = soj["min"]
            svc_max  = soj["max"] if soj["count"] > 0 else None

        # Waiting time = full sojourn mean − service mean (floor 0).
        # Sojourn here is the OCPA sojourn (backward-looking: prev→this event),
        # which represents the total elapsed time including real-world waiting.
        # Subtracting the service estimate gives the process waiting component.
        if soj["count"] > 0 and svc_mean is not None and svc_mean >= 0:
            wait_mean = max(0.0, soj["mean"] - svc_mean)
            wait_std  = soj["std"]
        else:
            wait_mean = None
            wait_std  = None

        result[act] = {
            # OCPA metrics
            "sojourn_mean":  soj["mean"],  "sojourn_std":  soj["std"],
            "sojourn_min":   soj["min"],   "sojourn_max":  soj["max"],
            "sync_mean":     sync["mean"], "sync_std":     sync["std"],
            "flow_mean":     flow["mean"], "flow_std":     flow["std"],
            "pooling_mean":  pool["mean"],
            "lagging_mean":  lag["mean"],
            "waiting_mean":  wait_mean,    "waiting_std":  wait_std,
            # Service time (used by DistributionTimePolicy)
            "service_mean":  svc_mean,     "service_std":  svc_std,
            "service_min":   svc_min,      "service_max":  svc_max,
            "sample_count":  soj["count"],
            # Ready-to-use distribution params (= service time, lognormal by default)
            "dist_type":     "lognormal",
            "mean_seconds":  svc_mean,
            "std_seconds":   svc_std,
            "min_seconds":   svc_min,
            "max_seconds":   svc_max,
        }

    return result


def _event_times_by_activity(ocel_log: Dict[str, Any]) -> Dict[str, List]:
    """activity -> sorted list of datetime timestamps. Shared by the two
    measures below."""
    from datetime import datetime

    def _parse_ts(raw):
        if raw is None:
            return None
        if isinstance(raw, datetime):
            return raw
        try:
            return datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
        except Exception:
            return None

    events = ocel_log.get('events', {})
    evlist = list(events.values()) if isinstance(events, dict) else (events or [])
    by_act: Dict[str, List] = defaultdict(list)
    for ev in evlist:
        act = (ev.get('activity') or ev.get('type') or ev.get('ocel:activity') or '')
        ts = _parse_ts(ev.get('timestamp') or ev.get('ocel:timestamp') or ev.get('time'))
        if act and ts is not None:
            by_act[act].append(ts)
    for act in by_act:
        by_act[act].sort()
    return by_act
