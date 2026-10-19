---
title: "Retry Evidence in Saved DocsFab Runs"
description: "Look up the RETRIES, rejected-reply, model telemetry, and failure-class fields shown by saved-run readers."
status: draft
content.type: reference
---

Look up the RETRIES, rejected-reply, model telemetry, and failure-class fields shown by saved-run readers.

Saved-run replay prints a `RETRIES` section when a failed or retried step
recorded inference attempts. Each line names the attempt outcome, the
condition's retryability, the harness `retryable` flag, the run's retry
decision, retries remaining, the physical provider requests the attempt spent
against the logical governed turns it spent them on, and the boundary that
refused a replay when one was refused. When `conditionRetryability` is
`eligible` and `retryable` is `false`, the line also states that those two
facts disagree. A line for a rejected response also names the rule that
refused it and the contract location, such as
`rejected by fact-link-unknown-obligation at $.issueJudgments[].obligationIds[]`,
and the reply's shape, such as `reply keys verdict, coverage, issueJudgments`
or `reply not JSON (malformed-json unexpected-end at character 16384 of 16384)`.
DocsFab never records or prints the reply's text.

```text
Step assess-readiness attempt 1: timeout; condition eligible; retryable false;
  decision declined-host-refusal (the harness reported the occurrence as not
  retryable); retries remaining 1; condition eligible disagrees with retryable
  false; physical 8 across 1 governed turn; replay stopped by attempts-exhausted
```

A governed turn is one turn the turn governor authorized. A physical request is
one call to the provider transport, and a single governed turn spends more than
one whenever the bounded in-turn replay fires. The clause always states both
numbers, because "8 requests" on its own reads like eight turns. When the
attempt carries no readable turn ledger, the clause reads `physical unavailable`
instead of claiming zero. When some turn rows cannot be accounted for, the
clause states how many it could not read; when none of them could, it reads
`physical unaccounted (N turns unreadable)` rather than a total of zero.

`providerAttempt.maxPhysicalRequestsPerStep` bounds the whole step attempt, not
one governed turn. A replay it refuses is recorded on that turn as
`step-physical-attempts-exhausted`. A governed turn it refuses outright never
reaches the provider at all and stops the step with
`Provider turn stopped locally: reason=step-physical-attempts-exhausted`, which
names the requests spent and the bound. Only lowering the entry is supported.

`--json` carries the same readings as `retryDispositions`, with the accounting
under `physicalAttempts`, the boundary under `replayVeto`, the harness
`retryable` flag, and `retriesRemaining`. When the condition is `eligible` and
`retryable` is `false`, the envelope also carries `eligibilityDisagreement`.
Decode validates the accounting as either the `unavailable` sentinel or a
complete set of non-negative counts with a known coverage word, and it refuses
a veto outside the closed vocabulary rather than printing it. The key is
omitted when no step has a retry story. A reading for a rejected response
also carries `rejectedReplyShape`, the content-free reply fingerprint described
in the run record contract, and `rejectedReplyExcerpt`, the reply's bounded,
redacted head, tail, and parse-position text. In `docsfab runs show`, the
excerpt prints under the attempt's `RETRIES` line. The summary line states the
reply length, how many characters were not retained, the
`inference.rejectedReplyExcerptChars` bound, and the segment that holds the
parser's stop position. Segment text prints as a JSON string. Control, format,
and line-separator characters are escaped in both the text and `--json` output,
so reply text cannot restyle or reorder a terminal line. Here is an example,
with the segment text shortened:

```text
Reply excerpt: 1024 of 19573 characters retained; 18549 not retained past inference.rejectedReplyExcerptChars = 512 per segment; parse stopped at character 0 (in head).
  head 0-512: "We need to check the README first. The review"
  tail 19061-19573: "\n{\"review\":{\"verdict\":\"pass\",\"issues\":["
```

The `FAILURE` footer uses that same selector, so
`docsfab run --quiet` cannot describe a retry the other surfaces omit. For
each failed step, the footer prints one `Rejected by` line that names the inner
rule and contract location that refused the step, followed by the reply's shape
for an inference rejection. The footer never prints the reply excerpt. Here are
two examples:

```text
Rejected by fact-link-unknown-obligation at $.issueJudgments[].obligationIds[]; reply keys verdict, coverage, issueJudgments (+1 undeclared).
Rejected by required-dimension-not-applicable at $.layers (3 quality validator issues).
```

A run that an older DocsFab release stopped with `host-path-disclosure` still
reads back. Its line names that rule at `$`. No current step raises the code.

The reply keys clause names only keys that a DocsFab response contract
declares. It counts every other key as `undeclared`, however ordinary the key
looks, and counts keys cut by `inference.rejectedReplyShapeMaxEntries` as
`over limit`. When a depth or path bound clipped the fingerprint, the line adds
`reply shape truncated` with the limit name, the bound, and the omitted count.

When the failed step's last attempt carries model telemetry, the footer also
prints one `Model telemetry` line. It names how the provider finished the last
turn, the output that turn produced against its per-request allowance, the time
spent waiting on the provider, and the provider error class when the attempt
ended on one. A reply cut at the output limit reads `finish reason length` and
`Rejected by text-truncated at $response`, so it does not look like a contract
shape rejection. A status that the provider declared in an error event inside
a successful HTTP 200 stream reads `in-stream status`, because the HTTP
response itself did not fail. Here are three examples:

```text
Model telemetry: finish reason length; output 16384 of 16384 allowed tokens; provider latency 48210 ms.
Model telemetry: finish reason error; provider latency 912 ms; provider error rate-limit (HTTP 429; retry after 2000 ms).
Model telemetry: finish reason error; provider latency 602 ms; provider error server (in-stream status 503).
```

A declined retry with remaining budget keeps NEXT as
`docsfab runs show <run-id> --json`. It does not suggest `docsfab doctor` or
the same command unchanged.

The `FAILURE` footer and `docsfab runs show` also print the run's one failure
class under the run line, with the layer and the catalogued code the class was
read from:

```text
Failure class: model-content (layer inference, code invalid-fact-link).
```

The run's class is its first cause: its first failed step's class, or the
finalize-time failure when every step succeeded. `--json` carries `failures`,
one entry per failure with `scope` set to `run`, `step`, or `attempt`, plus
`stepId` and `attempt` where they apply. A failed attempt of a step that later
succeeded on retry is listed too. For the class list, refer to
[Failure Classes](stop-classes.md#failure-classes).

## Continue a Completed Quality Evaluator Refusal

An answer-record run can fail after its read-only quality evaluator completes
when the workflow cannot admit the resulting product. You can continue from
the saved ledger checkpoint only when the run records a workflow product
mismatch and a typed, model-correctable quality validation refusal, with no
admitted quality report. DocsFab does not replay other completed steps or retry
a host fault, integrity refusal, or successful workflow. The source revision,
selected run, checkpoint, and continuation claim must still match.
