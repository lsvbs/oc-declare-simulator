import os
import json
from collections import defaultdict
from typing import List, Dict, Tuple
from datetime import datetime, timedelta
import statistics

# Path to the event log directory (same as probabilitydiscovery.py)
# From ParameterDiscovery/, go up to src/, then to Simulation/IO/input/eventlog
EVENT_LOG_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'Simulation', 'IO', 'input', 'eventlog'))


def load_event_log_with_timestamps(
    filename: str,
    case_object_type: str = "Customer Order",
    mode: str = "global"
) -> List[List[Tuple[str, datetime]]]:
    """
    Loads an event log from a JSON file with timestamps.
    
    Args:
        filename: Path to the OCEL 2.0 event log JSON file
        case_object_type: Object type to use for case-based trace extraction
        mode: "global" for single trace of all events, "case" for per-object traces
    
    Returns:
        List of traces, where each trace is a list of (activity_name, timestamp) tuples
    """
    with open(filename, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Check if it's already a list of traces (without timestamps)
    if isinstance(data, list) and all(isinstance(trace, list) for trace in data):
        raise ValueError("Event log is a simple list of traces without timestamps. Use OCEL 2.0 format with 'time' field.")

    # Parse OCEL 2.0 format
    if isinstance(data, dict) and "events" in data and "objects" in data:
        if mode == "global":
            # Build a single trace: all events sorted by timestamp
            events = []
            for ev in data["events"]:
                timestamp_str = ev.get("time")
                if timestamp_str:
                    # Parse ISO 8601 timestamp
                    timestamp = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
                    events.append((ev["type"], timestamp))
            
            # Sort by timestamp
            events.sort(key=lambda x: x[1])
            return [events] if events else []
        
        elif mode == "case":
            # Build mapping from event id to (activity, timestamp, related object ids)
            event_data = {}
            for ev in data["events"]:
                timestamp_str = ev.get("time")
                if timestamp_str:
                    timestamp = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
                    event_data[ev["id"]] = {
                        "activity": ev["type"],
                        "timestamp": timestamp,
                        "object_ids": [rel["objectId"] for rel in ev.get("relationships", [])],
                    }
            
            # For each object of the case type, collect its events in timestamp order
            traces = []
            for obj in data["objects"]:
                if obj["type"] != case_object_type:
                    continue
                obj_id = obj["id"]
                
                # Find all events related to this object
                obj_events = [
                    (ev["activity"], ev["timestamp"])
                    for ev_id, ev in event_data.items()
                    if obj_id in ev["object_ids"]
                ]
                
                # Sort by timestamp
                obj_events.sort(key=lambda x: x[1])
                
                if obj_events:
                    traces.append(obj_events)
            
            return traces
        else:
            raise ValueError(f"Unknown mode: {mode}")

    raise ValueError("Unrecognized event log format: must be OCEL 2.0 event log with timestamps.")


def discover_temporal_transition_matrix(
    event_log_with_timestamps: List[List[Tuple[str, datetime]]]
) -> Dict[str, Dict[str, Dict]]:
    """
    Discovers a temporal transition matrix from traces with timestamps.
    
    Args:
        event_log_with_timestamps: List of traces, each trace is list of (activity, timestamp) tuples
    
    Returns:
        Dictionary structure:
        {
            "source_activity": {
                "target_activity": {
                    "count": int,
                    "time_deltas_seconds": [float, ...],  # all observed time differences in seconds
                    "mean_seconds": float,
                    "median_seconds": float,
                    "std_dev_seconds": float,
                    "min_seconds": float,
                    "max_seconds": float,
                    "percentile_25_seconds": float,
                    "percentile_75_seconds": float,
                },
                ...
            },
            ...
        }
    """
    # Collect all time deltas for each transition
    transition_deltas = defaultdict(lambda: defaultdict(list))
    
    for trace in event_log_with_timestamps:
        # Process consecutive pairs of events
        for i in range(len(trace) - 1):
            source_activity, source_time = trace[i]
            target_activity, target_time = trace[i + 1]
            
            # Calculate time delta in seconds
            time_delta = (target_time - source_time).total_seconds()
            
            # Store the time delta
            transition_deltas[source_activity][target_activity].append(time_delta)
    
    # Calculate statistics for each transition
    temporal_matrix = {}
    for source_activity, targets in transition_deltas.items():
        temporal_matrix[source_activity] = {}
        
        for target_activity, deltas in targets.items():
            if not deltas:
                continue
            
            # Calculate statistics
            stats = {
                "count": len(deltas),
                "time_deltas_seconds": deltas,  # Keep all samples for empirical distribution
                "mean_seconds": statistics.mean(deltas),
                "median_seconds": statistics.median(deltas),
                "min_seconds": min(deltas),
                "max_seconds": max(deltas),
            }
            
            # Add standard deviation if we have more than one sample
            if len(deltas) > 1:
                stats["std_dev_seconds"] = statistics.stdev(deltas)
            else:
                stats["std_dev_seconds"] = 0.0
            
            # Add percentiles if we have enough samples
            if len(deltas) >= 4:
                sorted_deltas = sorted(deltas)
                stats["percentile_25_seconds"] = statistics.quantiles(sorted_deltas, n=4)[0]
                stats["percentile_75_seconds"] = statistics.quantiles(sorted_deltas, n=4)[2]
            else:
                stats["percentile_25_seconds"] = stats["min_seconds"]
                stats["percentile_75_seconds"] = stats["max_seconds"]
            
            temporal_matrix[source_activity][target_activity] = stats
    
    return temporal_matrix


def format_temporal_matrix_for_json(temporal_matrix: Dict) -> Dict:
    """
    Formats the temporal matrix for JSON serialization by converting to human-readable format.
    Keeps seconds as primary format but adds human-readable fields.
    """
    formatted = {}
    
    for source_activity, targets in temporal_matrix.items():
        formatted[source_activity] = {}
        
        for target_activity, stats in targets.items():
            formatted_stats = {
                "count": stats["count"],
                "mean_seconds": round(stats["mean_seconds"], 2),
                "median_seconds": round(stats["median_seconds"], 2),
                "std_dev_seconds": round(stats["std_dev_seconds"], 2),
                "min_seconds": round(stats["min_seconds"], 2),
                "max_seconds": round(stats["max_seconds"], 2),
                "percentile_25_seconds": round(stats["percentile_25_seconds"], 2),
                "percentile_75_seconds": round(stats["percentile_75_seconds"], 2),
                # Add human-readable formatted times
                "mean_formatted": _format_seconds(stats["mean_seconds"]),
                "median_formatted": _format_seconds(stats["median_seconds"]),
                "std_dev_formatted": _format_seconds(stats["std_dev_seconds"]),
                "min_formatted": _format_seconds(stats["min_seconds"]),
                "max_formatted": _format_seconds(stats["max_seconds"]),
            }
            
            formatted[source_activity][target_activity] = formatted_stats
    
    return formatted


def _format_seconds(seconds: float) -> str:
    """Convert seconds to human-readable format (e.g., '2h 15m 30s')."""
    if seconds < 0:
        return "0s"
    
    days = int(seconds // 86400)
    seconds %= 86400
    hours = int(seconds // 3600)
    seconds %= 3600
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    
    parts = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0:
        parts.append(f"{hours}h")
    if minutes > 0:
        parts.append(f"{minutes}m")
    if secs > 0 or not parts:
        parts.append(f"{secs}s")
    
    return " ".join(parts)


def print_temporal_matrix_summary(temporal_matrix: Dict):
    """Print a summary of the temporal transition matrix."""
    print("\n" + "=" * 80)
    print("TEMPORAL TRANSITION MATRIX SUMMARY")
    print("=" * 80)
    
    total_transitions = sum(
        len(targets) for targets in temporal_matrix.values()
    )
    print(f"\nTotal unique transitions: {total_transitions}")
    print(f"Source activities: {len(temporal_matrix)}")
    
    print("\n" + "-" * 80)
    print("Sample transitions (showing first 10):")
    print("-" * 80)
    
    count = 0
    for source_activity, targets in sorted(temporal_matrix.items()):
        for target_activity, stats in sorted(targets.items()):
            if count >= 10:
                break
            print(f"\n{source_activity} → {target_activity}")
            print(f"  Count: {stats['count']} occurrences")
            print(f"  Mean: {_format_seconds(stats['mean_seconds'])} ({stats['mean_seconds']:.1f}s)")
            print(f"  Median: {_format_seconds(stats['median_seconds'])} ({stats['median_seconds']:.1f}s)")
            print(f"  Std Dev: {_format_seconds(stats['std_dev_seconds'])} ({stats['std_dev_seconds']:.1f}s)")
            print(f"  Range: {_format_seconds(stats['min_seconds'])} - {_format_seconds(stats['max_seconds'])}")
            count += 1
        if count >= 10:
            break
    
    if total_transitions > 10:
        print(f"\n... and {total_transitions - 10} more transitions")


def main():
    """Main entry point for temporal transition matrix discovery."""
    # List available event logs
    logs = [f for f in os.listdir(EVENT_LOG_DIR) if f.endswith('.json') and not f.endswith('_prob_matrix.json') and not f.endswith('_temporal_matrix.json')]
    if not logs:
        print(f"No event logs found in {EVENT_LOG_DIR}")
        return
    
    print("=" * 80)
    print("TEMPORAL TRANSITION MATRIX DISCOVERY")
    print("=" * 80)
    print("\nAvailable event logs:")
    for i, log in enumerate(logs):
        print(f"  [{i}] {log}")
    
    idx = input(f"\nSelect log [0-{len(logs)-1}]: ")
    try:
        idx = int(idx)
        log_file = logs[idx]
    except (ValueError, IndexError):
        print("Invalid selection.")
        return
    
    log_path = os.path.join(EVENT_LOG_DIR, log_file)
    
    # Ask for mode
    with open(log_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    mode = "global"
    if isinstance(data, dict) and "objects" in data:
        print("\nSelect trace extraction mode:")
        print("  [0] Global event-to-event (all events in timestamp order)")
        print("  [1] Per-case (object-centric, e.g., per 'Customer Order')")
        inp = input("Choose mode [0=global, 1=case, default: 0]: ")
        if inp.strip() == "1":
            mode = "case"
    
    case_object_type = "Customer Order"
    if mode == "case" and isinstance(data, dict) and "objects" in data:
        types = sorted(set(obj["type"] for obj in data["objects"]))
        print("\nAvailable object types in log:")
        for i, t in enumerate(types):
            print(f"  [{i}] {t}")
        inp = input(f"Select case object type for trace extraction [default: {case_object_type}]: ")
        if inp.strip():
            try:
                idx = int(inp)
                case_object_type = types[idx]
            except (ValueError, IndexError):
                case_object_type = inp.strip()
    
    print(f"\nLoading event log with timestamps...")
    event_log = load_event_log_with_timestamps(log_path, case_object_type=case_object_type, mode=mode)
    print(f"Loaded {len(event_log)} trace(s)")
    
    print(f"\nDiscovering temporal transition matrix...")
    temporal_matrix = discover_temporal_transition_matrix(event_log)
    
    # Print summary
    print_temporal_matrix_summary(temporal_matrix)
    
    # Format for JSON
    formatted_matrix = format_temporal_matrix_for_json(temporal_matrix)
    
    # Save to file
    out_path = os.path.join(EVENT_LOG_DIR, f"{os.path.splitext(log_file)[0]}_temporal_matrix.json")
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(formatted_matrix, f, indent=2)
    
    print(f"\n{'=' * 80}")
    print(f"Temporal matrix written to: {out_path}")
    print(f"{'=' * 80}\n")


if __name__ == "__main__":
    main()
