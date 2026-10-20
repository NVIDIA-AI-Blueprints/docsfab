# DOCX block evidence

`SourceExtractorAdapterV1` for WordprocessingML (`.docx`) files, implementing
#838 against the shared seam in
[source evidence](source-evidence.md) (#835, !640).
This document covers only what is specific to the DOCX adapter
(`src/inputs/adapters/docx.ts`); record shapes, digest layering, and the
service/reader lifecycle are covered by the shared contract and are not
repeated here.

## Dependency decision

This adapter pins one runtime dependency: **`fast-xml-parser@5.11.1`**
(exact version, `npm install --save-exact`), used only for its `XMLParser`
export. The ZIP layer remains hand-rolled: a minimal central-directory reader
using Node's built-in `node:zlib` (`inflateRawSync`, in-memory `DEFLATE`
only).

Revision history: an earlier version of this adapter hand-rolled the XML
tokenizer too. A non-author review found three defects traceable to that
choice (quote-unaware attribute scanning that let an injected attribute value
corrupt adjacent text; a literal `w:`-prefix match instead of namespace-URI
resolution; no defense against a crafted document nesting depth before
allocation) and asked for a maintained, synchronous XML parser instead. The
ZIP reader was reviewed separately and found sound; it is unchanged in kind,
only hardened (see "Fixes from the non-author review" below).

Why `fast-xml-parser`, and why version `4.5.7`'s "legacy" line was considered
and rejected in favor of `5.11.1`:

- #795 names no specific DOCX XML package, explicitly warns against a new
  dependency on Saxes ("its upstream is archived"), and requires "a
  maintained parser/archive/XML dependency release." `fast-xml-parser` is
  synchronous (no `Promise`-based API to reconcile with this adapter's
  synchronous `extract()` contract, unlike PDF.js), non-validating (no DTD
  subsystem exists to disable — there is nothing to turn off), and under
  active maintenance.
