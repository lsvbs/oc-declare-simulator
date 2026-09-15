from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from datetime import timedelta
from itertools import product as _iproduct
from typing import Optional

from src.Simulation.Domain.ir import StaticModel, Activity
from src.Simulation.Domain.state import SimulationState, PendingObligation, InProgressActivity
# [resource/permanent-object handling — disabled, kept for reference] WaitingCandidate
from src.Simulation.Domain.config import SimulationConfig
from src.Simulation.Engine.selection import select_candidate as default_select_candidate
from src.Simulation.Engine.candidategeneration import (
    Candidate,
    build_candidate_for_activity,
    find_active_objects_of_type,
    build_candidate_for_object_and_activity,
    is_candidate_semantically_allowed,
)
from src.Simulation.Engine.semantics import _count_activity_for_object


def _apply_attribute_update(obj, upd: dict, timestamp=None) -> None:
    """Apply a single attribute update dict to a RuntimeObject in-place."""
    attr = upd.get('attribute', '')
    op   = upd.get('op', 'set')
    if not attr:
        return
    if op == 'set':
        obj.attributes[attr] = upd.get('value')
    elif op == 'increment':
        obj.attributes[attr] = obj.attributes.get(attr, 0) + upd.get('by', 1)
    elif op == 'decrement':
        obj.attributes[attr] = obj.attributes.get(attr, 0) - upd.get('by', 1)
    # Phase 4: record timestamped change in attribute history
    obj.attribute_history.append((timestamp, attr, obj.attributes[attr]))


def apply_conservative_link_policy(static_model, participating_ids, created_object_ids, state):
    """Create O2O links after an activity fires.

    Only writes a link between two objects if:
      1. An O2O rule covers their types, AND
      2. The link does not already exist, AND
      3. Neither object would exceed the rule's max_links by adding this link.

    This prevents pre-existing objects from other cases being spuriously linked
    to newly created objects, which would saturate O2O caps and block future
    activities on those objects.
    """

    def _link_exists(src: str, tgt: str) -> bool:
        neighbors = state._links_by_object.get(src)
        return neighbors is not None and tgt in neighbors

    def _count_links(oid: str, other_type: str) -> int:
        # O(1) via typed index if available, else O(degree) fallback
        lbt = getattr(state, '_linked_by_type', None)
        if lbt is not None:
            return len(lbt.get(oid, {}).get(other_type, frozenset()))
        count = 0
        for neighbor_id in state._links_by_object.get(oid, ()):
            obj = state.objects.get(neighbor_id)
            if obj and obj.object_type == other_type:
                count += 1
        return count

    def _can_link(id_a: str, type_a: str, id_b: str, type_b: str, rule) -> bool:
        """True if adding this link would not exceed max_links on either side."""
        if rule.max_links is None:
            return True
        if rule.source_type == type_a and rule.target_type == type_b:
            return (_count_links(id_a, type_b) < rule.max_links and
                    _count_links(id_b, type_a) < rule.max_links)
        if rule.source_type == type_b and rule.target_type == type_a:
            return (_count_links(id_b, type_a) < rule.max_links and
                    _count_links(id_a, type_b) < rule.max_links)
        return True

    # 1. Link every newly created object to every applicable participating object
    for created_id in created_object_ids:
        created_obj = state.objects.get(created_id)
        if created_obj is None:
            continue
        created_type = created_obj.object_type

        for pid in participating_ids:
            p_obj = state.objects.get(pid)
            if p_obj is None:
                continue
            p_type = p_obj.object_type

            for rule in static_model.o2o_rules:
                if rule.source_type == p_type and rule.target_type == created_type:
                    if not _link_exists(pid, created_id) and _can_link(pid, p_type, created_id, created_type, rule):
                        state.add_link(source_object_id=pid, target_object_id=created_id)
                elif rule.source_type == created_type and rule.target_type == p_type:
                    if not _link_exists(created_id, pid) and _can_link(created_id, created_type, pid, p_type, rule):
                        state.add_link(source_object_id=created_id, target_object_id=pid)

    # 2. Also link participating objects to each other where an O2O rule applies
    for i, pid1 in enumerate(participating_ids):
        p1_obj = state.objects.get(pid1)
        if p1_obj is None:
            continue
        for pid2 in participating_ids[i + 1:]:
            p2_obj = state.objects.get(pid2)
            if p2_obj is None:
                continue
            for rule in static_model.o2o_rules:
                if rule.source_type == p1_obj.object_type and rule.target_type == p2_obj.object_type:
                    if not _link_exists(pid1, pid2) and _can_link(pid1, p1_obj.object_type, pid2, p2_obj.object_type, rule):
                        state.add_link(source_object_id=pid1, target_object_id=pid2)
                elif rule.source_type == p2_obj.object_type and rule.target_type == p1_obj.object_type:
                    if not _link_exists(pid2, pid1) and _can_link(pid2, p2_obj.object_type, pid1, p1_obj.object_type, rule):
                        state.add_link(source_object_id=pid2, target_object_id=pid1)



