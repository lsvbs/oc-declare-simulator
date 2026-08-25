"""
OC-Declare Model Discovery from OCEL 2.0 Event Logs

This module discovers OC-Declare declarative constraints from object-centric event logs.
It mines constraints like precedence and response rules with support/confidence metrics.
"""

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Set, Tuple, Any, Optional
from collections import Counter, defaultdict
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


def calculate_precedence_support_confidence(
    traces: Dict[str, List[str]], 
    source: str, 
    target: str
) -> Tuple[float, float]:
    """Calculate support and confidence for precedence constraint (source before target).
    
    Args:
        traces: Dictionary of object_id -> activity sequence
        source: Source activity
        target: Target activity
        
    Returns:
        Tuple of (support, confidence)
        - support: % of traces where source precedes target
        - confidence: % of traces with source where target follows
    """
    total_traces = len(traces)
    if total_traces == 0:
        return 0.0, 0.0
    
    traces_with_precedence = 0
    traces_with_source = 0
    
    for trace in traces.values():
        has_source = source in trace
        if not has_source:
            continue

        traces_with_source += 1

        # Check if ANY occurrence of source precedes ANY occurrence of target.
        # list.index() only finds the first occurrence, which gives wrong results
        # when either activity repeats.  We scan for the earliest source position
        # and then check whether target appears anywhere after it.
        if source in trace:
            first_source_idx = next(i for i, a in enumerate(trace) if a == source)
            # target must appear at some position strictly after first_source_idx
            if any(a == target for a in trace[first_source_idx + 1:]):
                traces_with_precedence += 1
    
    support = traces_with_precedence / total_traces if total_traces > 0 else 0.0
    confidence = traces_with_precedence / traces_with_source if traces_with_source > 0 else 0.0
    
    return support, confidence


def calculate_response_support_confidence(
    traces: Dict[str, List[str]], 
    source: str, 
    target: str
) -> Tuple[float, float]:
    """Calculate support and confidence for response constraint (source triggers target).
    
    Args:
        traces: Dictionary of object_id -> activity sequence
        source: Source activity (trigger)
        target: Target activity (response)
        
    Returns:
        Tuple of (support, confidence)
        - support: % of traces where source is followed by target
        - confidence: % of traces with source where target eventually follows
    """
    total_traces = len(traces)
    if total_traces == 0:
        return 0.0, 0.0
    
    traces_with_response = 0
    traces_with_source = 0
    
    for trace in traces.values():
        if source not in trace:
            continue

        traces_with_source += 1

        # Use the earliest occurrence of source; check if target follows any of them.
        # list.index() only finds the first — this is correct for response (we want
        # "does target eventually follow the first source occurrence"), but we make
        # the intent explicit for repeated-activity traces.
        first_source_idx = next(i for i, a in enumerate(trace) if a == source)
        if any(a == target for a in trace[first_source_idx + 1:]):
            traces_with_response += 1
    
    support = traces_with_response / total_traces if total_traces > 0 else 0.0
    confidence = traces_with_response / traces_with_source if traces_with_source > 0 else 0.0
    
    return support, confidence


def discover_precedence_constraints(
    traces: Dict[str, List[str]],
    activities: List[str],
    object_type: str,
    min_support: float = 0.7,
    min_confidence: float = 0.85
) -> List[Dict[str, Any]]:
    """Discover precedence constraints (A must happen before B).
    
    Args:
        traces: Object traces for specific object type
        activities: List of all activities
        object_type: Object type these constraints apply to
        min_support: Minimum support threshold
        min_confidence: Minimum confidence threshold
        
    Returns:
        List of discovered precedence constraints
    """
    constraints = []
    
    for source in activities:
        for target in activities:
            if source == target:
                continue
            
            support, confidence = calculate_precedence_support_confidence(traces, source, target)
            
            if support >= min_support and confidence >= min_confidence:
                constraints.append({
                    'type': 'precedence',
                    'constraint_type': 'precedence',
                    'source': source,
                    'target': target,
                    'source_activity': source,
                    'target_activity': target,
                    'nmin': 1,
                    'scope': {
                        'kind': 'each',
                        'object_type': object_type
                    },
                    'support': round(support, 3),
                    'confidence': round(confidence, 3)
                })
    
    return constraints


