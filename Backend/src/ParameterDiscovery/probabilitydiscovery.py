import os
import json
from collections import defaultdict, Counter
from typing import Any, List, Dict, Optional

# Path to the event log directory (can be adjusted as needed)
EVENT_LOG_DIR = os.path.join(os.path.dirname(__file__), '../Simulation/IO/input/eventlog')


def _load_raw(filename: str):
    """Load a JSON, JSONOCEL, XML, or CSV event log file into a raw Python object.

    XML, CSV, and JSONOCEL files are converted to the normalised internal OCEL
    dict (events keyed by id, objects keyed by id).  JSON files are returned as-is.
    """
    from pathlib import Path
    suffix = Path(filename).suffix.lower()
    if suffix == '.xml':
        from Backend.src.Simulation.IO.input.ocel import load_ocel2_xml
        return load_ocel2_xml(filename)
    if suffix == '.csv':
        from Backend.src.Simulation.IO.input.ocel import load_ocel2_csv
        return load_ocel2_csv(filename)
    if suffix == '.jsonocel':
        from Backend.src.Simulation.IO.input.ocel import load_ocel2
        return load_ocel2(filename)
    with open(filename, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_event_log(
    filename: str,
    case_object_type: str = "Customer Order",
    mode: str = "global"
) -> List[List[str]]:
    """
    Loads an event log from a JSON or XML file.
    If the file is a list of traces, returns as-is.
    If the file is an OCEL 2.0 event log, extracts traces per case_object_type
    (mode="case") or a single global trace sorted by timestamp (mode="global").
    """
    data = _load_raw(filename)

    # Simple list-of-traces format — return as-is
    if isinstance(data, list) and all(isinstance(trace, list) for trace in data):
        return data

    # OCEL 2.0 format: events/objects may be a dict (keyed by id, our internal
    # normalised form) or a list (some raw JSON exports).
    if isinstance(data, dict) and "events" in data and "objects" in data:
        events_raw = data["events"]

        # Normalise to a list of (id, activity, timestamp) tuples regardless of
        # whether events_raw is a dict {id: {activity, timestamp, omap}} or a
        # list [{id, type/activity, time/timestamp, relationships}].
        if isinstance(events_raw, dict):
            event_tuples = [
                (eid, ev.get("activity", ""), ev.get("timestamp", ""))
                for eid, ev in events_raw.items()
            ]
            def event_omap(eid):
                return events_raw[eid].get("omap", [])
        else:
            event_tuples = [
                (
                    ev.get("id", ev.get("ocel:eid", "")),
                    ev.get("activity") or ev.get("type") or ev.get("ocel:activity", ""),
                    ev.get("timestamp") or ev.get("time") or ev.get("ocel:timestamp", ""),
                )
                for ev in events_raw
            ]
            _omap_index = {
                ev.get("id", ev.get("ocel:eid", "")): [
                    r.get("objectId") or r.get("ocel:oid")
                    for r in ev.get("relationships", ev.get("omap", []))
                    if isinstance(r, dict)
                ] if isinstance(ev.get("relationships", ev.get("omap", [])), list)
                  and ev.get("relationships", ev.get("omap", []))
                  and isinstance((ev.get("relationships") or ev.get("omap", []))[0], dict)
                else ev.get("omap", ev.get("relationships", []))
                for ev in events_raw
            }
            def event_omap(eid):
                return _omap_index.get(eid, [])

        if mode == "global":
            event_tuples.sort(key=lambda x: (x[2] is None, x[2] or ""))
            return [[activity for _, activity, _ in event_tuples]]

        elif mode == "case":
            objects_raw = data["objects"]
            # Normalise objects to {id: type}
            if isinstance(objects_raw, dict):
                obj_id_to_type = {oid: v.get("type", "") for oid, v in objects_raw.items()}
            else:
                obj_id_to_type = {
                    obj.get("id", obj.get("ocel:oid", "")): obj.get("type", obj.get("ocel:type", ""))
                    for obj in objects_raw
                }

            # Index events by the object ids they reference
            obj_events: Dict[str, list] = defaultdict(list)
            for eid, activity, ts in event_tuples:
                for oid in event_omap(eid):
                    if oid and obj_id_to_type.get(oid) == case_object_type:
                        obj_events[oid].append((activity, ts))

            traces = []
            for oid, evts in obj_events.items():
                evts.sort(key=lambda x: (x[1] is None, x[1] or ""))
                trace = [a for a, _ in evts]
                if trace:
                    traces.append(trace)
            return traces

        else:
            raise ValueError(f"Unknown mode: {mode}")

    raise ValueError("Unrecognized event log format: must be a list of traces or OCEL 2.0 event log.")


def discover_transition_matrix(event_log: List[List[str]]) -> Dict[str, Dict[str, float]]:
    """
    Discovers a transition probability matrix from a list of traces.
    Each trace is a list of activity names.
    Returns: {activity: {next_activity: probability, ...}, ...}
    """
    transitions = defaultdict(Counter)
    for trace in event_log:
        for a, b in zip(trace, trace[1:]):
            transitions[a][b] += 1
    # Normalize to probabilities
    prob_matrix = {}
    for a, counter in transitions.items():
        total = sum(counter.values())
        prob_matrix[a] = {b: count / total for b, count in counter.items()}
    return prob_matrix


def discover_transition_matrix_object_centric(ocel_log: dict) -> dict:
    """Build a transition probability matrix from per-object traces in an OCEL 2.0 log.

    For each object instance, extract the ordered sequence of activities it
    participated in (sorted by timestamp). Count A→B pairs within each object
    trace. The denominator for each activity includes both successor transitions
    AND trace endings (times the activity fired as the last event in a trace),
    so probabilities reflect the real chance of continuing vs. stopping.

    Returns a dict with:
      prob_matrix    – {activity: {next_activity: probability}}
                       probabilities sum to ≤ 1.0; the remainder is P(trace ends here)
      trace_end_prob – {activity: probability_of_ending_here}
      start_counts   – {activity: count_as_first_event_in_trace}
      end_counts     – {activity: count_as_last_event_in_trace}
      total_traces   – int, total number of object traces analysed
    """
    if not isinstance(ocel_log, dict):
        return {'prob_matrix': {}, 'trace_end_prob': {}, 'start_counts': {}, 'end_counts': {}, 'total_traces': 0}

    events_raw = ocel_log.get('events', {})
    objects_raw = ocel_log.get('objects', {})

    if isinstance(objects_raw, list):
        objects = {o.get('id', str(i)): o for i, o in enumerate(objects_raw)}
    else:
        objects = objects_raw

    if isinstance(events_raw, dict):
        events = []
        for eid, ev in events_raw.items():
            omap = ev.get('omap') or []
            if not omap:
                rels = ev.get('relationships') or []
                omap = [r.get('objectId', '') for r in rels if isinstance(r, dict)]
            events.append({
                'activity': ev.get('activity') or ev.get('type') or '',
                'timestamp': ev.get('timestamp') or ev.get('time') or '',
                'object_ids': omap,
            })
    else:
        events = []
        for ev in events_raw:
            rels = ev.get('relationships') or ev.get('omap') or []
            omap = [r.get('objectId', '') for r in rels] if rels and isinstance(rels[0], dict) else list(rels)
            events.append({
                'activity': ev.get('activity') or ev.get('type') or ev.get('ocel:activity') or '',
                'timestamp': ev.get('timestamp') or ev.get('time') or ev.get('ocel:timestamp') or '',
                'object_ids': omap,
            })

    # Build per-object event lists
    obj_events: Dict[str, list] = defaultdict(list)
    for ev in events:
        act = ev['activity']
        if not act:
            continue
        for oid in ev['object_ids']:
            if oid in objects:
                obj_events[oid].append((ev['timestamp'], act))

    # Count transitions and trace boundaries
    transitions: Dict[str, Counter] = defaultdict(Counter)
    total_fires: Counter = Counter()
    end_counts: Counter = Counter()
    start_counts: Counter = Counter()
    # Sum of normalised trace position (0=first, 1=last) for each activity
    pos_sums: Dict[str, float] = defaultdict(float)

    total_traces = 0
    for oid, evts in obj_events.items():
        evts.sort(key=lambda x: x[0])
        trace = [act for _, act in evts]
        if not trace:
            continue
        total_traces += 1
        start_counts[trace[0]] += 1
        end_counts[trace[-1]] += 1
        n = len(trace)
        for i, act in enumerate(trace):
            total_fires[act] += 1
            # Normalised position: 0 = first in trace, 1 = last
            pos_sums[act] += i / (n - 1) if n > 1 else 0.0
        for a, b in zip(trace, trace[1:]):
            if a != b:
                transitions[a][b] += 1

    # Build probability matrix with trace-ending in the denominator.
    prob_matrix: Dict[str, Dict[str, float]] = {}
    trace_end_prob: Dict[str, float] = {}

    all_activities = set(total_fires.keys())
    for act in all_activities:
        denom = total_fires[act]
        if not denom:
            continue
        out = transitions.get(act, Counter())
        prob_matrix[act] = {b: round(cnt / denom, 6) for b, cnt in out.items()}
        ep = round(end_counts.get(act, 0) / denom, 6)
        if ep > 0:
            trace_end_prob[act] = ep

    # Mean normalised trace position per activity (0 = always first, 1 = always last)
    trace_position: Dict[str, float] = {
        act: round(pos_sums[act] / total_fires[act], 4)
        for act in all_activities if total_fires[act]
    }

    return {
        'prob_matrix':     prob_matrix,
        'trace_end_prob':  trace_end_prob,
        'start_counts':    dict(start_counts),
        'end_counts':      dict(end_counts),
        'total_traces':    total_traces,
        'trace_position':  trace_position,
    }


def main():
    # List available event logs
    logs = [f for f in os.listdir(EVENT_LOG_DIR) if f.endswith('.json') or f.endswith('.xml')]
    if not logs:
        print(f"No event logs found in {EVENT_LOG_DIR}")
        return
    print("Available event logs:")
    for i, log in enumerate(logs):
        print(f"  [{i}] {log}")
    idx = input(f"Select log [0-{len(logs)-1}]: ")
    try:
        idx = int(idx)
        log_file = logs[idx]
    except (ValueError, IndexError):
        print("Invalid selection.")
        return
    log_path = os.path.join(EVENT_LOG_DIR, log_file)
    data = _load_raw(log_path)
    mode = "global"
    if isinstance(data, dict) and "objects" in data:
        print("Select trace extraction mode:")
        print("  [0] Global event-to-event (all events in timestamp order)")
        print("  [1] Per-case (object-centric, e.g., per 'Customer Order')")
        inp = input("Choose mode [0=global, 1=case, default: 0]: ")
        if inp.strip() == "1":
            mode = "case"
    case_object_type = "Customer Order"
    objects_raw = data.get("objects", {}) if isinstance(data, dict) else []
    if mode == "case" and objects_raw:
        if isinstance(objects_raw, dict):
            types = sorted(set(v.get("type", "") for v in objects_raw.values()))
        else:
            types = sorted(set(obj.get("type", "") for obj in objects_raw))
        print("Available object types in log:")
        for i, t in enumerate(types):
            print(f"  [{i}] {t}")
        inp = input(f"Select case object type for trace extraction [default: {case_object_type}]: ")
        if inp.strip():
            try:
                idx = int(inp)
                case_object_type = types[idx]
            except (ValueError, IndexError):
                case_object_type = inp.strip()
    event_log = load_event_log(log_path, case_object_type=case_object_type, mode=mode)
    matrix = discover_transition_matrix(event_log)
    out_path = os.path.join(EVENT_LOG_DIR, f"{os.path.splitext(log_file)[0]}_prob_matrix.json")
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(matrix, f, indent=2)
    print(f"Probability matrix written to {out_path}")


if __name__ == "__main__":
    main()


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

