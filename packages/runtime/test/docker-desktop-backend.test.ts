// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DARWIN_DOCKER_DESKTOP_BACKEND_IDENTITY,
  DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT,
  DARWIN_DOCKER_DESKTOP_IMAGE,
  DARWIN_DOCKER_DESKTOP_IMAGE_DIGEST,
  DARWIN_DOCKER_DESKTOP_SCRATCH_ROOT,
  DARWIN_DOCKER_DESKTOP_UNAVAILABLE_DIAGNOSTIC,
  assertDarwinDockerDesktopIsolationArgv,
  darwinDockerDesktopHostUser,
  darwinDockerDesktopProbeScript,
  darwinDockerDesktopValidationArgv,
} from "../src/delivery/worktree/docker-desktop-backend.js";
import { filesystemState } from "../src/delivery/worktree/host.js";
import type { DeliveryCommandRunner } from "../src/delivery/worktree/types.js";
import {
  NestedSandboxIsolationError,
  admitDarwinDockerDesktopValidationBackend,
  bindLiveValidationBackendRequest,
  nestedExecuteHostMustStayConfined,
  requireConfinedValidationIsolation,
} from "../src/delivery/worktree/validate.js";
import {
  ValidationBackendError,
  issueHostSelectedValidationBackend,
} from "../src/delivery/worktree/validation-backend.js";
import { internalOnly } from "./helpers/internal-path.js";
import { temporaryRoots } from "./helpers/temp.js";

const SECRET = "glpat-thisIsNotARealGitLabToken12";
const fixtureDir = dirname(fileURLToPath(import.meta.url));
const contractPath = join(
  fixtureDir,
  "fixtures/macos-docker-desktop-validation/isolation-contract.json",
);
const temporaryDirectories = temporaryRoots();
const validationCompose = internalOnly(
  "deploy/compose/docker-desktop-validation.yaml",
  "it pins the internal deployment compose file, which is not exported",
);

async function isolationFixture() {
  const root = await temporaryDirectories.create("docsfab-docker-desktop-backend-");
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

function recordingRunner(
  exitCode = 0,
): DeliveryCommandRunner & { calls: { command: string; args: readonly string[] }[] } {
  const calls: { command: string; args: readonly string[] }[] = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push({ command, args });
      return { exitCode, stdout: Buffer.alloc(0) };
    },
  };
}

