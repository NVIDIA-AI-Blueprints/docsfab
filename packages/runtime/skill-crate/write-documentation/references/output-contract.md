# Writer Output Contract

Use this contract only when the runtime requests the governed HTML artifact
ABI. Repository-native create, update, and restructure jobs return their
bounded patch and step evidence instead.

Return three artifacts.

## `document.html`

- Use the selected HTML format.
- Preserve required semantic section IDs.
- Use accessible headings, lists, tables, links, and code markup.
- Do not embed scripts or remote assets.
- Link to `base.css` beside the HTML output.

## `base.css`

- Copy the local stylesheet selected by the approved team profile or run
  configuration beside `document.html`.
- Use `../../../quality/formats/html/base.css` as the default when no other
  stylesheet is selected.
- Do not silently generate or substitute a different stylesheet.
- Include the stylesheet in the enclosing run manifest.

## `writer-metadata.json`

Conform to `../../../quality/schemas/writer-result.schema.json` and include:

- output path;
- source identifiers and locators;
- assumptions;
- unresolved questions;
- claims requiring verification;
- applied review issue IDs; and
- rejected review issue IDs with reasons.
