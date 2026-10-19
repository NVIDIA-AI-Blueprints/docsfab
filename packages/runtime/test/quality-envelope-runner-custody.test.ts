// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { limit } from "../src/config/limits.js";
import { DEFAULT_ANSWER_SUBMISSION_OPTION } from "../src/config/answer-submission.js";
import {
  InferenceStepError,
  type HarnessStepInput,
  type HarnessStepResult,
} from "../src/execution/contracts.js";
import { createStyleTaskContext } from "../src/execution/task-context.js";
import { PiHarness } from "../src/harness/pi.js";
import {
  bindQualityArtifactResponseContract,
  isEditorialAssessmentStep,
} from "../src/harness/editorial-response-contract.js";
import { admitEditorialAssessmentReply } from "../src/harness/reply-admission/editorial-assessment.js";
import {
  admitQualityArtifactReply,
  qualityTextRefusalBehind,
} from "../src/harness/reply-admission/quality-artifact.js";
import type { ReplyAdmissionContext } from "../src/harness/reply-admission/context.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { chunkedTextTurn } from "./support/answer-submission-fixtures.js";
import { runAuthoringUpdateQualityProducerFixture } from "./support/authoring-update-quality-runner.js";
import { loadSavedRunEditorialDecodeOptions } from "../src/cli/run/editorial-replay.js";
import { loadVerifiedCheckoutRun, loadVerifiedPublicationRun } from "../src/delivery/preflight.js";
import { LiveWorkflowDelivery } from "../src/live-agent/workflow-delivery.js";
import { FileRunStore } from "../src/records/file-store.js";

const roots = temporaryRoots();
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await roots.cleanup();
});
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const timeout = testTimeoutMs(limit("test.journeyLocalTimeoutMs").value);
const reference = {
  kind: "context-packet" as const,
  schemaVersion: 1 as const,
  digest: "a".repeat(64),
  repositoryRevision: "b".repeat(40),
  repositoryContentDigest: "c".repeat(64),
};
const assessment = {
  schemaVersion: 1,
  kind: "docsfab-editorial-assessment-proposal",
  assessment: "accepted",
  rationale: "The admitted public source supports this independent assessment.",
  evidenceRefs: [reference],
  limitations: [],
  recommendation: null,
};
const skill = { id: "evaluate-document-quality", contentSha256: "d".repeat(64) };

function input(): HarnessStepInput {
  const workflow = getWorkflow("update-documentation");
  if (workflow.schemaVersion !== 2 || !workflow.branching)
    throw new Error("The shipped UPDATE workflow is not V2.");
  return {
    workflow,
    step: workflow.branching.branches
      .flatMap((branch) => branch.steps)
      .find((step) => step.id === "evaluate-document-quality")!,
    repositoryPath: "/fixture",
    runId: "quality-text-custody",
    inferenceAttempt: 1,
    evidenceIdentity: { repositoryRevision: reference.repositoryRevision },
    editorialEvidenceRefs: [reference],
    editorialCandidate: { reference } as unknown as HarnessStepInput["editorialCandidate"],
    qualityProfileSelection: {
      selectionSha256: "e".repeat(64),
    } as HarnessStepInput["qualityProfileSelection"],
  };
}
function context(reply: string): ReplyAdmissionContext {
  return {
    decodedResponse: reply,
    collectAttemptEvidence: () => ({ model: { provider: "offline", model: "fixture" } }),
    refuseContractPlaceholder: () => undefined,
  };
}
function failure(run: () => unknown): InferenceStepError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceStepError);
    return error as InferenceStepError;
  }
  throw new Error("The malformed reply unexpectedly admitted a quality candidate.");
}
function refusal(
  current: HarnessStepInput,
  inner = '{"evaluation":',
  skillEvidence: HarnessStepResult["skill"] = skill,
) {
  const reply = JSON.stringify({ summary: inner, editorialAssessmentProposal: assessment });
  const outer = admitEditorialAssessmentReply(current, reply, context(reply));
  const error = failure(() =>
    admitQualityArtifactReply(current, outer.summary, context(reply), {
      admission: outer,
      skill: skillEvidence,
    }),
  );
  return { error, outer };
}

