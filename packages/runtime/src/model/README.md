# Model configuration and provider boundary

This directory binds profiles to provider transports, applies request and turn
controls, and contains read-only catalog and governed profile operations. Start
with the [runtime source map](../README.md).

## Three layers

1. **Configuration and profile** select a provider ID, model ID, base URL,
   API format, transport, conservative effective limits, and profile metadata.
   `bindModelExecutionProfile` produces the execution profile and a separately
   held credential value.
2. **Provider connection** registers exactly that model and transport with Pi,
   confines requests to the configured origin and installed path where
   applicable, rejects redirects, bounds responses, and checks returned model
   identity where the selected connection supplies those controls.
3. **Turn policy** estimates request size, chooses an output allowance, compacts
   or stops a governed turn, accounts for retries, and emits inference evidence.

These are independent concerns. A profile digest does not contain a credential;
a credential does not choose a model or grant a tool; and a token budget does
not authorize provider access. Repository, tool, and write authority live at
the workflow, harness, execution-lease, and host boundaries.

## Execution paths

`createModelConnection` binds a `ModelEndpointConfig`, selects an exact
route-and-transport factory, validates the credential family, and creates the
Pi model connection. It never falls back to another route, model, transport, or
credential family.

The persistent local live-agent calls `createModelConnection(config.model)`
without workflow governance. It receives request budgeting, not workflow
leases. `PiHarness` runs can pass turn identity, cumulative limits, output
authority, retry policy, and lease callbacks for that attempt.

[`model-composition/`](../model-composition/) loads digest-bound route,
authentication, connection, harness, request-policy, candidate, and workflow
bindings. Candidate or catalog presence does not prove live support or approval.

[`native-compositions/`](../native-compositions/) owns Codex and Claude native
preflight and bounded pilot machinery. Installed native compositions remain
`preflight-only`, with model egress and workflow execution unavailable. Hosted `native-codex` and
`native-claude` routes therefore fail execution until a contained runner is
installed, as documented by the [hosted invoker](../host-invoker/README.md).

## Request and turn controls

`provider.ts` supports only its closed transport table. Its boundary fetch
requires the configured origin and disables redirects. That origin is HTTPS,
or plain HTTP only to `localhost`, an IPv4 address in `127.0.0.0/8`, or
`[::1]`; [`endpoint-transport.ts`](endpoint-transport.ts) owns that rule for
setup, configuration loading, connection creation, and the boundary. Plain
HTTP goes through [`loopback-http-fetch.ts`](loopback-http-fetch.ts), a direct
`node:http` transport that ignores proxy settings and resolves each connection
through a lookup that admits only loopback addresses. Request-path,
response-size, model-identity, and exact-credential response checks apply when
the caller supplies those options; they are not universal connection behavior.
For an Anthropic Messages connection with an installed path guard, the boundary
also permits only the Pi SDK's exact `?beta=true` query on that pinned path.
Other queries, fragments, credentials in the request URL, and route changes
remain refused. The payload send gate then refuses a request whose body is not
the payload the request policy authorized and sends its own serialization of
that payload. On the Anthropic Messages transport only, the SDK sends `betas`
as the `anthropic-beta` header, so the body must be the authorized payload
without `betas` and the header exactly those values joined by `,` in order.
Any other difference, including any other beta header, refuses as
`payload-send-mismatch`. The recorded payload digest still covers `betas`.
Setup reports the final request URL so compatible gateways can
be checked against the actual request destination.
It registers every model with `supportsStrictMode: false`, so no tool
declaration carries a `strict` field: the only value the harness could emit
here is `false`, and a front door that reaches Bedrock refuses the whole
request when it arrives.

`request-policy.ts` finalizes the installed NVIDIA API Catalog style OpenAI-chat
payload with a closed field set, DocsFab instruction, installed reasoning
control, deterministic sampling, output bound, and credential checks. It is not
a generic payload editor. Its one message transformation follows the sealed
`reasoningMode`: a reasoning-off policy omits the reasoning fields Pi replays on
an assistant turn, and the governed turn records the count beside the payload
digest. Every refusal carries a closed reason from `request-policy-refusals.ts`,
which also holds each reason's failure class and next action for failure
classification and `docsfab why`. An unmatched chat-completions endpoint that serves a
model an installed composition measured receives only that composition's
reasoning control, through `applyReasoningControl`; the binding attaches it as
`measuredReasoningControl` when the profile declares reasoning off.

`context-budget.ts` handles a single request's input estimate, reserved context,
minimum output, and effective configured limits. Without explicit turn
governance, `createContextBudgetedStream` uses that local preflight to clamp or
stop the request.

