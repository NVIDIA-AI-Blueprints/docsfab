# PDF Evidence Contract

DocsFab extracts text evidence from a PDF with the packaged PDF.js text API, as
decided on issue 795 and implemented for issue 837 in
`src/inputs/adapters/pdf.ts`.

The adapter plugs into the shared extraction seam described in
[source evidence](source-evidence.md). It produces `pdf-page` segments and
nothing else. Identity, digests, budgets, and the sealed representation belong
to the host, exactly as they do for every other adapter.

## What The Adapter Does

It hands verified bytes to a pinned `pdfjs-dist` build, asks each page for its
text content, and turns what PDF.js produced into segments.

It never tokenizes a content stream, resolves an object by scanning for an
`N G obj` header, decodes a font, or decompresses anything itself. A withdrawn
hand-written parser did all of that and a non-author review found five distinct
defects in it: an unbounded `inflateSync`, Latin-1 mis-decoding of
Type0/Identity-H text, inline image bytes emitted as text, shadow objects from
an incremental update cited as current, and silent blindness to PDF 1.5 object
streams. None of that code exists here, so none of those defects is reachable.

Two rules decide every outcome below.

1. **Never emit text PDF.js did not produce.** Every retained character comes
   from a `getTextContent()` item, byte for byte. When PDF.js signals that it
   could not map a glyph, the page is refused rather than quoted.
2. **Never report an incomplete read as complete.** A page with no text layer, a
   page whose glyphs would not map, a document past the page ceiling, and a
   document PDF.js refused all produce a limitation. The host turns a limitation
   into `partial` completeness, and the write gate treats partial evidence as
   unread.

## Pinned Parser

| Item | Value |
| --- | --- |
| Package | `pdfjs-dist` |
| Version | `6.3.289`, pinned exactly |
| Build | `pdfjs-dist/legacy/build/pdf.mjs`, the build that runs without a browser worker |
| Load | Dynamic import, once per process, only when a PDF is opened |

The version is also a value in the adapter's `defaultOptions`, so it is part of
the extractor options digest and therefore part of every `spanId`. Upgrading the
parser changes span identity rather than silently re-interpreting bytes under an
identifier that already exists. A test asserts that the constant, the installed
package version, and the loaded module's own `version` all agree.

## Registry And Missing Parser

A shipped host reaches this adapter only through
`createDefaultSourceExtractorRegistry()`. The `pdf` extension maps to
`application/pdf` on the fixed allowlist. A registry that omits the adapter
does not resolve that media type: that is a missing parser, not a successful
empty read.

If the packaged `pdfjs-dist` build fails to load, the host seam refuses with
`adapter-failed` and does not quote the loader's message. Credential-shaped
extractor options are rejected before a byte reaches `getDocument`.

The upload helper in `src/inputs/pdf-adapter.ts` is a different path. It is
not this extractor and is not the production source-evidence adapter.

## Loading Configuration

The adapter calls `getDocument` with the bytes plus exactly this frozen option
set, and nothing else:

| Option | Value | Why |
| --- | --- | --- |
| `data` | A private copy of the verified bytes | PDF.js takes ownership of the buffer it is given and detaches it. The host still has to digest the original, so PDF.js never receives the host's buffer. |
| `useWorkerFetch` | `false` | No resource fetching from the worker. |
| `useWasm` | `false` | No WebAssembly module is loaded. |
| `useSystemFonts` | `false` | No font is read from the operating system. |
| `enableXfa` | `false` | The XFA layer is not built. XFA documents are refused outright. |
| `stopAtErrors` | `true` | A damaged page stops rather than producing best-effort output. |
| `isEvalSupported` | `false` | Kept from issue 795. `pdfjs-dist@6` removed the evaluation code path outright, so the flag is inert in this version; it is passed so the intent stays legible and survives a downgrade. |
| `disableFontFace` | `true` | No font face is installed. |
| `disableAutoFetch` | `true` | No speculative range request. |
| `disableStream` | `true` | No streamed fetch. |
| `verbosity` | `0` | Parser diagnostics never reach a log that a run record could capture. |

