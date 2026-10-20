---
title: RST Authoring Capability
description: Supported reStructuredText update shapes and deterministic capability refusals.
---

DocsFab supports a bounded reStructuredText (RST) update when the task names
one existing page owned by one tracked Sphinx configuration. The update must
use the `update-documentation` workflow and `--patch-only` delivery. The
writer edits one host-selected prose region and retains a reviewable patch.

RST creation, restructuring, and multi-page updates are unsupported. A
tracked `.rst` file elsewhere in the repository does not make an untargeted
request unsupported. Missing targets continue through the normal discovery
workflow.

## Deterministic Task Admission

When a caller supplies a canonical task with an explicit target set, runtime
admission checks RST operation, target count, delivery, and Sphinx ownership
before request interpretation or workflow execution. The admission digest binds
the normalized task, repository identity and revision, effective documentation
roots, and tracked Sphinx configuration bytes.

Known unsupported shapes return one stable operator code:

| Code | Cause | Next action |
| --- | --- | --- |
| `rst-capability-unsupported-operation` | The task requests an RST operation other than update. | Use an update of one existing Sphinx page or select a supported Markdown or MDX target. |
| `rst-capability-unsupported-cardinality` | The task includes more than one target and at least one RST page. | Split the RST changes into separate update tasks or use supported Markdown or MDX targets. |
| `rst-capability-unsupported-delivery` | The RST update does not select patch-only delivery. | Add `--patch-only` to the existing update command or select a supported Markdown or MDX target. |
| `rst-capability-unsupported-adapter` | The page is not owned by one unambiguous tracked Sphinx configuration. | Use one existing RST page under a tracked Sphinx configuration or select a supported Markdown or MDX target. |
| `rst-capability-admission-required` | A host path cannot prove delivery and RST adapter admission against the canonical task. | Run the task through DocsFab CLI preflight with one existing Sphinx page and `--patch-only`, or select a supported Markdown or MDX target. |

The ordinary CLI instruction is not a canonical target list. `--source` binds
read evidence, and `--context-path` selects reader context; neither grants or
binds a write target. Catalog routing and semantic target discovery can call a
provider before runtime knows whether an instruction requests an RST update.
These paths preserve normal discovery and do not claim zero provider calls.

## Existing Write Guard

After admission, plan and write checks still enforce the exact admitted RST
path, repository roots, source evidence, page-region preservation, and static
structure checks. Admission does not authorize publication or expand the
workflow's existing write authority.
