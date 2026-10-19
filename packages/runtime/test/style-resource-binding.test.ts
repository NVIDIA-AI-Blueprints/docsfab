// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildRuntimeQualityLock } from "../scripts/generate-quality-pack.mjs";
import { QUALITY_RUNTIME_POLICY_ROOT, QUALITY_SOURCE_ROOTS } from "../scripts/derived-products.mjs";
import {
  createReaderTaskContextSupplier,
  createStyleTaskContext,
  QualityResourceLimitError,
} from "../src/execution/task-context.js";
import { limit } from "../src/config/limits.js";
import {
  parseRuntimeQualityLock,
  type VerifiedQualityPackContext,
} from "../src/quality-pack/manifest.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import type { QualityProfileSelectionReceiptV1 } from "../src/records/contracts.js";
import { temporaryRoots } from "./helpers/temp.js";
import { unverifiedVerificationResultFixture } from "./helpers/verification.js";
import {
  createAuditHarness,
  createRepository,
  firstUserMessageText,
  getWorkflow,
  projectRoot,
  qualityDirectory,
  resetSharedTestState,
  reviewStepInput,
  scriptedProvider,
  skillCrateDirectory,
  stepInput,
  textTurn,
  verifyQualityPackContext,
} from "./support/pi-harness-session-fixtures.js";

const qualitySourceRoot = resolve(projectRoot, "../quality");
const roots = temporaryRoots();

afterEach(async () => {
  await resetSharedTestState();
  await roots.cleanup();
});

async function installedPack() {
  return verifyQualityPackContext({
    qualityDirectory,
    qualityPackDirectory: resolve(projectRoot, "quality-pack"),
    skillCrateDirectory,
  });
}

/**
 * A copy of the quality source tree whose declaration names a house style
 * profile. The lock comes from the real generator, so nothing in source changes.
 */
