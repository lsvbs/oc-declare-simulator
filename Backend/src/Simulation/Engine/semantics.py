from __future__ import annotations

from itertools import chain, product as _product
from typing import Any, Optional

from Backend.src.Simulation.Domain.ir import StaticModel
from Backend.src.Simulation.Domain.state import SimulationState
from Backend.src.Simulation.Engine.linkplanning import plan_o2o_links
from Backend.src.Simulation.Engine.attrutils import apply_guard_filter
_EMPTY_SET: frozenset = frozenset()  # #14: reusable empty set to avoid alloc in O2O checks



# ---------------------------------------------------------------------------
# Index helpers
# ---------------------------------------------------------------------------

def _events_for_object(state: SimulationState, oid: str) -> list:
    """All executed events that involve object ``oid`` — O(1) lookup."""
    return state._events_by_object.get(oid, [])


def _events_for_activity(state: SimulationState, activity: str) -> list:
    """All executed events with the given activity name — O(1) lookup."""
    return state._events_by_activity.get(activity, [])


def _events_for_activity_and_object(state: SimulationState, activity: str, oid: str) -> list:
    """All executed events with given activity that involve object ``oid`` — O(1)."""
    return state._events_by_act_obj.get((activity, oid), [])


def _activity_fired_globally(state: SimulationState, activity: str) -> bool:
    """True if ``activity`` has fired at least once anywhere."""
    return bool(state._events_by_activity.get(activity))


def _activity_fired_for_object(state: SimulationState, activity: str, oid: str) -> bool:
    """True if ``activity`` has fired at least once involving ``oid``."""
    return bool(state._events_by_act_obj.get((activity, oid)))


def _count_activity_for_object(state: SimulationState, activity: str, oid: str) -> int:
    """Count of times ``activity`` fired involving ``oid``."""
    return len(state._events_by_act_obj.get((activity, oid), []))


def _last_activity_for_scope_object(state: SimulationState, scope_object_id: str) -> Optional[str]:
    """Activity name of the most recent event involving ``scope_object_id``, or None."""
    return state._last_activity_per_object.get(scope_object_id)


# ---------------------------------------------------------------------------
# Scope helpers
# ---------------------------------------------------------------------------

def _get_scope_object_ids_from_candidate(candidate: Any, state: SimulationState, scope_object_type: str) -> list[str]:
    # [resource/permanent-object handling — disabled, kept for reference]
    # resource_types = getattr(state, '_resource_types', set()) or set()
    ids: list[str] = []
    for oid in getattr(candidate, "participating_object_ids", []) or []:
        runtime = state.objects.get(oid)
        if runtime is None:
            continue
        if runtime.object_type == scope_object_type:
            # if runtime.object_type not in resource_types:
            ids.append(oid)
    return ids


# ---------------------------------------------------------------------------
# Constraint checkers
# ---------------------------------------------------------------------------

def _scope_ids(candidate: Any, state: SimulationState, scope_type: str,
               cache: dict | None = None) -> list[str]:
    """Return scope object IDs, using pre-computed cache when available (#12)."""
    if cache is not None:
        return cache.get(scope_type, [])
    return _get_scope_object_ids_from_candidate(candidate, state, scope_type)


def _scope_assignments(candidate, state, scope, cache=None):
    """Definition 8: one joint filter for EVERY Cartesian Each assignment.

    Empty Each domains are vacuous; empty All is the identity; empty Any
    matches nothing. Prospective creations have no previous events.
    """
    by_type = {t: list(ids) for t, ids in (cache or {}).items()}
    if cache is None:
        for oid in candidate.participating_object_ids:
            obj = state.objects.get(oid)
            if obj:
                by_type.setdefault(obj.object_type, []).append(oid)
    for i, typ in enumerate(getattr(candidate, 'object_types_to_create', ())):
        by_type.setdefault(typ, []).append(('new', i, typ))
    bindings = scope.bindings or (((scope.object_type, scope.kind),) if scope.object_type else ())
    each, required, anys = [], set(), []
    for typ, mode in bindings:
        ids = by_type.get(typ, [])
        if mode == 'each':
            each.append(ids)
        elif mode == 'all':
            required.update(ids)
        elif mode == 'any':
            anys.append(frozenset(ids))
    for assignment in _product(*each):
        yield required.union(assignment), tuple(anys)