def discover_response_constraints(
    traces: Dict[str, List[str]],
    activities: List[str],
    object_type: str,
    min_support: float = 0.7,
    min_confidence: float = 0.85
) -> List[Dict[str, Any]]:
    """Discover response constraints (if A happens, B must eventually follow).
    
    Args:
        traces: Object traces for specific object type
        activities: List of all activities
        object_type: Object type these constraints apply to
        min_support: Minimum support threshold
        min_confidence: Minimum confidence threshold
        
    Returns:
        List of discovered response constraints
    """
    constraints = []
    
    for source in activities:
        for target in activities:
            if source == target:
                continue
            
            support, confidence = calculate_response_support_confidence(traces, source, target)
            
            if support >= min_support and confidence >= min_confidence:
                constraints.append({
                    'type': 'response',
                    'constraint_type': 'response',
                    'source': source,
                    'target': target,
                    'source_activity': source,
                    'target_activity': target,
                    'scope': {
                        'kind': 'each',
                        'object_type': object_type
                    },
                    'support': round(support, 3),
                    'confidence': round(confidence, 3)
                })
    
    return constraints


def calculate_not_coexistence_support_confidence(
    traces: Dict[str, List[str]],
    source: str,
    target: str
) -> Tuple[float, float]:
    """Calculate support/confidence for a not-coexistence (mutual exclusion) rule.

    ``not_coexistence(A, B)`` states that A and B never both occur within the
    same scope (object trace). The rule is *activated* whenever at least one of
    A or B occurs and *satisfied* whenever they do not both occur. It is a
    symmetric relation (``not_coexistence(A, B) == not_coexistence(B, A)``).

    Args:
        traces: Dictionary of object_id -> activity sequence
        source: First activity (A)
        target: Second activity (B)

    Returns:
        Tuple of (support, confidence)
        - support: fraction of all traces in which at least one of A or B occurs
          (i.e. how often the rule is relevant / activated). This filters out
          activity pairs that are simply too rare to be meaningful.
        - confidence: among those activated traces, the fraction in which A and B
          do NOT coexist. 1.0 means perfect mutual exclusion.
    """
    total_traces = len(traces)
    if total_traces == 0:
        return 0.0, 0.0

    traces_with_a = 0
    traces_with_b = 0
    traces_with_both = 0
    traces_with_either = 0

    for trace in traces.values():
        has_a = source in trace
        has_b = target in trace

        if has_a:
            traces_with_a += 1
        if has_b:
            traces_with_b += 1
        if has_a and has_b:
            traces_with_both += 1
        if has_a or has_b:
            traces_with_either += 1

    # Mutual exclusion is only meaningful when BOTH activities are individually
    # possible for this object type. If one of them never occurs, the apparent
    # "non-coexistence" is just absence of that activity, not a real exclusion.
    if traces_with_a == 0 or traces_with_b == 0:
        return 0.0, 0.0

    support = traces_with_either / total_traces
    confidence = (
        (traces_with_either - traces_with_both) / traces_with_either
        if traces_with_either > 0 else 0.0
    )

    return support, confidence


