// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { gatherRepositoryFirstPass } from "../src/first-pass.mjs";
import { parseOrdinaryDocumentationRequest } from "../src/first-pass-support.mjs";
import { KnowledgeStore } from "../src/store.mjs";

const temporaryDirectories = [];
const BEHAVIOR_ONE = "The widget --version command prints the installed version.";
const BEHAVIOR_TWO = "The widget --help command prints the available subcommands.";

test.after(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("first-pass gather quotes README evidence into a candidate snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-first-pass-"));
  temporaryDirectories.push(root);
  const repository = path.join(root, "repo");
  const data = path.join(root, "data");
  await mkdir(path.join(repository, "docs"), { recursive: true });
  await writeFile(
    path.join(repository, "README.md"),
    "# Route one skill\n\nThe router routes one skill over local MCP.\n",
  );
  await writeFile(
    path.join(repository, "docs", "overview.md"),
    "# Overview\n\nOperator-facing routing.\n",
  );

  const result = await gatherRepositoryFirstPass({
    repositoryPath: repository,
    dataDirectory: data,
    revision: "abc123",
    instruction: "Create a get-started page.",
  });

  assert.equal(result.snapshot.kind, "knowledge-accepted-snapshot");
  assert.equal(result.snapshot.status, "candidate");
  assert.equal(result.sourceCount, 2);
  assert.equal(result.snapshot.claims.length, 2);
  assert.match(result.snapshot.claims[0].statement, /Route one skill/);
  assert.match(result.snapshot.claims[1].statement, /Overview/);
  assert.equal(result.snapshot.claims[0].kind, "behavior");
  assert.equal(result.snapshot.sources[0].locator.startsWith("readme:"), true);
  await assertGatheredClaimsRemainUnverified(result, data);
});

test("first-pass gathers plain Markdown from the repository root and nested package roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-first-pass-plain-roots-"));
  temporaryDirectories.push(root);
  const repository = path.join(root, "repo");
  const data = path.join(root, "data");
  await mkdir(path.join(repository, "packages", "widget", "docs"), { recursive: true });
  await mkdir(path.join(repository, "node_modules", "ignored"), { recursive: true });
  await mkdir(path.join(repository, "dist"), { recursive: true });
  await writeFile(path.join(repository, "README.md"), "# Widget\n\n- The widget command reads the local configuration.\n");
  await writeFile(path.join(repository, "getting-started.md"), "# Getting started\n\n- The widget command prints its installed version.\n");
  await writeFile(path.join(repository, "packages", "widget", "README.md"), "# Widget package\n\n- The widget package exposes the collection command.\n");
  await writeFile(path.join(repository, "packages", "widget", "docs", "reference.mdx"), "# Reference\n\n- The collection command lists available entries.\n\n");
  await writeFile(path.join(repository, "node_modules", "ignored", "secret.md"), "- Must not be gathered.\n");
  await writeFile(path.join(repository, "dist", "generated.md"), "- Must not be gathered.\n");
  const result = await gatherRepositoryFirstPass({
    repositoryPath: repository,
    dataDirectory: data,
    revision: "abc123",
    instruction: boundedBehaviorRequest(["The collection command lists available entries."]),
  });
  assert.equal(result.sourceCount, 4);
  assert.deepEqual(result.snapshot.sources.map((source) => source.locator).sort(), [
    "readme:README.md",
    "document:getting-started.md",
    "document:packages/widget/README.md",
    "document:packages/widget/docs/reference.mdx",
  ].sort());
  assert.equal(result.snapshot.claims.some((claim) => claim.statement === "The collection command lists available entries."), true);
  assert.equal(result.snapshot.claims.some((claim) => claim.statement.includes("Must not be gathered")), false);
});

test("first-pass gather still produces a snapshot when the tree has no README", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "knowledge-first-pass-empty-"),
  );
  temporaryDirectories.push(root);
  const repository = path.join(root, "repo");
  const data = path.join(root, "data");
  await mkdir(repository);

  const result = await gatherRepositoryFirstPass({
    repositoryPath: repository,
    dataDirectory: data,
  });

  assert.equal(result.snapshot.status, "candidate");
  assert.equal(result.sourceCount, 1);
  assert.match(result.snapshot.claims[0].statement, /no README/);
  await assertGatheredClaimsRemainUnverified(result, data);
});

