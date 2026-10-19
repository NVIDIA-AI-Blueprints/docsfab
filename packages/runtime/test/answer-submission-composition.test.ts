// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The recorded answer-submission capability on installed compositions
 * (#1707): its decode, the composition path's bound profile, the composition
 * execution evidence, and the exact-model, proven-origin borrow by an
 * unmatched chat-completions endpoint. No shipped composition records the
 * capability before its qualification probe, so each case seals its own
 * self-consistent copy of the package assets.
 */
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import { decodeCompositionRegistry } from "../src/model-composition/contracts.js";
import {
  loadInstalledModelCompositionAuthorityFromTrustedRootForTest,
  recordedAnswerSubmissionForModel,
  resolveInstalledExecutableComposition,
} from "../src/model-composition/installed.js";
import {
  ModelCompositionError,
  type InstalledAnswerSubmission,
  type InstalledModelCompositionAuthority,
} from "../src/model-composition/types.js";
import type { ModelEndpointConfig } from "../src/model/configuration.js";
import { createCompositionExecutionEvidence } from "../src/records/composition-execution.js";
import { validModelConfig } from "./helpers.js";

const holder = vi.hoisted(() => ({
  authority: undefined as Promise<{ authority: InstalledModelCompositionAuthority }> | undefined,
}));

// The operator binder loads the package authority once; it reads this test's
// sealed copy instead.
vi.mock("../src/model-composition/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model-composition/index.js")>();
  return {
    ...actual,
    loadInstalledModelCompositionAuthority: () =>
      holder.authority ?? actual.loadInstalledModelCompositionAuthority(),
  };
});

const { resolveOperatorExecutionBinding } = await import(
  "../src/model/operator-execution-binding.js"
);

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const SUPER_PI = "nvidia-nemotron-3-super-120b-a12b-pi";
const CATALOG_ORIGIN = "https://integrate.api.nvidia.com";
const SELF_HOSTED_ORIGIN = "https://nim.example.test";
const CAPABILITY: InstalledAnswerSubmission = {
  kind: "host-tool-call",
  argumentShell: "untyped",
  duplicateKeys: "unobserved",
  reportTurnToolChoice: "none",
  evidenceSha256: "d".repeat(64),
};

type Json = Record<string, any>;
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function reseal<T extends Json>(entry: T, key: string): T {
  const { [key]: _old, ...body } = entry;
  return { ...body, [key]: canonicalDigest(body) } as T;
}

/**
 * A sealed copy of the package's composition assets after `edit`, loaded as an
 * authority: every edited record, candidate, registry, and the manifest are
 * redigested so the loader's checks still hold.
 */
async function sealedAuthority(
  edit: (assets: { compositions: Json[]; candidates: Json[]; adapters: Json[] }) => void,
): Promise<InstalledModelCompositionAuthority> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-answer-submission-assets-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  const assetRoot = join(packageRoot, "model-compositions");
  await Promise.all([
    cp(join(runtimeRoot, "model-compositions"), assetRoot, { recursive: true }),
    cp(join(runtimeRoot, "workflows"), join(packageRoot, "workflows"), { recursive: true }),
  ]);
  const read = async (name: string) => JSON.parse(await readFile(join(assetRoot, name), "utf8"));
  const compositionRegistry = await read("composition-registry.json");
  const candidateRegistry = await read("candidate-projections.json");
  const adapterRegistry = await read("adapter-registry.json");
  const manifest = await read("installed-manifest.json");
  edit({
    compositions: compositionRegistry.compositions,
    candidates: candidateRegistry.candidates,
    adapters: adapterRegistry.adapters,
  });
  compositionRegistry.compositions = compositionRegistry.compositions.map((entry: Json) =>
    reseal(entry, "compositionSha256"),
  );
  const sealedBy = new Map<string, string>(
    compositionRegistry.compositions.map((entry: Json) => [
      entry.compositionId,
      entry.compositionSha256,
    ]),
  );
  candidateRegistry.candidates = candidateRegistry.candidates.map((entry: Json) =>
    reseal({ ...entry, compositionSha256: sealedBy.get(entry.compositionId) }, "candidateSha256"),
  );
  const sealedRegistries = {
    "composition-registry": reseal(compositionRegistry, "registrySha256"),
    "candidate-projections": reseal(candidateRegistry, "registrySha256"),
    "adapter-registry": reseal(adapterRegistry, "registrySha256"),
  };
  const fileSha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  for (const [kind, registry] of Object.entries(sealedRegistries)) {
    const text = `${JSON.stringify(registry, null, 2)}\n`;
    await writeFile(join(assetRoot, `${kind}.json`), text);
    const asset = manifest.assets.find((entry: Json) => entry.kind === kind);
    asset.fileSha256 = fileSha256(text);
    asset.contractSha256 = registry.registrySha256;
  }
  const sealedManifest = reseal(manifest, "installedManifestSha256");
  const manifestText = `${JSON.stringify(sealedManifest, null, 2)}\n`;
  await writeFile(join(assetRoot, "installed-manifest.json"), manifestText);
  const { authority } = await loadInstalledModelCompositionAuthorityFromTrustedRootForTest(
    assetRoot,
    fileSha256(manifestText),
  );
  return authority;
}

