// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import * as publicApi from "../src/inputs/index.js";
import {
  ExternalInputContractError,
  assertExternalInputManifestAuthentic,
  citeExternalInput,
  createExternalInputAccessLedger,
  createExternalInputCitationLedger,
  createHistoricalEmptyExternalInputManifest,
  decodeExternalInputAccessLedger,
  decodeExternalInputCitationLedger,
  decodeExternalInputManifest,
  decodePersistedExternalInputAccessLedger,
  decodePersistedExternalInputManifest,
  digestExternalInputLocator,
  EXTERNAL_INPUT_MIGRATION_POLICY,
  migrateExternalInputManifest,
  mintExternalInputManifest,
  openExternalInputAccessCapture,
  openExternalInputCitationCapture,
  openExternalInputRegistry,
  projectExternalInputDisclosure,
  projectExternalInputManifest,
  recordExternalInputAccess,
  registerExternalInput,
  registerFakeExternalInput,
  requireCitationsForClaims,
  restoreExternalInputManifest,
  sanitizeExternalInputMetadata,
  serializeExternalInputAccessLedger,
  serializeExternalInputManifest,
  transitionExternalInputLifecycle,
  type ExternalInputCitationV1,
  type ExternalInputRegistrationV1,
  type ExternalInputRunBindingV1,
} from "../src/inputs/index.js";
import { internalCreateExternalInputHostAuthority } from "../src/inputs/authority-internal.js";
import { configureCredential } from "./helpers/configured-credential.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/external-input-manifest-v1.json", import.meta.url), "utf8"),
) as {
  binding: ExternalInputRunBindingV1;
  supplier: ExternalInputRegistrationV1["supplier"];
  entries: Array<{
    inputId: string;
    sourceKind: ExternalInputRegistrationV1["sourceKind"];
    safeTitle: string;
    canonicalLocator: string;
    visibility: ExternalInputRegistrationV1["visibility"];
    disclosurePolicy: ExternalInputRegistrationV1["disclosurePolicy"];
    intendedRoles: ExternalInputRegistrationV1["intendedRoles"];
    version: ExternalInputRegistrationV1["version"];
    body: string | null;
  }>;
};
const SHA = (character: string) => character.repeat(64);

