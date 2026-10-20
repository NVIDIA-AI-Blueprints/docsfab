// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Extract a bounded, credential-safe diagnostic summary for one matrix cell. */
const text = (value) => (typeof value === "string" ? value : null);
const number = (value) => (Number.isFinite(value) ? value : null);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

function statusOf(step) {
  return step?.status ?? step?.outcome ?? step?.state ?? "unknown";
}

function routeOf(cell = {}, record = {}) {
  const provider = cell.providerId ?? cell.provider?.providerId ?? cell.provider ?? null;
  const rawRoute =
    cell.route ??
    cell.providerRoute ??
    cell.baseUrl ??
    cell.provider?.baseUrl ??
    record.compositionExecution?.deployment?.routeId ??
    cell.laneId ??
    null;
  let route = text(rawRoute);
  if (route && /^https?:\/\//i.test(route)) {
    try {
      const url = new URL(route);
      route = `${url.origin}${url.pathname}`;
    } catch {
      route = null;
    }
  }
  const joined = `${provider ?? ""} ${route ?? ""}`.toLowerCase();
  if (joined.includes("catalog")) return { provider: "API Catalog", id: text(provider), route };
  if (joined.includes("inference") || joined.includes("nvidia-inference-api")) {
    return { provider: "Inference Hub", id: text(provider), route };
  }
  return { provider: "unknown", id: text(provider), route };
}

function safeStep(step, index) {
  const inferenceAttempts = Array.isArray(step?.inference?.attempts) ? step.inference.attempts : [];
  const attempts = Array.isArray(step?.attempts) ? step.attempts : inferenceAttempts;
  const stepId = text(step?.id ?? step?.stepId ?? step?.name) ?? `step-${index + 1}`;
  const stepFailure = object(step?.failure);
  return {
    id: stepId,
    status: text(statusOf(step)) ?? "unknown",
    failureCode: text(stepFailure.code ?? step?.failureCode ?? step?.code ?? null),
    failureClass: text(stepFailure.class),
    failureLayer: text(stepFailure.layer),
    attempts: attempts.map((attempt) => ({
      status: text(attempt?.status ?? attempt?.outcome ?? statusOf(attempt)) ?? "unknown",
      failureCode: text(
        attempt?.failure?.code ??
          attempt?.failureCode ??
          attempt?.code ??
          (["succeeded", "success", "completed", "ok"].includes(
            String(attempt?.outcome ?? "").toLowerCase(),
          )
            ? null
            : attempt?.outcome),
      ),
      providerErrorClass: text(
        attempt?.providerErrorClass ?? attempt?.modelTelemetry?.providerError?.class,
      ),
      retryScheduled: typeof attempt?.retryScheduled === "boolean" ? attempt.retryScheduled : null,
      startedAt: text(attempt?.startedAt ?? attempt?.startedAtIso),
      endedAt: text(attempt?.completedAt ?? attempt?.endedAt ?? attempt?.endedAtIso),
      durationMs: number(attempt?.durationMs),
    })),
    retryCount: number(step?.inference?.effectiveMaxRetries),
    durationMs: number(step?.durationMs),
    startedAt: text(step?.startedAt ?? step?.startedAtIso),
    endedAt: text(step?.completedAt ?? step?.endedAt ?? step?.endedAtIso),
  };
}

