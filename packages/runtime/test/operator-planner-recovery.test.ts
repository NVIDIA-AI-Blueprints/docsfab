// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { handleDoCommand } from "../src/cli/commands/do.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { plannerGovernedInputOutcome } from "../src/evaluation-report/authoring-outcome-projector.js";
import {
  formatOperatorErrorEnvelope,
  sanitizeDisplayText,
  serializeOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import type { RunRecord } from "../src/records/contracts.js";
import { retainedEvidenceBindings } from "../src/records/retained-evidence-bindings.js";
import { createWorkflowOutcome } from "../src/workflow-contracts/outcome.js";
import { temporaryRoots } from "./helpers/temp.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { journeyTestTimeoutMs } from "./support/journey.js";
import {
  createSourceFixture,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";

const roots = temporaryRoots();
const instruction = "Create docs/deployment.md using docs/deploy-notes.txt.";

afterEach(() => {
  process.exitCode = undefined;
});

async function fixture(status: "failed" | "needs-input" = "failed") {
  const root = await mkdtemp(join(tmpdir(), "docsfab-planner-recovery-"));
  roots.track(root);
  const repository = join(root, "repo");
  const stateDirectory = join(root, "state");
  await mkdir(join(repository, "docs"), { recursive: true });
  await mkdir(stateDirectory);
  await writeFile(join(repository, "docs/deploy-notes.txt"), "Deployment source\n");
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "add", "docs/deploy-notes.txt"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const revision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const runId = `planner-recovery-${status}`;
  const record = {
    schemaVersion: 2,
    id: runId,
    workflow: "create-documentation",
    repository: { sourcePath: repository, requestedRevision: revision, revision },
    workspace: { strategy: "tracked-export", disposable: true },
    status,
    instruction,
    createdAt: "2026-10-12T00:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        kind: "evaluate",
        skill: "plan-documentation",
        mode: "read-only",
        status: "needs-input",
        inference: {
          configuredMaxRetries: 0,
          effectiveMaxRetries: 0,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: [],
          replay: "read-only",
          attempts: [
            {
              attempt: 1,
              outcome: "succeeded",
              retryable: false,
              retryScheduled: false,
              durationMs: 1,
            },
          ],
        },
        planDiagnostic: {
          schemaVersion: 1,
          kind: "docsfab-documentation-plan-diagnostic",
          code: "missing-source",
          responseSha256: "a".repeat(64),
          responseShape: "json-object",
        },
      },
    ],
  } as RunRecord;
  if (status === "needs-input") {
    const candidate = plannerGovernedInputOutcome(record);
    if (!candidate) throw new Error("The sealed planner fixture did not produce an outcome.");
    record.workflowOutcome = createWorkflowOutcome(candidate, record);
  }
  await writeFile(join(stateDirectory, `${runId}.json`), JSON.stringify(record));
  return { repository, stateDirectory, revision, runId, record };
}

async function refusal(args: string[], stateDirectory: string) {
  try {
    await handleDoCommand(args, { stateDirectory });
    throw new Error("Expected do to refuse planner continuation.");
  } catch (error) {
    return toOperatorErrorEnvelope(error);
  }
}

async function inRepository<T>(repository: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(repository);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

async function save(item: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(item.stateDirectory, `${item.runId}.json`), JSON.stringify(item.record));
}

it.each(["failed", "needs-input"] as const)(
  "distinguishes an existing %s planner stop and reconstructs its source amendment",
  async (status) => {
    const item = await fixture(status);
    const args = ["--repo", ".", "--continue", item.runId, "--attach", "docs/deploy-notes.txt"];
    const before = await readFile(join(item.stateDirectory, `${item.runId}.json`));
    const result = await inRepository(item.repository, () => refusal(args, item.stateDirectory));
    expect(result.code).toBe("continue-planner-input-unsupported");
    expect(result.message).toContain("planner stage");
    expect(result.nextAction).toContain("docsfab run create-documentation");
    expect(result.nextAction).toContain(`--revision ${item.revision}`);
    expect(result.nextAction).toContain("--source docs/deploy-notes.txt --patch-only");
    expect(result.nextAction).toContain(instruction);
    expect(formatOperatorErrorEnvelope(result)).toContain(`Next action: ${result.nextAction}`);
    expect(JSON.parse(serializeOperatorErrorEnvelope(result)).nextAction).toBe(result.nextAction);
    expect(await readFile(join(item.stateDirectory, `${item.runId}.json`))).toEqual(before);
    expect(await readdir(item.stateDirectory)).toEqual([`${item.runId}.json`]);
  },
);

