// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPrivateKey, createPublicKey, verify, type KeyObject } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelEndpointConfig } from "../src/model/configuration.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  pinModelCatalogArtifactDirectory,
  retainModelCatalogApprovalAuthorization,
  retainModelCatalogObservation,
} from "../src/model/catalog-artifact-store.js";
import {
  MODEL_CATALOG_FIELDS,
  finalizeModelCatalogObservation,
  finalizeModelCatalogObservationSet,
  finalizeModelProfileProposal,
  finalizeOperatorApprovedModelProfile,
  projectApprovedModelProfile,
  type ModelCatalogField,
  type ModelCatalogFieldEvidenceV1,
  type ModelCatalogFieldValue,
  type ModelCatalogObservationV1,
  type ModelCatalogObservationSetV1,
  type ModelProfileProposalV1,
  type ModelCatalogProposalFieldV1,
  type OperatorApprovedModelProfileV1,
} from "../src/model/catalog-contracts.js";
import {
  ModelCatalogProvenanceError,
  createApprovedCatalogModelEvidence,
  decodeModelCatalogApprovalAuthorization,
  decodeModelCatalogApprovalEvidence,
  decodeModelCatalogObservationProvenance,
  decodeModelCatalogProposalProvenance,
  finalizeModelCatalogApprovalEvidence,
  finalizeModelCatalogObservationProvenance,
  finalizeModelCatalogProposalProvenance,
  serializeModelCatalogProvenanceArtifact,
  signModelCatalogApprovalAuthorization,
  type ModelCatalogApprovalAuthorizationV1,
  type ModelCatalogApprovalEvidenceV1,
  type ModelCatalogObservationProvenanceV1,
  type ModelCatalogProposalProvenanceV1,
  type TrustedModelCatalogApprovalAuthority,
} from "../src/model/catalog-provenance.js";
import { validModelEvidenceProjection } from "../src/model/profile-evidence.js";
import { decodeModelEvidence } from "../src/scorecard-record.js";
import * as credentialScanner from "../src/security/repository-scanner.js";
import { configureCredential } from "./helpers/configured-credential.js";

const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-02T00:00:00.000Z";
const T2 = "2026-08-03T00:00:00.000Z";
const APPROVED_AT = "2026-08-04T00:00:00.000Z";
const AS_OF = new Date("2026-08-15T00:00:00.000Z");

