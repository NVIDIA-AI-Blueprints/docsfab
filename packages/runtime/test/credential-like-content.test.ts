// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import { decodeRunResultV1, formatRunSummary } from "../src/operator/index.js";
import type { RunRecord } from "../src/records/contracts.js";
import { CREDENTIAL_LIKE_CONTENT } from "../src/security/credential-findings.js";
import {
  collectCredentialLikeContent,
  REQUEST_TEXT_LOCATION,
} from "../src/security/repository-credential-findings.js";
import {
  credentialRuleLine,
  LocalRepositorySecurityScanner,
} from "../src/security/repository-scanner.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plainConfiguredCredential } from "./helpers/planted-configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const RUN_ID = "run-credential-like-content-1807";

// Credential-shaped values, built at run time so no source line holds one.
const PAGE_VALUE = plantedCredentialValue(51, 32);
const SOURCE_VALUE = plantedCredentialValue(52, 32);
const REQUEST_VALUE = plantedCredentialValue(53, 32);
const VALUES = [PAGE_VALUE, SOURCE_VALUE, REQUEST_VALUE];

function expectNoValue(text: string): void {
  for (const value of VALUES) expect(text).not.toContain(value);
}

function savedRecord(findings: RunRecord["credentialFindings"], warning: string): RunRecord {
  const review = canonicalizeJsonEvidence({ verdict: "approved", issues: [] });
  return {
    schemaVersion: 2,
    id: RUN_ID,
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/repository",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-05T00:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    credentialFindings: findings,
    evidenceWarnings: [warning],
    steps: [
      {
        id: "review-documentation",
        title: "review-documentation",
        skill: "review-documentation",
        mode: "read-only",
        status: "succeeded",
        summary: review,
      },
    ],
  } as RunRecord;
}

