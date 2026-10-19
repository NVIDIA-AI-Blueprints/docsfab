// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { limit } from "../src/config/limits.js";
import { createStyleTaskContext } from "../src/execution/task-context.js";
import { PiHarness } from "../src/harness/pi.js";
import { isEditorialAssessmentStep } from "../src/harness/editorial-response-contract.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { chunkedTextTurn } from "./support/answer-submission-fixtures.js";
import { runAuthoringQualityProducerFixture } from "./support/authoring-quality-runner.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { qualityTextRefusalBehind } from "../src/harness/reply-admission/quality-artifact.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { formatRunRetryDispositionLines } from "../src/operator/retry-disposition.js";
import type { RunRecord } from "../src/records/contracts.js";

const roots = temporaryRoots();
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const timeout = testTimeoutMs(limit("test.journeyLocalTimeoutMs").value);
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await roots.cleanup();
});

async function actualCreate(
  reply: string,
  options: { finalRefusal?: (error: InferenceStepError, input: HarnessStepInput) => void } = {},
) {
  const root = await roots.create("docsfab-create-quality-envelope-");
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
  const policy = parseRetryPolicy({});
  const requests: unknown[] = [];
  const refusals: { code?: string; location?: string }[] = [];
  let active = false;
  let response = reply;
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    if (!active || !String(url).startsWith(validModelConfig.baseUrl))
      throw new Error("The offline CREATE fixture forbids external network access.");
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return chunkedTextTurn([response]);
  });
  const fixture = await runAuthoringQualityProducerFixture(root, {
    deliveryReady: true,
    retryPolicy: policy,
    runStep: async (input, scripted) => {
      if (input.step.id !== "evaluate-document-quality") return scripted;
      expect(input.workflow.schemaVersion).toBe(3);
      expect(isEditorialAssessmentStep(input)).toBe(false);
      if (reply === "valid") {
        const candidate = scripted.qualityArtifactCandidate!;
        response = `${JSON.stringify({ evaluation: candidate.evaluation, qualityScore: candidate.qualityScore })}\n${candidate.reportMarkdown}`;
      }
      active = true;
      try {
        return await pi.runStep(input);
      } catch (error) {
        const rejection = (error as { rejection?: { code: string; location: string } }).rejection;
        refusals.push({ ...rejection });
        if (refusals.length === policy.maxRetries + 1)
          options.finalRefusal?.(error as InferenceStepError, input);
        throw error;
      } finally {
        active = false;
      }
    },
  });
  const quality = fixture.record.steps.find((step) => step.id === "evaluate-document-quality")!;
  const saved = JSON.parse(
    await readFile(join(fixture.stateDirectory, `${fixture.record.id}.json`), "utf8"),
  );
  expect(saved).toEqual(fixture.record);
  expect(await readFile(join(fixture.sourcePath, "src/main.ts"), "utf8")).toContain("hello");
  expect(await readFile(fixture.record.changes!.patch!.artifactPath, "utf8")).toContain(
    "docs/cli-reference.md",
  );
  return { ...fixture, quality, policy, requests, refusals };
}

