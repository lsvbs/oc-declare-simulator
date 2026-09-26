"""First/last activity shares and their application through lifecycle discovery."""
import json
import tempfile
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from Backend.src.ParameterDiscovery.lifecycle import discover_lifecycle
from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.Engine.simulator import Simulator
from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict


def log_from_traces(traces, object_type='Order'):
    log = {'objects': {}, 'events': {}}
    for index, trace in enumerate(traces):
        oid = f'{object_type}_{index}'
        log['objects'][oid] = {'type': object_type}
        for position, activity in enumerate(trace):
            log['events'][f'{oid}_{position}'] = {
                'activity': activity,
                'timestamp': (datetime(2025, 1, 1) + timedelta(seconds=position)).isoformat(),
                'omap': [oid],
            }
    return log


class LifecycleShareTests(unittest.TestCase):
    def test_exactly_ninety_percent_qualifies_but_eighty_nine_does_not(self):
        for count in (89, 90, 91, 100):
            with self.subTest(count=count):
                log = log_from_traces([['Start', 'Finish']] * count +
                                      [['OtherStart', 'OtherFinish']] * (100-count))
                expected = ({'Start'}, {'Finish'}) if count >= 90 else (set(), set())
                self.assertEqual(expected, discover_lifecycle(log, 'Order'))

    def test_creation_and_deactivation_are_independent_for_same_activity(self):
        log = log_from_traces([['A', 'Middle', 'A']] * 9 + [['B', 'C']])
        self.assertEqual(({'A'}, {'A'}), discover_lifecycle(log, 'Order'))

    def test_first_and_last_can_qualify_independently(self):
        log = log_from_traces([['Start', 'Finish']] * 8 + [['Start', 'OtherFinish']] * 2)
        self.assertEqual(({'Start'}, set()), discover_lifecycle(log, 'Order'))
        log = log_from_traces([['Start', 'Finish']] * 8 + [['OtherStart', 'Finish']] * 2)
        self.assertEqual((set(), {'Finish'}), discover_lifecycle(log, 'Order'))

    def test_rare_endpoint_gets_no_exception(self):
        log = log_from_traces([['Start', 'Finish']] * 19 + [['Start', 'RareEnd']])
        self.assertEqual(({'Start'}, {'Finish'}), discover_lifecycle(log, 'Order'))

    def test_single_event_objects_can_receive_both_flags(self):
        log = log_from_traces([['A']] * 9 + [['B']])
        self.assertEqual(({'A'}, {'A'}), discover_lifecycle(log, 'Order'))

    def test_denominator_is_per_type_and_includes_objects_without_events(self):
        log = log_from_traces([['Start', 'Finish']] * 8 + [[], []])
        items = log_from_traces([['Pack', 'Ship']] * 9 + [[]], 'Item')
        for key in log:
            log[key].update(items[key])
        self.assertEqual((set(), set()), discover_lifecycle(log, 'Order'))
        self.assertEqual(({'Pack'}, {'Ship'}), discover_lifecycle(log, 'Item'))

    def test_repeated_events_do_not_increase_an_objects_vote(self):
        log = log_from_traces([['Frequent'] * 100] + [['Other']] * 9)
        self.assertEqual(({'Other'}, {'Other'}), discover_lifecycle(log, 'Order'))

    def test_chronological_order_uses_timezone_and_event_id_for_ties(self):
        events = {
            'e3': {'activity': 'Last', 'timestamp': '2025-01-01T10:00:00Z', 'omap': ['o']},
            'e1': {'activity': 'First', 'timestamp': '2025-01-01T11:00:00+02:00', 'omap': ['o']},
            'e2': {'activity': 'Middle', 'timestamp': '2025-01-01T10:00:00Z', 'omap': ['o']},
        }
        for ordered in (events, dict(reversed(list(events.items())))):
            log = {'objects': {'o': {'type': 'Order'}}, 'events': ordered}
            self.assertEqual(({'First'}, {'Last'}), discover_lifecycle(log, 'Order'))

    def test_raw_ocel_arrays_and_duplicate_relationships(self):
        log = {
            'objects': [{'id': 'o', 'type': 'Order'}],
            'events': [{'id': 'e', 'type': 'A', 'time': '2025-01-01T00:00:00Z',
                        'relationships': [{'objectId': 'o'}, {'objectId': 'o'}]}],
        }
        self.assertEqual(({'A'}, {'A'}), discover_lifecycle(log, 'Order'))

    def test_trace_list_uses_the_same_share_rule(self):
        self.assertEqual(({'Start'}, {'Finish'}), discover_lifecycle(
            [['Start', 'Finish']] * 9 + [['Other']], 'case'))
        self.assertEqual((set(), set()), discover_lifecycle(
            [['Start', 'Finish']] * 8 + [[], []], 'case'))

    def test_empty_log_and_absent_type_have_no_flags(self):
        for log in ([], {'objects': {}, 'events': {}}, log_from_traces([['A']], 'Other')):
            self.assertEqual((set(), set()), discover_lifecycle(log, 'Order'))

    def test_threshold_overrides_are_explicit_and_validated(self):
        log = log_from_traces([['Start', 'Finish']] * 8 + [['Other']] * 2)
        self.assertEqual(({'Start'}, {'Finish'}), discover_lifecycle(log, 'Order', 0.8))
        for value in (0, -0.1, 1.1, float('nan'), float('inf'), True, None, 'bad'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                discover_lifecycle(log, 'Order', value)

    def test_missing_timestamp_is_not_treated_as_a_first_event(self):
        log = log_from_traces([['Start']])
        log['events']['Order_0_0']['timestamp'] = None
        with self.assertRaisesRegex(ValueError, 'valid timestamp'):
            discover_lifecycle(log, 'Order')


class LifecycleDiscoveryApiTests(unittest.TestCase):
    def setUp(self):
        from Backend import server
        self.server = server
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(server, 'OCDECLARE_DIR', self.directory))
        self.stack.enter_context(patch.object(server, 'EVENTLOG_DIR', self.directory))
        self.stack.enter_context(patch.dict(server.discovery_cache, {}, clear=True))
        self.client = server.app.test_client()
        # Deliberately stale flags: rediscovery must remove these assignments.
        self.model = {
            'object_types': ['Order'],
            'activities': [{'name': name, 'bindings': [{'object_type': 'Order',
                'min_count': 1, 'max_count': 1, 'creates': True, 'deactivates': True}]}
                for name in ('Start', 'Finish')],
            'constraints': [
                {'type': 'response', 'source': 'Start', 'target': 'Finish',
                 'scope': {'kind': 'each', 'object_type': 'Order'}, 'nmin': 1},
                {'type': 'precedence', 'source': 'Start', 'target': 'Finish',
                 'scope': {'kind': 'each', 'object_type': 'Order'}, 'nmin': 1},
            ],
        }
        self.model_path = self.directory/'model.json'
        self.model_path.write_text(json.dumps(self.model))
        self.log_path = self.directory/'log.json'
        self.log_path.write_text(json.dumps(log_from_traces(
            [['Start', 'Finish']] * 9 + [['OtherStart', 'OtherEnd']])))
        self.payload = {'ocdeclareFile': 'model.json', 'eventLogFile': 'log.json'}

    def derive(self, **overrides):
        response = self.client.post('/api/derive-lifecycle', json={**self.payload, **overrides})
        self.assertEqual(200, response.status_code, response.json)
        return response.json

    @staticmethod
    def flags(result):
        return {a['name']: (a['bindings'][0]['creates'], a['bindings'][0]['deactivates'])
                for a in result['model']['activities']}

    def test_default_threshold_replaces_stale_flags_without_editing_source(self):
        before = self.model_path.read_bytes(), self.log_path.read_bytes()
        result = self.derive()
        self.assertEqual(0.9, result['lifecycle_threshold'])
        self.assertEqual('ocel', result['method'])
        self.assertEqual({'Start': (True, False), 'Finish': (False, True)}, self.flags(result))
        self.assertEqual(parse_ocdeclare_dict(self.model).constraints,
                         parse_ocdeclare_dict(result['model']).constraints)
        self.assertEqual(before, (self.model_path.read_bytes(), self.log_path.read_bytes()))

    def test_no_qualifying_activity_clears_flags_instead_of_guessing(self):
        self.log_path.write_text(json.dumps(log_from_traces(
            [['Start', 'Finish']] * 8 + [['OtherStart', 'OtherEnd']] * 2)))
        result = self.derive()
        self.assertEqual({'Start': (False, False), 'Finish': (False, False)}, self.flags(result))
        self.assertIn('Order: no creating activity meets the threshold', result['summary'])
        self.assertIn('Order: no deactivating activity meets the threshold', result['summary'])

    def test_cached_log_uses_threshold_and_explicit_override(self):
        self.server.discovery_cache['log.json'] = {'event_log_ocel': log_from_traces(
            [['Start', 'Finish']] * 8 + [['OtherStart', 'OtherEnd']] * 2)}
        self.assertEqual({'Start': (False, False), 'Finish': (False, False)}, self.flags(self.derive()))
        self.assertEqual({'Start': (True, False), 'Finish': (False, True)},
                         self.flags(self.derive(lifecycleThreshold=0.8)))

    def test_trace_list_import_keeps_valid_order_beyond_sixty_events_and_traces(self):
        model = json.loads(json.dumps(self.model).replace('Order', 'case'))
        self.model_path.write_text(json.dumps(model))
        self.log_path.write_text(json.dumps(
            [['Start', 'Finish']] * 90 + [['OtherStart', 'OtherEnd']] * 10))
        self.assertEqual({'Start': (True, False), 'Finish': (False, True)},
                         self.flags(self.derive()))

    def test_missing_log_cannot_fall_back_to_unmeasured_flags(self):
        for filename in ('', 'missing.json'):
            response = self.client.post('/api/derive-lifecycle', json={**self.payload, 'eventLogFile': filename})
            self.assertEqual(400, response.status_code)
            self.assertIn('log', response.json['error'].lower())

    def test_invalid_threshold_is_a_request_error(self):
        for value in (None, True, 0, -1, 1.1, 'bad'):
            response = self.client.post('/api/derive-lifecycle', json={**self.payload, 'lifecycleThreshold': value})
            self.assertEqual(400, response.status_code, response.json)

    def test_missing_timestamp_returns_a_clear_request_error(self):
        log = log_from_traces([['Start', 'Finish']])
        log['events']['Order_0_0']['timestamp'] = None
        self.log_path.write_text(json.dumps(log))
        response = self.client.post('/api/derive-lifecycle', json=self.payload)
        self.assertEqual(400, response.status_code)
        self.assertIn('valid timestamp', response.json['error'])

    def test_discovered_flags_run_through_simulation_and_fulfill_responses(self):
        model = self.derive()['model']
        model['activity_durations'] = {
            name: {'dist_type': 'fixed', 'mean_seconds': 1} for name in ('Start', 'Finish')}
        state = Simulator(parse_ocdeclare_dict(model), SimulationConfig(
            seed=7, max_steps=20, start_policy=StartPolicy(['Start'], max_case_starts=3))).run()
        self.assertEqual(6, len(state.executed_events))
        self.assertEqual(3, state.total_obligations_fulfilled)
        self.assertEqual(0, state.total_obligations_violated)
        self.assertFalse(state._obligations_count)
        self.assertFalse(state.in_progress)
        self.assertTrue(all(not obj.active for obj in state.objects.values()))


if __name__ == '__main__':
    unittest.main()
