#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic generator for the committed DOCX positive-control fixtures
 * (#838). Re-run after editing this file to refresh the committed binaries:
 *
 *   node test/fixtures/source-evidence/docx/build-fixtures.mjs
 *
 * Both fixtures are minimal, hand-built OOXML packages: enough parts for this
 * adapter's traversal (`word/document.xml`, plus a relationships part and a
 * content-types part so the "external relationship is never fetched" case has
 * something real to ignore). They are not guaranteed to open in Microsoft
 * Word -- styles.xml, numbering.xml, and the theme parts are intentionally
 * omitted because this adapter never reads them.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildZip } from "./zip-builder.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`;

// The external hyperlink target below must never be fetched by the adapter;
// the adapter does not even open this part. It exists so a reviewer can see
// exactly what "denied external resource, never fetched" is being proven
// against in the negative-control test that asserts no network import exists.
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://docs.example.invalid/guide" TargetMode="External"/>
</Relationships>
`;

const NAMESPACES =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function documentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NAMESPACES}><w:body>${body}<w:sectPr/></w:body></w:document>
`;
}

const BASIC_BODY = `
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Release Notes</w:t></w:r></w:p>
  <w:p><w:r><w:t>Unicode café &amp; résumé 日本語 😀</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First bullet item</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second bullet item</w:t></w:r></w:p>
  <w:p><w:r><w:t>See </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>the docs</w:t></w:r></w:hyperlink><w:r><w:t> for more.</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>Row0 Col0</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Row0 Col1</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Row1 Col0</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Row1 Col1</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
`;

// Same overall shape as the basic fixture (one heading, one prose paragraph,
// two list items, one hyperlink paragraph, one 2x2 table) but every string
// and the row/column order differ. A locator computed against this fixture
// must resolve to different text than the same locator against the basic
// fixture; a hardcoded or copy-pasted locator/text pairing fails against this
// file.
const DIVERGENT_BODY = `
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Divergent Notes</w:t></w:r></w:p>
  <w:p><w:r><w:t>A completely different paragraph, no relation to the basic fixture.</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Alpha bullet</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Beta bullet</w:t></w:r></w:p>
  <w:p><w:r><w:t>Consult </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>the archive</w:t></w:r></w:hyperlink><w:r><w:t> instead.</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>Alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Beta</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Gamma</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Delta</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
`;

function buildDocx(bodyXml) {
  return buildZip([
    { name: "[Content_Types].xml", content: CONTENT_TYPES },
    { name: "_rels/.rels", content: ROOT_RELS },
    { name: "word/_rels/document.xml.rels", content: DOCUMENT_RELS },
    { name: "word/document.xml", content: documentXml(bodyXml) },
  ]);
}

const fixtures = {
  "basic-document.docx": buildDocx(BASIC_BODY),
  "divergent-document.docx": buildDocx(DIVERGENT_BODY),
};

for (const [name, bytes] of Object.entries(fixtures)) {
  writeFileSync(join(here, name), bytes);
  console.log(`wrote ${name} (${bytes.length} bytes)`);
}
