from __future__ import annotations

import math
import random as _random  # #19: module-level import
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Protocol, Any, Dict


class TimePolicy(Protocol):
	def next_timestamp(self, state: Any, candidate: Any, config: Any, rng: Any | None = None) -> datetime:
		...


@dataclass
class DefaultTimePolicy:
	"""Minimal default time policy."""

	def next_timestamp(self, state: Any, candidate: Any, config: Any, rng: Any | None = None) -> datetime:
		if getattr(state, "last_generated_timestamp", None) is not None:
			return state.last_generated_timestamp

		timestamps = [e.timestamp for e in getattr(state, "executed_events", []) if getattr(e, "timestamp", None) is not None]
		if timestamps:
			return max(timestamps)

		return config.start_timestamp


def _sample_duration(dur: Any, rng: Any = None, numpy_api: bool | None = None) -> float:
	"""Sample a duration in seconds from an ActivityDuration specification."""
	mean  = float(getattr(dur, "mean_seconds", 3600.0))
	std   = float(getattr(dur, "std_seconds",  600.0))
	lo    = float(getattr(dur, "min_seconds",  0.0))
	hi    = getattr(dur, "max_seconds", None)
	hi_f  = float(hi) if hi is not None else None
	dtype = str(getattr(dur, "dist_type", "lognormal")).lower()

	def _clamp(x: float) -> float:
		x = max(lo, x)
		if hi_f is not None:
			x = min(hi_f, x)
		return x

	if mean <= 0:
		return max(0.0, lo)
	if dtype == "fixed" or std < 1e-9:
		return _clamp(mean)

	if rng is None:
		rng = _random.Random()

	# #20: use pre-computed numpy_api flag when available
	_numpy = numpy_api if numpy_api is not None else hasattr(rng, "lognormal")

	if dtype == "exponential":
		s = float(rng.exponential(scale=mean)) if _numpy else float(rng.expovariate(1.0 / mean))
	elif dtype == "normal":
		s = float(rng.normal(loc=mean, scale=std)) if _numpy else float(rng.normalvariate(mean, std))
	else:  # lognormal (default)
		# #18: use pre-cached log-space params if available on dur object
		mu_log    = getattr(dur, '_mu_log',    None)
		sigma_log = getattr(dur, '_sigma_log', None)
		if mu_log is None or sigma_log is None:
			var = std ** 2
			sigma_log = math.sqrt(math.log(1.0 + var / (mean ** 2)))
			mu_log    = math.log(mean) - 0.5 * sigma_log ** 2
		s = (
			float(rng.lognormal(mean=mu_log, sigma=sigma_log))
			if _numpy
			else float(rng.lognormvariate(mu_log, sigma_log))
		)

	return _clamp(s)


def _sample_waiting(dur: Any, rng: Any = None, numpy_api: bool | None = None) -> float:
	"""Sample a pre-start process waiting time in seconds from ActivityDuration."""
	mean = getattr(dur, "waiting_mean", None)
	std  = getattr(dur, "waiting_std",  None)

	if mean is None or mean <= 0:
		return 0.0

	std_f = float(std) if std is not None else 0.0

	if std_f < 1e-9:
		return float(mean)

	if rng is None:
		rng = _random.Random()

	# #20: use pre-computed numpy_api flag when available
	_numpy = numpy_api if numpy_api is not None else hasattr(rng, "lognormal")
	var = std_f ** 2
	if var <= 0 or mean <= 0:
		return float(mean)
	sigma_log = math.sqrt(math.log(1.0 + var / (mean ** 2)))
	mu_log    = math.log(mean) - 0.5 * sigma_log ** 2
	s = (
		float(rng.lognormal(mean=mu_log, sigma=sigma_log))
		if _numpy
		else float(rng.lognormvariate(mu_log, sigma_log))
	)
	return max(0.0, s)


@dataclass
class DistributionTimePolicy:
    """Time policy that samples realistic durations from per-activity distributions."""

    durations: Dict[str, Any]  # activity_name -> ActivityDuration

    def __post_init__(self):
        # #18: pre-compute lognormal log-space parameters for each activity
        # so _sample_duration doesn't recompute them on every call
        for act_name, dur in (self.durations or {}).items():
            mean = float(getattr(dur, "mean_seconds", 3600.0))
            std  = float(getattr(dur, "std_seconds",  600.0))
            dtype = str(getattr(dur, "dist_type", "lognormal")).lower()
            if dtype == "lognormal" and mean > 0 and std >= 1e-9:
                var = std ** 2
                try:
                    sigma_log = math.sqrt(math.log(1.0 + var / (mean ** 2)))
                    mu_log    = math.log(mean) - 0.5 * sigma_log ** 2
                    object.__setattr__(dur, '_mu_log',    mu_log)    if hasattr(dur, '__dataclass_fields__') else setattr(dur, '_mu_log',    mu_log)
                    object.__setattr__(dur, '_sigma_log', sigma_log) if hasattr(dur, '__dataclass_fields__') else setattr(dur, '_sigma_log', sigma_log)
                except (ValueError, ZeroDivisionError):
                    pass

        # #20: cache numpy API detection once (rng not available here, set lazily)
        self._numpy_api: bool | None = None

    def _get_numpy_api(self, rng: Any) -> bool:
        # #20: cache on first call
        if self._numpy_api is None:
            self._numpy_api = hasattr(rng, "lognormal")
        return self._numpy_api

    def next_timestamp(self, state: Any, candidate: Any, config: Any, rng: Any | None = None) -> datetime:
        base = (
            getattr(state, "last_generated_timestamp", None)
            or (
                max((e.timestamp for e in getattr(state, "executed_events", []) if getattr(e, "timestamp", None) is not None), default=None)
            )
            or config.start_timestamp
        )

        act = getattr(candidate, "activity_name", "")

        dur = self.durations.get(act)
        if dur is None:
            return base

        # #20: pass cached numpy_api flag to avoid hasattr on every sample
        numpy_api = self._get_numpy_api(rng) if rng is not None else None
        seconds = _sample_duration(dur, rng, numpy_api=numpy_api)
        try:
            return base + timedelta(seconds=max(0.0, seconds))
        except OverflowError:
            return base