- `4.5.7` ("legacy," still receiving patches) has one dependency (`strnum`)
  against `5.x`'s four-to-six, but carries a moderate advisory
  (GHSA-gh4j-gqv2-49f6, "XMLBuilder: XML Comment and CDATA Injection via
  Unescaped Delimiters") unpatched below `5.7.0`. This adapter never imports
  `XMLBuilder` or calls the deprecated `addEntity` (tested: `DOCX adapter
  inertness > never imports the XMLBuilder half of the pinned dependency`),
  so the vulnerable code path is provably unreachable either way — but
  starting a brand-new dependency pin with a known, avoidable advisory when a
  clean version exists is not a defensible default. `5.11.1` (latest at pin
  time) carries no known advisory for either half of the package. `npm audit`
  reports one unrelated moderate finding (`yaml`, pre-existing in this
  package before this Task, GHSA-48c2-rrv3-qjmp) that this Task did not
  introduce and does not touch.
- `XMLParser`'s `preserveOrder: true` mode returns an exact document-order
  array of `{ [tagName]: children, ":@"?: attrs }` nodes (verified directly
  against the installed version; see the namespace-resolution section
  below), which is what a block adapter needs: WordprocessingML mixes
  differently-named siblings (`w:p`, `w:tbl`, `w:sectPr`, ...) under `w:body`,
  and only an order-preserving parse can assign correct positional ordinals
  across them.

`packages/runtime/package.json`, `package-lock.json`, and
`npm-shrinkwrap.json` are all updated together: this package ships both a
lockfile and a shrinkwrap, and `scripts/verify-packed-cli.mjs` requires them
to match exactly.

## Scope deviation: `source-extraction.ts` untouched

The issue's Path also lists `packages/runtime/src/inputs/source-extraction.ts`.
This Task does not modify it. That file is #835's reviewed, stable adapter
contract (`SourceExtractorAdapterV1`, `createSourceExtractorRegistry`,
`extractSourceRepresentation`); #838's worker instructions are explicit that
#835's files stay untouched here, and that any defect found in them belongs in
this MR's notes, not as a direct edit. No defect was found: the existing
`SourceExtractionRequestV1`/`SourceExtractionResultV1` contract is sufficient
for a DOCX adapter exactly as written for HTML, so no change was needed.

`src/inputs/index.ts` now re-exports `docxSourceExtractorAdapter`, and
`createDefaultSourceExtractorRegistry` (landed with #835 / !663) registers
it next to HTML and PDF. `source-acquisition.ts` is the production caller.
This Task still does not edit those shared files. The remaining #838
acceptance named on !652 is the DOCX-instantiated citation-chain proof in
`test/source-evidence-docx.test.ts`.

## Main document part resolution

The main document part is **never assumed to be `word/document.xml`**. It is
resolved the way a real OOXML consumer resolves it:

1. Read `_rels/.rels` (the package root's relationships part). Refuse if
   absent, unreadable, or unparseable.
2. Find the `Relationship` whose `Type` is exactly
   `http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument`.
   Refuse if none exists, or if more than one does (ambiguous).
3. Refuse if that relationship has `TargetMode="External"`: its `Target` is a
   URI outside the package, not an internal part path. This adapter never
   fetches anything regardless (it only ever reads bytes already inside the
   archive, so treating an external target as internal would be low severity
   at worst), but an external target is never a valid main document part.
4. Normalize its `Target` to a package-relative part path (reject an absolute
   or traversal target). Refuse if the resolved part is absent from the
   archive.
5. Read `[Content_Types].xml`. Refuse if absent, unreadable, or unparseable.
   Resolve the effective content type for the target part: an exact
   `Override` match on `PartName`, else a `Default` match on the part's
   extension. Refuse unless it is exactly
   `application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml`.

Only after all five checks pass is the resolved part's bytes actually read
and parsed. A package whose relationships point at
`word/document2.xml` while a benign, differently-worded decoy sits at
`word/document.xml` is extracted from `word/document2.xml`; the decoy is
never opened. A package whose `[Content_Types].xml` does not declare the
relationship target as the WordprocessingML main document is refused rather
than trusting the relationship alone.

## Blocks and locators

`docx-block` (frozen by #795, decoded in `source-evidence.ts`, not modified
here): `{ kind: "docx-block", part, blockPath, paragraphOrdinal, tableCell }`.

- **`part`** is the resolved main document part from the previous section
  (normally, but not assumed to be, `"word/document.xml"`). Headers, footers,
  footnotes, endnotes, and comments live in separate package parts
  ("stories") this adapter does not read. If any such part is present in the
  archive (`word/header*.xml`, `word/footer*.xml`, `word/footnotes.xml`,
  `word/endnotes.xml`, `word/comments.xml`), the representation carries
  `unsupported-structure` even when the main body extracts cleanly, so their
  omission is a stated limitation rather than a silent gap.
- **Body-level paragraph.** A `w:p` that is a direct child of `w:body` yields
  one segment. `blockPath` is `[bodyBlockOrdinal]`: the zero-based ordinal
  among the body's `w:p`/`w:tbl` children only (other body children, such as
  `w:sectPr`, are section properties, not block content, and do not advance
  it). `paragraphOrdinal` is the zero-based ordinal among body-level paragraph
  blocks only; tables, and paragraphs nested inside a table cell, do not
  advance it. `tableCell` is `null`.
- **Table cell.** A `w:tc` yields one segment: the cell's own paragraphs' text
  joined with `"\n"`. `blockPath` is `[tableBodyOrdinal, rowOrdinal,
  cellOrdinal]`. `tableCell` is `{row, column}`, the same row/cell ordinals.
  `paragraphOrdinal` is `null` — the block is the cell, not one paragraph
  inside it. A `w:tbl` nested inside a cell is not extracted (its text does
  not appear anywhere); the enclosing representation is flagged
  `unsupported-structure`.

  The table walk (`w:tbl` → `w:tr` → `w:tc` → `w:p`) is allowlist-based at
  every level, the same posture as the paragraph walk above: `w:tbl`'s
  direct children other than `w:tr` (besides the metadata pair `w:tblPr`/
  `w:tblGrid`, silently skipped), `w:tr`'s direct children other than `w:tc`
  (besides `w:trPr`), and `w:tc`'s direct children other than `w:p` (besides
  `w:tcPr`, and `w:tbl` -- already covered by the nested-table flag above)
  are all flagged `unsupported-structure` and never recursed into. A
  schema-valid ECMA-376 content control (`w:sdt`/`w:sdtContent`) wrapping a
  row or a cell, or an unrecognized wrapper (`w:customXml`) wrapping a cell
  paragraph, would otherwise be silently invisible to a lookup scoped to
  literal `tr`/`tc`/`p` children, losing that content while reporting
  `completeness: "complete"` and `limitations: []`.

Elements are matched by **resolved namespace URI plus local name**, not by a
literal `w:` prefix string. `fast-xml-parser` returns tag names with their
literal prefix intact (e.g. `x:p`); it does not resolve prefixes to namespace
URIs itself. This adapter walks the parsed tree once, tracking each element's
in-scope `xmlns`/`xmlns:*` bindings (inherited from ancestors, extended by
declarations on the element itself), and resolves every tag and non-namespace
attribute to `{uri, local}` before any WordprocessingML-specific matching
happens. An alternate prefix bound to the WordprocessingML namespace (e.g.
`<x:p xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`)
is recognized identically to `<w:p>`, with identical locator ordinals, and
does not shift the ordinals of surrounding `w:`-prefixed siblings.

A **heading** is an ordinary paragraph carrying `w:pPr/w:pStyle`; a **list
item** is an ordinary paragraph carrying `w:pPr/w:numPr`. WordprocessingML
never stores the rendered bullet/number glyph as literal text, so neither
needs a special locator or special-case traversal: the paragraph walk above
already captures their literal run text.

Inside a paragraph, recursion into a child element is **allowlist-based, not
a denylist**: only `w:r` (with its own `w:vanish` check), `w:ins`/`w:moveTo`
(revision-tracking, see below), and the fixed set `w:hyperlink`,
`w:smartTag`, `w:fldSimple`, `w:sdt`, `w:sdtContent` are ever walked into
looking for more text. A **hyperlink** (`w:hyperlink`) and an **inline
content control** (`w:sdt` wrapping `w:sdtContent`, `w:sdtPr` skipped as
formatting metadata like `w:pPr`/`w:rPr`) are the two containers this covers
in practice; their visible run text folds into the enclosing paragraph's
text exactly like any other run. The relationship part naming a hyperlink's
target (`word/_rels/document.xml.rels`) is never opened — this adapter only
ever reads the resolved main document part — so an external target is
definitionally never fetched, not merely policy-excluded.

Everything else encountered inside a paragraph — a block-level element
(`w:p`, `w:tbl`, `w:tr`, `w:tc`, `w:altChunk`, ...) nested there by locally
malformed but still well-formed XML, an unrecognized container such as
`w:customXml`, or any other surprise — is flagged `unsupported-structure`
and **never recursed into**. This is the fix for the review's second
blocking finding: a well-formed-but-schema-invalid
`<w:p>A<w:p>B</w:p><w:p>C</w:p></w:p>` is not caught by well-formedness
validation (it is valid XML, just invalid WordprocessingML structure), and an
earlier, denylist-shaped version of this recursion walked into the nested
`<w:p>` elements anyway, fabricating one span merging all three paragraphs'
text at the outer paragraph's locator with `completeness: "complete"` and no
limitation. The allowlist closes the defect class, not only the one
instance: any nested block-level or unrecognized element is refused the same
way, not just a literal `w:p`.

A **body-level content control** (`w:sdt` as a direct `w:body` child, whose
`w:sdtContent` wraps one or more whole paragraphs rather than inline runs) is
different from the inline case above: `walkBody` does not recognize `w:sdt`
as a block, so it is flagged `unsupported-structure` and its `w:sdtContent`
is never opened at all — any paragraphs inside it are not extracted,
**known debt**, not a fabrication risk (the content is lost, honestly
disclosed, never merged into a neighboring block).

**Revision-tracking markup**, refined by the review: `w:ins` and `w:moveTo`
(content present at, or moved to, this location in the current document) are
read normally, their text included. `w:del` and `w:moveFrom` (content
removed from, or moved away from, this location) are excluded entirely —
walked past without recursing, so it does not matter whether their content
uses `w:delText` (the spec-correct element for deleted text) or, in a
non-conformant producer, a bare `w:t`; exclusion is by element identity, not
by which text tag happens to appear inside it. Encountering any of the four
always adds `unsupported-structure`: full tracked-change semantics
(accepted/rejected state, competing/nested edits) are not resolved, only this
one best-effort reading of "what is current."

A **hidden run** (`w:r` whose `w:rPr` contains an active `w:vanish`) is
excluded and flagged `hidden-content-excluded`, the same code the HTML
adapter uses for hidden content. "Active" honors CT_OnOff semantics (ECMA-376
Part 1, §17.17.4) exactly: the element's own presence means on (hidden)
unless `w:val` explicitly turns it off. An absent `w:val`, or `w:val` of
`true`/`1`/`on`, is hidden; `w:val` of `false`/`0`/`off` is visible. A bare
`<w:vanish/>` is therefore hidden, but `<w:vanish w:val="false"/>` is not.

`w:altChunk` (an embedded foreign-format part, referenced by relationship ID)
is never opened — this adapter has no mechanism to open any part except the
resolved main document part — and is flagged `unsupported-structure`. It
does not advance `bodyOrdinal` (it is not a `w:p`/`w:tbl` block) and does not
shift the ordinals of surrounding paragraphs.

Any **foreign-namespace element** — most commonly Word's own
`mc:AlternateContent` (routinely emitted to wrap a modern drawing/shape with
an older fallback for backward compatibility) — is never opened and is
flagged `unsupported-structure`, whether it appears inside a paragraph or
directly under `w:body`. This adapter does not resolve markup-compatibility
`mc:Choice`/`mc:Fallback` selection; the whole element, and any text inside
it, is skipped. An earlier revision skipped a foreign-namespace element
silently, with no limitation at all; that gap is what this flagging closes.

An unrecognized **WordprocessingML-namespace** element as a **direct
`w:body` child** — most commonly a run or text orphaned there by a locally
mismatched tag elsewhere in the document, though that specific case is now
caught earlier by well-formedness validation (see "Accept / reject policy")
— is flagged `unsupported-structure` rather than silently absorbed. A fixed
allowlist of legitimate, block-free body metadata (`w:sectPr`,
`w:bookmarkStart`/`w:bookmarkEnd`, `w:proofErr`, `w:commentRangeStart`/
`w:commentRangeEnd`, `w:permStart`/`w:permEnd`) is still silently skipped, as
before.

**Known debt:** merged-cell `gridSpan`/`vMerge` alignment across table rows is
not resolved. `row`/`column` are positional ordinals among each row's own
`w:tc` children, not the visually merged grid position. A table with merged
cells still extracts every cell's text; the column numbering for later rows
may not visually line up with an earlier row's merged cell. Revisit if a
consumer needs true grid alignment.

## Accept / reject policy

`SourceRepresentationLimitation`, defined in `source-evidence.ts` (#835, not
modified here), is a stable, seven-code vocabulary. This adapter reuses the
existing codes rather than inventing new ones, which means most archive- and
package-level abuse cases below collapse to one host-level signal
(`SourceExtractionError("empty-extraction")`, raised by `source-extraction.ts`
when an adapter returns zero segments) rather than each getting its own
labelled reason at the host boundary.

That collapse is real, and the review asked for it to be made testable
anyway: `diagnoseDocxPackage(bytes, options?)` (exported from `docx.ts`,
explicitly **not** part of `SourceExtractorAdapterV1` — a test/diagnostic
surface only) runs the same ZIP-and-package-resolution logic `extract()`
uses internally and returns the specific internal `DocxPackageReasonCode`
(e.g. `"encrypted"`, `"content-type-mismatch"`, `"duplicate-part"`) before it
is collapsed. Every archive/package-level row below is asserted against its
exact reason code in `test/source-evidence-docx.test.ts`, so a regression
that silently swaps one refusal reason for another (while still emitting
zero segments, still passing a coarser "it throws" test) is caught. A
malformation inside the *main document part's own XML* (DOCTYPE/entity, XML
depth, XML node count) is only visible to `extract()`, not to
`diagnoseDocxPackage`, since package resolution never parses that part's
content — those rows are tested through the host `SourceExtractionError`
code only, which is all a real caller ever observes.

