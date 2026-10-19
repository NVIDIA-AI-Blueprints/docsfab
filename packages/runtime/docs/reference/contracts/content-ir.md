# Content IR V3 Contract

`ContentIndexV3` has the exact V2 index shape and evidence fields. Its digest
includes `schemaVersion: 3`. V3 adds `rst` to the document format enum. V1 and
V2 retain their original document-format enums, closed decoders, and digest
meaning.

V3 builds from a host-prepared `RepositoryWorkspace` for one immutable tracked
revision. It recognizes a finite, non-executing RST/MyST subset: sections,
explicit labels, local `ref` and `doc` roles, directive shapes, and code-block
boundaries. Labels and local roles become the existing document and section
nodes with existing outbound-link and backlink edges. RST directives retain
their declared shape only. This contract does not evaluate directives, execute
Sphinx configuration, resolve includes, or validate Sphinx routes.

The directive subset is `toctree`, `include`, `literalinclude`, `code`, and
`code-block`. RST roles use `:ref:` and `:doc:`; MyST roles use `{ref}` and
`{doc}`. MyST directives use a matching backtick, tilde, or colon fence with a
braced directive name. Code directive bodies are literal; other supported
directive bodies retain their eligible prose roles. Ordinary Markdown fences,
front matter, inline code, and HTML comments are not role-bearing prose.

Malformed labels or directives, unknown interpreted-text roles, unsupported
directives, unresolved local labels, and unresolved local document targets fail
the index. No new node or edge kinds represent RST directives.

`diffContentIndexesVersioned` first decodes each input under its own known
version. It emits `StructuralDiffV3` whenever either input is V3. V1-only and
V2-containing comparisons retain V1 and V2 diff versions respectively.
