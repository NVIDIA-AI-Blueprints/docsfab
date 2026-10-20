# Repository workspaces and evidence

This directory owns the runtime's bounded view of a selected Git repository:
exact-revision export, tracked-file reads, inventory, and change evidence. It
does not own applying or publishing a patch; continue in the
[delivery guide](../delivery/README.md) for those operations.
The [runtime source map](../README.md) routes changes outside repository access.

## Know which repository view you have

| View | Created and used by | Meaning |
| --- | --- | --- |
| Selected checkout | CLI/operator | The local Git repository named by `--repo`; it supplies repository identity and the requested revision. Normal workflow execution does not edit it. |
| Exported workflow workspace | [`workspace/materialize.ts`](workspace/materialize.ts), used by [`cli/run/local-workflow.ts`](../cli/run/local-workflow.ts) | A bounded temporary export of tracked blobs from one resolved commit. It has no original `.git` directory or source-repository history. |
| Hosted detached checkout | `packages/host`, consumed by [host-invoker](../host-invoker/README.md) | A clean host-created checkout at the request's exact commit and tree. The child verifies it; this directory does not materialize it. |
| Live direct checkout | [local live agent](../live-agent/README.md) | The current checkout, including uncommitted files. Documentation writes are enabled by default unless `--read-only` is selected; workflows still run in exported workspaces. |
| Delivery worktree | [`delivery/worktree.ts`](../delivery/worktree.ts) | A separate Git worktree at the authorized base revision where the saved patch is applied and validated before publication. |

This distinction protects both evidence and operator state. A successful
workflow can produce a saved patch without changing the selected checkout, and
a newly initialized private evidence repository records a comparison baseline;
it does not recreate the selected repository's history.

## Export and cleanup lifecycle

[`prepareRepositoryWorkspace`](workspace/materialize.ts) resolves the selected
checkout and requested revision to an exact commit, reads its tracked tree, and
exports allowed regular blobs into a temporary directory under bounded file,
byte, scratch-space, per-blob, and aggregate-time limits. Git settings that can
execute hooks, filters, external diff commands, or included configuration are
rejected before export; this rule is about Git configuration, not executable
tracked blobs.

The exported workspace is registered with its filesystem identity and tracked
entry metadata. [`workspace/tracked-read.ts`](workspace/tracked-read.ts)
rechecks that identity, path containment, file kind, size, and captured bytes
when callers list or read tracked content. It also detects post-export changes
instead of silently treating them as original source.

[`workspace/lease.ts`](workspace/lease.ts) serializes mutations of an active
export. [`withRepositoryWorkspace`](workspace/materialize.ts) wraps use in a
`finally` cleanup; direct callers must invoke `dispose()`. Disposal deactivates
the registered capability before removing its temporary root.

## Inventory and change evidence

[`inventory.ts`](inventory.ts) builds the governed repository discovery view
for a registered workspace. It starts from verified tracked entries, identifies
document and configuration candidates, builds content and navigation
observations, and reports incomplete coverage as evidence rather than
inventing a complete scan. Its closed data shapes are in
[`inventory-contracts.ts`](inventory-contracts.ts). The
[`LocalWorkflowSearchCoordinator`](../search/local-workflow-coordinator.ts)
also accepts a filesystem-only directory when no registered workspace is
available, as in the hosted runner. That fallback reports semantic rubric and
navigation probes as unsupported and does not claim governed inventory
provenance.

[`evidence.ts`](evidence.ts) creates a private Git baseline outside the exported
workspace, stages later workspace bytes against that baseline, and records
changed paths plus an optional binary-capable patch and digest. Runtime-owned
bookkeeping can advance that private baseline only through the dedicated
bounded operation. The collector removes its private temporary repository when
disposed; persisted patch artifacts remain under the run's configured artifact
storage. The [records guide](../records/README.md) explains retained run and
artifact relationships.

## File map

| Area | Source |
| --- | --- |
| Workspace API and failure evidence | [`workspace/contracts.ts`](workspace/contracts.ts) |
| Exact tracked-tree export and disposal | [`workspace/materialize.ts`](workspace/materialize.ts) |
| Active-workspace verification and tracked reads | [`workspace/tracked-read.ts`](workspace/tracked-read.ts) |
| Mutation serialization | [`workspace/lease.ts`](workspace/lease.ts) |
| Security-sensitive export exclusions | [`workspace/export-exclusion.ts`](workspace/export-exclusion.ts) |
| Patch and changed-file capture | [`evidence.ts`](evidence.ts) |
| Repository discovery and document inventory | [`inventory.ts`](inventory.ts), [`inventory-contracts.ts`](inventory-contracts.ts) |
| Navigation inspection | [`navigation-observation.ts`](navigation-observation.ts), [`fern-navigation.ts`](fern-navigation.ts) |
| Documentation source support | [`documentation-source-support.ts`](documentation-source-support.ts), [`documentation-source-applicability.ts`](documentation-source-applicability.ts) |

## Common changes

| Task | Source | Focused evidence |
| --- | --- | --- |
| Change export limits or lifecycle | [`../../../../config/limits/repository.yaml`](../../../../config/limits/repository.yaml) (`repository.workspaceExport*`), [`workspace/contracts.ts`](workspace/contracts.ts), [`workspace/materialize.ts`](workspace/materialize.ts) | [`../../test/workspace.test.ts`](../../test/workspace.test.ts), [`../../test/workspace-export-stall.test.ts`](../../test/workspace-export-stall.test.ts) |
| Change safe Git/tree handling | [`workspace/materialize.ts`](workspace/materialize.ts), [`workspace/tracked-read.ts`](workspace/tracked-read.ts) | [`../../test/workspace-git-batch.test.ts`](../../test/workspace-git-batch.test.ts) |
| Change inventory behavior | [`inventory.ts`](inventory.ts) | [`../../test/repository-inventory.test.ts`](../../test/repository-inventory.test.ts) |
| Change patch evidence | [`evidence.ts`](evidence.ts) | [`../../test/evidence.test.ts`](../../test/evidence.test.ts), [`../../test/first-pass-patch-evidence.test.ts`](../../test/first-pass-patch-evidence.test.ts) |
| Change delivery worktrees | [`../delivery/worktree.ts`](../delivery/worktree.ts) | [`../../test/delivery-worktree.test.ts`](../../test/delivery-worktree.test.ts) |

Keep source-checkout identity, exported workflow state, evidence baselines, and
delivery worktrees distinct in code and documentation. Their Git repositories
and cleanup rules serve different trust boundaries.