function summaryEvidence(steps) {
  const unverifiedDimensionKeys = new Set();
  const pageStatuses = new Map();
  let structuredInsufficient = false;
  let textualInsufficient = false;
  let dimensionsObserved = false;
  for (const step of steps) {
    if (typeof step.summary !== "string") continue;
    let parsed = null;
    try {
      parsed = JSON.parse(step.summary);
    } catch {
      textualInsufficient ||= step.summary.toLowerCase().includes("insufficient-evidence");
    }
    if (!parsed || typeof parsed !== "object") continue;
    const coverageItems = Array.isArray(parsed.coverage) ? parsed.coverage : [];
    const dimensions = Array.isArray(parsed.factInventory?.dimensions)
      ? parsed.factInventory.dimensions
      : [];
    dimensionsObserved ||= Array.isArray(parsed.factInventory?.dimensions);
    for (const item of coverageItems) {
      const status = item?.status ?? item?.assessment;
      if (typeof item?.path !== "string" || typeof status !== "string") continue;
      const statusesForPath = pageStatuses.get(item.path) ?? new Set();
      statusesForPath.add(status.toLowerCase());
      pageStatuses.set(item.path, statusesForPath);
    }
    const assessments = [];
    for (const item of [...coverageItems, ...dimensions])
      assessments.push(item?.status, item?.assessment);
    const statuses = assessments
      .filter((value) => typeof value === "string")
      .map((value) => value.toLowerCase());
    for (const [index, item] of (dimensions.length ? dimensions : coverageItems).entries()) {
      const status = item?.status ?? item?.assessment;
      if (
        typeof status !== "string" ||
        !["unverified", "not-verified"].includes(status.toLowerCase())
      )
        continue;
      const identity =
        item?.dimension_id ??
        item?.dimensionId ??
        item?.id ??
        item?.dimension ??
        item?.path ??
        `${step.id ?? "step"}:${index}`;
      unverifiedDimensionKeys.add(String(identity));
    }
    structuredInsufficient ||=
      statuses.includes("insufficient-evidence") ||
      parsed.overall_decision === "insufficient-evidence" ||
      parsed.status === "insufficient-evidence";
  }
  let pagesVerified = 0;
  let pagesUnverified = 0;
  for (const statusesForPath of pageStatuses.values()) {
    if (
      [...statusesForPath].some((status) => status === "unverified" || status === "not-verified")
    ) {
      pagesUnverified += 1;
    } else if (
      [...statusesForPath].every((status) => ["verified", "pass", "satisfied"].includes(status))
    ) {
      pagesVerified += 1;
    }
  }
  return {
    pagesObserved: pageStatuses.size > 0 ? pageStatuses.size : null,
    pagesVerified: pageStatuses.size > 0 ? pagesVerified : null,
    pagesUnverified: pageStatuses.size > 0 ? pagesUnverified : null,
    dimensionsObserved,
    unverifiedDimensions: dimensionsObserved ? unverifiedDimensionKeys.size : null,
    structuredInsufficient,
    textualInsufficient,
  };
}

