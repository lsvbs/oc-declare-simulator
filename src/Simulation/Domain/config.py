from dataclasses import dataclass, field
from datetime import datetime
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
    start_activity_caps:
        Per-activity cap: {activity_name: max_fires}. Activities not present are
        uncapped. Checked independently of max_case_starts.
    """
    start_activity_names: list[str] = field(default_factory=list)
    max_case_starts: Optional[int] = None
    start_activity_caps: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SimulationConfig:
    """
    Global simulation settings that are not part of the static process model.
    """
    max_steps: int = 10_000_000  # safety cap (event count); time is the primary stop driver
    max_sim_time_s: Optional[float] = None
    # Trace-based limit: stop when this many objects have been deactivated (completed their lifecycle)
    max_traces: Optional[int] = None
    # Case-based limit: stop when this many cases (start-activity firings) have completed
    max_cases: Optional[int] = None
    # Wall-clock limit in real seconds. Unlike every other stop condition this
    # one is about the machine, not the model: it bounds how long you are
    # willing to wait, and stops mid-process rather than at a meaningful point.
    # A run cut short by it is a partial run — the event log is still valid, it
    # just ends wherever the clock ran out. None disables it.
    max_runtime_s: Optional[float] = None
    seed: Optional[int] = None
    start_policy: StartPolicy = field(default_factory=StartPolicy)
    selection_weights: dict[str, float] = field(default_factory=dict)
    activity_weights: dict[str, float] = field(default_factory=dict)
    start_timestamp: datetime = field(default_factory=lambda: datetime(2025, 1, 1, 9, 0, 0))
    anchor_object_types: list[str] = field(default_factory=list)