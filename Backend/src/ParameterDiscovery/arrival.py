"""Discover activity inter-arrival distributions from an OCEL."""
from typing import Any, Dict
from Backend.src.ParameterDiscovery.timediscovery import _event_times_by_activity


def discover_interarrival_times(ocel_log: Dict[str, Any]) -> Dict[str, Any]:
    """Inter-arrival time distribution per activity, measured from the log.

    Returns the gaps between consecutive occurrences of each activity, in the
    same shape as activity_durations so the existing sampler can be reused.

    This is what paces activities that have no input object bindings. Without
    it such an activity is offered exactly one candidate per simulation step
    and fires on essentially every step, which makes "one per step" the de
    facto arrival rate — an artifact of the step structure rather than anything
    measured. On container_logistics that is why 'Collect Goods' reached ~70%
    of generated events against 29.8% in the log, and why Customer Orders
    accumulated in the thousands.

    A simulation parameter, not part of OC-Declare: never written into the
    model file, merged at simulation setup.

    Returns:
        {activity: {dist_type, mean_seconds, std_seconds, min_seconds,
                    max_seconds, sample_count}} for activities with >= 2
        occurrences (a single occurrence yields no gap to measure).
    """
    if isinstance(ocel_log, list):
        return {}
    by_act = _event_times_by_activity(ocel_log)
    out: Dict[str, Any] = {}
    for act, times in by_act.items():
        if len(times) < 2:
            continue
        gaps = [(times[i] - times[i - 1]).total_seconds() for i in range(1, len(times))]
        gaps = [g for g in gaps if g >= 0]
        if not gaps:
            continue
        n = len(gaps)
        mean = sum(gaps) / n
        var = sum((g - mean) ** 2 for g in gaps) / n if n > 1 else 0.0
        out[act] = {
            'dist_type':    'exponential' if mean > 0 else 'fixed',
            'mean_seconds': mean,
            'std_seconds':  var ** 0.5,
            'min_seconds':  min(gaps),
            'max_seconds':  max(gaps),
            'sample_count': n,
        }
    return out

