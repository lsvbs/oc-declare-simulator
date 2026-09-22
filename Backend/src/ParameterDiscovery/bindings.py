"""Discover activity-object participation cardinalities from event logs."""

from collections import defaultdict
from typing import Any, Dict


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

