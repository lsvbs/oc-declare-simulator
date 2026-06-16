from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol, Any, Dict


class TimePolicy(Protocol):
	def next_timestamp(self, state: Any, candidate: Any, config: Any, rng: Any | None = None) -> datetime:
		...


@dataclass
class DefaultTimePolicy:
	"""Minimal default time policy.

	- If there is a previously generated timestamp in state, use that as the base.
	- Else if there are executed events with timestamps, use the latest one.
	- Otherwise start from config.start_timestamp.
	- Advance by config.default_time_delta for each newly generated event after the first.
	"""

	def next_timestamp(self, state: Any, candidate: Any, config: Any, rng: Any | None = None) -> datetime:
		if getattr(state, "last_generated_timestamp", None) is not None:
			return state.last_generated_timestamp + config.default_time_delta

		timestamps = [e.timestamp for e in getattr(state, "executed_events", []) if getattr(e, "timestamp", None) is not None]
		if timestamps:
			return max(timestamps) + config.default_time_delta

		return config.start_timestamp


def _sample_duration(dur: Any, rng: Any = None) -> float:
	"""Sample a duration in seconds from an ActivityDuration specification.

	Works with BOTH Python's ``random.Random`` (methods: lognormvariate,
	normalvariate, expovariate) and numpy ``Generator`` (methods: lognormal,
	normal, exponential). The simulator passes a stdlib ``random.Random``.

	Supports dist_type in {"lognormal", "normal", "exponential", "fixed"}.
	Falls back to mean_seconds when std is zero or parameters are degenerate.
	"""
	import random as _random

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

	# Degenerate / deterministic cases
	if mean <= 0:
		return max(0.0, lo)
	if dtype == "fixed" or std < 1e-9:
		return _clamp(mean)

	if rng is None:
		rng = _random.Random()

	# numpy Generator exposes ``.lognormal``; stdlib Random does not.
	numpy_api = hasattr(rng, "lognormal")

	if dtype == "exponential":
		# numpy uses scale=mean; stdlib uses rate=1/mean
		s = float(rng.exponential(scale=mean)) if numpy_api else float(rng.expovariate(1.0 / mean))
	elif dtype == "normal":
		s = float(rng.normal(loc=mean, scale=std)) if numpy_api else float(rng.normalvariate(mean, std))
	else:  # lognormal (default)
		# Convert empirical mean/std to log-space parameters (method of moments)
		var = std ** 2
		sigma_log = math.sqrt(math.log(1.0 + var / (mean ** 2)))
		mu_log    = math.log(mean) - 0.5 * sigma_log ** 2
		s = (
			float(rng.lognormal(mean=mu_log, sigma=sigma_log))
			if numpy_api
			else float(rng.lognormvariate(mu_log, sigma_log))
		)

	return _clamp(s)


@dataclass
class DistributionTimePolicy:
	"""Time policy that samples realistic durations from per-activity distributions.

	Each activity can have a different distribution type and parameters
	(stored in StaticModel.activity_durations as ActivityDuration objects).
	Activities without an entry fall back to the default fixed-delta behaviour.
	"""

	durations: Dict[str, Any]  # activity_name -> ActivityDuration
	_fallback_delta: timedelta = timedelta(hours=1)

	def next_timestamp(self, state: Any, candidate: Any, config: Any, rng: Any | None = None) -> datetime:
		base = (
			getattr(state, "last_generated_timestamp", None)
			or (
				max((e.timestamp for e in getattr(state, "executed_events", []) if getattr(e, "timestamp", None) is not None), default=None)
			)
			or config.start_timestamp
		)

		dur = self.durations.get(getattr(candidate, "activity_name", ""))
		if dur is None:
			return base + (getattr(config, "default_time_delta", self._fallback_delta))

		seconds = _sample_duration(dur, rng)
		return base + timedelta(seconds=max(0.0, seconds))
