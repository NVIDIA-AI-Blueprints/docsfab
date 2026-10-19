// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { access, chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import {
  READER_SOURCE_NOMINATIONS_LIMIT,
  ReaderTaskAdmissionObservationError,
  observeReaderTaskContextAdmissionV1,
} from "../src/execution/reader-task-admission.js";
import { conservativeReaderContextInput } from "../src/execution/task-context.js";
import {
  assertHostRuntimeReaderEvidenceNominations,
  sealHostRuntimeReaderEvidencePolicy,
} from "../src/host-invoker/contracts.js";
import { RepositoryConfigurationRefusalError } from "../src/repository/workspace/configuration-refusal.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

const roots = temporaryRoots();

describe("reader task admission resource and Git boundaries", () => {
  it("admits a new tracked root and root configuration from the selected immutable comparison", async () => {
    const repository = await repositoryFixture();
    const base = await git(repository, ["rev-parse", "HEAD"]);
    await mkdir(join(repository, "new-root"));
    await writeFile(join(repository, "new-root", "api.ts"), "export const behavior = 'new';\n");
    await writeFile(
      join(repository, "AGENTS.md"),
      "Use tracked evidence and preserve reader intent.\n",
    );
    await writeFile(join(repository, "project.json"), '{"behavior":"new"}\n');
    const head = await commitFixture(repository, "new root and configuration");
    const requestText = "Explain the actual changed public contract. ".repeat(150);
    const readerContextInput = conservativeReaderContextInput({
      instruction: requestText,
      changeScope: ["docs/cli.md"],
    });
    const policy = sealHostRuntimeReaderEvidencePolicy({
      schemaVersion: 2,
      workflow: "update-documentation",
      sourceRoles: [
        "public-contract",
        "changed-source",
        "current-documentation",
        "repository-instruction",
        "accepted-knowledge",
        "request",
      ],
      readScope: "bound-tracked-repository",
      maximumSourceNominations: 128,
    });
    const observed = await observeReaderTaskContextAdmissionV1({
      repositoryPath: repository,
      revision: head,
      observationMode: "workflow-export",
      readerContextInput,
      requestText,
      comparisonRequest: { kind: "base-head", baseRevision: base, headRevision: head },
      sourceHints: [{ role: "public-contract", path: "new-root/api.ts" }],
      requireCompleteChangedSources: true,
      admitNominations: (nominations) =>
        assertHostRuntimeReaderEvidenceNominations(policy, nominations),
    });
    expect(observed.admission.admittedRevision).toBe(head);
    expect(observed.admission.sources.map((source) => source.uri)).toEqual(
      expect.arrayContaining([
        "new-root/api.ts",
        "project.json",
        "AGENTS.md",
        "docs/cli.md",
        "request:instruction",
      ]),
    );
    const request = observed.sourceBytes.find(
      (entry) => entry.source.uri === "request:instruction",
    );
    expect(Buffer.from(request!.bytes).toString()).toBe(requestText);
    expect(readerContextInput.reader_job).not.toBe(requestText);
  });

  it("admits authorization source references and credential-like literals, and rejects a configured credential", async () => {
    const repository = await repositoryFixture();
    const path = "src/publication.ts";
    const source = [
      "const preparationAuthorization = preparePublication();",
      "const receipt = createReceipt({ authorization: preparationAuthorization });",
      'const authorization = authorizeLocalUserPublication({ command: "publish" });',
      "function validate(authorization: LocalUserPublicationAuthorizationV1): void {}",
    ].join("\n");
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, path), source);
    await commitFixture(repository, "publication source");
    const request = {
      repositoryPath: repository,
      observationMode: "workflow-export" as const,
      readerContextInput: readerInput(),
      sourceHints: [{ role: "public-contract" as const, path }],
    };
    const observed = await observeReaderTaskContextAdmissionV1(request);
    const admitted = observed.sourceBytes.find((entry) => entry.source.uri === path);
    expect(Buffer.from(admitted!.bytes).toString()).toBe(source);
    const literal = ["Zq8v", "N3pL", "5tR7", "wX9y", "B2cD", "4fG6"].join("");
    await writeFile(join(repository, path), `${source}\nconst password = "${literal}";`);
    await commitFixture(repository, "synthetic credential fixture");
    // A credential-like literal is admitted and becomes a finding (#1807).
    const shaped = await observeReaderTaskContextAdmissionV1(request);
    expect(shaped.sourceBytes.some((entry) => entry.source.uri === path)).toBe(true);
    configureCredential(literal);
    await expect(observeReaderTaskContextAdmissionV1(request)).rejects.toThrow(
      "credential-material",
    );
  });

  it("continues with valid evidence when an interactive caller records a missing source", async () => {
    const repository = await repositoryFixture();
    const missing: string[] = [];
    const observed = await observeReaderTaskContextAdmissionV1({
      repositoryPath: repository,
      observationMode: "workflow-export",
      readerContextInput: readerInput(),
      sourceHints: [{ role: "public-contract", path: "src/missing.ts" }],
      onMissingSource: (source) => missing.push(source.path),
    });
    expect(missing).toEqual(["src/missing.ts"]);
    expect(observed.admission.sources.map((source) => source.uri)).toEqual(["docs/cli.md"]);
    expect(Buffer.from(observed.sourceBytes[0]!.bytes).toString()).toBe("# CLI\n");
  });

  it.each([false, true])(
    "keeps strict evidence admission for required sources (%s)",
    async (hosted) => {
      const repository = await repositoryFixture();
      const missing: string[] = [];
      await expect(
        observeReaderTaskContextAdmissionV1({
          repositoryPath: repository,
          observationMode: "workflow-export",
          readerContextInput: readerInput(),
          sourceHints: [{ role: "changed-source", path: "src/missing.ts" }],
          ...(hosted
            ? {
                requireCompleteChangedSources: true,
                onMissingSource: (source: { path: string }) => missing.push(source.path),
              }
            : {}),
        }),
      ).rejects.toThrow("evidence-unavailable");
      expect(missing).toEqual([]);
    },
  );

  it("does not report an evidence admission when every nominated file is missing", async () => {
    const repository = await repositoryFixture();
    const missing: string[] = [];
    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: { ...readerInput(), change_scope: ["src/missing.ts"] },
        sourceHints: [{ role: "public-contract", path: "src/missing.ts" }],
        onMissingSource: (source) => missing.push(source.path),
      }),
    ).rejects.toThrow("evidence-unavailable");
    expect(missing).toEqual(["src/missing.ts"]);
  });

  it.each(["secret", "symlink", "oversize"])(
    "does not downgrade %s evidence failures to missing files",
    async (kind) => {
      const literal = ["Hm2k", "Rt8w", "Q4zx", "L7vp", "N9cs", "J3db"].join("");
      if (kind === "secret") configureCredential(literal);
      const repository = await repositoryFixture();
      const path = "docs/source.md";
      if (kind === "symlink") await symlink("cli.md", join(repository, path));
      else
        await writeFile(
          join(repository, path),
          kind === "secret" ? `api_key=${literal}\n` : Buffer.alloc(1024 * 1024 + 1, 0x78),
        );
      await commitFixture(repository, "source boundary");
      const missing: string[] = [];
      await expect(
        observeReaderTaskContextAdmissionV1({
          repositoryPath: repository,
          observationMode: "workflow-export",
          readerContextInput: readerInput(),
          sourceHints: [{ role: "public-contract", path }],
          onMissingSource: (source) => missing.push(source.path),
        }),
      ).rejects.toThrow(kind === "secret" ? "credential-material" : "evidence-unavailable");
      expect(missing).toEqual([]);
    },
  );

  it("disables a repository fsmonitor before selected-checkout status", async () => {
    const repository = await repositoryFixture();
    const control = await roots.create("docsfab-reader-monitor-");
    const marker = join(control, "fsmonitor-called");
    const monitor = join(control, "fsmonitor.sh");
    await writeFile(monitor, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 });
    await chmod(monitor, 0o700);
    await git(repository, ["config", "core.fsmonitor", monitor]);

    // A reachability pin, not a vocabulary pin: what this file proves is that
    // reader admission reaches the coded refusal, so it asserts the class, the
    // family and one short anchor. The sentences are proved by the hand-written
    // substrings in `test/workspace.test.ts`.
    const caught = await observeReaderTaskContextAdmissionV1({
      repositoryPath: repository,
      observationMode: "selected-checkout",
      readerContextInput: readerInput(),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(RepositoryConfigurationRefusalError);
    expect((caught as RepositoryConfigurationRefusalError).code).toBe("filesystem-monitor");
    expect((caught as RepositoryConfigurationRefusalError).message).toContain(
      "sets core.fsmonitor",
    );
    await expect(access(marker)).rejects.toThrow();
  });

  it("rejects more than 128 nominated sources before touching the repository", async () => {
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

  it("counts the repository instruction against the nomination bound", async () => {
    const repository = await repositoryFixture();
    await writeFile(join(repository, "AGENTS.md"), "Use tracked evidence.\n");
    await commitFixture(repository, "repository instruction");
    const bound = limit(READER_SOURCE_NOMINATIONS_LIMIT).value;
    // change_scope names one page; explicit hints fill the rest, and AGENTS.md adds one more.
    const admit = (explicit: number, missing: string[]) =>
      observeReaderTaskContextAdmissionV1({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: Array.from({ length: explicit }, (_, index) => ({
          role: "public-contract" as const,
          path: `src/contract-${index}.ts`,
        })),
        onMissingSource: (source) => missing.push(source.path),
      });

    // Adjacent: at the bound with the instruction counted, admission reads on.
    const missing: string[] = [];
    const admitted = await admit(bound - 2, missing);
    expect(missing).toHaveLength(bound - 2);
    expect(admitted.admission.sources.map((source) => source.uri).sort()).toEqual([
      "AGENTS.md",
      "docs/cli.md",
    ]);

    // One past it only because of the instruction: refused before any source is read.
    const unread: string[] = [];
    await expect(admit(bound - 1, unread)).rejects.toEqual(
      new ReaderTaskAdmissionObservationError("invalid-value"),
    );
    expect(unread).toEqual([]);
  });

  it("stops retained source bytes at the 8 MiB aggregate ceiling", async () => {
    const repository = await repositoryFixture();
    await mkdir(join(repository, "src"));
    const hints = [];
    for (let index = 0; index < 8; index += 1) {
      const path = `src/source-${index}.png`;
      await writeFile(join(repository, path), Buffer.alloc(1024 * 1024, 0x78));
      hints.push({ role: "public-contract" as const, path });
    }
    await commitFixture(repository, "large sources");

    await expect(
      observeReaderTaskContextAdmissionV1({
        repositoryPath: repository,
        observationMode: "workflow-export",
        readerContextInput: readerInput(),
        sourceHints: hints,
      }),
    ).rejects.toMatchObject({
      name: "ReaderTaskAdmissionObservationError",
      code: "evidence-unavailable",
    });
  });
});

async function repositoryFixture(): Promise<string> {
  const repository = await roots.create("docsfab-reader-admission-");
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
