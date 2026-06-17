from __future__ import annotations

import json
import shutil
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, Optional

from src.Simulation.Domain.ir import (
    StaticModel,
    ObjectType,
    AttributeDefinition,
    Activity,
    ObjectBinding,
    Constraint,
    Scope,
    O2ORule,
    ActivityDuration,
)


IO_INPUT_DIR = Path(__file__).resolve().parents[1] / "IO" / "input" / "ocdeclare"


def ensure_input_dir() -> Path:
    IO_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    return IO_INPUT_DIR


def import_ocdeclare_json(src_path: str, dest_name: Optional[str] = None, lifecycle_mode: str = "none") -> StaticModel:
    """Copy a JSON OC-Declare file into the project's IO/input/ocdeclare folder and parse it.

    Parameters
    - src_path: path to the source JSON file
    - dest_name: optional filename to use in the destination folder; defaults to original name

    Returns
    - StaticModel built from the JSON content.

    The JSON is expected to follow a simple schema (examples below). The adapter is
    tolerant and will substitute reasonable defaults when fields are missing.
    """
    src = Path(src_path)
    if not src.exists():
        raise FileNotFoundError(f"OC-Declare JSON not found: {src}")

    dst_dir = ensure_input_dir()
    dest_name = dest_name or src.name
    dst = dst_dir / dest_name
    try:
        # Avoid copying when src and dst are the same file (can happen when
        # the user passes a path that is already inside the project's IO folder).
        if src.resolve() != dst.resolve():
            shutil.copy2(src, dst)
    except Exception:
        # If copy fails for any reason, proceed to open the destination path
        # (copy is best-effort; parsing will still work if file is accessible).
        pass

    with dst.open("r", encoding="utf-8") as f:
        data = json.load(f)

    # Support both dict-format and list-format OC-Declare files. If the file
    # is a list (arc list), parse with parse_ocdeclare_list and optionally
    # apply the simple lifecycle derivation when requested.
    if isinstance(data, list):
        static_model = parse_ocdeclare_list(data)
        if lifecycle_mode == "simple_arcs":
            lifecycle_info = derive_provisional_lifecycle_from_list(data)
            static_model = apply_lifecycle_from_provisional_info(static_model, lifecycle_info)
        return static_model

    if isinstance(data, dict):
        return parse_ocdeclare_dict(data)

    raise ValueError("Unrecognized OC-Declare JSON structure: expected object or list")


def _opt_float(v) -> Optional[float]:
    """Return float(v) or None when v is None/missing."""
    return None if v is None else float(v)


