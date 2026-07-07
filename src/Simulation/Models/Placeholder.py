model = StaticModel(
    object_types=[
        ObjectType(name="order"),
        ObjectType(name="item"),
        ObjectType(name="customer"),
    ],
    activities=[
        Activity(
            name="Place Order",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1, creates=True),
                ObjectBinding(object_type="customer", min_count=1, max_count=1),
            ],
        ),
        Activity(
            name="Add Item",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1),
                ObjectBinding(object_type="item", min_count=1, max_count=None, creates=True),
            ],
        ),
        Activity(
            name="Confirm Order",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1),
            ],
        ),
        Activity(
            name="Ship Order",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1, deactivates=True),
                ObjectBinding(object_type="item", min_count=1, max_count=None),
            ],
        ),
        Activity(
            name="Cancel Order",
            bindings=[
                ObjectBinding(object_type="order", min_count=1, max_count=1, deactivates=True),
            ],
        ),
    ],
    constraints=[
        Constraint(
            constraint_type="precedence",
            a="Place Order",
            b="Confirm Order",
            scope=Scope(kind="each", object_type="order"),
        ),
        Constraint(
            constraint_type="precedence",
            a="Place Order",
            b="Cancel Order",
            scope=Scope(kind="each", object_type="order"),
        ),
        Constraint(
            constraint_type="response",
            a="Confirm Order",
            b="Ship Order",
            scope=Scope(kind="each", object_type="order"),
        ),
        Constraint(
            constraint_type="not_coexistence",
            a="Ship Order",
            b="Cancel Order",
            scope=Scope(kind="each", object_type="order"),
        ),
    ],
    o2o_rules=[
        O2ORule(source_type="customer", target_type="order", min_links=0, max_links=None, bidirectional=False),
        O2ORule(source_type="order", target_type="item", min_links=0, max_links=None, bidirectional=False),
    ],
)