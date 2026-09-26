"""Relationship effects, OC-Declare/DES boundaries and OCEL interoperability."""
import copy
import importlib.util
import json
import os
import tempfile
import unittest
from contextlib import ExitStack
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from Backend.src.ParameterDiscovery.O2O import discover_o2o_rules
from Backend.src.Simulation.Domain.config import SimulationConfig, StartPolicy
from Backend.src.Simulation.Domain.ir import (
    Activity, ActivityDuration, Constraint, ObjectBinding, O2ORule, Scope, StaticModel,
)
from Backend.src.Simulation.Domain.state import ObjectLink, SimulationState
from Backend.src.Simulation.Engine.candidategeneration import Candidate, is_candidate_semantically_allowed
from Backend.src.Simulation.Engine.linkplanning import plan_o2o_links
from Backend.src.Simulation.Engine.o2o import TransitiveType, obj_L_transitive
from Backend.src.Simulation.Engine.semantics import check_all_constraints, check_o2o_rules
from Backend.src.Simulation.Engine.simulator import Simulator, apply_conservative_link_policy
from Backend.src.Simulation.IO.input.ocel import load_ocel2
from Backend.src.Simulation.IO.output.OCEL2 import build_ocel2_dict, write_ocel2_json
from Backend.src.Simulation.IO.output.metrics import compute_audit


def creation_model(items=1, rules=None):
    return StaticModel(
        activities=[Activity('Create', [ObjectBinding('Order', 1, 1, creates=True),
                                       ObjectBinding('Item', items, items, creates=True)])],
        o2o_rules=rules if rules is not None else [O2ORule('Order', 'Item', 1, 1)],
        activity_durations={'Create': ActivityDuration(dist_type='fixed', mean_seconds=10)},
    )


def one_creation(model=None):
    config = SimulationConfig(max_steps=1, seed=7, start_policy=StartPolicy(['Create']))
    return Simulator(model or creation_model(), config).run()


