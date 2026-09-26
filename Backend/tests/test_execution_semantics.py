"""Regression coverage for rebinding, start reservations and response obligations."""
import copy
import threading
import unittest
from datetime import datetime, timedelta
from dataclasses import replace

from Backend.tests.verify_remaining_logic import RemainingLogicChecks
from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.Domain.ir import (
    Activity, ActivityDuration, Constraint, ObjectBinding, O2ORule, Scope, StaticModel,
)
from Backend.src.Simulation.Domain.state import SimulationState
from Backend.src.Simulation.Engine.candidategeneration import (
    Candidate, build_candidate_for_activity, is_candidate_semantically_allowed,
)
from Backend.src.Simulation.Engine.simulator import Simulator
from Backend.src.Simulation.IO.output.OCEL2 import build_ocel2_dict


def fixed(seconds):
    return ActivityDuration(dist_type='fixed', mean_seconds=seconds)


def fire(sim, state, activity, ids):
    event = state.record_event(activity, ids)
    sim._update_obligations_after_event(event, state)
    return event


class RebindingTests(unittest.TestCase):
    def jobs(self, *, guard=None, rules=(), constraints=(), machine_ready=True, shared_link=False):
        state = SimulationState()
        orders = [state.add_object('Order').object_id for _ in range(2)]
        machines = [state.add_object('Machine', attributes={'ready': True}).object_id,
                    state.add_object('Machine', attributes={'ready': machine_ready}).object_id]
        if shared_link:
            for order in orders:
                state.add_link(order, machines[0])
        if constraints:
            state.record_event('Setup', [machines[0]], datetime(2025, 1, 1))
        model = StaticModel(activities=[Activity('Work', [
            ObjectBinding('Order', 1, 1, deactivates=True), ObjectBinding('Machine', 1, 1, guard=guard)])],
            o2o_rules=list(rules), constraints=list(constraints), activity_durations={'Work': fixed(100)})
        config = SimulationConfig(max_steps=3 if constraints else 2, seed=7, start_policy=StartPolicy(['Work']))
        state = Simulator(model, config).run(state)
        times = [(e.timestamp - config.start_timestamp).total_seconds()
                 for e in state.executed_events if e.activity_name == 'Work']
        return times, state

    def test_alternative_must_pass_attribute_guard(self):
        times, _ = self.jobs(guard={'attribute': 'ready', 'op': '==', 'value': True}, machine_ready=False)
        self.assertEqual([100, 200], times)

    def test_alternative_must_respect_existing_relationship_capacity(self):
        times, _ = self.jobs(rules=[O2ORule('Order', 'Machine', 1, 1, False)], shared_link=True)
        self.assertEqual([100, 200], times)

    def test_alternative_must_pass_its_own_precedence(self):
        times, _ = self.jobs(constraints=[Constraint('precedence', 'Setup', 'Work', Scope('each', 'Machine'), 1)])
        self.assertEqual([100, 200], times)

    def test_two_free_machines_run_in_parallel_and_keep_primary_orders(self):
        times, state = self.jobs()
        self.assertEqual([100, 100], times)
        self.assertEqual({'Order_1', 'Order_2'}, {e.object_ids[0] for e in state.executed_events})
        self.assertEqual({'Machine_1', 'Machine_2'}, {e.object_ids[1] for e in state.executed_events})

    def test_rebinding_preserves_inactive_scope_exemption(self):
        state = SimulationState()
        order = state.add_object('Order').object_id
        machines = [state.add_object('Machine').object_id for _ in range(2)]
        old_item = state.add_object('Item').object_id
        state.deactivate_object(old_item)
        state.record_event('Setup', [machines[1]])
        activity = Activity('Work', [ObjectBinding('Order', 1, 1), ObjectBinding('Machine', 1, 1)])
        model = StaticModel(activities=[activity], constraints=[
            Constraint('precedence', 'Unused', 'Work', Scope('each', 'Item'), 1),
            Constraint('precedence', 'Setup', 'Work', Scope('each', 'Machine'), 1)])
        sim = Simulator(model, SimulationConfig())
        original = Candidate('Work', [order, machines[0]], required_object_ids=(order,))
        self.assertFalse(is_candidate_semantically_allowed(model, original, state))
        replacement = sim._valid_candidate_binding(activity, original, state)
        self.assertIsNotNone(replacement)
        self.assertEqual([order, machines[1]], replacement.participating_object_ids)
        self.assertTrue(is_candidate_semantically_allowed(model, replacement, state))


