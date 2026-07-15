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
			try:
				return state.last_generated_timestamp + config.default_time_delta
			except OverflowError:
				return state.last_generated_timestamp

		timestamps = [e.timestamp for e in getattr(state, "executed_events", []) if getattr(e, "timestamp", None) is not None]
		if timestamps:
			try:
				return max(timestamps) + config.default_time_delta
			except OverflowError:
				return max(timestamps)

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


def _sample_waiting(dur: Any, rng: Any = None) -> float:
	"""Sample a pre-start process waiting time in seconds from ActivityDuration.

	Uses ``waiting_mean`` and ``waiting_std`` (set by timing discovery).
	Returns 0.0 when no waiting distribution is available.
	"""
	import random as _random

	mean = getattr(dur, "waiting_mean", None)
	std  = getattr(dur, "waiting_std",  None)

	if mean is None or mean <= 0:
		return 0.0

	std_f = float(std) if std is not None else 0.0

	if std_f < 1e-9:
		return float(mean)

	if rng is None:
		rng = _random.Random()

	numpy_api = hasattr(rng, "lognormal")
	var = std_f ** 2
	if var <= 0 or mean <= 0:
		return float(mean)
	sigma_log = math.sqrt(math.log(1.0 + var / (mean ** 2)))
	mu_log    = math.log(mean) - 0.5 * sigma_log ** 2
	s = (
		float(rng.lognormal(mean=mu_log, sigma=sigma_log))
		if numpy_api
		else float(rng.lognormvariate(mu_log, sigma_log))
	)
	return max(0.0, s)


@dataclass
class DistributionTimePolicy:
    """Time policy that samples realistic durations from per-activity distributions.

    Clock compression for concurrent activities
    -------------------------------------------
    When ``concurrency_probs`` is provided and the previous activity and the
    current candidate have a stored concurrency probability above
    ``concurrency_threshold``, the clock is not advanced — the new event is
    assigned the same timestamp as the previous one, modelling the two
    activities as firing simultaneously.

    The probability is used as a Bernoulli draw: with probability p the clock
    stays (concurrent), with probability 1-p it advances normally.
    """

    durations: Dict[str, Any]  # activity_name -> ActivityDuration
    _fallback_delta: timedelta = timedelta(hours=1)
    concurrency_probs: Dict[str, float] = None   # "A|||B" -> float
    concurrency_threshold: float = 0.3           # minimum p to consider concurrent

    def next_timestamp(self, state: Any, candidate: Any, config: Any, rng: Any | None = None) -> datetime:
        import random as _random

        base = (
            getattr(state, "last_generated_timestamp", None)
            or (
                max((e.timestamp for e in getattr(state, "executed_events", []) if getattr(e, "timestamp", None) is not None), default=None)
            )
            or config.start_timestamp
        )

        act = getattr(candidate, "activity_name", "")

        # ── Clock compression check ───────────────────────────────────────────
        if self.concurrency_probs and state.executed_events:
            prev_act = state.executed_events[-1].activity_name
            if prev_act != act:
                key = f"{prev_act}|||{act}"
                p = self.concurrency_probs.get(key, 0.0)
                if p >= self.concurrency_threshold:
                    # Bernoulli draw: fire concurrently with probability p
                    _rng = rng if rng is not None else _random.Random()
                    roll = float(_rng.random()) if hasattr(_rng, "random") else float(_rng.uniform(0, 1))
                    if roll < p:
                        return base  # same timestamp — concurrent

        dur = self.durations.get(act)
        if dur is None:
            return base + (getattr(config, "default_time_delta", self._fallback_delta))

        seconds = _sample_duration(dur, rng)
        try:
            return base + timedelta(seconds=max(0.0, seconds))
        except OverflowError:
            return base
