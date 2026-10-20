// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  INVOCATION_COMPATIBILITY_CASES,
  InvocationContractError,
  invocationHostCapabilitiesFixture,
  invocationResolveRequestFixture,
  invocationRuntimeBindingFixture,
  resolveInvocationContract,
} from "../src/execution/invocation-contracts.js";
import { CatalogSkillCrateResolver } from "../src/skills/catalog-crate-resolver.js";
import { verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import {
  decodeSkillInvocationMetadata,
  INVOCATION_CONTRACT_SKILL_IDS,
  INVOCATION_METADATA_FILE,
  InvocationMetadataError,
  loadVerifiedInvocationMetadata,
  selectSkillInvocationProfile,
} from "../src/skills/invocation-metadata.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/invocation-contracts",
);
const readTools = ["read", "grep", "find", "ls"] as const;
const writeTools = [...readTools, "edit", "write"] as const;

function toolsFor(skillId: string): readonly string[] {
  return skillId === "write-documentation" || skillId === "repo-bootstrap" ? writeTools : readTools;
}

async function copiedCrate(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "docsfab-invocation-crate-"));
  const destination = resolve(root, "skill-crate");
  await cp(skillCrateDirectory, destination, { recursive: true });
  return destination;
}

async function verifiedSkill(skillId: string, crate = skillCrateDirectory) {
  return verifyCatalogSkill({
    skillCrateDirectory: crate,
    skillId,
    grantedTools: toolsFor(skillId),
  });
}