describe("credential-free model catalog provenance", () => {
  it("binds normalized values, source identity, path, time, adapters, and policy", () => {
    const first = chain();
    const changedPath = chain({ sourcePath: "/catalog/models?cursor=next" });
    const changedValue = chain({ contextWindow: 64_000, maxInputTokens: 47_616 });
    const changedOrigin = chain({ origin: "https://alternate.example.test" });
    const changedAdapter = chain({ adapterVersion: "1.0.1" });

    expect(first.observationEvidence.source).toMatchObject({
      origin: "https://catalog.example.test",
      providerId: "example-provider",
      modelId: "example/model",
      retrievedAt: T2,
      providerUpdatedAt: T1,
      adapter: { id: "adapter:catalog", version: "1.0.0" },
    });
    expect(first.observationEvidence.source).not.toHaveProperty("path");
    expect(first.observationEvidence.sha256).not.toBe(changedPath.observationEvidence.sha256);
    expect(first.observationEvidence.sha256).not.toBe(changedValue.observationEvidence.sha256);
    expect(first.observationEvidence.sha256).not.toBe(changedAdapter.observationEvidence.sha256);
    expect(first.proposalEvidence.sha256).not.toBe(changedOrigin.proposalEvidence.sha256);
    expect(first.approvalEvidence.sha256).not.toBe(changedOrigin.approvalEvidence.sha256);

    expect(
      decodeModelCatalogObservationProvenance(
        serializeModelCatalogProvenanceArtifact(first.observationEvidence, {
          kind: "observation",
          observation: first.observation,
        }),
        first.observation,
      ),
    ).toEqual(first.observationEvidence);

    const unsupportedPolicy = structuredClone(
      first.proposalEvidence,
    ) as ModelCatalogProposalProvenanceV1 & {
      reconciliationPolicy: { id: string; version: string };
    };
    unsupportedPolicy.reconciliationPolicy.version = "2";
    rehash(unsupportedPolicy);
    expect(unsupportedPolicy.sha256).not.toBe(first.proposalEvidence.sha256);
    expect(() =>
      decodeModelCatalogProposalProvenance(
        unsupportedPolicy,
        first.proposal,
        first.observationSet,
        [first.observation],
        [first.observationEvidence],
      ),
    ).toThrow(ModelCatalogProvenanceError);
  });

  it("rejects tamper, replay, origin substitution, and a self-consistent forged chain", () => {
    const trusted = chain();
    const other = chain({
      providerId: "other-provider",
      modelId: "other/model",
      origin: "https://other.example.test",
    });

    const tampered = structuredClone(trusted.approvalEvidence);
    tampered.reviewAfter = "2026-10-01";
    expect(() =>
      decodeModelCatalogApprovalEvidence(
        tampered,
        trusted.approval,
        trusted.proposalEvidence,
        trusted.proposal,
        trusted.observationSet,
        [trusted.observation],
        [trusted.observationEvidence],
      ),
    ).toThrow(ModelCatalogProvenanceError);

    expect(() =>
      decodeModelCatalogApprovalEvidence(
        trusted.approvalEvidence,
        other.approval,
        other.proposalEvidence,
        other.proposal,
        other.observationSet,
        [other.observation],
        [other.observationEvidence],
      ),
    ).toThrow(ModelCatalogProvenanceError);

    const attackAuthority = signingAuthority("operator:fixture");
    const attackAuthorization = authorize(other, attackAuthority);
    expect(() => modelEvidence(other, attackAuthorization, trusted.authority)).toThrow(
      ModelCatalogProvenanceError,
    );

    const rehashed = structuredClone(trusted.authorization);
    rehashed.providerId = "other-provider";
    rehash(rehashed);
    expect(() => modelEvidence(trusted, rehashed, trusted.authority)).toThrow(
      ModelCatalogProvenanceError,
    );

    const lateAuthorization = signModelCatalogApprovalAuthorization({
      approvalEvidence: trusted.approvalEvidence,
      approval: trusted.approval,
      proposalProvenance: trusted.proposalEvidence,
      proposal: trusted.proposal,
      observationSet: trusted.observationSet,
      observations: [trusted.observation],
      observationProvenance: [trusted.observationEvidence],
      authorityId: trusted.authority.id,
      authorizedAt: "2026-08-20T00:00:00.000Z",
      privateKey: trusted.privateKey,
    });
    expect(() => modelEvidence(trusted, lateAuthorization, trusted.authority)).toThrow(
      ModelCatalogProvenanceError,
    );

    let getterCalls = 0;
    const accessorLeaf = structuredClone(trusted.observationEvidence);
    Object.defineProperty(accessorLeaf, "observation", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return trusted.observationEvidence.observation;
      },
    });
    const accessorArray = [trusted.observationEvidence];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return trusted.observationEvidence;
      },
    });
    const sparse = new Array<ModelCatalogObservationProvenanceV1>(1);
    const decorated = [trusted.observationEvidence] as ModelCatalogObservationProvenanceV1[] & {
      extra?: string;
    };
    decorated.extra = "untrusted";
    for (const leaves of [[accessorLeaf], accessorArray, sparse, decorated]) {
      expect(() =>
        finalizeModelCatalogProposalProvenance({
          proposal: trusted.proposal,
          observationSet: trusted.observationSet,
          observations: [trusted.observation],
          observationProvenance: leaves,
        }),
      ).toThrow(ModelCatalogProvenanceError);
    }
    const observationAccessor = [trusted.observation];
    Object.defineProperty(observationAccessor, "0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return trusted.observation;
      },
    });
    expect(() =>
      finalizeModelCatalogProposalProvenance({
        proposal: trusted.proposal,
        observationSet: trusted.observationSet,
        observations: observationAccessor,
        observationProvenance: [trusted.observationEvidence],
      }),
    ).toThrow(ModelCatalogProvenanceError);
    expect(getterCalls).toBe(0);
  });

  it("rejects provider credential canaries and forged raw payload serialization content-free", () => {
    const inferenceCanary = ["nv", "api-", "A".repeat(24)].join("");
    const metadataCanary = ["ihub", "_api_", "B".repeat(24)].join("");
    const inferenceBoundaryCanary = ["nv", "api-", "C".repeat(19), "-"].join("");
    const metadataBoundaryCanary = ["ihub", "_api_", "D".repeat(19), "-"].join("");
    for (const canary of [
      inferenceCanary,
      metadataCanary,
      inferenceBoundaryCanary,
      metadataBoundaryCanary,
      ["gl", "pat-", "E".repeat(24)].join(""),
      ["s", "k-", "F".repeat(24)].join(""),
    ]) {
      const observation = completeObservation({ sourceId: `source:${canary}` });
      let message = "";
      try {
        finalizeModelCatalogObservationProvenance({ observation, sourcePath: "/catalog" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Model catalog provenance is invalid or incompatible.");
      expect(message).not.toContain(canary);

      const clean = completeObservation();
      const keyName = ["api", "_key"].join("");
      expect(() =>
        finalizeModelCatalogObservationProvenance({
          observation: clean,
          sourcePath: `/catalog?${keyName}=${canary}`,
        }),
      ).toThrow(ModelCatalogProvenanceError);
    }

    const fixture = chain();
    const metadataName = ["x", "-api", "-key"].join("");
    const forged = {
      ...structuredClone(fixture.observationEvidence),
      rawPayload: { [metadataName]: metadataCanary, prose: "not allowlisted" },
    };
    rehash(forged);
    let message = "";
    try {
      serializeModelCatalogProvenanceArtifact(forged, {
        kind: "observation",
        observation: fixture.observation,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Model catalog provenance is invalid or incompatible.");
    expect(message).not.toContain(metadataName);
    expect(message).not.toContain(metadataCanary);

    let getterCalls = 0;
    const accessor = structuredClone(fixture.observationEvidence);
    Object.defineProperty(accessor, "kind", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "docsfab-model-catalog-observation-provenance";
      },
    });
    expect(() =>
      serializeModelCatalogProvenanceArtifact(accessor, {
        kind: "observation",
        observation: fixture.observation,
      }),
    ).toThrow(ModelCatalogProvenanceError);
    expect(getterCalls).toBe(0);
  });

  it("retains only normalized evidence in an owner-private, identity-pinned store", async () => {
    const fixture = chain();
    const root = await mkdtemp(join(tmpdir(), "docsfab-catalog-evidence-"));
    await chmod(root, 0o700);
    const directory = await pinModelCatalogArtifactDirectory(root);
    const rawCanary = ["ihub", "_api_", "C".repeat(24)].join("");
    const retained = await retainModelCatalogObservation({
      directory,
      file: "observation.json",
      observation: fixture.observation,
      sourcePath: "/catalog/models?cursor=opaque",
      rawPayload: { opaque: rawCanary },
    } as Parameters<typeof retainModelCatalogObservation>[0] & { rawPayload: unknown });
    const path = join(root, "observation.json");
    const serialized = await readFile(path, "utf8");

    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(serialized).toContain(retained.sha256);
    expect(serialized).not.toContain(rawCanary);
    expect(serialized).not.toContain("rawPayload");
    expect(serialized).not.toContain("/catalog/models");

    const authorization = await retainModelCatalogApprovalAuthorization({
      directory,
      file: "authorization.json",
      authorization: fixture.authorization,
      approvalEvidence: fixture.approvalEvidence,
      authority: fixture.authority,
    });
    const authorizationPath = join(root, "authorization.json");
    const authorizationBytes = await readFile(authorizationPath, "utf8");
    expect((await lstat(authorizationPath)).mode & 0o777).toBe(0o600);
    expect(authorizationBytes).toContain(authorization.sha256);
    expect(authorizationBytes).not.toContain("PRIVATE KEY");
    expect(authorizationBytes).not.toContain(rawCanary);
  });

  it("rejects symlink, permissive, and parent-substitution storage targets", async () => {
    const fixture = chain();
    const base = await mkdtemp(join(tmpdir(), "docsfab-catalog-store-"));
    const real = join(base, "real");
    const linked = join(base, "linked");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, linked);
    await expect(pinModelCatalogArtifactDirectory(linked)).rejects.toThrow(
      "Model catalog artifact storage was rejected.",
    );

    const permissive = join(base, "permissive");
    await mkdir(permissive, { mode: 0o755 });
    await expect(pinModelCatalogArtifactDirectory(permissive)).rejects.toThrow(
      "Model catalog artifact storage was rejected.",
    );

    const leafRoot = join(base, "leaf-root");
    await mkdir(leafRoot, { mode: 0o700 });
    const leafDirectory = await pinModelCatalogArtifactDirectory(leafRoot);
    await symlink(join(base, "outside.json"), join(leafRoot, "observation.json"));
    await expect(
      retainModelCatalogObservation({
        directory: leafDirectory,
        file: "observation.json",
        observation: fixture.observation,
        sourcePath: "/catalog",
      }),
    ).rejects.toThrow("Model catalog artifact storage was rejected.");

    const selected = join(base, "selected");
    const moved = join(base, "moved");
    await mkdir(selected, { mode: 0o700 });
    const pinned = await pinModelCatalogArtifactDirectory(selected);
    await expect(
      retainModelCatalogObservation({
        directory: pinned,
        file: "observation.json",
        observation: fixture.observation,
        sourcePath: "/catalog",
        writeOptions: {
          beforeOpen: async () => {
            await rename(selected, moved);
            await mkdir(selected, { mode: 0o700 });
          },
        },
      }),
    ).rejects.toThrow("Model catalog artifact storage was rejected.");
    await expect(lstat(join(selected, "observation.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("emits only the legacy-compatible approved safe profile into run-record model evidence", () => {
    const fixture = chain();
    const model = modelEvidence(fixture, fixture.authorization, fixture.authority);
    const serialized = JSON.stringify(model);

    expect(validModelEvidenceProjection(model)).toBe(true);
    expect(decodeModelEvidence(JSON.parse(serialized))).toEqual(model);
    expect(Object.keys(model)).toEqual(["provider", "model", "profile"]);
    expect(serialized).not.toContain(fixture.approval.approvedBy);
    expect(serialized).not.toContain(fixture.observation.source.id);
    expect(serialized).not.toContain(fixture.observationEvidence.source.origin);
    expect(serialized).not.toContain(fixture.observationEvidence.source.pathSha256);
    expect(serialized).not.toContain(fixture.proposal.sha256);
    expect(serialized).not.toContain(fixture.approval.sha256);
    expect(serialized).not.toContain(fixture.inferenceCanary);
    expect(serialized).not.toContain(fixture.metadataCanary);

    expect(() =>
      createApprovedCatalogModelEvidence({
        ...approvedEvidenceInput(fixture, fixture.authorization, fixture.authority),
        purpose: "judge",
      }),
    ).toThrow(ModelCatalogProvenanceError);
    expect(
      createApprovedCatalogModelEvidence({
        ...approvedEvidenceInput(fixture, fixture.authorization, fixture.authority),
        purpose: "policy",
      }),
    ).toEqual(model);

    const judge = chain({ purpose: "judge" });
    expect(
      createApprovedCatalogModelEvidence({
        ...approvedEvidenceInput(judge, judge.authorization, judge.authority),
        purpose: "judge",
      }),
    ).toMatchObject({ provider: "example-provider", model: "example/model" });
    expect(() =>
      createApprovedCatalogModelEvidence({
        ...approvedEvidenceInput(judge, judge.authorization, judge.authority),
        purpose: "policy",
      }),
    ).toThrow(ModelCatalogProvenanceError);
  });
});

describe("schema-owned public catalog proof", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves a genuinely verified classified proof through signing, decoding, serialization, and retention", async () => {
    const fixture = chain({ signingLabel: "classified-public-proof" });
    expect(independentlyVerified(fixture.authorization, fixture.authority)).toBe(true);
    const scan = classifyProof(fixture.authorization.signature);
    const signed = authorize(fixture, fixture);
    expect(signed.signature === fixture.authorization.signature).toBe(true);
    // The classifier treats these same bytes identically outside the proof slot.
    expect(() =>
      chain({ providerId: signed.signature, signingLabel: "proof-outside-slot" }),
    ).toThrow(ModelCatalogProvenanceError);
    const source = structuredClone(signed);
    const decoded = decodeModelCatalogApprovalAuthorization(
      source,
      fixture.approvalEvidence,
      fixture.authority,
    );
    expect(decoded !== source && Object.isFrozen(decoded)).toBe(true);
    source.signature = "A".repeat(86);
    expect(decoded.signature === signed.signature).toBe(true);
    const serialized = serializeModelCatalogProvenanceArtifact(decoded, {
      kind: "authorization",
      approvalEvidence: fixture.approvalEvidence,
      authority: fixture.authority,
    });
    expect(JSON.parse(serialized).signature === signed.signature).toBe(true);
    expect(validModelEvidenceProjection(modelEvidence(fixture, decoded, fixture.authority))).toBe(
      true,
    );
    // The real final generic screen receives every field except this exact proof slot.
    expect(scan.mock.calls.some(([value]) => authorizationNonProofScreen(value, decoded))).toBe(
      true,
    );

    const root = await mkdtemp(join(tmpdir(), "docsfab-public-proof-"));
    try {
      await chmod(root, 0o700);
      const directory = await pinModelCatalogArtifactDirectory(root);
      const retained = await retainModelCatalogApprovalAuthorization({
        directory,
        file: "authorization.json",
        authorization: decoded,
        approvalEvidence: fixture.approvalEvidence,
        authority: fixture.authority,
      });
      const bytes = JSON.parse(await readFile(join(root, "authorization.json"), "utf8"));
      expect(bytes.signature === signed.signature && retained.signature === signed.signature).toBe(
        true,
      );
      expect((await lstat(join(root, "authorization.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("distinguishes unsigned credential syntax from a valid proof without searching for a collision", () => {
    const fixture = chain({ signingLabel: "unsigned-syntax-control" });
    for (const tail of ["C".repeat(80), "C".repeat(79)]) {
      const unsigned = ["nv", "api-", tail].join("");
      expect(credentialScanner.detectCredentialRuleIds(unsigned).length > 0).toBe(true);
      const changed = { ...fixture.authorization, signature: unsigned };
      rehash(changed);
      expect(() =>
        decodeModelCatalogApprovalAuthorization(
          changed,
          fixture.approvalEvidence,
          fixture.authority,
        ),
      ).toThrow(ModelCatalogProvenanceError);
    }
  });

  it("rejects noncanonical encoding even when it decodes to the same independently verified bytes", () => {
    const fixture = chain({ signingLabel: "canonical-proof-control" });
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const canonical = fixture.authorization.signature;
    const alias = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)!) + 1];
    expect(Buffer.from(alias, "base64url").equals(Buffer.from(canonical, "base64url"))).toBe(true);
    const changed = { ...fixture.authorization, signature: alias };
    rehash(changed);
    expect(() =>
      decodeModelCatalogApprovalAuthorization(changed, fixture.approvalEvidence, fixture.authority),
    ).toThrow(ModelCatalogProvenanceError);
  });

  it("keeps trust, all bindings, dates, replay, and recomputed-digest proof tamper closed before publication", async () => {
    const fixture = chain({ signingLabel: "classified-rejection-control" });
    classifyProof(fixture.authorization.signature);
    const other = chain({ signingLabel: "other-trusted-authority", modelId: "other/model" });
    expect(other.approvalEvidence.sha256 !== fixture.approvalEvidence.sha256).toBe(true);
    const corrupt = Buffer.from(fixture.authorization.signature, "base64url");
    corrupt[0] = corrupt[0]! ^ 1;
    const changes = [
      { signature: corrupt.toString("base64url") },
      { signature: fixture.authorization.signature.slice(1) },
      { approvalEvidenceSha256: "0".repeat(64) },
      { approvalSha256: "0".repeat(64) },
      { proposalSha256: "0".repeat(64) },
      { purpose: "judge" as const },
      { providerId: "other-provider" },
      { modelId: "other/model" },
      { origin: "https://other.example.test" },
      { authorityId: "operator:other" },
      { authorizedAt: T2 },
      { authorizedAt: "2026-08-04T00:00:01.000Z" },
      { effectiveDate: "2026-08-05" },
      { reviewAfter: "2026-10-01" },
      { extra: "unbound-extension" },
    ];
    const cases = changes.map((change) => {
      const authorization = { ...fixture.authorization, ...change };
      rehash(authorization);
      return { authorization, evidence: fixture.approvalEvidence, authority: fixture.authority };
    });
    cases.push(
      {
        authorization: fixture.authorization,
        evidence: fixture.approvalEvidence,
        authority: other.authority,
      },
      {
        authorization: fixture.authorization,
        evidence: other.approvalEvidence,
        authority: fixture.authority,
      },
    );
    const root = await mkdtemp(join(tmpdir(), "docsfab-public-proof-refusal-"));
    try {
      await chmod(root, 0o700);
      const directory = await pinModelCatalogArtifactDirectory(root);
      for (const [index, candidate] of cases.entries()) {
        expect(() =>
          decodeModelCatalogApprovalAuthorization(
            candidate.authorization,
            candidate.evidence,
            candidate.authority,
          ),
        ).toThrow(ModelCatalogProvenanceError);
        expect(() =>
          serializeModelCatalogProvenanceArtifact(candidate.authorization, {
            kind: "authorization",
            approvalEvidence: candidate.evidence,
            authority: candidate.authority,
          }),
        ).toThrow(ModelCatalogProvenanceError);
        await expect(
          retainModelCatalogApprovalAuthorization({
            directory,
            file: `rejected-${index}.json`,
            authorization: candidate.authorization,
            approvalEvidence: candidate.evidence,
            authority: candidate.authority,
          }),
        ).rejects.toThrow();
        await expect(lstat(join(root, `rejected-${index}.json`))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects accessors and proxies without executing caller code, and returns an independent frozen snapshot", () => {
    const fixture = chain({ signingLabel: "inert-snapshot-control" });
    let calls = 0;
    const accessor = structuredClone(fixture.authorization);
    Object.defineProperty(accessor, "signature", {
      enumerable: true,
      get: () => {
        calls += 1;
        return fixture.authorization.signature;
      },
    });
    const proxy = new Proxy(fixture.authorization, {
      ownKeys(target) {
        calls += 1;
        return Reflect.ownKeys(target);
      },
    });
    for (const invalid of [accessor, proxy]) {
      expect(() =>
        decodeModelCatalogApprovalAuthorization(
          invalid,
          fixture.approvalEvidence,
          fixture.authority,
        ),
      ).toThrow(ModelCatalogProvenanceError);
    }
    expect(calls).toBe(0);
    const source = structuredClone(fixture.authorization);
    const decoded = decodeModelCatalogApprovalAuthorization(
      source,
      fixture.approvalEvidence,
      fixture.authority,
    );
    expect(decoded !== source && Object.isFrozen(decoded)).toBe(true);
  });

  it("refuses an exact configured proof before signing, serialization, or retention despite generic classification", async () => {
    const fixture = chain({ signingLabel: "configured-proof-control" });
    classifyProof(fixture.authorization.signature);
    configureCredential(fixture.authorization.signature);
    expect(() => authorize(fixture, fixture)).toThrow(ModelCatalogProvenanceError);
    expect(() =>
      decodeModelCatalogApprovalAuthorization(
        fixture.authorization,
        fixture.approvalEvidence,
        fixture.authority,
      ),
    ).toThrow(ModelCatalogProvenanceError);
    expect(() =>
      serializeModelCatalogProvenanceArtifact(fixture.authorization, {
        kind: "authorization",
        approvalEvidence: fixture.approvalEvidence,
        authority: fixture.authority,
      }),
    ).toThrow(ModelCatalogProvenanceError);
    const root = await mkdtemp(join(tmpdir(), "docsfab-configured-proof-refusal-"));
    try {
      await chmod(root, 0o700);
      await expect(
        retainModelCatalogApprovalAuthorization({
          directory: await pinModelCatalogArtifactDirectory(root),
          file: "authorization.json",
          authorization: fixture.authorization,
          approvalEvidence: fixture.approvalEvidence,
          authority: fixture.authority,
        }),
      ).rejects.toThrow();
      await expect(lstat(join(root, "authorization.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains exact configured and generic guards outside the proof slot", () => {
    const fixture = chain({
      signingLabel: "configured-nonproof-control",
      modelId: ["fixture", "configured", "model", "one"].join("/"),
    });
    configureCredential(fixture.authorization.modelId);
    expect(() =>
      decodeModelCatalogApprovalAuthorization(
        fixture.authorization,
        fixture.approvalEvidence,
        fixture.authority,
      ),
    ).toThrow(ModelCatalogProvenanceError);
    expect(() =>
      serializeModelCatalogProvenanceArtifact(fixture.authorization, {
        kind: "authorization",
        approvalEvidence: fixture.approvalEvidence,
        authority: fixture.authority,
      }),
    ).toThrow(ModelCatalogProvenanceError);
    const shaped = ["nv", "api-", "G".repeat(24)].join("");
    expect(() => chain({ providerId: shaped, signingLabel: "generic-nonproof-control" })).toThrow();
  });
});

function classifyProof(signature: string) {
  const real = credentialScanner.detectCredentialRuleIdsInValue;
  return vi
    .spyOn(credentialScanner, "detectCredentialRuleIdsInValue")
    .mockImplementation((value) => {
      const rules = real(value);
      return JSON.stringify(value)?.includes(signature)
        ? [...rules, "test-captured-public-proof"]
        : rules;
    });
}

function authorizationNonProofScreen(
  value: unknown,
  authorization: ModelCatalogApprovalAuthorizationV1,
): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const { signature: _proof, ...nonProof } = authorization;
  return (
    !Object.hasOwn(candidate, "signature") &&
    Object.keys(candidate).sort().join("\n") === Object.keys(nonProof).sort().join("\n") &&
    Object.entries(nonProof).every(([key, item]) => candidate[key] === item)
  );
}

function independentlyVerified(
  authorization: ModelCatalogApprovalAuthorizationV1,
  authority: TrustedModelCatalogApprovalAuthority,
): boolean {
  const { sha256: _digest, signature, ...statement } = authorization;
  const digest = createHash("sha256")
    .update(canonicalizeJsonEvidence(statement as JsonEvidenceValue))
    .digest();
  return verify(
    null,
    digest,
    createPublicKey(authority.publicKey),
    Buffer.from(signature, "base64url"),
  );
}

interface ChainOptions {
  sourcePath?: string;
  sourceId?: string;
  providerId?: string;
  modelId?: string;
  origin?: string;
  contextWindow?: number;
  maxInputTokens?: number;
  adapterVersion?: string;
  purpose?: "policy" | "judge";
  signingLabel?: string;
}

interface CatalogChainCore {
  readonly observation: ModelCatalogObservationV1;
  readonly observationSet: ModelCatalogObservationSetV1;
  readonly proposal: ModelProfileProposalV1;
  readonly approval: OperatorApprovedModelProfileV1;
  readonly observationEvidence: ModelCatalogObservationProvenanceV1;
  readonly proposalEvidence: ModelCatalogProposalProvenanceV1;
  readonly approvalEvidence: ModelCatalogApprovalEvidenceV1;
}

interface CatalogSigningFixture {
  readonly privateKey: KeyObject;
  readonly authority: TrustedModelCatalogApprovalAuthority;
}

interface CatalogChainFixture extends CatalogChainCore, CatalogSigningFixture {
  readonly authorization: ModelCatalogApprovalAuthorizationV1;
  readonly inferenceCanary: string;
  readonly metadataCanary: string;
}

function chain(options: ChainOptions = {}): CatalogChainFixture {
  const observation = completeObservation(options);
  const observationSet = finalizeModelCatalogObservationSet(
    {
      id: `observation-set:${observation.purpose}`,
      purpose: observation.purpose,
      completedAt: T2,
      observations: [{ id: observation.id, sha256: observation.sha256 }],
    },
    [observation],
  );
  const proposal = finalizeModelProfileProposal(
    {
      id: `proposal:${observation.purpose}`,
      purpose: observation.purpose,
      createdAt: T2,
      observationSet: { id: observationSet.id, sha256: observationSet.sha256 },
      observations: [{ id: observation.id, sha256: observation.sha256 }],
      fields: observation.fields
        .map(
          (field): ModelCatalogProposalFieldV1 => ({
            field: field.field,
            state: field.state,
            ...(field.state === "observed" ? { value: field.value } : {}),
            derivation: {
              kind: "observation",
              input: {
                observationId: observation.id,
                observationSha256: observation.sha256,
                field: field.field,
              },
            },
          }),
        )
        .reverse(),
    },
    observationSet,
    [observation],
  );
  const approval = finalizeOperatorApprovedModelProfile(
    {
      id: `approval:${observation.purpose}`,
      purpose: observation.purpose,
      proposalSha256: proposal.sha256,
      approvedBy: "operator:fixture",
      approvedAt: APPROVED_AT,
      effectiveDate: "2026-08-04",
      reviewAfter: "2026-09-01",
      fields: structuredClone(proposal.fields),
    },
    proposal,
    observationSet,
    [observation],
  );
  const observationEvidence = finalizeModelCatalogObservationProvenance({
    observation,
    sourcePath: options.sourcePath ?? "/catalog/models",
  });
  const proposalEvidence = finalizeModelCatalogProposalProvenance({
    proposal,
    observationSet,
    observations: [observation],
    observationProvenance: [observationEvidence],
  });
  const approvalEvidence = finalizeModelCatalogApprovalEvidence({
    approval,
    proposalProvenance: proposalEvidence,
    proposal,
    observationSet,
    observations: [observation],
    observationProvenance: [observationEvidence],
  });
  const signing = signingAuthority(approval.approvedBy, options.signingLabel);
  const partial: CatalogChainCore = {
    observation,
    observationSet,
    proposal,
    approval,
    observationEvidence,
    proposalEvidence,
    approvalEvidence,
  };
  const authorization = authorize(partial, signing);
  return {
    ...partial,
    authorization,
    authority: signing.authority,
    privateKey: signing.privateKey,
    inferenceCanary: ["nv", "api-", "R".repeat(24)].join(""),
    metadataCanary: ["ihub", "_api_", "S".repeat(24)].join(""),
  };
}

function completeObservation(options: ChainOptions = {}): ModelCatalogObservationV1 {
  const values: Record<ModelCatalogField, ModelCatalogFieldValue> = {
    activity: "active",
    apiFormats: ["chat_completions", "messages"],
    billingInterpretation: "authoritative-rate",
    cacheReadPrice: price(500_000),
    cacheWritePrice: price(0),
    contextWindow: options.contextWindow ?? 128_000,
    inputModalities: ["image", "text"],
    inputPrice: price(1_250_000),
    limitSemantics: "combined-context",
    maxInputTokens: options.maxInputTokens ?? 111_616,
    maxOutputTokens: 16_384,
    modelId: options.modelId ?? "example/model",
    origin: options.origin ?? "https://catalog.example.test",
    outputPrice: price(10_000_000),
    providerCreatedAt: T0,
    providerId: options.providerId ?? "example-provider",
    providerUpdatedAt: T1,
    reasoning: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    supportsSystemRole: true,
    toolUse: true,
  };
  const fields = MODEL_CATALOG_FIELDS.map(
    (field): ModelCatalogFieldEvidenceV1 => ({
      field,
      state: "observed",
      value: values[field],
    }),
  ).reverse();
  return finalizeModelCatalogObservation({
    id: "observation:catalog",
    purpose: options.purpose ?? "policy",
    source: {
      id: options.sourceId ?? "source:catalog",
      adapter: { id: "adapter:catalog", version: options.adapterVersion ?? "1.0.0" },
      retrievedAt: T2,
    },
    fields,
  });
}

let signingFixtureSequence = 0;

function signingAuthority(id: string, label?: string): CatalogSigningFixture {
  if (label !== undefined) {
    // One public fixture identity, fixed before execution; never search for proof bytes.
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        createHash("sha256").update(`docsfab:test:catalog-public-proof:${label}`).digest(),
      ]),
      format: "der",
      type: "pkcs8",
    });
    return {
      privateKey,
      authority: {
        id,
        publicKey: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
      },
    };
  }
  // Public, nonproduction fixture seeds keep real signatures reproducible.
  // Every call gets a distinct key, including repeated authority IDs used by
  // the self-consistent forged-chain test. No credential predicate filters keys.
  const seed = createHash("sha256")
    .update(`docsfab-public-catalog-signing-fixture:${signingFixtureSequence++}:${id}`)
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  return {
    privateKey,
    authority: {
      id,
      publicKey: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
    },
  };
}

function authorize(
  fixture: CatalogChainCore,
  signing: CatalogSigningFixture,
): ModelCatalogApprovalAuthorizationV1 {
  return signModelCatalogApprovalAuthorization({
    approvalEvidence: fixture.approvalEvidence,
    approval: fixture.approval,
    proposalProvenance: fixture.proposalEvidence,
    proposal: fixture.proposal,
    observationSet: fixture.observationSet,
    observations: [fixture.observation],
    observationProvenance: [fixture.observationEvidence],
    authorityId: signing.authority.id,
    authorizedAt: APPROVED_AT,
    privateKey: signing.privateKey,
  });
}

function modelEvidence(
  fixture: CatalogChainFixture,
  authorization: ModelCatalogApprovalAuthorizationV1,
  authority: TrustedModelCatalogApprovalAuthority,
) {
  return createApprovedCatalogModelEvidence({
    ...approvedEvidenceInput(fixture, authorization, authority),
    purpose: "policy",
  });
}

function approvedEvidenceInput(
  fixture: CatalogChainFixture,
  authorization: ModelCatalogApprovalAuthorizationV1,
  authority: TrustedModelCatalogApprovalAuthority,
) {
  const profile = projectApprovedModelProfile(
    fixture.approval,
    fixture.proposal,
    fixture.observationSet,
    [fixture.observation],
    AS_OF,
  );
  const config: ModelEndpointConfig = {
    providerId: fixture.approvalEvidence.providerId,
    modelId: fixture.approvalEvidence.modelId,
    baseUrl: "https://runtime.example.test/v1",
    api: "openai-completions",
    apiFormat: "chat_completions",
    apiKey: `${fixture.inferenceCanary}:${fixture.metadataCanary}`,
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 4_096 },
    profile,
  };
  return {
    config,
    asOf: AS_OF,
    approvalEvidence: fixture.approvalEvidence,
    approval: fixture.approval,
    proposalProvenance: fixture.proposalEvidence,
    proposal: fixture.proposal,
    observationSet: fixture.observationSet,
    observations: [fixture.observation],
    observationProvenance: [fixture.observationEvidence],
    authorization,
    authority,
  };
}

function price(amountMicrounits: number) {
  return { amountMicrounits, currency: "USD", unit: "per-million-tokens" as const };
}

function rehash(value: { sha256: string }): void {
  const { sha256: _digest, ...body } = value;
  value.sha256 = createHash("sha256")
    .update(canonicalizeJsonEvidence(body as JsonEvidenceValue))
    .digest("hex");
}