describe("credential-like content findings (#1807)", () => {
  const roots = temporaryRoots();

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("names each flagged file, line, and rule, and the request text, never the value", async () => {
    const workspace = await roots.create("docsfab-credential-like-content-");
    await mkdir(join(workspace, "docs"), { recursive: true });
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "docs", "page.md"),
      `# Page\n\nSet the key:\n\n    export NGC_API_KEY=${PAGE_VALUE}\n`,
    );
    await writeFile(
      join(workspace, "src", "settings.py"),
      `import os\n\npassword = "${SOURCE_VALUE}"\n`,
    );
    await writeFile(join(workspace, "docs", "clean.md"), "# Clean\n\nNothing to see.\n");
    const report = await new LocalRepositorySecurityScanner().scan(workspace);

    const collected = await collectCredentialLikeContent({
      runId: RUN_ID,
      report,
      workspacePath: workspace,
      requestText: `Update docs/page.md; the old password = "${REQUEST_VALUE}".`,
    });

    expect(collected.findings).toEqual([
      {
        code: CREDENTIAL_LIKE_CONTENT,
        location: "docs/page.md:5",
        rule: "credential.metadata-assigned-secret",
      },
      {
        code: CREDENTIAL_LIKE_CONTENT,
        location: REQUEST_TEXT_LOCATION,
        rule: "credential.assigned-secret",
      },
      {
        code: CREDENTIAL_LIKE_CONTENT,
        location: "src/settings.py:3",
        rule: "credential.assigned-secret",
      },
    ]);
    expect(collected.warning).toBe(
      `credential-like-content: 2 repository files and the request text hold text that looks like a credential. DocsFab used it and continued; only its own configured credentials stop a run. The maintainers decide whether it is a real credential. \`docsfab runs show ${RUN_ID}\` lists each path, line, and rule.`,
    );
    expectNoValue(JSON.stringify(collected));
  });

  it("reports nothing when no content is flagged", async () => {
    const workspace = await roots.create("docsfab-credential-like-content-clean-");
    await writeFile(join(workspace, "README.md"), "# Clean\n");
    const collected = await collectCredentialLikeContent({
      runId: RUN_ID,
      report: await new LocalRepositorySecurityScanner().scan(workspace),
      workspacePath: workspace,
      requestText: "Update README.md.",
    });
    expect(collected).toEqual({ findings: [], warning: undefined });
  });

  it("finds the first line a rule matches", () => {
    const content = [
      "# Title",
      "",
      `password: ${PAGE_VALUE}`,
      "",
      `password: ${SOURCE_VALUE}`,
    ].join("\n");
    expect(credentialRuleLine(content, "credential.assigned-secret")).toBe(3);
    expect(credentialRuleLine(content, "credential.private-key")).toBeUndefined();
    expect(credentialRuleLine(content, "credential.no-such-rule")).toBeUndefined();
    // A one-line file and a match on the last line.
    expect(credentialRuleLine(`password=${PAGE_VALUE}`, "credential.assigned-secret")).toBe(1);
    expect(
      credentialRuleLine(`# a\n# b\npassword=${PAGE_VALUE}`, "credential.assigned-secret"),
    ).toBe(3);
  });

  it("counts the findings under LIMITATIONS in the run summary, without listing values", () => {
    const findings = [
      {
        code: CREDENTIAL_LIKE_CONTENT,
        location: "docs/page.md:5",
        rule: "credential.assigned-secret",
      },
    ] as const;
    const warning = `credential-like-content: 1 repository file holds text that looks like a credential. DocsFab used it and continued; only its own configured credentials stop a run. The maintainers decide whether it is a real credential. \`docsfab runs show ${RUN_ID}\` lists each path, line, and rule.`;
    const human = formatRunSummary({
      record: savedRecord([...findings], warning),
      recordPath: `/private/state/${RUN_ID}.json`,
      exitCode: 0,
      repositoryPath: "/tmp/repository",
      tty: false,
      reportUnavailableReason: "no retained evaluator report",
    }).join("\n");
    const limitations = human.slice(human.indexOf("LIMITATIONS"));
    expect(human).toContain("LIMITATIONS");
    expect(limitations).toContain(warning);
    // The live summary counts; only `runs show` lists each finding.
    expect(human).not.toContain("CREDENTIAL-LIKE CONTENT");
    expectNoValue(human);
  });

  it("lists every finding in docsfab runs show", async () => {
    const stateDirectory = await roots.create("docsfab-credential-like-content-runs-");
    const findings = [
      {
        code: CREDENTIAL_LIKE_CONTENT,
        location: "docs/page.md:5",
        rule: "credential.assigned-secret",
      },
      {
        code: CREDENTIAL_LIKE_CONTENT,
        location: "request:instruction",
        rule: "credential.assigned-secret",
      },
    ] as const;
    const warning = `credential-like-content: 1 repository file and the request text hold text that looks like a credential. DocsFab used it and continued; only its own configured credentials stop a run. The maintainers decide whether it is a real credential. \`docsfab runs show ${RUN_ID}\` lists each path, line, and rule.`;
    const record = savedRecord([...findings], warning);
    await writeFile(join(stateDirectory, `${RUN_ID}.json`), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => lines.push(String(message ?? ""));
    try {
      await handleRunsCommand(["show", RUN_ID, "--state-dir", stateDirectory]);
    } finally {
      console.log = originalLog;
    }
    const human = lines.join("\n");
    expect(human).toContain("CREDENTIAL-LIKE CONTENT");
    expect(human).toMatch(/^ {2}docs\/page\.md:5 \(credential\.assigned-secret\)$/mu);
    expect(human).toMatch(/^ {2}request:instruction \(credential\.assigned-secret\)$/mu);
    expect(human).toContain(warning);

    lines.length = 0;
    console.log = (message?: unknown) => lines.push(String(message ?? ""));
    try {
      await handleRunsCommand(["show", RUN_ID, "--json", "--state-dir", stateDirectory]);
    } finally {
      console.log = originalLog;
    }
    const shown = decodeRunResultV1(JSON.parse(lines.join("\n")));
    expect(shown.credentialFindings).toEqual(findings);
    expectNoValue(JSON.stringify(shown));
  });

  it("redacts newly configured replay secrets in both views without rewriting the record", async () => {
    const secret = plainConfiguredCredential("metadata-replay");
    const stateDirectory = await roots.create("docsfab-credential-replay-");
    const path = join(stateDirectory, `${RUN_ID}.json`);
    const record = savedRecord(
      [
        {
          code: CREDENTIAL_LIKE_CONTENT,
          location: `docs/${secret}\u202e.md:23`,
          rule: "credential.assigned-secret",
        },
      ],
      "credential-like-content: inspect retained finding metadata.",
    );
    const saved = `${JSON.stringify(record)}\n`;
    await writeFile(path, saved, { mode: 0o600 });
    configureCredential(secret);

    for (const json of [false, true]) {
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => lines.push(String(message ?? ""));
      try {
        await handleRunsCommand([
          "show",
          RUN_ID,
          ...(json ? ["--json"] : []),
          "--state-dir",
          stateDirectory,
        ]);
      } finally {
        console.log = originalLog;
      }
      const text = lines.join("\n");
      expect(text).not.toContain(secret);
      expect(text).not.toContain("\u202e");
      if (json) {
        const shown = decodeRunResultV1(JSON.parse(text));
        expect(shown.credentialFindings).toEqual([
          {
            code: CREDENTIAL_LIKE_CONTENT,
            location: "docs/[REDACTED]\\u202e.md:23",
            rule: "credential.assigned-secret",
          },
        ]);
      } else {
        expect(text).toContain("docs/[REDACTED]\\u202e.md:23 (credential.assigned-secret)");
      }
    }
    expect(await readFile(path, "utf8")).toBe(saved);
  });
});
