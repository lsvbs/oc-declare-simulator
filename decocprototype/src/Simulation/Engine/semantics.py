
from __future__ import annotations
# Placeholder constraint checks for not-yet-implemented OC-Declare arc types
def check_responded_existence(state, scope_object_id, source_activity, target_activity):
    """
    Responded Existence (AS): Whenever source_activity (A) occurs in the given scope,
    target_activity (B) must also occur at least once (order does not matter).
    Returns True if the constraint is satisfied.
    """
    # Get all events for this scope object
    events = [e for e in state.executed_events if scope_object_id in getattr(e, 'participating_object_ids', [])]
    a_occurred = any(e.activity_name == source_activity for e in events)
    b_occurred = any(e.activity_name == target_activity for e in events)
    # If A never occurs, constraint is vacuously satisfied
    if not a_occurred:
        return True
    # If A occurs, B must also occur
    return b_occurred

def check_chain_response(state, scope_object_id, source_activity, target_activity):
    """
    Returns True if for every occurrence of source_activity (A) in the given scope,
    the immediately next event is target_activity (B).
    """
    events = [e for e in state.executed_events if scope_object_id in getattr(e, 'participating_object_ids', [])]
    events_sorted = sorted(events, key=lambda e: e.timestamp)
    for idx, event in enumerate(events_sorted):
        if event.activity_name == source_activity:
            # A found, check if next event is B
            if idx == len(events_sorted)-1 or events_sorted[idx+1].activity_name != target_activity:
                return False
    return True



def check_chain_precedence(state, scope_object_id, source_activity, target_activity):
    """
    Returns True if for every occurrence of target_activity (B) in the given scope,
    the immediately preceding event (in time/order) is source_activity (A).
    """
    # Get all events for this scope object, sorted by timestamp or order
    events = [e for e in state.executed_events if scope_object_id in getattr(e, 'participating_object_ids', [])]
    events_sorted = sorted(events, key=lambda e: e.timestamp)
    for idx, event in enumerate(events_sorted):
        if event.activity_name == target_activity:
            # B found, check if previous event is A
            if idx == 0 or events_sorted[idx-1].activity_name != source_activity:
                return False
    return True



from typing import Any, Iterable, Optional

from src.Simulation.Domain.ir import StaticModel
from src.Simulation.Domain.state import SimulationState
from src.Simulation.Domain.ir import O2ORule


def _get_scope_object_ids_from_candidate(candidate: Any, state: SimulationState, scope_object_type: str) -> list[str]:
    """Helper to get scope object ids that the candidate refers to.

    Candidate is expected to have `participating_object_ids` (list[str]) and
    `object_types_to_create` (list[str]), but we only consider existing
    participating ids for scope checks (newly created objects don't have history).
    """
    ids: list[str] = []
    for oid in getattr(candidate, "participating_object_ids", []) or []:
        runtime = state.objects.get(oid)
        if runtime is None:
            continue
        if runtime.object_type == scope_object_type:
            ids.append(oid)
    return ids


