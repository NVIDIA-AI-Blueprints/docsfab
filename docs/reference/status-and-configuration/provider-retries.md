---
title: "Provider and Step Retries in DocsFab"
description: "Look up which provider failures and response refusals can be retried, which budget pays for them, and how write settlement constrains a retry."
status: draft
content.type: reference
---

Look up which provider failures and response refusals can be retried, which budget pays for them, and how write settlement constrains a retry.

Composition execution applies the configured read-only inference **step**
retry policy. `DOCSFAB_READ_ONLY_MAX_RETRIES` is parsed in
`packages/runtime/src/config/retry-policy.ts` from the `retry.maxRetries`
catalog limit, with maximum 3. That is the step's contract-correction count. A
separate transport budget, `retry.maxTransportRetries` (default and maximum 6,
lowered with `DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES`), covers attempts that a
throttle or transport fault ended. So one read-only step can make at most
1 + 3 + 6 = 10 attempts. Generated `host.yaml` leaves that numeric field unset and therefore
follows the catalog. An existing numeric `readOnlyMaxRetries` remains an
explicit operator override; setup does not infer its history or migrate it.
Executable compositions do not add a tighter retry cap:
`CompositionModelLimits` has no retry field, and an unnamed composition-only number
would hide the cost of extra live model calls.

Each retry re-executes the read-only step under the same sealed turn, time,
and response ceilings. The per-step source-read byte budget is restored for
each attempt, so a retry does not inherit bytes a prior failed attempt already
spent. A run that does not fail costs the same as a single attempt. A failing
read-only step at the catalog default can use 3 contract-correction retries
and 6 transport retries when its failure category is retryable. Set
`DOCSFAB_READ_ONLY_MAX_RETRIES=0` to turn off the contract-correction retries
and `DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES=0` to turn off the transport
retries; set both to turn off step retries entirely. An explicit or
historically persisted host override remains in force. A transport-failed
attempt can still spend tokens before the fault ends it, so exhausting both
maximums multiplies that step's token spend by up to 10. Write-capable
steps stay single-attempt. `context-exhausted` and other non-retryable
categories still terminate on the first attempt with `retryScheduled: false`.
The run record and operator envelope keep `configuredMaxRetries`,
`effectiveMaxRetries`, and one `attempts[]` entry per attempt so the spend is
auditable.

One narrower retry also runs below the step layer. A provider request that
fails with a retryable transport fault is replayed with the identical payload,
up to 8 attempts in total, using 500 ms exponential backoff capped at 20,000 ms
per wait and 60,000 ms across the turn. The seven waits are 500, 1,000, 2,000,
4,000, 8,000, 16,000, and 20,000 ms, 51,500 ms in total. The window was 3
attempts and 1,500 ms of backoff until local runs against the provider route
showed fault bursts that outlast it (live defect 30): the route answered each
408 within milliseconds, so the backoff is the whole window, and 3 of 56
measured bursts lasted three or more faults and each failed a workflow step. The
widened window survives a burst of nearly a minute, stays under a fifth of the
smallest sealed composition `timeoutMs` (300,000 ms), and the attempt deadline
still bounds every wait. The replayed faults are a dropped or refused connection,
a request timeout, and the HTTP statuses a server asks a client to repeat: 408,
425, 429, and any 5xx. Every other 4xx status, including 400, 401, 403, and 404,
is terminal and is never replayed, because repeating the same request cannot
change the answer. A status the provider names first wins over any status that
appears inside the error body, so a gateway that wraps an upstream failure
cannot flip the decision in either direction. When the request left the host,
the replay decision uses the same provider error class that the attempt
records. A content-filter, authentication, or invalid-request error is never
replayed, even when its error text also mentions a connection or a timeout.
Neither is a rate limit that arrived without an HTTP status, such as
`quota exceeded` inside a successful stream. A response that dies while its
body transfers is replayed as well, because nothing has reached the model yet.

A turn that the provider answers with HTTP 429 gets a wider window: up to 24
attempts and 380,000 ms of summed backoff, from
`providerAttempt.maxThrottledAttemptsPerTurn` and
`providerAttempt.maxThrottledTotalDelayMs`. On build.nvidia.com, the chance of
another 429 stayed near 0.7 whether DocsFab had waited 0.5 s or 20 s, so more
attempts outlast the throttle and longer waits do not. One counter and one
summed wait serve the whole turn, and the failure being decided picks the
bound: a 503 after ten 429s is judged against the general 8-attempt bound and
ends the turn. Under a composition that seals a 300,000 ms attempt timer, the
attempt deadline ends a throttled turn first.

