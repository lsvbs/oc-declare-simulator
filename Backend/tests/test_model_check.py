"""Regression tests for discovery's OC-Declare count adjustment.

Run from the project root: python3 -m unittest discover -s Backend/tests -v
"""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from Backend import server
from Backend.src.Evaluation import notebook_measures as nm
from Backend.src.Evaluation.service import check_model_counts
from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict


def event(eid, activity, hour, *objects):
    return {'id': eid, 'type': activity, 'time': f'2026-01-01T{hour:02}:00:00Z',
            'relationships': [{'objectId': oid} for oid in objects]}


def log(events):
    return {'objects': [{'id': oid, 'type': typ} for oid, typ in
                        [('c1', 'Container'), ('c2', 'Container'), ('v1', 'Vehicle'), ('v2', 'Vehicle')]],
            'events': events}


def arc(kind, source='A', target='B', scope=None):
    return {'from': source, 'to': target, 'arc_type': kind, 'counts': [1, None],
            'involvement_per_label': scope if scope is not None else {'Container': 'Each'}}


def model(*constraints):
    return {'constraint_orientation': 'arc', 'constraints': list(constraints),
            'activities': [{'name': a} for a in ('A', 'B', 'C')],
            'object_types': [{'name': t} for t in ('Container', 'Vehicle')]}


def observed(report):
    return [(r['observedNmin'], r['observedNmax']) for r in report['constraintResults']]


class ModelCountTests(unittest.TestCase):
    def test_precedence_counts_predecessors_for_each_target_activation(self):
        raw = log([event('a', 'A', 1, 'c1'), event('b1', 'B', 2, 'c1'), event('b2', 'B', 3, 'c1')])
        report = check_model_counts(raw, model(arc('EP', 'B', 'A'), arc('EF')))
        self.assertEqual(observed(report), [(1, 1), (2, 2)])
        self.assertEqual([r['total'] for r in report['constraintResults']], [2, 1])

    def test_engine_orientation_and_scope_bindings_match_canonical_arcs(self):
        raw = log([event('a', 'A', 1, 'c1', 'v1'), event('b', 'B', 2, 'c1', 'v1')])
        canonical = model(arc('EP', 'B', 'A', {'Container': 'Each', 'Vehicle': 'Each'}))
        engine = {'constraints': [{
            'constraint_type': 'precedence', 'source_activity': 'A', 'target_activity': 'B',
            'scope': {'bindings': [['Container', 'each'], ['Vehicle', 'each']]},
            'nmin': 1, 'nmax': None,
            # Stale import fields must not override the edited engine fields.
            'from': 'wrong', 'to': 'wrong', 'counts': [0, 99], 'arc_type': 'EP',
        }]}
        self.assertEqual(observed(check_model_counts(raw, engine)), observed(check_model_counts(raw, canonical)))

    def test_joint_each_scope_excludes_partial_matches_and_missing_domain(self):
        raw = log([event('a', 'A', 1, 'c1', 'v1'), event('b', 'B', 2, 'c1', 'v1'),
                   event('partial', 'B', 3, 'c1', 'v2'), event('vacuous', 'A', 4, 'c2')])
        report = check_model_counts(raw, model(arc('EF', scope={'Container': 'Each', 'Vehicle': 'Each'})))
        self.assertEqual(observed(report), [(1, 1)])
        self.assertEqual(report['constraintResults'][0]['vacuous'], 1)

    def test_each_cartesian_all_and_any_are_distinct(self):
        raw = log([event('a', 'A', 1, 'c1', 'c2', 'v1', 'v2'),
                   event('b1', 'B', 2, 'c1', 'v1'), event('b2', 'B', 3, 'c2', 'v2')])
        report = check_model_counts(raw, model(
            arc('EF', scope={'Container': 'Each', 'Vehicle': 'Each'}),
            arc('EF', scope={'Container': 'All'}),
            arc('EF', scope={'Container': 'Any'})))
        self.assertEqual(observed(report), [(0, 1), (0, 0), (2, 2)])
        both = log([event('a', 'A', 1, 'c1', 'c2'), event('b', 'B', 2, 'c1', 'c2')])
        self.assertEqual(observed(check_model_counts(both, model(arc('EF', scope={'Container': 'Any'})))), [(1, 1)])

    def test_direct_arcs_use_nearest_scoped_timestamp_not_global_neighbor(self):
        raw = log([event('a', 'A', 1, 'c1'), event('unrelated', 'C', 2, 'c2'),
                   event('b1', 'B', 3, 'c1'), event('b2', 'B', 3, 'c1')])
        report = check_model_counts(raw, model(arc('DF'), arc('DP', 'B', 'A')))
        self.assertEqual(observed(report), [(2, 2), (1, 1)])
        raw['events'].append(event('intervening', 'C', 2, 'c1'))
        self.assertEqual(observed(check_model_counts(raw, model(arc('DF'), arc('DP', 'B', 'A')))), [(0, 0), (0, 0)])

    def test_equal_time_does_not_satisfy_temporal_arcs_but_as_is_unordered(self):
        raw = log([event('a', 'A', 2, 'c1'), event('b', 'B', 2, 'c1')])
        report = check_model_counts(raw, model(*(arc(kind) for kind in ('EF', 'EP', 'DF', 'DP', 'AS'))))
        self.assertEqual(observed(report), [(0, 0)] * 4 + [(1, 1)])

    def test_no_evidence_is_distinct_from_a_real_zero_count(self):
        raw = log([event('a', 'A', 1, 'c1')])
        report = check_model_counts(raw, model(arc('EF'), arc('EF', 'B', 'A'),
                                              arc('EF', scope={'Vehicle': 'Each'})))
        self.assertEqual(observed(report), [(0, 0), (None, None), (None, None)])
        self.assertIsNone(report['constraintResults'][1]['confidence'])
        self.assertEqual(report['constraintResults'][2]['vacuous'], 1)

    def test_empty_model_and_empty_log_have_no_invented_observations(self):
        self.assertEqual(check_model_counts(log([]), {})['constraintResults'], [])
        report = check_model_counts(log([]), model(arc('EF')))
        self.assertEqual(observed(report), [(None, None)])
        self.assertIsNone(report['globalConformance'])

    def test_default_evaluation_report_and_confidence_are_unchanged(self):
        raw = log([event('a', 'A', 1, 'c1'), event('b', 'B', 2, 'c2')])
        original = model(arc('EF'))
        before = copy.deepcopy(original)
        table, summary = nm.evaluate_confidence(nm.build_index(raw), nm.load_confidence_model(original))
        report = check_model_counts(raw, original)
        self.assertEqual(list(table.columns), nm.REPORT_COLUMNS)
        self.assertEqual(report['globalConformance'], summary['global_confidence'])
        self.assertEqual(report['globalConformance'], 0.5)
        self.assertEqual(original, before)

    def test_guard_and_indirect_scope_are_rejected_instead_of_silently_ignored(self):
        for constraint in [dict(arc('EF'), guard='amount > 5'), arc('EF', scope={'Container>Vehicle': 'Each'})]:
            with self.subTest(constraint=constraint), self.assertRaises(NotImplementedError):
                check_model_counts(log([]), model(constraint))

    def test_zero_dp_bounds_reach_simulator_without_becoming_succession(self):
        edited = model(dict(arc('DP', 'B', 'A'), counts=[0, 0]))
        static = parse_ocdeclare_dict(edited)
        constraint = static.constraints[0]
        self.assertEqual((constraint.constraint_type, constraint.source_activity,
                          constraint.target_activity, constraint.nmin, constraint.nmax),
                         ('chain_precedence', 'A', 'B', 0, 0))


class ModelCheckApiTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def test_api_accepts_ocel2_and_ocel1_and_does_not_change_files(self):
        raw = log([event('a', 'A', 1, 'c1'), event('b1', 'B', 2, 'c1'), event('b2', 'B', 3, 'c1')])
        legacy = {'ocel:objects': {o['id']: {'ocel:type': o['type']} for o in raw['objects']},
                  'ocel:events': {e['id']: {'ocel:activity': e['type'], 'ocel:timestamp': e['time'],
                                          'ocel:omap': [r['objectId'] for r in e['relationships']]}
                                  for e in raw['events']}}
        with tempfile.TemporaryDirectory() as folder, patch.object(server, 'EVENTLOG_DIR', Path(folder)):
            for filename, content in [('input.json', raw), ('input.jsonocel', legacy)]:
                path = Path(folder) / filename
                path.write_text(json.dumps(content))
                before = path.read_bytes()
                response = self.client.post('/api/model-check', json={
                    'eventLogFile': filename, 'modelOverride': model(arc('EP', 'B', 'A'))})
                self.assertEqual(response.status_code, 200, response.get_json())
                self.assertEqual(observed(response.get_json()), [(1, 1)])
                self.assertEqual(path.read_bytes(), before)

    def test_api_rejects_missing_inputs_and_path_escape(self):
        for body in [[], {}, {'eventLogFile': 'x'},
                     {'eventLogFile': '../outside.json', 'modelOverride': model(arc('EF'))}]:
            with self.subTest(body=body):
                self.assertEqual(self.client.post('/api/model-check', json=body).status_code, 400)
        self.assertEqual(self.client.post('/api/model-check', json={
            'eventLogFile': 'nonexistent-regression-log.json', 'modelOverride': model(arc('EF'))}).status_code, 404)

    def test_api_reports_unsupported_guard_as_error_without_bounds(self):
        response = self.client.post('/api/model-check', json={
            'eventLogFile': 'container_logistics.json',
            'modelOverride': model(dict(arc('EF'), guard='amount > 5'))})
        self.assertEqual(response.status_code, 400)
        self.assertIn('bounds were not applied', response.get_json()['error'])
        self.assertNotIn('constraintResults', response.get_json())

    def test_container_logistics_regression(self):
        # Tracked input fixture, independent of ignored discovered-model files.
        constraints = [
            arc('EP', 'Load Truck', 'Pick Up Empty Container'),
            arc('EP', 'Reschedule Container', 'Book Vehicles', {'Vehicle': 'Each'}),
            arc('EF', 'Reschedule Container', 'Depart',
                {'Container': 'Each', 'Transport Document': 'Each', 'Vehicle': 'Each'}),
            arc('EF', 'Reschedule Container', 'Load to Vehicle', {'Container': 'Each', 'Vehicle': 'Each'}),
        ]
        response = self.client.post('/api/model-check', json={
            'eventLogFile': 'container_logistics.json', 'modelOverride': model(*constraints)})
        self.assertEqual(response.status_code, 200, response.get_json())
        report = response.get_json()
        self.assertEqual(observed(report), [(1, 1), (3, 11), (1, 1), (1, 1)])
        self.assertEqual(report['totalEvents'], 35372)
        self.assertEqual(report['constraintResults'][2]['total'], 36)
        self.assertEqual(report['constraintResults'][2]['vacuous'], 1)


if __name__ == '__main__':
    unittest.main()
