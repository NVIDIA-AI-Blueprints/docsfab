// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { summarizeNetworkedPhaseFailure } from "../src/acceptance.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { diagnose } from "../src/doctor.js";
import {
  DEFAULT_NEXT_ACTIONS,
  reportOperatorFailure,
  type OperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { remediationText } from "../src/operator/remediation.js";
import { validModelConfig } from "./helpers.js";

/**
 * Which collaborator of `diagnose` fails, and the provider and host detail it
 * fails with. The doctor must never carry that detail into its error.
 */
const injected = vi.hoisted(() => ({
  fault: "none",
  detail: "provider-reply-canary at /private/host/canary/export",
}));

vi.mock("../src/quality-pack/manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/quality-pack/manifest.js")>();
  return { ...actual, verifyQualityPack: async () => ({ resolvedResources: undefined }) };
});

vi.mock("../src/skills/catalog-crate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/skills/catalog-crate.js")>();
  return {
    ...actual,
    readCatalogSkillCrateLock: async () => {
      if (injected.fault === "skill-loading") throw new Error(injected.detail);
      return { skills: [] };
    },
  };
});

vi.mock("../src/harness/pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/harness/pi.js")>();
  const skill = { name: "audit-documentation" };
  return {
    ...actual,
    createDocsFabResourceLoader: () => ({
      reload: async () => {},
      getSkills: () => {
        if (injected.fault === "skill-inspection") throw new Error(injected.detail);
        if (injected.fault === "skill-diagnostics") {
          return { skills: [skill], diagnostics: [{}, {}] };
        }
        if (injected.fault === "no-skills") return { skills: [], diagnostics: [] };
        return { skills: [skill], diagnostics: [] };
      },
    }),
    getDocsFabContextSources: () => {
      if (injected.fault === "context-sources") throw new Error(injected.detail);
      return [];
    },
  };
});

vi.mock("../src/model/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model/provider.js")>();
  return {
    ...actual,
    createModelConnection: async (endpoint: { providerId: string; modelId: string }) => {
      const role = endpoint.providerId === "judge-provider" ? "judge" : "policy";
      if (injected.fault === `${role}-registration`) throw new Error(injected.detail);
      return {
        runtime: {
          getAvailable: async () =>
            injected.fault === `${role}-unavailable` ? [] : [{ id: endpoint.modelId }],
        },
      };
    },
  };
});

const POLICY_MODEL = `${validModelConfig.providerId}/${validModelConfig.modelId}`;
const JUDGE_MODEL = "judge-provider/judge/model";

/** The next action of every skill stop, as the catalog words it. */
const SKILLS_NEXT_ACTION =
  "DocsFab could not use its installed governed skills, and the error withholds host paths. Reinstall DocsFab from its exact release, or rebuild a source checkout, then run the same command again.";

function configuration(overrides: Partial<DocsFabConfig> = {}): DocsFabConfig {
  return {
    projectRoot: process.cwd(),
    skillCrateDirectory: "/unused/skill-crate",
    qualityDirectory: "/unused/quality",
    qualityPackDirectory: "/unused/quality-pack",
    stateDirectory: "/unused/runs",
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
    ...overrides,
  };
}

const withJudge = configuration({
  judge: { ...validModelConfig, providerId: "judge-provider", modelId: "judge/model" },
});

interface LiveDoctorStop {
  /** The collaborator that fails; `none` leaves every collaborator healthy. */
  fault: string;
  /** The stable code the stop carries, and the class its summary names. */
  code: string;
  failureClass: string;
  /** The message the stop keeps, which doctor readiness and its callers read. */
  message: string;
  /** The next action the envelope and summary carry, worded here so the catalog is not read back. */
  nextAction: string;
  config?: DocsFabConfig;
  liveCheckFails?: true;
}