describe("darwin docker desktop validation argv", () => {
  it.skipIf(validationCompose.skip)(
    validationCompose.title("names the pinned validation image in the deployment compose file"),
    async () => {
      const compose = await readFile(
        join(fixtureDir, "../../../deploy/compose/docker-desktop-validation.yaml"),
        "utf8",
      );
      expect(compose).toContain(DARWIN_DOCKER_DESKTOP_IMAGE);
    },
  );

  it("pins the digest-bound image and #210 resource, credential, and egress controls", async () => {
    const contract = JSON.parse(await readFile(contractPath, "utf8")) as {
      backendIdentity: string;
      image: string;
      imageDigest: string;
      candidateRoot: string;
      scratchRoot: string;
      requiredFlagValues: Record<string, string>;
      requiredFlags: string[];
      forbiddenTokens: string[];
    };
    const fixture = await isolationFixture();
    const argv = darwinDockerDesktopValidationArgv(fixture.host);
    const rendered = argv.join(" ");
    expect(contract.backendIdentity).toBe(DARWIN_DOCKER_DESKTOP_BACKEND_IDENTITY);
    expect(argv[0]).toBe("docker");
    expect(argv).toContain(DARWIN_DOCKER_DESKTOP_IMAGE);
    expect(contract.image).toBe(DARWIN_DOCKER_DESKTOP_IMAGE);
    expect(contract.imageDigest).toBe(DARWIN_DOCKER_DESKTOP_IMAGE_DIGEST);
    expect(contract.candidateRoot).toBe(DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT);
    expect(contract.scratchRoot).toBe(DARWIN_DOCKER_DESKTOP_SCRATCH_ROOT);
    for (const flag of contract.requiredFlags) expect(argv).toContain(flag);
    for (const [flag, value] of Object.entries(contract.requiredFlagValues)) {
      const index = argv.indexOf(flag);
      expect(argv[index + 1]).toBe(value);
    }
    expect(argv).toContain("--user");
    expect(argv).toContain(
      `${darwinDockerDesktopHostUser().uid}:${darwinDockerDesktopHostUser().gid}`,
    );
    expect(rendered).toContain(`source=${resolve(fixture.worktreePath)}`);
    expect(rendered).toContain(`target=${DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT}`);
    expect(rendered).toContain("readonly");
    expect(rendered).toContain(`source=${resolve(fixture.scratchPath)}`);
    expect(rendered).toContain(`target=${DARWIN_DOCKER_DESKTOP_SCRATCH_ROOT}`);
    for (const token of contract.forbiddenTokens) {
      expect(rendered).not.toContain(token);
    }
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(fixture.deniedPath);
    expect(rendered).not.toContain("--privileged");
    if (homedir() !== fixture.worktreePath && homedir() !== fixture.scratchPath) {
      expect(rendered).not.toContain(`source=${homedir()},`);
    }
    expect(() => assertDarwinDockerDesktopIsolationArgv(argv, fixture.host)).not.toThrow();
  });

  it("rejects a privileged, socket, host-network, or credential-widened argv", async () => {
    const fixture = await isolationFixture();
    const argv = darwinDockerDesktopValidationArgv(fixture.host);
    const imageIndex = argv.indexOf(DARWIN_DOCKER_DESKTOP_IMAGE);
    const option = (...tokens: string[]) => [
      ...argv.slice(0, imageIndex),
      ...tokens,
      ...argv.slice(imageIndex),
    ];
    expect(() =>
      assertDarwinDockerDesktopIsolationArgv(option("--privileged"), fixture.host),
    ).toThrow(ValidationBackendError);
    expect(() =>
      assertDarwinDockerDesktopIsolationArgv(
        option("--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock"),
        fixture.host,
      ),
    ).toThrow(ValidationBackendError);
    const hostNetwork = argv.map((part, index) =>
      argv[index - 1] === "--network" ? "host" : part,
    );
    expect(() => assertDarwinDockerDesktopIsolationArgv(hostNetwork, fixture.host)).toThrow(
      ValidationBackendError,
    );
    expect(() =>
      assertDarwinDockerDesktopIsolationArgv(option("-e", "GITLAB_TOKEN=secret"), fixture.host),
    ).toThrow(ValidationBackendError);
    expect(() =>
      assertDarwinDockerDesktopIsolationArgv(
        option("--mount", `type=bind,source=${fixture.deniedRoot},target=/denied`),
        fixture.host,
      ),
    ).toThrow(ValidationBackendError);
  });

  it("allows repository command flags after the image but rejects Docker volume flags before it", async () => {
    const fixture = await isolationFixture();
    const argv = darwinDockerDesktopValidationArgv(fixture.host);
    const imageIndex = argv.indexOf(DARWIN_DOCKER_DESKTOP_IMAGE);
    expect(imageIndex).toBeGreaterThan(0);
    expect(() =>
      assertDarwinDockerDesktopIsolationArgv(
        [...argv, "python3", "-m", "unittest", "-v"],
        fixture.host,
      ),
    ).not.toThrow();
    expect(() =>
      assertDarwinDockerDesktopIsolationArgv(
        [...argv.slice(0, imageIndex), "-v", "/:/host", ...argv.slice(imageIndex)],
        fixture.host,
      ),
    ).toThrow(ValidationBackendError);
  });

  it("treats private loopback as isolated from host and external connectivity", () => {
    const script = darwinDockerDesktopProbeScript();
    expect(script).toContain("1.1.1.1");
    expect(script).toContain("c.on('connect',()=>{c.destroy();process.exit(1)})");
    expect(script).not.toContain("s.listen(0,'127.0.0.1',()=>{s.close();process.exit(1)})");
  });
});

