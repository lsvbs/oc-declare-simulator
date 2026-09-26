"""Numerical definitions ported from evaluationmeasures.ipynb.

The notebook is the reference for formulas, filters, denominators, tie handling,
and undefined results. The UI/API orchestration lives in service.py. No notebook
execution or external notebook file is required at runtime.
"""
import itertools
import json
import math
import statistics
from collections import Counter, defaultdict

import numpy as np
import pandas as pd
from scipy.stats import wasserstein_distance

REFERENCE_NOTEBOOK_SHA256 = "2a02ac8efc15e923a6403d9e1080d9eebf9fc0baf80a215227c63fc60cc44aca"

def _read_json(source):
    if isinstance(source, dict):
        return source
    with open(source, encoding="utf-8") as stream:
        return json.load(stream)


# Reference notebook cell 9
SMOOTHING = 0.5

def load_ocel(path):
    raw = _read_json(path)

    ts = pd.to_datetime(
        [e["time"] for e in raw["events"]],
        utc=True,
        format="ISO8601",
    )

    events = sorted(
        zip(
            (e["id"] for e in raw["events"]),
            (e["type"] for e in raw["events"]),
            ts,
            (
                [r["objectId"] for r in e.get("relationships") or []]
                for e in raw["events"]
            ),
        ),
        key=lambda event: event[2],
    )

    return {
        "events": events,
        "otype": {o["id"]: o["type"] for o in raw["objects"]},
        "raw": raw,
    }

def smoothed_probabilities(cP, cQ, smoothing=SMOOTHING):
    """Align categories and normalize each histogram with additive smoothing."""
    if not np.isfinite(smoothing) or smoothing <= 0:
        raise ValueError("smoothing must be a finite number greater than zero.")

    keys = sorted(set(cP) | set(cQ))
    counts_p = np.array([cP.get(k, 0) for k in keys], dtype=float)
    counts_q = np.array([cQ.get(k, 0) for k in keys], dtype=float)

    for name, counts in (("P", counts_p), ("Q", counts_q)):
        if not np.all(np.isfinite(counts)) or np.any(counts < 0):
            raise ValueError(f"{name} must contain finite, nonnegative counts.")
        if counts.sum() <= 0:
            raise ValueError(
                f"{name} contains no observations; KL divergence is undefined."
            )

    p = counts_p + smoothing
    q = counts_q + smoothing
    p /= p.sum()
    q /= q.sum()

    return keys, p, q

def kl_divergence(cP, cQ, smoothing=SMOOTHING):
    """Return D_KL(P || Q) in bits for additively smoothed distributions."""
    _, p, q = smoothed_probabilities(cP, cQ, smoothing)
    return float(np.sum(p * np.log2(p / q)))


# Reference notebook cell 11
def type_counts(log, basis):
    """
    basis='objects':
        Count objects of each type, including objects without events.

    basis='relations':
        Count event-to-object attachments by object type.
        An event involving five distinct objects of one type contributes five.
        Repeated references to the same object within an event count once,
        regardless of relationship qualifier.
    """
    if basis == "objects":
        return Counter(log["otype"].values())

    if basis != "relations":
        raise ValueError("basis must be 'objects' or 'relations'.")

    counts = Counter()

    for event_id, _, _, object_ids in log["events"]:
        for object_id in set(object_ids):
            if object_id not in log["otype"]:
                raise ValueError(
                    f"Event {event_id!r} references unknown object "
                    f"{object_id!r}."
                )
            counts[log["otype"][object_id]] += 1

    return counts


