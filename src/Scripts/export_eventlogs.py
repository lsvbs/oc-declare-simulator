from __future__ import annotations

from dataclasses import replace
from datetime import datetime
from pathlib import Path

from src.Simulation.Domain.config import SimulationConfig
from src.Simulation.Engine.simulator import Simulator
from src.Simulation.IO.output.OCEL2 import write_ocel2_json
from src.Simulation.Models.OCDeclare import import_first_ocdeclare_in_input


def apply_start_activity_override(static_model, activity_name: str, object_type: str):
    """Bootstrap helper for exports.

    OC-Declare models often require pre-existing objects. For a smoke/export run
    we allow selecting one activity to create the required objects.
    """

    new_activities = []
    for activity in static_model.activities:
        if activity.name != activity_name:
            new_activities.append(activity)
            continue

        new_bindings = []
        for binding in activity.bindings:
            if binding.object_type == object_type:
                new_bindings.append(replace(binding, creates=True))
            else:
                new_bindings.append(binding)

        new_activities.append(replace(activity, bindings=new_bindings))

    return replace(static_model, activities=new_activities)


def run_once(*, out_dir: Path | None = None, log_id: str = "run") -> Path:
    static_model = import_first_ocdeclare_in_input()

    # Default bootstrap used in earlier smoke runs.
    static_model = apply_start_activity_override(
        static_model,
        activity_name="Register Customer Order",
        object_type="Customer Order",
    )

    config = SimulationConfig()
    state = Simulator(static_model, config).run()

    filename = f"{log_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    return write_ocel2_json(state, out_dir=out_dir, filename=filename, log_id=log_id)


def main() -> None:
    out_path = run_once()
    print(f"Wrote OCEL 2.0 JSON to: {out_path}")


if __name__ == "__main__":
    main()
