import unittest
from datetime import datetime, timedelta

from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.Domain.ir import (
    Activity, ActivityDuration, Constraint, ObjectBinding, ObjectType, Scope, StaticModel,
)
from Backend.src.Simulation.Domain.state import SimulationState
from Backend.src.Simulation.Engine.candidategeneration import Candidate, build_candidate_for_activity
from Backend.src.Simulation.Engine.semantics import check_all_constraints
from Backend.src.Simulation.Engine.simulator import Simulator
from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict


def fixed(seconds):
    return ActivityDuration(dist_type='fixed', mean_seconds=seconds)


def arrivals(duration=100, gap=10, **kwargs):
    return StaticModel(
        activities=[Activity('Arrive', [ObjectBinding('Order', 1, 1, creates=True)])],
        object_types=[ObjectType('Order')],
        activity_durations={'Arrive': fixed(duration)},
        interarrival_times={'Arrive': fixed(gap)},
        **kwargs,
    )


class SchedulingTests(unittest.TestCase):
    def run_model(self, model, **kwargs):
        kwargs.setdefault('max_steps', 30)
        kwargs.setdefault('start_policy', StartPolicy(['Arrive']))
        config = SimulationConfig(seed=7, **kwargs)
        state = Simulator(model, config).run()
        return state, config

    def test_arrivals_while_work_is_in_progress(self):
        state, config = self.run_model(arrivals(), max_steps=3)
        self.assertEqual([100, 110, 120], [
            (e.timestamp - config.start_timestamp).total_seconds()
            for e in state.executed_events
        ])

    def test_concurrency_cap_still_applies(self):
        state, config = self.run_model(arrivals(activity_concurrency={'Arrive': 1}), max_steps=3)
        self.assertEqual([100, 200, 300], [
            (e.timestamp - config.start_timestamp).total_seconds() for e in state.executed_events
        ])

    def test_deadline_leaves_late_work_unfinished(self):
        state, config = self.run_model(arrivals(), max_sim_time_s=5)
        self.assertEqual([], state.executed_events)
        self.assertEqual(1, len(state.in_progress))
        self.assertEqual(config.start_timestamp + timedelta(seconds=5), state.current_time)

    def test_completions_at_deadline_included_without_new_starts(self):
        model = StaticModel(activities=[Activity('A'), Activity('B')],
                            activity_durations={'A': fixed(5), 'B': fixed(5)})
        state, _ = self.run_model(model, max_sim_time_s=5, start_policy=StartPolicy(['A', 'B']))
        self.assertEqual({'A', 'B'}, {e.activity_name for e in state.executed_events})
        self.assertEqual([], state.in_progress)

    def test_calendar_opens_while_other_activity_runs(self):
        calendar = [0.0] * 168
        calendar[10] = 1.0  # Monday 10:00
        model = StaticModel(
            activities=[Activity('Long'), Activity('Short')],
            activity_durations={'Long': fixed(7200), 'Short': fixed(10)},
            activity_calendars={'per_activity': {'Short': calendar}},
        )
        state, config = self.run_model(
            model, start_timestamp=datetime(2025, 1, 6, 9),
            start_policy=StartPolicy(['Long', 'Short'], start_activity_caps={'Long': 1, 'Short': 1}),
        )
        event = next(e for e in state.executed_events if e.activity_name == 'Short')
        self.assertEqual(3610, (event.timestamp - config.start_timestamp).total_seconds())

    def test_deadline_while_calendar_is_closed(self):
        state, config = self.run_model(
            arrivals(activity_calendars={'global': [0.0] * 168}), max_sim_time_s=5)
        self.assertEqual([], state.executed_events)
        self.assertEqual(config.start_timestamp + timedelta(seconds=5), state.current_time)

    def test_start_cap_reserves_running_instances(self):
        state, _ = self.run_model(arrivals(), start_policy=StartPolicy(
            ['Arrive'], start_activity_caps={'Arrive': 2}))
        self.assertEqual(2, len(state.executed_events))
        self.assertEqual(2, len(state.objects))
        self.assertEqual([], state.in_progress)

    def test_global_start_cap_reserves_all_activities(self):
        model = StaticModel(activities=[Activity('A'), Activity('B')],
                            activity_durations={'A': fixed(5), 'B': fixed(5)})
        state, _ = self.run_model(model, start_policy=StartPolicy(['A', 'B'], max_case_starts=1))
        self.assertEqual(1, len(state.executed_events))

    def test_zero_start_cap(self):
        state, _ = self.run_model(arrivals(), start_policy=StartPolicy(
            ['Arrive'], start_activity_caps={'Arrive': 0}))
        self.assertEqual([], state.executed_events)
        self.assertEqual({}, state.objects)