describe("CREATE malformed final quality replies", () => {
  it("keeps malformed non-record steps outside retry presentation", () => {
    const malformed = { steps: [null, undefined, 7] } as unknown as RunRecord;
    expect(formatRunRetryDispositionLines(malformed)).toEqual([]);
  });

  it.each([
    ["quality-envelope-json", '{"evaluation":'],
    ["quality-envelope-shape", '"The documentation looks correct."'],
  ])(
    "keeps a correct CREATE patch after final %s exhaustion",
    async (code, reply) => {
      const result = await actualCreate(reply);
      expect(result.requests).toHaveLength(result.policy.maxRetries + 1);
      expect(result.refusals).toHaveLength(result.policy.maxRetries + 1);
      expect(result.refusals.at(-1)?.code).toBe(code);
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(result.quality.status).toBe("succeeded");
      expect(result.quality.qualityValidationRejection?.code).toBe(code);
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expect(result.quality.summary).toContain("no quality");
      expect(result.quality.summary).not.toContain("independently admitted editorial assessment");
      const output: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
      await handleRunsCommand([
        "show",
        result.record.id,
        "--state-dir",
        result.stateDirectory,
        "--json",
      ]);
      expect(process.exitCode ?? 0).toBe(0);
      const json = JSON.parse(output.at(-1)!);
      expect(json.quality).toBeNull();
      expect(json.product.limitations).toContain(
        code === "quality-envelope-json" ? code : "quality-validation-unavailable",
      );
      expect(JSON.stringify(json)).not.toContain('"qualityScore":');
      output.length = 0;
      await handleRunsCommand(["show", result.record.id, "--state-dir", result.stateDirectory]);
      const human = output.join("\n");
      expect(human).toContain("Quality: unavailable/not projected");
      expect(human.slice(human.indexOf("QUALITY"), human.indexOf("RETRIES"))).toContain(code);
      const finalRetry = human
        .split("\n")
        .find((line) =>
          line.includes(`Step evaluate-document-quality attempt ${result.policy.maxRetries + 1}:`),
        );
      expect(finalRetry).toBeDefined();
      expect(finalRetry).not.toContain(": succeeded;");
      expect(finalRetry).toContain(code);
    },
    timeout,
  );

  it(
    "still validates a real declared CREATE quality answer",
    async () => {
      const result = await actualCreate("valid");
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(result.requests).toHaveLength(1);
      expect(result.refusals).toEqual([]);
      expect(result.quality.qualityValidationRejection).toBeUndefined();
      expect(result.record.qualityArtifactValidation?.status).toBe("passed");
    },
    timeout,
  );

  it(
    "keeps changed technical verification strict at the CREATE syntax fallback",
    async () => {
      const result = await actualCreate('{"evaluation":', {
        finalRefusal: (error, input) => {
          expect(qualityTextRefusalBehind(error, input)).toBeDefined();
          input.technicalVerification!.factInventory.limitations.push("Changed after admission.");
        },
      });
      expect(result.record.status).toBe("failed");
      expect(result.quality.qualityValidationRejection?.code).toBe(
        "quality-technical-verification-changed",
      );
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expect(result.quality.summary ?? "").not.toContain("Host report decline:");
      expect(result.quality.inference?.attempts.at(-1)?.outcome).toBe("provider-terminal");
    },
    timeout,
  );

  it(
    "keeps an unbound CREATE evaluator strict after its final syntax refusal",
    async () => {
      const result = await actualCreate('{"evaluation":', {
        finalRefusal: (error) => {
          delete error.evidence?.model;
        },
      });
      expect(result.record.status).toBe("failed");
      expect(result.quality.qualityValidationRejection?.code).toBe(
        "quality-evaluator-identity-unbound",
      );
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expect(result.quality.summary ?? "").not.toContain("Host report decline:");
      expect(result.quality.inference?.attempts.at(-1)?.outcome).toBe("provider-terminal");
    },
    timeout,
  );

  it(
    "keeps configured credential output outside CREATE syntax fallback",
    async () => {
      const credential = configureCredential(["offline-create", "credential-control"].join("-"));
      const result = await actualCreate(JSON.stringify({ evaluation: credential }));
      expect(result.record.status).toBe("failed");
      expect(result.requests).toHaveLength(1);
      expect(result.refusals[0]?.code).toBe("credential-material");
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expect(result.quality.summary ?? "").not.toContain("Host report decline:");
      expect(JSON.stringify(result.record)).not.toContain(credential);
    },
    timeout,
  );

  it(
    "does not grant CREATE fallback custody to a copied coded error",
    async () => {
      const result = await actualCreate('"No evaluation object."', {
        finalRefusal: (error, input) => {
          expect(qualityTextRefusalBehind(error, input)).toBeDefined();
          const copied = new InferenceStepError(
            error.message,
            error.category,
            error.retryable,
            error.evidence,
            error.rejection,
          );
          expect(qualityTextRefusalBehind(copied, input)).toBeUndefined();
          throw copied;
        },
      });
      expect(result.record.status).toBe("failed");
      expect(result.record.qualityArtifactValidation).toBeUndefined();
      expect(result.quality.summary ?? "").not.toContain("Host report decline:");
      expect(result.quality.inference?.attempts.at(-1)?.rejection?.code).toBe(
        "quality-envelope-shape",
      );
      expect(result.quality.qualityValidationRejection).toBeUndefined();
      const output: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
      await handleRunsCommand(["show", result.record.id, "--state-dir", result.stateDirectory]);
      const human = output.join("\n");
      expect(human.slice(human.indexOf("QUALITY"), human.indexOf("RETRIES"))).toContain(
        "quality-envelope-shape",
      );
    },
    timeout,
  );
});
