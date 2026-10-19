#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Render the matrix into a Markdown report.
 *
 * Keeps kinds of evidence visibly separate, because collapsing them is how a
 * comparison starts asserting more than it measured:
 *   MECHANICAL  did the run finish, where did it stop, what did it change
 *   TASK SCORE  the judge total for a run that delivered, 0 for a run that
 *               delivered nothing or wrote outside its boundary
 *   QUALITY     the judge total of whatever was produced, delivered or not
 *
 * Cells on the composition path and on the model-profile path run different
 * budgets, so they are never ranked in one table. Judge verdicts from
 * different judges, prompts, rubrics, or corpora are never aggregated.
 *
 * Usage:
 *   node report.mjs [--config path] [--out path] [--title "..."]
 */
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FAILURE_CLASSES } from "../../src/operator/failure-class.ts";
import { canonicalDigest } from "./corpus.mjs";
import { cellId, loadConfig } from "./lib.mjs";
import { collectCellEvidence } from "./evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const mdCell = (value) =>
  String(value ?? "—")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
const evidenceLink = (label, path) => {
  if (typeof path !== "string" || path.length === 0) return `${label} —`;
  const target = encodeURI(path)
    .replaceAll("|", "%7C")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
  return `[${label}](<${target}>)`;
};
const diagnosisLabel = (classification) =>
  ({
    provider_error: "Provider/service failure",
    integration_output_contract: "DocsFab–model output contract",
    output_limit: "DocsFab–model output limit",
    harness_setup: "Harness/setup",
    insufficient_evidence: "Insufficient evidence",
    pending: "Pending",
    completed: "Completed",
    unknown: "Unknown",
  })[classification] ?? "Unknown";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** `median [min-max] n=k`, or an em dash when there is nothing to summarise. */
export function spread(values) {
  if (values.length === 0) return "—";
  const m = median(values);
  const text = Number.isInteger(m) ? `${m}` : m.toFixed(1);
  return values.length === 1
    ? `${text} n=1`
    : `${text} [${Math.min(...values)}–${Math.max(...values)}] n=${values.length}`;
}

/**
 * Failure classes that say nothing about the model: the provider, the network,
 * a credential, the harness's own state directory or environment
 * (`operator-input` inside a run), or an operator stopped the run. Every other
 * class (a reply the host refused, a bound the model ran into, an
 * unclassified stop) is the model's result. Checked against the product's closed vocabulary, so a
 * renamed class fails loudly instead of silently scoring.
 */
export const NON_MODEL_FAILURE_CLASSES = new Set([
  "operator-input",
  "auth",
  "infrastructure",
  "flake",
  "cancelled",
]);
for (const failureClass of NON_MODEL_FAILURE_CLASSES) {
  if (!FAILURE_CLASSES.includes(failureClass)) {
    throw new Error(
      `${failureClass} is not a DocsFab failure class; update NON_MODEL_FAILURE_CLASSES.`,
    );
  }
}

/**
 * The task score of one cell, or null when the cell says nothing about the
 * model: a harness fault, a CLI refusal before any run, a failure of a
 * non-model class, a same-family judge, or a judge error. A run that did not
 * succeed for a model reason delivered nothing, so it scores 0 even if it
 * wrote a document first; so does a write outside the task's boundary.
 */
export function taskScore(row) {
  const verdict = row.judge;
  if (!verdict) return null;
  if (row.harnessFault || row.cliRefusal) return null;
  if (row.status !== "succeeded" && NON_MODEL_FAILURE_CLASSES.has(row.failure?.class)) return null;
  if (verdict.status === "no-output") return 0;
  if (verdict.status !== "scored") return null;
  if (row.status !== "succeeded" || (row.boundaryViolations ?? []).length > 0) return 0;
  return verdict.total;
}

export function qualityScore(row) {
  return row.judge?.status === "scored" ? row.judge.total : null;
}

/** Refuse to aggregate verdicts that came from different judging setups. */
export function assertOneJudgeIdentity(rows) {
  const identities = new Map();
  for (const row of rows) {
    if (!row.judgeIdentity) continue;
    identities.set(canonicalDigest(row.judgeIdentity), row.judgeIdentity);
  }
  if (identities.size > 1) {
    throw new Error(
      `judged.jsonl mixes ${identities.size} judge identities (model, prompt version, rubric, corpus); ` +
        `rejudge with one config or report them separately: ${[...identities.values()]
          .map((identity) => JSON.stringify(identity))
          .join("; ")}`,
    );
  }
  return [...identities.values()][0] ?? null;
}

