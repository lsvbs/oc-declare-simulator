from dataclasses import dataclass, field
from typing import Optional, Any
from datetime import datetime


@dataclass
class RuntimeObject:
    object_id: str
    object_type: str
    status: Optional[str] = None
    active: bool = True
    attributes: dict[str, Any] = field(default_factory=dict)
    # [resource/permanent-object handling — disabled, kept for reference]
    # DES occupancy: set while this resource is held by an in-progress activity
    # busy_until: Optional[datetime] = None
    # busy_by: Optional[str] = None   # activity_name holding this resource
    # Phase 4: full attribute change history for OCEL 2.0 timestamped export
    # Each entry: (timestamp: Optional[datetime], attr_name: str, new_value: Any)
    attribute_history: list = field(default_factory=list)


@dataclass
class InProgressActivity:
    """An activity that has started but not yet completed (DES mode)."""
    candidate_activity_name: str
    participating_object_ids: list[str]
    object_types_to_create: list[str]
    started_at: datetime
    complete_at: datetime          # when this activity finishes
    # [resource/permanent-object handling — disabled, kept for reference]
    # held_resource_ids: list[str]   # resource objects locked for this activity
    created_object_ids: list[str] = field(default_factory=list)

    # Make sortable by complete_at for heapq
    def __lt__(self, other: "InProgressActivity") -> bool:
        return self.complete_at < other.complete_at


# [resource/permanent-object handling — disabled, kept for reference]
# @dataclass
# class WaitingCandidate:
#     """A candidate that could not start because a resource was unavailable."""
#     candidate_activity_name: str
#     participating_object_ids: list[str]
#     object_types_to_create: list[str]
#     arrived_at: datetime           # when it first tried to start
#     blocked_resource_type: str     # which resource type caused the wait


@dataclass
class ObjectLink:
    source_object_id: str
    target_object_id: str


@dataclass
class ExecutedEvent:
    event_id: str
    activity_name: str
    timestamp: Optional[datetime]
    object_ids: list[str] = field(default_factory=list)
    # Phase 3: event-level attributes captured at activity completion
    attributes: dict[str, Any] = field(default_factory=dict)

    @property
    def participating_object_ids(self) -> list[str]:
        """Backward-compatible alias for code that expects the older name."""
        return self.object_ids


@dataclass
class PendingObligation:
    source_activity: str
    target_activity: str
    scope_object_id: Optional[str] = None


