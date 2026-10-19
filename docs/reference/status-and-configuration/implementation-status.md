---
title: DocsFab Implementation Status
description: Distinguish implemented and tested DocsFab capabilities from integrated, planned, and release-blocked behavior.
status: draft
---

DocsFab is in project stage alpha: named internal users run the local CLI
and live-agent as the current product. Public release remains blocked. Use
this page to avoid interpreting a target-product concept as released
behavior. The product reference model records the current repository evidence
boundary. Later tracker, implementation, and runtime changes remain
development evidence until a new source item and immutable model version
reconcile them. For more information, refer to [DocsFab Status and
Configuration Reference](index.md).

## Snapshot

The following table summarizes the current interpretation of each boundary.

| Boundary | Current interpretation |
| --- | --- |
| Public release | Release blocked. No canonical DocsFab release record exists. |
| Complete first-run experience | Planned. Local CLI and live-agent are the current product; the complete Blueprint first-run is not. |
| Local runtime and quality workflows | Repository-tested or implemented with integration pending, as identified in the inventory. |
| GitLab and Fern delivery | Individual paths have repository tests or CI evidence; no row establishes end-to-end release authority. |

Treat every state as scoped to its evidence cell. A passing test, source
build, preview, or retained composition-execution run does not promote a
capability to a released product.

## Status Definitions

The following table defines each state.

| State | Meaning |
| --- | --- |
| Repository-tested | The repository contains implementation and focused tests that pass in a local checkout. This is current-product evidence for that capability, not a public-release claim. |
| Implemented, integration pending | Code or documentation exists, but the complete DocsFab composition or delivery path has not been verified. |
| Pilot-verified | The evidence cell records a successful live pilot journey. This does not establish other deployment modes, broader qualification, or public release. |
| Planned | The canonical product reference model describes the capability, but the repository does not establish working behavior. |
| Release blocked | A release record or required deployment, security, legal, support, or verification evidence is absent. |

## Capability Inventory

### Knowledge and Convergence

The following table lists the state and evidence boundary of each knowledge and convergence capability.

| Capability | State | Evidence boundary |
| --- | --- | --- |
| Source-thread JSON schemas, validation, and rendered views | Repository-tested | Schemas, validator, and source-thread records exist under `packages/knowledge`; package tests pass. |
| Session-transcript evidence mining | Repository-tested | Skill, secret-safe miner, and five Python tests exist. |
| Knowledge event store and local control-plane API | Repository-tested | Local tests cover replay, concurrency, stale writes, authority, artifacts, workflows, adapter boundaries, and a sealed knowledge-snapshot export. |
| Product-model interview procedure | Implemented, integration pending | Consent-aware skill and artifact contract exist. No production interview UI is established. |
| Source-thread synthesis and model package | Implemented, integration pending | Skill, synthesis contract, and DocsFab candidate model versions exist. A persistent autonomous reconciler is not established. |
| Bounded context compilation for one hosted job | Repository-tested | Local tests pass. Live hosted compilation remains integration pending. |
| Merge-triggered report-only reconciliation | Repository-tested | Local tests pass. Complete live merge reporting remains unverified. |
| Owner-controlled Slack advisory summaries | Implemented, integration pending | Questions-only is the default. Protected initial configuration and owner-only Slack status/mode commands control summaries for new advisory results. Real Slack command, delivery, and quiet clean-merge evidence remain separate deployment acceptance. |
| Structured accountable-owner adjudication | Repository-tested | Local tests pass. Live qualification, including routing through a confirmed ownership map, remains incomplete. |
| Governed post-adjudication model and projection convergence | Repository-tested | Local tests pass. Live PRD, SRD, and POR projection regeneration from accepted decisions remains integration pending. |
| Bounded adjudication and post-reconciliation documentation convergence | Repository-tested | The synthesis skill prompts for one-at-a-time adjudication and defines regeneration plus an all-family readiness rescan. Autonomous semantic reconciliation remains incomplete. |

