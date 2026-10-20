# Governed catalog skills

DocsFab pins every public workflow step to immutable skill bytes. Canonical
authoring lives under `packages/skills/<id>/`; the installed runtime ships a
generated copy under `skill-crate/<id>/` and a colocated
`skill-crate/lock.json`.

There is one production skill contract. The former empty `skills/lock.json`,
optional-pack registry, install/enable objects, and `extend|replace` roles are
retired. A validated workflow step or the live agent selects an available locked skill
by its stable id.

| DocsFab workflow | Catalog skill ids in order |
| --- | --- |
| `review-documentation` | `audit-documentation`, `lint-documentation`, `verify-technical-accuracy`, `review-documentation`, `test-audience-understanding`, `evaluate-document-quality` |
| `create-documentation` | `plan-documentation`, `write-documentation`, `lint-documentation`, `verify-technical-accuracy`, `review-documentation`, `test-audience-understanding`, `evaluate-document-quality` |
| `update-documentation` | `plan-documentation`, `write-documentation`, `lint-documentation`, `verify-technical-accuracy`, `review-documentation`, `test-audience-understanding`, `evaluate-document-quality` |
| `restructure-documentation` | `audit-documentation` in documentation-set scope, `plan-documentation`, `write-documentation`, `lint-documentation`, `verify-technical-accuracy`, `review-documentation`, `test-audience-understanding`, `evaluate-document-quality` |

`review-documentation` is the standalone comprehensive review. It runs
the six skills once, has no writer or remediation step, and passes the five
preceding summaries to the terminal evaluator as bounded, untrusted evidence.
The peer-review skill keeps the same id as a step; the CLI name selects the
workflow.

Parked readiness, foundation, IA, bootstrap, foundation-to-patch, and roadmap
adapters are not operator-runnable jobs. They remain unavailable from
`docsfab list` until a public workflow change binds them. Unknown names are
the same class of error: run `docsfab list`.

## What the crate locks

`CatalogSkillCrateLockV1` records the exact eight-skill catalog in stable order.
Each entry includes:

- the canonical HTTPS repository, immutable revision, and
  `packages/skills/<id>/SKILL.md` source path;
- version, license, inputs, outputs, and the exact granted and withheld tools;
- the `SKILL.md` SHA-256, deterministic bundle SHA-256, and a closed file list
  with a digest for every file; and
- the crate-relative `skillRoot` used by the installed package.

The bundle hash is the SHA-256 of lexicographically sorted, LF-terminated
lines `<file-sha256>  <skill-relative-path>`. Changed, missing, extra,
traversing, hard-linked, or symlinked files fail before model execution. A
requested tool set that differs from the lock also fails closed.

Runtime does not scan the sibling authoring catalog and does not discover
ambient Pi skills. It loads only the verified crate directory for the current
workflow step or live-agent request. The run record associates the workflow id and step id with the
verified skill evidence and its exact content and bundle digests.

## Tool boundary

Read-only and evaluation steps receive `read`, `grep`, `find`, and `ls`.
`write-documentation` receives those tools plus `edit` and `write` when the host
authorizes the requested edit or workflow writes. General shell, SCM,
credential, and arbitrary network tools are not granted by the crate.

## Updating the pin

1. Edit the canonical source under `packages/skills/<id>/`.
2. From `packages/runtime`, run `npm run generate:skill-crate`.
3. Run `npm run generate:quality-pack` to update the manifest that binds the
   skill lock to Pin C.
4. Review both the canonical change and generated crate bytes. Do not hand-edit
   files under `skill-crate/`.
5. Run `npm run check`, `npm run verify:package`, and
   `npm run acceptance:clean-install`.

Generation is intentionally all-or-nothing. It rejects a missing or unexpected
canonical skill and replaces the complete lock and staging payload.

Generic non-skill governed bundles remain under `governed-assets/` with their
own asset lock. Quality policy and portable evaluation assets are authored in
`packages/quality/`; generated Pin C bytes and the B+C manifest live under
runtime `quality/` and `quality-pack/`. See the internal quality-pack crate
decision record.
