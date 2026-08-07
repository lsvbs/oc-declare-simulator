#!/usr/bin/env python3
"""
Flask backend server for Declarative OC Simulator Frontend.
Handles simulation orchestration and file management.
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import os
import sys
import json
from pathlib import Path
from collections import Counter
import pickle
import tempfile

# Add project root to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.Simulation.Models.OCDeclare import (
    parse_ocdeclare_list,
    derive_provisional_lifecycle_from_list,
    apply_lifecycle_from_provisional_info,
)
from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Domain.state import SimulationState, RuntimeObject
from src.Simulation.Engine.simulator import Simulator
from src.ParameterDiscovery.probabilitydiscovery import discover_transition_matrix, load_event_log
from src.ParameterDiscovery.OCDeclarediscovery import discover_ocdeclare_model, compute_ocpa_metrics, load_ocel2, discover_concurrency_probs, discover_o2o_rules, discover_resource_types
from src.Simulation.Engine.selection import select_candidate
from src.Simulation.IO.output.OCEL2 import write_ocel2_json
from src.Simulation.IO.output.metrics import compute_metrics, write_metrics_json

app = Flask(__name__)
CORS(app)

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent
OCDECLARE_DIR = BASE_DIR / 'src' / 'Simulation' / 'IO' / 'input' / 'ocdeclare'
EVENTLOG_DIR = BASE_DIR / 'src' / 'Simulation' / 'IO' / 'input' / 'eventlog'
PARAMETERS_DIR = BASE_DIR / 'src' / 'Simulation' / 'IO' / 'input' / 'parameters'
OUTPUT_DIR = BASE_DIR / 'src' / 'Simulation' / 'IO' / 'output' / 'eventlogs'
METRICS_DIR = BASE_DIR / 'metrics'
HISTORY_FILE = METRICS_DIR / 'run_history.json'
DISCOVERY_DIR = Path(tempfile.gettempdir()) / 'decocprototype_discovery'
DISCOVERY_DIR.mkdir(exist_ok=True)
PARAMETERS_DIR.mkdir(parents=True, exist_ok=True)
METRICS_DIR.mkdir(parents=True, exist_ok=True)

# Store discovery results in memory (keyed by event_log_file)
discovery_cache = {}

# Active simulation runs: run_id -> {state, stop_event, thread, done}
import threading
_active_runs: dict = {}


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


def _compute_ocel_time_span(ocel_source) -> float | None:
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
            if (f.endswith('.json') or f.endswith('.xml')) and not f.endswith('_matrix.json')
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
        from src.ParameterDiscovery.probabilitydiscovery import discover_transition_matrix_object_centric
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
            act_obj_counts: dict = {}
            for edata in events_list_raw:
                act = edata.get('activity') or edata.get('ocel:activity', '')
                if not act:
                    continue
                for oid in (edata.get('omap') or edata.get('relationships') or []):
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
                        object_type_stats[ot]['mean_max_reuse'] = round(
                            sum(max_reuse_list) / len(max_reuse_list), 2
                        )

        # Global consecutive-repeat stats: across the full sorted event timeline,
        # find every run of consecutive same-activity firings and record its length.
        # min/mean/max of those run lengths tells you how the activity clusters in
        # the real log — directly calibrates the max_consecutive setting.
        activity_consec_stats: dict = {}
        if ocel_source:
            sorted_acts = [
                edata.get('activity') or edata.get('ocel:activity', '')
                for edata in sorted(
                    events_list_raw,
                    key=lambda e: e.get('timestamp') or e.get('ocel:timestamp') or ''
                )
                if edata.get('activity') or edata.get('ocel:activity', '')
            ]
            # Scan runs
            act_runs: dict = {}  # activity -> list of run lengths
            i = 0
            while i < len(sorted_acts):
                act = sorted_acts[i]
                run = 1
                while i + run < len(sorted_acts) and sorted_acts[i + run] == act:
                    run += 1
                act_runs.setdefault(act, []).append(run)
                i += run
            for act, runs in act_runs.items():
                activity_consec_stats[act] = {
                    'min':  min(runs),
                    'max':  max(runs),
                    'mean': round(sum(runs) / len(runs), 2),
                }

        # Suggested nmax per object: 95th-percentile of per-object repeat counts
        # from the real log.  Gives the user a data-driven starting point for
        # max_consecutive_per_object that prevents the simulation from exceeding
        # realistic repeat counts while still allowing natural variation.
        activity_nmax_suggestions: dict = {}
        if ocel_source and act_obj_counts:
            import math
            for act, obj_counts in act_obj_counts.items():
                counts_list = sorted(obj_counts.values())
                n = len(counts_list)
                if n == 0:
                    continue
                # 95th percentile (nearest-rank)
                idx_p95 = max(0, math.ceil(0.95 * n) - 1)
                p95 = counts_list[idx_p95]
                # p50 for context
                idx_p50 = max(0, math.ceil(0.50 * n) - 1)
                p50 = counts_list[idx_p50]
                activity_nmax_suggestions[act] = {
                    'p50': int(p50),
                    'p95': int(p95),
                    'suggested': int(p95),  # recommended value to plug in
                }
        
        # Calculate transition statistics
        transition_count = sum(len(targets) for targets in prob_matrix.values())
        
        # Store in cache for later simulation use
        discovery_cache[event_log_file] = {
            'prob_matrix': prob_matrix,
            'time_distributions': time_distributions,
            'activities': activities,
            'activity_counts': activity_counts,
            'activity_repeat_stats': activity_repeat_stats,
            'activity_consec_stats': activity_consec_stats,
            'activity_nmax_suggestions': activity_nmax_suggestions,
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
                'activity_consec_stats': activity_consec_stats,
                'activity_nmax_suggestions': activity_nmax_suggestions,
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
            from src.Simulation.Models.OCDeclare import parse_ocdeclare_list
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
                        'scope': {'kind': c.scope.kind, 'object_type': c.scope.object_type},
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
        seed = int(data.get('seed', 42))
        # Accept either startActivities (list, new) or startActivity (string, legacy)
        start_activities = data.get('startActivities')
        if not start_activities:
            sa = data.get('startActivity')
            start_activities = [sa] if sa else []
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

        # Merge concurrency probabilities into model_data
        concurrency_probs = cached.get('concurrency_probs', {})
        if concurrency_probs and isinstance(model_data, dict):
            existing_cp = model_data.get('concurrency_probs') or {}
            if not existing_cp:
                model_data = {**model_data, 'concurrency_probs': concurrency_probs}
        
        # Route to the correct parser based on file format:
        # - list  → hand-crafted arc-list format (Format 1)
        # - dict  → discovered structured format (Format 2)
        if isinstance(model_data, list):
            static_model = parse_ocdeclare_list(model_data)
            lifecycle_info = derive_provisional_lifecycle_from_list(model_data)
            static_model = apply_lifecycle_from_provisional_info(static_model, lifecycle_info)
        else:
            from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict
            static_model = parse_ocdeclare_dict(model_data)
        
        # Build simulation config
        start_policy = StartPolicy(
            start_activity_names=start_activities,
            max_case_starts=None
        )
        
        config = SimulationConfig(
            max_steps=max_steps,
            max_sim_time_s=max_sim_time_s,
            max_traces=max_traces,
            seed=seed,
            start_policy=start_policy,
            anchor_object_types=[ot.name for ot in static_model.object_types]
        )
        
        # Create selection wrapper with probability matrix
        # Also captures per-candidate probabilities so the trace can report them.
        _last_prob_map = {}  # activity_name -> normalised probability

        def select_with_matrix(candidates, state, static_model, config=None, rng=None, **kwargs):
            # Mirror the probability calculation from selection.py so we can
            # expose normalised weights in the iteration trace.
            last_activity = (
                state.executed_events[-1].activity_name
                if state.executed_events
                else "__START__"
            )
            transition_probs = prob_matrix.get(last_activity, {})
            epsilon = 1e-6
            raw_weights = [transition_probs.get(c.activity_name, 0.0) + epsilon for c in candidates]
            total = sum(raw_weights)
            _last_prob_map.clear()
            for c, w in zip(candidates, raw_weights):
                _last_prob_map[c.activity_name] = round(w / total, 4) if total > 0 else 0.0

            return select_candidate(
                candidates=candidates,
                state=state,
                static_model=static_model,
                config=config,
                rng=rng,
                transition_matrix=prob_matrix
            )
        
        # Initialize state with initial objects (for Order Management)
        initial_state = SimulationState()
        
        # Add initial products and employees if Order Management
        if 'order' in ocdeclare_file.lower() or 'management' in ocdeclare_file.lower():
            initial_state.objects['products_1'] = RuntimeObject(
                object_id='products_1', 
                object_type='products', 
                active=True
            )
            initial_state.objects['products_2'] = RuntimeObject(
                object_id='products_2', 
                object_type='products', 
                active=True
            )
            initial_state.objects['employees_1'] = RuntimeObject(
                object_id='employees_1', 
                object_type='employees', 
                active=True
            )
            initial_state.objects['employees_2'] = RuntimeObject(
                object_id='employees_2', 
                object_type='employees', 
                active=True
            )
            initial_state.next_object_counter = {'products': 3, 'employees': 3}
        
        # Run simulation
        import tempfile, os
        _LOG_CAP = 500  # only keep last 500 steps in the response to avoid huge payloads
        # Write full iteration trace directly to a temp file (JSONL) to avoid
        # accumulating all entries in memory.
        _iter_tmp = tempfile.NamedTemporaryFile(
            mode='w', suffix='.jsonl', delete=False,
            dir=str(METRICS_DIR), prefix='iteration_tmp_'
        )
        _iter_tmp_path = _iter_tmp.name

        # Write model snapshot as the first record so the iteration log is self-contained
        import json as _json2
        _model_header = {
            "event": "model_snapshot",
            "ocdeclare_file": ocdeclare_file,
            "start_activities": start_activities,
            "constraints": [
                {
                    "constraint_type": getattr(c, "constraint_type", None),
                    "source_activity": getattr(c, "source_activity", None),
                    "target_activity": getattr(c, "target_activity", None),
                    "scope_kind": getattr(c.scope, "kind", None) if hasattr(c, "scope") and c.scope else None,
                    "scope_object_type": getattr(c.scope, "object_type", None) if hasattr(c, "scope") and c.scope else None,
                    "nmin": getattr(c, "nmin", None),
                    "nmax": getattr(c, "nmax", None),
                }
                for c in static_model.constraints
            ],
            "activities": [
                {
                    "name": a.name,
                    "bindings": [
                        {
                            "object_type": b.object_type,
                            "creates": getattr(b, "creates", False),
                            "deactivates": getattr(b, "deactivates", False),
                            "min_count": getattr(b, "min_count", 1),
                            "max_count": getattr(b, "max_count", None),
                        }
                        for b in (a.bindings or [])
                    ],
                }
                for a in static_model.activities
            ],
            "o2o_rules": [
                {
                    "source_type": getattr(r, "source_type", None),
                    "target_type": getattr(r, "target_type", None),
                    "min_links": getattr(r, "min_links", None),
                    "max_links": getattr(r, "max_links", None),
                    "bidirectional": getattr(r, "bidirectional", False),
                }
                for r in (static_model.o2o_rules or [])
            ],
            "resource_types": list(static_model.resource_types or []),
            "resource_pool_sizes": dict(static_model.resource_pool_sizes or {}),
            "no_parallel_activities": list(getattr(static_model, "no_parallel_activities", set()) or []),
        }
        _iter_tmp.write(_json2.dumps(_model_header) + '\n')
        _iter_tmp.flush()

        def trace_func(event: str, payload: dict):
            if event == "iteration":
                step = payload.get("step_count", "?")
                candidates_detail = payload.get("candidates", [])
                ts = payload.get("timestamp", None)
                in_prog = payload.get("in_progress_count", 0)
                waiting = payload.get("waiting_count", 0)
                candidates_with_probs = [
                    {
                        "activity": c.get("activity_name", ""),
                        "prob": _last_prob_map.get(c.get("activity_name", ""), None),
                        "objects": c.get("participating_object_ids", []),
                    }
                    for c in candidates_detail
                ]
                entry = {
                    "step": step,
                    "event": "candidates",
                    "num_candidates": payload.get("num_candidates", 0),
                    "candidates_with_probs": candidates_with_probs,
                    "in_progress": in_prog,
                    "waiting": waiting,
                    "sim_time": payload.get("sim_time", None),
                    # Diagnostic fields for bottleneck analysis
                    "active_objects":                 payload.get("active_objects", {}),
                    "total_obligations":              payload.get("total_obligations", 0),
                    "obligated_activities":           payload.get("obligated_activities", []),
                    "deactivations_this_step":         payload.get("deactivations_this_step", 0),
                    "obligations_fulfilled_this_step": payload.get("obligations_fulfilled_this_step", 0),
                    "total_deactivations":             payload.get("total_deactivations", 0),
                    "total_obligations_fulfilled":     payload.get("total_obligations_fulfilled", 0),
                    "total_obligations_cancelled":     payload.get("total_obligations_cancelled", 0),
                }
                import json as _json
                _iter_tmp.write(_json.dumps(entry) + '\n')
            elif event == "chosen":
                activity = payload.get("activity_name", "?")
                entry = {
                    "event": "chosen",
                    "activity": activity,
                    "prob": _last_prob_map.get(activity, None),
                    "objects": payload.get("participating_object_ids", []),
                    "creates": payload.get("object_types_to_create", []),
                    "timestamp": payload.get("timestamp", None),
                }
                import json as _json
                _iter_tmp.write(_json.dumps(entry) + '\n')
            elif event == "applied":
                entry = {
                    "event":       "applied",
                    "activity":    payload.get("activity_name", "?"),
                    "timestamp":   payload.get("timestamp", None),
                    "started_at":  payload.get("started_at", None),
                    "duration_s":  payload.get("duration_s", None),
                    "objects":     payload.get("object_ids", []),
                    "step_count":  payload.get("step_count", None),
                    "concurrent":  payload.get("concurrent", []),
                }
                import json as _json
                _iter_tmp.write(_json.dumps(entry) + '\n')
            elif event == "stop":
                entry = {
                    "step": payload.get("step_count", "?"),
                    "event": "stop",
                    "reason": payload.get("reason", "unknown"),
                }
                import json as _json
                _iter_tmp.write(_json.dumps(entry) + '\n')
                _iter_tmp.flush()

        stop_event = threading.Event()
        simulator = Simulator(
            static_model,
            config,
            rng=None,
            select_func=select_with_matrix,
            trace_func=trace_func,
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
        
        # Save output
        output_file = write_ocel2_json(final_state, static_model=static_model)
        output_filename = os.path.basename(output_file)

        # Compute and save timing metrics
        metrics = compute_metrics(final_state)
        metrics_file = write_metrics_json(final_state, out_dir=METRICS_DIR, filename=output_filename.replace('log_', 'metrics_'))
        metrics_filename = os.path.basename(metrics_file)

        # Close temp file and rename to final iteration log path
        iteration_log_filename = output_filename.replace('log_', 'iteration_')
        iteration_log_path = METRICS_DIR / iteration_log_filename
        try:
            _iter_tmp.close()
            import shutil
            shutil.move(_iter_tmp_path, str(iteration_log_path))
        except Exception:
            try:
                os.unlink(_iter_tmp_path)
            except Exception:
                pass
            iteration_log_filename = None

        # Compute object lifecycle and activity participation audits
        from src.Simulation.IO.output.metrics import compute_audit
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
            'iteration_log_file': iteration_log_filename,
            'runtime_s':      _sim_runtime_s,
            # store config snapshot so re-run can replay it
            'model_override': model_override,
            'prob_matrix_override': prob_matrix_override,
        }
        history = _load_history()
        history.append(run_entry)
        _save_history(history)

        # Build concurrency summary from the cached discovered probs
        # Only include unique pairs (A <= B) above threshold 0.3, sorted by probability
        cached_conc = discovery_cache.get(event_log_file, {}).get('concurrency_probs', {})
        concurrency_pairs = sorted(
            [
                {'a': k.split('|||')[0], 'b': k.split('|||')[1], 'p': round(v, 3)}
                for k, v in cached_conc.items()
                if '|||' in k and k.split('|||')[0] <= k.split('|||')[1] and v >= 0.3
            ],
            key=lambda x: -x['p'],
        )
        
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
                'output_file': output_filename,
                'metrics_file': metrics_filename,
                'iteration_log_file': iteration_log_filename,
                # metrics intentionally omitted from inline response — can be very large
                # (hundreds of MB for big runs). Use GET /api/run-history/{id}/metrics
                # or the Download Metrics button to access the full data.
                'metrics': {
                    'activity_metrics': metrics.get('activity_metrics', {}),
                    'activity_service_by_type': metrics.get('activity_service_by_type', {}),
                    # object_metrics omitted — too large; available via metrics file download
                },
                'audit': audit,
                'concurrency_pairs': concurrency_pairs,
                'resource_types': list(static_model.resource_types or []),
                'completed_traces': getattr(final_state, 'completed_trace_count', 0),
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


@app.route('/api/download-metrics/<filename>', methods=['GET'])
def download_metrics(filename):
    """Download generated metrics file."""
    try:
        file_path = METRICS_DIR / filename
        if not file_path.exists():
            return jsonify({'error': 'File not found'}), 404
        return send_file(file_path, mimetype='application/json', as_attachment=True, download_name=filename)
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


def get_eventlog_events():
    """Return a lightweight event list from an input OCEL log for conformance checking."""
    try:
        filename = request.args.get('file')
        if not filename:
            return jsonify({'error': 'Missing file parameter'}), 400
        log_path = EVENTLOG_DIR / filename
        if not log_path.exists():
            return jsonify({'error': f'Event log not found: {filename}'}), 404

        # Support both JSON and XML OCEL formats
        suffix = log_path.suffix.lower()
        if suffix == '.xml':
            from src.ParameterDiscovery.OCDeclarediscovery import load_ocel2_xml
            ocel = load_ocel2_xml(str(log_path))
            # XML loader returns objects as dict {id: {type, attributes}}
            objects_raw_dict = ocel.get('objects', {})
            obj_type_map = {oid: info.get('type','') for oid, info in objects_raw_dict.items()}
            events_dict = ocel.get('events', {})
            result = []
            for eid, ev in events_dict.items():
                result.append({
                    'id': eid,
                    'activity': ev.get('activity', ''),
                    'timestamp': ev.get('timestamp', ''),
                    'object_ids': ev.get('omap', []),
                })
        else:
            # JSON OCEL
            content = log_path.read_text(encoding='utf-8').strip()
            if not content:
                return jsonify({'error': f'Event log file is empty: {filename}'}), 400
            ocel = json.loads(content)
            objects_raw = ocel.get('objects', [])
            if isinstance(objects_raw, dict):
                objects_raw = list(objects_raw.values())
            obj_type_map = {obj.get('id', ''): obj.get('type', '') for obj in objects_raw}
            events_raw = ocel.get('events', [])
            if isinstance(events_raw, dict):
                events_raw = list(events_raw.values())
            result = []
            for ev in events_raw:
                rels = ev.get('relationships', []) or []
                oids = [r['objectId'] for r in rels if r.get('objectId')]
                result.append({'id': ev.get('id', ''), 'activity': ev.get('type', ''),
                               'timestamp': ev.get('time', ''), 'object_ids': oids})

        result.sort(key=lambda e: e.get('timestamp', ''))
        return jsonify({'events': result, 'count': len(result), 'object_types_map': obj_type_map})
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/run-history/<run_id>/iteration-log', methods=['GET'])
def get_iteration_log(run_id):
    """Return the full iteration log for a specific run (JSONL format)."""
    history = _load_history()
    entry = next((e for e in history if e['id'] == run_id), None)
    if not entry:
        return jsonify({'error': 'Run not found'}), 404
    ilf = entry.get('iteration_log_file')
    if not ilf:
        return jsonify({'error': 'No iteration log file for this run'}), 404
    path = METRICS_DIR / ilf
    if not path.exists():
        return jsonify({'error': 'Iteration log file missing from disk'}), 404
    # Support both legacy JSON array and new JSONL format
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read().strip()
    if content.startswith('['):
        data = json.loads(content)
    else:
        data = [json.loads(line) for line in content.splitlines() if line.strip()]
    return jsonify({'iteration_logs': data, 'count': len(data)})


@app.route('/api/discover-ocdeclare', methods=['POST'])
def run_ocdeclare_discovery():
    """Discover OC-Declare model from OCEL 2.0 event log."""
    try:
        data = request.json
        event_log_file = data.get('eventLogFile')
        min_support = data.get('minSupport', 0.7)
        min_confidence = data.get('minConfidence', 0.85)
        noise_threshold = data.get('noiseThreshold', 0.15)
        lifecycle_threshold = data.get('lifecycleThreshold', 0.5)
        resource_threshold = data.get('resourceThreshold', 50.0)
        constraint_types = data.get('constraintTypes', {
            'precedence': True,
            'response': True,
            'not_coexistence': False,
            'chain_precedence': False,
            'chain_response': False,
            'coexistence': False,
            'absence': False
        })
        # Per-constraint-type thresholds (optional). Each key maps to a dict
        # with optional 'minSupport', 'minConfidence', 'noiseThreshold'.
        # Falls back to the global values above for any missing key or field.
        constraint_params = data.get('constraintParams', {})
        
        if not event_log_file:
            return jsonify({'error': 'Missing event log file'}), 400
        
        # Validate parameters
        if not (0 <= min_support <= 1):
            return jsonify({'error': 'min_support must be between 0 and 1'}), 400
        if not (0 <= min_confidence <= 1):
            return jsonify({'error': 'min_confidence must be between 0 and 1'}), 400
        if not (0 <= noise_threshold <= 1):
            return jsonify({'error': 'noise_threshold must be between 0 and 1'}), 400
        if not (0 <= lifecycle_threshold <= 1):
            return jsonify({'error': 'lifecycle_threshold must be between 0 and 1'}), 400
        if resource_threshold < 1:
            return jsonify({'error': 'resource_threshold must be >= 1'}), 400

        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Event log file not found: {event_log_file}'}), 404
        
        # Generate output filename with timestamp
        from datetime import datetime
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        log_basename = Path(event_log_file).stem
        output_filename = f'discovered_{log_basename}_{timestamp}.json'
        
        # Run discovery
        result = discover_ocdeclare_model(
            event_log_path=str(log_path),
            min_support=min_support,
            min_confidence=min_confidence,
            noise_threshold=noise_threshold,
            lifecycle_threshold=lifecycle_threshold,
            resource_threshold=resource_threshold,
            constraint_types=constraint_types,
            constraint_params=constraint_params,
            output_filename=output_filename,
            output_dir=str(OCDECLARE_DIR)
        )
        
        # Return results
        return jsonify({
            'success': True,
            'filename': output_filename,
            'model': result['model'],
            'stats': result['stats'],
            'parameters': result['parameters'],
            'start_activities_ranked': result.get('start_activities_ranked', [])
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


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
            from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict, parse_ocdeclare_list
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


@app.route('/api/analyze-blocking', methods=['POST'])
def analyze_blocking():
    """Dry-run simulation + static obligation saturation check to find blocking constraints."""
    try:
        import sys as _sys
        _sys.path.insert(0, str(BASE_DIR))
        from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict, parse_ocdeclare_list
        from src.Simulation.Engine.simulator import Simulator
        from src.Simulation.Domain.config import SimulationConfig, StartPolicy
        from src.Simulation.Domain.state import SimulationState
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
        from src.Simulation.Models.OCDeclare import parse_ocdeclare_dict, parse_ocdeclare_list
        from src.Simulation.Engine.simulator import Simulator
        from src.Simulation.Domain.config import SimulationConfig, StartPolicy
        from src.Simulation.Domain.state import SimulationState
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

        # Discover concurrency probabilities using the timing distributions as
        # the window reference (max of each pair's mean_seconds).
        concurrency = discover_concurrency_probs(event_log, activity_durations=metrics)

        # Store both in the discovery cache so the simulator can use them
        if event_log_file in discovery_cache:
            discovery_cache[event_log_file]['time_distributions'] = metrics
            discovery_cache[event_log_file]['concurrency_probs'] = concurrency

        return jsonify({
            'success': True,
            'metrics': metrics,
            'activity_count': len(metrics),
            'empty': len(metrics) == 0,
            'concurrency_probs': {k: v for k, v in concurrency.items() if '|||' in k and k.split('|||')[0] <= k.split('|||')[1]},
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

        from src.Simulation.Models.OCDeclare import (
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
                        from src.ParameterDiscovery.OCDeclarediscovery import load_ocel2
                        ocel_log = load_ocel2(str(log_path))
                    except Exception:
                        ocel_log = None

        if ocel_log and isinstance(ocel_log, dict) and 'objects' in ocel_log:
            from src.ParameterDiscovery.OCDeclarediscovery import discover_lifecycle
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
        resource_threshold = float(data.get('resourceThreshold', 50.0))

        if not event_log_file:
            return jsonify({'error': 'Missing eventLogFile parameter'}), 400

        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Event log file not found: {event_log_file}'}), 404

        event_log = load_ocel2(str(log_path))
        resource_type_names = discover_resource_types(event_log, resource_threshold)

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


if __name__ == '__main__':
    print("🚀 Starting Declarative OC Simulator Backend...")
    print(f"📁 OC-Declare models directory: {OCDECLARE_DIR}")
    print(f"📁 Event logs directory: {EVENTLOG_DIR}")
    print(f"📁 Output directory: {OUTPUT_DIR}")
    print("🌐 Server running on http://localhost:5000")
    print("💡 Make sure to run 'npm run dev' in the Frontend folder")
    
    app.run(debug=True, port=5000)
