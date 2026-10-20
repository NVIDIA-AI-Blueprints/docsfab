---
title: "Run a Documentation Workflow in DocsFab"
description: "Run one named DocsFab workflow against an immutable repository revision and inspect its saved result. For a persistent conversation, use the Live Agent Quickstart."
status: draft
content.type: how-to
---

Run one named DocsFab workflow against an immutable repository revision and inspect its saved result. For a persistent conversation, use the [Live Agent Quickstart](../get-started/live-agent-quickstart.md).

## Prerequisites

Before you run a job, confirm the following prerequisites:

- Select the Git repository you want to document, which can be DocsFab itself.
- Install or build the CLI as described in
  [Install DocsFab](../get-started/installation.md).
- Confirm Node.js 24.21.0 or later and that `docsfab list` shows the bound jobs.
- Select an immutable target repository revision and keep `--repo` pointed at
  that product.
- For explicit composition execution, configure the exact model ID and endpoint
  selected by an installed composition, and provide its credential through the
  host environment.

Read-only is the default for review. Create, update, and restructure
write and open one draft merge request unless you pass `--patch-only`
or `--dry-run`. Do not retry a blocked job with broader authority.

For a public GitHub pull request review, run the following command. This
selection uses the authenticated fork head rather than your current checkout:

```bash
docsfab run review-documentation --pr https://github.com/OWNER/REPO/pull/N
```

Add `--source docs/reference.md` when you need another tracked file at the
fork head as review evidence. DocsFab binds it with the pull request sources in
one run.

Use `--dry-run` to preview the unresolved selection without network or model
work. The normal read-only run saves a private run record and a local Markdown
report; `--json` prints structured result and report locators. Check the
reported M/B/H basis, reviewed pages, deferred or uncertain impact, source
citations, and unavailable repository checks before interpreting the quality
verdict. This route does not execute repository scripts or post to GitHub.

## Choose a Job

Select the fixed catalog job that matches your intended outcome. Request
text does not grant authority or let a model choose a different workflow.
The following table maps each goal to its job.

`create-documentation` and `restructure-documentation` write Markdown and MDX
pages, not reStructuredText (`.rst`) pages. `update-documentation` supports
one narrow RST case: with `--patch-only`, it can replace or insert ordinary
top-level prose in one existing tracked `.rst` page under an unambiguous Sphinx
root. The patch preserves every other page byte. RST creation, restructuring,
and edits inside directive bodies or nested content remain unsupported. For a
Sphinx site, `review-documentation` can
inspect a bounded RST subset and reports unsupported syntax as a limitation or
refusal. Refer to
[Documentation Source Coverage in DocsFab](../resources/evaluation/source-coverage.md)
before choosing a job for an RST-only site.

