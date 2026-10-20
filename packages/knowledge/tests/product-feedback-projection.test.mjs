// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * v4 projections (#2495): a sealed document takes the decided claim's statement in one marked
 * region, appended under the generated section when the document holds none yet, and rewritten
 * where it stands by every later decision on the same claim.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { materializeProductFeedbackCandidate as materialize, verifyProductFeedbackCandidate as verify,
  productFeedbackTargetRoutePolicySha256, PRODUCT_FEEDBACK_PROJECTION_HEADING as HEADING,
  PRODUCT_REFERENCE_MODEL_TARGET_ID as PACKAGE } from "../src/product-feedback-materializer.mjs";
import { materializerFixture, verificationInput } from "./fixtures/product-feedback-materialization.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
// The fixture's own routed documents, in route order; the first is the one these tests project into.
const FIXTURE_DOCUMENTS = materializerFixture().recipe.targets.map(route => route.path);
const PATH = FIXTURE_DOCUMENTS[0];
const START = "<!-- docsfab:claim:CLAIM-MENTION:start -->", END = "<!-- docsfab:claim:CLAIM-MENTION:end -->";
const FIRST = "In the configured pilot channel, the service may reply to ordinary messages without an explicit mention.";
const count = (text, needle) => text.split(needle).length - 1;
const PRD = "# Product Requirements\n\n| Field | Value |\n| --- | --- |\n| Status | Projection |\n\n## Functional requirements\n\n" +
  "Ordinary channel messages require an explicit mention.\n\n## Change control\n\nDirect edits enter governed intake.\n";

/** One accepted decision routed, deterministically, to the product requirements document as it stands in `document`. */
function projected(document, overrides = {}) {
  // The fixture builds a route for each of its four documents before selecting `target-0`.
  const documents = Object.fromEntries(FIXTURE_DOCUMENTS.map(path => [path, path === PATH ? document : PRD]));
  const input = materializerFixture({ targets: ["target-0"], projectionTargets: [PACKAGE, "target-0"], documents, ...overrides });
  const route = input.recipe.targets[0];
  assert.equal(route.path, PATH);
  route.beforeText = null; route.heading = HEADING; route.baseSha256 = sha(document);
  input.recipe.targetRoutePolicySha256 = productFeedbackTargetRoutePolicySha256(input.recipe.targets.map(({ baseSha256: _b, ...rest }) => rest));
  const output = materialize(input);
  assert.match(verify(verificationInput(input, output)).reproductionSha256, /^[a-f0-9]{64}$/u, "the candidate reproduces");
  return { input, output, text: output.files[PATH] };
}

test("a document with no region takes the decision under a generated section at its end, every existing byte kept", () => {
  const { text, output } = projected(PRD);
  assert.equal(output.manifest.materializerVersion, "docsfab-product-feedback-materializer.v4");
  assert.ok(text.startsWith(PRD), "the document's own bytes stand ahead of the projection");
  assert.equal(text.slice(PRD.length), `\n## ${HEADING}\n\n` +
    "DocsFab writes each accepted product reference model decision here, as the statement the model records for its claim. " +
    "A later decision on the same claim rewrites its entry in place; change the model, not this text.\n\n" +
    `${START}\n${FIRST}\n\n_Model claim \`CLAIM-MENTION\` in \`EXAMPLE\` v0.2. Scope: surface: configured-pilot-channel._\n${END}\n`);
  // A document without a final newline is separated by a blank line all the same.
  assert.ok(projected(PRD.trimEnd()).text.startsWith(`${PRD.trimEnd()}\n\n## ${HEADING}\n\n`));
});