# Reference notebook cell 14
def discover_service_times(
    log_path,
    service_time_mode="minimum",
    anchor_activities=None,
):
    if service_time_mode not in {"minimum", "p25", "p50"}:
        raise ValueError("service_time_mode must be 'minimum', 'p25', or 'p50'.")

    raw = _read_json(log_path)

    events = raw["events"]
    if not isinstance(events, list):
        raise ValueError("Expected an OCEL 2.0 event list.")

    timestamps = pd.to_datetime(
        [event.get("time") for event in events],
        utc=True,
        format="ISO8601",
        errors="raise",
    )
    if timestamps.isna().any():
        raise ValueError("Every event must have a valid timestamp.")

    known_objects = {obj["id"] for obj in raw["objects"]}
    timelines = defaultdict(list)
    event_objects = []

    for i, event in enumerate(events):
        object_ids = [
            relation["objectId"]
            for relation in event.get("relationships") or []
        ]

        # Count each event-object pair once, ignoring relationship qualifiers.
        object_ids = list(dict.fromkeys(object_ids))
        event_objects.append(object_ids)

        for object_id in object_ids:
            if object_id not in known_objects:
                raise ValueError(
                    f"Event {event['id']!r} references unknown object "
                    f"{object_id!r}."
                )
            timelines[object_id].append(i)

    preceding = defaultdict(list)
    following = defaultdict(list)

    for timeline in timelines.values():
        # Stable sorting preserves input order for equal timestamps.
        timeline.sort(key=lambda i: timestamps[i])

        for previous_i, next_i in zip(timeline, timeline[1:]):
            following[previous_i].append(timestamps[next_i])
            preceding[next_i].append(timestamps[previous_i])

    buckets = defaultdict(lambda: {"forward": [], "sojourn": []})

    for i, event in enumerate(events):
        activity = event.get("type")
        if not activity or not event_objects[i]:
            continue

        complete = timestamps[i]
        bucket = buckets[activity]

        # One forward observation per object that has a subsequent event.
        bucket["forward"].extend(
            max(0.0, (next_time - complete).total_seconds())
            for next_time in following[i]
        )

        # One sojourn observation per event.
        # Match the prototype's zero fallback when no predecessor exists.
        sojourn = (
            max(
                0.0,
                (complete - max(preceding[i])).total_seconds(),
            )
            if preceding[i]
            else 0.0
        )
        bucket["sojourn"].append(sojourn)

    anchors = {
        anchor["name"]: anchor
        for anchor in anchor_activities or []
        if anchor.get("name")
    }

    def summarize(values):
        if not values:
            return {"mean": 0.0, "std": 0.0, "min": 0.0, "max": 0.0}

        return {
            "mean": float(statistics.mean(values)),
            # Prototype uses population std, not sample std.
            "std": float(statistics.pstdev(values)),
            "min": float(min(values)),
            "max": float(max(values)),
        }

    results = {}

    for activity in sorted(set(buckets) | set(anchors)):
        bucket = buckets.get(activity, {"forward": [], "sojourn": []})
        direct = bucket["forward"]
        sojourn = bucket["sojourn"]
        positive_sojourn = [value for value in sojourn if value > 0]

        # Match the prototype's upper-middle observation for even sample sizes.
        if direct and positive_sojourn:
            direct_middle = sorted(direct)[len(direct) // 2]
            sojourn_middle = sorted(positive_sojourn)[len(positive_sojourn) // 2]

            if direct_middle <= sojourn_middle:
                source, source_name = direct, "forward"
            else:
                source, source_name = positive_sojourn, "positive_sojourn"
        elif direct:
            source, source_name = direct, "forward"
        elif positive_sojourn:
            source, source_name = positive_sojourn, "positive_sojourn"
        else:
            source, source_name = sojourn, "zero_or_empty_sojourn"

        selected_count = 0
        selected = []   # Anchors and unavailable estimates have no empirical samples.

        if activity in anchors:
            anchor = anchors[activity]
            sojourn_stats = summarize(sojourn)

            mean = float(anchor.get("mean_seconds", sojourn_stats["mean"]))
            std = float(anchor.get("std_seconds", sojourn_stats["std"]))
            minimum = float(anchor.get("min_seconds", 0.0))
            maximum = anchor.get("max_seconds")
            maximum = float(maximum) if maximum is not None else None

            source_name = "anchor"
            window = "anchor"

        elif source:
            ordered = sorted(source)
            n = len(ordered)

            if service_time_mode == "p25":
                lower = 0
                upper = max(0, math.ceil(0.50 * n) - 1)
            elif service_time_mode == "p50":
                lower = max(0, math.ceil(0.25 * n) - 1)
                upper = max(0, math.ceil(0.75 * n) - 1)
            else:
                lower = 0
                upper = max(0, math.ceil(0.25 * n) - 1)

            selected = ordered[lower:upper + 1]
            stats = summarize(selected)
            selected_count = len(selected)

            mean, std = stats["mean"], stats["std"]
            minimum, maximum = stats["min"], stats["max"]
            window = service_time_mode

        else:
            mean, std, minimum, maximum = 0.0, 0.0, 0.0, None
            window = "no_observations"

        results[activity] = {
            "service_mean": mean,     # Seconds
            "service_std": std,       # Seconds; population standard deviation
            "service_min": minimum,   # Seconds
            "service_max": maximum,   # Seconds
            "estimation_source": source_name,
            "estimation_window": window,
            "n_forward_observations": len(direct),
            "n_sojourn_observations": len(sojourn),
            "n_selected_observations": selected_count,
            "service_samples_seconds": list(selected),
        }

    return results


# Reference notebook cell 16
def calculate_wmape(actual, simulated):
    actual = np.asarray(actual, dtype=float)
    simulated = np.asarray(simulated, dtype=float)

    if not (
        np.all(np.isfinite(actual))
        and np.all(np.isfinite(simulated))
    ):
        raise ValueError("WMAPE requires finite timing estimates.")

    denominator = np.abs(actual).sum()

    if denominator == 0:
        return np.nan

    return float(np.abs(actual - simulated).sum() / denominator)


# Reference notebook cell 18
def load_selected_samples(results, role):
    samples = {}

    for activity, stats in results.items():
        if "service_samples_seconds" not in stats:
            raise KeyError(
                f"{role}, {activity!r}: selected samples are missing. "
                "Update and rerun the service-time discovery cell."
            )

        values = np.asarray(
            stats["service_samples_seconds"], dtype=float
        )

        if (
            values.ndim != 1
            or not np.all(np.isfinite(values))
            or np.any(values < 0)
        ):
            raise ValueError(
                f"{role}, {activity!r}: samples must be a "
                "one-dimensional collection of finite, nonnegative durations."
            )

        samples[activity] = values / 3600.0  # Convert seconds to hours.

    return samples

def weighted_w1(frame):
    """Average per-activity W1, weighted by reference selected-sample counts."""
    if frame.empty:
        return np.nan

    return float(np.average(
        frame["W1_hours"].to_numpy(dtype=float),
        weights=frame["n_input"].to_numpy(dtype=float),
    ))

def selected_sample_coverage(samples, scored_activities, results):
    """Share of available non-anchor selected observations included in scoring."""
    eligible = {
        activity: values
        for activity, values in samples.items()
        if results[activity]["estimation_source"] != "anchor"
    }

    total = sum(len(values) for values in eligible.values())
    scored = sum(
        len(values)
        for activity, values in eligible.items()
        if activity in scored_activities
    )

    return scored / total if total > 0 else np.nan


# Reference notebook cell 20
_NGD_PADDING = object()

def load_ngd_log(path):
    raw = _read_json(path)

    events = raw.get("events")
    objects = raw.get("objects")

    if not isinstance(events, list) or not isinstance(objects, list):
        raise ValueError("Expected OCEL 2.0 'events' and 'objects' lists.")

    object_types = {}

    for obj in objects:
        oid = obj["id"]
        otype = obj["type"]

        if not isinstance(oid, str) or not isinstance(otype, str):
            raise ValueError("Object IDs and types must be strings.")
        if oid in object_types:
            raise ValueError(f"Duplicate object ID: {oid!r}")

        object_types[oid] = otype

    # Validate timezone information rather than silently assuming local time.
    timestamps = []
    seen_event_ids = set()

    for event in events:
        eid = event["id"]
        activity = event["type"]

        if not isinstance(eid, str) or not isinstance(activity, str):
            raise ValueError("Event IDs and activity names must be strings.")
        if eid in seen_event_ids:
            raise ValueError(f"Duplicate event ID: {eid!r}")
        seen_event_ids.add(eid)

        timestamp = pd.Timestamp(event.get("time"))

        if pd.isna(timestamp) or timestamp.tzinfo is None:
            raise ValueError(
                f"Event {eid!r} needs a valid timestamp with a timezone."
            )

        timestamps.append(timestamp.tz_convert("UTC"))

    timelines = defaultdict(list)
    unattached_events = 0
    repeated_attachments = 0

    for event, timestamp in zip(events, timestamps):
        object_ids = [
            relation["objectId"]
            for relation in event.get("relationships") or []
        ]

        # One occurrence of an event per object, regardless of qualifier.
        unique_ids = set(object_ids)
        repeated_attachments += len(object_ids) - len(unique_ids)

        if not unique_ids:
            unattached_events += 1

        for oid in unique_ids:
            if oid not in object_types:
                raise ValueError(
                    f"Event {event['id']!r} references unknown object {oid!r}."
                )

            timelines[oid].append(
                (timestamp, event["id"], event["type"])
            )

    sequences = defaultdict(list)
    tied_timelines = 0

    for oid, timeline in timelines.items():
        timeline.sort(key=lambda item: (item[0], item[1]))

        if any(
            left[0] == right[0]
            for left, right in zip(timeline, timeline[1:])
        ):
            tied_timelines += 1

        sequences[object_types[oid]].append(
            [activity for _, _, activity in timeline]
        )

    return {
        "sequences": dict(sequences),
        "declared_types": set(object_types.values()),
        "unattached_events": unattached_events,
        "unused_objects": len(object_types) - len(timelines),
        "repeated_attachments_removed": repeated_attachments,
        "timelines_with_timestamp_ties": tied_timelines,
    }

def ngd_histogram(log, object_type=None, n=2):
    if not isinstance(n, int) or n < 1:
        raise ValueError("n must be a positive integer.")

    if object_type is None:
        sequences = (
            sequence
            for type_sequences in log["sequences"].values()
            for sequence in type_sequences
        )
    else:
        sequences = iter(log["sequences"].get(object_type, []))

    counts = Counter()
    n_traces = 0

    for sequence in sequences:
        padded = (
            [_NGD_PADDING] * (n - 1)
            + sequence
            + [_NGD_PADDING] * (n - 1)
        )

        counts.update(
            tuple(padded[i:i + n])
            for i in range(len(padded) - n + 1)
        )
        n_traces += 1

    return counts, n_traces

def relative_ngd(reference, simulated, object_type=None, n=2):
    c_input, traces_input = ngd_histogram(reference, object_type, n)
    c_simulated, traces_simulated = ngd_histogram(simulated, object_type, n)

    total_input = sum(c_input.values())
    total_simulated = sum(c_simulated.values())

    if total_input == 0 and total_simulated == 0:
        distance = np.nan
        status = "No observed traces in either log"
    elif total_input == 0:
        distance = np.nan
        status = "No observed traces in input"
    elif total_simulated == 0:
        distance = np.nan
        status = "No observed traces in simulation"
    else:
        grams = set(c_input) | set(c_simulated)

        distance = 0.5 * sum(
            abs(
                c_input.get(g, 0) / total_input
                - c_simulated.get(g, 0) / total_simulated
            )
            for g in grams
        )
        status = "Compared"

    return {
        "scope": "pooled" if object_type is None else "object_type",
        "object_type": object_type,
        "n": n,
        "traces_input": traces_input,
        "traces_simulated": traces_simulated,
        "ngrams_input": total_input,
        "ngrams_simulated": total_simulated,
        "NGD_relative": distance,
        "status": status,
    }


# Reference notebook cell 23
def load_confidence_model(path):
    model = _read_json(path)

    if model.get("constraint_orientation") != "arc":
        raise ValueError(
            "Expected constraint_orientation='arc'. "
            "Other orientations require explicit conversion."
        )

    constraints = []

    for i, c in enumerate(model["constraints"], start=1):
        ar = str(c["arc_type"]).upper()
        if ar not in {"EF", "EP"}:
            raise NotImplementedError(
                f"Constraint {i}: unsupported arc type {ar!r}."
            )

        bounds = c.get("counts")
        if not isinstance(bounds, list) or len(bounds) != 2:
            raise ValueError(
                f"Constraint {i}: expected counts=[minimum, maximum]."
            )

        lower, upper = bounds
        if type(lower) is not int or lower < 0:
            raise ValueError(
                f"Constraint {i}: minimum must be a nonnegative integer."
            )
        if upper is not None and (
            type(upper) is not int or upper < lower
        ):
            raise ValueError(
                f"Constraint {i}: maximum must be null "
                "or an integer >= minimum."
            )

        inv = c.get("involvement_per_label")
        if not isinstance(inv, dict):
            raise ValueError(
                f"Constraint {i}: involvement_per_label must be a dictionary."
            )

        inv = {label: str(mode).lower() for label, mode in inv.items()}
        for label, mode in inv.items():
            if mode not in {"each", "all", "any"}:
                raise ValueError(
                    f"Constraint {i}: unknown involvement mode {mode!r}."
                )
            if ">" in label or "<" in label:
                raise NotImplementedError(
                    f"Constraint {i}: indirect object label {label!r} "
                    "requires object-to-object relationship handling."
                )

        constraints.append({
            **c,
            "constraint_id": i,
            "arc_type": ar,
            "source_activity": c["from"],
            "target_activity": c["to"],
            "nmin": lower,
            "nmax": np.inf if upper is None else upper,
            "involvement_per_label": inv,
        })

    return {**model, "constraints": constraints}

def build_index(path):
    raw = _read_json(path)
    path = "OCEL data" if isinstance(path, dict) else path

    objects = raw["objects"]
    events = raw["events"]

    otype = {o["id"]: o["type"] for o in objects}
    if len(otype) != len(objects):
        raise ValueError(f"{path}: duplicate object IDs.")

    if len({e["id"] for e in events}) != len(events):
        raise ValueError(f"{path}: duplicate event IDs.")

    timestamps = pd.to_datetime(
        [e["time"] for e in events],
        utc=True,
        format="ISO8601",
        errors="raise",
    )
    if timestamps.isna().any():
        raise ValueError(f"{path}: missing event timestamps.")

    # The paper assumes unique timestamps. Do not invent an order for ties.
    n_tied_events = int(timestamps.duplicated(keep=False).sum())

    if n_tied_events:
        print(
            f"Note: {path}\n"
            f"  {n_tied_events} events share a timestamp with another event.\n"
            "  Equal-time events are treated as simultaneous and cannot "
            "fulfil an EF/EP requirement for each other."
        )

    ev_objs = defaultdict(lambda: defaultdict(set))
    obj_events = defaultdict(set)
    ev_time = {}
    act_events = defaultdict(set)

    for event, timestamp in zip(events, timestamps):
        eid = event["id"]
        ev_time[eid] = timestamp
        act_events[event["type"]].add(eid)

        for relation in event.get("relationships") or []:
            oid = relation["objectId"]
            if oid not in otype:
                raise ValueError(
                    f"{path}: event {eid!r} references unknown object {oid!r}."
                )

            ev_objs[eid][otype[oid]].add(oid)
            obj_events[oid].add(eid)

    return {
        "ev_objs": ev_objs,
        "obj_events": obj_events,
        "ev_time": ev_time,
        "act_events": act_events,
        "n_events": len(events),
    }

def involvement(c):
    inv = c["involvement_per_label"]
    return (
        [label for label, mode in inv.items() if mode == "each"],
        [label for label, mode in inv.items() if mode == "all"],
        [label for label, mode in inv.items() if mode == "any"],
    )

def matching_events(idx, eid, c, each_combo, all_objects, any_types):
    """Return matching target events for one Cartesian Each binding."""
    target = c["target_activity"]
    candidates = set(idx["act_events"].get(target, set()))

    # Every selected Each object and every All object must be present.
    required = set(each_combo) | all_objects
    for oid in required:
        candidates.intersection_update(idx["obj_events"].get(oid, set()))

    # Each Any type requires at least one object shared with the activation.
    for object_type in any_types:
        source_objects = idx["ev_objs"][eid].get(object_type, set())
        candidates = {
            other for other in candidates
            if idx["ev_objs"][other].get(object_type, set()) & source_objects
        }

    timestamp = idx["ev_time"][eid]
    if c["arc_type"] == "EF":
        return {
            other for other in candidates
            if idx["ev_time"][other] > timestamp
        }

    # EP: source still activates, but matching targets must be earlier.
    return {
        other for other in candidates
        if idx["ev_time"][other] < timestamp
    }

def satisfies(idx, eid, c):
    """Check nmin <= matching count <= nmax for EVERY Each binding."""
    each, alls, anys = involvement(c)
    objects = idx["ev_objs"][eid]

    all_objects = set()
    for object_type in alls:
        all_objects.update(objects.get(object_type, set()))

    domains = [
        sorted(objects.get(object_type, set()))
        for object_type in each
    ]

    counts = []

    # With no Each labels, product() yields one empty binding.
    # With an empty Each domain, it yields no bindings: vacuous satisfaction.
    for combo in itertools.product(*domains):
        counts.append(len(
            matching_events(idx, eid, c, combo, all_objects, anys)
        ))

    ok = all(c["nmin"] <= count <= c["nmax"] for count in counts)
    return ok, counts

REPORT_COLUMNS = [
    "constraint_id", "arc", "activates_on", "counts_activity",
    "each", "all", "any", "nmin", "nmax",
    "n_activations", "n_satisfied", "n_violating",
    "n_vacuous_activations", "confidence", "mean_binding_count",
    "model_support",
]

def evaluate_confidence(idx, model):
    rows = []
    violating_events = set()

    for c in model["constraints"]:
        each, alls, anys = involvement(c)
        activations = idx["act_events"].get(c["source_activity"], set())

        satisfied = 0
        vacuous = 0
        binding_counts = []

        for eid in activations:
            ok, counts = satisfies(idx, eid, c)
            satisfied += int(ok)
            vacuous += int(len(counts) == 0)
            binding_counts.extend(counts)

            if not ok:
                violating_events.add(eid)

        n = len(activations)
        rows.append({
            "constraint_id": c["constraint_id"],
            "arc": c["arc_type"],
            "activates_on": c["source_activity"],
            "counts_activity": c["target_activity"],
            "each": ", ".join(each),
            "all": ", ".join(alls),
            "any": ", ".join(anys),
            "nmin": c["nmin"],
            "nmax": c["nmax"],
            "n_activations": n,
            "n_satisfied": satisfied,
            "n_violating": n - satisfied,
            "n_vacuous_activations": vacuous,
            # No activations means undefined confidence, not 100%.
            "confidence": satisfied / n if n else np.nan,
            "mean_binding_count": (
                float(np.mean(binding_counts)) if binding_counts else np.nan
            ),
            "model_support": c.get("support", np.nan),
        })

    table = pd.DataFrame(rows, columns=REPORT_COLUMNS)
    n_events = idx["n_events"]
    n_bad = len(violating_events)

    summary = {
        "n_events": n_events,
        "n_satisfying_events": n_events - n_bad,
        "n_violating_events": n_bad,
        "n_constraints": len(table),
        "n_inactive_constraints": int((table["n_activations"] == 0).sum()),
        "global_confidence": (
            (n_events - n_bad) / n_events if n_events else np.nan
        ),
        # Additional summary; this is NOT Definition 9's global confidence.
        "mean_constraint_confidence": (
            float(table["confidence"].mean())
            if table["confidence"].notna().any() else np.nan
        ),
    }

    return table, summary


# Reference notebook cell 25
INCIDENT_COLUMNS = [
    "constraint_id",
    "arc",
    "activation_activity",
    "counted_activity",
    "event",
    "time",
    "nmin",
    "nmax",
    "n_evaluated_bindings",
    "n_failed_bindings",
    "minimum_observed_count",
    "maximum_observed_count",
]

def constraint_violation_report(idx, normalized_model):
    # Use the same satisfaction semantics as the confidence evaluator.
    per_constraint, confidence_summary = evaluate_confidence(
        idx, normalized_model
    )

    per_constraint = per_constraint.copy()
    denominator = per_constraint["n_activations"].replace(0, np.nan)
    per_constraint["violation_rate"] = (
        per_constraint["n_violating"] / denominator
    )

    incidents = []

    for c in normalized_model["constraints"]:
        activations = idx["act_events"].get(
            c["source_activity"], set()
        )

        for eid in sorted(
            activations,
            key=lambda event_id: (
                idx["ev_time"][event_id],
                str(event_id),
            ),
        ):
            ok, counts = satisfies(idx, eid, c)
            if ok:
                continue

            n_failed = sum(
                not (c["nmin"] <= count <= c["nmax"])
                for count in counts
            )

            # One row per failed event–constraint activation.
            incidents.append({
                "constraint_id": c["constraint_id"],
                "arc": c["arc_type"],
                "activation_activity": c["source_activity"],
                "counted_activity": c["target_activity"],
                "event": eid,
                "time": idx["ev_time"][eid],
                "nmin": c["nmin"],
                "nmax": c["nmax"],
                "n_evaluated_bindings": len(counts),
                "n_failed_bindings": n_failed,
                "minimum_observed_count": min(counts),
                "maximum_observed_count": max(counts),
            })

    incidents = pd.DataFrame(
        incidents,
        columns=INCIDENT_COLUMNS,
    )

    n_activations = int(per_constraint["n_activations"].sum())
    n_violations = int(per_constraint["n_violating"].sum())
    n_events = idx["n_events"]
    n_affected_events = int(incidents["event"].nunique())

    if len(incidents) != n_violations:
        raise RuntimeError(
            "Incident count differs from the confidence evaluator."
        )

    if n_affected_events != confidence_summary["n_violating_events"]:
        raise RuntimeError(
            "Violating-event count differs from the confidence evaluator."
        )

    summary = {
        "n_events": n_events,
        "n_constraints": len(per_constraint),
        "n_inactive_constraints": int(
            (per_constraint["n_activations"] == 0).sum()
        ),
        "n_activations": n_activations,
        "n_violating_activations": n_violations,
        "activation_violation_rate": (
            n_violations / n_activations
            if n_activations else np.nan
        ),
        "n_constraints_affected": int(
            (per_constraint["n_violating"] > 0).sum()
        ),
        "n_events_affected": n_affected_events,
        "event_violation_rate": (
            n_affected_events / n_events
            if n_events else np.nan
        ),
        "n_vacuous_activations": int(
            per_constraint["n_vacuous_activations"].sum()
        ),
    }

    return incidents, per_constraint, summary


# Reference notebook cell 27
def _coverage_fraction(numerator, denominator):
    return numerator / denominator if denominator else np.nan

def _coverage_mean(values):
    finite = [float(v) for v in values if pd.notna(v)]
    return float(np.mean(finite)) if finite else np.nan

def _coverage_index(path):
    # Reuse the corrected index and its input validation.
    idx = build_index(path)

    # The corrected confidence index does not retain all declared objects.
    # Include objects with no events when measuring object-type presence.
    raw = _read_json(path)

    types_present = {obj["type"] for obj in raw["objects"]}
    return idx, types_present

COVERAGE_DETAIL_COLUMNS = [
    "constraint_id",
    "arc",
    "source_activity",
    "target_activity",
    "n_activations",
    "n_nonvacuous_activations",
    "source_activated",
    "nonvacuously_activated",
    "object_presence_coverage",
    "finite_boundary_coverage",
    "matching_event_coverage",
    "nmin",
    "nmax",
    "observed_counts",
]

def model_coverage(idx, types_present, normalized_model):
    model_activities = {
        activity["name"]
        for activity in normalized_model["activities"]
    }
    model_types = {
        object_type["name"]
        for object_type in normalized_model["object_types"]
    }
    log_activities = {
        activity
        for activity, events in idx["act_events"].items()
        if events
    }

    activity_coverage = _coverage_fraction(
        len(model_activities & log_activities),
        len(model_activities),
    )
    object_type_coverage = _coverage_fraction(
        len(model_types & types_present),
        len(model_types),
    )

    rows = []

    for c in normalized_model["constraints"]:
        events = idx["act_events"].get(
            c["source_activity"], set()
        )
        labels = list(c["involvement_per_label"])

        n_full_object_presence = 0
        n_nonvacuous = 0
        observed_counts = set()

        for eid in events:
            objects = idx["ev_objs"][eid]

            # Presence diagnostic only:
            # Each, All, and Any labels are all checked for object presence.
            # With no labels, the presence requirement holds trivially.
            if all(objects.get(label, set()) for label in labels):
                n_full_object_presence += 1

            # Reuse the corrected matching semantics.
            # counts has one entry per evaluated Cartesian Each binding.
            # Empty counts means a vacuous activation due to an empty
            # Each domain. With no Each labels, there is one binding.
            _, counts = satisfies(idx, eid, c)

            if counts:
                n_nonvacuous += 1
                observed_counts.update(counts)

        # Only finite boundaries are observable.
        # A set avoids counting an exact-count bound twice.
        boundaries = {c["nmin"]}
        if np.isfinite(c["nmax"]):
            boundaries.add(c["nmax"])

        boundary_coverage = (
            len(boundaries & observed_counts) / len(boundaries)
            if observed_counts else np.nan
        )

        # Matching-event coverage is interpreted only for constraints
        # requiring at least one matching event. Zero-minimum constraints
        # are excluded because observing a match need not be desirable.
        matching_coverage = (
            float(any(count > 0 for count in observed_counts))
            if c["nmin"] > 0 else np.nan
        )

        rows.append({
            "constraint_id": c["constraint_id"],
            "arc": c["arc_type"],
            "source_activity": c["source_activity"],
            "target_activity": c["target_activity"],
            "n_activations": len(events),
            "n_nonvacuous_activations": n_nonvacuous,
            "source_activated": bool(events),
            "nonvacuously_activated": n_nonvacuous > 0,
            "object_presence_coverage": _coverage_fraction(
                n_full_object_presence, len(events)
            ),
            "finite_boundary_coverage": boundary_coverage,
            "matching_event_coverage": matching_coverage,
            "nmin": c["nmin"],
            "nmax": c["nmax"],
            "observed_counts": sorted(observed_counts),
        })

    details = pd.DataFrame(rows, columns=COVERAGE_DETAIL_COLUMNS)

    scores = {
        # Presence among all declared model activities / object types.
        "Activity coverage": activity_coverage,
        "Object-type coverage": object_type_coverage,

        # Fractions over ALL model constraints, including inactive ones.
        "Source-activation coverage": _coverage_mean(
            details["source_activated"]
        ),
        "Non-vacuous activation coverage": _coverage_mean(
            details["nonvacuously_activated"]
        ),

        # Equal-weight average of per-constraint presence fractions,
        # restricted to constraints with at least one source activation.
        "Object-presence coverage": _coverage_mean(
            details["object_presence_coverage"]
        ),

        # Equal-weight average over constraints with evaluated bindings.
        # Undefined if none were evaluated.
        "Finite-boundary coverage": _coverage_mean(
            details["finite_boundary_coverage"]
        ),

        # Fraction of positive-minimum constraints with at least one
        # observed matching event. Inactive eligible constraints count 0.
        "Matching-event coverage": _coverage_mean(
            details["matching_event_coverage"]
        ),
    }

    return scores, details
