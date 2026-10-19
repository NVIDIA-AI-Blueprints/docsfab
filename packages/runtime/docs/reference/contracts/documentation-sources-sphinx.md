# Sphinx Documentation Source Contract

The fixed adapter registry (`documentation-source-support.ts`) declares the
`sphinx` `validate` capability as `supported`. `deriveDocumentationSourceApplicability` recognizes `conf.py`
or `docs/conf.py` as the Sphinx configuration location and treats `.rst` and
`.md` as documentation markup for relevance and required-closure purposes.

## Configuration

The Sphinx source module parses a finite set of static `conf.py` literals
without executing Python: `project`, `root_doc`/`master_doc`, `source_suffix`,
and `extensions`. Only a single top-level, unconditional assignment per key
is accepted; a quoted string or a literal list/tuple of quoted strings is
accepted for `source_suffix` and `extensions`. A reassigned, conditionally
assigned, concatenated, formatted, or otherwise computed value fails as a
`documentation-source-applicability` limitation, naming the offending key.
Exactly one of `conf.py` or `docs/conf.py` may exist per source root; both
present at once is an ambiguous-location limitation. `root_doc` and
`master_doc` may both be set only when their literal values agree.
`source_suffix` defaults to `[".rst", ".md"]`; `extensions` defaults to `[]`.

## Routing and local structure

The Sphinx source root is the directory containing its `conf.py`. The root
document is `root_doc` under that directory, resolved against each
`source_suffix` in order; a missing root document fails closed. Validation
walks the `toctree`/`include`/`literalinclude` graph from the root document:
each toctree entry (optionally `Title <path>`) resolves relative to the
referencing document unless prefixed with `/`, in which case it resolves
relative to the Sphinx source root. `include` and `literalinclude` targets
resolve the same way but are leaf references, not further graph edges. A
toctree entry containing `*` is unsupported. `:doc:`/`:ref:` (RST) and
`{doc}`/`{ref}` (MyST) roles resolve the same way: `doc` against the
document graph, `ref` against explicit labels (`.. _label:` / `(label)=`)
collected from every visited document. A label bound to more than one
document fails as a duplicate reference label.

A toctree cycle, a target that resolves outside the documentation source
root, or a missing target fails validation. A document outside the toctree
graph from the root and outside the changed-path set is never read and
cannot fail validation on its own account.

## Enumerated directives and non-goals

Only `toctree`, `include`, `literalinclude`, `code`, and `code-block`
directives are recognized, matching the Content IR RST/MyST subset (see
`content-ir.md`); any other directive or domain-qualified directive name
(for example `py:function` or `note`) fails as an unsupported-directive
limitation. This module never executes `conf.py`, never resolves
`sphinx.ext.autodoc`/`apidoc`/`autosummary`/`intersphinx` output, and never
evaluates a custom domain or a remote inventory. When `extensions` names one
of those generated-content extensions, a toctree target that is otherwise
missing is reported as a generated-content limitation instead of a failure,
since the module cannot know whether that page would exist after a real
build. Native HTML build output and a verified installed-Sphinx build
recipe are separately tracked (#839); this contract makes no unqualified
builder claim.

## Known bound

Sphinx source-root ownership reuses the existing
`documentation-source-applicability.ts` `docs/`-prefix heuristic for mixed-
root-ownership detection. A Sphinx project whose `conf.py` sits at the
source-root level with sibling `.rst`/`.md` files (rather than nested under
a `docs/` directory) can trip that pre-existing, adapter-agnostic heuristic
even though this module resolves such a layout correctly on its own. Tracked
as follow-up debt outside this contract; the nested `docs/conf.py` layout is
the currently verified shape.
