"""Assemble the notebook's measures for the evaluation API.

Undefined numbers are serialized as null, never as zero or perfect scores.
Each comparison uses the full saved logs, not the UI's capped trace preview.
"""
from collections import Counter
import math

import numpy as np
import pandas as pd

from . import notebook_measures as nm


def json_safe(value):
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, np.generic):
        return json_safe(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value


def canonical_model(model):
    """Undo the UI's orientation adapter without substituting runtime caps.

Original from/to/counts remain authoritative when retained by the editor.
Older editor models have explicitly engine-oriented source/target fields;
precedence endpoints are reversed to produce the notebook's EP convention.
"""
    if not isinstance(model, dict):
        raise ValueError('Select an OC-Declare model with activities and constraints.')
    if model.get('constraint_orientation') == 'arc':
        return model
    constraints = []
    for i, c in enumerate(model.get('constraints', []), 1):
        if all(key in c for key in ('from', 'to', 'counts', 'arc_type')):
            constraints.append(dict(c))
            continue
        kind = c.get('constraint_type') or c.get('type')
        arrows = {'response': 'EF', 'precedence': 'EP',
                  'not_succession': 'EF', 'not_precedence': 'EP'}
        if kind not in arrows:
            raise NotImplementedError(f'Constraint {i}: unsupported constraint type {kind!r}; the notebook supports EF/EP.')
        source = c.get('source_activity') or c.get('source')
        target = c.get('target_activity') or c.get('target')
        if not source or not target:
            raise ValueError(f'Constraint {i}: missing source or target activity.')
        arrow = arrows[kind]
        if arrow == 'EP':
            source, target = target, source
        scope = c.get('scope') or {}
        involvement = c.get('involvement_per_label')
        if involvement is None:
            involvement = scope.get('involvement_per_label')
        if involvement is None:
            involvement = dict(scope.get('bindings') or [])
            if not involvement and scope.get('object_type'):
                involvement = {scope['object_type']: scope.get('kind', 'each')}
        bounds = [0, 0] if kind.startswith('not_') else [c.get('nmin', 1), c.get('nmax')]
        constraints.append({**c, 'from': source, 'to': target, 'arc_type': arrow,
                            'counts': bounds, 'involvement_per_label': involvement})
    return {**model, 'constraint_orientation': 'arc', 'constraints': constraints,
            'activities': [a if isinstance(a, dict) else {'name': a} for a in model.get('activities', [])],
            'object_types': [o if isinstance(o, dict) else {'name': o} for o in model.get('object_types', [])]}


def _kl(reference, simulated):
    keys, p, q = nm.smoothed_probabilities(reference, simulated)
    forward, reverse = p * np.log2(p / q), q * np.log2(q / p)
    na, nb = sum(reference.values()), sum(simulated.values())
    return {
        'smoothing': nm.SMOOTHING,
        'KL_input||simulated_bits': float(forward.sum()),
        'KL_simulated||input_bits': float(reverse.sum()),
        'n_categories': len(keys), 'n_input': na, 'n_simulated': nb,
        'only_in_input': sorted(set(reference) - set(simulated)),
        'only_in_simulated': sorted(set(simulated) - set(reference)),
        'details': [dict(category=k, count_input=reference.get(k, 0),
                         count_simulated=simulated.get(k, 0),
                         p_input_raw=reference.get(k, 0) / na,
                         p_simulated_raw=simulated.get(k, 0) / nb,
                         p_input_smoothed=p[i], p_simulated_smoothed=q[i],
                         contribution_bits=forward[i]) for i, k in enumerate(keys)],
    }


def _wmape(reference, simulated):
    shared = sorted(set(reference) & set(simulated))
    if not shared:
        raise ValueError('No shared activities with service-time estimates.')
    rows = [dict(activity=a,
                 mean_h_input=reference[a]['service_mean'] / 3600,
                 mean_h_simulated=simulated[a]['service_mean'] / 3600,
                 std_h_input=reference[a]['service_std'] / 3600,
                 std_h_simulated=simulated[a]['service_std'] / 3600,
                 source_input=reference[a]['estimation_source'],
                 source_simulated=simulated[a]['estimation_source'],
                 n_selected_input=reference[a]['n_selected_observations'],
                 n_selected_simulated=simulated[a]['n_selected_observations']) for a in shared]
    return {
        'mean': nm.calculate_wmape([r['mean_h_input'] for r in rows], [r['mean_h_simulated'] for r in rows]),
        'std': nm.calculate_wmape([r['std_h_input'] for r in rows], [r['std_h_simulated'] for r in rows]),
        'activities_compared': len(shared), 'activities_total': len(set(reference) | set(simulated)),
        'only_in_input': sorted(set(reference) - set(simulated)),
        'only_in_simulated': sorted(set(simulated) - set(reference)), 'details': rows,
    }


def _wasserstein(reference, simulated):
    samples_input = nm.load_selected_samples(reference, 'input')
    samples_simulated = nm.load_selected_samples(simulated, 'simulated')
    all_activities = sorted(set(reference) | set(simulated))
    rows, excluded = [], []
    for activity in all_activities:
        reason = None
        if activity not in reference:
            reason = 'Missing from input discovery results'
        elif activity not in simulated:
            reason = 'Missing from simulated discovery results'
        elif 'anchor' in (reference[activity]['estimation_source'], simulated[activity]['estimation_source']):
            reason = 'Anchor parameters used in one or both logs'
        else:
            xa, xb = samples_input[activity], samples_simulated[activity]
            if len(xa) < 1 or len(xb) < 1:
                reason = f'Insufficient selected samples: input={len(xa)}, simulated={len(xb)}'
        if reason:
            excluded.append({'activity': activity, 'reason': reason})
            continue
        actual, generated = reference[activity], simulated[activity]
        if actual['estimation_window'] != generated['estimation_window']:
            raise ValueError(f'{activity!r}: discovery windows differ between logs.')
        distance = float(nm.wasserstein_distance(xa, xb))
        ma, mb = float(xa.mean()), float(xb.mean())
        rows.append(dict(activity=activity, window=actual['estimation_window'],
                         source_input=actual['estimation_source'], source_simulated=generated['estimation_source'],
                         n_input=len(xa), n_simulated=len(xb), mean_h_input=ma, mean_h_simulated=mb,
                         W1_hours=distance, W1_norm=distance / ma if ma > 0 else np.nan,
                         mean_gap_h=abs(ma - mb)))
    frame = pd.DataFrame(rows)
    scored = {r['activity'] for r in rows}
    return {
        'activities_scored': len(rows), 'activities_total': len(all_activities),
        'W1_weighted_hours': nm.weighted_w1(frame),
        'W1_unweighted_hours': float(frame['W1_hours'].mean()) if rows else np.nan,
        'W1_median_hours': float(frame['W1_hours'].median()) if rows else np.nan,
        'input_selected_sample_coverage': nm.selected_sample_coverage(samples_input, scored, reference),
        'simulated_selected_sample_coverage': nm.selected_sample_coverage(samples_simulated, scored, simulated),
        'details': rows, 'excluded': excluded,
    }


def _attempt(fn):
    try:
        return {'status': 'ok', **fn()}
    except (ValueError, KeyError, TypeError, NotImplementedError) as exc:
        return {'status': 'unavailable', 'reason': str(exc)}


def _model_scores(raw, model):
    idx = nm.build_index(raw)
    per_constraint, confidence = nm.evaluate_confidence(idx, model)
    incidents, violations_by_constraint, violations = nm.constraint_violation_report(idx, model)
    coverage, coverage_details = nm.model_coverage(idx, {o['type'] for o in raw['objects']}, model)
    # Detailed activation incidents can be enormous; the UI uses the exact
    # summaries and per-constraint counts, all calculated over the complete log.
    return {'confidence': confidence, 'violations': violations,
            'constraints': violations_by_constraint.to_dict('records'),
            'coverage': coverage, 'coverage_details': coverage_details.to_dict('records')}


def evaluate_logs(input_raw, simulated_raw, model=None, service_time_mode='minimum', anchor_activities=None):
    if service_time_mode not in {'minimum', 'p25', 'p50'}:
        raise ValueError('serviceTimeMode must be minimum, p25, or p50.')
    if not isinstance(anchor_activities or [], list):
        raise ValueError('anchorActivities must be a list.')
    result = {
        'method': 'evaluationmeasures.ipynb', 'method_version': 1,
        'reference_sha256': nm.REFERENCE_NOTEBOOK_SHA256,
        'settings': {'smoothing': 0.5, 'service_time_mode': service_time_mode,
                     'anchor_activities': anchor_activities or [], 'w1_min_samples': 1, 'ngram_sizes': [2, 3]},
        'logs': {},
    }
    logs = {'simulated': simulated_raw}
    if input_raw is not None:
        logs = {'input': input_raw, **logs}
    for role, raw in logs.items():
        if not isinstance(raw, dict) or not isinstance(raw.get('events'), list) or not isinstance(raw.get('objects'), list):
            raise ValueError(f'{role}: the notebook requires OCEL 2.0 JSON events and objects lists.')
        result['logs'][role] = {'events': len(raw['events']), 'objects': len(raw['objects'])}

    def model_comparison():
        canonical = canonical_model(model)
        normalized = nm.load_confidence_model(canonical)
        return {'model': canonical, **{role: _model_scores(raw, normalized) for role, raw in logs.items()}}
    result['conformance'] = _attempt(model_comparison)

    if input_raw is None:
        result['comparison'] = {'status': 'unavailable', 'reason': 'Select an input log to compare with the simulation.'}
        return json_safe(result)
    result['comparison'] = {'status': 'ok'}
    a, b = nm.load_ocel(input_raw), nm.load_ocel(simulated_raw)
    result['kl'] = {
        'activities': _attempt(lambda: _kl(Counter(e[1] for e in a['events']), Counter(e[1] for e in b['events']))),
        **{basis: _attempt(lambda basis=basis: _kl(nm.type_counts(a, basis), nm.type_counts(b, basis)))
           for basis in ('objects', 'relations')},
    }

    def timing():
        ref = nm.discover_service_times(input_raw, service_time_mode, anchor_activities)
        sim = nm.discover_service_times(simulated_raw, service_time_mode, anchor_activities)
        # Retained sample counts/sources accompany every reported distance.
        return {'wmape': _attempt(lambda: _wmape(ref, sim)),
                'wasserstein': _attempt(lambda: _wasserstein(ref, sim)),
                'service_times': {role: {act: {k: v for k, v in stats.items() if k != 'service_samples_seconds'}
                                         for act, stats in values.items()}
                                  for role, values in [('input', ref), ('simulated', sim)]}}
    result['timing'] = _attempt(timing)

    def ngd():
        ref, sim = nm.load_ngd_log(input_raw), nm.load_ngd_log(simulated_raw)
        types = sorted(ref['declared_types'] | sim['declared_types'])
        rows = [nm.relative_ngd(ref, sim, ot, n) for n in (2, 3) for ot in [*types, None]]
        return {'summary': {f"NGD_{r['n']}gram_relative": r['NGD_relative'] for r in rows if r['scope'] == 'pooled'},
                'details': rows,
                'only_in_input': sorted(ref['declared_types'] - sim['declared_types']),
                'only_in_simulated': sorted(sim['declared_types'] - ref['declared_types']),
                'diagnostics': {role: {k: v for k, v in log.items() if k not in ('sequences', 'declared_types')}
                                for role, log in [('input', ref), ('simulated', sim)]}}
    result['ngd'] = _attempt(ngd)
    return json_safe(result)
