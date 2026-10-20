// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReaderTaskAdmissionObservationError,
  observeReaderTaskContextAdmissionV1,
} from "../src/execution/reader-task-admission.js";
import {
  READER_TASK_ADMISSION_FAILURE_KIND,
  createReaderTaskAdmissionFailureV1,
  decodeReaderTaskAdmissionFailure,
  projectReaderTaskAdmissionFailure,
  type ReaderTaskAdmissionFailureV1,
} from "../src/execution/reader-task-admission-failure.js";
import { RepositoryWorkspaceReadError } from "../src/repository/workspace/contracts.js";
import * as trackedRead from "../src/repository/workspace/tracked-read.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { configureCredential } from "./helpers/configured-credential.js";

const roots = temporaryRoots();

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("reader-task admission failure contract", () => {
  it("identifies one missing explicit nomination among 16 readable sources", async () => {
    const repository = await repositoryFixture();
    await mkdir(join(repository, "src"));
    const hints = [];
    for (let index = 0; index < 16; index += 1) {
      const path = `src/module-${String(index).padStart(2, "0")}.ts`;
      await writeFile(join(repository, path), `export const n = ${index};\n`);
      hints.push({ role: "public-contract" as const, path });
    }
    const revision = await commitFixture(repository, "sixteen sources");
    const missing = "src/module-missing.ts";
    hints.push({ role: "public-contract", path: missing });
    const before = await git(repository, ["status", "--porcelain=v1"]);

    const error = await observeRejected({
      repositoryPath: repository,
      observationMode: "workflow-export",
      readerContextInput: readerInput(),
      sourceHints: hints,
    });
    const failure = requireFailure(error);
    expect(error).toMatchObject({
      name: "ReaderTaskAdmissionObservationError",
      code: "evidence-unavailable",
    });
    expect(failure).toMatchObject({
      kind: READER_TASK_ADMISSION_FAILURE_KIND,
      code: "evidence-unavailable",
      phase: "reader-task-admission",
      reason: "not-admitted-at-selected-revision",
      correctiveAction: "replace-rejected-nomination",
      selectedRevision: revision,
      nomination: {
        binding: "explicit-source-hint",
        index: 16,
        role: "public-contract",
        identity: { kind: "repository-relative-path", path: missing },
      },
      effect: {
        scope: "this-admission-attempt",
        workflowStarted: false,
        readerHandoffCreated: false,
      },
    });
    expect(JSON.stringify(failure)).not.toMatch(/nonexistent|does not exist|not found/iu);
    expect(await git(repository, ["status", "--porcelain=v1"])).toBe(before);

    const corrected = await observeReaderTaskContextAdmissionV1({
      repositoryPath: repository,
      observationMode: "workflow-export",
      readerContextInput: readerInput(),
      sourceHints: hints.slice(0, 16),
    });
    expect(corrected.admission.sources.some((source) => source.uri === missing)).toBe(false);
    expect(
      corrected.admission.sources.filter((source) => source.role === "public-contract"),
    ).toHaveLength(16);
  });

  it("treats a renamed path as not admitted at the selected revision", async () => {
    const repository = await repositoryFixture();
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src/legacy.ts"), "export const legacy = true;\n");
    await commitFixture(repository, "legacy");
    await git(repository, ["mv", "src/legacy.ts", "src/current.ts"]);
    await git(repository, ["commit", "--quiet", "-m", "rename"]);

    const failure = requireFailure(
      await observeRejected({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "public-contract", path: "src/legacy.ts" }],
      }),
    );
    expect(failure.reason).toBe("not-admitted-at-selected-revision");
    expect(failure.nomination.identity).toEqual({
      kind: "repository-relative-path",
      path: "src/legacy.ts",
    });
    expect(JSON.stringify(failure)).not.toMatch(/nonexistent|working copy/iu);
  });

  it("does not treat a dirty-only working-tree file as a nonexistent path", async () => {
    const repository = await repositoryFixture();
    const dirty = "src/uncommitted.ts";
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, dirty), "export const dirty = true;\n");
    await access(join(repository, dirty));

    const failure = requireFailure(
      await observeRejected({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "public-contract", path: dirty }],
      }),
    );
    expect(failure.reason).toBe("not-admitted-at-selected-revision");
    expect(failure.nomination.identity).toEqual({
      kind: "repository-relative-path",
      path: dirty,
    });
    expect(JSON.stringify(failure)).not.toMatch(/nonexistent|does not exist/iu);
    await access(join(repository, dirty));
  });

  it("classifies a nominated directory as an unsupported entry kind", async () => {
    const repository = await repositoryFixture();
    const failure = requireFailure(
      await observeRejected({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "current-documentation", path: "docs" }],
      }),
    );
    expect(failure.reason).toBe("unsupported-entry-kind");
    expect(failure.correctiveAction).toBe("nominate-regular-tracked-file");
    expect(failure.nomination).toMatchObject({
      binding: "explicit-source-hint",
      index: 0,
      identity: { kind: "repository-relative-path", path: "docs" },
    });
  });

  it("classifies a nominated symlink as an unsupported entry kind", async () => {
    const repository = await repositoryFixture();
    await symlink("cli.md", join(repository, "docs/link.md"));
    await commitFixture(repository, "symlink");

    const failure = requireFailure(
      await observeRejected({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "current-documentation", path: "docs/link.md" }],
      }),
    );
    expect(failure.reason).toBe("unsupported-entry-kind");
    expect(failure.nomination.identity).toEqual({
      kind: "repository-relative-path",
      path: "docs/link.md",
    });
  });

  it("reports the per-source byte limit for an oversized tracked file", async () => {
    const repository = await repositoryFixture();
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src/large.bin"), Buffer.alloc(1024 * 1024 + 1, 0x78));
    await commitFixture(repository, "oversize");

    const failure = requireFailure(
      await observeRejected({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "public-contract", path: "src/large.bin" }],
      }),
    );
    expect(failure.reason).toBe("exceeded-source-byte-limit");
    expect(failure.correctiveAction).toBe("reduce-source-bytes");
    expect(failure.nomination.identity).toEqual({
      kind: "repository-relative-path",
      path: "src/large.bin",
    });
  });

  it("identifies the nomination that crosses the aggregate byte ceiling", async () => {
    const repository = await repositoryFixture();
    await mkdir(join(repository, "src"));
    const hints = [];
    for (let index = 0; index < 8; index += 1) {
      const path = `src/source-${index}.png`;
      await writeFile(join(repository, path), Buffer.alloc(1024 * 1024, 0x78));
      hints.push({ role: "public-contract" as const, path });
    }
    await commitFixture(repository, "aggregate");

    const failure = requireFailure(
      await observeRejected({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: hints,
      }),
    );
    expect(failure.reason).toBe("exceeded-aggregate-byte-limit");
    expect(failure.nomination).toMatchObject({
      binding: "explicit-source-hint",
      identity: { kind: "repository-relative-path", path: "src/source-7.png" },
    });
  });

  it("maps a changed tracked snapshot to the changed-snapshot reason", async () => {
    const repository = await repositoryFixture();
    const original = trackedRead.readTrackedRepositoryFile;
    vi.spyOn(trackedRead, "readTrackedRepositoryFile").mockImplementation(
      async (workspace, path, maxBytes) => {
        if (path === "docs/cli.md") throw new RepositoryWorkspaceReadError("changed");
        return original(workspace, path, maxBytes);
      },
    );

    const failure = requireFailure(
      await observeRejected({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "current-documentation", path: "docs/cli.md" }],
      }),
    );
    expect(failure.reason).toBe("changed-snapshot");
    expect(failure.correctiveAction).toBe("reobserve-unchanged-snapshot");
  });

  it("maps unknown read failures without leaking host paths or exception text", async () => {
    const repository = await repositoryFixture();
    const leak = "EACCES /Users/example-user/.ssh/id_rsa TOKEN=super-secret";
    const original = trackedRead.readTrackedRepositoryFile;
    vi.spyOn(trackedRead, "readTrackedRepositoryFile").mockImplementation(
      async (workspace, path, maxBytes) => {
        if (path === "docs/cli.md") throw new Error(leak);
        return original(workspace, path, maxBytes);
      },
    );

    const error = await observeRejected({
      repositoryPath: repository,
      observationMode: "workflow-export",
      readerContextInput: readerInput(),
      sourceHints: [{ role: "current-documentation", path: "docs/cli.md" }],
    });
    const failure = requireFailure(error);
    expect(failure.reason).toBe("unknown-read-failure");
    expect(failure.correctiveAction).toBe("none");
    const serialized = JSON.stringify({
      message: error.message,
      failure,
      projected: projectReaderTaskAdmissionFailure(error),
    });
    expect(serialized).not.toContain(leak);
    expect(serialized).not.toContain("/Users/example-user");
    expect(serialized).not.toContain("TOKEN=super-secret");
  });

  it("maps typed read-failed evidence to unknown-read-failure, not a missing file", async () => {
    const repository = await repositoryFixture();
    const original = trackedRead.readTrackedRepositoryFile;
    vi.spyOn(trackedRead, "readTrackedRepositoryFile").mockImplementation(
      async (workspace, path, maxBytes) => {
        if (path === "docs/cli.md") throw new RepositoryWorkspaceReadError("read-failed");
        return original(workspace, path, maxBytes);
      },
    );

    const failure = requireFailure(
      await observeRejected({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "current-documentation", path: "docs/cli.md" }],
      }),
    );
    expect(failure.reason).toBe("unknown-read-failure");
    expect(failure.reason).not.toBe("not-admitted-at-selected-revision");
  });

  it("keeps excluded sources denied and withholds their path", async () => {
    const repository = await repositoryFixture();
    await writeFile(join(repository, ".env"), "TOKEN=tracked-secret\n");
    await git(repository, ["add", "--force", ".env"]);
    await git(repository, ["commit", "--quiet", "-m", "excluded"]);

    const error = await observeRejected({
      repositoryPath: repository,
      observationMode: "workflow-export",
      readerContextInput: readerInput(),
      sourceHints: [{ role: "public-contract", path: ".env" }],
    });
    const failure = requireFailure(error);
    expect(failure.reason).toBe("excluded-or-denied-source");
    expect(failure.correctiveAction).toBe("omit-denied-source");
    expect(failure.nomination.identity).toEqual({
      kind: "opaque-reference",
      reference: "explicit-source-hint:0",
    });
    const serialized = JSON.stringify({ message: error.message, failure });
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("TOKEN=tracked-secret");
  });

  it("rejects configured-credential paths and traversal without leaking or probing outside", async () => {
    const repository = await repositoryFixture();
    const outside = await roots.create("docsfab-outside-");
    const secret = join(outside, "secret.ts");
    await writeFile(secret, "export const leaked = true;\n");
    const tokenPath = `src/${configureCredential(`glpat-${"a".repeat(20)}`)}.ts`;

    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "public-contract", path: tokenPath }],
      }),
    ).rejects.toMatchObject({ code: "credential-material" });
    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "public-contract", path: "../secret.ts" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-value" });
    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: [{ role: "public-contract", path: "/etc/passwd" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-value" });
    await access(secret);
  });

  it("round-trips the bounded projection and refuses extra or private payloads", async () => {
    const repository = await repositoryFixture();
    const error = await observeRejected({
      repositoryPath: repository,
      observationMode: "workflow-export",
      readerContextInput: readerInput(),
      sourceHints: [{ role: "public-contract", path: "src/missing.ts" }],
    });
    const failure = requireFailure(error);
    const wrapped = new Error("wrapper");
    wrapped.cause = error;
    expect(projectReaderTaskAdmissionFailure(wrapped)).toEqual(failure);
    expect(decodeReaderTaskAdmissionFailure(JSON.parse(JSON.stringify(failure)))).toEqual(failure);

    expect(() => decodeReaderTaskAdmissionFailure({ ...failure, retryable: true })).toThrow(
      ReaderTaskAdmissionObservationError,
    );
    expect(() => decodeReaderTaskAdmissionFailure({ ...failure, runId: "forged-run" })).toThrow(
      ReaderTaskAdmissionObservationError,
    );
    expect(() =>
      decodeReaderTaskAdmissionFailure({
        ...failure,
        effect: { ...failure.effect, workflowStarted: true },
      }),
    ).toThrow(ReaderTaskAdmissionObservationError);
    expect(
      projectReaderTaskAdmissionFailure({
        ...failure,
        retryAuthorized: true,
        hostPath: "/Users/example-user/.ssh/id_rsa",
      }),
    ).toBeUndefined();
    expect(() =>
      decodeReaderTaskAdmissionFailure({
        ...failure,
        nomination: {
          ...failure.nomination,
          identity: { kind: "repository-relative-path", path: "/Users/example-user/.ssh/id_rsa" },
        },
      }),
    ).toThrow(ReaderTaskAdmissionObservationError);
  });

  it("keeps coarse-code callers and historical records compatible", async () => {
    const coarse = new ReaderTaskAdmissionObservationError("evidence-unavailable");
    expect(coarse).toMatchObject({
      name: "ReaderTaskAdmissionObservationError",
      code: "evidence-unavailable",
    });
    expect(coarse.message).toBe(
      "Reader task admission observation rejected input: evidence-unavailable.",
    );
    expect(projectReaderTaskAdmissionFailure(coarse)).toBeUndefined();
    expect(() => decodeReaderTaskAdmissionFailure({ code: "evidence-unavailable" })).toThrow(
      ReaderTaskAdmissionObservationError,
    );

    const detailed = createReaderTaskAdmissionFailureV1({
      reason: "not-admitted-at-selected-revision",
      selectedRevision: "a".repeat(40),
      nomination: {
        binding: "explicit-source-hint",
        index: 0,
        role: "public-contract",
        path: "src/missing.ts",
      },
    });
    const thrown = new ReaderTaskAdmissionObservationError("evidence-unavailable", detailed);
    expect(thrown.code).toBe("evidence-unavailable");
    expect(thrown.message).toBe(coarse.message);
    expect(projectReaderTaskAdmissionFailure(thrown)?.nomination.index).toBe(0);
  });

  it("still enforces the source-count cap before repository access", async () => {
    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: join(tmpdir(), "must-not-be-read"),
        observationMode: "selected-checkout",
        readerContextInput: readerInput(),
        sourceHints: Array.from({ length: 128 }, (_, index) => ({
          role: "public-contract" as const,
          path: `src/contract-${index}.ts`,
        })),
      }),
    ).rejects.toEqual(new ReaderTaskAdmissionObservationError("invalid-value"));
  });
});

