# Conversion IR and construct rules

This module defines the contracts that documentation conversion stages meet
at. Source readers produce the conversion IR; target emitters consume it.
Neither side reads the other's syntax.

| File | What it owns |
| --- | --- |
| [`contracts.ts`](contracts.ts) | The versioned IR (documents, navigation, labels, routes, assets, substitutions, drop ledger), dispositions, ambiguity units and answers, plan-level rules, and refusal codes |
| [`registry.ts`](registry.ts) | The closed construct rule registry: one data table, one rule per construct |
| [`resolver.ts`](resolver.ts) | Gives every IR node exactly one disposition, fills the drop ledger, and enumerates ambiguity units and refusals |

Each construct has exactly one disposition:

- `convert` names a target-neutral emitter intent with typed parameters.
- `judge` makes the host enumerate an ambiguity unit with a closed answer set.
- `drop-with-notice` removes the node and records it in the drop ledger.
- `refuse` blocks plan approval until a plan-level rule covers the construct.

Directive and role names without a rule fall back to `directive:*` or `role:*`,
which produce a custom-construct ambiguity unit. A node kind the IR does not
define, or a construct with more than one rule, is refused with a named code.
Readers turn the directives in `NORMALIZED_DIRECTIVE_NODE_KINDS`, and `raw`
with an `html` format, into typed nodes, and they lower-case directive and role
names; a node that breaks either rule is refused. These reader checks, and
node-id uniqueness, also cover the subtree of a dropped node, which gets no
disposition of its own.

Ambiguity unit ids are `unit:node:<node id>` for a node and
`unit:substitution:<name>` for a substitution-table entry.

The design is the documentation conversion decision record,
`planning/design/documentation-conversion-decision.md`.