describe("darwin docker desktop backend admission", () => {
  it("records backend identity and digests without secrets or host paths", async () => {
    const fixture = await isolationFixture();
    const request = await bindLiveValidationBackendRequest(fixture.host);
    const runner = recordingRunner(0);
    const admitted = await admitDarwinDockerDesktopValidationBackend(
      issueHostSelectedValidationBackend("darwin")!,
      request,
      fixture.host,
      runner,
      fixture.worktreePath,
    );
    expect(admitted.attestation.backendIdentity).toBe(DARWIN_DOCKER_DESKTOP_BACKEND_IDENTITY);
    expect(admitted.attestation.inputTreeSha256).toBe(await filesystemState(fixture.worktreePath));
    const serialized = JSON.stringify(admitted.attestation);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(fixture.worktreePath);
    expect(serialized).not.toContain(fixture.scratchPath);
    expect(serialized).not.toContain(fixture.deniedPath);
    expect(admitted.isolation.commandPrefix).toEqual(
      darwinDockerDesktopValidationArgv(fixture.host),
    );
    expect(runner.calls[0]?.command).toBe("docker");
    expect(runner.calls[0]?.args.join(" ")).toContain(DARWIN_DOCKER_DESKTOP_IMAGE);
    expect(runner.calls[0]?.args).toContain("node");
    expect(runner.calls[0]?.args).toContain(darwinDockerDesktopProbeScript());
  });

  it("fails closed when the live input tree does not match the bound digest", async () => {
    const fixture = await isolationFixture();
    const request = await bindLiveValidationBackendRequest(fixture.host);
    await writeFile(join(fixture.worktreePath, "README.md"), "mutated tree\n");
    await expect(
      admitDarwinDockerDesktopValidationBackend(
        issueHostSelectedValidationBackend("darwin")!,
        request,
        fixture.host,
        recordingRunner(0),
        fixture.worktreePath,
      ),
    ).rejects.toMatchObject({ code: "input-tree-mismatch" });
  });

  it("fails closed when a JSON lookalike tries to admit a backend", async () => {
    const fixture = await isolationFixture();
    const request = await bindLiveValidationBackendRequest(fixture.host);
    await expect(
      admitDarwinDockerDesktopValidationBackend(
        JSON.parse(JSON.stringify(issueHostSelectedValidationBackend("darwin"))) as never,
        request,
        fixture.host,
        recordingRunner(0),
        fixture.worktreePath,
      ),
    ).rejects.toMatchObject({ code: "untrusted-backend" });
  });

  it("returns backend-unavailable when Docker Desktop does not admit the probe", async () => {
    const fixture = await isolationFixture();
    const request = await bindLiveValidationBackendRequest(fixture.host);
    await expect(
      admitDarwinDockerDesktopValidationBackend(
        issueHostSelectedValidationBackend("darwin")!,
        request,
        fixture.host,
        recordingRunner(1),
        fixture.worktreePath,
      ),
    ).rejects.toMatchObject({ code: "backend-unavailable" });
  });
});

describe("darwin docker desktop isolation seam", () => {
  it("returns one actionable diagnostic when Docker Desktop is unavailable", async () => {
    if (process.platform !== "darwin") return;
    const fixture = await isolationFixture();
    const runner = recordingRunner(1);
    await expect(
      requireConfinedValidationIsolation(fixture.host, runner, fixture.worktreePath),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof NestedSandboxIsolationError &&
        error.message === DARWIN_DOCKER_DESKTOP_UNAVAILABLE_DIAGNOSTIC &&
        error.allowOperatorSupervisedFallback === !nestedExecuteHostMustStayConfined()
      );
    });
    expect(runner.calls[0]?.command).toBe("docker");
  });

  it("does not construct a bubblewrap candidate for the docker desktop argv", () => {
    const argv = darwinDockerDesktopValidationArgv({
      worktreePath: "/tmp/worktree",
      scratchPath: "/tmp/scratch",
    });
    expect(argv[0]).toBe("docker");
    expect(argv).not.toContain("/usr/bin/bwrap");
    expect(issueHostSelectedValidationBackend("linux")!.kind).toBeDefined();
  });
});
