// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLocalUserPublicationPlan } from "../src/delivery/contracts.js";
import { filesystemState } from "../src/delivery/worktree/host.js";
import {
  admitLinuxBubblewrapValidationBackend,
  bindLiveValidationBackendRequest,
  validationIsolationCandidates,
} from "../src/delivery/worktree/validate.js";
import {
  DOCSFAB_VALIDATION_BACKEND_POLICY_V1,
  VALIDATION_BACKEND_CAPABILITY_KIND,
  ValidationBackendError,
  createValidationBackendAttestation,
  createValidationBackendRequest,
  decodeValidationBackendAttestation,
  decodeValidationBackendRequest,
  issueHostSelectedValidationBackend,
  lookupValidationBackend,
  selectHostValidationBackendIdentity,
  validationBackendPolicySha256,
  validationScratchSha256,
} from "../src/delivery/worktree/validation-backend.js";
import type { DeliveryCommandRunner } from "../src/delivery/worktree/types.js";
import { temporaryRoots } from "./helpers/temp.js";

const TREE_A = "a".repeat(64);
const TREE_B = "b".repeat(64);
const SECRET = "glpat-thisIsNotARealGitLabToken12";
const temporaryDirectories = temporaryRoots();

function policy() {
  return {
    limits: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.limits },
    egress: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.egress },
    credentials: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.credentials },
    teardown: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.teardown },
  };
}

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    inputTreeSha256: TREE_A,
    scratchSha256: TREE_B,
    ...policy(),
    ...overrides,
  };
}

function passingRunner(): DeliveryCommandRunner {
  return {
    run: async () => ({ exitCode: 0, stdout: Buffer.alloc(0) }),
  };
}

async function isolationFixture() {
  const root = await temporaryDirectories.create("docsfab-validation-backend-");
  const worktreePath = join(root, "worktree");
  const scratchPath = join(root, "scratch");
  const deniedRoot = join(root, "denied");
  await mkdir(worktreePath);
  await mkdir(scratchPath);
  await mkdir(deniedRoot);
  await writeFile(join(worktreePath, "README.md"), "candidate tree\n");
  const deniedPath = join(deniedRoot, "secret");
  await writeFile(deniedPath, SECRET, { mode: 0o600 });
  return {
    root,
    worktreePath,
    scratchPath,
    deniedRoot,
    deniedPath,
    host: {
      worktreePath,
      scratchPath,
      deniedReadPaths: [deniedPath],
      deniedReadRoots: [deniedRoot],
    },
  };
}

describe("validation backend capability", () => {
  it("selects linux-bubblewrap or darwin-docker-desktop from the host platform and ignores serialized selectors", () => {
    const serialized = {
      plan: { validationBackend: "docker-desktop", validationCommand: "node check.cjs" },
      config: { validationBackend: "docker-desktop" },
      environment: {
        DOCSFAB_VALIDATION_BACKEND: "docker-desktop",
        VALIDATION_BACKEND: "linux-bubblewrap",
      },
      modelOutput: { backend: "docker-desktop", identity: "linux-bubblewrap" },
    };
    expect(selectHostValidationBackendIdentity("linux", serialized)).toBe("linux-bubblewrap");
    expect(selectHostValidationBackendIdentity("darwin", serialized)).toBe("darwin-docker-desktop");
    expect(selectHostValidationBackendIdentity("win32", serialized)).toBeUndefined();
    const linux = issueHostSelectedValidationBackend("linux", serialized);
    expect(linux?.kind).toBe(VALIDATION_BACKEND_CAPABILITY_KIND);
    expect(lookupValidationBackend(linux)?.identity).toBe("linux-bubblewrap");
    const darwin = issueHostSelectedValidationBackend("darwin", serialized);
    expect(darwin?.kind).toBe(VALIDATION_BACKEND_CAPABILITY_KIND);
    expect(lookupValidationBackend(darwin)?.identity).toBe("darwin-docker-desktop");
    expect(issueHostSelectedValidationBackend("win32", serialized)).toBeUndefined();
  });

  it("rejects reconstructed JSON lookalikes as untrusted backends", () => {
    const issued = issueHostSelectedValidationBackend("linux");
    expect(issued).toBeDefined();
    const copied = JSON.parse(JSON.stringify(issued)) as { kind: string };
    expect(copied.kind).toBe(VALIDATION_BACKEND_CAPABILITY_KIND);
    expect(lookupValidationBackend(copied)).toBeUndefined();
    expect(lookupValidationBackend({ kind: VALIDATION_BACKEND_CAPABILITY_KIND })).toBeUndefined();
  });

  it("rejects a publication plan that names a validation backend field", () => {
    expect(() =>
      assertLocalUserPublicationPlan({
        schemaVersion: 1,
        kind: "docsfab-local-user-gitlab-publication-plan",
        validationBackend: "docker-desktop",
      }),
    ).toThrow();
  });
});

