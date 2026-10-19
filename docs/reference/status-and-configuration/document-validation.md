---
title: "Documentation Validation Reference in DocsFab"
description: "Look up the structural validation contract for documentation candidates and Content IR source support."
status: draft
content.type: reference
---

Look up the structural validation contract for documentation candidates and Content IR source support.

## Sealed Structural Validation

When a delivery changes documentation paths, the built-in validation profile
checks supported relative links in Markdown and MDX files, site-root links
resolved through the sealed Fern route map, static quoted `Card` `href`
targets, scalar Fern navigation targets in `fern/docs.yml` and versioned Fern
YAML, and reachability of changed documentation pages from navigation. Route
resolution honors supported tab, section, page, and folder slugs. Every page
expanded from folder navigation must remain a regular candidate-tree path. The
top-level Fern version index is followed to discover nested navigation files.
When a repository keeps canonical pages outside the published tree,
`fern/SOURCE_MAP.md` can explicitly bind a canonical path area to its changed,
navigation-reachable Fern projection area. Ownership paths require balanced
code delimiters. The validator does not infer a file mirror from directory
names. Git deletion status keeps removed pages out of candidate-file reads
during a restructure.

Unsupported or malformed navigation syntax produces a typed limitation instead
of a passing result. This includes YAML tags and aliases, route-affecting slug
shapes outside the supported scalar form, and `Card` opening tags without
exactly one static quoted `href` value or with expression-valued attributes.
Quoted greater-than characters and Unicode text in other static attributes
remain supported. The ready attestation and immutable delivery receipt bind the
profile version, ordered check IDs and results, candidate-tree
digest, check-set digest, and result digest.

## Content IR V3 Source Support

Content IR V3 adds structural indexing for tracked reStructuredText (`.rst`)
files and supported MyST syntax in Markdown. It recognizes sections, explicit
labels, local `ref` and `doc` roles, selected directives, and code-block
boundaries. Unsupported or malformed RST or MyST syntax fails with
`unsupported-document-syntax` instead of being ignored.

## RST Authoring Capability

Authoring supports one existing `.rst` page owned by one unambiguous tracked
Sphinx configuration. Use the `update-documentation` workflow with
`--patch-only`. RST creation, restructuring, and multi-page updates are
unsupported. A repository that contains RST pages does not constrain an
untargeted request, and missing targets continue through normal discovery.

The runtime reports these stable capability errors for known RST task targets:

| Code | Cause | Next action |
| --- | --- | --- |
| `rst-capability-unsupported-operation` | The task requests an RST operation other than update. | Use `update-documentation` with `--patch-only` for one existing Sphinx page, or select Markdown or MDX. |
| `rst-capability-unsupported-cardinality` | The task includes more than one target and at least one is RST. | Split the RST changes into separate update tasks, or select Markdown or MDX. |
| `rst-capability-unsupported-delivery` | A known RST update does not use patch-only delivery. | Add `--patch-only` to the update command, or select Markdown or MDX. |
| `rst-capability-unsupported-adapter` | The page lacks one unambiguous tracked Sphinx configuration. | Use one existing page under a tracked Sphinx configuration, or select Markdown or MDX. |
| `rst-capability-admission-required` | A host path cannot prove delivery and adapter admission for the canonical task. | Run the task through DocsFab CLI preflight with one existing Sphinx page and `--patch-only`, or select Markdown or MDX. |

The CLI has no write-target flag. `--source` binds read evidence, while
`--context-path` selects reader context; neither binds a write target.
Consequently, `docsfab run` instructions and `docsfab do` catalog routing can
use provider-backed request interpretation before the runtime can determine
that an instruction targets RST. Canonical structured task targets receive
deterministic admission before provider use, with stable refusal codes. The
internal admission record carries digests for the normalized task, repository,
configuration, and adapter; authorization still comes from canonical task
validation, tracked workspace state, and existing write-scope checks.

This support is structural and non-executing. DocsFab does not execute Sphinx
configuration or directives, resolve includes, or validate rendered Sphinx
routes through Content IR. Historical Content IR V1 and V2 retain their
original Markdown-family formats, source selection, and digest semantics. Use
V3 when the indexed source set includes RST or the supported MyST additions.
