# MyST reader

`readMystSource` reads MyST Markdown pages under one documentation root into
the conversion IR (`../contracts.ts`). It never executes configuration code,
never fetches a URL, and never reads outside the documentation root.

| File | What it owns |
| --- | --- |
| [`reader.ts`](reader.ts) | Pages, frontmatter, includes, assets, labels, substitutions, node ids, and bounds |
| [`blocks.ts`](blocks.ts) | The block parser and directive normalization into typed nodes |
| [`inline.ts`](inline.ts) | The inline parser: code spans, roles, substitutions, links, images, emphasis, raw HTML |
| [`directives.ts`](directives.ts) | Directive option blocks and typed option values |
| [`configuration.ts`](configuration.ts) | `myst_substitutions` read statically from `conf.py` |
| [`source-tree.ts`](source-tree.ts) | Contained read access to the documentation root, on disk or in memory |

## Behavior

- Every node carries a one-based source line span in the file it came from.
  Node ids are `<source path>#<n>` in pre-order, so the same bytes give the
  same IR.
- Block parsing follows CommonMark: ATX and setext headings, paragraphs,
  lists, block quotes with lazy continuation, fenced and indented code, HTML
  blocks, thematic breaks, GFM pipe tables, footnotes, and link reference
  definitions. MyST adds `%` comments, `(label)=` targets, and directives.
- A directive opens with a backtick, tilde, or colon fence and closes at a
  fence of the same character at least as long, so nesting uses longer outer
  fences. Options come from leading `:name: value` lines or a `---` YAML
  block. Bodies are parsed again as blocks, except for the literal-bodied
  directives in `TEXT_BODY_DIRECTIVES`.
- The directives in `NORMALIZED_DIRECTIVE_NODE_KINDS` become typed nodes, and
  `raw` with an `html` format becomes an `html` node. A `toctree` stays a
  directive whose body lists its entries; navigation assembly resolves them.
- Markup includes are read and parsed as their own documents; literal
  includes are checked to exist. Both are recorded in the asset table. Remote
  includes are recorded and become ambiguity units in the resolver.
- Navigation and routes stay empty; navigation assembly and route planning
  fill them.

## Refusals and bounds

Unreadable input stops the read with a `ConversionContractError` whose code
names the cause: a missing page or include, an include outside the
documentation root (including through a symbolic link), an include cycle, an
asset outside the repository, non-UTF-8 bytes, frontmatter or directive
options that cannot be read, a substitution with two values, or a
`myst_substitutions` table that is not a static literal. Markdown inline and
reference image titles are refused because the current conversion IR has no
title field for inline images; move the meaning into visible alt text or a
caption before converting.

Page and markup-include size is bounded by `contentIndex.maxSourceBytes`;
nested containers along one path (directive bodies, block quotes, list items,
footnotes, emphasis, and links) by `conversion.maxNestingDepth`. Both refuse
with the limit's own code and name the page and line.