it(
  "offers a new run at a fresh committed revision when the source appeared after the planner stop",
  async () => {
    const item = await fixture("needs-input");
    const before = await readFile(join(item.stateDirectory, `${item.runId}.json`));
    const source = "docs/new-deploy-notes.txt";
    await writeFile(join(item.repository, source), "New deployment facts\n");
    execFileSync("git", ["-C", item.repository, "add", source]);
    execFileSync("git", [
      "-C",
      item.repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "new source after stop",
    ]);
    const freshRevision = execFileSync("git", ["-C", item.repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const result = await inRepository(item.repository, () =>
      refusal(["--repo", ".", "--continue", item.runId, "--attach", source], item.stateDirectory),
    );
    expect(result.code).toBe("continue-planner-input-unsupported");
    expect(result.message).toContain("planner stage");
    expect(result.nextAction).toContain(`--revision ${freshRevision}`);
    expect(result.nextAction).toContain(`--source ${source} --patch-only`);
    expect(result.nextAction).not.toContain(`--revision ${item.revision}`);
    const namedHead = await inRepository(item.repository, () =>
      refusal(
        ["--repo", ".", "--continue", item.runId, "--attach", source, "--revision", "HEAD"],
        item.stateDirectory,
      ),
    );
    expect(namedHead.nextAction).toBe(result.nextAction);
    const stale = await inRepository(item.repository, () =>
      refusal(
        ["--repo", ".", "--continue", item.runId, "--attach", source, "--revision", item.revision],
        item.stateDirectory,
      ),
    );
    expect(stale.nextAction).toContain("not a regular tracked file at new-run revision");
    expect(stale.nextAction).not.toContain("docsfab run create-documentation");
    expect(await readFile(join(item.stateDirectory, `${item.runId}.json`))).toEqual(before);
  },
  journeyTestTimeoutMs(),
);

it("keeps a nonexistent ID and a foreign repository masked", async () => {
  const item = await fixture();
  const missing = await refusal(
    ["--repo", item.repository, "--continue", "missing-planner"],
    item.stateDirectory,
  );
  const foreign = await refusal(
    ["--repo", join(item.repository, "other"), "--continue", item.runId],
    item.stateDirectory,
  );
  expect(foreign.message).toBe(missing.message.replace("missing-planner", item.runId));
  expect(foreign.code).not.toBe("continue-planner-input-unsupported");
  expect(foreign.nextAction).not.toContain(instruction);
});

it("gives an oversized foreign ID and an absent ID the same refusal and limit warning", async () => {
  const item = await fixture();
  item.record.instruction = "x".repeat(8193);
  await save(item);
  const previousLimit = process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES;
  process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES = "8192";
  const warnings: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    warnings.push(String(chunk));
    return true;
  });
  try {
    const repository = join(item.repository, "other");
    const foreign = await refusal(
      ["--repo", repository, "--continue", item.runId],
      item.stateDirectory,
    );
    const foreignWarnings = warnings.splice(0).join("");
    const missing = await refusal(
      ["--repo", repository, "--continue", "missing-planner"],
      item.stateDirectory,
    );
    expect(foreign.code).toBe(missing.code);
    expect(foreign.message).toBe(missing.message.replace("missing-planner", item.runId));
    expect(foreign.nextAction).toBe(missing.nextAction);
    expect(foreignWarnings).toBe(warnings.join(""));
    expect(foreignWarnings).toContain("WARNING runs-record-max-bytes-bound");
    warnings.length = 0;
    const sameRepository = await refusal(
      ["--repo", item.repository, "--continue", item.runId],
      item.stateDirectory,
    );
    expect(sameRepository.code).toBe(missing.code);
    expect(sameRepository.nextAction).not.toContain("docsfab run create-documentation");
    expect(warnings.join("")).toBe(foreignWarnings);
  } finally {
    stderr.mockRestore();
    if (previousLimit === undefined) delete process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES;
    else process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES = previousLimit;
  }
});

