// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";

// Runnable with `node --test` and collectable by Vitest; Vitest's `expect`
// works outside its runner.
const { afterEach, describe, it } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

import { loadLimitDefinitions } from "./check-limits.mjs";
import {
  CODES,
  SCAN_ROOTS,
  compareRequestWordingSites,
  main,
  runRequestWordingCheck,
  scanRequestWording,
} from "./check-request-wording.mjs";
import { CHECKER_INPUTS, requestWordingCiPathPatterns } from "./request-wording-scan-roots.mjs";

// Real-tree cases parse every file under both scan roots.
const FULL_SCAN_CASE = Object.freeze({
  timeout: loadLimitDefinitions().find((entry) => entry.name === "test.ciTimeoutMs").value,
});
/** The longest a child scan may run before the test stops it as runaway work. */
const CHILD_SCAN_BOUND_MS = FULL_SCAN_CASE.timeout;
/** Outlasts the child bound, so a runaway child fails on its own stop. */
const BOUNDED_CHILD_CASE = Object.freeze({
  timeout: loadLimitDefinitions().find((entry) => entry.name === "test.ciHookTimeoutMs").value,
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptDir, "check-request-wording.mjs");
const realBaselinePath = join(scriptDir, "request-wording-baseline.json");
const repoRoot = dirname(dirname(dirname(scriptDir)));
const roots = [];
const exec = promisify(execFile);
const EMPTY_BASELINE = Object.freeze({ description: "fixture", sites: [], allowlist: [] });
const SOURCE = "packages/runtime/src/fixture.ts";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * @param {Record<string, string>} files repository-relative path to source
 * @param {unknown} [baseline] written as JSON; null writes no baseline file
 */
async function fixture(files, baseline = EMPTY_BASELINE) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-request-wording-"));
  roots.push(root);
  for (const scanRoot of SCAN_ROOTS) await mkdir(join(root, scanRoot), { recursive: true });
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  const baselinePath = join(root, "baseline.json");
  if (baseline !== null) {
    await writeFile(
      baselinePath,
      typeof baseline === "string" ? baseline : JSON.stringify(baseline),
    );
  }
  return { root, baselinePath };
}

async function check(files, baseline) {
  const { root, baselinePath } = await fixture(files, baseline);
  return runRequestWordingCheck({ repoRoot: root, baseline: baselinePath });
}

async function sitesOf(files) {
  const { root } = await fixture(files);
  return scanRequestWording({ repoRoot: root });
}

/** @param {{ path: string; function: string; fingerprint: string }[]} sites */
function brief(sites) {
  return sites.map((site) => ({ path: site.path, function: site.function }));
}

let realTreeScanCount = 0;
let realTreeSnapshot;
async function realTreeResult() {
  realTreeSnapshot ??= (async () => {
    realTreeScanCount += 1;
    const sites = scanRequestWording({ repoRoot });
    const baseline = JSON.parse(await readFile(realBaselinePath, "utf8"));
    return {
      sites,
      baseline,
      result: compareRequestWordingSites(sites, baseline, repoRoot, realBaselinePath),
    };
  })();
  return realTreeSnapshot;
}

const ROW_A = String.raw`export function f(instruction) {
  return /\badd\b/.test(instruction);
}
`;

