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
from Backend.src.ParameterDiscovery import timediscovery as timing_discovery
from Backend.src.ParameterDiscovery import timediscovery as timing_discovery

REFERENCE_NOTEBOOK_SHA256 = "9f75c3ee987fc2f37a4d217ab23a7a75e743558eb71763c7d0a1742a2c114676"

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
def type_counts(log):
    """Count objects by type, including objects without events."""
    return Counter(log["otype"].values())


# Reference notebook cell 14
def discover_service_times(log_path, service_time_mode="p25", anchor_activities=None):
    raw = _read_json(log_path)
    # The discovery module expects dictionaries and object-ID lists.
    objects = {obj["id"]: {"type": obj["type"]} for obj in raw["objects"]}
    timestamps = pd.to_datetime([e["time"] for e in raw["events"]], utc=True, format="ISO8601", errors="raise")
    if timestamps.isna().any():
        raise ValueError("Every event must have a valid timestamp.")
    events = {}
    for event, timestamp in zip(raw["events"], timestamps):
        ids = list(dict.fromkeys(r["objectId"] for r in event.get("relationships") or []))
        if any(oid not in objects for oid in ids):
            raise ValueError(f"Event {event['id']!r} references an unknown object.")
        if event["id"] in events:
            raise ValueError(f"Duplicate event ID: {event['id']!r}")
        events[event["id"]] = {"activity": event["type"], "timestamp": timestamp.to_pydatetime(), "omap": ids}
    discovered = timing_discovery.compute_ocpa_metrics(
        {"events": events, "objects": objects},
        anchor_activities=anchor_activities,
        service_time_mode=service_time_mode,
    )
    # Recover empirical samples for evaluation without modifying timediscovery.py.
    # Means and standard deviations above come directly from that module.
    from collections import defaultdict
    import statistics
    import math
    timelines = defaultdict(list)
    for eid, event in events.items():
        for oid in event["omap"]:
            timelines[oid].append(eid)
    previous, following = defaultdict(list), defaultdict(list)
    for timeline in timelines.values():
        timeline.sort(key=lambda eid: events[eid]["timestamp"])
        for left, right in zip(timeline, timeline[1:]):
            following[left].append(events[right]["timestamp"])
            previous[right].append(events[left]["timestamp"])
    buckets = defaultdict(lambda: {"forward": [], "sojourn": []})
    for eid, event in events.items():
        if not event["activity"] or not event["omap"]:
            continue
        bucket = buckets[event["activity"]]
        ts = event["timestamp"]
        bucket["forward"].extend(max(0.0, (t-ts).total_seconds()) for t in following[eid])
        bucket["sojourn"].append(max(0.0, (ts-max(previous[eid])).total_seconds()) if previous[eid] else 0.0)
    anchors = {a["name"] for a in anchor_activities or [] if a.get("name")}
    result = {}
    for activity, stats in sorted(discovered.items()):
        bucket = buckets[activity]
        direct, sojourn = bucket["forward"], bucket["sojourn"]
        positive = [v for v in sojourn if v > 0]
        if direct and positive:
            use_forward = sorted(direct)[len(direct)//2] <= sorted(positive)[len(positive)//2]
            source, name = (direct, "forward") if use_forward else (positive, "positive_sojourn")
        elif direct:
            source, name = direct, "forward"
        elif positive:
            source, name = positive, "positive_sojourn"
        else:
            source, name = sojourn, "zero_or_empty_sojourn"
        selected = timing_discovery._select_timing_window(source, service_time_mode) if activity not in anchors else []
        if selected:
            if not (math.isclose(statistics.mean(selected), stats["service_mean"], abs_tol=1e-9)
                    and math.isclose(statistics.pstdev(selected), stats["service_std"], abs_tol=1e-9)):
                raise ValueError("Evaluation samples no longer match timediscovery.py; update the sample adapter.")
        result[activity] = {
            "service_mean": stats["service_mean"], "service_std": stats["service_std"],
            "estimation_source": "anchor" if activity in anchors else name,
            "estimation_window": "anchor" if activity in anchors else service_time_mode if source else "no_observations",
            "n_forward_observations": len(direct), "n_sojourn_observations": len(sojourn),
            "n_selected_observations": len(selected), "service_samples_seconds": list(selected),
        }
    return result


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

    # Each log is ordered independently: retain naive wall-clock timestamps,
    # or convert aware timestamps to UTC. Never invent a timezone or mix modes.
    timestamp_mode = None
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

        try:
            timestamp = pd.Timestamp(event.get("time"))
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"Event {eid!r} needs a valid timestamp.") from exc

        if pd.isna(timestamp):
            raise ValueError(f"Event {eid!r} needs a valid timestamp.")

        event_mode = "naive" if timestamp.tzinfo is None else "aware"
        if timestamp_mode is None:
            timestamp_mode = event_mode
        elif event_mode != timestamp_mode:
            raise ValueError(
                f"Event {eid!r}: this log mixes timestamps with and without "
                "timezones. Use a consistent timestamp format or explicitly "
                "localize the naive timestamps before NGD evaluation."
            )

        timestamps.append(
            timestamp if event_mode == "naive" else timestamp.tz_convert("UTC")
        )

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
        "timestamp_mode": timestamp_mode or "empty",
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
        if ar not in {"EF", "EP", "AS", "DF", "DP"}:
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

    # Equal timestamps remain simultaneous. For DF/DP, retain every event
    # at the nearest qualifying timestamp rather than breaking ties by ID.
    n_tied_events = int(timestamps.duplicated(keep=False).sum())

    if n_tied_events:
        print(
            f"Note: {path if not isinstance(path, dict) else 'OCEL log'}\n"
            f"  {n_tied_events} events share a timestamp with another event.\n"
            "  Equal-time events are treated as simultaneous and cannot "
            "fulfil an EF/EP/DF/DP requirement for each other."
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
    """Apply full object scope, temporal rule, then target activity.

    DF/DP must consider intervening events of ANY activity within that scope.
    All events tied at the nearest strictly later/earlier timestamp qualify.
    """
    arc = c["arc_type"]
    if arc not in {"EF", "EP", "AS", "DF", "DP"}:
        raise NotImplementedError(f"Unsupported arc type {arc!r}.")

    target_events = idx["act_events"].get(c["target_activity"], set())
    filters = []
    # For non-direct arcs the activity filter commutes with the other filters.
    # Direct arcs must defer it until AFTER nearest-timestamp selection.
    if arc not in {"DF", "DP"}:
        filters.append(target_events)

    required = set(each_combo) | all_objects
    for oid in required:
        filters.append(idx["obj_events"].get(oid, set()))

    for object_type in any_types:
        source_objects = idx["ev_objs"][eid].get(object_type, set())
        shared_events = set()
        for oid in source_objects:
            shared_events.update(idx["obj_events"].get(oid, set()))
        filters.append(shared_events)

    # Start with the smallest set to avoid scanning the whole log for each
    # scoped activation. With no object scope, directness is global.
    if filters:
        filters.sort(key=len)
        candidates = set(filters[0])
        for event_set in filters[1:]:
            candidates.intersection_update(event_set)
    else:
        candidates = set(idx["ev_time"])

    if arc == "AS":
        return candidates

    timestamp = idx["ev_time"][eid]
    if arc in {"EF", "DF"}:
        candidates = {
            other for other in candidates
            if idx["ev_time"][other] > timestamp
        }
    else:  # EP / DP: normalized source activates; targets must be earlier.
        candidates = {
            other for other in candidates
            if idx["ev_time"][other] < timestamp
        }

    if arc in {"DF", "DP"} and candidates:
        select_time = min if arc == "DF" else max
        nearest = select_time(idx["ev_time"][other] for other in candidates)
        candidates = {
            other for other in candidates
            if idx["ev_time"][other] == nearest
        }

    return candidates & target_events

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
