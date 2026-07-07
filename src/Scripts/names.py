import os
import sys
import json

# --- Print activities from OCDeclare example1 ---
from src.Simulation.Models.OCDeclare import import_first_ocdeclare_in_input

def print_ocdeclare_activities():
    static_model = import_first_ocdeclare_in_input(lifecycle_mode="simple_arcs")
    print("Activities from OCDeclare (example1):")
    for activity in static_model.activities:
        print(f"  - {activity.name}")

# --- Print activities from probabilitydiscovery event log ---
sys.path.append(os.path.join(os.path.dirname(__file__), '../..'))
from src.ParameterDiscovery.probabilitydiscovery import load_event_log

def print_eventlog_activities():
    event_log_path = os.path.join(os.path.dirname(__file__), '../Simulation/IO/input/eventlog/container_logistics.json')
    event_log_path = os.path.abspath(event_log_path)
    if not os.path.exists(event_log_path):
        print(f"Event log not found: {event_log_path}")
        return
    # Extract traces using probabilitydiscovery logic
    traces = load_event_log(event_log_path)
    # Flatten all activities in all traces
    activities = set()
    for trace in traces:
        for act in trace:
            activities.add(act)
    print("Activities from probabilitydiscovery event log (container_logistics.json):")
    for act in sorted(activities):
        print(f"  - {act}")
    print("\nExtracted traces (one per case object):")
    for i, trace in enumerate(traces, 1):
        print(f"  Trace {i}: {trace}")

if __name__ == "__main__":
    print_ocdeclare_activities()
    print()
    print_eventlog_activities()
