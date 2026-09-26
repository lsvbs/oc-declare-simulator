"""Load OCEL files into the normalized event/object representation."""
import csv
import json
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List


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
    base_time = datetime(2024, 1, 1)
    
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
                # Roll synthetic minutes/seconds over instead of emitting invalid
                # ISO timestamps once there are more than 59 traces or events.
                'timestamp': (base_time + timedelta(
                    minutes=trace_idx, seconds=event_counter)).isoformat(),
                'omap': [obj_id]
            }
            event_counter += 1
    
    return {
        'events': events,
        'objects': objects
    }
