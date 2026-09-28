"""Regression and independent evaluator checks for joint EP/DP/DF semantics."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import itertools
import unittest

from Backend.src.Evaluation import notebook_measures as nm
from Backend.src.ParameterDiscovery.OCDeclarediscovery import (
    _arcs_to_deco_constraints, _build_discovery_indices, _check_arc, _check_arc_multi_type,
)
from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.Domain.ir import ActivityDuration, Constraint, Scope, StaticModel
from Backend.src.Simulation.Domain.state import SimulationState, InProgressActivity
from Backend.src.Simulation.Engine.candidategeneration import Candidate
from Backend.src.Simulation.Engine.semantics import check_all_constraints, check_temporal_schedule
from Backend.src.Simulation.Engine.simulator import Simulator
from Backend.src.Simulation.IO.output.OCEL2 import build_ocel2_dict
from Backend.src.Simulation.Models.OCDeclare import parse_ocdeclare_dict, parse_ocdeclare_list

BASE = datetime(2025, 1, 1, tzinfo=timezone.utc)


def moment(n):
    return BASE + timedelta(seconds=n)


def make_case(arrow, types, involvement, history, lower=1, upper=None):
    state = SimulationState()
    ids = [state.add_object(t).object_id for t in types]
    for n, (activity, members) in enumerate(history, 1):
        state.record_event(activity, [ids[i] for i in members], moment(n))
    backwards = arrow in ('EP', 'DP')
    arc = {'arc_type': arrow, 'from': 'B' if backwards else 'A',
           'to': 'A' if backwards else 'B', 'counts': [lower, upper],
           'involvement_per_label': involvement}
    raw = {'constraint_orientation': 'arc', 'constraints': [arc],
           'object_types': [{'name': t} for t in dict.fromkeys(types)],
           'activities': [{'name': a, 'bindings': [
               {'object_type': t, 'min_count': types.count(t), 'max_count': types.count(t)}
               for t in dict.fromkeys(types)]} for a in ('A', 'B', 'C')],
           'activity_durations': {a: {'dist_type': 'fixed', 'mean_seconds': 1} for a in ('A', 'B', 'C')}}
    return state, ids, raw, parse_ocdeclare_dict(raw)


class PrecedenceTests(unittest.TestCase):
    def test_original_three_counterexamples_are_blocked_in_actual_runs(self):
        cases = [
            (['Order', 'Order', 'Item', 'Item'], {'Order': 'each', 'Item': 'each'},
             [('A', [0, 2]), ('A', [1, 3])], 1, None),
            (['Order', 'Order'], {'Order': 'each'}, [('A', [0]), ('A', [0]), ('A', [1])], 2, None),
            (['Order'], {'Order': 'each'}, [('A', [0]), ('A', [0])], 1, 1),
        ]
        for types, inv, history, lower, upper in cases:
            with self.subTest(types=types, lower=lower, upper=upper):
                state, ids, raw, model = make_case('EP', types, inv, history, lower, upper)
                self.assertFalse(check_all_constraints(model, Candidate('B', ids), state))
                model = replace(model, activities=[model.activities[1]])
                sim = Simulator(model, SimulationConfig(start_timestamp=moment(10), max_steps=len(history)+1))
                sim.run(state)
                self.assertFalse(any(e.activity_name == 'B' for e in state.executed_events))

    def test_upper_bound_counts_predecessors_and_does_not_cap_target_lifetime(self):
        state, ids, _, model = make_case('EP', ['Order'], {'Order': 'each'},
                                         [('A', [0]), ('B', [0]), ('B', [0])], 1, 1)
        self.assertTrue(check_all_constraints(model, Candidate('B', ids), state))
        model = replace(model, activities=[model.activities[1]])
        Simulator(model, SimulationConfig(start_timestamp=moment(10), max_steps=4)).run(state)
        self.assertEqual(['A', 'B', 'B', 'B'], [e.activity_name for e in state.executed_events])

    def test_declared_counts_win_over_endpoint_statistics(self):
        _, _, raw, _ = make_case('EP', ['Order'], {'Order': 'each'}, [])
        raw['constraints'][0].update(observed_counts={'from': [5, 99], 'to': [8, 12]}, nmin=8, nmax=99)
        constraint = parse_ocdeclare_dict(raw).constraints[0]
        self.assertEqual((1, None), (constraint.nmin, constraint.nmax))

    def test_edited_type_and_endpoints_override_imported_alias_fields(self):
        model = parse_ocdeclare_dict({'constraints': [{
            'constraint_type': 'chain_precedence', 'type': 'response',
            'source_activity': 'EditedA', 'target_activity': 'EditedB',
            'source': 'OldA', 'target': 'OldB', 'nmin': 2, 'nmax': 3,
            'scope': {'kind': 'each', 'object_type': 'Order'}}]})
        c = model.constraints[0]
        self.assertEqual(('chain_precedence', 'EditedA', 'EditedB', 2, 3),
                         (c.constraint_type, c.source_activity, c.target_activity, c.nmin, c.nmax))

    def test_empty_each_is_vacuous_but_empty_any_is_not(self):
        for inv, allowed in [('each', True), ('any', False), ('all', False)]:
            state, _, _, model = make_case('EP', ['Order'], {'Order': inv}, [])
            self.assertEqual(allowed, check_all_constraints(model, Candidate('B', []), state))

    def test_new_object_has_no_predecessor(self):
        state, ids, _, model = make_case('EP', ['Order'], {'Order': 'each'}, [('A', [0])])
        self.assertFalse(check_all_constraints(model, Candidate('B', ids, ['Order']), state))

    def test_inactive_any_scope_is_not_skipped(self):
        state, _, _, model = make_case('EP', ['Order'], {'Order': 'any'}, [])
        state._inactive_scope_types = {'Order'}
        self.assertFalse(check_all_constraints(model, Candidate('B', []), state))

    def test_guard_exemption_survives_prefilter_and_scheduling(self):
        state, ids, _, model = make_case('EP', ['Order'], {'Order': 'each'}, [])
        constraint = replace(model.constraints[0], guard={'attribute': 'subject', 'op': '==', 'value': True})
        model = replace(model, activities=[model.activities[1]], constraints=[constraint], _constraints_by_activity={})
        Simulator(model, SimulationConfig(start_timestamp=BASE, max_steps=1, start_policy=StartPolicy(['B']))).run(state)
        self.assertEqual(['B'], [e.activity_name for e in state.executed_events])

    def test_ep_and_dp_agree_with_notebook_for_every_small_history(self):
        # Mixed Each/All/Any scopes, non-unit bounds, and intervening activities.
        for arrow, inv, bounds in itertools.product(
                ('EP', 'DP'), ({'Order': 'each', 'Item': 'each'}, {'Order': 'any', 'Item': 'all'},
                               {'Order': 'all'}, {}), ((0, 0), (1, None), (2, 2))):
            for acts in itertools.product(('A', 'C'), repeat=3):
                history = list(zip(acts, ([0, 2], [1, 2, 3], [0, 1, 2, 3])))
                state, ids, raw, model = make_case(arrow, ['Order', 'Order', 'Item', 'Item'], inv, history, *bounds)
                candidate = Candidate('B', ids, evaluation_timestamp=moment(4))
                allowed = check_all_constraints(model, candidate, state)
                event = state.record_event('B', ids, moment(4))
                normalized = nm.load_confidence_model(raw)
                expected, _ = nm.satisfies(nm.build_index(build_ocel2_dict(state)), event.event_id, normalized['constraints'][0])
                self.assertEqual(expected, allowed, (arrow, inv, bounds, acts))


class DirectArrowTests(unittest.TestCase):
    def test_external_model_editor_round_trip_preserves_all_scopes(self):
        listed = parse_ocdeclare_list([{'from': 'A', 'to': 'B', 'arc_type': 'DF', 'counts': [1, None],
            'label': {'each': [{'object_type': 'Order'}], 'all': [{'object_type': 'Item'}]}}])
        c = listed.constraints[0]
        editor = {'constraints': [{'constraint_type': c.constraint_type, 'source_activity': c.source_activity,
            'target_activity': c.target_activity, 'nmin': c.nmin, 'nmax': c.nmax,
            'scope': {'kind': c.scope.kind, 'object_type': c.scope.object_type, 'bindings': list(c.scope.bindings)}}]}
        self.assertEqual(c, parse_ocdeclare_dict(editor).constraints[0])

    def test_dictionary_and_list_import_keep_direct_arrows_and_all_labels(self):
        for arrow, kind in [('DF', 'chain_response'), ('DP', 'chain_precedence')]:
            arc = {'from': 'A', 'to': 'B', 'arc_type': arrow, 'counts': [1, 2],
                   'label': {'each': [{'object_type': 'Order'}], 'all': [{'object_type': 'Item'}]}}
            listed = parse_ocdeclare_list([arc]).constraints[0]
            discovered = _arcs_to_deco_constraints([{**arc, 'label': ['Order', 'Item'],
                              'involvement_per_label': {'Order': 'each', 'Item': 'all'}}])
            parsed = parse_ocdeclare_dict({'constraint_orientation': 'arc', 'constraints': discovered}).constraints[0]
            self.assertEqual(kind, listed.constraint_type)
            self.assertEqual(listed, parsed)
            self.assertEqual((('Order', 'each'), ('Item', 'all')), parsed.scope.bindings)

    def test_old_direct_aliases_are_enforced(self):
        state = SimulationState(); oid = state.add_object('Order').object_id
        state.record_event('A', [oid], moment(1))
        for alias, activity in [('direct_response', 'C'), ('direct_precedence', 'B')]:
            model = StaticModel(constraints=[Constraint(alias, 'A', 'B', Scope('each', 'Order'), 1)])
            if alias == 'direct_precedence':
                state.record_event('C', [oid], moment(2))
            self.assertFalse(check_all_constraints(model, Candidate(activity, [oid]), state))

    def test_all_filters_before_directness_partial_events_do_not_intervene(self):
        state, ids, _, model = make_case('DP', ['Order', 'Order'], {'Order': 'all'},
                                        [('A', [0, 1]), ('C', [0])])
        self.assertTrue(check_all_constraints(model, Candidate('B', ids), state))
        state.record_event('C', ids, moment(3))
        self.assertFalse(check_all_constraints(model, Candidate('B', ids), state))

    def test_any_uses_nearest_event_in_the_union(self):
        state, ids, _, model = make_case('DP', ['Order', 'Order'], {'Order': 'any'}, [('A', [0]), ('C', [1])])
        self.assertFalse(check_all_constraints(model, Candidate('B', ids), state))

    def test_df_does_not_block_partial_all_or_unrelated_creation(self):
        state, ids, _, model = make_case('DF', ['Order', 'Order'], {'Order': 'all'}, [('A', [0, 1])])
        self.assertTrue(check_all_constraints(model, Candidate('C', ids[:1]), state))
        self.assertFalse(check_all_constraints(model, Candidate('C', ids), state))
        self.assertTrue(check_all_constraints(model, Candidate('B', ids), state))
        self.assertTrue(check_all_constraints(model, Candidate('A', [], ['Order']), state))
        state.record_event('B', ids, moment(2))
        self.assertTrue(check_all_constraints(model, Candidate('C', ids), state))

    def test_tied_nearest_targets_count_together(self):
        state, ids, _, model = make_case('DP', ['Order'], {'Order': 'each'}, [('A', [0])], 2, 2)
        state.record_event('A', ids, moment(1))
        self.assertTrue(check_all_constraints(model, Candidate('B', ids, evaluation_timestamp=moment(2)), state))
        self.assertFalse(check_all_constraints(model, Candidate('B', ids, evaluation_timestamp=moment(1)), state))

    def test_discovery_filters_full_scope_before_nearest_time(self):
        for arrow in ('DF', 'DP'):
            # C only touches one member of the All group; it is outside scope.
            acts = ['A', 'C', 'B'] if arrow == 'DF' else ['B', 'C', 'A']
            log = {'objects': {'o1': {'type': 'Order'}, 'o2': {'type': 'Order'}, 'i1': {'type': 'Item'}},
                   'events': {str(i): {'activity': a, 'timestamp': moment(i),
                                      'omap': ['o1'] if a == 'C' else ['o1', 'o2', 'i1']}
                              for i, a in enumerate(acts)}}
            idx = _build_discovery_indices(log)
            self.assertIsNotNone(_check_arc(idx, 'A', 'B', arrow, 'Order', 'all', 0))
            self.assertIsNotNone(_check_arc_multi_type(idx, 'A', 'B', arrow,
                                 [('Order', 'all'), ('Item', 'each')], 0))
            # Any includes that C; the matching target is no longer immediate.
            self.assertIsNone(_check_arc(idx, 'A', 'B', arrow, 'Order', 'any', 0))

    def test_discovery_ties_and_upper_bounds(self):
        log = {'objects': {'o1': {'type': 'Order'}}, 'events': {
            'a': {'activity': 'A', 'timestamp': moment(0), 'omap': ['o1']},
            'b1': {'activity': 'B', 'timestamp': moment(1), 'omap': ['o1']},
            'b2': {'activity': 'B', 'timestamp': moment(1), 'omap': ['o1']}}}
        idx = _build_discovery_indices(log)
        self.assertIsNone(_check_arc(idx, 'A', 'B', 'DF', 'Order', 'any', 0, 1, 1))
        arc = _check_arc(idx, 'A', 'B', 'DF', 'Order', 'each', 0, 2, 2)
        self.assertEqual([2, 2], arc['counts'])

    def test_df_run_creates_and_fulfils_obligation_and_export_conforms(self):
        for inv in ({'Order': 'each', 'Item': 'each'}, {'Order': 'all', 'Item': 'any'}):
            _, _, raw, _ = make_case('DF', ['Order', 'Order', 'Item'], inv, [])
            for activity in raw['activities']:
                for binding in activity['bindings']:
                    binding['creates'] = activity['name'] == 'A'
                    binding['deactivates'] = activity['name'] == 'B'
            raw['constraints'].append({'arc_type': 'DP', 'from': 'B', 'to': 'A', 'counts': [1, 1], 'involvement_per_label': inv})
            model = parse_ocdeclare_dict(raw)
            state = Simulator(model, SimulationConfig(start_timestamp=BASE, max_steps=10, seed=3,
                              start_policy=StartPolicy(['A'], max_case_starts=1))).run()
            self.assertEqual(['A', 'B'], [e.activity_name for e in state.executed_events])
            self.assertFalse(state._obligations_count)
            self.assertGreater(state.total_obligations_fulfilled, 0)
            _, summary = nm.evaluate_confidence(nm.build_index(build_ocel2_dict(state)), nm.load_confidence_model(raw))
            self.assertEqual(1, summary['global_confidence'])

    def test_df_admission_matches_notebook_on_closed_direct_windows(self):
        for inv, bound in itertools.product(
                ({'Order': 'each', 'Item': 'each'}, {'Order': 'any', 'Item': 'all'},
                 {'Order': 'all'}, {}), ((1, None), (1, 1), (0, 0))):
            for activity, members in itertools.product(('A', 'B', 'C'), ([0], [0, 2], [0, 1, 2, 3])):
                state, ids, raw, model = make_case('DF', ['Order', 'Order', 'Item', 'Item'], inv,
                                                 [('A', [0, 1, 2, 3])], *bound)
                candidate = Candidate(activity, [ids[i] for i in members], evaluation_timestamp=moment(2))
                allowed = check_all_constraints(model, candidate, state)
                state.record_event(activity, candidate.participating_object_ids, moment(2))
                idx = nm.build_index(build_ocel2_dict(state)); c = nm.load_confidence_model(raw)['constraints'][0]
                # A direct window becomes closed when a first scoped future
                # timestamp exists. Unclosed windows remain future obligations.
                temporal = {**c, 'target_activity': activity, 'arc_type': 'EF'}
                each, alls, anys = nm.involvement(c)
                activation = state.executed_events[0].event_id
                objects = idx['ev_objs'][activation]
                all_objects = set().union(*(objects.get(t, set()) for t in alls))
                expected = True
                for combo in itertools.product(*(sorted(objects.get(t, set())) for t in each)):
                    if nm.matching_events(idx, activation, temporal, combo, all_objects, anys):
                        count = len(nm.matching_events(idx, activation, c, combo, all_objects, anys))
                        expected &= c['nmin'] <= count <= c['nmax']
                self.assertEqual(expected, allowed, (inv, bound, activity, members))

    def test_reserved_dp_is_not_broken_by_new_completion(self):
        state, ids, _, model = make_case('DP', ['Order', 'Order'], {'Order': 'any'}, [('A', [0, 1])])
        # B involves both Any members. A new C on o2 would be its nearest event.
        state.in_progress.append(InProgressActivity('B', ids, [], moment(2), moment(10)))
        self.assertFalse(check_temporal_schedule(model, Candidate('C', ids[1:]), state, moment(5)))
        self.assertTrue(check_temporal_schedule(model, Candidate('C', ids[1:]), state, moment(11)))

    def test_zero_duration_cannot_fulfil_strict_precedence(self):
        state, ids, _, model = make_case('EP', ['Order'], {'Order': 'each'}, [('A', [0])])
        model = replace(model, activities=[model.activities[1]], activity_durations={'B': ActivityDuration('fixed', 0)})
        sim = Simulator(model, SimulationConfig(start_timestamp=moment(1), max_steps=2))
        sim.run(state)
        self.assertEqual(['A'], [e.activity_name for e in state.executed_events])
        self.assertFalse(state.in_progress)
        self.assertFalse(state._busy_objects)


if __name__ == '__main__':
    unittest.main()