@dataclass
class SimulationState:
    step_count: int = 0
    objects: dict[str, RuntimeObject] = field(default_factory=dict)
    links: list[ObjectLink] = field(default_factory=list)
    executed_events: list[ExecutedEvent] = field(default_factory=list)
    pending_obligations: list[PendingObligation] = field(default_factory=list)
    # Fast index for obligation resolution: (target_activity, scope_object_id|None) -> count
    # None key is used for unscoped obligations. Kept in sync with pending_obligations.
    _obligations_count: dict[tuple, int] = field(default_factory=dict)
    next_object_counter: dict[str, int] = field(default_factory=dict)
    next_event_counter: int = 1
    last_generated_timestamp: Optional[datetime] = None

    # ── O(1) lookup indexes (maintained by record_event) ─────────────────────
    # activity_name -> all events with that activity
    _events_by_activity: dict[str, list] = field(default_factory=dict)
    # object_id -> all events involving that object
    _events_by_object: dict[str, list] = field(default_factory=dict)
    # (activity_name, object_id) -> all events with that activity involving that object
    _events_by_act_obj: dict[tuple, list] = field(default_factory=dict)
    # (activity_name, object_id) -> set of event_ids, mirroring _events_by_act_obj.
    # Maintained incrementally in record_event so multi-type constraint checks
    # (semantics._joint_scope_event_ids) can read a prebuilt set in O(1) instead
    # of rebuilding a frozenset over the object's whole event history on every
    # check — that rebuild was the dominant superlinear cost at scale (#24).
    # Read-only for consumers: never mutate the returned set in place.
    _event_ids_by_act_obj: dict[tuple, set] = field(default_factory=dict)
    # object_id -> activity_name of the most recent event involving it
    _last_activity_per_object: dict[str, str] = field(default_factory=dict)
    # count of start-activity events (maintained via start_activity_names set in record_event)
    _start_event_count: int = 0
    # per-activity start-event count: {activity_name: count}
    _start_event_count_by_activity: dict = field(default_factory=dict)
    # set of start activity names — populated once by the simulator before running
    _start_activity_names: set = field(default_factory=set)
    # [resource/permanent-object handling — disabled, kept for reference]
    # set of resource type names — populated once by the simulator before running
    # Left in place (always empty now) rather than removed: many call sites do
    # direct `state._resource_types` attribute access rather than getattr(...).
    _resource_types: set = field(default_factory=set)

    # ── O(1) link index (maintained by add_link) ──────────────────────────────
    # object_id -> set of object_ids it is directly linked to (undirected)
    _links_by_object: dict[str, set] = field(default_factory=dict)

    # ── In-progress index (maintained by _des_start_activity / _des_complete_activity) ──
    # (activity_name, object_id) -> True for every object currently in-progress
    # for that activity. Prevents obligation injection from starting a second
    # concurrent instance before the first has recorded its event.
    _in_progress_objects: set = field(default_factory=set)

    # ── Per-object busy index (#27) ───────────────────────────────────────────
    # Every object_id currently participating in ANY in-progress activity.
    # _in_progress_objects above is keyed (activity_name, object_id), so it only
    # stops the *same* activity restarting on an object; it says nothing about a
    # different activity claiming it. This set enforces that an object takes part
    # in at most one activity instance at a time.
    #
    # Modelling note: OC-Declare has instantaneous events, so this question does
    # not arise in the formalism — it appears only once activities are given a
    # duration. Exclusivity is therefore a simulation assumption, not declarative
    # semantics, and some object types (a Transport Document referenced by two
    # concurrent activities) could legitimately opt out of it.
    _busy_objects: set = field(default_factory=set)

    # ── Per-activity in-progress counter (#26) ────────────────────────────────
    # activity_name -> number of instances currently started but not completed.
    # Maintained alongside _in_progress_objects so the concurrency ceiling can
    # be checked in O(1) instead of scanning the in_progress heap.
    _in_progress_by_activity: dict[str, int] = field(default_factory=dict)

    # ── Next permitted arrival time per activity (#26) ────────────────────────
    # activity_name -> datetime before which the activity may not start again.
    # Only used for activities that have a measured inter-arrival distribution;
    # absent means "no arrival pacing".
    _next_arrival_at: dict = field(default_factory=dict)

    # ── Active-objects-by-type index (maintained by add_object / deactivate) ──
    # object_type -> set of object_ids that are currently active
    _active_by_type: dict[str, set] = field(default_factory=dict)
    # object_id -> object_type (for O(1) type lookup without hitting .objects)
    _type_of_object: dict[str, str] = field(default_factory=dict)

    # ── Consecutive-streak caches (maintained by record_event) ───────────────
    # How many times the most recent global event was the same activity in a row.
    # Reset to 1 when a different activity fires; incremented when same activity fires.
    # activity_name -> current global streak length (only the last-fired activity is non-zero)
    _global_streak: dict[str, int] = field(default_factory=dict)
    # (activity_name, object_id) -> streak of consecutive firings on that object
    _object_streak: dict[tuple, int] = field(default_factory=dict)
    # last activity fired globally (to reset _global_streak on change)
    _last_global_activity: Optional[str] = None

    # activity_name -> timestamp when this activity first appeared in the candidate
    # pool in the current "availability window" (reset each time it fires).
    _candidate_first_seen: dict[str, datetime] = field(default_factory=dict)
    # activity_name -> list of pool-wait durations in seconds (one per firing):
    # how long the activity was eligible (all constraints met, all required objects
    # present) before being chosen.
    candidate_wait_s: dict[str, list[float]] = field(default_factory=dict)
    # activity_name -> list of service durations in seconds (one per firing):
    # the clock advance sampled by the time policy when the activity fired.
    activity_service_s: dict[str, list[float]] = field(default_factory=dict)
    # Per (activity, object_type) service time samples — enables "time per object type per activity" metrics
    activity_service_by_type_s: dict = field(default_factory=dict)  # (act_name, obj_type) -> [float]
    # activity_name -> list of pre-start process waiting durations (DES only)
    process_wait_s: dict[str, list[float]] = field(default_factory=dict)

    # ── DES (Discrete Event Simulation) fields ────────────────────────────────
    # Current simulation clock — advances to the next completion timestamp in DES mode
    current_time: Optional[datetime] = None
    # Min-heap of in-progress activities sorted by complete_at (use heapq)
    in_progress: list = field(default_factory=list)
    # [resource/permanent-object handling — disabled, kept for reference]
    # Activities waiting for a resource to become free. Left in place (always
    # empty now) rather than removed: several call sites read it directly.
    waiting_queue: list = field(default_factory=list)
    # activity_name -> list of resource-wait durations in seconds
    resource_wait_s: dict[str, list[float]] = field(default_factory=dict)
    # Parallelism: number of concurrently in-progress activities sampled at each completion
    parallelism_samples: list[int] = field(default_factory=list)
    # Cumulative counters for iteration log delta tracking
    total_deactivations: int = 0
    total_obligations_fulfilled: int = 0   # target activity actually fired
    total_obligations_cancelled: int = 0   # cleared because scope object deactivated
    total_obligations_violated: int = 0    # cancelled obligations that were unfulfilled (= constraint violations)
    # Per-constraint fulfillment tracking (E3 / S8).
    # Key: (constraint_type, source_activity, target_activity, scope_kind) — matches constraint identity.
    # Value: {"fulfilled": int, "cancelled": int, "violated": int}
    _constraint_obligation_stats: dict = field(default_factory=dict)
    # Maps each active obligation key → constraint identity tuple, so deactivate_object
    # can attribute cancellations to the right constraint without a full scan.
    _obligation_to_constraint: dict = field(default_factory=dict)
    # Multi-type secondary binding info: obligation_key → [(obj_type, inv, frozenset(required_oids))]
    # Only populated for multi-type response obligations; empty for single-type.
    _obligation_bindings: dict = field(default_factory=dict)
    # Running count of deactivated non-resource objects (= completed traces)
    # Maintained in deactivate_object — avoids O(n) scan in _should_stop
    completed_trace_count: int = 0
    # Precedence satisfied cache: set of (source_activity, target_activity, scope_kind, object_id)
    # Once a precedence is permanently satisfied for an object it is never rechecked.
    # Only cached when nmax is None (no upper bound) — nmax constraints can become
    # violated again if the source fires too many times, so they cannot be cached.
    _prec_satisfied: set = field(default_factory=set)
    # Performance: track object types with zero active instances to skip constraint checks
    _inactive_scope_types: set = field(default_factory=set)
    # Performance: typed link index — _linked_by_type[oid][object_type] = set of linked oids of that type
    _linked_by_type: dict = field(default_factory=dict)

    # Phase 1 — Obligation stratification
    # Ready pool: (target_act, scope_oid) → 1 — prerequisites satisfied, inject immediately
    _obligations_ready: dict = field(default_factory=dict)
    # Blocked pool: (blocking_source_act, scope_oid) → set of (target_act, oblg_oid) waiting for it
    _obligations_blocked: dict = field(default_factory=dict)

    # #23 — Incremental candidate pool for the "expand" section of
    # _generate_candidates_des (activities in Simulator._incremental_safe_activities
    # only). (activity_name, primary_object_id) -> Candidate, patched
    # incrementally instead of being rebuilt from scratch every step.
    _candidate_pool: dict = field(default_factory=dict)
    # Reverse index: object_id -> set of pool keys whose candidate currently
    # includes that object as ANY participant (not just the primary). Lets a
    # change to any participant (deactivation, attribute update, or an event
    # firing on it) find and re-verify every pool entry it could affect,
    # without needing to reason about O2O link topology at all.
    _pool_entries_by_participant: dict = field(default_factory=dict)
    # Secondary index: activity_name -> set of primary_object_ids currently
    # pooled for it. Lets _generate_candidates_des emit one activity's pool
    # entries without scanning the whole pool.
    _candidate_pool_keys_by_activity: dict = field(default_factory=dict)
    # Which incremental-safe activities have had their pool entries
    # populated at least once (via a one-time full rescan the first time
    # they become eligible) — everything else for that activity is
    # incremental from then on.
    _pool_initialized_activities: set = field(default_factory=set)
    # Transient per-step accumulators, populated by _des_complete_activity as
    # events complete and consumed (then cleared) by the next
    # _generate_candidates_des call. _step_dirty_objects = participants +
    # created-object-ids of every event completed this step.
    # _step_dirty_types = object types created or attribute-updated this
    # step (drives the new/updated-supply full-rescan trigger).
    _step_dirty_objects: set = field(default_factory=set)
    _step_dirty_types: set = field(default_factory=set)

    def new_object_id(self, object_type: str) -> str:
        current = self.next_object_counter.get(object_type, 0) + 1
        self.next_object_counter[object_type] = current
        return f"{object_type}_{current}"

    def new_event_id(self) -> str:
        event_id = f"e{self.next_event_counter}"
        self.next_event_counter += 1
        return event_id

    def add_object(self, object_type: str, status: Optional[str] = None, attributes: Optional[dict] = None) -> RuntimeObject:
        object_id = self.new_object_id(object_type)
        obj = RuntimeObject(
            object_id=object_id,
            object_type=object_type,
            status=status,
            active=True,
            attributes=dict(attributes) if attributes else {},
        )
        self.objects[object_id] = obj
        self._active_by_type.setdefault(object_type, set()).add(object_id)
        self._type_of_object[object_id] = object_type
        # Object type now has active instances — remove from inactive set
        self._inactive_scope_types.discard(object_type)
        # New object initially eligible for start activities (eligibility index populated by simulator)
        return obj

    def deactivate_object(self, object_id: str) -> None:
        """Mark an object inactive and update the active-by-type index.

        When a non-resource object is deactivated:
        - All pending response obligations scoped to this object are removed
          from _obligations_count (a deactivated object can never fire activities,
          so its obligations can never be fulfilled and should not inflate the pool).
        - Any resource-type neighbors whose only remaining active links are to
          now-inactive objects have those links removed from the runtime index.
          The persistent link log (self.links) is untouched so the OCEL output
          is unchanged.
        """
        obj = self.objects.get(object_id)
        if obj is None:
            return
        obj.active = False
        active_set = self._active_by_type.get(obj.object_type)
        if active_set:
            active_set.discard(object_id)
            # If this was the last active object of this type, mark type as inactive
            if not active_set:
                self._inactive_scope_types.add(obj.object_type)

        # Clear all pending obligations scoped to this object.
        keys_to_remove = []
        for k in self._obligations_count:
            if isinstance(k[1], str) and k[1] == object_id:
                keys_to_remove.append(k)
            elif isinstance(k[1], frozenset) and object_id in k[1]:
                c_key_ob = self._obligation_to_constraint.get(k)
                if c_key_ob and len(c_key_ob) > 3 and c_key_ob[3] == 'any':
                    # any-mode: cancel only when no other active members remain
                    remaining_active = any(
                        oid != object_id and self.objects.get(oid) and self.objects[oid].active
                        for oid in k[1]
                    )
                    if not remaining_active:
                        keys_to_remove.append(k)
                else:
                    # all-mode: cancel immediately — full set can never fire
                    keys_to_remove.append(k)
        for k in keys_to_remove:
            del self._obligations_count[k]
            self._obligations_ready.pop(k, None)
            self._obligation_bindings.pop(k, None)
            # Each cancelled unfulfilled obligation is a constraint violation (S8).
            # Attribute it to the originating constraint via the reverse-lookup dict.
            c_key = self._obligation_to_constraint.pop(k, None)
            if c_key is not None:
                stats = self._constraint_obligation_stats.setdefault(
                    c_key, {"fulfilled": 0, "cancelled": 0, "violated": 0}
                )
                stats["cancelled"] += 1
                stats["violated"] += 1
                self.total_obligations_violated += 1
        self.total_deactivations += 1
        self.total_obligations_cancelled += len(keys_to_remove)
        # Clean up stratified obligation pools (blocked only; ready handled above)
        for k in [k for k in self._obligations_blocked if isinstance(k[1], str) and k[1] == object_id]:
            self._obligations_blocked.pop(k, None)
        # [resource/permanent-object handling — disabled, kept for reference]
        # Increment completed trace count for non-resource objects
        # resource_types: set = getattr(self, '_resource_types', set()) or set()
        # if obj.object_type not in resource_types:
        #     self.completed_trace_count += 1
        # With resource handling disabled, every deactivated object counts as a
        # completed trace (equivalent to the above with resource_types always empty).
        self.completed_trace_count += 1
        # Clear precedence satisfied cache entries for this object
        self._prec_satisfied = {k for k in self._prec_satisfied if k[-1] != object_id}

        # [resource/permanent-object handling — disabled, kept for reference]
        # # Free resource neighbors whose case-object links are all now inactive.
        # resource_types: set = getattr(self, '_resource_types', set()) or set()
        # if obj.object_type in resource_types:
        #     # The deactivated object is itself a resource — nothing extra to do.
        #     return
        #
        # # For each resource neighbor of the deactivated object, remove the
        # # deactivated object from that resource's runtime link set.
        # # Then, if the resource has NO remaining active (non-resource) neighbors,
        # # clear its entire link set so O2O caps reset for the next case.
        # for neighbor_id in list(self._links_by_object.get(object_id, set())):
        #     neighbor = self.objects.get(neighbor_id)
        #     if neighbor is None or neighbor.object_type not in resource_types:
        #         continue
        #     res_links = self._links_by_object.get(neighbor_id)
        #     if res_links:
        #         res_links.discard(object_id)
        #     own_links = self._links_by_object.get(object_id)
        #     if own_links:
        #         own_links.discard(neighbor_id)
        #     if res_links is not None:
        #         remaining_active = any(
        #             self.objects.get(nid) is not None
        #             and self.objects[nid].active
        #             and self.objects[nid].object_type not in resource_types
        #             for nid in res_links
        #         )
        #         if not remaining_active:
        #             res_links.clear()

    def pool_set(self, key: tuple, candidate: Any) -> None:
        """Insert or replace an incremental-candidate-pool entry (#23),
        keeping `_pool_entries_by_participant` and
        `_candidate_pool_keys_by_activity` in sync with the new candidate's
        participants."""
        self.pool_remove(key)
        self._candidate_pool[key] = candidate
        for oid in candidate.participating_object_ids:
            self._pool_entries_by_participant.setdefault(oid, set()).add(key)
        self._candidate_pool_keys_by_activity.setdefault(key[0], set()).add(key[1])

    def pool_remove(self, key: tuple) -> None:
        """Remove an incremental-candidate-pool entry if present, keeping
        `_pool_entries_by_participant` and `_candidate_pool_keys_by_activity`
        in sync (#23)."""
        old = self._candidate_pool.pop(key, None)
        if old is None:
            return
        act_oids = self._candidate_pool_keys_by_activity.get(key[0])
        if act_oids is not None:
            act_oids.discard(key[1])
            if not act_oids:
                del self._candidate_pool_keys_by_activity[key[0]]
        for oid in old.participating_object_ids:
            entries = self._pool_entries_by_participant.get(oid)
            if entries is not None:
                entries.discard(key)
                if not entries:
                    del self._pool_entries_by_participant[oid]

    def add_link(self, source_object_id: str, target_object_id: str) -> None:
        self.links.append(
            ObjectLink(
                source_object_id=source_object_id,
                target_object_id=target_object_id,
            )
        )
        self._links_by_object.setdefault(source_object_id, set()).add(target_object_id)
        self._links_by_object.setdefault(target_object_id, set()).add(source_object_id)
        # Maintain typed link index for O(1) count_links_for_object
        src_type = self._type_of_object.get(source_object_id)
        tgt_type = self._type_of_object.get(target_object_id)
        if src_type and tgt_type:
            self._linked_by_type.setdefault(source_object_id, {}).setdefault(tgt_type, set()).add(target_object_id)
            self._linked_by_type.setdefault(target_object_id, {}).setdefault(src_type, set()).add(source_object_id)

    def record_event(
        self,
        activity_name: str,
        participating_object_ids: list[str],
        timestamp: Optional[datetime] = None,
        attributes: Optional[dict] = None,
    ) -> ExecutedEvent:
        event = ExecutedEvent(
            event_id=self.new_event_id(),
            activity_name=activity_name,
            timestamp=timestamp,
            object_ids=participating_object_ids,
            attributes=dict(attributes) if attributes else {},
        )
        self.executed_events.append(event)
        self.step_count += 1

        # ── Maintain indexes ──────────────────────────────────────────────────
        self._events_by_activity.setdefault(activity_name, []).append(event)

        for oid in participating_object_ids:
            # Capture previous activity before updating — needed for streak reset below
            prev_act_for_oid = self._last_activity_per_object.get(oid)
            self._events_by_object.setdefault(oid, []).append(event)
            self._events_by_act_obj.setdefault((activity_name, oid), []).append(event)
            # #24: keep the event-id set mirror in sync (see field comment)
            self._event_ids_by_act_obj.setdefault((activity_name, oid), set()).add(event.event_id)
            self._last_activity_per_object[oid] = activity_name

            # Per-object streak (#17: inlined, no dict allocation)
            if prev_act_for_oid != activity_name:
                prev_key = (prev_act_for_oid, oid) if prev_act_for_oid else None
                if prev_key and prev_key in self._object_streak:
                    del self._object_streak[prev_key]
            key = (activity_name, oid)
            self._object_streak[key] = self._object_streak.get(key, 0) + 1

        if activity_name in self._start_activity_names:
            self._start_event_count += 1
            self._start_event_count_by_activity[activity_name] = (
                self._start_event_count_by_activity.get(activity_name, 0) + 1
            )

        # ── Global consecutive-streak cache ───────────────────────────────────
        if self._last_global_activity != activity_name:
            self._global_streak.clear()
            self._last_global_activity = activity_name
        self._global_streak[activity_name] = self._global_streak.get(activity_name, 0) + 1

        return event