"""Minimal OCEL 2.0-style JSON export utilities.

This exporter writes a single, consistent, sequence-based OCEL-style JSON
structure. It avoids mixing multiple JSON variants in one file.

Notes for compatibility with OCPQ / OCEL 2.0 readers:
- Top-level collections are emitted as lists, not dictionaries.
- Events must carry a `time` field.
- Object attribute entries in OCEL 2.0 are time-dependent records in many
  readers. Since the simulator does not yet model object-attribute change
  history explicitly, we export object `attributes` as an empty list.
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

    # Make timezone-naive datetimes explicit UTC to avoid ambiguous timestamps.
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)

    return ts.isoformat()


def _build_object_type_definitions(state: SimulationState) -> list[dict[str, Any]]:
    object_type_names = sorted({obj.object_type for obj in state.objects.values()})

    return [
        {
            "name": object_type_name,
            "attributes": [
                {"name": "status", "type": "string"},
                {"name": "active", "type": "boolean"},
            ],
        }
        for object_type_name in object_type_names
    ]


def _build_event_type_definitions(state: SimulationState) -> list[dict[str, Any]]:
    event_type_names = sorted({ev.activity_name for ev in state.executed_events})

    return [
        {
            "name": event_type_name,
            "attributes": [],
        }
        for event_type_name in event_type_names
    ]


def _build_objects(state: SimulationState) -> list[dict[str, Any]]:
    """Build OCEL 2.0 objects.

    Important:
    Many OCEL 2.0 readers interpret object attributes as time-stamped value
    assignments. Since the simulator currently stores only the current object
    state and not a full attribute history, we export no object attributes yet.
    """
    objects: list[dict[str, Any]] = []

    for obj_id in sorted(state.objects.keys()):
        obj = state.objects[obj_id]
        objects.append(
            {
                "id": obj_id,
                "type": obj.object_type,
                "attributes": [],
            }
        )

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
) -> dict[str, Any]:
    """Convert a SimulationState into a clean sequence-based OCEL 2.0-style dict."""

    payload: dict[str, Any] = {
        "version": "2.0",
        "ordering": "timestamp",
        "objectTypes": _build_object_type_definitions(state),
        "eventTypes": _build_event_type_definitions(state),
        "objects": _build_objects(state),
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
    )

    file_path = out_path / filename
    file_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=indent),
        encoding="utf-8",
    )
    return file_path