class ConstraintTests(unittest.TestCase):
    def parsed_model(self, kind, scope=None, **kwargs):
        return parse_ocdeclare_dict({
            'object_types': ['Order', 'Other'],
            'activities': [
                {'name': a, 'bindings': [{'object_type': 'Order', 'min_count': 1}]}
                for a in ['A', 'B', 'C']
            ] + [{'name': 'D', 'bindings': [{'object_type': 'Other', 'min_count': 1}]}],
            'constraints': [{'type': kind, 'source': 'A', 'target': 'B',
                             'scope': scope or {'kind': 'each', 'object_type': 'Order'}, **kwargs}],
        })

    def test_chain_rules_block_intervening_activity_only_on_armed_object(self):
        for kind in ['chain_response', 'chain_succession']:
            with self.subTest(kind=kind):
                model = self.parsed_model(kind)
                state = SimulationState()
                order = state.add_object('Order').object_id
                other_order = state.add_object('Order').object_id
                state.record_event('A', [order])
                self.assertFalse(check_all_constraints(model, Candidate('C', [order]), state))
                self.assertTrue(check_all_constraints(model, Candidate('C', [other_order]), state))
                self.assertTrue(check_all_constraints(model, Candidate('B', [order]), state))
                state.record_event('B', [order])
                self.assertTrue(check_all_constraints(model, Candidate('C', [order]), state))

    def test_global_chain_blocks_unrelated_activity(self):
        model = self.parsed_model('chain_response', {'kind': 'global', 'object_type': ''})
        state = SimulationState()
        state.record_event('A', [])
        self.assertFalse(check_all_constraints(model, Candidate('D'), state))

    def test_init_is_checked_on_other_activities(self):
        model = self.parsed_model('init')
        state = SimulationState()
        order = state.add_object('Order').object_id
        self.assertFalse(check_all_constraints(model, Candidate('C', [order]), state))
        state.record_event('B', [order])
        self.assertTrue(check_all_constraints(model, Candidate('C', [order]), state))

    def test_absence_zero_and_positive_limits(self):
        for kind in ['each', 'global']:
            for limit in [0, 2]:
                with self.subTest(kind=kind, limit=limit):
                    model = self.parsed_model('absence', {'kind': kind, 'object_type': 'Order'}, nmax=limit)
                    state = SimulationState()
                    oid = state.add_object('Order').object_id
                    cand = Candidate('B', [oid])
                    for _ in range(limit):
                        self.assertTrue(check_all_constraints(model, cand, state))
                        state.record_event('B', [oid])
                    self.assertFalse(check_all_constraints(model, cand, state))

    def test_absence_guard_exemption_remains(self):
        model = self.parsed_model('absence', nmax=0,
                                  guard={'attribute': 'priority', 'op': '==', 'value': 'high'})
        state = SimulationState()
        oid = state.add_object('Order', attributes={'priority': 'low'}).object_id
        self.assertTrue(check_all_constraints(model, Candidate('B', [oid]), state))


class BatchTests(unittest.TestCase):
    def test_pinned_primary_is_part_of_full_batch(self):
        state = SimulationState()
        ids = [state.add_object('Order').object_id for _ in range(2)]
        activity = Activity('Batch', [ObjectBinding('Order', 2, 2)])
        cand = build_candidate_for_activity(activity, state, force_object_id=ids[0])
        self.assertIsNotNone(cand)
        self.assertEqual(set(ids), set(cand.participating_object_ids))
        self.assertEqual(2, len(cand.participating_object_ids))

    def test_missing_or_guarded_inputs_cannot_fill_batch(self):
        state = SimulationState()
        oid = state.add_object('Order', attributes={'ready': False}).object_id
        activity = Activity('Batch', [ObjectBinding('Order', 2, 2)])
        self.assertIsNone(build_candidate_for_activity(activity, state, force_object_id=oid))
        for _ in range(2):
            state.add_object('Order', attributes={'ready': True})
        guarded = Activity('Batch', [ObjectBinding('Order', 2, 2,
                            guard={'attribute': 'ready', 'op': '==', 'value': True})])
        self.assertIsNone(build_candidate_for_activity(guarded, state, force_object_id=oid))

    def test_batch_runs_once_and_deactivates_both_objects(self):
        model = StaticModel(activities=[
            Activity('Arrive', [ObjectBinding('Order', 2, 2, creates=True)]),
            Activity('Batch', [ObjectBinding('Order', 2, 2, deactivates=True)]),
        ])
        config = SimulationConfig(max_steps=10, start_policy=StartPolicy(['Arrive'], max_case_starts=1))
        state = Simulator(model, config).run()
        self.assertEqual(['Arrive', 'Batch'], [e.activity_name for e in state.executed_events])
        self.assertEqual(2, state.total_deactivations)


class ObligationTests(unittest.TestCase):
    def run_terminal(self, terminal, extra_constraints=()):
        model = StaticModel(activities=[
            Activity('A', [ObjectBinding('Order', 1, 1, creates=True)]),
            Activity(terminal, [ObjectBinding('Order', 1, 1, deactivates=True)]),
        ], constraints=[Constraint('response', 'A', 'B', Scope('each', 'Order'), nmin=1),
                        *extra_constraints], activity_durations={terminal: fixed(1)})
        return Simulator(model, SimulationConfig(max_steps=10, start_policy=StartPolicy(
            ['A'], max_case_starts=1))).run()

    def test_terminal_response_is_fulfilled(self):
        state = self.run_terminal('B')
        self.assertEqual(1, state.total_obligations_fulfilled)
        self.assertEqual(0, state.total_obligations_violated)
        self.assertEqual({}, state._obligations_count)

    def test_unrelated_deactivation_still_violates_response(self):
        state = self.run_terminal('C')
        self.assertEqual(0, state.total_obligations_fulfilled)
        self.assertEqual(1, state.total_obligations_violated)

    def test_new_obligation_on_deactivated_object_is_cancelled(self):
        state = self.run_terminal('B', [Constraint('response', 'B', 'C', Scope('each', 'Order'), nmin=1)])
        self.assertEqual(1, state.total_obligations_fulfilled)
        self.assertEqual(1, state.total_obligations_violated)
        self.assertEqual({}, state._obligations_count)


if __name__ == '__main__':
    unittest.main()
