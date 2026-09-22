#!/usr/bin/env python3
"""
Flask backend server for Declarative OC Simulator Frontend.
Handles simulation orchestration and file management.
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import os
import re
import sys
import json
import statistics as _statistics
from pathlib import Path
from collections import Counter
import pickle
import tempfile

# Add project root to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from Backend.src.Simulation.Models.OCDeclare import (
    parse_ocdeclare_list,
    derive_provisional_lifecycle_from_list,
    apply_lifecycle_from_provisional_info,
)
from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.Domain.state import SimulationState
from Backend.src.Simulation.Engine.simulator import Simulator
from Backend.src.ParameterDiscovery.timediscovery import compute_ocpa_metrics
from Backend.src.ParameterDiscovery.probabilitydiscovery import discover_transition_matrix, load_event_log
from Backend.src.ParameterDiscovery.OCDeclarediscovery import discover_ocdeclare_model
from Backend.src.Simulation.IO.input.ocel import load_ocel2
from Backend.src.ParameterDiscovery.O2O import discover_o2o_rules
from Backend.src.ParameterDiscovery.concurrency import discover_activity_concurrency
from Backend.src.ParameterDiscovery.arrival import discover_interarrival_times
from Backend.src.ParameterDiscovery.calendar import discover_activity_calendars
from Backend.src.ParameterDiscovery.probabilitydiscovery import discover_object_transition_matrix
# Object-lifecycle discovery is a separate concern from Algorithm 1 and
# lives in its own module.
from Backend.src.ParameterDiscovery.lifecycle import discover_permanent_object_types, suggest_permanent_object_threshold, discover_creation_counts
from Backend.src.Simulation.Engine.selection import select_candidate
from Backend.src.Simulation.IO.output.OCEL2 import write_ocel2_json
from Backend.src.Simulation.IO.output.metrics import compute_metrics, write_metrics_json

app = Flask(__name__)
CORS(app)

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent
OCDECLARE_DIR = BASE_DIR / 'Backend' / 'src' / 'Simulation' / 'IO' / 'input' / 'ocdeclare'
EVENTLOG_DIR = BASE_DIR / 'Backend' / 'src' / 'Simulation' / 'IO' / 'input' / 'eventlog'
PARAMETERS_DIR = BASE_DIR / 'Backend' / 'src' / 'Simulation' / 'IO' / 'input' / 'parameters'
OUTPUT_DIR = BASE_DIR / 'Backend' / 'src' / 'Simulation' / 'IO' / 'output' / 'eventlogs'
METRICS_DIR = BASE_DIR / 'Backend' / 'metrics'
HISTORY_FILE = METRICS_DIR / 'run_history.json'
DISCOVERY_DIR = Path(tempfile.gettempdir()) / 'decocprototype_discovery'
DISCOVERY_DIR.mkdir(exist_ok=True)
PARAMETERS_DIR.mkdir(parents=True, exist_ok=True)
METRICS_DIR.mkdir(parents=True, exist_ok=True)

# Store discovery results in memory (keyed by event_log_file)
discovery_cache = {}


def _merge_pacing(model_data, event_log_file, time_distributions=None):
    """Attach simulation parameters measured from the OCEL to a loaded model.

    Concurrency ceilings, inter-arrival distributions, availability calendars,
    per-object transition probabilities and creation counts are all measured
    from the OCEL, never written into the OC-Declare model file, and merged
    here once the log and the model are both loaded — the same contract as
    activity_durations.

    creation_counts is how many NEW objects of each type one event of an
    activity actually brings into existence, as an empirical distribution
    (discover_creation_counts). build_candidate_for_activity samples it instead
    of assuming a creating binding always produces min_count objects.

    Concurrency bounds state.in_progress. Objects are created when an activity
    *starts*, so an activity that starts faster than it completes creates
    objects indefinitely. Inter-arrival pacing replaces "one candidate per
    simulation step" as the arrival rate for activities with no input bindings.

    Values already present on the model (e.g. set in the model editor) win.
    """
    if not isinstance(model_data, dict) or not event_log_file:
        return model_data
    need_conc = not model_data.get('activity_concurrency')
    need_iat = not model_data.get('interarrival_times')
    need_cal = not model_data.get('activity_calendars')
    need_otr = not model_data.get('object_transitions')
    need_cre = not model_data.get('creation_counts')
    if not need_conc and not need_iat and not need_cal and not need_otr and not need_cre:
        return model_data
    cache_entry = discovery_cache.setdefault(event_log_file, {})
    conc = cache_entry.get('activity_concurrency')
    iat = cache_entry.get('interarrival_times')
    cal = cache_entry.get('activity_calendars')
    otr = cache_entry.get('object_transitions')
    cre = cache_entry.get('creation_counts')
    if ((need_conc and conc is None) or (need_iat and iat is None)
            or (need_cal and cal is None) or (need_otr and otr is None)
            or (need_cre and cre is None)):
        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return model_data
        try:
            ocel = load_ocel2(str(log_path))
            if need_conc and conc is None:
                conc = discover_activity_concurrency(ocel, time_distributions or None)
                cache_entry['activity_concurrency'] = conc
            if need_iat and iat is None:
                iat = discover_interarrival_times(ocel)
                cache_entry['interarrival_times'] = iat
            if need_cal and cal is None:
                cal = discover_activity_calendars(ocel)
                cache_entry['activity_calendars'] = cal
            if need_otr and otr is None:
                otr = discover_object_transition_matrix(ocel)
                cache_entry['object_transitions'] = otr
            if need_cre and cre is None:
                cre = discover_creation_counts(ocel)
                cache_entry['creation_counts'] = cre
        except Exception:
            conc = conc or {}
            iat = iat or {}
            cal = cal or {}
            otr = otr or {}
            cre = cre or {}
    out = model_data
    if need_conc and conc:
        out = {**out, 'activity_concurrency': conc}
    if need_iat and iat:
        out = {**out, 'interarrival_times': iat}
    if need_cal and cal:
        out = {**out, 'activity_calendars': cal}
    if need_otr and otr:
        out = {**out, 'object_transitions': otr}
    if need_cre and cre:
        out = {**out, 'creation_counts': cre}
    return out

# Active simulation runs: run_id -> {state, stop_event, thread, done}
import threading
_active_runs: dict = {}
_discovery_runs: dict = {}  # run_id -> {done, phase, pct, result, error}


def _compute_avg_connected_trace_duration(state, resource_types) -> float | None:
    """Compute average trace duration across all completed connected-component traces.

    A trace starts when the first event fires on any object in the connected
    component and ends when the last event fires on any object in the component.
    Only traces where the root non-resource object is deactivated are counted.
    """
    from collections import deque
    resource_set = set(resource_types or [])

    # Build per-object event timestamps
    obj_timestamps = {}  # obj_id -> [timestamps]
    for ev in state.executed_events:
        if ev.timestamp is None:
            continue
        for oid in ev.object_ids:
            obj_timestamps.setdefault(oid, []).append(ev.timestamp)

    # Find deactivated non-resource objects as trace roots
    deactivated_roots = [
        oid for oid, obj in state.objects.items()
        if not obj.active and obj.object_type not in resource_set
    ]

    if not deactivated_roots:
        return None

    # BFS over _links_by_object to find connected component for each root
    # Only traverse non-resource objects to stay within the case boundary
    visited_global: set = set()
    durations = []

    for root in deactivated_roots:
        if root in visited_global:
            continue  # already part of another trace's component
        # BFS
        component: set = set()
        queue = deque([root])
        while queue:
            oid = queue.popleft()
            if oid in component:
                continue
            component.add(oid)
            for neighbor in state._links_by_object.get(oid, set()):
                obj = state.objects.get(neighbor)
                if obj and obj.object_type not in resource_set and neighbor not in component:
                    queue.append(neighbor)
        visited_global.update(component)

        # Collect all event timestamps for this component
        all_ts = []
        for oid in component:
            all_ts.extend(obj_timestamps.get(oid, []))
        if len(all_ts) >= 2:
            span = (max(all_ts) - min(all_ts)).total_seconds()
            durations.append(span)

    if not durations:
        return None
    return round(sum(durations) / len(durations), 1)


def _compute_case_tracker(state, start_activity_names: set, resource_types: set) -> dict:
    """Compute per-start-activity case statistics.

    A case is defined as one firing of a start activity plus all non-resource
    objects whose first event is that start event.  A case is complete when
    every one of those objects is inactive (deactivated).
    """
    resource_types = set(resource_types or [])

    # Index: oid -> event_id of the first event the object participates in
    obj_first_event: dict[str, str] = {}
    # Index: oid -> timestamp of the last event the object participates in
    obj_last_ts: dict[str, object] = {}
    # Index: oid -> list of (timestamp, activity, object_ids) in order
    obj_events: dict[str, list] = {}

    for event in state.executed_events:
        for oid in event.object_ids:
            if oid not in obj_first_event:
                obj_first_event[oid] = event.event_id
            obj_last_ts[oid] = event.timestamp
            obj_events.setdefault(oid, []).append(event)

    _CASE_DETAIL_CAP = 500  # max individual cases stored per start activity

    case_pools: dict[str, list] = {}

    for event in state.executed_events:
        if event.activity_name not in start_activity_names:
            continue

        # Objects created at this event: their first event is this event, non-resource
        created = [
            oid for oid in event.object_ids
            if obj_first_event.get(oid) == event.event_id
            and state.objects.get(oid) is not None
            and state.objects[oid].object_type not in resource_types
        ]

        completed = bool(created) and all(
            not state.objects[oid].active for oid in created
        )

        case_end_ts = None
        if created:
            lasts = [obj_last_ts[oid] for oid in created if obj_last_ts.get(oid) is not None]
            if lasts:
                case_end_ts = max(lasts)

        duration_s = None
        if event.timestamp is not None and case_end_ts is not None:
            duration_s = (case_end_ts - event.timestamp).total_seconds()
            if duration_s < 0:
                duration_s = None

        # Build ordered event sequence for this case (union of all spawned-object timelines)
        seen_eids: set = set()
        case_events: list = []
        for oid in created:
            for ev in obj_events.get(oid, []):
                if ev.event_id not in seen_eids:
                    seen_eids.add(ev.event_id)
                    case_events.append(ev)
        case_events.sort(key=lambda e: (e.timestamp is None, e.timestamp))

        def _iso(ts):
            return ts.isoformat() if ts is not None else None

        case_pools.setdefault(event.activity_name, []).append({
            'completed': completed,
            'duration_s': duration_s,
            'created_count': len(created),
            'start_ts': _iso(event.timestamp),
            'end_ts': _iso(case_end_ts),
            'events': [
                {
                    'activity': e.activity_name,
                    'timestamp': _iso(e.timestamp),
                    'object_ids': list(e.object_ids),
                }
                for e in case_events
            ],
        })

    result: dict[str, dict] = {}
    for act, cases in case_pools.items():
        total = len(cases)
        done = sum(1 for c in cases if c['completed'])
        durations = [c['duration_s'] for c in cases if c['duration_s'] is not None]
        result[act] = {
            'case_count': total,
            'completed': done,
            'completion_rate': round(done / total, 3) if total else 0,
            'mean_duration_s': round(_statistics.mean(durations), 1) if durations else None,
            'min_duration_s': round(min(durations), 1) if durations else None,
            'max_duration_s': round(max(durations), 1) if durations else None,
            'median_duration_s': round(_statistics.median(durations), 1) if durations else None,
            'cases': cases[:_CASE_DETAIL_CAP],
            'cases_capped': len(cases) > _CASE_DETAIL_CAP,
        }

    return result
    """Return the total time span of an OCEL log in seconds (last − first timestamp)."""
    if not ocel_source or not isinstance(ocel_source, dict):
        return None
    events_raw = ocel_source.get('events', {})
    events_list = list(events_raw.values()) if isinstance(events_raw, dict) else (events_raw or [])
    timestamps = []
    for e in events_list:
        ts = e.get('time') or e.get('timestamp') or e.get('ocel:timestamp')
        if ts:
            timestamps.append(str(ts))
    if len(timestamps) < 2:
        return None
    timestamps.sort()
    try:
        from datetime import datetime
        def _parse(s):
            for fmt in ('%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M:%S+00:00',
                        '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S'):
                try:
                    return datetime.strptime(s[:19], fmt[:len(s[:19])])
                except Exception:
                    pass
            return None
        t0 = _parse(timestamps[0])
        t1 = _parse(timestamps[-1])
        if t0 and t1:
            return round((t1 - t0).total_seconds(), 1)
    except Exception:
        pass
    return None


def _compute_ocel_time_range(ocel_source):
    """Return (first_iso, last_iso, span_s) for an OCEL log, or (None, None, None)."""
    if not ocel_source or not isinstance(ocel_source, dict):
        return None, None, None
    events_raw = ocel_source.get('events', {})
    events_list = list(events_raw.values()) if isinstance(events_raw, dict) else (events_raw or [])
    timestamps = []
    for e in events_list:
        ts = e.get('time') or e.get('timestamp') or e.get('ocel:timestamp')
        if ts:
            timestamps.append(str(ts))
    if len(timestamps) < 2:
        return None, None, None
    timestamps.sort()
    try:
        from datetime import datetime
        def _parse(s):
            for fmt in ('%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M:%S+00:00',
                        '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S'):
                try:
                    return datetime.strptime(s[:19], fmt[:len(s[:19])])
                except Exception:
                    pass
            return None
        t0 = _parse(timestamps[0])
        t1 = _parse(timestamps[-1])
        if t0 and t1:
            span = round((t1 - t0).total_seconds(), 1)
            return timestamps[0][:19], timestamps[-1][:19], span
    except Exception:
        pass
    return None, None, None


def _load_history() -> list:
    """Load run history from disk, or return empty list."""
    try:
        if HISTORY_FILE.exists():
            with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception:
        pass
    return []


def _save_history(history: list) -> None:
    try:
        with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
            json.dump(history[-200:], f, indent=2)  # cap at 200 entries
    except Exception:
        pass


@app.route('/api/files', methods=['GET'])
def get_available_files():
    """Return lists of available OC-Declare models and event logs."""
    try:
        ocdeclare_files = [
            f for f in os.listdir(OCDECLARE_DIR) 
            if f.endswith('.json')
        ] if OCDECLARE_DIR.exists() else []
        
        event_log_files = [
            f for f in os.listdir(EVENTLOG_DIR)
            if (f.endswith('.json') or f.endswith('.xml') or f.endswith('.csv') or f.endswith('.jsonocel')) and not f.endswith('_matrix.json')
        ] if EVENTLOG_DIR.exists() else []
        
        parameter_files = [
            f for f in os.listdir(PARAMETERS_DIR)
            if f.endswith('.json')
        ] if PARAMETERS_DIR.exists() else []

        return jsonify({
            'ocdeclare_files': sorted(ocdeclare_files),
            'event_log_files': sorted(event_log_files),
            'parameter_files': sorted(parameter_files)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/discover', methods=['POST'])
def run_discovery():
    """Run parameter discovery on event log."""
    try:
        data = request.json
        event_log_file = data.get('eventLogFile')
        
        if not event_log_file:
            return jsonify({'error': 'Missing event log file'}), 400
        
        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Event log file not found: {event_log_file}'}), 404
        
        # Load event log — trace-list format for probability discovery
        event_log = load_event_log(str(log_path))

        # Also load as OCEL 2.0 dict for per-object repeat stats (if the file
        # supports it — load_ocel2 handles both JSON and XML OCEL formats).
        try:
            event_log_ocel = load_ocel2(str(log_path))
        except Exception:
            event_log_ocel = None

        # Discover transition probabilities — use object-centric aggregation when
        # the log is OCEL 2.0 (eliminates spurious cross-case transitions and
        # includes trace-end probabilities in the denominator).
        from Backend.src.ParameterDiscovery.probabilitydiscovery import discover_transition_matrix_object_centric
        trace_end_prob = {}
        trace_position = {}
        start_counts = {}
        end_counts = {}
        total_traces = 0
        if event_log_ocel and isinstance(event_log_ocel, dict):
            oc_result = discover_transition_matrix_object_centric(event_log_ocel)
            prob_matrix    = oc_result['prob_matrix']
            trace_end_prob = oc_result['trace_end_prob']
            start_counts   = oc_result['start_counts']
            end_counts     = oc_result['end_counts']
            total_traces   = oc_result['total_traces']
            trace_position = oc_result.get('trace_position', {})
            # Fill in any activity seen globally but absent from object-centric matrix
            global_matrix = discover_transition_matrix(event_log)
            for act, tgts in global_matrix.items():
                if act not in prob_matrix:
                    prob_matrix[act] = tgts
        else:
            prob_matrix = discover_transition_matrix(event_log)

        # Time distributions discovery (optional, for future use)
        time_distributions = {}  # Placeholder for now

        # Extract activities from probability matrix
        activities = sorted(set(prob_matrix.keys()) | set(start_counts.keys()) | set(end_counts.keys()))

        # Derive likely start/end activity lists from object-centric counts
        # Start: activities that begin traces; top candidates sorted by count
        likely_start = sorted(start_counts, key=lambda a: -start_counts[a]) if start_counts else []
        # End: activities with high trace-end probability (> 0.3 of the time they fire = last)
        likely_end   = sorted(
            [a for a, p in trace_end_prob.items() if p >= 0.3],
            key=lambda a: -trace_end_prob[a]
        ) if trace_end_prob else []

        # Strict start activities: ≥95% of firings have NO preceding event on any
        # participating object — used for auto-selection on the landing page
        strict_start_activities = []
        _ocel_src = event_log_ocel if event_log_ocel and isinstance(event_log_ocel, dict) else None
        if _ocel_src:
            try:
                from collections import defaultdict as _dd2
                _evdict = _ocel_src.get('events', {})
                _evlist = list(_evdict.values()) if isinstance(_evdict, dict) else (_evdict or [])
                # Build per-object sorted timestamp list
                _obj_ts = _dd2(list)
                for _ev in _evlist:
                    _ts = _ev.get('timestamp') or _ev.get('time') or ''
                    for _oid in (_ev.get('omap') or []):
                        _obj_ts[_oid].append(_ts)
                for _oid in _obj_ts:
                    _obj_ts[_oid].sort()
                # Count firings with/without a preceding event on any object
                _act_no_prec = _dd2(int)
                _act_total   = _dd2(int)
                for _ev in _evlist:
                    _ts  = _ev.get('timestamp') or _ev.get('time') or ''
                    _act = _ev.get('activity') or _ev.get('type', '')
                    if not _act: continue
                    _objs = _ev.get('omap') or []
                    _has_prec = any(
                        any(t < _ts for t in _obj_ts.get(_oid, []))
                        for _oid in _objs
                    )
                    _act_total[_act] += 1
                    if not _has_prec:
                        _act_no_prec[_act] += 1
                strict_start_activities = sorted(
                    [a for a, tot in _act_total.items()
                     if tot > 0 and _act_no_prec[a] / tot >= 0.95],
                    key=lambda a: -_act_no_prec[a]
                )
            except Exception:
                pass  # fall back to empty — frontend will use likely_start

        # Find the first activity that actually appears in the log (chronologically)
        first_activity = None
        if isinstance(event_log, dict):
            events_list = event_log.get('events', {})
            if isinstance(events_list, dict):
                sorted_events = sorted(events_list.values(), key=lambda e: e.get('timestamp', ''))
                if sorted_events:
                    first_activity = sorted_events[0].get('activity')
            elif isinstance(events_list, list) and events_list:
                first_activity = events_list[0].get('activity') or events_list[0].get('ocel:activity')
        elif isinstance(event_log, list) and event_log and event_log[0]:
            first_activity = event_log[0][0]
        
        # Calculate statistics based on event log format
        # Basic counts from the trace-list format (always available)
        object_type_stats = {}  # {type: {count, attributes: [names]}}

        if isinstance(event_log, list):
            total_events = sum(len(trace) for trace in event_log)
            total_objects = 0
            activity_counts: dict = {}
            for trace in event_log:
                for act in trace:
                    if act:
                        activity_counts[act] = activity_counts.get(act, 0) + 1
        elif isinstance(event_log, dict):
            total_events = len(event_log.get('events', []))
            objects_raw = event_log.get('objects', {})
            objs_list = list(objects_raw.values()) if isinstance(objects_raw, dict) else (objects_raw or [])
            total_objects = len(objs_list)
            activity_counts = {}
            for edata in (event_log.get('events', {}).values() if isinstance(event_log.get('events'), dict) else event_log.get('events', [])):
                act = edata.get('activity') or edata.get('ocel:activity', '')
                if act:
                    activity_counts[act] = activity_counts.get(act, 0) + 1
        else:
            total_events = 0
            total_objects = 0
            activity_counts = {}

        # Build per-type object stats from the OCEL dict (event_log_ocel is always
        # the raw OCEL dict when available, regardless of load_event_log format).
        _ocel_src = event_log_ocel if event_log_ocel and isinstance(event_log_ocel, dict) \
                    else (event_log if isinstance(event_log, dict) else None)
        if _ocel_src:
            objects_raw = _ocel_src.get('objects', {})
            objs_list = list(objects_raw.values()) if isinstance(objects_raw, dict) else (objects_raw or [])
            if not total_objects:
                total_objects = len(objs_list)
            from collections import defaultdict as _dd
            _type_attrs: dict = _dd(set)
            _type_counts: dict = _dd(int)
            for obj in objs_list:
                ot = obj.get('type') or obj.get('ocel:type', '')
                if not ot:
                    continue
                _type_counts[ot] += 1
                for attr in (obj.get('attributes') or []):
                    name = attr.get('name') or attr.get('key', '') if isinstance(attr, dict) else str(attr)
                    if name:
                        _type_attrs[ot].add(name)
            object_type_stats = {
                ot: {'count': _type_counts[ot], 'attributes': sorted(_type_attrs[ot])}
                for ot in sorted(_type_counts)
            }

        # Per-activity repeat stats: requires OCEL 2.0 dict with omap per event.
        # Use event_log_ocel (loaded separately above) so this always works even
        # when load_event_log returns a trace list.
        activity_repeat_stats: dict = {}
        ocel_source = event_log_ocel if event_log_ocel else (event_log if isinstance(event_log, dict) else None)
        if ocel_source:
            ocel_events = ocel_source.get('events', {})
            events_list_raw = list(ocel_events.values() if isinstance(ocel_events, dict) else ocel_events)

            def _norm_act(edata):
                """Return activity name regardless of OCEL key variant."""
                return (edata.get('activity') or edata.get('ocel:activity') or
                        edata.get('type') or '')

            def _norm_omap(edata):
                """Return list of object-id strings regardless of OCEL format."""
                raw = edata.get('omap') or edata.get('ocel:omap') or edata.get('relationships') or []
                if raw and isinstance(raw[0], dict):
                    return [r.get('objectId') or r.get('ocel:oid', '') for r in raw if isinstance(r, dict)]
                return [str(x) for x in raw]

            def _norm_ts(edata):
                """Return timestamp string regardless of OCEL key variant."""
                return (edata.get('timestamp') or edata.get('ocel:timestamp') or
                        edata.get('time') or '')

            act_obj_counts: dict = {}
            for edata in events_list_raw:
                act = _norm_act(edata)
                if not act:
                    continue
                for oid in _norm_omap(edata):
                    if not oid:
                        continue
                    act_obj_counts.setdefault(act, {}).setdefault(oid, 0)
                    act_obj_counts[act][oid] += 1
            for act, obj_counts in act_obj_counts.items():
                counts_list = list(obj_counts.values())
                if counts_list:
                    activity_repeat_stats[act] = {
                        'min':  min(counts_list),
                        'max':  max(counts_list),
                        'mean': round(sum(counts_list) / len(counts_list), 2),
                    }

            # Per-object max reuse: for each object, find the activity that used it
            # the most times, then aggregate those per-object maxima by object type.
            # Requires the object→type map built earlier (_ocel_src).
            if _ocel_src and object_type_stats:
                objects_raw = _ocel_src.get('objects', {})
                objs_list_typed = list(objects_raw.values()) if isinstance(objects_raw, dict) else (objects_raw or [])
                _oid_to_type: dict = {}
                for obj in objs_list_typed:
                    oid_key = obj.get('id') or obj.get('ocel:id', '')
                    ot = obj.get('type') or obj.get('ocel:type', '')
                    if oid_key and ot:
                        _oid_to_type[oid_key] = ot

                # Transpose act_obj_counts to obj_act_counts: {oid: {act: count}}
                obj_act_counts: dict = {}
                for act, obj_counts in act_obj_counts.items():
                    for oid, cnt in obj_counts.items():
                        obj_act_counts.setdefault(oid, {})[act] = cnt

                # For each object: max reuse = highest count across all activities
                from collections import defaultdict as _dd2
                _type_max_reuse: dict = _dd2(list)
                for oid, act_counts in obj_act_counts.items():
                    ot = _oid_to_type.get(oid)
                    if not ot:
                        continue
                    _type_max_reuse[ot].append(max(act_counts.values()))

                for ot, max_reuse_list in _type_max_reuse.items():
                    if ot in object_type_stats and max_reuse_list:
                        object_type_stats[ot]['max_reuse'] = max(max_reuse_list)
                        object_type_stats[ot]['min_reuse'] = min(max_reuse_list)
                        object_type_stats[ot]['mean_max_reuse'] = round(
                            sum(max_reuse_list) / len(max_reuse_list), 2
                        )

        # Calculate transition statistics
        transition_count = sum(len(targets) for targets in prob_matrix.values())

        # Store in cache for later simulation use
        discovery_cache[event_log_file] = {
            'prob_matrix': prob_matrix,
            'time_distributions': time_distributions,
            'activities': activities,
            'activity_counts': activity_counts,
            'activity_repeat_stats': activity_repeat_stats,
            'start_counts': start_counts,
            'event_log': event_log,
            'event_log_ocel': event_log_ocel,  # OCEL dict for lifecycle derivation
        }

        return jsonify({
            'success': True,
            'results': {
                'activities': activities,
                'activity_counts': activity_counts,
                'activity_repeat_stats': activity_repeat_stats,
                # (activity_nmax_suggestions removed)
                'activity_count': len(activities),
                'total_events': total_events,
                'total_objects': total_objects,
                'object_type_stats': object_type_stats,
                'transition_count': transition_count,
                'time_distributions_discovered': len(time_distributions) > 0,
                'first_activity': first_activity,
                'likely_start_activities': likely_start,
                'strict_start_activities': strict_start_activities,
                'likely_end_activities':   likely_end,
                'trace_end_prob':          trace_end_prob,
                'trace_position':          trace_position,
                'prob_matrix': {
                    src: {tgt: round(float(cnt), 4) for tgt, cnt in tgts.items()}
                    for src, tgts in prob_matrix.items()
                },
            } | (lambda tr: {
                'ocel_time_span_s':        tr[2],
                'ocel_first_timestamp':    tr[0],
                'ocel_last_timestamp':     tr[1],
                'log_object_trace_count':  total_objects,
            })(_compute_ocel_time_range(ocel_source)),
            'logs': [
                f"Loaded event log: {event_log_file}",
                f"Discovered {len(activities)} unique activities",
                f"Analyzed {total_events} events",
                f"Discovered {transition_count} transitions",
                f"Time distributions: {'discovered' if time_distributions else 'not available'}"
            ]
        })
        
    except Exception as e:
        import traceback
        return jsonify({
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/activities', methods=['GET'])
def get_activities():
    """Get discovered activities from cached discovery results."""
    try:
        event_log_file = request.args.get('eventLogFile')
        
        if not event_log_file or event_log_file not in discovery_cache:
            return jsonify({'error': 'Discovery not run for this event log. Please run discovery first.'}), 400
        
        activities = discovery_cache[event_log_file]['activities']
        return jsonify({'activities': activities})
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/model-state', methods=['GET'])
def get_model_state():
    """Return the editable model dict + normalised probability matrix for a given model file.

    Query params:
      ocdeclareFile – filename in OCDECLARE_DIR (required)
      eventLogFile  – filename in EVENTLOG_DIR used to look up the discovery cache (optional)
    """
    try:
        ocdeclare_file = request.args.get('ocdeclareFile', '')
        event_log_file = request.args.get('eventLogFile', '')

        if not ocdeclare_file:
            return jsonify({'error': 'Missing ocdeclareFile parameter'}), 400

        model_path = OCDECLARE_DIR / ocdeclare_file
        if not model_path.exists():
            return jsonify({'error': f'Model file not found: {ocdeclare_file}'}), 404

        with open(model_path, 'r') as f:
            model_data = json.load(f)

        # External OC-Declare files are raw constraint lists (from/to/arc_type format).
        # Parse them into the same normalised dict the frontend Model Editor expects.
        if isinstance(model_data, list):
            from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_list
            static = parse_ocdeclare_list(model_data)
            model_data = {
                'object_types': [
                    {'name': ot.name, 'attributes': list(ot.attributes)}
                    for ot in static.object_types
                ],
                'activities': [
                    {
                        'name': a.name,
                        'bindings': [
                            {
                                'object_type': b.object_type,
                                'min_count': b.min_count,
                                'max_count': b.max_count,
                                'creates': b.creates,
                                'deactivates': b.deactivates,
                            }
                            for b in a.bindings
                        ],
                    }
                    for a in static.activities
                ],
                'constraints': [
                    {
                        'constraint_type': c.constraint_type,
                        'source_activity': c.source_activity,
                        'target_activity': c.target_activity,
                        'scope': {
                            'kind': c.scope.kind,
                            'object_type': c.scope.object_type,
                            'bindings': list(c.scope.bindings) if c.scope.bindings else [],
                        },
                        'nmin': c.nmin,
                        'nmax': c.nmax,
                    }
                    for c in static.constraints
                ],
                'o2o_rules': [
                    {
                        'source_type': r.source_type,
                        'target_type': r.target_type,
                        'min_links': r.min_links,
                        'max_links': r.max_links,
                        'bidirectional': r.bidirectional,
                    }
                    for r in static.o2o_rules
                ],
                'resource_types': list(static.resource_types or []),
                'resource_pool_sizes': dict(static.resource_pool_sizes or {}),
                'activity_durations': {},
            }

        prob_matrix_out = {}
        if event_log_file and event_log_file in discovery_cache:
            raw = discovery_cache[event_log_file]['prob_matrix']
            for src, targets in raw.items():
                total = sum(float(v) for v in targets.values())
                if total > 0:
                    prob_matrix_out[src] = {
                        tgt: round(float(cnt) / total, 4)
                        for tgt, cnt in targets.items()
                    }

        return jsonify({
            'success': True,
            'model': model_data,
            'probMatrix': prob_matrix_out,
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


def _safe_parameters_path(filename: str) -> "Path | None":
    """Resolve `filename` inside PARAMETERS_DIR, rejecting traversal attempts."""
    if not filename or not filename.endswith('.json'):
        return None
    candidate = (PARAMETERS_DIR / filename).resolve()
    try:
        candidate.relative_to(PARAMETERS_DIR.resolve())
    except ValueError:
        return None
    return candidate


@app.route('/api/parameters/<path:filename>', methods=['GET'])
def get_parameter_file(filename):
    """Load a saved parameter file from PARAMETERS_DIR.

    Returns the editor model dict plus any embedded `transition_matrix`
    (split out as `probMatrix`), matching the shape /api/model-state returns.
    """
    try:
        path = _safe_parameters_path(filename)
        if path is None:
            return jsonify({'error': 'Invalid filename'}), 400
        if not path.exists():
            return jsonify({'error': f'Parameter file not found: {filename}'}), 404

        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # Split the embedded transition matrix (if any) out of the model dict.
        prob_matrix = {}
        if isinstance(data, dict):
            prob_matrix = data.pop('transition_matrix', {}) or {}

        return jsonify({
            'success': True,
            'model': data,
            'probMatrix': prob_matrix,
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/save-parameters', methods=['POST'])
def save_parameter_file():
    """Persist the editor's current parameters into PARAMETERS_DIR.

    Body: { filename: str, params: dict }
    The filename is sanitised to its basename and forced into PARAMETERS_DIR.
    """
    try:
        data = request.json or {}
        filename = os.path.basename(data.get('filename', '') or '')
        params = data.get('params')

        if not filename.endswith('.json'):
            return jsonify({'error': 'filename must end with .json'}), 400
        if not isinstance(params, dict):
            return jsonify({'error': 'params must be an object'}), 400

        path = _safe_parameters_path(filename)
        if path is None:
            return jsonify({'error': 'Invalid filename'}), 400

        with open(path, 'w', encoding='utf-8') as f:
            json.dump(params, f, indent=2)

        return jsonify({'success': True, 'filename': filename})
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/simulate/status/<run_id>', methods=['GET'])
def simulation_status(run_id):
    run = _active_runs.get(run_id)
    if not run:
        return jsonify({'error': 'unknown run_id'}), 404
    state = run['state']
    resource_types = set(getattr(state, '_resource_types', set()) or set()) if state else set()
    completed_traces = getattr(state, 'completed_trace_count', 0) if state else 0
    last_ts = None
    if state and state.last_generated_timestamp:
        try:
            last_ts = state.last_generated_timestamp.isoformat()
        except Exception:
            pass
    start_ts = run.get('start_timestamp')
    # Active objects: sum of _active_by_type set sizes (O(types) not O(objects))
    active_objects = sum(len(s) for s in state._active_by_type.values()) if state else 0
    # Pending obligations (number of distinct (target, scope) pairs)
    total_obligations = len(state._obligations_count) if state else 0
    # Cumulative deactivation and fulfillment counters
    total_deactivations = getattr(state, 'total_deactivations', 0) if state else 0
    total_oblig_fulfilled = getattr(state, 'total_obligations_fulfilled', 0) if state else 0
    total_oblig_cancelled = getattr(state, 'total_obligations_cancelled', 0) if state else 0
    return jsonify({
        'step_count':               state.step_count if state else 0,
        'events_count':             len(state.executed_events) if state else 0,
        'objects_count':            len(state.objects) if state else 0,
        'active_objects':           active_objects,
        'total_obligations':        total_obligations,
        'total_deactivations':      total_deactivations,
        'total_oblig_fulfilled':    total_oblig_fulfilled,
        'total_oblig_cancelled':    total_oblig_cancelled,
        'completed_traces':         completed_traces,
        'completed_cases':          getattr(state, '_start_event_count', 0) if state else 0,
        # Per-start-activity firing counts, so the tracker can show progress
        # against each activity's own cap. Mirrors _start_event_count_by_activity,
        # which Simulator._is_start_activity_blocked reads to enforce the cap.
        'start_counts_by_activity': dict(getattr(state, '_start_event_count_by_activity', {}) or {}) if state else {},
        'start_activity_caps':      run.get('start_activity_caps') or {},
        'last_timestamp':           last_ts,
        'start_timestamp':          start_ts,
        'done':                     run['done'],
    })


@app.route('/api/simulate/stop/<run_id>', methods=['POST'])
def simulation_stop(run_id):
    run = _active_runs.get(run_id)
    if not run:
        return jsonify({'error': 'unknown run_id'}), 404
    run['stop_event'].set()
    return jsonify({'ok': True})


@app.route('/api/simulate', methods=['POST'])
def run_simulation():
    """Run simulation with provided configuration using cached discovery results."""
    try:
        data = request.json

        # Extract configuration
        ocdeclare_file = data.get('ocdeclareFile')
        event_log_file = data.get('eventLogFile')
        run_id         = data.get('runId')          # optional: enables live status/stop
        max_steps = int(data.get('maxEvents') or data.get('maxSteps') or 10_000_000)
        print(f"[simulate] maxEvents received: {max_steps}", flush=True)
        # Time-based limit: simulated seconds to advance (None = use steps only)
        max_sim_time_s = data.get('maxSimTimeS')
        if max_sim_time_s is not None:
            try:
                max_sim_time_s = float(max_sim_time_s)
            except (TypeError, ValueError):
                max_sim_time_s = None
        max_traces = data.get('maxTraces')
        if max_traces is not None:
            try:
                max_traces = int(max_traces)
            except (TypeError, ValueError):
                max_traces = None
        max_cases = data.get('maxCases')
        if max_cases is not None:
            try:
                max_cases = int(max_cases)
            except (TypeError, ValueError):
                max_cases = None
        # Wall-clock budget in real seconds — how long you are willing to wait,
        # as opposed to every other limit here, which is about the model.
        max_runtime_s = data.get('maxRuntimeS')
        if max_runtime_s is not None:
            try:
                max_runtime_s = float(max_runtime_s)
                if max_runtime_s <= 0:
                    max_runtime_s = None
            except (TypeError, ValueError):
                max_runtime_s = None
        seed = int(data.get('seed', 42))
        # Accept either startActivities (list, new) or startActivity (string, legacy)
        start_activities = data.get('startActivities')
        if not start_activities:
            sa = data.get('startActivity')
            start_activities = [sa] if sa else []
        # Per-activity start caps: {activity_name: max_fires} — optional
        start_activity_caps = data.get('startActivityCaps') or {}
        if isinstance(start_activity_caps, dict):
            # Coerce values to int, drop null/empty
            start_activity_caps = {k: int(v) for k, v in start_activity_caps.items() if v not in (None, '', 0)}
        else:
            start_activity_caps = {}
        model_override = data.get('modelOverride')            # full edited model dict (optional)
        prob_matrix_override = data.get('probMatrixOverride') # normalised prob matrix (optional)

        if not start_activities:
            return jsonify({'error': 'Missing required configuration: startActivities'}), 400
        if not ocdeclare_file and not model_override:
            return jsonify({'error': 'Either ocdeclareFile or modelOverride is required'}), 400

        # Get cached discovery results if available; fall back to empty defaults
        # so the simulation can run with just a model override + prob matrix override.
        cached = {}
        if event_log_file and event_log_file in discovery_cache:
            cached = discovery_cache[event_log_file]
            prob_matrix = cached['prob_matrix']
            time_distributions = cached['time_distributions']
        else:
            prob_matrix = {}
            time_distributions = {}

        # Apply overrides supplied by the model editor
        if prob_matrix_override:
            prob_matrix = prob_matrix_override

        # Load model — use editor override when available, otherwise read from file
        if model_override:
            model_data = model_override
        else:
            model_path = OCDECLARE_DIR / ocdeclare_file
            if not model_path.exists():
                return jsonify({'error': f'Model file not found: {ocdeclare_file}'}), 404
            with open(model_path, 'r') as f:
                model_data = json.load(f)

        # Merge discovered time distributions into model_data
        if time_distributions and isinstance(model_data, dict):
            existing = model_data.get('activity_durations') or {}
            merged = {act: metrics for act, metrics in time_distributions.items()
                      if act not in existing}
            merged.update(existing)
            model_data = {**model_data, 'activity_durations': merged}

        # Concurrency ceilings + inter-arrival pacing, measured from the OCEL
        model_data = _merge_pacing(model_data, event_log_file, time_distributions)

        # Route to the correct parser based on file format:
        # - list  → hand-crafted arc-list format (Format 1)
        # - dict  → discovered structured format (Format 2)
        if isinstance(model_data, list):
            static_model = parse_ocdeclare_list(model_data)
            lifecycle_info = derive_provisional_lifecycle_from_list(model_data)
            static_model = apply_lifecycle_from_provisional_info(static_model, lifecycle_info)
        else:
            from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict
            static_model = parse_ocdeclare_dict(model_data)
        
        # Build simulation config
        start_policy = StartPolicy(
            start_activity_names=start_activities,
            max_case_starts=None,
            start_activity_caps=start_activity_caps,
        )
        
        config = SimulationConfig(
            max_steps=max_steps,
            max_sim_time_s=max_sim_time_s,
            max_traces=max_traces,
            max_cases=max_cases,
            max_runtime_s=max_runtime_s,
            seed=seed,
            start_policy=start_policy,
            anchor_object_types=[ot.name for ot in static_model.object_types]
        )
        
        # Create selection wrapper with probability matrix
        def select_with_matrix(candidates, state, static_model, config=None, rng=None, **kwargs):
            return select_candidate(
                candidates=candidates,
                state=state,
                static_model=static_model,
                config=config,
                rng=rng,
                transition_matrix=prob_matrix
            )

        # Objects are created by the loaded model, independently of its filename.
        initial_state = SimulationState()

        # Run simulation
        stop_event = threading.Event()
        simulator = Simulator(
            static_model,
            config,
            rng=None,
            select_func=select_with_matrix,
            stop_event=stop_event,
            transition_matrix=prob_matrix,
            start_counts=cached.get('start_counts', {}),
        )

        # Register run for live status/stop polling
        if run_id:
            _active_runs[run_id] = {
                'state': initial_state,
                'stop_event': stop_event,
                'done': False,
                'start_timestamp': config.start_timestamp.isoformat() if config.start_timestamp else None,
                # Echoed back on each status poll so the tracker can render
                # "fired / cap" without the frontend re-deriving it from config.
                'start_activity_caps': dict(start_activity_caps or {}),
            }

        result_holder = [None]
        def _run():
            result_holder[0] = simulator.run_des(state=initial_state)
            if run_id and run_id in _active_runs:
                _active_runs[run_id]['done'] = True

        import time as _time
        _sim_start = _time.time()
        t = threading.Thread(target=_run, daemon=True)
        t.start()
        t.join()  # Flask request stays open until done; frontend polls status in parallel
        _sim_runtime_s = round(_time.time() - _sim_start, 1)
        final_state = result_holder[0]

        # Clean up run registry
        if run_id:
            _active_runs.pop(run_id, None)

        # Generate results
        obj_types = Counter(obj.object_type for obj in final_state.objects.values())
        activity_sequence = [e.activity_name for e in final_state.executed_events]

        # Per-object traces — cap at 200 objects to keep the response small.
        # The full data is in the saved OCEL file; this subset is only used
        # for the DFG layout and object-tracer visualisation.
        _TRACE_CAP = 200
        object_traces: dict[str, list[str]] = {}
        for event in final_state.executed_events:
            for oid in event.object_ids:
                if oid in object_traces or len(object_traces) < _TRACE_CAP:
                    object_traces.setdefault(oid, []).append(event.activity_name)

        # #28: per-object lifecycle timelines for the Results view. Capped for
        # the same reason as object_traces — the full data lives on the state
        # and in the saved OCEL file. Objects with the most status changes are
        # kept first, since those are the interesting ones when diagnosing a run
        # (an object that only shows 'created' tells you nothing).
        _LIFECYCLE_CAP = 150
        _lc_sorted = sorted(
            final_state.objects.values(),
            key=lambda o: (-len(getattr(o, 'timestamps', []) or []), o.object_id),
        )
        object_lifecycles = [
            {
                'object_id': o.object_id,
                'object_type': o.object_type,
                'active': o.active,
                'entries': [
                    {
                        'timestamp': e.timestamp.isoformat() if e.timestamp else None,
                        'lastupdate': e.lastupdate,
                        'activity': e.activity,
                        'status': e.status,
                    }
                    for e in (getattr(o, 'timestamps', []) or [])
                ],
            }
            for o in _lc_sorted[:_LIFECYCLE_CAP]
        ]
        object_lifecycles_total = len(final_state.objects)

        # Object-type lookup: object_id → object_type
        object_types_map: dict[str, str] = {
            oid: obj.object_type
            for oid, obj in final_state.objects.items()
        }

        # Object-to-object links: directed source → target connections.
        # Used by the frontend "Object Tracer" to show, for each seed object,
        # which objects were linked to it (and transitively beyond).
        object_links: list[dict[str, str]] = [
            {'source': link.source_object_id, 'target': link.target_object_id}
            for link in final_state.links
        ]
        
        # Save output. The log is named after the event log it was simulated
        # from — "<input>_simulated_log_<date>_<time>.json" — so an output file
        # still says what it came from once it has been moved or shared.
        _stem = Path(event_log_file).stem if event_log_file else ''
        _stem = re.sub(r'[^A-Za-z0-9._-]+', '_', _stem).strip('_')
        _log_id = f'{_stem}_simulated_log' if _stem else 'log'
        output_file = write_ocel2_json(final_state, static_model=static_model, log_id=_log_id)
        output_filename = os.path.basename(output_file)

        # Compute and save timing metrics. Built from the log_id rather than by
        # string-replacing "log_" in the filename: the input log's own name is
        # now part of it, and a name such as "my_log_export" would have had the
        # wrong substring rewritten.
        metrics = compute_metrics(final_state)
        _metrics_id = f'{_stem}_simulated_metrics' if _stem else 'metrics'
        _metrics_filename = (
            output_filename.replace(f'{_log_id}_', f'{_metrics_id}_', 1)
            if output_filename.startswith(f'{_log_id}_')
            else f'{_metrics_id}_{output_filename}'
        )
        metrics_file = write_metrics_json(final_state, out_dir=METRICS_DIR, filename=_metrics_filename)
        metrics_filename = os.path.basename(metrics_file)

        # Compute object lifecycle and activity participation audits
        from Backend.src.Simulation.IO.output.metrics import compute_audit
        audit = compute_audit(final_state, static_model=static_model, prob_matrix=prob_matrix)

        # Persist run entry to history
        from datetime import datetime as _dt
        run_entry = {
            'id':             output_filename,   # unique — same as log filename
            'timestamp':      _dt.now().isoformat(),
            'event_log_file': event_log_file,
            'ocdeclare_file': ocdeclare_file or '(editor override)',
            'max_steps':      max_steps,
            'max_sim_time_s': max_sim_time_s,
            'seed':           seed,
            'start_activities': start_activities,
            'steps_executed': final_state.step_count,
            'events_count':   len(final_state.executed_events),
            'objects_count':  len(final_state.objects),
            'output_file':    output_filename,
            'metrics_file':   metrics_filename,
            'runtime_s':      _sim_runtime_s,
            # store config snapshot so re-run can replay it
            'model_override': model_override,
            'prob_matrix_override': prob_matrix_override,
        }
        history = _load_history()
        history.append(run_entry)
        _save_history(history)


        return jsonify({
            'success': True,
            'results': {
                'steps_executed': final_state.step_count,
                'events_count': len(final_state.executed_events),
                'objects_count': len(final_state.objects),
                'object_types': dict(obj_types),
                'activity_sequence': activity_sequence,
                'object_traces': object_traces,
                # object_types_map only for the capped trace objects (keeps response small)
                'object_types_map': {
                    oid: obj.object_type
                    for oid, obj in final_state.objects.items()
                    if oid in object_traces
                },
                'object_links': object_links,
                'object_lifecycles': object_lifecycles,
                'object_lifecycles_total': object_lifecycles_total,
                'output_file': output_filename,
                'metrics_file': metrics_filename,
                # metrics intentionally omitted from inline response — can be very large
                # (hundreds of MB for big runs). Use GET /api/run-history/{id}/metrics
                # to access the full data.
                'metrics': {
                    'activity_metrics': metrics.get('activity_metrics', {}),
                    'activity_service_by_type': metrics.get('activity_service_by_type', {}),
                    # object_metrics omitted — too large; available via metrics file download
                },
                'audit': audit,
                'resource_types': list(static_model.resource_types or []),
                'completed_traces': getattr(final_state, 'completed_trace_count', 0),
                'obligations_fulfilled': getattr(final_state, 'total_obligations_fulfilled', 0),
                'obligations_cancelled': getattr(final_state, 'total_obligations_cancelled', 0),
                'obligations_violated': getattr(final_state, 'total_obligations_violated', 0),
                # Per-constraint obligation stats (E3/S8): fulfillment rate per response constraint
                'constraint_obligation_stats': {
                    f"{k[0]}|{k[1]}→{k[2]}|{k[3]}": v
                    for k, v in (getattr(final_state, '_constraint_obligation_stats', None) or {}).items()
                },
                'sim_time_s': (
                    (final_state.last_generated_timestamp - config.start_timestamp).total_seconds()
                    if final_state.last_generated_timestamp else None
                ),
                # Connected-component trace duration: for each completed non-resource root object,
                # find all objects reachable via links, then measure first-to-last event timestamp.
                # Average across all completed traces gives avg_connected_trace_duration_s.
                'avg_connected_trace_duration_s': (lambda: _compute_avg_connected_trace_duration(
                    final_state, static_model.resource_types or set()
                ))(),
                # Aggregate trace lifetime: mean of (last_event - first_event) per non-resource object
                'avg_trace_lifetime_s': (lambda om: (
                    round(sum(v['lifetime_s'] for v in om.values() if v.get('lifetime_s') is not None) /
                          max(1, sum(1 for v in om.values() if v.get('lifetime_s') is not None)), 1)
                    if any(v.get('lifetime_s') is not None for v in om.values()) else None
                ))(metrics.get('object_metrics') or {}),
                # Aggregate avg wait time: execution-count-weighted mean of mean_wait_in_pool_s
                'avg_wait_s': (lambda am: (
                    round(sum((am[a].get('mean_wait_in_pool_s') or 0) * (am[a].get('execution_count') or 0) for a in am) /
                          max(1, sum(am[a].get('execution_count') or 0 for a in am)), 1)
                    if am else None
                ))(metrics.get('activity_metrics') or {}),
                # Parallelism: mean number of concurrently in-progress activities (sampled at each completion)
                'avg_parallelism': (lambda s: (
                    round(sum(s) / len(s), 2) if s else None
                ))(getattr(final_state, 'parallelism_samples', [])),
                # Case tracker: per start-activity case counts, completion rates and durations
                'case_tracker': _compute_case_tracker(
                    final_state,
                    start_activity_names=set(start_activities or []),
                    resource_types=static_model.resource_types or set(),
                ),
            },
            'logs': [
                f"Loaded model: {ocdeclare_file}",
                f"Using cached discovery from: {event_log_file}",
                f"Start activities: {', '.join(start_activities)}",
                f"Max steps: {max_steps}, Seed: {seed}",
                f"Simulation completed with {final_state.step_count} steps",
                f"Generated {len(final_state.executed_events)} events",
                f"Created {len(final_state.objects)} objects",
                f"Output saved to: {output_filename}"
            ],
        })
        
    except Exception as e:
        import traceback
        return jsonify({
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/download/<filename>', methods=['GET'])
def download_file(filename):
    """Download generated event log file."""
    try:
        file_path = OUTPUT_DIR / filename
        if not file_path.exists():
            return jsonify({'error': 'File not found'}), 404
        return send_file(file_path, mimetype='application/json', as_attachment=True, download_name=filename)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/download-ocdeclare/<filename>', methods=['GET'])
def download_ocdeclare_file(filename):
    """Download a saved OC-Declare model file from OCDECLARE_DIR."""
    try:
        safe = Path(filename).name  # prevent directory traversal
        file_path = OCDECLARE_DIR / safe
        if not file_path.exists():
            return jsonify({'error': 'File not found'}), 404
        return send_file(file_path, mimetype='application/json', as_attachment=True, download_name=safe)
    except Exception as e:
        return jsonify({'error': str(e)}), 500




@app.route('/api/run-history', methods=['GET'])
def get_run_history():
    """Return the persisted run history (newest first)."""
    history = _load_history()
    return jsonify({'runs': list(reversed(history))})


@app.route('/api/run-history/<run_id>/conformance', methods=['PATCH'])
def patch_run_conformance(run_id):
    """Persist conformance scores (fitness, precision) into the run history entry."""
    try:
        data = request.json or {}
        history = _load_history()
        for entry in history:
            if entry['id'] == run_id:
                entry['conformance'] = {
                    'fitness':             data.get('fitness'),
                    'constraint_fitness':  data.get('constraint_fitness'),
                    'precision':           data.get('precision'),
                }
                _save_history(history)
                return jsonify({'success': True})
        return jsonify({'error': 'Run not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/run-history/<run_id>/metrics', methods=['GET'])
def get_run_metrics(run_id):
    """Load the metrics JSON for a specific run."""
    history = _load_history()
    entry = next((e for e in history if e['id'] == run_id), None)
    if not entry:
        return jsonify({'error': 'Run not found'}), 404
    mf = entry.get('metrics_file')
    if not mf:
        return jsonify({'error': 'No metrics file for this run'}), 404
    path = METRICS_DIR / mf
    if not path.exists():
        return jsonify({'error': 'Metrics file missing from disk'}), 404
    # Return only activity_metrics (small) by default; object_metrics is huge
    # and is only needed for the Object Lifetimes panel.
    section = request.args.get('section', 'activity')
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if section == 'object':
        return jsonify({'object_metrics': data.get('object_metrics', {})})
    return jsonify({'activity_metrics': data.get('activity_metrics', {})})



@app.route('/api/run-history/<run_id>/events', methods=['GET'])
def get_run_events(run_id):
    """Return a lightweight event list from the output OCEL for conformance checking.

    Returns [{id, activity, object_ids, timestamp}] sorted by timestamp.
    """
    try:
        log_path = OUTPUT_DIR / run_id
        if not log_path.exists():
            return jsonify({'error': f'Output log not found: {run_id}'}), 404
        with open(log_path, 'r', encoding='utf-8') as f:
            ocel = json.load(f)
        events_raw = ocel.get('events', [])
        if isinstance(events_raw, dict):
            events_raw = list(events_raw.values())
        result = []
        for ev in events_raw:
            rels = ev.get('relationships', []) or []
            oids = [r['objectId'] for r in rels if r.get('objectId')]
            result.append({
                'id':         ev.get('id', ''),
                'activity':   ev.get('type', ''),
                'timestamp':  ev.get('time', ''),
                'object_ids': oids,
            })
        result.sort(key=lambda e: e['timestamp'])
        return jsonify({'events': result, 'count': len(result)})
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/run-history/<run_id>/ocpq', methods=['GET'])
def get_run_ocpq(run_id):
    """Compute OCPQ schema measures from an output OCEL log.

    For every ordered (source_activity, target_activity) pair that share at least
    one object, compute:
      support      - number of distinct (source_event_id, target_event_id) connections
      coverage     - fraction of source instances reaching ≥1 target
      selectivity  - 1 / avg targets per connected source  (high = discriminating)
      reach        - fraction of target instances reached by ≥1 source
      exclusivity  - 1 / avg sources per connected target  (high = exclusive)
      throughput   - mean seconds between source and target event (event-to-event)
      eq_class     - hash of the exact set of (src_oid, tgt_oid) connections
    """
    try:
        log_path = OUTPUT_DIR / run_id
        if not log_path.exists():
            return jsonify({'error': f'Output log not found: {run_id}'}), 404

        with open(log_path, 'r', encoding='utf-8') as f:
            ocel = json.load(f)

        events_raw = ocel.get('events', [])
        if isinstance(events_raw, dict):
            events_raw = list(events_raw.values())
        objects_raw = ocel.get('objects', [])
        if isinstance(objects_raw, dict):
            objects_raw = list(objects_raw.values())

        # Build object_type map
        obj_type: dict[str, str] = {o['id']: o.get('type', '') for o in objects_raw}

        # Parse events — keep only those with timestamps
        from datetime import datetime, timezone
        def parse_ts(s):
            if not s: return None
            try:
                return datetime.fromisoformat(s.replace('Z', '+00:00'))
            except Exception:
                return None

        events: list[dict] = []
        for ev in events_raw:
            ts = parse_ts(ev.get('time', ''))
            rels = ev.get('relationships', []) or []
            oids = [r['objectId'] for r in rels if r.get('objectId')]
            events.append({
                'id':       ev.get('id', ''),
                'activity': ev.get('type', ''),
                'ts':       ts,
                'oids':     set(oids),
            })
        events.sort(key=lambda e: (e['ts'] or datetime.min.replace(tzinfo=timezone.utc)))

        # Build per-object event sequence (ordered by timestamp)
        obj_events: dict[str, list[dict]] = {}
        for ev in events:
            for oid in ev['oids']:
                obj_events.setdefault(oid, []).append(ev)

        # For each object, generate consecutive (source, target) event pairs
        # A "schema" is (source_activity, target_activity)
        from collections import defaultdict
        import hashlib

        # schema -> list of {src_ev_id, tgt_ev_id, src_oid, delta_s}
        schema_connections: dict[tuple, list[dict]] = defaultdict(list)

        for oid, evs in obj_events.items():
            otype = obj_type.get(oid, '')
            for i in range(len(evs) - 1):
                src = evs[i]
                tgt = evs[i + 1]
                if src['activity'] == tgt['activity']:
                    continue
                schema = (src['activity'], tgt['activity'])
                delta_s = None
                if src['ts'] and tgt['ts']:
                    delta_s = (tgt['ts'] - src['ts']).total_seconds()
                schema_connections[schema].append({
                    'src_ev':   src['id'],
                    'tgt_ev':   tgt['id'],
                    'oid':      oid,
                    'otype':    otype,
                    'delta_s':  delta_s,
                })

        # Count total source / target instances per activity
        act_event_count: dict[str, int] = defaultdict(int)
        for ev in events:
            act_event_count[ev['activity']] += 1

        results = []
        for (src_act, tgt_act), conns in sorted(schema_connections.items()):
            # Support: distinct (src_ev, tgt_ev) pairs
            conn_pairs = set((c['src_ev'], c['tgt_ev']) for c in conns)
            support = len(conn_pairs)

            # Coverage: fraction of source instances that reach ≥1 target
            connected_srcs = set(c['src_ev'] for c in conns)
            total_src = act_event_count.get(src_act, 0)
            coverage = round(len(connected_srcs) / total_src, 4) if total_src else 0

            # Selectivity: 1 / avg targets per connected source
            src_to_tgts: dict[str, set] = defaultdict(set)
            for c in conns:
                src_to_tgts[c['src_ev']].add(c['tgt_ev'])
            avg_fan_out = sum(len(v) for v in src_to_tgts.values()) / len(src_to_tgts) if src_to_tgts else 0
            selectivity = round(1 / avg_fan_out, 4) if avg_fan_out else None

            # Reach: fraction of target instances reached
            connected_tgts = set(c['tgt_ev'] for c in conns)
            total_tgt = act_event_count.get(tgt_act, 0)
            reach = round(len(connected_tgts) / total_tgt, 4) if total_tgt else 0

            # Exclusivity: 1 / avg sources per connected target
            tgt_to_srcs: dict[str, set] = defaultdict(set)
            for c in conns:
                tgt_to_srcs[c['tgt_ev']].add(c['src_ev'])
            avg_fan_in = sum(len(v) for v in tgt_to_srcs.values()) / len(tgt_to_srcs) if tgt_to_srcs else 0
            exclusivity = round(1 / avg_fan_in, 4) if avg_fan_in else None

            # Throughput: mean delta_s
            deltas = [c['delta_s'] for c in conns if c['delta_s'] is not None]
            throughput_s = round(sum(deltas) / len(deltas), 1) if deltas else None

            # Eq class: hash of the exact (src_ev, tgt_ev) connection set
            pair_str = '|'.join(sorted(f'{s}>{t}' for s, t in conn_pairs))
            eq_class = hashlib.md5(pair_str.encode()).hexdigest()[:8]

            # Object type breakdown
            otype_counts: dict[str, int] = defaultdict(int)
            for c in conns:
                otype_counts[c['otype']] += 1

            results.append({
                'source_activity':  src_act,
                'target_activity':  tgt_act,
                'support':          support,
                'coverage':         coverage,
                'selectivity':      selectivity,
                'reach':            reach,
                'exclusivity':      exclusivity,
                'throughput_s':     throughput_s,
                'eq_class':         eq_class,
                'object_types':     dict(otype_counts),
            })

        # Sort by support desc
        results.sort(key=lambda r: -r['support'])

        return jsonify({'schemas': results, 'total': len(results)})

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/eventlog-events', methods=['GET'])
def get_eventlog_events():
    """Return a lightweight event list from an input OCEL log for conformance checking."""
    try:
        filename = request.args.get('file')
        if not filename:
            return jsonify({'error': 'Missing file parameter'}), 400
        log_path = EVENTLOG_DIR / filename
        if not log_path.exists():
            return jsonify({'error': f'Event log not found: {filename}'}), 404

        # load_ocel2 handles OCEL 1.0 (.jsonocel), OCEL 2.0 JSON, XML, and CSV
        ocel = load_ocel2(str(log_path))
        # After normalisation objects is always {oid: {type, attributes}}
        objects_dict = ocel.get('objects', {})
        obj_type_map = {oid: info.get('type', '') for oid, info in objects_dict.items()}
        # After normalisation events is always {eid: {activity, timestamp, omap}}
        events_dict = ocel.get('events', {})
        result = []
        for eid, ev in events_dict.items():
            result.append({
                'id': eid,
                'activity': ev.get('activity', ev.get('type', '')),
                'timestamp': ev.get('timestamp', ev.get('time', '')),
                'object_ids': ev.get('omap', []),
            })

        result.sort(key=lambda e: e.get('timestamp', ''))
        return jsonify({'events': result, 'count': len(result), 'object_types_map': obj_type_map})
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/discover-ocdeclare', methods=['POST'])
def run_ocdeclare_discovery():
    """Discover OC-Declare model asynchronously.

    Returns immediately with {run_id}.  Poll
    GET /api/discover-ocdeclare/status/<run_id> for {phase, pct, done, …}.
    """
    try:
        data = request.json
        event_log_file      = data.get('eventLogFile')
        noise_threshold     = float(data.get('noiseThreshold', 0.2))
        arc_types           = data.get('arcTypes', ['EF', 'EP', 'AS'])
        reduction           = data.get('reduction', 'Lossless')
        run_id              = data.get('runId') or str(__import__('uuid').uuid4())

        if not event_log_file:
            return jsonify({'error': 'Missing event log file'}), 400
        if not (0 <= noise_threshold <= 1):
            return jsonify({'error': 'noiseThreshold must be between 0 and 1'}), 400
        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Event log file not found: {event_log_file}'}), 404

        from datetime import datetime as _dt
        timestamp       = _dt.now().strftime('%Y%m%d_%H%M%S')
        log_basename    = Path(event_log_file).stem
        output_filename = f'discovered_{log_basename}_{timestamp}.json'

        entry = {'done': False, 'phase': 'Starting', 'pct': 0, 'result': None, 'error': None, 'logs': []}
        _discovery_runs[run_id] = entry

        def _run():
            from datetime import datetime as _dt2

            def _progress(phase, pct):
                entry['phase'] = phase
                entry['pct']   = pct

            def _log(msg):
                entry['logs'].append({'t': _dt2.now().strftime('%H:%M:%S'), 'msg': msg})

            try:
                result = discover_ocdeclare_model(
                    event_log_path=str(log_path),
                    noise_threshold=noise_threshold,
                    arc_types=arc_types,
                    reduction=reduction,
                    output_filename=output_filename,
                    output_dir=str(OCDECLARE_DIR),
                    progress_callback=_progress,
                    log_callback=_log,
                )
                entry['result'] = {
                    'success':  True,
                    'filename': output_filename,
                    'model':    result['model'],
                    'stats':    result['stats'],
                    'parameters': result['parameters'],
                    'start_activities_ranked': result.get('start_activities_ranked', []),
                }
            except Exception as exc:
                import traceback
                traceback.print_exc()
                entry['error'] = str(exc)
            finally:
                entry['done'] = True

        threading.Thread(target=_run, daemon=True).start()
        return jsonify({'run_id': run_id})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/discover-ocdeclare/status/<run_id>', methods=['GET'])
def ocdeclare_discovery_status(run_id):
    """Poll progress of an async OC-Declare discovery run."""
    entry = _discovery_runs.get(run_id)
    if not entry:
        return jsonify({'error': 'unknown run_id'}), 404
    resp = {
        'done':  entry['done'],
        'phase': entry['phase'],
        'pct':   entry['pct'],
        'logs':  list(entry.get('logs', [])),
    }
    if entry['done']:
        if entry['error']:
            resp['error'] = entry['error']
        else:
            resp.update(entry['result'] or {})
        # Clean up after delivering the result
        _discovery_runs.pop(run_id, None)
    return jsonify(resp)


@app.route('/api/constraint-health', methods=['POST'])
def constraint_health():
    """Run the constraint health check and return structured results.

    Accepts the same body as /api/simulate:
      eventLogFile, ocdeclareFile, modelOverride, startActivities, startActivity
    """
    try:
        import sys as _sys
        _sys.path.insert(0, str(BASE_DIR))
        from constraint_health_report import run_health_check

        data = request.json or {}
        ocdeclare_file  = data.get('ocdeclareFile')
        event_log_file  = data.get('eventLogFile')
        model_override  = data.get('modelOverride')
        start_activities = data.get('startActivities') or (
            [data['startActivity']] if data.get('startActivity') else []
        )

        if not start_activities:
            return jsonify({'error': 'Missing startActivities'}), 400
        if not ocdeclare_file and not model_override:
            return jsonify({'error': 'Either ocdeclareFile or modelOverride is required'}), 400

        # Build model dict
        if model_override:
            model_dict = model_override
        else:
            model_path = OCDECLARE_DIR / ocdeclare_file
            if not model_path.exists():
                return jsonify({'error': f'Model file not found: {ocdeclare_file}'}), 404
            with open(model_path) as f:
                model_dict = json.load(f)

        # Load event log from discovery cache or file
        event_log = None
        if event_log_file:
            if event_log_file in discovery_cache:
                pass  # cache doesn't store the raw log, load from file
            log_path = EVENTLOG_DIR / event_log_file
            if log_path.exists():
                try:
                    event_log = load_ocel2(str(log_path))
                except Exception:
                    pass

        result = run_health_check(
            model_dict=model_dict,
            start_activities=start_activities,
            event_log=event_log,
            steps=int(data.get('steps', 500)),
        )

        # ── Annotate exclusion_detail with lifecycle info ─────────────────────
        # For each blocked activity, the exclusion_detail entries tell us which
        # object type was missing. Enrich them with which activity creates that
        # type and which activity(ies) deactivate it, so the frontend can show
        # e.g. "no active Container (created by: Order Empty Containers,
        # deactivated by: Depart, Reschedule Container)".
        try:
            from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict, parse_ocdeclare_list
            if isinstance(model_dict, list):
                _sm = parse_ocdeclare_list(model_dict)
            else:
                _sm = parse_ocdeclare_dict(model_dict)

            _creators:     dict[str, list[str]] = {}
            _deactivators: dict[str, list[str]] = {}
            for _a in _sm.activities:
                for _b in _a.bindings:
                    if _b.creates:
                        _creators.setdefault(_b.object_type, []).append(_a.name)
                    if _b.deactivates:
                        _deactivators.setdefault(_b.object_type, []).append(_a.name)

            for _blocked in result.get('permanently_blocked', []):
                for _det in _blocked.get('exclusion_detail', []):
                    _ot = _det.get('binding_type', '')
                    _det['created_by']     = _creators.get(_ot, [])
                    _det['deactivated_by'] = _deactivators.get(_ot, [])
        except Exception:
            pass  # annotation is best-effort — never break the health check

        return jsonify({'success': True, **result})

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/pinpoint-blocking', methods=['POST'])
def pinpoint_blocking():
    """Iteratively identify which constraints are blocking activities by removing
    the top blocker each round and re-running the simulation."""
    try:
        import sys as _sys
        _sys.path.insert(0, str(BASE_DIR))
        from constraint_health_report import pinpoint_blocking_constraints

        data = request.json or {}
        model_override   = data.get('modelOverride')
        ocdeclare_file   = data.get('ocdeclareFile')
        start_activities = data.get('startActivities') or (
            [data['startActivity']] if data.get('startActivity') else []
        )
        steps     = int(data.get('steps', 200))
        max_rounds = int(data.get('maxRounds', 12))

        if not start_activities:
            return jsonify({'error': 'Missing startActivities'}), 400
        if not model_override and not ocdeclare_file:
            return jsonify({'error': 'Either ocdeclareFile or modelOverride is required'}), 400

        if model_override:
            model_dict = model_override
        else:
            model_path = OCDECLARE_DIR / ocdeclare_file
            if not model_path.exists():
                return jsonify({'error': f'Model file not found: {ocdeclare_file}'}), 404
            with open(model_path) as f:
                model_dict = json.load(f)

        result = pinpoint_blocking_constraints(
            model_dict=model_dict,
            start_activities=start_activities,
            steps=steps,
            max_rounds=max_rounds,
        )
        return jsonify({'success': True, **result})

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/dry-run-stats', methods=['POST'])
def dry_run_stats_endpoint():
    """Run a 500-step dry simulation and return pool/blocking statistics."""
    try:
        import sys as _sys
        _sys.path.insert(0, str(BASE_DIR))
        from constraint_health_report import dry_run_stats

        data = request.json or {}
        model_override   = data.get('modelOverride')
        ocdeclare_file   = data.get('ocdeclareFile')
        start_activities = data.get('startActivities') or (
            [data['startActivity']] if data.get('startActivity') else []
        )
        steps = int(data.get('steps', 500))

        if not start_activities:
            return jsonify({'error': 'Missing startActivities'}), 400
        if not model_override and not ocdeclare_file:
            return jsonify({'error': 'Either ocdeclareFile or modelOverride is required'}), 400

        if model_override:
            model_dict = model_override
        else:
            model_path = OCDECLARE_DIR / ocdeclare_file
            if not model_path.exists():
                return jsonify({'error': f'Model file not found: {ocdeclare_file}'}), 404
            with open(model_path) as f:
                model_dict = json.load(f)

        result = dry_run_stats(
            model_dict=model_dict,
            start_activities=start_activities,
            steps=steps,
        )
        return jsonify({'success': True, **result})

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/analyze-blocking', methods=['POST'])
def analyze_blocking():
    """Dry-run simulation + static obligation saturation check to find blocking constraints."""
    try:
        import sys as _sys
        _sys.path.insert(0, str(BASE_DIR))
        from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict, parse_ocdeclare_list
        from Backend.src.Simulation.Engine.simulator import Simulator
        from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
        from Backend.src.Simulation.Domain.state import SimulationState
        from datetime import datetime

        data = request.json or {}
        model_override   = data.get('modelOverride')
        ocdeclare_file   = data.get('ocdeclareFile')
        start_activities = data.get('startActivities') or []
        prob_matrix      = data.get('probMatrixOverride') or {}
        dry_run_steps    = int(data.get('steps', 300))
        seed             = int(data.get('seed', 42))

        if not start_activities:
            return jsonify({'error': 'Missing startActivities'}), 400

        # Load model
        if model_override:
            model_dict = model_override
        elif ocdeclare_file:
            mp = OCDECLARE_DIR / ocdeclare_file
            if not mp.exists():
                return jsonify({'error': f'Model file not found: {ocdeclare_file}'}), 404
            with open(mp) as f:
                model_dict = json.load(f)
        else:
            return jsonify({'error': 'modelOverride or ocdeclareFile required'}), 400

        if isinstance(model_dict, list):
            static_model = parse_ocdeclare_list(model_dict)
        else:
            static_model = parse_ocdeclare_dict(model_dict)

        # ── 1. Static obligation saturation check ────────────────────────────
        # For each response constraint, check whether the target activity can
        # realistically fire: it needs at least one binding that either creates
        # its own object, uses a resource, or has an object created by another activity.
        creators: dict[str, list[str]] = {}  # object_type -> [activity names that create it]
        for a in static_model.activities:
            for b in a.bindings:
                if b.creates:
                    creators.setdefault(b.object_type, []).append(a.name)

        resource_types = set(static_model.resource_types or [])
        saturated: list[dict] = []
        for c in static_model.constraints:
            if c.constraint_type not in ('response', 'chain_response'):
                continue
            tgt = c.target_activity
            tgt_act = next((a for a in static_model.activities if a.name == tgt), None)
            if not tgt_act:
                continue
            non_creating = [b for b in tgt_act.bindings
                            if not b.creates and b.object_type not in resource_types]
            unsatisfied = [b for b in non_creating
                           if b.object_type not in creators]
            if unsatisfied:
                saturated.append({
                    'constraint_type': c.constraint_type,
                    'source': getattr(c, 'source_activity', None) or getattr(c, 'source', '?'),
                    'target': tgt,
                    'reason': f"Target needs {', '.join(b.object_type for b in unsatisfied)} but no activity creates it",
                    'severity': 'high',
                })

        # ── 2. Dry-run with constraint rejection tracking ─────────────────────
        # Instrument: monkey-patch _generate_candidates_des to record rejections
        rejection_counts: dict[str, int] = {}
        blocking_pairs: dict[tuple, int] = {}  # (constraint_type, source, target) -> count

        original_gen = Simulator._generate_candidates_des

        def _instrumented_gen(self_s, state):
            candidates = original_gen(self_s, state)
            # Track which activities had candidates blocked by constraint checks
            # We compare activities in model vs activities in candidate pool
            pool_acts = {c.activity_name for c in candidates}
            for act in self_s.static_model.activities:
                if act.name not in pool_acts and state.objects:
                    rejection_counts[act.name] = rejection_counts.get(act.name, 0) + 1
            return candidates

        Simulator._generate_candidates_des = _instrumented_gen

        try:
            cfg = SimulationConfig(
                max_steps=dry_run_steps,
                seed=seed,
                start_policy=StartPolicy(start_activity_names=start_activities),
                start_timestamp=datetime(2025, 1, 1, 9, 0, 0),
            )
            sim = Simulator(static_model, cfg,
                            transition_matrix=prob_matrix,
                            start_counts={})
            sim.run_des(state=SimulationState())
        finally:
            Simulator._generate_candidates_des = original_gen

        # Build blocking list: activities that were absent from pool >20% of steps
        # and have response obligations pointing at them
        total_steps = max(dry_run_steps, 1)
        pressure_threshold = 0.15  # absent >15% of steps = potentially blocking

        # Map constraint targets
        response_targets = {
            (getattr(c, 'source_activity', None) or getattr(c, 'source', ''), c.target_activity): c.constraint_type
            for c in static_model.constraints
            if c.constraint_type in ('response', 'chain_response', 'precedence', 'chain_precedence')
        }

        blocking: list[dict] = []
        for act_name, blocked_steps in sorted(rejection_counts.items(), key=lambda x: -x[1]):
            pressure = blocked_steps / total_steps
            if pressure < pressure_threshold:
                continue
            # Find which constraints may be causing it
            related = [
                {'constraint_type': ctype, 'source': src, 'target': tgt}
                for (src, tgt), ctype in response_targets.items()
                if tgt == act_name or src == act_name
            ]
            blocking.append({
                'activity': act_name,
                'blocked_steps': blocked_steps,
                'pressure': round(pressure, 3),
                'severity': 'high' if pressure > 0.5 else 'medium',
                'related_constraints': related,
                'reason': 'dry-run',
            })

        # Add static saturation findings (avoid duplicates)
        seen_tgts = {b['activity'] for b in blocking}
        for s in saturated:
            if s['target'] not in seen_tgts:
                blocking.append({
                    'activity': s['target'],
                    'blocked_steps': None,
                    'pressure': None,
                    'severity': s['severity'],
                    'related_constraints': [{'constraint_type': s['constraint_type'],
                                             'source': s['source'], 'target': s['target']}],
                    'reason': 'static: ' + s['reason'],
                })

        return jsonify({'blocking': blocking, 'total_steps': total_steps})

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/analyze-pressure', methods=['POST'])
def analyze_pressure():
    """Iterative constraint pressure analysis.

    Runs a deeper instrumented dry-run than /api/analyze-blocking:
    - Classifies WHY each activity is absent from the candidate pool each step
    - Computes pressure scores weighted by firing deficit vs log expectation
    - Returns top blocking constraints ranked by score with suggestions
    """
    try:
        import sys as _sys
        _sys.path.insert(0, str(BASE_DIR))
        from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict, parse_ocdeclare_list
        from Backend.src.Simulation.Engine.simulator import Simulator
        from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
        from Backend.src.Simulation.Domain.state import SimulationState
        from collections import defaultdict
        from datetime import datetime

        data = request.json or {}
        model_override    = data.get('modelOverride')
        start_activities  = data.get('startActivities') or []
        prob_matrix       = data.get('probMatrixOverride') or {}
        dry_run_steps     = int(data.get('steps', 5000))
        seed              = int(data.get('seed', 42))
        activity_counts   = data.get('activityCounts') or {}     # from discoveryResults
        ocel_time_span_s  = data.get('ocelTimeSpanS') or None    # total log time span

        if not start_activities:
            return jsonify({'error': 'Missing startActivities'}), 400
        if not model_override:
            return jsonify({'error': 'modelOverride required'}), 400

        if isinstance(model_override, list):
            static_model = parse_ocdeclare_list(model_override)
        else:
            static_model = parse_ocdeclare_dict(model_override)

        resource_types = set(static_model.resource_types or [])

        # ── Phase 1: Expected rates from log ────────────────────────────────────
        log_total_events = sum(activity_counts.values()) or 1
        log_days = (ocel_time_span_s / 86400) if ocel_time_span_s and ocel_time_span_s > 0 else None

        expected_rate: dict[str, float] = {}  # firings per day from log
        for act, cnt in activity_counts.items():
            if log_days and log_days > 0:
                expected_rate[act] = cnt / log_days
            else:
                expected_rate[act] = cnt / log_total_events * 100  # fallback: per 100 events

        # Build per-activity primary binding type (first non-creating non-resource binding)
        primary_type: dict[str, str | None] = {}
        for a in static_model.activities:
            for b in a.bindings:
                if not b.creates and b.object_type not in resource_types:
                    primary_type[a.name] = b.object_type
                    break
            else:
                primary_type[a.name] = None

        # Build precedence constraints per target activity for reason classification
        prec_by_target: dict[str, list] = defaultdict(list)
        for c in static_model.constraints:
            if c.constraint_type in ('precedence', 'chain_precedence'):
                prec_by_target[c.target_activity].append(c)

        # ── Phase 2: Instrumented dry-run ───────────────────────────────────────
        # block_counts[act][reason] = steps blocked for that reason
        # reasons: 'no_objects', 'precedence', 'resource_busy', 'other'
        block_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        # blocking_constraint[act] = constraint key that most blocked it
        blocking_constraint: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        fired_counts: dict[str, int] = defaultdict(int)
        total_steps_run = [0]
        last_sim_time = [None]

        original_gen = Simulator._generate_candidates_des

        def _pressure_gen(self_s, state):
            candidates = original_gen(self_s, state)
            if not state.objects:
                return candidates
            pool_acts = {c.activity_name for c in candidates}
            total_steps_run[0] += 1
            last_sim_time[0] = state.current_time

            waiting_acts = {wc.candidate_activity_name for wc in state.waiting_queue}

            for act in self_s.static_model.activities:
                if act.name in pool_acts:
                    continue

                # Resource busy — activity is in waiting queue (passed semantic checks, failed resource)
                if act.name in waiting_acts:
                    block_counts[act.name]['resource_busy'] += 1
                    # Find which resource type is blocking
                    for wc in state.waiting_queue:
                        if wc.candidate_activity_name == act.name:
                            blocking_constraint[act.name][f'resource:{wc.blocked_resource_type}'] += 1
                            break
                    continue

                pt = primary_type.get(act.name)

                # No objects of required type
                if pt and not state._active_by_type.get(pt):
                    block_counts[act.name]['no_objects'] += 1
                    blocking_constraint[act.name]['no_objects'] += 1
                    continue

                # Precedence not met — check nmin for each precedence constraint
                prec_blocked = False
                for c in prec_by_target.get(act.name, []):
                    nmin = getattr(c, 'nmin', 1) or 1
                    if nmin <= 0:
                        continue
                    # Check at least one active object of the scope type is blocked by this
                    scope_type = getattr(c.scope, 'object_type', None) if c.scope else None
                    if scope_type:
                        active_ids = state._active_by_type.get(scope_type, set())
                        for oid in list(active_ids)[:8]:  # sample up to 8
                            src_events = state._events_by_act_obj.get((c.source_activity, oid))
                            src_count = len(src_events) if src_events else 0
                            if src_count < nmin:
                                prec_blocked = True
                                ckey = f'precedence:{c.source_activity}→{act.name}'
                                blocking_constraint[act.name][ckey] += 1
                                break
                    if prec_blocked:
                        break

                if prec_blocked:
                    block_counts[act.name]['precedence'] += 1
                    continue

                # All other constraint failures or missing bindings
                block_counts[act.name]['other'] += 1

            return candidates

        # Also track actual firing counts
        original_complete = Simulator._des_complete_activity

        def _tracking_complete(self_s, in_prog, state):
            fired_counts[in_prog.candidate_activity_name] += 1
            return original_complete(self_s, in_prog, state)

        Simulator._generate_candidates_des = _pressure_gen
        Simulator._des_complete_activity = _tracking_complete

        try:
            cfg = SimulationConfig(
                max_steps=dry_run_steps,
                seed=seed,
                start_policy=StartPolicy(start_activity_names=start_activities),
                start_timestamp=datetime(2025, 1, 1, 9, 0, 0),
            )
            sim = Simulator(static_model, cfg,
                            transition_matrix=prob_matrix,
                            start_counts={})
            sim.run_des(state=SimulationState())
        finally:
            Simulator._generate_candidates_des = original_gen
            Simulator._des_complete_activity = original_complete

        # ── Phase 3: Pressure and deficit scores ────────────────────────────────
        steps = max(total_steps_run[0], 1)

        # Compute simulated time span in days
        start_dt = datetime(2025, 1, 1, 9, 0, 0)
        end_dt = last_sim_time[0] or start_dt
        sim_days = max((end_dt - start_dt).total_seconds() / 86400, 1e-6)

        activity_rates: dict[str, dict] = {}
        for act in static_model.activities:
            name = act.name
            exp = expected_rate.get(name)
            actual = fired_counts.get(name, 0) / sim_days if sim_days > 0 else 0
            deficit = max(0.0, (exp - actual)) if exp is not None else 0.0
            activity_rates[name] = {
                'expected': round(exp, 3) if exp is not None else None,
                'actual': round(actual, 3),
                'deficit': round(deficit, 3),
                'fired': fired_counts.get(name, 0),
            }

        # ── Phase 4: Score each (activity, constraint) pair ─────────────────────
        scored: list[dict] = []
        seen: set[str] = set()

        for act_name, reason_counts in block_counts.items():
            total_blocked = sum(reason_counts.values())
            pressure = total_blocked / steps
            if pressure < 0.05:
                continue

            deficit = activity_rates.get(act_name, {}).get('deficit', 0.0)
            score = round(pressure * max(deficit, 0.1), 4)  # min weight 0.1 so low-deficit still surfaces

            # Find the dominant constraint key
            all_ckeys = blocking_constraint.get(act_name, {})
            top_ckey = max(all_ckeys, key=all_ckeys.get) if all_ckeys else None

            # Determine primary reason
            primary_reason = max(reason_counts, key=reason_counts.get)

            # Build constraint detail
            constraint_detail = None
            suggestion = None
            if top_ckey and top_ckey.startswith('precedence:'):
                parts = top_ckey[len('precedence:'):].split('→')
                src = parts[0] if len(parts) == 2 else ''
                c_obj = next((c for c in static_model.constraints
                              if c.constraint_type in ('precedence', 'chain_precedence')
                              and c.source_activity == src
                              and c.target_activity == act_name), None)
                nmin_val = getattr(c_obj, 'nmin', 1) if c_obj else 1
                nmax_val = getattr(c_obj, 'nmax', None) if c_obj else None
                constraint_detail = {
                    'constraint_type': c_obj.constraint_type if c_obj else 'precedence',
                    'source': src,
                    'target': act_name,
                    'nmin': nmin_val,
                    'nmax': nmax_val,
                }
                pct = round(reason_counts.get('precedence', 0) / steps * 100)
                if nmin_val >= 1 and pct > 60:
                    suggestion = f'"{src}" must precede "{act_name}" in {pct}% of steps — consider setting nmin=0 to make it optional, or check that "{src}" fires early enough'
                elif nmax_val is not None:
                    suggestion = f'nmax={nmax_val} cap on "{src}" may be hit before "{act_name}" can fire — consider raising nmax'
                else:
                    suggestion = f'Ensure "{src}" fires before "{act_name}" for each object'
            elif top_ckey and top_ckey.startswith('resource:'):
                rt = top_ckey[len('resource:'):]
                constraint_detail = {'constraint_type': 'resource', 'resource_type': rt}
                pct = round(reason_counts.get('resource_busy', 0) / steps * 100)
                suggestion = f'Resource "{rt}" is busy in {pct}% of steps — consider increasing the pool size for "{rt}"'
            elif top_ckey == 'no_objects':
                pt = primary_type.get(act_name)
                constraint_detail = {'constraint_type': 'no_objects', 'missing_type': pt}
                suggestion = f'No active objects of type "{pt}" — check that the activity creating "{pt}" fires early enough and that deactivation is not premature'
            else:
                constraint_detail = {'constraint_type': 'other'}
                suggestion = 'Activity is blocked by semantic constraints — check not_coexistence, nmax caps, or exclusive_choice constraints'

            key = f'{act_name}:{top_ckey}'
            if key not in seen:
                seen.add(key)
                scored.append({
                    'activity': act_name,
                    'pressure': round(pressure, 3),
                    'deficit': activity_rates.get(act_name, {}).get('deficit', 0.0),
                    'score': score,
                    'primary_reason': primary_reason,
                    'reason_breakdown': {k: round(v / steps, 3) for k, v in reason_counts.items()},
                    'blocking_constraint': constraint_detail,
                    'top_constraint_key': top_ckey,
                    'suggestion': suggestion,
                })

        # Sort by score descending, take top 10
        scored.sort(key=lambda x: -x['score'])
        top_blocking = scored[:10]

        # ── Phase 5: Cascade detection ───────────────────────────────────────────
        # For each high-deficit activity blocked by precedence, trace root blocker
        # (simple one-hop: find if the blocking source also has a deficit)
        for entry in top_blocking:
            cd = entry.get('blocking_constraint') or {}
            if cd.get('constraint_type') in ('precedence', 'chain_precedence'):
                src = cd.get('source', '')
                src_rates = activity_rates.get(src, {})
                if src_rates.get('deficit', 0) > 0:
                    entry['cascade_note'] = (
                        f'Root blocker may be "{src}" (also under-firing: '
                        f'{src_rates["actual"]:.1f}/day vs {src_rates["expected"]:.1f}/day expected)'
                    )

        return jsonify({
            'top_blocking': top_blocking,
            'total_steps': steps,
            'sim_days': round(sim_days, 2),
            'activity_rates': {k: v for k, v in activity_rates.items() if v['expected'] or v['fired']},
        })

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/discover-timing', methods=['POST'])
def discover_timing():
    """Compute OCPA time metrics from an OCEL log + optional anchor service times.

    Body JSON:
      eventLogFile      – filename in EVENTLOG_DIR (required)
      anchorActivities  – list of { name, mean_seconds, std_seconds, min_seconds, max_seconds }
                          (optional; without anchors, service/waiting times are estimated)

    Returns per-activity metrics dict and stores them in the discovery cache under
    the key 'time_distributions'.
    """
    try:
        data = request.json or {}
        event_log_file = data.get('eventLogFile')
        anchor_activities = data.get('anchorActivities', [])
        service_time_mode = data.get('serviceTimeMode', 'minimum')
        if not event_log_file:
            return jsonify({'error': 'Missing eventLogFile parameter'}), 400

        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Event log file not found: {event_log_file}'}), 404

        # Use the OCEL 2.0 loader (NOT load_event_log, which returns activity-name
        # traces). compute_ocpa_metrics needs the normalised dict with per-event
        # timestamps, activities and object maps.
        event_log = load_ocel2(str(log_path))
        metrics = compute_ocpa_metrics(event_log, anchor_activities, service_time_mode=service_time_mode)

        if event_log_file in discovery_cache:
            discovery_cache[event_log_file]['time_distributions'] = metrics

        return jsonify({
            'success': True,
            'metrics': metrics,
            'activity_count': len(metrics),
            'empty': len(metrics) == 0,
        })

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/discover-timing-output', methods=['POST'])
def discover_timing_output():
    """Run timing discovery on a simulation output OCEL log.

    Identical to /api/discover-timing but reads from OUTPUT_DIR instead of
    EVENTLOG_DIR so the same discovery algorithm can be applied to simulated logs.

    Body JSON:
      outputFile        – filename in OUTPUT_DIR (e.g. 'log_20260721_123456.json')
      serviceTimeMode   – 'minimum' | 'p25' | 'p50'  (default: 'minimum')
    """
    try:
        data = request.json or {}
        output_file = data.get('outputFile')
        service_time_mode = data.get('serviceTimeMode', 'minimum')
        if not output_file:
            return jsonify({'error': 'Missing outputFile parameter'}), 400

        log_path = OUTPUT_DIR / output_file
        if not log_path.exists():
            return jsonify({'error': f'Output log file not found: {output_file}'}), 404

        event_log = load_ocel2(str(log_path))
        metrics = compute_ocpa_metrics(event_log, [], service_time_mode=service_time_mode)

        return jsonify({
            'success': True,
            'metrics': metrics,
            'activity_count': len(metrics),
        })

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/derive-lifecycle', methods=['POST'])
def derive_lifecycle():
    """Derive creates/deactivates flags for an external OC-Declare file.

    Uses the OCEL event log (discover_lifecycle) when available — this is the
    accurate method. Falls back to the arc-direction heuristic
    (derive_provisional_lifecycle_from_list) when no OCEL is loaded.

    Body JSON:
      ocdeclareFile  – filename in OCDECLARE_DIR (required)
      eventLogFile   – filename in EVENTLOG_DIR (optional, uses OCEL-based discovery)
    """
    try:
        data = request.json or {}
        ocdeclare_file = data.get('ocdeclareFile', '')
        event_log_file = data.get('eventLogFile', '')

        if not ocdeclare_file:
            return jsonify({'error': 'Missing ocdeclareFile parameter'}), 400

        model_path = OCDECLARE_DIR / ocdeclare_file
        if not model_path.exists():
            return jsonify({'error': f'Model file not found: {ocdeclare_file}'}), 404

        with open(model_path, 'r') as f:
            raw = json.load(f)

        from Backend.src.Simulation.Models.OCDeclare import (
            parse_ocdeclare_list,
            parse_ocdeclare_dict,
            derive_provisional_lifecycle_from_list,
            apply_lifecycle_from_provisional_info,
        )

        # Support both arc-list (external) and discovered dict formats.
        # Dict files already have bindings — we re-derive lifecycle on top of them.
        if isinstance(raw, list):
            base_model = parse_ocdeclare_list(raw)
        else:
            base_model = parse_ocdeclare_dict(raw)
        method_used = 'arc_heuristic'


        ocel_log = None
        if event_log_file:
            # Prefer cached OCEL dict (avoids re-reading disk if Step 1 was run)
            if event_log_file in discovery_cache:
                ocel_log = discovery_cache[event_log_file].get('event_log_ocel')
            # Fall back to loading from disk
            if not (ocel_log and isinstance(ocel_log, dict) and 'objects' in ocel_log):
                log_path = EVENTLOG_DIR / event_log_file
                if log_path.exists():
                    try:
                        from Backend.src.Simulation.IO.input.ocel import load_ocel2
                        ocel_log = load_ocel2(str(log_path))
                    except Exception:
                        ocel_log = None

        if ocel_log and isinstance(ocel_log, dict) and 'objects' in ocel_log:
            from Backend.src.ParameterDiscovery.lifecycle import discover_lifecycle
            from Backend.src.ParameterDiscovery.bindings import discover_object_bindings
            from Backend.src.Simulation.Domain.ir import ObjectBinding
            from dataclasses import replace

            # Pure constraint exports have no simulation bindings. Derive them
            # here, with lifecycle parameters, without rewriting the source file.
            # Keep existing bindings (including user-set cardinalities) intact.
            discovered_bindings = discover_object_bindings(ocel_log)
            enriched_activities = []
            for activity in base_model.activities:
                bindings = list(activity.bindings)
                known_types = {b.object_type for b in bindings}
                for object_type, info in discovered_bindings.get(activity.name, {}).items():
                    if object_type not in known_types:
                        bindings.append(ObjectBinding(
                            object_type=object_type,
                            min_count=info["min_count"],
                            max_count=info["max_count"],
                        ))
                enriched_activities.append(replace(activity, bindings=bindings))
            base_model = replace(base_model, activities=enriched_activities)
            entry: dict = {}
            exit_: dict = {}
            objects_raw = ocel_log['objects']
            object_types = sorted({
                o.get('type', '')
                for o in (objects_raw.values() if isinstance(objects_raw, dict) else objects_raw)
                if o.get('type')
            })
            for ot in object_types:
                creating_acts, terminating_acts = discover_lifecycle(ocel_log, ot, lifecycle_threshold=0.5)
                if creating_acts:
                    entry[ot] = creating_acts
                if terminating_acts:
                    exit_[ot] = terminating_acts
            lifecycle_info = {'entry': entry, 'exit': exit_}
            method_used = 'ocel'
        else:
            # Fallback: arc-direction heuristic from the constraint file itself
            lifecycle_info = derive_provisional_lifecycle_from_list(raw)

        model_with_lc = apply_lifecycle_from_provisional_info(base_model, lifecycle_info)

        # Serialise to the same dict shape as /api/model-state
        model_data = {
            'object_types': [
                {'name': ot.name, 'attributes': list(ot.attributes)}
                for ot in model_with_lc.object_types
            ],
            'activities': [
                {
                    'name': a.name,
                    'bindings': [
                        {
                            'object_type': b.object_type,
                            'min_count': b.min_count,
                            'max_count': b.max_count,
                            'creates': b.creates,
                            'deactivates': b.deactivates,
                        }
                        for b in a.bindings
                    ],
                }
                for a in model_with_lc.activities
            ],
            'constraints': [
                {
                    'constraint_type': c.constraint_type,
                    'source_activity': c.source_activity,
                    'target_activity': c.target_activity,
                    'scope': {'kind': c.scope.kind, 'object_type': c.scope.object_type},
                    'nmin': c.nmin,
                    'nmax': c.nmax,
                }
                for c in model_with_lc.constraints
            ],
            'o2o_rules': [
                {
                    'source_type': r.source_type,
                    'target_type': r.target_type,
                    'min_links': r.min_links,
                    'max_links': r.max_links,
                    'bidirectional': r.bidirectional,
                }
                for r in model_with_lc.o2o_rules
            ],
            'resource_types': list(model_with_lc.resource_types or []),
            'resource_pool_sizes': dict(model_with_lc.resource_pool_sizes or {}),
            'activity_durations': {},
        }

        # Report what was inferred
        entry_info = lifecycle_info.get('entry', {})
        exit_info  = lifecycle_info.get('exit', {})
        summary = [f'Source: {"OCEL event log" if method_used == "ocel" else "arc-direction heuristic"}']
        for ot, acts in sorted(entry_info.items()):
            summary.append(f'{", ".join(sorted(acts))} → creates {ot}')
        for ot, acts in sorted(exit_info.items()):
            summary.append(f'{", ".join(sorted(acts))} → deactivates {ot}')

        return jsonify({
            'success': True,
            'model': model_data,
            'summary': summary,
            'method': method_used,
        })

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/discover-o2o', methods=['POST'])
def discover_o2o():
    """Discover O2O rules from an OCEL event log.

    Body JSON:
      eventLogFile – filename in EVENTLOG_DIR (required)

    Returns the discovered rules in the same shape the Model Editor expects.
    """
    try:
        data = request.json or {}
        event_log_file = data.get('eventLogFile')
        if not event_log_file:
            return jsonify({'error': 'Missing eventLogFile parameter'}), 400

        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Event log file not found: {event_log_file}'}), 404

        event_log = load_ocel2(str(log_path))
        rules = discover_o2o_rules(event_log)

        return jsonify({
            'success': True,
            'o2o_rules': rules,
            'count': len(rules),
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/discover-resources', methods=['POST'])
def discover_resources():
    """Discover resource object types from an OCEL event log.

    Body JSON:
      eventLogFile      – filename in EVENTLOG_DIR (required)
      resourceThreshold – avg events/instance to qualify as resource (default 50)
    """
    try:
        data = request.json or {}
        event_log_file = data.get('eventLogFile')
        permanent_threshold = float(data.get('resourceThreshold', 50.0))

        if not event_log_file:
            return jsonify({'error': 'Missing eventLogFile parameter'}), 400

        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Event log file not found: {event_log_file}'}), 404

        event_log = load_ocel2(str(log_path))
        resource_type_names = discover_permanent_object_types(event_log, permanent_threshold)

        # Count individual object instances per resource type
        objects_raw = event_log.get('objects', {})
        objs_list = list(objects_raw.values()) if isinstance(objects_raw, dict) else (objects_raw or [])
        from collections import Counter
        type_counts = Counter(
            o.get('type') or o.get('ocel:type', '')
            for o in objs_list
        )
        resource_info = [
            {'type': rt, 'instance_count': type_counts.get(rt, 0)}
            for rt in resource_type_names
        ]

        return jsonify({
            'success': True,
            'resource_types': resource_type_names,
            'resource_info': resource_info,
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/suggest-permanent-threshold', methods=['POST'])
def suggest_permanent_threshold():
    """Suggest a permanent-object threshold via gap detection on the OCEL.

    Body JSON:
      eventLogFile – filename in EVENTLOG_DIR (required)

    Returns:
      { suggested_threshold: float | null }
      null means the log's reuse distribution has no clear bimodal gap.
    """
    try:
        data = request.json or {}
        event_log_file = data.get('eventLogFile')
        if not event_log_file:
            return jsonify({'error': 'Missing eventLogFile parameter'}), 400
        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Event log file not found: {event_log_file}'}), 404
        event_log = load_ocel2(str(log_path))
        threshold = suggest_permanent_object_threshold(event_log)
        return jsonify({'suggested_threshold': threshold})
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/upload-file', methods=['POST'])
def upload_file():
    """Upload a file into the appropriate input directory.

    Accepts multipart/form-data with fields:
      file  – the file to upload
      type  – 'ocdeclare' | 'eventlog' | 'parameters'
    """
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        file = request.files['file']
        file_type = request.form.get('type', '')

        if not file.filename:
            return jsonify({'error': 'Empty filename'}), 400

        dir_map = {
            'ocdeclare':  OCDECLARE_DIR,
            'eventlog':   EVENTLOG_DIR,
            'parameters': PARAMETERS_DIR,
        }
        target_dir = dir_map.get(file_type)
        if target_dir is None:
            return jsonify({'error': f'Unknown file type: {file_type}'}), 400

        # Sanitise filename — keep only the basename
        filename = os.path.basename(file.filename)
        if not filename:
            return jsonify({'error': 'Invalid filename'}), 400

        target_dir.mkdir(parents=True, exist_ok=True)
        save_path = target_dir / filename
        file.save(str(save_path))

        return jsonify({'success': True, 'filename': filename})
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({'status': 'ok'})


# ── Further Evaluations endpoints ────────────────────────────────────────────

def _build_static_model_from_request(data):
    """Shared helper: parse model + event-log cache from a request dict.

    Returns (static_model, prob_matrix, cached) or raises ValueError.
    """
    from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict
    ocdeclare_file = data.get('ocdeclareFile')
    event_log_file = data.get('eventLogFile')
    model_override  = data.get('modelOverride')

    cached = {}
    if event_log_file and event_log_file in discovery_cache:
        cached = discovery_cache[event_log_file]
    prob_matrix = cached.get('prob_matrix', {})

    if model_override:
        model_data = model_override
    elif ocdeclare_file:
        model_path = OCDECLARE_DIR / ocdeclare_file
        if not model_path.exists():
            raise ValueError(f'Model file not found: {ocdeclare_file}')
        with open(model_path, 'r') as f:
            model_data = json.load(f)
    else:
        raise ValueError('Either ocdeclareFile or modelOverride is required')

    time_distributions = cached.get('time_distributions', {})
    if time_distributions and isinstance(model_data, dict):
        existing = model_data.get('activity_durations') or {}
        merged = {act: m for act, m in time_distributions.items() if act not in existing}
        merged.update(existing)
        model_data = {**model_data, 'activity_durations': merged}

    # Concurrency ceilings + inter-arrival pacing, measured from the OCEL
    model_data = _merge_pacing(model_data, event_log_file, time_distributions)

    if isinstance(model_data, list):
        static_model = parse_ocdeclare_list(model_data)
        lifecycle_info = derive_provisional_lifecycle_from_list(model_data)
        static_model = apply_lifecycle_from_provisional_info(static_model, lifecycle_info)
    else:
        static_model = parse_ocdeclare_dict(model_data)

    return static_model, prob_matrix, cached


def _run_single_seed(static_model, prob_matrix, start_activities, seed,
                     max_steps, max_traces, max_sim_time_s):
    """Run a single simulation and return the final state."""
    start_policy = StartPolicy(start_activity_names=start_activities, max_case_starts=None)
    config = SimulationConfig(
        max_steps=max_steps,
        max_sim_time_s=max_sim_time_s,
        max_traces=max_traces,
        seed=seed,
        start_policy=start_policy,
        anchor_object_types=[ot.name for ot in static_model.object_types],
    )

    def _sel(candidates, state, static_model, config=None, rng=None, **kwargs):
        return select_candidate(candidates=candidates, state=state,
                                static_model=static_model, config=config,
                                rng=rng, transition_matrix=prob_matrix)

    sim = Simulator(static_model=static_model, config=config, select_func=_sel,
                    transition_matrix=prob_matrix)
    return sim.run()


@app.route('/api/further-eval/conformance-check', methods=['POST'])
def further_eval_conformance_check():
    """E1 — Post-hoc conformance check of a generated OCEL against OC-Declare constraints.

    Body: { outputFile: str, ocdeclareFile: str | modelOverride: dict }
    Returns per-constraint violation summary based on the events in the output log.
    """
    try:
        data = request.json or {}
        output_file = data.get('outputFile')
        if not output_file:
            return jsonify({'error': 'outputFile is required'}), 400

        log_path = OUTPUT_DIR / output_file
        if not log_path.exists():
            return jsonify({'error': f'Output log not found: {output_file}'}), 404

        with open(log_path, 'r', encoding='utf-8') as f:
            ocel = json.load(f)

        static_model, _, _ = _build_static_model_from_request(data)

        # Build per-object event sequences from the OCEL
        events_raw = ocel.get('events', [])
        if isinstance(events_raw, dict):
            events_raw = list(events_raw.values())
        events_raw.sort(key=lambda e: e.get('time', ''))

        # Build obj_id -> [activity_name in order]
        obj_traces = {}
        obj_type_map = {}
        for ev in events_raw:
            act = ev.get('type', ev.get('activity', ''))
            rels = ev.get('relationships', []) or []
            for r in rels:
                oid = r.get('objectId', '')
                otype = r.get('qualifier', r.get('objectType', ''))
                if oid:
                    obj_traces.setdefault(oid, []).append(act)
                    if otype:
                        obj_type_map[oid] = otype

        # Also check objects dict for type info
        objects_raw = ocel.get('objects', {})
        if isinstance(objects_raw, list):
            for o in objects_raw:
                oid = o.get('id', o.get('ocel:id', ''))
                otype = o.get('type', o.get('ocel:type', ''))
                if oid and otype:
                    obj_type_map[oid] = otype

        constraint_results = []
        for c in static_model.constraints:
            src = c.source_activity
            tgt = c.target_activity
            ctype = c.constraint_type
            scope_type = getattr(c.scope, 'object_type', '') or ''
            scope_kind = getattr(c.scope, 'kind', 'each')
            nmin = getattr(c, 'nmin', 0) or 0
            nmax = getattr(c, 'nmax', None)

            # Filter to scope objects
            if scope_type:
                scope_objs = [oid for oid, ot in obj_type_map.items() if ot == scope_type]
            else:
                scope_objs = list(obj_traces.keys())

            if not scope_objs:
                constraint_results.append({
                    'constraint': f'{ctype}({src} → {tgt})',
                    'constraint_type': ctype,
                    'source': src, 'target': tgt,
                    'scope_kind': scope_kind, 'scope_type': scope_type,
                    'checked': 0, 'violated': 0, 'violation_rate': None,
                    'note': 'no scope objects in log',
                })
                continue

            violated = 0
            checked = 0
            for oid in scope_objs:
                trace = obj_traces.get(oid, [])
                has_src = src in trace
                has_tgt = tgt in trace

                if ctype in ('response', 'succession'):
                    if has_src:
                        checked += 1
                        first_src = next((i for i, a in enumerate(trace) if a == src), None)
                        if first_src is not None and not any(a == tgt for a in trace[first_src + 1:]):
                            violated += 1
                elif ctype == 'responded_existence':
                    if has_src:
                        checked += 1
                        if not has_tgt:
                            violated += 1
                elif ctype == 'precedence':
                    if has_tgt:
                        checked += 1
                        first_tgt = next((i for i, a in enumerate(trace) if a == tgt), None)
                        if first_tgt is not None and not any(a == src for a in trace[:first_tgt]):
                            violated += 1
                elif ctype == 'not_coexistence':
                    checked += 1
                    if has_src and has_tgt:
                        violated += 1
                elif ctype in ('not_succession', 'not_precedence'):
                    # Violated if source has fired and target follows it (not_succession)
                    # or if target fires and source has preceded it (not_precedence) —
                    # both reduce to: source and target both appear in the trace.
                    if has_src:
                        checked += 1
                        if has_tgt:
                            violated += 1
                elif ctype == 'coexistence':
                    if has_src or has_tgt:
                        checked += 1
                        if not (has_src and has_tgt):
                            violated += 1
                elif ctype == 'exclusive_choice':
                    checked += 1
                    if has_src and has_tgt:
                        violated += 1
                    elif not has_src and not has_tgt:
                        violated += 1
                elif ctype in ('existence', 'init', 'last'):
                    checked += 1
                    if not has_src:
                        violated += 1
                elif ctype == 'absence':
                    checked += 1
                    cnt = trace.count(src)
                    cap = nmax if nmax is not None else 0
                    if cnt > cap:
                        violated += 1
                elif ctype == 'exactly':
                    checked += 1
                    cnt = trace.count(src)
                    if cnt != nmin:
                        violated += 1
                else:
                    # Generic: count-based check where applicable
                    if has_src:
                        checked += 1

            rate = round(violated / checked, 4) if checked > 0 else None
            constraint_results.append({
                'constraint': f'{ctype}({src} → {tgt})',
                'constraint_type': ctype,
                'source': src, 'target': tgt,
                'scope_kind': scope_kind, 'scope_type': scope_type,
                'checked': checked, 'violated': violated,
                'violation_rate': rate,
            })

        total_checked = sum(r['checked'] for r in constraint_results)
        total_violated = sum(r['violated'] for r in constraint_results)
        overall_fitness = round(1.0 - total_violated / total_checked, 4) if total_checked > 0 else None

        return jsonify({
            'constraint_results': constraint_results,
            'overall_fitness': overall_fitness,
            'total_checked': total_checked,
            'total_violated': total_violated,
            'num_constraints': len(constraint_results),
            'num_objects': len(obj_traces),
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/further-eval/log-fidelity', methods=['POST'])
def further_eval_log_fidelity():
    """E2 — Cross-log fidelity: simulated vs real OCEL.

    Body: { outputFile: str, eventLogFile: str }
    Returns per-activity KL divergence, object count distributions, timing EMD.
    """
    try:
        import math
        data = request.json or {}
        output_file = data.get('outputFile')
        event_log_file = data.get('eventLogFile')
        if not output_file:
            return jsonify({'error': 'outputFile is required'}), 400
        if not event_log_file:
            return jsonify({'error': 'eventLogFile (real log) is required'}), 400

        log_path = OUTPUT_DIR / output_file
        if not log_path.exists():
            return jsonify({'error': f'Output log not found: {output_file}'}), 404
        real_path = EVENTLOG_DIR / event_log_file
        if not real_path.exists():
            return jsonify({'error': f'Event log not found: {event_log_file}'}), 404

        with open(log_path, 'r', encoding='utf-8') as f:
            sim_ocel = json.load(f)
        # Use load_ocel2 to normalise OCEL 1.0 (.jsonocel) as well as OCEL 2.0
        real_ocel = load_ocel2(str(real_path))

        def _extract_activities(ocel):
            evs = ocel.get('events', [])
            if isinstance(evs, dict):
                evs = list(evs.values())
            return [e.get('type', e.get('activity', '')) for e in evs]

        def _extract_obj_counts_per_type(ocel):
            objs = ocel.get('objects', {})
            if isinstance(objs, dict):
                obj_list = list(objs.values())
            else:
                obj_list = objs or []
            counts = {}
            for o in obj_list:
                ot = o.get('type', o.get('ocel:type', ''))
                counts[ot] = counts.get(ot, 0) + 1
            return counts

        def _extract_inter_event_gaps_s(ocel):
            evs = ocel.get('events', [])
            if isinstance(evs, dict):
                evs = list(evs.values())
            evs = sorted(evs, key=lambda e: e.get('time', '') or e.get('timestamp', ''))
            from datetime import datetime
            gaps = []
            prev_ts = None
            for e in evs:
                ts_str = e.get('time', '') or e.get('timestamp', '')
                if not ts_str:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00').replace('+00:00', ''))
                except Exception:
                    continue
                if prev_ts is not None:
                    delta = (ts - prev_ts).total_seconds()
                    if delta >= 0:
                        gaps.append(delta)
                prev_ts = ts
            return gaps

        def _kl_divergence(p_counts, q_counts):
            """KL(P||Q) where P=real, Q=simulated. Uses add-1 smoothing."""
            all_keys = set(p_counts) | set(q_counts)
            p_total = sum(p_counts.values()) + len(all_keys)
            q_total = sum(q_counts.values()) + len(all_keys)
            kl = 0.0
            for k in all_keys:
                p = (p_counts.get(k, 0) + 1) / p_total
                q = (q_counts.get(k, 0) + 1) / q_total
                kl += p * math.log(p / q)
            return round(kl, 6)

        def _emd_1d(a_vals, b_vals):
            """1-D earth mover's distance (Wasserstein-1) between two sample lists."""
            if not a_vals or not b_vals:
                return None
            a_sorted = sorted(a_vals)
            b_sorted = sorted(b_vals)
            # Merge and compute CDF difference area
            all_vals = sorted(set(a_sorted + b_sorted))
            def cdf(vals, x):
                return sum(1 for v in vals if v <= x) / len(vals)
            emd = 0.0
            for i in range(len(all_vals) - 1):
                diff = abs(cdf(a_sorted, all_vals[i]) - cdf(b_sorted, all_vals[i]))
                emd += diff * (all_vals[i + 1] - all_vals[i])
            return round(emd, 4)

        real_acts = _extract_activities(real_ocel)
        sim_acts  = _extract_activities(sim_ocel)

        real_act_counts = {}
        for a in real_acts:
            real_act_counts[a] = real_act_counts.get(a, 0) + 1
        sim_act_counts = {}
        for a in sim_acts:
            sim_act_counts[a] = sim_act_counts.get(a, 0) + 1

        activity_kl = _kl_divergence(real_act_counts, sim_act_counts)

        real_obj_counts = _extract_obj_counts_per_type(real_ocel)
        sim_obj_counts  = _extract_obj_counts_per_type(sim_ocel)
        object_type_kl  = _kl_divergence(real_obj_counts, sim_obj_counts)

        real_gaps = _extract_inter_event_gaps_s(real_ocel)
        sim_gaps  = _extract_inter_event_gaps_s(sim_ocel)
        timing_emd = _emd_1d(real_gaps, sim_gaps)

        # Per-activity frequency comparison table
        all_acts = sorted(set(list(real_act_counts.keys()) + list(sim_act_counts.keys())))
        real_total = max(len(real_acts), 1)
        sim_total  = max(len(sim_acts), 1)
        activity_freq_table = [
            {
                'activity': a,
                'real_count': real_act_counts.get(a, 0),
                'sim_count':  sim_act_counts.get(a, 0),
                'real_freq':  round(real_act_counts.get(a, 0) / real_total, 4),
                'sim_freq':   round(sim_act_counts.get(a, 0) / sim_total, 4),
            }
            for a in all_acts
        ]

        all_types = sorted(set(list(real_obj_counts.keys()) + list(sim_obj_counts.keys())))
        object_type_table = [
            {
                'object_type': t,
                'real_count': real_obj_counts.get(t, 0),
                'sim_count':  sim_obj_counts.get(t, 0),
            }
            for t in all_types
        ]

        timing_summary = {
            'real_gap_mean_s':   round(sum(real_gaps) / len(real_gaps), 1) if real_gaps else None,
            'sim_gap_mean_s':    round(sum(sim_gaps)  / len(sim_gaps),  1) if sim_gaps  else None,
            'real_gap_median_s': round(sorted(real_gaps)[len(real_gaps)//2], 1) if real_gaps else None,
            'sim_gap_median_s':  round(sorted(sim_gaps)[len(sim_gaps)//2],   1) if sim_gaps  else None,
            'emd_s':             timing_emd,
        }

        return jsonify({
            'activity_kl_divergence':  activity_kl,
            'object_type_kl_divergence': object_type_kl,
            'timing_emd_s': timing_emd,
            'activity_freq_table': activity_freq_table,
            'object_type_table':   object_type_table,
            'timing_summary':      timing_summary,
            'real_event_count': len(real_acts),
            'sim_event_count':  len(sim_acts),
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/further-eval/multi-run', methods=['POST'])
def further_eval_multi_run():
    """E5 — Multi-seed variance analysis.

    Body: {
      seeds: [int, ...],           # list of seeds to run (max 20)
      ocdeclareFile | modelOverride,
      eventLogFile,
      startActivities: [str],
      maxEvents: int,
      maxTraces: int,
    }
    Returns mean ± std for event count, object count, completed traces,
    obligations fulfilled/cancelled/violated, and per-constraint fulfillment rates.
    """
    try:
        import math
        data = request.json or {}
        seeds = data.get('seeds') or [42, 99, 123, 456, 789]
        seeds = [int(s) for s in seeds[:20]]  # cap at 20
        start_activities = data.get('startActivities') or []
        if not start_activities:
            return jsonify({'error': 'startActivities is required'}), 400
        max_steps  = int(data.get('maxEvents') or data.get('maxSteps') or 100_000)
        max_traces = data.get('maxTraces')
        if max_traces is not None:
            max_traces = int(max_traces)
        max_sim_time_s = data.get('maxSimTimeS')
        if max_sim_time_s is not None:
            max_sim_time_s = float(max_sim_time_s)

        static_model, prob_matrix, _ = _build_static_model_from_request(data)

        run_results = []
        for seed in seeds:
            st = _run_single_seed(
                static_model, prob_matrix, start_activities,
                seed, max_steps, max_traces, max_sim_time_s,
            )
            c_stats = {
                f"{k[0]}|{k[1]}→{k[2]}|{k[3]}": dict(v)
                for k, v in (getattr(st, '_constraint_obligation_stats', None) or {}).items()
            }
            run_results.append({
                'seed':                  seed,
                'events_count':          len(st.executed_events),
                'objects_count':         len(st.objects),
                'completed_traces':      getattr(st, 'completed_trace_count', 0),
                'obligations_fulfilled': getattr(st, 'total_obligations_fulfilled', 0),
                'obligations_cancelled': getattr(st, 'total_obligations_cancelled', 0),
                'obligations_violated':  getattr(st, 'total_obligations_violated', 0),
                'constraint_stats':      c_stats,
            })

        def _stats(values):
            n = len(values)
            if n == 0:
                return {'mean': None, 'std': None, 'min': None, 'max': None}
            mean = sum(values) / n
            std  = math.sqrt(sum((v - mean) ** 2 for v in values) / n) if n > 1 else 0.0
            return {'mean': round(mean, 2), 'std': round(std, 2),
                    'min': min(values), 'max': max(values)}

        summary = {
            'events_count':          _stats([r['events_count']          for r in run_results]),
            'objects_count':         _stats([r['objects_count']         for r in run_results]),
            'completed_traces':      _stats([r['completed_traces']      for r in run_results]),
            'obligations_fulfilled': _stats([r['obligations_fulfilled'] for r in run_results]),
            'obligations_violated':  _stats([r['obligations_violated']  for r in run_results]),
        }

        # Per-constraint fulfillment rate across seeds
        all_c_keys = set()
        for r in run_results:
            all_c_keys.update(r['constraint_stats'].keys())
        constraint_summary = {}
        for ck in sorted(all_c_keys):
            rates = []
            for r in run_results:
                cs = r['constraint_stats'].get(ck, {})
                f = cs.get('fulfilled', 0)
                v = cs.get('violated', 0)
                total = f + v
                if total > 0:
                    rates.append(f / total)
            constraint_summary[ck] = _stats(rates) if rates else {'mean': None, 'std': None}

        return jsonify({
            'seeds':              seeds,
            'runs':               run_results,
            'summary':            summary,
            'constraint_summary': constraint_summary,
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/further-eval/cardinality-fidelity', methods=['POST'])
def further_eval_cardinality_fidelity():
    """E6 — Object cardinality fidelity: objects-per-event in real vs simulated log.

    Body: { outputFile: str, eventLogFile: str }
    Returns per-activity mean/std objects-per-event for real vs sim log.
    """
    try:
        data = request.json or {}
        output_file   = data.get('outputFile')
        event_log_file = data.get('eventLogFile')
        if not output_file:
            return jsonify({'error': 'outputFile is required'}), 400
        if not event_log_file:
            return jsonify({'error': 'eventLogFile (real log) is required'}), 400

        log_path  = OUTPUT_DIR / output_file
        real_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Output log not found: {output_file}'}), 404
        if not real_path.exists():
            return jsonify({'error': f'Event log not found: {event_log_file}'}), 404

        with open(log_path,  'r', encoding='utf-8') as f:
            sim_ocel  = json.load(f)
        # Use load_ocel2 to normalise OCEL 1.0 (.jsonocel) as well as OCEL 2.0
        real_ocel = load_ocel2(str(real_path))

        def _objects_per_event(ocel):
            evs = ocel.get('events', [])
            if isinstance(evs, dict):
                evs = list(evs.values())
            per_act = {}
            for e in evs:
                act  = e.get('type', e.get('activity', ''))
                rels = e.get('relationships', []) or e.get('omap', []) or []
                cnt  = len(rels)
                per_act.setdefault(act, []).append(cnt)
            return per_act

        import math
        def _summarise(vals):
            if not vals:
                return {'mean': None, 'std': None, 'min': None, 'max': None, 'count': 0}
            n = len(vals)
            mean = sum(vals) / n
            std  = math.sqrt(sum((v - mean) ** 2 for v in vals) / n) if n > 1 else 0.0
            return {'mean': round(mean, 3), 'std': round(std, 3),
                    'min': min(vals), 'max': max(vals), 'count': n}

        real_ope = _objects_per_event(real_ocel)
        sim_ope  = _objects_per_event(sim_ocel)

        all_acts = sorted(set(list(real_ope.keys()) + list(sim_ope.keys())))
        table = []
        for act in all_acts:
            real_s = _summarise(real_ope.get(act, []))
            sim_s  = _summarise(sim_ope.get(act, []))
            mean_diff = (
                round(sim_s['mean'] - real_s['mean'], 3)
                if real_s['mean'] is not None and sim_s['mean'] is not None else None
            )
            table.append({
                'activity': act,
                'real': real_s,
                'sim':  sim_s,
                'mean_diff': mean_diff,
            })

        return jsonify({'table': table})
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/further-eval/ocpa-ocpq-comparison', methods=['POST'])
def further_eval_ocpa_ocpq_comparison():
    """E4/E7 — Side-by-side OCPA timing + OCPQ schema comparison: real vs sim log.

    Body: { outputFile: str, eventLogFile: str, serviceTimeMode?: str }
    Calls existing discover-timing-output and discover-timing logic, then pairs results.
    """
    try:
        from Backend.src.Simulation.IO.input.ocel import load_ocel2
        from Backend.src.ParameterDiscovery.timediscovery import compute_ocpa_metrics
        data = request.json or {}
        output_file    = data.get('outputFile')
        event_log_file = data.get('eventLogFile')
        service_mode   = data.get('serviceTimeMode', 'sojourn')
        if not output_file:
            return jsonify({'error': 'outputFile is required'}), 400
        if not event_log_file:
            return jsonify({'error': 'eventLogFile (real log) is required'}), 400

        log_path  = OUTPUT_DIR / output_file
        real_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Output log not found: {output_file}'}), 404
        if not real_path.exists():
            return jsonify({'error': f'Event log not found: {event_log_file}'}), 404

        sim_ocel  = load_ocel2(str(log_path))
        real_ocel = load_ocel2(str(real_path))

        sim_metrics  = compute_ocpa_metrics(sim_ocel,  service_time_mode=service_mode) or {}
        real_metrics = compute_ocpa_metrics(real_ocel, service_time_mode=service_mode) or {}

        all_acts = sorted(set(list(sim_metrics.keys()) + list(real_metrics.keys())))

        TIME_FIELDS = ['service_mean', 'service_min', 'service_max',
                       'waiting_mean', 'sojourn_mean', 'sync_mean',
                       'flow_mean', 'pooling_mean', 'lagging_mean']

        def _pct_diff(real_v, sim_v):
            if real_v is None or sim_v is None or real_v == 0:
                return None
            return round((sim_v - real_v) / abs(real_v) * 100, 1)

        comparison = []
        for act in all_acts:
            rm = real_metrics.get(act, {})
            sm = sim_metrics.get(act, {})
            fields = {}
            for f in TIME_FIELDS:
                rv = rm.get(f)
                sv = sm.get(f)
                fields[f] = {
                    'real': rv, 'sim': sv,
                    'pct_diff': _pct_diff(rv, sv),
                }
            # Per-activity WMAPE: weighted mean absolute percentage error over
            # all TIME_FIELDS that have both a real and sim value.
            # Weight = real value (larger metrics dominate the aggregate).
            wmape_num = 0.0
            wmape_den = 0.0
            for f in TIME_FIELDS:
                rv = rm.get(f)
                sv = sm.get(f)
                if rv is not None and sv is not None and rv > 0:
                    wmape_num += abs(sv - rv)
                    wmape_den += rv
            act_wmape = round(wmape_num / wmape_den * 100, 1) if wmape_den > 0 else None
            comparison.append({'activity': act, 'fields': fields, 'wmape': act_wmape})

        # Global WMAPE across all activities and fields
        global_num = sum(
            abs((row['fields'][f]['sim'] or 0) - (row['fields'][f]['real'] or 0))
            for row in comparison for f in TIME_FIELDS
            if row['fields'][f]['real'] and row['fields'][f]['sim'] and row['fields'][f]['real'] > 0
        )
        global_den = sum(
            row['fields'][f]['real']
            for row in comparison for f in TIME_FIELDS
            if row['fields'][f]['real'] and row['fields'][f]['sim'] and row['fields'][f]['real'] > 0
        )
        global_wmape = round(global_num / global_den * 100, 1) if global_den > 0 else None

        return jsonify({
            'comparison': comparison,
            'real_metrics': real_metrics,
            'sim_metrics':  sim_metrics,
            'global_wmape': global_wmape,
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/further-eval/distribution-fidelity', methods=['POST'])
def further_eval_distribution_fidelity():
    """Distribution fidelity: Wasserstein-1 on per-activity sojourn times + KS on activity frequencies.

    Following López-Pintado et al. 2024 "Discovery and Simulation of Data-Aware Business Processes".
    Body: { outputFile: str, eventLogFile: str }
    """
    try:
        data = request.json or {}
        output_file    = data.get('outputFile')
        event_log_file = data.get('eventLogFile')
        if not output_file:
            return jsonify({'error': 'outputFile is required'}), 400
        if not event_log_file:
            return jsonify({'error': 'eventLogFile (real log) is required'}), 400

        log_path  = OUTPUT_DIR / output_file
        real_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Output log not found: {output_file}'}), 404
        if not real_path.exists():
            return jsonify({'error': f'Event log not found: {event_log_file}'}), 404

        with open(log_path,  'r', encoding='utf-8') as f:
            sim_ocel  = json.load(f)
        # Use load_ocel2 to normalise OCEL 1.0 (.jsonocel) as well as OCEL 2.0
        real_ocel = load_ocel2(str(real_path))

        # ── Helpers ────────────────────────────────────────────────────────────

        def _parse_ts(raw):
            if not raw:
                return None
            from datetime import datetime
            try:
                return datetime.fromisoformat(
                    str(raw).replace('Z', '+00:00').replace('+00:00', '')
                )
            except Exception:
                return None

        def _get_oids(ev):
            # OCEL 2.0: omap is a list of plain object ID strings
            omap = ev.get('omap')
            if omap and isinstance(omap, list):
                return [o for o in omap if o]
            # JSON-OCEL: relationships is a list of dicts with objectId
            rels = ev.get('relationships') or []
            return [r.get('objectId', '') for r in rels if isinstance(r, dict) and r.get('objectId')]

        def _extract_sojourn(ocel):
            """Return dict of activity -> [sojourn_seconds] via backward-gap method."""
            evs = ocel.get('events', [])
            if isinstance(evs, dict):
                evs = list(evs.values())
            parsed = []
            for ev in evs:
                ts  = _parse_ts(ev.get('time') or ev.get('ocel:timestamp') or ev.get('timestamp'))
                act = ev.get('type', ev.get('activity', ev.get('ocel:activity', '')))
                oids = set(o for o in _get_oids(ev) if o)
                if ts and act:
                    parsed.append((ts, act, oids))
            parsed.sort(key=lambda t: t[0])
            obj_last: dict = {}
            samples: dict  = {}
            for ts, act, oids in parsed:
                preceding = [obj_last[o] for o in oids if o in obj_last]
                if preceding:
                    s = (ts - max(preceding)).total_seconds()
                    if 0 <= s < 365 * 86400:
                        samples.setdefault(act, []).append(s)
                for o in oids:
                    obj_last[o] = ts
            return samples

        def _extract_act_counts(ocel):
            evs = ocel.get('events', [])
            if isinstance(evs, dict):
                evs = list(evs.values())
            counts: dict = {}
            for ev in evs:
                act = ev.get('type', ev.get('activity', ev.get('ocel:activity', '')))
                if act:
                    counts[act] = counts.get(act, 0) + 1
            return counts

        def _w1(a_vals, b_vals):
            """Wasserstein-1 between two sample lists (O(n log n) two-pointer)."""
            if not a_vals or not b_vals:
                return None
            a_s = sorted(a_vals)
            b_s = sorted(b_vals)
            na, nb = len(a_s), len(b_s)
            all_x = sorted(set(a_s + b_s))
            if len(all_x) < 2:
                return 0.0
            ia = ib = 0
            w1 = 0.0
            for i in range(len(all_x) - 1):
                x, xn = all_x[i], all_x[i + 1]
                while ia < na and a_s[ia] <= x:
                    ia += 1
                while ib < nb and b_s[ib] <= x:
                    ib += 1
                w1 += abs(ia / na - ib / nb) * (xn - x)
            return round(w1, 2)

        def _ks_samples(a_vals, b_vals):
            """KS statistic between two sojourn-time sample lists (max |F_a(x) - F_b(x)|)."""
            if not a_vals or not b_vals:
                return None
            a_s = sorted(a_vals)
            b_s = sorted(b_vals)
            na, nb = len(a_s), len(b_s)
            all_x = sorted(set(a_s + b_s))
            ia = ib = 0
            ks = 0.0
            for x in all_x:
                while ia < na and a_s[ia] <= x:
                    ia += 1
                while ib < nb and b_s[ib] <= x:
                    ib += 1
                ks = max(ks, abs(ia / na - ib / nb))
            return round(ks, 4)

        # ── Compute ────────────────────────────────────────────────────────────

        real_sojourn = _extract_sojourn(real_ocel)
        sim_sojourn  = _extract_sojourn(sim_ocel)
        real_counts  = _extract_act_counts(real_ocel)
        sim_counts   = _extract_act_counts(sim_ocel)

        all_acts = sorted(set(list(real_sojourn.keys()) + list(sim_sojourn.keys())))
        act_rows = []
        for act in all_acts:
            rs = real_sojourn.get(act, [])
            ss = sim_sojourn.get(act, [])
            act_rows.append({
                'activity': act,
                'real_n':   len(rs),
                'sim_n':    len(ss),
                'w1_s':     _w1(rs, ss),
                'ks_s':     _ks_samples(rs, ss),
            })
        act_rows.sort(key=lambda r: -r['real_n'])

        total_real_n = sum(r['real_n'] for r in act_rows if r['w1_s'] is not None)
        overall_w1 = round(
            sum(r['w1_s'] * r['real_n'] for r in act_rows if r['w1_s'] is not None) / total_real_n,
            2
        ) if total_real_n > 0 else None

        total_real_n_ks = sum(r['real_n'] for r in act_rows if r['ks_s'] is not None)
        overall_ks = round(
            sum(r['ks_s'] * r['real_n'] for r in act_rows if r['ks_s'] is not None) / total_real_n_ks,
            4
        ) if total_real_n_ks > 0 else None

        return jsonify({
            'activity_rows':    act_rows,
            'overall_w1_s':     overall_w1,
            'overall_ks_s':     overall_ks,
            'real_event_count': sum(real_counts.values()),
            'sim_event_count':  sum(sim_counts.values()),
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


if __name__ == '__main__':
    print("🚀 Starting Declarative OC Simulator Backend...")
    print(f"📁 OC-Declare models directory: {OCDECLARE_DIR}")
    print(f"📁 Event logs directory: {EVENTLOG_DIR}")
    print(f"📁 Output directory: {OUTPUT_DIR}")
    print("🌐 Server running on http://localhost:5000")
    print("💡 Make sure to run 'npm run dev' in the Frontend folder")
    
    app.run(debug=True, port=5000)