test("first-pass gather selects exact requested behavior from eligible Markdown lines", async () => {
  const { data, result } = await gatherFixture({
    readme: `# Widget CLI\n\n- ${BEHAVIOR_ONE}\n- ${BEHAVIOR_TWO}\n`,
    docs: {
      "reference.md": `# Reference\n\n${BEHAVIOR_TWO}\n`,
    },
    instruction: boundedBehaviorRequest([BEHAVIOR_ONE, BEHAVIOR_TWO]),
  });

  const substantive = result.snapshot.claims.filter(
    (claim) => !claim.statement.startsWith("Repository source "),
  );
  assert.deepEqual(
    substantive.map((claim) => claim.statement),
    [BEHAVIOR_ONE, BEHAVIOR_TWO],
  );
  const sourcesById = new Map(result.snapshot.sources.map((source) => [source.id, source]));
  assert.deepEqual(
    substantive[0].evidenceIds.map((id) => sourcesById.get(id)?.locator),
    ["readme:README.md"],
  );
  assert.deepEqual(
    substantive[1].evidenceIds.map((id) => sourcesById.get(id)?.locator),
    ["readme:README.md", "document:docs/reference.md"],
  );
  assert.equal(
    result.snapshot.claims.filter((claim) => claim.statement.startsWith("Repository source "))
      .length,
    2,
  );
  await assertGatheredClaimsRemainUnverified(result, data);
  const events = await readEvents(data);
  assert.equal(events.some((event) => event.type === "model.version-approved"), false);
});

test("first-pass gather mirrors the finite request bounds without treating the request as evidence", async () => {
  const cases = [
    {
      name: "generic prose",
      instruction: "Create a get-started page.",
    },
    {
      name: "unsafe target",
      instruction: boundedBehaviorRequest([BEHAVIOR_ONE], "docs/../escape.md"),
    },
    {
      name: "duplicate statement",
      instruction: boundedBehaviorRequest([BEHAVIOR_ONE, BEHAVIOR_ONE]),
    },
    {
      name: "trailing prose",
      instruction: `${boundedBehaviorRequest([BEHAVIOR_ONE])}\nExplain why it matters.`,
    },
    {
      name: "intent-bearing statement",
      instruction: boundedBehaviorRequest(["The product purpose is documentation automation."]),
      readme: "The product purpose is documentation automation.\n",
    },
    {
      name: "more than 32 statements",
      instruction: boundedBehaviorRequest(
        Array.from({ length: 33 }, (_, index) => `Behavior statement ${index + 1}.`),
      ),
      readme: `${Array.from({ length: 33 }, (_, index) => `Behavior statement ${index + 1}.`).join("\n\n")}\n`,
    },
    {
      name: "statement longer than 240 characters",
      instruction: boundedBehaviorRequest(["x".repeat(241)]),
      readme: `${"x".repeat(241)}\n`,
    },
  ];
  for (const testCase of cases) {
    const { result } = await gatherFixture({
      readme: testCase.readme ?? `${BEHAVIOR_ONE}\n`,
      instruction: testCase.instruction,
    });
    assert.deepEqual(
      result.snapshot.claims.filter(
        (claim) => !claim.statement.startsWith("Repository source "),
      ),
      [],
      testCase.name,
    );
  }
});