function classify({ cell, record, steps, counts, coverage, route }) {
  if (cell?.harnessFault)
    return {
      classification: "harness_setup",
      nextAction: "Fix the harness or local setup, then rerun this cell.",
    };
  if (cell?.cliRefusal)
    return {
      classification: "harness_setup",
      nextAction: "Resolve the CLI admission/setup refusal, then rerun this cell.",
    };
  const failures = [
    ...(Array.isArray(record?.failures) ? record.failures : []),
    ...(record?.failure ? [record.failure] : []),
    ...(cell?.failure ? [cell.failure] : []),
    ...(record?.failureCode
      ? [
          {
            code: record.failureCode,
            class: record.failureClass,
            stepId: record.terminalStepId,
            providerErrorClass: record.providerErrorClass,
            httpStatus: record.httpStatus,
          },
        ]
      : []),
    ...steps
      .filter((step) => step.failureCode)
      .map((step) => ({
        code: step.failureCode,
        class: step.failureClass,
        layer: step.failureLayer,
      })),
  ];
  const codes = failures.map((failure) => String(failure?.code ?? "").toLowerCase());
  const statuses = [record?.execution?.status, record?.runStatus, record?.status, cell?.status]
    .filter(Boolean)
    .map(String);
  const combinedCodes = codes.join(" ");
  if (codes.some((code) => /output[-_]limit|token[-_]limit|response[-_]too[-_]long/.test(code))) {
    return {
      classification: "output_limit",
      nextAction:
        "Inspect the effective output allowance and step budget; use a provider-supported allowance that fits the task scope.",
    };
  }
  if (
    codes.some((code) =>
      /^(output[-_](contract|schema|format)|invalid[-_](output|reply)|reply[-_]parse|evaluation[-_]schema[-_]required|quality[-_]envelope[-_]json)$/.test(
        code,
      ),
    ) ||
    failures.some(
      (failure) =>
        failure?.class === "contract-shape" || failure?.rejectionCode || failure?.rejectionSource,
    )
  ) {
    return {
      classification: "integration_output_contract",
      nextAction:
        "Inspect the rejected step output contract and structured rejection evidence; compare the prompt/schema with the provider response.",
    };
  }
  const runFailed =
    statuses.some((status) => status === "failed") ||
    steps.some((step) => ["failed", "error"].includes(step.status));
  const terminalSteps = steps.filter((step) => ["failed", "error"].includes(step.status));
  const terminalAttempts = terminalSteps.map((step) => step.attempts.at(-1)).filter(Boolean);
  const attemptEvidence =
    runFailed &&
    terminalAttempts.some(
      (attempt) => attempt.providerErrorClass || attempt.status === "provider-transient",
    );
  const providerEvidence =
    attemptEvidence ||
    failures.some(
      (failure) =>
        failure?.providerErrorClass ||
        failure?.httpStatus ||
        failure?.providerFailure ||
        (failure?.code === "provider-transient" && failure?.class === "flake"),
    ) ||
    Boolean(record?.providerErrorClass || record?.httpStatus || record?.providerFailure);
  if (providerEvidence && route.provider !== "unknown") {
    return {
      classification: "provider_error",
      nextAction: `Inspect the ${route.provider} request on the exact configured route, including structured provider status and retry behavior.`,
    };
  }
  if (cell?.status === "pending" || cell?.disposition === "pending") {
    return {
      classification: "pending",
      nextAction: "Wait for this planned cell to finish; no result is available yet.",
    };
  }
  const hasCoverageWarning =
    coverage?.hostDeclined === true ||
    coverage?.pagesUnverified > 0 ||
    coverage?.unverifiedDimensions > 0 ||
    coverage?.insufficientEvidence === true ||
    coverage?.overallDecision === "insufficient-evidence" ||
    coverage?.overallDecision === "unverified";
  if (hasCoverageWarning) {
    return {
      classification: "insufficient_evidence",
      nextAction: coverage.hostDeclined
        ? "Inspect the host decline reason and satisfy its output or coverage contract before counting this run as useful."
        : "Review missing or unverified evidence and the named coverage gaps before treating the result as useful success.",
    };
  }
  if (
    statuses.some((status) => status === "succeeded") &&
    counts.failed === 0 &&
    counts.unattempted === 0 &&
    steps.length > 0 &&
    !hasCoverageWarning &&
    !coverage.textualInsufficient
  ) {
    return {
      classification: "completed",
      nextAction:
        "Review the produced artifact and recorded coverage; use an independent judge only when configured.",
    };
  }
  if (coverage.textualInsufficient) {
    return {
      classification: "unknown",
      nextAction:
        "Review the model-authored summary that mentions insufficient evidence; confirm the caveat against structured coverage fields.",
    };
  }
  const hadEarlierProviderRetry = terminalSteps.some((step) =>
    step.attempts
      .slice(0, -1)
      .some((attempt) => attempt.providerErrorClass || attempt.status === "provider-transient"),
  );
  if (hadEarlierProviderRetry) {
    return {
      classification: "unknown",
      nextAction:
        "Review earlier provider retries as history; the terminal timeout remains ambiguous without provider evidence on the final attempt.",
    };
  }
  if (cell?.harnessFault || cell?.cliRefusal || combinedCodes.includes("spawn")) {
    return {
      classification: "harness_setup",
      nextAction: "Inspect the harness setup or CLI startup evidence, then rerun the cell.",
    };
  }
  return {
    classification: "unknown",
    nextAction:
      "Inspect the referenced run record and logs; available structured evidence does not identify the cause.",
  };
}

