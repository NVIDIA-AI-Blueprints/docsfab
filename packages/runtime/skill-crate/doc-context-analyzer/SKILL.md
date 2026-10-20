---
name: doc-context-analyzer
description: Inspect an immutable repository and its approved documentation foundation. Report a candidate canon, evidence provenance, conflicts, missing facts, and questions without accepting product decisions or changing the repository.
license: Apache-2.0 AND CC-BY-4.0
allowed-tools: Read Grep Glob
---

# Inspect Documentation Foundation

Inspect the selected repository revision against the exact approved model
supplied by the host. Produce a candidate foundation and explain what evidence
is still needed. This method does not approve a model, authorize a write, or
declare a release ready.

## Required inputs

- The immutable repository revision and its authenticated workspace.
- Applicable repository instructions and the documentation inventory.
- The host's current approved model binding, when available.
- Exact registered evidence or previously retained inputs with their original
  project, producer, and revision provenance.

## Method

1. Preserve the source revision and approved model digest in the result.
   A document that labels itself approved is insufficient; use the host's
   protected model binding.
2. Inspect repository instructions and documentation without changing them.
3. Preserve the distinction between canonical claims, unverified claims,
   unresolved conflicts, stale evidence, and missing inputs. Cite the approved
   snapshot as evidence of its stated model; do not claim to have independently
   verified every original source named by that snapshot.
4. Nominate affected repository artifacts only when their actual paths and
   digests are known. A general product claim need not invent a target file.
5. Use the native inspection result and its durable candidate canon. Preserve
   its limitations and typed questions. Unsupported input formats or absent
   evidence remain explicit missing inputs.
6. Return the inspection's readiness for these exact inputs. Keep readiness
   separate from model acceptance, permission to draft, and permission to
   merge or publish.

## Result

Report the selected revision, candidate canon identity, readiness, evidence
limitations, conflicts, missing facts, and questions needed to continue.
Keep the complete structured inspection and question records available for a
subsequent authorized task.

## Boundaries

- Stay read-only. The native executor performs inspection and persistence;
  model prose is not a substitute for a host receipt.
- Do not accept a candidate snapshot or treat a decoded approval flag as a
  new authority decision.
- Do not reuse another person's private predecessor input without an actual
  shared approval that covers it.
- Do not schedule another skill, create a patch, commit, merge, or publish.
