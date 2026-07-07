from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional


@dataclass(frozen=True)
class StartPolicy:
    """
    Controls how often new cases may be started.
    start_activity_names:
        Activities that are treated as case-starting activities.
    max_case_starts:
        Maximum number of times any start activity may be executed in total.
        None means no explicit limit.
    """
    start_activity_names: list[str] = field(default_factory=list)
    max_case_starts: Optional[int] = None


@dataclass(frozen=True)
class SimulationConfig:
    """
    Global simulation settings that are not part of the static process model.
    """
    max_steps: int = 100
    seed: Optional[int] = None
    start_policy: StartPolicy = field(default_factory=StartPolicy)
    # selection_weights: dict mapping submodel names to relative weights
    selection_weights: dict[str, float] = field(default_factory=dict)
    # optional per-activity weights used to randomly pick among candidates
    activity_weights: dict[str, float] = field(default_factory=dict)
    # default start timestamp for simulated events
    start_timestamp: datetime = field(default_factory=lambda: datetime(2025, 1, 1, 9, 0, 0))
    # default time delta between consecutive simulated events
    default_time_delta: timedelta = field(default_factory=lambda: timedelta(hours=1))
    # object types that act as case anchors (e.g., "Customer Order").
    # These can be used by the engine to control where new cases may start and
    # when new anchor objects may be created.
    anchor_object_types: list[str] = field(default_factory=list)