def discover_not_coexistence_constraints(
    traces: Dict[str, List[str]],
    activities: List[str],
    object_type: str,
    min_support: float = 0.7,
    min_confidence: float = 0.85
) -> List[Dict[str, Any]]:
    """Discover not-coexistence (mutually exclusive) constraints.

    A ``not_coexistence(A, B)`` constraint means activities A and B never occur
    together within the same scope object's history. Because the relation is
    symmetric, each unordered activity pair is reported at most once.

    Args:
        traces: Object traces for specific object type
        activities: List of all activities
        object_type: Object type these constraints apply to
        min_support: Minimum support threshold
        min_confidence: Minimum confidence threshold

    Returns:
        List of discovered not-coexistence constraints
    """
    constraints = []

    # Iterate over unordered pairs only (i < j) to avoid duplicate symmetric
    # constraints. The engine's not_coexistence check is direction-agnostic.
    for i, source in enumerate(activities):
        for target in activities[i + 1:]:
            if source == target:
                continue

            support, confidence = calculate_not_coexistence_support_confidence(
                traces, source, target
            )

            if support >= min_support and confidence >= min_confidence:
                constraints.append({
                    'type': 'not_coexistence',
                    'constraint_type': 'not_coexistence',
                    'source': source,
                    'target': target,
                    'source_activity': source,
                    'target_activity': target,
                    'scope': {
                        'kind': 'each',
                        'object_type': object_type
                    },
                    'support': round(support, 3),
                    'confidence': round(confidence, 3)
                })

    return constraints


def calculate_chain_precedence_support_confidence(
    traces: Dict[str, List[str]],
    source: str,
    target: str
) -> Tuple[float, float]:
    """Calculate support/confidence for a chain-precedence rule.

    ``chain_precedence(A, B)`` states that every B is *immediately* preceded by
    A within the same scope (object trace).  Unlike plain ``precedence`` (A
    somewhere before B), this is the directly-follows variant: the event right
    before B must be A.

    The rule is *activated* by every occurrence of B that has a predecessor
    (i.e. B is not the first event of the trace) and *satisfied* when that
    immediate predecessor is A.  We use the strict trace-level interpretation:
    a trace satisfies the rule only when *all* of its activating B's are
    immediately preceded by A.

    Args:
        traces: Dictionary of object_id -> activity sequence
        source: Activity that must directly precede the target (A)
        target: Activity whose immediate predecessor is constrained (B)

    Returns:
        Tuple of (support, confidence)
        - support: fraction of all traces that activate AND satisfy the rule
        - confidence: among activating traces, the fraction that satisfy it
    """
    total_traces = len(traces)
    if total_traces == 0:
        return 0.0, 0.0

    activated_traces = 0
    satisfied_traces = 0

    for trace in traces.values():
        has_activation = False
        all_ok = True
        for i, activity in enumerate(trace):
            # B is activating only when it has a predecessor (not first event).
            if activity == target and i > 0:
                has_activation = True
                if trace[i - 1] != source:
                    all_ok = False
        if has_activation:
            activated_traces += 1
            if all_ok:
                satisfied_traces += 1

    if activated_traces == 0:
        return 0.0, 0.0

    support = satisfied_traces / total_traces
    confidence = satisfied_traces / activated_traces
    return support, confidence


def calculate_chain_response_support_confidence(
    traces: Dict[str, List[str]],
    source: str,
    target: str
) -> Tuple[float, float]:
    """Calculate support/confidence for a chain-response rule.

    ``chain_response(A, B)`` states that every A is *immediately* followed by B
    within the same scope (object trace).  Unlike plain ``response`` (B
    eventually follows A), this is the directly-follows variant: the event right
    after A must be B.

    The rule is *activated* by every occurrence of A that has a successor (i.e.
    A is not the last event of the trace) and *satisfied* when that immediate
    successor is B.  We use the strict trace-level interpretation: a trace
    satisfies the rule only when *all* of its activating A's are immediately
    followed by B.

    Args:
        traces: Dictionary of object_id -> activity sequence
        source: Activity whose immediate successor is constrained (A)
        target: Activity that must directly follow the source (B)

    Returns:
        Tuple of (support, confidence)
        - support: fraction of all traces that activate AND satisfy the rule
        - confidence: among activating traces, the fraction that satisfy it
    """
    total_traces = len(traces)
    if total_traces == 0:
        return 0.0, 0.0

    activated_traces = 0
    satisfied_traces = 0

    for trace in traces.values():
        has_activation = False
        all_ok = True
        last_idx = len(trace) - 1
        for i, activity in enumerate(trace):
            # A is activating only when it has a successor (not last event).
            if activity == source and i < last_idx:
                has_activation = True
                if trace[i + 1] != target:
                    all_ok = False
        if has_activation:
            activated_traces += 1
            if all_ok:
                satisfied_traces += 1

    if activated_traces == 0:
        return 0.0, 0.0

    support = satisfied_traces / total_traces
    confidence = satisfied_traces / activated_traces
    return support, confidence