| Case | Outcome | Diagnostic reason code |
| --- | --- | --- |
| No End-Of-Central-Directory record found | Hard refusal (`empty-extraction`) | `eocd-not-found` |
| ZIP64 sentinel present | Hard refusal (`empty-extraction`) — zip64 is not implemented | `zip64-unsupported` |
| Central-directory entry count over `maxArchiveEntries` | Hard refusal (`empty-extraction`) | `too-many-entries` |
| Unparseable / truncated central directory | Hard refusal (`empty-extraction`) | `central-directory-malformed` |
| Encrypted entry (general-purpose bit 0) | Hard refusal (`empty-extraction`) | `encrypted` |
| Absolute path, `..` traversal, or backslash separator in a part name | Hard refusal (`empty-extraction`) | `unsafe-path` |
| Symlink entry (Unix mode bits in external attrs) | Hard refusal (`empty-extraction`) | `symlink` |
| Duplicate part name, exact or case-insensitive | Hard refusal (`empty-extraction`) | `duplicate-part` |
| Local file header name disagrees with the central directory entry it belongs to | Hard refusal (`empty-extraction`) | `expansion-failed` |
| `word/vbaProject.bin` present (macro-enabled package) | Hard refusal (`empty-extraction`) | `macro-enabled` |
| `_rels/.rels` missing / unreadable / malformed | Hard refusal (`empty-extraction`) | `root-relationships-missing` / `-unreadable` / `-malformed` |
| No, or more than one, `officeDocument` relationship | Hard refusal (`empty-extraction`) | `main-relationship-missing` / `-ambiguous` |
| `officeDocument` relationship has `TargetMode="External"` | Hard refusal (`empty-extraction`) | `main-relationship-external` |
| Relationship target unsafe, or absent from the archive | Hard refusal (`empty-extraction`) | `main-part-unsafe-path` / `main-part-missing` |
| `[Content_Types].xml` missing / unreadable / malformed | Hard refusal (`empty-extraction`) | `content-types-missing` / `-unreadable` / `-malformed` |
| Resolved part's effective content type is not the WordprocessingML main-document type | Hard refusal (`empty-extraction`) | `content-type-mismatch` |
| Declared **or actual** expansion of any read part over `maxExpandedBytes` | Hard refusal (`empty-extraction`) | `expansion-failed` |
| `<!DOCTYPE` or `<!ENTITY` anywhere in the main document part | Hard refusal (`empty-extraction`) | *(not visible to `diagnoseDocxPackage`; inside the main part's own XML)* |
| XML nesting over `maxXmlDepth`, or node count over `maxXmlNodes`, in the main document part | Hard refusal (`empty-extraction`) | *(same)* |
| **Any well-formedness violation** in the main document part (mismatched/unclosed tag, invalid structure) — `XMLValidator.validate` | Hard refusal (`empty-extraction`) | *(same)* |
| Non-UTF-8 main document part | Partial: `unsupported-encoding` | n/a |
| Nested table inside a cell | Partial: `unsupported-structure`, nested table's text absent | n/a |
| Table row/cell wrapped in a content control (`w:sdt`), or a cell paragraph wrapped in `w:customXml` | Partial: `unsupported-structure`, wrapped content absent | n/a |
| Revision-tracking markup (`w:ins`/`w:del`/`w:moveFrom`/`w:moveTo`) | Partial: `unsupported-structure`; `w:ins`/`w:moveTo` text kept, `w:del`/`w:moveFrom` text excluded | n/a |
| Hidden run (`w:rPr/w:vanish`, CT_OnOff-aware) | Partial: `hidden-content-excluded` | n/a |
| Inline media/embedded object (`w:drawing`/`w:object`/`w:pict`) | Partial: `non-text-content-excluded` | n/a |
| `w:altChunk` (embedded foreign-format part) | Partial: `unsupported-structure`, never opened | n/a |
| Any other foreign-namespace element (e.g. `mc:AlternateContent`) | Partial: `unsupported-structure`, never opened | n/a |
| Unrecognized WordprocessingML-namespace direct `w:body` child | Partial: `unsupported-structure` | n/a |
| Block-level or unrecognized element nested inside a paragraph (e.g. a well-formed-but-schema-invalid `w:p` nested in `w:p`, or `w:customXml`) | Partial: `unsupported-structure`, never recursed into | n/a |
| Body-level content control (`w:sdt` wrapping whole paragraphs) | Partial: `unsupported-structure`, `w:sdtContent` never opened | n/a |
| Header/footer/footnote/endnote/comment part present ("omitted story") | Partial: `unsupported-structure`, part never opened | n/a |
| CDATA section inside `w:t` | No refusal or limitation — content taken literally, never entity-decoded | n/a |
| Wrong media type | Host-level `unsupported-media-type`, before the adapter runs | n/a |

A **locally mismatched or unclosed XML tag** anywhere in the main document
part is a hard refusal, not the partial recovery an earlier revision of this
adapter and document described. `fast-xml-parser`'s own `parse` step is, left
unchecked, forgiving of exactly this malformation: it recovers by nesting
later content under the still-open element rather than raising an error. For
this adapter that recovery is a provenance hazard, not a convenience — a
paragraph left open by one missing `</w:r>` would otherwise swallow every
following paragraph's text into a single fabricated span at the first
paragraph's locator, reported as `completeness: "complete"` with no
limitation at all. `XMLValidator.validate` (from the same pinned package) is
run before `parse` ever sees the document and refuses outright on any
well-formedness violation.

The zip-bomb defenses (`maxArchiveEntries`, `maxExpandedBytes`) do not require
gigabyte-scale fixtures to test: `extractSourceRepresentation`'s `options`
parameter overrides the adapter's `defaultOptions` per call, so the test suite
proves enforcement with small fixtures and small overridden caps. One test
goes further, per the review's finding that a bomb test built with an honest
declared size only ever tripped the cheap declared-size pre-check: it builds
an entry whose **declared** `uncompressedSize` is a small, budget-compliant
lie, while the real `DEFLATE` stream honestly inflates to far more, proving
the pre-check cannot be the only bound.

`inflateRawSync`'s `maxOutputLength` and this module's own
post-decompression size check are **not equally strong**, and this document
no longer claims otherwise (an earlier revision did, incorrectly).
`maxOutputLength` is the real protective bound: it aborts decompression as
soon as the cap would be exceeded. The review measured a 510 KB entry
inflating 1029:1 toward 512 MiB: roughly 28 ms and 30 MiB RSS with the bound
in place, versus roughly 650 MiB RSS materialized before the
post-decompression check could reject anything when the bound was removed.
The post-decompression check only runs *after* `inflateRawSync` returns, so
it is correctness defense in depth against a coding mistake in the call, not
a substitute resource bound. A test asserts the real
mechanism directly rather than only its eventual effect: it wraps
`inflateRawSync` and asserts every call receives `maxOutputLength` equal to
the configured cap, so a change that dropped the option would fail that
assertion immediately, before any question of which check happens to still
catch the resulting oversized buffer.

## Fixes from the non-author review

A non-author critic reviewed an earlier version of this adapter and found:

- **Blocking.** A body paragraph under an alternate namespace prefix bound to
  the WordprocessingML URI was silently dropped, and later block ordinals
  shifted. Fixed by namespace-URI resolution (see "Blocks and locators"
  above); tested with an alternate-prefix paragraph interleaved among
  `w:`-prefixed ones, asserting identical ordinals and no shift.
- **Blocking.** The hand-rolled tokenizer's attribute scan was quote-unaware;
  a crafted `w:t` attribute value containing a literal `>` could corrupt the
  following text. Structurally impossible with `fast-xml-parser` (a real,
  quote-aware parser); a negative-control test is kept anyway.
- **Blocking.** The main document part was hardcoded to `word/document.xml`
  and `_rels/.rels` was never read, so a package whose real relationships
  pointed elsewhere while a decoy sat at the conventional path would cite the
  decoy. Fixed by the resolution procedure in "Main document part
  resolution" above.
- **High.** A table nested inside a cell lost its inner text while reporting
  `limitations: []`, contradicting this document's own claim. Fixed:
  `unsupported-structure` is now actually emitted (the nested table's text
  remains unextracted; extracting it is out of scope for this Task, see
  known debt).
- **Test gaps.** Two mutants that should have failed a test instead passed
  the (then) full suite: removing `inflateRawSync`'s `maxOutputLength`, and
  dropping `w:del` from the excluded-revision set while a `delText`-only test
  masked it structurally (see "Accept / reject policy" and "Blocks and
  locators" above for both fixes and their now-load-bearing tests).
- **Medium.** `w:altChunk` and hidden (`w:vanish`) runs were silently
  unhandled. Both are now explicitly flagged (see "Blocks and locators").
- **Low.** A local file header naming a different part than its central
  directory entry, and a case-only duplicate part name (`Word/Document.xml`
  shadowing `word/document.xml`), were not checked. Both now refuse.
- **Refusal collapse.** Addressed by `diagnoseDocxPackage`, described in
  "Accept / reject policy" above.

## Fixes from the second non-author review

A second non-author review, at the head produced by the fixes above,
confirmed defects 1–4 and the earlier test gap fixed and independently
proven, and the dependency ruling correct, but found one new blocking defect
plus four follow-ons:

- **Blocking — no well-formedness gate.** `fast-xml-parser`'s forgiving
  recovery from a mismatched/unclosed tag (see "Accept / reject policy") let
  a missing `</w:r>` fabricate one span merging three unrelated paragraphs'
  text at the first paragraph's locator, reported as complete with no
  limitation. Fixed by running `XMLValidator.validate` before `parse` and
  refusing outright on any well-formedness violation; tested with the exact
  three-paragraph scenario, asserting refusal rather than merged text, and
  with a mutant proof (removing the validator call makes that test fail).
- **High — foreign-namespace elements silently dropped.** `mc:AlternateContent`
  (which Word routinely emits) and any other non-WordprocessingML element
  lost its text with `limitations: []`. Fixed: any foreign-namespace element,
  inside a paragraph or directly under `w:body`, is now flagged
  `unsupported-structure` (see "Blocks and locators").
- **Medium — `w:vanish` ignored `w:val`.** `<w:vanish w:val="false"/>` (or
  `"0"`/`"off"`) incorrectly hid visible text. Fixed: CT_OnOff semantics are
  now honored exactly (see "Blocks and locators").
- **Medium — the `maxOutputLength` test gap was not actually closed.**
  Dropping `maxOutputLength` alone still passed the full suite, because the
  redundant post-decompression check still caught the final oversized
  result — but only after the full buffer was materialized (measured at
  roughly 650 MiB RSS for a crafted entry, versus roughly 30 MiB with the
  bound in place), a real resource-exhaustion difference this document's
  prior "independently sufficient" claim did not account for. That claim is
  corrected above (see "Accept / reject policy"), and a new test wraps
  `inflateRawSync` to assert every call actually receives the configured
  `maxOutputLength`, observing the mechanism directly instead of only its
  eventual effect; mutant-proved (removing the option makes this new test
  fail immediately).
- **Low.** An officeDocument relationship with `TargetMode="External"` was
  read as if it were an internal part path. Fixed: explicitly refused (see
  "Main document part resolution"). CDATA content inside `w:t` was
  entity-decoded like ordinary text, corrupting a literal `&amp;` inside a
  CDATA section. Fixed by giving CDATA its own parser key, never routed
  through this module's entity decoder (see "No entity resolution, no DTD
  loading").

## Fixes from the third non-author review

A third non-author review, at the head produced by the fixes above,
confirmed the round-two blocking defect and all four follow-ons fixed and
independently proven (the validator-removal mutant now fails 7 tests; the
`maxOutputLength`-removal mutant now fails the dedicated mocked-call test;
132/132 regression clean), but found that the fix closed one instance of a
defect class rather than the class itself:

- **Blocking — the validator closes the instance, not the class.**
  `XMLValidator.validate` catches an *unclosed or mismatched* tag, but a
  `<w:p>` nested directly inside another `<w:p>` is still perfectly
  well-formed XML — WordprocessingML's schema forbids it, not XML itself —
  so the validator does not, and cannot, catch it.
  `collectParagraphText`'s generic container fall-through still recursed
  into any unrecognized WordprocessingML-namespace child, including a
  nested `w:p`, reproducing the identical fabrication byte-for-byte
  (`spans: 1`, `"ALPHABRAVOCHARLIE"`, `completeness: "complete"`,
  `limitations: []`) through a `w:customXml` wrapper too. Fixed by making
  the paragraph collector's recursion allowlist-based (see "Blocks and
  locators"): only `w:r`, `w:ins`/`w:moveTo`, `w:hyperlink`, `w:smartTag`,
  `w:fldSimple`, and `w:sdt`/`w:sdtContent` are ever recursed into; anything
  else is flagged `unsupported-structure` and skipped, covering every
  block-level or unrecognized element as one class rather than enumerating
  instances. Tested with the exact nested-`w:p` scenario and a
  `w:customXml`-wrapped variant, both asserting the outer text only, plus a
  mutant proof (reverting to the generic fall-through fails both tests).
  A body-level content control (`w:sdt` wrapping whole paragraphs) is
  documented as known debt rather than extracted, with a test proving its
  content is honestly lost (flagged), never fabricated into a neighboring
  block; an inline content control (wrapping only runs within an
  already-recognized paragraph) is still read, with its own test.
- **Low, addressed rather than left untested.** Eight `DocxPackageReasonCode`
  values appeared in the accept/reject table with no dedicated test
  (`zip64-unsupported`, `root-relationships-malformed`,
  `root-relationships-unreadable`, `content-types-missing`,
  `content-types-unreadable`, `content-types-malformed`,
  `main-part-unsafe-path`, `main-relationship-ambiguous`). All eight were
  cheap to construct from existing test helpers; a dedicated test was added
  for each rather than marking the rows untested.

## Fixes from the fourth non-author review

A fourth non-author review, at the head produced by the fixes above,
confirmed the round-three blocking fix comprehensive (20 independent attacks
correct; the allowlist-revert mutant reproduces the fabrication and fails
both named tests; 144/144), but found one medium finding that was blocking
only because it produced a false `complete` claim:

- **Medium — the paragraph-level allowlist fix had a sibling gap in the
  table walk.** `walkBody`'s `w:tbl` branch looked up rows, cells, and
  paragraphs with bare `wChildren(tbl, "tr")` / `wChildren(row, "tc")` /
  `wChildren(cell, "p")` -- a filter, not an allowlist, with no else-branch
  flag. A schema-valid ECMA-376 content control wrapping a row or a cell
  (`w:tbl > w:sdt/w:sdtContent > w:tr`, `w:tr > w:sdt > w:tc`), or an
  unrecognized wrapper around a cell paragraph (`w:tc > w:customXml >
  w:p`), was therefore silently invisible to the lookup: its text never
  appeared anywhere, while the representation still reported
  `completeness: "complete"` and `limitations: []`. Body-level `w:sdt` was
  already flagged (see "Fixes from the third non-author review"), so the
  adapter was inconsistent between the paragraph/body layer and the table
  layer. Fixed by mirroring the same flag-and-skip posture into all three
  table lookups (see "Blocks and locators"): `collectDirectChildren`
  replaces the bare `wChildren` filter at each of the three levels, flagging
  `unsupported-structure` for anything that is neither the wanted local name
  nor a small, level-specific metadata allowlist (`w:tblPr`/`w:tblGrid` for
  `w:tbl`; `w:trPr` for `w:tr`; `w:tcPr` for `w:tc`, alongside `w:tbl`
  itself, already covered by the existing nested-table flag). Tested with
  the row-via-sdt, cell-via-sdt, and cell-paragraph-via-customXml scenarios,
  each asserting the wrapped text is absent and `unsupported-structure` is
  reported, plus a positive control proving ordinary table metadata
  (`w:tblPr`/`w:tblGrid`/`w:trPr`/`w:tcPr`) is still silently skipped, not
  newly flagged. Mutant-proved: removing the row-level flag reproduces
  `completeness: "complete"` and fails the row-via-sdt test.

## No entity resolution, no DTD loading

`DOCX_XML_SECURITY_POLICY` (`resolveExternalEntities: false, loadExternalDtd:
false`) is a documentation/assertion marker, not a configuration switch.
`fast-xml-parser` is configured with `processEntities: false`: unprocessed
entity references (including `&amp;` and friends) are left as literal text in
the parser's own output, then decoded separately by this module's own
five-entity table (`amp`, `lt`, `gt`, `apos`, `quot`) plus numeric character
references; an unrecognized named entity is left as literal text. The parser
has no DTD subsystem at all (nothing to disable). A `<!DOCTYPE` or `<!ENTITY`
declaration is additionally refused outright by a substring scan before the
parser ever sees the document — verified directly against the installed
version: with `processEntities: false`, a DOCTYPE-declared internal entity is
left completely unexpanded even without the upfront scan, so the scan is
belt-and-suspenders, not the sole safeguard.

CDATA content (`<![CDATA[...]]>`) is configured under its own parser key
(`cdataPropName: "#cdata"`), distinct from ordinary text, specifically so it
is never run back through this module's own entity-decoding table. CDATA
content is literal by the XML specification: an `&amp;` inside a CDATA
section is three real characters, not an escaped ampersand, and decoding it
anyway would corrupt the original text. An earlier revision did not set
`cdataPropName`, so CDATA content was indistinguishable from ordinary text at
the point this module saw it and was incorrectly decoded; that gap is fixed.

## Limits

Declared as part of `defaultOptions`, the adapter's own pinned transformation
settings (merged with the shared `SourceExtractionLimitsV1` from
`source-extraction.ts`, which separately governs original/derivative/span
byte budgets):

| Option | Default | Purpose |
| --- | --- | --- |
| `maxArchiveEntries` | 2,000 | Central-directory entry count ceiling |
| `maxExpandedBytes` | 64 MiB | Decompressed size ceiling, applied uniformly to every part this adapter reads (`_rels/.rels`, `[Content_Types].xml`, and the resolved main document part) |
| `maxXmlDepth` | 64 | XML element nesting ceiling, passed to `fast-xml-parser` as `maxNestedTags` (verified against the installed version to throw *before* fully materializing a document nested beyond it — real pre-allocation protection, not a post-hoc check) |
| `maxXmlNodes` | 200,000 | XML element count ceiling, enforced by this module's own namespace-resolution walk |

These match the ceilings named in #795's
bound table (100 pages; 64 MiB expanded ZIP bytes, 2,000 entries, XML nesting
64) for the shared PDF/DOCX row, adding a node-count ceiling as additional
defense-in-depth against a small-compressed, wide/shallow XML bomb that a
byte-count cap alone would not catch quickly.

## Known debt

- Headers, footers, footnotes, endnotes, and comments are not read. Only the
  resolved main document part's body is traversed.
- Table cell `row`/`column` ordinals do not resolve `gridSpan`/`vMerge`
  merged-cell grid alignment (see above).
- A table nested inside a cell is flagged (`unsupported-structure`) rather
  than extracted with its own ordinals. Revisit if a consumer needs nested
  table text.
- A body-level content control (`w:sdt` whose `w:sdtContent` wraps one or
  more whole paragraphs) is flagged `unsupported-structure`; its content is
  never extracted. Only an *inline* `w:sdt`/`w:sdtContent` (wrapping runs
  within an already-recognized paragraph) is read. Revisit if a consumer
  needs block-level content-control text.
- `w:customXml` is never recursed into, even when it wraps only an ordinary
  run with no nested block content (a real, if less common, case in
  documents with custom XML data bindings). The allowlist in "Blocks and
  locators" trades that completeness for the safety of never assuming an
  unfamiliar container is safe to walk into.
- Per-entry ZIP CRC-32 is not validated by the reader. The host already binds
  the whole original file by SHA-256; a corrupted individual entry either
  fails to inflate (caught) or produces implausible text (caught by the
  divergent-fixture and mutant tests), so CRC-32 checking would add code with
  nothing further to verify at this layer.
- ZIP64 archives are refused outright (`empty-extraction`) rather than
  supported. DOCX files large enough to require ZIP64 are outside this
  adapter's addressed range (`maxExpandedBytes` refuses them first regardless).
- `confined-subprocess` execution mode always refuses today, stated plainly
  by its own error code (`subprocess-unimplemented`) in the base branch's
  shared launcher, `source-parser-launch.ts`. This adapter runs only
  `in-process`, like the HTML adapter, and does not depend on subprocess
  confinement landing.

## Integrated citation chain

`test/source-evidence-docx.test.ts` (`integration: registry to a cited DOCX
span`) re-proves the generic #835 binding → per-step reader → span access →
citation → `SourceEvidenceFinalV1` chain with this adapter substituted for
HTML. The adapter is resolved from `createDefaultSourceExtractorRegistry` by
media type, not imported directly, so a registration miss fails that suite.
A complete original clears the write gate after a real read and accepts a
citation of those spans; an omitted-story or hidden-run original keeps
`completeness: "partial"` and those limitation codes on the final record.
Locators stay `docx-block` (`part` / `blockPath` / `paragraphOrdinal` /
`tableCell`); they are never inferred from rendered HTML or page layout.
`source-acquisition.ts` is now the production caller of
`createDefaultSourceExtractorRegistry`; wiring further acquisition policy
still belongs to #797 / Q1.