def _matches_objects(object_ids, required, anys):
    ids = set(object_ids)
    return required.issubset(ids) and all(ids.intersection(group) for group in anys)


class _ProjectedEvents(tuple):
    """Indexed reservation snapshot, used only within one admission check.

    Positions preserve the original order and duplicate events, including the
    legacy untimed fallback. No results survive a change to simulation state.
    """

    def __init__(self, events):
        self._by_object = {}
        self._by_activity = {}
        self._matches = {}
        for position, event in enumerate(self):
            self._by_activity.setdefault(event.activity_name, []).append(position)
            for oid in set(event.object_ids):
                self._by_object.setdefault(oid, []).append(position)

    def matching(self, required, anys, activity=None):
        key = (frozenset(required), tuple(anys), activity)
        if key in self._matches:
            return self._matches[key]
        pools = [self._by_object.get(oid, ()) for oid in required]
        if activity is not None:
            pools.append(self._by_activity.get(activity, ()))
        for group in anys:
            pools.append(sorted({i for oid in group for i in self._by_object.get(oid, ())}))
        positions = min(pools, key=len) if pools else range(len(self))
        result = tuple(self[i] for i in positions
                       if (activity is None or self[i].activity_name == activity)
                       and _matches_objects(self[i].object_ids, required, anys))
        self._matches[key] = result
        return result


def _scope_events(state, required, anys, activity=None, extra=()):
    """Filter objects before nearest-time selection; retain equal-time ties."""
    pools = [state._events_by_object.get(oid, ()) for oid in required]
    if activity is not None:
        pools.append(state._events_by_activity.get(activity, ()))
    for group in anys:
        pool = {e.event_id: e for oid in group for e in state._events_by_object.get(oid, ())}
        pools.append(list(pool.values()))
    pool = min(pools, key=len) if pools else state.executed_events
    if isinstance(extra, _ProjectedEvents):
        extra = extra.matching(required, anys, activity)
    return [e for e in chain(pool, extra)
            if (activity is None or e.activity_name == activity)
            and _matches_objects(e.object_ids, required, anys)]


def _nearest_events(events, forward):
    if not events:
        return []
    if any(e.timestamp is None for e in events):
        # Legacy, untimed in-memory histories retain their recorded order.
        return [events[0] if forward else events[-1]]
    moment = (min if forward else max)(e.timestamp for e in events)
    return [e for e in events if e.timestamp == moment]


def _precedence_counts(constraint, candidate, state, scope_ids_cache=None, direct=False):
    timestamp = getattr(candidate, 'evaluation_timestamp', None)
    extra = getattr(candidate, 'projected_events', ())
    for required, anys in _scope_assignments(candidate, state, constraint.scope, scope_ids_cache):
        if not direct and timestamp is None and not extra:
            # Untimed candidate generation counts the whole completed history.
            # The maintained event-ID indexes encode the same joint filter;
            # avoid reconstructing event/object sets for every repeated EP test.
            # Sampled timestamps and direct windows still take the full path.
            pools = [state._event_ids_by_act_obj.get((constraint.source_activity, oid), _EMPTY_SET)
                     for oid in required]
            for group in anys:
                pools.append(set().union(*(state._event_ids_by_act_obj.get(
                    (constraint.source_activity, oid), _EMPTY_SET) for oid in group)))
            if not pools:
                yield len(state._events_by_activity.get(constraint.source_activity, ()))
            else:
                smallest = min(pools, key=len)
                # Never mutate the index sets owned by SimulationState.
                yield len(smallest.intersection(*pools)) if len(pools) > 1 else len(smallest)
            continue
        events = _scope_events(state, required, anys,
                               None if direct else constraint.source_activity, extra)
        if timestamp is not None:
            events = [e for e in events if e.timestamp is None or e.timestamp < timestamp]
        if direct:
            events = _nearest_events(events, forward=False)
        yield sum(e.activity_name == constraint.source_activity for e in events)