The backoff stops as soon as the caller cancels rather than running to
completion first, and a turn cancelled during that window is recorded as
cancelled rather than as a provider failure. When a throttled response carries
`Retry-After`, the wait honours it, still clamped by the per-wait and
across-the-turn ceilings. This retry sits below the turn governor,
so it consumes no additional provider turn, appends no second entry to the turn
ledger, and triggers no second execution-lease preflight. It also stops at the
composition `timeoutMs` deadline and at the caller's cancellation. A replay whose
payload digest does not match the first attempt fails closed rather than
proceeding, so the retry is provably the same request. When a retry happens, the
turn record carries `providerRetries` with the count.

A request that failed after it left the host is also retried at the step layer.
The in-turn replay cannot repeat a stream that already published content, so a
connection that breaks mid-stream ends the attempt. The step retry decides from
the attempt's recorded provider error class before it reads any error text.
When the class is `network`, `server`, `stream-incomplete`, or `timeout`, or
`rate-limit` with an HTTP 429 status, the step retry treats the failure as
retryable, even when the provider's error text matches no rule. Each retry is a
fresh read-only attempt. Content-filter, authentication, and
invalid-request errors stay terminal, even when their error text also mentions
a connection or reads like a malformed response. A rate limit without an HTTP
status also stays terminal, because it is usually a quota that no retry
outlasts. A request that DocsFab refused before sending records no provider
error, so no class decides its retry. Its error text still decides, as before,
so such a refusal can still be retried. When the failed attempt recorded a
`Retry-After` with the HTTP status of its response, the step retry waits at
least that long, up to the ceiling of the budget that judges the attempt.

A throttled or `provider-transient` attempt never delivered an answer that the
step's contract could judge, so its retry comes from a separate transport
budget and does not spend `DOCSFAB_READ_ONLY_MAX_RETRIES`. A step keeps every
contract-correction attempt however many throttles or transport faults come
before them, and the correction that the last judged attempt earned carries
over to the next attempt. The transport budget has the following three bounds:

- `retry.maxTransportRetries`: 6 transport retries per step by default. Set
  `DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES` from 0 through 6 to lower it. At
  0, the step stops on its first transport fault.
- `retry.transportMaxDelayMs`: each wait is the exponential from
  `DOCSFAB_RETRY_BASE_DELAY_MS` by transport retry number, lengthened to the
  provider's `Retry-After` and capped at 60,000 ms.
- `retry.transportMaxElapsedMs`: the step's transport-failed attempts and
  their waits may use 3,600,000 ms of wall clock in total. The attempt that is
  running when the bound is crossed still finishes.

When a bound refuses a further transport retry, the step fails with its
transport category and names the bound, for example
`retry-max-transport-retries-bound: 7 exceeds retry.maxTransportRetries = 6
count.`, followed by the remediation. The attempt records `retryDecision:
exhausted`. Write-capable steps use this budget only when the host proves that
no filesystem write tool ran during the failed attempt, or when the host
restores the workspace to its pre-attempt state before retrying. The host reads
every tool batch across all turns and reconciles its settlement with execution
lease and per-tool counters. A missing result, unreadable ledger, unknown tool,
or inconsistent counter keeps the failure terminal as `declined-write-step`.
The attempt records `writeSettlement` as `no-write`, `write-executed`, or
`unavailable`. The run record keeps the applied budget in `transportRetry`,
and `docsfab doctor` prints it on the `Transport retry budget` line.

The transport budget adds wall clock to a step. `docsfab doctor` adds it to the
`Retry envelope` line as `transport<=…ms`. The transport portion is the smaller
of two amounts: the elapsed ceiling plus one attempt timer, or every transport
attempt at its full timer plus every wait at 60,000 ms. With the default 6
transport retries and a 1,800,000 ms attempt timer, that is
`min(3,600,000 + 1,800,000, 7 × 1,800,000 + 6 × 60,000) = 5,400,000 ms`.
The separate contract portion is `(1 + 3) × 1,800,000 = 7,200,000 ms`, so the
full step worst case is `5,400,000 + 7,200,000 = 12,600,000 ms`. This exceeds
the 10,800,000 ms ceiling for a hosted job deadline
(`runtime.deadlineMilliseconds`). A hosted job is still bounded, because the
job deadline cancels the whole run when it fires. Set
`DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES` lower, or seal a shorter attempt
timer, when one step must fit inside a shorter job deadline.

