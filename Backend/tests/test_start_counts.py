import unittest
from contextlib import ExitStack
from unittest.mock import patch

from Backend.src.Simulation.Domain.config import resolve_start_activity_caps


class StartCountTests(unittest.TestCase):
    def test_discovered_defaults_and_explicit_overrides(self):
        self.assertEqual({'A': 7, 'B': 12}, resolve_start_activity_caps(
            ['A', 'B'], {'B': ''}, {'A': 7, 'B': 12}))
        self.assertEqual({'A': 3, 'B': 0}, resolve_start_activity_caps(
            ['A', 'B'], {'A': '3', 'B': 0, 'C': 5}, {'A': 7, 'B': 12}))

    def test_missing_or_invalid_counts_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Enter a starting count'):
            resolve_start_activity_caps(['A'])
        for value in [-1, 1.5, 'bad', True, float('inf'), 2**53]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'whole number'):
                resolve_start_activity_caps(['A'], {'A': value})


class StartCountApiTests(unittest.TestCase):
    def setUp(self):
        from Backend import server
        self.server = server
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(server.discovery_cache, {
            'test.json': {'activity_counts': {'Arrive': 2}},
        }, clear=True))
        self.stack.enter_context(patch.object(server, '_merge_pacing', side_effect=lambda model, *_: model))
        self.stack.enter_context(patch.object(server, 'write_ocel2_json', return_value='/tmp/test_log.json'))
        self.stack.enter_context(patch.object(server, 'write_metrics_json', return_value='/tmp/test_metrics.json'))
        self.stack.enter_context(patch.object(server, '_load_history', return_value=[]))
        self.stack.enter_context(patch.object(server, '_save_history'))
        self.client = server.app.test_client()
        self.payload = {
            'eventLogFile': 'test.json', 'startActivities': ['Arrive'], 'maxEvents': 20,
            'modelOverride': {
                'object_types': ['Order'],
                'activities': [{'name': 'Arrive', 'bindings': [
                    {'object_type': 'Order', 'min_count': 1, 'max_count': 1, 'creates': True}]}],
                'activity_durations': {'Arrive': {'dist_type': 'fixed', 'mean_seconds': 100}},
                'interarrival_times': {'Arrive': {'dist_type': 'fixed', 'mean_seconds': 10}},
            },
        }

    def test_blank_count_uses_discovery_through_complete_request(self):
        response = self.client.post('/api/simulate', json={**self.payload, 'startActivityCaps': {'Arrive': ''}})
        self.assertEqual(200, response.status_code, response.json)
        result = response.json['results']
        self.assertEqual({'Arrive': 2}, result['start_activity_caps'])
        self.assertEqual(2, result['events_count'])
        self.assertEqual(2, result['objects_count'])

    def test_explicit_count_without_log_and_zero_override(self):
        for count in [0, 3]:
            response = self.client.post('/api/simulate', json={
                **self.payload, 'eventLogFile': None, 'startActivityCaps': {'Arrive': count}})
            self.assertEqual(200, response.status_code, response.json)
            self.assertEqual(count, response.json['results']['events_count'])

    def test_no_discovered_count_requires_user_value(self):
        response = self.client.post('/api/simulate', json={**self.payload, 'eventLogFile': None})
        self.assertEqual(400, response.status_code)
        self.assertIn('Enter a starting count', response.json['error'])

    def test_invalid_count_is_a_validation_error(self):
        response = self.client.post('/api/simulate', json={
            **self.payload, 'startActivityCaps': {'Arrive': -1}})
        self.assertEqual(400, response.status_code)

    def test_deadline_returns_unfinished_objects_without_completion_events(self):
        response = self.client.post('/api/simulate', json={**self.payload, 'maxSimTimeS': 5})
        self.assertEqual(200, response.status_code, response.json)
        self.assertEqual(0, response.json['results']['events_count'])
        self.assertEqual(1, response.json['results']['objects_count'])
        self.assertEqual([], response.json['results']['recent_events'])

    def test_recent_events_include_every_object_beyond_old_preview_cap(self):
        model = {
            **self.payload['modelOverride'],
            'object_types': ['Order', 'Item'],
            'activities': [{'name': 'Arrive', 'bindings': [
                {'object_type': 'Order', 'min_count': 1, 'max_count': 1, 'creates': True},
                {'object_type': 'Item', 'min_count': 2, 'max_count': 2, 'creates': True},
            ]}],
        }
        response = self.client.post('/api/simulate', json={
            **self.payload, 'modelOverride': model, 'maxEvents': 75,
            'startActivityCaps': {'Arrive': 75},
        })
        self.assertEqual(200, response.status_code, response.json)
        result = response.json['results']
        self.assertEqual(75, result['events_count'])
        self.assertEqual(list(range(66, 76)), [e['sequence'] for e in result['recent_events']])
        state = self.server.write_ocel2_json.call_args.args[0]
        for expected, actual in zip(state.executed_events[-10:], result['recent_events']):
            self.assertEqual(expected.event_id, actual['event_id'])
            self.assertEqual(expected.activity_name, actual['activity'])
            self.assertEqual(expected.timestamp.isoformat(), actual['timestamp'])
            self.assertEqual([
                {'object_id': oid, 'object_type': state.objects[oid].object_type}
                for oid in expected.object_ids
            ], actual['objects'])
            self.assertEqual(3, len(actual['objects']))
        self.assertTrue(any(obj['object_id'] not in result['object_types_map']
                            for e in result['recent_events'] for obj in e['objects']))

    def test_recent_events_handle_short_runs_and_keep_tied_completion_order(self):
        # Zero duration makes all three completions share one timestamp.
        model = {**self.payload['modelOverride'],
                 'activity_durations': {'Arrive': {'dist_type': 'fixed', 'mean_seconds': 0}},
                 'interarrival_times': {}}
        response = self.client.post('/api/simulate', json={
            **self.payload, 'modelOverride': model, 'startActivityCaps': {'Arrive': 3},
        })
        self.assertEqual(200, response.status_code, response.json)
        events = response.json['results']['recent_events']
        self.assertEqual([1, 2, 3], [e['sequence'] for e in events])
        state = self.server.write_ocel2_json.call_args.args[0]
        self.assertEqual([e.event_id for e in state.executed_events], [e['event_id'] for e in events])
        self.assertEqual(1, len({e['timestamp'] for e in events}))


if __name__ == '__main__':
    unittest.main()