export function renderReport({ title, results, judged, probe, manifest = null }) {
  const judgedBy = new Map(judged.map((row) => [cellId(row), row]));
  const identity = assertOneJudgeIdentity(judged);
  const rows = results.map((row) => ({ ...row, judge: judgedBy.get(cellId(row))?.judge ?? null }));
  const byId = new Map(rows.map((row) => [cellId(row), row]));
  for (const planned of manifest?.plannedCells ?? []) {
    const id = cellId(planned);
    if (!byId.has(id)) {
      const pending = { ...planned, status: "pending", disposition: "pending" };
      pending.cellEvidence = collectCellEvidence({ cell: pending, plannedCell: planned, manifest });
      rows.push(pending);
    }
  }
  for (const row of rows) {
    row.cellEvidence ??= collectCellEvidence({
      cell: row,
      recordPath: row.recordPath ?? null,
      manifest,
    });
  }
  const workflows = [...new Set(rows.map((row) => row.workflow))];
  const out = [`# ${title}`, ""];
  out.push(
    `Generated by \`scripts/model-matrix/report.mjs\` from ${rows.length} cell(s): ` +
      `${new Set(rows.map((row) => row.model).filter(Boolean)).size} model(s), ${workflows.length} workflow(s), ` +
      `corpus ${[...new Set(rows.map((row) => row.corpusId).filter(Boolean))].join(", ") || manifest?.corpus?.id || "unknown"}.`,
    "",
  );
  if (identity) {
    out.push(
      `Judge: \`${identity.model}\` (${identity.family}), prompt ${identity.promptVersion}, ` +
        `rubric ${identity.rubricSha256.slice(0, 12)}, corpus manifest ${String(identity.corpusManifestSha256).slice(0, 12)}.`,
      "",
    );
  }

  out.push("## Cell diagnosis", "");
  out.push(
    "| Model | Workflow | Route | Steps passed/total | Terminal step/code | Diagnosis | Run quality / coverage | Next action |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of rows) {
    const evidence = row.cellEvidence;
    const passedTotal = evidence.steps.length
      ? `${evidence.counts.succeeded}/${evidence.steps.length}`
      : "—";
    const terminal = evidence.failure
      ? `${evidence.failure.stepId ?? "run"}:${evidence.failure.code ?? "unknown"}`
      : "—";
    const pageCoverage =
      evidence.coverage.pagesObserved === null
        ? "page coverage not recorded"
        : `${evidence.coverage.pagesUnverified}/${evidence.coverage.pagesObserved} pages unverified`;
    const dimensionCoverage = evidence.coverage.dimensionsObserved
      ? `${evidence.coverage.unverifiedDimensions} dimension${evidence.coverage.unverifiedDimensions === 1 ? "" : "s"} unverified`
      : "dimension coverage not measured";
    const quality = `${evidence.quality.present ? (evidence.quality.score === null ? "quality report present; no scalar score" : `run score ${evidence.quality.score}`) : "quality report absent"}; ${evidence.quality.decision ?? evidence.coverage.overallDecision ?? "decision not recorded"}; ${pageCoverage}; ${dimensionCoverage}${evidence.coverage.textualInsufficient ? "; prose mentions insufficient evidence" : ""}`;
    const route = `${evidence.route.provider}${evidence.route.route ? ` (${evidence.route.route})` : ""}`;
    out.push(
      `| \`${mdCell(row.model ?? "unknown")}\` | ${mdCell(row.workflow)} | ${mdCell(route)} | ${passedTotal} | ${mdCell(terminal)} | ${mdCell(diagnosisLabel(evidence.classification))} | ${mdCell(quality)} | ${mdCell(evidence.nextAction)} |`,
    );
  }
  out.push("");
  out.push("### Cell evidence details", "");
  for (const row of rows) {
    const evidence = row.cellEvidence;
    out.push(
      `#### ${mdCell(row.model ?? "unknown")} / ${mdCell(row.workflow ?? "unknown")} / r${mdCell(row.rep ?? "?")}`,
      "",
    );
    out.push(
      `- Status: ${mdCell(evidence.status)}; ${evidence.counts.succeeded} succeeded, ${evidence.counts.failed} failed, ${evidence.counts.unattempted} unattempted, ${evidence.counts.running} running.`,
    );
    out.push(
      `- Elapsed: ${evidence.elapsedMs ?? "not recorded"} ms; tokens: input ${evidence.usage.inputTokens ?? "—"}, output ${evidence.usage.outputTokens ?? "—"}, total ${evidence.usage.totalTokens ?? "—"}.`,
    );
    out.push(
      `- Runtime: ${mdCell(evidence.runtime.revision ?? "unknown")}${evidence.runtime.dirty === null ? "" : evidence.runtime.dirty ? " (dirty)" : " (clean)"}; corpus: ${mdCell(evidence.corpus.id ?? "unknown")} seal ${mdCell(evidence.corpus.seal ?? "unknown")}${evidence.corpus.fixtureCommit ? `; fixture commit ${mdCell(evidence.corpus.fixtureCommit)}${evidence.corpus.sealed === false ? " (unsealed retained fixture)" : ""}` : ""}; composition/profile: ${mdCell(JSON.stringify(evidence.composition))}.`,
    );
    out.push(
      `- Effective limits: ${mdCell(JSON.stringify(evidence.effectiveLimits))}; coverage: ${mdCell(JSON.stringify(evidence.coverage))}; run quality report: ${evidence.quality.present ? `present (${evidence.quality.decision ?? "decision unavailable"}; rubric total ${evidence.quality.score ?? "unavailable"})` : "absent"}. Independent judge score is reported separately above when available.`,
    );
    out.push(
      `- Steps: ${evidence.steps.length ? evidence.steps.map((step) => `${mdCell(step.id)}=${mdCell(step.status)}${step.failureCode ? ` (${mdCell(step.failureCode)}${step.failureClass ? `/${mdCell(step.failureClass)}` : ""}${step.failureLayer ? `/${mdCell(step.failureLayer)}` : ""})` : ""}${step.durationMs === null ? "" : ` ${step.durationMs}ms`}${step.attempts.length ? `; attempts: ${step.attempts.map((attempt) => `${mdCell(attempt.status)}${attempt.failureCode ? `:${mdCell(attempt.failureCode)}` : ""}${attempt.durationMs === null ? "" : ` ${attempt.durationMs}ms`}${attempt.retryScheduled === null ? "" : attempt.retryScheduled ? " retry scheduled" : " no retry"}`).join(", ")}` : ""}`).join("; ") : "No step evidence recorded."}`,
    );
    out.push(
      `- Evidence: ${evidenceLink("record", evidence.evidencePaths.record)}; ${evidenceLink("log", evidence.evidencePaths.log)}; ${evidenceLink("result", evidence.evidencePaths.result)}; ${evidenceLink("patch", evidence.evidencePaths.patch)}.`,
      "",
    );
  }

  for (const mode of [...new Set(rows.map((row) => row.mode))].sort()) {
    const modeRows = rows.filter((row) => row.mode === mode);
    out.push(`## ${mode === "composition" ? "Composition path" : "Model-profile path"}`, "");
    out.push(
      "| Model | Workflow | Succeeded | Task score | Quality when produced | Unscored | Stops |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const model of [...new Set(modeRows.map((row) => row.model))]) {
      for (const workflow of workflows) {
        const cells = modeRows.filter((row) => row.model === model && row.workflow === workflow);
        if (cells.length === 0) continue;
        const succeeded = cells.filter((row) => row.status === "succeeded").length;
        const tasks = cells.map(taskScore).filter((value) => value !== null);
        const quality = cells.map(qualityScore).filter((value) => value !== null);
        const unscored = cells.filter((row) => taskScore(row) === null).length;
        const stops = cells
          .filter((row) => row.status !== "succeeded")
          .map((row) =>
            row.harnessFault
              ? `harness:${row.harnessFault.code}`
              : row.failure
                ? `${row.failure.stepId ?? "run"}:${row.failure.code}`
                : row.cliRefusal
                  ? `cli:${row.cliRefusal.code ?? "refused"}`
                  : (row.disposition ?? row.status ?? "unknown"),
          );
        out.push(
          `| \`${model}\` | ${workflow} | ${succeeded}/${cells.length} | ${spread(tasks)} | ` +
            `${spread(quality)} | ${unscored} | ${[...new Set(stops)].join(", ") || "—"} |`,
        );
      }
    }
    out.push("");
  }

  const flagged = rows.filter(
    (row) => (row.boundaryViolations ?? []).length > 0 || row.judge?.statedTotalMismatch,
  );
  if (flagged.length > 0) {
    out.push("## Flags", "");
    for (const row of flagged) {
      if ((row.boundaryViolations ?? []).length > 0) {
        out.push(
          `- \`${cellId(row)}\` wrote outside its boundary: ${row.boundaryViolations.join(", ")}.`,
        );
      }
      if (row.judge?.statedTotalMismatch) {
        out.push(
          `- \`${cellId(row)}\`: the judge stated ${row.judge.statedTotalMismatch.stated}; ` +
            `its dimensions sum to ${row.judge.statedTotalMismatch.derived}, which is used.`,
        );
      }
    }
    out.push("");
  }

  if (probe.length) {
    out.push("## Harness compatibility probe", "");
    out.push("| Model | Verdict |", "| --- | --- |");
    for (const row of probe) out.push(`| \`${row.model}\` | ${row.verdict} |`);
    out.push("");
  }

  out.push("## Reading these numbers", "");
  out.push(
    "- **Task score** is the judge total for a run that succeeded and stayed inside its writing boundary.",
    "  A run that failed for a model reason, stopped for input, or produced no target output scores 0.",
    "  A harness fault, a CLI refusal before any run, a failure classed operator-input, auth,",
    "  infrastructure, flake or cancelled, a same-family judge, or a judge error is unscored and counted separately: those cells",
    "  say nothing about the model.",
    "- **Quality when produced** grades whatever the run produced, even if a later step failed.",
    "- Cells are `median [min–max] n=k` over repetitions. Treat differences inside the spread as noise.",
    "- The judge reads the corpus's declared sources at each cell's revision. Its total is the sum of",
    "  its validated dimension scores, never the total it states.",
    "",
  );
  return out.join("\n");
}

