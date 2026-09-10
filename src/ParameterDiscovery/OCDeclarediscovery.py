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
        objects[oid] = {'type': otype, 'attributes': attrs}

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
                        'attributes': obj.get('attributes', {})
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


def _check_arc(
    idx: Dict[str, Any],
    act_A: str,
    act_B: str,
    arc_type: str,
    obj_type: str,
    involvement: str,
    noise_threshold: float,
    counts_min: int = 1,
    counts_max: Optional[int] = 20,
) -> Optional[Dict[str, Any]]:
    """
    Check one OC-Declare arc (act_A → act_B, arc_type, obj_type, involvement).

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

    return {
        'from':                  act_A,
        'to':                    act_B,
        'arc_type':              arc_type,
        'label':                 [obj_type],
        'involvement':           involvement,
        'involvement_per_label': {obj_type: involvement},
        'counts':                [counts_min, None],
        'support':               round(support, 4),
    }


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
    counts_max: Optional[int] = 20,
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
            # Every combination of one object per multi-object-each type must find
            # a qualifying B-event containing all assigned objects simultaneously.
            from itertools import product as _iproduct
            ok = True
            for assignment in _iproduct(*multi_sets):
                joint = joint_base
                for obj_set in assignment:
                    joint = joint & obj_set
                if not joint:
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
    return {
        'from':                  act_A,
        'to':                    act_B,
        'arc_type':              arc_type,
        'label':                 list(obj_types),
        'involvement':           min_inv,
        'involvement_per_label': ipl,
        'counts':                [counts_min, None],
        'support':               round(support, 4),
    }


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


def _arcs_to_deco_constraints(arcs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Map OC-Declare arcs to the DeCo simulator constraint format.

    EF/DF(A→B, T): response(source=A, target=B)
    EP/DP(A→B, T): precedence(source=B, target=A)
    AS(A→B, T):    coexistence(source=A, target=B)
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
        nmin, nmax = arc.get('counts', [1, None])
        support   = arc.get('support', 0.0)
        ctype     = ARC_TO_CTYPE.get(atype)
        if not ctype:
            continue
        src, tgt = (B, A) if atype in ('EP', 'DP') else (A, B)
        inv = arc.get('involvement', 'each')
        ipl = arc.get('involvement_per_label', {obj_type: inv})
        constraints.append({
            'type':                  ctype,
            'constraint_type':       ctype,
            'source':                src,
            'target':                tgt,
            'source_activity':       src,
            'target_activity':       tgt,
            'source_type':           obj_type,
            'target_type':           obj_type,
            'nmin':                  nmin,
            'nmax':                  nmax,
            'support':               support,
            'confidence':            support,
            'arc_type':              atype,
            'involvement':           inv,
            'involvement_per_label': ipl,
            'label':                 arc.get('label', []),
            'scope':                 {
                'kind':                   inv,
                'object_type':            obj_type,
                'involvement_per_label':  ipl,
            },
        })
    return constraints


def _discover_kvaanda_arcs(
    ocel_log: Dict[str, Any],
    activities: List[str],
    object_types: List[str],
    noise_threshold: float = 0.2,
    arc_types: Optional[List[str]] = None,
    counts_min: int = 1,
    counts_max: Optional[int] = 20,
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
        s: Set[str] = set()
        for eid in idx['events_by_activity'].get(act, []):
            s.update(idx['event_objs_by_type'].get(eid, {}).keys())
        act_B_otypes[act] = s

    _log(f"Arc mining: {len(activities)} activities × {len(object_types)} object types, noise threshold {noise_threshold}")

    n_acts = len(activities)
    for i, act_A in enumerate(activities):
        if progress_callback is not None:
            progress_callback('Mining arcs', round(100 * i / n_acts) if n_acts else 100)
        _log(f"[{i+1}/{n_acts}] Checking act_A: {act_A}")
        for act_B in activities:
            for obj_type in object_types:
                if max_objs.get(act_A, {}).get(obj_type, 0) == 0:
                    continue
                if obj_type not in act_B_otypes.get(act_B, set()):
                    continue

                is_multiple = max_objs[act_A][obj_type] > 1

                # Step 1: check 'any' with AS to see if this pair is viable at all
                any_as = _check_arc(idx, act_A, act_B, 'AS', obj_type, 'any',
                                    noise_threshold, counts_min, counts_max)
                if any_as is None:
                    continue

                if is_multiple:
                    involvements = ['any']
                    each_as = _check_arc(idx, act_A, act_B, 'AS', obj_type, 'each',
                                         noise_threshold, counts_min, counts_max)
                    if each_as is not None:
                        involvements.append('each')
                else:
                    # When max objects per event == 1, 'any' and 'each' are equivalent;
                    # OCPQ returns 'each' in this case.
                    involvements = ['each']

                # Step 2: escalate arc type for each viable involvement
                for inv in involvements:
                    arcs.extend(_get_stricter_arc_type(
                        idx, act_A, act_B, obj_type, inv, arc_types,
                        noise_threshold, counts_min, counts_max,
                    ))

    # Step 3: combine single-type arcs into multi-type arcs where possible
    _log(f"Arc scan done — {len(arcs)} raw arcs found; merging multi-type arcs…")
    arcs = _combine_to_multitype_arcs(arcs, idx, noise_threshold, counts_min, counts_max)
    _log(f"After multi-type merge: {len(arcs)} arcs")

    # Step 4: lossless reduction
    if reduction == 'Lossless':
        arcs = _lossless_reduction(arcs)
        _log(f"After lossless reduction: {len(arcs)} arcs remain")

    # Step 5: refinement then re-reduce
    if refinement:
        arcs = _refine_arcs(arcs, idx, noise_threshold, counts_min, counts_max)
        if reduction == 'Lossless':
            arcs = _lossless_reduction(arcs)
        _log(f"After refinement + re-reduction: {len(arcs)} final arcs")

    return arcs


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
    # An activity already marked as a creator is never additionally a terminator
    # (prevents creates+consumes spurious flag from single-event noise instances)
    terminating_activities = {
        act for act, cnt in last_counts.items()
        if cnt / n >= lifecycle_threshold and act not in creating_activities
    }

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


def discover_o2o_rules(ocel_log: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Discover object-to-object relationship rules.
    
    Args:
        ocel_log: OCEL 2.0 log dictionary
        
    Returns:
        List of O2O rules with cardinality constraints
    """
    # Handle simple list format - no O2O rules for simple lists
    if isinstance(ocel_log, list):
        return []
    
    events = ocel_log.get('events', {})
    objects = ocel_log.get('objects', {})
    
    # Track which object types co-occur in events
    o2o_links = defaultdict(lambda: defaultdict(set))
    
    for event_data in events.values():
        object_ids = event_data.get('omap', []) or event_data.get('relationships', [])
        
        # Find all pairs of different object types in this event
        for obj1_id in object_ids:
            obj1_type = objects.get(obj1_id, {}).get('type')
            if not obj1_type:
                continue
            
            for obj2_id in object_ids:
                if obj1_id == obj2_id:
                    continue
                
                obj2_type = objects.get(obj2_id, {}).get('type')
                if not obj2_type or obj1_type == obj2_type:
                    continue
                
                # Record link
                o2o_links[(obj1_type, obj2_type)][obj1_id].add(obj2_id)
    
    # Calculate cardinality for each directed pair, then decide bidirectionality
    o2o_rules = []
    processed_pairs = set()

    for (type1, type2), links in o2o_links.items():
        if (type1, type2) in processed_pairs or (type2, type1) in processed_pairs:
            continue
        processed_pairs.add((type1, type2))

        fwd_cards = [len(linked_objs) for linked_objs in links.values()]
        if not fwd_cards:
            continue

        fwd_min = min(fwd_cards)
        fwd_max = max(fwd_cards)

        rev_links = o2o_links.get((type2, type1), {})
        rev_cards = [len(linked_objs) for linked_objs in rev_links.values()]

        if rev_cards:
            rev_min = min(rev_cards)
            rev_max = max(rev_cards)

            if fwd_max == rev_max and fwd_min == rev_min:
                # Symmetric: one bidirectional rule with the shared cardinality
                o2o_rules.append({
                    'source_type': type1,
                    'target_type': type2,
                    'min_links': fwd_min,
                    'max_links': fwd_max if fwd_max < 100 else None,
                    'bidirectional': True,
                })
            else:
                # Asymmetric: two separate unidirectional rules
                o2o_rules.append({
                    'source_type': type1,
                    'target_type': type2,
                    'min_links': fwd_min,
                    'max_links': fwd_max if fwd_max < 100 else None,
                    'bidirectional': False,
                })
                o2o_rules.append({
                    'source_type': type2,
                    'target_type': type1,
                    'min_links': rev_min,
                    'max_links': rev_max if rev_max < 100 else None,
                    'bidirectional': False,
                })
        else:
            # No reverse links observed — unidirectional rule
            o2o_rules.append({
                'source_type': type1,
                'target_type': type2,
                'min_links': fwd_min,
                'max_links': fwd_max if fwd_max < 100 else None,
                'bidirectional': False,
            })

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

    # Discover object bindings
    _cb('Building bindings', 8)
    _log("Discovering object bindings (cardinality per activity)…")
    bindings_data = discover_object_bindings(ocel_log)
    _log(f"Bindings done for {len(bindings_data)} activities")

    # Update bindings with lifecycle info (creates/deactivates flags)
    n_types = len(object_types)
    for ti, obj_type in enumerate(object_types):
        pct = 8 + int(2 * (ti + 1) / max(n_types, 1))  # 8→10 across all types
        _cb('Lifecycle discovery', pct)
        _log(f"Lifecycle [{ti+1}/{n_types}]: scanning events for '{obj_type}'…")
        creating_acts, terminating_acts = discover_lifecycle(
            ocel_log, obj_type, lifecycle_threshold
        )
        _log(f"  → creates: {sorted(creating_acts) or 'none'}  |  deactivates: {sorted(terminating_acts) or 'none'}")
        for activity in creating_acts:
            if activity in bindings_data and obj_type in bindings_data[activity]:
                bindings_data[activity][obj_type]['creates'] = True
        for activity in terminating_acts:
            if activity in bindings_data and obj_type in bindings_data[activity]:
                bindings_data[activity][obj_type]['deactivates'] = True

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
            counts_max=20,
            reduction=reduction,
            refinement=True,
            progress_callback=lambda phase, pct: _cb(phase, 10 + int(pct * 0.8)),
            log_callback=log_callback,
        )
    )
    _log(f"Constraint translation done — {len(all_constraints)} constraints discovered")

    # Discover O2O rules
    _cb('Discovering O2O rules', 92)
    _log("Discovering object-to-object (O2O) relationship rules…")
    o2o_rules = discover_o2o_rules(ocel_log)
    _log(f"Found {len(o2o_rules)} O2O rules")

    # Classify resource object types (high events-per-instance ratio)
    _cb('Classifying object types', 94)
    _log("Classifying permanent (resource) object types…")
    resource_types = discover_permanent_object_types(ocel_log, permanent_threshold)
    _log(f"Permanent/resource types: {', '.join(resource_types) if resource_types else 'none detected'}")

    # Discover ranked start activity candidates
    start_activities_ranked = discover_start_activities(ocel_log)

    # Collect attribute schema and default values from the log.
    # attribute_schema: { object_type: { attr_name: initial_value } }
    # Phase 4d: when attribute entries carry timestamps, use the earliest-observed
    # value per attribute (object's initial state) instead of most-common.
    # object_type_attr_defs: { object_type: [ {name, type} ] }
    attribute_schema: Dict[str, Any] = {}
    object_type_attr_defs: Dict[str, list] = {}

    raw_objects = ocel_log.get("objects", {})
    raw_object_types_meta = ocel_log.get("objectTypes", []) or []

    for ot_entry in raw_object_types_meta:
        if not isinstance(ot_entry, dict):
            continue
        ot_name = ot_entry.get("name", "")
        if not ot_name:
            continue
        attr_defs = ot_entry.get("attributes", []) or []
        object_type_attr_defs[ot_name] = [
            {"name": str(a.get("name", "")), "type": str(a.get("type", "string"))}
            for a in attr_defs if isinstance(a, dict) and a.get("name")
        ]

    # Buckets: (object_type, attr_name) -> list of (timestamp_str_or_None, value)
    attr_value_buckets: Dict[str, Dict[str, list]] = {}
    obj_iter = raw_objects.values() if isinstance(raw_objects, dict) else (raw_objects if isinstance(raw_objects, list) else [])
    for obj_entry in obj_iter:
        if not isinstance(obj_entry, dict):
            continue
        ot = obj_entry.get("type", "")
        attrs = obj_entry.get("attributes", []) or []
        if isinstance(attrs, list):
            for a in attrs:
                if not isinstance(a, dict):
                    continue
                name = a.get("name")
                value = a.get("value")
                ts = a.get("time")  # may be None for unversioned entries
                if name is not None and value is not None:
                    attr_value_buckets.setdefault(ot, {}).setdefault(name, []).append((ts, value))
        elif isinstance(attrs, dict):
            for name, value in attrs.items():
                if value is not None:
                    attr_value_buckets.setdefault(ot, {}).setdefault(name, []).append((None, value))

    for ot, attr_map in attr_value_buckets.items():
        defaults = {}
        for attr_name, ts_value_pairs in attr_map.items():
            # Use earliest timestamped value when available; fall back to most-common
            timestamped = [(ts, v) for ts, v in ts_value_pairs if ts is not None]
            if timestamped:
                timestamped.sort(key=lambda x: x[0])
                defaults[attr_name] = timestamped[0][1]
            else:
                values = [v for _, v in ts_value_pairs]
                counter = Counter(str(v) for v in values)
                most_common_str, _ = counter.most_common(1)[0]
                defaults[attr_name] = next((v for v in values if str(v) == most_common_str), most_common_str)
        attribute_schema[ot] = defaults

    # Phase 3e: discover event-level attribute names per activity type
    # Collect attribute names observed on events in the log — user still decides
    # capture source; this pre-populates the known attribute names.
    event_attr_names: Dict[str, list] = {}  # activity_name -> [attr_name, ...]
    raw_events = ocel_log.get("events", []) or []
    ev_iter = raw_events.values() if isinstance(raw_events, dict) else raw_events
    for ev_entry in ev_iter:
        if not isinstance(ev_entry, dict):
            continue
        act_name = ev_entry.get("type") or ev_entry.get("activity") or ""
        ev_attrs = ev_entry.get("attributes", []) or []
        seen = event_attr_names.setdefault(act_name, [])
        if isinstance(ev_attrs, list):
            for ea in ev_attrs:
                if isinstance(ea, dict):
                    n = ea.get("name")
                    if n and n not in seen:
                        seen.append(n)
        elif isinstance(ev_attrs, dict):
            for n in ev_attrs:
                if n not in seen:
                    seen.append(n)

    # Build object_types list: strings for backward compat, but enrich with attr defs
    object_types_with_attrs = []
    for ot_name in object_types:
        entry: Dict[str, Any] = {"name": ot_name}
        if ot_name in object_type_attr_defs:
            entry["attributes"] = object_type_attr_defs[ot_name]
        object_types_with_attrs.append(entry)

    # Build activity structures with bindings
    activity_structures = []
    for activity in activities:
        bindings_list = []
        if activity in bindings_data:
            for obj_type, binding_info in bindings_data[activity].items():
                bindings_list.append({
                    'object_type': obj_type,
                    'min_count': binding_info['min_count'],
                    'max_count': binding_info['max_count'],
                    'creates': binding_info['creates'],
                    'deactivates': binding_info['deactivates']
                })

        act_entry: Dict[str, Any] = {
            'name': activity,
            'bindings': bindings_list,
        }
        # Phase 3e: attach discovered event attribute names so the UI can
        # pre-populate the event_attributes capture list
        if activity in event_attr_names and event_attr_names[activity]:
            act_entry['discovered_event_attr_names'] = event_attr_names[activity]
        activity_structures.append(act_entry)

    # Build discovered model
    discovered_model = {
        'object_types': object_types_with_attrs,
        'activities': activity_structures,
        'constraints': all_constraints,
        'o2o_rules': o2o_rules,
        'resource_types': resource_types,
        'attribute_schema': attribute_schema,
        'event_attribute_names': event_attr_names,  # Phase 3e
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
        'num_o2o_rules': len(o2o_rules),
        'constraint_breakdown': constraint_breakdown,
        'avg_support': round(sum(c['support'] for c in all_constraints) / len(all_constraints), 3) if all_constraints else 0,
        'avg_confidence': round(sum(c['confidence'] for c in all_constraints) / len(all_constraints), 3) if all_constraints else 0
    }
    
    result = {
        'model': discovered_model,
        'stats': stats,
        'output_file': output_filename,
        'start_activities_ranked': start_activities_ranked,
        'parameters': {
            'min_support': min_support,
            'min_confidence': min_confidence,
            'noise_threshold': noise_threshold,
            'lifecycle_threshold': lifecycle_threshold,
            'permanent_threshold': permanent_threshold,
            'resource_types': resource_types,
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