### Packaged Resources

`pdfjs-dist@6` replaced the injectable `CMapReaderFactory` and
`StandardFontDataFactory` with URL options. The adapter's fixed policy for this
version is that none of `cMapUrl`, `standardFontDataUrl`, `wasmUrl`, `iccUrl`,
`url`, `range`, `httpHeaders`, or `withCredentials` is ever set. PDF.js therefore
has no location to read from: no network request, and no filesystem read outside
the process. A document that would need a predefined Adobe CMap fails closed with
`unsupported-encoding` instead of reaching outside the process for a mapping
table.

`PDF_FORBIDDEN_RESOURCE_OPTIONS` names that list, and a test asserts that the
object actually handed to `getDocument` contains none of those keys and contains
exactly `data` plus the pinned options.

## Limits

| Limit | Value | Behavior when exceeded |
| --- | --- | --- |
| Pages | 100 | Pages 1 through 100 are read; the rest are not. The document is reported with the `over-page-limit` reason. |
| Original bytes | The host's `limits.maxOriginalBytes` | Refused before a byte reaches the parser, by the host and again by the adapter. |
| Spans | The host's `limits.maxSpans` | Page reading stops, and the document is reported with the `over-page-limit` reason. |
| Derivative bytes | The host's `limits.maxDerivativeBytes` | The host truncates and adds `byte-budget-truncated`. |
| Wall clock | The host's `limits.maxExtractionMs` | The host refuses with `extraction-deadline-exceeded` and discards partial work. |

The loading task is destroyed on completion, on error, and on cancellation. The
adapter implements the seam's optional `abort(request)` hook, which destroys the
in-flight loading task, and it also destroys on `request.signal`.

## Locators

One segment per page that produced citable text, with the `pdf-page` locator:

```ts
{ kind: "pdf-page", pageNumber, itemStart, itemEnd }
```

- `pageNumber` is one-based.
- `itemStart` and `itemEnd` are zero-based and half-open, indexing that page's
  pinned extracted text-item sequence. That sequence is exactly the text items
  PDF.js returned for the page, in its order, with marked-content boundary
  records removed.
- The derivative span gives the exact quoted bytes. Page text is the item
  strings concatenated in PDF.js order, with a newline after an item PDF.js
  marked as ending a line, and trailing whitespace removed. No spacing is
  guessed from glyph geometry, because a guessed space is a character the source
  does not contain.

A page is cited whole or not at all, so `itemStart` is `0` and `itemEnd` is the
page's item count. The fields are still part of the locator, and therefore part
of the `spanId`, so a citation that names the wrong page or the wrong item range
does not verify. Substituting another original's representation onto an
observation bound to these bytes fails closed with `substitution`.

## Writer And Verifier Citation

Page text becomes citable only after a host-issued step reader actually reads
the sealed `pdf-page` span. `createSourceSpanCitation` plus
`verifySourceSpanCitations` accept a citation whose spans were read in the same
step of the same binding, and they reject an unread page, a wrong step, or a
material claim with no citation. Partial documents (mixed pages, AcroForm, page
ceiling, derivative or span budgets) keep their limitations on the sealed
representation; the write gate reports `partial` coverage rather than treating
the quotation as complete.

## Reason Codes

The seam's `limitations` vocabulary is fixed and shared across adapters, so it
cannot express a PDF-specific reason. `extractPdfTextEvidence` additionally
returns specific reason codes; `extract()` is the projection of that onto the
seam's `{ segments, limitations }` shape.

