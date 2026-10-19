---
title: Model-Profile Approval in DocsFab
description: Distinguish the current approval-bundle schema (version 1) from target model, route, harness, and qualification composition.
status: draft
---

DocsFab does not assume that every model comes from NVIDIA Inference Hub. The
target design composes provider-specific model evidence with serving-route,
harness, and role evidence without pretending that the current bundle (schema
version 1) already carries every binding. For more information, refer to [DocsFab Status
and Configuration Reference](index.md).

Operator failures that select envelope code `profile-inspect` or
`profile-evidence-invalid` print this page as `Docs:`. The two codes lead to
different next actions, as the following list shows:

- `profile-inspect`: other profile provenance failures, for example from
  `docsfab run`. The next action is `docsfab profile inspect`. Use
  `docsfab profile approve` only for exact reviewed evidence.
- `profile-evidence-invalid`: DocsFab cannot build model profile evidence from
  the configured profile. `docsfab profile inspect` and the IA corpus
  preflight print this code, so its next action does not repeat
  `profile inspect`. The message names the field and the `MODEL_*` or
  `JUDGE_*` setting that supplies it, such as `MODEL_ID` or `JUDGE_PROVIDER`.
  It never prints the configured value. Correct that setting in the
  environment or the DocsFab configuration root, then run `docsfab doctor`.

The `profile-inspection-clock-invalid` code means inspection time was invalid
or moved backwards while collecting evidence. Correct host clock
synchronization before generating fresh evidence. Preserve saved reports and
do not approve output from the failed inspection.

Approval failures use the following separate codes so their recovery does not repeat the
failed command:

- `invalid-model-profile-configuration` lists invalid setting names without
  printing their configured values. Correct those settings, then run
  `docsfab doctor` to confirm the profile loads.
- `unsupported-model-profile-api-format` names `MODEL_API_FORMAT` or
  `JUDGE_API_FORMAT`. Select a format supported by the configured route, then
  run `docsfab doctor`.
- `invalid-model-profile-approval` means the inspected proposal or its signed
  evidence failed validation. Run `docsfab profile inspect --catalog --json`
  and review that exact report before continuing.
- `profile-apply-rejected` gives a content-minimized refusal. Run
  `docsfab doctor` and correct any reported configuration issue before
  retrying the requested profile operation.
- `profile-owner-artifact-rejected` means an owner-controlled inspection,
  signing-key, approval-bundle, or model-profile file could not be read
  safely. Restore the intended artifact from its owner-controlled source,
  keep key material private, and have its owner verify it before continuing.
- `profile-apply-ambiguous` and `profile-rollback-ambiguous` mean a transaction
  may have completed only in part. Do not retry the operation or begin another
  profile mutation. Preserve the configuration root, transaction markers, and
  staged receipts for the configuration-root owner to reconcile first.

Profile option errors use `cli-usage`; the next action points to `docsfab
--help` instead of repeating the failed profile subcommand. If `profile seed`
has no preset, choose a provider and model with `docsfab setup` and enter
`MODEL_API_KEY` through its hidden prompt.

`docsfab doctor`, with or without `--catalog`, applies the same evidence rule
to the policy profile and to an enabled judge profile once the profile loads. It reports a defect as
the diagnostic `provider-profile-evidence-invalid`, with the same message and
next action. The diagnostic clears only after the named setting is corrected,
so re-running doctor confirms the fix.

For the envelope schema, refer to
[DocsFab Operator Error Envelope](operator-error-envelope.md).

The review date is an advisory reminder, not an expiry. After
`MODEL_PROFILE_REVIEW_AFTER` or `JUDGE_PROFILE_REVIEW_AFTER` passes, the
profile stays `current`: DocsFab keeps the configured token limits,
capabilities, and prices, and no command refuses on the date. Inspection does
not apply an 8,192-token ceiling to a current or unknown profile.
`docsfab profile inspect`, `docsfab doctor`, and the run summary of a run that
started after the date print a `Review overdue` line with the date.

To act on the reminder, do the following:

- Re-inspect: run `docsfab profile inspect --catalog --json` and compare the
  provider's current limits.
- Re-approve: pass that exact reviewed report to `docsfab profile approve`.

Change `MODEL_PROFILE_REVIEW_AFTER` or `JUDGE_PROFILE_REVIEW_AFTER` only
after that review. Run records and reports saved before review dates became
advisory can still show status `stale`.

## Choose an Evidence Lane

The following table lists each evidence lane and what it establishes.

