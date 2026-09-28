"""
OC-Declare Model Discovery from OCEL 2.0 Event Logs

This module discovers OC-Declare declarative constraints from object-centric event logs.
It mines constraints like precedence and response rules with support/confidence metrics.
"""

import json
from pathlib import Path
from typing import Dict, List, Set, Tuple, Any, Optional
from collections import Counter, defaultdict, deque
from Backend.src.Simulation.IO.input.ocel import load_ocel2
from Backend.src.ParameterDiscovery.lifecycle import DEFAULT_LIFECYCLE_THRESHOLD


def discover_object_types(ocel_log: Dict[str, Any]) -> List[str]:
    """Discover all object types in the log.
    
    Args:
        ocel_log: OCEL 2.0 log dictionary
        
    Returns:
        List of unique object type names
    """
    # Handle simple list format
    if isinstance(ocel_log, list):
        return ['case']  # Simple lists have implicit "case" object type
    
    objects = ocel_log.get('objects', {})
    
    # Check if objects is a dict or list
    if isinstance(objects, list):
        return ['case']  # Fallback for malformed data
    
    object_types = set()
    
    for obj_data in objects.values():
        obj_type = obj_data.get('type')
        if obj_type:
            object_types.add(obj_type)
    
    return sorted(list(object_types))


def discover_activities(ocel_log: Dict[str, Any]) -> List[str]:
    """Discover all activities in the log.
    
    Args:
        ocel_log: OCEL 2.0 log dictionary
        
    Returns:
        List of unique activity names
    """
    # Handle simple list format
    if isinstance(ocel_log, list):
        activities = set()
        for trace in ocel_log:
            activities.update(trace)
        return sorted(list(activities))
    
    events = ocel_log.get('events', {})
    activities = set()
    
    for event_data in events.values():
        activity = event_data.get('activity')
        if activity:
            activities.add(activity)
    
    return sorted(list(activities))


# ──────────────────────────────────────────────────────────────────────────────
# Küsters & van der Aalst (2025) OC-Declare Discovery
# Reference: https://github.com/aarkue/OCPQ (rust4pm dependency)
# "OC-DECLARE: Discovering Object-Centric Declarative Patterns with Synchronization"
# ──────────────────────────────────────────────────────────────────────────────

def _build_discovery_indices(ocel_log: Dict[str, Any]) -> Dict[str, Any]:
    """Build lookup tables for efficient arc checking."""
    events  = ocel_log.get('events', {})
    objects = ocel_log.get('objects', {})

    events_by_activity: Dict[str, List[str]]            = defaultdict(list)
    events_by_object:   Dict[str, List[Tuple]]           = defaultdict(list)  # oid→[(ts,eid)]
    event_objs_by_type: Dict[str, Dict[str, List[str]]] = {}
    event_time:         Dict[str, str]                   = {}
    event_activity_map: Dict[str, str]                   = {}

    ev_items = events.items() if isinstance(events, dict) else []
    for eid, edata in ev_items:
        if not isinstance(edata, dict):
            continue
        activity  = edata.get('activity') or edata.get('type', '')
        timestamp = edata.get('timestamp', '')
        omap      = edata.get('omap', []) or edata.get('relationships', [])
        if not activity:
            continue
        events_by_activity[activity].append(eid)
        event_time[eid] = timestamp
        event_activity_map[eid] = activity
        by_type: Dict[str, List[str]] = defaultdict(list)
        for oid in omap:
            obj   = (objects.get(oid) if isinstance(objects, dict) else None) or {}
            otype = obj.get('type', '')
            if otype:
                by_type[otype].append(oid)
                events_by_object[oid].append((timestamp, eid))
        event_objs_by_type[eid] = dict(by_type)

    for oid in events_by_object:
        events_by_object[oid].sort(key=lambda x: x[0])

    return {
        'events_by_activity': dict(events_by_activity),
        'events_by_object':   dict(events_by_object),
        'event_objs_by_type': event_objs_by_type,
        'event_time':         event_time,
        'event_activity':     event_activity_map,
    }


def _get_max_objects_per_event(
    ocel_log: Dict[str, Any],
    activities: List[str],
    object_types: List[str],
) -> Dict[str, Dict[str, int]]:
    """Return {activity: {obj_type: max_objects_in_any_single_event}}."""
    events  = ocel_log.get('events', {})
    objects = ocel_log.get('objects', {})
    act_set = set(activities)
    ot_set  = set(object_types)
    result: Dict[str, Dict[str, int]] = {a: {} for a in activities}

    ev_items = events.items() if isinstance(events, dict) else []
    for eid, edata in ev_items:
        if not isinstance(edata, dict):
            continue
        activity = edata.get('activity') or edata.get('type', '')
        if activity not in act_set:
            continue
        omap = edata.get('omap', []) or edata.get('relationships', [])
        counts: Dict[str, int] = {}
        for oid in omap:
            obj = (objects.get(oid) if isinstance(objects, dict) else None) or {}
            otype = obj.get('type', '')
            if otype in ot_set:
                counts[otype] = counts.get(otype, 0) + 1
        for otype, cnt in counts.items():
            if cnt > result[activity].get(otype, 0):
                result[activity][otype] = cnt
    return result


def _count_qualifying_events(
    oid: str,
    t_A: str,
    arc_type: str,
    obj_B_events: Dict[str, List[Tuple]],
) -> int:
    """Count qualifying B-events for one object binding (AS / EF / EP)."""
    b_events = obj_B_events.get(oid, [])
    if arc_type == 'EF':
        return sum(1 for ts, _ in b_events if ts > t_A)
    if arc_type == 'EP':
        return sum(1 for ts, _ in b_events if ts < t_A)
    return len(b_events)  # AS


def _direct_binding_counts(idx, activation, target, arrow, bindings):
    """Object filters first, nearest strict timestamp second, activity last."""
    from itertools import product
    by_type = idx['event_objs_by_type'].get(activation, {})
    each, required, anys = [], set(), []
    for typ, mode in bindings:
        ids = set(by_type.get(typ, ()))
        if mode == 'each':
            each.append(sorted(ids))
        elif mode == 'all':
            required.update(ids)
        elif mode == 'any':
            anys.append(ids)
    timestamp = idx['event_time'][activation]
    for assignment in product(*each):
        filters = [{eid for _, eid in idx['events_by_object'].get(oid, ())}
                   for oid in required.union(assignment)]
        for group in anys:
            filters.append({eid for oid in group for _, eid in idx['events_by_object'].get(oid, ())})
        candidates = set.intersection(*filters) if filters else set(idx['event_time'])
        candidates = {eid for eid in candidates
                      if (idx['event_time'][eid] > timestamp if arrow == 'DF'
                          else idx['event_time'][eid] < timestamp)}
        if not candidates:
            yield 0
            continue
        nearest = (min if arrow == 'DF' else max)(idx['event_time'][eid] for eid in candidates)
        yield sum(idx['event_activity'][eid] == target for eid in candidates
                  if idx['event_time'][eid] == nearest)


