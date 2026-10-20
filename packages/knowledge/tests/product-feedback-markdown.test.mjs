// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {assertProductFeedbackParagraph,productFeedbackParagraphRange,productFeedbackControlledRange,productFeedbackClaimSpanRange,selectProductFeedbackMarkdownSection} from "../src/product-feedback-markdown.mjs";

const actual=[
  ["planning/product-requirements.md",null,"This Product Requirements Document (PRD) is a maintained human-readable","DocsFab Product Requirements Document"],
  ["planning/software-requirements.md",null,"This Software Requirements Document (SRD) projects the current Product","DocsFab Software Requirements Document"],
  ["planning/plan-of-record.md",null,"This Plan of Record (POR) is the maintained delivery projection of the Product","DocsFab Plan of Record"],
  ["docs/about/core-concepts/product-knowledge.md",null,"Product knowledge connects claims about a product to their sources, scope,","Product Knowledge in DocsFab"],
  ["docs/about/core-concepts/product-knowledge.md","Evidence, Model, and Projections","Projections remain traceable to a model and evidence boundary.","Evidence, Model, and Projections"],
];
const repository=fileURLToPath(new URL("../../../",import.meta.url));
// Skip only when the whole planning tree is absent, as in the exported tree; a partial tree still runs and fails.
const planningSkip=(base,path)=>!path.startsWith("planning/")||existsSync(join(base,"planning"))?false
  :"repository planning documents are absent from this tree";
test("planning skip covers only an absent planning tree, never an incomplete one or a docs page",()=>{
  const scratch=mkdtempSync(join(tmpdir(),"docsfab-planning-skip-"));
  try{
    assert.equal(planningSkip(scratch,"planning/plan-of-record.md"),"repository planning documents are absent from this tree");
    assert.equal(planningSkip(scratch,"docs/about/index.md"),false);
    mkdirSync(join(scratch,"planning"));
    assert.equal(planningSkip(scratch,"planning/plan-of-record.md"),false);
  }finally{rmSync(scratch,{recursive:true,force:true});}
});
for(const [path,heading,start,title]of actual)test(`actual maintained paragraph retains exact bytes: ${path} / ${heading??"document lead"}`,{skip:planningSkip(repository,path)},()=>{
  const content=readFileSync(new URL("../../../"+path,import.meta.url),"utf8"),lines=content.split("\n");
  const first=lines.findIndex(line=>line.startsWith(start));assert.ok(first>=0);
  let last=first;while(last<lines.length&&lines[last]!=="")last++;
  const before=lines.slice(first,last).join("\n");assert.ok(before.includes("\n"));
  const range=productFeedbackParagraphRange(content,heading,before),section=selectProductFeedbackMarkdownSection(content,heading);
  assert.equal(section.heading,title);assert.equal(section.headingLevel,heading===null?1:2);
  assert.equal(content.slice(range.start,range.end),before+"\n");
  assert.equal(content.slice(0,range.start)+before+"\n"+content.slice(range.end),content,
    "unchanged-byte reproduction is not a semantic proposal or owner decision");
});

test("null root is disjoint from every historical H2 string, including literal leading hashes",()=>{
  const content="# # Exact title\n\nIdentical paragraph.\n\n## # Exact title\n\nIdentical paragraph.\n";
  const root=productFeedbackParagraphRange(content,null,"Identical paragraph."),legacy=productFeedbackParagraphRange(content,"# Exact title","Identical paragraph.");
  assert.ok(root.end<legacy.start);assert.equal(selectProductFeedbackMarkdownSection(content,"# Exact title").headingLevel,2);
  assert.throws(()=>productFeedbackParagraphRange(content,"Exact title","Identical paragraph."));
});

