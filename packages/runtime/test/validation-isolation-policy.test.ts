// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createValidationBackendRequest,
  DOCSFAB_VALIDATION_BACKEND_POLICY_V1,
  issueHostSelectedValidationBackend,
  VALIDATION_BACKEND_CAPABILITY_KIND,
  VALIDATION_BACKEND_IDENTITIES,
} from "../src/delivery/worktree/validation-backend.js";
import { admitHostContainment } from "../src/validation/host-containment.js";
import { NestedSandboxIsolationError } from "../src/delivery/worktree/validate.js";
import {
  resolveValidationIsolationPolicy,
  shouldUseOperatorSupervisedValidationFallback,
} from "../src/delivery/worktree/validation-isolation-policy.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { CHECK_ISOLATION_UNAVAILABLE } from "../src/workflow-execution/check-sandbox.js";
import {
  admitRequiredCheckBackend,
  ATTENDED_WRITE_CONFINEMENT_TIER,
  REQUIRED_CHECK_BACKEND_IDENTITIES,
  requiredCheckIsolationRemedy,
  selectRequiredCheckBackend,
} from "../src/workflow-execution/check-isolation-selection.js";
import {
  hostSelectedCheckAuthority,
  WorkflowChecksHostOperation,
} from "../src/workflow-execution/workflow-checks.js";
import { materializePilotHead } from "./helpers/documentation-supervision-pilot.js";

/** Every process launch in this file, recorded so a direct (unprefixed) check launch is visible. */
const launches: string[][] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record =
    <T extends (...args: never[]) => unknown>(launch: T) =>
    (...args: Parameters<T>) => {
      launches.push([String(args[0]), ...((Array.isArray(args[1]) ? args[1] : []) as string[])]);
      return launch(...args);
    };
  const execFile = Object.assign(record(actual.execFile as never), {
    [promisify.custom]: record(
      (actual.execFile as unknown as Record<symbol, (...args: never[]) => unknown>)[
        promisify.custom
      ]!,
    ),
  });
  return {
    ...actual,
    spawn: record(actual.spawn as never),
    spawnSync: record(actual.spawnSync as never),
    exec: record(actual.exec as never),
    execFile,
    execFileSync: record(actual.execFileSync as never),
  };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  launches.splice(0);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("validation isolation policy", () => {
  it("requires confinement for standing-repo-grant on every execute host", () => {
    expect(
      resolveValidationIsolationPolicy({
        authorityBasis: "standing-repo-grant",
        nestedExecuteHost: false,
      }),
    ).toEqual({
      authorityBasis: "standing-repo-grant",
      nestedExecuteHost: false,
      allowOperatorSupervisedFallback: false,
      requireConfinement: true,
    });
  });

  it("allows operator-supervised fallback for interactive-once on a normal host", () => {
    expect(
      resolveValidationIsolationPolicy({
        authorityBasis: "interactive-once",
        nestedExecuteHost: false,
      }),
    ).toMatchObject({
      allowOperatorSupervisedFallback: true,
      requireConfinement: false,
    });
  });

  it("fails closed for interactive-once inside nested execute hosts", () => {
    expect(
      resolveValidationIsolationPolicy({
        authorityBasis: "interactive-once",
        nestedExecuteHost: true,
      }),
    ).toMatchObject({
      allowOperatorSupervisedFallback: false,
      requireConfinement: true,
    });
  });

  it("rejects standing-repo-grant fallback even when bubblewrap throws a plain Error", () => {
    const policy = resolveValidationIsolationPolicy({
      authorityBasis: "standing-repo-grant",
      nestedExecuteHost: false,
    });
    expect(
      shouldUseOperatorSupervisedValidationFallback(policy, new Error("isolation unavailable")),
    ).toBe(false);
  });

  it("accepts interactive-once fallback for Darwin Docker unavailable outside nested execute", () => {
    const policy = resolveValidationIsolationPolicy({
      authorityBasis: "interactive-once",
      nestedExecuteHost: false,
    });
    expect(
      shouldUseOperatorSupervisedValidationFallback(
        policy,
        new NestedSandboxIsolationError("Docker Desktop validation is unavailable.", true),
      ),
    ).toBe(true);
    expect(
      shouldUseOperatorSupervisedValidationFallback(
        policy,
        new NestedSandboxIsolationError("nested sandbox isolation unavailable"),
      ),
    ).toBe(false);
  });
});