const STOPS: readonly LiveDoctorStop[] = [
  {
    fault: "skill-loading",
    code: "skill-loading-failed",
    failureClass: "infrastructure",
    message: "Skill loading failed without retaining host-path diagnostics.",
    nextAction: SKILLS_NEXT_ACTION,
  },
  {
    fault: "skill-inspection",
    code: "skill-inspection-failed",
    failureClass: "infrastructure",
    message: "Skill inspection failed without retaining host-path diagnostics.",
    nextAction: SKILLS_NEXT_ACTION,
  },
  {
    fault: "skill-diagnostics",
    code: "skill-loading-diagnostics-reported",
    failureClass: "infrastructure",
    message: "Skill loading reported 2 content-free diagnostic(s).",
    nextAction: SKILLS_NEXT_ACTION,
  },
  {
    fault: "no-skills",
    code: "governed-skills-not-found",
    failureClass: "infrastructure",
    message: "No governed skills were found in the configured skills directory.",
    nextAction: SKILLS_NEXT_ACTION,
  },
  {
    fault: "context-sources",
    code: "context-source-inspection-failed",
    failureClass: "infrastructure",
    message: "Context-source inspection failed without retaining host-path diagnostics.",
    nextAction:
      "DocsFab could not inspect the repository's instruction files, and the error withholds host paths. Check that the checkout's instruction files, such as AGENTS.md, are readable by this user, then run the same command again.",
  },
  {
    fault: "policy-registration",
    code: "policy-model-registration-failed",
    failureClass: "infrastructure",
    message: "Policy model registration failed without retaining endpoint diagnostics.",
    nextAction:
      "DocsFab could not register the policy model's provider, and the error withholds endpoint detail. Check the MODEL_* provider, endpoint, model, and key settings with `docsfab doctor`, then run the same command again.",
  },
  {
    fault: "policy-unavailable",
    code: "policy-model-not-available",
    failureClass: "operator-input",
    message: `Model ${POLICY_MODEL} is not available after configuration.`,
    nextAction: remediationText("doctor"),
  },
  {
    fault: "judge-registration",
    code: "judge-model-registration-failed",
    failureClass: "infrastructure",
    message: "Judge model registration failed without retaining endpoint diagnostics.",
    nextAction:
      "DocsFab could not register the judge model's provider, and the error withholds endpoint detail. Check the JUDGE_* provider, endpoint, model, and key settings, then run the same command again.",
    config: withJudge,
  },
  {
    fault: "judge-unavailable",
    code: "judge-model-not-available",
    failureClass: "operator-input",
    message: `Judge model ${JUDGE_MODEL} is not available after configuration.`,
    nextAction: remediationText("doctor"),
    config: withJudge,
  },
  {
    fault: "none",
    code: "live-model-check-failed",
    failureClass: "infrastructure",
    message: "Live model check failed without retaining provider diagnostics.",
    nextAction:
      "The live provider check did not succeed, and the error withholds the provider's reply. Check that the model endpoint is reachable from this machine and accepts the configured key, then run `docsfab doctor --live` again.",
    liveCheckFails: true,
  },
  {
    fault: "none",
    code: "model-request-policy-exceeds-limits",
    failureClass: "operator-input",
    message:
      "Policy model request policy cannot fit effective limits: effective-context=128000 effective-output=16384 context-reserve=127990 required-minimum-output=16.",
    nextAction:
      "Lower the request policy's reserved context or minimum output tokens, or raise the effective limits the message names, then run the same command again.",
    config: configuration({
      model: {
        ...validModelConfig,
        requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 127_990 },
      },
    }),
  },
];

/** Run the doctor as the acceptance's live phase does, with the live check on. */
async function runLiveDoctor(
  stop: Pick<LiveDoctorStop, "fault" | "config" | "liveCheckFails">,
): Promise<unknown> {
  injected.fault = stop.fault;
  try {
    return await diagnose(stop.config ?? configuration(), {
      live: true,
      liveChecker: async () => {
        if (stop.liveCheckFails) throw new Error(injected.detail);
        return { latencyMs: 1 };
      },
    }).then(
      (result) => result,
      (error: unknown) => error,
    );
  } finally {
    injected.fault = "none";
  }
}

/** The failure boundary and the harness's summary, as the live-doctor phase runs them. */
function collectedSummary(error: unknown): {
  envelope: OperatorErrorEnvelope;
  printed: string;
  summary: ReturnType<typeof summarizeNetworkedPhaseFailure>;
} {
  const written: string[] = [];
  const envelope = reportOperatorFailure(error, {
    json: true,
    write: (line) => written.push(line),
  });
  const printed = written.join("\n");
  const summary = summarizeNetworkedPhaseFailure({
    acceptanceId: "acceptance-test",
    testedCommit: "a".repeat(40),
    phase: "live-doctor",
    exitCode: 1,
    stdout: "",
    stderr: printed,
    environment: {},
    privateRoots: ["/private/host/canary"],
  });
  return { envelope, printed, summary };
}

describe("the live doctor's stops carry stable codes", () => {
  it("passes when every collaborator is healthy", async () => {
    // Positive control: a stop below comes from its injected fault, not from the fixture.
    for (const config of [configuration(), withJudge]) {
      expect(await runLiveDoctor({ fault: "none", config })).toMatchObject({
        provider: validModelConfig.providerId,
        skills: ["audit-documentation"],
        live: { latencyMs: 1 },
      });
    }
  });

  it.each(STOPS)("names $code in the collected live-doctor summary", async (stop) => {
    const error = await runLiveDoctor(stop);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: stop.code, message: stop.message });
    // The caught failure is dropped, not chained: it names no provider or host detail.
    expect((error as Error).cause).toBeUndefined();

    const { envelope, printed, summary } = collectedSummary(error);
    expect(envelope).toMatchObject({
      code: stop.code,
      failure: { class: stop.failureClass, layer: "cli", code: stop.code },
    });
    // The on-call reads what to do, not only what failed: the stop's own text, never the catch-all.
    expect(envelope.nextAction).toBe(stop.nextAction);
    expect(envelope.nextAction).not.toBe(DEFAULT_NEXT_ACTIONS["operator-error"]);
    expect(summary).toEqual({
      schemaVersion: 1,
      acceptanceId: "acceptance-test",
      testedCommit: "a".repeat(40),
      phase: "live-doctor",
      exitCode: 1,
      report: "operator-error",
      code: stop.code,
      failure: { class: stop.failureClass, layer: "cli", code: stop.code },
      nextAction: envelope.nextAction,
      ...(envelope.docsAnchor ? { docsAnchor: envelope.docsAnchor } : {}),
    });
    // Neither the printed envelope nor the summary carries the failing collaborator's detail.
    for (const text of [printed, JSON.stringify(summary)]) {
      expect(text).not.toContain("provider-reply-canary");
      expect(text).not.toContain("/private/host");
    }
  });

  it("gives every stop its own code", () => {
    const codes = STOPS.map((stop) => stop.code);
    expect(new Set(codes).size).toBe(codes.length);
    // Not the catch-all an uncoded stop summarizes as, whose next action is a real sentence.
    expect(codes).not.toContain("operator-error");
    expect(DEFAULT_NEXT_ACTIONS["operator-error"]).toEqual(expect.any(String));
  });
});
