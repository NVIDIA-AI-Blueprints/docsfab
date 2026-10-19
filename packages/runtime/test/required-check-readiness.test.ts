// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { DockerCheckContainmentError } from "../src/validation/host-containment.js";
import { CheckIsolationUnavailableError } from "../src/workflow-execution/check-isolation-selection.js";
import { probeRequiredCheckReadiness } from "../src/workflow-execution/required-check-readiness.js";
import { materializePilotHead } from "./helpers/documentation-supervision-pilot.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("early repository-required check readiness", () => {
  it("names a missing host backend without executing a required command", async () => {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    const prepareAuthority = vi.fn(async () => {
      throw new CheckIsolationUnavailableError({
        status: "refused",
        refusal: "linux-bubblewrap-unavailable",
        message: "bubblewrap cannot create a user namespace",
      });
    });
    const limitation = await probeRequiredCheckReadiness(workspace, { prepareAuthority });
    expect(prepareAuthority).toHaveBeenCalledOnce();
    expect(limitation).toMatchObject({ code: "required-check-isolation-unavailable" });
    expect(limitation?.nextCommand).toContain("working user namespaces");
  });

  it("leaves readiness unchanged when the isolated authority prepares", async () => {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    const cleanup = vi.fn(async () => undefined);
    const prepareAuthority = vi.fn(async () => ({
      resolve: async () => undefined,
      run: async () => {
        throw new Error("required check must not run during readiness");
      },
      cleanup,
    }));
    expect(await probeRequiredCheckReadiness(workspace, { prepareAuthority })).toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not prepare a check backend for instructions with no required command", async () => {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    await writeFile(join(workspace.path, "AGENTS.md"), "Run tests as needed.\n");
    const prepareAuthority = vi.fn(async () => {
      throw new Error("unexpected probe");
    });
    expect(await probeRequiredCheckReadiness(workspace, { prepareAuthority })).toBeUndefined();
    expect(prepareAuthority).not.toHaveBeenCalled();
  });

  it("reports an ordinary preparation error without exposing its host path", async () => {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    const prepareAuthority = vi.fn(async () => {
      throw new Error("EACCES: mkdtemp /private/tmp/private-operator-path");
    });
    const limitation = await probeRequiredCheckReadiness(workspace, { prepareAuthority });
    expect(limitation).toMatchObject({ code: "required-check-isolation-unavailable" });
    expect(limitation?.explanation).toContain("no repository command ran");
    expect(limitation?.nextCommand).toContain("isolated check executor");
    expect(JSON.stringify(limitation)).not.toContain("private-operator-path");
  });

  it("preserves a broken-containment failure as a hard error", async () => {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    const failure = new DockerCheckContainmentError();
    await expect(
      probeRequiredCheckReadiness(workspace, {
        prepareAuthority: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it("does not hide a failure to clean up an established authority", async () => {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    const failure = new Error("established authority cleanup failed");
    await expect(
      probeRequiredCheckReadiness(workspace, {
        prepareAuthority: async () => ({
          resolve: async () => undefined,
          run: async () => {
            throw new Error("required check must not run during readiness");
          },
          cleanup: async () => {
            throw failure;
          },
        }),
      }),
    ).rejects.toBe(failure);
  });
});