def _count_df_dp(
    oid: str,
    t_A: str,
    act_B: str,
    arc_type: str,
    events_by_object: Dict[str, List[Tuple]],
    event_activity: Dict[str, str],
) -> int:
    """Return 1 if the directly adjacent event (DF: after, DP: before) is act_B, else 0."""
    obj_events = events_by_object.get(oid, [])  # sorted (ts, eid)
    if arc_type == 'DF':
        for ts, eid in obj_events:
            if ts > t_A:
                return 1 if event_activity.get(eid) == act_B else 0
    else:  # DP
        for ts, eid in reversed(obj_events):
            if ts < t_A:
                return 1 if event_activity.get(eid) == act_B else 0
    return 0


def _occurrences_per_object(idx: Dict[str, Any], activity: str, obj_type: str) -> Dict[str, int]:
    """object_id -> number of `activity` events that object took part in.

    This is the quantity the simulator's nmin/nmax actually read — see
    semantics.check_precedence, which counts events of an activity *per scope
    object*. Discovery's counts_min/counts_max are a different thing: acceptance
    thresholds on how many qualifying events exist per source event. Measuring
    the enforced quantity directly is what keeps a discovered nmax and a
    hand-set one meaning the same thing in the same field.
    """
    out: Dict[str, int] = {}
    for eid in idx['events_by_activity'].get(activity, []):
        for oid in idx['event_objs_by_type'].get(eid, {}).get(obj_type, []):
            out[oid] = out.get(oid, 0) + 1
    return out


def _joint_occurrences(idx: Dict[str, Any], activity: str,
                       each_types: List[str]) -> Dict[tuple, int]:
    """assignment -> number of `activity` events involving every object in it.

    The multi-type generalisation of _occurrences_per_object. An *assignment* is
    one object per Each label — exactly what Definition 8's universal quantifier
    ranges over::

        for all o_1 in obj^ot1(e), ..., o_n in obj^otn(e):  n_min <= |f| <= n_max

    and |f| is the size of a single JOINT event set, so the bound has to be
    fitted to a joint count too. Measuring the primary label's marginal instead
    fits the wrong quantity: a marginal is always >= the intersection, so the
    fitted n_max comes out too permissive. On container_logistics that is
    `Book Vehicles -> Depart`, fitted 3 from Transport Document where the true
    joint maximum over (Transport Document, Vehicle) pairs is 1.

    Reduces to _occurrences_per_object when there is exactly one Each label, so
    single-label arcs keep their previous numbers exactly.

    All/Any labels are deliberately not folded in. They narrow `f` further in
    semantics._nmax_blocked, so leaving them out can only make the fitted
    maximum larger than the enforced count — loose, never blocking something
    the log permits.
    """
    from itertools import product as _iproduct
    out: Dict[tuple, int] = {}
    for eid in idx['events_by_activity'].get(activity, []):
        by_type = idx['event_objs_by_type'].get(eid, {})
        groups = [by_type.get(t) or () for t in each_types]
        if any(not g for g in groups):
            continue
        for assignment in _iproduct(*groups):
            out[assignment] = out.get(assignment, 0) + 1
    return out


