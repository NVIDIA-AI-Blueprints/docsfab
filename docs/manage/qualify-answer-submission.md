---
title: "Check Answer Submission Capability in DocsFab"
description: "Inspect recorded answer-submission capability or run the explicit live qualification probe. A probe records evidence; it does not approve a release."
status: draft
content.type: how-to
---

Inspect recorded answer-submission capability or run the explicit live qualification probe. A probe records evidence; it does not approve a release.

## Answer Submission

Offline doctor prints an `Answer submission` line. It names the
`DOCSFAB_ANSWER_SUBMISSION` value, whether the bound route recorded an answer
submission and with which argument shell, and the path the final quality
evaluator in `review-documentation` takes, with the reason each run records:
`tool-call (recorded-route)`, `text-final (not-recorded)`, or
`text-final (operator-override)`.

`docsfab doctor --live --answer-submission` qualifies a route for the
tool-call path. It runs offline readiness, then sends content-free
`submit_quality_evaluation` requests through the same binding, request
policy, effective output limit, and network boundary that run requests use,
and nothing else that spends requests. Each variant is sent
`endpointProbe.answerSubmissionSamples` times (three by default). The plan is
the untyped shell (V1), a duplicate key (V3), a line break inside a string
(V4), and a nested object of about 20 KB (V6), so 12 requests. Every sample of
the chosen shell must carry a submission call that the host's strict decoder
admits; a member that arrives as one JSON string holding its value counts when
the decoder admits it.

The typed-shell contingency sends V2, then V3, V4, and V6 again with the typed
shell. It is needed when the untyped V1 is not usable, or when the untyped V4
or V6 is not. It spends past the nominal plan, so it runs only with
`--answer-submission-typed-contingency`. Without that flag, the probe stops
before the contingency and prints `CONTINGENCY REQUIRED` with the most
requests the contingency would add. At the default limits, one run sends at
most 14 requests without the flag and at most 26 with it.

The large-object variant runs on the bound composition's attempt timer, the
most time a production submission turn has; the others use
`endpointProbe.requestTimeoutMs`. A large-object request that ends without an
HTTP response is sent again, each sample at most once and at most
`endpointProbe.answerSubmissionTransportRetries` times in all (two by default).
Other variants are not retried. Every request that ends without an HTTP
response records a transport class (`timeout`, `reset`, `byte-bound`, or
`other`), how long it ran, and the bytes that arrived.

The command prints one of the following four verdicts:

- `GO`, with the capability to record: argument shell, duplicate-key
  observation, `objectMembers` (whether members arrived as objects, as
  strings, or mixed), and report-turn `tool_choice`, which is always `auto`.
- `NO-GO`, with a `provider-compatibility` stop class, its cause, and the next
  action. A shell or decoder failure is named first; then a large object cut at
  the output limit, over the response byte bound, or timed out at the attempt
  timer twice while still streaming (`timer-fit`); then a missing tool call;
  then an HTTP refusal.
- `INCONCLUSIVE`, when transport failures kept the probe from a verdict. It
  lists each failure and has no stop class. Probe again later.
- `CONTINGENCY REQUIRED`, when only the typed shell can qualify the route and
  the contingency flag was not given. It has no stop class. Ask the cost owner,
  then rerun with `--answer-submission-typed-contingency`.

It writes the content-free observation under `answer-submission-probes/`
beside the run state directory, named by its SHA-256, which is the
`evidenceSha256` a composition records. The command exits nonzero unless the
verdict is `GO`: `NO-GO` and `INCONCLUSIVE` exit 1, and `CONTINGENCY REQUIRED`
exits 2. Add `--json` for a `docsfab-answer-submission-probe-result` record,
whose `decision` is `go`, `no-go`, `inconclusive`, `contingency-required`, or
`not-checked`.

`docsfab profile probe` uses the same spend gate and the same probe stack.
The default invocation does not contact a serving route. Add `--live` to run
the request-policy probe and the endpoint compatibility probe. Refer to
[Profile Probe and Draft in DocsFab](../configure/probe-model-route.md).

By default, `profile inspect` summarizes the active model, provider route,
readiness and fallback status, effective limits, catalog-check status, and
next action. Add `--verbose` for the detailed audit view. Use
`--json` for canonical evidence in automation or approval workflows.

Do not copy provider or GitLab credentials into the project file, prompts,
or run records.
