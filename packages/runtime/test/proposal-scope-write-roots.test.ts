// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One documentation write rule admits a named page for a local create or
 * update run (#1914). Proposal-scope admission, the sealed scope grammar, and
 * the first-pass destination check share it. Under the default policy,
 * `.docsfab.json` `documentationRoots` only narrow `docs/` and `fern/`
 * (Decision 8, #1594), and pages in other documentation trees point to #1603.
 * A local run may widen to configured documentation directories (owner
 * amendment to Decision 8, option A, #1914 note 72942914). A refused page is
 * named with the rule it breaks, and the live agent recovers the code from the
 * message alone.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  bindFirstRunProposalScope,
  DocumentationRootsOutsideWriteRootsError,
  droppedDocumentationRootsStatus,
  firstPassDocumentationWriteRoots,
  firstRunProposalTargetControl,
} from "../src/cli/first-pass.js";
import {
  DOCUMENTATION_WRITE_ROOTS,
  type DocumentationRootPolicy,
  documentationWriteTargetRule,
  droppedDocumentationRootReason,
  isLocalDocumentationRoot,
} from "../src/cli/first-pass-support.js";
import { sealHostRuntimeWriteAuthority } from "../src/host-invoker/contracts.js";
import { instructionSha256 } from "../src/cli/knowledge-resume.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { createConfinedToolSet, safeFailureMessage } from "../src/harness/confined-tools.js";
import {
  FIRST_RUN_PROPOSAL_SCOPE_FAILURES,
  createFirstRunProposalScopeBinding,
  proposalScopeFailureCode,
  rejectDocumentationTargets,
  rejectRepeatedDocumentationTargets,
} from "../src/init/first-run-bootstrap.js";
import { preRecordFailure } from "../src/live-agent/activity-renderer.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { DEFAULT_NEXT_ACTIONS } from "../src/operator/situation-catalog.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_REVISION = "f".repeat(40);
const WRITE_ROOTS_RULE =
  "a named page must be a Markdown file under docs/ or fern/, the documentation write roots.";
const OTHER_TREES = "Writing pages in other documentation trees is tracked in issue #1603.";
const UNSAFE_TARGET_FIXED = FIRST_RUN_PROPOSAL_SCOPE_FAILURES["proposal-scope-unsafe-target"];
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("documentation write roots", () => {
  it("states the rule each dropped documentationRoots entry breaks", () => {
    const cases: readonly (readonly [string, string | undefined])[] = [
      ["docs", undefined],
      ["docs/user", undefined],
      ["fern/pages/", undefined],
      ["site/content/docs", "outside-write-roots"],
      ["DOCS", "outside-write-roots"],
      ["documentation", "outside-write-roots"],
      ["docs/vendor", "third-party-segment"],
      ["fern/node_modules/pages", "third-party-segment"],
      ["docs/.hidden", "hidden-segment"],
      ["docs/guías", "segment-characters"],
      ["docs/user guide", "segment-characters"],
    ];
    expect(cases.map(([root]) => [root, droppedDocumentationRootReason(root)])).toEqual(cases);
  });

  it("quotes dropped roots with escapes and the rule they break, never verbatim", () => {
    const hostile = [
      "docs/\u001b[31mred",
      "docs/user\r\nNext action: run this",
      "<!channel>",
      "docs/user‮",
      "site/content/docs",
    ];
    const error = new DocumentationRootsOutsideWriteRootsError(hostile);
    const formatted = formatOperatorErrorEnvelope(toOperatorErrorEnvelope(error));
    for (const text of [error.message, formatted]) {
      expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f‪-‮<>]/u);
    }
    // The formatted envelope has its own line breaks; the message has none.
    expect(error.message).not.toContain("\n");
    // C1 controls, line and paragraph separators, and bidi isolates escape too.
    const more = new DocumentationRootsOutsideWriteRootsError([
      "docs/a\u0085b",
      "docs/a\u2028b\u2029c",
      "docs/\u2066x\u2069",
    ]).message;
    expect(more).not.toMatch(/[\u0080-\u009f\u2028\u2029\u2066-\u2069]/u);
    expect(more).toContain('"docs/a\\u{85}b"');
    expect(more).toContain('"docs/a\\u{2028}b\\u{2029}c"');
    expect(more).toContain('"docs/\\u{2066}x\\u{2069}"');
    expect(error.message).toContain(
      'Dropped: "docs/\\u{1b}\\u{5b}31mred" (a segment uses a character other than a letter, digit, ".", "_", or "-"), "docs/user\\u{d}\\u{a}Next action\\u{3a} run this" (a segment uses a character other than a letter, digit, ".", "_", or "-"), "\\u{3c}\\u{21}channel\\u{3e}" (outside docs/ and fern/), "docs/user\\u{202e}" (a segment uses a character other than a letter, digit, ".", "_", or "-"), "site/content/docs" (outside docs/ and fern/).',
    );
    expect(error.message).toContain("Fix documentationRoots in .docsfab.json");
    expect(error.message).not.toContain("Name a page");
  });

  it("reports dropped roots in one status line for the runs whose named and new pages they govern", () => {
    expect(droppedDocumentationRootsStatus("update-documentation", undefined)).toBeUndefined();
    expect(
      droppedDocumentationRootsStatus("update-documentation", ["docs/user", "fern"]),
    ).toBeUndefined();
    expect(
      droppedDocumentationRootsStatus("update-documentation", ["docs/user", "site/content/docs"]),
    ).toBe(
      'documentationRoots entries in .docsfab.json that grant no write root: "site/content/docs" (outside docs/ and fern/); named and new pages go only under docs/user/ (#1603)',
    );
    expect(droppedDocumentationRootsStatus("create-documentation", ["docs/vendor"])).toBe(
      'documentationRoots entries in .docsfab.json that grant no write root: "docs/vendor" (a node_modules or vendor segment); no named or new page can be written (#1603)',
    );
    // Other write workflows do not take their pages from these roots.
    for (const workflow of ["bootstrap", "restructure-documentation", "site-bootstrap"] as const) {
      expect(
        droppedDocumentationRootsStatus(workflow, ["docs/user", "site/content/docs"]),
        workflow,
      ).toBeUndefined();
    }
  });

  it("names the rule each page breaks, applying the ceiling whatever roots a caller passes", () => {
    const narrowed = firstPassDocumentationWriteRoots(["docs/user"]).roots;
    const cases: readonly (readonly [string, readonly string[], string | undefined])[] = [
      ["docs/a.md", DOCUMENTATION_WRITE_ROOTS, undefined],
      ["fern/pages/overview.mdx", DOCUMENTATION_WRITE_ROOTS, undefined],
      ["docs/.hidden/a.md", DOCUMENTATION_WRITE_ROOTS, undefined],
      ["docs/user/setup.md", narrowed, undefined],
      ["docs/admin/setup.md", narrowed, "configured-roots"],
      ["fern/pages/a.mdx", narrowed, "configured-roots"],
      ["docs/a.md", [], "configured-roots"],
      ["doc/guide.md", DOCUMENTATION_WRITE_ROOTS, "write-roots"],
      ["documentation/guide.md", DOCUMENTATION_WRITE_ROOTS, "write-roots"],
      ["site/content/en/docs/setup.md", DOCUMENTATION_WRITE_ROOTS, "write-roots"],
      ["website/docs/intro.md", DOCUMENTATION_WRITE_ROOTS, "write-roots"],
      ["README.md", DOCUMENTATION_WRITE_ROOTS, "write-roots"],
      ["overview.mdx", DOCUMENTATION_WRITE_ROOTS, "write-roots"],
      ["src/docs/guide.md", DOCUMENTATION_WRITE_ROOTS, "write-roots"],
      // A caller-supplied root outside docs/ and fern/ grants nothing.
      ["site/content/en/docs/setup.md", ["site/content/en/docs/"], "write-roots"],
      ["docs/vendor/a.md", DOCUMENTATION_WRITE_ROOTS, "protected-path"],
      ["docs/node_modules/a.md", DOCUMENTATION_WRITE_ROOTS, "protected-path"],
      ["fern/.github/a.md", DOCUMENTATION_WRITE_ROOTS, "protected-path"],
      ["docs/.gitlab-ci.yml/a.md", DOCUMENTATION_WRITE_ROOTS, "protected-path"],
      ["../docs/a.md", DOCUMENTATION_WRITE_ROOTS, "page-path"],
      ["docs/../src/a.md", DOCUMENTATION_WRITE_ROOTS, "page-path"],
      ["docs/./a.md", DOCUMENTATION_WRITE_ROOTS, "page-path"],
      ["/docs/a.md", DOCUMENTATION_WRITE_ROOTS, "page-path"],
      ["docs\\a.md", DOCUMENTATION_WRITE_ROOTS, "page-path"],
      ["C:/docs/a.md", DOCUMENTATION_WRITE_ROOTS, "page-path"],
      ["docs/a.txt", DOCUMENTATION_WRITE_ROOTS, "page-path"],
    ];
    expect(
      cases.map(([path, roots]) => [
        path,
        roots.join(","),
        documentationWriteTargetRule(path, roots),
      ]),
    ).toEqual(cases.map(([path, roots, rule]) => [path, roots.join(","), rule]));
  });

  it("keeps the sealed scope grammar on the page shape every write root shares", () => {
    expect(
      seal(["docs/a.md", "fern/pages/b.mdx", "site/content/en/docs/c.md", ".docsfab.json"])
        .targetPaths,
    ).toEqual([".docsfab.json", "docs/a.md", "fern/pages/b.mdx", "site/content/en/docs/c.md"]);
    // A file root's own page: a tracked file documentationRoots lists, outside
    // any documentation directory.
    expect(seal(["README.md", "tests/bats/README.md"]).targetPaths).toEqual([
      "README.md",
      "tests/bats/README.md",
    ]);
    for (const path of [
      "docs/vendor/a.md",
      "site/content/node_modules/a.md",
      "site/.hidden/a.md",
      "src/a.md",
      "/docs/a.md",
      "docs/../a.md",
      "AGENTS.md",
      "site/content/hugo.toml",
    ]) {
      expect(() => seal([path]), path).toThrowError(
        expect.objectContaining({ code: "proposal-scope-input-invalid" }),
      );
    }
  });
});

