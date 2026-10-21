---
title: DocsFab Operator Error Envelope
description: Look up the DocsFab operator error envelope schema and situation-class docs anchors.
status: draft
---

DocsFab CLI, doctor, and init failures that reach the operator boundary
use one JSON object: schema version 1, kind `docsfab-operator-error`. The
machine identity is `code`. That value is the thrown `error.code` after
kebab-case sanitization. Agents consume `--json`. Do not scrape the human
lines. For more information, refer to [DocsFab Status and Configuration
Reference](index.md).

This page documents that envelope schema. It is not a catalog of contract
stems, first-pass support rules, or doctor diagnostic codes. For the
class map of every operator-visible stop, refer to
[Stop Classes in DocsFab](stop-classes.md).
For symptom-led recovery, refer to
[Troubleshooting DocsFab](../../troubleshooting.md).

## Identity Rules

The following rules are frozen for schema version 1:

- `kind` is always `docsfab-operator-error`.
- `schemaVersion` is `1`. There is no schema version 2 field on this
  envelope.
- `envelope.code` is `error.code` when that code is lowercase kebab-case.
  A code that fails the pattern becomes `operator-error`.
- Optional `nextAction`, `docsAnchor`, and `details` are derived at the
  operator boundary. They do not replace `code`.

Leaked contract stems such as `invalid-shape` remain valid `code` values
when a closed schema throws them. They are not troubleshooting situation
headings. Doctor diagnostics such as `project-config-missing` are a
separate closed family on
[Runtime Readiness and Doctor Checks in DocsFab](../../manage/check-readiness.md).

## Required Fields

`--json` always includes the following fields: `schemaVersion`, `kind`,
`code`, and `message`.

The following table lists the value of each required field.

| Field | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `docsfab-operator-error` |
| `code` | Lowercase kebab-case machine identity, copied from `error.code` |
| `message` | Credential-scrubbed operator sentence |

A representative identity-pass payload looks like this:

```json
{
  "schemaVersion": 1,
  "kind": "docsfab-operator-error",
  "code": "invalid-shape",
  "message": "External-input contract rejected: invalid-shape.",
  "nextAction": "Inspect the rejected artifact against the published contract schema, then retry with a conforming payload."
}
```

That example has no `docsAnchor` because `invalid-shape` is a contract
stem, not a situation-class docs target.

## Optional Fields

The serializer omits an optional field when it is empty. The following
table lists the optional fields.

The following table lists each optional field and when it appears.

| Field | When it appears |
| --- | --- |
| `nextAction` | A situation-class next action, inferred remediation, or throw-site action exists |
| `docsAnchor` | A repo-relative Markdown path is configured for that `code` or remediation |
| `failure` | Always written by current builds: the failure class, layer, and classified code |
| `details` | The throw is a recognized host failure type with content-free evidence |
| `originalRequestCompletion` | First-pass support projected `complete` or `incomplete` |
| `draftApplicability` | First-pass support projected a draft class |
| `documentationPartialLocator` | A host-held draft locator string is present |

`draftApplicability` is one of `useful-partial`, `scaffold-only`,
`no-useful-deliverable`, `cancellation`, or `execution-failure`.

`details.kind` is one of the following recognized evidence shapes:

- `docsfab-proposal-scope-admission-failure`
- `docsfab-first-pass-support-failure`
- `docsfab-first-pass-evidence-gap`
- `docsfab-repository-workspace-materialization-failure`

Those objects carry digests, phases, rules, counts, and limits. They do
not echo rejected target text, prompts, or credential values. First-pass
`rule` names stay inside `details`. They are not public situation ids.

## Failure Class

`failure` names why the command failed, as one value from a closed list,
so reports can count failures by cause. It has exactly the following three
fields.

| Field | Value |
| --- | --- |
| `class` | One failure class, such as `auth`, `operator-input`, or `model-content` |
| `layer` | `cli` for an operator-boundary refusal, or `inference` when a model attempt caused it |
| `code` | The catalogued code the class was read from |

