---
title: Glossary
description: Look up the product, knowledge, workflow, and quality terms used throughout DocsFab documentation.
status: draft
---

Use this glossary to look up DocsFab product, knowledge, workflow, delivery,
authority, and quality terms. Each definition gives the DocsFab-specific
meaning; follow its related link when you need the full concept or contract.

**Browse alphabetically:** [A](#a) · [C](#c) · [D](#d) · [E](#e) · [F](#f) ·
[G](#g) · [H](#h) · [I](#i) · [J](#j) · [M](#m) · [N](#n) · [P](#p) · [Q](#q) ·
[R](#r) · [S](#s) · [T](#t) · [W](#w)

## A

Approval
: A recorded grant from an accountable authority for a specific mutation,
  publication, release, or external action. Approval for one boundary does not
  imply approval for another.

Artifact
: A versioned workflow output, such as a finding, report, documentation page,
  patch, preview, branch, or proposed pull request or merge request.

## C

Context Packet
: A revision-bound, budgeted structural view of the selected repository that
  the runtime prepares before a workflow step. Packet contents are not
  retained in run records.

## D

Documentation Brief
: A target-specific handoff that pins the audience, reader outcome, repository
  revision, product reference-model version, evidence, style profile,
  template, quality policy, and authority boundary.

Documentation Convergence
: The post-reconciliation transition that updates affected pages, rescans
  every configured information-architecture family, generates newly ready
  missing targets, and records targets that remain blocked.

  **Related:** [Documentation Convergence and Freshness in DocsFab](../reference/knowledge-and-delivery/delivery/documentation-convergence.md)

Documentation Readiness
: The evidence-backed assessment of whether DocsFab has enough information to
  produce one documentation target for a named audience and release.

  **Related:** [Evidence Before Drafting](../about/core-concepts/documentation-quality.md#evidence-before-drafting)

Durable Patch
: The Git binary patch the runtime preserves from an authorized write-capable
  run before the disposable workspace is cleaned up.

## E

Evidence State
: The custody or transformation state of a source item, such as raw,
  source-authored, participant-edited, transformed, awaiting confirmation, or
  attribution-unverified.

## F

Façade Inputs
: The three replaceable inputs at the DocsFab package edge: imported accepted
  canon (knowledge), a locked quality pack, and the one-job runtime executor.
  Runtime does not own product truth.

Finding
: An identified technical, editorial, audience, policy, or delivery issue that
  remains active until addressed or explicitly dismissed with rationale.

## G

Governed Workflow
: A fixed `Task → Workflow → Step` contract with bounded tools, defined
  evidence, and explicit write authorization. Disk presence of a skill does
  not activate a governed workflow.

  **Related:** [Documentation Jobs in DocsFab](../about/core-concepts/documentation-jobs.md)

## H

Host
: `packages/host`, a DocsFab GitLab channel. It is not a fourth façade and
  not an outside product. Runtime writes the patch. Host is the only
  DocsFab code allowed to hold a GitLab credential long enough to post a
  note or, when authorized, open a draft merge request.

  **Related:** [Delivering Results](../about/core-concepts/documentation-jobs.md#delivering-results)

Host Publisher
: The fixed-purpose DocsFab component in `packages/host` that may redeem a
  task-scoped credential lease and perform a typed GitLab mutation. A
  valid lease is not a repository grant.

## I

Inconsistency
: A meaningful difference between source claims, classified by behavior,
  intent, terminology, scope, version, representation, or documentation
  quality and routed to an appropriate resolution owner.

Inference Hub Metadata
: The authenticated DocsFab catalog-evidence adapter that reads only
  `INFERENCE_HUB_METADATA_API_KEY` (`ihub_api_...`). It is not used for
  ordinary composition-execution inference.

  **Related:** [Install DocsFab](../get-started/installation.md)

## J

Job
: One bound execution of a catalogued workflow against a pinned repository
  revision, using pinned knowledge and a locked quality pack. This is the
  sense used throughout this documentation set, as in "the runtime is a
  one-job executor" and "a job takes pinned knowledge".

  **Related:** [Documentation Jobs in DocsFab](../about/core-concepts/documentation-jobs.md)

Job Packet
: The durable record the host tracks for one submitted workflow, carrying its
  own status, events, and progress through submit, observe, cancel, and
  resume. Statuses are `queued`, `running`, `needs-input`,
  `needs-human-decision`, `succeeded`, `failed`, and `cancelled`. The spine
  that manages packets is repository-tested and has no production caller.

  **Related:** [Delivering Results](../about/core-concepts/documentation-jobs.md#delivering-results)

## M

Mailbox
: A DocsFab surface that kicks off, observes, and resumes **one** catalogued
  job on an existing conversation (GitLab merge-request notes first). It
  talks on that merge request. It does not by itself open a new draft
  merge request.

  **Related:** [GitLab Host Mailbox in DocsFab](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md)

Merge Receipt
: The immutable record of a synthesis boundary, exact inputs, claim decisions,
  inferences, conflicts, approvals, and delta from a prior product reference
  model.

Model Context Protocol
: An interface through which an agent can access governed tools or context.
  DocsFab identifies MCP as one possible interactive adapter; the product
  contract does not depend on it.

## N

Needs Input
: An honest product stop that records a named gap instead of inventing
  intent. Several doors can print this string: routing-time `do`,
  delegated pause, editorial work products, knowledge continuation,
  human-decision (CLI-skinned), and product disposition `needs-input`.
  They are not the same class. Refer to the Stop Classes tables.

  **Related:** [Stop Classes in DocsFab](../reference/status-and-configuration/stop-classes.md)

Non-Author Review
: Adversarial evaluation by a person or clean agent that did not participate
  in producing the artifact. Same-session self-review does not satisfy this
  minimum DocsFab gate.

NVIDIA API Catalog
: The hosted NVIDIA chat route at `https://integrate.api.nvidia.com/v1`.
  Installed NVIDIA API Catalog compositions authenticate with
  `DOCSFAB_NVIDIA_API_KEY` only.

  **Related:** [Install DocsFab](../get-started/installation.md)

NVIDIA Inference API
: The internal NVIDIA Inference Hub serving route, `nvidia-inference-api`,
  an OpenAI-compatible origin recorded in the route registry. DocsFab uses
  it for catalog inspection and the optional semantic judge, not for the
  NVIDIA API Catalog compositions.

NVIDIA Inference Hub
: The internal NVIDIA catalog and key console at
  [NVIDIA Inference Hub](https://inference.nvidia.com). Other tools often
  store the same key as `NVIDIA_API_KEY` or `NVINF_HUB_KEY`. DocsFab does
  not read those names.

## P

Product Disposition
: The product-outcome plane of a finished job, independent of execution
  status: `ready`, `not-ready`, `needs-input`, `inconclusive`, or
  `blocked`. Successful execution is not a ready product.

  **Related:** [Stop Classes in DocsFab](../reference/status-and-configuration/stop-classes.md)

Product Reference Model
: A versioned package of evidence-linked claims, relationships, terminology,
  diagrams, conflicts, decisions, open questions, and readiness assessments
  that is the canonical representation of shared product understanding for a
  defined scope.

  **Related:** [Product Knowledge in DocsFab](../about/core-concepts/product-knowledge.md)

Projection
: A reader-oriented representation derived from a reference model, such as a
  documentation page, diagram, glossary, summary, or readiness view. A
  projection does not replace its source model or evidence.

## Q

Quality Capability Slot
: One required MVP quality outcome. Slots are covered many-to-many by human
  or agent roles, skills, checks, policies, knowledge operations, runtime
  behavior, and repository automation; they do not imply one skill per slot.

  **Related:** [Quality Roles and Capability Coverage in DocsFab](../reference/quality/quality-roles-and-capabilities.md)

Quality Function
: A required judgment outcome (technical writing, technical review and
  verification, editorial review, quality evaluation, or target-audience
  evaluation) that a configured human or agent provider can supply.

## R

Representation
: An original or derived form of one source item, including its media type,
  locator, integrity, parent representation, and transformation metadata.

Run Record
: An append-only record of what a documentation job requested, planned,
  attempted, completed, verified, delivered, published, failed, or abandoned.

  **Related:** [Runtime CLI and Configuration in DocsFab](../reference/status-and-configuration/runtime-cli-and-configuration.md)

## S

Software Requirements Document
: An optional, project- and workflow-dependent requirements artifact. DocsFab
  can ingest an existing SRD as source evidence, recommend creating one for a
  new project, or generate an updated SRD as a projection of the canonical
  product reference model.

Source Item
: One attributed piece of evidence within a source thread. An item preserves
  its own time, version, scope, governance, lineage, and representations.

Source Thread
: The stable, append-only lineage for one identifiable evidence origin. A
  thread can contain multiple documents, interviews, diagrams, tests,
  observations, and corrections.

  **Related:** [Source Threads](../about/core-concepts/product-knowledge.md#source-threads)

Standing Repository Grant
: A DocsFab permission record, activated by a GitLab Maintainer or Owner
  who is also listed in DocsFab platform policy, for one exact GitLab host
  and numeric project. The `contribute` tier can allow a namespaced
  unprotected push and create-or-reuse draft MR. It does not include
  merge, approve, mark-ready, or protected-default write. The maintain-prm
  add-on lets the feedback publisher ready its own product reference model
  update and add it to the merge train, and nothing more. Host revalidates
  the grant immediately before mutation.

  **Related:** [Delivering Results](../about/core-concepts/documentation-jobs.md#delivering-results) and [A Result Grants No Authority](../about/core-concepts/documentation-jobs.md#a-result-grants-no-authority)

Stop Class
: One operator-visible reason DocsFab declined to pretend the work was
  done, paired with a next action or a named missing input.

  **Related:** [Stop Classes in DocsFab](../reference/status-and-configuration/stop-classes.md)

Synthesis
: The governed comparison of selected source-thread claims that creates a new
  candidate model version, inconsistency report, and merge receipt.

## T

Task
: A canonical request that identifies the desired documentation outcome,
  requester, repository revision, model version, workflow, and authority.
  This is the runtime sense, written as `Task` in the
  `Task → Workflow → Step` contract.

## W

Workflow
: A versioned sequence or graph of governed steps used to produce a bounded
  documentation outcome.

  **Related:** [Workflow Contracts in DocsFab](../reference/workflow-contracts/index.md)

## Related Documentation

Use the following pages for the concepts and contracts that appear most often
in this glossary:

- [DocsFab Overview](../about/index.md)
- [DocsFab Architecture](../reference/architecture.md)
- [Documentation Jobs in DocsFab](../about/core-concepts/documentation-jobs.md)
- [Stop Classes in DocsFab](../reference/status-and-configuration/stop-classes.md)
- [A Result Grants No Authority](../about/core-concepts/documentation-jobs.md#a-result-grants-no-authority)
- [Delivering Results](../about/core-concepts/documentation-jobs.md#delivering-results)
- [Source Threads](../about/core-concepts/product-knowledge.md#source-threads)
- [Reference-Model Package in DocsFab](../reference/knowledge-and-delivery/knowledge/reference-model-package.md)