test("first-pass gather refuses ambiguous Markdown contexts before trimming", async () => {
  const cases = [
    ["ATX heading", `# ${BEHAVIOR_ONE}\n`],
    ["setext heading", `${BEHAVIOR_ONE}\n---\n`],
    ["backtick fence", `\`\`\`text\n${BEHAVIOR_ONE}\n\`\`\`\n`],
    ["tilde fence", `~~~text\n${BEHAVIOR_ONE}\n~~~\n`],
    ["unclosed fence", `\`\`\`text\n${BEHAVIOR_ONE}\n`],
    ["indented code", `    ${BEHAVIOR_ONE}\n`],
    ["tab-indented code", `\t${BEHAVIOR_ONE}\n`],
    ["blockquote", `> ${BEHAVIOR_ONE}\n`],
    ["blockquote lazy continuation", `> Context\n${BEHAVIOR_ONE}\n`],
    ["HTML comment", `<!-- hidden -->\n${BEHAVIOR_ONE}\n`],
    ["unclosed HTML comment", `<!-- hidden\n${BEHAVIOR_ONE}\n`],
    ["HTML block", `<details>\n${BEHAVIOR_ONE}\n</details>\n`],
    ["unclosed script block", `<script\n\n${BEHAVIOR_ONE}\n`],
    ["list-prefixed unclosed script block", `- <script\n\n${BEHAVIOR_ONE}\n`],
    ["BOM-prefixed unclosed script block", `\uFEFF<script\n\n${BEHAVIOR_ONE}\n`],
    ["unclosed style block", `<style\n\n${BEHAVIOR_ONE}\n`],
    ["unclosed pre block", `<pre\n\n${BEHAVIOR_ONE}\n`],
    ["unclosed textarea block", `<textarea\n\n${BEHAVIOR_ONE}\n`],
    ["unclosed generic HTML block", `<section\n\n${BEHAVIOR_ONE}\n`],
    ["unclosed CDATA block", `<![CDATA[\n\n${BEHAVIOR_ONE}\n`],
    ["unclosed frontmatter", `---\ntitle: ${BEHAVIOR_ONE}\n`],
    ["frontmatter value", `---\ntitle: Example\nclaim: ${BEHAVIOR_ONE}\n---\n`],
    ["BOM-prefixed frontmatter", `\uFEFF---\n\n${BEHAVIOR_ONE}\n\n---\n`],
    ["whitespace frontmatter delimiter", `--- \n\n${BEHAVIOR_ONE}\n\n---\n`],
    ["nested list", `  - ${BEHAVIOR_ONE}\n`],
    ["list lazy continuation", `- Context\n${BEHAVIOR_ONE}\n`],
    ["list item containing a heading", `- # ${BEHAVIOR_ONE}\n`, `# ${BEHAVIOR_ONE}`],
    ["list item containing a blockquote", `- > ${BEHAVIOR_ONE}\n`, `> ${BEHAVIOR_ONE}`],
    ["list item containing an indented line", `-     ${BEHAVIOR_ONE}\n`, `    ${BEHAVIOR_ONE}`],
    ["list item containing a fence", `- \`\`\`${BEHAVIOR_ONE}\n`, `\`\`\`${BEHAVIOR_ONE}`],
  ];
  for (const [name, readme, requested = BEHAVIOR_ONE] of cases) {
    const { result } = await gatherFixture({
      readme,
      instruction: boundedBehaviorRequest([requested]),
    });
    assert.equal(
      result.snapshot.claims.some((claim) => claim.statement === requested),
      false,
      name,
    );
  }
});

test("first-pass gather keeps unsupported README formats wrapper-only", async () => {
  const { result } = await gatherFixture({
    readmeName: "README.rst",
    readme: `${BEHAVIOR_ONE}\n`,
    instruction: boundedBehaviorRequest([BEHAVIOR_ONE]),
  });
  assert.equal(result.snapshot.claims.length, 1);
  assert.match(result.snapshot.claims[0].statement, /^Repository source README\.rst states:/u);
});

test("ordinary documentation requests admit root and nested package Markdown targets", () => {
  const parsed = parseOrdinaryDocumentationRequest({
    workflow: "create-documentation",
    revision: "a".repeat(40),
    instruction:
      "Create packages/widget/docs/guide.md and packages/widget/docs/reference.mdx using packages/widget/README.md as current evidence.",
  });
  assert.deepEqual(parsed.targetPaths, ["packages/widget/docs/guide.md", "packages/widget/docs/reference.mdx"]);
  assert.deepEqual(parsed.dependencyPaths, ["packages/widget/README.md"]);
});

test("ordinary English create without a Markdown token is still an ordinary documentation request", () => {
  const parsed = parseOrdinaryDocumentationRequest({
    workflow: "create-documentation",
    revision: "a".repeat(40),
    instruction: "Create a get-started page.",
  });
  assert.deepEqual(parsed.targetPaths, []);
  assert.equal(parsed.workflow, "create-documentation");
});

test("first-pass gather normalizes NFC and CRLF before exact matching", async () => {
  const composed = "The Café command prints the current status.";
  const decomposed = "The Cafe\u0301 command prints the current status.";
  const { result } = await gatherFixture({
    readme: `# Status\r\n\r\n- ${decomposed}\r\n`,
    instruction: boundedBehaviorRequest([composed]).replace(/\n/gu, "\r\n"),
  });
  assert.equal(result.snapshot.claims.some((claim) => claim.statement === composed), true);

  const duplicate = await gatherFixture({
    readme: `- ${composed}\n`,
    instruction: boundedBehaviorRequest([composed, decomposed]),
  });
  assert.equal(
    duplicate.result.snapshot.claims.some((claim) => claim.statement === composed),
    false,
  );
});