Each situation catalog row carries its class, so `code` usually equals the
envelope `code`. A first-pass stop names its rule instead. An inference
failure names its coded rejection, or the provider error its attempt recorded,
such as `provider-http-auth` for an HTTP 401. When the model request layer
wrapped another error, the envelope names that error's own code, the same code
the failed run records. A refusal at a catalogued operational limit carries
that limit's `refusal` from `config/limits/` as its `code`, such as
`autonomy-authorization-window-ms-bound`, and its class is `bound`. Earlier
versions reported these refusals as `operator-error`. A code that no catalog row or table names
reads as `unknown` with that code, which shows what still needs a class. The class of a
failed installed quality pack follows the error type, not the code. That failure reads
`infrastructure` with any pack code, while other errors that reuse a pack code, such as
`unsafe-path` from a repository check, stay `unknown`. For
the full list of classes, refer to
[Failure Classes](stop-classes.md#failure-classes).

A classified payload looks like this:

```json
{
  "schemaVersion": 1,
  "kind": "docsfab-operator-error",
  "code": "gitlab-unauthenticated",
  "message": "GitLab rejected the request for the selected host.",
  "nextAction": "Run `glab auth login --hostname <host from the selected remote>`; no SCM credential is stored by DocsFab.",
  "failure": { "class": "auth", "layer": "cli", "code": "gitlab-unauthenticated" }
}
```

## Human Lines and JSON

Human stderr (or the reporter's write callback) prints the message, then
these lines when the fields exist:

```text
code: <code>
failure class: <class> (layer <layer>)
Next action: <actionable sentence>
Docs: <repo-relative Markdown path>
```

The `failure class:` line adds `, code <code>` inside the parentheses when
the classified code differs from `code:`. `--json` always includes `code`.
Additional `Evidence:`, original-request, draft-applicability, and
host-held draft locator lines appear only when the matching optional
fields are present.

`Docs:` stays a repository-relative path such as
`docs/troubleshooting.md`. When Fern publishes that
file, the site route is the path under `docs/` without the `docs/` prefix
or `.md` suffix, for example
[Troubleshooting DocsFab](../../troubleshooting.md). Printed
operator output does not substitute that URL for the `Docs:` line.

## Credential Scrub

Every operator string is scrubbed before it leaves the envelope. The
boundary redacts credential-shaped tokens, HTTP and HTTPS URLs, and host
paths under `Users`, `home`, or `root`. Replacements are `[REDACTED]`.
JSON pointers such as `$.packet` remain visible. Origin-only HTTPS URLs
that match an installed executable route remain visible so a
`deployment-binding-mismatch` refusal can name the recorded origin. URLs
with a path, query, fragment, username, or password still redact,
including those same hosts.

## Situation-Class Docs Anchors

Situation-class recovery headings are the `DEFAULT_DOCS_ANCHORS` keys
that already have a docs path, plus doctor diagnostics as a separate
family. They are not the full next-action map and not the contract-stem
set.

Each of the following pages names the `code` it documents. Each code whose
`Docs:` path is `docs/troubleshooting.md` has a row in the
[Error Messages](../../troubleshooting.md#error-messages) table on that page. The following table
maps each situation-class `code` to its docs path and published page.

The following table lists each snapshotted code, its `Docs:` path, and its published Fern page.

| `code` | `Docs:` path | Published Fern page |
| --- | --- | --- |
| `migration-required` | `docs/about/architecture.md` | [DocsFab Architecture](../../about/architecture.md) |
| `cli-usage` | `docs/reference/status-and-configuration/human-output-and-json.md` | [Human Output and JSON](human-output-and-json.md) |
| `doctor` | `docs/manage/check-readiness.md` | [Check Readiness](../../manage/check-readiness.md) |
| `profile-inspect` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `profile-inspection-clock-invalid` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `profile-evidence-invalid` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `invalid-model-profile-configuration` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `unsupported-model-profile-api-format` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `invalid-model-profile-approval` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `profile-apply-rejected` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `profile-owner-artifact-rejected` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `profile-apply-ambiguous` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `profile-rollback-ambiguous` | `docs/reference/status-and-configuration/model-profile-approval.md` | [Model-Profile Approval](model-profile-approval.md) |
| `glab-auth-login` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `aggregate-timeout` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `per-blob-timeout` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `source-authority-path-refused` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `composition-retired` | `docs/configure/model.md` | [Configure the Model](../../configure/model.md) |
| `setup-model-choice-required` | `docs/configure/model.md` | [Configure the Model](../../configure/model.md) |
| `profile-seed-choice-required` | `docs/reference/status-and-configuration/model-profile-fields.md` | [Model-Profile Fields](model-profile-fields.md) |
| `deployment-binding-mismatch` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `model-endpoint-insecure-transport` | `docs/configure/model.md` | [Configure the Model](../../configure/model.md) |
| `tracked-source-dirty` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `not-a-git-repository` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `not-repository-root` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `unsafe-git-configuration` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `git-identity-drift` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `git-configuration-refused` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `git-checkout-unverified` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `ambiguous-remote` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `repository-mismatch` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `first-pass-support-invalid` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `required-source-unread` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `preflight-budget-exceeded` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `content-index-refused` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `content-index-unreadable` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `context-compile-failed` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `navigation-alias-refused` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `empty-page-anchor` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |
| `duplicate-page-anchor` | `docs/troubleshooting.md` | [Troubleshooting DocsFab](../../troubleshooting.md) |

A missing-profile `migration-required` throw can override that stem's
architecture page and send `Docs:` to
[Install DocsFab](../../get-started/installation.md) through the
`profile-seed` remediation.

## Related Topics

For more information, refer to the following pages:

- [Runtime CLI and Configuration in DocsFab](runtime-cli-and-configuration.md)
- [Runtime Readiness and Doctor Checks in DocsFab](../../manage/check-readiness.md)
- [Troubleshooting DocsFab](../../troubleshooting.md)
- [DocsFab Implementation Status](implementation-status.md)
