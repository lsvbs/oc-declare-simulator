"""Attribute utility helpers shared across Engine modules.

Extracted here to avoid circular imports between candidategeneration.py
(which imports from semantics.py) and semantics.py (which needs guard
filtering for constraint-level guards).
"""
from __future__ import annotations

from Backend.src.Simulation.Domain.state import SimulationState


def apply_guard_filter(ids: list, guard: dict, state: SimulationState) -> list:
    """Filter object IDs by an attribute guard predicate.

    Objects lacking the named attribute are excluded (fail-absent).
    Both sides are coerced to float for numeric comparisons when possible.
    Supported ops: ==, !=, >, <, >=, <=
    """
    attr_name = guard.get('attribute', '')
    op        = guard.get('op', '==')
    raw_val   = guard.get('value')

    def _coerce(a, b):
        try:
            return float(a), float(b)
        except (TypeError, ValueError):
            return str(a), str(b)

    result = []
    for oid in ids:
        obj = state.objects.get(oid)
        if obj is None:
            continue
        attrs = obj.attributes or {}
        if attr_name not in attrs:
            continue  # fail-absent
        obj_val = attrs[attr_name]
        a, b = _coerce(obj_val, raw_val)
        try:
            if   op == '==': match = a == b
            elif op == '!=': match = a != b
            elif op == '>' : match = a >  b
            elif op == '<' : match = a <  b
            elif op == '>=': match = a >= b
            elif op == '<=': match = a <= b
            else:            match = False
        except TypeError:
            match = False
        if match:
            result.append(oid)
    return result