The default merge-reconciliation interaction posts governed questions only.
The mapped product-decision owner can use `/docsfab reconciliation status` and
`/docsfab reconciliation mode questions|advisories` in the approved project
conversation. Advisories mode adds summaries for newly completed eligible
advisory analyses, without owner mentions or historical backfill. Clean and
informational-only results remain silent in both modes. Failed,
missing, corrupt, quarantined, retried, and superseded results do not become
Product Reference Model conflicts. An eligible conflict produces one request
that mentions the uniquely mapped accountable owner. An attributable reply can
resume the existing candidate lineage, but it cannot approve, publish, merge,
or deploy.

The current worker classifies changed paths; it does not semantically compare
source changes against the Product Reference Model. Advisory summaries expose
that screening result without changing finding severity or owner authority.
Visibility settings persist across restart, and disabling advisories
suppresses pending unattempted deliveries. Uncertain Slack posts remain
inspectable rather than being automatically reposted. General debug levels
and raw log streaming remain outside this slice.

### Quality and Documentation Behavior

The following table lists the state and evidence boundary of each quality and documentation behavior capability.

| Capability | State | Evidence boundary |
| --- | --- | --- |
| NVIDIA-derived writing profile | Implemented, integration pending | A lineage-bearing compact profile is packaged under `packages/quality`; broader quality-pack integration remains incomplete. |
| Central skill catalog and runtime-bound quality workflows | Repository-tested | Eight canonical skill sources exist under one inventory. Source-fact inventory is a Pin A step of `verify-technical-accuracy`, not a ninth catalog identity. Focused polish is part of `write-documentation`; the standalone `polish-documentation` skill is retired. Exact staged copies are hash-locked in the runtime crate. Four validated manifests under `packages/runtime/workflows/` define the operator-runnable jobs. Representative-audience and broader comparative live-model evidence remain pending. |
| Five-function quality model and many-to-many capability coverage | Planned | The product reference model defines the provider-neutral functions. Runtime bindings and complete evidence are not implemented. |
| Clean non-author adversarial review | Implemented, integration pending | The product reference model requires a clean subagent for agent-authored content and a different human or clean agent for human-authored content. Explicit reviewer-independence attestation remains incomplete. |
| Conditional, bidirectional SRD lifecycle | Planned | The product reference model is canonical, and SRDs are optional inputs or outputs. Current shared skills still implement the narrower SRD-first preview. |

### Runtime and Execution

The following table lists the state and evidence boundary of each runtime and execution capability.

| Capability | State | Evidence boundary |
| --- | --- | --- |
| Governed documentation runtime and `docsfab` CLI | Repository-tested | The runtime exposes four catalog workflows, including composed creation, update, and restructuring jobs. `docsfab --version` reports the `packages/runtime/package.json` version, and `docsfab help` exposes the current command catalog. The package is not established here as an approved product release. |
| Derived runtime state preparation | Repository-tested | `runtime:prepare` generates and verifies the derived graph once in dependency order. This is a local CI path; exact-merge integration remains subject to CI evidence. |
| Provider-neutral Pi executable compositions | Repository-tested | Explicit `--composition <id>` routing supports NVIDIA, direct OpenAI, and direct Anthropic connections. Provider-offline contract tests cover all three transport families. Every composition-execution result remains technically unapproved and not release eligible. |
| Codex and Claude Code native composition preflight | Implemented, integration pending | `docsfab composition list` exposes two `preflight-only` compositions. Contained native execution and role qualification remain unimplemented. |
| Cross-harness development pilot | Implemented, integration pending | `docsfab composition pilot-campaign` can collect live development evidence only with explicit acknowledgment of the uncontained boundary. It provides no ranking, technical approval, or merge authority. |
| Bounded local Docker and Brev runtime previews | Repository-tested | `deploy/compose/` and `deploy/brev/` package and smoke the current CLI. These paths do not provision a complete Blueprint environment or establish release readiness. |
| Complete NVIDIA Blueprint first-run | Planned | The complete one-command journey, managed Brev provisioning, approved model and serving profile, live watch, and release evidence are not established. |
| `.docsfab.json` project configuration | Repository-tested | `docsfab init` previews and applies a digest-bound configuration containing the GitLab remote and default branch. Private state stays under `.docsfab/` or `DOCSFAB_CONFIG_ROOT`. |

