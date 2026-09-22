"""Discover activity availability calendar parameters from an OCEL."""
from collections import defaultdict
from typing import Any, Dict, Set
from Backend.src.ParameterDiscovery.timediscovery import _event_times_by_activity


def discover_activity_calendars(
    ocel_log: Dict[str, Any],
    min_events_for_own_calendar: int = 500,   # kept for signature compatibility
) -> Dict[str, Any]:
    """Discover a probabilistic weekly availability calendar from the event log.

    Follows the probabilistic-calendar approach of Lopez-Pintado & Dumas (ICPM
    2023), used by SIMOD's resource-model stage: each weekly slot carries the
    probability that work may start in it, rather than a crisp on/off boundary
    that misfits both tails of a ramp (this log: 05:00 5.3%, 07:00 13.3%,
    17:00 1.1%, 99.5% weekdays).

    ESTIMATOR — availability, not demand. For each of the 168 weekly slots the
    probability is the fraction of WEEKS in which any activity occurred in it.
    Two earlier estimators were measured and rejected:

      * per activity, normalised by that activity's busiest slot — measures how
        *busy* a slot is, not whether work is possible in it. Used as a gate it
        multiplies throughput by the mean probability: it refused 110,962 of
        119,024 candidates (93%); 'Load Truck' was offered 66,374 times and
        started 35.
      * per activity, fraction of weeks used — still confounded. 'Register
        Customer Order' fires ~9 times a week across 70 slots, so a slot-week is
        empty 87% of the time because there was nothing to do, not because the
        process was closed. Mean availability 0.130.

    Pooling all activities removes the confound: a slot is available if ANY work
    happened in it. Measured here: 0.800 mean availability weekdays 05:00-17:00,
    0.08 Saturday, 0.02 Sunday.

    DEVIATION FROM SIMOD: SIMOD derives one calendar per RESOURCE profile from
    that resource's own events. OCEL 2.0 events carry no resource attribute —
    container_logistics has none on any of its 35,372 events — so this is one
    process-level calendar. Per-activity calendars were tried and abandoned for
    the confound above: an activity's event times measure when it was *needed*;
    only a resource's full history measures when it was *available*.

    Returns:
        {'slots_per_week': 168, 'global': [168 floats], 'per_activity': {},
         'fallback_activities': [...], 'weeks_observed': int}
        per_activity is intentionally empty — every activity uses the pooled
        calendar through Simulator._calendar_for.
    """
    if isinstance(ocel_log, list):
        return {}
    by_act = _event_times_by_activity(ocel_log)
    if not by_act:
        return {}

    SLOTS = 7 * 24
    slot_weeks: Dict[int, Set] = defaultdict(set)
    all_weeks: Set = set()
    for times in by_act.values():
        for t in times:
            iso = t.isocalendar()
            wk = (iso[0], iso[1])
            all_weeks.add(wk)
            slot_weeks[t.weekday() * 24 + t.hour].add(wk)

    if not all_weeks:
        return {}
    n_weeks = len(all_weeks)
    return {
        'slots_per_week': SLOTS,
        'global': [len(slot_weeks.get(s, ())) / n_weeks for s in range(SLOTS)],
        'per_activity': {},
        'fallback_activities': sorted(by_act.keys()),
        'weeks_observed': n_weeks,
    }

