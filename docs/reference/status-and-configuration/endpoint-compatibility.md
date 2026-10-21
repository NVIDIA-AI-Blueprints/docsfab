---
title: "Endpoint Compatibility Reference in DocsFab"
description: "Look up the compatibility checks and verdicts shared by `docsfab profile probe --live` and `docsfab doctor --live`."
status: draft
content.type: reference
---

Look up the compatibility checks and verdicts shared by `docsfab profile probe --live` and `docsfab doctor --live`.

## Read the Endpoint Compatibility Verdict

With `--live`, the probe sends two streamed requests in the shape DocsFab's
harness sends: one turn that offers a tool, then one request for a single JSON
object. Both carry `stream_options.include_usage` and the output limit. They
use the output-limit field and instruction role DocsFab's provider sends on
that route: `max_tokens` and a `system` message under an installed request
policy or on the NVIDIA API Catalog, and otherwise the field and role the
provider picks for the endpoint and profile, such as `max_completion_tokens`.
After a refused request, the probe sends no further compatibility requests.
The request-policy samples also stop after a client error other than 408 or
429, such as a retired model's 410, so that case costs one request. `profile probe` uses the `endpointProbe.maxOutputTokens`
limit, 4,096 tokens by default. When the request-policy verdict is
`reasoning-split-controllable`, the requests also carry
`chat_template_kwargs.thinking=false`, the control a drafted policy installs.

Every probe request crosses the same network boundary as DocsFab's provider
requests. The probe stays on the configured origin, never follows a redirect,
sends plain HTTP only to loopback, and bounds each response by
`compositionExecution.maxResponseBytes`. A plain-HTTP `localhost` endpoint that does not
resolve only to loopback is refused before any request carries the
credential.

`docsfab doctor --live` runs the same checks against your configured endpoint
before its connectivity turn. It sends the bound composition's request policy
and your effective output limit, which is the `effective-output` value doctor
prints.

The report names one of the following verdicts:

- `compatible`: every check passed.
- `incompatible`: at least one check failed.
- `inconclusive`: no check failed, but at least one could not decide.
- `not-checked`: the endpoint's transport is not OpenAI-compatible chat
  completions, which the probe speaks. For example, an OpenAI profile on
  `openai-responses` reports `not-checked`, and doctor's connectivity turn
  checks that transport instead.

Each check reports `pass`, `fail`, `inconclusive`, or `not-checked`, a
finding, and a detail line. A failed or inconclusive check also names a
cause, its owner, and one next action. Owners and causes use the same values
as DocsFab's run diagnosis, so the owner is one of `provider-capacity`,
`output-limit`, `contract-shape`, `model-content`, `operator-configuration`,
or `docsfab-defect`.

The following table lists each check with its failing findings, cause, and owner.

| Check | Failing findings | Cause | Owner |
| --- | --- | --- | --- |
| `availability` | `end-of-life` (HTTP 410, or an end-of-life notice) | `provider-model-retired` | `operator-configuration` |
| `availability` | `model-not-found` (HTTP 404), `output-limit-rejected` (the endpoint refused the output limit), `request-rejected` (any other 4xx) | `provider-request-refused` | `operator-configuration` |
| `availability` | `redirected` (the request, with its credential, reached the endpoint, which redirected; DocsFab does not follow) | `provider-request-refused` | `operator-configuration` |
| `availability` | `response-rejected` (the boundary rejected the response framing, such as a malformed `Content-Length`) | `reply-shape-rejected` | `contract-shape` |
| `availability` | `credential-rejected` (HTTP 401 or 403) | `provider-auth-refused` | `operator-configuration` |
| `availability` | `boundary-refused` (origin, path, or loopback refusal before sending), `unreachable` (a transport failure other than a proxy refusal, which fails the command with its own code) | `request-not-sent` | `operator-configuration` |
| `availability` | `response-too-large` (over `compositionExecution.maxResponseBytes`) | `operational-limit-reached` | `operator-configuration` |
| `availability` | `rate-limited` (HTTP 429) | `provider-rate-limited` | `provider-capacity` |
| `availability` | `provider-unavailable` (HTTP 5xx) | `provider-server-error` | `provider-capacity` |
| `availability` | `timeout` (over `endpointProbe.requestTimeoutMs`) | `provider-timeout` | `provider-capacity` |
| `availability` | `probe-defect` (the probe failed inside DocsFab) | `uncatalogued-failure` | `docsfab-defect` |
| `streaming` | `stream-error-event` with a server-fault type or a 429 or 5xx code | `provider-stream-error` | `provider-capacity` |
| `streaming` | `stream-error-event` with any other code | `provider-request-refused` | `operator-configuration` |
| `streaming` | `not-event-stream`, `unterminated-stream` | `reply-shape-rejected` | `contract-shape` |
| `tool-calls` | `tool-call-in-text` (the call arrived as text, not `tool_calls`) | `reply-shape-rejected` | `contract-shape` |
| `tool-calls` | `malformed-arguments` | `reply-not-json` | `contract-shape` |
| `tool-calls` | `no-tool-call`, `unknown-tool` | `reply-content-rejected` | `model-content` |
| `structured-output` | `malformed-json` | `reply-not-json` | `contract-shape` |
| `structured-output` | `contract-mismatch` (JSON, but not the requested object) | `reply-shape-rejected` | `contract-shape` |
| `structured-output` | `empty-reply`, `reasoning-only-reply` | `reply-blank` | `model-content` |
| `output-limit` | `length-cut` (`finish_reason=length` at the output limit) | `output-allowance-reached` | `output-limit` |