def check_not_coexistence(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    """Check not_coexistence constraint for the candidate in the given state.

    Returns True when the candidate does not violate the constraint.
    """
    # If the candidate is not one of the two activities in the constraint,
    # the constraint is irrelevant for this candidate.
    if candidate.activity_name == constraint.source_activity:
        forbidden_other_activity = constraint.target_activity
    elif candidate.activity_name == constraint.target_activity:
        forbidden_other_activity = constraint.source_activity
    else:
        return True

    # Scope-aware check for 'each'
    if constraint.scope.kind == "each":
        scope_object_ids = _get_scope_object_ids_from_candidate(candidate, state, constraint.scope.object_type)

        # If the candidate does not yet refer to an existing scope object
        # of that type, then there is no previous scoped history to violate.
        if not scope_object_ids:
            return True

        for executed_event in state.executed_events:
            if executed_event.activity_name != forbidden_other_activity:
                continue

            for scope_object_id in scope_object_ids:
                if scope_object_id in executed_event.object_ids:
                    return False

        return True

    # Fallback: global check (anywhere)
    for executed_event in state.executed_events:
        if executed_event.activity_name == forbidden_other_activity:
            return False

    return True


def check_response(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    """Check response constraint (if A happens then B must happen later in the same scope).

        Previous versions enforced response *eagerly* during candidate selection:
        whenever there was an outstanding obligation "A -> B" for a scope object,
        only B was allowed next for that scope object. This caused deadlocks when
        multiple different response constraints shared the same source (A -> B,
        A -> C, ...), because no single candidate could satisfy all of them at
        once.

        We now adopt a more permissive, *lazy* interpretation at simulation time:

        - Non-target activities are never blocked by outstanding response
            obligations. They are assumed to be intermediate steps that may be
            followed by the required target(s) later.
        - Target activities (B) are still checked against optional upper bounds
            (nmax) to avoid exceeding configured cardinalities.

        Full satisfaction of response constraints (i.e., that every A is
        eventually followed by a B before the end of a case) is therefore a
        *post-hoc* property of the produced log, not something that is enforced
        step-by-step during candidate generation.
    """
    required_source = constraint.source_activity
    required_target = constraint.target_activity

    # Optional cardinality bounds imported from OC-DECLARE
    nmin = getattr(constraint, "nmin", 0)
    nmax = getattr(constraint, "nmax", None)

    # If candidate is the target activity, it may satisfy outstanding
    # obligations. However, if an upper bound nmax is configured, we must
    # ensure that executing another target for the same scoped objects would
    # not exceed that bound. We approximate this by counting how many target
    # events already occurred for each scoped object in the past.
    if candidate.activity_name == required_target:
        if constraint.scope.kind == "each" and nmax is not None:
            scope_object_ids = _get_scope_object_ids_from_candidate(
                candidate, state, constraint.scope.object_type
            )

            for scope_object_id in scope_object_ids:
                # count how many times the target already occurred for this scope object
                target_count = 0
                for executed_event in state.executed_events:
                    if scope_object_id not in executed_event.object_ids:
                        continue
                    if executed_event.activity_name == required_target:
                        target_count += 1

                if target_count >= nmax:
                    # executing another target would exceed nmax for this scope
                    return False

        return True

    # For non-target activities we no longer enforce outstanding response
    # obligations eagerly. They are always allowed (from the perspective of
    # this constraint), regardless of existing A/B history.
    return True


def check_constraint(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    kind = getattr(constraint, "constraint_type", None)
    if kind == "not_coexistence":
        return check_not_coexistence(constraint, candidate, state)
    if kind == "response":
        return check_response(constraint, candidate, state)
    if kind == "precedence":
        return check_precedence(constraint, candidate, state)
    if kind == "not_precedence":
        return check_not_precedence(constraint, candidate, state)
    if kind == "responded_existence":
        # responded_existence is a retrospective constraint (checked on logs, not enforced during generation)
        # It states: if A occurs, B must also occur (no order). This is vacuously satisfied during generation.
        return True
    if kind == "chain_response":
        return check_chain_response(constraint, candidate, state)
    if kind == "chain_precedence":
        return check_chain_precedence(constraint, candidate, state)
    
    # Unknown constraint type: be permissive and allow (avoids breaking on new/unimplemented constraints)
    return True


def check_precedence(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    """Enforce precedence: A must occur before B in the given scope.

    If the candidate is the target (B), ensure that for each scope object
    referenced by the candidate there exists a prior event with activity A.
    If candidate is not B, the constraint is irrelevant.
    """
    source = constraint.source_activity
    target = constraint.target_activity

    # Optional cardinality bounds imported from OC-DECLARE
    nmin = getattr(constraint, "nmin", 0)
    nmax = getattr(constraint, "nmax", None)

    # Only relevant when candidate is the target activity
    if candidate.activity_name != target:
        return True

    # For 'each' scope, require that each referenced scope object has seen A earlier.
    # In addition, if the candidate *creates* new scope objects of this type while
    # performing B, this immediately violates precedence, because those new objects
    # would see B as their first event without any prior A.
    if constraint.scope.kind == "each":
        scope_object_ids = _get_scope_object_ids_from_candidate(
            candidate, state, constraint.scope.object_type
        )

        # Count how many new objects of the scoped type this candidate will create
        created_scope_count = 0
        for t in getattr(candidate, "object_types_to_create", []) or []:
            if t == constraint.scope.object_type:
                created_scope_count += 1

        # If the candidate neither references nor creates scoped objects, the
        # precedence constraint is irrelevant for this step.
        if not scope_object_ids and created_scope_count == 0:
            return True

        # If the candidate would create scoped objects for which B is the first
        # event, precedence (A before B on each such object) would be violated —
        # UNLESS this candidate is itself the designated lifecycle creator for
        # that scope type (i.e. the scope type appears in object_types_to_create).
        # In that case, being the first event for those objects is correct
        # lifecycle behaviour, not a precedence violation.
        if created_scope_count > 0:
            if constraint.scope.object_type not in (candidate.object_types_to_create or []):
                return False
            # Creator activity: exempt from the creates-guard, fall through to
            # history checks for any already-existing scope objects below.

        # For each existing scope object id, check if there's a prior A and
        # optionally enforce upper/lower bounds on how many A's may exist
        # before B according to (nmin, nmax).
        for scope_object_id in scope_object_ids:
            saw_a = False
            a_count = 0
            for executed_event in state.executed_events:
                if scope_object_id not in executed_event.object_ids:
                    continue
                if executed_event.activity_name == source:
                    saw_a = True
                    a_count += 1

            # At least one A must exist when nmin > 0 (classical precedence
            # usually has nmin >= 1). If we did not see any A, precedence is
            # violated.
            if nmin > 0 and not saw_a:
                return False

            # If an upper bound nmax is specified, disallow B when the number
            # of preceding A occurrences already exceeds that bound.
            if nmax is not None and a_count > nmax:
                return False

        return True

    # Fallback: require at least one prior source event globally
    for executed_event in state.executed_events:
        if executed_event.activity_name == source:
            return True

    return False

    raise ValueError(f"Unknown constraint type: {kind}")


def check_not_precedence(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    """Enforce 'not preceded' constraint: the target (B) must not be preceded
    by the source (A) in the given scope.

    If the candidate is the target activity, ensure that for each scope object
    referenced by the candidate there is NO prior event with activity A. If the
    candidate is not the target, the constraint is irrelevant.
    """
    source = constraint.source_activity
    target = constraint.target_activity

    # Only relevant when candidate is the target activity
    if candidate.activity_name != target:
        return True

    # For 'each' scope, require that each referenced scope object has NOT seen A earlier
    if constraint.scope.kind == "each":
        scope_object_ids = _get_scope_object_ids_from_candidate(candidate, state, constraint.scope.object_type)

        # If candidate does not reference an existing scope object, allow by default
        if not scope_object_ids:
            return True

        for scope_object_id in scope_object_ids:
            for executed_event in state.executed_events:
                if scope_object_id not in executed_event.object_ids:
                    continue
                if executed_event.activity_name == source:
                    # Found a prior source for this scope object -> violation
                    return False

        return True

    # Fallback: global check — disallow if any prior source exists
    for executed_event in state.executed_events:
        if executed_event.activity_name == source:
            return False

    return True


def _last_activity_for_scope_object(state: SimulationState, scope_object_id: str) -> Any:
    """Return the activity name of the most recent executed event that involved
    ``scope_object_id``, or ``None`` if that object has no history yet.

    ``state.executed_events`` is append-ordered, so the last matching event is
    the chronologically most recent one for this object.
    """
    last_activity = None
    for executed_event in state.executed_events:
        if scope_object_id in executed_event.object_ids:
            last_activity = executed_event.activity_name
    return last_activity


def check_chain_precedence(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    """Enforce chain-precedence: B must be *immediately* preceded by A.

    ``chain_precedence(A, B)`` means that for each scope object, the event
    directly before B must be A.  This is the directly-follows (adjacency)
    variant of ``precedence`` and is backward-looking, so it can be enforced
    safely at candidate-generation time without risk of deadlock.

    Only the target activity (B) is constrained.  For every existing scope
    object the candidate references, the most recent prior event must be A.  If
    the candidate would create a fresh scope object (making B that object's
    first event, with no predecessor), the constraint is violated.
    """
    source = constraint.source_activity
    target = constraint.target_activity

    # Only relevant when the candidate is the target activity B.
    if candidate.activity_name != target:
        return True

    if constraint.scope.kind == "each":
        scope_object_ids = _get_scope_object_ids_from_candidate(
            candidate, state, constraint.scope.object_type
        )

        # Count how many new scope-typed objects this candidate would create.
        created_scope_count = 0
        for t in getattr(candidate, "object_types_to_create", []) or []:
            if t == constraint.scope.object_type:
                created_scope_count += 1

        # Not referencing or creating any scope object -> constraint irrelevant.
        if not scope_object_ids and created_scope_count == 0:
            return True

        # A freshly created scope object would have B as its first event, so
        # there is no immediate A predecessor -> violation.
        if created_scope_count > 0:
            return False

        # Every existing scope object's most recent event must be A.
        for scope_object_id in scope_object_ids:
            if _last_activity_for_scope_object(state, scope_object_id) != source:
                return False

        return True

    # Fallback: global adjacency — the most recent event overall must be A.
    if not state.executed_events:
        return False
    return state.executed_events[-1].activity_name == source


def check_chain_response(constraint: Any, candidate: Any, state: SimulationState) -> bool:
    """Enforce chain-response: A must be *immediately* followed by B.

    ``chain_response(A, B)`` means that once A occurs for a scope object, the
    very next event touching that object must be B.  This is the directly-
    follows (adjacency) variant of ``response`` and, unlike plain response, it
    is enforced *eagerly*: while a scope object is "armed" (its most recent
    event was A), any candidate that touches that object but is not B is
    blocked.

    Caveat (documented trade-off): eager enforcement can deadlock if a scope
    object is armed but B cannot be produced as a candidate (e.g. B needs
    another object that does not exist), or if conflicting chain_response rules
    share the same source.  Such situations indicate an inconsistent model and
    are not expected from high-confidence discovered constraints.
    """
    source = constraint.source_activity
    target = constraint.target_activity

    if constraint.scope.kind == "each":
        scope_object_ids = _get_scope_object_ids_from_candidate(
            candidate, state, constraint.scope.object_type
        )

        # If the candidate touches no existing scope object, it cannot violate
        # an outstanding "next must be B" obligation for this constraint.
        if not scope_object_ids:
            return True

        for scope_object_id in scope_object_ids:
            # Object is "armed" when its most recent event was A.
            if _last_activity_for_scope_object(state, scope_object_id) == source:
                # The only activity allowed to touch an armed object next is B.
                if candidate.activity_name != target:
                    return False

        return True

    # Fallback: global adjacency — if the last event overall was A, only B may
    # fire next.
    if state.executed_events:
        last_activity = state.executed_events[-1].activity_name
        if last_activity == source and candidate.activity_name != target:
            return False
    return True


def check_all_constraints(static_model: StaticModel, candidate: Any, state: SimulationState) -> bool:
    for constraint in static_model.constraints:
        if not check_constraint(constraint, candidate, state):
            return False
    return True


def _count_links_for_object(state: SimulationState, object_id: str, other_type: str) -> int:
    """Count links from object_id to runtime objects of `other_type`."""
    count = 0
    for link in state.links:
        if link.source_object_id == object_id:
            target_obj = state.objects.get(link.target_object_id)
            if target_obj and target_obj.object_type == other_type:
                count += 1
        if link.target_object_id == object_id:
            target_obj = state.objects.get(link.source_object_id)
            if target_obj and target_obj.object_type == other_type:
                count += 1
    return count


def check_o2o_rules(static_model: StaticModel, candidate: Any, state: SimulationState) -> bool:
    """Validate object-to-object static rules for the given candidate against runtime state.

    Only `max_links` is enforced at candidate-generation time: it is a hard
    structural cap that must not be exceeded as the simulation runs.

    `min_links` is intentionally NOT enforced here.  It was discovered as a
    global property of complete traces (e.g. "every Transport Document ends up
    linked to at least 1 Container"), not as a precondition that must hold
    *before* an activity fires.  Enforcing it eagerly would block activities
    like Book Vehicles from firing before any Container objects exist, even
    though the Container-TD link is only established later in the process.
    Conformance against min_links should be checked post-hoc on the produced
    event log, not during candidate generation.
    """
    # fast path
    if not static_model.o2o_rules:
        return True

    # map runtime object ids to types
    obj_type_of = {oid: robj.object_type for oid, robj in state.objects.items()}

    # helper: count how many new objects of a given type the candidate will create
    created_counts: dict[str, int] = {}
    for t in getattr(candidate, "object_types_to_create", []) or []:
        created_counts[t] = created_counts.get(t, 0) + 1

    participating_ids = getattr(candidate, "participating_object_ids", []) or []

    for rule in static_model.o2o_rules:
        # Only enforce max_links — see docstring for why min_links is skipped.
        if rule.max_links is None:
            continue

        for oid in participating_ids:
            otype = obj_type_of.get(oid)
            if otype is None:
                continue

            if otype == rule.source_type:
                existing = _count_links_for_object(state, oid, rule.target_type)
                created = created_counts.get(rule.target_type, 0)
                if existing + created > rule.max_links:
                    return False

            if otype == rule.target_type:
                existing = _count_links_for_object(state, oid, rule.source_type)
                created = created_counts.get(rule.source_type, 0)
                if existing + created > rule.max_links:
                    return False

    return True