class ReservationTests(unittest.TestCase):
    def test_global_bounds_account_for_running_work_across_calendar_slots(self):
        for kind, minimum, maximum in [('absence', 0, 1), ('exactly', 1, None), ('response', 0, 1)]:
            with self.subTest(kind=kind):
                state = SimulationState()
                for _ in range(3):
                    state.add_object('Order')
                calendar = [1.0] * 168
                model = StaticModel(activities=[Activity('A', [ObjectBinding('Order', 1, 1, deactivates=True)])],
                    constraints=[Constraint(kind, 'A', 'A', Scope('global', ''), minimum, maximum)],
                    activity_durations={'A': fixed(4000)}, activity_calendars={'global': calendar})
                config = SimulationConfig(seed=7, max_steps=5, start_policy=StartPolicy(['A']))
                result = Simulator(model, config).run(state)
                self.assertEqual(1, len(result.executed_events))

    def test_concurrency_one_is_not_a_global_execution_limit(self):
        state = SimulationState()
        for _ in range(3):
            state.add_object('Order')
        model = StaticModel(activities=[Activity('A', [ObjectBinding('Order', 1, 1, deactivates=True)])],
            constraints=[Constraint('absence', 'A', 'A', Scope('global', ''), nmax=2)],
            activity_durations={'A': fixed(10)}, activity_concurrency={'A': 1})
        config = SimulationConfig(max_steps=10, start_policy=StartPolicy(['A']))
        result = Simulator(model, config).run(state)
        self.assertEqual([10, 20], [(e.timestamp-config.start_timestamp).total_seconds() for e in result.executed_events])

    def test_rejected_reserved_start_does_not_allocate_objects_or_sample_time(self):
        model = StaticModel(activities=[Activity('A', [ObjectBinding('Order', 1, 1, creates=True)])],
            constraints=[Constraint('absence', 'A', 'A', Scope('global', ''), nmax=1)],
            activity_durations={'A': fixed(10)})
        config = SimulationConfig(seed=7)
        sim, state = Simulator(model, config), SimulationState(current_time=config.start_timestamp)
        self.assertIsNotNone(sim._des_start_activity(Candidate('A', [], ['Order']), state, []))
        before, rng_before = copy.deepcopy(state), sim.rng.getstate()
        self.assertIsNone(sim._des_start_activity(Candidate('A', [], ['Order']), state, []))
        self.assertEqual(before, state)
        self.assertEqual(rng_before, sim.rng.getstate())


