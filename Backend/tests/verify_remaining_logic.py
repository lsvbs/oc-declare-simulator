"""Additional verification cases for the remaining simulation issues.

Run explicitly with:
    python3 -m unittest Backend.tests.verify_remaining_logic -v

These are the five original reproductions, now all expected to pass. They
are also collected by test_execution_semantics.py in the regular suite.
"""

import unittest

from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.Domain.ir import (
    Activity, ActivityDuration, Constraint, ObjectBinding, O2ORule, Scope, StaticModel,
)
from Backend.src.Simulation.Domain.state import SimulationState
from Backend.src.Simulation.Engine.simulator import Simulator


class RemainingLogicChecks(unittest.TestCase):
    def test_two_available_secondary_objects_allow_two_parallel_jobs(self):
        state = SimulationState()
        for object_type in ['Order', 'Order', 'Machine', 'Machine']:
            state.add_object(object_type)
        model = StaticModel(
            activities=[Activity('Work', [
                ObjectBinding('Order', 1, 1, deactivates=True), ObjectBinding('Machine', 1, 1),
            ])],
            activity_durations={'Work': ActivityDuration(dist_type='fixed', mean_seconds=100)},
        )
        config = SimulationConfig(max_steps=2, seed=7, start_policy=StartPolicy(['Work']))
        result = Simulator(model, config).run(state)
        self.assertEqual([100, 100], [
            (e.timestamp - config.start_timestamp).total_seconds() for e in result.executed_events
        ], 'Both jobs should complete together using different available machines.')

    def test_response_requiring_two_executions_is_not_fulfilled_by_one(self):
        model = StaticModel(activities=[
            Activity('A', [ObjectBinding('Order', 1, 1, creates=True)]),
            Activity('B', [ObjectBinding('Order', 1, 1)]),
        ], constraints=[Constraint('response', 'A', 'B', Scope('each', 'Order'), nmin=2)])
        config = SimulationConfig(max_steps=2, seed=7, start_policy=StartPolicy(['A'], max_case_starts=1))
        state = Simulator(model, config).run()
        self.assertEqual(['A', 'B'], [e.activity_name for e in state.executed_events])
        self.assertEqual(0, state.total_obligations_fulfilled,
                         'Only one of the two required B events occurred.')
        self.assertTrue(state._obligations_count, 'A second B is still owed at this point.')

    def test_newly_created_objects_receive_required_link(self):
        model = StaticModel(activities=[Activity('A', [
            ObjectBinding('Order', 1, 1, creates=True),
            ObjectBinding('Item', 1, 1, creates=True),
        ])], o2o_rules=[O2ORule('Order', 'Item', min_links=1, max_links=1)])
        config = SimulationConfig(max_steps=1, seed=7, start_policy=StartPolicy(['A']))
        state = Simulator(model, config).run()
        self.assertEqual(2, len(state.objects))
        self.assertEqual(1, len(state.links), 'The new Order and Item should be linked.')

    def test_global_maximum_accounts_for_concurrent_starts(self):
        state = SimulationState()
        for _ in range(3):
            state.add_object('Order')
        model = StaticModel(
            activities=[Activity('A', [ObjectBinding('Order', 1, 1, deactivates=True)])],
            constraints=[Constraint('absence', 'A', 'A', Scope('global', ''), nmax=1)],
            activity_durations={'A': ActivityDuration(dist_type='fixed', mean_seconds=10)},
        )
        config = SimulationConfig(max_steps=10, seed=7, start_policy=StartPolicy(['A']))
        result = Simulator(model, config).run(state)
        self.assertEqual(1, len(result.executed_events),
                         'A must occur at most once globally, even with several free objects.')

    def test_all_response_generates_the_required_joint_event(self):
        model = StaticModel(activities=[
            Activity('A', [ObjectBinding('Order', 2, 2, creates=True)]),
            Activity('B', [ObjectBinding('Order', 1, 2, deactivates=True)]),
        ], constraints=[Constraint('response', 'A', 'B', Scope('all', 'Order'), nmin=1)])
        config = SimulationConfig(max_steps=10, seed=7, start_policy=StartPolicy(['A'], max_case_starts=1))
        state = Simulator(model, config).run()
        responses = [e for e in state.executed_events if e.activity_name == 'B']
        self.assertEqual(1, len(responses), 'Both orders should participate in the same B event.')
        self.assertEqual(2, len(responses[0].object_ids))
        self.assertEqual(1, state.total_obligations_fulfilled)
        self.assertEqual(0, state.total_obligations_violated)


if __name__ == '__main__':
    unittest.main()
