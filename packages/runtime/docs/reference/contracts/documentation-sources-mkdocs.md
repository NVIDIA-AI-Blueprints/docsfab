# Bounded MkDocs and Material Documentation Sources

DocsFab recognizes a finite, literal subset of MkDocs and Material for MkDocs
configuration and Markdown syntax (issue #831, extending the source-aware
validation seam from #829 and the frozen contract in #795). The adapter never
executes `mkdocs.yml`, a plugin, or a Python tag; every recognized form is a
static YAML or Markdown structure read directly from verified repository
bytes.

## Configuration

`mkdocs.yml` or `mkdocs.yaml` (exactly one) governs a source root. Recognized
top-level keys:

- `docs_dir`: a literal, repository-relative path. Defaults to `docs` when
  absent. Any safe relative path is accepted, including nested and
  non-default roots such as `docs/site`. A `.` segment (for example
  `./docs` or `docs/.`) is rejected rather than silently normalized, so a
  spelling that the delivery layer's containment check would otherwise
  mismatch can never admit an unreachable page or a broken link.
- `use_directory_urls`: a literal boolean. Defaults to `true`.
- `nav`: a literal YAML list of pages and nested sections. Its absence
  selects automatic navigation instead of an error.

Unrecognized or non-literal values (Python tags such as
`!!python/name:...`, YAML aliases, non-scalar `docs_dir`, a non-boolean
`use_directory_urls`, or a top-level `INHERIT` key) are rejected with a
stable, descriptive error rather than silently ignored. `INHERIT` is
rejected unconditionally, including when a local `nav` is present, because
the effective configuration cannot be determined without merging the
referenced parent file, which this adapter never reads.

## Navigation modes

- **Explicit**: `nav` is present. Each entry is a bare page path, or a
  single-key mapping from a literal title to either a page path or a nested
  list of further entries (bounded to 16 levels deep). Every leaf must
  resolve to an existing Markdown file under `docs_dir`; a missing target
  fails validation. A changed or newly added page under `docs_dir` that is
  not reachable from the current `nav` reports a limitation requesting an
  explicit navigation update in the same change, rather than a hard failure,
  matching the "document-only change needs input" case.
- **Automatic**: `nav` is absent. Every Markdown file under `docs_dir` is
  eligible; no reachability check applies. A non-empty `plugins` list
  combined with automatic navigation is unsupported, because a plugin such
  as an awesome-pages-style page orderer can silently reorder or filter
  pages outside this adapter's literal understanding.

## Index/README routing and directory URLs

A page named `index.md` or `README.md` represents its containing
directory's own route rather than a nested page. The exact literal route for
a `docs_dir`-relative page is:

| `use_directory_urls` | `index.md` at `docs_dir` root | `guide/index.md` | `guide/setup.md` |
| --- | --- | --- | --- |
| `true` (default) | `/` | `/guide/` | `/guide/setup/` |
| `false` | `/index.html` | `/guide.html` | `/guide/setup.html` |

## Material syntax

The adapter recognizes the enumerated Material subset: tables, fenced code,
`!!!` admonitions, `???`/`???+` collapsible details, and `===` content tabs
with a literal quoted label. Recognized markers must align to 4-space
indentation steps and nest no more than 4 levels deep; a bare `===` without
a quoted label is left to the existing CommonMark setext-heading handling
rather than misread as a tab. Recognition establishes structure only for
this literal subset; it is not a claim of full Python-Markdown or
pymdownx fidelity.

## Unsupported semantics

Python tags, YAML aliases, `INHERIT`-based configuration composition,
arbitrary `markdown_extensions`, plugin execution, and any other behavior
that requires running MkDocs or a plugin are out of scope for this
release. A parser failure is never reported as positive no-navigation; it
is always a named limitation or failure.

## Known debt

`documentation-source-applicability.ts` (owned by #829, outside this
Task's path scope) collects each root's configuration candidates in a fixed
list order and asserts that order is already sorted. For any adapter with a
`.yml`/`.yaml` pair (Fern and MkDocs), the fixed order is not lexically
sorted, so a root with both extensions present throws during applicability
derivation instead of reaching this adapter's own ambiguous-configuration
guard. This adapter's delivery-layer guard (`validateMkdocsStructuralDocumentation`
in `structural-documentation-mkdocs.ts`) still rejects more than one
governing configuration file when it is reached directly; the upstream
sort-order defect should be fixed in a follow-up C1-owned change.

Two further pre-existing conditions, discovered but not fixed here because
they are outside this Task's path scope: the dual-extension
`DocumentationSourceApplicabilityError("invalid-value")` above escapes raw
(uncaught) from `delivery/preflight.ts` and `delivery/worktree/validate.ts`
rather than surfacing as a structured limitation. Separately,
`documentation-source-applicability.ts`'s `adapterOwnsMarkupPath` hardcodes a
`docs/` prefix check when deciding `mixed-root-ownership`, so any changed
Markdown file outside `docs/` at a root that also owns an MkDocs config
— including a root `README.md` — is flagged `mixed-root-ownership` even
when ownership is not actually ambiguous.