def discover_chain_precedence_constraints(
    traces: Dict[str, List[str]],
    activities: List[str],
    object_type: str,
    min_support: float = 0.7,
    min_confidence: float = 0.85
) -> List[Dict[str, Any]]:
    """Discover chain-precedence constraints (B is immediately preceded by A).

    Args:
        traces: Object traces for specific object type
        activities: List of all activities
        object_type: Object type these constraints apply to
        min_support: Minimum support threshold
        min_confidence: Minimum confidence threshold

    Returns:
        List of discovered chain-precedence constraints
    """
    constraints = []

    for source in activities:
        for target in activities:
            if source == target:
                continue

            support, confidence = calculate_chain_precedence_support_confidence(
                traces, source, target
            )

            if support >= min_support and confidence >= min_confidence:
                constraints.append({
                    'type': 'chain_precedence',
                    'constraint_type': 'chain_precedence',
                    'source': source,
                    'target': target,
                    'source_activity': source,
                    'target_activity': target,
                    'nmin': 1,
                    'scope': {
                        'kind': 'each',
                        'object_type': object_type
                    },
                    'support': round(support, 3),
                    'confidence': round(confidence, 3)
                })

    return constraints


def discover_chain_response_constraints(
    traces: Dict[str, List[str]],
    activities: List[str],
    object_type: str,
    min_support: float = 0.7,
    min_confidence: float = 0.85
) -> List[Dict[str, Any]]:
    """Discover chain-response constraints (A is immediately followed by B).

    Args:
        traces: Object traces for specific object type
        activities: List of all activities
        object_type: Object type these constraints apply to
        min_support: Minimum support threshold
        min_confidence: Minimum confidence threshold

    Returns:
        List of discovered chain-response constraints
    """
    constraints = []

    for source in activities:
        for target in activities:
            if source == target:
                continue

            support, confidence = calculate_chain_response_support_confidence(
                traces, source, target
            )

            if support >= min_support and confidence >= min_confidence:
                constraints.append({
                    'type': 'chain_response',
                    'constraint_type': 'chain_response',
                    'source': source,
                    'target': target,
                    'source_activity': source,
                    'target_activity': target,
                    'nmin': 1,
                    'scope': {
                        'kind': 'each',
                        'object_type': object_type
                    },
                    'support': round(support, 3),
                    'confidence': round(confidence, 3)
                })

    return constraints


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


