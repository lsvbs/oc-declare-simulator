from __future__ import annotations

from typing import Any, Iterable, Optional, Callable
import random

from src.Simulation.Domain.ir import StaticModel
from src.Simulation.Domain.state import SimulationState


def _move_seen_activities_to_back(pool: list[Any], state: SimulationState) -> list[Any]:
    """Reorder candidates so that activities that already happened in this run come last.

    This is a small, test-oriented helper: it preserves the original relative order
    of candidates, but groups them such that candidates whose activity has not yet
    appeared in `state.executed_events` are placed first, and candidates for
    activities that already occurred are moved to the back of the list.
    """
    seen = set(state._events_by_activity.keys())
    unseen_candidates: list[Any] = []
    seen_candidates: list[Any] = []

    for c in pool:
        if c.activity_name in seen:
            seen_candidates.append(c)
        else:
            unseen_candidates.append(c)

    return unseen_candidates + seen_candidates


def select_candidate(
    candidates: list[Any],
    state: SimulationState,
    static_model: StaticModel,
    config: Optional[Any] = None,
    rng: Optional[random.Random] = None,
    o2o_filter: Optional[Callable[[Any, SimulationState, StaticModel], bool]] = None,
    declarative_filter: Optional[Callable[[Any, SimulationState, StaticModel, random.Random], bool]] = None,
    transition_matrix: Optional[dict[str, dict[str, float]]] = None,
) -> Any:
    """Selection pipeline with transition-based probability support:

    1. Declarative filter: keep candidates that satisfy (or are accepted by) declarative model.
    2. O2O filter: further filter candidates by object-to-object relationship possibilities.
    3. Obligations: if pending obligations exist, prefer candidates that fulfill them.
    4. Decision:
       - If `transition_matrix` is provided: use transition probabilities P(next | last_activity)
         with two-stage sampling (sample activity, then pick a candidate for that activity).
       - Otherwise: pick first candidate (deterministic).

    The function is modular: pass custom `o2o_filter` and `declarative_filter` for different behaviour.
    
    Parameters:
        transition_matrix: Optional dict mapping last_activity -> {next_activity: probability}.
                          If provided, enables dynamic transition-based selection.
    """
    if not candidates:
        raise ValueError("No candidates to select from")

    if rng is None:
        rng = random.Random(getattr(config, "seed", None))

    # default filters
    def default_o2o_filter(cand: Any, st: SimulationState, sm: StaticModel) -> bool:
        # By default, assume candidates have already been filtered semantically
        # (constraints + O2O) during candidate generation.
        return True

    def default_declarative_filter(cand: Any, st: SimulationState, sm: StaticModel, rng: random.Random) -> bool:
        # declarative filtering already happens at candidate generation; accept all by default
        return True

    o2o_filter = o2o_filter or default_o2o_filter
    declarative_filter = declarative_filter or default_declarative_filter

    # Step 1: declarative
    pool = [c for c in candidates if declarative_filter(c, state, static_model, rng)]
    if not pool:
        pool = candidates

    # Step 2: O2O (optional)
    o2o_pool = [c for c in pool if o2o_filter(c, state, static_model)]
    if o2o_pool:
        pool = o2o_pool

    # Step 3: obligations (DISABLED for probabilistic selection)
    # NOTE: The current obligation tracking is for "response" (eventually-follows) constraints,
    # which should NOT force immediate selection. They should only be tracked until eventually
    # fulfilled. Only "chain_response" (directly-follows) should filter candidates.
    # For now, we disable this filter to allow probabilistic selection based on transition matrix.
    # 
    # TODO: Implement proper distinction between:
    #   - "response" obligations: track but don't filter (eventually fulfilled)
    #   - "chain_response" obligations: must be fulfilled immediately (filter pool)
    #
    # pending = getattr(state, "pending_obligations", [])
    # if pending:
    #     print(f"DEBUG: Found {len(pending)} pending obligations")
    #     fulfilling = []
    #     for c in pool:
    #         for obligation in pending:
    #             if c.activity_name != obligation.target_activity:
    #                 continue
    #             sid = getattr(obligation, "scope_object_id", None)
    #             if sid is None:
    #                 fulfilling.append(c)
    #                 break
    #             if sid in getattr(c, "participating_object_ids", []):
    #                 fulfilling.append(c)
    #                 break
    #     if fulfilling:
    #         print(f"DEBUG: Obligations filter reduced pool to {len(fulfilling)} candidates")
    #         pool = fulfilling
    # else:
    #     print(f"DEBUG: No pending obligations")
    # (obligations filter disabled — response constraints don't force immediate selection)

    # Reorder pool so that already-executed activities are moved to the back.
    pool = _move_seen_activities_to_back(pool, state)

    # Step 4: decision by transition matrix or deterministic first
    if transition_matrix:
        # Direct weighted selection: apply transition probabilities to candidates.
        # 
        # Note: With global candidate generation (_generate_candidates), there is
        # exactly ONE candidate per activity, so we apply transition probabilities
        # directly to each candidate. This treats activities as singular concepts
        # (e.g., "Load Truck" is one activity that processes multiple objects together).
        #
        # The commented-out two-stage approach below was designed for object-centric
        # generation where multiple candidates per activity exist (one per object).
        # That approach would be needed if we want each object-activity pair to compete
        # separately, but conceptually this is wrong: an activity is a singular concept,
        # not multiplied by the number of objects it processes.
        
        # Determine last executed activity
        if state.executed_events:
            last_activity = state.executed_events[-1].activity_name
        else:
            last_activity = "__START__"
        
        # Direct application: get transition probability for each candidate's activity
        transition_probs = transition_matrix.get(last_activity, {})
        weights = [transition_probs.get(c.activity_name, 0.0) for c in pool]
        
        # Add small epsilon smoothing to avoid zero-probability trap
        epsilon = 1e-6
        weights = [w + epsilon for w in weights]
        
        total = sum(weights)
        if total > 0:
            # Use random.choices for proper weighted sampling
            # This is more robust than manual cumulative distribution
            selected = rng.choices(pool, weights=weights, k=1)[0]
            return selected
        
        # Fallback if all weights are zero (shouldn't happen with epsilon)
        return pool[0] if pool else None
        
        # --- COMMENTED OUT: Two-stage selection for object-centric generation ---
        # This approach groups candidates by activity and samples in two stages:
        # 1. Sample an activity according to transition probabilities
        # 2. Pick a candidate uniformly from that activity's pool
        # 
        # Use this if switching to object-centric candidate generation where
        # multiple candidates per activity exist (e.g., "Load Truck with HU_1",
        # "Load Truck with HU_2", etc.). However, this multiplies activity
        # probability by object count, which may not be conceptually correct.
        #
        # from collections import defaultdict
        # activity_to_candidates = defaultdict(list)
        # for c in pool:
        #     activity_to_candidates[c.activity_name].append(c)
        # 
        # activities = list(activity_to_candidates.keys())
        # transition_probs = transition_matrix.get(last_activity, {})
        # weights = [transition_probs.get(act, 0.0) for act in activities]
        # total = sum(weights)
        # epsilon = 1e-6
        # weights = [w + epsilon for w in weights]
        # total = sum(weights)
        # 
        # if total > 0:
        #     r = rng.random() * total
        #     upto = 0.0
        #     chosen_activity = None
        #     for act, w in zip(activities, weights):
        #         upto += w
        #         if r <= upto:
        #             chosen_activity = act
        #             break
        #     
        #     if chosen_activity is None:
        #         chosen_activity = activities[-1]
        #     
        #     return rng.choice(activity_to_candidates[chosen_activity])
        # --- END COMMENTED OUT SECTION ---

    return pool[0]
