---
title: "Check Answer-Record Capability in DocsFab"
description: "Run an explicit answer-record premise probe against a selected corpus. Keep measured probe evidence separate from workflow or release qualification."
status: draft
content.type: how-to
---

Run an explicit answer-record premise probe against a selected corpus. Keep measured probe evidence separate from workflow or release qualification.

## Answer Records

`docsfab doctor --live --answer-records --answer-record-corpus <path>`
measures whether a route admits the final quality evaluator's answer as small
judgment records, one per `submit_answer_record` call. It prints `GO`,
`NO-GO`, or `INCONCLUSIVE` for that answer transport, and records nothing; a
later qualification seals the values from the observation it keeps.
`--answer-record-corpus` names the record corpus it sends: the records of
two live step 8 evaluations, with host-owned members removed. The two
options are given together. The corpus is maintainer evidence that the
DocsFab package does not ship, and the probe sends only the committed
corpus, whose SHA-256 it pins. When the file cannot be read, is not a valid
corpus, or has another digest, the probe reports `not checked` and sends
nothing.

The probe runs offline readiness. It then sends requests through the same
binding, request policy, effective output limit, and network boundary that
run requests use. `tool_choice` is set to `required`, and every argument of
the tool is described but untyped. Each rung in the following table is sent once per seed,
`endpointProbe.answerRecordSamples` times (three by default).

| Phase | Requests | What it sends |
| --- | --- | --- |
| A | Up to 12 | One record per call at 0.5, 2, 4, and 8 KiB of argument bytes, climbing until a seed is not admitted. |
| B | Up to 9 | One message of several record calls of up to 6 KiB, 10 KiB, and the per-message budget maximum (18,743 bytes at an output limit of 8,192 tokens), climbing until a seed is not admitted. Each prompt is padded to the median input of recorded evaluator turns, so time to first token reflects a production-sized prompt. |
| C | 3 | One 4 KiB record whose strings carry quotes, backslashes, fences, braces, line breaks, tabs, markup, and non-ASCII text. |

Phase B runs only while phase A can still give `GO`, and phase C only while
phase B can too. Once `GO` is out of reach, the probe stops spending and
gives the verdict it has earned.

A call is admitted only when all of the following hold:

- Pi's own argument validation accepts it.
- The host's strict decode admits it: strict JSON with no duplicate keys,
  exactly the `type`, `key`, and `record` members, a declared record type, a
  key exactly for keyed types, and a record that is an object, or a JSON
  string that holds one.
- It carries at least as many bytes as the call it copies. The prompt asks
  for compact JSON, so a shorter copy dropped content.

A sample is admitted only when the reply carries exactly the calls asked
for, none of them cut at the output limit. Sizes are raw argument bytes,
with the `type`, `key`, and `record` wrapper included, and the largest record
and message sizes come from the bytes the admitted calls actually carried.

Before the first request, the probe prints its plan to standard error: the
requests, the transport retries, and the input tokens it will spend. It
refuses before sending anything when the plan exceeds
`endpointProbe.answerRecordRequestBudget` (24 requests by default) or
`endpointProbe.answerRecordInputTokenBudget` (600,000 tokens by default). The
refusal carries the limit's code and remediation. That check against the
plan is the hard budget gate. During the run, the probe predicts each
request's input from the worst ratio of reported to estimated input tokens
seen so far, and withholds a request that would cross the token budget. The
observation names the count of withheld requests.

