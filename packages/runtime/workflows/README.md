# Runtime workflows

This directory is the canonical source for operator-runnable DocsFab workflow
definitions. Each JSON manifest names one job and its ordered skill ids,
execution modes, prompts, and context policy.

The accepted workflow definition and execution boundary decision keeps this
packaged data separate from the TypeScript registry, contracts, generic
execution engine, and domain-owned internal journeys:

- `src/workflow-registry/` loads, validates, binds, and resolves definitions;
- `src/workflow-contracts/` owns task, search, and outcome codecs;
- `src/workflow-execution/` owns generic scheduling and execution;
- domain directories own internal journeys, adapters, and projectors.

| Workflow | Ordered skill ids |
| --- | --- |
| `review-documentation` | `audit-documentation`, `lint-documentation`, `verify-technical-accuracy`, `review-documentation`, `test-audience-understanding`, `evaluate-document-quality` |
| `create-documentation` | `plan-documentation`, `write-documentation`, `lint-documentation`, `verify-technical-accuracy`, `review-documentation`, `evaluate-document-quality` |
| `update-documentation` | `plan-documentation`, `write-documentation` (update mode; author path inventories source facts first), `lint-documentation`, `verify-technical-accuracy`, `review-documentation`, `evaluate-document-quality` |
| `restructure-documentation` | `audit-documentation` in documentation-set scope, `plan-documentation`, inventory-only `verify-technical-accuracy`, `write-documentation`, `lint-documentation`, `verify-technical-accuracy`, `review-documentation`, `test-audience-understanding`, `evaluate-document-quality` |
| `audit-documentation` | one read-only `audit-documentation` host-operation step that runs the structural template checks; no model call |

`review-documentation` is the operator-runnable review job. It runs the six evaluation
skills once and has no writer or remediation step. The peer-review skill uses
the same id as a step (`step.skill`); `docsfab run review-documentation`
selects the workflow. Its terminal evaluator consumes the preceding five step
summaries as bounded, untrusted evidence and returns the validated report.
Unknown names are not jobs; run `docsfab list`.

`audit-documentation` is the per-page template conformance audit. Its single
step, `audit-template-conformance`, is a host operation: it maps every
documentation page in scope to a governed template from frontmatter or path
conventions, runs `validatePage` from `src/templates/validate.ts` on each mapped
page, and retains a sealed per-page report with host-counted coverage. The
local run binds a harness that refuses inference.
`scripts/check-workflow-boundaries.mjs` pins that one step field by field.

`src/workflow-registry/manifest.ts` validates the exact manifest set, rejects unknown
keys, binds registered search plans, requires `searchPlan` and `searchMode`
together, requires context-policy steps to match the
workflow steps in order, requires every `consumes` reference to name an earlier
step, requires `consumesEvidence` to name earlier sealed steps, and recursively
freezes the result. `catalog.ts`
combines those validated jobs with internal parked definitions; it does not
duplicate the runnable step lists.

`npm run check:workflow-boundaries` rejects a restored `src/workflows/`, an
unexpected top-level manifest, or a public TypeScript workflow definition.

Skills remain canonical under `packages/skills/<id>/`. A manifest may schedule
only ids present in the generated hashed runtime crate. Adding, removing, or
retargeting a step therefore requires one atomic manifest, skill-crate, lock,
test, and documentation update.

## Hosted native manifests

`foundation`, `foundation-to-patch`, `ia-analysis`, `ia-plan` and
`site-bootstrap` are hosted manifests, not operator-runnable jobs: they have no
`docsfab run` entry point and the general `docsfab list` output is unchanged.
They arrive through the host dispatcher as sealed native tasks. Four of the five
run as native host operations rather than as inference; `ia-analysis` is the one
native job whose own step IS an inference step, so its governed discovery search
is pinned in the manifest instead of being selected by the model.
`site-bootstrap` is the one native job whose step is a `write` step, so it is
also the only one that requires a separate operation-specific write grant.

