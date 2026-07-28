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
    max_sim_time_s: Optional[float] = None
    # Trace-based limit: stop when this many objects have been deactivated (completed their lifecycle)
    max_traces: Optional[int] = None
    seed: Optional[int] = None
    start_policy: StartPolicy = field(default_factory=StartPolicy)
    selection_weights: dict[str, float] = field(default_factory=dict)
    activity_weights: dict[str, float] = field(default_factory=dict)
    start_timestamp: datetime = field(default_factory=lambda: datetime(2025, 1, 1, 9, 0, 0))
    default_time_delta: timedelta = field(default_factory=lambda: timedelta(hours=1))
    anchor_object_types: list[str] = field(default_factory=list)