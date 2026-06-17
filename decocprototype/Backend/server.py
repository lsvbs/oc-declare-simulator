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
from src.ParameterDiscovery.OCDeclarediscovery import discover_ocdeclare_model, compute_ocpa_metrics, load_ocel2, discover_concurrency_probs
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
        
        # Load event log
        event_log = load_event_log(str(log_path))
        
        # Discover transition probabilities
        prob_matrix = discover_transition_matrix(event_log)
        
        # Time distributions discovery (optional, for future use)
        time_distributions = {}  # Placeholder for now
        
        # Extract activities from probability matrix
        activities = sorted(set(prob_matrix.keys()))

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
        if isinstance(event_log, dict):
            # OCEL 2.0 format
            total_events = len(event_log.get('events', []))
            total_objects = len(event_log.get('objects', []))
        elif isinstance(event_log, list):
            # Simple list format (list of traces)
            total_events = sum(len(trace) for trace in event_log)
            total_objects = 0  # Not available in simple format
        else:
            total_events = 0
            total_objects = 0
        
        # Calculate transition statistics
        transition_count = sum(len(targets) for targets in prob_matrix.values())
        
        # Store in cache for later simulation use
        discovery_cache[event_log_file] = {
            'prob_matrix': prob_matrix,
            'time_distributions': time_distributions,
            'activities': activities,
            'event_log': event_log
        }
        
        return jsonify({
            'success': True,
            'results': {
                'activities': activities,
                'activity_count': len(activities),
                'total_events': total_events,
                'total_objects': total_objects,
                'transition_count': transition_count,
                'time_distributions_discovered': len(time_distributions) > 0,
                'first_activity': first_activity,
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

        # Normalise each row of the probability matrix so values are in [0, 1]
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


def _safe_parameters_path(filename: str) -> Path | None:
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


@app.route('/api/simulate', methods=['POST'])
def run_simulation():
    """Run simulation with provided configuration using cached discovery results."""
    try:
        data = request.json
        
        # Extract configuration
        ocdeclare_file = data.get('ocdeclareFile')
        event_log_file = data.get('eventLogFile')
        max_steps = int(data.get('maxSteps', 50))
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
        iteration_logs = []

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

        simulator = Simulator(
            static_model, 
            config, 
            rng=None, 
            select_func=select_with_matrix,
            trace_func=trace_func,
        )
        
        final_state = simulator.run(state=initial_state)
        
        # Generate results
        obj_types = Counter(obj.object_type for obj in final_state.objects.values())
        activity_sequence = [e.activity_name for e in final_state.executed_events]

        # Per-object traces: object_id → ordered list of activity names
        object_traces: dict[str, list[str]] = {}
        for event in final_state.executed_events:
            for oid in event.object_ids:
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
                'object_types_map': object_types_map,
                'object_links': object_links,
                'output_file': output_filename,
                'metrics_file': metrics_filename,
                'metrics': metrics,
                'concurrency_pairs': concurrency_pairs,
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
            'iteration_logs': iteration_logs
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
    with open(path, 'r', encoding='utf-8') as f:
        return jsonify(json.load(f))


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
