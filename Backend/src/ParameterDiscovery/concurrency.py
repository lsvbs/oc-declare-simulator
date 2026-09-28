"""Activity concurrency discovery and the retained, unenforced WIP measure."""
from collections import defaultdict
from typing import Any, Dict, List, Optional
from Backend.src.ParameterDiscovery.timediscovery import compute_ocpa_metrics, _event_times_by_activity


def discover_wip_caps(
    ocel_log: Dict[str, Any],
    safety_factor: float = 1.0,
) -> Dict[str, int]:
    """Measure the peak number of simultaneously in-flight objects per type.

    An object counts as "in flight" between its first and its last event in
    the log. Sweeping those intervals per object type gives the highest
    number of instances the real process ever had open at once — its
    work-in-progress (WIP) ceiling.

    NOT ENFORCED BY THE SIMULATOR. This was briefly used as an admission-control
    cap and has been removed: how many objects of a type are alive at once is an
    emergent quantity, not a rule. Containers peak at 102 in this log because
    arrival rate times lifecycle duration equals that (L = lambda * W), not
    because anything refused to create the 103rd. Capping it turned an output
    into an input and masked an unbalanced model.

    It survives as a VALIDATION measure: run the simulation, sweep the simulated
    log the same way, and compare peaks against these. If the simulated peak
    settles near the log's, the model balances on its own; if it grows without
    bound, something upstream (arrival rate, starved consumer, selection) is
    wrong — and that is the finding, not something to cap away.

    This is a *simulation parameter*, not part of the OC-Declare model, and is
    deliberately never written into the discovered model file — that file must
    stay identical to what the OCPQ-Converter produces. It is measured from the
    OCEL and merged at simulation setup, the same way activity_durations is
    (Backend.server._merge_wip_caps).

    On container_logistics this is the difference between ~175 objects in
    flight (the real log's peak, summed over types) and >6000 and climbing.

    NOTE ON SEMANTICS: a WIP cap is *not* derivable from the OC-Declare
    constraints — the formalism says nothing about capacity. This supplies
    the missing "capacity" leg of the discrete-event triple (arrival /
    capacity / service) and is a modelling assumption layered on top of the
    discovered model, calibrated from the log. It should be documented as
    such rather than presented as OC-Declare semantics.

    NOTE ON PERMANENT OBJECT TYPES: this measure is currently computed and
    applied for *all* object types. Once permanent-object / resource-type
    handling is re-enabled (see the "[resource/permanent-object handling —
    disabled, kept for reference]" markers in the engine), permanent types
    should be *excluded* here and capped by their resource pool size instead:
    their capacity is the size of the pool, not a WIP ceiling, and they are
    never created mid-simulation. Conveniently the same sweep identifies
    them — a permanent type's mean in-flight count equals its total instance
    count (Truck 5.9/6, Forklift 3.0/3 on container_logistics, versus <=0.05
    for every transient type).

    Args:
        ocel_log: OCEL 2.0 log dictionary (as returned by load_ocel2)
        safety_factor: multiplier applied to the observed peak before
            rounding up. 1.0 caps exactly at the observed peak; >1.0 leaves
            headroom.

    Returns:
        {object_type: cap}, omitting types with no timestamped events.
    """
    if isinstance(ocel_log, list):
        return {}

    objects = ocel_log.get('objects', {})
    events = ocel_log.get('events', {})
    if not objects or not events:
        return {}

    import math
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

    # obj_id → (first_ts, last_ts)
    first_ts: Dict[str, Any] = {}
    last_ts: Dict[str, Any] = {}
    for event_data in events.values():
        ts = _parse_ts(event_data.get('timestamp') or
                       event_data.get('ocel:timestamp') or
                       event_data.get('time'))
        if ts is None:
            continue
        omap = event_data.get('omap') or []
        if not omap:
            rels = event_data.get('relationships') or []
            omap = [r.get('objectId', r) if isinstance(r, dict) else r for r in rels]
        for obj_id in omap:
            prev_first = first_ts.get(obj_id)
            if prev_first is None or ts < prev_first:
                first_ts[obj_id] = ts
            prev_last = last_ts.get(obj_id)
            if prev_last is None or ts > prev_last:
                last_ts[obj_id] = ts

    # Group the [first, last] intervals by object type
    by_type: Dict[str, List] = defaultdict(list)
    for obj_id, start in first_ts.items():
        obj_data = objects.get(obj_id)
        ot = obj_data.get('type') if isinstance(obj_data, dict) else None
        if ot:
            by_type[ot].append((start, last_ts[obj_id]))

    caps: Dict[str, int] = {}
    for ot, intervals in by_type.items():
        # Sweep line: +1 at each interval start, -1 at each end. Ends are
        # processed before starts at an identical timestamp (-1 sorts before
        # +1), so an object closing and another opening at the same instant
        # does not inflate the peak.
        points = sorted(
            [(s, 1) for s, _ in intervals] + [(e, -1) for _, e in intervals],
            key=lambda p: (p[0], p[1])
        )
        cur = peak = 0
        for _, delta in points:
            cur += delta
            if cur > peak:
                peak = cur
        if peak > 0:
            caps[ot] = max(1, int(math.ceil(peak * safety_factor)))

    return caps