class ResponseCountingTests(unittest.TestCase):
    def setup_response(self, nmin=2, scope=None, constraints=None):
        state = SimulationState()
        orders = [state.add_object('Order').object_id for _ in range(2)]
        constraints = constraints if constraints is not None else [Constraint(
            'response', 'A', 'B', scope or Scope('each', 'Order'), nmin=nmin)]
        model = StaticModel(activities=[Activity('A'), Activity('B'), Activity('C')], constraints=constraints)
        return Simulator(model, SimulationConfig()), state, orders

    def test_two_responses_are_required_and_counted_once_each(self):
        sim, state, ids = self.setup_response()
        fire(sim, state, 'A', ids[:1])
        fire(sim, state, 'B', ids[:1])
        self.assertEqual([1], list(state._obligations_count.values()))
        self.assertEqual(0, state.total_obligations_fulfilled)
        fire(sim, state, 'B', ids[:1])
        self.assertEqual(1, state.total_obligations_fulfilled)
        self.assertEqual({}, state._response_obligations)
        self.assertEqual({}, state._responses_by_target)
        self.assertEqual({}, state._responses_by_object)

    def test_later_response_can_satisfy_several_earlier_activations(self):
        sim, state, ids = self.setup_response()
        fire(sim, state, 'A', ids[:1])
        fire(sim, state, 'A', ids[:1])
        fire(sim, state, 'B', ids[:1])
        self.assertEqual([1, 1], list(state._obligations_count.values()))
        fire(sim, state, 'B', ids[:1])
        self.assertEqual(2, state.total_obligations_fulfilled)

    def test_new_activation_does_not_inherit_previous_responses(self):
        sim, state, ids = self.setup_response()
        for activity in ['A', 'B', 'A', 'B']:
            fire(sim, state, activity, ids[:1])
        self.assertEqual(1, state.total_obligations_fulfilled)
        self.assertEqual([1], list(state._obligations_count.values()))

    def test_constraints_sharing_target_and_scope_remain_independent(self):
        sim, state, ids = self.setup_response(constraints=[
            Constraint('response', 'A', 'B', Scope('each', 'Order'), 1),
            Constraint('response', 'C', 'B', Scope('each', 'Order'), 2)])
        for activity in ['A', 'C', 'B']:
            fire(sim, state, activity, ids[:1])
        self.assertEqual(1, state.total_obligations_fulfilled)
        self.assertEqual([1], list(state._obligations_count.values()))

    def test_zero_minimum_creates_no_positive_obligation(self):
        sim, state, ids = self.setup_response(nmin=0)
        fire(sim, state, 'A', ids)
        self.assertEqual({}, state._obligations_count)

    def test_any_counts_events_not_number_of_matching_objects(self):
        sim, state, ids = self.setup_response(scope=Scope('any', 'Order'))
        fire(sim, state, 'A', ids)
        fire(sim, state, 'B', ids)
        self.assertEqual([1], list(state._obligations_count.values()))
        fire(sim, state, 'B', ids[:1])
        self.assertEqual(1, state.total_obligations_fulfilled)

    def test_partial_all_event_does_not_count(self):
        sim, state, ids = self.setup_response(scope=Scope('all', 'Order'))
        fire(sim, state, 'A', ids)
        fire(sim, state, 'B', ids[:1])
        fire(sim, state, 'B', ids[1:])
        self.assertEqual([2], list(state._obligations_count.values()))
        fire(sim, state, 'B', ids)
        self.assertEqual([1], list(state._obligations_count.values()))

    def test_partial_response_cancelled_on_unrelated_deactivation(self):
        sim, state, ids = self.setup_response()
        fire(sim, state, 'A', ids[:1])
        fire(sim, state, 'B', ids[:1])
        state.deactivate_object(ids[0])
        self.assertEqual(0, state.total_obligations_fulfilled)
        self.assertEqual(1, state.total_obligations_violated)
        self.assertEqual({}, state._obligations_count)

    def test_any_survives_until_last_eligible_member_deactivates(self):
        sim, state, ids = self.setup_response(scope=Scope('any', 'Order'))
        fire(sim, state, 'A', ids)
        state.deactivate_object(ids[0])
        self.assertTrue(state._obligations_count)
        state.deactivate_object(ids[1])
        self.assertEqual(1, state.total_obligations_cancelled)
        self.assertEqual({}, state._responses_by_object)

    def test_guard_exempt_activation_creates_no_obligation(self):
        sim, state, ids = self.setup_response(constraints=[Constraint('response', 'A', 'B',
            Scope('each', 'Order'), 2, guard={'attribute': 'required', 'op': '==', 'value': True})])
        fire(sim, state, 'A', ids)
        self.assertEqual({}, state._obligations_count)

    def test_mixed_each_all_any_bindings_require_one_matching_event(self):
        scope = Scope('each', 'Order', bindings=(('Order', 'each'), ('Item', 'all'), ('Machine', 'any')))
        sim, state, orders = self.setup_response(scope=scope, nmin=1)
        items = [state.add_object('Item').object_id for _ in range(2)]
        machines = [state.add_object('Machine').object_id for _ in range(2)]
        fire(sim, state, 'A', orders + items + machines)
        fire(sim, state, 'B', orders + items[:1] + machines)
        self.assertEqual(0, state.total_obligations_fulfilled)
        fire(sim, state, 'B', orders + items + machines[:1])
        self.assertEqual(2, state.total_obligations_fulfilled)

    def test_blocked_response_waits_for_every_required_precedence_occurrence(self):
        sim, state, ids = self.setup_response(nmin=1, constraints=[
            Constraint('response', 'A', 'B', Scope('each', 'Order'), 1),
            Constraint('precedence', 'C', 'B', Scope('each', 'Order'), 2)])
        fire(sim, state, 'A', ids[:1])
        self.assertFalse(state._obligations_ready)
        fire(sim, state, 'C', ids[:1])
        self.assertFalse(state._obligations_ready)
        self.assertEqual(1, len(state._obligations_blocked))
        fire(sim, state, 'C', ids[:1])
        self.assertEqual(1, len(state._obligations_ready))
        self.assertFalse(state._obligations_blocked)
        fire(sim, state, 'B', ids[:1])
        self.assertEqual(1, state.total_obligations_fulfilled)
        self.assertFalse(state._obligation_waiting_on)


