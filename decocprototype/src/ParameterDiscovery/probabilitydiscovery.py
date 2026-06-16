import os
import json
from collections import defaultdict, Counter
from typing import List, Dict

# Path to the event log directory (can be adjusted as needed)
EVENT_LOG_DIR = os.path.join(os.path.dirname(__file__), '../Simulation/IO/input/eventlog')


def _load_raw(filename: str):
    """Load a JSON or XML event log file into a raw Python object.

    For XML files delegates to load_ocel2_xml which returns the normalised
    internal dict (events keyed by id, objects keyed by id).  For JSON files
    returns whatever json.load produces.
    """
    from pathlib import Path
    if Path(filename).suffix.lower() == '.xml':
        from src.ParameterDiscovery.OCDeclarediscovery import load_ocel2_xml
        return load_ocel2_xml(filename)
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