describe("invocation contracts", () => {
  it("loads ordinary guidance and supporting-reference profiles from the verified crate", async () => {
    const metadata = await loadVerifiedInvocationMetadata(
      await verifiedSkill("write-documentation"),
    );
    expect(metadata.skillId).toBe("write-documentation");
    const guidance = selectSkillInvocationProfile(metadata, { operation: "load-guidance" });
    const resolved = resolveInvocationContract(
      invocationResolveRequestFixture(guidance, {
        binding: invocationRuntimeBindingFixture({ skillId: "write-documentation" }),
      }),
    );
    expect(resolved.contextPhase).toBe("absent");
    expect(resolved.immediateToolResultKind).toBe("instructions-loaded");
    expect(resolved.applicationResultKind).toBe("none");
    expect(resolved.hostRequirements).toEqual(["verified-crate"]);
    expect(resolved.metadataIsGrant).toBe(false);

    const reference = selectSkillInvocationProfile(metadata, {
      operation: "load-supporting-reference",
    });
    expect(
      resolveInvocationContract(invocationResolveRequestFixture(reference)).immediateToolResultKind,
    ).toBe("reference-loaded");
  });

  it("resolves input-phase and completed-phase profiles independently from generated descriptors", async () => {
    for (const testCase of INVOCATION_COMPATIBILITY_CASES) {
      const metadata = await loadVerifiedInvocationMetadata(await verifiedSkill(testCase.skillId));
      const profile = selectSkillInvocationProfile(metadata, {
        operation: testCase.operation,
        profileId: testCase.profileId,
      });
      const resolved = resolveInvocationContract(
        invocationResolveRequestFixture(profile, {
          callerFields: [...testCase.callerFields],
          binding:
            "binding" in testCase
              ? invocationRuntimeBindingFixture(testCase.binding)
              : invocationRuntimeBindingFixture({ profileId: testCase.profileId }),
        }),
      );
      expect(resolved.contextPhase, testCase.id).toBe(testCase.expected.contextPhase);
      expect(resolved.immediateToolResultKind, testCase.id).toBe(
        testCase.expected.immediateToolResultKind,
      );
      expect(resolved.applicationResultKind, testCase.id).toBe(
        testCase.expected.applicationResultKind,
      );
    }
  });

  it("rejects writer and reference reader fields before work starts", async () => {
    const metadata = await loadVerifiedInvocationMetadata(
      await verifiedSkill("write-documentation"),
    );
    const guidance = selectSkillInvocationProfile(metadata, { operation: "load-guidance" });
    try {
      resolveInvocationContract(
        invocationResolveRequestFixture(guidance, { callerFields: ["readerContext"] }),
      );
      expect.unreachable("writer reader fields must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(InvocationContractError);
      expect((error as InvocationContractError).code).toBe("unsupported-context");
      expect((error as InvocationContractError).recovery).toBe("retry-load-without-reader-fields");
      expect((error as InvocationContractError).fields).toEqual(["readerContext"]);
    }

    const reference = selectSkillInvocationProfile(metadata, {
      operation: "load-supporting-reference",
    });
    expect(() =>
      resolveInvocationContract(
        invocationResolveRequestFixture(reference, { callerFields: ["readerContext"] }),
      ),
    ).toThrow(InvocationContractError);
  });

  it("requires read-only observation capability for direct reader assessment", async () => {
    const metadata = await loadVerifiedInvocationMetadata(
      await verifiedSkill("plan-documentation"),
    );
    const profile = selectSkillInvocationProfile(metadata, {
      operation: "load-reader-assessment-guidance",
    });
    const binding = invocationRuntimeBindingFixture({
      profileId: "direct-reader-assessment",
      restrictions: { requireReadOnly: true, requireObservationSupplier: true },
    });

    try {
      resolveInvocationContract(
        invocationResolveRequestFixture(profile, {
          callerFields: ["readerContext"],
          binding,
          capabilities: invocationHostCapabilitiesFixture({ observationSupplierAvailable: false }),
        }),
      );
      expect.unreachable("missing supplier must fail closed");
    } catch (error) {
      expect((error as InvocationContractError).code).toBe("missing-host-capability");
      expect((error as InvocationContractError).recovery).toBe("retry-when-supplier-available");
    }

    try {
      resolveInvocationContract(
        invocationResolveRequestFixture(profile, {
          callerFields: ["readerContext"],
          binding,
          capabilities: invocationHostCapabilitiesFixture({ allowWrite: true }),
        }),
      );
      expect.unreachable("write mode must fail closed");
    } catch (error) {
      expect((error as InvocationContractError).code).toBe("incompatible-binding");
      expect((error as InvocationContractError).recovery).toBe("retry-in-read-only-session");
    }

    try {
      resolveInvocationContract(
        invocationResolveRequestFixture(profile, {
          callerFields: [],
          binding,
        }),
      );
      expect.unreachable("missing readerContext must fail closed");
    } catch (error) {
      expect((error as InvocationContractError).code).toBe("required-context");
    }
  });

  it("rejects unknown versions, missing files, and tampered metadata", async () => {
    const unknown = JSON.parse(
      readFileSync(resolve(fixtureRoot, "unknown-version.json"), "utf8"),
    ) as unknown;
    expect(() => decodeSkillInvocationMetadata(unknown)).toThrow(InvocationMetadataError);
    try {
      decodeSkillInvocationMetadata(unknown);
    } catch (error) {
      expect((error as InvocationMetadataError).code).toBe("unknown-version");
    }

    const valid = JSON.parse(
      readFileSync(resolve(fixtureRoot, "valid-metadata.json"), "utf8"),
    ) as unknown;
    expect(decodeSkillInvocationMetadata(valid).skillId).toBe("write-documentation");

    await expect(verifiedSkill("derive-source-obligations")).rejects.toMatchObject({
      name: "CatalogSkillCrateError",
      code: "invalid-lock",
    });

    const crate = await copiedCrate();
    const verified = await verifiedSkill("write-documentation", crate);
    await writeFile(
      resolve(verified.directory, INVOCATION_METADATA_FILE),
      `${JSON.stringify({ schemaVersion: 1, skillId: "write-documentation", profiles: [] })}\n`,
    );
    await expect(loadVerifiedInvocationMetadata(verified)).rejects.toMatchObject({
      code: "tampered",
    });
  });

  it("rejects phase mismatch and unknown operations without scanning packages/skills", async () => {
    const metadata = await loadVerifiedInvocationMetadata(
      await verifiedSkill("write-documentation"),
    );
    const profile = selectSkillInvocationProfile(metadata, {
      profileId: "workflow-step-completed-reader-context",
      operation: "execute-workflow-step",
    });
    expect(() =>
      resolveInvocationContract(
        invocationResolveRequestFixture(profile, {
          binding: invocationRuntimeBindingFixture({
            kind: "workflow-step",
            profileId: profile.id,
            expectedContextPhase: "reader-input",
          }),
        }),
      ),
    ).toThrowError(InvocationContractError);

    expect(() =>
      resolveInvocationContract(
        invocationResolveRequestFixture(profile, { operation: "load-guidance" }),
      ),
    ).toThrowError(InvocationContractError);

    const resolver = new CatalogSkillCrateResolver(skillCrateDirectory);
    for (const skillId of INVOCATION_CONTRACT_SKILL_IDS) {
      const loaded = await resolver.resolveInvocationMetadata({
        step: {
          skill: skillId,
          mode:
            skillId === "write-documentation" || skillId === "repo-bootstrap"
              ? "write"
              : "read-only",
          kind: "inference",
        },
      } as never);
      expect(loaded.skillId).toBe(skillId);
      expect(loaded.profiles.length).toBeGreaterThan(0);
    }
  });

  it("does not treat metadata as a grant when the crate is unverified", () => {
    const profile = decodeSkillInvocationMetadata(
      JSON.parse(readFileSync(resolve(fixtureRoot, "valid-metadata.json"), "utf8")) as unknown,
    ).profiles[0];
    expect(profile).toBeDefined();
    if (!profile) throw new Error("expected independent valid metadata fixture");
    expect(() =>
      resolveInvocationContract(
        invocationResolveRequestFixture(profile, {
          capabilities: invocationHostCapabilitiesFixture({ crateVerified: false }),
        }),
      ),
    ).toThrowError(InvocationContractError);
  });
});