const recordOnSuper = (assets: { compositions: Json[] }) => {
  const entry = assets.compositions.find((composition) => composition.compositionId === SUPER_PI)!;
  entry.answerSubmission = { ...CAPABILITY };
};

/**
 * A second Super composition sealed over a self-hosted origin, with the
 * capability; the original keeps none. Its identity is not the catalog
 * route's, so no origin can be proven for it.
 */
const recordOnUnprovenClone = (assets: {
  compositions: Json[];
  candidates: Json[];
  adapters: Json[];
}) => {
  const source = assets.compositions.find((composition) => composition.compositionId === SUPER_PI)!;
  const identitySha256 = canonicalDigest({
    schemaVersion: 1,
    origin: SELF_HOSTED_ORIGIN,
    route: "/v1/chat/completions",
    provider: source.deployment.provider,
  });
  const cloneId = `${SUPER_PI}-self-hosted`;
  const routeAdapter = assets.adapters.find(
    (adapter) =>
      adapter.kind === "route-evidence" && adapter.id === source.adapters.routeEvidence.id,
  )!;
  const connectionAdapter = assets.adapters.find(
    (adapter) =>
      adapter.kind === "provider-connection" &&
      adapter.id === source.adapters.providerConnection.id,
  )!;
  const routeId = `${routeAdapter.id}-self-hosted`;
  const connectionId = `${connectionAdapter.id}-self-hosted`;
  assets.adapters.push(
    { ...routeAdapter, id: routeId, deploymentIdentitySha256: identitySha256 },
    { ...connectionAdapter, id: connectionId, deploymentIdentitySha256: identitySha256 },
  );
  assets.compositions.push({
    ...source,
    compositionId: cloneId,
    deployment: { ...source.deployment, identitySha256 },
    requestPolicy: reseal(
      { ...source.requestPolicy, deploymentIdentitySha256: identitySha256 },
      "policySha256",
    ),
    adapters: {
      ...source.adapters,
      routeEvidence: { ...source.adapters.routeEvidence, id: routeId },
      providerConnection: { ...source.adapters.providerConnection, id: connectionId },
    },
    answerSubmission: { ...CAPABILITY },
  });
  const candidate = assets.candidates.find((entry) => entry.compositionId === SUPER_PI)!;
  assets.candidates.push({
    ...candidate,
    candidateId: `${candidate.candidateId}-self-hosted`,
    compositionId: cloneId,
    deploymentIdentitySha256: identitySha256,
    providerConnectionAdapter: { ...candidate.providerConnectionAdapter, id: connectionId },
  });
};

describe("the composition record's answerSubmission", () => {
  it("decodes with and without the optional field, and refuses an unknown value", async () => {
    const registry = JSON.parse(
      await readFile(join(runtimeRoot, "model-compositions/composition-registry.json"), "utf8"),
    );
    expect(
      decodeCompositionRegistry(registry).compositions.every(
        (composition) => composition.answerSubmission === undefined,
      ),
    ).toBe(true);
    const withField = (answerSubmission: unknown) => {
      const copy = structuredClone(registry);
      const entry = copy.compositions.find(
        (composition: Json) => composition.compositionId === SUPER_PI,
      );
      entry.answerSubmission = answerSubmission;
      copy.compositions = copy.compositions.map((composition: Json) =>
        reseal(composition, "compositionSha256"),
      );
      return reseal(copy, "registrySha256");
    };
    expect(
      decodeCompositionRegistry(withField(CAPABILITY)).compositions.find(
        (composition) => composition.compositionId === SUPER_PI,
      )?.answerSubmission,
    ).toEqual(CAPABILITY);
    for (const bad of [
      { ...CAPABILITY, argumentShell: "schema" },
      { ...CAPABILITY, duplicateKeys: "collapsed" },
      { ...CAPABILITY, kind: "json-mode" },
      { ...CAPABILITY, extra: true },
    ]) {
      expect(() => decodeCompositionRegistry(withField(bad))).toThrow(ModelCompositionError);
    }
  });
});

