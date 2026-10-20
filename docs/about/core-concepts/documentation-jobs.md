---
title: Documentation Jobs in DocsFab
description: Learn what a DocsFab documentation job is, which jobs the catalog offers, what a job returns, and why a result grants no write or merge authority.
status: draft
---

A documentation job binds one named outcome to a repository revision and
explicit authority in [DocsFab](../index.md). Its workflow defines the steps,
and each step receives only its allowed tools and context.

This `Task → Workflow → Step` structure lets you inspect what the job was
asked to do, what it changed, and which evidence supports the result. Direct
live-agent conversation and edits use their own interactive-operation
evidence; they do not create a named-workflow run record. For the other
concepts behind a result, refer to [Core Concepts](../index.md#core-concepts).

## The Model Proposes and the Runtime Controls

A model can propose a documentation change, but the model does not decide what
can happen. The DocsFab runtime decides which job runs, what each step can
read or change, when the job must stop, and what evidence it keeps.

The following table shows the layers that take part in one job.

| Layer | Question it answers |
| --- | --- |
| Model | Given this step's context, what response or tool call comes next? |
| DocsFab runtime | Which job and step are running, what can they access, when must they stop, and what evidence must they keep? |
| Confined tools | Which read, search, edit, write, or validation action can this step perform? |
| Disposable workspace | Where can the action happen without changing your checkout? |
| Run record and patch | What happened, what changed, and what can a reviewer inspect? |

Fixed workflows make the intended outcome, the authority, and the evidence
reviewable. The runtime schedules only catalog-bound, hash-locked skills. A
skill file on disk does not create or activate a job. For how the runtime
binds inputs and connects to GitLab and the model, refer to
[DocsFab Architecture](../../reference/architecture.md#data-flow).

## Catalog Jobs

The local `docsfab` CLI runs the jobs in its catalog. Run `docsfab list` to
see the jobs installed for you. The catalog contains the following jobs.

| Job | What it does | Authority |
| --- | --- | --- |
| `review-documentation` | Reviews a documentation set with audit, deterministic, technical, editorial, audience, and quality evidence. | Read-only |
| `create-documentation` | Creates documentation for a specific audience and scope. | Write-capable; requires `--instruction` |
| `update-documentation` | Updates existing documentation for a product or API change, or verifies that no change is needed. | Write-capable; requires `--instruction` or a resume |
| `restructure-documentation` | Reorganizes a documentation set while preserving content, routes, and navigation. | Write-capable; requires `--instruction` |
| `audit-documentation` | Checks every page against its template. It makes no model call. | Read-only |
| `readiness` | Assesses whether agents can reliably use the repository as input. | Read-only |
| `release-documentation-readiness` | Assesses public release-documentation readiness and returns a work plan. Requires a tracked `.docsfab.json`. | Read-only |
| `bootstrap` | Proposes minimal `README.md` and `AGENTS.md` guidance, or asks explicit questions. | Write-capable |

An unknown job name fails closed. For the ordered steps of each job, refer to
[Workflow Contracts in DocsFab](../../reference/workflow-contracts/index.md).

## What You Get Back

The model works in a disposable export of the pinned revision, not in your
checkout. Your checkout stays unchanged. A finished job returns the following:

- A structured run record bound to the revision, workflow, and pinned inputs.
- Findings, when the job is a review or when write work cannot complete
  honestly.
- A Git patch, when a write-capable job produces a change.

Execution status and product readiness are separate results. A job can run
to completion and still report its outcome as `not-ready`, `needs-input`,
`inconclusive`, or `blocked`. An update that finds no documentation change is
needed reports a verified no-change result instead of a rewrite. For how
DocsFab reports a job that cannot finish, refer to
[When a Job Stops in DocsFab](job-stops.md).

## A Result Grants No Authority

Evidence records what a job observed or produced. Authority is a separate,
explicit decision that permits one narrowly defined change. A run record, a
model response, or an artifact that a job wrote cannot grant authority by
itself.

The following rules apply to every job:

- A green review is not a write.
- A patch is not merge authority.
- A model request for a write does not grant write authority.
- A draft merge request is a proposal, not an accepted change.
- A quality evaluation is evidence for reviewers, not approval to merge or
  publish.

Merge stays outside DocsFab, with one narrow exception. Your organization's
review, required checks, and an explicit merge decision remain separate from
the job. Publication of the rendered documentation site is another separate
step.

The exception is the product reference model's own updates. With the
maintain-prm add-on on a `Contribute` grant, the feedback publisher readies its
own merge request and adds it to the merge train, and GitLab merges it after
the required pipeline passes. DocsFab never merges, approves, or readies any
other merge request. For the grant, refer to
[Standing Repository Grant in the Glossary](../../resources/glossary.md#s).

## Delivering Results

After a successful `create-documentation`, `update-documentation`, or
`restructure-documentation` job, the CLI opens one draft merge request by
default. It uses `glab` with your own GitLab authentication, so you need an
origin remote (or `--remote <name>`), an authenticated `glab`, and permission
to push and create a merge request. Pass `--patch-only` to keep the patch
locally without opening a merge request.

DocsFab uses GitLab in two different ways. Keep them separate when you read a
result. The following table compares them.

| Action | What GitLab shows | What it means |
| --- | --- | --- |
| Comment on an existing merge request | One summary note on that merge request | Communication about a job, such as review findings. It does not change the source branch. |
| Open a draft merge request | A new branch and one draft merge request | Delivery of a patch from a successful write job. It does not merge anything. |

The model never receives a GitLab token or a general shell. Delivery checks
the exact patch and target branch again immediately before it changes GitLab.
A stale patch, a moved branch head, or missing permission stops delivery. To
deliver a retained patch or recover a failed delivery, refer to
[Deliver or Recover a Draft Merge Request](../../workflows/deliver-draft-mr.md#deliver-or-recover-a-draft-merge-request).

On a first write, DocsFab can propose a `.docsfab.json` project configuration
in the same patch. For the rules that limit which paths a job can write,
refer to [The Write Scope](../../reference/status-and-configuration/request-interpretation.md#the-write-scope).

## Related Documentation

For more information, refer to the following pages:

- [Run a Documentation Workflow in DocsFab](../../workflows/run-a-documentation-workflow.md)
- [Workflow Contracts in DocsFab](../../reference/workflow-contracts/index.md)
- [Architecture Overview](../architecture.md)
- [Security and Trust](../security.md)