| Lane | Current purpose | What it establishes |
| --- | --- | --- |
| NVIDIA catalog approval | `docsfab profile inspect --catalog` and `docsfab profile approve` | Technical evidence for the NVIDIA Inference API plus authenticated Inference Hub Metadata route and a `policy` or `judge` purpose. |
| Pi composition execution | `docsfab run <workflow> --composition <id>` | A bounded NVIDIA, OpenAI, or Anthropic workflow experiment. It does not establish technical approval, role qualification, or release eligibility. |
| Native-harness preflight | `docsfab composition preflight --composition <id>` | Codex or Claude Code CLI, authentication, and catalog readiness. It makes no model request and does not execute a workflow. The Claude Code preflight is provider-offline; the Codex preflight makes one authenticated read of the ChatGPT account's model catalog. |
| Cross-harness development pilot | `docsfab composition pilot-campaign …` | Live, explicitly acknowledged, uncontained development evidence across harnesses. It provides no ranking, approval, qualification, release, or merge authority. |
| Role qualification | Frozen corpus, role-local evaluation, and independent review | Planned qualification evidence. The current runtime does not enforce the composite selector. |

Do not move evidence between lanes. In particular, direct-provider composition-execution
results and native-harness preflight cannot produce the current NVIDIA
technical-approval bundle.

## Approval Bindings

The following table lists the approval bindings, with examples.

| Binding | Examples |
| --- | --- |
| Model identity | GPT, Claude, Nemotron |
| Serving route | OpenAI API, Anthropic API, NVIDIA Inference API, Bedrock, hosted or local NIM |
| Execution harness | Pi, Codex, Claude Code |
| DocsFab purpose | Writing, review, judge, audit, retrieval |

Changing a serving route or harness requires new evidence even when the model
name stays the same. The applicable serving-route, harness, and interface
bindings select an evidence-adapter set. Each adapter can read only its
credential family. Credentials remain in the host boundary and never enter
approval artifacts or the repository.

The current signed bundle (schema version 1) binds only a `policy` or `judge`
purpose, exact model/provider/origin catalog evidence, operator, and dates. It does not bind a
Codex or Claude Code harness identity or a writing, review, audit, or retrieval
qualification. Those are target bindings for a future composite schema or
credential-free approved lock.

## Current Adapter Support

The CLI implements the following three technical catalog-approval adapter sets for policy
and judge profiles:

- NVIDIA Inference API `/v1/models` plus authenticated Inference Hub
  Metadata evidence
- Direct OpenAI API `GET https://api.openai.com/v1/models/{id}` using the
  OpenAI credential only. Retrieve observes model identity. It does not
  observe token limits, so a signed technical-approval bundle cannot complete
  from this adapter alone.
- Direct Anthropic API `GET https://api.anthropic.com/v1/models/{id}` using
  the Anthropic credential only. Retrieve maps `max_input_tokens` and
  `max_tokens` into the combined-context approval envelope.

Direct OpenAI and Anthropic routes never read
`INFERENCE_HUB_METADATA_API_KEY`. Hub Metadata remains NVIDIA-only.

A separate explicit composition-execution lane implements direct NVIDIA, OpenAI, and
Anthropic provider connections behind Pi. Composition execution and technical
approval remain different state machines. Hosted or local NIM approval
adapters remain unimplemented.

The installed Codex and Claude Code compositions are preflight-only. They
inspect bounded CLI, authentication, and catalog facts without a model request
or workflow execution. The Claude Code preflight is provider-offline. The
Codex preflight makes one authenticated read of the ChatGPT account's model
catalog; no prompt, repository content, or credential is sent to Codex. Claude Code cannot advance to
inference while descendant containment is unavailable. Codex cannot advance
while the installed CLI cannot capability-disable native tools before egress.
No external-harness role is currently qualified. The embedding/retrieval
interface adapter remains unimplemented.

The separate `pilot-campaign` command can collect live cross-harness
development evidence only after the operator acknowledges the uncontained
boundary and supplies canonical executable paths plus owner-private durable
state. Its host-derived evaluation remains unattested proxy evidence. It does
not rank candidates or establish approval, qualification, release, or merge
authority.

A composition can require more than one adapter. None requires an Inference
Hub Metadata credential merely because the model is GPT, Claude, or Nemotron.

Do not substitute the NVIDIA two-source adapter for another route. Direct
OpenAI and Anthropic have their own catalog-approval adapters. Composition-execution
evaluation still does not by itself produce an approval bundle. Use
`docsfab profile inspect --catalog` on the bound serving route, then
`docsfab profile approve`. Native preflight is not workflow-qualification
evidence. Hosted or local NIM and embedding adapters remain unimplemented.

The external harness qualification decision
defines the exact boundary, frozen role-local corpus, and closed failure model.

The
[runtime approval-operations runbook](../../../packages/runtime/docs/reference/model-governance/model-catalog-operations.md)
contains the normative status and credential matrix.

