from __future__ import annotations

from src.Simulation.Domain.ir import (
    Activity,
    ObjectType,
    Constraint,
    Scope,
    ObjectBinding,
    StaticModel,
    O2ORule,
)
from src.Simulation.Domain.state import SimulationState, RuntimeObject
from src.Simulation.Domain.config import SimulationConfig, StartPolicy
from src.Simulation.Engine.simulator import Simulator
from datetime import datetime




def print_final_state(state: SimulationState) -> None:
    print("\n=== FINAL STATE ===")
    print(f"Step count: {state.step_count}")

    print("\nObjects:")
    if not state.objects:
        print("  (none)")
    else:
        for object_id, runtime_object in state.objects.items():
            print(
                f"  {object_id}: type={runtime_object.object_type}, status={runtime_object.status}, active={runtime_object.active}"
            )

    print("\nExecuted events:")
    if not state.executed_events:
        print("  (none)")
    else:
        for event in state.executed_events:
            print(f"  {event.event_id}: activity={event.activity_name}, objects={event.participating_object_ids}, timestamp={event.timestamp}")

    print("\nPending obligations:")

from src.Simulation.Models.OCDeclare import import_first_ocdeclare_in_input

    print("   * Negated or existence-negation constraints (e.g., 'not preceded by') are approximated only; full negation semantics are not available.")
    # Load StaticModel from OCDeclare adapter
    static_model = import_first_ocdeclare_in_input()

    state = SimulationState()

    # Create runtime objects with the exact ids the example describes (o1..o12).
    explicit_objects = {
        "o1": "customer",
        "o2": "order",
        "o3": "item",
        "o4": "item",
        "o5": "item",
        "o6": "employee",
        "o7": "employee",
        "o8": "employee",
        "o9": "employee",
        "o10": "order",
        "o11": "item",
        "o12": "item",
    }

    for oid, otype in explicit_objects.items():
        state.objects[oid] = RuntimeObject(object_id=oid, object_type=otype, status=None, active=True)

    # Create O2O links as described (direction follows the static model's source/target types):
    # - order -> customer (o2 -> o1, o10 -> o1)
    state.add_link("o2", "o1")
    state.add_link("o10", "o1")
    # - item -> order (items belong to their orders)
    state.add_link("o3", "o2")
    state.add_link("o4", "o2")
    state.add_link("o5", "o2")
    state.add_link("o11", "o10")
    state.add_link("o12", "o10")
    # - customer -> employee (customer tied to employees)
    state.add_link("o1", "o6")
    state.add_link("o1", "o7")

    # Record the events exactly as specified (timestamps in UTC naive datetimes for clarity)
    # 01.01.2025 10:00 - Place Order (e1): {o1,o2,o3,o4,o5}
    state.record_event("Place Order", ["o1", "o2", "o3", "o4", "o5"], timestamp=datetime(2025, 1, 1, 10, 0))

    # 01.01.2025 13:00 - Confirm Order (e2): {o2,o3,o4,o5,o6,o7}
    state.record_event("Confirm Order", ["o2", "o3", "o4", "o5", "o6", "o7"], timestamp=datetime(2025, 1, 1, 13, 0))

    # Picks (each item picked in separate events, associated with an employee)
    # 01.01.2025 16:00 - Pick Item (e3): {o3,o8}
    state.record_event("Pick Item", ["o3", "o8"], timestamp=datetime(2025, 1, 1, 16, 0))
    # 02.01.2025 09:00 - Pick Item (e4): {o4,o9}
    state.record_event("Pick Item", ["o4", "o9"], timestamp=datetime(2025, 1, 2, 9, 0))
    # 02.01.2025 12:00 - Pick Item (e5): {"o5","o9"}
    state.record_event("Pick Item", ["o5", "o9"], timestamp=datetime(2025, 1, 2, 12, 0))

    # Second order placement and confirm
    # 02.01.2025 16:00 - Place Order (e6): {o1,o10,o11,o12}
    state.record_event("Place Order", ["o1", "o10", "o11", "o12"], timestamp=datetime(2025, 1, 2, 16, 0))
    # 02.01.2025 18:00 - Confirm Order (e7): {o1,o10,o11,o12,o6}
    state.record_event("Confirm Order", ["o1", "o10", "o11", "o12", "o6"], timestamp=datetime(2025, 1, 2, 18, 0))

    # Payment
    # 03.01.2025 12:00 - Process Payment (e8): {o1,o2,o7}
    state.record_event("Process Payment", ["o1", "o2", "o7"], timestamp=datetime(2025, 1, 3, 12, 0))

    # Print the constructed runtime state
    print_final_state(state)

    # Explain representability limits of the current IR/semantics implementation
    print("\nRepresentability notes:")
    print(" - The runtime objects, explicit O2O links, and executed events above capture the scenario's structure.")
    print(" - What is NOT well supported (current engine limitations):")
    print("   * Transitive scope evaluation: semantics checks (precedence/response) operate over directly scoped objects;")
    print("     they do not automatically propagate constraints transitively along O2O relations. For example, a constraint")
    print("     that targets 'items of a customer' via customer->employee->... requires explicit transitive handling which is not implemented.")
    print("   * Complex quantifiers and multi-object patterns: requirements like 'the same three items' or 'exactly N items per order'")
    print("     are not represented natively by the IR; they must be approximated or enforced externally.")
    print("   * Negated or existence-negation constraints (e.g., 'not preceded by') are approximated only; full negation semantics are not available.")
    print("   * Automatic link inference/policy: the engine's automatic link creation is conservative. For precise semantics you should pre-seed the runtime links (as done here) or extend the IR/engine to create links according to richer policies.")


if __name__ == "__main__":
    main()