| Reason | Seam limitation | Meaning |
| --- | --- | --- |
| `encrypted` | `unsupported-structure` | The document carries a security handler. Checked **after load**, because a document with an empty user password opens and decrypts silently: `getMetadata().info.EncryptFilterName` is a string, or `getPermissions()` returns non-null. Either one refuses, before any page is read. A load that fails with a password exception refuses too. Nothing pattern-matches raw bytes, so `/Encr#79pt` and `/Encrypt` are the same name. |
| `xfa-form` | `active-content-excluded` | The document declares an XFA form. Its reader-visible content lives in the XFA stream, so the static page layer is not the document. |
| `forms-layer-excluded` | `active-content-excluded` | The document declares an AcroForm. Static page text is still cited, but field values live in the form and never appear in it, so the representation is partial. Covered by `acroform.pdf`. |
| `no-text-layer` | `non-text-content-excluded` | PDF.js returned no text item for a page, or the items joined to nothing. Image-only pages, inline-image-only pages, and empty pages are indistinguishable through the text API and all mean the same thing here. |
| `unsupported-encoding` | `unsupported-encoding` | A page's text contains a character PDF.js emits for an unmapped glyph: U+FFFD, a private-use code point, an unpaired surrogate, or a control character. The page is refused rather than quoted. |
| `over-page-limit` | `span-budget-truncated` | The document has more pages than the ceiling, or the span budget stopped page reading. |
| `over-size` | `unsupported-structure` | The original exceeds `limits.maxOriginalBytes`. |
| `malformed` | `unsupported-structure` | PDF.js refused the document or a page for any other reason. |
| `cancelled` | `unsupported-structure` | The host cancelled mid-document. |

Only `encrypted` is distinguished from `malformed`. Every other PDF.js failure
maps to `malformed` on purpose: PDF.js error messages are built from the
untrusted bytes and can quote them, so nothing but a fixed code leaves the
adapter.

