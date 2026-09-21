"""
OC-Declare Model Discovery from OCEL 2.0 Event Logs

This module discovers OC-Declare declarative constraints from object-centric event logs.
It mines constraints like precedence and response rules with support/confidence metrics.
"""

import csv
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Set, Tuple, Any, Optional
from collections import Counter, defaultdict, deque
from datetime import datetime


# Object-lifecycle discovery lives in its own module: it is prototype machinery
# for playing a model out, not part of Algorithm 1. Imported here because
# discover_ocdeclare_model assembles the full model.
from src.ParameterDiscovery.lifecycle import (  # noqa: E402
    discover_lifecycle,
    discover_permanent_object_types,
    suggest_permanent_object_threshold,
    discover_creation_counts,
)


def load_ocel2_xml(filename: str) -> Dict[str, Any]:
    """Load an OCEL 2.0 event log from XML file.

    Parses the standard OCEL 2.0 XML format and returns the same internal
    dict structure that load_ocel2 produces for JSON files:
      {
        'objects': { id: { 'type': str, 'attributes': {} } },
        'events':  { id: { 'activity': str, 'timestamp': str, 'omap': [id, ...] } },
        'objectTypes': [ { 'name': str } ],
      }
    """
    tree = ET.parse(filename)
    root = tree.getroot()

    # ── object types ────────────────────────────────────────────────────────
    object_types = []
    for ot in root.findall('./object-types/object-type'):
        object_types.append({'name': ot.get('name', '')})

    # ── objects ─────────────────────────────────────────────────────────────
    objects: Dict[str, Any] = {}
    for obj in root.findall('./objects/object'):
        oid  = obj.get('id', '')
        otype = obj.get('type', '')
        attrs: Dict[str, Any] = {}
        for attr in obj.findall('./attributes/attribute'):
            attrs[attr.get('name', '')] = attr.text
        # Object-to-object relations, kept verbatim — this is the log's own
        # statement of how objects relate, and discover_o2o_rules reads it
        # rather than re-deriving relations from event co-participation.
        rels = [
            {'objectId': rel.get('object-id'), 'qualifier': rel.get('qualifier') or ''}
            for rel in obj.findall('./objects/relationship')
            if rel.get('object-id')
        ]
        objects[oid] = {'type': otype, 'attributes': attrs, 'relationships': rels}

    # ── events ──────────────────────────────────────────────────────────────
    events: Dict[str, Any] = {}
    for evt in root.findall('./events/event'):
        eid       = evt.get('id', '')
        activity  = evt.get('type', '')
        timestamp = evt.get('time', '')
        omap = [
            rel.get('object-id')
            for rel in evt.findall('./objects/relationship')
            if rel.get('object-id')
        ]
        events[eid] = {'activity': activity, 'timestamp': timestamp, 'omap': omap}

    return {
        'objects':     objects,
        'events':      events,
        'objectTypes': object_types,
    }