Every other step retry decision follows one host-owned table, the
[retry rules](../../../packages/runtime/docs/reference/contracts/model-output-rules.md#retry-rules)
declared in `config/model-output/retry-policy.yaml`. Each attempt records the
rule that decided it as `retryRule`, and `docsfab runs show` prints that rule as
the attempt's retry decision. The following four conditions get their own handling:

- A reply that is prose, an array, or empty where the step's contract asks for
  a JSON object is retried within `DOCSFAB_READ_ONLY_MAX_RETRIES`, and the
  retry tells the model to return only the object.
- An answer cut at the output limit with no continuation left, or completed by
  a continuation and then refused, is retried once by default, with feedback to
  return the complete answer well inside the limit. Set
  `DOCSFAB_READ_ONLY_MAX_CUT_ANSWER_RETRIES` from 0 through 3 to change it.
- An attempt that times out is retried once by default, and the attempt
  records whether the host's own attempt timer fired (`attempt-deadline`) or the
  provider timed out (`provider-timeout`). After a host deadline, the retry
  tells the model to read only what the answer needs. Set
  `DOCSFAB_READ_ONLY_MAX_TIMEOUT_RETRIES` from 0 through 3 to change it.

- An attempt the runtime stopped as `no-progress` is retried once by default,
  and that retry asks for the answer at its first notice-only re-read (refer to
  [Read-Loop Supervision](read-loop-supervision.md)). Set `DOCSFAB_READ_ONLY_MAX_NO_PROGRESS_RETRIES` from
  0 through 3 to change it.

The condition budgets count the retries of that condition already scheduled in
the step, and all of them stay inside `DOCSFAB_READ_ONLY_MAX_RETRIES`. A host that
lowers that count applies the lower value to each condition budget; an explicit
condition override above it is refused at startup. A refusal its validator
marks terminal, such as credential material or an authority refusal, is never
retried.

A hosted stream can also close cleanly partway through an answer, with no
finish reason and no `[DONE]` event. On the OpenAI Chat Completions transport,
where every complete stream ends with `[DONE]`, DocsFab records this as the
provider error class `stream-incomplete`, a retryable `provider-transient`
failure. The in-turn replay still refuses a stream that already published
answer text, so the step retry repeats the attempt from the transport budget.
A stream that closed before any answer text is
replayed in the turn instead. Each attempt has its own execution lease, so the
retry is not charged for the incomplete attempt's output. A stream that sent `[DONE]`
without a finish reason, or whose body failed before its end, keeps its
previous classification. The failure class of a `stream-incomplete` attempt is
`infrastructure`, with code `provider-stream-incomplete`.

A provider can also answer HTTP 200 and then end the stream with a structured
error event, such as `{"error":{"type":"service_unavailable","code":503}}`.
DocsFab reads the event's integer `error.code` as a declared status and checks
its `error.type` against a closed list of server-fault types. It never reads
the event's message. A declared status maps to a class the same way an HTTP
status does: a declared 504 is `timeout`, any other declared 5xx is `server`,
and both are retryable. A server-fault type with no declared status is
`server`. A declared 429 is still a rate limit without an HTTP status, so it
stays terminal. The in-turn replay and the step retry act on this class, on a
compatible endpoint and on an installed composition route alike.

On an installed composition route, the response boundary checks the model
identity of every 200 body before Pi reads it. A stream whose only events are
structured error events, apart from the closing `[DONE]`, carries no model
output to check. The boundary still scans it for credentials, skips the
identity check, and passes it on, so the error is classified as above rather
than refused. An error event counts only when it has no member other than
`error` and an optional `"type": "error"`. A stream with any other event still
needs a model identity, and every model it names must match the selected model,
so a chunk from another model is refused even when an error event follows it.
A stream with any data after `[DONE]` also keeps the identity check. The
boundary reads at least every `data:` line that the stream's consumer reads.
The openai SDK, which parses the openai transports, drops one leading byte
order mark (U+FEFF) from every line. Pi's own parser for Anthropic messages
drops none. Both end a line at CRLF, LF, or a bare CR. The boundary ends lines
the same way and drops every leading byte order mark, so it inspects each line
either consumer treats as data, and possibly more. It reads each `data:` line
on its own and refuses the body when one does not parse. A 200 body that is not
a stream, or a stream with no event, is refused as before.

A provider turn that contains a tool batch can consume one provider turn even
when no tool call executes. This occurs when Pi rejects every call before host
authorization, such as for an unknown tool, invalid arguments, or truncated tool
arguments. The execution lease records zero executed tool calls and allows the
model to reissue the batch within the remaining lease. A host preflight failure
is not treated as this case and instead fails with its diagnostic evidence.

At an execution checkpoint, the host decides renewal from executed-call
evidence. If that evidence does not support renewal, DocsFab stops without
requesting another provider turn. The terminal lease retains the stop reason and
disposition for diagnosis; checkpoint model output cannot authorize renewal.