describe("external input manifest contracts", () => {
  it("round-trips an authenticated multi-source manifest and leaves decoded copies inert", async () => {
    const capability = openExternalInputRegistry(fixture.binding);
    for (const entry of fixture.entries) {
      registerExternalInput(capability, registrationFromFixture(entry));
    }
    const manifest = await mint(capability, SHA("1"));
    assertExternalInputManifestAuthentic(manifest);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(manifest.entries).toHaveLength(fixture.entries.length);
    expect(manifest.entries.map((entry) => entry.inputId)).toEqual(
      [...fixture.entries.map((entry) => entry.inputId)].sort(),
    );

    const text = serializeExternalInputManifest(manifest);
    const decoded = decodePersistedExternalInputManifest(text);
    expect(decoded).toEqual(manifest);
    expectError(() => assertExternalInputManifestAuthentic(decoded), "authority-required");
    expect(restoreExternalInputManifest(decoded, capability)).toEqual(manifest);
  });

  it("keeps historical absence explicit and non-authorizing", () => {
    const historical = createHistoricalEmptyExternalInputManifest(fixture.binding);
    expect(historical.entries).toEqual([]);
    expect(historical.authorityStatus).toBe("historical-inert");
    expectError(() => assertExternalInputManifestAuthentic(historical), "authority-required");
    expect(EXTERNAL_INPUT_MIGRATION_POLICY.historicalAuthority).toBe("none");
  });

  it("rejects duplicate IDs, unknown keys, credential material, and locator substitution", () => {
    configureCredential(["glpat", "abcdefghijklmnopqrst"].join("-"));
    const capability = openExternalInputRegistry(fixture.binding);
    const first = registrationFromFixture(fixture.entries[0]!);
    registerExternalInput(capability, first);
    expectError(() => registerExternalInput(capability, first), "duplicate-input");

    expectError(
      () =>
        registerExternalInput(capability, {
          ...registrationFromFixture(fixture.entries[1]!),
          locator: {
            ...registrationFromFixture(fixture.entries[1]!).locator,
            adapterKind: "url",
          },
        }),
      "substitution",
    );

    expectError(
      () =>
        registerExternalInput(capability, {
          ...registrationFromFixture(fixture.entries[2]!),
          inputId: "glpat-abcdefghijklmnopqrst",
        }),
      "credential-material",
    );

    expectError(
      () => digestExternalInputLocator("https://example.invalid/?token=glpat-abcdefghijklmnopqrst"),
      "credential-material",
    );
  });

  it("enforces lifecycle and disclosure consistency", async () => {
    const capability = openExternalInputRegistry(fixture.binding);
    const readable = registrationFromFixture(fixture.entries[0]!);
    registerExternalInput(capability, readable);

    expectError(
      () =>
        transitionExternalInputLifecycle(capability, {
          inputId: readable.inputId,
          from: "supplied",
          to: "cited",
          reasonCode: "skip-access",
          evidenceSha256s: [SHA("2")],
        }),
      "lifecycle-conflict",
    );

    transitionExternalInputLifecycle(capability, {
      inputId: readable.inputId,
      from: "supplied",
      to: "accessed",
      reasonCode: "tool-open",
      evidenceSha256s: [SHA("3")],
    });
    transitionExternalInputLifecycle(capability, {
      inputId: readable.inputId,
      from: "accessed",
      to: "cited",
      reasonCode: "finding-support",
      evidenceSha256s: [SHA("4")],
    });

    expectError(
      () =>
        registerExternalInput(
          openExternalInputRegistry({
            runIdSha256: SHA("b"),
            repository: fixture.binding.repository,
          }),
          {
            ...readable,
            inputId: "input:bad-public-forbidden",
            visibility: "public",
            disclosurePolicy: "forbidden",
            initialLifecycle: "supplied",
          },
        ),
      "lifecycle-conflict",
    );

    const inaccessibleCapability = openExternalInputRegistry({
      runIdSha256: SHA("c"),
      repository: fixture.binding.repository,
    });
    registerExternalInput(inaccessibleCapability, {
      ...readable,
      inputId: "input:inaccessible",
      contentDigestSha256: null,
      locator: {
        adapterKind: "repository-document",
        locatorSha256: digestExternalInputLocator("repo://missing.md"),
        permissionClass: "inaccessible",
      },
      initialLifecycle: "inaccessible",
      disclosurePolicy: "identity-only",
    });
    const inaccessibleManifest = await mint(inaccessibleCapability, SHA("5"));
    expect(inaccessibleManifest.entries[0]!.lifecycleState).toBe("inaccessible");
  });

  it("rejects replayed receipts, copied capabilities, tampering, and unknown versions", async () => {
    const host = authority(SHA("6"));
    const first = openExternalInputRegistry(fixture.binding);
    registerExternalInput(first, registrationFromFixture(fixture.entries[0]!));
    await mintExternalInputManifest(first, host);

    const second = openExternalInputRegistry({
      runIdSha256: SHA("d"),
      repository: fixture.binding.repository,
    });
    registerExternalInput(second, {
      ...registrationFromFixture(fixture.entries[0]!),
      inputId: "input:second",
    });
    await expectErrorAsync(() => mintExternalInputManifest(second, host), "authority-replayed");

    const capability = openExternalInputRegistry(fixture.binding);
    registerExternalInput(capability, registrationFromFixture(fixture.entries[0]!));
    const manifest = await mint(capability, SHA("7"));
    const copied = { kind: "docsfab-external-input-host-capability" } as const;
    expectError(() => restoreExternalInputManifest(manifest, copied), "authority-required");

    const tampered = structuredClone(manifest);
    tampered.entries[0]!.safeTitle = "Substituted";
    expectError(() => decodeExternalInputManifest(tampered), "digest-mismatch");
    expectError(
      () => migrateExternalInputManifest({ ...manifest, schemaVersion: 2 }),
      "migration-required",
    );
  });

  it("snapshots registry contents before awaiting host verification", async () => {
    const capability = openExternalInputRegistry(fixture.binding);
    const registration = registrationFromFixture(fixture.entries[0]!);
    registerExternalInput(capability, registration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let challengeSeen = false;
    const host = internalCreateExternalInputHostAuthority({
      async verifyCurrent(challenge) {
        challengeSeen = true;
        await gate;
        return {
          status: "current" as const,
          challengeSha256: challenge.challengeSha256,
          observedAt: "2026-08-05T20:00:00.000Z",
          authorityReceiptSha256: SHA("8"),
        };
      },
    });
    const pending = mintExternalInputManifest(capability, host);
    expect(challengeSeen).toBe(true);
    // Late registration must not appear in the already-challenged manifest.
    registerExternalInput(capability, registrationFromFixture(fixture.entries[1]!));
    registration.safeTitle = "mutated-after-register";
    release();
    const manifest = await pending;
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.safeTitle).toBe(fixture.entries[0]!.safeTitle);
    expect(manifest.entries[0]!.inputId).toBe(fixture.entries[0]!.inputId);
  });

  it("enforces canonical persistence and content-minimized projections", async () => {
    const capability = openExternalInputRegistry(fixture.binding);
    for (const entry of fixture.entries) {
      registerExternalInput(capability, registrationFromFixture(entry));
    }
    const manifest = await mint(capability, SHA("9"));
    const canonical = serializeExternalInputManifest(manifest);
    expectError(() => decodePersistedExternalInputManifest(` ${canonical}`), "invalid-shape");
    const duplicate = canonical.replace("{", '{"kind":"docsfab-external-input-manifest",');
    expectError(() => decodePersistedExternalInputManifest(duplicate), "invalid-shape");

    const projection = projectExternalInputManifest(manifest);
    expect(projection.entries).toHaveLength(fixture.entries.length);
    expect(projection).not.toHaveProperty("safeTitle");
    expect(JSON.stringify(projection)).not.toContain("Guide");
    expect(JSON.stringify(projection)).not.toContain("repo://docs/guide.md");
    expect(JSON.stringify(projection)).not.toContain("Maintainers request");
    expect(Object.keys(publicApi).some((key) => key.startsWith("internal"))).toBe(false);
  });

  it("accepts gitlab-mr-note locator-digest records and rejects unknown kinds", async () => {
    const capability = openExternalInputRegistry(fixture.binding);
    const note = fixture.entries.find((entry) => entry.sourceKind === "gitlab-mr-note")!;
    registerExternalInput(capability, registrationFromFixture(note));
    const manifest = await mint(capability, SHA("e"));
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.sourceKind).toBe("gitlab-mr-note");
    expect(JSON.stringify(manifest)).not.toContain(note.body!);
    expect(JSON.stringify(manifest)).not.toContain(note.canonicalLocator);

    const unknownCapability = openExternalInputRegistry({
      runIdSha256: SHA("f"),
      repository: fixture.binding.repository,
    });
    const base = registrationFromFixture(note);
    for (const kind of ["github-pr-review-thread", "not-a-kind"] as const) {
      expectError(
        () =>
          registerExternalInput(unknownCapability, {
            ...base,
            inputId: `input:${kind}`,
            sourceKind: kind as ExternalInputRegistrationV1["sourceKind"],
            locator: {
              ...base.locator,
              adapterKind: kind as ExternalInputRegistrationV1["sourceKind"],
            },
          }),
        "invalid-value",
      );
    }
  });
});