describe("private final quality text custody", () => {
  it("retains only the actual admitted proposal on the typed inner JSON refusal", () => {
    const current = input();
    const { error, outer } = refusal(current);
    const held = qualityTextRefusalBehind(error, current);
    expect(held?.proposal).toBe(outer.editorialAssessmentProposal);
    expect(held?.rejection).toEqual({ code: "quality-envelope-json", location: "$.evaluation" });
    expect(Object.isFrozen(held?.proposal)).toBe(true);
    expect(JSON.stringify(error)).not.toContain(assessment.rationale);
    expect(JSON.stringify(error)).not.toContain('{"evaluation":');
    expect(qualityTextRefusalBehind(Object.create(error), current)).toBeUndefined();
    expect(
      qualityTextRefusalBehind(
        new InferenceStepError(
          "same code",
          "malformed-response",
          true,
          error.evidence,
          error.rejection,
        ),
        current,
      ),
    ).toBeUndefined();
  });

  it("refuses stale attempts and changed run, candidate, profile and evidence bindings", () => {
    const current = input();
    const { error } = refusal(current);
    for (const changed of [
      { ...current, inferenceAttempt: 2 },
      { ...current, runId: "another-run" },
      {
        ...current,
        editorialCandidate: {
          ...current.editorialCandidate,
          reference: { ...reference, digest: "f".repeat(64) },
        },
      },
      {
        ...current,
        qualityProfileSelection: {
          ...current.qualityProfileSelection,
          selectionSha256: "f".repeat(64),
        },
      },
      { ...current, evidenceIdentity: { repositoryRevision: "f".repeat(40) } },
    ])
      expect(qualityTextRefusalBehind(error, changed as HarnessStepInput)).toBeUndefined();
  });

  it("keeps the returned carrier and its copied skill metadata immutable", () => {
    const current = input();
    const suppliedSkill = {
      ...skill,
      source: { repository: "fixture", revision: "d".repeat(40), path: "original-skill.md" },
    };
    const { error, outer } = refusal(current, '{"evaluation":', suppliedSkill);
    const held = qualityTextRefusalBehind(error, current);
    expect(held).toBeDefined();
    expect(Object.isFrozen(held)).toBe(true);
    expect(Object.isFrozen(held?.skill?.source)).toBe(true);
    expect(held?.skill).not.toBe(suppliedSkill);
    suppliedSkill.source.path = "replaced-skill.md";
    expect(held?.skill?.source?.path).toBe("original-skill.md");
    for (const [field, value] of [
      ["proposal", { ...assessment, rationale: "Replacement outside the admitted reply." }],
      ["bindingSha256", "f".repeat(64)],
      ["rejection", { code: "unknown", location: "$" }],
      ["skill", { ...skill, contentSha256: "f".repeat(64) }],
    ] as const)
      expect(Reflect.set(held!, field, value)).toBe(false);
    expect(Reflect.set(held!.skill!.source!, "path", "replaced-skill.md")).toBe(false);
    expect(qualityTextRefusalBehind(error, current)?.proposal).toBe(
      outer.editorialAssessmentProposal,
    );
  });

  it("cannot rebind an admitted receipt by changing its original input object", () => {
    for (const change of [
      (current: HarnessStepInput) => {
        current.inferenceAttempt = 2;
      },
      (current: HarnessStepInput) => {
        current.runId = "another-run";
      },
      (current: HarnessStepInput) => {
        current.editorialCandidate = {
          ...current.editorialCandidate,
          reference: { ...reference, digest: "f".repeat(64) },
        } as unknown as HarnessStepInput["editorialCandidate"];
      },
      (current: HarnessStepInput) => {
        current.qualityProfileSelection = {
          ...current.qualityProfileSelection!,
          selectionSha256: "f".repeat(64),
        };
      },
      (current: HarnessStepInput) => {
        current.evidenceIdentity = { repositoryRevision: "f".repeat(40) };
      },
    ]) {
      const current = input();
      const reply = JSON.stringify({
        summary: '{"evaluation":',
        editorialAssessmentProposal: assessment,
      });
      const outer = admitEditorialAssessmentReply(current, reply, context(reply));
      change(current);
      const error = failure(() =>
        admitQualityArtifactReply(current, outer.summary, context(reply), {
          admission: outer,
          skill,
        }),
      );
      expect(error.rejection?.code).toBe("quality-envelope-json");
      expect(qualityTextRefusalBehind(error, current)).toBeUndefined();
    }
    const unchanged = input();
    const { error, outer } = refusal(unchanged);
    expect(qualityTextRefusalBehind(error, unchanged)?.proposal).toBe(
      outer.editorialAssessmentProposal,
    );
  });

  it("refuses absent, copied and other-input outer receipts without inferring origin from a code", () => {
    const current = input();
    const { outer } = refusal(current);
    const copied = failure(() =>
      admitQualityArtifactReply(current, outer.summary, context(outer.summary), {
        admission: { ...outer },
        skill,
      }),
    );
    const other = failure(() =>
      admitQualityArtifactReply({ ...current }, outer.summary, context(outer.summary), {
        admission: outer,
        skill,
      }),
    );
    const missing = failure(() =>
      admitQualityArtifactReply(current, outer.summary, context(outer.summary)),
    );
    for (const error of [copied, other, missing]) {
      expect(error.rejection?.code).toBe("quality-envelope-json");
      expect(qualityTextRefusalBehind(error, current)).toBeUndefined();
    }
  });

  it("keeps undeclared carriers, malformed outer replies and other inner refusals strict", () => {
    const current = input();
    for (const reply of [
      JSON.stringify({ summary: {}, editorialAssessmentProposal: assessment }),
      JSON.stringify(
        JSON.stringify({ summary: '{"evaluation":', editorialAssessmentProposal: assessment }),
      ),
      JSON.stringify({
        summary: '{"evaluation":',
        editorialAssessmentProposal: { ...assessment, assessment: "unrecognized" },
      }),
      '{"summary":',
    ]) {
      const error = failure(() => admitEditorialAssessmentReply(current, reply, context(reply)));
      expect(qualityTextRefusalBehind(error, current)).toBeUndefined();
    }
    for (const inner of [
      '{"evaluation":{},"qualityScore":null,"qualityScore":null}',
      '{"evaluation":{},"qualityScore":[]}',
      '"double encoded quality text"',
    ]) {
      const { error } = refusal(current, inner);
      expect(error.rejection?.code).not.toBe("quality-envelope-json");
      expect(qualityTextRefusalBehind(error, current)).toBeUndefined();
    }
    const undeclared = {
      ...current,
      workflow: { name: "update-documentation", schemaVersion: 1, steps: [] },
    } as unknown as HarnessStepInput;
    const { error } = refusal(undeclared);
    expect(qualityTextRefusalBehind(error, undeclared)).toBeUndefined();
  });

  it("matches carrier instructions to the same declared consumer selector", () => {
    const declared = input();
    expect(isEditorialAssessmentStep(declared)).toBe(true);
    expect(bindQualityArtifactResponseContract(declared).step.prompt).toContain(
      "For UPDATE, keep the outer editorial assessment envelope",
    );
    const undeclared = {
      ...declared,
      workflow: { name: "update-documentation", schemaVersion: 1, steps: [] },
    } as unknown as HarnessStepInput;
    expect(isEditorialAssessmentStep(undeclared)).toBe(false);
    expect(bindQualityArtifactResponseContract(undeclared).step.prompt).not.toContain(
      "For UPDATE, keep the outer editorial assessment envelope",
    );
  });

  it("keeps credential, non-inert, host and unknown failures outside syntax custody", () => {
    const current = input();
    const credential = configureCredential(["offline-quality", "credential-control"].join("-"));
    for (const outer of [
      { summary: `{"evaluation":"${credential}":`, editorialAssessmentProposal: assessment },
      {
        summary: '{"evaluation":',
        editorialAssessmentProposal: {
          ...assessment,
          rationale: `The supplied credential is ${credential}.`,
        },
      },
    ]) {
      const reply = JSON.stringify(outer);
      const error = failure(() => admitEditorialAssessmentReply(current, reply, context(reply)));
      expect(error.retryable).toBe(false);
      expect(error.rejection?.code).toBe("credential-material");
      expect(qualityTextRefusalBehind(error, current)).toBeUndefined();
    }
    const { error, outer } = refusal(current);
    const forged = {
      ...outer,
      editorialAssessmentProposal: new Proxy(
        {},
        {
          get: () => {
            throw new Error("Non-inert proposal read.");
          },
        },
      ),
    };
    const nonInert = failure(() =>
      admitQualityArtifactReply(current, outer.summary, context(outer.summary), {
        admission: forged,
        skill,
      }),
    );
    expect(qualityTextRefusalBehind(nonInert, current)).toBeUndefined();
    expect(() =>
      admitQualityArtifactReply(
        current,
        outer.summary,
        {
          ...context(outer.summary),
          collectAttemptEvidence: () => {
            throw new Error("Actual host evidence failure.");
          },
        },
        { admission: outer, skill },
      ),
    ).toThrow("Actual host evidence failure.");
    expect(
      qualityTextRefusalBehind(new Error("Unknown decoder failure."), current),
    ).toBeUndefined();
    Object.defineProperty(error, "condition", { value: "cut-answer" });
    expect(qualityTextRefusalBehind(error, current)).toBeUndefined();
  });
});