def _parse_activity_durations(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Parse the activity_durations dict from a model JSON dict."""
    out = {}
    for act_name, d in raw.items():
        if not isinstance(d, dict):
            continue
        out[str(act_name)] = ActivityDuration(
            dist_type=str(d.get("dist_type", "lognormal")),
            mean_seconds=float(d.get("mean_seconds", 3600.0)),
            std_seconds=float(d.get("std_seconds", 600.0)),
            min_seconds=float(d.get("min_seconds", 0.0)),
            max_seconds=_opt_float(d.get("max_seconds")),
            sojourn_mean=_opt_float(d.get("sojourn_mean")),
            sojourn_std=_opt_float(d.get("sojourn_std")),
            waiting_mean=_opt_float(d.get("waiting_mean")),
            waiting_std=_opt_float(d.get("waiting_std")),
            sync_mean=_opt_float(d.get("sync_mean")),
            sync_std=_opt_float(d.get("sync_std")),
            flow_mean=_opt_float(d.get("flow_mean")),
            flow_std=_opt_float(d.get("flow_std")),
            pooling_mean=_opt_float(d.get("pooling_mean")),
            lagging_mean=_opt_float(d.get("lagging_mean")),
            sample_count=int(d.get("sample_count", 0)),
        )
    return out


def parse_ocdeclare_dict(data: Dict[str, Any]) -> StaticModel:
    """Parse a dictionary (loaded from OC-Declare JSON) into a StaticModel.

    Expected JSON structure (lenient):
    {
      "object_types": ["order", "item", "customer"],
      "activities": [
        {"name": "Place Order", "bindings": [{"object_type":"order","min_count":1,"max_count":1,"creates":true}]}
      ],
      "constraints": [
        {"type": "precedence", "source": "Place Order", "target": "Confirm Order", "scope": {"kind":"each","object_type":"order"}}
      ],
      "o2o_rules": [
        {"source_type":"order","target_type":"item","min_links":0,"max_links":null,"bidirectional":false}
      ]
    }
    """
    # Object types
    object_types = []
    # attribute_schema: maps object_type_name -> {attr_name: default_value}
    attribute_schema: Dict[str, Dict[str, Any]] = data.get("attribute_schema") or {}
    for ot in data.get("object_types", []) or []:
        if isinstance(ot, str):
            name = ot
            attr_defs_raw = []
        elif isinstance(ot, dict):
            name = ot.get("name", "")
            attr_defs_raw = ot.get("attributes", [])
        else:
            continue
        attr_defs = tuple(
            AttributeDefinition(name=str(a.get("name", "")), type=str(a.get("type", "string")))
            for a in attr_defs_raw
            if isinstance(a, dict) and a.get("name")
        )
        object_types.append(ObjectType(name=str(name), attributes=attr_defs))

    # Activities
    activities = []
    for a in data.get("activities", []) or []:
        name = a.get("name")
        if not name:
            continue
        bindings = []
        for b in a.get("bindings", []) or []:
            bindings.append(
                ObjectBinding(
                    object_type=str(b.get("object_type")),
                    min_count=int(b.get("min_count", 0)),
                    max_count=(None if b.get("max_count") is None else int(b.get("max_count"))),
                    creates=bool(b.get("creates", False)),
                    # Prefer the canonical "deactivates" key. Fall back to the
                    # legacy "consumes" key so older model files still load.
                    deactivates=bool(b.get("deactivates", b.get("consumes", False))),
                )
            )
        activities.append(Activity(name=name, bindings=bindings))

    # Constraints
    constraints = []
    for c in data.get("constraints", []) or []:
        ctype = c.get("type") or c.get("constraint_type")
        # Accept all key styles: discovered models use source/target (and also
        # carry source_activity/target_activity); the model editor emits only
        # source_activity/target_activity; hand-written arc lists may use a/b.
        source = c.get("source") or c.get("source_activity") or c.get("a")
        target = c.get("target") or c.get("target_activity") or c.get("b")
        scope = c.get("scope") or {}
        scope_kind = scope.get("kind", "each")
        scope_object_type = scope.get("object_type")
        if not ctype or not source or not target:
            continue
        # Cardinality bounds (OC-DECLARE). These give precedence/response their
        # "teeth": a precedence constraint only enforces "A before B" on existing
        # scope objects when nmin >= 1. Discovered models usually omit these keys,
        # so they default to nmin=0 (permissive) for backward compatibility; the
        # model editor emits nmin=1 for manually added precedence constraints.
        nmin_raw = c.get("nmin")
        nmax_raw = c.get("nmax")
        try:
            nmin = int(nmin_raw) if nmin_raw is not None else 0
        except (TypeError, ValueError):
            nmin = 0
        try:
            nmax = int(nmax_raw) if nmax_raw is not None else None
        except (TypeError, ValueError):
            nmax = None
        constraints.append(
            Constraint(
                constraint_type=str(ctype),
                source_activity=str(source),
                target_activity=str(target),
                scope=Scope(kind=str(scope_kind), object_type=str(scope_object_type) if scope_object_type is not None else ""),
                nmin=nmin,
                nmax=nmax,
            )
        )

    # O2O rules
    o2o_rules = []
    for r in data.get("o2o_rules", []) or []:
        o2o_rules.append(
            O2ORule(
                source_type=str(r.get("source_type")),
                target_type=str(r.get("target_type")),
                min_links=int(r.get("min_links", 0)),
                max_links=(None if r.get("max_links") is None else int(r.get("max_links"))),
                bidirectional=bool(r.get("bidirectional", True)),
            )
        )

    return StaticModel(
        activities=activities,
        object_types=object_types,
        constraints=constraints,
        o2o_rules=o2o_rules,
        resource_types=[str(r) for r in data.get("resource_types", []) or []],
        max_consecutive={
            str(k): int(v)
            for k, v in (data.get("max_consecutive") or {}).items()
            if v is not None
        },
        activity_durations=_parse_activity_durations(data.get("activity_durations") or {}),
        attribute_defaults={
            str(k): dict(v)
            for k, v in (data.get("attribute_schema") or {}).items()
            if isinstance(v, dict)
        },
        concurrency_probs={
            str(k): float(v)
            for k, v in (data.get("concurrency_probs") or {}).items()
        },
    )


def derive_provisional_lifecycle_from_list(data: list) -> dict[str, dict[str, set[str]]]:
    """Heuristically derive entry/exit activities per object type from OC-DECLARE arcs.

    This is a *provisional* helper intended for simulation diagnostics only.
    It does **not** change object lifecycles in the engine and can later be
    replaced by a derivation based on an actual OCEL.

    Improved heuristic (per object type ``ot`` and activity ``A``):

      - We classify each arc that mentions ``ot`` in its label as an
        *input* or *output* arc for each endpoint activity using the
        OC-DECLARE direction and arc_type:

          * precedence-like arcs ("EP", "DP"):
              - ``from`` side is an *input* for that activity and ``ot``
              - ``to`` side is an *output* for that activity and ``ot``

          * response-like arcs ("EF", "DF"):
              - ``from`` side is an *output* for that activity and ``ot``
              - ``to`` side is an *input* for that activity and ``ot``

          * other / unknown arc types: both endpoints are treated as having
            both input and output arcs for that type (neutral fallback).

      - Entry activities for ``ot`` are those that have *output* arcs for
        ``ot`` but no *input* arcs for ``ot``.

      - Exit activities for ``ot`` are those that have *input* arcs for
        ``ot`` but no *output* arcs for ``ot``.

    Intuition: for a type like "Transport Document", an activity such as
    "Create Transport Document" that only appears on the output side of
    arcs whose labels mention "Transport Document" but never on the input
    side is treated as an initializer for that type.
    """

    # Per object type, track which activities have input/output arcs.
    input_acts: dict[str, set[str]] = {}
    output_acts: dict[str, set[str]] = {}

    def mark_input(ot: str, act: str) -> None:
        input_acts.setdefault(ot, set()).add(act)

    def mark_output(ot: str, act: str) -> None:
        output_acts.setdefault(ot, set()).add(act)

    for item in data:
        if not isinstance(item, dict):
            continue
        f = item.get("from")
        t = item.get("to")
        arc_type = item.get("arc_type")
        label = item.get("label") or {}

        if not (f or t):
            continue

        for label_type in ("each", "any", "all"):
            for obj in label.get(label_type, []) or []:
                ot = obj.get("object_type")
                if not ot:
                    continue
                ot = str(ot)

                if arc_type in {"EP", "DP"}:  # precedence-like
                    if f:
                        mark_input(ot, str(f))
                    if t:
                        mark_output(ot, str(t))
                elif arc_type in {"EF", "DF"}:  # response-like
                    if f:
                        mark_output(ot, str(f))
                    if t:
                        mark_input(ot, str(t))
                else:
                    # Fallback: if we don't recognize the arc type, treat
                    # both endpoints as having both input and output arcs
                    # for this object type so that they are not classified
                    # as pure entry/exit activities.
                    if f:
                        mark_input(ot, str(f))
                        mark_output(ot, str(f))
                    if t:
                        mark_input(ot, str(t))
                        mark_output(ot, str(t))

    entry_activities: dict[str, set[str]] = {}
    exit_activities: dict[str, set[str]] = {}

    all_object_types = set(input_acts.keys()) | set(output_acts.keys())
    for ot in all_object_types:
        in_set = input_acts.get(ot, set())
        out_set = output_acts.get(ot, set())

        # Entry: activities that only have output arcs for this type.
        entries = out_set - in_set
        # Exit: activities that only have input arcs for this type.
        exits = in_set - out_set

        if entries:
            entry_activities[ot] = entries
        if exits:
            exit_activities[ot] = exits

    return {"entry": entry_activities, "exit": exit_activities}


def apply_lifecycle_from_provisional_info(
    static_model: StaticModel,
    lifecycle_info: dict[str, dict[str, set[str]]],
) -> StaticModel:
    """Apply simple init/exit lifecycle flags to a StaticModel.

    This helper consumes the structure returned by
    ``derive_provisional_lifecycle_from_list`` and turns it into
    ``creates=True`` / ``deactivates=True`` flags on the relevant
    ``ObjectBinding`` instances.

    Contract (per object type ot):
      - If an activity A appears in lifecycle_info["entry"][ot], then
        A is treated as an *initializer* for ot (binding.creates=True).
      - If an activity A appears in lifecycle_info["exit"][ot], then
        A is treated as an *exit* for ot (binding.deactivates=True).

    The logic is deliberately simple and local to object types; it can
    be replaced or extended later (for example, with an OCEL-based
    lifecycle discovery) without changing the rest of the engine.
    """

    entry = lifecycle_info.get("entry", {})
    exit_ = lifecycle_info.get("exit", {})

    new_activities: list[Activity] = []

    for activity in static_model.activities:
        new_bindings: list[ObjectBinding] = []
        for binding in activity.bindings:
            ot = binding.object_type
            creates = binding.creates
            deactivates = getattr(binding, "deactivates", False)

            init_set = entry.get(ot, set())
            exit_set = exit_.get(ot, set())

            if activity.name in init_set:
                creates = True
            if activity.name in exit_set:
                deactivates = True

            new_bindings.append(
                replace(
                    binding,
                    creates=creates,
                    deactivates=deactivates,
                )
            )

        new_activities.append(replace(activity, bindings=new_bindings))

    return replace(static_model, activities=new_activities)


def parse_ocdeclare_list(data: list) -> StaticModel:
    """Parse OC-Declare arcs into StaticModel with constraints and bindings.

    Note: This function intentionally does **not** encode any object creation
    or exit semantics. All bindings are treated as pure inputs (creates=False),
    and lifecycle information should be derived separately (for example via
    `derive_provisional_lifecycle_from_list` or, in the future, from an OCEL
    log that records real object lifetimes).
    """
    from src.Simulation.Domain.ir import ObjectBinding, Constraint, Scope
    # Collect all activity names and object types
    activity_names = set()
    object_types = set()
    # For building up activities and their bindings. We keep at most one
    # ObjectBinding per (activity, object_type) pair; multiple arcs that
    # mention the same pair do NOT create additional bindings.
    activity_bindings: dict[str, dict[str, ObjectBinding]] = {}
    constraints = []

    # Helper: map arc_type to constraint_type
    arc_type_map = {
        "EF": "response",
        "EP": "precedence",
        "AS": "responded_existence",  # not yet implemented
        "DF": "direct_response",      # not yet implemented
        "DP": "direct_precedence",    # not yet implemented
    }

    for item in data:
        if not isinstance(item, dict):
            continue
        f = item.get("from")
        t = item.get("to")
        arc_type = item.get("arc_type")
        counts = item.get("counts", [0, None])
        nmin = counts[0] if len(counts) > 0 else 0
        nmax = counts[1] if len(counts) > 1 else None
        label = item.get("label") or {}

        # Register activities
        if f:
            activity_names.add(str(f))
        if t:
            activity_names.add(str(t))

        # For each label type (each/any/all), add bindings to both activities.
        # We merge bindings per (activity, object_type) so that each such pair
        # appears at most once, regardless of how many arcs reference it.
        for label_type in ("each", "any", "all"):
            for obj in label.get(label_type, []) or []:
                ot = obj.get("object_type")
                if not ot:
                    continue
                ot = str(ot)
                object_types.add(ot)

                def ensure_binding(act_name: str | None) -> None:
                    if not act_name:
                        return
                    per_act = activity_bindings.setdefault(str(act_name), {})
                    if ot in per_act:
                        # Binding for this (activity, object_type) already
                        # exists; do not create a duplicate. If we later want
                        # to reflect more complex per-event multiplicities,
                        # we can adjust min_count/max_count here.
                        return
                    # IMPORTANT: We deliberately do **not** use OC-DECLARE
                    # arc counts (nmin, nmax) for per-event multiplicity
                    # here. Those counts belong to the declarative
                    # constraint over the trace, not to how many objects a
                    # single event uses. For now we require at least one
                    # participating object of the given type per event and
                    # leave max_count unbounded.
                    per_act[ot] = ObjectBinding(
                        object_type=ot,
                        min_count=1,
                        max_count=None,
                        creates=False,
                        deactivates=False,
                    )

                ensure_binding(f)
                ensure_binding(t)

        # Map arc_type to internal constraint_type
        constraint_type = arc_type_map.get(arc_type, arc_type or "unknown")

        # Scope: use first object_type in label.each if present, else ""
        scope_obj_type = ""
        if label.get("each") and len(label["each"]) > 0:
            scope_obj_type = str(label["each"][0].get("object_type", ""))
        scope = Scope(kind="each", object_type=scope_obj_type)

        # OC-DECLARE tuple (ar, s, t, ...) uses `from` = s (constrained/later)
        # and `to` = t (earlier activity that must appear before s).
        # Our engine's `precedence` semantics are "source must appear before target".
        # To align with OC-DECLARE, we therefore *swap* from/to for precedence-like
        # constraints when constructing the internal Constraint:
        #   EP  (precedence)        : every `from` must be preceded by `to`
        #   DP  (direct_precedence) : same, but immediate (not yet implemented here)
        if f and t and constraint_type:
            src = str(f)
            tgt = str(t)

            if constraint_type in {"precedence", "direct_precedence"}:
                # Swap roles so that `to` is the required earlier activity and
                # `from` is the constrained later activity in the engine.
                src, tgt = tgt, src

            constraints.append(Constraint(
                constraint_type=constraint_type,
                source_activity=src,
                target_activity=tgt,
                scope=scope,
                nmin=int(nmin) if nmin is not None else 0,
                nmax=None if nmax is None else int(nmax),
            ))

    # Build activities with bindings (flatten per-activity dicts to lists)
    activities = []
    for n in sorted(activity_names):
        per_act = activity_bindings.get(n, {})
        bindings = list(per_act.values())
        activities.append(Activity(name=n, bindings=bindings))
    object_types_list = [ObjectType(name=n) for n in sorted(object_types)]

    return StaticModel(activities=activities, object_types=object_types_list, constraints=constraints, o2o_rules=[])


def import_first_ocdeclare_in_input(lifecycle_mode: str = "none") -> StaticModel:
    """Find the first JSON in the IO input ocdeclare folder and parse it.

    Preference: if `example1.json` exists, use it; otherwise pick the first JSON file.
    """
    ensure_input_dir()
    files = sorted(IO_INPUT_DIR.glob("*.json"))
    if not files:
        raise FileNotFoundError(f"No OC-Declare JSON files found in {IO_INPUT_DIR}")

    # prefer example1.json when present
    chosen = None
    for f in files:
        if f.name == "example1.json":
            chosen = f
            break
    if chosen is None:
        chosen = files[0]

    with chosen.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    if isinstance(data, list):
        static_model = parse_ocdeclare_list(data)

        # Optional: derive a very simple init/exit lifecycle from the
        # OC-DECLARE arc list and project it onto ObjectBinding
        # creates/deactivates flags. This keeps lifecycle derivation
        # localized and easy to swap out later.
        if lifecycle_mode == "simple_arcs":
            lifecycle_info = derive_provisional_lifecycle_from_list(data)
            static_model = apply_lifecycle_from_provisional_info(static_model, lifecycle_info)

        return static_model
    if isinstance(data, dict):
        return parse_ocdeclare_dict(data)

    raise ValueError("Unrecognized OC-Declare JSON structure: expected object or list")


if __name__ == "__main__":
    # Simple CLI for manual testing
    import sys
    from pprint import pprint
    if len(sys.argv) < 2:
        # No path provided — try to load the first file in the IO input folder
        try:
            sm = import_first_ocdeclare_in_input()
        except FileNotFoundError:
            print("No OC-Declare JSON found in", IO_INPUT_DIR)
            print("Usage: OCDeclare.py PATH_TO_JSON")
            raise SystemExit(1)
    else:
        sm = import_ocdeclare_json(sys.argv[1])
    print("=== Full StaticModel ===")
    pprint(sm)
