from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime


@dataclass
class RuntimeObject:
    object_id: str
    object_type: str
    status: Optional[str] = None
    active: bool = True
    # attributes: dict[str, Any] = field(default_factory=dict)  # maybe later


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
    next_object_counter: dict[str, int] = field(default_factory=dict)
    next_event_counter: int = 1
    last_generated_timestamp: Optional[datetime] = None

    def new_object_id(self, object_type: str) -> str:
        current = self.next_object_counter.get(object_type, 0) + 1
        self.next_object_counter[object_type] = current
        return f"{object_type}_{current}"

    def new_event_id(self) -> str:
        event_id = f"e{self.next_event_counter}"
        self.next_event_counter += 1
        return event_id

    def add_object(self, object_type: str, status: Optional[str] = None) -> RuntimeObject:
        object_id = self.new_object_id(object_type)
        obj = RuntimeObject(
            object_id=object_id,
            object_type=object_type,
            status=status,
            active=True,
        )
        self.objects[object_id] = obj
        return obj

    def add_link(self, source_object_id: str, target_object_id: str) -> None:
        self.links.append(
            ObjectLink(
                source_object_id=source_object_id,
                target_object_id=target_object_id,
            )
        )

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
        return event  