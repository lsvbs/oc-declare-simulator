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
                'likely_end_activities':   likely_end,
                'trace_end_prob':          trace_end_prob,
                'trace_position':          trace_position,
                'prob_matrix': {
                    src: {tgt: round(float(cnt), 4) for tgt, cnt in tgts.items()}
                    for src, tgts in prob_matrix.items()
                },
            },
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
    return jsonify({
        'step_count': state.step_count if state else 0,
        'events_count': len(state.executed_events) if state else 0,
        'objects_count': len(state.objects) if state else 0,
        'done': run['done'],
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
        max_steps = int(data.get('maxSteps', 50))
        print(f"[simulate] maxSteps received: {max_steps}", flush=True)
        seed = int(data.get('seed', 42))
        # Accept either startActivities (list, new) or startActivity (string, legacy)
        start_activities = data.get('startActivities')
        if not start_activities:
            sa = data.get('startActivity')
            start_activities = [sa] if sa else []
        model_override = data.get('modelOverride')            # full edited model dict (optional)
        prob_matrix_override = data.get('probMatrixOverride') # normalised prob matrix (optional)

        if not event_log_file or not start_activities:
            return jsonify({'error': 'Missing required configuration'}), 400
        if not ocdeclare_file and not model_override:
            return jsonify({'error': 'Either ocdeclareFile or modelOverride is required'}), 400
        
        # Check if discovery has been run for this event log
        if event_log_file not in discovery_cache:
            return jsonify({'error': 'Discovery not run for this event log. Please run discovery first.'}), 400
        
        # Get cached discovery results
        cached = discovery_cache[event_log_file]
        prob_matrix = cached['prob_matrix']
        time_distributions = cached['time_distributions']

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
        from collections import deque
        _LOG_CAP = 500  # only keep last 500 steps in the response to avoid huge payloads
        iteration_logs = deque(maxlen=_LOG_CAP)
        # No upfront skipping — the deque's maxlen naturally keeps only the last 500
        # entries, so early steps are evicted as the simulation progresses. This also
        # ensures the trace is populated when the simulation stops before max_steps.

        def trace_func(event: str, payload: dict):
            if event == "iteration":
                step = payload.get("step_count", "?")
                candidates = payload.get("candidate_activity_names", [])
                # Build per-candidate detail: prob + participating object IDs
                candidates_detail = payload.get("candidates", [])
                candidates_with_probs = [
                    {
                        "activity": a,
                        "prob": _last_prob_map.get(a, None),
                        "objects": next(
                            (c.get("participating_object_ids", []) for c in candidates_detail
                             if c.get("activity_name") == a),
                            []
                        ),
                    }
                    for a in candidates
                ]
                iteration_logs.append({
                    "step": step,
                    "event": "candidates",
                    "candidates": candidates,
                    "candidates_with_probs": candidates_with_probs,
                    "num_candidates": payload.get("num_candidates", 0),
                })
            elif event == "chosen":
                activity = payload.get("activity_name", "?")
                objects = payload.get("participating_object_ids", [])
                creates = payload.get("object_types_to_create", [])
                iteration_logs.append({
                    "step": None,
                    "event": "chosen",
                    "activity": activity,
                    "prob": _last_prob_map.get(activity, None),
                    "objects": objects,
                    "creates": creates,
                })
            elif event == "stop":
                iteration_logs.append({
                    "step": payload.get("step_count", "?"),
                    "event": "stop",
                    "reason": payload.get("reason", "unknown"),
                })

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
            }

        result_holder = [None]
        def _run():
            result_holder[0] = simulator.run_des(state=initial_state)
            if run_id and run_id in _active_runs:
                _active_runs[run_id]['done'] = True

        t = threading.Thread(target=_run, daemon=True)
        t.start()
        t.join()  # Flask request stays open until done; frontend polls status in parallel
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
            'seed':           seed,
            'start_activities': start_activities,
            'steps_executed': final_state.step_count,
            'events_count':   len(final_state.executed_events),
            'objects_count':  len(final_state.objects),
            'output_file':    output_filename,
            'metrics_file':   metrics_filename,
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
                # metrics intentionally omitted from inline response — can be very large
                # (hundreds of MB for big runs). Use GET /api/run-history/{id}/metrics
                # or the Download Metrics button to access the full data.
                'metrics': {
                    'activity_metrics': metrics.get('activity_metrics', {}),
                    # object_metrics omitted — too large; available via metrics file download
                },
                'audit': audit,
                'concurrency_pairs': concurrency_pairs,
                'resource_types': list(static_model.resource_types or []),
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
            'iteration_logs': list(iteration_logs)
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
            steps=20,
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

        if not event_log_file:
            return jsonify({'error': 'Missing eventLogFile parameter'}), 400

        log_path = EVENTLOG_DIR / event_log_file
        if not log_path.exists():
            return jsonify({'error': f'Event log file not found: {event_log_file}'}), 404

        # Use the OCEL 2.0 loader (NOT load_event_log, which returns activity-name
        # traces). compute_ocpa_metrics needs the normalised dict with per-event
        # timestamps, activities and object maps.
        event_log = load_ocel2(str(log_path))
        metrics = compute_ocpa_metrics(event_log, anchor_activities)

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