it("replays retained local sources once and refuses an unresolved revision", async () => {
  const item = await fixture();
  item.record.retainedEvidenceBindings = retainedEvidenceBindings({
    sources: [{ path: "docs/deploy-notes.txt", sha256: "a".repeat(64) }],
  });
  await save(item);
  const args = ["--repo", ".", "--continue", item.runId, "--attach", "docs/deploy-notes.txt"];
  const kept = await inRepository(item.repository, () => refusal(args, item.stateDirectory));
  expect(kept.nextAction?.match(/--source /gu)).toHaveLength(1);
  const mismatch = await inRepository(item.repository, () =>
    refusal([...args, "--revision", "f".repeat(40)], item.stateDirectory),
  );
  expect(mismatch.nextAction).toContain("does not resolve to a commit");
  expect(mismatch.nextAction).not.toContain("docsfab run create-documentation");
});

it("refuses a fresh revision that removed a retained source", async () => {
  const item = await fixture("needs-input");
  item.record.retainedEvidenceBindings = retainedEvidenceBindings({
    sources: [{ path: "docs/deploy-notes.txt", sha256: "a".repeat(64) }],
  });
  await save(item);
  const before = await readFile(join(item.stateDirectory, `${item.runId}.json`));
  await writeFile(join(item.repository, "docs/new-notes.txt"), "Replacement source\n");
  execFileSync("git", ["-C", item.repository, "add", "docs/new-notes.txt"]);
  execFileSync("git", ["-C", item.repository, "rm", "-q", "docs/deploy-notes.txt"]);
  execFileSync("git", [
    "-C",
    item.repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "replace retained source",
  ]);
  const result = await inRepository(item.repository, () =>
    refusal(
      ["--repo", ".", "--continue", item.runId, "--attach", "docs/new-notes.txt"],
      item.stateDirectory,
    ),
  );
  expect(result.nextAction).toContain("Source docs/deploy-notes.txt is not a regular tracked file");
  expect(result.nextAction).not.toContain("docsfab run create-documentation");
  expect(await readFile(join(item.stateDirectory, `${item.runId}.json`))).toEqual(before);
});

it("uses a relative symlink alias only from the invocation cwd that resolves to the saved repository", async () => {
  const item = await fixture();
  const alias = join(item.repository, "..", "repo-alias");
  await symlink(item.repository, alias);
  const result = await inRepository(join(item.repository, ".."), () =>
    refusal(
      ["--repo", "repo-alias", "--continue", item.runId, "--attach", "docs/deploy-notes.txt"],
      item.stateDirectory,
    ),
  );
  const candidate = `docsfab run create-documentation --repo repo-alias --revision ${item.revision} --instruction '${instruction}' --source docs/deploy-notes.txt --patch-only`;
  expect(sanitizeDisplayText(candidate)).toBe(candidate);
  expect(result.nextAction).toContain("--repo repo-alias");
  const elsewhere = await refusal(
    ["--repo", item.repository, "--continue", item.runId, "--attach", "docs/deploy-notes.txt"],
    item.stateDirectory,
  );
  expect(elsewhere.nextAction).toContain("use a validated relative --repo path");
  expect(elsewhere.nextAction).not.toContain("docsfab run create-documentation");
});

