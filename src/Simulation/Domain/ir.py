from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal, Optional, Any


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

    # Attribute guard: object must have this attribute and satisfy the condition.
    # e.g. {"attribute": "status", "op": "==", "value": "ready"}
    # If the object does not have the named attribute, it is excluded (fail-absent).
    # Supported ops: ==, !=, >, <, >=, <=
    guard: dict | None = None

    # Attribute updates applied to participating objects of this type when the
    # activity fires (non-DES: immediately; DES: on completion).
    # Stored as a tuple of dicts to keep the frozen dataclass hashable.
    # e.g. ({"attribute": "quantity", "op": "decrement", "by": 1},)
    # Supported ops: set, increment, decrement
    attribute_updates: tuple = ()


@dataclass(frozen=True)
class Activity:
    name: str
    bindings: list[ObjectBinding] = field(default_factory=list)


@dataclass(frozen=True)
class AttributeDefinition:
    name: str
    type: str = "string"  # "string" | "float" | "integer" | "boolean"


@dataclass(frozen=True)
class ObjectType:
    name: str
    attributes: tuple = ()  # tuple[AttributeDefinition, ...]


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
    resource_types: list[str] = field(default_factory=list)
    # How many instances of each resource type to pre-populate at sim start.
    # Defaults to 1 for any resource type not listed here.
    resource_pool_sizes: dict[str, int] = field(default_factory=dict)
    max_consecutive: dict[str, int] = field(default_factory=dict)
    # Per-object max consecutive: activity may repeat at most N times on the
    # same object ID before another activity must touch that object.
    max_consecutive_per_object: dict[str, int] = field(default_factory=dict)
    activity_durations: dict[str, ActivityDuration] = field(default_factory=dict)
    attribute_defaults: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Activities in this set may NOT run concurrently with themselves across
    # different objects. Default (not in set) = unlimited parallelism.
    # Resource activities are always exempt (they share a pool by design).
    no_parallel_activities: set = field(default_factory=set)
    # Concurrency probabilities: (A, B) -> float in [0, 1].
    # p > 0 means A and B were observed firing concurrently in the log with
    # that frequency.  Stored as a flat dict with "A|||B" keys (both orderings
    # map to the same value) so the frozen dataclass can hold it.
    concurrency_probs: dict[str, float] = field(default_factory=dict)
    # Per-activity constraint index: activity_name -> constraints where that
    # activity is source_activity or target_activity. Built once after parse.
    # Reduces check_all_constraints from O(all_constraints) to O(relevant).
    _constraints_by_activity: dict[str, list] = field(default_factory=dict)

    def constraints_for_activity(self, activity_name: str) -> list:
        """Return only constraints relevant to this activity (O(1) lookup)."""
        idx = object.__getattribute__(self, '_constraints_by_activity')
        if idx:
            return idx.get(activity_name, [])
        # Fallback: return all (index not built yet)
        return object.__getattribute__(self, 'constraints')


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