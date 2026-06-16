from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Optional


def get_rng(seed: Optional[int]) -> random.Random:
	"""Return a deterministic RNG seeded with `seed` (or an unseeded Random if None).

	This central helper keeps RNG creation in one place. Other modules (Simulator,
	selection) can accept an RNG object (preferred) or call this helper with
	the SimulationConfig.seed.
	"""
	return random.Random(seed)


@dataclass
class RNGProvider:
	"""Simple wrapper around a Random instance to allow sharing/DI in tests.

	Usage: create provider = RNGProvider(get_rng(cfg.seed)) and pass provider.rng
	to modules that need randomness. This lets tests replace provider.rng easily.
	"""
	rng: random.Random

