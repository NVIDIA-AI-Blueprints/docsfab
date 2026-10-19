---
title: "Content IR Reference"
description: "Normative reference for DocsFab's deterministic structural content index."
template-source-version: "1.0.0"
---

# Structural Content IR

DocsFab's Content IR is a deterministic, read-only structural index for
Markdown-first repositories. It lets later workflows refer to documents,
heading-bounded sections, graph edges, and change regions without placing page
bodies or host paths in durable evidence.

## Repository binding and identity

`ContentIndexV1` remains for legacy consumers; asset-aware
`ContentIndexV2` is built only from an active host-prepared
`RepositoryWorkspace` for one immutable Git commit. Callers cannot assert a
path, revision, or tracked-file manifest. The index admits only tracked regular
files, rejects ignored/untracked/excluded/symlink/submodule/hardlinked inputs,
and rechecks bounded descriptor reads to fail closed on substitution.

Document identifiers derive from normalized explicit frontmatter IDs or
repository-relative paths. Section IDs combine document identity and normalized
heading anchors. Duplicate document identities, named by both pages, and
broken links fail explicitly; an unresolved navigation entry is recorded
instead, as [Navigation](#navigation) describes.

The checkout walk that builds `ContentIndexV1` reads each file by the bytes
its directory lists and names it by its NFC repository path, so a decomposed
(NFD) name indexes on a byte-exact file system such as Linux ext4. A file or
directory whose name an index path cannot hold, one with a backslash, a
control character, bytes that are not UTF-8, or a root name that begins like
a Windows drive, is left out and recorded as an `unindexable-name`
limitation; a directory is left out with every page under it. Of two names
that are the same once NFC, the index keeps the composed spelling and records
the other as `normalized-name-collision`. `contentIndexNameWarnings(index)`
turns both into `content-index-name-left-out` run warnings, which a step's
context preflight records. A warning whose path would pass the run record's
1,024-character bound names each path by its SHA-256 instead and keeps its
scope and remedy: a directory still covers every page under it, and a
collision still names the kept file. On a page the caller targets
(`targetPaths`, or the selected paths of a focused index), an anchor with no
letter or digit stops with `empty-page-anchor`, and an explicit anchor, MyST
label, or HTML id that repeats an anchor on its page stops with
`duplicate-page-anchor`; both messages name the page, the line, and the
edit. On any other page, including every page of a workspace (V2 or V3)
index, the index leaves that anchor out and records the same message as a
limitation with the page and line. The section before a left-out heading
runs on to the next kept heading, and the heading's lines stay in the body
digest, so pages without such an anchor index exactly as before. Impact
postflight reports an anchor problem that a run wrote into a page, and that
the baseline did not have, as a run-record warning instead of stopping.
Returned evidence contains only revision, digests, node, and edge counts—not
bodies, frontmatter values, external URLs, credentials, or host paths.

## Supported structure

The non-executing parser recognizes Markdown and MDX-compatible Markdown:
frontmatter shapes, headings and explicit anchors, section relations, Markdown
and simple HTML links, assets, directives, fenced-code boundaries, and safe
static navigation files. It never evaluates JavaScript or TypeScript sidebars
or a general YAML/MDX runtime: such a sidebar is recorded as unknown
navigation, and other unsupported forms fail rather than execute. A `---` or
`===` line underlines a setext heading only when the line above it is
paragraph text; after a closing code fence, a heading, a list item, a block
quote, an HTML block, or a blank line, it is a thematic break or block
content.

## Change regions and assets

Each document has independent body, headings, metadata, navigation, and graph
digests. Adding or removing documents invalidates all five. Stable explicit
identities preserve move history; changing an asset's bytes or edges changes the
referencing document graph. Asset links bind their repository-relative path and
SHA-256 to the revision without embedding bytes. The declared limits
`contentIndex.maxAssets` (4,096 unique assets), `contentIndex.maxAssetBytes`
(64 MiB each), and `contentIndex.maxTotalAssetBytes` (1 GiB in total) can be
raised with their host overrides. An asset past one of them is left out of the
index, with no asset edge and no manifest entry, and is recorded as a
limitation that names the asset, the page that links it, the limit, and the
observed value; the index keeps going. When a run's workflow search builds the
index, each left-out asset also becomes a `content-index-asset-left-out`
warning on the run record, which the run summary and `docsfab runs show` list
under LIMITATIONS. A warning whose paths would pass the run record's
1,024-character bound names the asset by the SHA-256 of its path instead, so
each left-out asset keeps its own warning. Other consumers of a workspace index
read the records with `contentIndexLimitations(index)` and do not print them
yet. An index that
leaves assets out has a different digest from one that keeps them, so two hosts
with different limits can compute different digests for one revision.
`contentIndex.maxSourceBytes` (4 MiB per page or navigation source) still stops
the index, naming the page, its size, and the limit.

## Navigation

Navigation is context, not content a task needs, so it never stops indexing.
From `mkdocs.yml` or `mkdocs.yaml`, the index reads only `nav` and `docs_dir`,
parsed as YAML 1.1 as MkDocs does, and resolves each entry against `docs_dir`
(default `docs`). The document is never converted as a whole: a walk reads just
those two settings and spends a budget equal to the file's byte length, one unit
for each node it visits and each alias it follows, and one for each character of
each nav entry it reads. A file without aliases cannot exceed that budget.
Aliases under any other key, such as `extra`, are never resolved. The budget
bounds the walk, not the parse, which formats no error messages and checks no
`!!omap`, so it stays close to linear in the file's size. A `<<` merge key is
read as MkDocs reads it for `nav` and `docs_dir`, and an explicit key wins over
a merged one. A plain `docs_dir` is read from its source text, so `docs_dir: .`
is the configuration's own directory. Plugin settings are never navigation, and
a configuration without `nav` has no explicit navigation. When `docs_dir` is not
set and the repository has no `docs` directory or tracked `docs` symlink beside
the configuration, entries resolve beside the configuration; which pages an
index selected never changes that choice. A Jupyter Book `_toc.yml` contributes
its `root:` and `file:` entries, and a Docusaurus `sidebars.json` its document
ids. An entry that names no indexed page or resolves outside the repository is
skipped, breaks the previous-next chain, and is recorded by name, once however
often it is listed; `contentIndexLimitations(index)` returns those records, and
`docsfab run` prints each one as a content index notice. A configuration is
recorded once, as unreadable, when it is not valid YAML, is too large or too
deeply nested to read, expands its aliases past the walk's budget, has a `nav`
that contains itself through an alias, or has a `docs_dir` outside the
repository or naming no directory in it; reading one never loops. An entry
naming a page outside the include set an index was narrowed to breaks the chain
without a record, because that page was never selected. A JavaScript or
TypeScript sidebar (`sidebars.js`, `.cjs`, `.mjs`, or `.ts`) is never run: it is
recorded as unknown navigation, and a focused index on a target beside it also
reports incomplete navigation coverage. A `sidebars.json` that is not valid JSON
is recorded as unreadable. Symlinks are never read through. An untargeted index
of a working checkout admits a symlink that stays inside the repository as an
alias that navigation resolves to its target, records one that leads outside the
repository or nowhere, and refuses only a symlink a selected root runs through.

## Governed bundles and verification

`governed-assets/lock.json` binds source repository, immutable revision, source
and local paths, declared license, exact files, hashes, and bundle digest.
Verification rejects traversal, mutable revisions, missing/extra files,
symlinks, byte changes, and provenance drift. Content IR v2 and governed-asset
tests exercise real binary assets, encoding and path adversaries, limits,
tracked-file attacks, and structural changes.
