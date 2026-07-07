"""Data mining for OCEL 2.0 event logs: most common qualifiers, attributes and
attribute values for events and objects.

This is a read-only analysis script. It loads an OCEL 2.0 JSON log (default: the
container logistics log) and reports, separately for *events* and *objects*:

  * Type distribution          -- event types (activities) / object types.
  * Qualifier distribution     -- the `qualifier` on each E2O / O2O relationship.
  * Attribute-name distribution-- how often each attribute `name` appears.
  * Attribute-value frequencies-- the most common `value` for each attribute,
                                  plus a global ranking across all attributes.

The OCEL 2.0 shape it expects (standard ocel2-json):

    {
      "eventTypes":  [{"name": ..., "attributes": [{"name", "type"}, ...]}, ...],
      "objectTypes": [{"name": ..., "attributes": [{"name", "type"}, ...]}, ...],
      "events":  [{"id", "type", "time",
                   "attributes":    [{"name", "value"}, ...],
                   "relationships": [{"objectId", "qualifier"}, ...]}, ...],
      "objects": [{"id", "type",
                   "attributes":    [{"name", "value", "time"}, ...],
                   "relationships": [{"objectId", "qualifier"}, ...]}, ...]
    }

Some logs carry no object-to-object relationships; the script handles missing
sections gracefully and simply reports zero counts.

Usage:
    python3.13 src/Scripts/mine_ocel_attributes.py
    python3.13 src/Scripts/mine_ocel_attributes.py --file path/to/log.json --top 30
    python3.13 src/Scripts/mine_ocel_attributes.py --values-per-attr 15 --output report.json
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

# Default input: the container logistics OCEL 2.0 log shipped with the project.
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_LOG = (
    _PROJECT_ROOT
    / "src"
    / "Simulation"
    / "IO"
    / "input"
    / "eventlog"
    / "container_logistics.json"
)


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #
def load_ocel(filename: str | os.PathLike[str]) -> dict[str, Any]:
    """Load an OCEL 2.0 JSON log from disk.

    Args:
        filename: Path to the OCEL 2.0 JSON file.

    Returns:
        The parsed JSON as a dict with (at least) ``events`` and ``objects`` keys.

    Raises:
        FileNotFoundError: If the file does not exist.
        ValueError: If the top-level JSON is not an object.
    """
    path = Path(filename)
    if not path.exists():
        raise FileNotFoundError(f"OCEL log not found: {path}")

    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)

    if not isinstance(data, dict):
        raise ValueError(
            "Expected a top-level JSON object with 'events'/'objects' keys, "
            f"got {type(data).__name__}."
        )
    return data


# --------------------------------------------------------------------------- #
# Value normalisation
# --------------------------------------------------------------------------- #
def normalize_value(value: Any) -> Any:
    """Return a hashable representation of an attribute value for counting.

    Strings, numbers, booleans and ``None`` are returned unchanged. Lists/dicts
    (rare, but possible) are turned into a compact, stable JSON string so they
    can be used as dictionary keys in a Counter.
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except TypeError:
        return str(value)


def display_value(value: Any, max_len: int) -> str:
    """Render a value for the terminal, collapsing whitespace and truncating."""
    text = "<empty>" if value == "" else str(value)
    text = " ".join(text.split())  # collapse newlines / repeated spaces
    if len(text) > max_len:
        text = text[: max_len - 1] + "…"
    return text


