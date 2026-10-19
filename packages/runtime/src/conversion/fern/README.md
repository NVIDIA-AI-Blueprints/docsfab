# Fern page emitter

`emitFernPage` turns one conversion IR document into Fern page text. Each node
takes its disposition from the construct rule index; a `convert` node is
written by the emitter for its intent in `FERN_INTENT_EMITTERS`, one per
`ConvertTarget`.

| File | What it owns |
| --- | --- |
| [`page.ts`](page.ts) | Dispositions, answered units, includes, frontmatter, refusals, and the final MDX check |
| [`emitters.ts`](emitters.ts) | The intent table and the per-intent emitters |
| [`markdown.ts`](markdown.ts), [`tables.ts`](tables.ts) | Markdown blocks and inlines; pipe and HTML tables, `list-table`, and `csv-table` |
| [`escape.ts`](escape.ts) | The only text escaping, plus fences, code spans, attributes, and YAML scalars |
| [`html.ts`](html.ts) | Raw HTML: kept when it is inert JSX, otherwise wrapped |
| [`mdx-check.ts`](mdx-check.ts) | An independent check of finished page text, with `@babel/parser` for JSX |
| [`types.ts`](types.ts) | Inputs, results, refusal codes, and the built-in component list |

Rules the emitter keeps:

- Only Fern's built-in components (decision C2): `Note`, `Tip`, `Warning`,
  `Info`, `Accordion`, `Tabs`, `Tab`, `CardGroup`, `Card`, and `Frame`. The
  MDX check refuses any other capitalized tag.
- Text is escaped once, in `escape.ts`. Code fences, code spans, math, and
  JavaScript string expressions carry their content unchanged.
- Output is deterministic: fixed attribute order, LF line endings, one blank
  line between blocks (one newline between adjacent components), and one
  trailing newline.
- Nothing is dropped silently. A node the emitter cannot write is a refusal
  with a code and next action; source detail Fern cannot carry is a notice.
- The emitter reads no files. Literal includes, `csv-table` `:file:`, and
  markup includes come from `FernEmitSources`; link and image targets are
  written as the IR gives them.
- Page title, slug, and canonical URL come from the page plan. Source document
  frontmatter is not consumed; each source key produces a notice so callers can
  account for metadata that needs a separate migration. Supported source
  `description` and `keywords` constructs are emitted through the rule plan.