For direct-provider profiles, use authoritative provider evidence such as
[OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
or the [Claude Platform documentation](https://platform.claude.com/docs/en/intro),
then bind the exact deployment and organization policy used by DocsFab.

## Approval Sequence

1. Select the candidate and DocsFab role.
2. Bind the model, serving route, and harness identities.
3. Select the matching evidence-adapter set and provide only its host-managed
   authentication.
4. Inspect and normalize provider or harness evidence.
5. Reconcile observed, unknown, conflicting, and unsupported fields with the
   policy for that adapter set.
6. Preview and sign the exact technical proposal without changing
   configuration.
7. Apply the saved bundle using its exact bundle and patch digests.
8. Run offline diagnostics and an explicitly authorized live check.
9. Run the frozen workflow-qualification suite for the intended role.
10. Refresh when the provider, model, or route changes, or roll back from the
    exact receipt. The review date prompts that review; it does not expire the
    profile.

## Composition Execution and Preflight Status

Inspect the installed composition package without provider egress:

```bash
docsfab composition list
```

A composition-execution workflow requires an exact selection:

```bash
docsfab run review-documentation --repo /absolute/path/to/target-repo \
  --composition nvidia-inference-gpt-6-sol-pi
```

Codex and Claude Code use separate readiness commands:

```bash
docsfab composition preflight \
  --composition openai-gpt-6-sol-codex-preflight

docsfab composition preflight \
  --composition anthropic-claude-opus-4.7-claude-code-preflight
```

Every record and result in this lane remains
`technicalApproval: not-established`,
`roleQualification: not-established`, and `releaseEligible: false`. Omitting
`--composition` runs the composition that `host.yaml` names, or the configured
model profile.

## Technical Approval and Qualification

Technical approval under schema version 1 establishes the `policy` or `judge`
purpose, exact model/provider/origin, compatible transport, verified catalog fields,
provenance, authority, and review dates. It does not bind a harness or prove
that the profile writes good documentation.

Role qualification measures performance against a frozen DocsFab workflow,
repository corpus, skill and quality-pack versions, and score threshold. An
approved profile can be qualified for audit while still requiring evaluation
for writing or review.

The deterministic scorer can emit only `qualification-candidate`. A future
host-authority finalizer must bind an authorized corpus freeze and independent
review before anything can be labeled `qualified`.

The planned composite record and purpose-scoped selector can choose a profile
only when both conditions hold:

```text
technical profile is current
AND
requested role is qualified
```

The current runtime does not yet enforce this selector.

## Implemented NVIDIA Inspection

The following command is specific to the NVIDIA Inference API serving route
with authenticated Inference Hub Metadata evidence:

```bash
umask 077
docsfab profile inspect --catalog --json \
  > /owner-private/policy-inspection.json
```

For this route, configure `INFERENCE_HUB_METADATA_ORIGIN`,
`INFERENCE_HUB_METADATA_PATH`, `INFERENCE_HUB_METADATA_MODE`, the applicable
label variable, and the distinct `INFERENCE_HUB_METADATA_API_KEY`. Do not
configure those values for direct OpenAI, direct Anthropic, or NIM serving
routes; Codex or Claude Code harnesses; or embedding profiles.

The NVIDIA Inference Hub Metadata service uses these host values. Set the
label to the exact model ID that the inference route serves, and replace
`METADATA_ORIGIN` with the HTTPS origin of the Metadata service that your
NVIDIA administrator provides:

```dotenv
INFERENCE_HUB_METADATA_ORIGIN=METADATA_ORIGIN
INFERENCE_HUB_METADATA_PATH=/api/v1/models
INFERENCE_HUB_METADATA_MODE=search
MODEL_INFERENCE_HUB_METADATA_LABEL=azure/openai/gpt-6-sol
```

Search mode sends the label as the `search` query parameter, and DocsFab sends
the Metadata key in the `x-api-key` header. The service returns HTTP 403 for
the same key sent as `Authorization: Bearer`.

This service's records give prices as bare `price_1m_*` numbers without a
currency, and they do not state whether the context limit is shared between
input and output. DocsFab therefore reports those prices and the limit
semantics as `unknown`. Because the limit semantics are required for a
`ready` proposal, the reconciliation reports `review-required` for these
records.

Continue with the complete `docsfab profile approve` preview, signing, apply,
confirmation, and rollback commands in the
[runtime approval-operations runbook](../../../packages/runtime/docs/reference/model-governance/model-catalog-operations.md).
Keep the private bundle, signing key, receipt, endpoints, and credentials
outside the repository.

## Authoritative Sources

This page is based on the following sources:

- [Model profile inspection implementation](../../../packages/runtime/src/model/profile-inspection.ts)
- [Model catalog operations runbook](../../../packages/runtime/docs/reference/model-governance/model-catalog-operations.md)

## Related Topics

For more information, refer to the following topics:

- [Runtime CLI and Configuration in DocsFab](runtime-cli-and-configuration.md)
- [DocsFab Operator Error Envelope](operator-error-envelope.md)
- [Profile Probe and Draft in DocsFab](../../configure/probe-model-route.md)
- [Run a Documentation Workflow in DocsFab](../../workflows/run-a-documentation-workflow.md)
- [DocsFab Implementation Status](implementation-status.md)