class LinkPlanningTests(unittest.TestCase):
    def test_creating_both_objects_produces_required_link(self):
        state = one_creation()
        self.assertEqual(2, len(state.objects))
        self.assertEqual([ObjectLink('Order_1', 'Item_1')], state.links)

    def test_all_existing_new_combinations(self):
        for existing_types, new_types in [(['Order', 'Item'], []), (['Order'], ['Item']),
                                          (['Item'], ['Order']), ([], ['Order', 'Item'])]:
            with self.subTest(existing=existing_types):
                state = SimulationState()
                existing = [state.add_object(t).object_id for t in existing_types]
                model = creation_model()
                before = copy.deepcopy(state)
                plan = plan_o2o_links(model, existing, state, new_types)
                self.assertIsNotNone(plan)
                self.assertEqual(before, state, 'Planning must not allocate IDs or change indexes.')
                new_ids = [state.add_object(t).object_id for t in new_types]
                plan.apply(state, new_ids)
                self.assertEqual([ObjectLink('Order_1', 'Item_1')], state.links)

    def test_no_rule_means_no_inferred_links(self):
        self.assertEqual([], one_creation(creation_model(rules=[])).links)

    def test_no_self_links_for_same_type_rule(self):
        state = SimulationState()
        model = StaticModel(o2o_rules=[O2ORule('Item', 'Item', 0, 1)])
        plan = plan_o2o_links(model, [], state, ['Item', 'Item'])
        ids = [state.add_object('Item').object_id for _ in range(2)]
        plan.apply(state, ids)
        self.assertEqual([ObjectLink(*ids)], state.links)

    def test_directional_rule_does_not_impose_reverse_maximum(self):
        state = one_creation(creation_model(items=3, rules=[O2ORule('Item', 'Order', 1, 1, False)]))
        self.assertEqual(3, len(state.links))
        self.assertEqual({'Item_1', 'Item_2', 'Item_3'}, state._linked_by_type['Order_1']['Item'])

    def test_both_asymmetric_bounds_apply_independent_of_rule_order(self):
        rules = [O2ORule('Order', 'Item', 1, 3, False), O2ORule('Item', 'Order', 1, 1, False)]
        for ordered in [rules, rules[::-1]]:
            model = creation_model(items=3, rules=ordered)
            self.assertEqual(3, len(one_creation(model).links))
            self.assertFalse(check_o2o_rules(model, Candidate('Create', [], ['Order', 'Order', 'Item']),
                                            SimulationState()))

    def test_new_objects_cannot_exceed_bidirectional_maximum(self):
        state = one_creation(creation_model(items=2))
        self.assertEqual({}, state.objects)
        self.assertEqual({}, state.next_object_counter)
        self.assertEqual([], state.executed_events)

    def test_existing_links_count_and_reparticipation_does_not_duplicate(self):
        state = one_creation()
        ids = list(state.objects)
        cand = Candidate('Again', ids)
        self.assertTrue(check_o2o_rules(creation_model(), cand, state))
        apply_conservative_link_policy(creation_model(), ids + ids, [], state)
        self.assertEqual(1, len(state.links))
        cand.object_types_to_create = ['Item']
        self.assertFalse(check_o2o_rules(creation_model(), cand, state))

    def test_permissive_rule_cannot_override_restrictive_rule(self):
        rules = [O2ORule('Order', 'Item', 0, None), O2ORule('Item', 'Order', 0, 0, False)]
        for ordered in [rules, rules[::-1]]:
            self.assertIsNone(plan_o2o_links(StaticModel(o2o_rules=ordered), [],
                                            SimulationState(), ['Order', 'Item']))

    def test_preexisting_endpoint_and_new_endpoint_limits_both_apply(self):
        model = creation_model()
        state = SimulationState()
        orders = [state.add_object('Order').object_id for _ in range(2)]
        # Each old Order would have one partner, but the new Item would have two.
        self.assertFalse(check_o2o_rules(model, Candidate('Create', orders, ['Item']), state))

    def test_start_rechecks_stale_plan_before_any_state_or_rng_changes(self):
        model = creation_model()
        state = SimulationState()
        order = state.add_object('Order').object_id
        candidate = Candidate('Create', [order], ['Item'])
        self.assertTrue(check_o2o_rules(model, candidate, state))
        item = state.add_object('Item').object_id
        state.add_link(order, item)
        sim = Simulator(model, SimulationConfig(seed=7))
        before = copy.deepcopy(state)
        rng_before = sim.rng.getstate()
        self.assertIsNone(sim._des_start_activity(candidate, state, []))
        self.assertEqual(before, state)
        self.assertEqual(rng_before, sim.rng.getstate())

    def test_small_cardinalities_match_independent_complete_pair_calculation(self):
        # Exercise both directions and mixed old/new endpoints without mirroring
        # the planner: a complete bipartite plan has exactly the opposite count.
        for orders in range(1, 4):
            for items in range(1, 4):
                for order_max, item_max in [(1, 1), (3, 1), (1, 3), (None, 2), (0, None)]:
                    for existing_order in [False, True]:
                        with self.subTest(orders=orders, items=items, caps=(order_max, item_max),
                                          existing_order=existing_order):
                            state = SimulationState()
                            ids = [state.add_object('Order').object_id] if existing_order else []
                            new_types = ['Order'] * (orders - len(ids)) + ['Item'] * items
                            rules = [O2ORule('Order', 'Item', 0, order_max, False),
                                     O2ORule('Item', 'Order', 0, item_max, False)]
                            plan = plan_o2o_links(StaticModel(o2o_rules=rules), ids, state, new_types)
                            allowed = (order_max is None or items <= order_max) and (
                                item_max is None or orders <= item_max)
                            self.assertEqual(allowed, plan is not None)
                            if allowed:
                                self.assertEqual(orders * items, len(plan.links))