class Simulator:
    def __init__(
        self,
        static_model: StaticModel,
        config: SimulationConfig,
        rng: object | None = None,
        *,
        trace_func: callable | None = None,
        select_func: callable | None = None,
        stop_event=None,  # threading.Event — set to request early termination
        transition_matrix: dict | None = None,
        start_counts: dict | None = None,  # {activity: count} from OC discovery, used as fallback weights
    ):
        """Create a Simulator.

        Parameters
        - static_model: the StaticModel to simulate
        - config: SimulationConfig with max_steps and optional seed
        - rng: optional Random-like instance. If omitted, an RNG is created from config.seed
        """
        self.static_model = static_model
        self.config = config
        # deterministic RNG for reproducible selection when seed provided
        # Accept an injected RNG for testability; otherwise create one from config.seed
        from src.Simulation.Engine.rng import get_rng

        if rng is None:
            self.rng = get_rng(self.config.seed)
        else:
            # allow passing either a Random instance or an RNG provider with .rng
            self.rng = getattr(rng, "rng", rng)

        from src.Simulation.Engine.timepolicy import DefaultTimePolicy, DistributionTimePolicy
        durations = getattr(static_model, "activity_durations", {}) or {}
        if durations:
            self.time_policy = DistributionTimePolicy(durations=durations)
        else:
            self.time_policy = DefaultTimePolicy()

        # selection function can be overridden by tests or higher-level orchestration
        self.select_func = select_func or default_select_candidate

        # Optional tracing hook (kept generic to avoid coupling the engine to stdout/logging).
        # Signature: trace_func(event: str, payload: dict)
        self.trace_func = trace_func

        # Optional stop signal: caller sets this threading.Event to request early stop.
        self.stop_event = stop_event

        # Transition matrix used to probabilistically gate no-input start activities
        # in DES mode (prevents them from firing every single step unconditionally).
        self.transition_matrix = transition_matrix or {}
        # Trace-start counts from OC discovery: used as fallback weights for start
        # activities that don't appear in the last row of the transition matrix.
        self.start_counts = start_counts or {}

        # ── Hot-path caches (computed once, reused every step) ────────────────
        # [resource/permanent-object handling — disabled, kept for reference]
        # #2: resource types as a set — avoids rebuilding set(...) in every generator call
        # self._resource_types_set: set = set(getattr(static_model, 'resource_types', []) or [])
        # Master switch: forcing this empty makes every resource-aware branch
        # throughout the engine degrade to its already-correct "no resources" path.
        self._resource_types_set: set = set()

        # #3: start activity names as a set — avoids rebuilding set(...) per step
        self._start_names_set: set = set(config.start_policy.start_activity_names)

        # #4: activity name → Activity dict — avoids O(A) scan in obligation injection
        self._act_by_name: dict = {a.name: a for a in static_model.activities}

        # #4: precedence constraints indexed by target_activity — avoids O(C) scan per step
        self._prec_by_target: dict = {}
        for con in static_model.constraints:
            if con.constraint_type == 'precedence':
                self._prec_by_target.setdefault(con.target_activity, []).append(con)

        # #8: response constraints indexed by source_activity — avoids O(C) scan per event
        self._response_by_source: dict = {}
        for con in static_model.constraints:
            if con.constraint_type == 'response':
                self._response_by_source.setdefault(con.source_activity, []).append(con)

        # Phase 1: For each response target B, which precedence sources must fire first?
        # _obligation_prerequisites[target_act][scope_type] = [required_source_activities]
        self._obligation_prerequisites: dict = {}
        for con in static_model.constraints:
            if con.constraint_type not in ('response', 'chain_response'):
                continue
            tgt = con.target_activity
            scope_type = getattr(con.scope, 'object_type', None) if con.scope else None
            prec_gates = [
                p.source_activity for p in static_model.constraints
                if p.constraint_type == 'precedence'
                and p.target_activity == tgt
                and getattr(p.scope, 'object_type', None) == scope_type
                and getattr(p, 'nmin', 0) > 0
            ]
            if prec_gates:
                self._obligation_prerequisites.setdefault(tgt, {}).setdefault(
                    scope_type, []).extend(prec_gates)

        # Phase 2: Non-resource, non-creating object types required per activity
        # Used to skip activities whose required types are all inactive
        self._activity_required_types: dict = {}
        # [resource/permanent-object handling — disabled, kept for reference]
        # resource_set = set(getattr(static_model, 'resource_types', []) or [])
        resource_set: set = set()
        for activity in static_model.activities:
            required = {
                b.object_type for b in activity.bindings
                if not b.creates and b.object_type not in resource_set
            }
            if required:
                self._activity_required_types[activity.name] = required

        # Inverted index of the above: object_type -> activities that need an
        # existing (non-creates) instance of it. Used by the incremental
        # candidate pool (#23) to know which activities to fully rescan when
        # a new instance of a type appears — a previously supply-starved
        # primary object can only newly succeed for activities that actually
        # require that type.
        self._activities_requiring_type: dict = {}
        for act_name, types in self._activity_required_types.items():
            for t in types:
                self._activities_requiring_type.setdefault(t, set()).add(act_name)

        # [#25 work-in-progress caps — REMOVED]
        # A per-type ceiling on simultaneously-active objects used to be enforced
        # here. It was admission control: an activity creating an instance of a
        # type already at its ceiling was refused until one deactivated.
        #
        # Removed deliberately. How many objects of a type are alive at once is
        # not something a process rule decides — in the source log Containers
        # peak at 102 because arrival rate times lifecycle duration happens to
        # equal that (L = lambda * W), not because anything refused to create the
        # 103rd. Capping it suppressed the symptom of an unbalanced model rather
        # than fixing the cause, and made an emergent quantity an input.
        #
        # Object population is now unbounded and emergent. discover_wip_caps is
        # kept in ParameterDiscovery as a *validation* measure: comparing the
        # simulated peak against the log's is how you check the model balances.
        # ── Per-activity concurrency ceiling (#26) ─────────────────────────
        # Maximum simultaneously in-progress instances of an activity, measured
        # from the log. Objects are created when an activity *starts*, so an
        # activity that starts far faster than it completes manufactures
        # objects without limit: 'Register Customer Order' (service ~51157s,
        # one candidate per step) reached 593 concurrent instances against a
        # real-log peak of 3, and every one of them had already created its
        # Customer Order. This bounds state.in_progress at source.
        #
        # This one DOES apply to start activities — it paces arrivals rather
        # than refusing them for want of downstream capacity, so it is the
        # "cap set on the start activity" that governs them.
        self._activity_concurrency: dict = dict(
            getattr(static_model, 'activity_concurrency', {}) or {})

        # ── Inter-arrival pacing for input-less activities (#26) ───────────
        # An activity with no input object bindings gets exactly one candidate
        # per simulation step, so without pacing it fires on essentially every
        # step and the step structure becomes the arrival rate. Where the log
        # gives a measured inter-arrival distribution we schedule the next
        # permitted start instead, and skip the transition-probability gate
        # (which was only ever a stand-in for this).
        # Only activities with NO input object bindings are arrivals. For every
        # other activity a measured inter-arrival gap is meaningless: those
        # events serve many different objects, often concurrently, so gating on
        # the global gap between consecutive occurrences serialises something
        # the real process ran in parallel — and it compounds with the other
        # admission gates, since throughput becomes the minimum of all of them.
        #
        # Measured before this restriction: inter-arrival was the largest single
        # refuser at 12,147 of 26,599 gate refusals, and it was refusing
        # activities that are not arrivals — 'Reschedule Container' 1,798
        # refusals for 1 start, 'Order Empty Containers' 1,794 for 48,
        # 'Depart' 1,785 for 7.
        _inputless = {
            a.name for a in static_model.activities
            if not [b for b in a.bindings if not b.creates]
        }
        self._interarrival: dict = {
            k: v for k, v in (getattr(static_model, 'interarrival_times', {}) or {}).items()
            if k in _inputless
        }

        # ── Probabilistic weekly availability calendars (#29) ──────────────
        # Per-activity slot probabilities discovered from the log. This is the
        # layer that produces overnight and weekend waiting with the right
        # shape, rather than sampling a waiting distribution that reproduces
        # only its mean and emits events at 03:00 on Sundays.
        # Calendars are per ACTIVITY, not per resource: OCEL events carry no
        # resource attribute. See discover_activity_calendars for that and the
        # two other deviations from SIMOD's pipeline.
        self._activity_calendars: dict = dict(
            getattr(static_model, 'activity_calendars', {}) or {})

        # ── Object-local candidate ordering (#30) ──────────────────────────
        # P(next activity | object type, last activity on THAT object), measured
        # from the log. Used to order candidates that compete for the same
        # object, replacing the global transition matrix for that decision —
        # which conditioned on the last event anywhere in the process and so
        # carried no information about the contested object.
        self._object_transitions: dict = dict(
            getattr(static_model, 'object_transitions', {}) or {})
        # Primary object type per activity = first non-creating binding, the
        # same rule _generate_candidates_des uses to pick which object a
        # candidate is derived for.
        self._primary_type_by_activity: dict = {}
        for _a in static_model.activities:
            _nc = [b.object_type for b in _a.bindings if not b.creates]
            if _nc:
                self._primary_type_by_activity[_a.name] = _nc[0]

        # ── Incremental-candidate-pool safety classification (#23) ─────────
        # An activity is "incremental-safe" iff none of its relevant
        # constraints can reach a global-fallback branch — one whose result
        # depends on model-wide state rather than the specific candidate's
        # own participants (e.g. check_absence's "not scope_ids" branch
        # falling back to a raw len(state._events_by_activity[...]) count).
        # Activities that fail this are simply excluded from incremental
        # treatment and always get the full per-step rescan — see
        # _generate_candidates_des. This was derived by auditing every
        # constraint checker in semantics.py; see the design plan for the
        # full derivation (playful-frolicking-squirrel.md).
        def _has_required_binding(act_name: str, object_type: str) -> bool:
            act = self._act_by_name.get(act_name)
            if act is None:
                return False
            return any(b.object_type == object_type and b.min_count >= 1 for b in act.bindings)

        def _has_creates_binding(act_name: str, object_type: str) -> bool:
            act = self._act_by_name.get(act_name)
            if act is None:
                return False
            return any(b.object_type == object_type and b.creates for b in act.bindings)

        unsafe_activities: set = set()
        for con in static_model.constraints:
            kind = con.constraint_type
            scope = con.scope
            is_multitype = bool(getattr(scope, 'bindings', None))
            scope_kind_ok = scope.kind in ('each', 'any', 'all')
            src, tgt, ot = con.source_activity, con.target_activity, scope.object_type

            if not scope_kind_ok and not is_multitype:
                # Truly unscoped constraint — always model-wide, for any type
                # except response/responded_existence which never look at
                # scope at all (checked again below, but short-circuit here).
                if kind not in ('response', 'responded_existence'):
                    unsafe_activities.update((src, tgt))
                continue

            if kind in ('response', 'responded_existence', 'not_coexistence',
                        'not_precedence', 'chain_precedence', 'init', 'coexistence'):
                # Every branch of these checkers is either candidate-local or
                # already returns a safe (True) result on an empty scope —
                # confirmed by reading each function in semantics.py.
                continue

            if kind == 'precedence' or kind == 'succession':
                if is_multitype:
                    continue  # joint multi-type check is always candidate-local
                if con.nmin and con.nmin > 0 and not _has_required_binding(tgt, ot):
                    unsafe_activities.add(tgt)
                continue

            if kind == 'chain_response' or kind == 'chain_succession':
                # Global "armed" scan over state._active_by_type only reachable
                # when this activity is the source AND creates the scope type.
                if _has_creates_binding(src, ot):
                    unsafe_activities.add(src)
                continue

            if kind in ('absence', 'exactly', 'not_succession', 'not_chain_succession'):
                # Unlike precedence, these have NO nmin/nmax escape hatch and
                # fall back to a global count unconditionally for any
                # non-"each" scope kind (including any/all — not just empty
                # scope) — confirmed by reading the actual branch structure.
                if scope.kind != 'each' or not _has_required_binding(tgt, ot):
                    unsafe_activities.add(tgt)
                continue

            if kind == 'exclusive_choice':
                if scope.kind != 'each':
                    unsafe_activities.update((src, tgt))
                continue

            if kind == 'alternate_response':
                if scope.kind != 'each':
                    unsafe_activities.add(src)
                continue

            if kind == 'alternate_precedence':
                if scope.kind != 'each':
                    unsafe_activities.add(tgt)
                continue

            if kind == 'alternate_succession':
                if scope.kind != 'each':
                    unsafe_activities.update((src, tgt))
                continue

            # Any future/unrecognised constraint type: conservatively unsafe.
            unsafe_activities.update((src, tgt))

        # #25: an activity whose start can be deferred by WIP admission control
        # is never incremental-safe. Before #25 every generated candidate started
        # immediately, so _des_start_activity pruned it and the pool was drained
        # each step — pool entries never actually survived a step, and the
        # dirty-tracking was never exercised for persistence. A deferred
        # candidate does persist, and can then go stale without any of its
        # participants being dirtied (caught by SIM_DEBUG_POOL_CHECK as a
        # spurious extra pool entry for 'Order Empty Containers'). These
        # activities therefore keep the unmodified full rescan every step.
        # The cost is small precisely because WIP caps bound the active-object
        # sets the rescan iterates over.
        # #23 incremental candidate pool — DISABLED (empty set = every
        # activity full-rescans each step, the pre-#23 behaviour).
        #
        # The pool cached derived candidates and re-derived only those whose
        # participants an event had dirtied. It was worth ~19-36% on large runs,
        # but it has now produced six distinct correctness defects, each found
        # only because SIM_DEBUG_POOL_CHECK cross-checks it against a full
        # rescan: force_object_id silently ignored, objects becoming free not
        # dirtying their type, objects becoming busy not dirtying at all, skipped
        # activities never consuming the step's dirty set, and two classes of
        # stale entry once admission gates could defer a candidate.
        #
        # The root difficulty is structural: the pool is only sound if every
        # reason a candidate can appear or disappear is accompanied by an event
        # that dirties one of ITS participants. Deferral-based gates break that
        # (a calendar slot opens because the clock moved; a concurrency slot
        # frees when a different object finishes), and so does secondary-object
        # selection inside build_candidate_for_activity, which can change
        # without touching the primary.
        #
        # Correctness over speed while the model is still being validated. The
        # machinery is left intact — restoring it is a matter of computing this
        # set again — but it should not come back without an argument for why
        # the invariant now holds.
        self._incremental_safe_activities: set = set()

        # Debug-only cross-check (#23): when enabled, every call to
        # _generate_candidates_des re-derives a fresh full rescan for each
        # incremental-safe activity and asserts it matches the pool exactly.
        # Off by default (real per-step cost) — opt in for testing.
        import os as _os
        self._debug_pool_check: bool = _os.environ.get('SIM_DEBUG_POOL_CHECK') == '1'

        # Reusable set for obligation dedup — cleared each step, avoids per-step allocation
        self._seen_obligation_keys: set = set()
        # Delta tracking for iteration log: last-seen cumulative counters
        self._last_deactivations: int = 0
        self._last_obligations_fulfilled: int = 0

    def _trace(self, event: str, payload: dict) -> None:
        if self.trace_func is None:
            return
        try:
            self.trace_func(event, payload)
        except Exception:
            # Tracing should never break the simulation.
            return

    def run(self, state=None):
        """Alias for run_des — the sole simulation entry point."""
        return self.run_des(state)

    def _pool_invalidate_activity(self, activity_name: str, state: SimulationState) -> None:
        """Drop every pooled entry for an activity and force a full rescan next time.

        Needed wherever _generate_candidates_des skips an activity before its
        incremental update runs: this step's dirty sets are consumed and
        cleared once at the top of the call, so a skipped activity never sees
        them and any entry that should have been invalidated would survive
        indefinitely. Dropping the entries and clearing the bootstrap flag
        makes the activity re-derive from scratch when it is next considered.
        """
        keys = state._candidate_pool_keys_by_activity.get(activity_name)
        if keys:
            for oid in list(keys):
                state.pool_remove((activity_name, oid))
        state._pool_initialized_activities.discard(activity_name)

    def _candidate_weight(self, candidate, state: SimulationState) -> float:
        """P(this activity | type of the candidate's primary object, that object's
        last activity) — the preference weight used to order candidates (#30).

        Primary object only. Multiplying across every participating object was
        measured as an alternative and picks the same winner 99.4% of the time
        while scoring worse on log-loss (0.464 vs 0.163), because multiplying
        sub-1 probabilities thins the true activity's score. See
        discover_object_transition_matrix.

        Returns 1.0 — neutral — when there is nothing to go on: no matrix, an
        input-less activity (no primary object), or an unseen state. A weight of
        0 means "the log never showed this next", which orders the candidate
        last but never blocks it: the constraints have already ruled on whether
        it is legal, and this is only a preference.
        """
        trans = self._object_transitions
        if not trans:
            return 1.0
        ptype = self._primary_type_by_activity.get(candidate.activity_name)
        if not ptype:
            return 1.0
        oid = None
        for o in candidate.participating_object_ids:
            if state._type_of_object.get(o) == ptype:
                oid = o
                break
        if oid is None:
            return 1.0
        last = state._last_activity_per_object.get(oid, '<START>')
        by_last = trans.get(ptype)
        if not by_last:
            return 1.0
        row = by_last.get(last)
        if not row:
            return 1.0
        return float(row.get(candidate.activity_name, 0.0))

    def _order_candidates(self, candidates: list, state: SimulationState) -> list:
        """Order candidates by object-local preference (#30).

        Every candidate is weighted and the whole list is shuffled in proportion
        to those weights — not just one winner promoted to the front, which is
        what the old global-matrix path did. The remainder then fell back to the
        order activities happen to appear in the model file, so whichever
        activity was declared first won most contests for a shared object. File
        order is not a modelling decision.

        Weighted shuffle without replacement via Efraimidis-Spirakis: key =
        U^(1/w), sorted descending. O(n log n), and unlike repeated sampling it
        needs no rescan per pick.
        """
        if len(candidates) < 2:
            return list(candidates)
        if not self._object_transitions:
            # No matrix — keep the previous behaviour exactly.
            ordered = list(candidates)
            try:
                top = self._select_candidate(ordered, state)
                return [top] + [c for c in ordered if c is not top]
            except Exception:
                return ordered
        _eps = 1e-9
        keyed = []
        for c in candidates:
            w = self._candidate_weight(c, state)
            if w <= 0.0:
                w = _eps
            u = self.rng.random()
            if u <= 0.0:
                u = _eps
            keyed.append((u ** (1.0 / w), c))
        keyed.sort(key=lambda kc: -kc[0])
        return [c for _k, c in keyed]

    def _calendar_for(self, activity_name: str):
        """Weekly availability calendar for an activity, or None if uncalendared (#29)."""
        cals = self._activity_calendars
        if not cals:
            return None
        per = cals.get('per_activity') or {}
        cal = per.get(activity_name)
        if cal is None:
            cal = cals.get('global')
        return cal if cal else None

    def _calendar_open(self, activity_name: str, state: SimulationState) -> bool:
        """Is this activity's calendar open for the current clock hour? (#29)

        ONE shared roll per (activity, hour), not one per candidate. If the hour
        is open every waiting candidate for the activity may start; if closed,
        none may. That is the paper's reading of an availability calendar — the
        resource performing the activity is or is not available in this slot —
        and it composes with the concurrency ceiling (#26), which then decides
        how many of the waiting candidates actually run.

        Rolling per candidate instead would model unboundedly many independent
        resources: with many candidates pending, some would pass even a 1%
        slot, and starts would smear evenly across the day instead of bursting
        when the facility opens.

        The decision is cached per activity for the current hour and re-rolled
        when the clock moves on, so it stays stable within the hour without
        retaining history.
        """
        cal = self._calendar_for(activity_name)
        if cal is None or state.current_time is None:
            return True
        hour = state.current_time.replace(minute=0, second=0, microsecond=0)
        cached = state._calendar_slot_open.get(activity_name)
        if cached is not None and cached[0] == hour:
            return cached[1]
        slot = hour.weekday() * 24 + hour.hour
        p = cal[slot] if slot < len(cal) else 1.0
        is_open = self.rng.random() < p
        state._calendar_slot_open[activity_name] = (hour, is_open)
        return is_open

    def _objects_free(self, candidate, state: SimulationState) -> bool:
        """Return True unless any participant is already inside another activity (#27).

        Must be re-checked in the start loop, not only at candidate generation:
        the whole candidate set is derived against the pre-start state, so two
        candidates can each be built holding object X while X was free, and the
        first to start claims it. Without the re-check the second would start
        anyway and X would sit in two activity instances at once.
        """
        busy = state._busy_objects
        if not busy:
            return True
        for oid in candidate.participating_object_ids:
            if oid in busy:
                return False
        return True

    def _concurrency_allows(self, candidate, state: SimulationState) -> bool:
        """Return True unless the activity is already at its concurrency ceiling (#26).

        Placement rationale: completions happen in
        _des_complete_activity before candidate generation and starts happen in
        the start loop after it, so the in-progress count only grows within a
        step. That makes the check exact at generation time and still correct
        when re-applied per candidate as the start loop proceeds.
        """
        caps = self._activity_concurrency
        if not caps:
            return True
        cap = caps.get(candidate.activity_name)
        if cap is None:
            return True
        return state._in_progress_by_activity.get(candidate.activity_name, 0) < cap

    def _arrival_allows(self, activity_name: str, state: SimulationState) -> bool:
        """Return True if `activity_name` may start now under inter-arrival pacing (#26).

        Activities without a measured inter-arrival distribution are never
        gated here. The first start is always permitted; subsequent ones wait
        until the sampled gap has elapsed on the simulation clock.
        """
        if not self._interarrival or activity_name not in self._interarrival:
            return True
        due = state._next_arrival_at.get(activity_name)
        if due is None:
            return True
        return state.current_time >= due

    def _schedule_next_arrival(self, activity_name: str, state: SimulationState) -> None:
        """Sample the next permitted start time for a paced activity (#26).

        The next due time is measured from the *previous due time*, not from
        the current clock. Scheduling from `state.current_time` lets the
        arrival process drift late and silently drop arrivals: the clock
        advances to the next completion — or, when nothing is running, leaps to
        the next scheduled arrival, which can be tens of thousands of seconds
        away — and every due time skipped in that leap is lost. One firing
        happens where five were due, so the effective rate falls below the
        measured one, less work is in flight, the system idles more, and the
        clock leaps further. It compounds.

        Anchoring on the previous due time makes the schedule a proper arrival
        process: a due time left behind by a clock jump stays in the past, so
        the activity is immediately eligible again and catches up one firing
        per step until the schedule is ahead of the clock. The per-activity
        concurrency ceiling (#26) bounds how much can be in flight while it
        catches up, so this cannot burst without limit.
        """
        dur = self._interarrival.get(activity_name)
        if dur is None or state.current_time is None:
            return
        from src.Simulation.Engine.timepolicy import _sample_duration
        gap = _sample_duration(dur, rng=self.rng)
        if gap is None or gap < 0:
            gap = 0.0
        prev_due = state._next_arrival_at.get(activity_name)
        base = prev_due if prev_due is not None else state.current_time
        state._next_arrival_at[activity_name] = base + timedelta(seconds=gap)

    def _is_start_activity_blocked(self, candidate, state: SimulationState) -> bool:
        """Return True if this start activity has hit its cap (global or per-activity)."""
        start_names = set(self.config.start_policy.start_activity_names)
        act = candidate.activity_name
        if act not in start_names:
            return False
        # Global cap
        max_starts = self.config.start_policy.max_case_starts
        if max_starts is not None and state._start_event_count >= max_starts:
            return True
        # Per-activity cap
        caps = self.config.start_policy.start_activity_caps or {}
        if act in caps and caps[act] is not None:
            fired = state._start_event_count_by_activity.get(act, 0)
            if fired >= caps[act]:
                return True
        return False

    def _should_stop(self, state: SimulationState) -> bool:
        # Time-based limit (primary)
        max_time = getattr(self.config, 'max_sim_time_s', None)
        if max_time is not None and state.last_generated_timestamp is not None:
            elapsed = (state.last_generated_timestamp - self.config.start_timestamp).total_seconds()
            if elapsed >= max_time:
                return True
        # Trace-based limit (primary)
        max_tr = getattr(self.config, 'max_traces', None)
        if max_tr is not None:
            if state.completed_trace_count >= max_tr:
                return True
        # Case-based limit: stop when start-activity firings reach the target
        max_ca = getattr(self.config, 'max_cases', None)
        if max_ca is not None:
            if state._start_event_count >= max_ca:
                return True
        # Event/step cap (safety backstop — always applies)
        if state.step_count >= self.config.max_steps:
            return True
        return False

    def _generate_candidates_des(self, state: SimulationState) -> list[Candidate]:
        """Generate one candidate per (activity, non-resource object) combination for DES mode.

        Unlike the global generator which produces one candidate per activity,
        this expands across non-resource objects so that each case object (e.g.
        each order) gets its own candidate entry. Multiple candidates for the
        same activity can then compete for the same resource and queue when it
        is occupied.
        """
        resource_types: set[str] = self._resource_types_set
        is_simulation_start = len(state.executed_events) == 0 and not state.in_progress
        start_activity_names = self._start_names_set
        candidates: list[Candidate] = []
        seen_keys: set[tuple] = set()
        # Memoizes find_active_objects_of_type(object_type, limit) for the
        # duration of this pass — state is read-only until candidates are
        # chosen and started later, so identical lookups are safe to reuse
        # across the many candidates built below (#20).
        pool_cache: dict[tuple, list[str]] = {}

        max_consec: dict = getattr(self.static_model, "max_consecutive", {}) or {}
        max_consec_obj: dict = getattr(self.static_model, "max_consecutive_per_object", {}) or {}

        # #23: consume this step's dirty-tracking accumulators (populated by
        # _des_complete_activity for every event that completed since the
        # last call) and clear them for the next step. Drives the
        # incremental candidate pool below.
        step_dirty_objects: set = state._step_dirty_objects
        step_dirty_types: set = state._step_dirty_types
        full_rescan_activities: set = set()
        for _t in step_dirty_types:
            full_rescan_activities.update(self._activities_requiring_type.get(_t, ()))
        if max_consec and step_dirty_objects:
            # Global (not per-object) max_consecutive resets whenever a
            # different activity fires. Precisely tracking which cap(s)
            # reset within one batch of same-instant completions isn't
            # worth the complexity (this is rarely used) — conservatively
            # treat any completion this step as a possible reset for every
            # capped activity.
            full_rescan_activities.update(max_consec.keys())
        state._step_dirty_objects = set()
        state._step_dirty_types = set()

        for activity in self.static_model.activities:
            if is_simulation_start and activity.name not in start_activity_names:
                # #23 correctness: a skipped activity never consumes this step's
                # dirty sets (they are cleared once, above), so anything it has
                # pooled must be dropped rather than silently kept.
                self._pool_invalidate_activity(activity.name, state)
                continue

            # #26: already running as many instances as the log ever showed, or
            # not yet due under inter-arrival pacing — produce no candidate at
            # all this step. Filtering here (rather than only at start) keeps
            # `candidates` honest for the deadlock bypass below, same as #25.
            if not self._arrival_allows(activity.name, state):
                self._pool_invalidate_activity(activity.name, state)
                continue
            _conc_cap = self._activity_concurrency.get(activity.name)
            if (_conc_cap is not None
                    and state._in_progress_by_activity.get(activity.name, 0) >= _conc_cap):
                self._pool_invalidate_activity(activity.name, state)
                continue

            # Phase 2: skip if all required object types have zero active instances
            _req_types = self._activity_required_types.get(activity.name)
            if _req_types and _req_types.issubset(state._inactive_scope_types):
                # Same as above, and doubly justified here: with every required
                # type inactive no candidate for this activity can be valid, so
                # every pooled entry is stale by definition. Missing this is what
                # left a stale 'Order Empty Containers' entry behind when all
                # Transport Documents were momentarily deactivated.
                self._pool_invalidate_activity(activity.name, state)
                continue

            # Find the primary non-resource input binding (first creates=False, non-resource type)
            primary_bindings = [
                b for b in activity.bindings
                if not b.creates and b.object_type not in resource_types
            ]

            if not primary_bindings:
                # Activity only creates or only uses resources — generate once globally.
                # For start activities with no input objects, gate by transition probability
                # so they don't fire unconditionally every step in DES mode.
                # All no-input start activities share the same normalised pool: each gets
                # weight = row[activity] (or epsilon if absent). Dividing by the total of
                # ALL row weights (plus epsilon per start activity) preserves the relative
                # ratios between existing targets while giving start activities their fair share.
                #
                # Safety bypass: if in_progress is empty AND the candidate list is still empty
                # at this point, skip the gate for start activities — otherwise the simulation
                # could deadlock permanently if all start activities roll unlucky simultaneously.
                is_potential_deadlock = (
                    activity.name in start_activity_names
                    and not state.in_progress
                    and not candidates
                )
                # #26: where the log supplies a real inter-arrival distribution
                # the probability gate is redundant — pacing is handled by
                # _arrival_allows above, which already let this activity through.
                # The gate was only ever a stand-in for a measured arrival rate,
                # and applying both would throttle twice.
                _paced = activity.name in self._interarrival
                if (not _paced) and self.transition_matrix and activity.name in start_activity_names and state.executed_events and not is_potential_deadlock:
                    last_act = state.executed_events[-1].activity_name
                    row = self.transition_matrix.get(last_act, {})
                    epsilon = 1e-6
                    # For start activities absent from the row, use their trace-start
                    # count as a fallback weight so they fire at their real log frequency
                    # rather than near-zero epsilon.
                    all_keys = set(row) | start_activity_names
                    raw = {}
                    for a in all_keys:
                        if a in row:
                            raw[a] = row[a] + epsilon
                        elif a in start_activity_names and self.start_counts:
                            raw[a] = self.start_counts.get(a, 0.0) + epsilon
                        else:
                            raw[a] = epsilon
                    total = sum(raw.values())
                    prob = raw[activity.name] / total if total > 0 else epsilon
                    if self.rng.random() > prob:
                        continue

                candidate = build_candidate_for_activity(activity, state, resource_types=resource_types,
                                                         pool_cache=pool_cache, rng=self.rng)
                if (candidate
                        and is_candidate_semantically_allowed(self.static_model, candidate, state)
                        # #27: an input-less activity usually only creates, but
                        # it can reuse an existing object via a creates-binding
                        # with max_count, so it needs the exclusivity check too.
                        and self._objects_free(candidate, state)
                        # #29: calendar applies to arrivals too — cases do not
                        # arrive at 03:00 on a Sunday either. Keyed on None
                        # since these candidates have no primary object.
                        and self._calendar_open(activity.name, state)):
                    key = (candidate.activity_name, tuple(sorted(candidate.participating_object_ids)),
                           tuple(sorted(candidate.object_types_to_create)))
                    if key not in seen_keys:
                        seen_keys.add(key)
                        candidates.append(candidate)
                continue

            # Expand: one candidate per active object of the primary binding type.
            primary_type = primary_bindings[0].object_type

            # Pre-compute cheap precedence gates for this activity (nmin and nmax)
            # using only the primary object id — avoids building the full candidate.
            prec_gates_nmin = [
                con for con in self._prec_by_target.get(activity.name, [])
                if con.scope.kind == 'each'
                and con.scope.object_type == primary_type
                and getattr(con, 'nmin', 0) > 0
            ]
            # Single-binding constraints only. This gate counts target events
            # per primary object — a marginal. semantics._nmax_blocked bounds
            # the Definition 8 JOINT count: target events involving every bound
            # object at once. The two coincide when the scope has one binding,
            # and the marginal is >= the joint otherwise, so applying this gate
            # to a multi-type constraint would drop candidates the semantics
            # accepts — and would do it before _nmax_blocked ever ran.
            prec_gates_nmax = [
                con for con in self._prec_by_target.get(activity.name, [])
                if con.scope.kind == 'each'
                and con.scope.object_type == primary_type
                and len(getattr(con.scope, 'bindings', ()) or ()) <= 1
                and getattr(con, 'nmax', None) is not None
            ]

            def _derive_primary_candidate(oid, _activity=activity, _primary_type=primary_type,
                                           _prec_gates_nmin=prec_gates_nmin,
                                           _prec_gates_nmax=prec_gates_nmax):
                """Build+check the candidate for `_activity` with `oid` as the
                primary object — returns None if blocked/invalid. Identical
                logic to the pre-#23 inline loop body, just reusable for both
                the full-rescan and incremental-pool paths below."""
                if (_activity.name, oid) in state._in_progress_objects:
                    return None

                if _prec_gates_nmin:
                    prec_satisfied = getattr(state, '_prec_satisfied', None)
                    for con in _prec_gates_nmin:
                        cache_key = (con.source_activity, _activity.name, 'each', oid)
                        if prec_satisfied is not None and cache_key in prec_satisfied:
                            continue  # already permanently satisfied
                        src_count = len(state._events_by_act_obj.get(
                            (con.source_activity, oid), []))
                        if src_count < con.nmin:
                            return None

                if _prec_gates_nmax:
                    for con in _prec_gates_nmax:
                        t_count = len(state._events_by_act_obj.get(
                            (_activity.name, oid), []))
                        if t_count >= con.nmax:
                            return None

                # #6: pass force_object_id instead of mutating _active_by_type
                candidate = build_candidate_for_activity(
                    _activity, state,
                    resource_types=resource_types,
                    force_object_id=oid,
                    pool_cache=pool_cache,
                    rng=self.rng,
                )
                if candidate is None:
                    return None
                if not is_candidate_semantically_allowed(self.static_model, candidate, state):
                    return None

                # max_consecutive checks (O(1) via cached streaks)
                if _activity.name in max_consec:
                    cap = max_consec[_activity.name]
                    streak = state._global_streak.get(_activity.name, 0)
                    if streak >= cap:
                        return None

                if _activity.name in max_consec_obj:
                    cap_obj = max_consec_obj[_activity.name]
                    for pid in candidate.participating_object_ids:
                        streak_obj = state._object_streak.get((_activity.name, pid), 0)
                        if streak_obj >= cap_obj:
                            return None



                # NO ADMISSION CHECKS HERE — deliberately.
                #
                # Derivation answers one question: is this candidate
                # structurally valid (objects exist, precedence holds, the
                # constraints accept it)? Whether it may start *right now* is a
                # separate question, answered in the start loop.
                #
                # The split is forced by how the incremental pool (#23) works.
                # A candidate rejected here leaves the pool and only returns
                # when one of its participants is dirtied by an event. Every
                # admission condition lifts for reasons that dirty nothing
                # relevant to this candidate:
                #   - object exclusivity (#27): it can be blocked by a SECONDARY
                #     participant, and since it was never pooled the reverse
                #     participant index cannot find it when that object frees;
                #   - concurrency ceiling (#26): a slot frees when some OTHER
                #     object's instance completes;
                #   - availability calendar (#29): a slot opens merely because
                #     the clock advanced — no event at all.
                # Each left the pool permanently short of a candidate the full
                # rescan produces, reported by SIM_DEBUG_POOL_CHECK as a missing
                # entry. Keeping derivation purely structural makes the pool
                # invariant statable: the pool holds every structurally valid
                # candidate; admission is decided at start.
                return candidate

            if activity.name not in self._incremental_safe_activities:
                # Not provably safe for incremental treatment (see
                # Simulator.__init__'s constraint-checker audit) — full
                # rescan every step, exactly as before #23.
                for oid in state._active_by_type.get(primary_type, set()):
                    candidate = _derive_primary_candidate(oid)
                    if candidate is None:
                        continue
                    key = (candidate.activity_name, tuple(sorted(candidate.participating_object_ids)),
                           tuple(sorted(candidate.object_types_to_create)))
                    if key not in seen_keys:
                        seen_keys.add(key)
                        candidates.append(candidate)
                continue

            # #23: incremental-safe activity — patch the persistent pool
            # instead of a full rescan, unless this is the first time it's
            # considered or this step's dirty-type/streak triggers demand a
            # full rescan of it specifically.
            needs_full_rescan = (
                activity.name not in state._pool_initialized_activities
                or activity.name in full_rescan_activities
            )
            if needs_full_rescan:
                oids_to_check = state._active_by_type.get(primary_type, set())
                state._pool_initialized_activities.add(activity.name)
            else:
                oids_to_check = set()
                for _dirty_oid in step_dirty_objects:
                    if state._type_of_object.get(_dirty_oid) == primary_type:
                        oids_to_check.add(_dirty_oid)
                    for _key in state._pool_entries_by_participant.get(_dirty_oid, ()):
                        if _key[0] == activity.name:
                            oids_to_check.add(_key[1])

            for oid in oids_to_check:
                pool_key = (activity.name, oid)
                candidate = _derive_primary_candidate(oid)
                if candidate is None:
                    state.pool_remove(pool_key)
                else:
                    state.pool_set(pool_key, candidate)

            if self._debug_pool_check:
                expected = set()
                for _oid in state._active_by_type.get(primary_type, set()):
                    if _derive_primary_candidate(_oid) is not None:
                        expected.add((activity.name, _oid))
                actual = {
                    (activity.name, _oid)
                    for _oid in state._candidate_pool_keys_by_activity.get(activity.name, ())
                }
                if expected != actual:
                    raise AssertionError(
                        f"#23 pool mismatch for {activity.name!r}: "
                        f"pool has {actual - expected} extra, missing {expected - actual}"
                    )

            # #23: merge this activity's current pool entries into the
            # returned candidate list now, in the same activity-declaration-
            # order position the legacy full rescan would have appended them
            # — keeps candidate ordering close to the pre-#23 engine (a
            # no-primary-binding activity declared later no longer jumps
            # ahead of an earlier incremental-safe activity's candidates).
            for _oid in state._candidate_pool_keys_by_activity.get(activity.name, ()):
                candidate = state._candidate_pool.get((activity.name, _oid))
                if candidate is None:
                    continue
                key = (candidate.activity_name, tuple(sorted(candidate.participating_object_ids)),
                       tuple(sorted(candidate.object_types_to_create)))
                if key not in seen_keys:
                    seen_keys.add(key)
                    candidates.append(candidate)

        # ── Option 4: Response obligation injection (B + F optimised) ────────
        # B: Build a set of (activity, object) pairs already in the pool so
        #    in-pool checks are O(1) instead of O(pool_size) per obligation.
        # F: Cheap pre-filter before calling build_candidate_for_activity —
        #    skip obligations whose target activity is blocked by precedence
        #    on the scope object without doing a full semantic check.
        if state._obligations_count and not is_simulation_start:
            act_by_name = self._act_by_name

            # B: index of (activity_name, scope_oid) already covered by normal pool
            pool_index: set[tuple] = set()
            for c in candidates:
                for oid in c.participating_object_ids:
                    pool_index.add((c.activity_name, oid))
                if not c.participating_object_ids:
                    pool_index.add((c.activity_name, None))

            # Build in-progress index to prevent starting an obligated activity
            # on an object that is already in-progress for that same activity.
            # Uses state._in_progress_objects maintained in _des_start/complete_activity.
            in_progress_index = state._in_progress_objects

            prec_by_target: dict[str, list] = self._prec_by_target

            seen_obligation_keys = self._seen_obligation_keys
            seen_obligation_keys.clear()
            # Phase 1: iterate only _obligations_ready (prerequisites met) instead of all _obligations_count
            _inject_pool = state._obligations_ready if state._obligations_ready else state._obligations_count
            for (target_act, scope_oid), count in list(_inject_pool.items()):
                if count <= 0:
                    continue
                dedup_key = (target_act, scope_oid)
                if dedup_key in seen_obligation_keys:
                    continue
                seen_obligation_keys.add(dedup_key)

                # Handle frozenset obligations (any-mode and all-mode) separately
                is_frozenset = isinstance(scope_oid, frozenset)

                if is_frozenset:
                    frozen_oids = scope_oid
                    c_key_ob = state._obligation_to_constraint.get((target_act, scope_oid))
                    scope_kind_of_ob = c_key_ob[3] if c_key_ob else 'all'
                    activity = act_by_name.get(target_act)
                    if activity is None:
                        continue

                    if scope_kind_of_ob == 'any':
                        # Any-mode: force one active member — non-empty intersection discharges
                        active_members = [o for o in frozen_oids
                                          if state.objects.get(o) and state.objects[o].active]
                        if not active_members:
                            continue
                        if any((target_act, o) in pool_index for o in active_members):
                            continue
                        if any((target_act, o) in in_progress_index for o in active_members):
                            continue
                        candidate = build_candidate_for_activity(
                            activity, state, resource_types=resource_types,
                            force_object_ids=[active_members[0]],
                            pool_cache=pool_cache, rng=self.rng,
                        )
                    else:
                        # All-mode: target must fire involving all objects in the frozenset
                        if any(not (state.objects.get(o) and state.objects[o].active) for o in frozen_oids):
                            continue
                        if any((target_act, o) in pool_index for o in frozen_oids):
                            continue
                        if any((target_act, o) in in_progress_index for o in frozen_oids):
                            continue
                        candidate = build_candidate_for_activity(
                            activity, state, resource_types=resource_types,
                            force_object_ids=list(frozen_oids),
                            pool_cache=pool_cache, rng=self.rng,
                        )

                    if candidate is None:
                        continue
                    if not is_candidate_semantically_allowed(self.static_model, candidate, state):
                        continue
                    # #27: obligation-injected candidates bypass the normal
                    # derivation path, so they need the exclusivity check too.
                    if not self._objects_free(candidate, state):
                        continue
                    key2 = (candidate.activity_name, tuple(sorted(candidate.participating_object_ids)),
                           tuple(sorted(candidate.object_types_to_create)))
                    if key2 not in seen_keys:
                        seen_keys.add(key2)
                        candidates.append(candidate)
                    continue

                # B: O(1) pool membership check (per-object and global obligations)
                if scope_oid is not None:
                    if (target_act, scope_oid) in pool_index:
                        continue
                else:
                    if (target_act, None) in pool_index:
                        continue

                # Skip if the obligated activity is already in-progress on this
                # scope object — prevents concurrent duplicate starts that bypass
                # the event-count check (record_event hasn't run yet for in-progress)
                if scope_oid is not None and (target_act, scope_oid) in in_progress_index:
                    continue
                # Also skip if ANY non-resource binding object for this activity is
                # already in-progress — prevents the same full event being queued
                # multiple times when the obligation fires on every step while the
                # first instance is still running (e.g. Depart queued 40+ times).
                activity_def = act_by_name.get(target_act)
                if activity_def and scope_oid is not None:
                    _skip = False
                    for _b in activity_def.bindings:
                        # [resource/permanent-object handling — disabled, kept for reference]
                        # if _b.creates or _b.object_type in resource_types:
                        if _b.creates:
                            continue
                        for _oid in state._active_by_type.get(_b.object_type, set()):
                            if (target_act, _oid) in in_progress_index:
                                _skip = True
                                break
                        if _skip:
                            break
                    if _skip:
                        continue

                # Scope object must exist and be active
                if scope_oid is not None:
                    scope_obj = state.objects.get(scope_oid)
                    if scope_obj is None or not scope_obj.active:
                        continue

                # F: cheap precedence pre-filter
                blocked = False
                for con in prec_by_target.get(target_act, []):
                    if scope_oid is None:
                        if not state._events_by_activity.get(con.source_activity):
                            blocked = True
                            break
                    elif con.scope.kind in ('each', 'any', 'all') and con.scope.object_type:
                        if scope_obj is not None and scope_obj.object_type == con.scope.object_type:
                            src_count = len(state._events_by_act_obj.get(
                                (con.source_activity, scope_oid), []))
                            nmin = con.nmin if con.nmin is not None else 1
                            nmax = con.nmax
                            if nmin > 0 and src_count == 0:
                                blocked = True
                                break
                            if nmax is not None:
                                t_count = len(state._events_by_act_obj.get(
                                    (target_act, scope_oid), []))
                                if t_count >= nmax:
                                    blocked = True
                                    break
                if blocked:
                    continue

                activity = act_by_name.get(target_act)
                if activity is None:
                    continue

                if scope_oid is not None:
                    candidate = build_candidate_for_activity(
                        activity, state, resource_types=resource_types, force_object_id=scope_oid,
                        pool_cache=pool_cache, rng=self.rng,
                    )
                else:
                    candidate = build_candidate_for_activity(
                        activity, state, resource_types=resource_types,
                        pool_cache=pool_cache, rng=self.rng,
                    )

                if candidate is None:
                    continue
                if not is_candidate_semantically_allowed(self.static_model, candidate, state):
                    continue

                key = (candidate.activity_name, tuple(sorted(candidate.participating_object_ids)),
                       tuple(sorted(candidate.object_types_to_create)))
                if key not in seen_keys:
                    seen_keys.add(key)
                    candidates.append(candidate)

        return candidates

    def _update_obligations_after_event(self, executed_event, state: SimulationState) -> None:
        self._fulfill_response_obligations(executed_event, state)
        self._create_response_obligations(executed_event, state)
        self._promote_obligations(executed_event, state)

    def _is_obligation_ready(self, target_act: str, scope_oid: str, state: SimulationState) -> bool:
        """Check if all precedence prerequisites for target_act have fired for scope_oid."""
        prereqs = self._obligation_prerequisites.get(target_act)
        if not prereqs:
            return True
        scope_type = state._type_of_object.get(scope_oid)
        for req_source in prereqs.get(scope_type, []):
            if not state._events_by_act_obj.get((req_source, scope_oid)):
                return False
        return True

    def _promote_obligations(self, executed_event, state: SimulationState) -> None:
        """After event fires, promote blocked obligations whose blocking prerequisite just fired."""
        act = executed_event.activity_name
        for scope_oid in executed_event.object_ids:
            key = (act, scope_oid)
            to_promote = state._obligations_blocked.pop(key, None)
            if not to_promote:
                continue
            for (tgt, oblg_oid) in to_promote:
                # Only promote if obligation still exists in the authoritative count
                if (tgt, oblg_oid) not in state._obligations_count:
                    continue
                if self._is_obligation_ready(tgt, oblg_oid, state):
                    state._obligations_ready[(tgt, oblg_oid)] = 1
                else:
                    # Still blocked by another prerequisite — re-register under next blocker
                    prereqs = self._obligation_prerequisites.get(tgt, {})
                    oblg_scope_type = state._type_of_object.get(oblg_oid)
                    for req_source in prereqs.get(oblg_scope_type, []):
                        if not state._events_by_act_obj.get((req_source, oblg_oid)):
                            state._obligations_blocked.setdefault(
                                (req_source, oblg_oid), set()).add((tgt, oblg_oid))
                            break

    def _fulfill_response_obligations(self, executed_event, state: SimulationState) -> None:
        act = executed_event.activity_name
        fired_oids = set(executed_event.object_ids)

        def _record_fulfillment(key):
            c_key = state._obligation_to_constraint.pop(key, None)
            if c_key is not None:
                stats = state._constraint_obligation_stats.setdefault(
                    c_key, {"fulfilled": 0, "cancelled": 0, "violated": 0}
                )
                stats["fulfilled"] += 1
            state.total_obligations_fulfilled += 1

        # Discharge unscoped obligations for this target activity
        if state._obligations_count.pop((act, None), None) is not None:
            state._obligations_ready.pop((act, None), None)
            _record_fulfillment((act, None))
        # Discharge per-object obligations (each/any mode)
        for oid in executed_event.object_ids:
            if state._obligations_count.pop((act, oid), None) is not None:
                state._obligations_ready.pop((act, oid), None)
                _record_fulfillment((act, oid))
        # Discharge frozenset obligations (any-mode: non-empty intersection; all-mode: full subset)
        all_keys = [k for k in list(state._obligations_count) if k[0] == act and isinstance(k[1], frozenset)]
        for k in all_keys:
            c_key_ob = state._obligation_to_constraint.get(k)
            scope_kind_of_ob = c_key_ob[3] if c_key_ob else 'all'
            if scope_kind_of_ob == 'any':
                satisfied = bool(k[1].intersection(fired_oids))
            else:
                satisfied = k[1].issubset(fired_oids)
            if satisfied and self._check_obligation_binding_satisfied(k, fired_oids, state):
                state._obligations_count.pop(k, None)
                state._obligations_ready.pop(k, None)
                state._obligation_bindings.pop(k, None)
                _record_fulfillment(k)

    def _create_response_obligations(self, executed_event, state: SimulationState) -> None:
        for constraint in self._response_by_source.get(executed_event.activity_name, []):
            # Constraint identity tuple used for per-constraint stats (E3/S8)
            c_key = (
                constraint.constraint_type,
                constraint.source_activity,
                constraint.target_activity,
                getattr(constraint.scope, 'kind', 'each'),
            )
            if constraint.scope.bindings and len(constraint.scope.bindings) > 1:
                # Multi-type: build one obligation per Cartesian combination of each-type objects.
                # Secondary any/all bindings are stored and verified at fulfillment time.
                event_oids_by_type: dict = {}
                for oid in executed_event.object_ids:
                    rt = state.objects.get(oid)
                    if rt:
                        event_oids_by_type.setdefault(rt.object_type, []).append(oid)

                each_types = [t for t, inv in constraint.scope.bindings if inv == 'each']
                other_bindings = [(t, inv) for t, inv in constraint.scope.bindings if inv != 'each']
                each_oid_lists = [event_oids_by_type.get(t, []) for t in each_types]

                if each_types and any(not lst for lst in each_oid_lists):
                    pass  # Required each-type missing from source event — no obligation
                else:
                    secondary_info = [
                        (t, inv, frozenset(event_oids_by_type.get(t, [])))
                        for t, inv in other_bindings
                        if event_oids_by_type.get(t)
                    ]
                    if each_types:
                        for combo in _iproduct(*each_oid_lists):
                            key = (constraint.target_activity, frozenset(combo))
                            if key not in state._obligations_count:
                                state._obligations_count[key] = 1
                                state._obligation_to_constraint[key] = c_key
                                if secondary_info:
                                    state._obligation_bindings[key] = secondary_info
                                state._obligations_ready[key] = 1
                    else:
                        # Only any/all bindings — key on primary type's object set
                        primary_type, _ = constraint.scope.bindings[0]
                        primary_oids = frozenset(event_oids_by_type.get(primary_type, []))
                        if primary_oids:
                            key = (constraint.target_activity, primary_oids)
                            if key not in state._obligations_count:
                                state._obligations_count[key] = 1
                                state._obligation_to_constraint[key] = c_key
                                remaining = [
                                    (t, inv, frozenset(event_oids_by_type.get(t, [])))
                                    for t, inv in constraint.scope.bindings[1:]
                                    if event_oids_by_type.get(t)
                                ]
                                if remaining:
                                    state._obligation_bindings[key] = remaining
                                state._obligations_ready[key] = 1
            elif constraint.scope.kind == "each":
                scope_object_ids = self._get_event_scope_object_ids(
                    executed_event=executed_event, state=state,
                    scope_object_type=constraint.scope.object_type,
                )
                for scope_object_id in scope_object_ids:
                    key = (constraint.target_activity, scope_object_id)
                    if key not in state._obligations_count:
                        state._obligations_count[key] = 1
                        state._obligation_to_constraint[key] = c_key
                        # Route to ready or blocked pool
                        if self._is_obligation_ready(constraint.target_activity, scope_object_id, state):
                            state._obligations_ready[key] = 1
                        else:
                            prereqs = self._obligation_prerequisites.get(constraint.target_activity, {})
                            scope_type = state._type_of_object.get(scope_object_id)
                            for req_source in prereqs.get(scope_type, []):
                                if not state._events_by_act_obj.get((req_source, scope_object_id)):
                                    state._obligations_blocked.setdefault(
                                        (req_source, scope_object_id), set()).add(key)
                                    break
            elif constraint.scope.kind == "any":
                scope_object_ids = self._get_event_scope_object_ids(
                    executed_event=executed_event, state=state,
                    scope_object_type=constraint.scope.object_type,
                )
                if scope_object_ids:
                    key = (constraint.target_activity, frozenset(scope_object_ids))
                    if key not in state._obligations_count:
                        state._obligations_count[key] = 1
                        state._obligation_to_constraint[key] = c_key
                        state._obligations_ready[key] = 1  # any-mode: one member suffices
            elif constraint.scope.kind == "all":
                scope_object_ids = self._get_event_scope_object_ids(
                    executed_event=executed_event, state=state,
                    scope_object_type=constraint.scope.object_type,
                )
                if scope_object_ids:
                    key = (constraint.target_activity, frozenset(scope_object_ids))
                    if key not in state._obligations_count:
                        state._obligations_count[key] = 1
                        state._obligation_to_constraint[key] = c_key
                        state._obligations_ready[key] = 1  # all-mode: always ready (frozenset handles sync)
            else:
                key = (constraint.target_activity, None)
                if key not in state._obligations_count:
                    state._obligations_count[key] = 1
                    state._obligation_to_constraint[key] = c_key
                    state._obligations_ready[key] = 1  # unscoped: always ready

    def _get_event_scope_object_ids(
        self,
        executed_event,
        state: SimulationState,
        scope_object_type: str,
    ) -> list[str]:
        scope_ids: list[str] = []

        for object_id in executed_event.object_ids:
            runtime_object = state.objects.get(object_id)

            if runtime_object is None:
                continue

            if runtime_object.object_type == scope_object_type:
                scope_ids.append(object_id)

        return scope_ids

    def _check_obligation_binding_satisfied(self, key, fired_oids: set, state: SimulationState) -> bool:
        """Check secondary any/all bindings for a multi-type obligation against the fired event."""
        binding_info = state._obligation_bindings.get(key)
        if not binding_info:
            return True
        fired_by_type: dict = {}
        for oid in fired_oids:
            obj = state.objects.get(oid)
            if obj:
                fired_by_type.setdefault(obj.object_type, set()).add(oid)
        for obj_type, inv, required_oids in binding_info:
            present = fired_by_type.get(obj_type, set())
            if not present:
                return False
            if inv == 'any':
                if not (required_oids & present):
                    return False
            else:  # 'all'
                if not required_oids.issubset(present):
                    return False
        return True


    def _get_activity_by_name(self, activity_name: str) -> Optional[Activity]:
        # #1: O(1) dict lookup using cached _act_by_name built in __init__
        return self._act_by_name.get(activity_name)

    def _get_candidate_scope_object_ids(
        self,
        candidate: Candidate,
        state: SimulationState,
        scope_object_type: str,
    ) -> list[str]:
        scope_ids: list[str] = []

        for object_id in candidate.participating_object_ids:
            runtime_object = state.objects.get(object_id)

            if runtime_object is None:
                continue

            if runtime_object.object_type == scope_object_type:
                scope_ids.append(object_id)

        return scope_ids

    def _select_candidate(self, candidates: list[Candidate], state: SimulationState) -> Candidate:
        """Delegate to the configured selection policy (self.select_func).

        Lets run_des order the candidate pool by transition probability (or
        whatever custom policy the caller supplied via select_func) before
        greedily trying to start each one.
        """
        return self.select_func(candidates, state, self.static_model, self.config, rng=self.rng)

    # ── DES (Discrete Event Simulation) methods ───────────────────────────────

    def _des_resources_available(self, candidate: Candidate, state: SimulationState) -> tuple[bool, list[str]]:
        """Check if all resource objects required by this candidate are free.
        Returns (available, held_resource_ids).
        held_resource_ids are the specific resource object IDs that will be locked.

        [resource/permanent-object handling — disabled, kept for reference]
        Always returns (True, []) now — equivalent to the commented logic
        below when state._resource_types is empty (the master switch in
        __init__/run_des forces it empty unconditionally).
        """
        # resource_types = state._resource_types
        # held: list[str] = []
        # current_time = state.current_time
        #
        # for oid in candidate.participating_object_ids:
        #     obj = state.objects.get(oid)
        #     if obj is None:
        #         continue
        #     if obj.object_type not in resource_types:
        #         continue
        #     # Resource object — check if busy
        #     if obj.busy_until is not None and current_time is not None and obj.busy_until > current_time:
        #         return False, []
        #     held.append(oid)
        #
        # return True, held
        return True, []

    def _des_lock_resources(self, held_resource_ids: list[str], activity_name: str,
                             complete_at, state: SimulationState) -> None:
        """Mark resource objects as busy until complete_at.

        [resource/permanent-object handling — disabled, kept for reference]
        held_resource_ids is always [] now (see _des_resources_available), so
        this is a no-op in practice; body kept commented for reference.
        """
        # for oid in held_resource_ids:
        #     obj = state.objects.get(oid)
        #     if obj:
        #         obj.busy_until = complete_at
        #         obj.busy_by = activity_name

    def _des_release_resources(self, held_resource_ids: list[str], state: SimulationState) -> None:
        """Release resource objects after activity completes.

        [resource/permanent-object handling — disabled, kept for reference]
        """
        # for oid in held_resource_ids:
        #     obj = state.objects.get(oid)
        #     if obj:
        #         obj.busy_until = None
        #         obj.busy_by = None

    def _des_start_activity(self, candidate: Candidate, state: SimulationState,
                             held_resource_ids: list[str]) -> InProgressActivity:
        """Create objects-to-create, apply links, lock resources, push to heap."""
        created_object_ids: list[str] = []
        attribute_defaults = getattr(self.static_model, "attribute_defaults", {}) or {}
        # [resource/permanent-object handling — disabled, kept for reference]
        # resource_types: set[str] = self._resource_types_set

        for object_type in candidate.object_types_to_create:
            # Resource types come from the pre-populated pool only — never created mid-sim.
            # if object_type in resource_types:
            #     continue
            defaults = attribute_defaults.get(object_type, {})
            obj = state.add_object(object_type=object_type, attributes=defaults)
            created_object_ids.append(obj.object_id)
            # Phase 4: record initial attribute values in history
            if defaults:
                for attr_name, attr_val in defaults.items():
                    obj.attribute_history.append((state.current_time, attr_name, attr_val))

        apply_conservative_link_policy(
            self.static_model,
            candidate.participating_object_ids,
            created_object_ids,
            state,
        )

        started_at = state.current_time
        # In DES mode the base for sampling must be current_time (when the activity
        # actually starts), not last_generated_timestamp.
        saved_ts = state.last_generated_timestamp
        state.last_generated_timestamp = state.current_time
        complete_at = self.time_policy.next_timestamp(state, candidate, self.config, rng=self.rng)
        # Restore: don't let this activity's complete_at become the base for the
        # next concurrently started activity. In DES mode all activities in the same
        # step start from current_time, not from each other's completion times.
        state.last_generated_timestamp = saved_ts

        # Record pure service time (sampled work duration only)
        if started_at is not None and complete_at is not None:
            svc = (complete_at - started_at).total_seconds()
            if svc >= 0:
                state.activity_service_s.setdefault(candidate.activity_name, []).append(svc)

        # Process waiting time from discovery (waiting_mean) is a descriptive metric
        # from the real log — it is NOT added to complete_at. Waiting in the simulation
        # emerges naturally from resource contention (resource_wait_s) and pool wait
        # (candidate_wait_s). Adding sampled waiting to the clock would inflate
        # simulation time artificially and has been removed.

        # Do NOT update last_generated_timestamp here in DES mode —
        # concurrent activities all start from current_time, not from
        # each other's completion times.

        # [resource/permanent-object handling — disabled, kept for reference]
        # self._des_lock_resources(held_resource_ids, candidate.activity_name, complete_at, state)

        in_prog = InProgressActivity(
            candidate_activity_name=candidate.activity_name,
            participating_object_ids=candidate.participating_object_ids + created_object_ids,
            object_types_to_create=candidate.object_types_to_create,
            started_at=started_at,
            complete_at=complete_at,
            # held_resource_ids=held_resource_ids,
            created_object_ids=created_object_ids,
        )
        heapq.heappush(state.in_progress, in_prog)
        # Maintain _in_progress_objects index
        for oid in in_prog.participating_object_ids:
            state._in_progress_objects.add((in_prog.candidate_activity_name, oid))
        # #27: claim every participant so no other activity can take it while
        # this instance runs.
        state._busy_objects.update(in_prog.participating_object_ids)
        # #28: lifecycle entry — each participant goes busy on this activity.
        for _oid in in_prog.participating_object_ids:
            state.record_object_status(_oid, 'started', 'busy',
                                       activity=in_prog.candidate_activity_name,
                                       timestamp=in_prog.started_at)
        # #27: claiming an object invalidates every *other* activity's pooled
        # candidate that references it — those candidates were derived while the
        # object was free and would now be refused by _objects_free. Becoming
        # busy is a state change like any other, so mark the participants dirty
        # and let the next generation pass re-derive them. (pool_remove below
        # only clears this activity's own entries.) Without this the pool keeps
        # entries the legacy full rescan would reject — caught by
        # SIM_DEBUG_POOL_CHECK as a spurious extra entry once activities have
        # non-zero duration and objects stay claimed across steps.
        state._step_dirty_objects.update(in_prog.participating_object_ids)
        # #26: per-activity in-progress counter + next permitted arrival
        _act_name = in_prog.candidate_activity_name
        state._in_progress_by_activity[_act_name] = (
            state._in_progress_by_activity.get(_act_name, 0) + 1)
        self._schedule_next_arrival(_act_name, state)

        # #23: a candidate that just started can no longer be a fresh
        # incremental-pool entry — prune it immediately so it isn't offered
        # again before it completes (nothing else would mark it dirty in the
        # meantime, since dirtying only happens on event completion). Safe
        # to call unconditionally per participant: pool_remove is a no-op
        # for keys that were never pooled (unsafe activities, or a
        # participant that never was any activity's primary).
        if candidate.activity_name in self._incremental_safe_activities:
            for oid in in_prog.participating_object_ids:
                state.pool_remove((candidate.activity_name, oid))

        return in_prog

    def _des_complete_activity(self, in_prog: InProgressActivity, state: SimulationState) -> None:
        """Write the ExecutedEvent, update indexes, release resources."""
        # Sample parallelism before releasing (counts this activity + any still running)
        state.parallelism_samples.append(len(state.in_progress) + 1)
        # [resource/permanent-object handling — disabled, kept for reference]
        # self._des_release_resources(in_prog.held_resource_ids, state)
        # Remove from _in_progress_objects index
        for oid in in_prog.participating_object_ids:
            state._in_progress_objects.discard((in_prog.candidate_activity_name, oid))
        # #27: release every participant. Safe to discard unconditionally — an
        # object can only be held by one instance at a time by construction.
        state._busy_objects.difference_update(in_prog.participating_object_ids)
        # #28: lifecycle entry — each participant goes idle again. Recorded
        # before the deactivation block below so an object that this activity
        # also deactivates reads 'completed' then 'deactivated', in that order.
        for _oid in in_prog.participating_object_ids:
            state.record_object_status(_oid, 'completed', 'idle',
                                       activity=in_prog.candidate_activity_name,
                                       timestamp=in_prog.complete_at)
        # #26: release this instance's slot in the per-activity concurrency count
        _act_name = in_prog.candidate_activity_name
        _remaining = state._in_progress_by_activity.get(_act_name, 0) - 1
        if _remaining > 0:
            state._in_progress_by_activity[_act_name] = _remaining
        else:
            state._in_progress_by_activity.pop(_act_name, None)

        activity = self._get_activity_by_name(in_prog.candidate_activity_name)
        # [resource/permanent-object handling — disabled, kept for reference]
        # resource_types = state._resource_types

        if activity:
            deactivated_types = {
                binding.object_type
                for binding in activity.bindings
                if getattr(binding, "deactivates", False)
                # and binding.object_type not in resource_types
            }
            for oid in in_prog.participating_object_ids:
                obj = state.objects.get(oid)
                if obj and obj.object_type in deactivated_types:
                    # #28: pass complete_at explicitly — state.current_time is
                    # not advanced to it until later in this method.
                    state.deactivate_object(oid, timestamp=in_prog.complete_at)

            # Apply attribute updates (DES: fires on completion, not on start)
            for binding in activity.bindings:
                updates = getattr(binding, 'attribute_updates', ()) or ()
                if not updates:
                    continue
                for oid in in_prog.participating_object_ids:
                    obj = state.objects.get(oid)
                    if obj and obj.object_type == binding.object_type:
                        for upd in updates:
                            _apply_attribute_update(obj, upd, timestamp=in_prog.complete_at)
                        # #23: an attribute update can newly satisfy (or
                        # break) a binding guard on this type, unblocking
                        # candidates that never had this object selected
                        # before — the reverse-participant index can't see
                        # that, so mark the whole type dirty for a full
                        # rescan of activities that require it.
                        state._step_dirty_types.add(binding.object_type)

            # Phase 3: capture event-level attributes
            evt_attrs: dict = {}
            for cap in getattr(activity, 'event_attributes', ()) or ():
                source = cap.get('source')
                name   = cap.get('name', '')
                if not name:
                    continue
                if source == 'static':
                    evt_attrs[name] = cap.get('value')
                elif source == 'object':
                    cap_type = cap.get('object_type', '')
                    cap_attr = cap.get('attribute', '')
                    for oid in in_prog.participating_object_ids:
                        obj = state.objects.get(oid)
                        if obj and obj.object_type == cap_type:
                            evt_attrs[name] = obj.attributes.get(cap_attr)
                            break

        executed_event = state.record_event(
            activity_name=in_prog.candidate_activity_name,
            participating_object_ids=in_prog.participating_object_ids,
            timestamp=in_prog.complete_at,
            attributes=evt_attrs if activity else {},
        )
        state.current_time = in_prog.complete_at

        # #23: mark every participant of this event dirty (covers direct
        # precedence/streak/in-progress effects and, via the reverse
        # participant index, any pooled candidate that used any of them as
        # a secondary participant too — see _generate_candidates_des).
        # Newly-created objects also mark their type dirty (new-supply
        # trigger for activities that require that type).
        state._step_dirty_objects.update(in_prog.participating_object_ids)
        for _created_oid in in_prog.created_object_ids:
            _created_obj = state.objects.get(_created_oid)
            if _created_obj is not None:
                state._step_dirty_types.add(_created_obj.object_type)
        # Every participant also leaves _in_progress_objects here, which makes
        # it newly available as a *secondary* for other activities. The reverse
        # participant index cannot see that: an activity whose primary object
        # has no pool entry yet (because it was previously blocked for want of
        # this very object) is not reachable from the dirty object at all. So
        # mark the participants' types dirty too, which full-rescans every
        # activity requiring them. Without this, ('Load Truck', 'Container_2')
        # was never re-derived once its Handling Unit came free — a candidate
        # silently missing from the pool rather than a stale one.
        # Only observable once activities have non-zero duration; with the
        # DefaultTimePolicy everything completes instantly and nothing is ever
        # meaningfully in progress, which is why #23's verification missed it.
        for _oid in in_prog.participating_object_ids:
            _obj = state.objects.get(_oid)
            if _obj is not None:
                state._step_dirty_types.add(_obj.object_type)

        # Track service time broken down by object type — enables per-(activity, type) metrics
        if in_prog.started_at and in_prog.complete_at:
            svc = (in_prog.complete_at - in_prog.started_at).total_seconds()
            if svc >= 0:
                _seen_types: set = set()
                for _oid in in_prog.participating_object_ids:
                    _obj = state.objects.get(_oid)
                    # [resource/permanent-object handling — disabled, kept for reference]
                    # if _obj and _obj.object_type not in self._resource_types_set:
                    if _obj:
                        _key = (in_prog.candidate_activity_name, _obj.object_type)
                        if _key not in _seen_types:
                            _seen_types.add(_key)
                            state.activity_service_by_type_s.setdefault(_key, []).append(svc)
        state.last_generated_timestamp = in_prog.complete_at

        self._update_obligations_after_event(executed_event, state)

        # Populate precedence satisfied cache on firing: for every precedence
        # with this activity as target, mark it satisfied for each participating
        # object so future candidate checks skip the constraint for these objects.
        prec_satisfied = getattr(state, '_prec_satisfied', None)
        if prec_satisfied is not None:
            fired_act = in_prog.candidate_activity_name
            # [resource/permanent-object handling — disabled, kept for reference]
            # resource_types = self._resource_types_set
            for con in self._prec_by_target.get(fired_act, []):
                if con.scope.kind != 'each':
                    continue
                nmax = getattr(con, 'nmax', None)
                if nmax is not None:
                    continue  # nmax constraints can be re-violated; don't cache
                source = con.source_activity
                nmin = getattr(con, 'nmin', 0)
                cache_key_base = (source, fired_act, 'each')
                for oid in in_prog.participating_object_ids:
                    obj = state.objects.get(oid)
                    # if obj is None or obj.object_type in resource_types:
                    if obj is None:
                        continue
                    if obj.object_type != con.scope.object_type:
                        continue
                    if _count_activity_for_object(state, source, oid) >= max(nmin, 1):
                        prec_satisfied.add(cache_key_base + (oid,))

        if self.trace_func is not None:
            self._trace("applied", {
                "event_id": executed_event.event_id,
                "activity_name": executed_event.activity_name,
                "timestamp": executed_event.timestamp.isoformat() if executed_event.timestamp else None,
                "started_at": in_prog.started_at.isoformat() if in_prog.started_at else None,
                "duration_s": (in_prog.complete_at - in_prog.started_at).total_seconds()
                              if in_prog.started_at and in_prog.complete_at else None,
                "object_ids": list(executed_event.object_ids),
                "step_count": state.step_count,
                "concurrent": [
                    {
                        "activity": ip.candidate_activity_name,
                        "objects": list(ip.participating_object_ids),
                        "started_at": ip.started_at.isoformat() if ip.started_at else None,
                        "complete_at": ip.complete_at.isoformat() if ip.complete_at else None,
                    }
                    for ip in state.in_progress
                ],
            })

    def _des_try_start_waiting(self, state: SimulationState,
                               completed_activity: str | None = None) -> None:
        """After a resource is released, try to start any waiting candidates.

        [resource/permanent-object handling — disabled, kept for reference]
        state.waiting_queue is never populated now (see the main loop below),
        so this always returns immediately; body kept commented for reference.

        #9: Skip full semantic re-check for candidates whose activity is not
        named in any constraint involving completed_activity. The only constraints
        that could have changed state are those with completed_activity as source
        or target — everything else is unaffected.
        """
        if not state.waiting_queue:
            return

        # # Build set of activities that COULD be affected by the completed activity
        # # Use _constraints_by_activity index (O(1)) instead of scanning all constraints (O(C))
        # if completed_activity is not None:
        #     affected: set[str] | None = set()
        #     for con in self.static_model.constraints_for_activity(completed_activity):
        #         if con.source_activity:
        #             affected.add(con.source_activity)
        #         if con.target_activity:
        #             affected.add(con.target_activity)
        #     affected.add(completed_activity)
        # else:
        #     affected = None  # unknown — re-check everything
        #
        # still_waiting: list[WaitingCandidate] = []
        # for wc in state.waiting_queue:
        #     cand = Candidate(
        #         activity_name=wc.candidate_activity_name,
        #         participating_object_ids=wc.participating_object_ids,
        #         object_types_to_create=wc.object_types_to_create,
        #     )
        #     # #9: only re-run semantic check if this candidate's activity could
        #     # have been affected by the just-completed activity.
        #     if affected is None or wc.candidate_activity_name in affected:
        #         if not is_candidate_semantically_allowed(self.static_model, cand, state):
        #             continue
        #     available, held = self._des_resources_available(cand, state)
        #     if available:
        #         if state.current_time is not None and wc.arrived_at is not None:
        #             wait = (state.current_time - wc.arrived_at).total_seconds()
        #             if wait >= 0:
        #                 state.resource_wait_s.setdefault(wc.candidate_activity_name, []).append(wait)
        #         self._des_start_activity(cand, state, held)
        #     else:
        #         still_waiting.append(wc)
        # state.waiting_queue = still_waiting

    def run_des(self, state: Optional[SimulationState] = None) -> SimulationState:
        """DES simulation loop. Activated when resource types are configured.

        Activities start immediately when inputs and resources are available.
        Multiple activities can be in-flight simultaneously. Clock advances to
        the next completion. Resource objects are locked for the duration and
        released on completion, allowing waiting activities to start.
        """
        if state is None:
            state = SimulationState()

        state._start_activity_names = self._start_names_set
        # [resource/permanent-object handling — disabled, kept for reference]
        # state._resource_types = set(getattr(self.static_model, 'resource_types', []) or [])
        state._resource_types = set()
        state.current_time = self.config.start_timestamp
        state.last_generated_timestamp = self.config.start_timestamp

        # from src.Simulation.Domain.state import RuntimeObject
        # pool_sizes = getattr(self.static_model, 'resource_pool_sizes', {}) or {}
        # for res_type in state._resource_types:
        #     n = pool_sizes.get(res_type, 1)
        #     for _ in range(n):
        #         oid = state.new_object_id(res_type)
        #         obj = RuntimeObject(object_id=oid, object_type=res_type, active=True)
        #         state.objects[oid] = obj
        #         state._active_by_type.setdefault(res_type, set()).add(oid)
        #         state._type_of_object[oid] = res_type

        start_activity_names = self._start_names_set

        # #26: consecutive clock jumps taken while nothing was running. Reset
        # whenever an activity actually starts; bounded so a model that can
        # never make progress terminates instead of advancing the clock forever
        # (step_count, and therefore max_steps, only moves when an event is
        # recorded).
        _idle_jumps = 0
        _MAX_IDLE_JUMPS = 1000

        while True:
            # Early stop requested by the frontend (Stop button)
            if self.stop_event is not None and self.stop_event.is_set():
                self._trace("stop", {"reason": "user_stopped", "step_count": state.step_count})
                break

            # All stop conditions: time (primary), traces (primary), events/steps (safety cap)
            if self._should_stop(state):
                self._trace("stop", {"reason": "stop_condition_met", "step_count": state.step_count})
                break

            # ── Complete all activities due at or before current_time ──────────
            while state.in_progress and state.in_progress[0].complete_at <= state.current_time:
                finishing = heapq.heappop(state.in_progress)
                self._des_complete_activity(finishing, state)
                self._des_try_start_waiting(state, finishing.candidate_activity_name)
                if self._should_stop(state):
                    break

            if self._should_stop(state):
                self._trace("stop", {"reason": "stop_condition_met", "step_count": state.step_count})
                break

            # ── Generate candidates at current_time ───────────────────────────
            candidates = self._generate_candidates_des(state)

            if self.trace_func is not None:
                self._trace("iteration", {
                    "step_count": state.step_count,
                    "num_candidates": len(candidates),
                    "candidate_activity_names": [c.activity_name for c in candidates],
                    "candidates": [
                        {
                            "activity_name": c.activity_name,
                            "participating_object_ids": list(c.participating_object_ids),
                            "object_types_to_create": list(c.object_types_to_create),
                        }
                        for c in candidates
                    ],
                    "in_progress_count": len(state.in_progress),
                    "waiting_count": len(state.waiting_queue),
                    # Active objects per type (counts only, for size tracking)
                    "active_objects": {
                        ot: len(ids)
                        for ot, ids in state._active_by_type.items()
                        if ids
                    },
                    # Obligation summary: target_activity -> number of scope objects with pending obligations
                    "obligations": (lambda obl: {
                        act: sum(1 for (a, _) in obl if a == act)
                        for act in {a for (a, _) in obl}
                    })(list(state._obligations_count.keys())) if state._obligations_count else {},
                    # Distinct obligated activities (targets with at least one pending)
                    "obligated_activities": list({t for (t, _) in state._obligations_count}),
                    # Total pending obligations count
                    "total_obligations": len(state._obligations_count),
                    # Simulated clock time
                    "sim_time": state.current_time.isoformat() if state.current_time else None,
                    # Per-step delta counters
                    "deactivations_this_step":         state.total_deactivations - self._last_deactivations,
                    "obligations_fulfilled_this_step":  state.total_obligations_fulfilled - self._last_obligations_fulfilled,
                    "total_deactivations":             state.total_deactivations,
                    "total_obligations_fulfilled":     state.total_obligations_fulfilled,
                    "total_obligations_cancelled":     state.total_obligations_cancelled,
                })

            # ── Try to start each feasible candidate (greedy, probabilistic order)
            is_simulation_start = len(state.executed_events) == 0 and not state.in_progress

            # Order by transition probability so highest-probability activity starts first
            # Update delta baseline after tracing so next step's deltas are correct
            self._last_deactivations = state.total_deactivations
            self._last_obligations_fulfilled = state.total_obligations_fulfilled
            # #30: order by object-local preference rather than promoting one
            # candidate and leaving the rest in model-file order.
            ordered = self._order_candidates(candidates, state)

            for cand in ordered:
                if is_simulation_start and cand.activity_name not in start_activity_names:
                    continue
                if self._is_start_activity_blocked(cand, state):
                    continue
                # #26: authoritative concurrency re-check. Candidate generation
                # already filtered on this, but several candidates for the same
                # activity can be started within one step, so the count must be
                # re-read as the loop proceeds.
                if not self._concurrency_allows(cand, state):
                    continue
                # #29: availability calendar — the sole enforcement point, for
                # the reason given in _derive_primary_candidate.
                if not self._calendar_open(cand.activity_name, state):
                    continue
                # #27: authoritative per-object exclusivity. Candidates were all
                # built against the pre-start state, so an earlier candidate in
                # this same loop may already have claimed one of these objects.
                if not self._objects_free(cand, state):
                    continue

                # [resource/permanent-object handling — disabled, kept for reference]
                # _des_resources_available always returns (True, []) now, so the
                # else branch below (queue a candidate waiting on a busy resource)
                # is unreachable; kept commented for reference.
                available, held = self._des_resources_available(cand, state)
                if available:
                    self._des_start_activity(cand, state, held)
                # else:
                #     key = (cand.activity_name, tuple(sorted(cand.participating_object_ids)))
                #     already_waiting = any(
                #         (wc.candidate_activity_name, tuple(sorted(wc.participating_object_ids))) == key
                #         for wc in state.waiting_queue
                #     )
                #     if not already_waiting:
                #         blocked_type = ""
                #         for oid in cand.participating_object_ids:
                #             obj = state.objects.get(oid)
                #             if obj and obj.object_type in state._resource_types:
                #                 if obj.busy_until and obj.busy_until > state.current_time:
                #                     blocked_type = obj.object_type
                #                     break
                #         state.waiting_queue.append(WaitingCandidate(
                #             candidate_activity_name=cand.activity_name,
                #             participating_object_ids=cand.participating_object_ids,
                #             object_types_to_create=cand.object_types_to_create,
                #             arrived_at=state.current_time,
                #             blocked_resource_type=blocked_type,
                #         ))

            # ── Advance clock to next completion ──────────────────────────────
            if not state.in_progress:
                # #26: nothing is running, but an inter-arrival gap may simply
                # not have elapsed yet. That is an idle system, not a deadlock:
                # jump the clock to the earliest scheduled arrival, exactly as
                # a next-event simulation would. Only genuinely unreachable
                # states (no pending arrival at all) terminate the run.
                _future = [t for t in state._next_arrival_at.values()
                           if t is not None and t > state.current_time]
                # #29: a closed calendar hour is not a deadlock — the next hour
                # may open. Offer the next hour boundary as a jump target so a
                # run does not terminate every Friday evening. Bounded by
                # _MAX_IDLE_JUMPS below.
                if self._activity_calendars:
                    _future.append(
                        (state.current_time + timedelta(hours=1))
                        .replace(minute=0, second=0, microsecond=0))
                if _future:
                    state.current_time = min(_future)
                    _idle_jumps += 1
                    # Guard: step_count only advances when an event is recorded,
                    # so a run that jumps forever would never hit max_steps.
                    if _idle_jumps > _MAX_IDLE_JUMPS:
                        self._trace("stop", {"reason": "idle_no_progress",
                                             "step_count": state.step_count})
                        break
                    continue
                self._trace("stop", {"reason": "no_candidates", "step_count": state.step_count})
                break

            _idle_jumps = 0
            state.current_time = state.in_progress[0].complete_at

        self._trace("stop", {"reason": "stop_condition_met", "step_count": state.step_count,
                              "max_events": self.config.max_steps})
        return state