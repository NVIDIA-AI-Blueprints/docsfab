---
title: "Probe a Model Route in DocsFab"
description: "Check an exact model and serving route before drafting a composition. The default probe is offline; `--live` sends model requests."
status: draft
content.type: how-to
---

Check an exact model and serving route before drafting a composition. The default probe is offline; `--live` sends model requests.

## Prerequisites

Install DocsFab, identify the exact served model ID, and configure the route's credential before a live probe.

## Steps

Use the command and checks below.

## Probe One Route

Replace `MODEL_ID` with the exact model ID that the route serves:

```bash
docsfab profile probe --route nvidia-inference-api \
  --model MODEL_ID
docsfab profile probe --route nvidia-inference-api \
  --model MODEL_ID --live --json
```

The default, offline invocation does not spend. It prints that live inference
was not requested, plus a credential-free locator. Add `--live` to run the
request-policy probe and the endpoint compatibility probe. That spend gate
matches `docsfab doctor --live`: no `--live` means no model request.

`--live` uses the same probe stack as
`packages/runtime/scripts/model-matrix/probe-models.mjs`. The stack lives in
`src/profile/probe-core.js`, so the installed package ships it. Do not run a
second HTTP probe.

Observation fields are the request-policy verdict, the locator, and the
endpoint compatibility report. They never include credentials, model reply
text, or Hub Metadata payloads. When the provider refuses a request, the report
quotes the provider's own message after DocsFab removes credentials, URLs, and
account, function, and request identifiers.

Use an exact Hub or OpenAI model id. Prefix matchers fail closed with a stable
error:

```text
profile probe rejects prefix matchers; use an exact Hub or OpenAI model id.
```

The following OpenAI-compatible chat-completions routes are supported today:

- `nvidia-inference-api`
- `nvidia-api-catalog`
- `openai-api`

## Interpret The Verdict

The following table describes each verdict and its draft.

| Verdict | Meaning | Draft |
| --- | --- | --- |
| `harness-compatible` | Text arrived in `content`. | Omit `requestPolicy` when the route marks the policy optional. |
| `reasoning-split-controllable` | `chat_template_kwargs.thinking=false` restored `content`. | Include the measured request policy. |
| `reasoning-split-uncontrolled` | The split remains. | Draft refuses. |
| `unreachable` | Endpoint, credential, or model problem. | Draft refuses. |

A proxy refusal is not an `unreachable` verdict. When a proxy setting or the
proxy itself refuses any probe request, `profile probe --live` fails with the
refusal's `outbound-proxy-*` code and next action, even when another sample
answered. For the codes, refer to
[Proxy Failures](../reference/security-and-trust.md#proxy-failures).

The NVIDIA Inference API route marks the installed request policy optional.
Harness-compatible models on that route, including OpenAI SKUs served through
the hub, omit the Nemotron control. The NVIDIA API Catalog route requires a
measured policy, so draft accepts it only for
`reasoning-split-controllable`.

## Related

Use these topics for the supporting contracts and next actions.

- [Endpoint Compatibility Reference](../reference/status-and-configuration/endpoint-compatibility.md)
- [Draft a Composition Record](draft-composition.md)

## Earlier Section Links

<a id="read-the-endpoint-compatibility-verdict"></a>

Refer to [Read The Endpoint Compatibility Verdict](../reference/status-and-configuration/endpoint-compatibility.md#read-the-endpoint-compatibility-verdict).

<a id="authoritative-sources"></a>

Refer to [Authoritative Sources](draft-composition.md#authoritative-sources).

<a id="draft-a-composition-record"></a>

Refer to [Draft A Composition Record](draft-composition.md#draft-a-composition-record).
