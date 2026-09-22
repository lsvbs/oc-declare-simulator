"""Read declared OCEL object relationships and summarize their cardinalities.

Absent relationships yield no rules; event co-participation is not a fallback.
"""
from collections import defaultdict
from typing import Any, Dict, List


def _declared_o2o_links(objects: Dict[str, Any]):
    """Object-to-object links exactly as the log declares them.

    Reads each object's own ``relationships`` list (OCEL 2.0's O2O section,
    preserved by the loaders above) — NOT event co-participation.

    Both directions of every declared relation are recorded. A relation is a
    single fact about two objects, and SimulationState.add_link stores links
    undirected (it indexes both endpoints), so the cardinality of a pair is
    meaningful read either way: "TR loads CR" appears 1997 times over 6 trucks,
    which says both "a truck loads 323-337 containers" and "a container is
    loaded by 1 truck". Emitting only the declared direction would leave the
    second fact — the one that actually constrains containers — unstated.

    Same-type relations are skipped: O2ORule is keyed on a type pair and the
    engine has no way to express a rule whose two sides are the same type.

    Returns (links, n_relations) where links maps
    (source_type, target_type) -> {source_object_id: {target_object_id, ...}}.
    """
    links = defaultdict(lambda: defaultdict(set))
    qualifiers = defaultdict(set)
    n_relations = 0

    for src_id, src in (objects or {}).items():
        src_type = (src or {}).get('type')
        if not src_type:
            continue
        for rel in ((src or {}).get('relationships') or ()):
            if isinstance(rel, dict):
                tgt_id = (rel.get('objectId') or rel.get('ocel:oid')
                          or rel.get('object-id') or rel.get('targetId'))
                qual = rel.get('qualifier') or ''
            else:
                tgt_id, qual = rel, ''
            if not tgt_id or tgt_id == src_id:
                continue
            tgt_type = (objects.get(tgt_id) or {}).get('type')
            if not tgt_type or tgt_type == src_type:
                continue
            n_relations += 1
            links[(src_type, tgt_type)][src_id].add(tgt_id)
            links[(tgt_type, src_type)][tgt_id].add(src_id)
            if qual:
                qualifiers[(src_type, tgt_type)].add(qual)
                qualifiers[(tgt_type, src_type)].add(qual)

    return links, qualifiers, n_relations



def discover_o2o_rules(ocel_log: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Read object-to-object relationship rules from the log's O2O section.

    The cardinalities come from the relations the log itself declares between
    objects. They are NOT inferred from which object types share an event.

    That distinction matters. Co-participation answers "were these two objects
    in the same event", which is a different question from "are these two
    objects related", and on container_logistics the two disagree badly: the
    log declares 15,920 relations over 7 type pairs, while co-participation
    produced 17 pairs, 13 of which the log never states. Some were simply
    wrong — the log says a Container belongs to exactly one Transport Document
    (1..1), co-participation said 1..13, because ``Depart`` puts a container in
    one event alongside up to 13 documents. Those invented ceilings are then
    enforced by check_o2o_rules and silently block activities.

    A log with no O2O section yields no rules. That is the honest answer: the
    log states no object relations, so none are enforced.

    Args:
        ocel_log: OCEL 2.0 log dictionary

    Returns:
        List of O2O rules with cardinality constraints
    """
    # Handle simple list format - no O2O rules for simple lists
    if isinstance(ocel_log, list):
        return []

    objects = ocel_log.get('objects', {})

    o2o_links, o2o_qualifiers, _n_relations = _declared_o2o_links(objects)
    if not o2o_links:
        return []

    # Calculate cardinality for each directed pair, then decide bidirectionality
    def _rule(src, tgt, lo, hi, bidirectional):
        # max_links is the largest number of distinct partners of `tgt` that any
        # single `src` object actually has in the log. No ceiling heuristic is
        # applied: the observed maximum IS what the log says, and capping large
        # values to "unbounded" would be another inference of the kind this
        # function exists to avoid.
        r = {
            'source_type': src,
            'target_type': tgt,
            'min_links': lo,
            'max_links': hi,
            'bidirectional': bidirectional,
        }
        quals = sorted(o2o_qualifiers.get((src, tgt), ()))
        if quals:
            # Provenance only — O2ORule has no qualifier field, so the rule is
            # the aggregate over all qualifiers joining this type pair.
            r['qualifiers'] = quals
        return r

    o2o_rules = []
    processed_pairs = set()

    for (type1, type2), links in o2o_links.items():
        if (type1, type2) in processed_pairs or (type2, type1) in processed_pairs:
            continue
        processed_pairs.add((type1, type2))

        fwd_cards = [len(linked_objs) for linked_objs in links.values()]
        if not fwd_cards:
            continue

        fwd_min, fwd_max = min(fwd_cards), max(fwd_cards)

        rev_links = o2o_links.get((type2, type1), {})
        rev_cards = [len(linked_objs) for linked_objs in rev_links.values()]

        if not rev_cards:
            # Unreachable while _declared_o2o_links records both directions;
            # kept so a caller passing a one-directional link map still works.
            o2o_rules.append(_rule(type1, type2, fwd_min, fwd_max, False))
            continue

        rev_min, rev_max = min(rev_cards), max(rev_cards)

        if fwd_min == rev_min and fwd_max == rev_max:
            # Symmetric: one bidirectional rule with the shared cardinality
            o2o_rules.append(_rule(type1, type2, fwd_min, fwd_max, True))
        else:
            # Asymmetric: two separate unidirectional rules
            o2o_rules.append(_rule(type1, type2, fwd_min, fwd_max, False))
            o2o_rules.append(_rule(type2, type1, rev_min, rev_max, False))

    return o2o_rules