describe("proposal-scope admission through the installed request parser", () => {
  it("binds docs/ and fern/ pages unchanged, and pages inside configured roots", async () => {
    await expect(admit("Update docs/a.md and fern/pages/b.mdx.")).resolves.toMatchObject({
      targetPaths: ["docs/a.md", "fern/pages/b.mdx"],
    });
    await expect(admit("Update docs/user/setup.md.", ["docs/user"])).resolves.toMatchObject({
      targetPaths: ["docs/user/setup.md"],
    });
  });

  it.each([
    [
      "a Hugo page outside every documentation directory (Dalec)",
      "Update website/content/guides/build.md to describe the new flag.",
      undefined,
      `DocsFab cannot write website/content/guides/build.md: ${WRITE_ROOTS_RULE} ${OTHER_TREES}`,
    ],
    [
      "a Docusaurus page",
      "Update website/docs/intro.md to describe the new flag.",
      undefined,
      `DocsFab cannot write website/docs/intro.md: ${WRITE_ROOTS_RULE} ${OTHER_TREES}`,
    ],
    [
      "an example README (NeMo Agent Toolkit)",
      "Update examples/agents/README.md to describe the new flag.",
      ["docs"],
      `DocsFab cannot write examples/agents/README.md: ${WRITE_ROOTS_RULE} ${OTHER_TREES}`,
    ],
    [
      "bare names after a directory prefix (Dynamo)",
      "Update five pages under docs/fern/pages/guides/: overview.mdx and install.mdx.",
      undefined,
      `DocsFab cannot write install.mdx and overview.mdx: ${WRITE_ROOTS_RULE} ${OTHER_TREES}`,
    ],
    [
      "a source page",
      "Update src/guide.md to describe the new flag.",
      undefined,
      `DocsFab cannot write src/guide.md: ${WRITE_ROOTS_RULE} ${OTHER_TREES}`,
    ],
    [
      "an absolute path, which the request grammar reads as relative",
      "Update /etc/guide.md to describe the new flag.",
      undefined,
      `DocsFab cannot write etc/guide.md: ${WRITE_ROOTS_RULE} ${OTHER_TREES}`,
    ],
    [
      "a page outside the narrowed roots",
      "Update docs/admin/setup.md to describe the new flag.",
      ["docs/user", "fern"],
      "DocsFab cannot write docs/admin/setup.md: a named page must be under docs/user/ and fern/, the documentationRoots in .docsfab.json inside docs/ or fern/.",
    ],
    [
      "a page in a protected directory",
      "Update docs/vendor/nvidia.md to describe the new flag.",
      undefined,
      "DocsFab cannot write docs/vendor/nvidia.md: a named page cannot be in a protected, source, or CI path.",
    ],
    [
      "pages that break different rules",
      "Update doc/a.md, docs/vendor/b.md, and docs/c.md.",
      undefined,
      `DocsFab cannot write doc/a.md: ${WRITE_ROOTS_RULE} DocsFab cannot write docs/vendor/b.md: a named page cannot be in a protected, source, or CI path. ${OTHER_TREES}`,
    ],
  ] as const)("refuses %s by name, with its rule", async (_label, instruction, roots, message) => {
    const error = await admit(instruction, roots).then(
      (scope) => expect.fail(`admitted ${JSON.stringify(scope?.targetPaths)}`),
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      name: "FirstRunProposalScopeError",
      code: "proposal-scope-unsafe-target",
      phase: "proposal-scope-admission",
      noWorkPerformed: true,
      instructionSha256: instructionSha256(instruction),
      repositoryRevision: REPOSITORY_REVISION,
    });
    expect((error as Error).message).toBe(message);
    // The live agent keeps only the message and still recovers the code.
    expect(proposalScopeFailureCode(message)).toBe("proposal-scope-unsafe-target");
  });

  it("refuses every named page with the configuration refusal when documentationRoots narrow to nothing", async () => {
    // The Kueue layout: the configured Hugo root grants nothing, so no page,
    // in that tree or under docs/, can be written until the file is fixed.
    const expected = new DocumentationRootsOutsideWriteRootsError(["site/content/en/docs"]);
    for (const instruction of [
      "Update site/content/en/docs/setup.md to describe the new flag.",
      "Update docs/a.md to describe the new flag.",
    ]) {
      const error = await admit(instruction, ["site/content/en/docs"]).then(
        (scope) => expect.fail(`${instruction} admitted ${JSON.stringify(scope?.targetPaths)}`),
        (caught: unknown) => caught,
      );
      expect(error, instruction).toBeInstanceOf(DocumentationRootsOutsideWriteRootsError);
      expect(error, instruction).toMatchObject({
        code: "documentation-roots-outside-write-roots",
        message: expected.message,
        nextAction: DEFAULT_NEXT_ACTIONS["documentation-roots-outside-write-roots"],
      });
    }
    expect(expected.message).toContain('"site/content/en/docs" (outside docs/ and fern/)');
    expect(expected.message).toContain("#1603");
  });

  // Owner decision on #1914 (note 72956288).
  it("binds a page once when every mention asks to change it", async () => {
    for (const [instruction, targetPaths] of [
      ["Update docs/a.md, docs/a.md, and docs/b.md.", ["docs/a.md", "docs/b.md"]],
      ["Update docs/b.md, docs/a.md, docs/b.md, and docs/a.md.", ["docs/a.md", "docs/b.md"]],
      [
        "Update docs/install.md to add the --verbose flag. In docs/install.md, also fix the broken link.",
        ["docs/install.md"],
      ],
    ] as const) {
      await expect(admit(instruction), instruction).resolves.toMatchObject({ targetPaths });
    }
  });

  it("binds a page that is also a --source selection once", async () => {
    const instruction =
      "Update docs/install.md to add the --verbose flag. In docs/install.md, also fix the broken link.";
    const scope = await bindFirstRunProposalScope({
      request: { ...createRequest(instruction), sourcePaths: ["docs/install.md"] },
      config: stubConfig(await temporaryDirectory("docsfab-scope-roots-")),
      revision: REPOSITORY_REVISION,
    });
    expect(scope?.targetPaths).toEqual(["docs/install.md"]);
  });

  it("refuses a repeated page by name when a mention excludes it or is unclear", async () => {
    for (const [instruction, message] of [
      // Binding once would also bind docs/b.md, which the request leaves alone.
      [
        "Update docs/a.md to match src/a.mjs. Leave docs/b.md and docs/a.md alone.",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      [
        "Update docs/a.md to describe the new flag. Do not make changes to docs/a.md.",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      [
        "Update docs/a.md and docs/b.md, except docs/a.md.",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      [
        "Update docs/a.md to describe the new flag. Don't touch docs/a.md.",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      // A mention that keeps or reads the page is named the same way.
      [
        "Update docs/a.md to describe the new flag. Leave docs/a.md unchanged.",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      [
        "Update docs/a.md to describe the new flag. Do not change docs/a.md.",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      // DocsFab cannot tell whether these mentions ask for a change.
      [
        "Update docs/a.md and docs/b.md to match src/a.mjs. Target file: docs/a.md.",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      [
        "Update docs/b.md, docs/a.md, and docs/b.md. What about docs/a.md?",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      // The !1577 review: emphasis, unlisted words, and a question mark no
      // longer read as a change request.
      [
        "Update docs/b.md, _not_ docs/a.md. Update docs/c.md, _not_ docs/a.md either.",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      [
        "Update docs/b.md in lieu of docs/a.md. Update docs/c.md, sans docs/a.md.",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
      [
        "Update docs/a.md to add the flag. Update docs/a.md?",
        "The documentation output list names the same target more than once: docs/a.md. DocsFab does not guess which mention of a repeated page sets its scope.",
      ],
    ] as const) {
      const error = await admit(instruction).then(
        (scope) => expect.fail(`${instruction} bound ${JSON.stringify(scope?.targetPaths)}`),
        (caught: unknown) => caught,
      );
      expect(error, instruction).toMatchObject({
        code: "proposal-scope-duplicate-targets",
        message,
        instructionSha256: instructionSha256(instruction),
      });
      expect(proposalScopeFailureCode(message)).toBe("proposal-scope-duplicate-targets");
    }
  });

  // The !1577 review, round two (B1): a page named once binds as it did before
  // option C, in a local run too. Excluding such a page precisely is #1935.
  it("binds a page named once as it did before option C", async () => {
    for (const [instruction, targetPaths] of [
      ["Update the nav bar in docs/a.md.", ["docs/a.md"]],
      ["Update the Save button in docs/a.md.", ["docs/a.md"]],
      ["Update the command that does not work in docs/install.md.", ["docs/install.md"]],
      [
        "Update docs/install.md to say ARM is not supported, and docs/faq.md too.",
        ["docs/faq.md", "docs/install.md"],
      ],
      [
        "Update the Save button in docs/ui.md to match docs/style.md.",
        ["docs/style.md", "docs/ui.md"],
      ],
      // The workflow guide's example: an exclusion of a page named once is not read yet.
      ["Update docs/b.md, but not docs/a.md.", ["docs/a.md", "docs/b.md"]],
    ] as const) {
      await expect(admit(instruction), instruction).resolves.toMatchObject({ targetPaths });
    }
    await expect(
      admitLocal("Update the nav bar in site/content/a.md.", ["site/content"]),
    ).resolves.toMatchObject({ targetPaths: ["site/content/a.md"] });
  });

  it("refuses traversal and absolute targets without echoing them", async () => {
    await expect(
      admit("Update docs/a.md, docs/../unsafe.md, and docs/b.md."),
    ).rejects.toMatchObject({ code: "proposal-scope-unsafe-target", message: UNSAFE_TARGET_FIXED });
    // A provider that returned an absolute or traversal target is refused the
    // same way, and a page beside it is not named alone.
    for (const targetPaths of [
      ["/docs/a.md"],
      ["docs/../src/a.md"],
      ["docs/a.md", "C:/docs/b.md"],
      ["doc/a.md", "/docs/b.md"],
    ]) {
      await expect(
        admitParsed("Update docs/a.md.", targetPaths),
        targetPaths.join(" "),
      ).rejects.toMatchObject({
        code: "proposal-scope-unsafe-target",
        message: UNSAFE_TARGET_FIXED,
      });
    }
  });

  it("renders the refused page, the rule, and the catalog next action in the operator envelope", async () => {
    const error = await admit("Update website/docs/intro.md to describe the new flag.").catch(
      (caught: unknown) => caught,
    );
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope).toMatchObject({
      code: "proposal-scope-unsafe-target",
      message: `DocsFab cannot write website/docs/intro.md: ${WRITE_ROOTS_RULE} ${OTHER_TREES}`,
      failure: { class: "planning-refusal", code: "proposal-scope-unsafe-target" },
      nextAction: DEFAULT_NEXT_ACTIONS["proposal-scope-unsafe-target"],
    });
    const formatted = formatOperatorErrorEnvelope(envelope);
    expect(formatted).toContain("website/docs/intro.md");
    expect(formatted).toContain("code: proposal-scope-unsafe-target");
    expect(formatted).toContain("#1603");
  });
});

// Owner amendment to Decision 8, option A (#1914 note 72942914): a local run
// may widen the write roots to configured documentation directories, Markdown
// and MDX only. Hosted runs stay narrow until #1603.
const LOCAL_WRITE_ROOTS_RULE =
  "a named page must be a Markdown file under docs/ or fern/, the default documentation write roots.";
const LIST_IT =
  "To write pages in another documentation directory, list it in documentationRoots in .docsfab.json.";
const LOCAL_PROTECTED =
  "a named page cannot be in a protected, hidden, code, or CI path, or be an agent instruction file such as AGENTS.md.";

describe("local runs widen to configured documentation directories", () => {
  it("runs the shared local documentation-root table and the knowledge provider's literal", async () => {
    const table = JSON.parse(
      await readFile(
        resolve(
          runtimeRoot,
          "..",
          "knowledge",
          "tests",
          "fixtures",
          "local-documentation-roots.json",
        ),
        "utf8",
      ),
    ) as { cases: { root: string; admitted: boolean }[] };
    expect(
      table.cases.filter(({ root, admitted }) => isLocalDocumentationRoot(root) !== admitted),
    ).toEqual([]);
    const declaration = (text: string) =>
      /const LOCAL_DOCUMENTATION_ROOT =\s*(\/\^\S+\/iu);/u.exec(text)?.[1];
    const provider = declaration(
      await readFile(
        resolve(runtimeRoot, "..", "knowledge", "src", "first-pass", "parse.mjs"),
        "utf8",
      ),
    );
    expect(provider, "the knowledge provider declares LOCAL_DOCUMENTATION_ROOT").toBeDefined();
    expect(
      declaration(
        await readFile(resolve(runtimeRoot, "src", "cli", "first-pass-support.ts"), "utf8"),
      ),
      "the runtime and knowledge LOCAL_DOCUMENTATION_ROOT literals differ",
    ).toBe(provider);
  });

  it("widens roots only under the local policy, and keeps the default narrow", () => {
    const configured = [
      "site/content/en/docs",
      "website/docs",
      "examples/agents",
      "src/docs",
      ".github/docs",
      "site/node_modules",
    ];
    expect(firstPassDocumentationWriteRoots(configured, "local-widen")).toEqual({
      roots: ["examples/agents/", "site/content/en/docs/", "website/docs/"],
      dropped: ["src/docs", ".github/docs", "site/node_modules"],
    });
    // Hosted runs, and every caller that does not opt in, stay narrow.
    expect(firstPassDocumentationWriteRoots(configured)).toEqual({
      roots: [],
      dropped: configured,
    });
    expect(
      droppedDocumentationRootsStatus(
        "create-documentation",
        ["site/content/en/docs", "src/docs"],
        "local-widen",
      ),
    ).toBe(
      'documentationRoots entries in .docsfab.json that grant no write root: "src/docs" (a code directory); named and new pages go only under site/content/en/docs/',
    );
    const reasons: readonly (readonly [string, string | undefined])[] = [
      ["site/content", undefined],
      ["src/docs", "code-directory"],
      ["packages/web/src/docs", "code-directory"],
      // The !1577 review: a bare packages/, and test, build, and skill trees.
      ["packages", "code-directory"],
      ["Packages/", "code-directory"],
      ["tests/docs", "code-directory"],
      ["cmd", "code-directory"],
      ["packages/knowledge/skills", "code-directory"],
      ["packages/runtime", undefined],
      ["\u{17f}ite/content", "segment-characters"],
      [".github/docs", "hidden-segment"],
      ["site/node_modules", "third-party-segment"],
      ["Vendor/docs", "third-party-segment"],
      ["docs/a b", "segment-characters"],
    ];
    expect(
      reasons.map(([root]) => [root, droppedDocumentationRootReason(root, "local-widen")]),
    ).toEqual(reasons);
  });

  it("names the rule each page breaks under local widening", () => {
    const { roots } = firstPassDocumentationWriteRoots(
      ["site/content", "website/docs", "examples/agents"],
      "local-widen",
    );
    const cases: readonly (readonly [string, string | undefined])[] = [
      ["site/content/en/docs/setup.md", undefined],
      ["site/content/_index.md", undefined],
      ["website/docs/intro.mdx", undefined],
      ["examples/agents/README.md", undefined],
      ["docs/a.md", "configured-roots"],
      ["src/docs/x.md", "configured-roots"],
      ["site/content/node_modules/x.md", "protected-path"],
      ["site/content/.hidden/x.md", "protected-path"],
      ["site/content/Vendor/x.md", "protected-path"],
      ["site/content/hugo.toml", "page-path"],
      ["site/content/../src/x.md", "page-path"],
      ["/site/content/x.md", "page-path"],
    ];
    expect(
      cases.map(([path]) => [path, documentationWriteTargetRule(path, roots, "local-widen")]),
    ).toEqual(cases);
    // Without configured roots a local run writes under docs/ and fern/ only.
    expect(
      documentationWriteTargetRule("site/content/x.md", DOCUMENTATION_WRITE_ROOTS, "local-widen"),
    ).toBe("write-roots");
  });

  // The !1577 review: agent instruction files and code trees are never pages
  // under a widened root, whatever the configured root admits.
  it("refuses agent instruction files and code trees under a widened root", () => {
    const { roots } = firstPassDocumentationWriteRoots(
      ["site/content", "examples/agents", "packages/runtime"],
      "local-widen",
    );
    expect(roots).toEqual(["examples/agents/", "packages/runtime/", "site/content/"]);
    const cases: readonly (readonly [string, string | undefined])[] = [
      ["site/content/AGENTS.md", "protected-path"],
      ["site/content/en/agents.md", "protected-path"],
      ["site/content/CLAUDE.md", "protected-path"],
      ["site/content/Claude.mdx", "protected-path"],
      ["examples/agents/GEMINI.md", "protected-path"],
      ["examples/agents/COPILOT-INSTRUCTIONS.md", "protected-path"],
      ["examples/agents/tools/SKILL.md", "protected-path"],
      // Variants that agents also load (the !1577 review, round two).
      ["site/content/AGENT.md", "protected-path"],
      ["site/content/agents.override.md", "protected-path"],
      ["site/content/CLAUDE.local.md", "protected-path"],
      ["site/content/gemini.md", "protected-path"],
      ["packages/runtime/AGENTS.md", "protected-path"],
      ["packages/runtime/test/fixtures/x.md", "protected-path"],
      ["packages/runtime/TESTS/x.md", "protected-path"],
      ["packages/runtime/skills/foo/references/x.md", "protected-path"],
      ["packages/runtime/src/x.md", "protected-path"],
      // Pages whose names only resemble those files stay pages.
      ["site/content/agents-overview.md", undefined],
      ["site/content/agents-page.md", undefined],
      ["site/content/subagent.md", undefined],
      ["site/content/claude-local.md", undefined],
      ["examples/agents/README.md", undefined],
      ["packages/runtime/README.md", undefined],
      ["packages/runtime/docs/setup.md", undefined],
    ];
    expect(
      cases.map(([path]) => [path, documentationWriteTargetRule(path, roots, "local-widen")]),
    ).toEqual(cases);
    // A bare packages/ grants nothing, so it cannot reach a package's files.
    expect(firstPassDocumentationWriteRoots(["packages"], "local-widen")).toEqual({
      roots: [],
      dropped: ["packages"],
    });
    // docs/ and fern/ keep their classifier rule, which admits docs/AGENTS.md
    // as before (#1936).
    expect(documentationWriteTargetRule("docs/AGENTS.md")).toBeUndefined();
    expect(
      documentationWriteTargetRule("docs/AGENTS.md", DOCUMENTATION_WRITE_ROOTS, "local-widen"),
    ).toBeUndefined();
  });

  it("admits named pages under configured documentation directories in a local run", async () => {
    for (const [instruction, roots, targetPaths] of [
      // Kueue: Hugo.
      [
        "Update site/content/en/docs/setup.md to describe the new flag.",
        ["site/content/en/docs"],
        ["site/content/en/docs/setup.md"],
      ],
      // Docusaurus.
      [
        "Update website/docs/intro.md to describe the new flag.",
        ["website/docs"],
        ["website/docs/intro.md"],
      ],
      // NeMo Agent Toolkit: a README outside docs/ that the project configures.
      [
        "Update examples/agents/README.md to describe the new flag.",
        ["examples/agents"],
        ["examples/agents/README.md"],
      ],
      // A doc/ tree, the second #1914 Acceptance layout.
      ["Update doc/setup.md to describe the new flag.", ["doc"], ["doc/setup.md"]],
      [
        "Update docs/a.md and website/content/b.md.",
        ["docs", "website/content"],
        ["docs/a.md", "website/content/b.md"],
      ],
    ] as const) {
      await expect(admitLocal(instruction, roots), instruction).resolves.toMatchObject({
        targetPaths,
      });
    }
  });

  it.each([
    [
      "a page outside docs/ and fern/ with no roots configured",
      "Update site/content/en/docs/setup.md to describe the new flag.",
      undefined,
      `DocsFab cannot write site/content/en/docs/setup.md: ${LOCAL_WRITE_ROOTS_RULE} ${LIST_IT}`,
    ],
    [
      "a docs/ page outside the configured roots",
      "Update docs/a.md to describe the new flag.",
      ["site/content/en/docs"],
      `DocsFab cannot write docs/a.md: a named page must be under site/content/en/docs/, the documentationRoots in .docsfab.json. ${LIST_IT}`,
    ],
    [
      "a page in a node_modules directory under a configured root",
      "Update site/content/node_modules/x.md to describe the new flag.",
      ["site/content"],
      `DocsFab cannot write site/content/node_modules/x.md: ${LOCAL_PROTECTED}`,
    ],
    [
      "a page in a hidden directory under a configured root",
      "Update site/content/.hidden/x.md to describe the new flag.",
      ["site/content"],
      `DocsFab cannot write site/content/.hidden/x.md: ${LOCAL_PROTECTED}`,
    ],
  ] as const)("refuses %s by name in a local run", async (_label, instruction, roots, message) => {
    const error = await admitLocal(instruction, roots).then(
      (scope) => expect.fail(`admitted ${JSON.stringify(scope?.targetPaths)}`),
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "proposal-scope-unsafe-target", message });
    expect(proposalScopeFailureCode(message)).toBe("proposal-scope-unsafe-target");
  });

  it("refuses traversal, absolute, source, and hidden roots in a local run", async () => {
    await expect(
      admitLocal("Update site/content/../src/x.md.", ["site/content"]),
    ).rejects.toMatchObject({ code: "proposal-scope-unsafe-target", message: UNSAFE_TARGET_FIXED });
    await expect(
      admitParsed("Update docs/a.md.", ["/site/content/x.md"], "local-widen"),
    ).rejects.toMatchObject({ code: "proposal-scope-unsafe-target", message: UNSAFE_TARGET_FIXED });
    const error = await admitLocal("Update docs/a.md to describe the new flag.", [
      "src/docs",
      ".github/docs",
    ]).then(
      (scope) => expect.fail(`admitted ${JSON.stringify(scope?.targetPaths)}`),
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DocumentationRootsOutsideWriteRootsError);
    expect(error).toMatchObject({
      code: "documentation-roots-outside-write-roots",
      message: new DocumentationRootsOutsideWriteRootsError(
        ["src/docs", ".github/docs"],
        "local-widen",
      ).message,
    });
    expect((error as Error).message).toContain(
      'Dropped: "src/docs" (a code directory), ".github/docs" (a segment starts with ".").',
    );
    expect((error as Error).message).not.toContain("#1603");
  });

  it("keeps a hosted run narrow: a widened page is outside the hosted write ceiling", async () => {
    // Default admission, the policy every non-local caller gets, still refuses.
    await expect(
      admit("Update site/content/en/docs/setup.md to describe the new flag.", [
        "site/content/en/docs",
      ]),
    ).rejects.toBeInstanceOf(DocumentationRootsOutsideWriteRootsError);
    // A hosted run writes only through its sealed grant, whose ceiling the host
    // fixes and .docsfab.json never touches.
    const grant = (path: string) =>
      sealHostRuntimeWriteAuthority({
        schemaVersion: 2,
        kind: "docsfab-host-runtime-write-authority",
        deploymentId: "deployment-test",
        projectId: "project-test",
        deploymentEpoch: "epoch-test",
        requestKey: "request-test",
        runId: "run-test",
        fence: 1,
        workflow: "update-documentation",
        sourceRevision: "a".repeat(40),
        sourceTreeObjectId: "b".repeat(40),
        pathCeiling: ["docs/"],
        targets: [{ path, operations: ["add"], preimageObjectId: null, fileMode: "100644" }],
        writeStepIds: ["write-documentation"],
        capsuleSha256: "c".repeat(64),
        compositionSha256: "d".repeat(64),
        toolPolicySha256: "e".repeat(64),
        expiresAt: "2099-01-01T00:00:00.000Z",
        limits: { maximumChangedPaths: 1, maximumPatchBytes: 1 },
      });
    expect(grant("docs/setup.md").targets.map((target) => target.path)).toEqual(["docs/setup.md"]);
    expect(() => grant("site/content/en/docs/setup.md")).toThrowError(
      expect.objectContaining({ code: "write-authority-target-outside-ceiling" }),
    );
  });
});

describe("refusal messages across the live-agent tool boundary", () => {
  it("recovers the code from every refusal form and renders the named page", () => {
    for (const [code, message] of Object.entries(FIRST_RUN_PROPOSAL_SCOPE_FAILURES)) {
      expect(proposalScopeFailureCode(message), code).toBe(code);
    }
    const named = thrownMessage(() =>
      rejectDocumentationTargets(
        [{ path: "doc/a.md", rule: "write-roots" }],
        DOCUMENTATION_WRITE_ROOTS,
      ),
    );
    expect(preRecordFailure(named)).toMatchObject({
      code: "proposal-scope-unsafe-target",
      meaning: `DocsFab cannot write doc/a.md: ${WRITE_ROOTS_RULE} ${OTHER_TREES}`,
      failure: { class: "planning-refusal" },
    });
    const repeated = thrownMessage(() => rejectRepeatedDocumentationTargets(["docs/a.md"]));
    expect(preRecordFailure(repeated)).toMatchObject({ code: "proposal-scope-duplicate-targets" });
    // The local-widening forms are recognized too.
    const local = thrownMessage(() =>
      rejectDocumentationTargets(
        [
          { path: "doc/a.md", rule: "write-roots" },
          { path: "site/x.md", rule: "configured-roots" },
          { path: "site/content/.h/x.md", rule: "protected-path" },
        ],
        ["site/content/"],
        {},
        "local-widen",
      ),
    );
    expect(local).toBe(
      `DocsFab cannot write doc/a.md: ${LOCAL_WRITE_ROOTS_RULE} DocsFab cannot write site/x.md: a named page must be under site/content/, the documentationRoots in .docsfab.json. DocsFab cannot write site/content/.h/x.md: ${LOCAL_PROTECTED} ${LIST_IT}`,
    );
    expect(preRecordFailure(local)).toMatchObject({ code: "proposal-scope-unsafe-target" });
  });

  it("withholds decorated, unknown-rule, and credential-bearing variants", () => {
    const named = thrownMessage(() =>
      rejectDocumentationTargets(
        [{ path: "doc/a.md", rule: "write-roots" }],
        DOCUMENTATION_WRITE_ROOTS,
      ),
    );
    const awsShapedPage = `docs/AKIA${"Q".repeat(16)}.md`;
    for (const text of [
      `${named} PRIVATE-QUOTE`,
      `Error: ${named}`,
      "DocsFab cannot write doc/a.md: the operator said so.",
      `DocsFab cannot write doc/a b.md: ${WRITE_ROOTS_RULE}`,
      `DocsFab cannot write ${awsShapedPage}: ${WRITE_ROOTS_RULE} ${OTHER_TREES}`,
    ]) {
      expect(proposalScopeFailureCode(text), text).toBeUndefined();
      expect(preRecordFailure(text), text).toBeUndefined();
    }
    // The composer never prints a credential-shaped page: the fixed refusal stands.
    expect(
      thrownMessage(() =>
        rejectDocumentationTargets(
          [{ path: awsShapedPage, rule: "write-roots" }],
          DOCUMENTATION_WRITE_ROOTS,
        ),
      ),
    ).toBe(UNSAFE_TARGET_FIXED);
  });
});

describe("symbolic-link escapes", () => {
  it("refuses a widened page whose directory links outside the repository at the write boundary", async () => {
    const root = await realpath(await temporaryDirectory("docsfab-scope-widened-link-"));
    const outside = await realpath(await temporaryDirectory("docsfab-scope-widened-link-outside-"));
    await mkdir(join(root, "site", "content"), { recursive: true });
    await symlink(outside, join(root, "site", "content", "escape"));
    // A local run admits the page by path: it lies under the configured root.
    const scope = await admitLocal("Update site/content/escape/page.md.", ["site/content"]);
    const control = firstRunProposalTargetControl(scope!);
    expect(control.targetPaths).toEqual(["site/content/escape/page.md"]);
    const toolSet = await createConfinedToolSet({
      workspacePath: root,
      allowWrite: true,
      allowedWritePaths: [...control.targetPaths],
    });
    const tool = toolSet.definitions.find((definition) => definition.name === "write")!;
    const raw = { path: "site/content/escape/page.md", content: "# Changed\n" };
    const prepared = structuredClone(tool.prepareArguments ? tool.prepareArguments(raw) : raw);
    await expect(
      tool.execute("call", prepared as never, undefined, undefined, undefined as never),
    ).rejects.toThrow(safeFailureMessage("denied-path"));
    expect(toolSet.getMutationRefusals()).toEqual([{ reason: "link", count: 1 }]);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses an admitted page whose directory links outside the repository at the write boundary", async () => {
    const root = await realpath(await temporaryDirectory("docsfab-scope-link-"));
    const outside = await realpath(await temporaryDirectory("docsfab-scope-link-outside-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
    await symlink(outside, join(root, "docs", "escape"));

    // Admission is a path rule: both pages lie under docs/.
    const linked = firstRunProposalTargetControl((await admit("Update docs/escape/page.md."))!);
    const guide = firstRunProposalTargetControl((await admit("Update docs/guide.md."))!);
    expect([linked.targetPaths, guide.targetPaths]).toEqual([
      ["docs/escape/page.md"],
      ["docs/guide.md"],
    ]);

    const write = async (targetPaths: readonly string[], path: string) => {
      const toolSet = await createConfinedToolSet({
        workspacePath: root,
        allowWrite: true,
        allowedWritePaths: [...targetPaths],
      });
      const tool = toolSet.definitions.find((definition) => definition.name === "write")!;
      const raw = { path, content: "# Changed\n" };
      const prepared = structuredClone(tool.prepareArguments ? tool.prepareArguments(raw) : raw);
      return {
        toolSet,
        result: tool.execute("call", prepared as never, undefined, undefined, undefined as never),
      };
    };

    const refused = await write(linked.targetPaths, "docs/escape/page.md");
    await expect(refused.result).rejects.toThrow(safeFailureMessage("denied-path"));
    expect(refused.toolSet.getMutationRefusals()).toEqual([{ reason: "link", count: 1 }]);
    expect(await readdir(outside)).toEqual([]);

    // Positive control: the same writer writes the admitted page with no link.
    const written = await write(guide.targetPaths, "docs/guide.md");
    await written.result;
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# Changed\n");
  });
});

/** Admission as a local run makes it: configured roots may widen. */
async function admitLocal(
  instruction: string,
  documentationRoots?: readonly string[],
): ReturnType<typeof bindFirstRunProposalScope> {
  return bindFirstRunProposalScope({
    request: createRequest(instruction),
    config: stubConfig(await temporaryDirectory("docsfab-scope-roots-")),
    revision: REPOSITORY_REVISION,
    documentationRootPolicy: "local-widen",
    ...(documentationRoots ? { documentationRoots } : {}),
  });
}

async function admit(
  instruction: string,
  documentationRoots?: readonly string[],
): ReturnType<typeof bindFirstRunProposalScope> {
  return bindFirstRunProposalScope({
    request: createRequest(instruction),
    config: stubConfig(await temporaryDirectory("docsfab-scope-roots-")),
    revision: REPOSITORY_REVISION,
    ...(documentationRoots ? { documentationRoots } : {}),
  });
}

/** Admission over a parser result, as a provider other than the installed one could return. */
async function admitParsed(
  instruction: string,
  targetPaths: readonly string[],
  documentationRootPolicy: DocumentationRootPolicy = "narrow",
): ReturnType<typeof bindFirstRunProposalScope> {
  return bindFirstRunProposalScope({
    request: createRequest(instruction),
    config: stubConfig(await temporaryDirectory("docsfab-scope-roots-")),
    revision: REPOSITORY_REVISION,
    documentationRootPolicy,
    ordinaryRequestParser: () => ({
      workflow: "update-documentation",
      instruction,
      instructionSha256: instructionSha256(instruction),
      repositoryRevision: REPOSITORY_REVISION,
      targetPaths: [...targetPaths].sort(),
    }),
  });
}

function seal(targetPaths: readonly string[]) {
  return createFirstRunProposalScopeBinding({
    workflow: "update-documentation",
    instructionSha256: "a".repeat(64),
    repositoryRevision: REPOSITORY_REVISION,
    targetPaths,
  });
}

function thrownMessage(refuse: () => never): string {
  try {
    refuse();
  } catch (error) {
    return (error as Error).message;
  }
}

function createRequest(instruction: string): RunRequestWithPublishProjection {
  return {
    workflow: "update-documentation",
    repositoryPath: "/tmp/repo",
    revision: "HEAD",
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function stubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "..", "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: { provider: "none", model: "none" },
  } as unknown as DocsFabConfig;
}