describe("external input access capture", () => {
  it("registers fake adapters without treating supply as access", async () => {
    const capability = openExternalInputAccessCapture(fixture.binding);
    for (const entry of fixture.entries) {
      registerFakeExternalInput(capability, entry.inputId, {
        adapterKind: entry.sourceKind,
        canonicalLocator: entry.canonicalLocator,
        safeTitle: entry.safeTitle,
        body: entry.body,
        version: entry.version,
        visibility: entry.visibility,
        disclosurePolicy: entry.disclosurePolicy,
        intendedRoles: entry.intendedRoles,
      });
    }
    const unused = createExternalInputAccessLedger(capability);
    expect(unused.observations).toEqual([]);

    const repo = fixture.entries[0]!;
    const digest = canonicalDigest({
      kind: "docsfab-external-input-fake-body",
      adapterKind: repo.sourceKind,
      body: repo.body,
    });
    const opened = recordExternalInputAccess(capability, {
      inputId: repo.inputId,
      stepId: "step:audit",
      outcome: "opened",
      observedContentDigestSha256: digest,
      accessorId: "tool:read-repository-document",
      evidenceSha256s: [SHA("a")],
    });
    expect(opened.outcome).toBe("opened");

    expectError(
      () =>
        recordExternalInputAccess(capability, {
          inputId: "input:never-registered",
          stepId: "step:audit",
          outcome: "opened",
          observedContentDigestSha256: digest,
          accessorId: "tool:read-repository-document",
          evidenceSha256s: [SHA("b")],
        }),
      "invalid-value",
    );

    const changedBody = `${repo.body}\nchanged`;
    const changedDigest = canonicalDigest({
      kind: "docsfab-external-input-fake-body",
      adapterKind: repo.sourceKind,
      body: changedBody,
    });
    expectError(
      () =>
        recordExternalInputAccess(capability, {
          inputId: repo.inputId,
          stepId: "step:audit-2",
          outcome: "opened",
          observedContentDigestSha256: changedDigest,
          accessorId: "tool:read-repository-document",
          evidenceSha256s: [SHA("c")],
        }),
      "substitution",
    );

    recordExternalInputAccess(capability, {
      inputId: repo.inputId,
      stepId: "step:audit-3",
      outcome: "changed-after-registration",
      observedContentDigestSha256: changedDigest,
      accessorId: "tool:read-repository-document",
      evidenceSha256s: [SHA("d")],
    });

    const ledger = createExternalInputAccessLedger(capability);
    expect(ledger.observations).toHaveLength(2);
    const text = serializeExternalInputAccessLedger(ledger);
    expect(decodePersistedExternalInputAccessLedger(text)).toEqual(ledger);
    expect(decodeExternalInputAccessLedger(ledger).runIdSha256).toBe(fixture.binding.runIdSha256);

    const manifest = await mint(capability, SHA("0"));
    const repoEntry = manifest.entries.find((entry) => entry.inputId === repo.inputId)!;
    expect(repoEntry.lifecycleState).toBe("changed");
    expect(JSON.stringify(manifest)).not.toContain(repo.body!);
    expect(JSON.stringify(ledger)).not.toContain(repo.body!);
    const note = fixture.entries.find((entry) => entry.sourceKind === "gitlab-mr-note")!;
    expect(JSON.stringify(manifest)).not.toContain(note.body!);
    expect(JSON.stringify(ledger)).not.toContain(note.body!);
  });

  it("keeps inaccessible and excluded fake sources identifiable without bodies", async () => {
    const capability = openExternalInputAccessCapture({
      runIdSha256: SHA("e"),
      repository: fixture.binding.repository,
    });
    registerFakeExternalInput(capability, "input:denied", {
      adapterKind: "confluence-page",
      canonicalLocator: "confluence://SPACE/page/denied",
      safeTitle: "Denied page",
      body: null,
      version: { kind: "unavailable", reasonCode: "permission-denied" },
      visibility: "private",
      disclosurePolicy: "identity-only",
      intendedRoles: ["background"],
      inaccessible: true,
    });
    registerFakeExternalInput(capability, "input:excluded", {
      adapterKind: "upload",
      canonicalLocator: "upload://secret.bin",
      safeTitle: "Excluded upload",
      body: null,
      version: { kind: "unavailable", reasonCode: "policy-excluded" },
      visibility: "private",
      disclosurePolicy: "forbidden",
      intendedRoles: ["context"],
      excluded: true,
    });

    expectError(
      () =>
        recordExternalInputAccess(capability, {
          inputId: "input:denied",
          stepId: "step:read",
          outcome: "opened",
          observedContentDigestSha256: SHA("f"),
          accessorId: "tool:confluence",
          evidenceSha256s: [SHA("1")],
        }),
      "lifecycle-conflict",
    );

    recordExternalInputAccess(capability, {
      inputId: "input:excluded",
      stepId: "step:read",
      outcome: "excluded-by-policy",
      observedContentDigestSha256: null,
      accessorId: "tool:upload",
      evidenceSha256s: [SHA("2")],
    });

    const manifest = await mint(capability, SHA("3"));
    expect(manifest.entries.map((entry) => entry.lifecycleState).sort()).toEqual([
      "excluded",
      "inaccessible",
    ]);
  });
});

