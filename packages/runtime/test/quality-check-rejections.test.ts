// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isRetainableInferenceRejection } from "../src/config/inference-rejection-limits.js";
import {
  classifyQualityScoreDiagnostic,
  classifyReportBindingDiagnostic,
  hostCheckRejection,
  projectLockedValidatorRejection,
  QUALITY_CHECK_INTEGRITY_CODES,
  QUALITY_CHECK_REJECTION_CODES,
  QUALITY_HOST_CHECK_LOCATIONS,
  QUALITY_SCORE_SEMANTICS_FALLBACK,
  QUALITY_SCORE_VALIDATOR_REFUSED,
  QUALITY_VALIDATOR_UNAVAILABLE_CODES,
  REPORT_BINDING_SEMANTICS_FALLBACK,
  REPORT_BINDING_VALIDATOR_REFUSED,
  technicalTraceRejection,
} from "../src/evaluation-report/quality-check-rejections.js";
import { QUALITY_ARTIFACT_FAILURES } from "../src/evaluation-report/quality-validator-host.js";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const HOST = "../src/evaluation-report/quality-validator-host.ts";
const HOST_MODULES = [
  "../src/evaluation-report/quality-validator-host/bounded-child.ts",
  "../src/evaluation-report/quality-validator-host/derivation.ts",
  "../src/evaluation-report/quality-validator-host/private-files.ts",
  "../src/evaluation-report/quality-validator-host/projection.ts",
];
const STAGING = "../src/evaluation-report/quality-artifact-staging.ts";
const STEP_LOOP = "../src/workflow-execution/runner-step-loop.ts";

/** Adjacent Python string literals, joined, with their `f` prefixes dropped. */
function joinLiterals(group: string): string {
  return [...group.matchAll(/f?"([^"]*)"/gu)].map((part) => part[1]).join("");
}

/** The top-level arguments of one call whose `(` is at `open`. */
function callArguments(text: string, open: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let index = open; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') quoted = !quoted;
    if (!quoted && "([{".includes(character)) depth += 1;
    if (!quoted && ")]}".includes(character)) depth -= 1;
    if (depth === 0) break;
    if (!quoted && depth === 1 && character === ",") {
      parts.push(current.trim());
      current = "";
    } else if (index > open) {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Every diagnostic template a shipped Python validator can emit, rendered
 * with placeholder values. Read from the validator the runtime ships, so a
 * new or reworded diagnostic fails here instead of silently reading as the
 * fallback.
 *
 * `{label}` is rendered with the labels that can reach it: in a field helper
 * (`_mapping`, `exact_fields`), every label its callers pass; elsewhere, the
 * function's own `label = ...`. A caller passing `label` itself passes its
 * own function's labels.
 */
function renderedTemplates(path: string): string[] {
  const script = source(path);
  const functions = script.split(/^(?=def )/mu).map((body) => ({
    name: /^def (\w+)/u.exec(body)?.[1] ?? "",
    body,
  }));
  const literal = /^((?:f?"[^"]*"\s*)+)$/u;
  const localLabels = (body: string) =>
    [...body.matchAll(/^\s+label = ((?:f?"[^"]*"\s*)+)$/gmu)].map((match) =>
      joinLiterals(match[1]!),
    );
  const helperArgument: Record<string, number> = {
    _mapping: 1,
    _exact_fields: 2,
    exact_fields: 2,
  };
  const helperLabels = new Map<string, string[]>();
  for (const { body } of functions) {
    const own = localLabels(body);
    for (const [helper, position] of Object.entries(helperArgument)) {
      for (const match of body.matchAll(new RegExp(`(?<![\\w.])${helper}\\(`, "gu"))) {
        if (/^def /u.test(body.slice(Math.max(0, match.index! - 4), match.index!))) continue;
        const argument = callArguments(body, match.index! + helper.length)[position];
        if (argument === undefined) continue;
        const labels = literal.test(argument)
          ? [joinLiterals(argument)].flatMap((label) =>
              label.includes("{label}")
                ? own.map((base) => label.replace("{label}", base))
                : [label],
            )
          : argument === "label"
            ? own
            : [];
        helperLabels.set(helper, [...(helperLabels.get(helper) ?? []), ...labels]);
      }
    }
  }
  const literals = String.raw`((?:f?"[^"]*"\s*)+)`;
  const render = (template: string) =>
    template.replace(/\{[^}]*!r\}/gu, "'placeholder'").replace(/\{[^}]*\}/gu, "placeholder");
  const templates: string[] = [];
  for (const { name, body } of functions) {
    const labels = helperLabels.get(name) ?? localLabels(body);
    const raw = [
      ...body.matchAll(new RegExp(String.raw`errors\.append\(\s*${literals}\)`, "gu")),
      ...body.matchAll(new RegExp(String.raw`raise ValueError\(\s*${literals}\)`, "gu")),
      ...body.matchAll(new RegExp(String.raw`(?:return|\+) \[\s*${literals}\]`, "gu")),
      ...body.matchAll(new RegExp(String.raw`[[(]\s*${literals}\s*for \w+ in`, "gu")),
    ].map((match) => joinLiterals(match[1]!));
    for (const template of raw) {
      if (!template.includes("{label}")) templates.push(render(template));
      else {
        expect(labels.length, `labels reaching ${name}`).toBeGreaterThan(0);
        for (const label of labels) templates.push(render(template.replace("{label}", label)));
      }
    }
  }
  return [...new Set(templates)];
}

/** The text of one top-level function or method, from its signature to its closing brace. */
function functionBody(text: string, signature: RegExp): string {
  const start = text.search(signature);
  expect(start, `signature ${signature}`).toBeGreaterThanOrEqual(0);
  const open = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  throw new Error("The function body in the drift fixture is not balanced.");
}

/** Character spans of every `name(...)` call in a text. */
function callSpans(text: string, name: RegExp): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(new RegExp(`${name.source}\\(`, "gu"))) {
    const open = match.index! + match[0].length - 1;
    let depth = 0;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      if (text[index] === ")") depth -= 1;
      if (depth === 0) {
        spans.push([open, index]);
        break;
      }
    }
  }
  return spans;
}