describe("check-request-wording", () => {
  it("fails a new keyword test on an instruction with the site, function, and remediation (row A)", async () => {
    const result = await check({ [SOURCE]: ROW_A });
    expect(result.status).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      code: CODES.newSite,
      path: SOURCE,
      function: "f",
      display: String.raw`/\badd\b/`,
    });
    expect(result.findings[0].pattern).toMatch(/^regex#[0-9a-f]{64}$/u);
    expect(result.findings[0].message).toContain("Derive this from the admitted request intent");
    expect(result.findings[0].message).toContain("allowlist entry with category and rationale");

    // Negative control: the same file without the keyword test passes.
    const clean = await check({
      [SOURCE]: "export function f(instruction) {\n  return instruction.length > 0;\n}\n",
    });
    expect(clean).toMatchObject({ status: 0, findings: [] });
    expect(clean.stdout).toMatch(/^OK: 0 request-wording sites match the baseline/u);
  });

  it("fresh checker calls reject a source edit even when an earlier inventory was clean", async () => {
    const { root, baselinePath } = await fixture({
      [SOURCE]: "export function f(instruction) { return instruction; }\n",
    });
    const priorSites = scanRequestWording({ repoRoot: root });
    expect(runRequestWordingCheck({ repoRoot: root, baseline: baselinePath })).toMatchObject({
      status: 0,
      findings: [],
    });

    await writeFile(join(root, SOURCE), ROW_A);
    expect(
      compareRequestWordingSites(priorSites, EMPTY_BASELINE, root, baselinePath),
    ).toMatchObject({
      status: 0,
      findings: [],
    });
    const fresh = runRequestWordingCheck({ repoRoot: root, baseline: baselinePath });
    expect(fresh.status).toBe(1);
    expect(fresh.findings.map((finding) => [finding.code, finding.path, finding.function])).toEqual(
      [[CODES.newSite, SOURCE, "f"]],
    );
  });

  it("flags each sink, subject, and lexicon shape (row B)", async () => {
    const cases = [
      [
        "member subject match",
        "export function f(parsed) { return parsed.instruction.match(/update/); }",
        ["f"],
      ],
      [
        "includes literal",
        'export function f(request) { return request.includes("update"); }',
        ["f"],
      ],
      [
        "lexicon some over a normalized local",
        String.raw`const LEXICON = [/\badd\b/u, /\bwrite\b/u];
export function f(request) { const normalized = request.toLowerCase(); return LEXICON.some((p) => p.test(normalized)); }`,
        ["f"],
      ],
      [
        "startsWith",
        'export function f(instruction) { return instruction.startsWith("Write"); }',
        ["f"],
      ],
      [
        "for-of lexicon",
        String.raw`const LEX = [/\badd\b/u];
export function f(instruction) { for (const p of LEX) { if (p.test(instruction)) return true; } return false; }`,
        ["f"],
      ],
      [
        "switch case",
        'export function f(instruction) { switch (instruction) { case "update": return 1; case "": return 0; default: return 2; } }',
        ["f"],
      ],
      [
        "const Set has",
        'const VERBS = new Set(["update"]);\nexport function f(instruction) { const word = instruction.trim(); return VERBS.has(word); }',
        ["f"],
      ],
      [
        "indexOf",
        'export function f(instruction) { return instruction.indexOf("update"); }',
        ["f"],
      ],
      [
        "literal on the left of ===",
        'export function f(instruction) { const word = instruction.trim(); return "update" === word; }',
        ["f"],
      ],
      [
        "array-destructured split binding",
        'export function f(instruction) { const [header] = instruction.split("\\n"); return header.startsWith("Write"); }',
        ["f"],
      ],
      [
        "uppercase-only word",
        String.raw`export function f(instruction) { return /\bMR\b/u.test(instruction); }`,
        ["f"],
      ],
      [
        "nested member subject",
        'export function f(parsed) { return parsed.request.includes("update"); }',
        ["f"],
      ],
      [
        "record member subject",
        "export function f(record) { return record.instruction.match(/add/); }",
        ["f"],
      ],
      [
        "same-file helper parameter",
        String.raw`function helper(text) { return /\badd\b/u.test(text); }
export function f(instruction) { return helper(instruction); }`,
        ["helper"],
      ],
      [
        "array callback parameter",
        'export function f(instruction) { return instruction.split(" ").some((word) => word === "update"); }',
        ["f"],
      ],
      [
        "hex escape decodes to a letter",
        String.raw`export function f(instruction) { return /\x41dd/u.test(instruction); }`,
        ["f"],
      ],
      [
        "regex alias by source",
        String.raw`const MONTH = /\bjanuary\b/u;
export function f(instruction) { const matcher = new RegExp(MONTH.source, MONTH.flags); return matcher.test(instruction); }`,
        ["f"],
      ],
      [
        "strict inequality against a literal",
        'export function f(instruction) { return instruction.trim() !== "publish"; }',
        ["f"],
      ],
      [
        "loose equality against a literal",
        'export function f(instruction) { return instruction == "publish"; }',
        ["f"],
      ],
      [
        "loose inequality with the literal on the left",
        'export function f(instruction) { return "publish" != instruction.trim(); }',
        ["f"],
      ],
      [
        "renamed object-binding subject",
        String.raw`export function f({ instruction: text }) { return /\badd\b/u.test(text); }`,
        ["f"],
      ],
      [
        "non-ASCII letters only",
        'export function f(instruction) { return instruction.includes("公開"); }',
        ["f"],
      ],
      [
        "class listing single letters",
        "export function f(instruction) { return /^[Yy]$/u.test(instruction); }",
        ["f"],
      ],
    ];
    for (const [label, source, functions] of cases) {
      const sites = await sitesOf({ [SOURCE]: `${source}\n` });
      expect({ label, sites: brief(sites) }).toEqual({
        label,
        sites: functions.map((name) => ({ path: SOURCE, function: name })),
      });
    }
  });

  it("fingerprints named consts, String.raw composition, helper-built consts, and aliases by name", async () => {
    const sites = await sitesOf({
      [SOURCE]: String.raw`const VERB = String.raw${"`"}(?:add|create)${"`"};
const JOB = new RegExp(String.raw${"`"}\b${"${VERB}"}\b${"`"}, "u");
function job(verbs) { return new RegExp(verbs, "u"); }
const CREATE = job("create|add");
const MONTH = /\bjanuary\b/u;
export function f(instruction) {
  const matcher = new RegExp(MONTH.source, MONTH.flags);
  return JOB.test(instruction) || CREATE.test(instruction) || matcher.test(instruction);
}
`,
    });
    expect(sites.map((site) => site.pattern.replace(/#[0-9a-f]{64}$/u, ""))).toEqual([
      "JOB",
      "CREATE",
      "MONTH",
    ]);
  });

  it("splits a labelled tuple lexicon into one site per row (tuple for-of)", async () => {
    const sites = await sitesOf({
      [SOURCE]: String.raw`const PATTERNS = [
  ["evidence", /based on evidence/iu, true],
  ["nonpublication", /do not publish/iu, false],
  ["digits", /^\d+$/u, false],
];
export function f(request) {
  for (const [name, pattern] of PATTERNS) { if (pattern.exec(request.instruction)) return name; }
  return undefined;
}
`,
    });
    expect(sites.map((site) => site.pattern.replace(/#[0-9a-f]{64}$/u, ""))).toEqual([
      "PATTERNS[evidence]",
      "PATTERNS[nonpublication]",
    ]);
    expect(new Set(sites.map((site) => site.function))).toEqual(new Set(["f"]));
  });

  it("reaches object-literal match arrows through a name-resolved property call", async () => {
    const sites = await sitesOf({
      [SOURCE]: String.raw`const ROUTES = Object.freeze([
  { workflow: "create-documentation", match: (text) => /\badd\b/u.test(text) },
  { workflow: "update-documentation", match: (text) => /\bupdate\b/u.test(text) },
]);
export function route(request) {
  const normalized = request.trim().replace(/\s+/gu, " ").toLowerCase();
  return ROUTES.filter((candidate) => candidate.match(normalized));
}
`,
    });
    expect(brief(sites)).toEqual([
      { path: SOURCE, function: "ROUTES[workflow=create-documentation].match" },
      { path: SOURCE, function: "ROUTES[workflow=update-documentation].match" },
    ]);
  });

  it("scans product-test.ts and the delegated outcome seeds, but not a same-named parameter elsewhere", async () => {
    const seeded = String.raw`export function parseDelegatedRequestedChecks(outcome) { return /\bnpm test\b/u.test(outcome); }
`;
    const sites = await sitesOf({
      "packages/runtime/src/product-test.ts": ROW_A,
      "packages/runtime/src/cli/commands/do-delegated.ts": seeded,
      // Same parameter name and a wording pattern, outside the seed list.
      "packages/runtime/src/cli/commands/runs-index.ts": String.raw`const SAFE_RECORD_ID = /^run-[a-z]+$/u;
export function parseDelegatedRequestedChecks(outcome) { return SAFE_RECORD_ID.test(outcome); }
`,
    });
    expect(brief(sites)).toEqual([
      {
        path: "packages/runtime/src/cli/commands/do-delegated.ts",
        function: "parseDelegatedRequestedChecks",
      },
      { path: "packages/runtime/src/product-test.ts", function: "f" },
    ]);
  });

  it("fails a removed baseline site with a shrink-the-baseline message (row C)", async () => {
    const { root, baselinePath } = await fixture({ [SOURCE]: ROW_A });
    const [site] = scanRequestWording({ repoRoot: root });
    const baseline = {
      description: "fixture",
      sites: [{ id: "inv-1-1", fingerprint: site.fingerprint }],
      allowlist: [],
    };
    await writeFile(baselinePath, JSON.stringify(baseline));

    // Positive control: the baseline matches the tree exactly.
    expect(runRequestWordingCheck({ repoRoot: root, baseline: baselinePath })).toMatchObject({
      status: 0,
      findings: [],
    });

    await writeFile(
      join(root, SOURCE),
      "export function f(instruction) {\n  return instruction;\n}\n",
    );
    const result = runRequestWordingCheck({ repoRoot: root, baseline: baselinePath });
    expect(result.status).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      code: CODES.stale,
      fingerprint: site.fingerprint,
      list: "sites",
      id: "inv-1-1",
    });
    expect(result.findings[0].message).toContain(`shrink the baseline: remove ${site.fingerprint}`);
  });

  it("keeps fingerprints stable across moves, reformatting, and comments (row D)", async () => {
    const original = String.raw`const LEX = [/\badd\b/u, "write"];
export function f(instruction) {
  return LEX.some((p) => instruction.includes(String(p)));
}
`;
    const moved = `${"\n".repeat(30)}export function unrelated(value) {\n  return value + 1;\n}\n${String.raw`const LEX = [
  // Verbs that start a write.
  /\badd\b/u,
  'write',
];
export function f(instruction) {
  return LEX.some((p) => instruction.includes(String(p)));
}
`}`;
    const before = await sitesOf({ [SOURCE]: original });
    const after = await sitesOf({ [SOURCE]: moved });
    expect(before).toHaveLength(1);
    expect(before[0].pattern).toMatch(/^LEX#[0-9a-f]{64}$/u);
    expect(after.map((site) => site.fingerprint)).toEqual(before.map((site) => site.fingerprint));
    expect(after[0].line).not.toBe(before[0].line);
  });

  it("allowlists by fingerprint, not by function, and digests a lexicon's content (row E)", async () => {
    const guarded = String.raw`const PROHIBITION = /\bdo not publish\b/u;
export function g(instruction) {
  return PROHIBITION.test(instruction);
}
`;
    const { root, baselinePath } = await fixture({ [SOURCE]: guarded });
    const [site] = scanRequestWording({ repoRoot: root });
    await writeFile(
      baselinePath,
      JSON.stringify({
        description: "fixture",
        sites: [],
        allowlist: [
          {
            fingerprint: site.fingerprint,
            category: "narrowing",
            inventoryRow: 17,
            rationale: "Only removes publication.",
          },
        ],
      }),
    );
    // Positive control: the allowlisted pattern itself passes.
    expect(runRequestWordingCheck({ repoRoot: root, baseline: baselinePath }).status).toBe(0);

    await writeFile(
      join(root, SOURCE),
      guarded.replace(
        "return PROHIBITION.test(instruction);",
        String.raw`return PROHIBITION.test(instruction) || /\bpublish anyway\b/u.test(instruction);`,
      ),
    );
    const added = runRequestWordingCheck({ repoRoot: root, baseline: baselinePath });
    expect(added.status).toBe(1);
    expect(added.findings.map((finding) => [finding.code, finding.function])).toEqual([
      [CODES.newSite, "g"],
    ]);

    // Extending the lexicon in place is a new site plus a stale entry.
    await writeFile(
      join(root, SOURCE),
      guarded.replace("do not publish", "do not publish|publish now"),
    );
    const extended = runRequestWordingCheck({ repoRoot: root, baseline: baselinePath });
    expect(extended.status).toBe(1);
    expect(extended.findings.map((finding) => finding.code).sort()).toEqual(
      [CODES.stale, CODES.newSite].sort(),
    );
    expect(extended.findings.find((finding) => finding.code === CODES.newSite)?.pattern).toMatch(
      /^PROHIBITION#/u,
    );
  });

  it("counts fingerprints as a multiset, so reusing an allowlisted guard is a new site", async () => {
    const once = String.raw`const GUARD = /\bdo not publish\b/u;
export function g(instruction) {
  return GUARD.test(instruction);
}
`;
    const { root, baselinePath } = await fixture({ [SOURCE]: once });
    const [site] = scanRequestWording({ repoRoot: root });
    const entry = {
      fingerprint: site.fingerprint,
      category: "narrowing",
      inventoryRow: 17,
      rationale: "Only removes publication.",
    };
    const writeAllowlist = (allowlist) =>
      writeFile(baselinePath, JSON.stringify({ description: "fixture", sites: [], allowlist }));
    await writeAllowlist([entry]);
    // Positive control: one allowlisted use passes.
    expect(runRequestWordingCheck({ repoRoot: root, baseline: baselinePath }).status).toBe(0);

    // A second identical use in the same function shares the fingerprint.
    await writeFile(
      join(root, SOURCE),
      once.replace(
        "  return GUARD.test(instruction);",
        '  if (!GUARD.test(instruction.toLowerCase())) return "grant-publish";\n  return GUARD.test(instruction);',
      ),
    );
    const reused = runRequestWordingCheck({ repoRoot: root, baseline: baselinePath });
    expect(reused.status).toBe(1);
    expect(
      reused.findings.map((finding) => [finding.code, finding.function, finding.fingerprint]),
    ).toEqual([[CODES.newSite, "g", site.fingerprint]]);

    // The converse: two entries for one use leave one stale entry, and two
    // entries for no use report both.
    await writeFile(join(root, SOURCE), once);
    await writeAllowlist([entry, entry]);
    const extra = runRequestWordingCheck({ repoRoot: root, baseline: baselinePath });
    expect(extra.findings.map((finding) => [finding.code, finding.count])).toEqual([
      [CODES.stale, 1],
    ]);
    await writeFile(
      join(root, SOURCE),
      "export function g(instruction) {\n  return instruction;\n}\n",
    );
    const gone = runRequestWordingCheck({ repoRoot: root, baseline: baselinePath });
    expect(gone.findings.map((finding) => [finding.code, finding.count])).toEqual([
      [CODES.stale, 2],
    ]);
    expect(gone.findings[0].message).toContain("(2 entries)");
  });

  it("folds a referenced fragment's content into the composed const's fingerprint", async () => {
    const composed = (verbs) =>
      `const VERB = String.raw${"`"}(?:${verbs})${"`"};\n` +
      `const JOB = new RegExp(String.raw${"`"}\\b${"${VERB}"}\\b${"`"}, "u");\n` +
      "export function f(instruction) {\n  return JOB.test(instruction);\n}\n";
    const [before] = await sitesOf({ [SOURCE]: composed("add|create") });
    const [after] = await sitesOf({ [SOURCE]: composed("add|create|write") });
    expect(before.pattern).toMatch(/^JOB#[0-9a-f]{64}$/u);
    expect(after.pattern).toMatch(/^JOB#[0-9a-f]{64}$/u);
    expect(after.pattern).not.toBe(before.pattern);
  });

  it(
    "digests each referenced helper once, not once per path to it",
    BOUNDED_CHILD_CASE,
    async () => {
      // Each helper calls the one below it twice, so re-expanding every path
      // would serialize about 2^32 helper bodies and never finish. The scan
      // runs synchronously, which no test timeout can stop, so the shipped CLI
      // scans the fixture first in a child that is stopped at the bound.
      const depth = 32;
      const helpers = Array.from({ length: depth }, (_, index) =>
        index === 0
          ? "function h0(text) { return text; }"
          : `function h${index}(text) { return h${index - 1}(text) + h${index - 1}(text); }`,
      ).join("\n");
      const source = (verbs) =>
        `${helpers}\n` +
        `function job(verbs) { h${depth - 1}("probe"); return new RegExp(verbs, "u"); }\n` +
        `const CREATE = job("${verbs}");\n` +
        "export function f(instruction) {\n  return CREATE.test(instruction);\n}\n";
      const { root, baselinePath } = await fixture({ [SOURCE]: source("create|add") });
      const child = await exec(
        process.execPath,
        [scriptPath, "--check", "--repo-root", root, "--baseline", baselinePath],
        { timeout: CHILD_SCAN_BOUND_MS },
      ).then(
        () => ({ code: 0, killed: false }),
        (error) => ({ code: error.code, killed: error.killed }),
      );
      // The empty baseline makes the one site new, so the check exits 1.
      expect(child).toEqual({ code: 1, killed: false });

      const [site] = await sitesOf({ [SOURCE]: source("create|add") });
      expect(site.pattern).toMatch(/^CREATE#[0-9a-f]{64}$/u);
      // The reused digest is the one a full expansion gives: the fingerprint
      // follows the pattern's content and nothing else.
      const [again] = await sitesOf({ [SOURCE]: source("create|add") });
      const [changed] = await sitesOf({ [SOURCE]: source("create|add|write") });
      expect(again.pattern).toBe(site.pattern);
      expect(changed.pattern).not.toBe(site.pattern);
    },
  );

  it.each([
    [
      "a diamond into a two-cycle",
      'function a(text) { return b(text); }\nfunction b(text) { return a(text); }\nfunction job(verbs) { a("x"); b("y"); return new RegExp(verbs, "u"); }\n',
      "CREATE#78aa2152c09d96d684204a58a6b09b17312fb47633a34e960cc5bc63c6f7c796",
    ],
    [
      "a three-cycle entered twice",
      'function a(text) { return b(text); }\nfunction b(text) { return c(text); }\nfunction c(text) { return a(text); }\nfunction job(verbs) { a("x"); c("y"); return new RegExp(verbs, "u"); }\n',
      "CREATE#3229d3c411324d32237c8dbe05c1727ea145e9dfafd49c9266500fedc4038eb1",
    ],
    [
      "a self-recursive helper reached twice",
      'function a(text) { return text ? a(text.slice(1)) : text; }\nfunction job(verbs) { a("x"); a("y"); return new RegExp(verbs, "u"); }\n',
      "CREATE#cec231da8207aab056a88dd5c8ed5fc4c5ff87f42968cbe15dc4fcd9251d452b",
    ],
  ])(
    "keeps the full-expansion fingerprint for %s, reusing no digest a cycle cut short",
    async (_label, helpers, fingerprint) => {
      // Each pinned fingerprint is what the checker gave before it reused
      // digests, expanding every path in full. A digest computed while a
      // reference sat on the visiting path holds a #cycle cut that another
      // path would expand, so reusing it would change these fingerprints.
      const [site] = await sitesOf({
        [SOURCE]:
          helpers +
          'const CREATE = job("create|add");\n' +
          "export function f(instruction) {\n  return CREATE.test(instruction);\n}\n",
      });
      expect(site.pattern).toBe(fingerprint);
    },
  );

  it("does not flag letter-free, structural, dynamic, test-path, or literal-only values (row F fixtures)", async () => {
    const sites = await sitesOf({
      [SOURCE]: String.raw`export function version(version) { return /^\d+$/.test(version); }
export function markdown(path) { return path.endsWith(".md"); }
export function grounded(instruction, quote) { return instruction.includes(quote) && instruction.indexOf(quote) >= 0; }
export function normalize(request) { return request.trim().replace(/\s+/gu, " ").toLowerCase(); }
export function nul(instruction) { return instruction.includes("\0") || instruction.trim() !== ""; }
export function fold(instruction) { return instruction.replace(/[‘’ʼ]/gu, "'"); }
export function slug(instruction) { return /^[a-z0-9-]+$/u.test(instruction); }
export function declared(request) { return request.workflow === "create-documentation" || request.method === "GET"; }
export function keyed(request, key) { return /token/u.test(request[key]); }
export function provenance(resubmitted) {
  const instruction = resubmitted ? "agent-resubmission" : "agent";
  return instruction === "agent-resubmission";
}
function classify(instruction) { return /\badd\b/u.test(instruction) ? "create" : "other"; }
export function kind(request) { return classify(request) === "create"; }
export function choice(message) { return message === "retry" || message === "edit anyway"; }
export function answer(answer) { return /^(?:y|yes)$/iu.test(answer); }
`,
      "packages/runtime/src/fixture.test.ts": ROW_A,
      "packages/runtime/src/test/helper.ts": ROW_A,
      "packages/runtime/src/fixtures/sample.ts": ROW_A,
      "packages/runtime/src/types.d.ts": ROW_A,
      "packages/runtime/src/types.d.mts": ROW_A,
    });
    // Only the helper's own keyword test is a site; its enum result is not.
    expect(brief(sites)).toEqual([{ path: SOURCE, function: "classify" }]);
  });

  it("flags the adjacent conditions of the literal-only and indexed-read exemptions", async () => {
    const sites = await sitesOf({
      [SOURCE]: String.raw`export function local(input) {
  const instruction = input.text;
  return /\badd\b/u.test(instruction);
}
export function indexed(instruction) {
  const parts = instruction.split(" ");
  return /\badd\b/u.test(parts[0]);
}
`,
    });
    expect(brief(sites)).toEqual([
      { path: SOURCE, function: "local" },
      { path: SOURCE, function: "indexed" },
    ]);
  });

  it("refuses a missing, unparsable, or misshapen baseline and an invalid allowlist (row J)", async () => {
    const files = { [SOURCE]: ROW_A };
    const missing = await fixture(files, null);
    const missingResult = runRequestWordingCheck({
      repoRoot: missing.root,
      baseline: missing.baselinePath,
    });
    expect(missingResult.status).toBe(2);
    expect(missingResult.findings.map((finding) => finding.code)).toEqual([CODES.baselineInvalid]);

    for (const bad of [
      "{not json",
      JSON.stringify({ sites: [] }),
      JSON.stringify({ sites: [{}], allowlist: [] }),
    ]) {
      const result = await check(files, bad);
      expect({
        bad,
        status: result.status,
        codes: result.findings.map((finding) => finding.code),
      }).toEqual({
        bad,
        status: 2,
        codes: [CODES.baselineInvalid],
      });
    }

    const both = { fingerprint: "x|f|regex#0", category: "narrowing", rationale: "Narrows." };
    for (const allowlist of [
      [both],
      [{ fingerprint: "y|f|regex#0", rationale: "Narrows." }],
      [{ fingerprint: "y|f|regex#0", category: "grants", rationale: "Narrows." }],
      [{ fingerprint: "y|f|regex#0", category: "narrowing" }],
      [{ fingerprint: "y|f|regex#0", category: "narrowing", rationale: " " }],
    ]) {
      const result = await check(files, {
        description: "fixture",
        sites: [{ id: "inv-1-1", fingerprint: "x|f|regex#0" }],
        allowlist,
      });
      expect({
        allowlist,
        status: result.status,
        codes: result.findings.map((finding) => finding.code),
      }).toEqual({
        allowlist,
        status: 2,
        codes: [CODES.allowlistInvalid],
      });
    }

    // A configured root that does not exist refuses instead of scanning less.
    const partial = await fixture(files);
    await rm(join(partial.root, "packages/knowledge/src"), { recursive: true });
    const partialResult = runRequestWordingCheck({
      repoRoot: partial.root,
      baseline: partial.baselinePath,
    });
    expect(partialResult.status).toBe(2);
    expect(partialResult.findings.map((finding) => finding.code)).toEqual([CODES.rootMissing]);

    expect(main(["--bogus"])).toMatchObject({ status: 2 });
    expect(main(["--bogus"]).stderr).toContain(CODES.usage);
    expect(main(["--baseline"])).toMatchObject({ status: 2 });
    const bare = main([]);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("nothing was checked");
  });

  it("exits 0, 1, and 2 from the shipped CLI, directly and through a symlink (row H)", async () => {
    const failing = await fixture({ [SOURCE]: ROW_A });
    const passing = await fixture({ [SOURCE]: "export const ok = 1;\n" });
    const linked = join(failing.root, "check-linked.mjs");
    await symlink(scriptPath, linked);
    for (const entry of [scriptPath, linked]) {
      const failed = await exec(process.execPath, [
        entry,
        "--check",
        "--repo-root",
        failing.root,
        "--baseline",
        failing.baselinePath,
      ]).then(
        () => ({ code: 0, stderr: "" }),
        (error) => ({ code: error.code, stderr: error.stderr }),
      );
      expect({ entry, code: failed.code }).toEqual({ entry, code: 1 });
      expect(failed.stderr).toContain(`${CODES.newSite}: ${SOURCE}:2 in f`);

      const { stdout } = await exec(process.execPath, [
        entry,
        "--check",
        "--repo-root",
        passing.root,
        "--baseline",
        passing.baselinePath,
      ]);
      expect(stdout).toMatch(/^OK: 0 request-wording sites/u);

      const refused = await exec(process.execPath, [entry]).then(
        () => ({ code: 0, stderr: "" }),
        (error) => ({ code: error.code, stderr: error.stderr }),
      );
      expect({ entry, code: refused.code }).toEqual({ entry, code: 2 });
      expect(refused.stderr).toContain(CODES.usage);
    }
    // Importing through the symlink with another entry point stays inert.
    const { stdout } = await exec(process.execPath, [
      "--input-type=module",
      "-e",
      `process.argv[1] = ${JSON.stringify(join(failing.root, "other.mjs"))}; await import(${JSON.stringify(pathToFileURL(linked).href)}); console.log("imported");`,
    ]);
    expect(stdout.trim()).toBe("imported");
  });

  it(
    "passes the checked-in tree and covers every inventory row (row G)",
    FULL_SCAN_CASE,
    async () => {
      expect(SCAN_ROOTS).toEqual(["packages/runtime/src", "packages/knowledge/src"]);
      const { result, baseline, sites } = await realTreeResult();
      expect(realTreeScanCount).toBe(1);
      expect({ status: result.status, findings: result.findings }).toEqual({
        status: 0,
        findings: [],
      });
      expect(result.stdout).toMatch(/^OK: \d+ request-wording sites match the baseline/u);
      expect(result.sites.some((site) => site.path.startsWith("packages/knowledge/src/"))).toBe(
        true,
      );

      const rows = new Set([
        ...baseline.sites.map((entry) => Number(/^inv-(\d+)-/u.exec(entry.id)?.[1])),
        ...baseline.allowlist.map((entry) => entry.inventoryRow),
      ]);
      // Row 11 (runner-ports instructionDirectsUpdate) is retired: a directed
      // update is now decided by structure, so the scan finds no site.
      // Row 14 (do-delegated parseDelegatedRequestedChecks) is retired: checks
      // come from --check flags, so the request text picks no command.
      // Row 5 (first-pass destination slug) is retired: a path-less create
      // asks for the page, so no page name is built from the request words.
      const retired = new Set([5, 11, 14]);
      for (let row = 1; row <= 17; row += 1)
        expect({ row, covered: rows.has(row) }).toEqual({ row, covered: !retired.has(row) });
      const runnerPorts = "packages/runtime/src/workflow-execution/runner-ports.ts";
      expect(
        brief(result.sites.filter((site) => site.function === "instructionDirectsUpdate")),
      ).toEqual([]);
      expect(
        brief(result.sites.filter((site) => site.function === "parseDelegatedRequestedChecks")),
      ).toEqual([]);
      expect(
        brief(
          result.sites.filter((site) =>
            ["proposeOrdinaryDocumentationDestination", "documentationDestinationSlug"].includes(
              site.function,
            ),
          ),
        ),
      ).toEqual([]);
      // Re-baselining a retired row fails as stale debt, not as a pass.
      const staleFingerprint = `${runnerPorts}|instructionDirectsUpdate|regex#${"0".repeat(64)}`;
      const staleSites = [...baseline.sites, { id: "inv-11-1", fingerprint: staleFingerprint }];
      const { baselinePath: staleBaseline } = await fixture({}, { ...baseline, sites: staleSites });
      const stale = compareRequestWordingSites(
        sites,
        { ...baseline, sites: staleSites },
        repoRoot,
        staleBaseline,
      );
      expect(stale.status).toBe(1);
      expect(
        stale.findings.map((finding) => [finding.code, finding.fingerprint, finding.id]),
      ).toEqual([[CODES.stale, staleFingerprint, "inv-11-1"]]);
      // The router's table and refusals are allowlisted; none of it is debt.
      expect(
        baseline.sites.filter((entry) =>
          entry.fingerprint.startsWith("packages/runtime/src/cli/outcome-router.ts|"),
        ),
      ).toEqual([]);
      expect(new Set(baseline.allowlist.map((entry) => entry.category))).toEqual(
        new Set(["narrowing", "kept-by-decision"]),
      );
    },
  );

  it(
    "does not flag quote grounding, NUL checks, declared structure, or closed replies in the real tree (row F)",
    FULL_SCAN_CASE,
    async () => {
      const { sites } = await realTreeResult();
      expect(realTreeScanCount).toBe(1);
      const at = (path, fn) =>
        sites.filter((site) => site.path === path && (fn === undefined || site.function === fn));
      const assess = "packages/knowledge/src/first-pass/assess.mjs";
      for (const [path, fn] of [
        [assess, "bindInstructionQuote"],
        [assess, "foldQuoteText"],
        [assess, "quoteKey"],
        // The admitted intent's constraint kinds and its NFC-to-raw span map
        // are structured data and offsets, not request wording.
        [assess, "intentConstraint"],
        [assess, "intentSourcePaths"],
        [assess, "rawInstructionSpan"],
        [assess, "rawOffset"],
        ["packages/runtime/src/lineage/contracts.ts", undefined],
        ["packages/runtime/src/records/knowledge-continuation.ts", undefined],
        ["packages/runtime/src/live-agent/workflow-failure-gate.ts", undefined],
        ["packages/runtime/src/live-agent/host.ts", undefined],
        ["packages/runtime/src/cli/outcome-router.ts", "normalizeOutcomeRequest"],
        ["packages/runtime/src/cli/commands/runs-index.ts", undefined],
        ["packages/knowledge/src/server.mjs", undefined],
        // NFC normalization and per-character whitespace tests in quote
        // grounding decide no target, route, or grant.
        ["packages/runtime/src/request-intent/quote.ts", undefined],
      ]) {
        expect({ path, fn, sites: brief(at(path, fn)) }).toEqual({ path, fn, sites: [] });
      }
      // The apostrophe fold in mentionIsActionable and the declared workflow
      // comparison in seedObligations are not sites; their siblings are.
      const mention = at("packages/knowledge/src/first-pass/parse.mjs", "mentionIsActionable");
      expect(mention.length).toBeGreaterThan(0);
      expect(mention.filter((site) => site.display.includes("u2018"))).toEqual([]);
      const seeds = at(assess, "seedObligations");
      expect(seeds.length).toBeGreaterThan(0);
      expect(seeds.filter((site) => site.display.includes("create-documentation"))).toEqual([]);
      // Only the request-word patterns are sites there; the lookup by intent
      // constraint kind and the intent-arm pattern set are not.
      expect(
        seeds.map((site) => /\|explicitPatterns\[([a-z-]+)\]#/u.exec(site.fingerprint)?.[1]).sort(),
      ).toEqual(["evidence", "nonpublication", "operations", "preservation", "typed-stop"]);
    },
  );

  it(
    "fails a new keyword test added inside the real routeOutcomeRequest (row I)",
    FULL_SCAN_CASE,
    async () => {
      const path = "packages/runtime/src/cli/outcome-router.ts";
      const source = await readFile(join(repoRoot, path), "utf8");
      const anchor = "  const normalized = normalizeOutcomeRequest(trimmed);\n";
      expect(source).toContain(anchor);
      const real = JSON.parse(await readFile(realBaselinePath, "utf8"));
      const own = (entry) => entry.fingerprint.startsWith(`${path}|`);
      const baseline = {
        ...real,
        sites: real.sites.filter(own),
        allowlist: real.allowlist.filter(own),
      };

      const unmodified = await check({ [path]: source }, baseline);
      expect({ status: unmodified.status, findings: unmodified.findings }).toEqual({
        status: 0,
        findings: [],
      });

      const modified = await check(
        {
          [path]: source.replace(
            anchor,
            `${anchor}  const bringUpToDate = ${String.raw`/\bbring\b.{0,20}\bup to date\b/u`}.test(normalized);\n`,
          ),
        },
        baseline,
      );
      expect(modified.status).toBe(1);
      expect(modified.findings.map((finding) => [finding.code, finding.function])).toEqual([
        [CODES.newSite, "routeOutcomeRequest"],
      ]);
    },
  );

  it("loads the CI trigger paths without npm dependencies, unlike the checker", async () => {
    const bare = await mkdtemp(join(tmpdir(), "docsfab-request-wording-bare-"));
    roots.push(bare);
    for (const name of ["request-wording-scan-roots.mjs", "check-request-wording.mjs"]) {
      await copyFile(join(scriptDir, name), join(bare, name));
    }
    const load = (name, expression) =>
      exec(process.execPath, [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(pathToFileURL(join(bare, name)).href)}); console.log(JSON.stringify(${expression}));`,
      ]).then(
        ({ stdout }) => ({ code: 0, stdout, stderr: "" }),
        (error) => ({ code: error.code, stdout: "", stderr: error.stderr }),
      );
    const ciPaths = await load(
      "request-wording-scan-roots.mjs",
      "m.requestWordingCiPathPatterns()",
    );
    expect(ciPaths.code).toBe(0);
    expect(JSON.parse(ciPaths.stdout)).toEqual(requestWordingCiPathPatterns());
    expect(requestWordingCiPathPatterns()).toEqual([
      ...SCAN_ROOTS.map((root) => `${root}/**/*`),
      ...CHECKER_INPUTS,
    ]);
    for (const file of [scriptPath, realBaselinePath]) {
      expect(CHECKER_INPUTS).toContain(relative(repoRoot, file).split(sep).join("/"));
    }
    // Adjacent: the same bare directory cannot load the checker, so the
    // generator must import the dependency-free module, not the checker.
    const checker = await load("check-request-wording.mjs", "m.SCAN_ROOTS");
    expect(checker.code).not.toBe(0);
    expect(checker.stderr).toContain("typescript");
  });
});