describe("external input citation and disclosure", () => {
  it("cites only registered accessed inputs and reconciles unused sources", async () => {
    const capability = openExternalInputAccessCapture(fixture.binding);
    openExternalInputCitationCapture(capability);
    const repo = fixture.entries[0]!;
    const slack = fixture.entries[1]!;
    for (const entry of [repo, slack]) {
      registerFakeExternalInput(capability, entry.inputId, {
        adapterKind: entry.sourceKind,
        canonicalLocator: entry.canonicalLocator,
        safeTitle: entry.safeTitle,
        body: entry.body,
        version: entry.version,
        visibility: entry.visibility,
        disclosurePolicy: entry.disclosurePolicy,
        intendedRoles: entry.intendedRoles,
      });
    }
    const digest = canonicalDigest({
      kind: "docsfab-external-input-fake-body",
      adapterKind: repo.sourceKind,
      body: repo.body,
    });
    const observation = recordExternalInputAccess(capability, {
      inputId: repo.inputId,
      stepId: "step:audit",
      outcome: "opened",
      observedContentDigestSha256: digest,
      accessorId: "tool:read-repository-document",
      evidenceSha256s: [SHA("1")],
    });
    const claim = SHA("2");
    const citation = citeExternalInput(capability, {
      inputId: repo.inputId,
      stepId: "step:audit",
      role: "evidence",
      supportedClaimSha256: claim,
      accessObservationSha256: observation.observationSha256,
    });
    expect(citation.kind).toBe("docsfab-external-input-citation");
    expect((citation as ExternalInputCitationV1).role).toBe("evidence");

    const unknown = citeExternalInput(capability, {
      inputId: "input:missing",
      stepId: "step:audit",
      role: "evidence",
      supportedClaimSha256: SHA("3"),
      accessObservationSha256: null,
    });
    expect(unknown.kind).toBe("docsfab-external-input-citation-diagnostic");

    const unused = citeExternalInput(capability, {
      inputId: slack.inputId,
      stepId: "step:audit",
      role: "requirement",
      supportedClaimSha256: SHA("4"),
      accessObservationSha256: null,
    });
    expect(unused.kind).toBe("docsfab-external-input-citation-diagnostic");

    const ledger = createExternalInputCitationLedger(capability);
    expect(ledger.citations).toHaveLength(1);
    expect(ledger.diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(ledger.reconciliation.find((entry) => entry.inputId === repo.inputId)?.state).toBe(
      "accessed-and-used",
    );
    expect(ledger.reconciliation.find((entry) => entry.inputId === slack.inputId)?.state).toBe(
      "supplied-but-unused",
    );
    expect(decodeExternalInputCitationLedger(ledger)).toEqual(ledger);
    expect(requireCitationsForClaims(capability, [claim])).toEqual([]);
    expect(requireCitationsForClaims(capability, [SHA("5")])).toHaveLength(1);

    const manifest = await mint(capability, SHA("6"));
    expect(manifest.entries.find((entry) => entry.inputId === repo.inputId)?.lifecycleState).toBe(
      "cited",
    );
  });

  it("clamps disclosure by policy and surface and blocks citation upgrades", () => {
    const capability = openExternalInputAccessCapture({
      runIdSha256: SHA("7"),
      repository: fixture.binding.repository,
    });
    const privateUpload = fixture.entries[3]!;
    registerFakeExternalInput(capability, privateUpload.inputId, {
      adapterKind: privateUpload.sourceKind,
      canonicalLocator: privateUpload.canonicalLocator,
      safeTitle: "Title with docsfab-provenance marker",
      body: null,
      version: privateUpload.version,
      visibility: "private",
      disclosurePolicy: "identity-only",
      intendedRoles: ["context"],
    });
    const repo = fixture.entries[0]!;
    registerFakeExternalInput(capability, repo.inputId, {
      adapterKind: repo.sourceKind,
      canonicalLocator: repo.canonicalLocator,
      safeTitle: repo.safeTitle,
      body: repo.body,
      version: repo.version,
      visibility: repo.visibility,
      disclosurePolicy: repo.disclosurePolicy,
      intendedRoles: repo.intendedRoles,
    });

    const patchProjection = projectExternalInputDisclosure(capability, {
      inputId: privateUpload.inputId,
      surface: "patch",
      requestedLevel: "public-content",
      canonicalLocator: privateUpload.canonicalLocator,
      excerptCandidate: "private body must not appear",
    });
    expect(patchProjection.level).toBe("opaque-identity");
    expect(patchProjection.safeLabel).toBeNull();
    expect(patchProjection.boundedExcerpt).toBeNull();
    expect(JSON.stringify(patchProjection)).not.toContain("private body");

    const mrProjection = projectExternalInputDisclosure(capability, {
      inputId: repo.inputId,
      surface: "mr-description",
      requestedLevel: "bounded-excerpt",
      canonicalLocator: repo.canonicalLocator,
      excerptCandidate: "Bounded documentation improvement.",
    });
    expect(mrProjection.level).toBe("permission-aware-link");
    expect(mrProjection.safeLabel).toBe("Guide");
    expect(mrProjection.boundedExcerpt).toBeNull();

    const promptProjection = projectExternalInputDisclosure(capability, {
      inputId: repo.inputId,
      surface: "prompt",
      requestedLevel: "bounded-excerpt",
      excerptCandidate: "Bounded documentation improvement.",
    });
    expect(promptProjection.level).toBe("bounded-excerpt");
    expect(promptProjection.boundedExcerpt).toContain("Bounded documentation");

    const cleaned = sanitizeExternalInputMetadata("# Title docsfab-provenance marker text");
    expect(cleaned.toLowerCase()).toContain("docsfab-provenance-ref");
    expect(cleaned).not.toContain("#");
    // Sanitizing twice (Slack labels re-sanitize) must not grow the suffix.
    expect(sanitizeExternalInputMetadata(cleaned)).toBe(cleaned);
    const live = sanitizeExternalInputMetadata("note <!-- docsfab-publication-provenance:v1 -->");
    expect(live).toBe("note !-- docsfab-publication-provenance-ref:v1 --");
    expect(sanitizeExternalInputMetadata(live)).toBe(live);
    expect(sanitizeExternalInputMetadata("docsfab-provenances and docsfab-run notes")).toBe(
      "docsfab-provenances and docsfab-run notes",
    );
  });
});

function registrationFromFixture(
  entry: (typeof fixture.entries)[number],
): ExternalInputRegistrationV1 {
  const metadataOnly =
    entry.body === null ||
    entry.disclosurePolicy === "identity-only" ||
    entry.disclosurePolicy === "redacted" ||
    entry.disclosurePolicy === "forbidden";
  const contentDigestSha256 =
    entry.body === null || metadataOnly
      ? null
      : canonicalDigest({
          kind: "docsfab-external-input-fake-body",
          adapterKind: entry.sourceKind,
          body: entry.body,
        });
  return {
    inputId: entry.inputId,
    sourceKind: entry.sourceKind,
    safeTitle: entry.safeTitle,
    locator: {
      adapterKind: entry.sourceKind,
      locatorSha256: digestExternalInputLocator(entry.canonicalLocator),
      permissionClass: metadataOnly ? "metadata-only" : "readable",
    },
    supplier: structuredClone(fixture.supplier),
    version: structuredClone(entry.version),
    contentDigestSha256,
    visibility: entry.visibility,
    disclosurePolicy: entry.disclosurePolicy,
    intendedRoles: [...entry.intendedRoles].sort(),
    initialLifecycle: "supplied",
  };
}

async function mint(capability: ReturnType<typeof openExternalInputRegistry>, receipt: string) {
  return mintExternalInputManifest(capability, authority(receipt));
}

function authority(receipt: string) {
  return internalCreateExternalInputHostAuthority({
    async verifyCurrent(challenge) {
      return {
        status: "current" as const,
        challengeSha256: challenge.challengeSha256,
        observedAt: "2026-08-05T20:00:00.000Z",
        authorityReceiptSha256: receipt,
      };
    },
  });
}

function expectError(run: () => unknown, code: ExternalInputContractError["code"]): void {
  try {
    run();
    throw new Error("Expected external-input failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalInputContractError);
    expect((error as ExternalInputContractError).code).toBe(code);
  }
}

async function expectErrorAsync(
  run: () => Promise<unknown>,
  code: ExternalInputContractError["code"],
): Promise<void> {
  try {
    await run();
    throw new Error("Expected external-input failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalInputContractError);
    expect((error as ExternalInputContractError).code).toBe(code);
  }
}
