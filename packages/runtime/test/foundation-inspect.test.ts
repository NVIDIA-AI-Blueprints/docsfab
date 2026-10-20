// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { DurableArtifactStore } from "../src/artifacts/index.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import type { ContextPreflightService } from "../src/context/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import {
  FoundationHostOperation,
  FoundationWorkflowOutcomeProjector,
  incompleteFoundationInspectSeed,
  inspectFoundation,
} from "../src/foundation/index.js";
import { sha256 } from "../src/content-ir/canonical.js";
import { buildRunResultV1, decodeRunResultV1 } from "../src/operator/run-result.js";
import { getWorkflow, isWorkflowName, listWorkflows } from "../src/workflow-registry/catalog.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { validModelEnvironment } from "./helpers.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class RejectingHarness implements AgentHarness {
  public calls = 0;
  public async runStep(): Promise<never> {
    this.calls += 1;
    throw new Error("Foundation inspection must not invoke the model harness.");
  }
}

const passedScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

const readyContextPreflight: ContextPreflightService = {
  preflight: async () => ({
    status: "unnecessary",
    reason: "target-not-applicable",
  }),
};

describe("foundation inspection workflow", () => {
  it("registers foundation as a read-only catalog workflow", () => {
    expect(isWorkflowName("foundation")).toBe(true);
    const workflow = getWorkflow("foundation");
    expect(workflow.steps).toHaveLength(1);
    expect(workflow.steps[0]).toMatchObject({
      id: "inspect-foundation",
      kind: "host-operation",
      operation: "foundation",
      mode: "read-only",
    });
    expect(listWorkflows().some((item) => item.name === "foundation")).toBe(false);
  });

  it("inspects an incomplete repository as needs-input without mutation or write tools", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const first = await inspectFoundation({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      ...incompleteFoundationInspectSeed(fixture.revision),
    });
    const second = await inspectFoundation({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      ...incompleteFoundationInspectSeed(fixture.revision),
    });

    expect(first.readiness).toBe("needs-input");
    expect(first.productDisposition).toBe("needs-input");
    expect(first.guarantees).toEqual({
      writeToolsGranted: false,
      hostMutation: false,
      allowWriteRequired: false,
    });
    expect(first.nextQuestions.length).toBeGreaterThan(0);
    expect(first.nextQuestions).toEqual(
      expect.arrayContaining([
        "What authoritative source binds product truth for the current revision?",
        "Who owns documentation accuracy for the current version series?",
      ]),
    );
    expect(first.missingFacts).toContain("registered-evidence-absent");
    expect(first.canon.state).toBe("proposal");
    expect(first.canon.claims).toEqual([]);
    // Artifact-equivalent apart from allowed identity timestamps (none here).
    expect(first.resultSha256).toBe(second.resultSha256);
    expect(first.canon.canonSha256).toBe(second.canon.canonSha256);
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  });

  it("retains general evidence-backed claims without inventing an affected artifact", async () => {
    const fixture = await createIncompleteFixture();
    const proposal = {
      id: "claim-general",
      subjectLabel: "product",
      assertionLabel: "supports operators",
      statementLabel: "The product supports operators.",
      applicabilityLabel: "current version",
      evidenceIds: ["ev-1"],
      confidence: "high" as const,
      verificationStatus: "verified" as const,
    };
    const input = {
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
      inputBinding: { manifestSha256: sha256("manifest"), inputIds: ["input-1"] },
      registeredEvidence: [
        {
          id: "ev-1",
          inputId: "input-1",
          digestSha256: sha256("bytes"),
          strength: "authoritative" as const,
        },
      ],
      claimProposals: [proposal],
    };
    const result = await inspectFoundation(input);
    expect(result.canon.claims[0]?.affectedArtifactIds).toEqual([]);
    // Naming one of the three fields requires the other two, so a half-populated
    // nomination is refused rather than silently dropped.
    await expect(
      inspectFoundation({
        ...input,
        claimProposals: [{ ...proposal, affectedArtifactId: "doc-incomplete" }],
      }),
    ).rejects.toThrow("Foundation inspection rejected: invalid-value.");
  });

  it("rejects claim proposals that invent evidence ids", async () => {
    const fixture = await createIncompleteFixture();
    await expect(
      inspectFoundation({
        repositoryPath: fixture.repository,
        repositoryRevision: fixture.revision,
        inputBinding: {
          manifestSha256: sha256("manifest"),
          inputIds: ["input-1"],
        },
        registeredEvidence: [
          {
            id: "ev-1",
            inputId: "input-1",
            digestSha256: sha256("bytes"),
            strength: "authoritative",
          },
        ],
        claimProposals: [
          {
            id: "claim-1",
            subjectLabel: "subject",
            assertionLabel: "assertion",
            statementLabel: "statement",
            applicabilityLabel: "applicability",
            evidenceIds: ["invented"],
            affectedArtifactId: "doc-1",
            affectedArtifactPath: "docs/guide.md",
            affectedArtifactDigestSha256: sha256("doc"),
            confidence: "high",
            verificationStatus: "verified",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-value" });
  });

  it("runs the host-operation path through WorkflowRunner without harness or writes", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const artifactRoot = await mkdtemp(join(tmpdir(), "docsfab-foundation-artifacts-"));
    roots.push(artifactRoot);
    const harness = new RejectingHarness();
    const hostOperations = new FoundationHostOperation({
      artifactStore: new DurableArtifactStore(artifactRoot),
    });
    const runner = new WorkflowRunner({
      harness,
      hostOperations,
      outcomeProjector: new FoundationWorkflowOutcomeProjector(),
      store: new MemoryStore(),
      repositoryScanner: passedScanner,
      contextPreflight: readyContextPreflight,
      id: () => "foundation-run-1",
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });

    const record = await runner.run({
      workflow: "foundation",
      workspacePath: fixture.repository,
      repository: {
        sourcePath: fixture.repository,
        requestedRevision: "HEAD",
        revision: fixture.revision,
      },
      allowWrite: false,
    });

    expect(harness.calls).toBe(0);
    expect(record.status).toBe("needs-input");
    expect(record.workflowOutcome?.disposition).toBe("needs-input");
    expect(record.steps[0]?.kind).toBe("host-operation");
    expect(record.steps[0]?.operation).toBe("foundation");
    expect(record.steps[0]?.tools).toBeUndefined();
    expect(record.changes).toBeUndefined();

    const result = buildRunResultV1({
      record,
      recordPath: "/private/runs/foundation-run-1.json",
      exitCode: 1,
      repositoryPath: fixture.repository,
    });
    expect(decodeRunResultV1(JSON.parse(JSON.stringify(result))).product.disposition).toBe(
      "needs-input",
    );
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  });

  it("CLI smoke: docsfab run foundation fails closed as unbound", async () => {
    const fixture = await createIncompleteFixture();
    const before = await snapshotTree(fixture.repository);
    const { stdout, stderr, exitCode } = await runDocsFabCli([
      "run",
      "foundation",
      "--repo",
      fixture.repository,
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toMatch(/not bound to a catalog skill/u);
    expect(await snapshotTree(fixture.repository)).toEqual(before);
  }, 60_000);
});

function extractRunResultJson(stdout: string): unknown {
  const kindAt = stdout.lastIndexOf('"kind": "docsfab-run-result"');
  if (kindAt < 0) throw new Error(`RunResultV1 JSON not found in CLI output:\n${stdout}`);
  let depth = 0;
  let start = -1;
  for (let index = kindAt; index >= 0; index -= 1) {
    const character = stdout[index];
    if (character === "}") depth += 1;
    else if (character === "{") {
      if (depth === 0) {
        start = index;
        break;
      }
      depth -= 1;
    }
  }
  if (start < 0) throw new Error(`RunResultV1 object start not found:\n${stdout}`);
  depth = 0;
  for (let index = start; index < stdout.length; index += 1) {
    const character = stdout[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(stdout.slice(start, index + 1));
    }
  }
  throw new Error(`RunResultV1 object end not found:\n${stdout}`);
}

async function createIncompleteFixture(): Promise<{ repository: string; revision: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-foundation-inspect-")));
  roots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository, { recursive: true });
  await writeFile(
    join(repository, "README.md"),
    "# Incomplete golden\n\nNo registered evidence.\n",
  );
  await writeFile(join(repository, "AGENTS.md"), "# Agents\n\nRead-only fixture guidance.\n");

  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "foundation@example.test"], {
    cwd: repository,
  });
  await execFileAsync("git", ["config", "user.name", "Foundation Fixture"], { cwd: repository });
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "incomplete foundation golden"], {
    cwd: repository,
  });
  const revision = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  return { repository, revision };
}

async function snapshotTree(root: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, "status", "--porcelain"]);
  const { stdout: head } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  const readme = await readFile(join(root, "README.md"));
  return createHash("sha256")
    .update(head)
    .update("\0")
    .update(stdout)
    .update("\0")
    .update(readme)
    .digest("hex");
}

async function runDocsFabCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const projectRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...validModelEnvironment,
          PI_OFFLINE: "1",
          CI: "1",
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}