test("first-pass gather preserves source-byte and deterministic discovery limits", async () => {
  const docs = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => {
      const name = `${String(index + 1).padStart(2, "0")}.md`;
      return [name, index === 11 ? `${BEHAVIOR_ONE}\n` : `Source ${index + 1}.\n`];
    }),
  );
  const limited = await gatherFixture({
    readme: "# Widget CLI\n",
    docs,
    instruction: boundedBehaviorRequest([BEHAVIOR_ONE]),
  });
  assert.equal(limited.result.sourceCount, 12);
  assert.equal(
    limited.result.snapshot.claims.some((claim) => claim.statement === BEHAVIOR_ONE),
    false,
  );
  assert.deepEqual(
    limited.result.snapshot.sources.map((source) => source.locator),
    [
      "readme:README.md",
      ...Array.from(
        { length: 11 },
        (_, index) => `document:docs/${String(index + 1).padStart(2, "0")}.md`,
      ),
    ],
  );

  const oversized = await gatherFixture({
    readme: `${BEHAVIOR_ONE}\n${"x".repeat(64 * 1024)}\n`,
    instruction: boundedBehaviorRequest([BEHAVIOR_ONE]),
  });
  assert.equal(oversized.result.sourceCount, 1);
  assert.equal(oversized.result.snapshot.sources[0].locator, "repository:.");
  assert.equal(
    oversized.result.snapshot.claims.some((claim) => claim.statement === BEHAVIOR_ONE),
    false,
  );
});

test("first-pass gather retains README.mdx once ahead of the source cap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-first-pass-readme-mdx-"));
  temporaryDirectories.push(root);
  const repository = path.join(root, "repo");
  await mkdir(repository, { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    await writeFile(
      path.join(repository, `a${String(index).padStart(2, "0")}.md`),
      `# Source ${index}\n\nBehavior ${index}.\n`,
    );
  }
  await writeFile(
    path.join(repository, "README.mdx"),
    "# Product entrypoint\n\nUnique product behavior.\n",
  );

  const mdx = await gatherRepositoryFirstPass({
    repositoryPath: repository,
    dataDirectory: path.join(root, "mdx-data"),
    revision: "abc123",
    instruction: "Create source-grounded documentation.",
  });
  const mdxLocators = mdx.snapshot.sources.map((source) => source.locator);
  assert.equal(mdx.sourceCount, 12);
  assert.equal(mdxLocators.filter((locator) => locator === "readme:README.mdx").length, 1);
  assert.equal(mdxLocators.includes("document:README.mdx"), false);

  await writeFile(path.join(repository, "README.md"), "# Preferred entrypoint\n");
  const markdown = await gatherRepositoryFirstPass({
    repositoryPath: repository,
    dataDirectory: path.join(root, "markdown-data"),
    revision: "abc123",
    instruction: "Create source-grounded documentation.",
  });
  assert.equal(markdown.sourceCount, 12);
  assert.equal(markdown.snapshot.sources[0].locator, "readme:README.md");
});

async function assertGatheredClaimsRemainUnverified(result, dataDirectory) {
  for (const claim of result.snapshot.claims) {
    assert.equal(claim.modelState, "candidate");
    assert.notEqual(claim.behaviorVerification, "verified");
  }

  const store = new KnowledgeStore(dataDirectory);
  await store.initialize();
  const events = store.getEvents();
  assert.equal(
    events.some((event) => event.type === "claim.status-updated"),
    false,
  );
  const claims = Object.values(store.getState().claims);
  assert.equal(claims.length, result.snapshot.claims.length);
  for (const claim of claims) {
    assert.equal(claim.kind, "behavior");
    assert.equal(claim.behaviorVerification, "unverified");
    assert.equal(claim.modelState, "candidate");
  }
}

async function gatherFixture({
  readme,
  instruction,
  docs = {},
  readmeName = "README.md",
}) {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-first-pass-finite-"));
  temporaryDirectories.push(root);
  const repository = path.join(root, "repo");
  const data = path.join(root, "data");
  await mkdir(path.join(repository, "docs"), { recursive: true });
  await writeFile(path.join(repository, readmeName), readme);
  for (const [name, contents] of Object.entries(docs)) {
    await writeFile(path.join(repository, "docs", name), contents);
  }
  const result = await gatherRepositoryFirstPass({
    repositoryPath: repository,
    dataDirectory: data,
    revision: "abc123",
    instruction,
  });
  return { data, repository, result };
}

function boundedBehaviorRequest(statements, targetPath = "docs/get-started.md") {
  return [
    `Write \`${targetPath}\` using only these repository-observed behavior claims:`,
    ...statements.map((statement) => `- ${statement}`),
  ].join("\n");
}

async function readEvents(dataDirectory) {
  const text = await readFile(path.join(dataDirectory, "events.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