class JointCandidateTests(unittest.TestCase):
    def test_forced_group_is_preserved_and_can_be_topped_up_to_minimum(self):
        state = SimulationState()
        ids = [state.add_object('Order').object_id for _ in range(3)]
        for minimum in [1, 3]:
            candidate = build_candidate_for_activity(Activity('B', [ObjectBinding('Order', minimum, 3)]),
                                                     state, force_object_ids=ids[:2])
            self.assertTrue(set(ids[:2]).issubset(candidate.participating_object_ids))
            self.assertEqual(max(2, minimum), len(candidate.participating_object_ids))

    def test_forced_group_cannot_exceed_maximum_or_bypass_guards(self):
        state = SimulationState()
        ids = [state.add_object('Order', attributes={'ready': i == 0}).object_id for i in range(2)]
        for binding in [ObjectBinding('Order', 1, 1), ObjectBinding('Order', 1, 2,
                       guard={'attribute': 'ready', 'op': '==', 'value': True})]:
            self.assertIsNone(build_candidate_for_activity(Activity('B', [binding]), state, force_object_ids=ids))

    def test_overlapping_terminal_groups_form_one_valid_union(self):
        state = SimulationState()
        ids = [state.add_object('Order').object_id for _ in range(3)]
        model = StaticModel(activities=[Activity('B', [ObjectBinding('Order', 1, 3, deactivates=True)])],
            constraints=[Constraint('response', 'A', 'B', Scope('all', 'Order'), 1)],
            activity_durations={'B': fixed(1)})
        sim = Simulator(model, SimulationConfig(max_steps=10, start_policy=StartPolicy(['B'])))
        fire(sim, state, 'A', ids[:2])
        fire(sim, state, 'A', ids[1:])
        result = sim.run(state)
        responses = [e for e in result.executed_events if e.activity_name == 'B']
        self.assertEqual(1, len(responses))
        self.assertEqual(set(ids), set(responses[0].object_ids))
        self.assertEqual(2, result.total_obligations_fulfilled)

    def test_joint_candidate_still_waits_for_precedence_and_calendar(self):
        calendar = [0.0] * 168
        calendar[10] = 1.0
        model = StaticModel(activities=[
            Activity('A', [ObjectBinding('Order', 2, 2, creates=True)]),
            Activity('B', [ObjectBinding('Order', 1, 2, deactivates=True)])],
            constraints=[Constraint('response', 'A', 'B', Scope('all', 'Order'), 1),
                         Constraint('precedence', 'A', 'B', Scope('each', 'Order'), 1)],
            activity_durations={'A': fixed(1), 'B': fixed(5)}, activity_calendars={'per_activity': {'B': calendar}})
        config = SimulationConfig(max_steps=10, start_timestamp=datetime(2025, 1, 6, 9),
                                  start_policy=StartPolicy(['A'], max_case_starts=1))
        result = Simulator(model, config).run()
        self.assertEqual(['A', 'B'], [e.activity_name for e in result.executed_events])
        self.assertEqual(config.start_timestamp+timedelta(seconds=3605), result.executed_events[-1].timestamp)
        self.assertEqual(2, len(result.executed_events[-1].object_ids))

    def test_impossible_joint_binding_terminates_without_invalid_partial_events(self):
        model = StaticModel(activities=[Activity('A', [ObjectBinding('Order', 2, 2, creates=True)]),
                                       Activity('B', [ObjectBinding('Order', 1, 1, deactivates=True)])],
                            constraints=[Constraint('response', 'A', 'B', Scope('all', 'Order'), 1)])
        state = Simulator(model, SimulationConfig(max_steps=10,
            start_policy=StartPolicy(['A'], max_case_starts=1))).run()
        self.assertEqual(['A'], [e.activity_name for e in state.executed_events])
        self.assertTrue(state._obligations_count)