# --------------------------------------------------------------------------- #
# Analysis
# --------------------------------------------------------------------------- #
class EntityStats:
    """Aggregated frequency statistics for one entity kind (events or objects)."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.total = 0
        self.types: Counter[Any] = Counter()
        self.qualifiers: Counter[Any] = Counter()
        self.attribute_names: Counter[Any] = Counter()
        # attribute name -> Counter of its values
        self.values_per_attribute: dict[Any, Counter[Any]] = defaultdict(Counter)
        # global value ranking, keyed by "attribute=value" to keep meaning
        self.global_values: Counter[tuple[Any, Any]] = Counter()
        self.with_attributes = 0
        self.with_relationships = 0

    @property
    def distinct_qualifiers(self) -> int:
        return len(self.qualifiers)

    @property
    def distinct_attributes(self) -> int:
        return len(self.attribute_names)


def analyze_entities(entities: list[dict[str, Any]], kind: str) -> EntityStats:
    """Compute qualifier / attribute / value frequencies for a list of entities.

    Args:
        entities: The ``events`` or ``objects`` list from an OCEL 2.0 log.
        kind: Human-readable label ("events" or "objects") for reporting.

    Returns:
        An :class:`EntityStats` with all aggregated counters.
    """
    stats = EntityStats(kind)
    stats.total = len(entities)

    for entity in entities:
        stats.types[entity.get("type")] += 1

        attributes = entity.get("attributes") or []
        if attributes:
            stats.with_attributes += 1
        for attribute in attributes:
            name = attribute.get("name")
            value = normalize_value(attribute.get("value"))
            stats.attribute_names[name] += 1
            stats.values_per_attribute[name][value] += 1
            stats.global_values[(name, value)] += 1

        relationships = entity.get("relationships") or []
        if relationships:
            stats.with_relationships += 1
        for relationship in relationships:
            stats.qualifiers[relationship.get("qualifier")] += 1

    return stats


# --------------------------------------------------------------------------- #
# Reporting (human-readable)
# --------------------------------------------------------------------------- #
def _pct(count: int, total: int) -> str:
    return f"{(100.0 * count / total):5.1f}%" if total else "  n/a"


def _print_counter(
    title: str,
    counter: Counter[Any],
    total: int,
    top: int,
    *,
    max_len: int = 60,
) -> None:
    print(f"\n  {title}  (distinct: {len(counter)})")
    if not counter:
        print("    (none)")
        return
    width = max((len(display_value(k, max_len)) for k, _ in counter.most_common(top)), default=0)
    for key, count in counter.most_common(top):
        label = display_value(key, max_len).ljust(width)
        print(f"    {label}  {count:>8,}  {_pct(count, total)}")


def print_entity_report(
    stats: EntityStats,
    *,
    top: int,
    values_per_attr: int,
    max_value_len: int,
) -> None:
    """Print a full human-readable report for one entity kind."""
    header = f" {stats.kind.upper()} ".center(78, "=")
    print(f"\n{header}")
    print(
        f"  total {stats.kind}: {stats.total:,}"
        f"  |  with attributes: {stats.with_attributes:,}"
        f"  |  with relationships: {stats.with_relationships:,}"
    )

    total_qualifiers = sum(stats.qualifiers.values())

    _print_counter(f"Top {top} types", stats.types, stats.total, top, max_len=max_value_len)
    _print_counter(
        f"Top {top} qualifiers", stats.qualifiers, total_qualifiers, top, max_len=max_value_len
    )
    # Percentages here are coverage: the share of entities carrying the attribute
    # (each entity has at most one record per attribute name in this log).
    _print_counter(
        f"Top {top} attributes (coverage of {stats.kind})",
        stats.attribute_names,
        stats.total,
        top,
        max_len=max_value_len,
    )

    # Most common value(s) for each of the most common attributes.
    print(f"\n  Most common values per attribute (top {values_per_attr} each)")
    if not stats.attribute_names:
        print("    (none)")
    for attr_name, attr_count in stats.attribute_names.most_common(top):
        values = stats.values_per_attribute[attr_name]
        print(
            f"    • {display_value(attr_name, max_value_len)}"
            f"  (occurrences: {attr_count:,}, distinct values: {len(values):,})"
        )
        for value, count in values.most_common(values_per_attr):
            label = display_value(value, max_value_len)
            print(f"        {label:<{max_value_len}}  {count:>8,}  {_pct(count, attr_count)}")

    # Global value ranking across all attributes (name=value pairs).
    print(f"\n  Top {top} attribute values overall (attribute = value)")
    if not stats.global_values:
        print("    (none)")
    for (attr_name, value), count in stats.global_values.most_common(top):
        label = f"{display_value(attr_name, 30)} = {display_value(value, max_value_len)}"
        print(f"    {label:<{max_value_len + 33}}  {count:>8,}")


# --------------------------------------------------------------------------- #
# Reporting (machine-readable)
# --------------------------------------------------------------------------- #
def stats_to_dict(stats: EntityStats, *, top: int, values_per_attr: int) -> dict[str, Any]:
    """Serialise an :class:`EntityStats` into a JSON-friendly summary dict."""
    return {
        "kind": stats.kind,
        "total": stats.total,
        "with_attributes": stats.with_attributes,
        "with_relationships": stats.with_relationships,
        "types": stats.types.most_common(top),
        "qualifiers": stats.qualifiers.most_common(top),
        "attributes": stats.attribute_names.most_common(top),
        "values_per_attribute": {
            str(name): counter.most_common(values_per_attr)
            for name, counter in sorted(
                stats.values_per_attribute.items(),
                key=lambda kv: stats.attribute_names[kv[0]],
                reverse=True,
            )[:top]
        },
        "global_top_values": [
            {"attribute": name, "value": value, "count": count}
            for (name, value), count in stats.global_values.most_common(top)
        ],
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Mine the most common qualifiers, attributes and attribute "
        "values for events and objects in an OCEL 2.0 log.",
    )
    parser.add_argument(
        "--file",
        "-f",
        default=str(_DEFAULT_LOG),
        help="Path to the OCEL 2.0 JSON log (default: container logistics log).",
    )
    parser.add_argument(
        "--top",
        "-n",
        type=int,
        default=20,
        help="How many entries to show in each ranking (default: 20).",
    )
    parser.add_argument(
        "--values-per-attr",
        type=int,
        default=10,
        help="How many top values to list per attribute (default: 10).",
    )
    parser.add_argument(
        "--max-value-len",
        type=int,
        default=60,
        help="Maximum characters to display for a value before truncating (default: 60).",
    )
    parser.add_argument(
        "--output",
        "-o",
        default=None,
        help="Optional path to also write the full summary as JSON.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    print(f"Loading OCEL log: {args.file}")
    data = load_ocel(args.file)

    events = data.get("events") or []
    objects = data.get("objects") or []
    event_types = data.get("eventTypes") or []
    object_types = data.get("objectTypes") or []

    print(
        f"Loaded {len(events):,} events / {len(objects):,} objects "
        f"({len(event_types):,} event types, {len(object_types):,} object types)."
    )

    event_stats = analyze_entities(events, "events")
    object_stats = analyze_entities(objects, "objects")

    print_entity_report(
        event_stats,
        top=args.top,
        values_per_attr=args.values_per_attr,
        max_value_len=args.max_value_len,
    )
    print_entity_report(
        object_stats,
        top=args.top,
        values_per_attr=args.values_per_attr,
        max_value_len=args.max_value_len,
    )

    if args.output:
        summary = {
            "source_file": os.path.abspath(args.file),
            "events": stats_to_dict(event_stats, top=args.top, values_per_attr=args.values_per_attr),
            "objects": stats_to_dict(object_stats, top=args.top, values_per_attr=args.values_per_attr),
        }
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)
        print(f"\nWrote JSON summary to: {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