async function main() {
  const config = await loadConfig(arg("config", join(HERE, "matrix.config.json")));
  const root = config.output.root;
  const results = await readJsonl(join(root, "results.jsonl"));
  const judged = await readJsonl(join(root, "judged.jsonl"));
  const manifestPath = join(root, "manifest.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : null;
  for (const row of results) {
    const runResultPath = row.resultPath ?? row.runResultPath ?? row.cliResultPath;
    if (
      !row.cellEvidence &&
      ((row.recordPath && existsSync(row.recordPath)) ||
        (runResultPath && existsSync(runResultPath)))
    ) {
      try {
        const record =
          row.recordPath && existsSync(row.recordPath)
            ? JSON.parse(await readFile(row.recordPath, "utf8"))
            : null;
        const runResult =
          runResultPath && existsSync(runResultPath)
            ? JSON.parse(await readFile(runResultPath, "utf8"))
            : null;
        row.cellEvidence = collectCellEvidence({
          cell: row,
          record,
          runResult,
          recordPath: row.recordPath,
          manifest,
        });
      } catch {
        row.cellEvidence = collectCellEvidence({
          cell: row,
          record: null,
          runResult: null,
          recordPath: row.recordPath,
          manifest,
        });
      }
    }
  }
  const probe = existsSync(join(root, "probe.json"))
    ? JSON.parse(await readFile(join(root, "probe.json"), "utf8")).rows
    : [];
  const text = renderReport({ title: arg("title", config.name), results, judged, probe, manifest });
  const outPath = arg("out", join(root, "report.md"));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text);
  const judgedById = new Map(judged.map((row) => [cellId(row), row]));
  const rowsById = new Map(results.map((row) => [cellId(row), row]));
  const summaryRows = results.map((row) => ({
    ...row,
    judge: judgedById.get(cellId(row))?.judge ?? null,
  }));
  for (const planned of manifest?.plannedCells ?? []) {
    const id = cellId(planned);
    if (!rowsById.has(id)) {
      const pending = { ...planned, status: "pending", disposition: "pending" };
      pending.cellEvidence = collectCellEvidence({ cell: pending, plannedCell: planned, manifest });
      summaryRows.push(pending);
    }
  }
  for (const row of summaryRows)
    row.cellEvidence ??= collectCellEvidence({
      cell: row,
      recordPath: row.recordPath ?? null,
      manifest,
    });
  await writeFile(
    join(dirname(outPath), "summary.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "docsfab-model-matrix-summary", runtime: manifest?.runtime ?? null, corpus: manifest?.corpus ?? null, cells: summaryRows.map((row) => ({ cellId: cellId(row), model: row.model ?? null, workflow: row.workflow ?? null, mode: row.mode ?? null, repetition: row.rep ?? row.repetition ?? null, status: row.status ?? "unknown", taskScore: taskScore(row), judgeQualityScore: qualityScore(row), evidence: row.cellEvidence })) }, null, 2)}\n`,
  );
  console.log(`wrote ${outPath}`);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
