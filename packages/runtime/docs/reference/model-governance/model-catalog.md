# Model catalog reference

This is the normative contract for catalog-aware profile inspection. For the operator sequence, see [Model catalog operations](../model-governance/model-catalog-operations.md).

## Authority and credentials

Catalog access is never part of ordinary workflow execution or model
registration. In the target operator sequence, the operator first binds the
model identity, serving route, execution harness, and DocsFab purpose. That
composition selects an evidence-adapter set, and each adapter may read only its
host-managed credential family. Inspection infers the adapter set from the
bound serving route rather than from a separate selector.

`profile inspect --catalog` selects the catalog-approval adapter set from the
bound serving route. The NVIDIA Inference API route reconciles `/v1/models`
with authenticated Inference Hub Metadata. Direct OpenAI and direct Anthropic
routes retrieve that provider's Models API and never read Hub Metadata. For
the NVIDIA route, the inference credential stays in `MODEL_API_KEY` or
`JUDGE_API_KEY`; Metadata uses the distinct
`INFERENCE_HUB_METADATA_API_KEY` (`ihub_api_...`). Missing Metadata does not
block ordinary `docsfab doctor` or `docsfab run` and is never reported as
`provider-credentials-missing`. The Metadata credential is not a prerequisite
for direct OpenAI, direct Anthropic, or NIM serving routes; Codex or Claude
Code harnesses; or embedding profiles. NVIDIA API Catalog, hosted or local
NIM, embedding profiles, and live native-harness adapters remain unimplemented.

No inference, discovery, or harness credential belongs in inspection JSON,
approval bundles, run records, or the repository. An unavailable required adapter
is a capability gap, not permission to relabel another provider's evidence.

Policy and judge proposals, approvals, environment keys, and receipts are separate. Approval of one slot grants no authority over the other.

Technical approval and workflow-role qualification are also separate. A v1
approval verifies the `policy` or `judge` purpose plus exact
model/provider/origin catalog evidence; it does not bind harness identity or a
writing, review, audit, or retrieval role. Qualification records measured
suitability for a named workflow or role, but cannot authorize a deployment or
silently qualify other roles. The current runtime does not yet enforce
purpose-scoped profile selection.

## Inspection and approval contract

Configured, effective, observed, and proposed fields must be reviewed before apply. A lower limit or capability regression is drift requiring an operator decision; it never changes the active profile. Missing pricing remains `unknown`, cannot become zero, and is not evidence that a service is free.

The first approval invocation signs the exact proposal and renders a patch. The apply invocation requires the saved bundle and patch digests, changes only the selected slot, and writes a credential-free receipt. A current approved profile remains usable when a catalog surface times out, rejects authorization, omits a model, or is unavailable; the failed inspection records a closed content-free code and does not mutate configuration.

`*_PROFILE_REVIEW_AFTER` is an advisory review reminder. From the day after it, `docsfab profile inspect`, `docsfab doctor`, and the run summary print `Review overdue` with the date; the profile stays `current` and keeps its approved limits, capabilities, and prices, and no command refuses on the date alone. A refresh requires new evidence, effective and review dates, and an apply receipt. Credential rotation does not authorize new limits or dates.

Rollback restores only selected allowlisted profile fields and preserves unrelated configuration and credentials. Later owner edits, inode changes, tracked aliases, or digest mismatches fail safely for owner review.

## Verification evidence

`npm run acceptance:catalog` covers the currently implemented NVIDIA policy and
judge lifecycle, offline outage, drift and a passed review date, refresh and
rollback, timeout, authorization failure, model removal, capability regression,
reduced limits, absent pricing, and the rule that ordinary workflows do not
reach catalog transport. It is not evidence for OpenAI or Anthropic retrieve
adapters, harness, NIM, or embedding adapters. Named runtime tests cover OpenAI
identity retrieve and Anthropic `max_input_tokens` / `max_tokens` mapping. The
two NVIDIA live checks are opt-in; missing or invalid host configuration
produces a clean skip. Adapter failures expose only fixed messages and codes,
and tests assert that supplied credentials are absent from results and errors.

The checked-in [sanitized GPT-5.4 example](../../examples/gpt-5.4-model-catalog-evidence.json) uses an exact closed schema with normalized evidence digests and selected limits, but no credential, raw response, host path, or open-ended field. Pricing remains explicitly unapproved; this evidence does not close economics issue #6.
