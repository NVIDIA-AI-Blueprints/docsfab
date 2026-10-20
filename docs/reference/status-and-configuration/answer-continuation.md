---
title: "Model Answer Continuation in DocsFab"
description: "Look up how empty replies, length stops, and cumulative output authority affect a model answer."
status: draft
content.type: reference
---

Look up how empty replies, length stops, and cumulative output authority affect a model answer.

An empty provider turn is replayed under its own, narrower bound. A completion
that carries a `finish_reason` and usage but no content and no tool call at all
is replaced by an identical replay, up to 3 attempts (`maxBlankAttempts`), with
the same backoff, `Retry-After`, deadline and cancellation handling. Empty turns
keep the narrower bound because the provider bills each one for its whole input
context, which a transport fault that never reached the model does not cost. A
turn that stopped for a reason of its own is never replayed identically: any
`finish_reason` outside the ordinary stop and tool-call set such as
`content_filter`, and a completion that carried provider error text, are
answers about that request, and repeating it cannot change them. A replayed
empty turn still costs tokens, so they are charged to the execution lease
against the governed turn that lands, and the turn record carries
`providerBlankTurns` with the number of empty turns observed, including the
last one when the budget runs out. The step then fails naming the streak and
the provider's own stop reason, for example
`Provider turn failed: blank: 3 blank provider turns stopReason=stop finish_reason=stop.`

A turn that stopped at the output limit (`finish_reason=length`) is handled by
shape, on whichever step it lands. It is the terminal-answer pattern of any
step whose final report outgrows the limit. An empty one is a turn where the
provider billed the whole output budget and surfaced neither text nor a tool
call (a front door that withholds the cut answer instead of streaming it). Such
a turn is replayed exactly once, and not identically. The replay appends one
bounded user message naming the authorized limit and asking for small tool
arguments and a terminal answer that fits. It runs under the same veto, backoff
budget, deadline and cancellation gates, and counts as one `providerRetries`
and one `providerBlankTurns`. The turn record's `finalPayloadSha256` then names
the nudged payload that was actually sent, and a replay that reaches the
payload hook without its nudge fails closed. From that point every further
replay of the same turn repeats the nudged request: a transient fault or an
ordinary empty turn on the nudged attempt is replayed under the ordinary bounds
(8 transport attempts, 3 empty turns), with the nudge still in place. If the
replay is cut the same way
the step fails as
`Provider turn failed: provider-failed: output-truncated: 2 provider turns of step review-documentation hit the 8,192-token output limit (finish_reason=length), last turn consumed 8,192 output tokens, no text or tool call surfaced; ...`,
classified `malformed-response; retryable=false`: the step, the limit and the
tokens the cut turn consumed are all in the one line. A terminal answer whose
text was cut is never replayed (its text has already been published) and is
never accepted as complete. A step whose reply the runtime decodes against a
host response contract first asks for the rest of that answer inside the same
attempt, up to `inference.maxLengthStopContinuations` continuation turns (1 by
default). When no continuation is left, the partial text stays the turn's
content and the step fails as `text-truncated`, naming the step, the limit, the
characters retained and the tokens consumed.

The two judgment steps of `review-documentation` over a version 2
source-obligation ledger (`provisional-technical-verification` and
`verify-technical-accuracy`) do not fail at either point. When their answer is
cut with no continuation left, or a cut turn and its replay surfaced nothing
(`output-truncated`), the runtime completes the judgment itself in the following way:

- It keeps each complete element it can recover from the retained text, read
  up to the composition's response byte ceiling.
- It records every obligation without a complete judgment as unverified, and
  sets the verdict to `human-review`.
- It adds one limitation that starts with `Host judgment completion:` and names
  the limit, the continuation turns, the output tokens billed, the characters
  retained, and what it kept and filled.

If the step's own checks refuse a kept element for its content, such as an
unknown severity or an overlong reason, the runtime keeps none of the cut
answer, records every obligation as unverified, and says so in the limitation.
The same floor applies when a continuation completes the cut answer but the
stitched reply is refused for its model content, even on an early attempt with
retries available. The host does not retry the whole step after that refusal.
The limitation and unverified obligation records name the continued refusal
without claiming that the retry budget was exhausted. A credential disclosure
or refusal of the host-filled result still fails the step. The attempt ends
`succeeded`, and its turn record keeps the `length` stop. A reading turn cut
with nothing surfaced is completed the same way, so an all-unverified judgment
does not by itself mean that an answer was started.