/**
 * `record` must be parsed structured run-result/record JSON. Raw logs and record
 * dumps are intentionally never scanned or copied into this summary.
 */
export function collectCellEvidence({
  cell = {},
  record = null,
  runResult = null,
  recordPath = null,
  manifest = null,
  plannedCell = null,
} = {}) {
  const actualCell = { ...object(plannedCell), ...object(cell) };
  const run = object(record);
  const result = object(runResult);
  const rawSteps = Array.isArray(run.steps)
    ? run.steps
    : Array.isArray(run.execution?.steps)
      ? run.execution.steps
      : [];
  const steps = rawSteps.map((step, index) => safeStep(step, index));
  const summaryCoverage = summaryEvidence(rawSteps);
  const planSteps = Array.isArray(actualCell.plannedSteps) ? actualCell.plannedSteps : [];
  const plannedIds = planSteps
    .map((step) => text(step?.id ?? step?.stepId ?? step))
    .filter(Boolean);
  const observedIds = new Set(steps.map((step) => step.id));
  const counts = {
    succeeded: steps.filter((step) => ["succeeded", "success", "completed"].includes(step.status))
      .length,
    failed: steps.filter((step) => ["failed", "error"].includes(step.status) || step.failureCode)
      .length,
    unattempted:
      steps.filter((step) =>
        ["pending", "skipped", "unattempted", "not-started"].includes(step.status),
      ).length + plannedIds.filter((id) => !observedIds.has(id)).length,
    running: steps.filter((step) => ["running", "in-progress"].includes(step.status)).length,
  };
  const quality =
    result.quality ??
    result.product?.quality ??
    run.quality ??
    run.product?.quality ??
    run.assessment ??
    null;
  const modelProfile = object(run.models?.[0]?.profile);
  const compositionRun = object(run.compositionExecution);
  const coverage = {
    overallDecision: text(
      quality?.decision ??
        quality?.overall_decision ??
        quality?.overallDecision ??
        run.overallDecision,
    ),
    pagesObserved: summaryCoverage.pagesObserved,
    pagesVerified: summaryCoverage.pagesVerified,
    pagesUnverified: summaryCoverage.pagesUnverified,
    dimensionsObserved: summaryCoverage.dimensionsObserved,
    unverifiedDimensions:
      number(
        quality?.unverifiedDimensions ?? quality?.unverified_dimensions ?? run.unverifiedDimensions,
      ) ?? summaryCoverage.unverifiedDimensions,
    insufficientEvidence:
      quality?.status === "insufficient-evidence" ||
      quality?.decision === "insufficient-evidence" ||
      quality?.overall_decision === "insufficient-evidence" ||
      run.overallDecision === "insufficient-evidence" ||
      run.sourceEvidence === "none" ||
      summaryCoverage.structuredInsufficient,
    textualInsufficient: summaryCoverage.textualInsufficient,
    hostDeclined: [
      run.disposition,
      run.product?.disposition,
      result.product?.disposition,
      actualCell.disposition,
    ].some((value) => ["host-declined", "host_declined", "declined"].includes(value)),
  };
  const route = routeOf(actualCell, run);
  const diagnostic = classify({ cell: actualCell, record: run, steps, counts, coverage, route });
  const composition = {
    ...Object.fromEntries(
      Object.entries(compositionRun).filter(([key]) =>
        ["compositionId", "releaseEligible", "workflow"].includes(key),
      ),
    ),
    deploymentRouteId: text(compositionRun.deployment?.routeId),
    ...object(actualCell.runManifest?.composition),
    ...object(actualCell.composition),
  };
  const limits = {
    ...object(
      actualCell.effectiveLimits ?? actualCell.effectiveSettings ?? manifest?.effectiveSettings,
    ),
    ...object(compositionRun.limits),
    ...modelProfile,
  };
  const usage = object(run.usage ?? run.tokenUsage ?? run.metrics?.usage);
  const runtime = object(manifest?.runtime ?? actualCell.runtime);
  const corpus = object(manifest?.corpus ?? actualCell.corpus);
  const recordFailure =
    run.failure ??
    run.failures?.find?.((entry) => entry.scope === "step") ??
    run.failures?.[0] ??
    (run.failureCode
      ? { code: run.failureCode, class: run.failureClass, stepId: run.terminalStepId }
      : null);
  const terminalStepId =
    recordFailure?.stepId ??
    steps.find((step) => step.failureCode === recordFailure?.code)?.id ??
    null;
  return {
    classification: diagnostic.classification,
    nextAction: diagnostic.nextAction,
    route,
    status:
      text(actualCell.status ?? result.execution?.status ?? run.execution?.status ?? run.status) ??
      "unknown",
    steps,
    counts,
    retries: steps
      .flatMap((step) => step.attempts)
      .filter(
        (attempt) => attempt.retryScheduled || attempt.failureCode || attempt.status === "retrying",
      )
      .map((attempt) => ({
        failureCode: attempt.failureCode,
        providerErrorClass: attempt.providerErrorClass,
        status: attempt.status,
        retryScheduled: attempt.retryScheduled,
        durationMs: attempt.durationMs,
      })),
    elapsedMs: number(run.execution?.durationMs ?? run.durationMs ?? actualCell.durationMs),
    usage: {
      inputTokens: number(usage.inputTokens ?? usage.promptTokens ?? usage.input),
      outputTokens: number(
        usage.outputTokens ?? usage.completionTokens ?? usage.output ?? run.outputTokens,
      ),
      totalTokens: number(usage.totalTokens ?? usage.total),
    },
    effectiveLimits: Object.fromEntries(
      Object.entries(limits).filter(
        ([key, value]) =>
          /limit|timeout|budget|turn|token|elapsed|context|window|tool.?call|retry/i.test(key) &&
          (typeof value === "number" || typeof value === "string"),
      ),
    ),
    composition: Object.fromEntries(
      Object.entries(composition).filter(
        ([key, value]) =>
          !/token|secret|credential|auth|password|key|url/i.test(key) &&
          ["string", "number", "boolean"].includes(typeof value),
      ),
    ),
    quality: {
      present: quality !== null,
      score: number(
        quality?.total ?? quality?.rubric?.total ?? quality?.score ?? quality?.overallScore,
      ),
      status: text(
        quality?.status ?? quality?.decision ?? quality?.rubric?.status ?? coverage.overallDecision,
      ),
      decision: text(quality?.decision ?? quality?.rubric?.decision),
      confidence: number(quality?.confidence ?? quality?.rubric?.confidence),
    },
    coverage,
    failure: recordFailure
      ? {
          code: text(recordFailure.code),
          class: text(recordFailure.class),
          layer: text(recordFailure.layer),
          stepId: text(terminalStepId),
        }
      : null,
    evidencePaths: {
      record: text(recordPath),
      log: text(actualCell.logPath),
      result: text(actualCell.resultPath ?? actualCell.runResultPath ?? actualCell.cliResultPath),
      patch: text(actualCell.patchPath),
    },
    runtime: {
      revision: text(runtime.revision ?? runtime.sha ?? runtime.commit),
      dirty: typeof runtime.dirty === "boolean" ? runtime.dirty : null,
    },
    corpus: {
      id: text(corpus.id ?? actualCell.corpusId),
      seal: text(corpus.manifestSha256 ?? corpus.seal ?? actualCell.corpusManifestSha256),
      sealed:
        typeof corpus.sealed === "boolean"
          ? corpus.sealed
          : Boolean(corpus.manifestSha256 ?? corpus.seal ?? actualCell.corpusManifestSha256),
      fixtureCommit: text(corpus.fixtureCommit),
      profileConfig: text(corpus.profileConfig ?? actualCell.profileConfig ?? modelProfile.sha256),
    },
  };
}