async function observeRejected(input: {
  repositoryPath: string;
  observationMode: "workflow-export" | "selected-checkout";
  readerContextInput: ReturnType<typeof readerInput>;
  sourceHints: readonly { role: "public-contract" | "current-documentation"; path: string }[];
}): Promise<ReaderTaskAdmissionObservationError> {
  try {
    await observeReaderTaskContextAdmissionV1(input);
  } catch (error) {
    if (error instanceof ReaderTaskAdmissionObservationError) return error;
    throw error;
  }
  throw new Error("expected reader-task admission to reject the nomination");
}

function requireFailure(error: ReaderTaskAdmissionObservationError): ReaderTaskAdmissionFailureV1 {
  const failure = projectReaderTaskAdmissionFailure(error);
  if (!failure) throw new Error("expected a bounded reader-task admission failure projection");
  return failure;
}

async function repositoryFixture(): Promise<string> {
  const repository = await roots.create("docsfab-reader-admission-failure-");
  await initFixtureRepo(repository, { "docs/cli.md": "# CLI\n" });
  return repository;
}

function readerInput() {
  return {
    schema_version: 1 as const,
    target_audience: "developers",
    reader_job: "run one inspection",
    change_scope: ["docs/cli.md"],
    source_priority: ["public contract", "current docs"],
    required_content: ["command", "verification"],
    excluded_content: ["unrelated internals"],
    unresolved_questions: [],
  };
}