test("a later decision on the same claim replaces its region in place, and re-applying a decision leaves the bytes unchanged", () => {
  const first = projected(PRD);
  const second = "Ordinary pilot-channel messages get a reply only after an explicit opt-in.";
  const superseded = projected(first.text, { statement: second, successorVersion: "v0.3" }).text;
  assert.equal(count(superseded, START), 1, "the superseding decision is not appended a second time");
  assert.equal(count(superseded, END), 1);
  assert.ok(superseded.includes(`${START}\n${second}\n\n_Model claim \`CLAIM-MENTION\` in \`EXAMPLE\` v0.3.`));
  assert.ok(!superseded.includes(FIRST), "the superseded statement is gone");
  assert.equal(superseded.slice(0, superseded.indexOf(START)), first.text.slice(0, first.text.indexOf(START)),
    "everything ahead of the region, the generated section included, is unchanged");
  // Idempotent: the same decision, same version, applied to its own output changes nothing,
  // and the same input materializes the same bytes.
  assert.equal(projected(first.text).text, first.text);
  assert.deepEqual(materialize(first.input), first.output);
});

test("a second claim joins the existing generated section, ahead of the next section", () => {
  const other = `## ${HEADING}\n\nIntro.\n\n<!-- docsfab:claim:CLAIM-OTHER:start -->\nAnother claim.\n<!-- docsfab:claim:CLAIM-OTHER:end -->\n`;
  const document = `# Plan\n\n${other}\n## Later section\n\nKept.\n`;
  const { text } = projected(document);
  assert.equal(count(text, `## ${HEADING}`), 1, "the generated section is reused, never repeated");
  assert.ok(text.includes(`<!-- docsfab:claim:CLAIM-OTHER:end -->\n\n${START}\n${FIRST}\n`));
  assert.ok(text.endsWith(`${END}\n\n## Later section\n\nKept.\n`), "the next section keeps its bytes after the new region");
});

test("a region a maintainer moved, or edited inside, is rewritten where it stands; a look-alike in a fence is not a region", () => {
  const moved = PRD.replace("Ordinary channel messages require an explicit mention.\n",
    `${START}\nA maintainer's own edit of the projected statement.\n${END}\n`);
  const { text } = projected(moved);
  assert.ok(!text.includes(`## ${HEADING}`), "no generated section is added when the claim already has a region");
  assert.ok(!text.includes("A maintainer's own edit"), "the region is the model's projection, not a second source");
  assert.ok(text.includes(`## Functional requirements\n\n${START}\n${FIRST}\n`), "rewritten in its own section");
  const fenced = `${PRD}\n\`\`\`markdown\n${START}\nAn example.\n${END}\n\`\`\`\n`;
  const example = projected(fenced).text;
  assert.ok(example.startsWith(fenced), "the fenced example is untouched");
  assert.equal(count(example, START), 2, "the projection is appended beside the example, which stays an example");
});

/** The merge receipt's section 12 bullets: the coded notes of what a projection repaired. */
const receiptNotes = output => {
  const receipt = output.changedFiles[output.manifest.model.path.replace(/model\.md$/u, "merge-receipt.md")];
  return receipt.slice(receipt.indexOf("## 12. "), receipt.indexOf("## 13. ")).split("\n").filter(row => row.startsWith("- "));
};
/** Projects the same decision `passes` times, each pass onto the previous output, as successive candidates do. */
function successive(document, passes, overrides = {}) {
  let text = document; const outputs = [];
  for (let pass = 0; pass < passes; pass++) { const result = projected(text, overrides); outputs.push(result); text = result.text; }
  return { text, outputs };
}

test("a statement containing a comment opener projects, replays unchanged, and is superseded in place (#2495 R2)", () => {
  const statement = "Reviewers must flag a stray <!-- comment opener left in a published page.";
  const first = projected(PRD, { statement });
  assert.ok(first.text.includes(`${START}\nReviewers must flag a stray \\<!-- comment opener left in a published page.\n`));
  assert.equal(projected(first.text, { statement }).text, first.text, "re-applying the decision leaves the bytes unchanged");
  const later = projected(first.text, { statement: "Reviewers flag stray comment openers.", successorVersion: "v0.3" }).text;
  assert.equal(count(later, START), 1);
  assert.ok(later.includes(`${START}\nReviewers flag stray comment openers.\n`) && !later.includes("stray \\<!--"));
});

