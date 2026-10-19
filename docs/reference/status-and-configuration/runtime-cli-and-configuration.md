---
title: "DocsFab CLI Command Reference"
description: "Look up the DocsFab command groups and their authority boundaries. Run `docsfab help <command>` for the exact options in your installed version."
status: draft
content.type: reference
---

Look up the DocsFab command groups and their authority boundaries. Run `docsfab help <command>` for the exact options in your installed version.

## Choose a Surface

Use the following table to choose a command surface for your need.

| Need | Surface | Continue with |
| --- | --- | --- |
| Confirm installation or diagnose a target repository. | `help`, `test`, `init`, or `doctor` | [Runtime Readiness and Doctor Checks in DocsFab](../../manage/check-readiness.md) for diagnostic semantics. |
| Hold a persistent terminal conversation with DocsFab. | `live-agent` | [Live Agent Quickstart](../../get-started/live-agent-quickstart.md) to start. [Live Agent Reference in DocsFab](live-agent.md) for flags, activities, and bounds. |
| Check which sources a selection binds before you run the work. | `sources` | [Check a Source Selection](../../workflows/select-sources.md#check-a-source-selection) for the verbs and their process scope. |
| Select and run a fixed documentation job. | `do` or `run` | [Workflow Contracts in DocsFab](../workflow-contracts/index.md) for ordered skill composition. |
| Inspect model execution or approval evidence. | `composition` or `profile` | [Model-Profile Approval in DocsFab](model-profile-approval.md) for lane boundaries. |
| Deliver or inspect a bounded result. | `publish`, `runs show`, or `evaluate` | The installed `docsfab help` output for exact options. |
| Apply authenticated issue-planning records. | `roadmap-issues` | Preflight and apply use exact private material, authorization, and confirmation digests. |
| Inspect a currently parked command surface. | `ia` or `roadmap-plan` | The current router fails closed because no catalog skill is active. |
| Preview one autonomous cycle. | `auto` | Explicit execution and publication confirmation remains required. |

## Command Groups

The following table lists the command groups.

| Command | Purpose | Authority boundary |
| --- | --- | --- |
| `docsfab help` | Display the complete command catalog. `docsfab help <command> [<subcommand>]`, `docsfab <command> --help`, and `-h` print one command's or subcommand's usage. A command group run without a subcommand, such as `docsfab runs` or `docsfab config`, lists its subcommands. | Read-only. Help makes no network request. |
| `docsfab list` | List available catalog workflow names and titles. Refer to [Discover DocsFab Workflows](../../get-started/discover-workflows.md) for workflow selection and plan examples. | Read-only. Disk presence does not add a workflow. |
| `docsfab test` | Run the credential-free offline self-test. `--quiet` is the short human shape; `--json` is the machine record. | Read-only and network-free by contract. |
| `docsfab init` | Discover a GitLab repository and preview or apply project configuration. | Application requires the exact preview digest. |
| `docsfab setup` | Choose OpenAI, OpenAI-compatible, Anthropic, or Anthropic-compatible, then configure the model, API, and owner-private credential without starting an agent. `--profile <compositionId>` writes that id and required secret names without copying YAML `MODEL_*` fields. DocsFab has no default model: without a terminal, bare setup on a host with no model selection stops with `setup-model-choice-required` and writes nothing, and a host with a retired selection stops with `composition-retired`; pass `--provider` and `--model`, or `--profile` with an installed composition id. The default output is concise; `--verbose` shows setup diagnostics, and `--json` emits the canonical result. | Writes host configuration and secrets outside the project checkout. Compatible providers accept a custom HTTPS base URL, or a plain HTTP base URL on a loopback host. Setup validates local configuration without making a provider request. |
| `docsfab config inspect` | Show effective host paths and installed profile selections with model and policy provenance. Optional legacy paths retain their physical status. `--json` emits the machine record. | Provider-offline and read-only. Checks selection references and legacy YAML schemas, without checking endpoint or credential readiness. It never prints credential values or reads secret-bearing files. |
| `docsfab live-agent` | Start or resume a persistent Pi terminal conversation. `--new` creates a separate session. The repeatable `--source` flag attaches tracked files and `--pr`, or its exact alias `--mr`, attaches one already-merged merge request as bound evidence for the session. | Loads packaged skills, the quality pack, and workflows. Documentation edits and workflow writes are enabled by default; host commands require terminal approval. `--read-only` disables edits, workflow writes, and host commands. Attached sources are a host selection: every bounded workflow the conversation runs binds exactly them, the writer and the verifier read the same immutable observations, and no conversation message or model tool argument can add, replace, or drop one. They are supported by `create-documentation` and `update-documentation`; asking for another workflow with sources attached stops that run and names the workflow instead of dropping the evidence, and a turn whose instruction already names merge requests by a merged-on date window stops for the same reason. |
| `docsfab sessions` | List local live-agent sessions with `list`, which prints each session's ID, age since its last write, size, and a repository label that never contains the path. `--repo <path>` shows one checkout's sessions. Delete sessions with `delete <session-id>`, `delete --all`, or `delete --older-than <days>`. `--json` emits the machine record. | `list` only reads. `delete` previews what it would remove and deletes nothing until you rerun it with the `--confirm <token>` that preview printed, which covers that exact set of files. It removes transcripts and task-branch state inside the session directory only, refuses a session ID that contains a path, and never follows or deletes a symbolic link. It does not change repositories, branches, or saved run records. For details, refer to [Stored Sessions and Deletion](../../manage/live-sessions.md#stored-sessions-and-deletion). |
| `docsfab sources` | Inspect and manage the sources one invocation binds, with the verbs `list`, `add`, `show`, `refresh`, `revalidate`, `remove`, `search`, and `purge`. The repeatable `--source` flag and `--pr`, or its exact alias `--mr`, select the same evidence they select on `docsfab run`. `--repo <path>` names the checkout. | Read-only except for `purge`: the other verbs read the selected revision for a preview or a version and write nothing, and the selection is held for that one invocation and is written nowhere, so no other process, saved run, or conversation reads it. `purge` deletes the owned local copies a custody store holds for a named session and appends a custody record; it previews first and deletes only against the confirmation that preview printed. The verbs, the listing, and every coded refusal are the same ones the live terminal's `/sources` commands answer with, over the same selection state, so the two surfaces cannot disagree. An unknown verb and an unknown `--` option each stop the command and name the accepted forms instead of being ignored. `docsfab run` also refuses an unknown `--` option with code `unknown-option`, lists the accepted run options, and names `docsfab run --help` as the next action rather than ignoring the token. |
| `docsfab doctor` | Inspect offline readiness; `--live` requests an explicit live check, adding the GitLab target observation behind draft-MR publication readiness. `--live --answer-submission` runs the answer-submission qualification probe instead. `--live --answer-records --answer-record-corpus <path>` runs the answer-record premise probe instead, and `--answer-record-small-groups` narrows it to 2- and 3-record messages. | Read-only unless a separately documented repair command is run. Offline it contacts no host. Validation readiness covers prerequisites; delivery checks its worktree confinement later. Human output and JSON `validationScope` report that confinement has not been checked. |
| `docsfab profile` | Inspect, approve, or roll back governed model profiles. The default inspection is concise; `--verbose` preserves the detailed audit view, and `--json` emits canonical evidence. | Approval and rollback require exact artifacts and confirmation values. |
| `docsfab composition` | List installed compositions, run native-harness preflight, compare composition-execution records, or run the explicitly acknowledged development pilot. | List and compare are provider-offline. Preflight makes no model request; the Codex preflight makes one authenticated account-catalog read. The pilot is live, uncontained development evidence and grants no approval, qualification, release, or merge authority. |
| `docsfab plan` | Print the fixed step plan for one active workflow. | Read-only; it does not execute the workflow. |
| `docsfab do` | Classify a natural-language sentence to a fixed catalog workflow, then optionally run it. Accepts `--quiet` and `--json`; has no `--verbose`. `--delegate` is a named opt-in for one finite delegated task and does not change that default. Accepts `--composition` and `--set` as `docsfab run` does. | The sentence is the work. Classification does not grant writes. Compact `ROUTE` can show catalog `write` for `create-documentation` and `update-documentation`; JSON `decision.readWriteScope` stays `"read-only"`. After classification, create/update/restructure write and open one draft MR. `bootstrap` requires `--allow-write` and delivers a local patch only. `--patch-only` selects local patch delivery for any workflow with a write step; on bootstrap, it does not replace the required `--allow-write` grant. `--draft-mr` remains limited to create/update/restructure. `--dry-run` opts out. `--instruction` on `do` is an optional override. A `needs-input` result lists `docsfab run <workflow>` commands, with `--instruction` on write jobs. Live `do` can admit one catalog job with the configured model after an eligible table miss; `--route-only` stays table-only. On an eligible table miss, `do` and both previews, `--dry-run` and `--route-only`, first verify the installed quality pack, and a tampered, stale, or unsafe pack stops the command with its own code, such as `checksum-mismatch`, before any model call. `--route-only` cannot combine with write or publish flags. Delegated `do` uses committed HEAD, `--resume <task-id> --answers <json-file>` to record answers for that exact task without continuing execution, and `--allow-write` for requested local documentation changes that still consume #758. Remote publication is unsupported. `--route-only` and `--dry-run` cannot combine with `--delegate`. The repeatable `--source` flag binds tracked files and `--pr`, or its exact alias `--mr`, grounds the run on one already-merged merge request, with the same selectors, acquisition, and refusals `docsfab run` uses; the same selection produces the same binding on both commands. Because `do` classifies before it knows the workflow, a selection that routes outside `create-documentation` or `update-documentation` stops and names the routed workflow. `--route-only` and `--dry-run` parse the selection without opening a source body or reading GitLab. Neither combines with `--continue` or `--attach`, or with a reply to an open run, because a continuation binds exactly the `--source` files and change the stopped run bound; each stops with `continue-binding-conflict`. An `update-documentation` route whose instruction names merge requests by a merged-on date window already selects its own evidence, so that instruction does not combine with either flag; the run stops and names the conflict, exactly as `docsfab run` does. Delegated `do` accepts neither, because bound sources are acquired by the catalog workflow runner the pilot does not use.  `--change` grounds the run on any change `docsfab run --change` accepts, a local commit range, a GitLab merge request, or a GitHub pull request, commit, or compare URL, or a release range written as `release:<base>..<head>`, and binds the same evidence `docsfab run` binds for it, a merge request's diff included; [Bind a Local Commit Range](../../workflows/bind-commit-range.md#bind-a-local-commit-range) lists how `do` routes and refuses it. |
| `docsfab run` | Run a named workflow against a repository and revision. Accepts `--quiet`, `--verbose`, and `--json`. `--composition <id>` selects an installed composition as the run's preset, and the repeatable `--set <key>=<value>` changes one of the model settings for this run, above the environment and `host.yaml`; refer to [Change a Preset's Settings](../../configure/override-model-settings.md). Create and update jobs can continue a durable first-pass stop with `--resume-from` and an attributed `--canon-snapshot`. `create-documentation` and `update-documentation` can bind tracked files as evidence with the repeatable `--source` flag. They can also be grounded on one GitLab merge request with `--pr`, or its exact alias `--mr`, which accepts the merge request's URL, a `host/group/project!number` reference, or the number alone for this checkout's project. On `docsfab run` only, `--pr` and `--mr` also accept a github.com pull request URL and bind it as `--change` would; refer to [Bind a GitHub Pull Request, Commit, or Compare](../../workflows/bind-github-change.md#bind-a-github-pull-request-commit-or-compare). For unqualified answer-record discovery on `review-documentation`, the explicit `--experimental-answer-records` option requires `--composition`. Without `--quiet`, DocsFab displays effective bounds before provider work; quiet mode suppresses that display while saved evidence retains the bounds and unqualified status. Per-key submission refusals do not end discovery; older discovery runs remain readable but cannot resume under the new refusal policy. Refer to [Unqualified Answer-Record Discovery](../../workflows/run-a-documentation-workflow.md#unqualified-answer-record-discovery) for shared-pool behavior and saved refusal diagnostics. DocsFab accepts these tracked source extensions: `.diff`, `.docx`, `.htm`, `.html`, `.ipynb`, `.js`, `.json`, `.markdown`, `.md`, `.mdx`, `.patch`, `.pdf`, `.toml`, `.ts`, `.txt`, `.xhtml`, `.yaml`, and `.yml`. | Create/update/restructure default to this checkout, origin, and one draft MR. Bootstrap requires `--allow-write`, delivers a local patch only, and accepts `--patch-only` as delivery selection without replacing that grant. Other workflows with write steps also accept `--patch-only`. `--dry-run` previews without writing or publishing. An `--instruction` that says not to publish, such as `Do not publish.` or `Keep the result local; do not commit, push, or open an MR.`, stops the default draft MR, `--draft-mr`, `--comment-mr`, and a write job's `--dry-run` with `publication-prohibition-conflict` before any GitLab read, model call, or run record, the same check `docsfab do` applies; `--patch-only` runs. A run whose request interpretation reads a `non-publication` constraint stops the same way before its first step and saves a record. `--instruction` may appear once; a second one stops the command instead of being ignored. Refer to [A Request That Says Not to Publish Is Refused](../../troubleshooting.md#a-request-that-says-not-to-publish-is-refused). Durable continuation is limited to the ordinary CLI host runtime and retains the original task and lineage. `--source` reads the selected revision, never the working tree, accepts only those extensions with no content sniffing, and has the write step read the part of each selected source that no earlier step read. A source that does not fit the step's source-read budget, 262,144 bytes by default and raisable with `DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES`, and at most `sources.readInputWindowShare` of a model's input window, is read in part and named, with the bytes read out of its total, in the run's LIMITATIONS section. Every acquisition stop names the failing condition and the change that clears it, and binds nothing. It does not combine with `--resume-from`, and on `update-documentation` it does not combine with a date-scoped instruction, because that instruction mints the run's binding from the merge requests it discovers. Extraction runs under a fixed 30-second per-file budget with no flag; a run that exceeds it refuses with its own message naming that budget and binds nothing. `--pr` resolves the project path to its numeric project identifier before reading, records both identities, and keys the evidence on the numeric one. On `docsfab run`, `--pr` also binds the merge request's pinned diff, from the checkout's own objects or, when the checkout lacks them, from GitLab's own diff, beside its text when it is merged and alone when it is open; a closed merge request refuses. Refer to [Bind a GitLab Merge Request's Diff](../../workflows/bind-gitlab-change.md#bind-a-gitlab-merge-requests-diff). It combines with `--source`, and the run then binds both as required evidence. `--dry-run` parses the reference without reading GitLab. |
| `docsfab multi-unit-campaign` | Inspect or run a bounded private multi-unit campaign. | Dry-run is the default. The write flag fails closed and does not grant auto-merge or publication. |
| `docsfab auto` | Preview or execute one bounded autonomous cycle. | Execution and publication require explicit confirmation and authority. |
| `docsfab publish` | Open a draft merge request for a succeeded write run. | Defaults to this checkout and `origin`. One-shot binds the plan digest. `--execute --confirm-plan-sha256` is two-phase recovery. |
| `docsfab runs list` | Enumerate safe metadata for saved run records, newest first. | Read-only; it does not open raw record output or perform workflow, Git, GitLab, report-server, write, or credential operations. |
| `docsfab runs show` | Replay one saved run record by ID. Optional `--canon-snapshot`, `--accept-candidate-snapshot`, and `--authority-id` validate and render one exact durable-continuation command. For a succeeded run whose patch changed documentation, a PUBLICATION section prints the draft merge request the run opened, its source branch, and its published head, from the run delivery index under the receipt root that `--state-dir` or `DOCSFAB_RECEIPT_ROOT` selects; `--json` reports the same lookup as `publication`. A run published with `--receipt-root` or by a managed cycle is found the same way. | Read-only; it accepts no write authorization and never claims, executes, or publishes. A run with no recorded draft merge request prints `run-delivery-not-recorded`; a damaged or unreadable index or receipt prints its own code (`run-delivery-index-invalid`, `run-delivery-index-unavailable`, `run-delivery-receipt-missing`, `run-delivery-receipt-invalid`, or `run-delivery-receipt-mismatch`) instead of reporting no merge request. A lookup never changes the exit code, the verdict, or NEXT. Draft merge requests opened before the index existed show as not recorded until their publication recovery command is replayed. When publication opens a draft merge request but cannot record it in the index, it stops with `run-delivery-index-write-failed` and prints the recovery command that records it. |
| `docsfab runs query` | Count run index rows across runs with `--where`, `--since`, `--until`, and `--group-by`. | Read-only; it reads only the run index. |
| `docsfab runs import` | Add saved run records from a state directory, a record file, or a local-workflows harness batch to the run index. | Writes only run index rows; it never changes a run record. |
| `docsfab why` | Diagnose a saved run, the newest run, a batch, or a state directory: what failed, why, the owner class, the next action, and the evidence. | Read-only; it reads the run index and saved records and makes no model call. |
| `docsfab reports serve` | Serve saved review HTML from the selected state directory. | Does not change the saved result. Bind and exposure remain operator choices. |
| `docsfab ia` | Reserved information-architecture input and cycle surface. | Parked until a catalog skill exists; the current router fails closed. |
| `docsfab roadmap-plan` | Reserved authenticated roadmap-planning surface. | Parked until a catalog skill exists; the current router fails closed. |
| `docsfab roadmap-issues` | Preflight or apply authenticated roadmap issue records. | Apply requires exact private material, authorization, receipt, and confirmation digests. |
| `docsfab evaluate` | Evaluate run records against a fixture. | Read-only unless another process acts on the result. |

For the generated operational-limits tables and the startup-validated contract-kit decode bounds, refer to [Operational Limits in DocsFab](operational-limits.md).

Run `docsfab help` from the exact version you use. The executable output is
authoritative when this summary and the installed command differ. For one
command, run `docsfab help <command>` or `docsfab <command> --help`. For
example, `docsfab runs --help` shows how to import and query saved run records
to diagnose failures.

## Authoritative Sources

This page is based on the following sources:

- [Runtime CLI usage](../../../packages/runtime/src/cli/usage.ts)
- [Change-source contract](../../../packages/runtime/docs/reference/contracts/change-source.md)
- [Project configuration implementation](../../../packages/runtime/src/init/project-config.ts)
- [Host configuration-path validation](../../../packages/runtime/src/config/host-paths.ts)
- [Create-documentation workflow manifest](../../../packages/runtime/workflows/create-documentation.json)

## Related Topics

- [Install DocsFab](../../get-started/installation.md)
- [Runner Quickstart](../../get-started/runner-quickstart.md)
- [DocsFab Operator Error Envelope](operator-error-envelope.md)
- [Model-Profile Approval in DocsFab](model-profile-approval.md)
- [DocsFab Implementation Status](implementation-status.md)
- [Troubleshooting DocsFab](../../troubleshooting.md)

## Moved Topic Links

Earlier section bookmarks lead to the canonical topic below.

<a id="agent-instruction-files-and-hidden-paths"></a>

Refer to [DocsFab Project Configuration Reference](project-configuration.md#agent-instruction-files-and-hidden-paths).

<a id="bind-a-github-pull-request-commit-or-compare"></a>

Refer to [Bind a GitHub Change in DocsFab](../../workflows/bind-github-change.md#bind-a-github-pull-request-commit-or-compare).

<a id="bind-a-gitlab-merge-requests-diff"></a>

Refer to [Bind a GitLab Change in DocsFab](../../workflows/bind-gitlab-change.md#bind-a-gitlab-merge-requests-diff).

<a id="bind-a-local-commit-range"></a>

Refer to [Bind a Local Commit Range in DocsFab](../../workflows/bind-commit-range.md#bind-a-local-commit-range).

<a id="bind-a-release-range"></a>

Refer to [Bind a Release Range in DocsFab](../../workflows/bind-release-range.md#bind-a-release-range).

<a id="check-a-source-selection"></a>

Refer to [Select Source Evidence in DocsFab](../../workflows/select-sources.md#check-a-source-selection).

<a id="content-ir-v3-source-support"></a>

Refer to [Documentation Validation Reference in DocsFab](document-validation.md#content-ir-v3-source-support).

<a id="declare-public-roots"></a>

Refer to [Configure Public Output Roots in DocsFab](../../configure/public-output-roots.md#declare-public-roots).

<a id="delegated-do-pilot"></a>

Refer to [Delegate a Local Task in DocsFab](../../workflows/delegate-a-task.md#delegated-do-pilot).

<a id="draft-mr-private-roots-and-recovery"></a>

Refer to [Deliver or Recover a Draft Merge Request in DocsFab](../../workflows/deliver-draft-mr.md#draft-mr-private-roots-and-recovery).

<a id="egress-refusal-codes"></a>

Refer to [Configure Public Output Roots in DocsFab](../../configure/public-output-roots.md#egress-refusal-codes).

<a id="host-and-private-configuration"></a>

Refer to [DocsFab Host Environment Variables](environment-variables.md#host-and-private-configuration).

<a id="host-paths-in-published-output"></a>

Refer to [Configure Public Output Roots in DocsFab](../../configure/public-output-roots.md#host-paths-in-published-output).

<a id="live-agent-and-one-off-jobs"></a>

Refer to [DocsFab Live Agent Quickstart](../../get-started/live-agent-quickstart.md).

<a id="model-profile-evidence-routes"></a>

Refer to [Model Evidence Routes in DocsFab](model-evidence-routes.md#model-profile-evidence-routes).

<a id="native-harness-preflight"></a>

Refer to [Check Native CLI Readiness in DocsFab](../../manage/check-native-harness.md#native-harness-preflight).

<a id="project-configuration"></a>

Refer to [DocsFab Project Configuration Reference](project-configuration.md#project-configuration).

<a id="sealed-structural-validation"></a>

Refer to [Documentation Validation Reference in DocsFab](document-validation.md#sealed-structural-validation).

<a id="rst-authoring-capability"></a>

Refer to [RST Authoring Capability](document-validation.md#rst-authoring-capability).