`turn-governor.ts` handles a governed sequence. It tracks provider turns, tool
evidence, compactions, recent tool groups, output authority, and a deterministic
evidence ledger. It can proceed, compact, or stop before provider access.
Workflow execution leases are deeper host-neutral contracts documented in
[execution leases](../../docs/reference/contracts/execution-leases.md).

`provider-turn-retry.ts` recognizes a closed set of retryable transport failures
and narrowly replayable empty turns. Retries use bounded deterministic backoff,
charge discarded-turn usage through callbacks, and never make local policy,
credential, response-size, or other non-retryable refusals transient.

## Catalog and profile operations

Catalog files define canonical observation, proposal, provenance,
reconciliation, and approval artifacts. `profile inspect` is local and
read-only unless catalog discovery is requested. Current discovery covers
NVIDIA Inference API plus Hub Metadata, OpenAI Models identity retrieve, and
Anthropic Models retrieve (`max_input_tokens` / `max_tokens`). Contracts for
unimplemented adapters do not make them live.

Profile approval and apply implement reviewed transactions over allowlisted
fields; inspection digests grant no apply authority. Operator details live in [model profiles](../../docs/reference/model-governance/model-profiles.md),
[catalog operations](../../docs/reference/model-governance/model-catalog-operations.md), and the [catalog contract](../../docs/reference/model-governance/model-catalog.md).

## File map

| Area | Maintainer purpose |
| --- | --- |
| [`configuration.ts`](configuration.ts) | Parse, diagnose, and bind endpoint profiles, limits, metadata, and credential family. |
| [`provider.ts`](provider.ts) | Exact transport factory, Pi registration, network boundary, response checks, and turn wiring. |
| [`request-policy.ts`](request-policy.ts) | Closed installed request finalization for supported policy routes. |
| [`context-budget.ts`](context-budget.ts) | Request token estimation, output clamp, and failure classification. |
| [`turn-governor.ts`](turn-governor.ts) | Multi-turn compaction, stop decisions, output authority, and evidence. |
| [`provider-turn-retry.ts`](provider-turn-retry.ts) | Bounded replay policy, blank-turn recognition, and accounting hooks. |
| [`outbound-http-policy.ts`](outbound-http-policy.ts) | Proxy resolution, built-in proxy enablement, the default outbound fetch, and the named proxy refusals. |
| [`outbound-proxy-classifier.ts`](outbound-proxy-classifier.ts) | Names an unreachable proxy and a 403 or 407 tunnel reply on a proxied request; leaves every other failure as it was. |
| `catalog-*.ts`, `inference-hub-metadata.ts`, `nvidia-inference-catalog.ts` | Read-only catalog evidence and reconciliation. |
| `profile-*.ts`, [`profile-apply/`](profile-apply/) | Inspection, approval, evidence, and transactional profile changes. |

## When to edit and verify

| Change | Focused evidence |
| --- | --- |
| Endpoint parsing or effective limits | [`provider.test.ts`](../../test/provider.test.ts), [`profile-environment.test.ts`](../../test/profile-environment.test.ts) |
| HTTPS origin, redirect, response, or model identity boundary | [`provider-network-boundary.test.ts`](../../test/provider-network-boundary.test.ts) |
| Request payload policy | [`provider-turn-governance.test.ts`](../../test/provider-turn-governance.test.ts) |
| Context and output calculations | [`context-budget.test.ts`](../../test/context-budget.test.ts), [`turn-governor.test.ts`](../../test/turn-governor.test.ts) |
| Retry and empty-turn behavior | [`provider-turn-retry.test.ts`](../../test/provider-turn-retry.test.ts) |
| Proxy resolution, refusals, and proxy failure codes | [`outbound-http-policy.test.ts`](../../test/outbound-http-policy.test.ts), [`outbound-proxy-classifier.test.ts`](../../test/outbound-proxy-classifier.test.ts), [`outbound-proxy-doctor.test.ts`](../../test/outbound-proxy-doctor.test.ts) |
| Catalog artifacts and reconciliation | [`model-catalog-contracts.test.ts`](../../test/model-catalog-contracts.test.ts), [`model-catalog-reconciliation.test.ts`](../../test/model-catalog-reconciliation.test.ts) |
| Profile inspection, approval, or apply | [`profile-inspection.test.ts`](../../test/profile-inspection.test.ts), [`profile-approval.test.ts`](../../test/profile-approval.test.ts), [`profile-apply.test.ts`](../../test/profile-apply.test.ts) |
| Native preflight versus execution capability | [`native-composition-preflight.test.ts`](../../test/native-composition-preflight.test.ts) |