def load_ocel2_csv(filename: str) -> Dict[str, Any]:
    """Convert a BPIC-style flat CSV event log into the internal OCEL 2.0 dict.

    Expected columns (at minimum):
        concept:name          – activity label
        time:timestamp        – ISO timestamp
        case:concept:name     – application/case object ID
        EventOrigin           – object type context: Application | Workflow | Offer
        EventID               – event-scoped object ID (workitem, state, or offer ID)
        OfferID               – explicit offer object ID for offer state-change rows

    Sparse offer-attribute columns (FirstWithdrawalAmount, NumberOfTerms, Accepted,
    MonthlyCost, Selected, CreditScore, OfferedAmount) are captured on the Offer
    object from the first row where they are non-empty.
    """
    objects: Dict[str, Any] = {}
    events: Dict[str, Any] = {}

    with open(filename, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            activity  = (row.get('concept:name') or '').strip()
            timestamp = (row.get('time:timestamp') or '').strip()
            case_id   = (row.get('case:concept:name') or '').strip()
            origin    = (row.get('EventOrigin') or '').strip()
            event_id_raw = (row.get('EventID') or '').strip()
            offer_id  = (row.get('OfferID') or '').strip()

            if not activity or not timestamp or not case_id:
                continue

            # ── Application object ─────────────────────────────────────────
            if case_id not in objects:
                objects[case_id] = {
                    'type': 'Application',
                    'attributes': {
                        k: row.get(k, '') for k in
                        ('case:LoanGoal', 'case:ApplicationType', 'case:RequestedAmount')
                    },
                }

            omap = [case_id]

            # ── Workflow workitem object ───────────────────────────────────
            if origin == 'Workflow' and event_id_raw:
                if event_id_raw not in objects:
                    objects[event_id_raw] = {'type': 'Workflow', 'attributes': {}}
                omap.append(event_id_raw)

            # ── Offer object ───────────────────────────────────────────────
            elif origin == 'Offer':
                # Prefer explicit OfferID; fall back to EventID when it names the offer
                resolved = offer_id or (event_id_raw if event_id_raw.startswith('Offer_') else None)
                if resolved:
                    if resolved not in objects:
                        offer_attrs = {
                            k: row.get(k, '') for k in
                            ('FirstWithdrawalAmount', 'NumberOfTerms', 'Accepted',
                             'MonthlyCost', 'Selected', 'CreditScore', 'OfferedAmount')
                        }
                        objects[resolved] = {'type': 'Offer', 'attributes': offer_attrs}
                    else:
                        # Back-fill sparse attributes from later rows if still empty
                        existing = objects[resolved]['attributes']
                        for k in ('FirstWithdrawalAmount', 'NumberOfTerms', 'Accepted',
                                  'MonthlyCost', 'Selected', 'CreditScore', 'OfferedAmount'):
                            if not existing.get(k) and row.get(k, '').strip():
                                existing[k] = row[k].strip()
                    omap.append(resolved)

            events[f'evt_{i}'] = {
                'activity':  activity,
                'timestamp': timestamp,
                'omap':      omap,
            }

    object_types = sorted({v['type'] for v in objects.values()})
    return {
        'events':      events,
        'objects':     objects,
        'objectTypes': [{'name': t} for t in object_types],
    }


def load_ocel2(filename: str) -> Dict[str, Any]:
    """Load an OCEL 2.0 event log from a JSON, JSONOCEL, XML, or CSV file.

    Args:
        filename: Path to OCEL file (.json, .jsonocel, .xml, or .csv)

    Returns:
        Dictionary with 'events' and 'objects' keys
    """
    filepath = Path(filename)
    if not filepath.exists():
        raise FileNotFoundError(f"Event log not found: {filename}")

    if filepath.suffix.lower() == '.xml':
        return load_ocel2_xml(filename)

    if filepath.suffix.lower() == '.csv':
        return load_ocel2_csv(filename)

    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Support both OCEL 2.0 format (dict) and simple list format
    if isinstance(data, dict):
        # ── OCEL 1.0 normalisation (.jsonocel / ocel:-prefixed keys) ─────────
        if 'ocel:events' in data and 'ocel:objects' in data:
            events_dict: Dict[str, Any] = {}
            for eid, ev in data['ocel:events'].items():
                events_dict[eid] = {
                    'activity':  ev.get('ocel:activity', ''),
                    'timestamp': ev.get('ocel:timestamp', ''),
                    'omap':      ev.get('ocel:omap', []),
                }
            objects_dict: Dict[str, Any] = {}
            for oid, obj in data['ocel:objects'].items():
                objects_dict[oid] = {
                    'type':       obj.get('ocel:type', ''),
                    'attributes': obj.get('ocel:ovmap', {}),
                    # OCEL 1.0 has no standard O2O section; carry it if present
                    # so discover_o2o_rules sees a uniform shape.
                    'relationships': obj.get('ocel:o2o', []) or [],
                }
            global_log = data.get('ocel:global-log', {})
            raw_types   = global_log.get('ocel:object-types', [])
            object_types = [{'name': t} for t in raw_types] if raw_types else \
                           [{'name': t} for t in sorted({v['type'] for v in objects_dict.values()})]
            return {'events': events_dict, 'objects': objects_dict, 'objectTypes': object_types}

        # ── OCEL 2.0 — objects/events may be arrays instead of dicts ─────────
        if 'objects' in data and isinstance(data['objects'], list):
            objects_dict = {}
            for obj in data['objects']:
                obj_id = obj.get('id') or obj.get('ocel:oid')
                if obj_id:
                    objects_dict[obj_id] = {
                        'type': obj.get('type') or obj.get('ocel:type'),
                        'attributes': obj.get('attributes', {}),
                        # OCEL 2.0 object-to-object relations. Preserved rather
                        # than dropped: discover_o2o_rules reads the log's own
                        # relations instead of inferring them from which object
                        # types happen to share an event.
                        'relationships': obj.get('relationships')
                                         or obj.get('ocel:o2o') or [],
                    }
            data['objects'] = objects_dict

        if 'events' in data and isinstance(data['events'], list):
            # Convert events array to dict
            events_dict = {}
            for evt in data['events']:
                evt_id = evt.get('id') or evt.get('ocel:eid')
                if evt_id:
                    # Extract activity name
                    activity = evt.get('activity') or evt.get('ocel:activity') or evt.get('type')

                    # Extract timestamp
                    timestamp = evt.get('timestamp') or evt.get('ocel:timestamp') or evt.get('time')

                    # Extract object relationships
                    # Handle both simple list of IDs and list of relationship objects
                    relationships = evt.get('omap') or evt.get('ocel:omap') or evt.get('relationships', [])
                    if relationships and isinstance(relationships[0], dict):
                        # Relationships is list of dicts like [{"objectId": "obj1", "qualifier": "..."}]
                        omap = [rel.get('objectId') or rel.get('ocel:oid') for rel in relationships if isinstance(rel, dict)]
                    else:
                        # Relationships is already a simple list of IDs
                        omap = relationships

                    events_dict[evt_id] = {
                        'activity': activity,
                        'timestamp': timestamp,
                        'omap': omap
                    }
            data['events'] = events_dict
        
        return data
    elif isinstance(data, list):
        # Convert simple list format to OCEL-like structure
        return convert_simple_list_to_ocel(data)
    else:
        raise ValueError("Unsupported event log format")


def convert_simple_list_to_ocel(traces: List[List[str]]) -> Dict[str, Any]:
    """Convert simple list format to OCEL-like structure.
    
    Args:
        traces: List of activity sequences
        
    Returns:
        OCEL-like dictionary
    """
    events = {}
    objects = {}
    
    event_counter = 0
    object_counter = 0
    
    for trace_idx, trace in enumerate(traces):
        # Create a "case" object for this trace
        obj_id = f"case_{object_counter}"
        objects[obj_id] = {
            'type': 'case',
            'attributes': {}
        }
        object_counter += 1
        
        # Create events for activities in this trace
        for activity in trace:
            event_id = f"e_{event_counter}"
            events[event_id] = {
                'activity': activity,
                'timestamp': f"2024-01-01T00:{trace_idx:02d}:{event_counter:02d}",
                'omap': [obj_id]
            }
            event_counter += 1
    
    return {
        'events': events,
        'objects': objects
    }


def extract_object_traces(ocel_log: Dict[str, Any], object_type: Optional[str] = None) -> Dict[str, List[str]]:
    """Extract activity sequences (traces) per object instance.
    
    Args:
        ocel_log: OCEL 2.0 log dictionary
        object_type: Filter by specific object type (None = all objects)
        
    Returns:
        Dictionary mapping object_id -> list of activities (in temporal order)
    """
    events = ocel_log.get('events', {})
    objects = ocel_log.get('objects', {})
    
    # Build object -> events mapping
    object_events = defaultdict(list)
    
    for event_id, event_data in events.items():
        # Get objects involved in this event
        object_ids = event_data.get('omap', []) or event_data.get('relationships', [])
        activity = event_data.get('activity')
        timestamp = event_data.get('timestamp', '')
        
        if not activity:
            continue
        
        for obj_id in object_ids:
            # Filter by object type if specified
            if object_type:
                obj_data = objects.get(obj_id, {})
                obj_type = obj_data.get('type')
                if obj_type != object_type:
                    continue
            
            object_events[obj_id].append({
                'activity': activity,
                'timestamp': timestamp,
                'event_id': event_id
            })
    
    # Sort events by timestamp and extract activity sequences
    object_traces = {}
    for obj_id, event_list in object_events.items():
        # Sort by timestamp
        sorted_events = sorted(event_list, key=lambda x: x['timestamp'])
        # Extract activity sequence
        object_traces[obj_id] = [e['activity'] for e in sorted_events]
    
    return object_traces


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
        'counts':                [counts_min, None],   # legacy field, unused
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
        'counts':                [counts_min, None],   # legacy field, unused
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

    `observed_counts` stays keyed by arc endpoint (`from`/`to`) for the same
    reason: it is a measurement of the arc, and mapping it onto the engine's
    nmin/nmax roles is the adapter's job.
    """
    ARC_TO_CTYPE = {
        'EF': 'response',  'DF': 'response',
        'EP': 'precedence', 'DP': 'precedence',
        'AS': 'coexistence',
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
            # Paper counts on |f(E_L)|. Left at the discovery default; the
            # adapter fits the engine's nmin/nmax from observed_counts below.
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
        metrics = compute_ocpa_metrics(ocel_log, [], service_time_mode='minimum')

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


def discover_interarrival_times(ocel_log: Dict[str, Any]) -> Dict[str, Any]:
    """Inter-arrival time distribution per activity, measured from the log.

    Returns the gaps between consecutive occurrences of each activity, in the
    same shape as activity_durations so the existing sampler can be reused.

    This is what paces activities that have no input object bindings. Without
    it such an activity is offered exactly one candidate per simulation step
    and fires on essentially every step, which makes "one per step" the de
    facto arrival rate — an artifact of the step structure rather than anything
    measured. On container_logistics that is why 'Collect Goods' reached ~70%
    of generated events against 29.8% in the log, and why Customer Orders
    accumulated in the thousands.

    A simulation parameter, not part of OC-Declare: never written into the
    model file, merged at simulation setup.

    Returns:
        {activity: {dist_type, mean_seconds, std_seconds, min_seconds,
                    max_seconds, sample_count}} for activities with >= 2
        occurrences (a single occurrence yields no gap to measure).
    """
    if isinstance(ocel_log, list):
        return {}
    by_act = _event_times_by_activity(ocel_log)
    out: Dict[str, Any] = {}
    for act, times in by_act.items():
        if len(times) < 2:
            continue
        gaps = [(times[i] - times[i - 1]).total_seconds() for i in range(1, len(times))]
        gaps = [g for g in gaps if g >= 0]
        if not gaps:
            continue
        n = len(gaps)
        mean = sum(gaps) / n
        var = sum((g - mean) ** 2 for g in gaps) / n if n > 1 else 0.0
        out[act] = {
            'dist_type':    'exponential' if mean > 0 else 'fixed',
            'mean_seconds': mean,
            'std_seconds':  var ** 0.5,
            'min_seconds':  min(gaps),
            'max_seconds':  max(gaps),
            'sample_count': n,
        }
    return out


def discover_activity_calendars(
    ocel_log: Dict[str, Any],
    min_events_for_own_calendar: int = 500,   # kept for signature compatibility
) -> Dict[str, Any]:
    """Discover a probabilistic weekly availability calendar from the event log.

    Follows the probabilistic-calendar approach of Lopez-Pintado & Dumas (ICPM
    2023), used by SIMOD's resource-model stage: each weekly slot carries the
    probability that work may start in it, rather than a crisp on/off boundary
    that misfits both tails of a ramp (this log: 05:00 5.3%, 07:00 13.3%,
    17:00 1.1%, 99.5% weekdays).

    ESTIMATOR — availability, not demand. For each of the 168 weekly slots the
    probability is the fraction of WEEKS in which any activity occurred in it.
    Two earlier estimators were measured and rejected:

      * per activity, normalised by that activity's busiest slot — measures how
        *busy* a slot is, not whether work is possible in it. Used as a gate it
        multiplies throughput by the mean probability: it refused 110,962 of
        119,024 candidates (93%); 'Load Truck' was offered 66,374 times and
        started 35.
      * per activity, fraction of weeks used — still confounded. 'Register
        Customer Order' fires ~9 times a week across 70 slots, so a slot-week is
        empty 87% of the time because there was nothing to do, not because the
        process was closed. Mean availability 0.130.

    Pooling all activities removes the confound: a slot is available if ANY work
    happened in it. Measured here: 0.800 mean availability weekdays 05:00-17:00,
    0.08 Saturday, 0.02 Sunday.

    DEVIATION FROM SIMOD: SIMOD derives one calendar per RESOURCE profile from
    that resource's own events. OCEL 2.0 events carry no resource attribute —
    container_logistics has none on any of its 35,372 events — so this is one
    process-level calendar. Per-activity calendars were tried and abandoned for
    the confound above: an activity's event times measure when it was *needed*;
    only a resource's full history measures when it was *available*.

    Returns:
        {'slots_per_week': 168, 'global': [168 floats], 'per_activity': {},
         'fallback_activities': [...], 'weeks_observed': int}
        per_activity is intentionally empty — every activity uses the pooled
        calendar through Simulator._calendar_for.
    """
    if isinstance(ocel_log, list):
        return {}
    by_act = _event_times_by_activity(ocel_log)
    if not by_act:
        return {}

    SLOTS = 7 * 24
    slot_weeks: Dict[int, Set] = defaultdict(set)
    all_weeks: Set = set()
    for times in by_act.values():
        for t in times:
            iso = t.isocalendar()
            wk = (iso[0], iso[1])
            all_weeks.add(wk)
            slot_weeks[t.weekday() * 24 + t.hour].add(wk)

    if not all_weeks:
        return {}
    n_weeks = len(all_weeks)
    return {
        'slots_per_week': SLOTS,
        'global': [len(slot_weeks.get(s, ())) / n_weeks for s in range(SLOTS)],
        'per_activity': {},
        'fallback_activities': sorted(by_act.keys()),
        'weeks_observed': n_weeks,
    }

def discover_object_transition_matrix(ocel_log: Dict[str, Any]) -> Dict[str, Any]:
    """Per-object-type directly-follows probabilities: P(next | type, last activity).

    For each object, the ordered sequence of activities it took part in is read
    off the log, and transitions are counted per object type. '<START>' is the
    state of an object that has not yet participated in anything.

    This replaces the global transition matrix as the basis for choosing between
    candidates that compete for the same object. The global matrix conditions on
    "the last event anywhere in the process", which across thousands of
    interleaved objects is scheduling noise — it promoted 'Load Truck' 705 times
    in a run where it fired 6. Conditioning on the object's own history instead
    matches how OC-Declare scopes its constraints (each/Container is a statement
    about that container) and is strongly predictive: measured on
    container_logistics, the top choice is correct 93.9% of the time on held-out
    data, from only 32 (type, last_activity) states across 7 object types.

    Scoring uses the candidate's PRIMARY object only. Multiplying probabilities
    across every participating object was measured as an alternative: the two
    rules pick the same winner 99.4% of the time, and the product rule is worse
    on log-loss (0.464 vs 0.163) because multiplying sub-1 probabilities thins
    the true activity's score. It would become worth revisiting if object
    attributes ever make two objects of the same type behave differently.

    A simulation parameter, not part of OC-Declare: measured from the log and
    merged at simulation setup, never written into the model file.

    Returns:
        {object_type: {last_activity: {next_activity: probability}}}
    """
    if isinstance(ocel_log, list):
        return {}
    events = ocel_log.get('events', {})
    evlist = list(events.values()) if isinstance(events, dict) else (events or [])
    objects = ocel_log.get('objects', {})

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

    rows = []
    for ev in evlist:
        act = (ev.get('activity') or ev.get('type') or ev.get('ocel:activity') or '')
        t = _parse_ts(ev.get('timestamp') or ev.get('ocel:timestamp') or ev.get('time'))
        if not act or t is None:
            continue
        omap = ev.get('omap') or []
        if not omap:
            omap = [r.get('objectId', r) if isinstance(r, dict) else r
                    for r in (ev.get('relationships') or [])]
        rows.append((t, act, omap))
    rows.sort(key=lambda r: r[0])

    obj_seq: Dict[str, List[str]] = defaultdict(list)
    for _t, act, omap in rows:
        for oid in omap:
            obj_seq[oid].append(act)

    counts: Dict[str, Dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    for oid, seq in obj_seq.items():
        od = objects.get(oid)
        ot = od.get('type') if isinstance(od, dict) else None
        if not ot:
            continue
        prev = '<START>'
        for act in seq:
            counts[ot][prev][act] += 1
            prev = act

    out: Dict[str, Any] = {}
    for ot, by_last in counts.items():
        out[ot] = {}
        for last, cnt in by_last.items():
            total = sum(cnt.values())
            if total:
                out[ot][last] = {a: c / total for a, c in cnt.items()}
    return out



def discover_start_activities(
    ocel_log: Dict[str, Any],
    min_pct: float = 1.0
) -> List[Dict[str, Any]]:
    """Discover ranked candidate start activities.

    For every object instance in the log, finds the chronologically first
    activity recorded for that object and tallies the counts.  Returns all
    activities that appear as the first event for at least *min_pct* percent
    of all object instances, sorted by count descending.

    This is especially useful for knowledge-intensive logs (e.g. parliamentary
    processes) where multiple distinct entry-points exist for different case
    variants.

    Args:
        ocel_log:  OCEL 2.0 log dict.
        min_pct:   Minimum percentage threshold (default 1 %).

    Returns:
        List of dicts, sorted by frequency descending::

            [{'activity': str, 'count': int, 'pct': float}, ...]
    """
    if isinstance(ocel_log, list):
        return []

    objects = ocel_log.get('objects', {})
    events  = ocel_log.get('events', {})

    # Single pass over events: track earliest (timestamp, activity) per object — O(N_events)
    obj_first: Dict[str, tuple] = {}  # oid -> (timestamp, activity)
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
            if oid not in objects:
                continue
            if oid not in obj_first or timestamp < obj_first[oid][0]:
                obj_first[oid] = (timestamp, activity)

    first_activities: List[str] = [act for (_, act) in obj_first.values() if act]

    total = len(first_activities)
    if total == 0:
        return []

    counts = Counter(first_activities)
    result = []
    for act, cnt in counts.most_common():
        pct = round(cnt / total * 100, 1)
        if pct >= min_pct:
            result.append({'activity': act, 'count': cnt, 'pct': pct})
    return result



def discover_object_bindings(ocel_log: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Discover which object types each activity interacts with and cardinality.
    
    Args:
        ocel_log: OCEL 2.0 log dictionary
        
    Returns:
        Dictionary mapping activity -> object_type -> {min_count, max_count, creates, deactivates}
    """
    # Handle simple list format
    if isinstance(ocel_log, list):
        # For simple list format, assume each activity has 1 "case" object
        bindings = {}
        for trace in ocel_log:
            for activity in trace:
                if activity not in bindings:
                    bindings[activity] = {}
                if 'case' not in bindings[activity]:
                    bindings[activity]['case'] = {
                        'min_count': 1,
                        'max_count': 1,
                        'creates': False,
                        'deactivates': False
                    }
        return bindings
    
    events = ocel_log.get('events', {})
    objects = ocel_log.get('objects', {})
    
    # Track object type counts per activity
    activity_object_counts = defaultdict(lambda: defaultdict(list))
    
    for event_data in events.values():
        activity = event_data.get('activity')
        if not activity:
            continue
        
        object_ids = event_data.get('omap', []) or event_data.get('relationships', [])
        
        # Count objects by type for this event
        type_counts = defaultdict(int)
        for obj_id in object_ids:
            obj_data = objects.get(obj_id, {})
            obj_type = obj_data.get('type')
            if obj_type:
                type_counts[obj_type] += 1
        
        # Record counts
        for obj_type, count in type_counts.items():
            activity_object_counts[activity][obj_type].append(count)
    
    # Calculate min/max cardinality
    bindings = {}
    for activity, type_counts in activity_object_counts.items():
        bindings[activity] = {}
        for obj_type, counts in type_counts.items():
            bindings[activity][obj_type] = {
                'min_count': min(counts),
                'max_count': max(counts) if max(counts) < 100 else None,  # None = unbounded
                'creates': False,  # Will be set by lifecycle discovery
                'deactivates': False  # Will be set by lifecycle discovery
            }
    
    return bindings


def _declared_o2o_links(objects: Dict[str, Any]):
    """Object-to-object links exactly as the log declares them.

    Reads each object's own ``relationships`` list (OCEL 2.0's O2O section,
    preserved by the loaders above) — NOT event co-participation.

    Both directions of every declared relation are recorded. A relation is a
    single fact about two objects, and SimulationState.add_link stores links
    undirected (it indexes both endpoints), so the cardinality of a pair is
    meaningful read either way: "TR loads CR" appears 1997 times over 6 trucks,
    which says both "a truck loads 323-337 containers" and "a container is
    loaded by 1 truck". Emitting only the declared direction would leave the
    second fact — the one that actually constrains containers — unstated.

    Same-type relations are skipped: O2ORule is keyed on a type pair and the
    engine has no way to express a rule whose two sides are the same type.

    Returns (links, n_relations) where links maps
    (source_type, target_type) -> {source_object_id: {target_object_id, ...}}.
    """
    links = defaultdict(lambda: defaultdict(set))
    qualifiers = defaultdict(set)
    n_relations = 0

    for src_id, src in (objects or {}).items():
        src_type = (src or {}).get('type')
        if not src_type:
            continue
        for rel in ((src or {}).get('relationships') or ()):
            if isinstance(rel, dict):
                tgt_id = (rel.get('objectId') or rel.get('ocel:oid')
                          or rel.get('object-id') or rel.get('targetId'))
                qual = rel.get('qualifier') or ''
            else:
                tgt_id, qual = rel, ''
            if not tgt_id or tgt_id == src_id:
                continue
            tgt_type = (objects.get(tgt_id) or {}).get('type')
            if not tgt_type or tgt_type == src_type:
                continue
            n_relations += 1
            links[(src_type, tgt_type)][src_id].add(tgt_id)
            links[(tgt_type, src_type)][tgt_id].add(src_id)
            if qual:
                qualifiers[(src_type, tgt_type)].add(qual)
                qualifiers[(tgt_type, src_type)].add(qual)

    return links, qualifiers, n_relations


def discover_o2o_rules(ocel_log: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Read object-to-object relationship rules from the log's O2O section.

    The cardinalities come from the relations the log itself declares between
    objects. They are NOT inferred from which object types share an event.

    That distinction matters. Co-participation answers "were these two objects
    in the same event", which is a different question from "are these two
    objects related", and on container_logistics the two disagree badly: the
    log declares 15,920 relations over 7 type pairs, while co-participation
    produced 17 pairs, 13 of which the log never states. Some were simply
    wrong — the log says a Container belongs to exactly one Transport Document
    (1..1), co-participation said 1..13, because ``Depart`` puts a container in
    one event alongside up to 13 documents. Those invented ceilings are then
    enforced by check_o2o_rules and silently block activities.

    A log with no O2O section yields no rules. That is the honest answer: the
    log states no object relations, so none are enforced.

    Args:
        ocel_log: OCEL 2.0 log dictionary

    Returns:
        List of O2O rules with cardinality constraints
    """
    # Handle simple list format - no O2O rules for simple lists
    if isinstance(ocel_log, list):
        return []

    objects = ocel_log.get('objects', {})

    o2o_links, o2o_qualifiers, _n_relations = _declared_o2o_links(objects)
    if not o2o_links:
        return []

    # Calculate cardinality for each directed pair, then decide bidirectionality
    def _rule(src, tgt, lo, hi, bidirectional):
        # max_links is the largest number of distinct partners of `tgt` that any
        # single `src` object actually has in the log. No ceiling heuristic is
        # applied: the observed maximum IS what the log says, and capping large
        # values to "unbounded" would be another inference of the kind this
        # function exists to avoid.
        r = {
            'source_type': src,
            'target_type': tgt,
            'min_links': lo,
            'max_links': hi,
            'bidirectional': bidirectional,
        }
        quals = sorted(o2o_qualifiers.get((src, tgt), ()))
        if quals:
            # Provenance only — O2ORule has no qualifier field, so the rule is
            # the aggregate over all qualifiers joining this type pair.
            r['qualifiers'] = quals
        return r

    o2o_rules = []
    processed_pairs = set()

    for (type1, type2), links in o2o_links.items():
        if (type1, type2) in processed_pairs or (type2, type1) in processed_pairs:
            continue
        processed_pairs.add((type1, type2))

        fwd_cards = [len(linked_objs) for linked_objs in links.values()]
        if not fwd_cards:
            continue

        fwd_min, fwd_max = min(fwd_cards), max(fwd_cards)

        rev_links = o2o_links.get((type2, type1), {})
        rev_cards = [len(linked_objs) for linked_objs in rev_links.values()]

        if not rev_cards:
            # Unreachable while _declared_o2o_links records both directions;
            # kept so a caller passing a one-directional link map still works.
            o2o_rules.append(_rule(type1, type2, fwd_min, fwd_max, False))
            continue

        rev_min, rev_max = min(rev_cards), max(rev_cards)

        if fwd_min == rev_min and fwd_max == rev_max:
            # Symmetric: one bidirectional rule with the shared cardinality
            o2o_rules.append(_rule(type1, type2, fwd_min, fwd_max, True))
        else:
            # Asymmetric: two separate unidirectional rules
            o2o_rules.append(_rule(type1, type2, fwd_min, fwd_max, False))
            o2o_rules.append(_rule(type2, type1, rev_min, rev_max, False))

    return o2o_rules


def discover_ocdeclare_model(
    event_log_path: str,
    noise_threshold: float = 0.2,
    arc_types: Optional[List[str]] = None,
    reduction: str = 'Lossless',
    lifecycle_threshold: float = 0.5,
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
        lifecycle_threshold: Minimum fraction of object instances for which an
            activity must be the chronological first/last event to be labelled
            creates/consumes.  Default 0.5 (majority vote).
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
                    If not provided, falls back to 'src/Simulation/IO/input/ocdeclare'
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
            output_path = Path('src/Simulation/IO/input/ocdeclare') / output_filename
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




def compute_ocpa_metrics(
    ocel_log: Dict[str, Any],
    anchor_activities: List[Dict[str, Any]] = None,
    service_time_mode: str = 'minimum',
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
    import math
    import statistics

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
        using_fallback = raw_source is not direct and not raw_source
        if act in anchor_map:
            anc = anchor_map[act]
            svc_mean = float(anc.get("mean_seconds", soj["mean"]))
            svc_std  = float(anc.get("std_seconds",  soj["std"]))
            svc_min  = float(anc.get("min_seconds",  0.0))
            svc_max  = anc.get("max_seconds")
            svc_max  = float(svc_max) if svc_max is not None else None
        elif raw_source:
            sorted_svc = sorted(raw_source)
            n = len(sorted_svc)

            # For terminal activities using sojourn fallback, always use minimum
            # window to strip idle-time inflation from the backward-looking sojourn.
            effective_mode = 'minimum' if using_fallback else service_time_mode

            if effective_mode == 'p25':
                lo_idx = 0
                hi_idx = max(0, int(math.ceil(0.50 * n)) - 1)  # [min, P50]
            elif effective_mode == 'p50':
                lo_idx = max(0, int(math.ceil(0.25 * n)) - 1)  # [P25, P75]
                hi_idx = max(0, int(math.ceil(0.75 * n)) - 1)
            else:  # 'minimum' — [min, P25]
                lo_idx = 0
                hi_idx = max(0, int(math.ceil(0.25 * n)) - 1)

            sub = sorted_svc[lo_idx : hi_idx + 1]
            if not sub:
                sub = sorted_svc  # fallback: use all if window is empty

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
