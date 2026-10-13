"""Small activity/type summaries for the input/output comparison matrix."""
from collections import Counter, defaultdict


def summarize_participation(events, object_types):
    """Count events involving each type and objects per activity occurrence.

    ``events`` contains (activity, object IDs) pairs. An object is counted once
    per event; the cardinality mean includes events where the type is absent.
    """
    totals = Counter()
    counts = defaultdict(lambda: defaultdict(Counter))
    for activity, ids in events:
        if not activity:
            continue
        totals[activity] += 1
        per_type = Counter(object_types[oid] for oid in set(ids) if oid in object_types)
        for object_type, count in per_type.items():
            counts[activity][object_type]['events'] += 1
            counts[activity][object_type]['objects'] += count
    return {
        activity: {
            object_type: {'event_count': values['events'],
                          'mean_objects': values['objects'] / totals[activity]}
            for object_type, values in by_type.items()
        }
        for activity, by_type in counts.items()
    }


def summarize_ocel_participation(ocel):
    if not isinstance(ocel, dict):
        return {}
    objects = ocel.get('objects', {})
    items = objects.items() if isinstance(objects, dict) else ((o['id'], o) for o in objects)
    types = {oid: obj['type'] for oid, obj in items if obj.get('type')}
    events = ocel.get('events', {})
    rows = events.values() if isinstance(events, dict) else events
    return summarize_participation(
        ((event.get('activity') or event.get('type'),
          [r.get('objectId') if isinstance(r, dict) else r
           for r in (event.get('omap') or event.get('relationships') or [])])
         for event in rows), types)