### GitLab and Documentation Delivery

The following table lists the state and evidence boundary of each GitLab and documentation delivery capability.

| Capability | State | Evidence boundary |
| --- | --- | --- |
| Phase A GitLab merge-request notification | Repository-tested | The host package can emit one terminal or needs-decision note through a fake-testable transport. It does not provide a live GitLab HTTP client. |
| Existing-MR review summary note | Pilot-verified | A hosted review-to-note journey is verified for a frozen merge-request head. This does not qualify webhook intake. Hosted quality validation remains an open follow-up. |
| Phase B GitLab mention-submit | Repository-tested | A signed Note Hook can parse `@docsfab run <workflow>` and call the host submit/observe spine. Mentions cannot mint `--allow-write`. |
| Provider-neutral merge-request change-event intake | Repository-tested | Local tests cover GitLab open, update, merge, and close normalization. Live receiver testing remains integration pending. |
| PostgreSQL host-service persistence | Repository-tested | Local tests cover project-bound PostgreSQL persistence. This is local harness evidence, not a live deployment. |
| Guarded PostgreSQL 16 bootstrap | Implemented, integration pending | Local tests pass. DocsFab schemas and project bindings remain integration pending. |
| Project activation package preparation | Repository-tested | Local tests cover closed activation inputs. Live activation remains integration pending. |
| Provider-neutral polling service integration | Implemented, integration pending | Each project requires one sealed `poll` or `webhook` policy without fallback. Complete live polling and webhook verification remain pending. |
| Runnable multi-project host ingress | Implemented, integration pending | Local tests cover per-project PostgreSQL-bound runtime composition. Cross-project worker isolation and a live epoch rollover remain unverified. |
| Host submit/observe spine | Repository-tested | Durable submit, observe, cancel, pause, and resume exist for one catalogued work packet under `packages/host/src/jobs/`. |
| Bounded hosted dispatcher | Repository-tested | Local tests cover digest-bound hosted dispatch. This evidence is not a live provider or service deployment. |
| Activated repository grants | Repository-tested | Host persists a versioned grant for one GitLab host and numeric project and evaluates named operations. Workers receive a decision, not a token. |
| GitLab publisher credential broker | Repository-tested | Host issues opaque task-scoped leases to a fixed-purpose publisher. A lease is not repository authority. |
| Host-owned create-or-reuse draft MR | Repository-tested | Typed `create-draft-mr` apply exists under `packages/host/src/gitlab-publisher/apply.ts`. A live SCM call is not claimed here. |
| Local-user `--draft-mr` publish | Repository-tested | Runtime local-user delivery can open a draft MR through `glab` in focused tests. Live GitLab execution is separately authorized and not claimed here. |
| Fern site delivery | Implemented, integration pending | CI defines merge-request Review Apps, a default-branch build, and SemVer-tag publication using Fern components `0.24.0`. Pipeline configuration does not prove that a release was approved or published successfully. |
| Repository-automation mode | Implemented, integration pending | Mailbox notify, mention-submit, thread-reply resume, merge-request change-event intake, merge-triggered report-only reconciliation, and the bounded host-job consumer exist as repository-tested paths. Production adapters and the dispatcher are implemented. Complete live qualification remains separate deployment acceptance. |

### Interaction, Deployment, and Release

The following table lists the state and evidence boundary of each interaction, deployment, and release capability.