test("an unmatched comment opener ahead of the region, inline or opening a block, neither stalls nor grows the region", () => {
  for (const [why, prefix, note] of [
    ["inline code", "Write `<!--` to start a comment.\n\n", null],
    ["an unclosed comment block", "<!-- a draft note that never closes\n\n", "projection-unclosed-comment-closed"],
  ]) {
    const { text, outputs } = successive(`${prefix}${PRD}`, 3);
    assert.equal(count(text, START), 1, why);
    assert.equal(count(text, `## ${HEADING}`), 1, why);
    assert.equal(outputs[2].text, outputs[1].text, `${why}: a replay changes nothing`);
    assert.deepEqual(receiptNotes(outputs[0].output), note ? [`- Projection \`${PATH}\`: \`${note}\`.`] : ["- None recorded by the materializer."], why);
    assert.deepEqual(receiptNotes(outputs[1].output), ["- None recorded by the materializer."], `${why}: nothing left to repair`);
  }
});

test("a comment block a maintainer leaves open above an existing region does not hide the region from the next decision", () => {
  const first = projected(PRD).text;
  const edited = first.replace(`## ${HEADING}`, `<!-- a maintainer's note that never closes\n\n## ${HEADING}`);
  const { text, outputs } = successive(edited, 2, { statement: "Ordinary messages need a mention.", successorVersion: "v0.3" });
  assert.equal(count(text, START), 1, "the marker row is found under the open comment and replaced in place");
  assert.equal(count(text, `## ${HEADING}`), 1);
  assert.ok(text.includes(`${START}\nOrdinary messages need a mention.\n`) && !text.includes(FIRST));
  assert.deepEqual(receiptNotes(outputs[0].output), ["- None recorded by the materializer."]);
});

test("a statement that begins like a code fence stays prose, so the next decision still finds its region (Greptile)", () => {
  const statement = "~~~ must be treated as literal text.";
  const first = projected(PRD, { statement });
  assert.ok(first.text.includes(`${START}\n\\~~~ must be treated as literal text.\n`), "the leading tilde is escaped");
  assert.equal(projected(first.text, { statement }).text, first.text, "re-applying the decision leaves the bytes unchanged");
  const later = projected(first.text, { statement: "Tildes are literal text.", successorVersion: "v0.3" }).text;
  assert.equal(count(later, START), 1); assert.ok(!later.includes("must be treated as literal text."));
});

test("a region a maintainer indents by up to three spaces is still the claim's region (Greptile)", () => {
  const first = projected(PRD).text;
  const indented = first.replace(START, `  ${START}`).replace(END, `   ${END}`);
  const later = projected(indented, { statement: "Ordinary messages need a mention.", successorVersion: "v0.3" }).text;
  assert.equal(count(later, START), 1, "replaced in place, not appended beside the indented one");
  assert.equal(count(later, `## ${HEADING}`), 1);
  assert.ok(later.includes(`${START}\nOrdinary messages need a mention.\n`) && !later.includes(FIRST));
});

test("a line that opens with backticks but has a backtick in its info string is inline code, not a fence to close", () => {
  const document = `${PRD}\n\`\`\`js\`\`\` is how inline code reads.\n`;
  const { text, outputs } = successive(document, 2);
  assert.ok(text.startsWith(`${document}\n## ${HEADING}\n`), "nothing is added to close a fence that does not exist");
  assert.deepEqual(receiptNotes(outputs[0].output), ["- None recorded by the materializer."]);
  assert.equal(count(text, START), 1); assert.equal(outputs[1].text, text);
});

test("a document that ends inside an open fence is closed once, so three passes leave one region outside the fence", () => {
  const document = `${PRD}\n~~~~sh\nnpm test\n`;
  const { text, outputs } = successive(document, 3);
  assert.equal(count(text, START), 1); assert.equal(count(text, `## ${HEADING}`), 1);
  assert.ok(text.startsWith(`${document}~~~~\n\n## ${HEADING}\n`), "the fence is closed with its own opener, ahead of the section");
  assert.deepEqual(receiptNotes(outputs[0].output), [`- Projection \`${PATH}\`: \`projection-unclosed-fence-closed\`.`]);
  assert.equal(outputs[2].text, outputs[1].text);
});

/** A region shaped exactly as DocsFab writes one: the statement, a blank line and the metadata line. */
const generated = (statement, version = "v0.1") =>
  `${START}\n${statement}\n\n_Model claim \`CLAIM-MENTION\` in \`EXAMPLE\` ${version}. Scope: surface: earlier._\n${END}\n`;

