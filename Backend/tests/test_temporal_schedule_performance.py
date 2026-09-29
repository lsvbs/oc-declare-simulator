"""Decision equivalence for the reservation-index optimization.

The deliberately unindexed reference retains the pre-optimization algorithm.
It remains useful as an oracle when the production admission path is optimized.
"""
from dataclasses import asdict, replace
from datetime import datetime, timedelta
import itertools
import random
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.Domain.ir import Activity, ObjectBinding, Constraint, Scope, StaticModel
from Backend.src.Simulation.Domain.state import SimulationState, InProgressActivity
from Backend.src.Simulation.Engine.candidategeneration import Candidate, _find_objects_preferring_linked
from Backend.src.Simulation.Engine.semantics import (
    _ProjectedEvents, _scope_assignments, _scope_events, _precedence_counts,
    check_all_constraints, check_temporal_schedule,
)
from Backend.src.Simulation.Engine.simulator import Simulator
from Backend.src.Simulation.IO.output.OCEL2 import build_ocel2_dict
from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict

BASE = datetime(2025, 1, 1)


def moment(seconds):
    return BASE + timedelta(seconds=seconds)


def unindexed_schedule(model, candidate, state, complete_at):
    """Reference: every reservation scans every other reservation (28 Sep)."""
    temporal = [c for c in model.constraints if c.constraint_type in (
        'precedence', 'chain_precedence', 'direct_precedence', 'chain_response', 'direct_response')]
    if not temporal:
        return True
    temporal_model = replace(model, constraints=temporal, _constraints_by_activity={})
    projected = tuple(SimpleNamespace(event_id=('running', i), activity_name=p.candidate_activity_name,
                      object_ids=p.participating_object_ids, timestamp=p.complete_at)
                      for i, p in enumerate(state.in_progress))
    proposed = replace(candidate, evaluation_timestamp=complete_at, projected_events=projected)
    if not check_all_constraints(temporal_model, proposed, state):
        return False
    extra = SimpleNamespace(event_id=('proposed',), activity_name=candidate.activity_name,
                            object_ids=candidate.participating_object_ids, timestamp=complete_at)
    backward_model = replace(temporal_model, constraints=[c for c in temporal if c.constraint_type in (
        'precedence', 'chain_precedence', 'direct_precedence')])
    for event in projected:
        pending = Candidate(event.activity_name, event.object_ids,
                            evaluation_timestamp=event.timestamp,
                            projected_events=(*projected, extra))
        if not check_all_constraints(backward_model, pending, state):
            return False
    return True