The same two steps also keep an uncut answer from failing the review when no
retry remains. An answer that the step's own checks refuse for its content is
retried with the rule's hint, as on every read-only step, within
`retry.maxRetries`. When no retry is left, because the attempt is the last one
or because the refusal is one that is never retried, such as an issue located
outside the target pages or a host filesystem path, the runtime keeps none of
the refused answer and records the same all-unverified judgment in the following way:

- Every obligation and every target page is unverified, with no issue
  judgment, and the verdict is `human-review`.
- One limitation that starts with `Host judgment completion:` names the step,
  the attempts spent, and the refusal's rejection code, for example
  `judgment-documentation-disposition-invalid`.
- Each demoted dimension names `judgment-reply-refused` as its reason.

Only a credential in the answer still fails the step. The host-filled judgment
has to fit the step's own size and count bounds.
A `documentation-set` review of a large repository makes every documentation
page a target, and the host-filled coverage alone can exceed
`technicalCorrection.proposalMaxBytes`. The run then stops before its first
model call with `technical-correction-proposal-max-bytes-bound`, which names the
observed bytes and the bound. When the host-filled judgment crosses a byte
bound at the step instead, the step stops with the same kind of code and is not
retried. To avoid this, narrow the run to a `focused-set` scope, as described in
[Review Scope](../workflow-contracts/review-documentation.md#review-scope).

A streamed tool call cut at the limit is
refused by Pi's own agent loop, which asks the model to re-issue it; the
runtime grants that once and names a second consecutive cut as
`tool-arguments-truncated` rather than spending a third output budget. The
remedy is the composition's `maxOutputTokens` or a shorter answer for that
step, which is why each message names the number. That remedy does not apply
when the cut turn was clamped to the cumulative output lease described in the
next paragraph. The lease remainder was the binding limit, so raising
`maxOutputTokens` does not move it. The message then names the remainder and
the lease limit instead, for example
`... Shorten the answer; the limit was the 10,000 output tokens left of the 4,194,304-token cumulative output lease, not maxOutputTokens.`,
and a shorter answer for that step is the remedy.

Each step attempt also carries a cumulative output-token lease (4,194,304 tokens
by default on the composition execution path). Before every provider turn, the runtime compares
that lease's remainder with the output the turn would request. While the remainder covers
the per-turn output limit, nothing changes. Once it is smaller, the request's
`max_tokens` is clamped to the exact remainder and the turn record carries
`outputAuthority` with the lease limit, the output already spent, and the floor.
Once the remainder falls below the floor (the provider's minimum output plus
1,024 tokens) no request is sent: the turn record ends with reason
`output-authority-exhausted`, the lease ends `budget-stopped` under the same
terminal reason (distinct from `cumulative-output-limit`, which names a spend
that reached the limit), and the step fails naming the step, the output spent
and the lease limit, for example
`Output authority exhausted [output-authority-exhausted]: step evaluate-document-quality used 4193804 of 4194304 cumulative output tokens; the 500 remaining are below the 1040-token floor, so no further provider turn was requested.`
A stop the budget governor makes before a turn, such as the provider-turn
limit, records category `context-exhausted` and is never retried. The tool
turn that brings a step attempt's executed calls to the hard tool-call ceiling
ends the attempt instead, with no answer asked for, because the step would
refuse an answer given at the ceiling. That attempt records category
`no-progress` with condition `tool-call-ceiling`, its lease ends
`hard-tool-call-ceiling`, and its code is
`composition-execution-max-tool-calls-per-step-bound`. The step retries it the
way it retries a read loop, as [Read-Loop Supervision](read-loop-supervision.md) describes, from the same
`retry.maxNoProgressRetries` budget. A retry that reaches the ceiling again
fails the step with the same code. `docsfab why` names the owner by what set the
ceiling: the model's progress for a sealed composition budget, and operator
configuration for a host limit or an override that lowered it.