test("reversed, duplicated and unpaired markers normalise to exactly one region, the first, with no review", () => {
  const at = (document, why) => {
    const { text, outputs } = successive(document, 2);
    assert.equal(count(text, START), 1, why); assert.equal(count(text, END), 1, why);
    assert.ok(text.indexOf(START) < text.indexOf(END), `${why}: the region opens before it closes`);
    assert.ok(text.includes(`${START}\n${FIRST}\n`), why);
    assert.deepEqual(receiptNotes(outputs[0].output), [`- Projection \`${PATH}\`: \`projection-markers-normalised\`.`], why);
    assert.equal(Object.hasOwn(outputs[0].output.manifest, "projectionReview"), false, `${why}: only markers and DocsFab's own regions go`);
    assert.equal(outputs[1].text, text, `${why}: the normalised document is stable`);
    return text;
  };
  // Reversed: the end stands before the start, so neither bounds a region; both go and the region is appended.
  const reversed = at(PRD.replace("## Change control", `${END}\nBetween.\n${START}\n\n## Change control`), "reversed");
  assert.ok(reversed.includes("Between.\n") && reversed.indexOf(START) > reversed.indexOf(`## ${HEADING}`), "reversed: appended under the section");
  // Duplicated in two sections: the first region takes the projection where it stands, and the later one goes whole.
  const duplicated = at(PRD.replace("mention.\n\n## Change control", `mention.\n\n${generated("One.")}\n## Change control`)
    .replace("governed intake.\n", `governed intake.\n\n${generated("Two.")}`), "duplicated");
  assert.ok(!duplicated.includes("One.") && !duplicated.includes("Two.") && !duplicated.includes(`## ${HEADING}`));
  assert.ok(duplicated.indexOf("## Functional requirements") < duplicated.indexOf(START) &&
    duplicated.indexOf(START) < duplicated.indexOf("## Change control"), "duplicated: the first region wins, in its own section");
  // Unpaired: a start that never closes, then a region DocsFab wrote, then a lone end.
  at(PRD.replace("## Change control", `${START}\n\n${generated("Kept.")}${END}\n\n## Change control`), "unpaired");
});

test("normalisation that would replace someone's text records the span and leaves the candidate for a human review", () => {
  const review = (output, spans) => {
    assert.deepEqual(output.manifest.projectionReview, { code: "projection-normalisation-needs-review",
      removed: spans.map(text => ({ path: PATH, bytes: Buffer.byteLength(text), sha256: sha(text) })) });
    for (const text of spans) assert.ok(receiptNotes(output).includes(`- Projection \`${PATH}\`: \`projection-normalisation-needs-review\`, ` +
      `removed ${Buffer.byteLength(text)} bytes with SHA-256 \`${sha(text)}\`.`));
    const receipt = output.changedFiles[output.manifest.model.path.replace(/model\.md$/u, "merge-receipt.md")];
    for (const text of spans) assert.ok(!receipt.includes(text.trim().split("\n")[0]), "the receipt records the span, never its text");
  };
  // Far-apart orphans of one claim pair up around two whole sections of someone's text.
  const orphans = PRD.replace("## Functional requirements", `${START}\n\n## Functional requirements`) + `\n${END}\n`;
  const between = orphans.slice(orphans.indexOf(START) + START.length + 1, orphans.indexOf(END));
  assert.ok(between.includes("## Change control"));
  review(projected(orphans).output, [between]);
  // A duplicated later region that holds someone's paragraph.
  const human = "A maintainer's paragraph about mentions.\n";
  const duplicate = PRD.replace("governed intake.\n", `governed intake.\n\n${generated("One.")}\n${START}\n${human}${END}\n`);
  review(projected(duplicate).output, [human]);
  // Positive control: a region DocsFab wrote, replaced by a later decision, needs no review.
  const first = projected(PRD).text;
  assert.equal(Object.hasOwn(projected(first, { statement: "Later.", successorVersion: "v0.3" }).output.manifest, "projectionReview"), false);
});