it("does not recover a planner diagnostic in a malformed saved run", async () => {
  const item = await fixture();
  const args = ["--repo", ".", "--continue", item.runId, "--attach", "docs/deploy-notes.txt"];
  item.record.schemaVersion = 999 as never;
  await save(item);
  const invalidSchema = await inRepository(item.repository, () =>
    refusal(args, item.stateDirectory),
  );
  expect(invalidSchema.message).toContain("No open editorial needs-input run named");
  expect(invalidSchema.nextAction).not.toContain("docsfab run create-documentation");
  item.record.schemaVersion = 2;
  item.record.workspace = { strategy: "tracked-export", disposable: false } as never;
  await save(item);
  const invalidWorkspace = await inRepository(item.repository, () =>
    refusal(args, item.stateDirectory),
  );
  expect(invalidWorkspace.message).toContain("No open editorial needs-input run named");
  expect(invalidWorkspace.nextAction).not.toContain("docsfab run create-documentation");
  item.record.workspace = { strategy: "tracked-export", disposable: true };
  delete (item.record.repository as { requestedRevision?: string }).requestedRevision;
  await save(item);
  const missingRepositoryBinding = await inRepository(item.repository, () =>
    refusal(args, item.stateDirectory),
  );
  expect(missingRepositoryBinding.message).toContain("No open editorial needs-input run named");
  expect(missingRepositoryBinding.nextAction).not.toContain("docsfab run create-documentation");
});

it("accepts a tracked Unicode source path without Git's quoted-path presentation", async () => {
  const item = await fixture();
  const source = "docs/café.md";
  await writeFile(join(item.repository, source), "Café source\n");
  execFileSync("git", ["-C", item.repository, "add", source]);
  execFileSync("git", [
    "-C",
    item.repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "unicode source",
  ]);
  item.record.repository.revision = execFileSync(
    "git",
    ["-C", item.repository, "rev-parse", "HEAD"],
    {
      encoding: "utf8",
    },
  ).trim();
  await save(item);
  const result = await inRepository(item.repository, () =>
    refusal(["--repo", ".", "--continue", item.runId, "--attach", source], item.stateDirectory),
  );
  expect(result.nextAction).toContain(`--source '${source}' --patch-only`);
});

it("keeps unrelated inference failure and malformed retained evidence out of executable recovery", async () => {
  const item = await fixture();
  item.record.steps.push({
    id: "evaluate-document-quality",
    title: "Evaluate",
    kind: "evaluate",
    skill: "evaluate-document-quality",
    mode: "read-only",
    status: "failed",
    inference: { attempts: [{ outcome: "failed" }] } as never,
  });
  await save(item);
  const args = ["--repo", ".", "--continue", item.runId, "--attach", "docs/deploy-notes.txt"];
  const unrelated = await inRepository(item.repository, () => refusal(args, item.stateDirectory));
  expect(unrelated.code).not.toBe("continue-planner-input-unsupported");
  item.record.steps.pop();
  item.record.retainedEvidenceBindings = { sources: "invalid" } as never;
  await save(item);
  const retained = await inRepository(item.repository, () => refusal(args, item.stateDirectory));
  expect(retained.nextAction).toContain("retained source binding is malformed");
  expect(retained.nextAction).not.toContain("docsfab run create-documentation");
});

it.each([
  [
    "reader evidence",
    "readerEvidenceRequest",
    { readerSources: "invalid" },
    "reader or comparison binding is malformed",
  ],
  ["change range", "changeSources", [{ kind: "invalid" }], "retained change binding is malformed"],
  ["release range", "changeSourceRelease", {}, "retained release binding cannot be replayed"],
] as const)(
  "refuses an unsupported %s binding without dropping it",
  async (_label, field, value, reason) => {
    const item = await fixture();
    (item.record as unknown as Record<string, unknown>)[field] = value;
    await save(item);
    const result = await inRepository(item.repository, () =>
      refusal(
        ["--repo", ".", "--continue", item.runId, "--attach", "docs/deploy-notes.txt"],
        item.stateDirectory,
      ),
    );
    expect(result.code).toBe("continue-planner-input-unsupported");
    expect(result.nextAction).toContain(reason);
    expect(result.nextAction).not.toContain("docsfab run create-documentation");
  },
);

