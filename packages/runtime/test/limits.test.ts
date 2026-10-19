// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LIMIT_DEFINITIONS,
  formatLimitsTable,
  inspectLimits,
  limit,
  limitDefinition,
  parseLimitOverride,
  refuseLimit,
  resolveLimits,
} from "../src/config/limits.js";
import { EXECUTION_LEASE_DEFAULTS } from "../src/execution/lease-contracts.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

describe("limits loader", () => {
  it("keeps recovery warnings and retry backoff unchanged while expanding work allowances", () => {
    const resolved = resolveLimits({ environment: {}, hostFile: null });
    for (const [name, value] of [
      ["recovery.headroomWarnRatio", 0.75],
      ["recovery.headroomDegradedRatio", 0.9],
      ["retry.baseDelayMs", 1_000],
      ["retry.maxDelayMs", 2_000],
    ] as const) {
      expect(resolved.find((entry) => entry.name === name)?.value, name).toBe(value);
    }
    expect(
      limit("hostInvoker.contextPreflightBudgetMs", { environment: {}, hostFile: null }).value,
    ).toBe(300_000);
  });

  it("resolves yaml defaults with config/limits.yaml as the source", () => {
    const timeout = limit("compositionExecution.timeoutMs", { environment: {}, hostFile: null });
    expect(timeout).toMatchObject({
      name: "compositionExecution.timeoutMs",
      value: 3_600_000,
      unit: "ms",
      source: "config/limits.yaml",
      refusal: "composition-execution-timeout-ms-bound",
    });
  });

  it("applies a host env override within [min, max] and fails at start-up outside it", () => {
    expect(
      limit("compositionExecution.timeoutMs", {
        environment: { DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "2000000" },
        hostFile: null,
      }).value,
    ).toBe(2_000_000);
    expect(
      limit("compositionExecution.timeoutMs", {
        environment: { DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "2000000" },
        hostFile: null,
      }).source,
    ).toBe("host");
    expect(() =>
      resolveLimits({
        environment: { DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "3600001" },
        hostFile: null,
      }),
    ).toThrow("DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS must be an integer between 1 and 3600000.");
  });

  it("shows the GitHub review body policy in doctor with validated host and project scope", async () => {
    const name = "githubReview.bodyMaxBytes";
    const variable = "DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES";
    expect(limitDefinition(name)).toMatchObject({
      value: 65_000,
      unit: "bytes",
      scope: "per-run",
      min: 256,
      max: 131_072,
      refusal: "github-review-body-bytes-bound",
    });
    expect(limit(name, { environment: {}, hostFile: null })).toMatchObject({
      value: 65_000,
      source: "config/limits.yaml",
    });
    for (const value of [256, 131_072]) {
      expect(
        limit(name, { environment: { [variable]: String(value) }, hostFile: null }),
      ).toMatchObject({
        value,
        source: "host",
      });
    }
    for (const invalid of ["255", "131073", "1.5"]) {
      expect(() => resolveLimits({ environment: { [variable]: invalid }, hostFile: null })).toThrow(
        `${variable} must be an integer between 256 and 131072.`,
      );
    }
    const root = await roots.create("docsfab-github-review-limit-");
    const projectFile = join(root, "limits.yaml");
    await writeFile(projectFile, `${name}: 512\n`, "utf8");
    expect(() => resolveLimits({ environment: {}, hostFile: null, projectFile })).toThrow(
      `${name}: project policy may only override per-project limits.`,
    );
    const inspection = await inspectLimits({
      environment: { [variable]: "66498" },
      hostFile: null,
      cwd: root,
    });
    expect(inspection.rows.find((row) => row.name === name)).toMatchObject({
      value: 66_498,
      source: "host",
    });
    expect(formatLimitsTable(inspection)).toContain(`${name} | 66498 | bytes | host`);
  });

  it("keeps approved endpoint-probe defaults and accepts only the approved override maxima", () => {
    const approved = [
      ["endpointProbe.answerRecordTypedRequestBudget", 17, 28],
      ["endpointProbe.answerRecordInputTokenBudget", 600000, 800000],
    ] as const;

    for (const [name, defaultValue, approvedMaximum] of approved) {
      const definition = limitDefinition(name);
      expect(definition.value).toBe(defaultValue);
      expect(definition.max).toBe(approvedMaximum);
      expect(definition.override).toBeNull();
      expect(parseLimitOverride(definition, String(approvedMaximum))).toBe(approvedMaximum);
      expect(() => parseLimitOverride(definition, String(approvedMaximum + 1))).toThrow(
        `between ${definition.min} and ${approvedMaximum}`,
      );
    }
  });

  it("rejects sealed overrides at every tier", async () => {
    const root = await roots.create("docsfab-limits-project-");
    const projectFile = join(root, "limits.yaml");
    await writeFile(projectFile, "sealed.compositionLimits.timeoutMs: 1\n", "utf8");
    expect(() => resolveLimits({ environment: {}, hostFile: null, projectFile })).toThrow(
      /sealed limits reject every project override|project policy may only override/u,
    );
  });

  it("narrows a per-project override below the host value", async () => {
    // none of the shipped T1 limits are per-project; parseLimitOverride still
    // enforces the shared [min, max] parser used by every tier.
    const definition = limitDefinition("compositionExecution.timeoutMs");
    expect(parseLimitOverride(definition, "1800000")).toBe(1_800_000);
    expect(() => parseLimitOverride(definition, "0")).toThrow("between 1 and 3600000");
  });

  it("keeps lease-derived composition limits equal to EXECUTION_LEASE_DEFAULTS", () => {
    expect(limitDefinition("compositionExecution.callsPerLease").value).toBe(
      EXECUTION_LEASE_DEFAULTS.callsPerLease,
    );
    expect(limitDefinition("compositionExecution.maxLeases").value).toBe(
      EXECUTION_LEASE_DEFAULTS.maxLeases,
    );
    expect(limitDefinition("compositionExecution.maxToolCallsPerStep").value).toBe(
      EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling,
    );
    expect(limitDefinition("compositionExecution.maxProviderTurns").value).toBe(
      EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
    );
  });

  it("prints the doctor table and exits 3 on warn, 1 on over", async () => {
    const root = await roots.create("docsfab-limits-observed-");
    const warnFile = join(root, "warn.json");
    const overFile = join(root, "over.json");
    const timeout = limitDefinition("compositionExecution.timeoutMs");
    await writeFile(
      warnFile,
      JSON.stringify({ "compositionExecution.timeoutMs": timeout.value * timeout.warnAt }),
      "utf8",
    );
    await writeFile(
      overFile,
      JSON.stringify({ "compositionExecution.timeoutMs": timeout.value + 1 }),
      "utf8",
    );
    const warn = await inspectLimits({
      environment: { DOCSFAB_LIMITS_OBSERVED_FILE: warnFile },
      hostFile: null,
      cwd: root,
    });
    const over = await inspectLimits({
      environment: { DOCSFAB_LIMITS_OBSERVED_FILE: overFile },
      hostFile: null,
      cwd: root,
    });
    const table = formatLimitsTable(warn);
    expect(table).toContain(
      "name | value | unit | source | observed-max-seen | headroom% | status",
    );
    expect(table).toContain("compositionExecution.timeoutMs");
    expect(warn.exitCode).toBe(3);
    expect(over.exitCode).toBe(1);
    expect(over.rows.find((row) => row.name === "compositionExecution.timeoutMs")?.status).toBe(
      "over",
    );
    expect(() =>
      refuseLimit(
        limit("compositionExecution.timeoutMs", { environment: {}, hostFile: null }),
        timeout.value + 1,
      ),
    ).toThrow(`${timeout.refusal}:`);
  });

  it("prints sealed records fit provenance and fails limits when a qualified projection does not fit", async () => {
    const projection = {
      compositionId: "synthetic-records-fit",
      qualification: "qualified" as const,
      fitStatus: "does-not-fit" as const,
      predictedTimerMs: 420_000,
      timerReviewLimitMs: 600_000,
      effectiveMaxOutputTokens: 8_192,
      effectiveTimeoutMs: 300_000,
      requiredReadingTurns: 8,
      effectiveMaxProviderTurns: 7,
      effectiveMessageBudgetBytes: 6_144,
      largestRecordEnvelopeBytes: 5_000,
      recordCallCeiling: 36,
      recordCallCeilingProvenance: "planAnswerRecords(quality-profile); canonical plan",
      evidenceProvenance: "synthetic digest-bound fit fixture",
    };
    const configurationRoot = await roots.create("docsfab-limits-qualified-records-");
    const report = await inspectLimits({
      environment: {
        DOCSFAB_CONFIG_ROOT: configurationRoot,
        DOCSFAB_STATE_DIR: join(configurationRoot, "state"),
      },
      hostFile: null,
      cwd: configurationRoot,
      answerSubmissionRecordsFits: [projection],
    });

    expect(report.status).toBe("over");
    expect(report.exitCode).toBe(1);
    expect(report.answerSubmissionRecordsFits).toEqual([projection]);
    expect(formatLimitsTable(report)).toContain(
      "synthetic-records-fit | 420000 | 600000 | 8192 | 300000 | 8/7 | 6144/5000 | 36 | qualified | does-not-fit | planAnswerRecords(quality-profile); canonical plan; synthetic digest-bound fit fixture",
    );
  });

  it("keeps missing records run metrics visibly unqualified without claiming a fit", async () => {
    const configurationRoot = await roots.create("docsfab-limits-unqualified-records-");
    const report = await inspectLimits({
      environment: {
        DOCSFAB_CONFIG_ROOT: configurationRoot,
        DOCSFAB_STATE_DIR: join(configurationRoot, "state"),
      },
      hostFile: null,
      cwd: configurationRoot,
      answerSubmissionRecordsFits: [
        {
          compositionId: "synthetic-unqualified-records",
          qualification: "unqualified",
          fitStatus: "unqualified",
          reason: "retained run metrics unavailable",
          predictedTimerMs: null,
          timerReviewLimitMs: null,
          effectiveMaxOutputTokens: 8_192,
          effectiveTimeoutMs: 300_000,
          requiredReadingTurns: null,
          effectiveMaxProviderTurns: 7,
          effectiveMessageBudgetBytes: null,
          largestRecordEnvelopeBytes: 5_000,
          recordCallCeiling: 36,
          recordCallCeilingProvenance: "canonical answer plan",
          evidenceProvenance: "installed metadata only",
        },
      ],
    });

    expect(report.status).toBe("unknown");
    expect(report.answerSubmissionRecordsFits?.[0]?.fitStatus).toBe("unqualified");
    expect(formatLimitsTable(report)).toContain("synthetic-unqualified-records | unqualified");
  });

  it("fails limits when a qualified records capability falls below its qualified message floor", async () => {
    const configurationRoot = await roots.create("docsfab-limits-records-floor-");
    const report = await inspectLimits({
      environment: {
        DOCSFAB_CONFIG_ROOT: configurationRoot,
        DOCSFAB_STATE_DIR: join(configurationRoot, "state"),
      },
      hostFile: null,
      cwd: configurationRoot,
      answerSubmissionRecordsFits: [
        {
          compositionId: "synthetic-records-floor",
          qualification: "qualified",
          fitStatus: "does-not-fit",
          reason: "effective message budget is below the smallest qualified rung (6144 bytes)",
          predictedTimerMs: 420_000,
          timerReviewLimitMs: 600_000,
          effectiveMaxOutputTokens: 1_024,
          effectiveTimeoutMs: 300_000,
          requiredReadingTurns: 8,
          effectiveMaxProviderTurns: 7,
          effectiveMessageBudgetBytes: 2_340,
          largestRecordEnvelopeBytes: 5_000,
          recordCallCeiling: 240,
          recordCallCeilingProvenance: "canonical answer plan",
          evidenceProvenance: "synthetic digest-bound fit fixture",
        },
      ],
    });

    expect(report.status).toBe("over");
    expect(report.exitCode).toBe(1);
    expect(report.answerSubmissionRecordsFits?.[0]).toMatchObject({
      qualification: "qualified",
      fitStatus: "does-not-fit",
      predictedTimerMs: 420_000,
      effectiveMessageBudgetBytes: 2_340,
    });
  });

  it("rejects an unknown project-policy key during resolution", async () => {
    const root = await roots.create("docsfab-limits-project-unknown-");
    const projectFile = join(root, "limits.yaml");
    await writeFile(projectFile, "typo.nonexistent: 5\n", "utf8");

    expect(() => resolveLimits({ environment: {}, hostFile: null, projectFile })).toThrow(
      "contains unknown operational limit typo.nonexistent",
    );
  });

  it("reports unavailable observations as unknown and handles a zero limit at zero", async () => {
    const root = await roots.create("docsfab-limits-zero-");
    const missing = await inspectLimits({
      environment: { DOCSFAB_STATE_DIR: root },
      hostFile: null,
      cwd: root,
    });
    const missingTimeout = missing.rows.find(
      (row) => row.name === "compositionExecution.timeoutMs",
    );
    expect(missingTimeout).toMatchObject({
      observedMaxSeen: null,
      headroomPercent: null,
      status: "unknown",
    });
    expect(formatLimitsTable(missing)).toContain(
      "compositionExecution.timeoutMs | 3600000 | ms | config/limits.yaml | n/a | n/a | unknown",
    );

    const observedFile = join(root, "observed.json");
    await writeFile(observedFile, JSON.stringify({ "retry.maxRetries": 0 }), "utf8");
    const atZero = await inspectLimits({
      environment: {
        DOCSFAB_LIMITS_OBSERVED_FILE: observedFile,
        DOCSFAB_READ_ONLY_MAX_RETRIES: "0",
      },
      hostFile: null,
      cwd: root,
    });
    expect(atZero.rows.find((row) => row.name === "retry.maxRetries")).toMatchObject({
      observedMaxSeen: 0,
      headroomPercent: 100,
      status: "ok",
    });

    await writeFile(observedFile, JSON.stringify({ "retry.maxRetries": 1 }), "utf8");
    const aboveZero = await inspectLimits({
      environment: {
        DOCSFAB_LIMITS_OBSERVED_FILE: observedFile,
        DOCSFAB_READ_ONLY_MAX_RETRIES: "0",
      },
      hostFile: null,
      cwd: root,
    });
    expect(aboveZero.rows.find((row) => row.name === "retry.maxRetries")?.status).toBe("over");
  });

  it("honors host disk-headroom overrides and requires warn to exceed over", () => {
    const over = limitDefinition("deploy.diskHeadroomOverBytes");
    const warn = limitDefinition("deploy.diskHeadroomWarnBytes");
    const overKey = over.override ?? over.name;
    const warnKey = warn.override ?? warn.name;
    expect(overKey).toBe("DOCSFAB_DEPLOY_DISK_HEADROOM_OVER_BYTES");
    expect(warnKey).toBe("DOCSFAB_DEPLOY_DISK_HEADROOM_WARN_BYTES");
    expect(over.min).toBe(1);
    expect(warn.min).toBe(1);
    expect(over.max).toBe(over.value);
    expect(warn.max).toBe(warn.value);

    expect(
      limit("deploy.diskHeadroomOverBytes", { environment: {}, hostFile: null }),
    ).toMatchObject({
      value: over.value,
      source: "config/limits.yaml",
    });
    expect(
      limit("deploy.diskHeadroomWarnBytes", { environment: {}, hostFile: null }),
    ).toMatchObject({
      value: warn.value,
      source: "config/limits.yaml",
    });

    const loweredOver = over.min + 1;
    const loweredWarn = loweredOver + 1;
    const lowered = resolveLimits({
      environment: {
        [overKey]: String(loweredOver),
        [warnKey]: String(loweredWarn),
      },
      hostFile: null,
    });
    expect(lowered.find((entry) => entry.name === over.name)).toMatchObject({
      value: loweredOver,
      source: "host",
    });
    expect(lowered.find((entry) => entry.name === warn.name)).toMatchObject({
      value: loweredWarn,
      source: "host",
    });

    expect(() =>
      resolveLimits({
        environment: { [overKey]: String(over.max + 1) },
        hostFile: null,
      }),
    ).toThrow(`${overKey} must be an integer between ${over.min} and ${over.max}.`);
    expect(() =>
      resolveLimits({
        environment: { [warnKey]: "not-an-integer" },
        hostFile: null,
      }),
    ).toThrow(`${warnKey} must be an integer between ${warn.min} and ${warn.max}.`);
    expect(() =>
      resolveLimits({
        environment: { [warnKey]: String(over.value) },
        hostFile: null,
      }),
    ).toThrow(`${warnKey} ${over.value} must be > ${overKey} ${over.value}.`);
  });

  it("exports every catalog entry used by the generated mirrors", () => {
    expect(LIMIT_DEFINITIONS.length).toBeGreaterThanOrEqual(11);
    expect(LIMIT_DEFINITIONS.some((entry) => entry.rationale === "unknown")).toBe(false);
  });

  it("resolves disk-headroom catalog defaults and host-lowered overrides", () => {
    const overDef = limitDefinition("deploy.diskHeadroomOverBytes");
    const warnDef = limitDefinition("deploy.diskHeadroomWarnBytes");
    expect(warnDef.value).toBeGreaterThan(overDef.value);
    expect(overDef.min).toBe(1);
    expect(warnDef.min).toBe(1);
    expect(overDef.max).toBe(overDef.value);
    expect(warnDef.max).toBe(warnDef.value);

    const options = { environment: {}, hostFile: null };
    const warn = limit("deploy.diskHeadroomWarnBytes", options);
    const over = limit("deploy.diskHeadroomOverBytes", options);
    expect(warn).toMatchObject({
      name: "deploy.diskHeadroomWarnBytes",
      value: warnDef.value,
      unit: "bytes",
      source: "config/limits.yaml",
    });
    expect(over).toMatchObject({
      name: "deploy.diskHeadroomOverBytes",
      value: overDef.value,
      unit: "bytes",
      source: "config/limits.yaml",
    });
    expect(warn.value).toBeGreaterThan(over.value);

    const loweredOver = overDef.min;
    const loweredWarn = overDef.min + 1;
    const lowered = resolveLimits({
      environment: {
        DOCSFAB_DEPLOY_DISK_HEADROOM_OVER_BYTES: String(loweredOver),
        DOCSFAB_DEPLOY_DISK_HEADROOM_WARN_BYTES: String(loweredWarn),
      },
      hostFile: null,
    });
    expect(lowered.find((entry) => entry.name === overDef.name)).toMatchObject({
      value: loweredOver,
      source: "host",
    });
    expect(lowered.find((entry) => entry.name === warnDef.name)).toMatchObject({
      value: loweredWarn,
      source: "host",
    });

    expect(() =>
      resolveLimits({
        environment: { DOCSFAB_DEPLOY_DISK_HEADROOM_OVER_BYTES: String(overDef.max + 1) },
        hostFile: null,
      }),
    ).toThrow(`${overDef.override} must be an integer between ${overDef.min} and ${overDef.max}.`);
    expect(() =>
      resolveLimits({
        environment: { DOCSFAB_DEPLOY_DISK_HEADROOM_WARN_BYTES: String(warnDef.max + 1) },
        hostFile: null,
      }),
    ).toThrow(`${warnDef.override} must be an integer between ${warnDef.min} and ${warnDef.max}.`);
    expect(() =>
      resolveLimits({
        environment: { DOCSFAB_DEPLOY_DISK_HEADROOM_WARN_BYTES: "not-a-number" },
        hostFile: null,
      }),
    ).toThrow(`${warnDef.override} must be an integer between ${warnDef.min} and ${warnDef.max}.`);
  });

  it("refuses disk headroom warn at or below over", () => {
    const warnDef = limitDefinition("deploy.diskHeadroomWarnBytes");
    const overDef = limitDefinition("deploy.diskHeadroomOverBytes");
    const equal = overDef.min;
    expect(() =>
      resolveLimits({
        environment: {
          DOCSFAB_DEPLOY_DISK_HEADROOM_OVER_BYTES: String(equal),
          DOCSFAB_DEPLOY_DISK_HEADROOM_WARN_BYTES: String(equal),
        },
        hostFile: null,
      }),
    ).toThrow(`${warnDef.override} ${equal} must be > ${overDef.override} ${equal}.`);
    expect(() =>
      resolveLimits({
        environment: { DOCSFAB_DEPLOY_DISK_HEADROOM_WARN_BYTES: String(overDef.value) },
        hostFile: null,
      }),
    ).toThrow(
      `${warnDef.override} ${overDef.value} must be > ${overDef.override} ${overDef.value}.`,
    );
  });

  it("honors host secrets-lock overrides and requires stale to stay below wait", () => {
    const wait = limitDefinition("secrets.lockWaitMs");
    const stale = limitDefinition("secrets.lockStaleMs");
    const retry = limitDefinition("secrets.lockRetryMs");
    const waitKey = wait.override ?? wait.name;
    const staleKey = stale.override ?? stale.name;
    const retryKey = retry.override ?? retry.name;
    expect(waitKey).toBe("DOCSFAB_SECRETS_LOCK_WAIT_MS");
    expect(staleKey).toBe("DOCSFAB_SECRETS_LOCK_STALE_MS");
    expect(retryKey).toBe("DOCSFAB_SECRETS_LOCK_RETRY_MS");
    expect(wait.min).toBe(1);
    expect(stale.min).toBe(1);
    expect(retry.min).toBe(1);
    expect(wait.max).toBe(wait.value);
    expect(stale.max).toBe(stale.value);
    expect(retry.max).toBe(retry.value);
    expect(stale.value).toBeLessThan(wait.value);

    expect(limit("secrets.lockWaitMs", { environment: {}, hostFile: null })).toMatchObject({
      value: wait.value,
      source: "config/limits.yaml",
    });
    expect(limit("secrets.lockStaleMs", { environment: {}, hostFile: null })).toMatchObject({
      value: stale.value,
      source: "config/limits.yaml",
    });
    expect(limit("secrets.lockRetryMs", { environment: {}, hostFile: null })).toMatchObject({
      value: retry.value,
      source: "config/limits.yaml",
    });

    const loweredWait = stale.min + 1;
    const loweredStale = stale.min;
    const loweredRetry = retry.min;
    expect(loweredStale).toBeLessThan(loweredWait);
    const lowered = resolveLimits({
      environment: {
        [waitKey]: String(loweredWait),
        [staleKey]: String(loweredStale),
        [retryKey]: String(loweredRetry),
      },
      hostFile: null,
    });
    expect(lowered.find((entry) => entry.name === wait.name)).toMatchObject({
      value: loweredWait,
      source: "host",
    });
    expect(lowered.find((entry) => entry.name === stale.name)).toMatchObject({
      value: loweredStale,
      source: "host",
    });
    expect(lowered.find((entry) => entry.name === retry.name)).toMatchObject({
      value: loweredRetry,
      source: "host",
    });

    for (const definition of [wait, stale, retry]) {
      const key = definition.override ?? definition.name;
      expect(() =>
        resolveLimits({
          environment: { [key]: String(definition.max + 1) },
          hostFile: null,
        }),
      ).toThrow(`${key} must be an integer between ${definition.min} and ${definition.max}.`);
      expect(() =>
        resolveLimits({
          environment: { [key]: "not-an-integer" },
          hostFile: null,
        }),
      ).toThrow(`${key} must be an integer between ${definition.min} and ${definition.max}.`);
    }
  });

  it("refuses secrets lock stale at or above wait", () => {
    const wait = limitDefinition("secrets.lockWaitMs");
    const stale = limitDefinition("secrets.lockStaleMs");
    const equal = Math.min(wait.max, stale.max);
    expect(() =>
      resolveLimits({
        environment: {
          [wait.override!]: String(equal),
          [stale.override!]: String(equal),
        },
        hostFile: null,
      }),
    ).toThrow(`${stale.override} ${equal} must be < ${wait.override} ${equal}.`);
    expect(() =>
      resolveLimits({
        environment: { [wait.override!]: String(stale.value) },
        hostFile: null,
      }),
    ).toThrow(`${stale.override} ${stale.value} must be < ${wait.override} ${stale.value}.`);
  });
});