test("paragraphs cannot select lists, quotes, code, HTML, fragments, blank-separated or cross-section text",()=>{
  for(const content of [
    "## Target\n\n- Selected paragraph.\n", "## Target\n\n- Item\n\n  Selected paragraph.\n",
    "## Target\n\n- Item\nSelected paragraph.\n", "## Target\n\n> Selected paragraph.\n",
    "## Target\n\n```text\nSelected paragraph.\n```\n", "## Target\n\n    Selected paragraph.\n",
    "## Target\n\n<!--\nSelected paragraph.\n-->\n", "## Target\n\n<div>\n\nSelected paragraph.\n\n</div>\n",
    "## Target\n\nFirst line.\nSelected paragraph.\n", "## Target\n\n## Elsewhere\n\nSelected paragraph.\n",
  ])assert.throws(()=>productFeedbackParagraphRange(content,"Target","Selected paragraph."),content);
  for(const text of ["One\n\nTwo","One\n## Elsewhere\nTwo","- List","One\n  code","One\r\nTwo","One\n"])
    assert.throws(()=>assertProductFeedbackParagraph(text),text);
  assert.throws(()=>productFeedbackParagraphRange("## Target\n\nSame.\n\nSame.\n","Target","Same."));
  assert.throws(()=>productFeedbackParagraphRange("## Target\n\nSame.\n\n## Target\n\nOther.\n","Target","Same."));
});

test("document lead needs a unique real H1/title and ends before the first child section",()=>{
  for(const content of ["No title.\n", "---\ntitle: First\ntitle: Second\n---\n\nParagraph.\n",
    "# Title\n\nParagraph.\n\n# Title\n", "---\ntitle: Title\n---\n\n# Title\n\nParagraph.\n",
    "# Title\n\n### Child\n\nParagraph.\n"])
    assert.throws(()=>productFeedbackParagraphRange(content,null,"Paragraph."),content);
  for(const encoded of ["Title",'"Title"',"'Title'"]){
    const content=`---\ntitle: ${encoded}\n---\n\nParagraph.\n\n## Child\n\nUntouched.\n`;
    assert.equal(selectProductFeedbackMarkdownSection(content,null).heading,"Title");
    assert.equal(content.slice(...Object.values(productFeedbackParagraphRange(content,null,"Paragraph."))),"Paragraph.\n");
  }
});

test("controlled regions remain scoped, unique, plain and exact after the initial paragraph",()=>{
  const open="<!-- docsfab:claim:CLAIM-ONE:start -->",close="<!-- docsfab:claim:CLAIM-ONE:end -->";
  const region=`${open}\nComplete claim.\n\nScope: all required facts.\n${close}\n`;
  const root=`---\ntitle: Title\n---\n\n${region}\n## Child\n\nUntouched.\n`;
  const selected=productFeedbackControlledRange(root,null,"CLAIM-ONE");assert.equal(root.slice(selected.start,selected.end),region);
  for(const changed of [root+open,root.replace(region,`\n## Child\n\n${region}`),root.replace("Complete claim.","## Other section"),
    root.replace(region,"```md\n"+region+"```\n"),root.replace("Scope: all required facts.","- Hidden list scope")])
    assert.throws(()=>productFeedbackControlledRange(changed,null,"CLAIM-ONE"));
});

test("root and legacy H2 selections cannot cross indented ATX or Setext section boundaries",()=>{
  for(const boundary of ["  ## Child", "Child\n-----", "Child\n=====", "###\tChild", "##", "  #   "]){
    assert.throws(()=>productFeedbackParagraphRange(`# Root\n\nLead.\n\n${boundary}\n\nElsewhere.\n`,null,"Elsewhere."),boundary);
    if(!boundary.startsWith('###'))assert.throws(()=>productFeedbackParagraphRange(`## Target\n\nLead.\n\n${boundary}\n\nElsewhere.\n`,"Target","Elsewhere."),boundary);
  }
  assert.throws(()=>productFeedbackParagraphRange("# Root\n\n  ## Legacy title\n\nParagraph.\n","Legacy title","Paragraph."),"new boundary recognition must not reinterpret previously unmatched string selectors");
  assert.throws(()=>productFeedbackParagraphRange("Legacy title\n------------\n\nParagraph.\n","Legacy title","Paragraph."));
});

function claimSpan(prefix, selected) {
  return {
    kind: "claim-span",
    startByte: Buffer.byteLength(prefix, "utf8"),
    endByte: Buffer.byteLength(prefix + selected, "utf8"),
    beforeText: selected,
  };
}