async function sourceWithHouseStyle(styleGuide = "# House style\n\nUse sentence case.\n") {
  const root = await roots.create("docsfab-style-binding-");
  for (const subtree of [...QUALITY_SOURCE_ROOTS, QUALITY_RUNTIME_POLICY_ROOT]) {
    await cp(resolve(qualitySourceRoot, subtree), join(root, subtree), { recursive: true });
  }
  await mkdir(join(root, "profiles/house-style"), { recursive: true });
  await writeFile(
    join(root, "profiles/house-style/profile.json"),
    '{"id":"house-style","version":"2026-10-05"}\n',
  );
  await writeFile(join(root, "profiles/house-style/style-guide.md"), styleGuide);
  await writeFile(join(root, "profiles/house-style/TERMINOLOGY.md"), "# Terms\n\nwidget\n");
  const declarationPath = join(root, "profiles/product-default.json");
  const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
  declaration.style_profile.bar_id = "profile:house-style";
  await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`);
  const qualityLock = parseRuntimeQualityLock(
    JSON.parse(JSON.stringify(await buildRuntimeQualityLock(root))),
  );
  return { qualityRoot: await realpath(root), qualityLock };
}

describe("product-default style profile binding", () => {
  it("binds the NVIDIA profile and gives writer, reviewer, and evaluator the digest the run record names", async () => {
    const pack = await installedPack();
    const style = pack.evidence.resolvedResources?.resources.find(
      (resource) => resource.kind === "style-profile",
    );
    expect(style).toMatchObject({
      id: "profile:nvidia-technical-documentation",
      layer: "product",
    });
    expect(pack.evidence.resolvedResources?.unresolvedLayers).toEqual([
      "organization",
      "target",
      "request",
    ]);
    const harness = await createAuditHarness();
    const review = getWorkflow("review-documentation");
    const update = getWorkflow("update-documentation");
    const steps = [
      update.steps.find((step) => step.skill === "write-documentation")!,
      review.steps.find((step) => step.skill === "review-documentation")!,
      review.steps.find((step) => step.skill === "evaluate-document-quality")!,
    ];
    const guide = await readFile(
      join(qualityDirectory, "profiles/nvidia-technical-documentation/style-guide.md"),
      "utf8",
    );
    const terminology = await readFile(
      join(qualityDirectory, "profiles/nvidia-technical-documentation/TERMINOLOGY.md"),
      "utf8",
    );
    for (const step of steps) {
      const context = await harness.boundStyleContext({ step });
      expect(context?.resource, step.id).toEqual(style);
      expect(context?.prompt, step.id).toContain(`sha256 ${style!.sha256}`);
      expect(context?.prompt, step.id).toContain(guide);
      expect(context?.prompt, step.id).toContain(terminology);
    }
    const verifier = review.steps.find((step) => step.skill === "verify-technical-accuracy")!;
    expect(await harness.boundStyleContext({ step: verifier })).toBeUndefined();
  });

  it("sends the bound style profile to the provider in a writer step's first request", async () => {
    const repositoryPath = await createRepository();
    const pack = await installedPack();
    const digest = pack.evidence.resolvedResources!.resources[0]!.sha256;
    const bodies: string[] = [];
    const provider = scriptedProvider([textTurn("The requested documentation was updated.")]);
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return provider(request, init);
    });
    const workflow = getWorkflow("restructure-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "write-documentation")!;
    await (await createAuditHarness()).runStep({ ...stepInput(repositoryPath), workflow, step });
    const sent = firstUserMessageText(bodies[0]!);
    expect(sent).toContain("Bound style profile, supplied by the host");
    expect(sent).toContain(`profile:nvidia-technical-documentation@`);
    expect(sent).toContain(`sha256 ${digest}`);
  });

  it("sends the same style digest in the reviewer and evaluator steps' first requests", async () => {
    const repositoryPath = await createRepository();
    const pack = await installedPack();
    const digest = pack.evidence.resolvedResources!.resources.find(
      (resource) => resource.kind === "style-profile",
    )!.sha256;
    const sentFor = async (
      run: (harness: Awaited<ReturnType<typeof createAuditHarness>>) => Promise<unknown>,
      reply: string,
    ) => {
      const bodies: string[] = [];
      const provider = scriptedProvider([textTurn(reply)]);
      vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return provider(request, init);
      });
      // Only the first request is under test; the step's reply handling is not.
      await run(await createAuditHarness()).catch((error: unknown) => error);
      vi.unstubAllGlobals();
      return firstUserMessageText(bodies[0]!);
    };
    const issue = {
      id: "STYLE-001",
      severity: "minor",
      category: "style_compliance",
      location: "README.md:1",
      finding: "The heading is not in title case.",
      evidence: { source_id: "source-1", locator: "README.md:1" },
      required_change: "Use title case.",
    };
    const reviewer = await sentFor(
      (harness) => harness.runStep(reviewStepInput(repositoryPath, "review-documentation")),
      JSON.stringify({ issues: [issue], verdict: "needs-revision" }),
    );
    const workflow = getWorkflow("review-documentation");
    const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
    const profileAssetPath = pack.qualityLock.productDefaults.evaluation.assetPath;
    const evaluator = await sentFor(
      (harness) =>
        harness.runStep({
          runId: "style-binding-evaluator",
          repositoryPath,
          workflow,
          step: workflow.steps.find((step) => step.skill === "evaluate-document-quality")!,
          evidenceIdentity: {
            repositoryRevision: "a".repeat(40),
            technicalVerificationSha256: canonicalDigest(technicalVerification),
          },
          qualityProfileSelection: {
            selectionSha256: "a".repeat(64),
            repositoryRevision: "a".repeat(40),
            skillLockSha256: pack.evidence.skillLockSha256,
            qualityLockSha256: pack.evidence.qualityLockSha256,
            qualityBundleSha256: pack.evidence.qualityBundleSha256,
            profileAssetPath,
            profilePayloadSha256: pack.qualityLock.files.find(
              (file) => file.path === profileAssetPath,
            )!.sha256,
            profileId: pack.qualityLock.productDefaults.evaluation.profileId,
            profileVersion: pack.qualityLock.productDefaults.evaluation.version,
            profileModel: "documentation-quality-model-v0.2",
          } as unknown as QualityProfileSelectionReceiptV1,
          technicalVerification,
          verificationTargetPaths: ["README.md"],
        }),
      "{}",
    );
    for (const [role, sent] of [
      ["reviewer", reviewer],
      ["evaluator", evaluator],
    ] as const) {
      expect(sent, role).toContain("Bound style profile, supplied by the host");
      expect(sent, role).toContain("profile:nvidia-technical-documentation@");
      expect(sent, role).toContain(`sha256 ${digest}`);
    }
  });

  it("refuses a style-bound step when run admission bound no style profile, without reading the lock", async () => {
    // The mounted payload stays available, so a harness that re-read the lock would still bind.
    const harness = await createAuditHarness({ qualityDirectory, styleContext: undefined });
    const input = reviewStepInput("/tmp/repository", "review-documentation");
    let refusal: unknown;
    try {
      harness.boundStyleContext(input);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "lock-unavailable" });
  });

  it("binds whatever profile the declaration names, with no source edit", async () => {
    const pack = await sourceWithHouseStyle();
    const context = await createStyleTaskContext(pack);
    expect(context.resource).toMatchObject({
      kind: "style-profile",
      id: "profile:house-style",
      layer: "product",
      version: "2026-10-05",
      sha256: pack.qualityLock.productDefaults.style.sha256,
    });
    expect(context.files.map((file) => file.path)).toEqual([
      "profiles/house-style/style-guide.md",
      "profiles/house-style/TERMINOLOGY.md",
    ]);
    expect(context.prompt).toContain("Use sentence case.");
    expect(context.prompt).not.toContain("NVIDIA");
  });

  it("reads the reader-impact baseline and policy from the declared evaluation profile", async () => {
    const pack = await sourceWithHouseStyle();
    const supplier = await createReaderTaskContextSupplier(
      pack as unknown as VerifiedQualityPackContext,
    );
    const declared = pack.qualityLock.productDefaults.evaluation;
    expect(supplier.baseline.path).toBe(declared.readerImpactBaselinePath);
    expect(supplier.policy).toMatchObject({ id: declared.profileId, version: declared.version });

    const moved = structuredClone(pack.qualityLock);
    moved.productDefaults.evaluation.version = "v9";
    await expect(
      createReaderTaskContextSupplier({
        ...pack,
        qualityLock: moved,
      } as unknown as VerifiedQualityPackContext),
    ).rejects.toMatchObject({ code: "pack-mismatch" });
  });

  it("refuses an oversized style resource with the limit code, observed size, and resource id", async () => {
    const bound = limit("execution.styleResourceMaxBytes");
    const pack = await sourceWithHouseStyle(`# House style\n\n${"a".repeat(bound.value)}\n`);
    const observed =
      Buffer.byteLength(`# House style\n\n${"a".repeat(bound.value)}\n`) +
      Buffer.byteLength("# Terms\n\nwidget\n");
    const refusal = await createStyleTaskContext(pack).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(QualityResourceLimitError);
    expect(refusal).toMatchObject({
      code: "style-resource-max-bytes-bound",
      limitName: "execution.styleResourceMaxBytes",
      observed,
      resourceId: "profile:house-style",
    });
    expect((refusal as Error).message).toContain(`${observed} exceeds`);
    expect((refusal as Error).message).toContain("Resource: profile:house-style.");
  });
});