| Hosted workflow | Execution and retained result |
| --- | --- |
| `foundation` | Read-only `doc-context-analyzer` native inspection with no model call. It retains a candidate canon, the full inspection record, and actionable onboarding questions. The protected approved-model digest must match the transported snapshot; a canon custody never approved, and one that is approved but is not a decodable accepted snapshot, both seed nothing and stay `needs-input` rather than failing. Only a canon whose bytes contradict their own content digest or Git blob id is refused outright. |
| `ia-analysis` | A read-only `tpl-design-ia` inference step under the pinned `information-architecture-discovery` search plan in `observe` mode. It provisions a canonical query-only input package for the exact checkout, never consuming another job's proposed ontology as fact, and retains the validated analysis output package in project custody. The retained package and each artifact it produces are bounded by `ia.analysisOutputMaxBytes`. |
| `ia-plan` | A read-only `tpl-design-ia` `host-operation` step with no model call: its harness refuses inference outright. It accepts at most one predecessor `ia-analysis` receipt, refuses a selection whose producer, repository identity, revision, receipt or bytes differ from the reference, and turns the admitted analysis into one canonical planning input package plus an `ia-plan` artifact. A request with no selection at all is not an error: it returns the canonical missing-package result with no private recovery command in any user-facing string. |
| `site-bootstrap` | Native `site-bootstrap` operation. It uses `template-scaffold-site` as read-only guidance and applies only a separately signed approved plan. It retains its actual operation record and reviewable patch. The bundle the host registered is admitted only up to `siteBootstrap.bundleMaxBytes`, the same bound the operator import and the parked command-line reader apply, and the reviewer policy the import registered only up to `siteBootstrap.reviewerPolicyMaxBytes`; both are refused on the size custody declared, before a byte is read. The retained operation record is admitted only up to `siteBootstrap.runRecordMaxBytes`. The plan must have been produced by an `ia-plan` job at this exact revision, carry a registered approval import, and name only outputs inside the installed grant's path ceiling; the reviewer policy the host staged must be the one that import registered. Because every link of plan -> signature -> import -> job is bound to one revision, a merge between any two of them refuses the job as `stale-repository` rather than applying a plan to a tree it was not reviewed against. The approval import is a root operation that verifies the signed plan against the accepted `ia-plan` job and the project's protected reviewer policy before registering it (import a signed site plan). |
| `foundation-to-patch` | A `write` `plan-documentation` step that declares `invokes: create-documentation`: after the same read-only inspection it copies the selected revision into a private candidate and runs the installed CREATE pipeline in process under a grant narrowed to the task's intended paths, then applies the child's verified patch to the outer checkout. It retains the inspection result, the nested authoring run, its patch and impact evidence, and its own composition checkpoint. Foundation questions that are still open end the job at `needs-input` without invoking the child and without creating a patch. Intended paths outside the installed write ceiling are refused by name before the child is prepared. Model content fails open: an unavailable check isolation or an inconclusive review degrades the product disposition to `inconclusive` while the patch is still returned, because a patch is not a publish. |

`scripts/check-workflow-boundaries.mjs` pins each of these manifests' single step
field by field -- id, kind, operation, invokes, mode, skill, and the search plan
and search mode (absent for the four host-operation jobs, pinned to
`information-architecture-discovery`/`observe` for `ia-analysis`) -- because a
native step names its executor, and now its child pipeline, in the manifest
rather than leaving the choice to a model. `site-bootstrap`'s single write step
id is also what the installed grant's `writeStepIds` must equal, so widening the
manifest cannot silently widen a grant already issued.
`src/workflow-registry/manifest.ts` refuses an `operation` on any step that is
not a `host-operation` step, and refuses an `invokes` that is not exactly
`create-documentation` on the `foundation-to-patch` host-operation step, for the
same reason. A declared `invokes` also widens the outer workflow's declared tool
set to cover the child's, so the outer tool ceiling admits the calls the child
actually makes.

### Native task and artifact custody

A hosted native task selects a workflow, its domain task, and the exact
predecessor receipt and artifact hashes; it is inert data and never an approval
or a write grant. The request carries artifact metadata rather than inline
package bytes: the host stages hash-named input files under a read-only worker
mount, and `src/host-invoker/native-custody.ts` verifies the deployment,
project, epoch, acting principal, repository identity, receipt namespace, exact
size, and content digest before any domain adapter sees them. Custody sealed for
another project or produced for another principal is refused, not re-bound.