test("claim spans use UTF-8 input bytes and preserve exact surrounding source", () => {
  const prefix = "Préface 🧭 remains unchanged.";
  const selected = " Café users retry safely. ";
  const suffix = "終わり stays unchanged.";
  const paragraph = prefix + selected + suffix;
  const beforeParagraph = "---\ntitle: Café reference\n---\n\n";
  const afterParagraph = "\n\n## Details\n\nOther evidence stays untouched.\n";
  const content = beforeParagraph + paragraph + afterParagraph;
  const selection = claimSpan(prefix, selected);
  assert.notEqual(selection.startByte, prefix.length);
  const range = productFeedbackClaimSpanRange(content, null, paragraph, selection, "CLAIM-RETRY");

  assert.equal(content.slice(range.start, range.end), selected);
  assert.equal(range.start, beforeParagraph.length + prefix.length);
  assert.equal(range.end, beforeParagraph.length + prefix.length + selected.length);
  assert.equal(range.prefix, prefix);
  assert.equal(range.suffix, suffix);
  assert.equal(content.slice(range.paragraphStart, range.paragraphEnd), paragraph + "\n");

  const replacement = " Café users retry once. ";
  const changed = content.slice(0, range.start) + replacement + content.slice(range.end);
  assert.equal(changed, beforeParagraph + prefix + replacement + suffix + afterParagraph);
  assert.deepEqual(Buffer.from(changed.slice(0, range.start)), Buffer.from(content.slice(0, range.start)));
  assert.deepEqual(Buffer.from(changed.slice(range.start + replacement.length)), Buffer.from(content.slice(range.end)));
});

test("claim spans preserve a selected leading BOM in exact text and source coordinates", () => {
  const prefix = "First.";
  const selected = "\uFEFF Second. ";
  const suffix = "Third.\uFEFF Final sentence.";
  const paragraph = prefix + selected + suffix;
  const lead = "## Target\n\n";
  const content = lead + paragraph + "\n";
  const range = productFeedbackClaimSpanRange(content, "Target", paragraph, claimSpan(prefix, selected));

  assert.equal(range.start, lead.length + prefix.length);
  assert.equal(range.end, lead.length + prefix.length + selected.length);
  assert.equal(content.slice(range.start, range.end), selected);
  assert.equal(range.prefix, prefix);
  assert.equal(range.suffix, suffix);
  const replacement = "\uFEFF Revised sentence. ";
  const changed = content.slice(0, range.start) + replacement + content.slice(range.end);
  assert.equal(changed, lead + prefix + replacement + suffix + "\n");
  assert.deepEqual(Buffer.from(changed.slice(0, range.start)), Buffer.from(content.slice(0, range.start)));
  assert.deepEqual(Buffer.from(changed.slice(range.start + replacement.length)), Buffer.from(content.slice(range.end)));
});

test("claim spans refuse declared text that drops a selected leading BOM", () => {
  const prefix = "First.";
  const selected = "\uFEFF Second. ";
  const paragraph = prefix + selected + "Third.";
  const selection = { ...claimSpan(prefix, selected), beforeText: " Second. " };
  assert.throws(() => productFeedbackClaimSpanRange(`## Target\n\n${paragraph}\n`, "Target", paragraph, selection),
    /ambiguous or unsupported Markdown target/u);
});

test("claim spans keep a suffix-leading BOM inside the selected separator whitespace", () => {
  const prefix = "First.";
  const selected = " Second. ";
  const suffix = "\uFEFFThird.";
  const paragraph = prefix + selected + suffix;
  const lead = "## Target\n\n";
  const content = lead + paragraph + "\n";
  assert.throws(() => productFeedbackClaimSpanRange(content, "Target", paragraph, claimSpan(prefix, selected)),
    /ambiguous or unsupported Markdown target/u);

  const completeSeparator = selected + "\uFEFF";
  const range = productFeedbackClaimSpanRange(content, "Target", paragraph, claimSpan(prefix, completeSeparator));
  assert.equal(content.slice(range.start, range.end), completeSeparator);
  assert.equal(range.start, lead.length + prefix.length);
  assert.equal(range.end, lead.length + prefix.length + completeSeparator.length);
  assert.equal(range.prefix, prefix);
  assert.equal(range.suffix, "Third.");
  const replacement = " Revised sentence. \uFEFF";
  const changed = content.slice(0, range.start) + replacement + content.slice(range.end);
  assert.equal(changed, lead + prefix + replacement + "Third.\n");
  assert.deepEqual(Buffer.from(changed.slice(range.start + replacement.length)), Buffer.from(content.slice(range.end)));
});