def _check_arc(
    idx: Dict[str, Any],
    act_A: str,
    act_B: str,
    arc_type: str,
    obj_type: str,
    involvement: str,
    noise_threshold: float,
    counts_min: int = 1,
    counts_max: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Check one OC-Declare arc (act_A → act_B, arc_type, obj_type, involvement).

    counts_max defaults to None (unbounded), matching the paper: Section 5
    discovers existence constraints with n_min = 1 and n_max = infinity. An
    earlier undocumented default of 20 rejected any arc where a source event had
    more than 20 qualifying target events, which silently removed six arcs the
    OCPQ converter finds — every arc involving Forklift or Truck. Those objects
    recur across thousands of events, so the single-type arc blew the cap, never
    entered X, and the valid multi-type combination (e.g. {Container: each,
    Forklift: each}) became unreachable because combine() can only merge arcs
    already in X.

    The per-scope-object nmin/nmax reported on the emitted arc are measured
    separately (see the observed_counts block below) and are unaffected.

    involvement semantics mirror OCPQ/rust4pm OCDeclareArcLabel.get_bindings():
      'each' — one binding per T-object in source event; event violated if ANY fails.
      'any'  — one binding (union of all T-objects); event violated if NONE qualifies.
      'all'  — one binding requiring ALL T-objects in the same target event.

    support = satisfied_events / total_events_with_T-object.
    Returns arc dict if support >= 1 − noise_threshold, else None.
    """
    eids_A     = idx['events_by_activity'].get(act_A, [])
    eids_B_set = set(idx['events_by_activity'].get(act_B, []))
    if not eids_A or not eids_B_set:
        return None

    event_time         = idx['event_time']
    event_objs_by_type = idx['event_objs_by_type']
    events_by_object   = idx['events_by_object']
    event_activity     = idx['event_activity']

    # Build per-object B-event index: oid → [(ts, eid)]
    obj_B_events: Dict[str, List[Tuple]] = {}
    for eid in eids_B_set:
        for oid in event_objs_by_type.get(eid, {}).get(obj_type, []):
            obj_B_events.setdefault(oid, []).append((event_time.get(eid, ''), eid))
    for oid in obj_B_events:
        obj_B_events[oid].sort()

    total = satisfied = 0

    # 'AS' + 'any' qualifying-event count doesn't depend on t_A — it's a pure
    # function of the (frozen) set of A-side objects in the event. Without
    # this cache it gets rebuilt by re-scanning every A-object's full B-event
    # list on every single A-event, which is invisible for ordinary case
    # objects but very expensive for high-frequency shared/resource objects
    # (e.g. a handful of forklifts each touching thousands of events) (#22).
    as_any_cache: Dict[frozenset, int] = {}

    for eid_A in eids_A:
        A_objs = event_objs_by_type.get(eid_A, {}).get(obj_type, [])
        if not A_objs:
            continue
        t_A = event_time.get(eid_A, '')
        total += 1
        if arc_type in ('DF', 'DP'):
            counts = _direct_binding_counts(idx, eid_A, act_B, arc_type, [(obj_type, involvement)])
            satisfied += int(all(n >= counts_min and (counts_max is None or n <= counts_max) for n in counts))
            continue
        event_ok = False

        if involvement == 'each':
            event_ok = True
            for oid in A_objs:
                if arc_type in ('DF', 'DP'):
                    cnt = _count_df_dp(oid, t_A, act_B, arc_type, events_by_object, event_activity)
                else:
                    cnt = _count_qualifying_events(oid, t_A, arc_type, obj_B_events)
                if cnt < counts_min or (counts_max is not None and cnt > counts_max):
                    event_ok = False
                    break

        elif involvement == 'any':
            if arc_type in ('DF', 'DP'):
                event_ok = any(
                    _count_df_dp(oid, t_A, act_B, arc_type, events_by_object, event_activity) >= counts_min
                    for oid in A_objs
                )
            elif arc_type == 'AS':
                # t_A-independent — cache per distinct A_objs set (#22).
                cache_key = frozenset(A_objs)
                cnt = as_any_cache.get(cache_key)
                if cnt is None:
                    qualifying_eids: Set[str] = set()
                    for oid in A_objs:
                        for ts, eid in obj_B_events.get(oid, []):
                            qualifying_eids.add(eid)
                    cnt = len(qualifying_eids)
                    as_any_cache[cache_key] = cnt
                event_ok = cnt >= counts_min and (counts_max is None or cnt <= counts_max)
            else:
                qualifying_eids: Set[str] = set()
                for oid in A_objs:
                    for ts, eid in obj_B_events.get(oid, []):
                        if arc_type == 'EF' and ts > t_A:
                            qualifying_eids.add(eid)
                        elif arc_type == 'EP' and ts < t_A:
                            qualifying_eids.add(eid)
                cnt = len(qualifying_eids)
                event_ok = cnt >= counts_min and (counts_max is None or cnt <= counts_max)

        elif involvement == 'all':
            if len(A_objs) == 1:
                oid = A_objs[0]
                cnt = (_count_df_dp(oid, t_A, act_B, arc_type, events_by_object, event_activity)
                       if arc_type in ('DF', 'DP')
                       else _count_qualifying_events(oid, t_A, arc_type, obj_B_events))
                event_ok = cnt >= counts_min and (counts_max is None or cnt <= counts_max)
            else:
                A_objs_set = set(A_objs)
                first_oid  = A_objs[0]
                qualifying_all: Set[str] = set()
                for ts, eid in obj_B_events.get(first_oid, []):
                    if arc_type == 'EF' and ts <= t_A:
                        continue
                    if arc_type == 'EP' and ts >= t_A:
                        continue
                    b_objs = set(event_objs_by_type.get(eid, {}).get(obj_type, []))
                    if A_objs_set.issubset(b_objs):
                        qualifying_all.add(eid)
                cnt = len(qualifying_all)
                event_ok = cnt >= counts_min and (counts_max is None or cnt <= counts_max)

        if event_ok:
            satisfied += 1

    if total == 0:
        return None
    support = satisfied / total
    if support < 1.0 - noise_threshold:
        return None

    # Observed per-scope-object occurrence counts for BOTH endpoints.
    #
    # counts_min/counts_max are acceptance thresholds (1 and unbounded) — they
    # say what this call was willing to accept, not what the log contains. The
    # arc used to publish them verbatim as its counts, so every discovered
    # constraint reported nmin=1 because that was the parameter, and nmax=None
    # even though counts_max had just been verified to hold. Both are now
    # measured instead, from the quantity the simulator actually enforces:
    # occurrences of an activity per scope object.
    occ_A = _occurrences_per_object(idx, act_A, obj_type)
    occ_B = _occurrences_per_object(idx, act_B, obj_type)
    obs_min_A = min(occ_A.values()) if occ_A else counts_min
    obs_max_A = max(occ_A.values()) if occ_A else None
    obs_min_B = min(occ_B.values()) if occ_B else counts_min
    obs_max_B = max(occ_B.values()) if occ_B else None

    return {
        'from':                  act_A,
        'to':                    act_B,
        'arc_type':              arc_type,
        'label':                 [obj_type],
        'involvement':           involvement,
        'involvement_per_label': {obj_type: involvement},
        'counts':                [counts_min, counts_max],
        # Per-endpoint observed occurrences per scope object. _arcs_to_deco_constraints
        # maps these onto nmin/nmax according to which endpoint becomes source
        # and which becomes target after the EP/DP swap.
        'observed_counts': {
            'from': [obs_min_A, obs_max_A],
            'to':   [obs_min_B, obs_max_B],
        },
        'support':               round(support, 4),
    }


def _stricter_arrow_candidates(base: str, arc_types: Optional[List[str]]) -> List[str]:
    """Arrow types to try, weakest-first, when escalating a discovered arc (Lemma 1).

    AS ("exists sometime") is the least strict. EF/EP restrict the target events
    to those after/before the source event; DF/DP restrict them further to the
    directly-following/preceding one. Trying in this order and keeping the last
    success yields the strictest satisfied arrow.
    """
    allowed = set(arc_types or ['EF', 'EP', 'AS'])
    order = ['EF', 'DF', 'EP', 'DP']
    return [a for a in order if a in allowed]


def _get_stricter_arc_type(
    idx: Dict[str, Any],
    act_A: str,
    act_B: str,
    obj_type: str,
    involvement: str,
    arc_types: List[str],
    noise_threshold: float,
    counts_min: int,
    counts_max: Optional[int],
) -> List[Dict[str, Any]]:
    """
    Given a viable AS-candidate, find the strictest arc type(s).
    Mirrors OCPQ's get_stricter_arrows_for_as:
      EF → try DF; EP → try DP; fall back to AS only if nothing else qualifies and A≠B.
    """
    ret: List[Dict[str, Any]] = []

    def _try(atype: str) -> Optional[Dict[str, Any]]:
        return _check_arc(idx, act_A, act_B, atype, obj_type, involvement,
                          noise_threshold, counts_min, counts_max)

    if 'EF' in arc_types or 'DF' in arc_types:
        if 'EF' in arc_types:
            ef = _try('EF')
            if ef is not None:
                df = _try('DF') if 'DF' in arc_types else None
                ret.append(df if df is not None else ef)
        elif 'DF' in arc_types:
            df = _try('DF')
            if df is not None:
                ret.append(df)

    if 'EP' in arc_types or 'DP' in arc_types:
        if 'EP' in arc_types:
            ep = _try('EP')
            if ep is not None:
                dp = _try('DP') if 'DP' in arc_types else None
                ret.append(dp if dp is not None else ep)
        elif 'DP' in arc_types:
            dp = _try('DP')
            if dp is not None:
                ret.append(dp)

    # AS only as fallback for non-self-loop pairs
    if not ret and 'AS' in arc_types and act_A != act_B:
        a_arc = _try('AS')
        if a_arc is not None:
            ret.append(a_arc)

    return ret


def _arc_type_dominated_by_or_eq(arc_type: str, other: str) -> bool:
    """True when `arc_type` is implied by (dominated by) `other`."""
    if arc_type == other:
        return True
    if arc_type == 'AS':
        return True
    if other == 'AS':
        return False
    return (arc_type == 'EF' and other == 'DF') or (arc_type == 'EP' and other == 'DP')


def _involvement_strength(inv: str) -> int:
    return {'any': 0, 'each': 1, 'all': 2}.get(inv, 1)


def _get_df_dp_eid(
    oid: str,
    t_A: str,
    arc_type: str,
    act_B: str,
    events_by_object: Dict[str, List[Tuple]],
    event_activity: Dict[str, str],
) -> Optional[str]:
    """Return the ID of the directly adjacent act_B event (DF: after, DP: before), or None."""
    obj_events = events_by_object.get(oid, [])
    if arc_type == 'DF':
        for ts, eid in obj_events:
            if ts > t_A:
                return eid if event_activity.get(eid) == act_B else None
    else:  # DP
        for ts, eid in reversed(obj_events):
            if ts < t_A:
                return eid if event_activity.get(eid) == act_B else None
    return None


def _check_arc_multi_type(
    idx: Dict[str, Any],
    act_A: str,
    act_B: str,
    arc_type: str,
    bindings: List[Tuple[str, str]],
    noise_threshold: float,
    counts_min: int = 1,
    counts_max: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Check a multi-type OC-Declare arc (len(bindings) >= 2).

    For each source event that has objects of every type in bindings, the event
    is satisfied when there exists a single target event satisfying all type
    conditions simultaneously.

    For 'any'/'all' bindings and single-object 'each': one qualifying frozenset.
    For multi-object 'each': Cartesian product — every combination of one object
    per multi-object-each type must find a qualifying B-event containing all
    assigned objects at once.
    """
    if len(bindings) < 2:
        return None

    obj_types = [t for t, _ in bindings]
    eids_A = idx['events_by_activity'].get(act_A, [])
    eids_B: Set[str] = set(idx['events_by_activity'].get(act_B, []))
    if not eids_A or not eids_B:
        return None

    event_time         = idx['event_time']
    event_objs_by_type = idx['event_objs_by_type']
    events_by_object   = idx['events_by_object']
    event_activity     = idx['event_activity']

    # Build per-type B-events index: {obj_type: {oid: [(ts, eid)]}}
    b_evt: Dict[str, Dict[str, List[Tuple]]] = {ot: {} for ot in obj_types}
    for eid in eids_B:
        eot = event_objs_by_type.get(eid, {})
        for ot in obj_types:
            for oid in eot.get(ot, []):
                b_evt[ot].setdefault(oid, []).append((event_time.get(eid, ''), eid))
    for ot in b_evt:
        for oid in b_evt[ot]:
            b_evt[ot][oid].sort()

    total = satisfied = 0

    for eid_A in eids_A:
        eot_A = event_objs_by_type.get(eid_A, {})
        if any(not eot_A.get(ot) for ot in obj_types):
            continue
        t_A = event_time.get(eid_A, '')
        total += 1

        if arc_type in ('DF', 'DP'):
            counts = _direct_binding_counts(idx, eid_A, act_B, arc_type, bindings)
            satisfied += int(all(n >= counts_min and (counts_max is None or n <= counts_max) for n in counts))
            continue

        # Compute qualifying B-event sets per binding.
        # Most bindings produce a single frozenset; multi-object 'each' produces
        # a list of per-object frozensets that are checked separately.
        single_sets: List = []
        multi_sets: List = []

        for ot, inv in bindings:
            A_objs = eot_A.get(ot, [])

            if arc_type in ('DF', 'DP'):
                if inv == 'any':
                    q: Set[str] = set()
                    for oid in A_objs:
                        e = _get_df_dp_eid(oid, t_A, arc_type, act_B,
                                           events_by_object, event_activity)
                        if e:
                            q.add(e)
                    single_sets.append(frozenset(q))
                elif len(A_objs) <= 1:
                    oid = A_objs[0] if A_objs else None
                    e = (_get_df_dp_eid(oid, t_A, arc_type, act_B,
                                        events_by_object, event_activity)
                         if oid else None)
                    single_sets.append(frozenset([e]) if e else frozenset())
                else:
                    per_obj = []
                    for oid in A_objs:
                        e = _get_df_dp_eid(oid, t_A, arc_type, act_B,
                                           events_by_object, event_activity)
                        per_obj.append(frozenset([e]) if e else frozenset())
                    multi_sets.append(per_obj)

            else:  # EF / EP / AS
                def _eid_set(oid: str, _ot: str = ot) -> frozenset:
                    return frozenset(
                        eid for ts, eid in b_evt[_ot].get(oid, [])
                        if (arc_type == 'EF' and ts > t_A)
                        or (arc_type == 'EP' and ts < t_A)
                        or arc_type == 'AS'
                    )

                if inv == 'any':
                    s: Set[str] = set()
                    for oid in A_objs:
                        s.update(_eid_set(oid))
                    single_sets.append(frozenset(s))
                elif inv == 'all':
                    combined = None
                    for oid in A_objs:
                        combined = _eid_set(oid) if combined is None else combined & _eid_set(oid)
                    single_sets.append(combined if combined is not None else frozenset())
                else:  # each
                    if len(A_objs) <= 1:
                        oid = A_objs[0] if A_objs else None
                        single_sets.append(_eid_set(oid) if oid else frozenset())
                    else:
                        # Multi-object each: Cartesian product across types
                        multi_sets.append([_eid_set(oid) for oid in A_objs])

        # Base qualifying set from all single-set bindings
        joint_base = single_sets[0] if single_sets else frozenset(eids_B)
        for s in single_sets[1:]:
            joint_base = joint_base & s

        if not multi_sets:
            cnt = len(joint_base)
            if cnt >= counts_min and (counts_max is None or cnt <= counts_max):
                satisfied += 1
        else:
            # Definition 8: quantify over the Cartesian product of the Each-type
            # objects, and for EVERY assignment require
            #     n_min <= |f(E_L)| <= n_max
            # where f intersects the qualifying target events of all assigned
            # objects. This branch previously tested only `if not joint`, i.e.
            # non-emptiness. That is equivalent to the bounds check for the
            # counts Algorithm 1 discovers with (n_min = 1, n_max = infinity,
            # Sec. 5) — so it was correct for mining — but this implementation
            # also re-checks arcs under other bounds, notably the n_max = 20
            # resource-like filter. With the bounds ignored, that filter was a
            # silent no-op for any arc carrying a multi-object 'each' binding.
            from itertools import product as _iproduct
            ok = True
            for assignment in _iproduct(*multi_sets):
                joint = joint_base
                for obj_set in assignment:
                    joint = joint & obj_set
                cnt = len(joint)
                if cnt < counts_min or (counts_max is not None and cnt > counts_max):
                    ok = False
                    break
            if ok:
                satisfied += 1

    if total == 0:
        return None
    support = satisfied / total
    if support < 1.0 - noise_threshold:
        return None

    ipl = {t: inv for t, inv in bindings}
    min_inv = min(bindings, key=lambda x: _involvement_strength(x[1]))[1]
    # Observed counts, fitted to the JOINT quantity semantics._nmax_blocked
    # enforces: one count per Each assignment, not one per object type. See
    # _joint_occurrences. With a single Each label this is identical to the
    # single-type path's _occurrences_per_object.
    _each_types = [t for t, inv in bindings if inv == 'each']
    if _each_types:
        occ_A = _joint_occurrences(idx, act_A, _each_types)
        occ_B = _joint_occurrences(idx, act_B, _each_types)
    else:
        # No Each label — the quantifier is empty and the count comes from the
        # All/Any filters alone, which are per-event rather than per-assignment
        # and so have no assignment to key on. Fall back to the first label's
        # marginal, which bounds the joint count from above.
        _primary_type = bindings[0][0] if bindings else None
        occ_A = _occurrences_per_object(idx, act_A, _primary_type) if _primary_type else {}
        occ_B = _occurrences_per_object(idx, act_B, _primary_type) if _primary_type else {}
    observed = {
        'from': [min(occ_A.values()) if occ_A else counts_min,
                 max(occ_A.values()) if occ_A else None],
        'to':   [min(occ_B.values()) if occ_B else counts_min,
                 max(occ_B.values()) if occ_B else None],
    }
    return {
        'from':                  act_A,
        'to':                    act_B,
        'arc_type':              arc_type,
        'label':                 list(obj_types),
        'involvement':           min_inv,
        'involvement_per_label': ipl,
        'counts':                [counts_min, counts_max],
        'observed_counts':       observed,
        'support':               round(support, 4),
    }


# ── Algorithm 1 primitives (Kuesters & van der Aalst, OC-DECLARE, Sec. 5) ──────

_INV_RANK = {'any': 0, 'each': 1, 'all': 2}


def _arc_ipl(arc: Dict[str, Any]) -> Dict[str, str]:
    """involvement_per_label for an arc, tolerating the single-type shape."""
    ipl = arc.get('involvement_per_label')
    if ipl:
        return dict(ipl)
    inv = arc.get('involvement', 'each')
    return {t: inv for t in (arc.get('label') or [])}


def _combine_involvements(ipl_a: Dict[str, str], ipl_b: Dict[str, str]) -> Dict[str, str]:
    """combine(arc, arc') from Algorithm 1: union of object involvements,
    preferring the stricter one where both arcs mention a type.

    Strictness order is All > Each > Any, per Lemma 2: an arc holding with a type
    in All also holds with it in Each, which in turn holds with it in Any.
    """
    out = dict(ipl_a)
    for t, inv in ipl_b.items():
        if t not in out or _INV_RANK.get(inv, 1) > _INV_RANK.get(out[t], 1):
            out[t] = inv
    return out


def _is_preferred_over(arc_d: Dict[str, Any], arc_dprime: Dict[str, Any]) -> bool:
    """D' <= D per Definition 10 — D is at least as preferred as D'.

    Same source, target and arrow type, and every object type D' constrains is
    constrained at least as strictly by D. Used by reduce() to drop arcs that
    another arc already implies.
    """
    if (arc_d['from'] != arc_dprime['from']
            or arc_d['to'] != arc_dprime['to']
            or arc_d['arc_type'] != arc_dprime['arc_type']):
        return False
    ipl_d = _arc_ipl(arc_d)
    ipl_p = _arc_ipl(arc_dprime)
    for t, inv_p in ipl_p.items():
        inv_d = ipl_d.get(t)
        if inv_d is None or _INV_RANK.get(inv_d, 1) < _INV_RANK.get(inv_p, 1):
            return False
    return True


def _reduce_implied(arcs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """reduce(Arcs) from Algorithm 1 line 22: keep only arcs not implied by another.

    Distinct from _lossless_reduction, which is OCPQ's transitive graph reduction
    across activity pairs. This one is local to a single (source, target, arrow)
    group and drops arcs strictly weaker than a sibling.
    """
    keep: List[Dict[str, Any]] = []
    for i, a in enumerate(arcs):
        dominated = False
        for j, b in enumerate(arcs):
            if i == j:
                continue
            if _is_preferred_over(b, a):
                # b implies a; drop a unless they are mutually preferred and a
                # came first (keeps exactly one of an equivalent pair)
                if not _is_preferred_over(a, b) or j < i:
                    dominated = True
                    break
        if not dominated:
            keep.append(a)
    return keep


def _combine_to_multitype_arcs(
    single_arcs: List[Dict[str, Any]],
    idx: Dict[str, Any],
    noise_threshold: float,
    counts_min: int,
    counts_max: Optional[int],
) -> List[Dict[str, Any]]:
    """Group single-type arcs by (from, to, arc_type) and merge into multi-type arcs.

    For each group of size ≥ 2, deduplicate by object type (keeping the strongest
    involvement per type), then try the largest subset that forms a valid multi-type
    arc. Single-type arcs whose type is covered by the multi-type arc are removed;
    remaining ones are kept.
    """
    from itertools import combinations as _combinations

    groups: Dict[Tuple, List[Dict]] = {}
    for arc in single_arcs:
        key = (arc['from'], arc['to'], arc['arc_type'])
        groups.setdefault(key, []).append(arc)

    result: List[Dict[str, Any]] = []
    for key, group in groups.items():
        if len(group) < 2:
            result.extend(group)
            continue

        act_A, act_B, arc_type = key

        # Deduplicate by obj_type, keeping the arc with the strongest involvement.
        # This prevents duplicate-type entries (e.g. any(review) + each(review))
        # from corrupting the multi-type binding check.
        best_per_type: Dict[str, Dict] = {}
        for arc in group:
            t   = arc['label'][0]
            inv = _involvement_strength(arc.get('involvement', 'each'))
            if t not in best_per_type or inv > _involvement_strength(
                    best_per_type[t].get('involvement', 'each')):
                best_per_type[t] = arc
        unique_group = list(best_per_type.values())

        best_multi: Optional[Dict[str, Any]] = None
        best_covered_types: Set[str] = set()

        if len(unique_group) >= 2:
            for size in range(len(unique_group), 1, -1):
                found = False
                for subset_indices in _combinations(range(len(unique_group)), size):
                    sub_arcs = [unique_group[i] for i in subset_indices]
                    bindings = [(a['label'][0], a.get('involvement', 'each'))
                                for a in sub_arcs]
                    multi = _check_arc_multi_type(
                        idx, act_A, act_B, arc_type, bindings,
                        noise_threshold, counts_min, counts_max)
                    if multi is not None:
                        best_multi = multi
                        best_covered_types = {a['label'][0] for a in sub_arcs}
                        found = True
                        break
                if found:
                    break

        if best_multi is not None:
            result.append(best_multi)
            # Keep any arc from the original group whose type is NOT covered
            for arc in group:
                if arc['label'][0] not in best_covered_types:
                    result.append(arc)
        else:
            result.extend(group)

    return result


def _has_dominating_path(
    candidate_idx: int,
    arcs: List[Dict[str, Any]],
    adj: Dict[str, List[int]],
    active: List[bool],
) -> bool:
    """BFS: return True if there is a path through active arcs from c.from to c.to
    where each traversed edge's (arc_type, involvement, label) dominates candidate's."""
    c      = arcs[candidate_idx]
    c_type = c['arc_type']
    c_lbl  = set(c['label'])

    queue: deque = deque([(c['from'], 0)])
    visited: Set[str] = {c['from']}

    while queue:
        curr, depth = queue.popleft()
        if curr == c['to']:
            return True
        for ei in adj.get(curr, []):
            if not active[ei] or ei == candidate_idx:
                continue
            e      = arcs[ei]
            e_type = e['arc_type']
            e_lbl  = set(e['label'])
            if not _arc_type_dominated_by_or_eq(c_type, e_type):
                continue
            if not c_lbl.issubset(e_lbl):
                continue
            e_ipl = e.get('involvement_per_label',
                           {t: e.get('involvement', 'each') for t in e_lbl})
            c_ipl = c.get('involvement_per_label',
                           {t: c.get('involvement', 'each') for t in c_lbl})
            if any(_involvement_strength(e_ipl.get(t, 'each')) <
                   _involvement_strength(c_ipl.get(t, 'each'))
                   for t in c_lbl):
                continue
            # Lossless guard: skip if 'any' labels overlap at depth >= 1
            if (depth >= 1
                    and c.get('involvement') == 'any'
                    and e.get('involvement') == 'any'
                    and c_lbl & e_lbl):
                continue
            if e['to'] not in visited:
                visited.add(e['to'])
                queue.append((e['to'], depth + 1))

    return False


def _lossless_reduction(arcs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """BFS-based transitive lossless reduction, matching OCPQ's reduce_oc_arcs(lossless=true)."""
    if not arcs:
        return arcs
    arcs = sorted(arcs, key=lambda a: (a['from'], a['to'], a['arc_type'],
                                        a.get('involvement', 'each')))
    adj: Dict[str, List[int]] = {}
    for i, arc in enumerate(arcs):
        adj.setdefault(arc['from'], []).append(i)

    active = [True] * len(arcs)
    for i in range(len(arcs)):
        if active[i] and _has_dominating_path(i, arcs, adj, active):
            active[i] = False

    return [arc for i, arc in enumerate(arcs) if active[i]]


def _refine_arcs(
    arcs: List[Dict[str, Any]],
    idx: Dict[str, Any],
    noise_threshold: float,
    counts_min: int,
    counts_max: Optional[int],
) -> List[Dict[str, Any]]:
    """Refinement pass: tighten involvement per arc.

    Single-type: any→each (stops at each to match OCPQ single-type output).
    Multi-type: any→each then each→all applied per type within the binding.
    """
    refined: List[Dict[str, Any]] = []
    for arc in arcs:
        ipl      = arc.get('involvement_per_label', {})
        arc_type = arc['arc_type']
        act1, act2 = arc['from'], arc['to']

        if len(ipl) <= 1:
            # Single-type arc: cap escalation at 'each'
            obj_type    = arc['label'][0] if arc['label'] else ''
            involvement = arc.get('involvement', 'each')
            next_inv    = {'any': 'each'}.get(involvement)
            if next_inv is not None:
                stricter = _check_arc(idx, act1, act2, arc_type, obj_type, next_inv,
                                      noise_threshold, counts_min, counts_max)
                if stricter is not None:
                    refined.append(stricter)
                    continue
            refined.append(arc)
        else:
            # Multi-type arc: try any→each, then each→all, per type
            new_ipl = dict(ipl)
            for escalation in ({'any': 'each'}, {'each': 'all'}):
                for t, inv in list(new_ipl.items()):
                    nxt = escalation.get(inv)
                    if nxt is None:
                        continue
                    test_ipl = {**new_ipl, t: nxt}
                    result = _check_arc_multi_type(
                        idx, act1, act2, arc_type,
                        list(test_ipl.items()),
                        noise_threshold, counts_min, counts_max,
                    )
                    if result is not None:
                        new_ipl[t] = nxt
            if new_ipl != ipl:
                final = _check_arc_multi_type(
                    idx, act1, act2, arc_type,
                    list(new_ipl.items()),
                    noise_threshold, counts_min, counts_max,
                )
                if final is not None:
                    refined.append(final)
                    continue
            refined.append(arc)
    return refined


#: Marks a discovered model whose constraints are stored in ARC orientation,
#: i.e. `from`/`to` mean what the OC-DECLARE tuple (ar, s, t, oi, n_min, n_max)
#: and the OCPQ converter mean by them. Files without this key predate the
#: change and are stored pre-swapped in engine orientation — the adapter needs
#: to tell the two apart, so this is an explicit marker rather than a guess.
CONSTRAINT_ORIENTATION = 'arc'


def _arcs_to_deco_constraints(arcs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Serialise OC-Declare arcs in the orientation the paper defines them.

    `from` is the arc's source activity s and `to` its target t, exactly as in
    Definition 7 and as the OCPQ converter writes them. No endpoint is swapped
    here, and no simulator-facing `source_activity`/`target_activity` is
    emitted.

    That swap belongs to the adapter, not to discovery. The engine reads
    `precedence` as "source must appear before target", which is the reverse of
    an EP arc, so *something* has to flip the endpoints — but discovery is the
    wrong place for it. Doing it here produced a file that carried
    `arc_type: "EP"` next to already-flipped activities, so nothing downstream
    could tell which orientation it was looking at without knowing the
    convention, and comparing the output against OCPQ meant undoing the flip
    first. Simulation.Models.OCDeclare.parse_ocdeclare_dict now performs it,
    mirroring what parse_ocdeclare_list has always done for the arc-list format.

    `observed_counts` stays keyed by arc endpoint (`from`/`to`) as descriptive
    statistics. It never replaces the declared matching-event bounds.
    """
    ARC_TO_CTYPE = {
        'EF': 'response',  'DF': 'chain_response',
        'EP': 'precedence', 'DP': 'chain_precedence',
        'AS': 'responded_existence',
    }
    constraints = []
    for arc in arcs:
        A, B      = arc['from'], arc['to']
        atype     = arc['arc_type']
        obj_type  = arc['label'][0] if arc.get('label') else ''
        counts    = list(arc.get('counts', [1, None]))
        support   = arc.get('support', 0.0)
        ctype     = ARC_TO_CTYPE.get(atype)
        if not ctype:
            continue
        inv = arc.get('involvement', 'each')
        ipl = arc.get('involvement_per_label', {obj_type: inv})
        constraints.append({
            # ── arc orientation (canonical) ──────────────────────────────────
            'from':                  A,
            'to':                    B,
            'arc_type':              atype,
            # Which DECLARE template the arrow type corresponds to. Derived, and
            # orientation-free — it names the template, not an endpoint role.
            'type':                  ctype,
            'constraint_type':       ctype,
            # Declared bounds on |f(E_L)|, also used by the runtime adapter.
            'counts':                counts,
            # Per-endpoint measurements, keyed by ARC endpoint.
            'observed_counts':       arc.get('observed_counts') or {},
            # Object involvement — orientation-independent.
            'involvement':           inv,
            'involvement_per_label': ipl,
            'label':                 arc.get('label', []),
            'scope':                 {
                'kind':                   inv,
                'object_type':            obj_type,
                'involvement_per_label':  ipl,
            },
            'support':               support,
            'confidence':            support,
        })
    return constraints


def _discover_kvaanda_arcs(
    ocel_log: Dict[str, Any],
    activities: List[str],
    object_types: List[str],
    noise_threshold: float = 0.2,
    arc_types: Optional[List[str]] = None,
    counts_min: int = 1,
    counts_max: Optional[int] = None,
    resource_filter_nmax: Optional[int] = 20,
    reduction: str = 'Lossless',
    refinement: bool = True,
    progress_callback=None,
    log_callback=None,
) -> List[Dict[str, Any]]:
    """
    Discover OC-Declare arcs per OCPQ / rust4pm (Küsters & van der Aalst 2025).

    For each (act_A, act_B) pair sharing object type T:
      1. Generate viable label type(s) — 'any' and/or 'each' — via AS threshold check.
      2. For each viable label, escalate to the strictest arc type (EF→DF, EP→DP, AS fallback).
      3. Apply lossless BFS reduction.
      4. Apply refinement pass (any→each→all), then reduce again.
    """
    if arc_types is None:
        arc_types = ['EF', 'EP', 'AS']

    def _log(msg):
        if log_callback is not None:
            log_callback(msg)

    idx      = _build_discovery_indices(ocel_log)
    max_objs = _get_max_objects_per_event(ocel_log, activities, object_types)
    arcs: List[Dict[str, Any]] = []

    # Pre-compute which object types each activity's B-side has events for
    act_B_otypes: Dict[str, Set[str]] = {}
    for act in activities:
        st: Set[str] = set()
        for eid in idx['events_by_activity'].get(act, []):
            st.update(idx['event_objs_by_type'].get(eid, {}).keys())
        act_B_otypes[act] = st

    _log(f"Arc mining: {len(activities)} activities x {len(object_types)} object types, "
         f"noise threshold {noise_threshold}")

    # ── Algorithm 1 (Kuesters & van der Aalst, Sec. 5) ────────────────────────
    # Run the involvement search once with the least strict arrow type, then
    # escalate arrow types per discovered arc, as the paper prescribes: "the
    # algorithm is executed once with ar = [AS], and for each discovered
    # constraint, versions with stricter arrows are checked and added, removing
    # the less strict versions, as per Lemma 1."
    BASE_ARROW = 'AS'

    n_acts = len(activities)
    for i, act_A in enumerate(activities):
        if progress_callback is not None:
            progress_callback('Mining arcs', round(100 * i / n_acts) if n_acts else 100)
        _log(f"[{i+1}/{n_acts}] Checking act_A: {act_A}")
        for act_B in activities:
            # X in Algorithm 1: every satisfied arc for this activity pair
            X: List[Dict[str, Any]] = []

            # Lines 4-13: per object type, try any -> each -> all, each only
            # attempted when the laxer one holds (Lemma 2 makes that sound: a
            # stricter involvement can only hold if the laxer one does). All
            # satisfied arcs are kept, not just the strictest — combine() and
            # reduce() below decide what survives.
            for obj_type in object_types:
                if max_objs.get(act_A, {}).get(obj_type, 0) == 0:
                    continue
                if obj_type not in act_B_otypes.get(act_B, set()):
                    continue

                # Involvements only differ when a source event can carry more
                # than one object of this type. With exactly one, Any, Each and
                # All correlate the same single object and are semantically
                # identical — OCPQ reports 'each' for that case, and trying the
                # stricter ones anyway makes them pass everywhere, after which
                # reduce() keeps 'all' and the output degenerates (measured:
                # 'all' on 35 labels, 3/35 agreement with the converter).
                if max_objs.get(act_A, {}).get(obj_type, 0) > 1:
                    ladder = ['any', 'each', 'all']
                else:
                    ladder = ['each']

                for inv in ladder:
                    arc_inv = _check_arc(idx, act_A, act_B, BASE_ARROW, obj_type, inv,
                                         noise_threshold, counts_min, counts_max)
                    if arc_inv is None:
                        # Lemma 2: a stricter involvement cannot hold once a
                        # laxer one fails, so stop climbing this ladder.
                        break
                    X.append(arc_inv)

            if not X:
                continue

            # Lines 14-21: combine pairs until no new satisfied arc appears.
            # Iterating to a fixpoint is what allows involvements over three or
            # more object types to be found — a single pass can only ever reach
            # pairs.
            seen_ipls = {tuple(sorted(_arc_ipl(a).items())) for a in X}
            while True:
                Y: List[Dict[str, Any]] = []
                for ia in range(len(X)):
                    for ib in range(ia + 1, len(X)):
                        merged = _combine_involvements(_arc_ipl(X[ia]), _arc_ipl(X[ib]))
                        key = tuple(sorted(merged.items()))
                        if key in seen_ipls:
                            continue
                        seen_ipls.add(key)
                        if len(merged) == 1:
                            t, inv = next(iter(merged.items()))
                            cand = _check_arc(idx, act_A, act_B, BASE_ARROW, t, inv,
                                              noise_threshold, counts_min, counts_max)
                        else:
                            cand = _check_arc_multi_type(
                                idx, act_A, act_B, BASE_ARROW, list(merged.items()),
                                noise_threshold, counts_min, counts_max)
                        if cand is not None:
                            Y.append(cand)
                if not Y:
                    break
                X.extend(Y)

            # Line 22: keep only arcs not implied by another in this group
            arcs.extend(_reduce_implied(X))

    _log(f"Arc scan done — {len(arcs)} arcs after combine + reduce")

    # ── Resource-like filter (paper, Sec. 5 p.14 and Sec. 6 p.15) ─────────────
    # "Uninteresting constraints, for example, involving only resource-like
    #  object types (e.g., employee), can be removed by filtering the result of
    #  Algorithm 1 before testing other arrow versions."   (Sec. 5)
    # "Results which would not surpass the confidence threshold with a maximal
    #  event count of n_max = 20 are removed to exclude undesirable entries
    #  (e.g., only based on resource-like object types)."  (Sec. 6)
    #
    # The filter is a re-check of the already-discovered arc under n_max = 20,
    # not a bound applied while mining. That distinction is the whole point:
    # applying it during mining (as this code previously did, via counts_max=20
    # threaded into _check_arc) rejects the single-type seeds for object types
    # that recur across many events, and since combine() can only merge arcs
    # already in X, valid joint involvements such as {Container: each,
    # Forklift: each} then become unreachable. Six arcs the OCPQ converter finds
    # were lost that way. Mining runs unbounded (n_max = infinity, per Sec. 5)
    # and the bound is applied here, to the result.
    #
    # Note this removes arcs involving ONLY resource-like types while keeping
    # mixed ones — an arc whose involvement also constrains a case object
    # correlates a much smaller event set and stays within the bound.
    if resource_filter_nmax is not None:
        def _survives_resource_filter(arc: Dict[str, Any]) -> bool:
            ipl = _arc_ipl(arc)
            if len(ipl) == 1:
                t, inv = next(iter(ipl.items()))
                return _check_arc(idx, arc['from'], arc['to'], arc['arc_type'], t, inv,
                                  noise_threshold, counts_min, resource_filter_nmax) is not None
            return _check_arc_multi_type(idx, arc['from'], arc['to'], arc['arc_type'],
                                         list(ipl.items()), noise_threshold, counts_min,
                                         resource_filter_nmax) is not None

        before = len(arcs)
        arcs = [a for a in arcs if _survives_resource_filter(a)]
        _log(f"After resource-like filter (n_max={resource_filter_nmax}): "
             f"{len(arcs)} arcs ({before - len(arcs)} removed)")

    # Arrow-type escalation (Lemma 1): replace each arc with its strictest
    # satisfied arrow type, keeping its discovered object involvement.
    escalated: List[Dict[str, Any]] = []
    for arc in arcs:
        ipl = _arc_ipl(arc)
        best = arc
        for atype in _stricter_arrow_candidates(arc['arc_type'], arc_types):
            if len(ipl) == 1:
                t, inv = next(iter(ipl.items()))
                cand = _check_arc(idx, arc['from'], arc['to'], atype, t, inv,
                                  noise_threshold, counts_min, counts_max)
            else:
                cand = _check_arc_multi_type(
                    idx, arc['from'], arc['to'], atype, list(ipl.items()),
                    noise_threshold, counts_min, counts_max)
            if cand is not None:
                best = cand
        escalated.append(best)
    arcs = escalated
    _log(f"After arrow-type escalation: {len(arcs)} arcs")

    # OCPQ's transitive lossless reduction — not part of Algorithm 1, retained
    # because it is the converter's default and the reference output we compare
    # against was produced with it enabled.
    if reduction == 'Lossless':
        arcs = _lossless_reduction(arcs)
        _log(f"After lossless reduction: {len(arcs)} arcs remain")

    return arcs




def discover_ocdeclare_model(
    event_log_path: str,
    noise_threshold: float = 0.2,
    arc_types: Optional[List[str]] = None,
    reduction: str = 'Lossless',
    lifecycle_threshold: float = DEFAULT_LIFECYCLE_THRESHOLD,
    permanent_threshold: float = 50.0,
    # Legacy parameters kept for backward compatibility (ignored by new algorithm)
    min_support: float = 0.7,
    min_confidence: float = 0.85,
    constraint_types: Optional[Dict[str, bool]] = None,
    constraint_params: Optional[Dict[str, Dict[str, float]]] = None,
    output_filename: Optional[str] = None,
    output_dir: Optional[str] = None,
    progress_callback=None,
    log_callback=None,
) -> Dict[str, Any]:
    """Main function to discover OC-Declare model from OCEL 2.0 event log.
    
    Args:
        event_log_path: Path to OCEL 2.0 event log file
        min_support: Global minimum support threshold (0-1). Used as fallback
            for any constraint type not present in constraint_params.
        min_confidence: Global minimum confidence threshold (0-1). Fallback.
        noise_threshold: Global tolerance for violations (0-1). Fallback.
        lifecycle_threshold: Legacy compatibility parameter (default 0.9).
            Lifecycle flags are derived separately by simulation-parameter
            discovery; constraint mining does not apply this parameter.
        permanent_threshold: Average events-per-instance above which an object
            type is classified as a permanent object (e.g. Forklift, Truck).
            Default 50.
        constraint_types: Dict of constraint types to discover (bool flags).
        constraint_params: Optional per-constraint-type thresholds. Keys are
            constraint type names (e.g. 'precedence', 'chain_response').
            Each value is a dict with optional keys:
              'minSupport', 'minConfidence', 'noiseThreshold'
            Missing keys fall back to the global parameters above.
            Example:
              {'chain_precedence': {'minSupport': 0.8, 'minConfidence': 0.95,
                                    'noiseThreshold': 0.05}}
        output_filename: Optional filename for saving discovered model
        output_dir: Optional absolute directory path to save the model in.
                    If not provided, falls back to 'Backend/src/Simulation/IO/input/ocdeclare'
                    relative to the current working directory.
        
    Returns:
        Dictionary containing discovered model and statistics
    """
    # Default constraint types
    if constraint_types is None:
        constraint_types = {}
    if constraint_params is None:
        constraint_params = {}
    if arc_types is None:
        arc_types = ['EF', 'EP', 'AS']

    def _cb(phase: str, pct: int) -> None:
        if progress_callback is not None:
            progress_callback(phase, pct)

    def _log(msg: str) -> None:
        if log_callback is not None:
            log_callback(msg)

    # Load event log
    _cb('Loading log', 0)
    _log(f"Loading event log: {Path(event_log_path).name}")
    ocel_log = load_ocel2(event_log_path)

    # Discover basic elements
    _cb('Discovering structure', 5)
    object_types = discover_object_types(ocel_log)
    activities   = discover_activities(ocel_log)
    n_events = len(ocel_log.get('events', {}))
    n_objects = len(ocel_log.get('objects', {}))
    _log(f"Loaded {n_events:,} events, {n_objects:,} objects — {len(object_types)} object types, {len(activities)} activities")
    _log(f"Object types: {', '.join(object_types)}")

    # Discover OC-Declare constraints using Küsters & van der Aalst (2025) algorithm
    _cb('Mining arcs', 10)
    all_constraints = _arcs_to_deco_constraints(
        _discover_kvaanda_arcs(
            ocel_log=ocel_log,
            activities=activities,
            object_types=object_types,
            noise_threshold=noise_threshold,
            arc_types=arc_types,
            counts_min=1,
            counts_max=None,
            reduction=reduction,
            refinement=True,
            progress_callback=lambda phase, pct: _cb(phase, 10 + int(pct * 0.8)),
            log_callback=log_callback,
        )
    )
    _log(f"Constraint translation done — {len(all_constraints)} constraints discovered")

    # Constraint discovery exports no simulation parameters. Bindings and
    # lifecycle flags are derived explicitly by simulation-parameter discovery.
    discovered_model = {
        "constraint_orientation": CONSTRAINT_ORIENTATION,
        "object_types": [{"name": name} for name in object_types],
        "activities": [{"name": name} for name in activities],
        "constraints": all_constraints,
    }

    # Save to file if requested
    if output_filename:
        if output_dir:
            output_path = Path(output_dir) / output_filename
        else:
            output_path = (Path(__file__).resolve().parents[1] / 'Simulation' / 'IO' / 'input' / 'ocdeclare') / output_filename
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(discovered_model, f, indent=2)
    
    # Calculate statistics
    # Count every discovered constraint type dynamically so that newly added
    # types (e.g. not_coexistence) are reflected without further changes here.
    constraint_breakdown: Dict[str, int] = {}
    for c in all_constraints:
        ctype = c['type']
        constraint_breakdown[ctype] = constraint_breakdown.get(ctype, 0) + 1

    stats = {
        'num_object_types': len(object_types),
        'num_activities': len(activities),
        'num_constraints': len(all_constraints),
        'num_o2o_rules': 0,
        'constraint_breakdown': constraint_breakdown,
        'avg_support': round(sum(c['support'] for c in all_constraints) / len(all_constraints), 3) if all_constraints else 0,
        'avg_confidence': round(sum(c['confidence'] for c in all_constraints) / len(all_constraints), 3) if all_constraints else 0
    }
    
    result = {
        'model': discovered_model,
        'stats': stats,
        'output_file': output_filename,
        'start_activities_ranked': [],
        'parameters': {
            'min_support': min_support,
            'min_confidence': min_confidence,
            'noise_threshold': noise_threshold,
            'constraint_types': constraint_types
        }
    }
    _cb('Done', 100)
    _log(f"Discovery complete — model saved to {output_filename or '(not saved)'}")
    return result
