// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  approveModelProfile,
  decodeModelProfileApprovalBundle,
  decodeModelProfileApprovalBundleAtCreation,
  ModelProfileApprovalError,
  projectModelProfileApprovalBundle,
  serializeModelProfileApprovalBundle,
  type ModelProfileApprovalBundleV1,
} from "../src/model/profile-approval.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  applyProfileConfiguration,
  prepareProfileApply,
  ProfileApplyError,
} from "../src/model/profile-apply.js";
import * as credentialScanner from "../src/security/repository-scanner.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { initFixtureRepo } from "./helpers/git.js";
import { validModelEnvironment } from "./helpers.js";
import {
  PROFILE_APPROVAL_NOW as NOW,
  profileApprovalFixture as approvalFixture,
} from "./profile-approval-fixture.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
const HUB_ORIGIN = new URL(HUB_BASE_URL).origin;

describe("model profile approval", () => {
  it("binds the exact policy-v2 proposal and signs a v2 runtime projection", async () => {
    const fixture = await approvalFixture();
    const bundle = approveModelProfile(fixture.input);

    expect(bundle).toMatchObject({
      purpose: "policy",
      inspectionSha256: fixture.report.sha256,
      proposalSha256: fixture.proposalSha256,
      proposalProvenanceSha256: fixture.report.catalog.reconciliation?.proposalProvenance?.sha256,
    });
    expect(bundle.modelEvidence.profile).toMatchObject({
      schemaVersion: 2,
      configuredContextWindow: 128_000,
      configuredMaxInputTokens: 96_000,
      configuredMaxOutputTokens: 20_000,
      status: "current",
    });
    const serialized = serializeModelProfileApprovalBundle(
      bundle,
      fixture.report,
      fixture.input.authority,
      NOW,
    );
    expect(
      decodeModelProfileApprovalBundle(serialized, fixture.report, fixture.input.authority, NOW),
    ).toEqual(bundle);
    expect(serialized).not.toContain(fixture.endpoint.apiKey);
    expect(serialized).not.toContain("ihub_api_");
    expect(Object.isFrozen(bundle.approval.fields)).toBe(true);
    expect(() => {
      bundle.approval.fields[0]!.state = "unknown";
    }).toThrow();
  });

  it("rejects digest, slot, model, freshness, conflict, and authority replay", async () => {
    const fixture = await approvalFixture();
    const cases = [
      { ...fixture.input, proposalSha256: "0".repeat(64) },
      { ...fixture.input, purpose: "judge" as const },
      { ...fixture.input, endpoint: { ...fixture.endpoint, modelId: "openai/other" } },
      {
        ...fixture.input,
        endpoint: { ...fixture.endpoint, baseUrl: "https://attacker.example/v1" },
      },
      {
        ...fixture.input,
        endpoint: { ...fixture.endpoint, baseUrl: `${HUB_ORIGIN}/other` },
      },
      { ...fixture.input, now: new Date("2026-08-06T12:34:56.790Z") },
      { ...fixture.input, conflictFields: [] },
      { ...fixture.input, conflictFields: ["maxInputTokens", "maxInputTokens"] as const },
    ];
    for (const input of cases) {
      expect(() => approveModelProfile(input)).toThrow(ModelProfileApprovalError);
    }

    const bundle = approveModelProfile(fixture.input);
    const other = generateKeyPairSync("ed25519");
    expect(() =>
      decodeModelProfileApprovalBundle(
        bundle,
        fixture.report,
        {
          id: fixture.input.authority.id,
          publicKey: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
        NOW,
      ),
    ).toThrow(ModelProfileApprovalError);
    const extended = JSON.parse(JSON.stringify(bundle));
    extended.authority.extra = "unbound-extension";
    expect(() =>
      decodeModelProfileApprovalBundle(extended, fixture.report, fixture.input.authority, NOW),
    ).toThrow(ModelProfileApprovalError);
  });

  it("decodes a bundle after its review date and refuses a clock before its creation", async () => {
    const fixture = await approvalFixture();
    const bundle = approveModelProfile(fixture.input);
    const overdue = new Date("2026-09-02T00:00:00.000Z");
    expect(bundle.approval.reviewAfter < overdue.toISOString().slice(0, 10)).toBe(true);
    // The review date is advisory, so the signed bundle stays valid.
    expect(
      decodeModelProfileApprovalBundle(bundle, fixture.report, fixture.input.authority, overdue),
    ).toEqual(bundle);
    // Adjacent condition: a clock before the bundle was created still refuses.
    const beforeCreation = new Date(Date.parse(bundle.createdAt) - 1);
    expect(() =>
      decodeModelProfileApprovalBundle(
        bundle,
        fixture.report,
        fixture.input.authority,
        beforeCreation,
      ),
    ).toThrow(ModelProfileApprovalError);
  });

  it("rejects a request reserve that exceeds the approved max-input budget", async () => {
    const fixture = await approvalFixture({
      requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 100_000 },
    });
    expect(() => approveModelProfile(fixture.input)).toThrow(ModelProfileApprovalError);
  });
});

