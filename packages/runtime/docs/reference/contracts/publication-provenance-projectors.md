# Publication provenance projectors

Epic #118 (evidence-aware commit and merge-request narratives) must consume the
existing lineage and inputs content-minimized projectors. This document is the
API surface for those implementers. It does **not** implement commit/MR
narrative rendering (#129).

## Why this package exists

Without an explicit seam, publication work tends to invent a third provenance
dialect beside `docsfab/lineage` and `docsfab/inputs`. Issue #152
freezes the provenance inputs #118 / #130 should use:

| Concern | Projector | Package |
| --- | --- | --- |
| Task origin, workflow choice, responsibility | `projectTaskLineage` | `docsfab/lineage` |
| External input identity and lifecycle | `projectExternalInputManifest` | `docsfab/inputs` |
| Per-input disclosure for commit/MR surfaces | `projectExternalInputDisclosure` | `docsfab/inputs` |
| Bundled publication provenance inputs | `projectPublicationProvenanceInputs` | `docsfab/publication` |

The publication package is a thin shim. It composes the lineage and inputs
projections and re-exports the domain projectors. It does not add private
fields, narrative prose, or a parallel sealed dialect.

## Import path

```ts
import {
  PUBLICATION_PROVENANCE_PROJECTOR_SURFACE,
  projectPublicationProvenanceInputs,
  projectTaskLineage,
  projectExternalInputManifest,
  projectPublicationInputDisclosure,
  assertPublicationProvenanceInputs,
  type PublicationProvenanceInputsV1,
  type TaskLineageProjectionV1,
  type ExternalInputManifestProjectionV1,
} from "docsfab/publication";
```

Equivalent direct imports remain valid and preferred when a caller only needs
one domain:

```ts
import { projectTaskLineage } from "docsfab/lineage";
import {
  projectExternalInputManifest,
  projectExternalInputDisclosure,
} from "docsfab/inputs";
```

`PUBLICATION_PROVENANCE_PROJECTOR_SURFACE` enumerates the package exports,
projector names, allowed disclosure surfaces (`commit-message`,
`mr-description`), and explicit non-goals (`#129` narrative rendering and a
third provenance dialect).

## `PublicationProvenanceInputsV1`

`projectPublicationProvenanceInputs({ origin, lineage, manifest })` returns:

- `lineage`: exact `TaskLineageProjectionV1` from `projectTaskLineage`
- `inputs`: exact `ExternalInputManifestProjectionV1` from
  `projectExternalInputManifest`
- `provenanceInputsSha256`: canonical digest over that sealed body

The bundle is content-minimized and credential-free. It retains digests, origin
class, selected workflow, decision actor/effect summaries, input source kinds,
permission class, visibility, disclosure policy, intended roles, and lifecycle.
It omits operator identifiers, approvals, recommendations, autonomous-cycle
internals, prompt/task bodies, safe titles, raw locators, private source
bodies, host paths, and credentials.

`assertPublicationProvenanceInputs` revalidates a sealed bundle for
idempotency and recovery bindings without decoding private artifacts.

## Disclosure for publication surfaces

Narrative rendering (#129) may need permission-aware labels or links. Use
`projectPublicationInputDisclosure` (or `projectExternalInputDisclosure`) with
surface `commit-message` or `mr-description`. Policy, surface, and visibility
ceilings remain those of the inputs package; citation cannot raise the ceiling.
Titles, locators, and excerpts are sanitized before emission.

Disclosure projections are intentionally not embedded in
`PublicationProvenanceInputsV1`. They require a live host capability and
optional locator/excerpt candidates supplied at render time.

## What #118 / #130 / #129 must not do

- Invent a third provenance record shape for task/input identity.
- Accept free-form provenance fields supplied independently of authenticated
  lineage/inputs evidence (#130).
- Embed private source material, credentials, or host paths in commit/MR
  metadata.
- Implement narrative rendering inside this package (#129 owns commit subjects
  and MR description sections).

Existing delivery metadata (`buildDocsFabPublicationMetadata`) remains the
current bounded outcome/path renderer until #129 extends it to consume these
projectors.

## Related contracts

- [Task origin and decision lineage](task-decision-lineage.md)
- [External input manifest](external-input-manifest.md)
- [Local-user GitLab publishing](../operations/local-user-gitlab-publishing.md)
- [SCM delivery records](scm-delivery-records.md)

## Evaluation

Focused tests live in `test/publication-provenance-projectors.test.ts`. They
prove the shim round-trips fixture lineage/inputs through the domain
projectors, stays content-minimized and credential-free, rejects unknown
bundle fields, clamps disclosure surfaces, and does not export narrative
renderers.
