from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal, Optional


# Adapters from Models should convert OC-Declare or other notations
# into the static representation defined in this module.
# This module should only contain static information that does not
# change during simulation iterations.


@dataclass(frozen=True)
class Scope:
    kind: Literal["each", "any", "all"]
    object_type: str


@dataclass(frozen=True)
class ObjectBinding:
    object_type: str
    min_count: int = 0
    max_count: int | None = None

    # Static activity effects for this object type:
    # creates=True     -> the activity may create missing runtime objects of this type
    # deactivates=True -> the activity marks participating runtime objects of this type as inactive
    creates: bool = False
    deactivates: bool = False


@dataclass(frozen=True)
class Activity:
    name: str
    bindings: list[ObjectBinding] = field(default_factory=list)


@dataclass(frozen=True)
class ObjectType:
    name: str


@dataclass(frozen=True)
class Constraint:
    """Static representation of a declarative constraint between activities."""

    constraint_type: Literal[
        "precedence",
        "response",
        "not_coexistence",
        "not_precedence",
        "chain_precedence",
        "chain_response",
    ]
    source_activity: str
    target_activity: str
    scope: Scope
    nmin: int = 0
    nmax: int | None = None


@dataclass(frozen=True)
class O2ORule:
    source_type: str
    target_type: str
    min_links: int = 0
    max_links: int | None = None
    bidirectional: bool = True


@dataclass(frozen=True)
class ActivityDuration:
    """Per-activity time distribution parameters.

    Discovered from OCEL logs via OCPA metrics, or set manually in the editor.
    Used by DistributionTimePolicy to sample realistic inter-event durations.

    Sampling distributions
    ----------------------
    dist_type="lognormal" (default) — always positive, right-skewed, good for
        most business process durations.
    dist_type="normal"   — bell curve; clamped to [min_seconds, max_seconds].
    dist_type="exponential" — memoryless; mean_seconds is the only parameter.
    dist_type="fixed"    — always returns mean_seconds (no randomness).

    OCPA reference metrics (seconds)
    ---------------------------------
    These are stored for display / analysis only and do not affect sampling.
    """

    dist_type: str = "lognormal"
    mean_seconds: float = 3600.0
    std_seconds: float = 600.0
    min_seconds: float = 0.0
    max_seconds: float | None = None
    # OCPA reference metrics
    sojourn_mean: float | None = None
    sojourn_std: float | None = None
    waiting_mean: float | None = None
    waiting_std: float | None = None
    sync_mean: float | None = None
    sync_std: float | None = None
    flow_mean: float | None = None
    flow_std: float | None = None
    pooling_mean: float | None = None
    lagging_mean: float | None = None
    sample_count: int = 0


@dataclass(frozen=True)
class StaticModel:
    activities: list[Activity] = field(default_factory=list)
    object_types: list[ObjectType] = field(default_factory=list)
    constraints: list[Constraint] = field(default_factory=list)
    o2o_rules: list[O2ORule] = field(default_factory=list)
    # Object types classified as reusable resources (e.g. Forklift, Truck).
    # Resource objects are never deactivated by the simulation engine and are
    # selected globally rather than by link-preference, because they participate
    # across many unrelated case chains and have no meaningful per-case binding.
    resource_types: list[str] = field(default_factory=list)
    # Per-activity cap on consecutive (back-to-back) firings.
    # e.g. {"pick item": 3} means pick item may fire at most 3 times in a row
    # before some other activity must intervene.  None / missing = no cap.
    max_consecutive: dict[str, int] = field(default_factory=dict)
    # Per-activity time distribution parameters (for DistributionTimePolicy).
    # Keyed by activity name.  Empty dict = use DefaultTimePolicy (fixed delta).
    activity_durations: dict[str, ActivityDuration] = field(default_factory=dict)
    #should these be immutable? switch to tuples later?


model = StaticModel(
    object_types=[
        ObjectType(name="order"),
        ObjectType(name="item"),
        ObjectType(name="customer"),
    ],
    activities=[
        Activity(
            name="Place Order",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1, creates=True),
                ObjectBinding(object_type="customer", min_count=1, max_count=1),
            ],
        ),
        Activity(
            name="Add Item",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1),
                ObjectBinding(object_type="item", min_count=1, max_count=None, creates=True),
            ],
        ),
        Activity(
            name="Confirm Order",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1),
            ],
        ),
        Activity(
            name="Ship Order",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1, deactivates=True),
                ObjectBinding(object_type="item", min_count=1, max_count=None),
            ],
        ),
        Activity(
            name="Cancel Order",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1, deactivates=True),
            ],
        ),
    ],
    constraints=[
        Constraint(
            constraint_type="precedence",
            source_activity="Place Order",
            target_activity="Confirm Order",
            scope=Scope(kind="each", object_type="order"),
        ),
        Constraint(
            constraint_type="precedence",
            source_activity="Place Order",
            target_activity="Cancel Order",
            scope=Scope(kind="each", object_type="order"),
        ),
        Constraint(
            constraint_type="response",
            source_activity="Confirm Order",
            target_activity="Ship Order",
            scope=Scope(kind="each", object_type="order"),
        ),
        Constraint(
            constraint_type="not_coexistence",
            source_activity="Ship Order",
            target_activity="Cancel Order",
            scope=Scope(kind="each", object_type="order"),
        ),
    ],
    o2o_rules=[
        O2ORule(source_type="customer", target_type="order", min_links=0, max_links=None, bidirectional=False),
        O2ORule(source_type="order", target_type="item", min_links=0, max_links=None, bidirectional=False),
    ],
)