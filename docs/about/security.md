---
title: Security and Trust
sidebar-title: Security and Trust
description: Understand the trust model for DocsFab sessions, product evidence, credentials, and documentation delivery.
status: draft
content.type: concept
---

Security boundaries control which files, tools, credentials, and delivery
actions a model can access in [DocsFab](index.md). Repositories, model output,
provider responses, and command output supply data; they do not grant
authority.

Use these boundaries to understand what a local session can change and which
artifacts you can share. Exact controls, platform limits, storage details,
and refusal codes are in the
[DocsFab Security Reference](../reference/security-and-trust.md).

<Note title="Current Product Scope">
These controls describe the current local runtime and a separately gated
private pilot. They do not establish a released multi-tenant security model.
</Note>

## Boundaries at a Glance

The following table summarizes each boundary and its purpose.

| Boundary | Purpose |
| --- | --- |
| Repository to workflow workspace | Keep named workflow work bound to tracked files at a selected revision. |
| Workspace to model | Limit a workflow step to its allowed tools and context. |
| Live agent to checkout | Allow documentation-scoped edits and separately approved host commands. |
| Host credentials to providers | Retain configured credentials in fixed-purpose adapters, outside model prompts and durable evidence. |
| Result to delivery | Recheck authorization before a host action changes GitLab. |
| Skills to job | Bind executable skills and quality inputs through their catalog locks. |

## Trust Principles

The following principles explain the controls you encounter during work.

- Product evidence supports claims; it does not grant permission to write,
  merge, or publish.
- Direct live-agent edits are enabled by default. Read-only mode removes
  edit, write, and host-command tools.
- Host commands need terminal approval and use filesystem isolation.
  Approved commands can still use the host network and existing Git
  authentication.
- Named workflows retain their own tool, write-scope, and delivery checks.
- Raw run records and patches are private operator artifacts. Share sanitized
  projections of them.
- A resumed conversation cannot revive a revoked grant or override the current
  process flags.

<span id="authority-and-session-permissions"></span>
<span id="command-lifetime"></span>
<span id="linked-worktrees-and-git-metadata"></span>

For the exact controls, refer to
[Session Permissions](../reference/security-and-trust.md#authority-and-session-permissions),
[Command Lifetime](../reference/security-and-trust.md#command-lifetime), and
[Linked Worktrees](../reference/security-and-trust.md#linked-worktrees-and-git-metadata).

<span id="data-storage-retention-and-requests"></span>
<span id="local-cli-data"></span>
<span id="private-pilot-data"></span>

## Data Handling

Local sessions keep conversation and task state on your machine. The private
pilot has separate storage, retention, and request handling. A deletion on one
surface does not remove every copy.

Refer to [Local CLI Data](../reference/security-and-trust.md#local-cli-data)
for local storage and cleanup, or
[Private Pilot Data](../reference/security-and-trust.md#private-pilot-data)
for pilot retention and individual data requests.

<span id="outbound-proxy"></span>
<span id="credentials"></span>
<span id="doctor-output"></span>
<span id="refusal-codes"></span>
<span id="proxy-failures"></span>
<span id="where-a-model-key-is-sent"></span>
<span id="check-scripts"></span>

## Network and Model Access

Provider adapters control where a configured model key is sent. The optional
outbound proxy applies its own credential and destination controls. These
controls do not give a model unrestricted network access.

For exact behavior, refer to
[Outbound Proxy](../reference/security-and-trust.md#outbound-proxy),
[Proxy Credentials](../reference/security-and-trust.md#credentials),
[Doctor Output](../reference/security-and-trust.md#doctor-output),
[Refusal Codes](../reference/security-and-trust.md#refusal-codes), and
[Proxy Failures](../reference/security-and-trust.md#proxy-failures).
For model requests and validation commands, refer to
[Where a Model Key Is Sent](../reference/security-and-trust.md#where-a-model-key-is-sent)
and [Check Scripts](../reference/security-and-trust.md#check-scripts).

Operator output still directs the following codes to this overview. Continue
with the corresponding reference topic.

- `credential-endpoint-untrusted`:
  [Model Key Destinations](../reference/security-and-trust.md#where-a-model-key-is-sent).
- `outbound-proxy-auth-required`, `outbound-proxy-denied`,
  `outbound-proxy-invalid`, `outbound-proxy-not-enabled`, and
  `outbound-proxy-unreachable`:
  [Proxy Refusal Codes](../reference/security-and-trust.md#refusal-codes).

## Credential-Like Content

DocsFab distinguishes its own configured credentials from text that resembles
one. Exact configured credentials are refused at protected boundaries.
Credential-shaped text can instead become a finding for review. The behavior
depends on the output surface.

<span id="text-that-looks-like-a-credential"></span>
<span id="docsfabs-own-credentials"></span>
<span id="redaction"></span>
<span id="what-the-detector-flags"></span>
<span id="screens-that-flag-instead-of-refusing"></span>

Refer to
[Text That Looks Like a Credential](../reference/security-and-trust.md#text-that-looks-like-a-credential),
[DocsFab's Own Credentials](../reference/security-and-trust.md#docsfabs-own-credentials),
[Redaction](../reference/security-and-trust.md#redaction), and
[What the Detector Flags](../reference/security-and-trust.md#what-the-detector-flags).
The [Screen Behavior Reference](../reference/security-and-trust.md#screens-that-flag-instead-of-refusing)
explains surfaces that flag findings instead of refusing output.

## Related Documentation

Continue with the following pages for the relevant level of detail.

- [DocsFab Security Reference](../reference/security-and-trust.md): exact
  security, retention, and credential contracts.
- [Architecture Overview for DocsFab](architecture.md): component roles and
  data flow.
- [Documentation Jobs](core-concepts/documentation-jobs.md): what a result
  grants and how delivery differs from execution.
- [DocsFab Implementation Status](../reference/status-and-configuration/implementation-status.md): capability evidence and release boundaries.