it("does not emit planner recovery for a superseded saved run", async () => {
  const item = await fixture();
  const successor = "planner-child-complete";
  await writeFile(
    join(item.stateDirectory, `${successor}.json`),
    JSON.stringify({
      id: successor,
      status: "succeeded",
    }),
  );
  const claims = join(item.stateDirectory, "input-ask-supersession");
  await mkdir(claims);
  await writeFile(
    join(claims, `${item.runId}.1.json`),
    JSON.stringify({
      schemaVersion: 1,
      kind: "docsfab-input-ask-supersession",
      originalRunId: item.runId,
      supersededBy: successor,
      sequence: 1,
    }),
  );
  const result = await inRepository(item.repository, () =>
    refusal(
      ["--repo", ".", "--continue", item.runId, "--attach", "docs/deploy-notes.txt"],
      item.stateDirectory,
    ),
  );
  expect(result.message).toContain("already continued");
  expect(result.nextAction).not.toContain("docsfab run create-documentation");
});

it("requires an actual amendment and reports an untracked nomination", async () => {
  const item = await fixture();
  const base = ["--repo", ".", "--continue", item.runId];
  const noAmendment = await inRepository(item.repository, () => refusal(base, item.stateDirectory));
  expect(noAmendment.code).toBe("continue-planner-input-unsupported");
  expect(noAmendment.nextAction).toContain("Supply an actual reply or a tracked");
  expect(noAmendment.nextAction).not.toContain("docsfab run create-documentation");
  const missingSource = await inRepository(item.repository, () =>
    refusal([...base, "--attach", "docs/missing.txt"], item.stateDirectory),
  );
  expect(missingSource.nextAction).toContain("not a regular tracked file at new-run revision");
  expect(missingSource.nextAction).not.toContain("docsfab run create-documentation");
});

it("refuses malformed current outcomes and retained context without manufacturing a command", async () => {
  const item = await fixture("needs-input");
  item.record.instructionContext = "Private context without a replay locator.";
  await save(item);
  const args = ["--repo", ".", "--continue", item.runId, "--attach", "docs/deploy-notes.txt"];
  const context = await inRepository(item.repository, () => refusal(args, item.stateDirectory));
  expect(context.nextAction).toContain("retained instruction context");
  expect(context.nextAction).not.toContain("docsfab run create-documentation");
  delete item.record.instructionContext;
  item.record.workflowOutcome = {
    ...structuredClone(item.record.workflowOutcome!),
    disposition: "blocked",
  } as typeof item.record.workflowOutcome;
  await save(item);
  const malformed = await inRepository(item.repository, () => refusal(args, item.stateDirectory));
  expect(malformed.code).not.toBe("continue-planner-input-unsupported");
  expect(malformed.nextAction).not.toContain(instruction);
});

it("withholds a configured credential in a reply and shell-quotes an ordinary reply", async () => {
  const item = await fixture();
  const base = ["--repo", ".", "--continue", item.runId];
  const credential = configureCredential(["secret", plantedCredentialValue(151, 24)].join("-"));
  const secret = await inRepository(item.repository, () =>
    refusal([`Use ${credential} now.`, ...base], item.stateDirectory),
  );
  expect(secret.nextAction).toContain("configured credential and was withheld");
  expect(JSON.stringify(secret)).not.toContain(credential);
  const reply = "Use O'Reilly's `guide`; $(touch pwned) is literal.";
  const safe = await inRepository(item.repository, () =>
    refusal([reply, ...base], item.stateDirectory),
  );
  expect(safe.nextAction).toContain("docsfab run create-documentation");
  expect(safe.nextAction).toContain("Operator amendment:");
  expect(safe.nextAction).toContain("'\\''");
  const parsed = execFileSync("sh", ["-c", `set -- ${safe.nextAction}; printf '%s\\0' "$@"`], {
    cwd: item.repository,
  })
    .toString("utf8")
    .split("\0");
  expect(parsed[parsed.indexOf("--instruction") + 1]).toBe(
    `${instruction}\n\nOperator amendment:\n${reply}`,
  );
  expect(await readdir(item.repository)).not.toContain("pwned");
  const spacedReply = "  preserve these spaces  ";
  const spaced = await inRepository(item.repository, () =>
    refusal([spacedReply, ...base], item.stateDirectory),
  );
  const spacedArgs = execFileSync(
    "sh",
    ["-c", `set -- ${spaced.nextAction}; printf '%s\\0' "$@"`],
    {
      cwd: item.repository,
    },
  )
    .toString("utf8")
    .split("\0");
  expect(spacedArgs[spacedArgs.indexOf("--instruction") + 1]).toBe(
    `${instruction}\n\nOperator amendment:\n${spacedReply}`,
  );
});