def check_not_coexistence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    if candidate.activity_name == constraint.source_activity:
        forbidden = constraint.target_activity
    elif candidate.activity_name == constraint.target_activity:
        forbidden = constraint.source_activity
    else:
        return True

    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        for oid in scope_ids:
            if _activity_fired_for_object(state, forbidden, oid):
                return False
        return True

    if constraint.scope.kind in ("any", "all"):
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        results = [_activity_fired_for_object(state, forbidden, oid) for oid in scope_ids]
        if constraint.scope.kind == "any":
            return not any(results)   # fail if any object has the forbidden activity
        else:  # all
            return not all(results)   # fail only if all objects have it

    return not _activity_fired_globally(state, forbidden)


def _nmax_blocked(constraint, candidate, state, target_activity, nmax, scope_ids_cache=None) -> bool:
    """True if firing `target_activity` now would push a Definition 8 count past nmax.

    Definition 8 (Küsters & van der Aalst, OC-DECLARE, p. 10) bounds exactly
    ONE quantity per Each assignment::

        e |= D  <=>  for all o_1 in obj^ot1(e), ..., o_n in obj^otn(e):
                         n_min <= |f(E_L)| <= n_max

        f = filter^act_t  o  filter^time_{ts(e),ar}  o  filter^all_{o_1..o_n}
              o  filter^all_{ obj^ot(e) | ot in All_oi }
              o  filter^any_{ obj^ot(e) | ot in Any_oi }

    |f(E_L)| is a JOINT count: target-activity events that involve the chosen
    Each objects *together with* every All object and at least one Any object.
    One number per Each assignment — never one number per object type. The
    bound must hold for every assignment, so the constraint is blocked as soon
    as a single assignment has reached nmax (firing again would exceed it).

    What this replaces: a per-type marginal — |events of target_activity
    involving this object|, taken separately for each binding and each compared
    to nmax. A marginal is always >= the intersection, so the old form was
    strictly stricter than the paper, and unboundedly so. For
    `Load Truck -> Drive to Terminal {Container: each, Truck: each}` with
    nmax=1 the log's joint count is 1 (one Drive to Terminal per
    container-truck pair) while the Truck marginal is 335 — so once any truck
    had driven once, every later candidate carrying that truck was refused.
    Folding All/Any into the event set rather than into a choice between
    any()/all() over the object list is the same correction: the paper filters
    *events*, not objects.

    Remaining deviation from Definition 8: no filter^time. The paper evaluates
    a source event e and looks forward or backward from ts(e); this is called
    for a *prospective* target event, with no reference source event in hand,
    so the count runs over the whole executed history. A wider window can only
    make the count larger, so this stays on the strict side of the paper.

    Index sets from state._event_ids_by_act_obj are treated as READ-ONLY —
    every combination below builds a new set via `&` or `|`.
    """
    if nmax is None:
        return False
    pending = [p for p in state.in_progress if p.candidate_activity_name == target_activity]
    if constraint.scope.kind not in ('each', 'any', 'all') and not constraint.scope.bindings:
        return len(state._events_by_activity.get(target_activity, ())) + len(pending) >= nmax
    bindings = getattr(constraint.scope, 'bindings', None) or (
        (constraint.scope.object_type, constraint.scope.kind),)

    eids_index = state._event_ids_by_act_obj

    def _tgt_eids(oid: str):
        completed = eids_index.get((target_activity, oid), _EMPTY_SET)
        if not pending:
            return completed
        # Reserve a distinct event for each running instance, preserving the
        # same joint Each/Any/All filtering as for completed events.
        return completed | {('running', index) for index, running in enumerate(pending)
                            if oid in running.participating_object_ids}

    # filter^all / filter^any contribute the same restriction to every Each
    # assignment, so they are folded once into `base`. None means "no
    # restriction applied yet", which is different from an empty set.
    base = None
    each_groups: list = []

    for obj_type, involvement in bindings:
        if not obj_type:
            continue
        oids = _scope_ids(candidate, state, obj_type, scope_ids_cache)

        if involvement == 'each':
            if not oids:
                # The universal quantifier ranges over obj^ot(e). With no
                # objects of this type the product is empty and the bound holds
                # vacuously — for any nmax, including 0.
                return False
            each_groups.append(oids)
            continue

        if involvement == 'any':
            # filter^any: events involving at least one of these objects. With
            # no objects that is the empty set, not the identity.
            acc: set = set()
            for oid in oids:
                acc |= _tgt_eids(oid)
        else:  # 'all'
            # filter^all: events involving all of them. Over no objects this is
            # the identity, so the binding adds no restriction.
            if not oids:
                continue
            acc = None
            for oid in oids:
                s = _tgt_eids(oid)
                acc = set(s) if acc is None else (acc & s)
        base = acc if base is None else (base & acc)

    if not each_groups:
        if base is None:
            # No object involvement at all. Not reachable from a parsed model —
            # parse_ocdeclare_dict always populates scope.bindings — and the
            # global-scope case is handled by the checkers themselves.
            return False
        return len(base) >= nmax

    # Every joint count is a subset of `base`, so if `base` itself cannot reach
    # the ceiling no assignment can either.
    if base is not None and len(base) < nmax:
        return False

    for assignment in _product(*each_groups):
        joint = base
        for oid in assignment:
            s = _tgt_eids(oid)
            joint = s if joint is None else (joint & s)
            if not joint:
                break
        if (len(joint) if joint is not None else 0) >= nmax:
            return True
    return False