class ReservationIndexTests(unittest.TestCase):
    def test_indexed_precedence_counts_match_event_filter_for_all_scope_modes(self):
        rng = random.Random(29019)
        state = SimulationState()
        ids = [state.add_object(t).object_id for t in ['Order', 'Order', 'Item', 'Item']]
        for i in range(50):
            state.record_event(rng.choice('AB'), rng.sample(ids, rng.randrange(5)), moment(i // 2))
        indexes_before = {k: set(v) for k, v in state._event_ids_by_act_obj.items()}
        for mode1, mode2 in itertools.product(['each', 'any', 'all'], repeat=2):
            scope = Scope(mode1, 'Order', (('Order', mode1), ('Item', mode2)))
            constraint = Constraint('precedence', 'A', 'B', scope, 1)
            for mask in range(16):
                for creates in [[], ['Order'], ['Item']]:
                    candidate = Candidate('B', [oid for i, oid in enumerate(ids) if mask & (1 << i)], creates)
                    expected = [len(_scope_events(state, required, anys, 'A'))
                                for required, anys in _scope_assignments(candidate, state, scope)]
                    self.assertEqual(expected, list(_precedence_counts(constraint, candidate, state)))
        global_rule = Constraint('precedence', 'A', 'B', Scope('all', ''), 1)
        self.assertEqual([len(state._events_by_activity['A'])],
                         list(_precedence_counts(global_rule, Candidate('B'), state)))
        self.assertEqual(indexes_before, state._event_ids_by_act_obj)

    def test_index_preserves_filter_order_ties_and_duplicate_events(self):
        state = SimulationState()
        ids = [state.add_object('Order').object_id for _ in range(3)]
        for i, members in enumerate(([0, 1], [1, 2], [], [0, 1, 2])):
            state.record_event('A' if i % 2 else 'B', [ids[j] for j in members], moment(i))
        events = [SimpleNamespace(event_id=i, activity_name='A' if i % 2 else 'B',
                  object_ids=[ids[j] for j in members], timestamp=moment(i // 2))
                  for i, members in enumerate(([1, 2], [0, 1], [], [0, 1, 2]))]
        events.append(events[0])  # A repeated event must not be deduplicated.
        indexed = _ProjectedEvents(events)
        groups = [frozenset(), frozenset(ids[:1]), frozenset(ids[1:]), frozenset(ids)]
        for required, anys, activity in itertools.product(
                groups, [(), *[(g,) for g in groups], (groups[1], groups[2])], [None, 'A', 'B', 'Missing']):
            expected = _scope_events(state, required, anys, activity, tuple(events))
            actual = _scope_events(state, required, anys, activity, indexed)
            self.assertEqual(expected, actual, (required, anys, activity))
            actual.append(events[0])
            self.assertEqual(expected, _scope_events(state, required, anys, activity, indexed))

    def test_admissions_match_reference_in_2000_varied_states(self):
        rng = random.Random(19029)
        kinds = ['precedence', 'chain_precedence', 'direct_precedence',
                 'chain_response', 'direct_response']
        scopes = [Scope('each', 'Order'), Scope('any', 'Order'), Scope('all', 'Order'),
                  Scope('all', ''), Scope('each', 'Order', (('Order', 'each'), ('Item', 'each'))),
                  Scope('any', 'Order', (('Order', 'any'), ('Item', 'all')))]
        outcomes = set()
        for case in range(2000):
            state = SimulationState()
            ids = [state.add_object(t, attributes={'selected': bool(i % 2)}).object_id
                   for i, t in enumerate(['Order', 'Order', 'Item', 'Item'])]
            members = lambda: rng.sample(ids, rng.randrange(len(ids) + 1))
            for _ in range(rng.randrange(8)):
                state.record_event(rng.choice('ABC'), members(),
                                   None if case % 7 == 0 else moment(rng.randrange(3)))
            constraints = [Constraint(rng.choice(kinds), rng.choice('ABC'), rng.choice('ABC'),
                           rng.choice(scopes), rng.randrange(3), rng.choice([None, 0, 1, 2]),
                           {'attribute': 'selected', 'op': '==', 'value': True} if case % 5 == 0 else None)
                           for _ in range(1 + case % 3)]
            model = StaticModel(constraints=constraints)
            state.in_progress = [InProgressActivity(rng.choice('ABC'), members(), [], moment(2),
                                 moment(rng.randrange(2, 6))) for _ in range(case % 5)]
            candidate = Candidate(rng.choice('ABCX'), members(), ['Order'] if case % 3 == 0 else [])
            complete_at = moment(rng.randrange(2, 6))
            before = asdict(state)
            expected = unindexed_schedule(model, candidate, state, complete_at)
            outcomes.add(expected)
            self.assertEqual(expected, check_temporal_schedule(model, candidate, state, complete_at), case)
            self.assertEqual(before, asdict(state), case)
        self.assertEqual({False, True}, outcomes)

    def test_new_admission_sees_new_reservations_and_completed_history(self):
        state = SimulationState()
        oid = state.add_object('Order').object_id
        state.record_event('A', [oid], moment(0))
        model = StaticModel(constraints=[Constraint('chain_precedence', 'A', 'B', Scope('any', 'Order'), 1)])
        candidate = Candidate('B', [oid])
        self.assertTrue(check_temporal_schedule(model, candidate, state, moment(3)))
        state.in_progress.append(InProgressActivity('C', [oid], [], moment(0), moment(2)))
        self.assertFalse(check_temporal_schedule(model, candidate, state, moment(3)))
        state.in_progress.clear()
        self.assertTrue(check_temporal_schedule(model, candidate, state, moment(3)))
        state.record_event('C', [oid], moment(2))
        self.assertFalse(check_temporal_schedule(model, candidate, state, moment(3)))

    def test_full_simulations_preserve_logs_obligations_and_rng_state(self):
        for direct, scope, seed in itertools.product([False, True], ['each', 'any', 'all'], [7, 29]):
            raw = {'object_types': [{'name': 'Order'}], 'activities': [
                {'name': a, 'bindings': [{'object_type': 'Order', 'min_count': 1, 'max_count': 1,
                 'creates': a == 'A', 'deactivates': a == 'C'}]} for a in 'ABC'],
                'constraints': [{'type': kind, 'source_activity': a, 'target_activity': b,
                 'nmin': 1, 'nmax': None, 'scope': {'kind': scope, 'object_type': 'Order'}}
                 for a, b in [('A', 'B'), ('B', 'C')]
                 for kind in (['chain_precedence', 'chain_response'] if direct else ['precedence', 'response'])],
                'activity_durations': {a: {'dist_type': 'exponential', 'mean_seconds': i + 1}
                                       for i, a in enumerate('ABC')},
                'activity_concurrency': {a: 10 for a in 'ABC'}}
            model = parse_ocdeclare_dict(raw)
            config = SimulationConfig(seed=seed, max_steps=180, start_timestamp=BASE,
                                      start_policy=StartPolicy(['A'], max_case_starts=50))
            results = []
            for checker in [unindexed_schedule, check_temporal_schedule]:
                sim = Simulator(model, config)
                with patch('Backend.src.Simulation.Engine.simulator.check_temporal_schedule', checker):
                    state = sim.run()
                self.assertGreaterEqual(state.step_count, 3)
                results.append((build_ocel2_dict(state), state._obligations_count, state.in_progress,
                                state.total_obligations_fulfilled, state.total_obligations_cancelled,
                                sim.rng.getstate()))
            self.assertEqual(results[0], results[1], (direct, scope, seed))


class ResponseSearchReuseTests(unittest.TestCase):
    def test_failed_binding_reused_without_skipping_creation_draws_and_rechecked_next_pass(self):
        scope = Scope('each', 'Order')
        joint = Scope('each', 'Order', (('Order', 'each'), ('Item', 'all')))
        model = StaticModel(activities=[Activity('A'), Activity('C'), Activity('B', [
            ObjectBinding('Order', 1, 1), ObjectBinding('Item', 1, 1),
            ObjectBinding('Tag', 1, 2, creates=True, create_counts=((1, 1), (2, 1))),
        ])], constraints=[Constraint('response', 'A', 'B', scope, 1),
                         Constraint('precedence', 'C', 'B', joint, 1)])
        sim = Simulator(model, SimulationConfig(seed=7, max_steps=100))
        state = SimulationState()
        ids = [state.add_object(t).object_id for t in ('Order', 'Item')]
        for n in range(20):
            event = state.record_event('A', ids, moment(n))
            sim._create_response_obligations(event, state)
        self.assertEqual(20, len(state._obligations_ready))
        before = asdict(state)
        expected_rng = random.Random()
        expected_rng.setstate(sim.rng.getstate())
        for _ in range(20):
            expected_rng.random()
        candidates = []
        with patch.object(sim, '_valid_candidate_binding', wraps=sim._valid_candidate_binding) as validate:
            sim._inject_response_candidates(candidates, set(), state, {})
            # Two possible sampled creation counts yield two distinct bindings.
            self.assertEqual(2, validate.call_count)
        self.assertEqual([], candidates)
        self.assertEqual(before, asdict(state))
        self.assertEqual(expected_rng.getstate(), sim.rng.getstate())

        # C now satisfies precedence; the prior negative result must be gone.
        state.record_event('C', ids, moment(21))
        with patch.object(sim, '_valid_candidate_binding', wraps=sim._valid_candidate_binding) as validate:
            sim._inject_response_candidates(candidates, set(), state, {})
            self.assertEqual(1, validate.call_count)
        self.assertEqual(['B'], [c.activity_name for c in candidates])
        expected_rng.random()
        self.assertEqual(expected_rng.getstate(), sim.rng.getstate())

    def test_link_preference_early_return_preserves_selection(self):
        rng = random.Random(2909)
        ids = [str(i) for i in range(20)]
        for _ in range(100):
            state = SimulationState()
            existing = rng.sample(ids, rng.randrange(21))
            state._links_by_object = {oid: ({'p'} if rng.random() < .3 else {'q'}) for oid in ids}
            linked = [oid for oid in existing if 'p' in state._links_by_object[oid]]
            for count in range(9):
                expected = (linked if linked else existing)[:count]
                self.assertEqual(expected, _find_objects_preferring_linked(state, existing, {'p'}, count))
                self.assertEqual(existing[:count], _find_objects_preferring_linked(state, existing, set(), count))


if __name__ == '__main__':
    unittest.main()