There is no `heuristic-encoding` row in the table above, and that absence is
deliberate. Refer to [Heuristic Font Decoding](#heuristic-font-decoding) for the
decided policy and why its detection is deferred.

## Heuristic Font Decoding

A composite font is a PDF `Type0` font with a CID-keyed descendant. When such a
font carries no embedded `ToUnicode` CMap, the bytes in the content stream are
character identifiers with no declared Unicode meaning. PDF.js does not refuse
them: it falls back to a heuristic mapping from CID to Unicode, and for an
Identity ordering that heuristic is the identity function, so the character it
emits is the CID value read as a code point.

Sometimes that heuristic lands on ordinary characters and the text looks
perfectly normal. `test/fixtures/source-evidence/pdf/type0-font.pdf` and the
#920 pair member `type0-heuristic-encoding.pdf` are exactly that shape: their
content streams show CIDs `0x0030`, `0x0031`, and `0x0032`, and PDF.js returns
the string `012`. Nothing in the document says those glyphs mean the digits
zero, one, and two. The control `type0-tounicode.pdf` carries the same CIDs
plus an embedded ToUnicode CMap that maps them to A, B, and C, so PDF.js
returns `ABC`. Sometimes the same heuristic lands on replacement or
private-use code points instead, which is
`test/fixtures/source-evidence/pdf/type0-unmapped.pdf`.

### Decided Policy

Recorded by the reviewing maintainer on September 15, 2026, as an amendment to issue 795, and
repeated here so a reader of this contract does not have to open the issue:

- Flag, do not refuse. A page whose text comes from a composite font without a
  `ToUnicode` map is **not** refused. Its text is emitted.
- Never cite it as complete. Such a page must be sealed `partial`, carrying a
  `heuristic-encoding` limitation, so the write gate treats it as evidence that
  was read imperfectly rather than as a faithful quotation.
- Unmapped glyphs are unchanged. When the heuristic produces a replacement
  character, a private-use code point, an unpaired surrogate, or a control
  character, the page is still refused with `unsupported-encoding`. That path is
  not relaxed by this policy.

### Detection Is Deferred

The policy is recorded; the adapter does not implement it yet, because
`pdfjs-dist@6.3.289` exposes no public per-font indicator that distinguishes
"composite font without a `ToUnicode` map" from "composite font with one". This
was investigated against the pinned build and its shipped `types/` on
September 16, 2026, and independently re-probed on September 21, 2026 against
the same pin, the frozen option set, and the #920 fixture pair. The findings
are:

| What was tried | Result |
| --- | --- |
| Per-font data from the text API | `getTextContent()` items carry only `fontName`, and `TextContent.styles` carries only `fontFamily`, `ascent`, `descent`, and `vertical`. Neither says anything about `ToUnicode`. |
| `page.commonObjs.get(item.fontName)` after `getTextContent()` | Empty. The text-content path never sends the font to the main thread; only `getOperatorList()` does. |
| `getOperatorList()` to populate `commonObjs` | Works, but it is a rendering-preparation call. Issue 795 restricts this adapter to text extraction and forbids invoking a rendering API, and with `disableFontFace` set to `true` an operator list additionally compiles glyph paths and handles images from untrusted bytes. That is a contract change, not an implementation detail. The 2026-09-21 probe also showed that `getOperatorList()` under the frozen option set (no `fontExtraProperties`) yields only `_inspectFont` and `compiledGlyphs`: still no `composite`, no `toUnicode`. |
| `composite` and `toUnicode` on the font object | Present only when `getDocument` receives `fontExtraProperties: true` **and** `page.getOperatorList()` has run. PDF.js documents that option as useful for debugging and notes that it increases memory use. It is also outside the frozen option set in [Loading Configuration](#loading-configuration), and because that set feeds the extractor options digest, adding it changes every `spanId`. The 2026-09-21 probe confirmed `fontExtraProperties: true` alone still leaves `page.commonObjs.get(fontName)` throwing after `getTextContent()`. |
| `toUnicode` presence as the discriminator | Does not work. PDF.js always synthesises a `toUnicode`, so the field is present either way. The only difference is the serialized shape of an internal class: a real map arrives as `{ _map: [...] }` and the heuristic fallback arrives as `{ firstChar: 0, lastChar: 65535 }`. |
| The worker's own boolean | `hasIncludedToUnicodeMap` is computed inside the worker and answers this question exactly, but it is not in the exported font-data property list, so it never crosses to the main thread. |
| The package's declared types | `FontFaceObject` is not exported from `types/src/pdf.d.ts`, `commonObjs.get()` returns `any`, and neither `ToUnicodeMap` nor `IdentityToUnicodeMap` has a declaration anywhere in `types/`. |

Every remaining route therefore needs both a forbidden rendering call and a
read of an underscore-private field. Depending on `_map` would also fail in the
wrong direction: if a future PDF.js release renamed it, every composite font
would start looking like it carried a real `ToUnicode` map, and DocsFab would go
back to citing heuristic text as complete without anything failing. A guess that
fails open is worse than a documented gap.

### fontExtraProperties: not taken

Decision, September 21, 2026, this Task: do **not** add
`fontExtraProperties: true` to the frozen `getDocument` option set.

Reasons:

- The option is outside [Loading Configuration](#loading-configuration). Adding
  it would change the extractor options digest and therefore every `spanId`,
  which would require bumping `PDF_SOURCE_EXTRACTOR_VERSION` as an extractor
  identity change. That cost is not justified when the option does not, by
  itself, expose a ToUnicode signal on the text path.
- PDF.js documents it as a debugging option that increases memory use.
- Combined with `page.getOperatorList()` it is a rendering-preparation API,
  which #795's adapter policy forbids.
- Even then the discriminator is the private `_map` versus `firstChar` /
  `lastChar` shape, which fails open if renamed.

`PDF_SOURCE_EXTRACTOR_VERSION` therefore stays `"2"`. The option set is
unchanged.

### Known Gap Today

Until an indicator exists, the adapter behaves as it did before this policy was
recorded: a composite font without `ToUnicode` whose heuristic produces ordinary
characters is cited, and the representation is sealed `complete` unless some
other reason made it partial. That is the gap, and it is listed again under
[Known Gaps](#known-gaps).

`heuristic-encoding` is a planned limitation code. It is **not** a member of
`SOURCE_REPRESENTATION_LIMITATIONS` today, and the closed decoder in
`src/inputs/source-evidence.ts` rejects it. Adding it is part of the deferred
implementation, not of this record.

### Upstream Request

The clean fix belongs in PDF.js. The reviewing maintainer filed
[mozilla/pdf.js#21968](https://github.com/mozilla/pdf.js/issues/21968) on
September 16, 2026 from the draft below plus the same-day probe evidence. A
PDF.js maintainer closed it the same day as `not_planned`, with no comment
and no public text-API indicator added.

This Task therefore cannot implement detection at `pdfjs-dist@6.3.289` inside
#795's frozen text-extraction policy. Remaining product choices belong to the
#795 owner: amend that policy to permit the operator-list route with its cost
accepted, or keep the gap until a later pinned PDF.js version exposes a public
per-font ToUnicode indicator through `getTextContent()` or
`TextContent.styles`.

Original request text, kept for the record:

> **Title:** Expose whether a font's ToUnicode CMap was embedded, through the
> text-content API
>
> **Body:** `getTextContent()` gives each item a `fontName`, but nothing that
> says whether the characters in `str` came from an embedded `ToUnicode` CMap or
> from the CID-to-Unicode heuristic fallback. For a composite (Type0/CID) font
> with no `ToUnicode` map, PDF.js returns plausible-looking characters that the
> document never actually declared. Consumers that cite PDF text as evidence
> need to tell those two cases apart, and today they cannot.
>
> The worker already computes exactly this: `properties.hasIncludedToUnicodeMap`
> in `src/core/evaluator.js`. It is not in `EXPORT_DATA_EXTRA_PROPERTIES`, so it
> never reaches the main thread, and the extra properties it sits alongside
> require `fontExtraProperties: true`, which the documentation describes as a
> debugging option.
>
> Everything else reachable today requires either `getOperatorList()` (to
> populate `commonObjs`, which `getTextContent()` does not) or reading the
> serialized shape of `ToUnicodeMap` versus `IdentityToUnicodeMap`, neither of
> which is public API.
>
> **Request:** expose a boolean such as `hasIncludedToUnicodeMap` (and ideally
> `composite`) without requiring `fontExtraProperties`, either on each `TextItem`
> or on the matching `TextContent.styles` entry, which already carries per-font
> data keyed by the same `fontName`.
>
> **Version:** `pdfjs-dist@6.3.289`, legacy build, Node.

## Inertness

Extraction runs in the host process, in the seam's `in-process-inert` mode. The
reserved `confined-subprocess` mode is still unimplemented and still refuses, so
this adapter does not depend on it.

The claim is narrow and it is measured: **no filesystem, network, subprocess,
home-directory, or evaluator capability is exercised during extraction.**
PDF.js still runs with this process's capabilities, and nothing in this adapter
changes that. The confinement probe and the extraction tests record the running
host (`process.platform`). This Task claims only the platform those tests ran
on.

`pdfjs-dist@6.3.289` ships no `eval` call and no `Function` constructor. It does
reach the filesystem, and not through an `import`: it calls
`process.getBuiltinModule("fs")` and `("fs/promises")` inside `getReadableStream`
and `node_utils_fetchData`, which run only on the URL-loading path, and it runs
`getBuiltinModule("module").createRequire(...)("@napi-rs/canvas")` once while the
module is being evaluated. Passing `data` instead of a URL is what keeps the
first group unreached. `fetch` and WebAssembly are unreachable for the same
reason: no resource URL is configured and `useWasm` is `false`.

`test/source-evidence-pdf.test.ts` measures rather than asserts this.
`process.getBuiltinModule` itself is wrapped, along with `node:fs`,
`node:fs/promises`, `node:child_process`, `node:net`, `node:http`, `node:https`,
`node:os`, and `node:vm`, and `globalThis.fetch` is replaced with a spy. Every
wrapper runs the real implementation and records the call. The whole fixture
corpus, including `chained-filter-bomb.pdf`, is then extracted with an **empty
call log**.

Four controls keep that emptiness meaningful:

- A subprocess launched through `process.getBuiltinModule("child_process")` is
  recorded. This is the exact escape an earlier version of the test missed: it
  wrapped only `import()`, so a real subprocess ran with the log still empty.
- A filesystem read is recorded through both `getBuiltinModule("fs")` and an
  ordinary `import("node:fs/promises")`.
- A home-directory read through `getBuiltinModule("os").homedir()` is recorded,
  so an empty log is not blindness to a `HOME` or user-info lookup.
- The build's own import-time `getBuiltinModule("module")` call is recorded,
  which proves the wrapper observes PDF.js and not only the test's own calls.

The canvas require is **import-time only**. It happens before any document is
opened, it fails closed with a warning when the optional package is absent, and
Node's own resolver performs its filesystem lookup, which is outside what this
wrapper can observe. That is a known gap below, not a measured result.

## Known Gaps

- **Composite fonts without a ToUnicode CMap.** When a Type0 font carries no
  ToUnicode CMap and no embedded program, PDF.js falls back to a heuristic
  mapping from CID to Unicode. When that heuristic produces ordinary mapped
  characters, DocsFab cites them and can seal the representation `complete`;
  when it produces unmapped glyphs, the page is refused with
  `unsupported-encoding`. The product question is now answered: the decided
  policy is to flag such pages `heuristic-encoding` and seal them `partial`,
  never to refuse them and never to cite them as complete. The gap is that the
  adapter cannot detect the case yet, because `pdfjs-dist@6.3.289` exposes no
  public per-font ToUnicode indicator through the text API. An independent
  2026-09-21 probe of the #920 fixture pair reproduced that finding. The
  upstream request [mozilla/pdf.js#21968](https://github.com/mozilla/pdf.js/issues/21968)
  was closed as `not_planned` on 2026-09-16. Refer to
  [Heuristic Font Decoding](#heuristic-font-decoding) for the policy, the
  investigation, the `fontExtraProperties` decision, and the remaining #795
  owner choice.
- **Predefined Adobe CMaps.** A document that needs one fails closed with
  `unsupported-encoding` rather than loading a mapping table, because no
  resource URL is configured.
- **Confined subprocess.** The platform confinement proof for
  `confined-subprocess` remains outstanding; refer to
  [source evidence](source-evidence.md).
- **Import-time canvas require.** The pinned build runs
  `createRequire(...)("@napi-rs/canvas")` once at module evaluation. It fails
  closed when the optional package is absent, and it happens before any document
  is opened, but Node's own module resolver performs a filesystem lookup for it
  that the measured wrapper cannot observe. Import-time only, and outside the
  measured extraction window.
- **Chained decompression filters.** A `/Filter [/FlateDecode x4]` stream is
  small on disk and large decoded. The adapter has no decompressor of its own to
  bound, so what stops it is the seam's `maxExtractionMs`, which reaches PDF.js
  only because PDF.js yields while decoding. A review measured 885 bytes
  expanding to 1 GB in 7.1 seconds, and 8 chained streams in 12.8 seconds,
  before `no-text-layer`; a 300 ms budget returned at 301 ms.
  `chained-filter-bomb.pdf` and its test pin both halves. Bounding decode work
  directly, rather than by elapsed time, remains open.
- **No OCR and no visual fidelity.** Text extraction only. A scanned page has no
  text layer and is reported as such.
- **Cross-platform confinement matrix.** The probe table names both
  `sandbox-exec` (macOS) and `bubblewrap` (Linux). Local evidence records only
  the host that ran the tests. The other platform remains a CI or #839 claim.
