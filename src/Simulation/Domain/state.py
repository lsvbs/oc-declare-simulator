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
    # DES occupancy: set while this resource is held by an in-progress activity
    busy_until: Optional[datetime] = None
    busy_by: Optional[str] = None   # activity_name holding this resource


@dataclass
class InProgressActivity:
    """An activity that has started but not yet completed (DES mode)."""
    candidate_activity_name: str
    participating_object_ids: list[str]
    object_types_to_create: list[str]
    started_at: datetime
    complete_at: datetime          # when this activity finishes
    held_resource_ids: list[str]   # resource objects locked for this activity
    created_object_ids: list[str] = field(default_factory=list)

    # Make sortable by complete_at for heapq
    def __lt__(self, other: "InProgressActivity") -> bool:
        return self.complete_at < other.complete_at


@dataclass
class WaitingCandidate:
    """A candidate that could not start because a resource was unavailable."""
    candidate_activity_name: str
    participating_object_ids: list[str]
    object_types_to_create: list[str]
    arrived_at: datetime           # when it first tried to start
    blocked_resource_type: str     # which resource type caused the wait


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
    # object_id -> activity_name of the most recent event involving it
    _last_activity_per_object: dict[str, str] = field(default_factory=dict)
    # count of start-activity events (maintained via start_activity_names set in record_event)
    _start_event_count: int = 0
    # set of start activity names — populated once by the simulator before running
    _start_activity_names: set = field(default_factory=set)
    # set of resource type names — populated once by the simulator before running
    _resource_types: set = field(default_factory=set)

    # ── O(1) link index (maintained by add_link) ──────────────────────────────
    # object_id -> set of object_ids it is directly linked to (undirected)
    _links_by_object: dict[str, set] = field(default_factory=dict)

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
    # activity_name -> list of pre-start process waiting durations (DES only)
    process_wait_s: dict[str, list[float]] = field(default_factory=dict)

    # ── DES (Discrete Event Simulation) fields ────────────────────────────────
    # Current simulation clock — advances to the next completion timestamp in DES mode
    current_time: Optional[datetime] = None
    # Min-heap of in-progress activities sorted by complete_at (use heapq)
    in_progress: list = field(default_factory=list)
    # Activities waiting for a resource to become free
    waiting_queue: list = field(default_factory=list)
    # activity_name -> list of resource-wait durations in seconds
    resource_wait_s: dict[str, list[float]] = field(default_factory=dict)

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

        # Clear all pending obligations scoped to this object.
        # Obligations are keyed as (target_activity, scope_object_id).
        keys_to_remove = [k for k in self._obligations_count if k[1] == object_id]
        for k in keys_to_remove:
            del self._obligations_count[k]

        # Free resource neighbors whose case-object links are all now inactive.
        resource_types: set = getattr(self, '_resource_types', set()) or set()
        if obj.object_type in resource_types:
            # The deactivated object is itself a resource — nothing extra to do.
            return

        # For each resource neighbor of the deactivated object, remove the
        # deactivated object from that resource's runtime link set.
        # Then, if the resource has NO remaining active (non-resource) neighbors,
        # clear its entire link set so O2O caps reset for the next case.
        for neighbor_id in list(self._links_by_object.get(object_id, set())):
            neighbor = self.objects.get(neighbor_id)
            if neighbor is None or neighbor.object_type not in resource_types:
                continue
            res_links = self._links_by_object.get(neighbor_id)
            if res_links:
                res_links.discard(object_id)
            own_links = self._links_by_object.get(object_id)
            if own_links:
                own_links.discard(neighbor_id)
            if res_links is not None:
                remaining_active = any(
                    self.objects.get(nid) is not None
                    and self.objects[nid].active
                    and self.objects[nid].object_type not in resource_types
                    for nid in res_links
                )
                if not remaining_active:
                    res_links.clear()

    def add_link(self, source_object_id: str, target_object_id: str) -> None:
        self.links.append(
            ObjectLink(
                source_object_id=source_object_id,
                target_object_id=target_object_id,
            )
        )
        self._links_by_object.setdefault(source_object_id, set()).add(target_object_id)
        self._links_by_object.setdefault(target_object_id, set()).add(source_object_id)

    def record_event(
        self,
        activity_name: str,
        participating_object_ids: list[str],
        timestamp: Optional[datetime] = None,
    ) -> ExecutedEvent:
        event = ExecutedEvent(
            event_id=self.new_event_id(),
            activity_name=activity_name,
            timestamp=timestamp,
            object_ids=participating_object_ids,
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

        # ── Global consecutive-streak cache ───────────────────────────────────
        if self._last_global_activity != activity_name:
            self._global_streak.clear()
            self._last_global_activity = activity_name
        self._global_streak[activity_name] = self._global_streak.get(activity_name, 0) + 1

        return event