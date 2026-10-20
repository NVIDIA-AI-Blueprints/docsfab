// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runnable with `node --test` and collectable by Vitest.
const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");

import {
  EXEC_MAX_BUFFER,
  EXEC_TIMEOUT_MS,
  FAILURE_OUTPUT_TAIL_LINES,
  WITHHELD_EXCERPT,
  checkMutantApplied,
  computeLabelMap,
  containsTokenShapedText,
  failingStepName,
  failureRow,
  findImporters,
  gitChangedPaths,
  labelForPath,
  npmStepNames,
  outputAfterLastStep,
  parseArgs,
  scanText,
  vitestCommandFor,
} from "./docsfab-preflight.mjs";
import { internalOnly } from "./internal-path.test-helper.mjs";

// The canonical half of the scan rule, so the probes can show each half alone
// misses a shape the other catches. The forge half is the shared shape list,
// imported the same way the script imports it.
import { containsAssignedCredential } from "../src/security/credential-material.ts";
import { TEXT_CREDENTIAL_SHAPES } from "../src/security/text-credential-shapes.js";

/** The forge half of the scan: the shared credential shapes. */
function forgeCredentialShapes() {
  return [...TEXT_CREDENTIAL_SHAPES];
}

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "docsfab-preflight.mjs");
const OWN_CHECKOUT_CASE = internalOnly(
  ".git",
  "default mode without --root targets the git root of its own checkout",
);

// Await `build` before cleanup, or the directory is deleted under its pending
// git calls.
async function withTempGitRepo(build) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-preflight-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "preflight-test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Preflight Test"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  try {
    return await build(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(root, relativePath, contents) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function commitAll(root, message) {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root });
}

describe("labelForPath / computeLabelMap", () => {
  it("maps one representative changed path per package-* label, matching check-mr-hygiene.sh", () => {
    const cases = [
      ["packages/runtime/scripts/docsfab-preflight.mjs", "package-runtime"],
      ["packages/knowledge/skills/example/SKILL.md", "package-knowledge"],
      ["packages/quality/profiles/example.md", "package-quality"],
      ["packages/skills/example/SKILL.md", "package-skills"],
      ["packages/host/src/limits.ts", "package-host"],
      ["docs/agents/worker-brief.md", "package-docs"],
      ["fern/docs.yml", "package-docs"],
      [".gitlab-ci.yml", "package-ci"],
      [".gitlab/ci/check-mr-hygiene.sh", "package-ci"],
      ["scripts/test/agent-guidance-size.test.sh", "package-process"],
      ["roles/worker.md", "package-process"],
      [".gitlab/README.md", "package-process"],
      [".gitlab/issue_templates/Task.md", "package-process"],
      [".gitlab/merge_request_templates/Default.md", "package-process"],
      ["AGENTS.md", "package-process"],
      // Case order matters as in the bash `case`: an earlier prefix wins over
      // */AGENTS.md.
      ["packages/runtime/AGENTS.md", "package-runtime"],
      ["benchmarks/AGENTS.md", "package-process"],
      ["BOOT.md", "package-process"],
      ["PRINCIPLES.md", "package-process"],
      ["CONTRIBUTING.md", "package-process"],
      ["PROCESS.md", "package-process"],
    ];
    for (const [path, expected] of cases) {
      assert.equal(labelForPath(path), expected, `expected ${path} -> ${expected}`);
    }
  });

  it("leaves an unmapped path unmapped, exactly like the CI script's informational bucket", () => {
    assert.equal(labelForPath("config/limits.yaml"), "");
  });

  it("positive control: a mix of mapped and one unmapped path produces the exact required set and the exact unmapped list", () => {
    const { required, unmapped, byPath } = computeLabelMap([
      "packages/runtime/scripts/docsfab-preflight.mjs",
      "docs/agents/worker-brief.md",
      "AGENTS.md",
      "config/limits.yaml",
      "",
      "  ",
    ]);
    assert.deepEqual(required, ["package-docs", "package-process", "package-runtime"]);
    assert.deepEqual(unmapped, ["config/limits.yaml"]);
    assert.equal(byPath["packages/runtime/scripts/docsfab-preflight.mjs"], "package-runtime");
    assert.equal(Object.hasOwn(byPath, ""), false);
  });
});