test("claim spans select complete first, last or only sentences without consuming the paragraph newline", () => {
  for (const [prefix, selected, suffix] of [
    ["", "First claim changes. ", "Last claim stays."],
    ["First claim stays.", " Last claim changes.", ""],
    ["", "Only claim changes.", ""],
  ]) {
    const paragraph = prefix + selected + suffix;
    const content = `## Target\n\n${paragraph}\n`;
    const range = productFeedbackClaimSpanRange(content, "Target", paragraph, claimSpan(prefix, selected));
    assert.equal(content.slice(range.start, range.end), selected);
    assert.equal(range.prefix, prefix);
    assert.equal(range.suffix, suffix);
    assert.equal(content.slice(range.end), suffix + "\n");
  }
});

test("claim spans require exact text and complete UTF-8 boundaries", () => {
  const prefix = "First stays.";
  const selected = " Café changes. ";
  const paragraph = prefix + selected + "Last stays.";
  const content = `## Target\n\n${paragraph}\n`;
  const valid = claimSpan(prefix, selected);
  const insideAccent = Buffer.byteLength(prefix + " Caf", "utf8") + 1;
  for (const selection of [
    { ...valid, startByte: insideAccent },
    { ...valid, endByte: insideAccent },
    { ...valid, beforeText: " Cafe changes. " },
    { ...valid, startByte: -1 },
    { ...valid, endByte: Buffer.byteLength(paragraph) + 1 },
    { ...valid, startByte: valid.startByte + 0.5 },
    { ...valid, endByte: valid.startByte },
    { ...valid, kind: "paragraph" },
    { ...valid, alternate: true },
  ]) {
    assert.throws(() => productFeedbackClaimSpanRange(content, "Target", paragraph, selection),
      /ambiguous or unsupported Markdown target/u);
  }
});

test("claim spans keep separator whitespace and Markdown constructs indivisible", () => {
  const prefix = "First stays.";
  const selected = " **Changed** claim applies. ";
  const suffix = "Last stays.";
  const paragraph = prefix + selected + suffix;
  const content = `## Target\n\n${paragraph}\n`;
  const valid = claimSpan(prefix, selected);
  assert.equal(content.slice(...Object.values(productFeedbackParagraphRange(content, "Target", paragraph))), paragraph + "\n");
  const range = productFeedbackClaimSpanRange(content, "Target", paragraph, valid);
  assert.equal(content.slice(range.start, range.end), selected);
  for (const selection of [
    claimSpan(prefix + " ", selected.slice(1)),
    claimSpan(prefix, selected.slice(0, -1)),
  ]) assert.throws(() => productFeedbackClaimSpanRange(content, "Target", paragraph, selection));

  const splitParagraph = "First stays. **Changed claim. Extra detail.** Last stays.";
  assert.throws(() => productFeedbackClaimSpanRange(`## Target\n\n${splitParagraph}\n`, "Target",
    splitParagraph, claimSpan(prefix, " **Changed claim. ")));
  const codeParagraph = "First stays. `Changed claim. Extra detail.` Last stays.";
  assert.throws(() => productFeedbackClaimSpanRange(`## Target\n\n${codeParagraph}\n`, "Target",
    codeParagraph, claimSpan(prefix, " `Changed claim. ")));
});

test("claim spans refuse ambiguous paragraph or section selectors and existing controlled claims", () => {
  const paragraph = "This claim changes.";
  const selection = claimSpan("", paragraph);
  for (const content of [
    `## Target\n\n${paragraph}\n\n${paragraph}\n`,
    `## Target\n\n${paragraph}\n\n## Target\n\nDifferent text.\n`,
    `## Target\n\n\`\`\`md\n${paragraph}\n\`\`\`\n`,
  ]) assert.throws(() => productFeedbackClaimSpanRange(content, "Target", paragraph, selection));

  const content = `## Target\n\n${paragraph}\n\n## Other\n\n<!-- docsfab:claim:CLAIM-ONE:start -->\nOther claim.\n<!-- docsfab:claim:CLAIM-ONE:end -->\n`;
  assert.throws(() => productFeedbackClaimSpanRange(content, "Target", paragraph, selection, "CLAIM-ONE"),
    /claim-span conflicts with existing controlled claim region/u);
  assert.equal(content.slice(...Object.values(productFeedbackParagraphRange(content, "Target", paragraph))), paragraph + "\n");
});