A request that ends without an HTTP response, other than a response byte
bound, can be sent again: each sample at most once, and at most
`endpointProbe.answerRecordTransportRetries` times in all (two by default).
A re-send is made only when it fits the token budget beside the remaining
plan. At the default budget a phase B re-send never fits. The plan line says
so, and a phase B transport failure ends the run `INCONCLUSIVE`. Each
transport failure names whether it was re-sent, or why not. When an HTTP
proxy refuses a request, the probe stops with the proxy's own code, as the
[live check](check-readiness.md#live-and-catalog-checks) does.

Every sample records its elapsed time, time to first token, when its first
and last tool-call argument text arrived and how many argument bytes came
after the first, output tokens, finish reason, and the input tokens the
provider reported, cached ones apart. Each request's
prompt opens with a nonce that is unique to the request and to the run, so
a provider prefix cache cannot shorten its prefill. The command prints one of the following three verdicts:

- `GO`, when every one of these holds for every seed:
  - phase A carries at least 1.5 times the largest corpus call (4,085 bytes
    for the committed corpus);
  - phase B admits a message rung of 6 KiB or more;
  - phase C is admitted, or is cut at the output limit or the response byte
    bound only above the largest admitted record size.
- `NO-GO`, with a `provider-compatibility` stop class, its cause, and the next
  action. The causes are `record-bound-below-record`,
  `r9-one-record-per-message`, `escape-mix-not-admitted`, and
  `provider-request-refused`.
- `INCONCLUSIVE`, when transport failures or the input-token budget left a
  `GO` criterion unmeasured. It has no stop class. A re-run is outside the
  approved spend, so get the cost owner's approval before probing again.

Each verdict prints the following:

- the measured largest record and message sizes;
- the 90th percentile time to first token on the padded prompts (Lturn),
  beside the median time per provider turn of the recorded evaluator
  attempts, an upper bound that includes decode;
- the decode rate r and its source, beside the median end-to-end rate;
- projections of the evaluator's records phase, described below;
- the corpus SHA-256.

The decode rate comes from the argument window, the time from a sample's
first to its last tool-call argument text, when that window covers at least
`endpointProbe.answerRecordDecodeWindowMinBasisPoints` of the sample's
elapsed time (2,500 basis points, 25%, by default). The output tokens are
prorated by the argument bytes that arrived inside the window. When the
bound request policy leaves reasoning on, the output tokens include reasoning
tokens, so a window rate counts them as decode and can read high; its source
label says which rate it is. A route that
sends each call's arguments in one burst when the call is complete leaves no
such window: Nemotron 3 Super on build.nvidia.com sends a one-record call at
the end of the response, so its time to first token is within a fraction of
a second of the elapsed time. The probe then reports the end-to-end rate,
output tokens over elapsed time with prefill included, which is a lower bound
on decode, and says so in the rate's source and in a note. When the first
output on a padded prompt is a whole call in one burst, a note also says
that Lturn includes that call's decode.

The projections are arithmetic, not measurements, and are marked so. For 1,
2, and 3 records per message, each prints the following:

- M, the record messages one evaluator answer needs, with a message never
  crossing a record group (43, 22, and 16 for the committed corpus);
- the records phase's input tokens, M times the median padded prompt the
  provider reported, with the cached share shown apart;
- the answer time A, the decode time of the larger fixture's records, the
  report, and one resent largest record at r, plus M + 2 times Lturn;
- the attempt timer T* that A needs, A divided by one minus the reading
  share `compositionExecution.answerNowElapsedShareBasisPoints`;
- the reading turns the bound composition's `maxProviderTurns` leaves after
  2M + 1 record, report, and resend turns.

It writes the content-free observation under `answer-record-probes/` beside
the run state directory, named by its SHA-256, which is its
`evidenceSha256`. `GO`, and `MEASURED` from the small-group run, exit 0;
every other verdict exits 1. Add `--json` for a
`docsfab-answer-record-probe-result` record, whose `decision` is `go`,
`no-go`, `measured`, `inconclusive`, or `not-checked`.

#### Small Groups

Add `--answer-record-small-groups` to send only phase K, which measures
whether one message can carry a small group of records when phase B's larger
messages are not admitted. It requires `--answer-records` and its corpus. The following table describes phase K.

The following table lists each phase, its requests, and what it sends.

| Phase | Requests | What it sends |
| --- | --- | --- |
| K | Up to 6 | One message of exactly k record calls, for k = 2 and then k = 3, each the first k records of one record group of the corpus. Each prompt is padded like phase B's. A larger group is not sent once a smaller one is not admitted for every seed. |

Each call is decided as in phase B, and a sample is admitted only when its
calls copy every planned record exactly once. A reply that ends in a stub
record, a short copy, a repeated or substituted record, or the wrong number
of calls is not admitted. Records are keyed, so their order inside the
message is recorded in the observation but not required. A group size
counts as admitted only when every seed is.

The run spends what the approved record-probe budget has left, not a new
budget, and the approval is a ledger kept as local files. Before the plan,
the command reads the `*.json` files present in `answer-record-probes/`
beside the run state. It charges the untyped probe's files: the premise run,
earlier small-group runs, and the reservations of small-group runs that did
not finish. A typed-shell premise observation spends a separate approval and
is not charged; an observation with any other shell is refused. It takes every request those runs sent, re-sends included, and the
input tokens they charged, each sample at the larger of its reported and
estimated input, off `endpointProbe.answerRecordGroupRequestBudget` (24
requests by default) and `endpointProbe.answerRecordGroupInputTokenBudget`
(600,000 tokens by default). Typed-shell requests use their separate 1b
request tranche, while their input tokens still count against the combined
600,000-token ceiling. After the premise run alone, 11 requests and 521,807
input tokens are left, and a later small-group run gets only what the earlier
ones left.

The ledger can count only the files that are present. Each file must still
match the SHA-256 in its name, so an edited file is refused, but a removed
file is not detected. Only the premise run's observation is pinned: when it
is missing, when a file is edited, unreadable, or of an unknown kind, or
when an entry named `*.json` is not a file, the probe reports `not checked`
and sends nothing. Do not remove a retained file to free budget.

Once the plan fits, and before the first request, the run writes a
reservation to the same directory, named by its SHA-256 like an
observation. It charges everything the ledger has left, the most the run's
own gates let it spend. When the run finishes, it writes its observation and
only then removes the reservation, so the ledger charges what the run
actually spent. A run that stops before its observation is written, such as
one interrupted with Ctrl-C, leaves its lock and a reservation of everything
that was left. Once the lock is removed, the ledger has nothing left, so a
further small-group run needs a budget amendment from the cost owner.

#### Typed Slice 1b

Add `--answer-record-typed` to run phase A-t with the typed `submit_answer_record`
shell. It requires `--answer-records` and its corpus, and it cannot combine
with `--answer-record-small-groups`. The phase uses 2 KiB, 4 KiB, and 8 KiB
single-record rungs, each sent once per seed. Pi parses and validates each
response against the exact typed tool schema before the probe runs its strict
record decoder, matching the production validation order.

This mode prints `MEASURED`, `NO-GO`, or `INCONCLUSIVE` for A-t only. It does
not qualify a records capability or produce a `GO`. The planned guided phase G
is not executed: the current sealed request policy does not admit guided JSON
fields, so the observation records `request-policy-blocked` with zero requests.
This is distinct from a provider rejecting a typed tool response. Phase G
remains open for the request-policy qualification.

`MEASURED` reports typed-schema admission and carried bytes, not exact copying.
Each call records whether its canonical envelope matched the planned record;
the printed match count keeps that check separate. A same-size changed record
can therefore be measured without qualifying exact-copy behavior.

The typed request tranche allows up to 17 requests. A-t schedules nine at the
default sample count; the eight guided requests remain unspent while G is
blocked. The typed preflight requires the retained premise observation and
every content-addressed observation or reservation. It charges all prior
probe input tokens against the combined 600,000-token ceiling and subtracts
the shared retries already used from the approved pool. It reserves the
remaining typed tranche, input-token headroom, and retries before sending, so
an interrupted run stays charged. A valid typed observation uses the typed
request tranche and combined token ceiling; a later K plan counts its tokens
but not its requests against K's separate untyped request tranche.

Every record-probe run holds an exclusive lock, `ledger.lock` in the same
directory, from before it reads the ledger until its observation is kept,
and releases it when the run ends. When the lock cannot be removed, the
run's verdict stands and a warning with the code
`answer-record-ledger-lock-not-released` names the file. A run that finds the
lock reports `not
checked` with the code `answer-record-ledger-locked` and sends nothing. A run
that died leaves the lock, which is never broken automatically: confirm that
no record-probe run is alive, then remove the file the message names.
Ledger refusals carry the code `answer-record-ledger-invalid`.

The plan line names the requests, the re-sends that fit, the input tokens
planned, and the recorded spend. The probe refuses before sending anything
when the plan exceeds what is left, with the limit's code and remediation.
A re-send after a transport failure is paid from what is left only, and is
made only when it fits beside the remaining plan. It never draws on
`endpointProbe.answerRecordTransportRetries`, which the premise runs share.

For each group size, the command prints whether it was admitted for every
seed, the timing of each seed, and the implied M. It then prints the
projections. The verdict is `MEASURED` when every group size up to the first
one that was not admitted is decided, and `INCONCLUSIVE` when transport
failures or a budget left one undecided. An HTTP refusal is `NO-GO`, as in
the premise run. `MEASURED` exits 0. With `--json`, its `decision` is
`measured`, and `measurement.groups` and `measurement.projections` carry the
results.