describe("scanText", () => {
  it("flags a GitLab closing pattern even when the sentence negates it", () => {
    const { ok, violations } = scanText(
      "This change does not fixes #1234; it is definitely not a close.",
    );
    assert.equal(ok, false);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, "closing-pattern");
    assert.equal(violations[0].line, 1);
  });

  it("flags every listed closing keyword paired with an issue reference", () => {
    const keywords = [
      "close",
      "closes",
      "closed",
      "closing",
      "fix",
      "fixes",
      "fixed",
      "fixing",
      "resolve",
      "resolves",
      "resolved",
      "resolving",
      "implement",
      "implements",
      "implemented",
      "implementing",
    ];
    for (const keyword of keywords) {
      const { ok } = scanText(`Work in progress; ${keyword} #42 tracks it.`);
      assert.equal(ok, false, `expected "${keyword} #42" to be flagged`);
    }
  });

  it("flags a sentence-initial capitalised keyword, the common real spelling", () => {
    // Pins the `i` flag on CLOSING_KEYWORD_PATTERN.
    for (const line of ["Closes #12", "Fixes #12", "CLOSES #12", "Resolves #7 as well"]) {
      const { ok, violations } = scanText(line);
      assert.equal(ok, false, `expected "${line}" to be flagged`);
      assert.equal(violations[0].type, "closing-pattern");
    }
  });

  it("allows only a precise close for an explicitly approved local IID", () => {
    for (const line of ["Closes #123", "Fixes #123.", "Resolves #123!"]) {
      assert.equal(scanText(line, { allowedCloseIids: ["123"] }).ok, true, line);
      assert.equal(scanText(line).ok, false, `default scan must still reject ${line}`);
    }
  });

  it("does not let an approved IID authorize foreign, extra, negated, quoted, or contextual references", () => {
    for (const line of [
      "Closes #124",
      "Closing #123",
      "Implemented #123",
      "Closes #123 and #124",
      "Closes #123 in group/project",
      "This does not close #123",
      "`Closes #123`",
      "Related to #123",
    ]) {
      const { ok } = scanText(line, { allowedCloseIids: ["123"] });
      assert.equal(ok, line === "Related to #123", line);
    }
  });

  it("rejects invalid allowlist inputs instead of coercing them", () => {
    assert.throws(
      () => scanText("Closes #123", { allowedCloseIids: "123" }),
      /positive local issue IIDs/u,
    );
    assert.throws(
      () => scanText("Closes #123", { allowedCloseIids: ["0"] }),
      /positive local issue IIDs/u,
    );
  });

  it("positive control: a closing keyword with no issue reference, and an issue reference with no keyword, both pass", () => {
    // Pins the ISSUE_REFERENCE_PATTERN conjunct.
    for (const line of [
      "fixes the bug (no ref)",
      "closing patterns are banned",
      "Advances #1151",
      "See !1045 and the design check",
    ]) {
      const { ok, violations } = scanText(line);
      assert.equal(ok, true, `expected "${line}" to pass, got ${JSON.stringify(violations)}`);
    }
  });

  // Built at run time so no vendor-prefixed literal of scannable length
  // appears in this file and the secret-fixtures registry stays untouched.
  const FAKE_VALUE = "EXAMPLE".repeat(4);
  const FAKE_GITLAB_TOKEN = `glpat-${FAKE_VALUE}`;
  // Ten characters: above the forge screen's `\S{8,}` floor and below the
  // canonical 12-character floor, so it isolates the forge half.
  const FORGE_ONLY_VALUE = FAKE_VALUE.slice(0, 10);

  it("passes the text a conforming worker actually posts: this MR's own title, a Co-Authored-By trailer, and ordinary key-like prose", () => {
    const benign = [
      "Draft: feat(process): docsfab-preflight, worker and critic brief templates, and guidance for the definition of done",
      "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>",
      "Owner: andrewch.",
      "Status: pending",
      "Summary: done",
      "TODO: later",
      "error: boom",
    ];
    for (const line of benign) {
      const { ok, violations } = scanText(line);
      assert.equal(
        ok,
        true,
        `expected ${JSON.stringify(line)} to pass, got ${JSON.stringify(violations)}`,
      );
    }
  });

  it("flags every credential assignment shape that stops the forge poller, naming token-shaped-text", () => {
    const shapes = [
      `token=${FAKE_GITLAB_TOKEN}`,
      `token:${FAKE_GITLAB_TOKEN}`,
      `PRIVATE-TOKEN: ${FAKE_VALUE}`,
      `Authorization: Bearer ${FAKE_VALUE}`,
      `password : ${FAKE_VALUE}`,
      `Authorization=Bearer ${FAKE_VALUE}`,
      `TOKEN = ${FAKE_VALUE}`,
      `api_key: ${FAKE_VALUE}`,
      `Authorization:Bearer ${FAKE_VALUE}`,
      `client_secret = ${FAKE_VALUE}`,
    ];
    for (const line of shapes) {
      const { ok, violations } = scanText(line);
      assert.equal(ok, false, `expected a credential shape on this line to be flagged`);
      assert.equal(violations[0].type, "token-shaped-text");
    }
  });

  it("never echoes the offending line, because preflight output gets pasted into GitLab", () => {
    const { violations } = scanText(`Authorization: Bearer ${FAKE_VALUE}`);
    assert.equal(violations[0].excerpt, WITHHELD_EXCERPT);
    assert.equal(violations[0].excerpt.includes(FAKE_VALUE), false);
  });

  it("is the union of both screens, and neither half alone would do", () => {
    const forgeShapes = forgeCredentialShapes();
    // Forge-only by value length, not key shape.
    const forgeOnly = `TOKEN = ${FORGE_ONLY_VALUE}`;
    assert.equal(
      forgeShapes.some((pattern) => pattern.test(forgeOnly)),
      true,
    );
    assert.equal(
      containsAssignedCredential(forgeOnly),
      false,
      "the canonical detector alone misses it: 10 characters is below its 12-character value floor",
    );
    // Canonical-only by KEY SHAPE: the forge boundary excludes `_`, so a
    // compound key ending in `_api_key` is the canonical suffix class's alone.
    // (Until Task #1476 this probe was `Authorization: Bearer <value>`; the
    // shared list now carries the bearer family, so that probe is matched by
    // both halves.)
    const canonicalOnly = `service_api_key: ${FAKE_VALUE}`;
    assert.equal(containsAssignedCredential(canonicalOnly), true);
    assert.equal(
      forgeShapes.some((pattern) => pattern.test(canonicalOnly)),
      false,
      "the forge screen alone misses it",
    );
    for (const line of [forgeOnly, canonicalOnly]) {
      assert.equal(containsTokenShapedText(line), true);
    }
    assert.equal(containsTokenShapedText("Status: pending"), false);
  });

  it("flags every credential family of the shared text list", () => {
    // The scan imports the shared list; there is no copy to pin.
    const upper = "ABCDEFGHIJKLMNOP";
    const moved = [
      ["bearer value", ["Bearer", "b".repeat(16)].join(" ")],
      ["lower-case bearer value", ["bearer", "b".repeat(16)].join(" ")],
      ["JWT", [`eyJ${"Q".repeat(10)}`, "Q".repeat(10), "sig"].join(".")],
      ["PEM private-key banner", ["-----BEGIN RSA", "PRIVATE", "KEY-----"].join(" ")],
      ["AWS long-term access-key identifier", ["AK", "IA", upper].join("")],
      ["AWS temporary access-key identifier", ["AS", "IA", upper].join("")],
    ];
    for (const [name, value] of moved) {
      const { ok, violations } = scanText(`Set ${value} before the run.`);
      assert.equal(ok, false, `${name} must be flagged`);
      assert.equal(violations[0].type, "token-shaped-text");
      assert.equal(violations[0].excerpt, WITHHELD_EXCERPT);
    }
    // Positive controls: the adjacent value one character short of each moved
    // family, and ordinary MR prose, pass.
    for (const benign of [
      ["Bearer", "b".repeat(15)].join(" "),
      ["AK", "IA", upper.slice(0, 15)].join(""),
      "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>",
      "Draft: feat(process): docsfab-preflight and the brief templates",
    ]) {
      assert.equal(scanText(benign).ok, true, benign.slice(0, 12));
    }
  });
  // Each gap probe keeps a control, so narrowing the scan is caught even if it
  // never touches the gap probe itself.
  it("T-R4a pinning pair: flags an unquoted token assignment (control) and the JSON-quoted form", () => {
    assert.equal(
      containsTokenShapedText(`token: ${FAKE_VALUE}`),
      true,
      "control must stay flagged",
    );
    // As a human pastes it, and as canonicalJson emits it (no space).
    for (const quoted of [`"token": "${FAKE_VALUE}"`, `{"token":"${FAKE_VALUE}"}`]) {
      assert.equal(containsTokenShapedText(quoted), true, quoted.slice(0, 9));
    }
  });

  it("T-R4b pinning pair: flags a bare private-token flag (control) and the -- CLI form", () => {
    assert.equal(
      containsTokenShapedText(`private-token=${FAKE_VALUE}`),
      true,
      "control must stay flagged",
    );
    assert.equal(
      containsTokenShapedText(`glab api --private-token=${FAKE_VALUE} projects/437040`),
      true,
      "a shell line carrying the CLI long flag must be flagged",
    );
  });

  // Forge half in isolation: the union cannot catch a forge-only regression
  // when both halves match, so drive the forge array with a forge-only value.
  it("forge screen alone recognizes a quoted key and a -- CLI flag, at a value the canonical detector is blind to", () => {
    const forgeShapes = forgeCredentialShapes();
    const flagged = [
      `"token": "${FORGE_ONLY_VALUE}"`,
      `{"token":"${FORGE_ONLY_VALUE}"}`,
      `'token': '${FORGE_ONLY_VALUE}'`,
      `glab api --private-token=${FORGE_ONLY_VALUE} projects/437040`,
    ];
    for (const probe of flagged) {
      assert.equal(
        forgeShapes.some((pattern) => pattern.test(probe)),
        true,
        `forge screen must flag ${probe.slice(0, 12)}...`,
      );
      assert.equal(
        containsAssignedCredential(probe),
        false,
        "probe must stay below the canonical value floor, or it cannot isolate the forge half",
      );
    }
  });

  // One step outside the quoted-key and `--` branches; all must stay
  // unflagged. The first four rows catch allowing a single `-` boundary.
  it("forge screen leaves shapes one step outside the two widened conditions unflagged", () => {
    const forgeShapes = forgeCredentialShapes();
    const benign = [
      `non-token: ${FAKE_VALUE}`,
      `non-secret: ${FAKE_VALUE}`,
      `x-token: ${FAKE_VALUE}`,
      `token-count: ${FAKE_VALUE}`,
      `-private-token=${FAKE_VALUE}`,
      `"tokens": "${FAKE_VALUE}"`,
      `"auth-token-history": "${FAKE_VALUE}"`,
      `token: ${FAKE_VALUE.slice(0, 7)}`,
      // A JSON subtree value is a structural field, not an assignment; host
      // `replaceSlackRoutes` screens documents shaped like this.
      `"authorization":{"authorityId":"swap-operator","evidenceReference":"x"}`,
      `"authorization": {"authorityId": "swap-operator"}`,
      `"token": "${FAKE_VALUE.slice(0, 3)}"`,
      `"token': "${FAKE_VALUE}"`,
    ];
    for (const probe of benign) {
      assert.equal(
        forgeShapes.some((pattern) => pattern.test(probe)),
        false,
        `forge screen must not flag ${probe}`,
      );
    }
  });

  // The canonical half at the same gaps and adjacent shapes.
  it("canonical detector classifies a quoted token key and a -- CLI flag, and still declines the adjacent keys", () => {
    for (const flagged of [
      `"token": "${FAKE_VALUE}"`,
      `{"token":"${FAKE_VALUE}"}`,
      // A single-quoted key, as YAML writes it; pins both quote characters.
      `'token': '${FAKE_VALUE}'`,
      `--private-token=${FAKE_VALUE}`,
    ]) {
      assert.equal(containsAssignedCredential(flagged), true, flagged.slice(0, 14));
    }
    for (const benign of [
      `non-token: ${FAKE_VALUE}`,
      `token-count: ${FAKE_VALUE}`,
      `"tokens": "${FAKE_VALUE}"`,
      `"auth-token-history": "${FAKE_VALUE}"`,
      // An unquoted bare `token` is an identifier. The line below ships in
      // validate_json_artifact.py, which the quality-pack integrity check reads
      // through detectCredentialRuleIds; classifying it marks every pack tampered.
      '        token = raw_token.replace("~1", "/").replace("~0", "~")',
      `token = ${FAKE_VALUE}`,
    ]) {
      assert.equal(containsAssignedCredential(benign), false, benign.slice(0, 24));
    }
    // The union still flags the unquoted form through the forge half.
    assert.equal(containsTokenShapedText(`token: ${FAKE_VALUE}`), true);
  });

  // The canonical 12-character value floor at the limit and limit-1.
  // `access_token:` is canonical-only (the forge boundary excludes `_`), so the
  // union tracks this floor exactly.
  it("canonical detector classifies an assignment whose value sits exactly on its value floor and declines one character below it", () => {
    const atFloor = FAKE_VALUE.slice(0, 12);
    const belowFloor = FAKE_VALUE.slice(0, 11);
    assert.equal(atFloor.length, 12);
    assert.equal(belowFloor.length, 11);
    assert.equal(containsAssignedCredential(`access_token: ${atFloor}`), true);
    assert.equal(containsAssignedCredential(`access_token: ${belowFloor}`), false);
    const forgeShapes = forgeCredentialShapes();
    assert.equal(
      forgeShapes.some((pattern) => pattern.test(`access_token: ${atFloor}`)),
      false,
      "the forge half must miss this shape, or the union assertions below prove nothing",
    );
    assert.equal(containsTokenShapedText(`access_token: ${atFloor}`), true);
    assert.equal(containsTokenShapedText(`access_token: ${belowFloor}`), false);
  });

  // The forge `\S{8,}` floor at the limit and limit-1. Unquoted on purpose: in
  // the quoted branch the closing quote counts toward the run, so a quoted
  // probe cannot sit exactly on the floor.
  it("forge screen flags an assignment whose value sits exactly on the value floor and declines one character below it", () => {
    const forgeShapes = forgeCredentialShapes();
    const atFloor = FAKE_VALUE.slice(0, 8);
    const belowFloor = FAKE_VALUE.slice(0, 7);
    assert.equal(atFloor.length, 8);
    assert.equal(belowFloor.length, 7);
    for (const key of ["token", "private-token", "--private-token"]) {
      assert.equal(
        forgeShapes.some((pattern) => pattern.test(`${key}=${atFloor}`)),
        true,
        `${key} at the floor must be flagged`,
      );
      assert.equal(
        forgeShapes.some((pattern) => pattern.test(`${key}=${belowFloor}`)),
        false,
        `${key} one character below the floor must not be flagged`,
      );
    }
  });

  // Positive controls for long-standing shapes.
  it("keeps every credential assignment shape it already recognized classified", () => {
    for (const control of [
      `access_token: ${FAKE_VALUE}`,
      `private-token=${FAKE_VALUE}`,
      `PRIVATE-TOKEN: ${FAKE_VALUE}`,
      `Authorization: Bearer ${FAKE_VALUE}`,
    ]) {
      assert.equal(containsTokenShapedText(control), true, control.slice(0, 16));
    }
  });

  it("flags obviously fake token-shaped prose without using a real credential", () => {
    // Low-entropy fixture: token-shaped here, but not a Gitleaks match.
    const fakeToken = "x".repeat(24);
    const { ok, violations } = scanText(`Authorization: ${fakeToken}`);
    assert.equal(ok, false);
    assert.equal(violations[0].type, "token-shaped-text");
  });

  it("does not flag a benign URL sentence, so the token-shape rule discriminates rather than matching everything", () => {
    const { ok } = scanText("See https://example.com/path/to/page for details.");
    assert.equal(ok, true);
  });

  it("positive control: ordinary MR prose using the Advances convention and a clean preflight line passes with zero findings", () => {
    const { ok, violations } = scanText(
      [
        "Advances #1234.",
        "Ran npm run preflight before push; every check passed.",
        "See docs/agents/worker-brief.md for the definition of done.",
      ].join("\n"),
    );
    assert.equal(ok, true);
    assert.deepEqual(violations, []);
  });
});