type Order = "syntax" | "trace" | "valid";
async function realUpdate(
  order: Order,
  options: {
    json?: boolean;
    transportFirst?: boolean;
    rejectAssessment?: boolean;
    signal?: AbortSignal;
    finalRefusal?: (error: InferenceStepError, input: HarnessStepInput) => void;
  } = {},
) {
  const root = await roots.create("docsfab-quality-text-runner-");
  const pack = await verifyQualityPackContext({
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
  });
  const pi = new PiHarness({
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    model: validModelConfig,
    styleContext: await createStyleTaskContext(pack),
    limits: { environment: {}, hostFile: null, projectFile: null },
  });
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
  const bodies: Record<string, unknown>[] = [];
  const proposals: { rationale: string; digest: string }[] = [];
  let reply: string | undefined;
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    if (!reply || !String(url).startsWith(validModelConfig.baseUrl))
      throw new Error("This offline quality fixture forbids network access.");
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return chunkedTextTurn([reply]);
  });
  const policy = parseRetryPolicy({});
  let qualityCalls = 0;
  let contractReplies = 0;
  const result = await runAuthoringUpdateQualityProducerFixture(root, "update", {
    retryPolicy: policy,
    patchOnly: true,
    json: options.json,
    silent: false,
    signal: options.signal,
    runStep: async (current, scripted) => {
      if (current.step.id !== "evaluate-document-quality") {
        if (order !== "valid" && scripted.verificationResult)
          scripted.verificationResult.factInventory.limitations.push(
            "The inventory does not establish external deployment behavior.",
          );
        return scripted;
      }
      qualityCalls += 1;
      if (options.transportFirst && qualityCalls === 1)
        throw new InferenceStepError("Offline connection reset.", "provider-transient", true);
      contractReplies += 1;
      expect(current.workflow.schemaVersion).toBe(2);
      expect(isEditorialAssessmentStep(current)).toBe(true);
      expect(DEFAULT_ANSWER_SUBMISSION_OPTION).toBe("recorded");
      expect(current.answerSubmission).toBeUndefined();
      expect(current.qualityAnswerRecords).toBeUndefined();
      const candidate = scripted.qualityArtifactCandidate!;
      const syntax = order !== "valid" && (contractReplies + (order === "trace" ? 1 : 0)) % 2 === 0;
      const inner = syntax
        ? '{"evaluation":'
        : `${JSON.stringify({ evaluation: candidate.evaluation, qualityScore: candidate.qualityScore })}\n${candidate.reportMarkdown}`;
      const proposal = {
        ...(scripted.editorialAssessmentProposal as typeof assessment),
        rationale: `This actual independent assessment belongs to quality reply ${contractReplies}.`,
        ...(options.rejectAssessment
          ? {
              assessment: "rejected",
              recommendation: {
                candidate: "update",
                kind: "product-gap",
                code: "product-gap.evaluator-change",
              },
            }
          : {}),
      };
      proposals.push({ rationale: proposal.rationale, digest: canonicalDigest(proposal) });
      reply = JSON.stringify({ summary: inner, editorialAssessmentProposal: proposal });
      try {
        return await pi.runStep(current);
      } catch (error) {
        if (contractReplies === policy.maxRetries + 1)
          options.finalRefusal?.(error as InferenceStepError, current);
        throw error;
      } finally {
        reply = undefined;
      }
    },
  });
  const quality = result.record.steps.find((step) => step.id === "evaluate-document-quality")!;
  const saved = JSON.parse(
    await readFile(join(result.stateDirectory, `${result.record.id}.json`), "utf8"),
  );
  expect(saved).toEqual(result.record);
  const source = await readFile(join(result.sourcePath, "docs/cli.md"), "utf8");
  const patch = await readFile(result.record.changes!.patch!.artifactPath, "utf8");
  expect(source).toContain("--old");
  expect(source).not.toContain("--new");
  expect(await readFile(join(result.sourcePath, "src/orbit.ts"), "utf8")).toBe(
    "export const option = '--new';\n",
  );
  expect(patch).toContain("--old");
  expect(patch).toContain("--new");
  expect(JSON.stringify(bodies)).not.toContain('"name":"submit_quality_evaluation"');
  expect(JSON.stringify(bodies)).not.toContain('"name":"submit_answer_record"');
  return { ...result, quality, bodies, proposals, policy, output, qualityCalls, contractReplies };
}

