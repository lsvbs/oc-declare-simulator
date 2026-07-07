"""Minimal OCEL 2.0-style JSON export utilities.

This exporter writes a single, consistent, sequence-based OCEL-style JSON
structure. It avoids mixing multiple JSON variants in one file.

Notes for compatibility with OCPQ / OCEL 2.0 readers:
- Top-level collections are emitted as lists, not dictionaries.
- Events must carry a `time` field.
- Object attributes are exported as time-stamped records using the simulation
  start time as the timestamp (attributes are static — initialized once and
  not modified during simulation).
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Optional

from src.Simulation.Domain.state import SimulationState


def _isoformat_or_none(ts: Optional[datetime]) -> Optional[str]:
    if ts is None:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.isoformat()


def _build_object_type_definitions(state: SimulationState, static_model: Any = None) -> list[dict[str, Any]]:
    object_type_names = sorted({obj.object_type for obj in state.objects.values()})

    # Build a lookup from the static model's ObjectType attribute definitions
    attr_def_lookup: dict[str, list] = {}
    if static_model is not None:
        for ot in getattr(static_model, "object_types", []) or []:
            attr_defs = getattr(ot, "attributes", ()) or ()
            if attr_defs:
                attr_def_lookup[ot.name] = [
                    {"name": a.name, "type": a.type} for a in attr_defs
                ]

    result = []
    for ot_name in object_type_names:
        attrs = attr_def_lookup.get(ot_name, [
            {"name": "status", "type": "string"},
            {"name": "active", "type": "boolean"},
        ])
        result.append({"name": ot_name, "attributes": attrs})
    return result


def _build_event_type_definitions(state: SimulationState) -> list[dict[str, Any]]:
    event_type_names = sorted({ev.activity_name for ev in state.executed_events})

    return [
        {
            "name": event_type_name,
            "attributes": [],
        }
        for event_type_name in event_type_names
    ]


def _build_objects(state: SimulationState, ref_timestamp: Optional[datetime] = None) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    ts_str = _isoformat_or_none(ref_timestamp)

    for obj_id in sorted(state.objects.keys()):
        obj = state.objects[obj_id]
        attrs = []
        for attr_name, attr_value in (obj.attributes or {}).items():
            entry: dict[str, Any] = {"name": attr_name, "value": attr_value}
            if ts_str is not None:
                entry["time"] = ts_str
            attrs.append(entry)
        objects.append({
            "id": obj_id,
            "type": obj.object_type,
            "attributes": attrs,
        })

    return objects


def _build_events(
    state: SimulationState,
    *,
    include_null_timestamps: bool = False,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    # Sort deterministically: first by timestamp (None last), then by event id.
    def _event_sort_key(ev: Any) -> tuple[Any, str]:
        ts = _isoformat_or_none(ev.timestamp)
        return (ts is None, ts or "", ev.event_id)

    for ev in sorted(state.executed_events, key=_event_sort_key):
        ts = _isoformat_or_none(ev.timestamp)

        if ts is None and not include_null_timestamps:
            raise ValueError(
                f"Event '{ev.event_id}' has no timestamp. "
                "For OCEL 2.0 export, every event should have a timestamp."
            )

        relationships: list[dict[str, Any]] = []
        for object_id in ev.object_ids:
            rel: dict[str, Any] = {
                "objectId": object_id,
                "qualifier": "",
            }
            relationships.append(rel)

        event_record: dict[str, Any] = {
            "id": ev.event_id,
            "type": ev.activity_name,
            "time": ts if ts is not None else None,
            "relationships": relationships,
            "attributes": [],
        }

        events.append(event_record)

    return events


def _build_object_relations(state: SimulationState) -> list[dict[str, Any]]:
    relations: list[dict[str, Any]] = []

    for link in sorted(
        state.links,
        key=lambda x: (x.source_object_id, x.target_object_id),
    ):
        relations.append(
            {
                "sourceObjectId": link.source_object_id,
                "targetObjectId": link.target_object_id,
                "type": "related",
            }
        )

    return relations


def build_ocel2_dict(
    state: SimulationState,
    *,
    log_id: str = "log",
    include_null_timestamps: bool = False,
    include_debug_metadata: bool = False,
    static_model: Any = None,
) -> dict[str, Any]:
    """Convert a SimulationState into a clean sequence-based OCEL 2.0-style dict."""

    # Use the earliest event timestamp as the reference for attribute time entries.
    ref_ts = next(
        (ev.timestamp for ev in state.executed_events if ev.timestamp is not None),
        None,
    )

    payload: dict[str, Any] = {
        "version": "2.0",
        "ordering": "timestamp",
        "objectTypes": _build_object_type_definitions(state, static_model),
        "eventTypes": _build_event_type_definitions(state),
        "objects": _build_objects(state, ref_ts),
        "events": _build_events(
            state,
            include_null_timestamps=include_null_timestamps,
        ),
        "objectRelations": _build_object_relations(state),
    }

    if include_debug_metadata:
        payload["x-sim"] = {
            "logId": log_id,
            "stepCount": state.step_count,
            "nextEventCounter": state.next_event_counter,
            "nextObjectCounter": dict(state.next_object_counter),
        }

    return payload


def default_eventlogs_dir() -> Path:
    """Return the default eventlogs/ directory (next to this file)."""
    return Path(__file__).resolve().parent / "eventlogs"


def write_ocel2_json(
    state: SimulationState,
    *,
    out_dir: Path | str | None = None,
    filename: str | None = None,
    log_id: str = "log",
    indent: int = 2,
    include_null_timestamps: bool = False,
    include_debug_metadata: bool = False,
    static_model: Any = None,
) -> Path:
    """Write a single OCEL 2.0-style JSON file for this state and return the path."""

    out_path = Path(out_dir) if out_dir is not None else default_eventlogs_dir()
    out_path.mkdir(parents=True, exist_ok=True)

    if filename is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{log_id}_{timestamp}.json"

    payload = build_ocel2_dict(
        state,
        log_id=log_id,
        include_null_timestamps=include_null_timestamps,
        include_debug_metadata=include_debug_metadata,
        static_model=static_model,
    )

    file_path = out_path / filename
    file_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=indent),
        encoding="utf-8",
    )
    return file_path