def check_response(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Lazy response enforcement — only upper-bound (nmax) is enforced eagerly."""
    required_target = constraint.target_activity
    nmax = getattr(constraint, "nmax", None)

    if candidate.activity_name == required_target:
        # Every binding, not just scope.object_type. A multi-type response
        # constraint previously degraded to its primary type without warning:
        # `Reschedule Container -> Depart` over {Container, Transport Document,
        # Vehicle} was enforced on Container alone.
        if _nmax_blocked(constraint, candidate, state, required_target, nmax, scope_ids_cache):
            return False
        return True

    return True


def check_precedence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None,
                      cand_by_type_cache: dict | None = None) -> bool:
    if candidate.activity_name != constraint.target_activity:
        return True
    lower, upper = constraint.nmin, constraint.nmax
    return all(count >= lower and (upper is None or count <= upper)
               for count in _precedence_counts(constraint, candidate, state, scope_ids_cache))


def check_not_precedence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    source = constraint.source_activity
    target = constraint.target_activity

    if candidate.activity_name != target:
        return True

    if constraint.scope.kind in ("each", "any", "all"):
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        results = [_activity_fired_for_object(state, source, oid) for oid in scope_ids]
        if constraint.scope.kind == "any":
            return not any(results)   # fail if any object has the source
        else:  # each or all
            return not any(results)   # same: fail if any scope object was preceded by source

    return not _activity_fired_globally(state, source)


def check_chain_precedence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    if candidate.activity_name != constraint.target_activity:
        return True
    return all(count >= constraint.nmin and (constraint.nmax is None or count <= constraint.nmax)
               for count in _precedence_counts(constraint, candidate, state, scope_ids_cache, direct=True))


def check_chain_response(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """A DF activation constrains its nearest later JOINT-scope timestamp.

    Historical activations keep their own Each/All/Any objects. Looking only
    at the proposed event's last activity incorrectly treats partial matches
    as intervening events and loses Any groups. Future lower bounds remain
    explicit response obligations until a qualifying completion occurs.
    """
    from types import SimpleNamespace
    timestamp = getattr(candidate, 'evaluation_timestamp', None)
    extra = getattr(candidate, 'projected_events', ())
    proposed = SimpleNamespace(event_id=('proposed',), activity_name=candidate.activity_name,
                               object_ids=candidate.participating_object_ids, timestamp=timestamp)
    bindings = constraint.scope.bindings or ((constraint.scope.object_type, constraint.scope.kind),)
    if constraint.scope.object_type and any(mode in ('each', 'any') for _, mode in bindings):
        # Such an activation must share a participant to be affected. Avoid
        # rescanning all completed cases for every new object-local candidate.
        activations = list({e.event_id: e for oid in candidate.participating_object_ids
                            for e in state._events_by_act_obj.get((constraint.source_activity, oid), ())}.values())
    else:
        activations = list(state._events_by_activity.get(constraint.source_activity, ()))
    if isinstance(extra, _ProjectedEvents):
        activations.extend(extra.matching(frozenset(), (), constraint.source_activity))
    else:
        activations.extend(e for e in extra if e.activity_name == constraint.source_activity)
    # A new source cannot be admitted if already scheduled work would
    # immediately violate it. Its newly created objects have no scheduled work.
    if timestamp is not None and candidate.activity_name == constraint.source_activity:
        activations.append(proposed)
    for activation in activations:
        if activation is not proposed and timestamp is not None and activation.timestamp is not None and timestamp <= activation.timestamp:
            continue
        by_type = {}
        for oid in activation.object_ids:
            obj = state.objects.get(oid)
            if obj:
                by_type.setdefault(obj.object_type, []).append(oid)
        if constraint.guard and constraint.scope.object_type:
            typ = constraint.scope.object_type
            by_type[typ] = apply_guard_filter(by_type.get(typ, []), constraint.guard, state)
            if not by_type[typ]:
                continue
        view = candidate if activation is proposed else activation
        for required, anys in _scope_assignments(view, state, constraint.scope, by_type):
            if activation is not proposed and not _matches_objects(proposed.object_ids, required, anys):
                continue
            events = _scope_events(state, required, anys, extra=extra)
            if activation.timestamp is None:
                # Untimed test/legacy histories: only events recorded after A.
                positions = {e.event_id: i for i, e in enumerate(state.executed_events)}
                events = [e for e in events if positions.get(e.event_id, -1) > positions.get(activation.event_id, -1)]
            else:
                events = [e for e in events if e.timestamp is not None and e.timestamp > activation.timestamp]
            if activation is not proposed:
                # Without a sampled timestamp the proposal is after completed
                # history. An already resolved direct window is unaffected.
                if timestamp is None and events:
                    continue
                events.append(proposed)
            nearest = _nearest_events(events, forward=True)
            if not nearest:
                continue  # still a future obligation
            count = sum(e.activity_name == constraint.target_activity for e in nearest)
            if count < constraint.nmin or (constraint.nmax is not None and count > constraint.nmax):
                return False
    return True


def check_responded_existence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Post-hoc obligation — cannot block eagerly. Always returns True."""
    return True


def check_absence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Activity must never occur (nmax=0) or at most nmax times."""
    target = constraint.target_activity or constraint.source_activity
    if candidate.activity_name != target:
        return True
    nmax = getattr(constraint, "nmax", 0)
    if nmax is None:
        nmax = 0
    if nmax <= 0:
        return False
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return len(state._events_by_activity.get(target, [])) < nmax
        for oid in scope_ids:
            cnt = _count_activity_for_object(state, target, oid)
            if cnt >= nmax:
                return False
        return True
    cnt = (len(state._events_by_activity.get(target, []))
           + state._in_progress_by_activity.get(target, 0))
    return cnt < nmax


def check_exactly(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Activity must occur exactly nmin times. Block after nmin firings."""
    target = constraint.target_activity or constraint.source_activity
    if candidate.activity_name != target:
        return True
    nmin = getattr(constraint, "nmin", 1) or 1
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return len(state._events_by_activity.get(target, [])) < nmin
        for oid in scope_ids:
            if _count_activity_for_object(state, target, oid) >= nmin:
                return False
        return True
    return (len(state._events_by_activity.get(target, []))
            + state._in_progress_by_activity.get(target, 0)) < nmin


def check_init(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Activity must be the first event for each scope object.

    For 'each' scope: the target must have fired for at least one scope object
    that participates in this candidate before any other activity fires for that
    object.  Using _activity_fired_globally is incorrect in multi-case runs
    because one case's init vacuously satisfies all other concurrent cases.
    """
    target = constraint.target_activity or constraint.source_activity
    if candidate.activity_name == target:
        return True

    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            # No scope objects yet — vacuously satisfied (nothing to enforce against)
            return True
        for oid in scope_ids:
            if not _activity_fired_for_object(state, target, oid):
                return False
        return True

    if constraint.scope.kind == "any":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        return any(_activity_fired_for_object(state, target, oid) for oid in scope_ids)

    if constraint.scope.kind == "all":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        return all(_activity_fired_for_object(state, target, oid) for oid in scope_ids)

    # Global fallback (no scope type set)
    return _activity_fired_globally(state, target)


def check_exclusive_choice(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Exactly one of source or target may occur. Once one fires, block the other."""
    source = constraint.source_activity
    target = constraint.target_activity
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        for oid in scope_ids:
            if candidate.activity_name == source and _activity_fired_for_object(state, target, oid):
                return False
            if candidate.activity_name == target and _activity_fired_for_object(state, source, oid):
                return False
        return True
    if candidate.activity_name == source:
        return not _activity_fired_globally(state, target)
    if candidate.activity_name == target:
        return not _activity_fired_globally(state, source)
    return True


def check_not_succession(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """After source fires, target must never follow."""
    source = constraint.source_activity
    target = constraint.target_activity
    if candidate.activity_name != target:
        return True
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return not _activity_fired_globally(state, source)
        for oid in scope_ids:
            if _activity_fired_for_object(state, source, oid):
                return False
        return True
    return not _activity_fired_globally(state, source)


def check_not_chain_succession(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Target must not occur immediately after source."""
    source = constraint.source_activity
    target = constraint.target_activity
    if candidate.activity_name != target:
        return True
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            if not state.executed_events:
                return True
            return state.executed_events[-1].activity_name != source
        for oid in scope_ids:
            if _last_activity_for_scope_object(state, oid) == source:
                return False
        return True
    if not state.executed_events:
        return True
    return state.executed_events[-1].activity_name != source


def check_alternate_response(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Block source from firing again while it is armed (fired but target hasn't responded)."""
    source = constraint.source_activity
    target = constraint.target_activity
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        for oid in scope_ids:
            src_count = _count_activity_for_object(state, source, oid)
            tgt_count = _count_activity_for_object(state, target, oid)
            if candidate.activity_name == source and src_count > tgt_count:
                return False
        return True
    src_count = len(state._events_by_activity.get(source, []))
    tgt_count = len(state._events_by_activity.get(target, []))
    if candidate.activity_name == source and src_count > tgt_count:
        return False
    return True


def check_alternate_precedence(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None) -> bool:
    """Each target firing must be matched by a preceding source; block target when balanced."""
    source = constraint.source_activity
    target = constraint.target_activity
    if candidate.activity_name != target:
        return True
    if constraint.scope.kind == "each":
        scope_ids = _scope_ids(candidate, state, constraint.scope.object_type, scope_ids_cache)
        if not scope_ids:
            return True
        for oid in scope_ids:
            src_count = _count_activity_for_object(state, source, oid)
            tgt_count = _count_activity_for_object(state, target, oid)
            if tgt_count >= src_count:
                return False
        return True
    src_count = len(state._events_by_activity.get(source, []))
    tgt_count = len(state._events_by_activity.get(target, []))
    return tgt_count < src_count


# Constraint types whose checker resolves scope.bindings itself. Everything else
# reads scope.object_type only, so the dispatcher splits multi-type constraints
# for them — see check_constraint.
_BINDING_AWARE_TYPES = frozenset({"precedence", "response", "chain_precedence", "chain_response", "direct_precedence", "direct_response", "chain_succession"})


def _single_binding_views(constraint: Any):
    """Yield one constraint per scope binding, each scoped to a single type.

    Used to give binding-unaware checkers multi-type coverage without rewriting
    each of them. A multi-type OC-Declare arc requires all its bindings to hold,
    so the dispatcher evaluates the checker once per binding and requires all to
    pass.

    APPROXIMATION, and worth stating where these results are reported: this
    tests "for each binding there is a qualifying source event" whereas the true
    joint semantics is "there is ONE source event qualifying under every binding
    simultaneously". The former is weaker — different bindings may be satisfied
    by different events. The binding-aware temporal checkers implement joint
    object filters themselves and are excluded from this path. For
    the remaining types this is still strictly more correct than the previous
    behaviour, which silently ignored every binding after the first.
    """
    import dataclasses
    bindings = getattr(constraint.scope, "bindings", None) or ()
    for obj_type, involvement in bindings:
        scope_view = dataclasses.replace(
            constraint.scope, kind=involvement, object_type=obj_type, bindings=()
        )
        yield dataclasses.replace(constraint, scope=scope_view)


def check_constraint(constraint: Any, candidate: Any, state: SimulationState, scope_ids_cache: dict | None = None,
                      cand_by_type_cache: dict | None = None) -> bool:
    kind = getattr(constraint, "constraint_type", None)
    # Multi-type constraint on a checker that only reads scope.object_type:
    # evaluate it once per binding and require all to hold. Without this the
    # constraint is enforced on its primary object type alone, silently.
    if kind not in _BINDING_AWARE_TYPES:
        _bindings = getattr(constraint.scope, "bindings", None) or ()
        if len(_bindings) > 1:
            return all(
                check_constraint(view, candidate, state, scope_ids_cache, cand_by_type_cache)
                for view in _single_binding_views(constraint)
            )
    if kind == "not_coexistence":
        return check_not_coexistence(constraint, candidate, state, scope_ids_cache)
    if kind == "response":
        return check_response(constraint, candidate, state, scope_ids_cache)
    if kind == "precedence":
        return check_precedence(constraint, candidate, state, scope_ids_cache, cand_by_type_cache)
    if kind == "not_precedence":
        return check_not_precedence(constraint, candidate, state, scope_ids_cache)
    if kind == "responded_existence":
        return check_responded_existence(constraint, candidate, state, scope_ids_cache)
    if kind in ("chain_response", "direct_response"):
        return check_chain_response(constraint, candidate, state, scope_ids_cache)
    if kind in ("chain_precedence", "direct_precedence"):
        return check_chain_precedence(constraint, candidate, state, scope_ids_cache)
    # New constraint types
    if kind == "absence":
        return check_absence(constraint, candidate, state, scope_ids_cache)
    if kind == "exactly":
        return check_exactly(constraint, candidate, state, scope_ids_cache)
    if kind == "init":
        return check_init(constraint, candidate, state, scope_ids_cache)
    if kind == "exclusive_choice":
        return check_exclusive_choice(constraint, candidate, state, scope_ids_cache)
    if kind == "not_succession":
        return check_not_succession(constraint, candidate, state, scope_ids_cache)
    if kind == "not_chain_succession":
        return check_not_chain_succession(constraint, candidate, state, scope_ids_cache)
    if kind == "alternate_response":
        return check_alternate_response(constraint, candidate, state, scope_ids_cache)
    if kind == "alternate_precedence":
        return check_alternate_precedence(constraint, candidate, state, scope_ids_cache)
    # Composite constraints decomposed into existing checks
    if kind == "succession":
        # Succession = Precedence ∧ Response (nmax enforcement)
        return (check_precedence(constraint, candidate, state, scope_ids_cache, cand_by_type_cache) and
                check_response(constraint, candidate, state, scope_ids_cache))
    if kind == "chain_succession":
        # Chain Succession = Chain Precedence ∧ Chain Response
        return (check_chain_precedence(constraint, candidate, state, scope_ids_cache) and
                check_chain_response(constraint, candidate, state, scope_ids_cache))
    if kind == "alternate_succession":
        # Alternate Succession = Alternate Response ∧ Alternate Precedence
        return (check_alternate_response(constraint, candidate, state, scope_ids_cache) and
                check_alternate_precedence(constraint, candidate, state, scope_ids_cache))
    # participation and choice are post-hoc (end-of-trace) — not enforced eagerly
    # coexistence is also post-hoc
    return True


def check_all_constraints(static_model: StaticModel, candidate: Any, state: SimulationState) -> bool:
    relevant = static_model.constraints_for_activity(candidate.activity_name)
    if not relevant:
        return True
    # #12: pre-compute scope object IDs once per scope type, reused by all checkers
    # [resource/permanent-object handling — disabled, kept for reference]
    # resource_types = getattr(state, '_resource_types', set()) or set()
    scope_ids_cache: dict[str, list[str]] = {}
    # Same pass also builds the resource-inclusive type grouping multi-type
    # precedence bindings need — avoids that function
    # rebuilding an identical grouping from scratch on every such check (#21).
    # (With resource handling disabled, scope_ids_cache and cand_by_type_cache
    # always end up identical — no type is ever excluded as a resource.)
    cand_by_type_cache: dict[str, list[str]] = {}
    for oid in getattr(candidate, "participating_object_ids", []) or []:
        runtime = state.objects.get(oid)
        if runtime is None:
            continue
        cand_by_type_cache.setdefault(runtime.object_type, []).append(oid)
        # if runtime.object_type in resource_types:
        #     continue
        scope_ids_cache.setdefault(runtime.object_type, []).append(oid)

    # Performance: set of object types with zero active instances — constraints
    # scoped to these types pass trivially (scope_ids would be empty → True)
    inactive_types = getattr(state, '_inactive_scope_types', None)
    creates_set = set(getattr(candidate, 'object_types_to_create', []) or [])

    for constraint in relevant:
        # Skip constraint if its scope type is fully inactive and not being created now
        if inactive_types is not None and constraint.constraint_type not in _BINDING_AWARE_TYPES:
            scope_type = getattr(constraint.scope, 'object_type', None)
            if scope_type and scope_type in inactive_types and scope_type not in creates_set:
                continue

        # Phase 2: apply constraint-level object-filter guard.
        # Scope objects not satisfying the guard are exempt — filter them out
        # before passing to the checker. If no objects remain, skip (trivially passes).
        c_guard = getattr(constraint, 'guard', None)
        if c_guard:
            scope_type = getattr(constraint.scope, 'object_type', None)
            if scope_type:
                original_ids = scope_ids_cache.get(scope_type, [])
                guarded_ids = apply_guard_filter(original_ids, c_guard, state)
                if not guarded_ids:
                    continue  # no objects subject to this constraint — passes trivially
                local_cache = {**scope_ids_cache, scope_type: guarded_ids}
                if not check_constraint(constraint, candidate, state, local_cache, local_cache):
                    return False
                continue

        if not check_constraint(constraint, candidate, state, scope_ids_cache, cand_by_type_cache):
            return False
    return True


# ---------------------------------------------------------------------------
# O2O rule checks
# ---------------------------------------------------------------------------

def check_o2o_rules(static_model: StaticModel, candidate: Any, state: SimulationState) -> bool:
    """Validate exactly the relationship effects that will be applied at start."""
    return plan_o2o_links(
        static_model,
        getattr(candidate, "participating_object_ids", []) or [],
        state,
        getattr(candidate, "object_types_to_create", []) or [],
    ) is not None


def check_temporal_schedule(static_model, candidate, state, complete_at):
    """Validate the sampled completion together with already reserved work.

    This keeps zero durations and concurrent, overlapping Any/global scopes
    consistent with the strict timestamps used in the exported OCEL log.
    Nothing is committed here; a rejected reservation has no state effects.
    """
    from dataclasses import replace
    from types import SimpleNamespace
    from Backend.src.Simulation.Engine.candidategeneration import Candidate

    temporal = [c for c in static_model.constraints if c.constraint_type in (
        'precedence', 'chain_precedence', 'direct_precedence', 'chain_response', 'direct_response')]
    if not temporal:
        return True
    projected = _ProjectedEvents(SimpleNamespace(event_id=('running', i), activity_name=p.candidate_activity_name,
                      object_ids=p.participating_object_ids, timestamp=p.complete_at)
                      for i, p in enumerate(state.in_progress))
    # Precedence checkers can only reject their target activity. DF can reject
    # intervening activities too, so it must remain in every proposed check.
    activities = {candidate.activity_name, *(e.activity_name for e in projected)}
    backward_index = {a: [c for c in temporal if c.constraint_type in (
        'precedence', 'chain_precedence', 'direct_precedence') and c.target_activity == a]
        for a in activities}
    temporal_index = {a: [c for c in temporal if c.constraint_type in (
        'chain_response', 'direct_response') or c.target_activity == a] for a in activities}
    temporal_model = replace(static_model, constraints=temporal, _constraints_by_activity=temporal_index)
    proposed = replace(candidate, evaluation_timestamp=complete_at, projected_events=projected)
    if not check_all_constraints(temporal_model, proposed, state):
        return False
    extra = SimpleNamespace(event_id=('proposed',), activity_name=candidate.activity_name,
                            object_ids=candidate.participating_object_ids, timestamp=complete_at)
    # A new completion may intervene before a DP target already scheduled on
    # another member of an Any group (or in a global scope).
    backward_model = replace(temporal_model, constraints=[c for c in temporal if c.constraint_type in (
        'precedence', 'chain_precedence', 'direct_precedence')], _constraints_by_activity=backward_index)
    with_proposed = _ProjectedEvents((*projected, extra))
    for event in projected:
        if not backward_index[event.activity_name]:
            continue
        pending = Candidate(event.activity_name, event.object_ids,
                            evaluation_timestamp=event.timestamp,
                            projected_events=with_proposed)
        if not check_all_constraints(backward_model, pending, state):
            return False
    return True
