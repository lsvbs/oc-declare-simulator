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


if __name__ == '__main__':
    unittest.main()
