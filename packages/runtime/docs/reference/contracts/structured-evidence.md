# Structured Repository Evidence

DocsFab converts structured repository sources into inert UTF-8 text
representations. Each retained span includes a locator into the admitted
original bytes. The host computes the original digest, derivative digest,
representation identity, and span identity.

The adapters accept bytes from an authenticated source producer. They do not
open files, fetch references, execute notebooks, or grant repository access.
Each admitted source uses the structured-source 20 MiB original-byte ceiling,
passed explicitly through E1 extraction. A source set accepts at most 64
sources, 64 entry paths, and 64 MiB of supplied bytes.

## Supported Sources

The initial structured adapters support these source families:

| Source | Locator | Extracted Content |
| --- | --- | --- |
| Plain text, source code, and text configuration | `text` | Nonempty lines with zero-based, half-open UTF-8 byte ranges in the original |
| JSON, OpenAPI JSON, and JSON Schema | `json-pointer` | Scalar values and empty containers with RFC 6901 pointers |
| YAML and OpenAPI YAML | `json-pointer` | The same semantic subset as JSON after strict YAML parsing |
| Jupyter Notebook | `notebook-cell` | Markdown and code cell source plus text-bearing historical outputs |

Text locators preserve original byte identity. For example, a CRLF separator
still consumes 2 original bytes even though separators between derivative
spans use a single newline.

JSON Pointer tokens escape `~` as `~0` and `/` as `~1`. The empty pointer
identifies the document root. JSON and YAML number leaves retain the original
source token (`1e2`, `-0`, excess-precision decimals) rather than a
normalized JavaScript number, so a derivative byte comparison can match the
admitted original. YAML mappings require string scalar keys so distinct source
keys cannot collapse into one JSON Pointer token. YAML duplicate keys,
non-string or complex keys, merge keys (`<<`), aliases, and explicit tags are
outside the supported deterministic subset and stop extraction.

Notebook locators include the cell ID, zero-based cell ordinal, source or
output part, output ordinal when applicable, and a byte range within that
part. DocsFab checks the cell ID against the ordinal during independent replay.
Duplicate cell IDs stop extraction. Output locators identify retained output
from the supplied notebook file. They do not prove that DocsFab ran the cell or
that the output is current.

## Local Reference Closure

`extractStructuredSourceSet` asynchronously receives a finite list of already
admitted source bytes and one or more entry paths. It follows `$ref` values only
when the target is another supplied JSON or YAML source. Every reached source
receives its own original digest, derivative, representation, and locator map.

The closure rejects these conditions:

- A target file or JSON Pointer is missing.
- A reference resolves outside the repository-relative source set.
- A reference uses a URL, URI scheme, or protocol-relative form.
- The reached reference graph contains a cycle.
- The source, aggregate byte, reference count, or depth limit is exceeded.

Unreferenced supplied files remain inert. The helper performs no filesystem or
network operation, and it does not add a source store.

## Installed Tracked-Source Route

The default tracked-source registry installs the four structured adapters
alongside the HTML, PDF, DOCX, and unified diff adapters. The fixed classifier
admits `.json`, `.yaml`, `.yml`, `.ipynb`, `.js`, `.ts`, `.toml`, and `.txt` in
addition to the HTML, PDF, DOCX, `.diff`, and `.patch` extensions;
`SOURCE_MEDIA_TYPE_BY_EXTENSION` in `src/inputs/source-extractor-registry.ts`
is the full list. It never sniffs content or guesses an unlisted extension. A `create-documentation --source <path>` run
reads the selected file from the immutable repository export, seals its
observation and source binding, attaches that binding to the admitted run, and
exposes its spans only through the source inventory and reader tools.

Each ordinary `--source` selection is extracted independently. That route does
not search for sibling files or claim to validate a cross-file `$ref` graph.
The bounded local-reference contract above applies when a host explicitly
supplies the complete source set to `extractStructuredSourceSet`.

## Evidence Use

The source reader accepts only observation, representation, and span IDs from
the sealed binding, or a byte-offset window of whole spans of one of its
representations. A successful read creates a same-step span access record.
A citation is valid only when its binding, representation, span, step, and
access record match.

`docsfab_list_sources` discloses identity and position, including the complete
RFC 6901 pointer for every `json-pointer` span. That pointer is the key
skeleton of the admitted original. Listing records no span-access observation;
only `docsfab_read_source` does. Operators and skills must treat inventory
pointers as locators, not as a substitute for a recorded read.

Knowledge consumers import `projectStructuredEvidenceSource` and
`verifyStructuredQuotation` from `packages/knowledge/src/structured-evidence.mjs`
after decoding the portable source records. The projection preserves every
structured locator, labels notebook outputs as `historical-notebook-output`,
and can independently compare text, JSON, and notebook quotations with
digest-bound original bytes. It does not import runtime code or mint access
authority. The packed CLI knowledge-provider copy list lives in runtime
packaging scripts outside this Task Path, so this helper is consumed from the
knowledge package source and its tests rather than that packed closure.

The current source producer and execution host remain responsible for source
registration, current access checks, disclosure limits, workflow admission,
and final evidence storage. A representation digest proves integrity, not
authority or semantic correctness of a claim.
