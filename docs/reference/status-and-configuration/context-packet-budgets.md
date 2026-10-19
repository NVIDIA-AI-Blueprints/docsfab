---
title: "Context Packet Budgets in DocsFab"
description: "Look up the budgets used to assemble and present bounded workflow context."
status: draft
content.type: reference
---

Look up the budgets used to assemble and present bounded workflow context.

## Context Packet Budgets

A workflow step can receive a context packet: a summary of the documentation
structure around the step's targets, which DocsFab adds to the step's prompt.
The packet's budget is a share of the input window of the model that runs the
step, not a fixed size. The following settings set that share:

- A local or change-scoped step uses `context.localPacketInputShareBasisPoints`.
- A corpus step uses `context.corpusPacketInputShareBasisPoints`.

The window comes from an installed composition, or from a model profile whose
metadata is current. Any other run uses `context.packetFallbackInputTokens` as
its window. That includes a run with no bound model profile, and an endpoint
that matches no installed composition, whose window `docsfab setup` writes
only as a placeholder. A window smaller than the fallback window also uses the
fallback window, so no model gets smaller packets than the fallback window
gives.

With the default shares, a 65,536-token window gives packets of 2,051 and
8,192 estimated tokens, and a 1,050,000-token window gives 32,865 and 131,250.
Raise a share, up to 10,000 basis points (the whole window), with
`DOCSFAB_CONTEXT_LOCAL_PACKET_INPUT_SHARE_BASIS_POINTS` or
`DOCSFAB_CONTEXT_CORPUS_PACKET_INPUT_SHARE_BASIS_POINTS`. Raise the fallback
window with `DOCSFAB_CONTEXT_PACKET_FALLBACK_INPUT_TOKENS`.

A packet over its budget is trimmed. The pages the step requested stay
longest, in the order the step requested them. Of the rest, the nodes farthest
from the targets go first. The trim keeps as many nodes as fit, then as many of
the edges among them as fit, then as many of their paths. The step continues
with the trimmed packet. Its `contextPreflight` record is `degraded` with
reason `preflight-budget-exceeded` and a `limit` with the following fields:

- `name`: the share that sized the budget.
- `configured`: the token budget that share gave this run's window.
- `observed`: the packet's estimated tokens before the trim.

When the trim leaves a requested page out of the packet, the record lists that
page in `unboundTargets` by its Unicode Normalization Form C (NFC) path.
A page whose path the record cannot hold, such as one with a control character,
is counted in `unboundTargetsOmitted` instead. A page's name never fails the step.

When the packet cannot fit even with only its first target, a read-only step
continues without a packet and records the same reason and limit. Its
`observed` value is the size of that smallest packet, which is the budget the
step needs to get any packet. A write step needs a packet, so it stops with
code `preflight-budget-exceeded`, class `bound`, and its error names the
share and both values. On a hosted run, the write step instead runs with the
host capsule in place of the packet and records the same reason and limit.
None of these cases reports `preflight-internal-failure`.
`docsfab run` and `docsfab runs show` list each such step in the LIMITATIONS
section, with the requested pages that got no context, and in `--json` as
`limitOverflow`.
