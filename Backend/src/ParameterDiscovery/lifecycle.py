"""Object-lifecycle discovery.

Everything here answers "when does an object of type T come into existence, when
does it end, and how many are born per event". None of it is part of Algorithm 1
of Kuesters & van der Aalst — the OC-DECLARE paper has no notion of an activity
creating or destroying an object. It is prototype machinery the simulator needs
in order to play a model out, kept in its own module so OCDeclarediscovery holds
the behavioural discovery algorithm and its arc serialisation, and nothing else.

How the paper would do it instead: an implicit OCEL pre-processing step adds
artificial <init> T / <exit> T events per object (Sec. 4, p. 11), after which
Algorithm 1 discovers ordinary arcs on them and no lifecycle-specific discovery
step exists at all. That was implemented and measured; the discovery side works,
but the simulator's object supply is a push (activities flagged `creates` mint
objects) where the paper's semantics is a pull (an object is created because a
candidate needs one), so it is not wired in. This module uses observed first/last
activity shares to assign the prototype's lifecycle flags.

Contents
    discover_lifecycle                  creates/deactivates flags per object type
    discover_permanent_object_types     reused ("resource-like") object types
    suggest_permanent_object_threshold  a data-driven cut-off for the above
    discover_creation_counts            how many NEW objects an event introduces
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple


DEFAULT_LIFECYCLE_THRESHOLD = 0.9


def validate_lifecycle_threshold(value: Any) -> float:
    """Accept a finite fraction in (0, 1], including JSON numeric strings."""
    try:
        threshold = float(value)
    except (TypeError, ValueError):
        raise ValueError("Lifecycle threshold must be a number greater than 0 and at most 1.") from None
    if isinstance(value, bool) or not math.isfinite(threshold) or not 0 < threshold <= 1:
        raise ValueError("Lifecycle threshold must be a number greater than 0 and at most 1.")
    return threshold


def discover_lifecycle(
    ocel_log: Dict[str, Any],
    object_type: str,
    lifecycle_threshold: float = DEFAULT_LIFECYCLE_THRESHOLD,
) -> Tuple[Set[str], Set[str]]:
    """Flag activities first/last for at least 90% of an object type by default.

    Every declared instance of the requested type contributes to the denominator,
    including objects with no events. Each observed object contributes exactly one
    first and one last activity. Timestamp ties use event ID as a stable tie-break.
    Creation and deactivation are independent: an activity may receive both flags.
    There are no rare-endpoint exceptions or fallback assignments below the threshold.

    A list of activity traces represents one object instance per trace (empty
    traces count in the denominator). Explicit threshold overrides remain supported.
    """
    threshold = validate_lifecycle_threshold(lifecycle_threshold)
    if isinstance(ocel_log, list):
        first_counts = Counter(trace[0] for trace in ocel_log if trace)
        last_counts = Counter(trace[-1] for trace in ocel_log if trace)
        n_objects = len(ocel_log)
    else:
        objects = ocel_log.get('objects', {}) or {}
        object_items = (objects.items() if isinstance(objects, dict) else
                        ((obj['id'], obj) for obj in objects))
        obj_ids = {oid for oid, obj in object_items
                   if isinstance(obj, dict) and obj.get('type') == object_type}
        n_objects = len(obj_ids)
        if not n_objects:
            return set(), set()

        # Keep only the two endpoints per object; no full trace sort is needed.
        first, last = {}, {}
        events = ocel_log.get('events', {}) or {}
        event_items = (events.items() if isinstance(events, dict) else
                       ((event['id'], event) for event in events))
        for eid, event in event_items:
            if not isinstance(event, dict):
                continue
            activity = event.get('activity') or event.get('type')
            if not activity:
                continue
            relations = event.get('omap') or event.get('relationships') or []
            involved = {rel.get('objectId') if isinstance(rel, dict) else rel for rel in relations}
            involved.intersection_update(obj_ids)
            if not involved:
                continue
            timestamp = event.get('timestamp') or event.get('time')
            try:
                ts = timestamp if isinstance(timestamp, datetime) else datetime.fromisoformat(
                    str(timestamp).replace('Z', '+00:00'))
            except (TypeError, ValueError):
                raise ValueError(f"Event {eid!r} needs a valid timestamp for lifecycle discovery.") from None
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            key = (ts.astimezone(timezone.utc), str(eid))
            for oid in involved:
                if oid not in first or key < first[oid][0]:
                    first[oid] = (key, activity)
                if oid not in last or key > last[oid][0]:
                    last[oid] = (key, activity)
        first_counts = Counter(activity for _, activity in first.values())
        last_counts = Counter(activity for _, activity in last.values())

    if not n_objects:
        return set(), set()
    return (
        {activity for activity, count in first_counts.items() if count / n_objects >= threshold},
        {activity for activity, count in last_counts.items() if count / n_objects >= threshold},
    )


def discover_permanent_object_types(
    ocel_log: Dict[str, Any],
    permanent_threshold: float = 2.0
) -> List[str]:
    """Classify object types as permanent (reusable) objects.

    A type is classified as permanent if the average maximum per-activity
    reuse count per object instance exceeds ``permanent_threshold``.

    "Per-activity reuse" = how many times a single object instance appears in
    the SAME activity. A Forklift firing Weigh 200 times scores 200.
    An applicant firing Interview Held exactly once scores 1 — not permanent.

    This correctly distinguishes shared infrastructure (Forklifts, Trucks) from
    case objects (applicants, orders) that each go through activities at most
    a small fixed number of times.

    Args:
        ocel_log: OCEL 2.0 log dictionary
        permanent_threshold: Minimum average max-per-activity repetitions per
            instance. Default 2.0 — an object must repeat the same activity
            more than twice on average to be classified as permanent.

    Returns:
        List of permanent object type names.
    """
    if isinstance(ocel_log, list):
        return []

    objects = ocel_log.get('objects', {})
    events  = ocel_log.get('events', {})

    from collections import defaultdict

    # Count (obj_id, activity) occurrences
    obj_act_counts: Dict = defaultdict(lambda: defaultdict(int))
    for event_data in events.values():
        activity = (event_data.get('activity') or event_data.get('type') or
                    event_data.get('ocel:activity', ''))
        omap = event_data.get('omap') or []
        if not omap:
            rels = event_data.get('relationships') or []
            omap = [r.get('objectId', r) if isinstance(r, dict) else r for r in rels]
        for obj_id in omap:
            if activity:
                obj_act_counts[obj_id][activity] += 1

    # Build object type map
    obj_type_map = {}
    for obj_id, obj_data in objects.items():
        ot = obj_data.get('type')
        if ot:
            obj_type_map[obj_id] = ot

    # For each instance, find max reuse in any single activity
    type_max_reuse: Dict = defaultdict(list)
    for obj_id, act_counts in obj_act_counts.items():
        ot = obj_type_map.get(obj_id)
        if ot:
            type_max_reuse[ot].append(max(act_counts.values()) if act_counts else 0)

    # Objects with zero events score 0
    for obj_id, obj_data in objects.items():
        ot = obj_data.get('type')
        if ot and obj_id not in obj_act_counts:
            type_max_reuse[ot].append(0)

    permanent_types = []
    for ot, scores in type_max_reuse.items():
        if scores and sum(scores) / len(scores) >= permanent_threshold:
            permanent_types.append(ot)

    return sorted(permanent_types)


def suggest_permanent_object_threshold(ocel_log: Dict[str, Any]) -> Optional[float]:
    """Suggest a threshold for permanent object classification via gap detection.

    Computes the average max-per-activity reuse score per object type, sorts
    them ascending, and finds the pair of adjacent scores with the largest
    relative gap (multiplicative jump).  Returns the geometric mean of those
    two scores as the suggested threshold, or None when the distribution is
    too flat (max gap ratio < 3) or fewer than 2 object types have data.
    """
    import math

    if not isinstance(ocel_log, dict):
        return None

    objects_raw = ocel_log.get('objects') or {}
    events_raw  = ocel_log.get('events')  or {}

    # Support both dict-keyed {id: {type, ...}} and list-based [{id, type, ...}] formats
    if isinstance(events_raw, dict):
        events_iter = events_raw.values()
    elif isinstance(events_raw, list):
        events_iter = events_raw
    else:
        events_iter = []

    obj_act_counts: Dict = defaultdict(lambda: defaultdict(int))
    for event_data in events_iter:
        if not isinstance(event_data, dict):
            continue
        activity = (event_data.get('activity') or event_data.get('type') or
                    event_data.get('ocel:activity', ''))
        omap = event_data.get('omap') or []
        if not omap:
            rels = event_data.get('relationships') or []
            omap = [r.get('objectId', r) if isinstance(r, dict) else r for r in rels]
        for obj_id in omap:
            if activity:
                obj_act_counts[obj_id][activity] += 1

    # Build obj_id → type map; handles both dict-keyed and list formats
    obj_type_map: Dict[str, str] = {}
    if isinstance(objects_raw, dict):
        for obj_id, obj_data in objects_raw.items():
            if isinstance(obj_data, dict):
                ot = obj_data.get('type')
                if ot:
                    obj_type_map[obj_id] = ot
        objects_items = objects_raw.items()
    elif isinstance(objects_raw, list):
        for obj_data in objects_raw:
            if isinstance(obj_data, dict):
                obj_id = obj_data.get('id', '')
                ot = obj_data.get('type')
                if ot and obj_id:
                    obj_type_map[obj_id] = ot
        objects_items = ((o.get('id', ''), o) for o in objects_raw if isinstance(o, dict))
    else:
        objects_items = iter([])

    type_max_reuse: Dict = defaultdict(list)
    for obj_id, act_counts in obj_act_counts.items():
        ot = obj_type_map.get(obj_id)
        if ot:
            type_max_reuse[ot].append(max(act_counts.values()) if act_counts else 0)
    for obj_id, obj_data in objects_items:
        if not isinstance(obj_data, dict):
            continue
        ot = obj_data.get('type')
        if ot and obj_id not in obj_act_counts:
            type_max_reuse[ot].append(0)

    type_scores = {
        ot: sum(scores) / len(scores)
        for ot, scores in type_max_reuse.items()
        if scores
    }

    if len(type_scores) < 2:
        return None

    sorted_scores = sorted(type_scores.values())

    best_ratio = 1.0
    best_i = None
    for i in range(len(sorted_scores) - 1):
        lo = sorted_scores[i]
        hi = sorted_scores[i + 1]
        ratio = (hi / lo) if lo > 0 else (float('inf') if hi > 0 else 1.0)
        if ratio > best_ratio:
            best_ratio = ratio
            best_i = i

    if best_i is None or best_ratio < 3.0:
        return None

    lo = sorted_scores[best_i]
    hi = sorted_scores[best_i + 1]
    threshold = math.sqrt(lo * hi) if lo > 0 else hi
    return round(threshold, 2)


def discover_creation_counts(ocel_log: Dict[str, Any]) -> Dict[str, Dict[str, Dict[str, int]]]:
    """How many objects of each type an activity actually brings into existence.

    An object counts as created by the first event it appears in — the same
    first-appearance rule discover_object_lifecycle uses to set the ``creates``
    flag. The result is the empirical distribution, per (activity, object
    type), of how many *new* objects a single event introduced::

        {activity: {object_type: {"3": 154, "4": 132, ...}}}

    This is deliberately separate from ObjectBinding.min_count/max_count, which
    discover_object_bindings measures as the number of objects of that type
    *present* in the event. For a creating binding those are different
    quantities, and on container_logistics they disagree sharply:

        Order Empty Containers / Container   present 1-5, created 1-5 (identical)
        Book Vehicles / Vehicle              present 0-2, created 0 in 79% of events
        Load Truck / Truck                   present 1,   created 0 in 10547 of 10553

    Collapsing both into one number is what made the engine create min_count
    objects and then top the event up to max_count with unrelated existing
    ones — see the output-binding branch of build_candidate_for_activity.

    Counts of 0 are recorded deliberately: they are how the log states "this
    event re-used objects that already existed", which is the normal case for
    Truck and Forklift and the reason the engine must not assume a creating
    binding always creates.

    Returns an empty dict for logs with no usable timestamps or objects.
    """
    if isinstance(ocel_log, list):
        return {}

    events = ocel_log.get('events', {}) or {}
    objects = ocel_log.get('objects', {}) or {}

    ordered = sorted(
        ((ed.get('timestamp') or '', eid, ed) for eid, ed in events.items()),
        key=lambda t: (t[0], t[1]),
    )

    seen: set = set()
    counts: Dict[str, Dict[str, Dict[str, int]]] = defaultdict(lambda: defaultdict(Counter))

    for _ts, _eid, event_data in ordered:
        activity = event_data.get('activity')
        if not activity:
            continue
        object_ids = event_data.get('omap', []) or event_data.get('relationships', [])

        per_type_total: Dict[str, int] = defaultdict(int)
        per_type_new: Dict[str, int] = defaultdict(int)
        for obj_id in object_ids:
            obj_type = (objects.get(obj_id) or {}).get('type')
            if not obj_type:
                continue
            per_type_total[obj_type] += 1
            if obj_id not in seen:
                per_type_new[obj_type] += 1

        for obj_type in per_type_total:
            counts[activity][obj_type][str(per_type_new.get(obj_type, 0))] += 1

        for obj_id in object_ids:
            seen.add(obj_id)

    # Drop (activity, type) pairs that never create anything — those bindings
    # are pure inputs and the engine reads min_count/max_count for them.
    out: Dict[str, Dict[str, Dict[str, int]]] = {}
    for activity, by_type in counts.items():
        kept = {ot: dict(dist) for ot, dist in by_type.items()
                if any(int(k) > 0 for k in dist)}
        if kept:
            out[activity] = kept
    return out