def discover_resource_types(
    ocel_log: Dict[str, Any],
    resource_threshold: float = 2.0
) -> List[str]:
    """Classify object types as reusable resources.

    A type is classified as a resource if the average maximum per-activity
    reuse count per object instance exceeds ``resource_threshold``.

    "Per-activity reuse" = how many times a single object instance appears in
    the SAME activity. A Forklift firing Weigh 200 times scores 200.
    An applicant firing Interview Held exactly once scores 1 — not a resource.

    This correctly distinguishes shared infrastructure (Forklifts, Trucks) from
    case objects (applicants, orders) that each go through activities at most
    a small fixed number of times.

    Args:
        ocel_log: OCEL 2.0 log dictionary
        resource_threshold: Minimum average max-per-activity repetitions per
            instance. Default 2.0 — an object must repeat the same activity
            more than twice on average to be classified as a resource.

    Returns:
        List of resource object type names.
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

    resource_types = []
    for ot, scores in type_max_reuse.items():
        if scores and sum(scores) / len(scores) >= resource_threshold:
            resource_types.append(ot)

    return sorted(resource_types)
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
    min_support: float = 0.7,
    min_confidence: float = 0.85,
    noise_threshold: float = 0.15,
    lifecycle_threshold: float = 0.5,
    resource_threshold: float = 50.0,
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
        resource_threshold: Average events-per-instance above which an object
            type is classified as a reusable resource (e.g. Forklift, Truck).
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
        constraint_types = {
            'precedence': True,
            'response': True,
            'not_coexistence': False,
            'chain_precedence': False,
            'chain_response': False,
            'coexistence': False,
            'absence': False
        }
    if constraint_params is None:
        constraint_params = {}

    def _thresholds(ctype: str):
        """Return (support, adjusted_confidence) for a specific constraint type,
        falling back to global parameters when per-type values are absent."""
        p = constraint_params.get(ctype, {})
        sup  = p.get('minSupport',      min_support)
        conf = p.get('minConfidence',   min_confidence)
        noise = p.get('noiseThreshold', noise_threshold)
        return sup, max(conf - noise, 0.5)

    # Load event log
    ocel_log = load_ocel2(event_log_path)
    
    # Discover basic elements
    object_types = discover_object_types(ocel_log)
    activities = discover_activities(ocel_log)
    
    # Discover object bindings
    bindings_data = discover_object_bindings(ocel_log)
    
    # Discover constraints per object type
    all_constraints = []
    
    for obj_type in object_types:
        # Extract traces for this object type
        traces = extract_object_traces(ocel_log, obj_type)
        
        if not traces:
            continue
        
        # Discover lifecycle
        creating_acts, terminating_acts = discover_lifecycle(ocel_log, obj_type, lifecycle_threshold)
        
        # Update bindings with lifecycle info
        for activity in creating_acts:
            if activity in bindings_data and obj_type in bindings_data[activity]:
                bindings_data[activity][obj_type]['creates'] = True
        
        for activity in terminating_acts:
            if activity in bindings_data and obj_type in bindings_data[activity]:
                bindings_data[activity][obj_type]['deactivates'] = True
        
        # Discover precedence constraints
        if constraint_types.get('precedence', False):
            _sup, _conf = _thresholds('precedence')
            precedence = discover_precedence_constraints(
                traces, activities, obj_type, _sup, _conf
            )
            all_constraints.extend(precedence)
        
        # Discover response constraints
        if constraint_types.get('response', False):
            _sup, _conf = _thresholds('response')
            response = discover_response_constraints(
                traces, activities, obj_type, _sup, _conf
            )
            all_constraints.extend(response)

        # Discover not-coexistence (mutually exclusive) constraints
        if constraint_types.get('not_coexistence', False):
            _sup, _conf = _thresholds('not_coexistence')
            not_coexistence = discover_not_coexistence_constraints(
                traces, activities, obj_type, _sup, _conf
            )
            all_constraints.extend(not_coexistence)

        # Discover chain-precedence constraints (B immediately preceded by A)
        if constraint_types.get('chain_precedence', False):
            _sup, _conf = _thresholds('chain_precedence')
            chain_precedence = discover_chain_precedence_constraints(
                traces, activities, obj_type, _sup, _conf
            )
            all_constraints.extend(chain_precedence)

        # Discover chain-response constraints (A immediately followed by B)
        if constraint_types.get('chain_response', False):
            _sup, _conf = _thresholds('chain_response')
            chain_response = discover_chain_response_constraints(
                traces, activities, obj_type, _sup, _conf
            )
            all_constraints.extend(chain_response)
    
    # Discover O2O rules
    o2o_rules = discover_o2o_rules(ocel_log)

    # Classify resource object types (high events-per-instance ratio)
    resource_types = discover_resource_types(ocel_log, resource_threshold)

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
            'resource_threshold': resource_threshold,
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