describe("validation backend request and attestation", () => {
  it("binds exact input tree, scratch, limits, egress, credentials, and teardown", () => {
    const request = createValidationBackendRequest(requestInput());
    expect(request.kind).toBe("docsfab-validation-backend-request");
    expect(request.inputTreeSha256).toBe(TREE_A);
    expect(request.scratchSha256).toBe(TREE_B);
    expect(request.limits).toEqual(DOCSFAB_VALIDATION_BACKEND_POLICY_V1.limits);
    expect(request.egress.external).toBe("deny");
    expect(request.credentials.hostHome).toBe("deny");
    expect(request.credentials.dockerSocket).toBe("deny");
    expect(request.teardown.descendants).toBe("required");
    expect(decodeValidationBackendRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it("rejects a widened egress or missing teardown binding", () => {
    expect(() =>
      createValidationBackendRequest(
        requestInput({
          egress: { ...policy().egress, external: "allow" },
        }),
      ),
    ).toThrow(ValidationBackendError);
    const { teardown: _teardown, ...missing } = requestInput();
    expect(() => createValidationBackendRequest(missing as never)).toThrow(ValidationBackendError);
  });

  it("records backend identity and digests without secrets or host paths", async () => {
    const fixture = await isolationFixture();
    const request = await bindLiveValidationBackendRequest(fixture.host);
    const admitted = await admitLinuxBubblewrapValidationBackend(
      issueHostSelectedValidationBackend("linux")!,
      request,
      fixture.host,
      passingRunner(),
      fixture.worktreePath,
    );
    const attestation = admitted.attestation;
    expect(attestation.backendIdentity).toBe("linux-bubblewrap");
    expect(attestation.policySha256).toBe(validationBackendPolicySha256());
    expect(attestation.inputTreeSha256).toBe(await filesystemState(fixture.worktreePath));
    expect(attestation.scratchSha256).toBe(await validationScratchSha256(fixture.scratchPath));
    expect(attestation.resultSha256).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(attestation);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(fixture.worktreePath);
    expect(serialized).not.toContain(fixture.scratchPath);
    expect(serialized).not.toContain(fixture.deniedPath);
    expect(decodeValidationBackendAttestation(JSON.parse(serialized))).toEqual(attestation);
    expect(admitted.isolation.commandPrefix).toEqual(
      validationIsolationCandidates(
        "linux",
        [fixture.worktreePath],
        [fixture.scratchPath],
        [fixture.deniedRoot],
      )[0],
    );
  });

  it("rejects a copied attestation that swaps the input-tree digest", async () => {
    const attestation = createValidationBackendAttestation({
      backendIdentity: "linux-bubblewrap",
      policySha256: validationBackendPolicySha256(),
      inputTreeSha256: TREE_A,
      scratchSha256: TREE_B,
      resultSha256: createHash("sha256").update("probe-passed").digest("hex"),
    });
    const tampered = {
      ...JSON.parse(JSON.stringify(attestation)),
      inputTreeSha256: TREE_B,
    };
    expect(() => decodeValidationBackendAttestation(tampered)).toThrow(ValidationBackendError);
  });
});

describe("linux bubblewrap backend boundary", () => {
  it("keeps the existing Linux Bubblewrap argument vector", () => {
    const linux = validationIsolationCandidates(
      "linux",
      ["/tmp/worktree"],
      ["/tmp/validation"],
    )[0]!;
    expect(linux).toEqual([
      "/usr/bin/bwrap",
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
      "--new-session",
      "--tmpfs",
      "/",
      "--ro-bind-try",
      "/usr",
      "/usr",
      "--ro-bind-try",
      "/bin",
      "/bin",
      "--ro-bind-try",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--ro-bind-try",
      "/etc/ld.so.cache",
      "/etc/ld.so.cache",
      "--ro-bind-try",
      "/etc/ssl",
      "/etc/ssl",
      "--ro-bind-try",
      process.execPath,
      process.execPath,
      "--ro-bind-try",
      "/tmp/worktree",
      "/tmp/worktree",
      "--bind",
      "/tmp/validation",
      "/tmp/validation",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--",
    ]);
  });

  it("fails closed when the live input tree does not match the bound digest", async () => {
    const fixture = await isolationFixture();
    const request = createValidationBackendRequest(requestInput());
    await expect(
      admitLinuxBubblewrapValidationBackend(
        issueHostSelectedValidationBackend("linux")!,
        request,
        fixture.host,
        passingRunner(),
        fixture.worktreePath,
      ),
    ).rejects.toMatchObject({ code: "input-tree-mismatch" });
  });

  it("fails closed when a JSON lookalike tries to admit a backend", async () => {
    const fixture = await isolationFixture();
    const request = await bindLiveValidationBackendRequest(fixture.host);
    await expect(
      admitLinuxBubblewrapValidationBackend(
        JSON.parse(JSON.stringify(issueHostSelectedValidationBackend("linux"))) as never,
        request,
        fixture.host,
        passingRunner(),
        fixture.worktreePath,
      ),
    ).rejects.toMatchObject({ code: "untrusted-backend" });
  });
});