class CombinedSimulationTests(unittest.TestCase):
    def test_parallel_cases_complete_all_response_counts_and_export(self):
        model = StaticModel(activities=[
            Activity('Arrive', [ObjectBinding('Order', 1, 1, creates=True), ObjectBinding('Item', 1, 1, creates=True)]),
            Activity('Work', [ObjectBinding('Order', 1, 1), ObjectBinding('Item', 1, 1), ObjectBinding('Machine', 1, 1)]),
            Activity('Finish', [ObjectBinding('Order', 1, 1, deactivates=True), ObjectBinding('Item', 1, 1, deactivates=True)])],
            constraints=[Constraint('response', 'Arrive', 'Work', Scope('each', 'Order'), 2, 2),
                         Constraint('precedence', 'Arrive', 'Work', Scope('each', 'Order'), 1),
                         Constraint('response', 'Work', 'Finish', Scope('each', 'Order'), 1),
                         Constraint('precedence', 'Work', 'Finish', Scope('each', 'Order'), 2)],
            o2o_rules=[O2ORule('Order', 'Item', 1, 1)],
            activity_durations={'Arrive': fixed(1), 'Work': fixed(5), 'Finish': fixed(1)},
            interarrival_times={'Arrive': fixed(2)})
        for seed in [1, 7, 42]:
            with self.subTest(seed=seed):
                state = SimulationState()
                for _ in range(3):
                    state.add_object('Machine')
                config = SimulationConfig(seed=seed, max_steps=300, max_runtime_s=10,
                    start_policy=StartPolicy(['Arrive'], max_case_starts=25))
                result = Simulator(model, config).run(state)
                self.assertEqual(100, len(result.executed_events))
                self.assertEqual(75, result.total_obligations_fulfilled)
                self.assertEqual(0, result.total_obligations_violated)
                self.assertEqual({}, result._obligations_count)
                self.assertEqual(set(), result._busy_objects)
                self.assertEqual([], result.in_progress)
                self.assertEqual(25, len(result.links))
                self.assertEqual(100, len(build_ocel2_dict(result)['events']))

    def test_user_stop_remains_responsive(self):
        stop = threading.Event()
        stop.set()
        result = Simulator(StaticModel(activities=[Activity('A')]), SimulationConfig(), stop_event=stop).run()
        self.assertEqual([], result.executed_events)


if __name__ == '__main__':
    unittest.main()
