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
candidate needs one), so it is not wired in. See the note above
discover_lifecycle for the measured comparison.

Contents
    discover_lifecycle                  creates/deactivates flags per object type
    discover_permanent_object_types     reused ("resource-like") object types
    suggest_permanent_object_threshold  a data-driven cut-off for the above
    discover_creation_counts            how many NEW objects an event introduces
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple


def discover_lifecycle(
    ocel_log: Dict[str, Any],
    object_type: str,
    lifecycle_threshold: float = 0.5
) -> Tuple[Set[str], Set[str]]:
    """Discover which activities create and terminate objects.

    An activity is considered a *creator* only if it is the first activity for
    at least ``lifecycle_threshold`` fraction of all instances of ``object_type``
    (default 50 %).  Likewise for *terminators*.  An activity that already
    qualifies as a creator is never additionally marked as a terminator, which
    prevents the spurious ``creates AND consumes`` flag that arises when a small
    number of single-event object instances make the first and last activity
    identical.

    The threshold approach follows the support-based filtering convention used in
    Declare/OC-Declare mining (Di Ciccio & Montali, 2022).

    Args:
        ocel_log: OCEL 2.0 log dictionary
        object_type: Object type to analyze
        lifecycle_threshold: Minimum fraction of instances (0–1) for which an
            activity must be the first/last event to qualify as a
            creator/terminator.  Default is 0.5 (majority).

    Returns:
        Tuple of (creating_activities, terminating_activities)
    """
    from collections import Counter

    # Handle both OCEL 2.0 (dict) and simple list format
    if isinstance(ocel_log, list):
        # For simple list format, just use first/last activity in traces
        creating_activities = set()
        terminating_activities = set()
        
        for trace in ocel_log:
            if trace:
                creating_activities.add(trace[0])
                terminating_activities.add(trace[-1])
        
        return creating_activities, terminating_activities
    
    objects = ocel_log.get('objects', {})
    events = ocel_log.get('events', {})

    # Build object-type filter set for this type — O(N_objects)
    obj_ids_of_type = {
        oid for oid, od in objects.items()
        if isinstance(od, dict) and od.get('type') == object_type
    }
    if not obj_ids_of_type:
        return set(), set()

    # Single pass over events: collect (timestamp, activity) per relevant object — O(N_events)
    obj_timeline: Dict[str, list] = defaultdict(list)
    ev_iter = events.items() if isinstance(events, dict) else []
    for eid, edata in ev_iter:
        if not isinstance(edata, dict):
            continue
        activity  = edata.get('activity') or edata.get('type', '')
        timestamp = edata.get('timestamp', '')
        if not activity:
            continue
        omap = edata.get('omap') or edata.get('relationships') or []
        for oid in omap:
            if oid in obj_ids_of_type:
                obj_timeline[oid].append((timestamp, activity))

    # Extract first/last activity per object
    object_first_activity = {}
    object_last_activity  = {}
    for oid, timeline in obj_timeline.items():
        timeline.sort(key=lambda x: x[0])
        object_first_activity[oid] = timeline[0][1]
        object_last_activity[oid]  = timeline[-1][1]
    
    # Aggregate: only keep activities that appear as first/last for enough instances
    n = len(object_first_activity)
    if n == 0:
        return set(), set()

    first_counts = Counter(object_first_activity.values())
    last_counts  = Counter(object_last_activity.values())

    creating_activities = {
        act for act, cnt in first_counts.items()
        if cnt / n >= lifecycle_threshold
    }

    # Objects whose entire life is a single event. For those, first and last
    # activity are necessarily the same, and "creates AND deactivates on the
    # same binding" is not a spurious flag — it is what the log says. The
    # engine supports it: _des_start_activity appends created objects to the
    # in-progress record's participating_object_ids, so _des_complete_activity
    # retires them when the activity finishes.
    single_event_share = Counter()
    for oid, timeline in obj_timeline.items():
        if len(timeline) == 1:
            single_event_share[timeline[0][1]] += 1

    terminating_activities = set()
    for act, cnt in last_counts.items():
        if cnt / n < lifecycle_threshold:
            continue
        if act not in creating_activities:
            terminating_activities.add(act)
            continue
        # The activity is also a creator. Keep the original guard — which
        # exists to suppress a creates+consumes flag caused by a handful of
        # single-event instances — UNLESS single-event objects are the norm for
        # this type rather than the exception.
        #
        # On BPIC17 they are the norm: 96.9% of Offer objects appear only in
        # O_Create Offer, and 97.8% of Workflow objects only in W_Handle leads.
        # The unconditional guard therefore fired on the majority case and left
        # those types with no terminator at all, so they were never retired and
        # accumulated for the whole run.
        if single_event_share[act] / n >= lifecycle_threshold:
            terminating_activities.add(act)

    # Rare but unambiguous endpoints: an activity that EVERY object of this type
    # ends on, however few reach it. The frequency vote above cannot see these —
    # O_Refused terminates 0.3% of Offers, far under any sensible threshold —
    # yet an object reaching one is finished, and leaving it active leaks it.
    #
    # Measured from the log rather than inferred from the model's structure. The
    # obvious alternative is "an activity with no outgoing response constraint
    # is an endpoint", but absence of an obligation means nothing is *required*
    # after A, not that nothing *happens* after A. Checked on container
    # logistics, 3 of 8 such structural endpoints are not terminal at all:
    # Place in Stock ends 0% of Forklifts and Drive to Terminal ends 17% of
    # Trucks — exactly the reused resource types. Marking those would retire
    # objects mid-life. The log-based test cannot make that mistake: if an
    # object ever continues past A, A is not marked.
    for act in last_counts:
        if act in terminating_activities:
            continue
        reached = sum(1 for tlin in obj_timeline.values()
                      if any(a == act for _ts, a in tlin))
        if reached and last_counts[act] == reached:
            terminating_activities.add(act)

    return creating_activities, terminating_activities


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