class SemanticBoundaryTests(unittest.TestCase):
    def test_minimum_allows_later_partner_creation_and_is_audited(self):
        model = creation_model(rules=[O2ORule('Order', 'Item', 2, 2, False)])
        state = SimulationState()
        self.assertTrue(check_o2o_rules(model, Candidate('Create', [], ['Order']), state))
        order = state.add_object('Order').object_id
        def audit():
            return compute_audit(state, model)['object_relationship_audit'][0]
        self.assertEqual(1, audit()['below_min_active_count'])
        for _ in range(2):
            plan = plan_o2o_links(model, [order], state, ['Item'])
            self.assertIsNotNone(plan)
            item = state.add_object('Item').object_id
            plan.apply(state, [item])
        self.assertEqual(0, audit()['below_min_active_count'])
        self.assertEqual(0, audit()['above_max_count'])

    def test_audit_separates_unfinished_and_inactive_objects(self):
        model = creation_model()
        state = SimulationState()
        active = state.add_object('Order').object_id
        inactive = state.add_object('Order').object_id
        state.deactivate_object(inactive)
        row = compute_audit(state, model)['object_relationship_audit'][0]
        self.assertEqual([active], row['below_min_active_examples'])
        self.assertEqual([inactive], row['below_min_inactive_examples'])

    def test_links_do_not_bypass_precedence_or_chain_constraints(self):
        state = one_creation()
        ids = list(state.objects)
        for scope_kind in ['each', 'any', 'all']:
            model = replace(creation_model(), constraints=[
                Constraint('precedence', 'Approve', 'Ship', Scope(scope_kind, 'Order'), nmin=1)])
            self.assertFalse(is_candidate_semantically_allowed(model, Candidate('Ship', ids), state))
            self.assertTrue(check_o2o_rules(model, Candidate('Ship', ids), state))
        state.record_event('Approve', ids)
        self.assertTrue(is_candidate_semantically_allowed(model, Candidate('Ship', ids), state))
        chain = replace(model, constraints=[
            Constraint('chain_response', 'Approve', 'Ship', Scope('each', 'Order'), nmin=1)])
        self.assertFalse(check_all_constraints(chain, Candidate('Other', ids), state))
        self.assertTrue(check_all_constraints(chain, Candidate('Ship', ids), state))

    def test_transitive_scope_keeps_rule_direction_and_symmetric_index(self):
        model = creation_model(rules=[O2ORule('Order', 'Item', 1, 1, False)])
        state = one_creation(model)
        self.assertEqual({'Item_1'}, obj_L_transitive(Candidate('X', ['Order_1']), state, model,
                                                     TransitiveType('Order', '>', 'Item')))
        self.assertEqual(set(), obj_L_transitive(Candidate('X', ['Item_1']), state, model,
                                                 TransitiveType('Item', '>', 'Order')))
        self.assertEqual({'Order_1'}, obj_L_transitive(Candidate('X', ['Item_1']), state, model,
                                                      TransitiveType('Item', '<', 'Order')))

    def test_links_at_start_events_only_at_completion_deadline_preserved(self):
        model = creation_model()
        config = SimulationConfig(seed=7, max_sim_time_s=5,
                                  start_policy=StartPolicy(['Create'], max_case_starts=1))
        state = Simulator(model, config).run()
        self.assertEqual(1, len(state.links))
        self.assertEqual([], state.executed_events)
        self.assertEqual(1, len(state.in_progress))
        self.assertEqual(set(state.objects), state._busy_objects)
        self.assertEqual(config.start_timestamp + timedelta(seconds=5), state.current_time)
        self.assertEqual(config.start_timestamp + timedelta(seconds=10), state.in_progress[0].complete_at)

    def test_response_completion_and_timing_match_without_relationship_rules(self):
        model = creation_model()
        model = replace(model, activities=model.activities + [Activity('Finish', [
            ObjectBinding('Order', 1, 1, deactivates=True), ObjectBinding('Item', 1, 1, deactivates=True)])],
            constraints=[Constraint('response', 'Create', 'Finish', Scope('each', 'Order'), nmin=1),
                         Constraint('precedence', 'Create', 'Finish', Scope('each', 'Order'), nmin=1)],
            activity_durations={**model.activity_durations,
                                'Finish': ActivityDuration(dist_type='fixed', mean_seconds=7)})
        config = SimulationConfig(seed=7, max_steps=10,
                                  start_policy=StartPolicy(['Create'], max_case_starts=1))
        linked = Simulator(model, config).run()
        baseline = Simulator(replace(model, o2o_rules=[]), config).run()
        self.assertEqual(['Create', 'Finish'], [e.activity_name for e in linked.executed_events])
        self.assertEqual(baseline.executed_events, linked.executed_events)
        self.assertEqual(1, linked.total_obligations_fulfilled)
        self.assertEqual(0, linked.total_obligations_violated)
        self.assertEqual({}, linked._obligations_count)
        self.assertEqual(2, linked.total_deactivations)
        self.assertEqual(1, len(linked.links), 'Deactivation must retain historical relationships.')

    def test_independent_arrivals_keep_parallel_completion_schedule(self):
        model = replace(creation_model(), interarrival_times={
            'Create': ActivityDuration(dist_type='fixed', mean_seconds=2)})
        config = SimulationConfig(seed=7, max_steps=3,
                                  start_policy=StartPolicy(['Create'], max_case_starts=3))
        state = Simulator(model, config).run()
        self.assertEqual([10, 12, 14], [(e.timestamp - config.start_timestamp).total_seconds()
                                      for e in state.executed_events])
        self.assertEqual(3, len(state.links))
        self.assertEqual(6, len(state.objects))
        for link in state.links:
            self.assertEqual(link.source_object_id.split('_')[-1], link.target_object_id.split('_')[-1])


class ExportTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec('jsonschema'), 'Optional validation dependency: jsonschema')
    def test_export_matches_official_ocel_schema(self):
        import jsonschema
        # Official schema, retrieved from:
        # https://www.ocel-standard.org/2.0/ocel20-schema-json.json (2026-09-25).
        schema = json.loads((Path(__file__).parent / 'fixtures' / 'ocel20-schema-json.json').read_text())
        payload = build_ocel2_dict(one_creation())
        jsonschema.Draft7Validator(schema, format_checker=jsonschema.FormatChecker()).validate(payload)

    def test_standard_structure_preserves_direction_and_deduplicates(self):
        state = one_creation()
        state.links.append(state.links[0])  # Be robust to legacy states with duplicates.
        payload = build_ocel2_dict(state)
        self.assertNotIn('objectRelations', payload)
        objects = {o['id']: o for o in payload['objects']}
        self.assertEqual([{'objectId': 'Item_1', 'qualifier': ''}], objects['Order_1']['relationships'])
        self.assertEqual([], objects['Item_1']['relationships'])
        self.assertEqual({'objectTypes', 'eventTypes', 'objects', 'events'},
                         {k for k, v in payload.items() if isinstance(v, list)})
        self.assertEqual(payload, build_ocel2_dict(state))

    def test_export_rejects_dangling_relationship_instead_of_losing_it(self):
        state = one_creation()
        state.links.append(ObjectLink('Order_1', 'missing'))
        with self.assertRaisesRegex(ValueError, 'unknown object'):
            build_ocel2_dict(state)

    def test_own_loader_and_discovery_recover_asymmetric_bounds(self):
        model = creation_model(items=3, rules=[O2ORule('Order', 'Item', 3, 3, False),
                                              O2ORule('Item', 'Order', 1, 1, False)])
        state = one_creation(model)
        with tempfile.TemporaryDirectory() as directory:
            path = write_ocel2_json(state, out_dir=directory, filename='relationships.json')
            loaded = load_ocel2(str(path))
        edges = {(oid, r['objectId']) for oid, obj in loaded['objects'].items()
                 for r in obj['relationships']}
        self.assertEqual({(link.source_object_id, link.target_object_id) for link in state.links}, edges)
        discovered = {(r['source_type'], r['target_type']):
                      (r['min_links'], r['max_links'], r['bidirectional'])
                      for r in discover_o2o_rules(loaded)}
        self.assertEqual({('Order', 'Item'): (3, 3, False), ('Item', 'Order'): (1, 1, False)}, discovered)

    @unittest.skipUnless(importlib.util.find_spec('pm4py'), 'Optional interoperability dependency: pm4py')
    def test_pm4py_recovers_exact_object_and_event_relationships(self):
        with tempfile.TemporaryDirectory() as directory:
            os.environ.setdefault('MPLCONFIGDIR', directory)
            import pm4py
            state = one_creation()
            path = write_ocel2_json(state, out_dir=directory, filename='relationships.json')
            loaded = pm4py.read_ocel2_json(str(path))
        self.assertEqual({('Order_1', 'Item_1', '')},
                         set(loaded.o2o[['ocel:oid', 'ocel:oid_2', 'ocel:qualifier']].itertuples(index=False, name=None)))
        self.assertEqual({('e1', 'Order_1'), ('e1', 'Item_1')},
                         set(loaded.relations[['ocel:eid', 'ocel:oid']].itertuples(index=False, name=None)))


class RelationshipApiTests(unittest.TestCase):
    def test_simulation_response_reports_audit_and_writes_standard_relationships(self):
        from Backend import server
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            stack.enter_context(patch.object(server, '_load_history', return_value=[]))
            stack.enter_context(patch.object(server, '_save_history'))
            stack.enter_context(patch.object(server, 'METRICS_DIR', directory))
            stack.enter_context(patch.object(server, 'write_ocel2_json', side_effect=
                lambda state, **kwargs: write_ocel2_json(state, out_dir=directory, **kwargs)))
            response = server.app.test_client().post('/api/simulate', json={
                'maxEvents': 1, 'seed': 7, 'startActivities': ['Create'],
                'startActivityCaps': {'Create': 1},
                'modelOverride': {
                    'object_types': ['Order', 'Item'],
                    'activities': [{'name': 'Create', 'bindings': [
                        {'object_type': t, 'min_count': 1, 'max_count': 1, 'creates': True}
                        for t in ['Order', 'Item']]}],
                    'o2o_rules': [{'source_type': 'Order', 'target_type': 'Item',
                                  'min_links': 2, 'max_links': 3, 'bidirectional': False}],
                },
            })
            self.assertEqual(200, response.status_code, response.json)
            result = response.json['results']
            self.assertEqual(1, result['events_count'])
            row = result['audit']['object_relationship_audit'][0]
            self.assertEqual(1, row['below_min_active_count'])
            self.assertEqual(0, row['above_max_count'])
            loaded = load_ocel2(str(Path(directory) / result['output_file']))
            self.assertEqual([{'objectId': 'Item_1', 'qualifier': ''}],
                             loaded['objects']['Order_1']['relationships'])


if __name__ == '__main__':
    unittest.main()