describe("quality-path failure codes (#1237)", () => {
  it("classifies every diagnostic the shipped score validator can emit", () => {
    const templates = renderedTemplates("../quality/checks/validate_quality_score.py");
    expect(templates.length).toBeGreaterThan(15);
    expect(
      templates.filter(
        (message) =>
          classifyQualityScoreDiagnostic(message).code === QUALITY_SCORE_SEMANTICS_FALLBACK,
      ),
    ).toEqual([]);
  });

  it("classifies every diagnostic the shipped report validator can emit", () => {
    const templates = renderedTemplates("../quality/checks/validate_quality_report.py");
    expect(templates.length).toBeGreaterThan(40);
    expect(
      templates.filter(
        (message) =>
          classifyReportBindingDiagnostic(message).code === REPORT_BINDING_SEMANTICS_FALLBACK,
      ),
    ).toEqual([]);
  });

  it("classifies JSON and plain limitation-row diagnostics at the limitation field", () => {
    for (const [message, code] of [
      ["v0.2 JSON limitation row is invalid", "report-limitation-row-ambiguous"],
      ["v0.2 JSON limitation row has an invalid value", "report-limitation-value-invalid"],
      ["v0.2 report limitation row has an invalid value", "report-limitation-value-invalid"],
    ] as const) {
      expect(classifyReportBindingDiagnostic(message)).toEqual({
        code,
        location: "$.limitations",
      });
    }
  });

  it("fails when a validator host producer throws without a closed code", () => {
    // Every failure inside validate() must be a coded QualityHostCheckError or
    // a staging error with a reason; the host turns anything else into its
    // check's integrity code. The constructor's configuration refusals run
    // before any step and are the only plain throws.
    const host = source(HOST);
    const hostConstructor = functionBody(host, /public constructor\(private readonly options/u);
    const plainThrows = [...host.matchAll(/throw new Error\(/gu)].length;
    const constructorThrows = [...hostConstructor.matchAll(/throw new Error\(/gu)].length;
    expect(plainThrows).toBe(constructorThrows);
    // Every refusal passes a rejection: reject() takes it as a required argument.
    const reject = functionBody(host, /private async reject\(/u);
    expect(reject).toMatch(/rejection: QualityValidationRejectionV1,\n/u);
    expect(host).not.toMatch(/rejection\?: QualityValidationRejectionV1/u);
    for (const [start, end] of callSpans(host, /this\.reject/u)) {
      expect(host.slice(start, end)).toMatch(
        /(?:Rejection|projectEvaluationValidatorRejection)\(/u,
      );
    }
  });

  it("fails when a staging rule refuses without naming itself", () => {
    const staging = source(STAGING);
    for (const name of [
      "stageQualityArtifactCandidate",
      "preflightQualityArtifactCandidateContent",
      "stageFinalQualityReport",
      "loadStagedQualityArtifact",
      "validateBindings",
    ]) {
      const body = functionBody(staging, new RegExp(`function ${name}\\(`, "u"));
      expect(body, name).not.toMatch(/\bfail\(\s*"[a-z-]+"\s*\)/u);
      const wrapped = callSpans(body, /\breasoned(?:Async)?/u);
      for (const match of body.matchAll(/\b(?:kit\.\w+|qualityObject|persistQualityPayload)\(/gu)) {
        expect(
          wrapped.some(([start, end]) => match.index! > start && match.index! < end),
          `${name}: ${match[0]} outside a reasoned() rule`,
        ).toBe(true);
      }
    }
  });

  it("fails when a runner quality guard throws without a closed code", () => {
    const loop = source(STEP_LOOP);
    // The candidate guards run in the per-attempt admission, and the
    // post-inference block stops on its refusal.
    const guard =
      /if \((?:qualityCandidateValidation|admitsQualityCandidate)\b|const admitQualityCandidate = /u;
    const guards = [...loop.matchAll(new RegExp(guard.source, "gu"))].map((match) =>
      functionBody(loop.slice(match.index!), guard),
    );
    expect(guards.length).toBeGreaterThanOrEqual(3);
    for (const guard of guards) expect(guard).not.toMatch(/throw new Error\(/u);
  });

  it("uses every host code and names each check's integrity and unavailable codes", () => {
    const sources = [HOST, ...HOST_MODULES, STAGING, STEP_LOOP].map(source).join("\n");
    const derived = new Set<string>([
      ...Object.values(QUALITY_CHECK_INTEGRITY_CODES),
      ...Object.values(QUALITY_VALIDATOR_UNAVAILABLE_CODES),
    ]);
    const unused = Object.keys(QUALITY_HOST_CHECK_LOCATIONS).filter(
      (code) => !derived.has(code) && !sources.includes(`"${code}"`),
    );
    expect(unused).toEqual([]);
  });

  it("keeps every code retainable and distinct from the outer failure codes", () => {
    const outer = new Set(Object.keys(QUALITY_ARTIFACT_FAILURES));
    for (const code of QUALITY_CHECK_REJECTION_CODES) {
      expect(outer.has(code), code).toBe(false);
      expect(
        isRetainableInferenceRejection({ code, location: "$" }),
        `${code} must pass the retained code grammar`,
      ).toBe(true);
    }
    for (const [code, location] of Object.entries(QUALITY_HOST_CHECK_LOCATIONS)) {
      expect(isRetainableInferenceRejection({ code, location }), code).toBe(true);
    }
    expect(hostCheckRejection("report-finalization", "report-limitation-duplicate")).toEqual({
      validator: "report-finalization",
      code: "report-limitation-duplicate",
      location: "$.limitations",
      issueCount: 1,
    });
  });

  it("reads a score or report refusal without retaining validator text", () => {
    const secret = `nvapi-${"R5t6Y7u8".repeat(5)}`;
    const report = projectLockedValidatorRejection({
      validator: "report-binding",
      stderr: `error: report profile does not match evaluation.json\nerror: SENTINEL ${secret}\n`,
    });
    expect(report).toEqual({
      validator: "report-binding",
      code: "report-profile-mismatch",
      location: "$.profile",
      issueCount: 2,
    });
    const score = projectLockedValidatorRejection({
      validator: "quality-score",
      stderr: `error: unsupported rubric: '${secret}'\n`,
    });
    expect(score).toEqual({
      validator: "quality-score",
      code: "score-rubric-unsupported",
      location: "$.rubric",
      issueCount: 1,
    });
    expect(JSON.stringify([report, score])).not.toMatch(/SENTINEL|nvapi-/u);
    expect(
      projectLockedValidatorRejection({
        validator: "quality-score",
        stderr: "",
      }),
    ).toEqual({
      validator: "quality-score",
      code: QUALITY_SCORE_VALIDATOR_REFUSED,
      location: "$",
      issueCount: 0,
    });
    expect(
      projectLockedValidatorRejection({
        validator: "report-binding",
        stderr: "Traceback\n",
      }),
    ).toMatchObject({ code: REPORT_BINDING_VALIDATOR_REFUSED, issueCount: 0 });
    expect(
      projectLockedValidatorRejection({
        validator: "report-binding",
        stderr: "error: an unrecognised refusal\n",
      }),
    ).toMatchObject({ code: REPORT_BINDING_SEMANTICS_FALLBACK, location: "$" });
  });

  it("codes the first technical trace violation, and a trace fault that names none", () => {
    expect(
      technicalTraceRejection({
        status: "invalid",
        violations: [
          { code: "missing-uncertainty", factId: "FACT-1" },
          { code: "missing-fact-id" },
        ],
        truncated: false,
      }),
    ).toEqual({
      validator: "technical-trace",
      code: "technical-trace-missing-uncertainty",
      location: "$.findings",
      issueCount: 2,
    });
    expect(
      technicalTraceRejection({
        status: "passed",
        violations: [],
        truncated: false,
      }),
    ).toEqual(hostCheckRejection("technical-trace", "technical-trace-integrity-failed"));
  });
});