def discover_activity_concurrency(
    ocel_log: Dict[str, Any],
    metrics: Optional[Dict[str, Any]] = None,
    safety_factor: float = 1.0,
) -> Dict[str, int]:
    """Peak number of simultaneously in-progress instances, per activity.

    OCEL events are instantaneous, so an occupancy interval is reconstructed as
    [t, t + service_mean] using the discovered service time, and the intervals
    of each activity are swept for their maximum overlap.

    The simulator uses the result as a concurrency ceiling: an activity already
    running that many instances does not start another until one completes.
    This bounds ``state.in_progress``, which matters because objects are created
    when an activity *starts*, not when it completes — so an activity that
    starts far faster than it finishes manufactures objects indefinitely. On
    container_logistics, 'Register Customer Order' (mean service ~51157s, one
    candidate per step) reached 593 simultaneous instances against a measured
    real-log peak of 3.

    Unlike the object-level WIP cap this one *does* apply to start activities:
    it limits the rate at which arrivals enter the system rather than refusing
    them for lack of downstream capacity.

    Like wip_caps this is a simulation parameter, never written into the
    OC-Declare model file — it is merged at simulation setup.

    Args:
        ocel_log: OCEL 2.0 log dictionary (as returned by load_ocel2)
        metrics:  output of compute_ocpa_metrics; computed on demand if omitted
        safety_factor: multiplier on the observed peak before rounding up

    Returns:
        {activity: max_concurrent_instances}, minimum 1.
    """
    if isinstance(ocel_log, list):
        return {}
    by_act = _event_times_by_activity(ocel_log)
    if not by_act:
        return {}
    if metrics is None:
        metrics = compute_ocpa_metrics(ocel_log, [], service_time_mode='p25')

    import math
    caps: Dict[str, int] = {}
    for act, times in by_act.items():
        svc = float((metrics.get(act) or {}).get('mean_seconds', 0.0) or 0.0)
        if svc <= 0 or not times:
            # No measurable service time — one at a time is the safe reading.
            caps[act] = 1
            continue
        # Sweep: ends (-1) sort before starts (+1) at equal timestamps so an
        # instance finishing as another begins does not inflate the peak.
        pts = sorted([(t, 1) for t in times]
                     + [(t + _timedelta_seconds(svc), -1) for t in times],
                     key=lambda p: (p[0], p[1]))
        cur = peak = 0
        for _, d in pts:
            cur += d
            if cur > peak:
                peak = cur
        caps[act] = max(1, int(math.ceil(peak * safety_factor)))
    return caps



def _timedelta_seconds(seconds: float):
    from datetime import timedelta
    return timedelta(seconds=seconds)
