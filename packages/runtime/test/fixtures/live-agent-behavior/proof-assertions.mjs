// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fixture-specific assertions, not product routing or model instructions. */
export function proofFixture(name) {
  const paragraph =
    name === "focused"
      ? "Simply run `node cli.mjs export --output report.txt` to instantly save a UTF-8 plain-text report."
      : "Simply run `node cli.mjs export` to instantly save report.txt. The --output option is optional and all export files are JSON.";
  return {
    readme: `# Bluebird CLI\n\nBluebird exports a local text report. Requires Node.js 22 or later.\n\n## Quick Start\n\n${paragraph}\n`,
    ...(name === "pull-request"
      ? {
          diff: [
            "diff --git a/cli.mjs b/cli.mjs",
            "--- a/cli.mjs",
            "+++ b/cli.mjs",
            "@@ -1,4 +1,9 @@",
            ' import { writeFileSync } from "node:fs";',
            " const args = process.argv.slice(2);",
            '-const output = args[args.indexOf("--output") + 1] || "report.txt";',
            '-writeFileSync(output, JSON.stringify({ report: "Bluebird" }));',
            '+const outputIndex = args.indexOf("--output");',
            '+if (args[0] !== "export" || outputIndex < 0 || !args[outputIndex + 1]) {',
            '+  console.error("Usage: node cli.mjs export --output <path> (required; UTF-8 plain text)");',
            "+  process.exitCode = 2;",
            "+} else {",
            '+  writeFileSync(args[outputIndex + 1], "Bluebird plain-text report\\n");',
            "+}",
            "",
          ].join("\n"),
        }
      : {}),
    cli: [
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'const outputIndex = args.indexOf("--output");',
      'if (args[0] !== "export" || outputIndex < 0 || !args[outputIndex + 1]) {',
      '  console.error("Usage: node cli.mjs export --output <path> (required; UTF-8 plain text)");',
      "  process.exitCode = 2;",
      "} else {",
      '  writeFileSync(args[outputIndex + 1], "Bluebird plain-text report\\n");',
      "}",
      "",
    ].join("\n"),
  };
}

/** A code-only review or a claim of skill use is not documentation review evidence. */
export function assessPullRequestReview({
  skillUses,
  workflows,
  targetRead,
  sourceRead,
  diffRead,
  finalText,
}) {
  const reviewUsed =
    skillUses.some((use) => use.skill === "review-documentation" && use.verified) ||
    workflows.some((run) => run.workflow === "review-documentation" && run.status === "succeeded");
  const documentationCorrection = assessFocusedFinding(
    finalText,
    sourceRead,
    proofFixture("pull-request").readme,
  ).groundedCommandCorrection;
  const readerImpact =
    /\b(?:fails?|failed|exits?|rejects?|usage error|cannot export|does not (?:write|save)|won't (?:write|save))\b/iu.test(
      finalText,
    );
  return (
    reviewUsed &&
    targetRead &&
    sourceRead &&
    diffRead &&
    /README\.md/u.test(finalText) &&
    documentationCorrection &&
    readerImpact
  );
}

export function assessFocusedFinding(text, sourceRead, readme) {
  const clarityCorrection =
    /simply|instantly/iu.test(text) &&
    /remove|omit|replace|avoid|delete|drop|unsupported|misleading/iu.test(text);
  const groundedCommandCorrection =
    sourceRead &&
    /`node\s+cli\.mjs\s+export`/u.test(readme ?? "") &&
    !/\b(?:no (?:correction|change|revision)s? (?:is|are) (?:required|needed|necessary)|(?:do not|don't) (?:add|include)\b[^.!?\n]{0,60}--output)/iu.test(
      text,
    ) &&
    (/\b(?:omits?|omitted|missing|lacks?|add|include)\b[^.!?\n]{0,100}--output\b/iu.test(text) ||
      /--output\b[^.!?\n]{0,100}\b(?:missing|omitted)\b/iu.test(text)) &&
    /node\s+cli\.mjs\s+export\s+--output\s+[\w./-]+\.txt\b/u.test(text);
  return { clarityCorrection, groundedCommandCorrection };
}

export function proofConversationSeconds(name) {
  return name === "workflow" ? 900 : 240;
}

/** Retain bounded execution facts without copying prompts, reports, or errors. */
export function summarizeProofRun(record) {
  const statuses = new Set([
    "queued",
    "running",
    "succeeded",
    "failed",
    "pending",
    "needs-human-decision",
    "needs-input",
  ]);
  const status = (value) => (statuses.has(value) ? value : "unknown");
  const identifier = (value) =>
    typeof value === "string" && /^[a-z0-9-]{1,80}$/u.test(value) ? value : undefined;
  const failureCodes = new Set([
    "candidate-invalid",
    "target-scope-mismatch",
    "evaluation-invalid",
    "quality-score-invalid",
    "report-binding-invalid",
    "validator-unavailable",
    "validator-integrity-invalid",
    "artifact-integrity-invalid",
  ]);
  // A source-obligation host-path refusal is saved either as the coded rule
  // sentence or as the older fixed sentence. Both classify, so a proof run over
  // a saved record keeps its category after the screen is gone.
  const hostPathRefusal = (value) =>
    value === "Source-obligation evidence disclosed a host path." ||
    (typeof value === "string" &&
      /^Source-obligation response did not satisfy the host-owned contract under rule host-path-disclosure at \$\.?$/u.test(
        value,
      ));
  const code = record.qualityArtifactValidation?.failureCode;
  return {
    runId: identifier(record.id),
    workflow: identifier(record.workflow),
    status: status(record.status),
    qualityFailureCode: failureCodes.has(code) ? code : undefined,
    steps: Array.isArray(record.steps)
      ? record.steps.slice(0, 32).map((step) => ({
          id: identifier(step.id),
          status: status(step.status),
          failureCategory: hostPathRefusal(step.error) ? "source-obligation-host-path" : undefined,
          durationMs:
            Number.isSafeInteger(step.durationMs) && step.durationMs >= 0
              ? step.durationMs
              : undefined,
        }))
      : [],
  };
}

/** Relevant profile/rubric files; callers still verify the locked digest and read result. */
export function isFocusedQualityGuidance(path) {
  return (
    typeof path === "string" &&
    /^(?:profiles\/|rubrics\/(?:getting-started|tutorial|how-to|task-guide|concept-guide)(?:[/.\-]|$))/u.test(
      path,
    )
  );
}