A reply cut at the output limit before the tool call or the JSON object marks
that check `inconclusive` with finding `cut-by-output-limit`. The cut does not
show that the model lacks the capability. The `output-limit` check fails, and
its next action tells you to raise the limit or select another model.

For example, a retired model answers HTTP 410, and the text output quotes the
provider:

```text
Endpoint compatibility: incompatible (max output tokens 4096)
  availability: fail (end-of-life). HTTP 410: the provider no longer serves this model.
    Provider said: "The model 'nvidia/nemotron-3-nano-30b-a3b' has reached its end of life on 2026-09-01T09:00:00Z and is no longer available."
    Owner: operator-configuration (cause provider-model-retired)
    Next action: Select a model the provider still serves: run `docsfab composition list`, then `docsfab setup --profile <composition-id>`.
```

The checks that did not run print as `not-checked`. In `--json` output, the
same report is the `compatibility` field, with `schemaVersion`, `kind`
(`docsfab-endpoint-compatibility`), `verdict`, `maxOutputTokens`, and
`checks`. Each check carries `id`, `status`, `finding`, `detail`, `cause`,
`owner`, and `nextAction`. A refused request adds `httpStatus`,
`providerMessage`, and `providerMessageTruncated` when the body was longer
than `endpointProbe.providerMessageMaxChars`. DocsFab reads the provider's
message from the whole response body or in-stream error event. Before it
applies that bound, it replaces with `[REDACTED]` every run of
`endpointProbe.credentialEchoMinChars` or more characters copied from the
credential, and every credential-shaped value. A run counts whether the
provider wrote it raw, JSON-escaped, or URL-encoded, and whether or not
invisible characters, spaces, or line breaks split it, so a truncated or
masked echo of the key is removed as well as a whole one. It then removes URLs,
email addresses, control, bidirectional, and zero-width characters, and
account, function, organization, and request identifiers from the quoted
message.

When a check's `detail` names a reply's finish reason, it is one of `stop`,
`length`, `tool_calls`, `content_filter`, or `function_call`. Any other value
the provider sends appears as `unrecognized`, as in
`finish_reason=unrecognized`, and an absent one as `none`. DocsFab never copies
the provider's own string.

`docsfab doctor --live` blocks readiness on a failed check. It reports
diagnostic `endpoint-incompatible`, or `provider-live-unavailable` when the
failure is provider capacity. Its next command is the failed check's next
action. The readiness record carries the report as `endpointCompatibility`.

## Authoritative Sources

The following sources define the behavior this page describes:

- [Profile probe implementation](../../../packages/runtime/src/cli/profile-probe.ts)
- [Endpoint compatibility checks](../../../packages/runtime/src/profile/endpoint-compatibility.ts)
- [Probe stack](../../../packages/runtime/src/profile/probe-core.js)
- [Profile draft implementation](../../../packages/runtime/src/cli/profile-draft.ts)
- [Reseal composition digests](../../../packages/runtime/scripts/reseal-composition-digests.mts)