it("withholds a command when envelope credential-shape redaction would change the saved request", async () => {
  const item = await fixture();
  const shapedCredential = "authorization=abcdefghijklmno";
  item.record.instruction = `${instruction} ${shapedCredential}`;
  await save(item);
  const result = await inRepository(item.repository, () =>
    refusal(
      ["--repo", ".", "--continue", item.runId, "--attach", "docs/deploy-notes.txt"],
      item.stateDirectory,
    ),
  );
  expect(result.code).toBe("continue-planner-input-unsupported");
  expect(result.nextAction).toContain("output protection would change");
  expect(result.nextAction).not.toContain("docsfab run create-documentation");
  expect(JSON.stringify(result)).not.toContain(shapedCredential);
});

it(
  "executes the rendered fresh-revision argv after the source is committed after the stop",
  async () => {
    const stopped = await fixture("needs-input");
    const seeded = await createSourceFixture();
    roots.track(seeded.root);
    stopped.record.repository.sourcePath = seeded.repository;
    stopped.record.repository.revision = seeded.revision;
    stopped.record.repository.requestedRevision = seeded.revision;
    const outcome = plannerGovernedInputOutcome(stopped.record);
    if (!outcome) throw new Error("The bound stopped fixture has no planner outcome.");
    stopped.record.workflowOutcome = createWorkflowOutcome(outcome, stopped.record);
    await save(stopped);
    const parentPath = join(stopped.stateDirectory, `${stopped.runId}.json`);
    const parentBefore = await readFile(parentPath);
    await writeFile(join(seeded.repository, "docs/deploy-notes.txt"), "Deployment source\n");
    execFileSync("git", ["-C", seeded.repository, "add", "docs/deploy-notes.txt"]);
    execFileSync("git", [
      "-C",
      seeded.repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "source committed after planner stop",
    ]);
    const freshRevision = execFileSync("git", ["-C", seeded.repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(freshRevision).not.toBe(seeded.revision);
    const result = await inRepository(seeded.repository, () =>
      refusal(
        ["--repo", ".", "--continue", stopped.runId, "--attach", "docs/deploy-notes.txt"],
        stopped.stateDirectory,
      ),
    );
    expect(result.nextAction).toContain("docsfab run create-documentation");
    const parsed = execFileSync("sh", ["-c", `set -- ${result.nextAction}; printf '%s\\0' "$@"`], {
      cwd: seeded.repository,
    })
      .toString("utf8")
      .split("\0")
      .slice(0, -1);
    expect(parsed).toEqual([
      "docsfab",
      "run",
      "create-documentation",
      "--repo",
      ".",
      "--revision",
      freshRevision,
      "--instruction",
      instruction,
      "--source",
      "docs/deploy-notes.txt",
      "--patch-only",
    ]);
    const request = parseRunArguments(parsed.slice(2));
    const model = new SourceToolHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: ["docs/deploy-notes.txt"],
    });
    const newRun = await executeRunRequest(
      { ...request, repositoryPath: seeded.repository, quiet: true },
      runtimeConfig(join(seeded.root, "amended-state")),
      { silent: true, executionHarness: model, skillResolver },
    );
    expect(newRun?.instruction).toBe(instruction);
    expect(newRun?.repository.revision).toBe(freshRevision);
    expect(newRun?.id).not.toBe(stopped.runId);
    expect(newRun?.retainedEvidenceBindings?.sources?.map((source) => source.path)).toEqual([
      "docs/deploy-notes.txt",
    ]);
    expect(model.calls[0]).toMatchObject({ stepId: "plan-documentation", hasSourceBinding: true });
    expect(await readFile(parentPath)).toEqual(parentBefore);
  },
  journeyTestTimeoutMs(),
);