describe("required-check backend selection", () => {
  it("refuses a plain live root before any Docker launch", async () => {
    await expect(
      hostSelectedCheckAuthority("/tmp/live-root", { platform: "darwin" }),
    ).rejects.toMatchObject({
      refusal: "darwin-check-preparation-failed",
    });
    expect(launches).toEqual([]);
  });

  it("refuses the attended policy tier even with a real Docker capability", async () => {
    const backend = issueHostSelectedValidationBackend("darwin")!;
    const policy = DOCSFAB_VALIDATION_BACKEND_POLICY_V1;
    const probe = vi.fn(async () => ({ value: true, commandPrefix: ["docker", "run"] }));
    await expect(
      admitHostContainment({
        backend,
        request: createValidationBackendRequest({
          inputTreeSha256: "a".repeat(64),
          scratchSha256: "b".repeat(64),
          limits: { ...policy.limits },
          egress: { ...policy.egress },
          credentials: { ...policy.credentials },
          teardown: { ...policy.teardown },
        }),
        identity: "darwin-docker-desktop",
        policy: {
          tier: "attended-write",
          readRoots: ["/input"],
          writableRoots: ["/scratch"],
          network: "deny",
          credentials: "deny-host",
          lifetime: "exact-container",
        },
        observeInput: async () => "a".repeat(64),
        observeScratch: async () => "b".repeat(64),
        probe,
      }),
    ).rejects.toMatchObject({ code: "policy-mismatch" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("admits only host-issued check capabilities", () => {
    // Positive control: the host capability is admitted by the same call that refuses the rest.
    expect(admitRequiredCheckBackend(issueHostSelectedValidationBackend("linux"), "linux")).toEqual(
      { status: "selected", identity: "linux-bubblewrap" },
    );
    expect(
      admitRequiredCheckBackend(issueHostSelectedValidationBackend("darwin"), "darwin"),
    ).toEqual({ status: "selected", identity: "darwin-docker-desktop" });
  });

  it("cannot select the attended live-agent tier or a sandbox it returns", () => {
    const attendedSandboxResult = {
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", "(version 1)(allow default)(deny file-write*)"],
      scratch: "/tmp/docsfab-doc-command-fixture",
      cleanup: async () => undefined,
    };
    const lookalike = { kind: VALIDATION_BACKEND_CAPABILITY_KIND, identity: "linux-bubblewrap" };
    for (const candidate of [
      ATTENDED_WRITE_CONFINEMENT_TIER,
      { tier: ATTENDED_WRITE_CONFINEMENT_TIER },
      attendedSandboxResult,
      lookalike,
      JSON.parse(JSON.stringify(issueHostSelectedValidationBackend("linux"))),
    ]) {
      expect(admitRequiredCheckBackend(candidate, "linux")).toMatchObject({
        status: "refused",
        refusal: "untrusted-backend",
      });
    }
    expect(REQUIRED_CHECK_BACKEND_IDENTITIES).not.toContain(ATTENDED_WRITE_CONFINEMENT_TIER);
    expect(VALIDATION_BACKEND_IDENTITIES).not.toContain(ATTENDED_WRITE_CONFINEMENT_TIER);
  });

  it("ignores plan, config, environment, and model values that name a backend", () => {
    const naming = (backend: string) => ({
      plan: { requiredChecks: { backend } },
      config: { validationBackend: backend },
      environment: { DOCSFAB_VALIDATION_BACKEND: backend, PATH: "/tmp/fake-docker-bin" },
      modelOutput: `Run the required checks under ${backend}.`,
    });
    expect(selectRequiredCheckBackend("darwin", naming("linux-bubblewrap"))).toMatchObject({
      status: "selected",
      identity: "darwin-docker-desktop",
    });
    expect(selectRequiredCheckBackend("win32", naming("linux-bubblewrap"))).toMatchObject({
      status: "refused",
      refusal: "platform-unsupported",
    });
    for (const backend of ["darwin-docker-desktop", ATTENDED_WRITE_CONFINEMENT_TIER]) {
      expect(selectRequiredCheckBackend("linux", naming(backend))).toEqual({
        status: "selected",
        identity: "linux-bubblewrap",
      });
    }
  });

  it("derives the remedy from exactly one recognized recorded refusal", () => {
    const generic = requiredCheckIsolationRemedy([]);
    expect(generic).toContain(
      "rerun on a host where the isolated check executor can run the command",
    );
    // The remedy follows a limitation that already names the command to run (#1918).
    expect(generic).not.toContain("run the command yourself");
    expect(requiredCheckIsolationRemedy(["darwin-docker-desktop-unavailable"])).toContain(
      "start Docker Desktop",
    );
    expect(requiredCheckIsolationRemedy(["linux-bubblewrap-unavailable"])).toContain(
      "provide Linux bubblewrap at /usr/bin/bwrap",
    );
    const preparation = requiredCheckIsolationRemedy(["linux-check-preparation-failed"]);
    expect(preparation).toContain("bubblewrap is not the cause");
    expect(preparation).toContain("TMPDIR");
    expect(preparation).not.toContain("/usr/bin/bwrap");
    // Every unavailable check sharing one refusal (two required checks on macOS) keeps it.
    expect(
      requiredCheckIsolationRemedy([
        "darwin-docker-desktop-unavailable",
        "darwin-docker-desktop-unavailable",
      ]),
    ).toContain("start Docker Desktop");
    // Adjacent condition: one check without a recognized refusal (an unsupported
    // check) beside a refused one gets the generic remedy, not the refused one's.
    expect(requiredCheckIsolationRemedy([undefined, "darwin-docker-desktop-unavailable"])).toBe(
      generic,
    );
    // Forged, mixed, or non-string values fall back to the generic remedy.
    expect(requiredCheckIsolationRemedy(["docker-desktop-running"])).toBe(generic);
    expect(requiredCheckIsolationRemedy([{ refusal: "darwin-docker-desktop-unavailable" }])).toBe(
      generic,
    );
    expect(
      requiredCheckIsolationRemedy(["darwin-docker-desktop-unavailable", "platform-unsupported"]),
    ).toBe(generic);
    for (const refusal of [
      "linux-bubblewrap-unavailable",
      "linux-check-preparation-failed",
      "platform-unsupported",
      "untrusted-backend",
    ])
      expect(requiredCheckIsolationRemedy([refusal])).not.toMatch(/docker/iu);
    expect(requiredCheckIsolationRemedy(["darwin-check-preparation-failed"])).toContain(
      "proposed tree",
    );
  });

  it.each([
    ["an operator-supervised fallback error", new NestedSandboxIsolationError("x", true)],
    ["a plain delivery isolation error", new Error("Validation isolation unavailable.")],
  ])("never runs a required check outside the sandbox after %s", async (_name, failure) => {
    // Delivery would fall back to the operator environment for this error; checks must not.
    const interactive = resolveValidationIsolationPolicy({
      authorityBasis: "interactive-once",
      nestedExecuteHost: false,
    });
    expect(shouldUseOperatorSupervisedValidationFallback(interactive, failure)).toBe(true);
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    const prepareSandbox = vi.fn(async () => {
      throw failure;
    });
    launches.splice(0);
    const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority: (path) =>
        hostSelectedCheckAuthority(path, { platform: "linux", prepareSandbox }),
    }).runStep({
      repositoryPath: workspace.path,
      step: {
        id: "lint-documentation",
        title: "Check the documentation",
        skill: "lint-documentation",
        mode: "read-only",
        prompt: "",
      },
      workflow: {
        name: "update-documentation",
        title: "Update",
        outcome: "Update fixture",
        contextPolicy: { schemaVersion: 1, steps: [] },
        steps: [],
      },
    });
    expect(prepareSandbox).toHaveBeenCalledTimes(1);
    // The spy sees every launch in this file; none may be the required check itself.
    expect(launches.filter((argv) => argv.some((part) => /python|unittest/u.test(part)))).toEqual(
      [],
    );
    // An untyped preparation error is attributed to neither bubblewrap nor host
    // preparation: it records the generic reason and no typed refusal.
    const [entry] = JSON.parse(result.summary).checks;
    expect(entry).toMatchObject({
      required: true,
      status: "unavailable",
      reason: CHECK_ISOLATION_UNAVAILABLE,
    });
    expect(entry).not.toHaveProperty("isolationRefusal");
  });
});