describe("checkMutantApplied", () => {
  it("reports applied:true with a real diffstat once a tracked file is actually edited", () => {
    return withTempGitRepo((root) => {
      writeFile(root, "file.js", "const x = 1;\n");
      commitAll(root, "init");
      writeFile(root, "file.js", "const x = 2;\n");

      return checkMutantApplied("file.js", { cwd: root }).then((result) => {
        assert.equal(result.applied, true);
        assert.match(result.status, /^ M file\.js/);
        assert.match(result.diffstat, /file\.js \| 2 [+][-]/);
      });
    });
  });

  it("reports applied:true for a brand-new untracked file, with a line-count diffstat", () => {
    return withTempGitRepo((root) => {
      writeFile(root, "file.js", "const x = 1;\n");
      commitAll(root, "init");
      writeFile(root, "new-file.js", "const y = 1;\nconst z = 2;\n");

      return checkMutantApplied("new-file.js", { cwd: root }).then((result) => {
        assert.equal(result.applied, true);
        assert.match(result.status, /^\?\? new-file\.js/);
        assert.match(result.diffstat, /new file, 2 line\(s\)/);
      });
    });
  });

  it("negative/positive-control pair: a reverted mutant reports applied:false, proving the check is not a no-op detector that always passes", () => {
    return withTempGitRepo((root) => {
      writeFile(root, "file.js", "const x = 1;\n");
      commitAll(root, "init");
      writeFile(root, "file.js", "const x = 2;\n");

      return checkMutantApplied("file.js", { cwd: root })
        .then((applied) => {
          assert.equal(applied.applied, true, "sanity: the edit was detected before reverting");
          execFileSync("git", ["checkout", "--", "file.js"], { cwd: root });
          return checkMutantApplied("file.js", { cwd: root });
        })
        .then((reverted) => {
          assert.equal(reverted.applied, false);
          assert.equal(reverted.status, "");
          assert.equal(reverted.diffstat, "");
        });
    });
  });
});

describe("gitChangedPaths / findImporters / vitestCommandFor", () => {
  it("finds the test file that imports a changed module and prints its vitest command", () => {
    return withTempGitRepo((root) => {
      writeFile(root, "packages/runtime/src/widget.ts", "export const widget = 1;\n");
      writeFile(
        root,
        "packages/runtime/test/widget.test.ts",
        'import { widget } from "../src/widget.js";\ntest("widget", () => widget);\n',
      );
      writeFile(root, "packages/runtime/test/unrelated.test.ts", 'test("noop", () => 1);\n');
      commitAll(root, "base");
      execFileSync("git", ["branch", "-m", "main"], { cwd: root });
      execFileSync("git", ["checkout", "-q", "-b", "work"], { cwd: root });
      writeFile(root, "packages/runtime/src/widget.ts", "export const widget = 2;\n");
      commitAll(root, "change widget");

      return gitChangedPaths("main", root).then((changed) => {
        assert.deepEqual(changed, ["packages/runtime/src/widget.ts"]);
        return findImporters(changed[0], root).then((importers) => {
          assert.deepEqual(importers, ["packages/runtime/test/widget.test.ts"]);
          assert.equal(
            vitestCommandFor(importers[0]),
            "(cd packages/runtime && npx vitest run test/widget.test.ts --testTimeout=180000)",
          );
        });
      });
    });
  });

  it("positive control: an unrelated changed file (no matching test) returns no importers, so the search discriminates by content", () => {
    return withTempGitRepo((root) => {
      writeFile(root, "packages/runtime/src/lonely.ts", "export const lonely = 1;\n");
      writeFile(root, "packages/runtime/test/other.test.ts", 'test("other", () => 1);\n');
      commitAll(root, "base");
      execFileSync("git", ["branch", "-m", "main"], { cwd: root });
      execFileSync("git", ["checkout", "-q", "-b", "work"], { cwd: root });
      writeFile(root, "packages/runtime/src/lonely.ts", "export const lonely = 2;\n");
      commitAll(root, "change lonely");

      return findImporters("packages/runtime/src/lonely.ts", root).then((importers) => {
        assert.deepEqual(importers, []);
      });
    });
  });
});

// A subprocess test per standalone mode, so CLI glue bugs (argument parsing,
// cwd selection) cannot hide behind unit tests of the exported functions.