describe("the exact-model, proven-origin borrow", () => {
  let recorded: InstalledModelCompositionAuthority;
  let unproven: InstalledModelCompositionAuthority;

  beforeAll(async () => {
    recorded = await sealedAuthority(recordOnSuper);
    unproven = await sealedAuthority(recordOnUnprovenClone);
  }, 60_000);

  it("returns the capability only for the exact model on its proven origin over chat completions", () => {
    const lookup = (
      overrides: Partial<{ modelId: string; transport: string; endpointOrigin: string }>,
    ) =>
      recordedAnswerSubmissionForModel(recorded, {
        modelId: SUPER,
        transport: "openai-chat-completions",
        endpointOrigin: CATALOG_ORIGIN,
        ...overrides,
      });
    expect(lookup({})).toEqual(CAPABILITY);
    expect(lookup({ endpointOrigin: SELF_HOSTED_ORIGIN })).toBeUndefined();
    expect(lookup({ modelId: "nvidia/nemotron-3-ultra-550b-a55b" })).toBeUndefined();
    expect(lookup({ transport: "openai-responses" })).toBeUndefined();
  });

  it("never borrows from a composition whose recorded origin cannot be proven", () => {
    for (const endpointOrigin of [CATALOG_ORIGIN, SELF_HOSTED_ORIGIN]) {
      expect(
        recordedAnswerSubmissionForModel(unproven, {
          modelId: SUPER,
          transport: "openai-chat-completions",
          endpointOrigin,
        }),
      ).toBeUndefined();
    }
  });

  describe("through the operator binder", () => {
    beforeAll(() => {
      holder.authority = Promise.resolve({ authority: recorded });
    });

    function unmatched(baseUrl: string, reasoning: boolean): ModelEndpointConfig {
      return {
        ...validModelConfig,
        providerId: "operator-configured-openai-compatible",
        baseUrl,
        modelId: SUPER,
        transport: "openai-chat-completions",
        profile: { ...validModelConfig.profile, reasoning },
      };
    }

    it("lends the capability to an unmatched endpoint on the proven origin, whatever its reasoning", async () => {
      for (const reasoning of [false, true]) {
        const binding = await resolveOperatorExecutionBinding({
          model: unmatched(`${CATALOG_ORIGIN}/v1`, reasoning),
        });
        expect(binding.match).toBe("unmatched-byo");
        expect(binding.profile.answerSubmission).toEqual(CAPABILITY);
      }
    });

    it("lends nothing to the same model behind another origin", async () => {
      const binding = await resolveOperatorExecutionBinding({
        model: unmatched(`${SELF_HOSTED_ORIGIN}/v1`, false),
      });
      expect(binding.match).toBe("unmatched-byo");
      expect(binding.profile.answerSubmission).toBeUndefined();
    });

    it("binds the composition's own capability on the composition path, and its evidence admits it", async () => {
      const bound = resolveInstalledExecutableComposition({
        authority: recorded,
        compositionId: SUPER_PI,
        workflowId: "review-documentation",
      });
      const configuredLimits = { ...bound.composition.compositionLimits };
      const binding = await resolveOperatorExecutionBinding({
        model: {
          ...validModelConfig,
          profile: {
            ...validModelConfig.profile,
            configuredLimits: {
              contextWindow: configuredLimits.contextWindow,
              maxInputTokens: configuredLimits.maxInputTokens,
              maxOutputTokens: configuredLimits.maxOutputTokens,
            },
          },
          providerId: "nvidia-api-catalog",
          baseUrl: `${CATALOG_ORIGIN}/v1`,
          modelId: SUPER,
          credentialEnv: "DOCSFAB_NVIDIA_API_KEY",
        },
        compositionId: SUPER_PI,
        bound,
        configuredLimits,
        attachCompositionPolicy: true,
        credential: { family: "nvidia-api-catalog", apiKey: "composition-test-key" },
      });
      expect(binding.profile.answerSubmission).toEqual(CAPABILITY);
      const evidence = (executionProfile: typeof binding.profile) =>
        createCompositionExecutionEvidence({
          runId: "answer-submission-run",
          bound,
          executionProfile,
          configuredLimits,
          workflow: { id: bound.workflow.workflowId, sourceSha256: bound.workflow.sourceSha256 },
          repository: { identitySha256: "a".repeat(64), revision: "b".repeat(40) },
        });
      expect(() => evidence(binding.profile)).not.toThrow();
      expect(() =>
        evidence({
          ...binding.profile,
          answerSubmission: { ...CAPABILITY, argumentShell: "typed" },
        }),
      ).toThrow(/subject-mismatch/u);
    });
  });
});
