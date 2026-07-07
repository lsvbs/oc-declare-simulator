from __future__ import annotations

from src.Simulation.Domain.config import SimulationConfig
from src.Simulation.Domain.state import SimulationState, RuntimeObject
from src.Simulation.Engine.candidategeneration import build_candidate_for_activity, Candidate
from src.Simulation.Engine.selection import select_candidate
from src.Simulation.Engine.rng import get_rng

from src.Scripts.smoke import build_paper_static_model


def simple_seeded_test(seed: int | None = 12345) -> None:
    model = build_paper_static_model()
    state = SimulationState()

    # minimal runtime objects so candidate generation has something to attach
    # create one existing order and one existing item and one customer/employee
    state.objects["init_order"] = RuntimeObject(object_id="init_order", object_type="order", status=None, active=True)
    state.objects["init_item"] = RuntimeObject(object_id="init_item", object_type="item", status=None, active=True)
    state.objects["init_customer"] = RuntimeObject(object_id="init_customer", object_type="customer", status=None, active=True)
    state.objects["init_employee"] = RuntimeObject(object_id="init_employee", object_type="employee", status=None, active=True)

    # build candidates for each activity
    candidates: list[Candidate] = []
    for activity in model.activities:
        cand = build_candidate_for_activity(activity, state)
        if cand is not None:
            candidates.append(cand)

    print("Found candidates:")
    for c in candidates:
        print(f" - {c.activity_name}: participating={c.participating_object_ids}, creates={c.object_types_to_create}")

    # set activity weights so selection may use RNG (give some activities positive weights)
    cfg = SimulationConfig(seed=seed, activity_weights={
        "Place Order": 1.0,
        "Confirm Order": 0.5,
        "Pick Item": 0.2,
        "Process Payment": 0.1,
    })

    rng = get_rng(cfg.seed)

    chosen = select_candidate(candidates, state, model, config=cfg, rng=rng)
    print("\nChosen candidate (single run):")
    print(f" -> {chosen.activity_name}: participating={chosen.participating_object_ids}, creates={chosen.object_types_to_create}")

    # Show reproducibility: run selection twice with same seed
    rng1 = get_rng(cfg.seed)
    pick1 = select_candidate(candidates, state, model, config=cfg, rng=rng1)
    rng2 = get_rng(cfg.seed)
    pick2 = select_candidate(candidates, state, model, config=cfg, rng=rng2)

    print("\nReproducibility check (same seed):", pick1.activity_name == pick2.activity_name)

    # If you want variation, change seed
    rng3 = get_rng(99999)
    pick3 = select_candidate(candidates, state, model, config=cfg, rng=rng3)
    print("Different seed yields different pick?", pick3.activity_name != pick1.activity_name)


def main() -> None:
    print("Smoke test: candidate generation + selection")
    simple_seeded_test(seed=42)


if __name__ == "__main__":
    main()