| Goal | Job | Mutation boundary | Result | Start here |
| --- | --- | --- | --- | --- |
| Prepare repository guidance | `bootstrap` | Local patch only, with `--allow-write`; no draft MR | Reviewable patch and run record | This hub |
| Evaluate an existing documentation set | `review-documentation` | Read-only | Findings and quality evidence | [Review Merge Request Impact in DocsFab](review-merge-request-impact.md) or [Baseline Documentation Health in DocsFab](baseline-documentation-health.md) |
| Create a bounded documentation target | `create-documentation` | Writes and opens a draft MR by default | Reviewable patch, run record, and draft MR | [Workflow Quickstart](../get-started/runner-quickstart.md) |
| Apply a bounded update to existing documentation | `update-documentation` | Writes and opens a draft MR by default | Reviewable patch, run record, and draft MR | [Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md) |
| Assess repository input for agents | `readiness` | Read-only | Source evidence and prioritized gaps | [Assess Documentation Readiness](assess-readiness.md#assess-documentation-readiness) |
| Assess public release documentation | `release-documentation-readiness` | Read-only | Governed disposition, decisions, and work plan | [Assess Documentation Readiness](assess-readiness.md#assess-documentation-readiness) |
| Check every page against its template | `audit-documentation` | Read-only, no model call | Per-page template findings and coverage counts | [Audit Pages Against Templates](audit-templates.md#audit-pages-against-templates) |
| Restructure an existing documentation set | `restructure-documentation` | Writes and opens a draft MR by default | Reviewable patch, run record, and draft MR | This hub; catalog-available, not a v0.0.1 proof journey |

## Inspect the Bound Catalog

Use the catalog commands to confirm the available jobs and inspect a job's
fixed step graph:

```bash
docsfab list
docsfab plan review-documentation
```

`list` prints `review-documentation`, `create-documentation`,
`update-documentation`, and `restructure-documentation`. `plan` prints the
fixed step graph. It does not read a target repository, run a model, or
grant write authority.

Inspect the separately installed model, route, and harness bindings:

```bash
docsfab composition list
```

The list distinguishes executable `pi-provider` compositions from
`preflight-only` Codex and Claude Code compositions. Listing compositions
does not run a provider or workflow.

## Choose an Execution Path

Omit `--composition` to use the model-profile path. To run the bounded
composition execution path, select one exact executable composition:

```bash
docsfab run review-documentation --repo /absolute/path/to/target-repo \
  --composition anthropic-claude-opus-4.7-pi
```

The installed executable NVIDIA, OpenAI, and Anthropic choices are listed
by `docsfab composition list`, which also marks records whose status is
`retired`. Current NVIDIA API Catalog IDs include
`nvidia-nemotron-3.5-lightning-30b-a3b-pi`,
`nvidia-nemotron-3-super-120b-a12b-pi`, and
`nvidia-nemotron-3-ultra-550b-a55b-pi`;
`nvidia-llama-3.3-nemotron-super-49b-v1.5-pi` is retired
(provider end-of-life 2026-08-26) and is refused for new runs.
The direct-provider ID is `anthropic-claude-opus-4.7-pi`.
`openai-gpt-5.6-sol-pi` is retired (superseded by operator decision
on September 28, 2026) and is refused for new runs; its successor is
`nvidia-inference-gpt-6-sol-pi`.

Provide exactly one credential source declared by the selected
composition. The NVIDIA API Catalog compositions read only
`DOCSFAB_NVIDIA_API_KEY`; `MODEL_API_KEY`, `NVIDIA_API_KEY`, and
`NGC_API_KEY` are not aliases for it. Direct-provider compositions retain
their documented `MODEL_API_KEY` or provider-specific source. Keep
credentials in the host secret boundary; do not put them in the command,
target repository, prompt, or run record. For the supported default
setup, use [Install DocsFab](../get-started/installation.md). For advanced
composition credential contracts, refer to
[Runtime CLI and Configuration in DocsFab](../reference/status-and-configuration/runtime-cli-and-configuration.md).

The configured model ID, base URL, and compatible API format must match
the selected installed route. DocsFab rejects a mismatch instead of
switching providers or compositions.

### Unqualified Answer-Record Discovery

Use `--experimental-answer-records` only when you are explicitly collecting
unqualified discovery evidence for a selected composition and route with a
locked quality profile. The host derives the answer-record plan from that
profile and its policy:

```bash
docsfab run review-documentation --repo /absolute/path/to/target-repo \
  --composition <composition-id> --experimental-answer-records
```

This option is limited to `review-documentation` and requires an explicit
`--composition` selection. It uses the locked quality profile's
host-derived answer-record plan; it does not require an installed
answer-submission qualification measurement. DocsFab prints the effective
execution bounds and the applicable request-intent, quality-evaluator, and
answer-now limits before provider work begins. The evidence records the
installed composition, candidate, package, and host limits used to derive
those effective bounds. The saved evidence records unqualified discovery;
this mode does not qualify the composition or change the qualified default
path. Without `--quiet`, DocsFab prints the effective bounds before provider
work. With `--quiet`, the preflight display is suppressed, but the saved run
evidence retains the bounds and unqualified status.

For the exact NVIDIA API Catalog Nemotron 3 Super 120B composition, discovery
can use a configured per-request output allowance up to the hosted endpoint's
documented [`max_tokens` ceiling](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer).
To select that ceiling, set
`MODEL_MAX_OUTPUT_TOKENS=32768` for the run. This override applies only with
`--experimental-answer-records` on that exact composition and route; other
compositions and ordinary runs keep their installed limits. The 32,768-token
value is documented endpoint request capacity, not measured evidence that a
DocsFab workflow needs that much output or will complete successfully. The
composition remains unqualified, and its sealed production limit is unchanged.

In this mode, tool reads and answer-record submissions share a renewable
per-lease call cadence. DocsFab keeps separate usage counts for each scope and
renews the cadence from host-owned checkpoint evidence. During the answer-
record evaluator step, this explicit policy does not impose aggregate tool-
call, lease-count, provider-turn, cumulative-token, whole-attempt time, or cost
ceilings. It still enforces configured output and response-byte capacity for
each provider request. Input and context admission follow the selected route's
existing host-or-provider policy. The provider SDK's request timeout, transport
retry rules, cancellation, credential isolation, and final validation also
remain active. Provider-account limits remain external to DocsFab. These
controls and usage records do not establish model capability.
If the model returns final text while required answer-record keys remain,
DocsFab asks for the remaining keys and continues in the same attempt.
Previously admitted records and existing tool permissions remain available
during recovery. A refused answer-record submission does not stop discovery
of other required keys. Saved run evidence retains content-free refusal
diagnostics so you can inspect rejection codes and locations without retaining
rejected answer content. At an execution-lease checkpoint, this explicit
discovery mode can renew after a correction tranche with zero useful records so
those refusals remain correctable. Ordinary runs still require a useful
success before renewal.

The final evaluator report may also continue across provider requests without
the ordinary run's continuation-count or stitched-response-byte cutoff. Each
individual provider response remains subject to its configured byte capacity,
and an incomplete model evaluation is still refused rather than completed by
the host.

Saved discovery runs created under the older refusal policy remain readable.
They cannot resume under the new policy. Start a fresh run with
`--experimental-answer-records` to continue discovery.

<Note title="Composition-execution evidence">
The direct NVIDIA, OpenAI, and Anthropic connections and their offline
contract tests are implemented. A retained NVIDIA API Catalog run through
the installed Llama-Nemotron composition completed the full six-stage
`create-documentation` workflow; a clean post-run audit found factual and
information-type defects in its patch, so this is execution evidence rather
than model-quality evidence. A September 11, 2026 direct OpenAI basic
verification test completed three synthetic requests through
`openai-gpt-5.6-sol-pi`, now retired, including a tool call and
result round trip. The sanitized record is
`packages/runtime/docs/internal/evidence/openai-provider-smoke-2026-09-11/evidence.json`.
A full direct OpenAI documentation workflow and its output quality remain
unverified. Direct Anthropic remains provider-offline in this comparison
slice. Every composition-execution result remains technically unapproved,
role-unqualified, and not release eligible.
</Note>

## Run a Read-Only Job

Run the review job without a write grant:

```bash
docsfab run review-documentation --repo /absolute/path/to/target-repo
```

This job does not require write authorization. Live `run` needs the
runtime model profile. `docsfab test` remains the credential-free
self-check.

`review-documentation` is the standalone comprehensive stack:
documentation audit, lint, technical verification, peer review,
audience-understanding, and quality evaluation.

When a run names exactly one documentation page, runtime compiles its
repository context for that page. A named page that is not present at the
frozen revision stops the run rather than silently widening it to the
whole documentation set.

Before the first model request, runtime verifies the installed quality
pack. After the request interpretation and before the first workflow step,
runtime builds a tracked documentation inventory and selects the
experimental `docsfab-documentation-quality` profile at version `v0.1`.
A missing, ambiguous, substituted, or inapplicable profile stops with
`quality-profile-selection-invalid` before any workflow step runs.

For reviewer and baseline procedures, refer to
[Review Merge Request Impact in DocsFab](review-merge-request-impact.md) and
[Baseline Documentation Health in DocsFab](baseline-documentation-health.md).

## Run a Write-Capable Job

Create, update, and restructure write and open one draft merge request
by default. Pass `--patch-only` to run in a disposable workspace and
retain a patch without publishing or changing the source checkout. Pass
`--dry-run` to preview and stop before repository inspection or workflow
steps. `--repo` defaults to this checkout.

An instruction that says not to publish, such as `Keep the result local; do
not commit, push, or open an MR.`, stops the default delivery, `--draft-mr`,
and `--dry-run` with `publication-prohibition-conflict` before any GitLab read
or model call. Pass `--patch-only` with it, or remove the prohibition to open
the draft merge request. For the recognized phrasings, refer to
[A Request That Says Not to Publish Is Refused](../troubleshooting.md#a-request-that-says-not-to-publish-is-refused).

Verified help for the bound write jobs:

<Tabs>
  <Tab title="Update">
    ```bash
    docsfab run update-documentation \
      --instruction "Update the API guide for the approved change"
    ```
  </Tab>
  <Tab title="Create">
    ```bash
    docsfab run create-documentation \
      --instruction "Create a task guide for the approved feature"
    ```
  </Tab>
  <Tab title="Restructure">
    ```bash
    docsfab run restructure-documentation \
      --instruction "Split the installation guide without breaking navigation"
    ```
  </Tab>
</Tabs>

For create examples and delivery choices, refer to
[Workflow Quickstart](../get-started/runner-quickstart.md). For update
beside a change, including `--reader-source`, refer to
[Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md).

`create-documentation` and `update-documentation` also accept the repeatable
`--source` flag, which binds tracked files at the selected revision and issues
the granted steps a host reader for them. DocsFab accepts these tracked source extensions: `.diff`, `.docx`, `.htm`, `.html`, `.ipynb`, `.js`, `.json`, `.markdown`, `.md`, `.mdx`, `.patch`, `.pdf`, `.toml`, `.ts`, `.txt`, `.xhtml`, `.yaml`, and `.yml`. `review-documentation` and `restructure-documentation` refuse
the flag, and the refusal names the workflows that accept it. `--dry-run`
parses the selection and stops before the host opens any source body. Refer to
[Select Source Evidence](select-sources.md).

Adding `--composition <id>` selects that installed composition as the run's
preset and does not grant delivery authority. Composition-execution writes stay
local unless you pass `--draft-mr`. A `--composition` run also accepts
`--release-gate`, `--comment-mr`, and `--resume-from`. Add
`--set <key>=<value>` to change one of the preset's model settings for the
run; refer to
[Change a Preset's Settings](../configure/override-model-settings.md).
The optional `--canon-sha256 <sha256>` flag is
accepted only beside `--comment-mr` and supplies the project's registered
canon digest for a focused review's continue command in the summary note.
For an authorized local write, a local Git repository does not need a remote or
`.docsfab.json`. DocsFab uses the default `docs/` and `fern/` roots when no
tracked project configuration sets them. A tracked configuration remains
authoritative and must be valid. Publishing or explicitly proposing
`.docsfab.json` still requires setup through a supported GitLab remote.
At this head no `--comment-mr` run carries a focused scope, so the flag
has no effect until a focused `--comment-mr` producer exists; read the
deferred set from the run record.

For changes selected by merge date, follow [Update Documentation From Merged Merge Requests](bind-gitlab-change.md#update-documentation-from-merged-merge-requests).

## Verify the Result

Inspect the terminal result and retained run record before you use any
output:

```bash
docsfab runs show <run-id>
```

Execution status describes whether the workflow completed. The quality
disposition describes the evaluated documentation and its evidence. Inspect
both; a completed run does not by itself mean the output passed evaluation,
and an evaluation artifact is not a release approval. For the evaluation
vector, optional content-type score, report summary, and their retained
locators, refer to [Evaluate Document Quality Skill in DocsFab](../reference/quality/skills/assess-and-evaluate/evaluate-document-quality.md)
and [Reading a Result](../about/core-concepts/documentation-quality.md#reading-a-result).
The locators identify runtime-retained artifacts and do not necessarily name
files written into the documented repository.

Some completed reviews have no validated quality projection. If the evaluator's
structured result remains invalid after correction attempts, the workflow can
retain its narrative and other findings without a validated evaluation, score,
or report projection. This is not a pass, and narrative does not replace a
validated evaluation. Review findings and patch delivery remain separate from
the quality verdict.

Confirm the following conditions:

- The record names the requested workflow, target repository revision,
  bound skills, locked quality pack, and selected composition when
  applicable.
- A successful read-only review contains findings and quality evidence
  without a write grant.
- When a write-capable job proposes changes, it contains a reviewable
  patch and does not imply commit, publication, deployment, or merge
  authority.
- A `needs-input`, blocked, or failed result identifies the unmet
  dependency. Do not retry it with broader authority. After a catalog
  job has started, follow
  [Answer and Resume a Stopped Job in DocsFab](answer-and-resume.md) or the PRODUCT
  shopping list. Do not treat `docsfab doctor` as that continuation.
- Composition-execution output remains technically unapproved, role-unqualified, and
  not release eligible, even when execution succeeds.

For the complete CLI output contract, refer to
[Human Output and JSON in DocsFab](../reference/status-and-configuration/human-output-and-json.md).

## Next Steps

Choose the next action from the verified result:

<CardGroup cols={2}>
  <Card
    title="Update Documentation Beside a Change in DocsFab"
    href="/workflows/update-documentation-beside-a-change"
  >
    Address review findings with a bounded `update-documentation` job.

    [Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md)
  </Card>
  <Card
    title="Delivering Results"
    href="/about/core-concepts/documentation-jobs"
  >
    Inspect a write-capable patch before requesting any separately authorized
    delivery. Refer to
    [Delivering Results](../about/core-concepts/documentation-jobs.md#delivering-results).
  </Card>
  <Card
    title="Answer and Resume a Stopped Job in DocsFab"
    href="/workflows/answer-and-resume"
  >
    If the job lacks load-bearing product evidence, use
    [Answer and Resume a Stopped Job in DocsFab](answer-and-resume.md) or
    [Gather Product Knowledge](index.md#gather-product-knowledge) before you
    resume.
  </Card>
  <Card
    title="Troubleshooting DocsFab"
    href="/troubleshooting"
  >
    If a runtime or provider check fails, use
    [Troubleshooting DocsFab](../troubleshooting.md).
  </Card>
</CardGroup>

## Related Topics

Use these topics for the concepts, setup, reference, and recovery
guidance that support this workflow:

<CardGroup cols={2}>
  <Card title="About DocsFab Workflows" href="/workflows">
    [About DocsFab Workflows](index.md)
  </Card>
  <Card
    title="Documentation Jobs"
    href="/about/core-concepts/documentation-jobs"
  >
    [Documentation Jobs in DocsFab](../about/core-concepts/documentation-jobs.md)
  </Card>
  <Card
    title="A Result Grants No Authority"
    href="/about/core-concepts/documentation-jobs"
  >
    [A Result Grants No Authority](../about/core-concepts/documentation-jobs.md#a-result-grants-no-authority)
  </Card>
  <Card
    title="Install DocsFab"
    href="/get-started/installation"
  >
    [Install DocsFab](../get-started/installation.md)
  </Card>
  <Card
    title="Runtime CLI and Configuration in DocsFab"
    href="/reference/status-and-configuration/runtime-cli-and-configuration"
  >
    [Runtime CLI and Configuration in DocsFab](../reference/status-and-configuration/runtime-cli-and-configuration.md)
  </Card>
  <Card title="Documentation Source Coverage">
    [Documentation Source Coverage in DocsFab](../resources/evaluation/source-coverage.md)
  </Card>
  <Card
    title="Troubleshooting DocsFab"
    href="/troubleshooting"
  >
    [Troubleshooting DocsFab](../troubleshooting.md)
  </Card>
</CardGroup>

## Moved Topic Links

Earlier section bookmarks lead to the canonical topic below.

<a id="assess-documentation-readiness"></a>

Refer to [Assess Documentation Readiness in DocsFab](assess-readiness.md#assess-documentation-readiness).

<a id="audit-pages-against-templates"></a>

Refer to [Audit Pages Against Templates in DocsFab](audit-templates.md#audit-pages-against-templates).

<a id="bind-first-pass-knowledge"></a>

Refer to [First-Pass Knowledge in DocsFab](first-pass-knowledge.md#bind-first-pass-knowledge).

<a id="compare-completed-composition-runs"></a>

Refer to [Compare Completed Composition Runs in DocsFab](../manage/compare-runs.md#compare-completed-composition-runs).

<a id="deliver-or-recover-a-draft-merge-request"></a>

Refer to [Deliver or Recover a Draft Merge Request in DocsFab](deliver-draft-mr.md#deliver-or-recover-a-draft-merge-request).

<a id="host-a-review-report"></a>

Refer to [Host a DocsFab Review Report](../manage/host-review-report.md#host-a-review-report).

<a id="preserve-the-original-task-during-snapshot-import"></a>

Refer to [First-Pass Knowledge in DocsFab](first-pass-knowledge.md#preserve-the-original-task-during-snapshot-import).

<a id="repository-wide-evidence-bounded-changes"></a>

Refer to [First-Pass Knowledge in DocsFab](first-pass-knowledge.md#repository-wide-evidence-bounded-changes).

<a id="supply-work-products-after-a-job-starts"></a>

Refer to [Supply Requested Work Products in DocsFab](supply-work-products.md#supply-work-products-after-a-job-starts).

<a id="update-documentation-from-merged-merge-requests"></a>

Refer to [Bind a GitLab Change in DocsFab](bind-gitlab-change.md#update-documentation-from-merged-merge-requests).