describe("schema-owned public proof in model profile bundles", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries the same classified proof through approval, round-trip, recovery, projection, and real prepare/apply", async () => {
    const fixture = await proofFixture("classified-bundle-proof");
    const initial = approveModelProfile(fixture.input);
    const { sha256: _digest, signature, ...statement } = initial.authorization;
    expect(
      verify(
        null,
        createHash("sha256")
          .update(canonicalizeJsonEvidence(statement as JsonEvidenceValue))
          .digest(),
        createPublicKey(fixture.input.authority.publicKey),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    const scan = classifyBundleProof(signature);
    const bundle = approveModelProfile(fixture.input);
    expect(bundle.authorization.signature === signature).toBe(true);
    expect(() =>
      approveModelProfile({
        ...fixture.input,
        authority: { ...fixture.input.authority, id: signature },
      }),
    ).toThrow(ModelProfileApprovalError);
    const serialized = serializeModelProfileApprovalBundle(
      bundle,
      fixture.report,
      fixture.input.authority,
      NOW,
    );
    const decoded = decodeModelProfileApprovalBundle(
      serialized,
      fixture.report,
      fixture.input.authority,
      NOW,
    );
    const recovered = decodeModelProfileApprovalBundleAtCreation(
      bundle,
      fixture.report,
      fixture.input.authority,
    );
    const projected = projectModelProfileApprovalBundle(
      bundle,
      fixture.report,
      fixture.input.authority,
      NOW,
    );
    expect(
      decoded.authorization.signature === signature && recovered.sha256 === bundle.sha256,
    ).toBe(true);
    expect(projected.maxInputTokens === 96_000).toBe(true);
    expect(scan.mock.calls.some(([value]) => bundleNonProofScreen(value, bundle))).toBe(true);

    const owner = await ownerEnvironment(fixture);
    try {
      const prepared = await prepareProfileApply({
        projectRoot: owner.root,
        purpose: "policy",
        inspection: fixture.report,
        approvalBundle: bundle,
        authority: fixture.input.authority,
        ambientEnvironment: {},
        now: NOW,
      });
      const receipt = await applyProfileConfiguration({
        prepared,
        confirmPatchSha256: prepared.preview.patch.sha256,
        inspection: fixture.report,
        approvalBundle: bundle,
        authority: fixture.input.authority,
        ambientEnvironment: {},
        now: NOW,
        receiptPath: resolve(owner.root, "apply-receipt.json"),
      });
      const after = await readFile(owner.envPath, "utf8");
      expect(receipt.applied && after.includes("MODEL_MAX_INPUT_TOKENS=96000")).toBe(true);
      expect(after.includes(fixture.endpoint.apiKey)).toBe(true);
      expect((await lstat(owner.envPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(owner.root, { recursive: true, force: true });
    }
  });

  it("serializes the verified snapshot despite post-verification caller substitution", async () => {
    const fixture = await proofFixture("bundle-snapshot-custody");
    const initial = approveModelProfile(fixture.input);
    const signature = initial.authorization.signature;
    const source = structuredClone(initial);
    let substituted = false;
    classifyBundleProof(signature, (value) => {
      if (
        !substituted &&
        value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).kind === "docsfab-model-profile-approval-bundle"
      ) {
        substituted = true;
        source.authorization.signature = "A".repeat(86);
        rehashBundle(source.authorization);
        rehashBundle(source);
      }
    });
    const serialized = serializeModelProfileApprovalBundle(
      source,
      fixture.report,
      fixture.input.authority,
      NOW,
    );
    expect(substituted).toBe(true);
    expect(JSON.parse(serialized).authorization.signature === signature).toBe(true);
    expect(source.authorization.signature !== signature).toBe(true);
    vi.restoreAllMocks();
    const mutable = structuredClone(initial);
    const decoded = decodeModelProfileApprovalBundle(
      mutable,
      fixture.report,
      fixture.input.authority,
      NOW,
    );
    expect(decoded !== mutable && Object.isFrozen(decoded.authorization)).toBe(true);
    mutable.authorization.signature = "A".repeat(86);
    expect(decoded.authorization.signature === signature).toBe(true);
  });

  it("rejects caller accessors, proxies, extras, and proof substitution without executing getters", async () => {
    const fixture = await proofFixture("bundle-inert-proof");
    const bundle = approveModelProfile(fixture.input);
    let calls = 0;
    const accessor = structuredClone(bundle);
    Object.defineProperty(accessor.authorization, "signature", {
      enumerable: true,
      get: () => {
        calls += 1;
        return bundle.authorization.signature;
      },
    });
    const proxy = new Proxy(bundle, {
      ownKeys(target) {
        calls += 1;
        return Reflect.ownKeys(target);
      },
    });
    const extra = { ...structuredClone(bundle), signature: bundle.authorization.signature };
    const altered = structuredClone(bundle);
    altered.authorization.signature = "A".repeat(86);
    rehashBundle(altered.authorization);
    rehashBundle(altered);
    for (const invalid of [accessor, proxy, extra, altered]) {
      expect(() =>
        decodeModelProfileApprovalBundle(invalid, fixture.report, fixture.input.authority, NOW),
      ).toThrow(ModelProfileApprovalError);
      expect(() =>
        serializeModelProfileApprovalBundle(
          invalid as ModelProfileApprovalBundleV1,
          fixture.report,
          fixture.input.authority,
          NOW,
        ),
      ).toThrow(ModelProfileApprovalError);
    }
    expect(calls).toBe(0);
  });

  it("keeps independent host trust and replay checks for the same classified bytes before apply", async () => {
    const fixture = await proofFixture("bundle-external-trust");
    const other = await proofFixture("bundle-wrong-signing-key");
    const bundle = approveModelProfile(fixture.input);
    classifyBundleProof(bundle.authorization.signature);
    expect(() =>
      approveModelProfile({ ...fixture.input, privateKey: other.input.privateKey }),
    ).toThrow(ModelProfileApprovalError);
    const beforeCreation = new Date(NOW.valueOf() - 1);
    const corrupt = structuredClone(bundle);
    const proof = Buffer.from(corrupt.authorization.signature, "base64url");
    proof[0] = proof[0]! ^ 1;
    corrupt.authorization.signature = proof.toString("base64url");
    rehashBundle(corrupt.authorization);
    rehashBundle(corrupt);
    const cases = [
      { bundle, authority: other.input.authority, now: NOW },
      { bundle, authority: fixture.input.authority, now: beforeCreation },
      { bundle: corrupt, authority: fixture.input.authority, now: NOW },
    ];
    const owner = await ownerEnvironment(fixture);
    try {
      const original = await readFile(owner.envPath, "utf8");
      const prepared = await prepareProfileApply({
        projectRoot: owner.root,
        purpose: "policy",
        inspection: fixture.report,
        approvalBundle: bundle,
        authority: fixture.input.authority,
        ambientEnvironment: {},
        now: NOW,
      });
      for (const [index, candidate] of cases.entries()) {
        expect(() =>
          serializeModelProfileApprovalBundle(
            candidate.bundle,
            fixture.report,
            candidate.authority,
            candidate.now,
          ),
        ).toThrow(ModelProfileApprovalError);
        await expect(
          prepareProfileApply({
            projectRoot: owner.root,
            purpose: "policy",
            inspection: fixture.report,
            approvalBundle: candidate.bundle,
            authority: candidate.authority,
            ambientEnvironment: {},
            now: candidate.now,
          }),
        ).rejects.toThrow(ProfileApplyError);
        await expect(
          applyProfileConfiguration({
            prepared,
            confirmPatchSha256: prepared.preview.patch.sha256,
            inspection: fixture.report,
            approvalBundle: candidate.bundle,
            authority: candidate.authority,
            ambientEnvironment: {},
            now: candidate.now,
            receiptPath: resolve(owner.root, `rejected-${index}.json`),
          }),
        ).rejects.toThrow(ProfileApplyError);
        expect((await readFile(owner.envPath, "utf8")) === original).toBe(true);
        await expect(lstat(resolve(owner.root, `rejected-${index}.json`))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(lstat(resolve(owner.root, "apply-receipt.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(owner.root, { recursive: true, force: true });
    }
  });

  it("rejects exact configured proof at both bundle boundaries and before partial apply", async () => {
    const fixture = await proofFixture("bundle-configured-proof");
    const bundle = approveModelProfile(fixture.input);
    classifyBundleProof(bundle.authorization.signature);
    configureCredential(bundle.authorization.signature);
    expect(() => approveModelProfile(fixture.input)).toThrow(ModelProfileApprovalError);
    expect(() =>
      decodeModelProfileApprovalBundle(bundle, fixture.report, fixture.input.authority, NOW),
    ).toThrow(ModelProfileApprovalError);
    expect(() =>
      serializeModelProfileApprovalBundle(bundle, fixture.report, fixture.input.authority, NOW),
    ).toThrow(ModelProfileApprovalError);
    const owner = await ownerEnvironment(fixture);
    try {
      const before = await readFile(owner.envPath, "utf8");
      await expect(
        prepareProfileApply({
          projectRoot: owner.root,
          purpose: "policy",
          inspection: fixture.report,
          approvalBundle: bundle,
          authority: fixture.input.authority,
          ambientEnvironment: {},
          now: NOW,
        }),
      ).rejects.toThrow(ProfileApplyError);
      expect((await readFile(owner.envPath, "utf8")) === before).toBe(true);
      await expect(lstat(resolve(owner.root, "apply-receipt.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(owner.root, { recursive: true, force: true });
    }
  });

  it("keeps the entire non-proof bundle under exact configured and generic screening", async () => {
    const fixture = await proofFixture("bundle-configured-nonproof");
    const bundle = approveModelProfile(fixture.input);
    configureCredential(bundle.inspectionSha256);
    expect(() => approveModelProfile(fixture.input)).toThrow(ModelProfileApprovalError);
    expect(() =>
      serializeModelProfileApprovalBundle(bundle, fixture.report, fixture.input.authority, NOW),
    ).toThrow(ModelProfileApprovalError);
    const shaped = ["nv", "api-", "H".repeat(24)].join("");
    expect(() =>
      approveModelProfile({
        ...fixture.input,
        authority: { ...fixture.input.authority, id: shaped },
      }),
    ).toThrow(ModelProfileApprovalError);
  });
});

async function proofFixture(label: string) {
  const fixture = await approvalFixture();
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      createHash("sha256").update(`docsfab:test:profile-public-proof:${label}`).digest(),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return {
    ...fixture,
    input: {
      ...fixture.input,
      privateKey,
      authority: {
        id: fixture.input.authority.id,
        publicKey: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
      },
    },
  };
}

function classifyBundleProof(signature: string, observe?: (value: unknown) => void) {
  const real = credentialScanner.detectCredentialRuleIdsInValue;
  return vi
    .spyOn(credentialScanner, "detectCredentialRuleIdsInValue")
    .mockImplementation((value) => {
      observe?.(value);
      const rules = real(value);
      return JSON.stringify(value)?.includes(signature)
        ? [...rules, "test-captured-public-proof"]
        : rules;
    });
}

function bundleNonProofScreen(value: unknown, bundle: ModelProfileApprovalBundleV1): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!candidate.authorization || typeof candidate.authorization !== "object") return false;
  const proof = candidate.authorization as Record<string, unknown>;
  return (
    candidate.kind === bundle.kind &&
    candidate.sha256 === bundle.sha256 &&
    !Object.hasOwn(proof, "signature") &&
    Object.keys(proof).length === Object.keys(bundle.authorization).length - 1 &&
    Object.keys(candidate).sort().join("\n") === Object.keys(bundle).sort().join("\n")
  );
}

function rehashBundle(value: { sha256: string }): void {
  const { sha256: _digest, ...body } = value;
  value.sha256 = createHash("sha256")
    .update(canonicalizeJsonEvidence(body as JsonEvidenceValue))
    .digest("hex");
}

async function ownerEnvironment(fixture: Awaited<ReturnType<typeof proofFixture>>) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-public-proof-apply-")));
  await initFixtureRepo(root);
  await writeFile(resolve(root, ".gitignore"), ".env\n.env.docsfab-*\n");
  const envPath = resolve(root, ".env");
  const environment = {
    ...validModelEnvironment,
    MODEL_PROVIDER: fixture.endpoint.providerId,
    MODEL_BASE_URL: fixture.endpoint.baseUrl,
    MODEL_ID: fixture.endpoint.modelId,
    MODEL_API_KEY: fixture.endpoint.apiKey,
    MODEL_CONTEXT_WINDOW: "8192",
    MODEL_MAX_OUTPUT_TOKENS: "4096",
    MODEL_PROFILE_APPROVED_SOURCE: "unknown",
    MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
    MODEL_PROFILE_REVIEW_AFTER: "unknown",
  };
  await writeFile(
    envPath,
    `${Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  return { root, envPath };
}
