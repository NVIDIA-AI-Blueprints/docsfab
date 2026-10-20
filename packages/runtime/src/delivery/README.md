# Delivery

This directory turns a verified saved workflow patch into a validated Git commit
and draft GitLab merge request. Delivery is a separate authority boundary after
workflow execution: producing or saving a patch does not grant permission to
apply, commit, push, open, update, or merge anything.

Read-only review delivery planning is in the sibling
[`../review-delivery/`](../review-delivery/) package. It can place an exact
technical issue inline on the after side of an ordinary modified document only
when a cold reader verifies the selected step's retained confined-read bytes
against the reviewed change source and current file snapshot. Unproved, legacy,
before-side, base-side, created-file, and publication-dependent locations stay
in the summary; the planner does not publish comments or grant SCM writes.

Start with the [runtime source map](../README.md) for surrounding code. The
[local GitLab publishing reference](../../docs/reference/operations/local-user-gitlab-publishing.md)
describes the operator flow; the
[delivery acceptance guide](../../docs/publish-a-patch/delivery-acceptance.md)
defines the end-to-end evidence requirements.

## The two patch paths

A successful write workflow saves a patch with its run record. The local live
agent can apply that patch back to the current checkout through
[`../live-agent/workflow-delivery.ts`](../live-agent/workflow-delivery.ts). That
path checks the run, base revision, changed paths, and patch before applying it;
it does not commit or publish as part of checkout persistence.

This directory owns the separate GitLab delivery path. It loads the exact saved
run and patch, resolves repository and GitLab facts, creates a bound publication
plan, requires current host authority, prepares an isolated delivery worktree,
applies and validates the patch there, commits and pushes the planned branch,
and opens or reuses the bound draft merge request.

## Read order

1. [`preflight.ts`](preflight.ts) loads and decodes the successful write run,
   checks repository, remote, identity, branch, patch, and validation inputs,
   then seals the publication plan.
2. [`contracts.ts`](contracts.ts), [`delivery-authority.ts`](delivery-authority.ts),
   and [`effective-authority.ts`](effective-authority.ts) define and check the
   host-held authority used at mutation boundaries.
3. [`worktree.ts`](worktree.ts) is the public facade for isolated preparation and
   inspection; follow it into [`worktree/`](worktree/) for implementation.
4. [`publisher.ts`](publisher.ts) coordinates validated Git and GitLab effects.
   [`git-publisher.ts`](git-publisher.ts) and
   [`gitlab-adapter.ts`](gitlab-adapter.ts) own those transports.
5. [`receipt.ts`](receipt.ts) and [`receipt-store.ts`](receipt-store.ts) record
   resumable, idempotent delivery progress.
6. [`cli.ts`](cli.ts) assembles preflight, authorization, worktree, validation,
   publication, and recovery for the local command surface.

## Worktree boundary

The `worktree/` directory keeps publication away from the source checkout:

- [`materialize.ts`](worktree/materialize.ts) creates and populates the exact
  delivery tree from the bound base and patch;
- [`validate.ts`](worktree/validate.ts) runs the selected validation and emits
  bounded evidence;
- [`validation-isolation-policy.ts`](worktree/validation-isolation-policy.ts)
  selects the permitted isolation behavior;
- [`host.ts`](worktree/host.ts) prepares and inspects the ready-worktree
  attestation;
- [`publish-plan.ts`](worktree/publish-plan.ts) binds the tree ready for the
  publication step.

Preparation and publication recheck authority and relevant repository identity
near the effects they protect. Validation success does not widen path scope or
authorize a different branch, remote, repository, or merge request.

## Records and remote truth

The SCM delivery record advances through planned, prepared, validated,
committed, pushed, and opened evidence, or a bounded failed disposition. Its
store uses compare-and-set behavior so restart and retry cannot silently replace
another attempt's state.

A receipt proves what this delivery pipeline observed and retained at a
particular point. It does not by itself prove that the current remote branch or
merge request still has that state. Callers that claim current GitLab state must
read it again and apply the appropriate freshness checks.

[`update-existing-mr/`](update-existing-mr/) is a narrow, destination-neutral
policy surface for evaluating a requested update against a specific project,
MR, branches, expected head, requester, and opaque host authority. It does not
grant general MR mutation or merge authority, and its current contracts and
evaluation are not a blanket publisher.

The sibling [`../publication/`](../publication/) contains only a public export
and content-minimized provenance projectors. Delivery consumes those projections
for publication metadata; the projection facade does not perform SCM effects.

## Common changes

| Task | Source | Focused evidence |
| --- | --- | --- |
| Change run or publication-plan admission | [`preflight.ts`](preflight.ts), [`contracts.ts`](contracts.ts) | [`delivery-publisher.test.ts`](../../test/delivery-publisher.test.ts) |
| Change isolated preparation or validation | [`worktree/`](worktree/) | [`delivery-worktree.test.ts`](../../test/delivery-worktree.test.ts) |
| Change Git or GitLab publication | [`publisher.ts`](publisher.ts), [`git-publisher.ts`](git-publisher.ts), [`gitlab-adapter.ts`](gitlab-adapter.ts) | [`delivery-publisher.test.ts`](../../test/delivery-publisher.test.ts) |
| Change receipt transitions or persistence | [`receipt.ts`](receipt.ts), [`receipt-store.ts`](receipt-store.ts) | [`delivery-receipt.test.ts`](../../test/delivery-receipt.test.ts), [`delivery-receipt-store.test.ts`](../../test/delivery-receipt-store.test.ts) |
| Change CLI recovery and assembly | [`cli.ts`](cli.ts) | [`delivery-cli.test.ts`](../../test/delivery-cli.test.ts) |
| Change existing-MR eligibility | [`update-existing-mr/`](update-existing-mr/) | [`contracts.test.ts`](../../test/delivery/update-existing-mr/contracts.test.ts) |

Keep workflow execution, checkout application, delivery authority, and remote
observation distinct in code and in completion claims.