function expectFailedFinalReplyAccounting(result: Awaited<ReturnType<typeof realUpdate>>) {
  expect(result.qualityCalls).toBe(result.policy.maxRetries + 1);
  expect(result.contractReplies).toBe(result.policy.maxRetries + 1);
  expect(result.quality.inference?.attempts).toHaveLength(result.bodies.length);
  expect(result.quality.usage?.total).toBe(result.bodies.length * 15);
  expect(result.quality.usage?.turns).toBe(result.bodies.length);
  const final = result.quality.inference?.attempts.at(-1);
  expect(final).toMatchObject({
    attempt: result.bodies.length,
    outcome: "provider-terminal",
    retryable: false,
    retryScheduled: false,
    rejection: { code: "quality-envelope-json", location: "$.evaluation" },
    usage: { total: 15, turns: 1 },
  });
  expect(final?.executionLease?.binding.inferenceAttempt).toBe(result.bodies.length);
  expect(final?.providerResponses?.state).toBe("complete");
  expect(final?.turns).toHaveLength(1);
  expect(final?.rejectedReplyShape).toBeDefined();
  expect(final?.rejectedReplyExcerpt).toBeDefined();
}

describe("actual Pi quality admission through UPDATE runner and CLI", () => {
  it(
    "applies the saved patch after a quality syntax decline without publishing",
    async () => {
      const result = await realUpdate("syntax");
      expect(result.record.status, result.record.error).toBe("succeeded");
      const rejection = result.quality.qualityValidationRejection!;
      expect(rejection).toEqual({
        validator: "candidate-admission",
        code: "quality-envelope-json",
        location: "$.evaluation",
        issueCount: 1,
      });
      const path = join(result.stateDirectory, `${result.record.id}.json`);
      const saved = await readFile(path, "utf8");
      const options = await loadSavedRunEditorialDecodeOptions(
        result.record,
        result.stateDirectory,
      );
      // Exercise the saved-run gate before the live caller applies its verified patch.
      await expect(loadVerifiedCheckoutRun(path, result.record.id, options)).resolves.toMatchObject(
        { id: result.record.id },
      );
      await expect(
        loadVerifiedPublicationRun(path, result.record.id, options),
      ).resolves.toMatchObject({ id: result.record.id });

      const credential = configureCredential(
        ["quality", "refusal", "credential", "control"].join(""),
      );
      try {
        for (const location of ["$", "$.evaluation", "$.qualityScore", "$.reportMarkdown"]) {
          const variant = structuredClone(result.record);
          variant.steps.find(
            (step) => step.id === "evaluate-document-quality",
          )!.qualityValidationRejection = { ...rejection, location };
          await writeFile(path, JSON.stringify(variant));
          await expect(
            loadVerifiedCheckoutRun(path, result.record.id, options),
            location,
          ).resolves.toMatchObject({ id: result.record.id });
        }
        const invalidFields = [
          { ...rejection, code: "unknown-quality-rejection" },
          { ...rejection, code: "quality-envelope-shape" },
          { ...rejection, validator: "quality-score" },
          { ...rejection, location: "$.unrecognized" },
          { ...rejection, location: `$.${credential}` },
          { ...rejection, rawReply: credential },
        ];
        for (const field of invalidFields) {
          const variant = structuredClone(result.record);
          Object.assign(variant.steps.find((step) => step.id === "evaluate-document-quality")!, {
            qualityValidationRejection: field,
          });
          await writeFile(path, JSON.stringify(variant));
          let refusal: unknown;
          try {
            await loadVerifiedCheckoutRun(path, result.record.id, options);
          } catch (error) {
            refusal = error;
          }
          expect(refusal).toMatchObject({ code: "run-record-contract-gap" });
          expect(String(refusal)).not.toContain(credential);
          expect(await readFile(join(result.sourcePath, "docs/cli.md"), "utf8")).toContain("--old");
        }
        const wrongStep = structuredClone(result.record);
        delete wrongStep.steps.find((step) => step.id === "evaluate-document-quality")!
          .qualityValidationRejection;
        wrongStep.steps.find(
          (step) => step.id === "write-documentation",
        )!.qualityValidationRejection = rejection;
        await writeFile(path, JSON.stringify(wrongStep));
        await expect(
          loadVerifiedCheckoutRun(path, result.record.id, options),
        ).rejects.toMatchObject({ code: "run-record-contract-gap" });
      } finally {
        await writeFile(path, saved);
      }

      const confirmPublication = vi.fn(async () => false);
      const ship = vi.fn(async () => {
        throw new Error("The local checkout test must not publish.");
      });
      const delivery = new LiveWorkflowDelivery({
        repositoryPath: result.sourcePath,
        stateDirectory: result.stateDirectory,
        allowWrite: true,
        confirmPublication,
        ship,
      });
      expect(await delivery.persist(result.record)).toEqual({ status: "applied" });
      expect(confirmPublication).not.toHaveBeenCalled();
      expect(ship).not.toHaveBeenCalled();
      expect(await readFile(join(result.sourcePath, "docs/cli.md"), "utf8")).toContain("--new");
      expect(await readFile(join(result.sourcePath, "src/orbit.ts"), "utf8")).toBe(
        "export const option = '--new';\n",
      );
      expect(await new FileRunStore(result.stateDirectory).get(result.record.id)).toMatchObject({
        checkoutPersistence: { outcome: "applied" },
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "evaluate-document-quality",
            qualityValidationRejection: rejection,
          }),
        ]),
      });
    },
    timeout,
  );

  it(
    "shows the final syntax limitation in human output without accepting JSON or a score",
    async () => {
      const result = await realUpdate("syntax");
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(result.quality.status).toBe("succeeded");
      expect(result.quality.qualityValidationRejection).toEqual({
        validator: "candidate-admission",
        code: "quality-envelope-json",
        location: "$.evaluation",
        issueCount: 1,
      });
      expect(result.quality.summary).toMatch(/^Host report decline:/u);
      expect(result.quality.summary).toContain(
        "no quality evaluation, report narrative or quality score",
      );
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expect(result.quality.inference?.configuredMaxRetries).toBe(result.policy.maxRetries);
      expect(result.quality.inference?.attempts).toHaveLength(result.policy.maxRetries + 1);
      expect(
        result.quality.inference?.attempts.slice(0, -1).map((attempt) => attempt.rejection?.code),
      ).toEqual([
        "technical-trace-missing-inventory-limitation",
        "quality-envelope-json",
        "technical-trace-missing-inventory-limitation",
      ]);
      expect(result.quality.inference?.attempts.at(-1)?.outcome).toBe("succeeded");
      expect(result.quality.usage?.total).toBe(result.bodies.length * 15);
      expect(result.quality.model?.provider).toBeTruthy();
      expect(result.quality.inference?.attempts.at(-1)?.executionLease).toBeDefined();
      expect(result.output.join("\n")).toContain("Limitation: quality-envelope-json");
      expect(result.output.join("\n")).toContain(
        "No quality evaluation or quality score is recorded.",
      );
      await handleRunsCommand(["show", result.record.id, "--state-dir", result.stateDirectory]);
      expect(result.output.join("\n")).toContain(
        `Step evaluate-document-quality attempt ${result.policy.maxRetries + 1}: quality reply rejected by quality-envelope-json`,
      );
      expect(result.output.join("\n")).not.toContain(
        `Step evaluate-document-quality attempt ${result.policy.maxRetries + 1}: succeeded;`,
      );
      const directory = join(result.stateDirectory, "..", "artifacts", "objects", "sha256");
      const rationales = await Promise.all(
        (await readdir(directory)).map((name) => readFile(join(directory, name), "utf8")),
      );
      expect(rationales.some((text) => text.includes(result.proposals.at(-1)!.rationale))).toBe(
        true,
      );
      for (const proposal of result.proposals.slice(0, -1))
        expect(rationales.some((text) => text.includes(proposal.rationale))).toBe(false);
    },
    timeout,
  );

  it(
    "persists the actual final proposal when a caller tries to replace its private carrier",
    async () => {
      const replacement = "This proposal was never admitted from the actual reply.";
      const result = await realUpdate("syntax", {
        json: true,
        finalRefusal: (error, current) => {
          const held = qualityTextRefusalBehind(error, current);
          expect(held).toBeDefined();
          expect(Reflect.set(held!, "proposal", { ...assessment, rationale: replacement })).toBe(
            false,
          );
          expect(Reflect.set(held!, "bindingSha256", "f".repeat(64))).toBe(false);
        },
      });
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(result.quality.qualityValidationRejection?.code).toBe("quality-envelope-json");
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      const directory = join(result.stateDirectory, "..", "artifacts", "objects", "sha256");
      const artifacts = await Promise.all(
        (await readdir(directory)).map((name) => readFile(join(directory, name), "utf8")),
      );
      expect(artifacts.some((text) => text.includes(result.proposals.at(-1)!.rationale))).toBe(
        true,
      );
      expect(artifacts.some((text) => text.includes(replacement))).toBe(false);
      expect(result.quality.usage?.total).toBe(result.bodies.length * 15);
    },
    timeout,
  );

  it(
    "shows the coded no-score syntax limitation in actual JSON output",
    async () => {
      const result = await realUpdate("syntax", { json: true });
      expect(result.record.status).toBe("succeeded");
      const projected = JSON.parse(result.output.at(-1)!);
      expect(projected.quality).toBeNull();
      expect(projected.product.limitations).toContain("quality-envelope-json");
      expect(JSON.stringify(projected)).not.toContain('"qualityScore":');
    },
    timeout,
  );

  it(
    "preserves the existing final technical-trace decline and admitted report narrative",
    async () => {
      const result = await realUpdate("trace");
      expect(result.record.status).toBe("succeeded");
      expect(result.quality.qualityValidationRejection?.code).toBe(
        "technical-trace-missing-inventory-limitation",
      );
      expect(result.quality.summary).toContain("# Documentation quality evaluation report");
      expect(result.quality.summary).toContain("Host report decline:");
      expect(result.quality.inference?.attempts).toHaveLength(result.policy.maxRetries + 1);
      expect(result.record.qualityArtifactValidation).toBeUndefined();
    },
    timeout,
  );

  it(
    "keeps a valid declared quality answer fully validated and bound to its provenance",
    async () => {
      const result = await realUpdate("valid");
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(result.quality.qualityValidationRejection).toBeUndefined();
      expect(result.record.qualityArtifactValidation?.status).toBe("passed");
      expect(result.record.qualityArtifactValidation?.repositoryRevision).toBe(
        result.record.repository.revision,
      );
      expect(result.quality.summary).toContain("Validated result summary");
      expect(result.quality.inference?.attempts).toHaveLength(1);
    },
    timeout,
  );

  it(
    "retains an independently rejected editorial assessment during syntax decline",
    async () => {
      const result = await realUpdate("syntax", { rejectAssessment: true });
      expect(result.quality.qualityValidationRejection?.code).toBe("quality-envelope-json");
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expect(result.record.workflowOutcome).toMatchObject({
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "product-gap.evaluator-change" }),
        ]),
      });
    },
    timeout,
  );

  it(
    "does not spend a contract attempt on a transport failure",
    async () => {
      const result = await realUpdate("syntax", { transportFirst: true });
      expect(result.record.status).toBe("succeeded");
      expect(result.qualityCalls).toBe(result.policy.maxRetries + 2);
      expect(result.contractReplies).toBe(result.policy.maxRetries + 1);
      expect(result.quality.inference?.attempts.at(0)?.outcome).toBe("provider-transient");
      expect(result.quality.summary).toContain(`${result.policy.maxRetries + 1} attempts spent`);
    },
    timeout,
  );

  it(
    "refuses changed technical verification at the new final syntax branch",
    async () => {
      const result = await realUpdate("syntax", {
        finalRefusal: (_error, current) => {
          current.technicalVerification!.factInventory.limitations.push(
            "Host input drift after admission.",
          );
        },
      });
      expect(result.record.status).toBe("failed");
      expect(result.quality.qualityValidationRejection?.code).toBe(
        "quality-technical-verification-changed",
      );
      expect(result.quality.summary ?? "").not.toContain("Host report decline:");
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expectFailedFinalReplyAccounting(result);
      expect(result.quality.inference?.attempts.at(-1)?.model?.provider).toBeTruthy();
    },
    timeout,
  );

  it(
    "refuses an unbound evaluator provider at the new final syntax branch",
    async () => {
      const result = await realUpdate("syntax", {
        finalRefusal: (error) => {
          delete error.evidence?.model;
        },
      });
      expect(result.record.status).toBe("failed");
      expect(result.quality.qualityValidationRejection?.code).toBe(
        "quality-evaluator-identity-unbound",
      );
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expectFailedFinalReplyAccounting(result);
      expect(result.quality.inference?.attempts.at(-1)?.model).toBeUndefined();
    },
    timeout,
  );

  it(
    "keeps cancellation primary over an otherwise eligible final syntax refusal",
    async () => {
      const controller = new AbortController();
      const result = await realUpdate("syntax", {
        signal: controller.signal,
        finalRefusal: () => controller.abort(),
      });
      expect(result.record.status).toBe("failed");
      expect(result.record.error).toBe("Workflow cancelled by user.");
      expect(result.quality.summary ?? "").not.toContain("Host report decline:");
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expectFailedFinalReplyAccounting(result);
      expect(result.quality.inference?.attempts.at(-1)?.model?.provider).toBeTruthy();
    },
    timeout,
  );
});
