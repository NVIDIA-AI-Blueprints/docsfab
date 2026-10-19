---
title: "Composition Execution Budgets in DocsFab"
description: "Look up how provider-turn, time, response-byte, and cumulative-token budgets combine for a composition execution attempt."
status: draft
content.type: reference
---

Look up how provider-turn, time, response-byte, and cumulative-token budgets combine for a composition execution attempt.

Optional host-owned ceilings are
`DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS` (default `512`),
`DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS` (default `3600000`), and
`DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES` (default `4194304`). The effective value
is the minimum of the host setting, candidate proposal, installed composition,
and package ceiling. These are experiment settings, not provider facts.

A raised host default does not override a narrower installed composition. The
GPT-6 Sol and two Anthropic Claude records on the NVIDIA Inference Hub route
seal 1,800,000 ms and 512 provider turns. Other installed compositions seal
300,000 ms and 128 turns. The 3,600,000 ms host default therefore does not grant these compositions
1-hour attempts. `DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS` bounds one workflow step attempt,
not the job. A hosted run is separately bounded by the dispatcher policy's
`runtime.deadlineMilliseconds`, which the host contract caps at `10800000`
(three hours).

Because the effective value is a **minimum across four sources**, raising the
host setting cannot lift a smaller candidate, composition, or package ceiling.
Three of those four are digest-sealed governance assets, so widening the envelope
means re-sealing the chain, not editing an environment variable.

`DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS` also sizes the per-step tool budget, which
is not independent of it: the execution-lease contract requires
`maxProviderTurns >= hardToolCallCeiling + maxLeases`, so the turn budget is a
hard cap on how many tool calls a step can make. The shape is fitted to whichever
turn budget a lane actually seals, so the number differs per lane: a lane sealed
at `512` turns yields a **policy** ceiling of 400 tool calls, and one sealed at
`128` yields 126. Compare that with a measured P100 of 54 tool calls and
24 provider turns per step across twelve models
(`packages/runtime/docs/internal/evidence/model-comparison-single-mode-2026-08-27/`).

Whether a step reaches its lane's 126- or 400-call policy ceiling also depends
on cumulative tokens and the attempt deadline.
`DOCSFAB_COMPOSITION_EXECUTION_MAX_CUMULATIVE_INPUT_TOKENS` defaults to `16777216`, and
`DOCSFAB_COMPOSITION_EXECUTION_MAX_CUMULATIVE_OUTPUT_TOKENS` defaults to `4194304`.
Both budgets apply to one step attempt. These defaults use their existing
catalog maxima by operator choice. The historical model measurements do not
establish these amounts as sufficient for every workload. Use the recorded
usage and stopping reason to identify the bound that a run actually reaches.

The previous default of `4` yielded a 3-call ceiling and could not complete
`create-documentation` for any model. Steps that exhaust either budget now **fail**
rather than reporting `succeeded`; before that change a truncated run was
indistinguishable from a finished one, so an envelope sized below every real
workflow produced confident, empty successes.

`DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES` bounds the **raw provider response on
the wire**, not the decoded document. Per-token JSON framing means the wire
bytes greatly exceed the document bytes, by a ratio that varies with the
provider's streaming format and token size. The content this setting admits
therefore differs by model even when the setting does not. Size it against the wire, and
measure your own lane rather than assuming a ratio.

For scale, the one retained measurement: a `nemotron-3.5-lightning-30b-a3b`
composition-execution step exceeded a 65,536-byte cap at 65,834 wire bytes across 199 SSE
events while producing a document far smaller than that
(`packages/runtime/docs/internal/evidence/pi-client-instrumentation-2026-08-24/report.md`).
That probe records wire bytes and event counts only (model output is never
written to evidence), so the probe bounds the wire side and not the ratio.