describe("CLI: --scan-file", () => {
  it("exits 1 and prints the finding for a closing-pattern file", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-preflight-scan-"));
    try {
      const file = writeFile(root, "body.txt", "This fixes #99 for sure.\n");
      const result = spawnSync(process.execPath, [scriptPath, "--scan-file", file], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /FAIL:.*1 finding/);
      assert.match(result.stdout, /closing-pattern/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("positive control: exits 0 for clean text", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-preflight-scan-"));
    try {
      const file = writeFile(root, "body.txt", "Advances #99. All checks passed.\n");
      const result = spawnSync(process.execPath, [scriptPath, "--scan-file", file], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^PASS:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a declared local closure while refusing an additional undeclared closure", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-preflight-scan-"));
    try {
      const file = writeFile(root, "body.txt", "Closes #123\nFixes #124\n");
      const result = spawnSync(
        process.execPath,
        [scriptPath, "--scan-file", file, "--allow-close", "123"],
        {
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stdout, /line 2 \[closing-pattern\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("always withholds credential-shaped text even on an approved close line", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-preflight-scan-"));
    try {
      const file = writeFile(
        root,
        "body.txt",
        "Closes #123 Authorization: Bearer EXAMPLEEXAMPLEEXAMPLEEXAMPLE\n",
      );
      const result = spawnSync(
        process.execPath,
        [scriptPath, "--scan-file", file, "--allow-close", "123"],
        {
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stdout, /token-shaped-text/);
      assert.equal(result.stdout.includes("EXAMPLEEXAMPLE"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CLI: in a checkout without the build-generated limits mirror", () => {
  // The scanner imports runtime source that reads the untracked limits mirror.
  function copiedCheckout() {
    const root = mkdtempSync(join(tmpdir(), "docsfab-preflight-fresh-"));
    const repository = resolve(dirname(scriptPath), "../../..");
    for (const path of [
      "config",
      "packages/runtime/scripts",
      "packages/runtime/src/config",
      "packages/runtime/src/security",
    ]) {
      cpSync(join(repository, path), join(root, path), { recursive: true });
    }
    return root;
  }
  const mirror = "packages/runtime/src/config/limits.generated.ts";

  it("writes the mirror, then scans", () => {
    const root = copiedCheckout();
    try {
      rmSync(join(root, mirror));
      const file = writeFile(root, "body.txt", "Advances #99. All checks passed.\n");
      const result = spawnSync(
        process.execPath,
        [join(root, "packages/runtime/scripts/docsfab-preflight.mjs"), "--scan-file", file],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^PASS:/);
      assert.equal(result.stderr, "");
      assert.ok(existsSync(join(root, mirror)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a catalog it cannot load and still scans with the mirror already on disk", () => {
    const root = copiedCheckout();
    try {
      writeFileSync(join(root, "config/limits.yaml"), "schemaVersion: 2\n");
      const file = writeFile(root, "body.txt", "Advances #99. All checks passed.\n");
      const result = spawnSync(
        process.execPath,
        [join(root, "packages/runtime/scripts/docsfab-preflight.mjs"), "--scan-file", file],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^PASS:/);
      assert.match(
        result.stderr,
        /^docsfab-preflight: could not write the build-generated limits mirrors: config\/limits\.yaml must declare schemaVersion 1/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CLI: --mutant-applied", () => {
  it("resolves the file relative to the invoking process's cwd, not the docsfab repository root", () => {
    return withTempGitRepo((root) => {
      writeFile(root, "file.js", "const x = 1;\n");
      commitAll(root, "init");
      writeFile(root, "file.js", "const x = 2;\n");

      const result = spawnSync(process.execPath, [scriptPath, "--mutant-applied", "file.js"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^PASS:/);
      assert.match(result.stdout, /diffstat:/);
    });
  });

  it("negative control: exits 1 when the file does not differ from HEAD", () => {
    return withTempGitRepo((root) => {
      writeFile(root, "file.js", "const x = 1;\n");
      commitAll(root, "init");

      const result = spawnSync(process.execPath, [scriptPath, "--mutant-applied", "file.js"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /^FAIL:/);
    });
  });
});

// A missing flag value, and `--root` with a mode that ignores it, are refused
// by name at parse time instead of falling back to a default.

describe("parseArgs (B2)", () => {
  for (const flag of [
    "--base",
    "--project",
    "--mr",
    "--root",
    "--scan-file",
    "--allow-close",
    "--mutant-applied",
  ]) {
    it(`throws naming the flag when ${flag} is given with no value (kills the silent-undefined defect)`, () => {
      assert.throws(() => parseArgs([flag]), { message: `${flag} requires a value` });
    });
  }

  it("positive control: a value-taking flag followed by a value never throws", () => {
    assert.doesNotThrow(() => parseArgs(["--root", "/tmp/some-dir"]));
  });

  it("positive control: --root with a real value is stored verbatim, not discarded by the missing-value guard", () => {
    assert.equal(parseArgs(["--root", "/tmp/some-dir"]).root, "/tmp/some-dir");
  });

  // An empty value (`--root "$TARGET"` with `TARGET` unset) counts as missing.
  for (const flag of [
    "--base",
    "--project",
    "--mr",
    "--root",
    "--scan-file",
    "--allow-close",
    "--mutant-applied",
  ]) {
    it(`throws naming the flag when ${flag} is given an empty value (B4: was silently treated as present)`, () => {
      assert.throws(() => parseArgs([flag, ""]), { message: `${flag} requires a value` });
    });
  }

  it("throws naming --root when its value is whitespace-only (B4 sibling; was previously loud but misattributed as spawn ENOENT)", () => {
    assert.throws(() => parseArgs(["--root", "   "]), { message: "--root requires a value" });
  });

  it("--root combined with --scan-file is refused by name, not silently ignored", () => {
    assert.throws(
      () => parseArgs(["--scan-file", "body.txt", "--root", "/tmp/some-dir"]),
      /--root is not supported with --scan-file/,
    );
    // Order-independent.
    assert.throws(
      () => parseArgs(["--root", "/tmp/some-dir", "--scan-file", "body.txt"]),
      /--root is not supported with --scan-file/,
    );
  });

  it("--root combined with --mutant-applied is refused by name, not silently ignored", () => {
    assert.throws(
      () => parseArgs(["--mutant-applied", "file.js", "--root", "/tmp/some-dir"]),
      /--root is not supported with --mutant-applied/,
    );
  });

  it("positive control: --scan-file/--mutant-applied without --root are unaffected by the refusal", () => {
    assert.equal(parseArgs(["--scan-file", "body.txt"]).mode, "scan-file");
    assert.equal(parseArgs(["--mutant-applied", "file.js"]).mode, "mutant-applied");
  });

  it("refuses --allow-close outside scan-file mode", () => {
    assert.throws(() => parseArgs(["--allow-close", "123"]), /supported only with --scan-file/u);
    assert.throws(
      () => parseArgs(["--mutant-applied", "file.js", "--allow-close", "123"]),
      /supported only with --scan-file/u,
    );
  });

  it("requires a positive numeric IID for each close allowance", () => {
    for (const iid of ["0", "001", "abc", "12a"]) {
      assert.throws(
        () => parseArgs(["--scan-file", "body.txt", "--allow-close", iid]),
        /positive local issue IID/u,
      );
    }
  });
});

describe("CLI: parseArgs failures at the shipped entry point (B2, executing)", () => {
  it("--root with no value exits 2 and never reaches the default-mode run (was: exit 0, ran in the cwd tree)", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--root"], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /--root requires a value/);
    // Nothing under default mode (the table, the labels row) ran.
    assert.equal(result.stdout, "");
  });

  it('--root "" exits 2 and never reaches the default-mode run (B4: was exit 0, an all-PASS table for the cwd, 0 bytes stderr)', () => {
    // An unset `"$TARGET"` expands to an empty argv element, not a missing one.
    const result = spawnSync(process.execPath, [scriptPath, "--root", "", "--base", "HEAD"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /--root requires a value/);
    assert.equal(result.stdout, "");
  });

  it('--mr "" exits 2 instead of silently dropping the MR labels row (B4 sibling)', () => {
    const result = spawnSync(process.execPath, [scriptPath, "--mr", "", "--base", "HEAD"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /--mr requires a value/);
    assert.equal(result.stdout, "");
  });

  it("--root combined with --scan-file exits 2 instead of silently checking the wrong tree", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-preflight-scan-"));
    try {
      const file = writeFile(root, "body.txt", "Advances #99. All checks passed.\n");
      const result = spawnSync(
        process.execPath,
        [scriptPath, "--root", root, "--scan-file", file],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /--root is not supported with --scan-file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A faithful `npm run <chain>` stdout with a two-line banner per script; the
// last banner names the step that failed.
const CHAIN_STDOUT = [
  "",
  "> docsfab-runtime@1.0.0 check:static",
  "> npm run format:check && npm run lint && npm run check:limits",
  "",
  "",
  "> docsfab-runtime@1.0.0 format:check",
  "> biome format .",
  "",
  "Checked 1404 files. No fixes applied.",
  "",
  "> docsfab-runtime@1.0.0 check:limits",
  "> node scripts/check-limits.mjs --check --gate",
  "",
  "scanning packages/runtime/src",
  "limits.generated.ts drifted from config/limits.yaml; run npm run generate:limits",
].join("\n");

// A passing step's stderr warning that must not be reported as a later failure.
const EARLIER_STDERR_WARNING =
  "test/interactive-task-scope.test.ts:112:82 lint/complexity/noCommaOperator warning";

describe("npmStepNames / outputAfterLastStep / failingStepName", () => {
  it("names every npm step in order and ignores the command lines between them", () => {
    assert.deepEqual(npmStepNames(CHAIN_STDOUT), ["check:static", "format:check", "check:limits"]);
  });

  it("positive control: a second banner-shaped line is required, not just a name@version on the first line (R12)", () => {
    // `"> esbuild@0.21.5 src"` matches the banner regex on its own, so only the
    // second-`> `-line requirement rejects it.
    const stdout = ["", "> docsfab-runtime@1.0.0 build", "> esbuild@0.21.5 src", "", "done"].join(
      "\n",
    );
    assert.deepEqual(npmStepNames(stdout), ["build"]);
  });

  it("returns only the failing step's own stdout, not the whole chain's", () => {
    assert.equal(
      outputAfterLastStep(CHAIN_STDOUT).trim().split("\n").at(-1),
      "limits.generated.ts drifted from config/limits.yaml; run npm run generate:limits",
    );
    assert.equal(outputAfterLastStep(CHAIN_STDOUT).includes("Checked 1404 files"), false);
  });

  it("prefers npm's own Lifecycle line when npm prints one, innermost first", () => {
    const stderr = [
      EARLIER_STDERR_WARNING,
      "npm error Lifecycle script `check:limits` failed with error:",
      "npm error Lifecycle script `check:static` failed with error:",
    ].join("\n");
    assert.equal(failingStepName(CHAIN_STDOUT, stderr, "check:static"), "check:limits");
  });

  it("falls back to the banner trail when npm prints no Lifecycle line, then to the invoked name", () => {
    assert.equal(
      failingStepName(CHAIN_STDOUT, EARLIER_STDERR_WARNING, "check:static"),
      "check:limits",
    );
    assert.equal(failingStepName("", "", "triage-secret-findings.py"), "triage-secret-findings.py");
  });
});

describe("failureRow", () => {
  it("names the failing step and its own last line, never an earlier step's stderr warning", () => {
    const row = failureRow("check:static", {
      stdout: CHAIN_STDOUT,
      stderr: EARLIER_STDERR_WARNING,
    });
    assert.equal(row.status, "FAIL");
    assert.equal(
      row.detail,
      "check:limits: limits.generated.ts drifted from config/limits.yaml; run npm run generate:limits",
    );
    assert.equal(row.detail.includes("noCommaOperator"), false);
    assert.equal(row.output.includes(EARLIER_STDERR_WARNING), true, "kept as labelled context");
  });

  it("trusts the tail of stderr for a single-step command, where a tool writes the message it dies on", () => {
    // check:derived's stdout ends with a SKIP summary; the cause is the last
    // stderr line, and only one step ran.
    const stdout = [
      "",
      "> docsfab-runtime@1.0.0 check:derived",
      "> node scripts/generate-derived.mjs --check",
      "",
      "FAIL limits: limits.generated.ts drifted from config/limits.yaml",
      "SKIP composition-digests: not run after the first derived-state failure",
    ].join("\n");
    const stderr = "Derived-state preflight failed at limits: limits.generated.ts drifted";
    const row = failureRow("check:derived", { stdout, stderr });
    assert.equal(
      row.detail,
      "check:derived: Derived-state preflight failed at limits: limits.generated.ts drifted",
    );
  });

  it("does not trust stderr in a chain, because an earlier step's warning is indistinguishable from the failing step's error", () => {
    const stderr = [EARLIER_STDERR_WARNING, "error: an unrelated later warning"].join("\n");
    const row = failureRow("check:static", { stdout: CHAIN_STDOUT, stderr });
    assert.equal(
      row.detail,
      "check:limits: limits.generated.ts drifted from config/limits.yaml; run npm run generate:limits",
    );
  });

  it("positive control: a command that printed nothing reports its own error message, not an empty detail", () => {
    const row = failureRow("check:derived", { message: "Command failed: npm run check:derived" });
    assert.equal(row.detail, "check:derived: Command failed: npm run check:derived");
    assert.deepEqual(row.output, []);
  });

  // FAILURE_OUTPUT_TAIL_LINES at the limit, limit+1, and well past it, through
  // `failureRow`. Fixture sizes are literal: deriving them from the constant
  // would let a mutated constant resize its own fixture. The sanity test ties
  // the literals to the constant.
  it("sanity: FAILURE_OUTPUT_TAIL_LINES is still 12 — update the two fixture sizes below if this changes", () => {
    assert.equal(FAILURE_OUTPUT_TAIL_LINES, 12);
  });

  function stderrLinesError(count) {
    const lines = Array.from({ length: count }, (_, index) => `line-${index + 1}`);
    return { stdout: "", stderr: lines.join("\n"), message: "boom" };
  }

  it("at the limit: 12 non-empty stderr lines are all reproduced (kills MC10, tail cap = 1)", () => {
    const row = failureRow("check:derived", stderrLinesError(12));
    assert.deepEqual(row.output, [
      "stderr, last 12 line(s):",
      ...Array.from({ length: 12 }, (_, index) => `line-${index + 1}`),
    ]);
    assert.equal(row.detail, "check:derived: line-12");
  });

  it("one past the limit: 13 stderr lines keep exactly the last 12, dropping the first (kills MC11, tail cap = 13)", () => {
    const row = failureRow("check:derived", stderrLinesError(13));
    assert.deepEqual(row.output, [
      "stderr, last 12 line(s):",
      ...Array.from({ length: 12 }, (_, index) => `line-${index + 2}`),
    ]);
    assert.equal(row.output.includes("line-1"), false, "the first line must be the one dropped");
    assert.equal(row.detail, "check:derived: line-13");
  });

  it("well past the limit (~50 stderr lines): the cap is enforced, not merely off-by-one-safe (kills MC2, cap unenforced)", () => {
    const row = failureRow("check:derived", stderrLinesError(50));
    // 1 header line + exactly 12 reproduced lines.
    assert.equal(row.output.length, 13);
    assert.deepEqual(
      row.output.slice(1),
      Array.from({ length: 12 }, (_, index) => `line-${index + 39}`),
    );
  });

  // A killed or overflowed child never prints its own failing line, so the
  // named cause must come ahead of the captured tail.
  describe("killed and maxBuffer children (R2)", () => {
    // Non-empty tails on both streams, so a pass proves precedence.
    const stdout = [
      "",
      "> docsfab-runtime@1.0.0 check:static",
      "> node scripts/some-long-running-step.mjs",
      "",
      "unrelated output captured before the kill -- must not be reported as the cause",
    ].join("\n");
    const stderr = "unrelated stderr captured before the kill -- must not be reported as the cause";

    it("T-R2a: names the timeout cause ahead of the tail when the child was killed", () => {
      const row = failureRow("check:static", { killed: true, signal: "SIGTERM", stdout, stderr });
      assert.equal(
        row.detail,
        `check:static: timed out after ${EXEC_TIMEOUT_MS}ms (EXEC_TIMEOUT_MS; signal SIGTERM)`,
      );
      assert.equal(row.detail.includes("must not be reported"), false);
    });

    it("T-R2b: names the maxBuffer cause ahead of the tail when output exceeded the cap (kills the real bug from note 70968701)", () => {
      const row = failureRow("check:static", {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        stdout,
        stderr,
      });
      assert.equal(
        row.detail,
        `check:static: output exceeded ${EXEC_MAX_BUFFER} bytes (EXEC_MAX_BUFFER)`,
      );
      assert.equal(row.detail.includes("must not be reported"), false);
    });

    it("T-R2c positive control: an ordinary non-zero exit (Node's real shape: killed false, signal null, code 1) keeps the existing tail attribution", () => {
      // promisify(execFile)'s shape for a plain non-zero exit.
      const row = failureRow("check:static", {
        killed: false,
        signal: null,
        code: 1,
        stdout,
        stderr,
      });
      assert.equal(row.detail, `check:static: ${stderr}`);
      // One npm step ran, so stderr is trusted as usual.
      assert.equal(row.detail.includes("timed out"), false);
      assert.equal(row.detail.includes("output exceeded"), false);
      assert.equal(row.detail.includes("terminated by signal"), false);
    });

    it("T-R2d: an external signal death (killed false, e.g. Linux OOM SIGKILL or a runner cancel/kill SIGTERM) is not misreported as the EXEC_TIMEOUT_MS timeout", () => {
      // An external kill arrives as { killed: false, signal, code: null };
      // reporting it as a timeout would send a reader to raise the bound.
      const row = failureRow("check:static", {
        killed: false,
        signal: "SIGKILL",
        code: null,
        stdout,
        stderr,
      });
      assert.equal(
        row.detail,
        `check:static: terminated by signal SIGKILL before it finished (not the EXEC_TIMEOUT_MS timeout; the parent did not kill it)`,
      );
      assert.equal(row.detail.includes("timed out"), false);
      assert.equal(row.detail.includes("must not be reported"), false);
    });
  });
});

// CLI default mode: an executing proof of the exit code. Commands are shimmed
// on PATH for the child only; `git` is not shimmed.

const PASSING_FIXTURE = {
  "check:derived": {
    stdout: ["", "> docsfab-runtime@1.0.0 check:derived", "> node x", "", "PASS"],
  },
  // Banner-free: the PASS detail must stay deterministic without banners.
  "check:pins": { stdout: ["PASS composition-digests"] },
  "check:static": { stdout: ["", "> docsfab-runtime@1.0.0 check:static", "> node x", "", "PASS"] },
  "check-package-imports.mjs": {
    stdout: ["Verified package facade imports (6 importer trees)."],
  },
  "triage-secret-findings.py": { stdout: ['{"entries": 103, "valid": true}'] },
};

function withCommandShims(fixture, run) {
  const dir = mkdtempSync(join(tmpdir(), "docsfab-preflight-shim-"));
  try {
    // Without --root, default mode targets the git root of its cwd, so the
    // child runs in a throwaway checkout instead of the tree holding this test.
    const checkout = join(dir, "checkout");
    mkdirSync(join(checkout, "packages", "runtime"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: checkout });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=preflight-test@example.com",
        "-c",
        "user.name=Preflight Test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: checkout },
    );
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(fixture));
    writeFileSync(
      join(dir, "shim.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        'const fixture = JSON.parse(readFileSync(process.env.PREFLIGHT_FIXTURE, "utf8"));',
        'import { appendFileSync } from "node:fs";',
        'import { basename } from "node:path";',
        'const key = process.argv[2] === "run" ? process.argv[3] : basename(process.argv[2]);',
        "const entry = fixture[key] ?? {};",
        "appendFileSync(`${process.env.PREFLIGHT_FIXTURE}.log`, `${key}:${process.env.npm_config_loglevel}\n`);",
        'const write = (stream, lines) => { if (lines?.length) stream.write(`${lines.join("\\n")}\\n`); };',
        "write(process.stdout, entry.startStdout);",
        "if (entry.holdForSignal) {",
        "  const timer = setInterval(() => {}, 1000);",
        '  process.once("exit", (code) => appendFileSync(`${process.env.PREFLIGHT_FIXTURE}.log`, `child-exit:${process.pid}:${code}\\n`));',
        '  process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });',
        "  appendFileSync(`${process.env.PREFLIGHT_FIXTURE}.log`, `child-start:${process.pid}\\n`);",
        "  await new Promise(() => {});",
        "}",
        "if (entry.delayMs) await new Promise((resolve) => setTimeout(resolve, entry.delayMs));",
        "write(process.stdout, entry.stdout);",
        "write(process.stderr, entry.stderr);",
        "if (entry.completionMarker) appendFileSync(`${process.env.PREFLIGHT_FIXTURE}.log`, `${entry.completionMarker}\\n`);",
        "process.exit(entry.exit ?? 0);",
        "",
      ].join("\n"),
    );
    // The shims exec process.execPath by absolute path, so shimming `node`
    // does not recurse. `glab api ...` dispatches on the key "api".
    for (const name of ["npm", "python3", "node", "glab"]) {
      const shim = join(dir, name);
      writeFileSync(
        shim,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "shim.mjs"))} "$@"\n`,
      );
      chmodSync(shim, 0o755);
    }
    const environment = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      PREFLIGHT_FIXTURE: fixturePath,
      npm_config_loglevel: "silent",
    };
    return run(
      (args, nodeArgs = []) =>
        spawnSync(process.execPath, [...nodeArgs, scriptPath, ...args], {
          encoding: "utf8",
          cwd: checkout,
          env: environment,
        }),
      () => readFileSync(`${fixturePath}.log`, "utf8"),
      { directory: dir, checkout, environment, fixturePath },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tableRow(stdout, name) {
  return stdout.split("\n").find((line) => line.startsWith(name)) ?? "";
}

describe("CLI: default mode", () => {
  // A short fixture watchdog scales the old call-site timeout without waiting
  // two minutes. Child completion and failure still come from real processes.
  const fixtureWatchdogMs = 200;
  for (const fails of [false, true]) {
    it(`waits for the complete npm chain and retains its ${fails ? "failure" : "success"}`, () => {
      return withCommandShims(
        {
          ...PASSING_FIXTURE,
          "check:static": {
            startStdout: ["> fixture@1.0.0 check:static", "> first-step"],
            delayMs: fixtureWatchdogMs * 2,
            stdout: [
              "> fixture@1.0.0 check:last-step",
              "> last-step",
              fails ? "late static failure" : "complete",
            ],
            exit: fails ? 23 : 0,
            completionMarker: "npm-chain-completed",
          },
        },
        (run, shimLog, { directory }) => {
          const preload = join(directory, "scale-existing-watchdog.mjs");
          writeFileSync(
            preload,
            `
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
const original = cp.execFile;
const optionsFor = (command, args, options) => command === "npm" && args[1] === "check:static" && options?.timeout
  ? { ...options, timeout: ${fixtureWatchdogMs} } : options;
const wrapped = (command, args, options, callback) => original(command, args, optionsFor(command, args, options), callback);
wrapped[promisify.custom] = (command, args, options) => original[promisify.custom](command, args, optionsFor(command, args, options));
cp.execFile = wrapped;
syncBuiltinESMExports();
`,
          );
          const result = run(["--base", "HEAD"], ["--import", preload]);
          assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
          assert.match(shimLog(), /^npm-chain-completed$/mu, "the npm child must actually finish");
          const row = tableRow(result.stdout, "check:static");
          assert.match(
            row,
            fails
              ? /FAIL\s+check:last-step: late static failure/u
              : /PASS\s+2 npm step\(s\), last: check:last-step/u,
          );
          assert.equal(result.stdout.includes("timed out"), false, result.stdout);
          assert.deepEqual(
            shimLog()
              .split("\n")
              .filter((line) => line.startsWith("check:")),
            ["check:derived:notice", "check:pins:notice", "check:static:notice"],
          );
        },
      );
    });
  }

  it("an owning process-group cancellation ends the helper and its npm child", () => {
    return withCommandShims(
      { ...PASSING_FIXTURE, "check:static": { holdForSignal: true } },
      (_run, _shimLog, { directory, checkout, environment, fixturePath }) => {
        const driver = join(directory, "cancel-own-group.mjs");
        writeFileSync(
          driver,
          `
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, watch } from "node:fs";
const child = spawn(process.execPath, [${JSON.stringify(scriptPath)}, "--base", "HEAD"], {
  cwd: ${JSON.stringify(checkout)}, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
});
const log = ${JSON.stringify(`${fixturePath}.log`)};
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop(); process.exit(1); });
const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
child.stdout.resume(); child.stderr.resume();
let watcher;
let exitWatcher;
try {
  const descendant = await new Promise((resolve, reject) => {
    const inspect = () => {
      let text; try { text = readFileSync(log, "utf8"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      const found = /^child-start:(\\d+)$/m.exec(text);
      if (found) resolve(found[1]);
    };
    watcher = watch(${JSON.stringify(directory)}, inspect);
    child.once("exit", () => reject(new Error("helper exited before npm child started")));
    child.once("error", reject);
    inspect();
  });
  watcher.close();
  const descendantExited = new Promise((resolve) => {
    const inspect = () => { if (readFileSync(log, "utf8").includes("child-exit:" + descendant + ":0")) resolve(); };
    exitWatcher = watch(${JSON.stringify(directory)}, inspect);
    inspect();
  });
  stop();
  const result = await closed;
  await descendantExited;
  assert.notEqual(result.code, 0, "cancelled helper must not report success");
  assert.equal(result.signal, "SIGTERM");
  assert.ok(readFileSync(log, "utf8").includes("child-exit:" + descendant + ":0"), "owned npm child must exit on cancellation");
} finally { watcher?.close(); exitWatcher?.close(); stop(); await closed; }
`,
        );
        const result = spawnSync(process.execPath, [driver], {
          cwd: checkout,
          env: environment,
          encoding: "utf8",
          timeout: EXEC_TIMEOUT_MS,
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
      },
    );
  });

  it("exits 1 with a FAIL row whose detail names the failing sub-script, not an earlier step's stderr warning", () => {
    return withCommandShims(
      {
        ...PASSING_FIXTURE,
        "check:derived": {
          stdout: CHAIN_STDOUT.split("\n"),
          stderr: [EARLIER_STDERR_WARNING],
          exit: 1,
        },
      },
      (run) => {
        const result = run(["--base", "HEAD"]);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        const row = tableRow(result.stdout, "check:derived");
        assert.match(row, /\bFAIL\b/);
        assert.match(row, /check:limits: limits\.generated\.ts drifted from config\/limits\.yaml/);
        assert.equal(row.includes("noCommaOperator"), false);
        assert.match(result.stdout, /Failure output for check:derived:/);
        assert.match(tableRow(result.stdout, "check:pins"), /\bPASS\b/);
      },
    );
  });

  it("forces npm's step banners on, so `npm run preflight --silent` still names the failing step", () => {
    // The spawn sets npm_config_loglevel=silent, which the child npm would otherwise inherit.
    return withCommandShims(PASSING_FIXTURE, (run, shimLog) => {
      const result = run(["--base", "HEAD"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const npmInvocations = shimLog()
        .split("\n")
        .filter((line) => line.startsWith("check:"));
      assert.deepEqual(npmInvocations, [
        "check:derived:notice",
        "check:pins:notice",
        "check:static:notice",
      ]);
    });
  });

  it("positive control: exits 0 and prints no failure output when every check passes", () => {
    return withCommandShims(PASSING_FIXTURE, (run) => {
      const result = run(["--base", "HEAD"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(
        tableRow(result.stdout, "check:derived"),
        /PASS\s+1 npm step\(s\), last: check:derived/,
      );
      assert.match(tableRow(result.stdout, "check:pins"), /PASS\s+ok\s*$/);
      assert.match(
        tableRow(result.stdout, "check-package-imports.mjs"),
        /PASS\s+Verified package facade imports/,
      );
      assert.equal(result.stdout.includes("Failure output for"), false);
      assert.match(tableRow(result.stdout, "package-* labels"), /N\/A\s+no mapped paths changed/);
    });
  });

  it("renders an unusable --base as a FAIL row instead of throwing away the table it already computed", () => {
    return withCommandShims(PASSING_FIXTURE, (run) => {
      const result = run(["--base", "no-such-ref-for-preflight-test"]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(tableRow(result.stdout, "check:derived"), /\bPASS\b/, "the table still printed");
      const row = tableRow(result.stdout, "package-* labels");
      assert.match(row, /FAIL\s+cannot diff against no-such-ref-for-preflight-test/);
      assert.match(result.stdout, /Failure output for package-\* labels/);
      assert.equal(result.stderr.includes("MODULE_NOT_FOUND"), false);
    });
  });

  it("fails on the repository-root registry check too, not only on npm scripts", () => {
    return withCommandShims(
      {
        ...PASSING_FIXTURE,
        "triage-secret-findings.py": {
          stdout: ["scanning"],
          stderr: ["error: registry source line is stale"],
          exit: 2,
        },
      },
      (run) => {
        const result = run(["--base", "HEAD"]);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(
          tableRow(result.stdout, "triage-secret-findings.py"),
          /FAIL\s+triage-secret-findings\.py: error: registry source line is stale/,
        );
      },
    );
  });

  it("fails on the repository-root import ratchet, the gate npm run check:static does not include", () => {
    return withCommandShims(
      {
        ...PASSING_FIXTURE,
        "check-package-imports.mjs": {
          stdout: [
            "Forbidden cross-package imports:",
            "- packages/runtime/scripts/x.mjs imports ../../host/src/y.ts",
          ],
          exit: 1,
        },
      },
      (run) => {
        const result = run(["--base", "HEAD"]);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(
          tableRow(result.stdout, "check-package-imports.mjs"),
          /FAIL\s+check-package-imports\.mjs: - packages\/runtime\/scripts\/x\.mjs imports/,
        );
      },
    );
  });

  it("skips the MR label comparison when the base diff failed, rather than reporting labels it could not compute", () => {
    // With no required set, a label row would read PASS vacuously.
    return withCommandShims(PASSING_FIXTURE, (run) => {
      const result = run(["--base", "no-such-ref-for-preflight-test", "--mr", "999999"]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(tableRow(result.stdout, "MR !999999 labels"), "");
      assert.match(tableRow(result.stdout, "package-* labels"), /\bFAIL\b/);
    });
  });

  // The MR label rows run against a throwaway repo via `--root`, because the
  // live repository's diff is not deterministic and its refs are shared.
  function buildRuntimeChangeRepo(root) {
    writeFile(root, "README.md", "throwaway\n");
    commitAll(root, "initial");
    const initialSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeFile(root, "packages/runtime/scripts/x.mjs", "export const x = 1;\n");
    commitAll(root, "add a packages/runtime file");
    return initialSha;
  }

  it("the MR label FAIL branch is exercised through a glab shim, not only verified by hand (kills MC7)", () => {
    return withTempGitRepo(async (root) => {
      const initialSha = buildRuntimeChangeRepo(root);
      return withCommandShims(
        { ...PASSING_FIXTURE, api: { stdout: [JSON.stringify({ labels: ["package-docs"] })] } },
        (run) => {
          const result = run(["--root", root, "--base", initialSha, "--mr", "42"]);
          assert.match(
            tableRow(result.stdout, "package-* labels"),
            /package-runtime/,
            "sanity: the throwaway diff must actually require package-runtime",
          );
          assert.match(tableRow(result.stdout, "MR !42 labels"), /FAIL\s+missing: package-runtime/);
        },
      );
    });
  });

  it("positive control: the same MR, fully labelled, reads PASS with the applied label list (R6)", () => {
    return withTempGitRepo(async (root) => {
      const initialSha = buildRuntimeChangeRepo(root);
      return withCommandShims(
        { ...PASSING_FIXTURE, api: { stdout: [JSON.stringify({ labels: ["package-runtime"] })] } },
        (run) => {
          const result = run(["--root", root, "--base", initialSha, "--mr", "42"]);
          assert.match(tableRow(result.stdout, "MR !42 labels"), /PASS\s+applied: package-runtime/);
        },
      );
    });
  });
});

// These invoke the script copy through the raw, un-realpath'd symlinked path
// on purpose: a guard that compares unresolved paths skips main() and exits 0.

describe("entry-point guard resolves symlinks before comparing (B1)", () => {
  /**
   * A copy of the script reachable through `target` and through `viaSymlink`,
   * so argv[1] carries a symlink component regardless of the host's tmpdir.
   */
  function withScriptCopyBehindSymlink(run) {
    const target = mkdtempSync(join(tmpdir(), "docsfab-preflight-guard-target-"));
    const linkParent = mkdtempSync(join(tmpdir(), "docsfab-preflight-guard-link-"));
    const viaSymlink = join(linkParent, "via-symlink");
    try {
      symlinkSync(target, viaSymlink);
      writeFile(
        target,
        "packages/runtime/scripts/docsfab-preflight.mjs",
        readFileSync(scriptPath, "utf8"),
      );
      const realRuntimeRoot = resolve(dirname(scriptPath), "..");
      symlinkSync(resolve(realRuntimeRoot, "src"), join(target, "packages", "runtime", "src"));
      // The script writes the untracked limits mirror through this module first.
      symlinkSync(
        resolve(realRuntimeRoot, "scripts", "check-limits.mjs"),
        join(target, "packages", "runtime", "scripts", "check-limits.mjs"),
      );
      symlinkSync(
        resolve(realRuntimeRoot, "node_modules"),
        join(target, "packages", "runtime", "node_modules"),
      );
      execFileSync("git", ["init", "-q"], { cwd: target });
      execFileSync("git", ["config", "user.email", "preflight-test@example.com"], {
        cwd: target,
      });
      execFileSync("git", ["config", "user.name", "Preflight Test"], { cwd: target });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: target });
      writeFile(target, "README.md", "throwaway\n");
      commitAll(target, "initial");
      const scriptCopyViaSymlink = join(
        viaSymlink,
        "packages",
        "runtime",
        "scripts",
        "docsfab-preflight.mjs",
      );
      return run({ target, viaSymlink, scriptCopyViaSymlink });
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  }

  it("sanity: the invocation path actually carries a symlink component (the fixture this test needs)", () => {
    return withScriptCopyBehindSymlink(({ scriptCopyViaSymlink }) => {
      assert.notEqual(
        scriptCopyViaSymlink,
        realpathSync(scriptCopyViaSymlink),
        "the symlinked path must differ from its own realpath, or this fixture proves nothing",
      );
    });
  });

  it("--scan-file through the un-realpath'd symlinked path still runs main(): exit 1 with the finding, not a silent exit 0", () => {
    return withScriptCopyBehindSymlink(({ target, scriptCopyViaSymlink }) => {
      const file = writeFile(target, "closing.txt", "line one\nCloses #1163\n");
      const result = spawnSync(process.execPath, [scriptCopyViaSymlink, "--scan-file", file], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.notEqual(result.stdout, "");
      assert.match(result.stdout, /FAIL: .* carries 1 finding\(s\)/);
      assert.match(result.stdout, /closing-pattern/);

      // Realpath control: must agree with the symlinked invocation.
      const control = spawnSync(
        process.execPath,
        [realpathSync(scriptCopyViaSymlink), "--scan-file", file],
        {
          encoding: "utf8",
        },
      );
      assert.equal(control.status, result.status);
      assert.equal(control.stdout, result.stdout);
    });
  });

  it("default mode through the un-realpath'd symlinked path still runs main(): prints a table, not zero bytes", () => {
    return withScriptCopyBehindSymlink(({ target, scriptCopyViaSymlink }) => {
      const dir = mkdtempSync(join(tmpdir(), "docsfab-preflight-guard-shim-"));
      try {
        writeFileSync(join(dir, "shim.mjs"), ["process.exit(0);", ""].join("\n"));
        for (const name of ["npm", "python3", "node", "glab"]) {
          const shim = join(dir, name);
          writeFileSync(
            shim,
            `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "shim.mjs"))} "$@"\n`,
          );
          chmodSync(shim, 0o755);
        }
        const result = spawnSync(process.execPath, [scriptCopyViaSymlink, "--base", "HEAD"], {
          encoding: "utf8",
          cwd: target,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /^CHECK\s+STATUS\s+DETAIL/m);
        assert.match(result.stdout, /check:derived/);
        assert.match(result.stdout, /check-package-imports\.mjs/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// `--root <dir>` must reach every default-mode consumer of the roots, and the
// default must resolve the cwd's git root, not the script file's location.

describe("CLI: --root targeting (R11)", () => {
  /**
   * A throwaway repo (`primary`) holding a copy of this script at its real
   * relative path, plus a linked worktree (`second`) standing in for the
   * worktree the caller wants checked.
   */
  async function withScriptCopyAndSecondWorktree(run) {
    return withTempGitRepo(async (primary) => {
      const scriptCopyPath = writeFile(
        primary,
        "packages/runtime/scripts/docsfab-preflight.mjs",
        readFileSync(scriptPath, "utf8"),
      );
      // The copy's relative import and its dependencies must resolve from
      // wherever the copy lives; symlinks suffice.
      const realRuntimeRoot = resolve(dirname(scriptPath), "..");
      symlinkSync(resolve(realRuntimeRoot, "src"), join(primary, "packages", "runtime", "src"));
      // The script writes the untracked limits mirror through this module first.
      symlinkSync(
        resolve(realRuntimeRoot, "scripts", "check-limits.mjs"),
        join(primary, "packages", "runtime", "scripts", "check-limits.mjs"),
      );
      symlinkSync(
        resolve(realRuntimeRoot, "node_modules"),
        join(primary, "packages", "runtime", "node_modules"),
      );
      commitAll(primary, "initial");

      const secondParent = mkdtempSync(join(tmpdir(), "docsfab-preflight-root-b-"));
      const second = join(secondParent, "worktree");
      execFileSync("git", ["worktree", "add", "-q", "-b", "second", second, "HEAD"], {
        cwd: primary,
      });
      try {
        // realpathSync keeps the expected paths exact under macOS's /var symlink.
        return await run({ primary, second, scriptCopyPath: realpathSync(scriptCopyPath) });
      } finally {
        try {
          execFileSync("git", ["worktree", "remove", "--force", second], { cwd: primary });
        } catch {
          // best-effort; the outer rmSync below still reclaims the directory
        }
        rmSync(secondParent, { recursive: true, force: true });
      }
    });
  }

  /** A minimal PATH shim for `npm` recording only the cwd it ran with. */
  function withCwdLoggingNpmShim(run) {
    const dir = mkdtempSync(join(tmpdir(), "docsfab-preflight-cwd-shim-"));
    const logPath = join(dir, "cwd.log");
    try {
      writeFileSync(
        join(dir, "shim.mjs"),
        [
          'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(logPath)}, process.cwd() + "\\n");`,
          "process.exit(0);",
          "",
        ].join("\n"),
      );
      const shim = join(dir, "npm");
      writeFileSync(
        shim,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "shim.mjs"))} "$@"\n`,
      );
      chmodSync(shim, 0o755);
      return run(dir, () => readFileSync(logPath, "utf8").trim().split("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function runScriptCopy(scriptCopyPath, args, cwd, shimDir) {
    return spawnSync(process.execPath, [scriptCopyPath, ...args], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
    });
  }

  it("--root overrides both the script file's own location and the process cwd", () => {
    return withScriptCopyAndSecondWorktree(({ primary, second, scriptCopyPath }) => {
      return withCwdLoggingNpmShim((shimDir, readLog) => {
        // cwd is `primary`; only an honoured `--root` resolves under `second`.
        const result = runScriptCopy(scriptCopyPath, ["--root", second], primary, shimDir);
        const loggedCwd = realpathSync(readLog()[0]);
        assert.equal(
          loggedCwd,
          realpathSync(resolve(second, "packages", "runtime")),
          result.stderr,
        );
      });
    });
  });

  it("default (no --root) resolves the current working directory's own repo root, not the script file's own location", () => {
    return withScriptCopyAndSecondWorktree(({ second, scriptCopyPath }) => {
      return withCwdLoggingNpmShim((shimDir, readLog) => {
        // cwd is `second`; the script file lives under `primary`.
        const result = runScriptCopy(scriptCopyPath, [], second, shimDir);
        const loggedCwd = realpathSync(readLog()[0]);
        assert.equal(
          loggedCwd,
          realpathSync(resolve(second, "packages", "runtime")),
          result.stderr,
        );
      });
    });
  });

  // Positive controls: the real `scriptPath` from both cwds `npm run preflight`
  // uses, with no `--root`, asserting the runtimeRoot the npm steps ran in.

  /**
   * Shims default mode's commands to log their cwd and exit 0. `git` is not
   * shimmed.
   */
  function withCwdLoggingShims(run) {
    const dir = mkdtempSync(join(tmpdir(), "docsfab-preflight-cwd-shims-"));
    const logPath = join(dir, "cwd.log");
    try {
      writeFileSync(
        join(dir, "shim.mjs"),
        [
          'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(logPath)}, process.cwd() + "\\n");`,
          "process.exit(0);",
          "",
        ].join("\n"),
      );
      for (const name of ["npm", "python3", "node", "glab"]) {
        const shim = join(dir, name);
        writeFileSync(
          shim,
          `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "shim.mjs"))} "$@"\n`,
        );
        chmodSync(shim, 0o755);
      }
      return run(dir, () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it(
    "positive control: default mode (no --root), cwd at the tool's own repository root, targets its own runtimeRoot (B3)",
    OWN_CHECKOUT_CASE,
    () => {
      const expectedRuntimeRoot = realpathSync(resolve(scriptPath, "..", ".."));
      const repositoryRootHere = resolve(scriptPath, "..", "..", "..", "..");
      return withCwdLoggingShims((shimDir, readLog) => {
        const result = spawnSync(process.execPath, [scriptPath, "--base", "HEAD"], {
          encoding: "utf8",
          cwd: repositoryRootHere,
          env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        // The first exec (`npm run check:derived`) names the runtimeRoot every
        // later npm step used.
        assert.equal(realpathSync(readLog()[0]), expectedRuntimeRoot);
      });
    },
  );

  it(
    "positive control: the same default mode, cwd at packages/runtime (npm run preflight's own cwd), targets the identical runtimeRoot (B3)",
    OWN_CHECKOUT_CASE,
    () => {
      const expectedRuntimeRoot = realpathSync(resolve(scriptPath, "..", ".."));
      return withCwdLoggingShims((shimDir, readLog) => {
        const result = spawnSync(process.execPath, [scriptPath, "--base", "HEAD"], {
          encoding: "utf8",
          cwd: resolve(scriptPath, "..", ".."),
          env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(realpathSync(readLog()[0]), expectedRuntimeRoot);
      });
    },
  );

  it(
    "runs the cross-package import ratchet from packages/runtime/scripts, the path the public export keeps",
    OWN_CHECKOUT_CASE,
    () => {
      const dir = mkdtempSync(join(tmpdir(), "docsfab-preflight-argv-shims-"));
      const logPath = join(dir, "node.log");
      try {
        writeFileSync(
          join(dir, "node-shim.mjs"),
          [
            'import { appendFileSync } from "node:fs";',
            `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + "\\n");`,
            "",
          ].join("\n"),
        );
        writeFileSync(join(dir, "exit-shim.mjs"), "process.exit(0);\n");
        for (const name of ["npm", "python3", "node", "glab"]) {
          const target = name === "node" ? "node-shim.mjs" : "exit-shim.mjs";
          writeFileSync(
            join(dir, name),
            `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, target))} "$@"\n`,
          );
          chmodSync(join(dir, name), 0o755);
        }
        const result = spawnSync(process.execPath, [scriptPath, "--base", "HEAD"], {
          encoding: "utf8",
          cwd: resolve(scriptPath, "..", ".."),
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const [invocation] = readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.deepEqual(invocation.argv, ["packages/runtime/scripts/check-package-imports.mjs"]);
        assert.equal(
          realpathSync(invocation.cwd),
          realpathSync(resolve(scriptPath, "..", "..", "..", "..")),
        );
        assert.equal(
          realpathSync(resolve(invocation.cwd, invocation.argv[0])),
          realpathSync(resolve(scriptPath, "..", "check-package-imports.mjs")),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
