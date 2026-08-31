"""
OC-Declare Model Discovery from OCEL 2.0 Event Logs

This module discovers OC-Declare declarative constraints from object-centric event logs.
It mines constraints like precedence and response rules with support/confidence metrics.
"""

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


def load_ocel2(filename: str) -> Dict[str, Any]:
    """Load an OCEL 2.0 event log from a JSON or XML file.

    Args:
        filename: Path to OCEL 2.0 file (.json or .xml)

    Returns:
        Dictionary with 'events' and 'objects' keys
    """
    filepath = Path(filename)
    if not filepath.exists():
        raise FileNotFoundError(f"Event log not found: {filename}")

    if filepath.suffix.lower() == '.xml':
        return load_ocel2_xml(filename)
    
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # Support both OCEL 2.0 format (dict) and simple list format
    if isinstance(data, dict):
        # Handle case where objects/events might be arrays instead of dicts
        # Some OCEL tools export objects/events as arrays
        if 'objects' in data and isinstance(data['objects'], list):
            # Convert objects array to dict
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
            else:
                qualifying_eids: Set[str] = set()
                for oid in A_objs:
                    for ts, eid in obj_B_events.get(oid, []):
                        if arc_type == 'EF' and ts > t_A:
                            qualifying_eids.add(eid)
                        elif arc_type == 'EP' and ts < t_A:
                            qualifying_eids.add(eid)
                        elif arc_type == 'AS':
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
        'from':        act_A,
        'to':          act_B,
        'arc_type':    arc_type,
        'label':       [obj_type],
        'involvement': involvement,
        'counts':      [counts_min, None],
        'support':     round(support, 4),
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
    c_inv  = _involvement_strength(c.get('involvement', 'each'))
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
            e_inv  = _involvement_strength(e.get('involvement', 'each'))
            e_lbl  = set(e['label'])
            if not _arc_type_dominated_by_or_eq(c_type, e_type):
                continue
            if e_inv < c_inv or e_lbl != c_lbl:
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
    """
    Refinement pass matching OCPQ's refine_oc_arcs_indexed:
    for each arc, try to tighten 'any'→'each' involvement.

    Note: escalation stops at 'each' for single-type labels. In OCPQ,
    'all' only appears as a secondary qualifier inside multi-type bindings;
    promoting single-type arcs to 'all' diverges from OCPQ output.
    """
    refined: List[Dict[str, Any]] = []
    for arc in arcs:
        obj_type    = arc['label'][0] if arc['label'] else ''
        arc_type    = arc['arc_type']
        involvement = arc.get('involvement', 'each')
        act1, act2  = arc['from'], arc['to']
        next_inv    = {'any': 'each'}.get(involvement)
        if next_inv is not None:
            stricter = _check_arc(idx, act1, act2, arc_type, obj_type, next_inv,
                                  noise_threshold, counts_min, counts_max)
            if stricter is not None:
                refined.append(stricter)
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
        constraints.append({
            'type':            ctype,
            'constraint_type': ctype,
            'source':          src,
            'target':          tgt,
            'source_activity': src,
            'target_activity': tgt,
            'source_type':     obj_type,
            'target_type':     obj_type,
            'nmin':            nmin,
            'nmax':            nmax,
            'support':         support,
            'confidence':      support,
            'arc_type':        atype,
            'involvement':     inv,
            'label':           arc.get('label', []),
            'scope':           {'kind': inv, 'object_type': obj_type},
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

    for act_A in activities:
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

    # Step 3: lossless reduction
    if reduction == 'Lossless':
        arcs = _lossless_reduction(arcs)

    # Step 4: refinement then re-reduce
    if refinement:
        arcs = _refine_arcs(arcs, idx, noise_threshold, counts_min, counts_max)
        if reduction == 'Lossless':
            arcs = _lossless_reduction(arcs)

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
    
    # Track first and last activities per object
    object_first_activity = {}
    object_last_activity = {}
    
    for obj_id, obj_data in objects.items():
        if obj_data.get('type') != object_type:
            continue
        
        # Find all events for this object
        obj_events = []
        for event_id, event_data in events.items():
            object_ids = event_data.get('omap', []) or event_data.get('relationships', [])
            if obj_id in object_ids:
                obj_events.append({
                    'activity': event_data.get('activity'),
                    'timestamp': event_data.get('timestamp', '')
                })
        
        if obj_events:
            # Sort by timestamp
            obj_events.sort(key=lambda x: x['timestamp'])
            object_first_activity[obj_id] = obj_events[0]['activity']
            object_last_activity[obj_id] = obj_events[-1]['activity']
    
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

    first_activities: List[str] = []
    for obj_id in objects:
        obj_events = [
            ed for ed in events.values()
            if obj_id in (ed.get('omap') or [])
        ]
        if not obj_events:
            continue
        obj_events.sort(key=lambda e: e.get('timestamp', ''))
        first_act = obj_events[0].get('activity')
        if first_act:
            first_activities.append(first_act)

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
    
    # Calculate cardinality
    o2o_rules = []
    processed_pairs = set()
    
    for (type1, type2), links in o2o_links.items():
        if (type1, type2) in processed_pairs or (type2, type1) in processed_pairs:
            continue
        
        # Count how many type2 objects each type1 object links to
        cardinalities = [len(linked_objs) for linked_objs in links.values()]
        
        if cardinalities:
            min_links = min(cardinalities)
            max_links = max(cardinalities)
            
            o2o_rules.append({
                'source_type': type1,
                'target_type': type2,
                'min_links': min_links,
                'max_links': max_links if max_links < 100 else None,
                'bidirectional': True  # Assume bidirectional by default
            })
            
            processed_pairs.add((type1, type2))
    
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
    output_dir: Optional[str] = None
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

    # Load event log
    ocel_log = load_ocel2(event_log_path)

    # Discover basic elements
    object_types = discover_object_types(ocel_log)
    activities   = discover_activities(ocel_log)

    # Discover object bindings
    bindings_data = discover_object_bindings(ocel_log)

    # Update bindings with lifecycle info (creates/deactivates flags)
    for obj_type in object_types:
        creating_acts, terminating_acts = discover_lifecycle(
            ocel_log, obj_type, lifecycle_threshold
        )
        for activity in creating_acts:
            if activity in bindings_data and obj_type in bindings_data[activity]:
                bindings_data[activity][obj_type]['creates'] = True
        for activity in terminating_acts:
            if activity in bindings_data and obj_type in bindings_data[activity]:
                bindings_data[activity][obj_type]['deactivates'] = True

    # Discover OC-Declare constraints using Küsters & van der Aalst (2025) algorithm
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
        )
    )
    
    # Discover O2O rules
    o2o_rules = discover_o2o_rules(ocel_log)

    # Classify resource object types (high events-per-instance ratio)
    resource_types = discover_permanent_object_types(ocel_log, permanent_threshold)

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
    
    return {
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




def discover_concurrency_probs(
    ocel_log: Dict[str, Any],
    activity_durations: Optional[Dict[str, Any]] = None,
    window_seconds: Optional[float] = None,
    min_occurrences: int = 2,
) -> Dict[str, float]:
    """Discover pairwise concurrency probabilities from an OCEL 2.0 log.

    Two events are considered concurrent when they share at least one object
    and their timestamps are within ``window_seconds`` of each other.  If no
    explicit window is given, the window for a pair (A, B) is
    ``max(mean_A, mean_B)`` from the provided activity_durations, falling
    back to 3600 s (1 h) when durations are unavailable.

    Returns a flat dict keyed ``"A|||B"`` (always A < B lexicographically so
    each unordered pair appears once) with the probability value in [0, 1].
    The probability is:
        p(A ∥ B) = (times A and B fired concurrently) / (total firings of A)
    Both ``"A|||B"`` and ``"B|||A"`` are stored for fast lookup.

    Parameters
    ----------
    ocel_log         : OCEL 2.0 dict (from load_ocel2).
    activity_durations : dict activity_name -> ActivityDuration or plain dict
                       with a ``mean_seconds`` key.  Used to set the window.
    window_seconds   : fixed override for the concurrency window (seconds).
                       When set, activity_durations is ignored for windowing.
    min_occurrences  : minimum number of concurrent co-occurrences required
                       before a probability is recorded.  Filters noise pairs.
    """
    if isinstance(ocel_log, list):
        return {}

    events  = ocel_log.get("events",  {})
    objects = ocel_log.get("objects", {})

    # ── Parse timestamps ──────────────────────────────────────────────────────
    def _ts(raw) -> Optional[datetime]:
        if raw is None:
            return None
        if isinstance(raw, datetime):
            return raw
        try:
            s = str(raw).replace("Z", "+00:00")
            return datetime.fromisoformat(s)
        except Exception:
            return None

    # Build a list of (timestamp, activity, event_id, {object_ids}) records
    ev_records = []
    for eid, edata in events.items():
        ts  = _ts(edata.get("timestamp") or edata.get("ocel:timestamp") or edata.get("time"))
        act = edata.get("activity") or edata.get("ocel:activity")
        omap = set(edata.get("omap") or edata.get("relationships") or [])
        if ts and act:
            ev_records.append((ts, act, eid, omap))

    if not ev_records:
        return {}

    ev_records.sort(key=lambda x: x[0])

    # ── Default window lookup ─────────────────────────────────────────────────
    def _mean_s(act: str) -> float:
        if activity_durations is None:
            return 3600.0
        entry = activity_durations.get(act)
        if entry is None:
            return 3600.0
        if isinstance(entry, dict):
            return float(entry.get("mean_seconds", 3600.0))
        return float(getattr(entry, "mean_seconds", 3600.0))

    # ── Count co-occurrences ──────────────────────────────────────────────────
    # For every event E_A, scan forward/backward within the window and find
    # events E_B that share at least one object with E_A.
    from datetime import timedelta

    act_total: Dict[str, int] = Counter(r[1] for r in ev_records)
    pair_count: Dict[str, int] = {}   # "A|||B" -> co-occurrence count (A <= B)

    n = len(ev_records)
    for i, (ts_a, act_a, _, omap_a) in enumerate(ev_records):
        win = timedelta(seconds=window_seconds if window_seconds is not None else 3600.0)
        # scan forward only — symmetric pairs counted once then doubled
        for j in range(i + 1, n):
            ts_b, act_b, _, omap_b = ev_records[j]
            if (ts_b - ts_a) > win:
                break
            if act_a == act_b:
                continue
            if not omap_a.intersection(omap_b):
                continue
            # use max window of the two activities when no fixed override
            if window_seconds is None:
                effective_win = timedelta(seconds=max(_mean_s(act_a), _mean_s(act_b)))
                if (ts_b - ts_a) > effective_win:
                    continue
            key = "|||".join(sorted([act_a, act_b]))
            pair_count[key] = pair_count.get(key, 0) + 1

    # ── Build probability dict ────────────────────────────────────────────────
    result: Dict[str, float] = {}
    for key, cnt in pair_count.items():
        if cnt < min_occurrences:
            continue
        a, b = key.split("|||")
        total_a = act_total.get(a, 0)
        total_b = act_total.get(b, 0)
        if total_a == 0 or total_b == 0:
            continue
        # p = symmetric: fraction of A-firings with a concurrent B,
        # averaged with fraction of B-firings with a concurrent A
        p = 0.5 * (cnt / total_a + cnt / total_b)
        p = min(1.0, round(p, 4))
        result[f"{a}|||{b}"] = p
        result[f"{b}|||{a}"] = p  # both orderings for fast lookup

    return result


if __name__ == '__main__':
    # Example usage
    result = discover_ocdeclare_model(
        event_log_path='src/Simulation/IO/input/eventlog/example_log.json',
        min_support=0.7,
        min_confidence=0.85,
        noise_threshold=0.15,
        constraint_types={'precedence': True, 'response': True},
        output_filename='discovered_model.json'
    )
    
    print(f"Discovered model saved to: {result['output_file']}")
    print(f"Statistics: {result['stats']}")