| Capability | State | Evidence boundary |
| --- | --- | --- |
| Hosted Slack-first core deployment | Pilot-verified | A hosted review-note journey is verified. This does not establish full host qualification; webhook and review-quality follow-ups remain open. |
| Interactive MCP, Slack, or chat mode | Implemented, integration pending | Local tests cover one deployment-level Slack Socket Mode connection with project-bound ports. MCP and other chat adapters remain planned. |
| Local CLI interaction mode | Repository-tested | `docsfab live-agent` provides one persistent, interactive Pi conversation for a local repository. Focused tests establish the entry point, capability loading, and resume behavior. |
| Fully hosted DaaS mode | Planned | Product intent defines a hosted backend and purpose-built application experience; no released service or UI is established. |
| Target onboarding journey | Planned | The authored design covers local Docker, Brev without nested sandboxing, immediate CLI onboarding, one governed job, and live watch. Operational instructions and the exact model profile remain open. |
| Authenticated multi-user service | Planned | Identity, tenancy, broker, and service-operation contracts are not released. |
| Brev reference deployment and model guidance | Release blocked | DocsFab sends inference to the model endpoint that you configure with `docsfab setup` and does not depend on a NIM. Any demonstration model, guidance on region, data policy, quota, fallback, and cost owner for the endpoint you choose, the Brev Launchable, and deployment evidence remain open. |
| Public release | Release blocked | No canonical DocsFab release record exists. |

## One-Shot Slack Questions

The host implements the bounded Stage 1 Slack question path. A mapped user can
run `/docsfab ask <question>` (free text, optional `target=<repo-relative-path>`
as the first or last word; without one, DocsFab answers from the tracked
documentation pages that best match the question and names them in the answer)
when both the project dispatcher policy and that user route
activate `live-agent-turn`. The
host persists the opening thread and turn identity, submits one job through the
normal spine, and runs the read-only hosted workflow. The run record keeps the
frozen scope. With `target=`, the turn runs against that page. Without one, the
frozen scope names the project's landing page, and the runtime replaces it with
the pages the documentation index approves before the model's first step. The
host then loads the terminal answer from project-bound content-addressed
storage and delivers at most three ordered chunks to the same thread. A top-level @-mention
of the DocsFab app asks the same way, with the words after the mention as the
question, and its replies go in the mention's own thread. In a direct message
whose route lists `live-agent-turn`, a top-level message asks the same way.
When one project's registry entry sets `slack.unboundAsks`, that project
answers questions in every Slack conversation no project is bound to (a direct
message to DocsFab, or a channel DocsFab is in that has no route or command
channel), from anyone in the workspace, with no channel membership check.
There, a top-level @-mention, `/docsfab ask`, or a top-level message in a
direct message opens a read-only session answered in its thread; an
@-mention inside another thread gets usage guidance instead. `/docsfab help`
there says how to ask, every other command is refused as before, and status
and reconciliation reports stay in each project's report channel. Without
that setting, an @-mention in a channel that no project serves gets one reply
that says so and names the channels where every member can use DocsFab.

Controlled component tests cover adapter-to-dispatcher-to-runtime-to-run-record
flow, duplicate ingress, restart delivery, project routing, denied admission,
failure notices, answer bounds, and the unchanged terminal-pointer guard.
Conversation resume, progress and cancel controls, writes, MCP, deployment,
and a real Slack/model exchange remain pending.

## Evidence Sources

Use the following checked-in sources to verify the inventory:

- [Runtime package overview](../../../packages/runtime/README.md)
- [Knowledge contracts, skills, and tests](../../../packages/knowledge/README.md)
- [Quality policy and evidence](../../../packages/quality/README.md)
- [Canonical skill catalog](../../../packages/skills/README.md)

The previously affected `brace-expansion` production path is resolved. DocsFab
pins `@earendil-works/pi-coding-agent@0.84.4`, whose locked nested dependency is
`brace-expansion@5.0.9`, past the `5.0.8` patch for
`GHSA-mh99-v99m-4gvg`. The dependency check now runs without an active
exception and fails if an affected version is reintroduced. This focused
remediation is not a general production-security or release-readiness result.

## Interpretation Rule

Conceptual pages can explain the target product when they label that boundary.
Procedures and reference pages must use verified commands, schemas, and
interfaces. Release notes require a canonical release record and cannot be
generated from plans alone.

## Related Topics

The following pages provide related information:

- [Runtime CLI and Configuration in DocsFab](runtime-cli-and-configuration.md)
- [Documentation Convergence and Freshness in DocsFab](../knowledge-and-delivery/delivery/documentation-convergence.md)
- [Documentation Constraint Evidence in DocsFab](../quality/documentation-constraint-evidence.md)
