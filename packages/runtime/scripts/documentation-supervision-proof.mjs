// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Real-provider proof for the frozen documentation-supervision pilot corpus. */
import { internalContentPath } from "../src/config/internal-content.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { installPackedDocsFab, packDocsFab } from "./lib/packed-cli.mjs";

const execute = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
export const DOCUMENTATION_SUPERVISION_PROOF_CASES = Object.freeze(
  [
    ["markdown-update-command-and-anchor-v1", "public-command-comparison"],
    ["markdown-no-change-contract-comparison-v1", "internal-only-comparison"],
    ["markdown-insufficient-evidence-unknown-comparison-v1", "current-snapshot-without-comparison"],
  ].flatMap(([id, input]) => [
    { id, input, surface: "workflow" },
    { id, input, surface: "direct-skill" },
  ]),
);
const SOURCE_PATHS = Object.freeze({
  "repository-instruction": ["AGENTS.md"],
  "public-contract": ["src/orbit.py", "tests/test_orbit.py"],
  "current-documentation": ["docs/cli.md"],
});
const SYNTHETIC_GITLAB_REMOTE =
  "https://gitlab.docsfab.invalid/documentation-supervision/fixture.git";
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(projectRoot, "../..");
const corpusRoot = resolve(repositoryRoot, internalContentPath("documentationSupervision"));

export function parseDocumentationSupervisionProofArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--mode" || argv[1] !== "pilot") {
    throw new Error("Usage: documentation-supervision-proof.mjs --mode pilot");
  }
  return Object.freeze({ mode: "pilot" });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactObject(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

export function verifyDocumentationSupervisionCorpus(input) {
  const manifest = JSON.parse(input.manifest.toString("utf8"));
  if (
    !exactObject(manifest, ["recipe_version", "kind", "identity_limit", "raw_sha256"]) ||
    manifest.recipe_version !== "docsfab-markdown-pilot-v1" ||
    manifest.kind !== "documentation-supervision-fixture-manifest-v1" ||
    !exactObject(manifest.raw_sha256, ["recipe.json", "model-inputs.json", "oracles.json"])
  ) {
    throw new Error("The documentation supervision corpus manifest has an invalid shape.");
  }
  for (const [name, bytes] of [
    ["recipe.json", input.recipe],
    ["model-inputs.json", input.modelInputs],
  ]) {
    if (!SHA256.test(manifest.raw_sha256[name]) || sha256(bytes) !== manifest.raw_sha256[name]) {
      throw new Error(`The documentation supervision corpus pin does not match ${name}.`);
    }
  }
  if (!SHA256.test(manifest.raw_sha256["oracles.json"])) {
    throw new Error("The documentation supervision corpus oracle pin is invalid.");
  }
  const modelInputs = JSON.parse(input.modelInputs.toString("utf8"));
  if (
    modelInputs.input_version !== "reader-context-input-v1" ||
    typeof modelInputs.request !== "string" ||
    !modelInputs.examples ||
    typeof modelInputs.examples !== "object"
  ) {
    throw new Error("The documentation supervision model input has an invalid shape.");
  }
  return Object.freeze({
    recipeVersion: manifest.recipe_version,
    manifestSha256: sha256(input.manifest),
    recipeSha256: manifest.raw_sha256["recipe.json"],
    modelInputsSha256: manifest.raw_sha256["model-inputs.json"],
    oracleSha256: manifest.raw_sha256["oracles.json"],
    request: modelInputs.request,
    examples: modelInputs.examples,
  });
}

export function verifyDocumentationSupervisionOracles(corpus, bytes) {
  if (sha256(bytes) !== corpus.oracleSha256) {
    throw new Error("The documentation supervision corpus pin does not match oracles.json.");
  }
  const oracles = JSON.parse(bytes.toString("utf8"));
  if (
    oracles.oracle_version !== "documentation-supervision-oracles-v1" ||
    !oracles.cases ||
    typeof oracles.cases !== "object"
  ) {
    throw new Error("The documentation supervision oracle has an invalid shape.");
  }
  return oracles;
}

function sourceHintsFor(fixture) {
  const hints = Object.entries(SOURCE_PATHS).flatMap(([role, paths]) =>
    paths.map((path) => ({ role, path })),
  );
  for (const path of fixture.changed_source_paths ?? [])
    hints.push({ role: "changed-source", path });
  return hints;
}

export function projectDocumentationSupervisionModelInput(input) {
  const example = input.corpus.examples[input.exampleId];
  if (
    !example ||
    !exactObject(example, ["reader_context_input", "source_roles"]) ||
    !exactObject(example.reader_context_input, [
      "schema_version",
      "target_audience",
      "reader_job",
      "change_scope",
      "source_priority",
      "required_content",
      "excluded_content",
      "unresolved_questions",
    ])
  ) {
    throw new Error("The selected documentation supervision model input is invalid.");
  }
  const comparison = input.fixture.source_revision.base
    ? {
        kind: "base-head",
        baseRevision: input.fixture.source_revision.base,
        headRevision: input.fixture.source_revision.head,
      }
    : undefined;
  const projection = {
    request: input.corpus.request,
    readerContext: example.reader_context_input,
    readerSources: sourceHintsFor(input.fixture),
    ...(comparison ? { readerComparison: comparison } : {}),
  };
  const encoded = canonicalJson(projection);
  if (/expected|oracle|impact_basis|completed_reader_context/iu.test(encoded)) {
    throw new Error("Evaluator-only supervision data reached the model input projection.");
  }
  return Object.freeze({ projection: Object.freeze(projection), sha256: sha256(encoded) });
}

export function buildDocumentationSupervisionPrompt({ surface, projection }) {
  const action =
    surface === "direct-skill"
      ? "Use the installed plan-documentation skill for a read-only assessment. Do not edit files or run a workflow."
      : `Run the installed update-documentation workflow for this request. Pass its instruction argument exactly as ${JSON.stringify(projection.request)} without paraphrasing. Keep any authorized mutation inside its disposable workflow export.`;
  return [
    action,
    ...(surface === "direct-skill" ? [`User request: ${projection.request}`] : []),
    "Reader context input:",
    JSON.stringify(projection.readerContext),
    "Repository source nominations:",
    JSON.stringify(projection.readerSources),
    projection.readerComparison
      ? `Exact comparison request: ${JSON.stringify(projection.readerComparison)}`
      : "Comparison request: unavailable. Do not infer a comparison from HEAD or the current snapshot.",
  ].join(" ");
}

export function projectDocumentationSupervisionObservationInput({
  surface,
  projection,
  repositoryPath,
}) {
  return {
    repositoryPath,
    revision: "HEAD",
    observationMode: surface === "workflow" ? "workflow-export" : "selected-checkout",
    readerContextInput: projection.readerContext,
    sourceHints: projection.readerSources,
    ...(surface === "workflow" ? { requestText: projection.request } : {}),
    ...(projection.readerComparison ? { comparisonRequest: projection.readerComparison } : {}),
  };
}

export function inspectDocumentationSupervisionSession(input) {
  const messages = input.entries
    .filter((entry) => entry?.type === "message")
    .map((entry) => entry.message);
  const calls = messages.flatMap((message) =>
    message?.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "toolCall")
      : [],
  );
  const results = messages.filter((message) => message?.role === "toolResult");
  const finalText =
    messages
      .filter((message) => message?.role === "assistant")
      .at(-1)
      ?.content?.filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const userPrompts = messages
    .filter((message) => message?.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((part) => part?.type === "text")
            .map((part) => part.text)
            .join(""),
    );
  if (Buffer.byteLength(finalText) > 16_384) {
    throw new Error("The final supervision assessment exceeds the retained evidence limit.");
  }
  const usage = messages
    .filter((message) => message?.role === "assistant" && message.usage)
    .reduce(
      (total, message) => {
        for (const [source, target] of [
          ["input", "inputTokens"],
          ["output", "outputTokens"],
          ["cacheRead", "cacheReadTokens"],
          ["cacheWrite", "cacheWriteTokens"],
        ]) {
          const value = message.usage[source];
          if (Number.isFinite(value) && value >= 0) total[target] += value;
        }
        return total;
      },
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
  const mutatingCalls = calls.filter((call) =>
    ["write", "edit", "bash", "apply_patch"].includes(call.name),
  );
  const skills = results
    .filter((result) => !result.isError && result.details?.kind === "docsfab-live-skill")
    .map((result) => ({
      skill: result.details.skill,
      contentSha256: result.details.contentSha256,
      handoffSha256: result.details.readerTaskContextHandoffSha256 ?? null,
      noChangeAssessment: result.details.noChangeAssessment ?? null,
      resultSha256: sha256(canonicalJson(result.details)),
    }));
  const workflows = results
    .filter((result) => result.details?.kind === "docsfab-live-workflow-result")
    .map((result) => result.details);
  const readerInteractions = calls.flatMap((call) => {
    const parameters = call.arguments;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return [];
    const relevant =
      call.name === "docsfab_run_workflow" ||
      (call.name === "docsfab_use_skill" &&
        parameters.skill === "plan-documentation" &&
        parameters.reference === undefined);
    if (!relevant) return [];
    const result = results.find((candidate) => candidate.toolCallId === call.id);
    const details = result?.details;
    return [
      {
        tool: call.name,
        input: normalizeReaderToolInput(call.name, parameters),
        handoffSha256: SHA256.test(details?.readerTaskContextHandoffSha256 ?? "")
          ? details.readerTaskContextHandoffSha256
          : null,
        resultKind: typeof details?.kind === "string" ? details.kind : null,
        resultSha256:
          result && !result.isError && details && typeof details === "object"
            ? sha256(canonicalJson(details))
            : null,
      },
    ];
  });
  return Object.freeze({
    calls: calls.map((call) => call.name),
    mutatingCalls: mutatingCalls.map((call) => call.name),
    skills,
    workflows,
    readerInteractions,
    finalAssessment: finalText,
    finalTextSha256: sha256(finalText),
    finalMentionsUnavailableComparison:
      /comparison/iu.test(finalText) &&
      /unavailable|unknown|missing|insufficient/iu.test(finalText),
    providerFailures: messages.filter(
      (message) =>
        message?.role === "assistant" && ["error", "aborted"].includes(message.stopReason),
    ).length,
    usage,
    promptMatched:
      input.expectedPrompt === undefined ? null : userPrompts.includes(input.expectedPrompt),
  });
}

function normalizeReaderToolInput(tool, parameters) {
  const readerSources = Array.isArray(parameters.readerSources)
    ? parameters.readerSources
        .map((entry) => ({ role: entry?.role, path: entry?.path }))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    : null;
  return {
    ...(tool === "docsfab_use_skill"
      ? { skill: parameters.skill ?? null }
      : {
          workflow: parameters.workflow ?? null,
          instruction: parameters.instruction ?? null,
        }),
    readerContext: parameters.readerContext ?? null,
    readerSources,
    readerComparison: parameters.readerComparison ?? null,
  };
}

export function verifyDocumentationSupervisionReaderBinding(input) {
  const expectedInput = normalizeReaderToolInput(
    input.surface === "workflow" ? "docsfab_run_workflow" : "docsfab_use_skill",
    input.surface === "workflow"
      ? {
          workflow: "update-documentation",
          instruction: input.projection.request,
          readerContext: input.projection.readerContext,
          readerSources: input.projection.readerSources,
          readerComparison: input.projection.readerComparison,
        }
      : {
          skill: "plan-documentation",
          readerContext: input.projection.readerContext,
          readerSources: input.projection.readerSources,
          readerComparison: input.projection.readerComparison,
        },
  );
  const interaction =
    input.observed.readerInteractions.length === 1
      ? input.observed.readerInteractions[0]
      : undefined;
  const expectedKind =
    input.surface === "workflow" ? "docsfab-live-workflow-result" : "docsfab-live-skill";
  const mismatchedInputFields = interaction
    ? Object.keys(expectedInput).filter(
        (field) => canonicalJson(interaction.input[field]) !== canonicalJson(expectedInput[field]),
      )
    : Object.keys(expectedInput);
  const verified = Boolean(
    interaction &&
      mismatchedInputFields.length === 0 &&
      interaction.handoffSha256 === input.expectedHandoff.handoffSha256 &&
      interaction.resultKind === expectedKind &&
      SHA256.test(interaction.resultSha256 ?? ""),
  );
  return Object.freeze({
    verified,
    expectedInputSha256: sha256(canonicalJson(expectedInput)),
    actualInputSha256: interaction ? sha256(canonicalJson(interaction.input)) : null,
    mismatchedInputFields,
    expectedHandoff: input.expectedHandoff,
    actualHandoffSha256: interaction?.handoffSha256 ?? null,
    selectedResultSha256: verified ? interaction.resultSha256 : null,
  });
}

export function evaluateDocumentationSupervisionCandidate(input) {
  if (input.fixturePin !== input.fixture.fixture_manifest.sha256) {
    throw new Error("The trusted fixture manifest pin changed before candidate evaluation.");
  }
  const oracle = input.oracles.cases?.[input.caseId];
  if (!oracle) throw new Error("The selected documentation supervision oracle is unavailable.");
  const expected = {
    "update-candidate": "executed-update",
    "no-change-candidate": "verified-no-change",
    "insufficient-evidence": "insufficient-evidence",
  }[oracle.expected_decision];
  if (!expected || input.candidate.outcome !== expected) {
    return Object.freeze({ status: "FAIL", expected, actual: input.candidate.outcome });
  }
  if (expected === "executed-update" && !input.candidate.patchVerified) {
    return Object.freeze({ status: "FAIL", expected, actual: "patch-unverified" });
  }
  if (
    expected === "verified-no-change" &&
    input.candidate.rationaleWordCount < (oracle.minimum_rationale_words ?? 0)
  ) {
    return Object.freeze({ status: "FAIL", expected, actual: "rationale-too-short" });
  }
  if (
    expected === "insufficient-evidence" &&
    !(oracle.required_limitation_terms ?? []).every((term) =>
      input.candidate.limitations.some((limitation) => limitation.toLowerCase().includes(term)),
    )
  ) {
    return Object.freeze({ status: "FAIL", expected, actual: "limitation-unverified" });
  }
  return Object.freeze({ status: "PASS", expected, actual: input.candidate.outcome });
}

async function loadCorpusBytes() {
  const names = ["manifest.json", "recipe.json", "model-inputs.json"];
  const [manifest, recipe, modelInputs] = await Promise.all(
    names.map((name) => readFile(join(corpusRoot, name))),
  );
  return { manifest, recipe, modelInputs };
}

async function materializeFixture(caseId, target) {
  const program = [
    "import importlib.util,json,pathlib,sys",
    "module_path=pathlib.Path(sys.argv[1])",
    "spec=importlib.util.spec_from_file_location('docsfab_supervision_materialize',module_path)",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps(module.materialize(sys.argv[2],pathlib.Path(sys.argv[3])),sort_keys=True))",
  ].join(";");
  const result = await execute(
    "python3",
    ["-c", program, join(corpusRoot, "materialize.py"), caseId, target],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 60_000 },
  );
  return JSON.parse(result.stdout);
}

async function gitOutput(repository, args) {
  return (await execute("git", args, { cwd: repository, timeout: 20_000 })).stdout.trim();
}

export async function configureDocumentationSupervisionFixtureRemote(repository) {
  if ((await gitOutput(repository, ["remote"])) !== "") {
    throw new Error("The supervision fixture must not inherit a Git remote.");
  }
  await gitOutput(repository, ["remote", "add", "origin", SYNTHETIC_GITLAB_REMOTE]);
  await gitOutput(repository, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  return Object.freeze({ remote: SYNTHETIC_GITLAB_REMOTE, defaultBranch: "main" });
}

async function readOwnSession(directory, sessionId, repository) {
  for (const filename of await readdir(directory).catch(() => [])) {
    if (!filename.endsWith(`_${sessionId}.jsonl`)) continue;
    const lines = (await readFile(join(directory, filename), "utf8")).trim().split("\n");
    const header = JSON.parse(lines[0]);
    if (header.id !== sessionId || header.cwd !== repository) continue;
    return {
      path: join(directory, filename),
      entries: lines
        .slice(1)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  }
  throw new Error("The proof could not find its exact live-agent session record.");
}

const INDEPENDENT_EDITORIAL_STEPS = Object.freeze([
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
]);

export async function readWorkflowEvidence(stateDirectory, workflow) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workflow.runId ?? "")) {
    throw new Error("The supervision workflow result has an invalid run identity.");
  }
  const bytes = await readFile(join(stateDirectory, `${workflow.runId}.json`));
  if (bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("The supervision workflow record exceeds the evaluator evidence limit.");
  }
  const record = JSON.parse(bytes.toString("utf8"));
  if (record.id !== workflow.runId || record.workflow !== "update-documentation") {
    throw new Error("The supervision workflow record does not match its live result.");
  }
  const plannerSummary =
    record.steps?.find((step) => step.id === "plan-documentation")?.summary ?? "";
  if (typeof plannerSummary !== "string" || Buffer.byteLength(plannerSummary) > 16_384) {
    throw new Error("The supervision planner summary exceeds the retained evidence limit.");
  }
  const independentChecks = INDEPENDENT_EDITORIAL_STEPS.flatMap((stepId) => {
    const step = record.steps?.find((candidate) => candidate.id === stepId);
    if (!step) return [];
    const summary = step.summary ?? "";
    if (typeof summary !== "string" || Buffer.byteLength(summary) > 16_384) {
      throw new Error(
        "A supervision independent-check summary exceeds the retained evidence limit.",
      );
    }
    const evidence = (step.artifacts ?? []).flatMap((use) => {
      const reference = use?.reference;
      if (
        !reference ||
        typeof reference.kind !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(reference.kind) ||
        !Number.isSafeInteger(reference.schemaVersion) ||
        !SHA256.test(reference.digest ?? "")
      ) {
        return [];
      }
      return [
        {
          kind: reference.kind,
          schemaVersion: reference.schemaVersion,
          digest: reference.digest,
        },
      ];
    });
    return [{ id: stepId, status: step.status, summary, evidence }];
  });
  if (
    independentChecks.reduce((total, check) => total + Buffer.byteLength(check.summary), 0) >
    64 * 1024
  ) {
    throw new Error("The supervision independent-check evidence exceeds the retained limit.");
  }
  const finalRationale =
    independentChecks.find((check) => check.id === "evaluate-document-quality")?.summary ??
    plannerSummary;
  const usage = record.usage ?? {};
  return {
    recordSha256: sha256(bytes),
    plannerSummary,
    rationaleWordCount: finalRationale.trim().split(/\s+/u).filter(Boolean).length,
    independentChecks,
    usage: Object.fromEntries(
      ["input", "output", "cacheRead", "cacheWrite", "total", "turns"].map((key) => [
        key,
        Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0,
      ]),
    ),
    steps: (record.steps ?? []).map((step) => ({ id: step.id, status: step.status })),
  };
}

export async function readUnboundWorkflowDiagnostic({
  stateDirectory,
  workflows,
  readerBinding,
  assertCredentialFree,
}) {
  if (readerBinding.verified || workflows.length !== 1) return null;
  const workflow = workflows[0];
  const evidence = await readWorkflowEvidence(stateDirectory, workflow);
  const reportedPatch = workflow.changes?.patch;
  let patch = null;
  if (reportedPatch !== undefined) {
    if (
      typeof reportedPatch.artifactPath !== "string" ||
      !SHA256.test(reportedPatch.sha256 ?? "")
    ) {
      throw new Error("The unbound supervision workflow patch identity is invalid.");
    }
    const [stateRoot, artifactPath] = await Promise.all([
      realpath(stateDirectory),
      realpath(reportedPatch.artifactPath),
    ]);
    const relativeArtifact = relative(stateRoot, artifactPath);
    if (
      relativeArtifact === ".." ||
      relativeArtifact.startsWith(`..${sep}`) ||
      isAbsolute(relativeArtifact)
    ) {
      throw new Error("The unbound supervision workflow patch escaped private state.");
    }
    const metadata = await stat(artifactPath);
    if (!metadata.isFile() || metadata.size > 65_536) {
      throw new Error("The unbound supervision workflow patch exceeds the diagnostic limit.");
    }
    const bytes = await readFile(artifactPath);
    if (bytes.byteLength !== metadata.size || sha256(bytes) !== reportedPatch.sha256) {
      throw new Error("The unbound supervision workflow patch digest is invalid.");
    }
    const content = bytes.toString("utf8");
    assertCredentialFree({ patch: content });
    patch = { patchSha256: reportedPatch.sha256, content };
  }
  return Object.freeze({
    bindingVerified: false,
    evaluation: "not-performed",
    workflow: {
      runId: workflow.runId,
      status: workflow.status,
      workflowStatus: workflow.workflowStatus,
    },
    evidence,
    patch,
  });
}

export function projectDocumentationSupervisionFailure(error) {
  if (error?.killed === true) return Object.freeze({ kind: "timeout" });
  const code = error?.code;
  if (
    (Number.isSafeInteger(code) && code >= 0 && code <= 255) ||
    (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code))
  ) {
    return Object.freeze({ kind: "process-exit", code });
  }
  const name = ["Error", "TypeError", "RangeError", "SyntaxError"].includes(error?.name)
    ? error.name
    : "Error";
  return Object.freeze({ kind: "error", name });
}

async function runConversation({
  executable,
  driver,
  repository,
  prompt,
  environment,
  allowWrite,
}) {
  let stdout = "";
  let terminalFailure = null;
  try {
    stdout = (
      await execute(
        "expect",
        ["-f", driver, executable, repository, prompt, allowWrite ? "1" : "0"],
        {
          cwd: repository,
          env: environment,
          timeout: 900_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      )
    ).stdout;
  } catch (error) {
    stdout = error.stdout ?? "";
    terminalFailure = error.killed ? "timeout" : `terminal-exit-${error.code ?? "unknown"}`;
  }
  const sessionId = /^SESSION ([a-f0-9-]+)$/mu.exec(stdout)?.[1];
  if (!sessionId) throw new Error("The installed live-agent did not expose a bounded session id.");
  return { sessionId, terminalFailure };
}

export function documentationSupervisionFixtureEnvironment(environment = process.env) {
  const allowed = {};
  for (const name of ["PATH", "SYSTEMROOT"]) {
    if (typeof environment[name] === "string") allowed[name] = environment[name];
  }
  return Object.freeze({
    ...allowed,
    LANG: "C",
    LC_ALL: "C",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHASHSEED: "0",
  });
}

async function runFrozenFixtureChecks(repository) {
  const environment = documentationSupervisionFixtureEnvironment();
  const test = await execute("python3", ["-m", "unittest", "discover", "-s", "tests"], {
    cwd: repository,
    env: environment,
    timeout: 30_000,
  });
  const help = await execute("python3", ["-m", "src.orbit", "--help"], {
    cwd: repository,
    env: environment,
    timeout: 10_000,
  });
  const success = await execute("python3", ["-m", "src.orbit", "--workspace", "."], {
    cwd: repository,
    env: environment,
    timeout: 10_000,
  });
  let missingExit = 0;
  try {
    await execute("python3", ["-m", "src.orbit"], {
      cwd: repository,
      env: environment,
      timeout: 10_000,
    });
  } catch (error) {
    missingExit = Number(error.code);
  }
  return {
    testsPassed: test.stderr.includes("OK"),
    helpHasWorkspace: help.stdout.includes("--workspace"),
    commandOutputSha256: sha256(success.stdout),
    commandOutputMatches: success.stdout === ".\n",
    missingPathExit: missingExit,
  };
}

function inspectAppliedPatch(rawDiff, expectedPath) {
  const entries = rawDiff.split("\n").filter(Boolean);
  const match =
    entries.length === 1
      ? /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])\t(.+)$/u.exec(entries[0])
      : null;
  const changedPaths = entries.flatMap((entry) => {
    const separator = entry.indexOf("\t");
    return separator === -1 ? [] : [entry.slice(separator + 1)];
  });
  return {
    admitted:
      match !== null && match[1] === match[2] && match[3] === "M" && match[4] === expectedPath,
    changedPaths,
  };
}

export async function evaluateDocumentationSupervisionWorkflowPatch({
  workflow,
  oracle,
  evaluatorRoot,
  caseId,
  selectedRepository,
}) {
  if (oracle.expected_decision !== "update-candidate") {
    return {
      verified: workflow.changes?.patch === undefined,
      receipt: {
        expectedPatch: false,
        patchPresent: workflow.changes?.patch !== undefined,
      },
    };
  }
  const artifactPath = workflow.changes?.patch?.artifactPath;
  if (typeof artifactPath !== "string") {
    return { verified: false, receipt: { expectedPatch: true, patchPresent: false } };
  }
  const patch = await readFile(artifactPath, "utf8");
  if (Buffer.byteLength(patch) > 65_536) {
    throw new Error("The supervision proof patch exceeds the retained evidence limit.");
  }
  const repository = join(evaluatorRoot, `${caseId}-evaluator`);
  await materializeFixture(caseId, repository);
  await execute("git", ["apply", "--check", artifactPath], { cwd: repository, timeout: 20_000 });
  await execute("git", ["apply", artifactPath], { cwd: repository, timeout: 20_000 });
  const appliedPatch = inspectAppliedPatch(
    await gitOutput(repository, ["diff", "--raw", "--no-abbrev", "--no-renames"]),
    oracle.patch.path,
  );
  const { changedPaths } = appliedPatch;
  if (!appliedPatch.admitted) {
    return {
      verified: false,
      receipt: {
        expectedPatch: true,
        patchPresent: true,
        patchSha256: sha256(patch),
        changedPaths,
        patchShapeVerified: false,
      },
    };
  }
  const document = await readFile(join(repository, oracle.patch.path), "utf8");
  const requiredFragmentsPresent = oracle.patch.required_fragments.every((fragment) =>
    document.includes(fragment),
  );
  const checks = await runFrozenFixtureChecks(repository);
  const selectedChangedPaths = (await gitOutput(selectedRepository, ["diff", "--name-only"]))
    .split("\n")
    .filter(Boolean);
  const selectedDocument = await readFile(join(selectedRepository, oracle.patch.path), "utf8");
  let reversePatchApplies = true;
  try {
    await execute("git", ["apply", "--reverse", "--check", artifactPath], {
      cwd: selectedRepository,
      timeout: 20_000,
    });
  } catch {
    reversePatchApplies = false;
  }
  const selectedCheckoutVerified =
    workflow.persistence?.status === "applied" &&
    reversePatchApplies &&
    canonicalJson(selectedChangedPaths) === canonicalJson(changedPaths) &&
    sha256(selectedDocument) === sha256(document);
  const verified =
    changedPaths.length === 1 &&
    changedPaths[0] === oracle.patch.path &&
    requiredFragmentsPresent &&
    checks.testsPassed &&
    checks.helpHasWorkspace &&
    checks.commandOutputMatches &&
    checks.missingPathExit === 2 &&
    selectedCheckoutVerified;
  return {
    verified,
    receipt: {
      expectedPatch: true,
      patchPresent: true,
      patchSha256: sha256(patch),
      patch,
      changedPaths,
      patchShapeVerified: true,
      resultingDocumentSha256: sha256(document),
      requiredFragmentsPresent,
      checks,
      selectedCheckoutVerified,
      selectedChangedPaths,
      selectedResultingDocumentSha256: sha256(selectedDocument),
      reversePatchApplies,
      persistenceStatus: workflow.persistence?.status ?? "unavailable",
    },
  };
}

export function evaluateDocumentationSupervisionStructuralValidity({
  surface,
  expectedDecision,
  conversation,
  observed,
  readerBinding,
  unchanged,
  selectedCheckoutVerified,
}) {
  return (
    !conversation.terminalFailure &&
    observed.providerFailures === 0 &&
    observed.promptMatched &&
    observed.mutatingCalls.length === 0 &&
    readerBinding.verified &&
    (surface !== "workflow" || expectedDecision !== "update-candidate"
      ? unchanged
      : selectedCheckoutVerified === true)
  );
}

async function runPilot() {
  let failed = false;
  let pendingReview = false;
  let phase = "prerequisites";
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-supervision-proof-")));
  const evidenceRoot = await realpath(
    await mkdtemp(join(tmpdir(), "docsfab-supervision-evidence-")),
  );
  const sessionFiles = [];
  const evidencePath = join(evidenceRoot, "documentation-supervision-proof.jsonl");
  let retain;
  let campaignSha256;
  try {
    await Promise.all([
      execute("expect", ["-v"], { timeout: 10_000 }),
      execute("python3", ["--version"], { timeout: 10_000 }),
    ]);
    phase = "corpus";
    const bytes = await loadCorpusBytes();
    const corpus = verifyDocumentationSupervisionCorpus(bytes);
    const fixtureByArm = new Map();
    for (const [index, item] of DOCUMENTATION_SUPERVISION_PROOF_CASES.entries()) {
      const repository = join(root, `case-${index + 1}`);
      const fixture = await materializeFixture(item.id, repository);
      await configureDocumentationSupervisionFixtureRemote(repository);
      fixtureByArm.set(`${item.surface}:${item.id}`, {
        fixture,
        repository,
        pin: fixture.fixture_manifest.sha256,
      });
    }
    phase = "packaging";
    const packRoot = join(root, "pack");
    const installRoot = join(root, "install");
    await mkdir(packRoot);
    const { record, tarball } = await packDocsFab({
      projectRoot,
      packDestination: packRoot,
      env: process.env,
    });
    const installed = await installPackedDocsFab({
      tarball,
      installRoot,
      cwd: root,
      env: process.env,
    });
    const imported = (path) =>
      import(pathToFileURL(join(installed.installedPackageRoot, "dist", path)).href);
    phase = "configuration";
    const { loadDocsFabEnvironment, resolveDocsFabLiveAgentSessionDirectory } =
      await imported("config/host-paths.js");
    const { loadConfig } = await imported("config/runtime-loader.js");
    const { loadLiveAgentCapabilities } = await imported("live-agent/capabilities.js");
    const { observeReaderTaskContextAdmissionV1 } = await imported(
      "execution/reader-task-admission.js",
    );
    const { assertModelResponseCredentialFree } = await imported(
      "security/credential-isolation.js",
    );
    const retainedRecords = [];
    retain = async (record) => {
      const retainedRecord = campaignSha256 ? { ...record, campaignSha256 } : record;
      assertModelResponseCredentialFree(retainedRecord);
      retainedRecords.push(retainedRecord);
      await writeFile(
        evidencePath,
        `${retainedRecords.map((value) => JSON.stringify(value)).join("\n")}\n`,
        { mode: 0o600 },
      );
      console.log(JSON.stringify(retainedRecord));
    };
    const proofEnvironment = { ...process.env };
    loadDocsFabEnvironment(proofEnvironment);
    const config = loadConfig(proofEnvironment);
    const capabilities = await loadLiveAgentCapabilities(config);
    const readerTaskContextSupplier = capabilities.readerTaskContextSupplier;
    if (!readerTaskContextSupplier) {
      throw new Error("The supervision proof requires the installed reader context supplier.");
    }
    if (
      config.skillCrateDirectory !== join(installed.installedPackageRoot, "skill-crate") ||
      config.qualityDirectory !== join(installed.installedPackageRoot, "quality") ||
      config.qualityPackDirectory !== join(installed.installedPackageRoot, "quality-pack")
    ) {
      throw new Error("The supervision proof requires assets from its installed package.");
    }
    const configRoot = join(root, "config");
    await mkdir(configRoot);
    proofEnvironment.DOCSFAB_CONFIG_ROOT = configRoot;
    proofEnvironment.DOCSFAB_STATE_DIR = join(root, "state");
    proofEnvironment.NO_COLOR = "1";
    const sessionDirectory = resolveDocsFabLiveAgentSessionDirectory(proofEnvironment);
    const driver = join(root, "conversation.exp");
    await writeFile(
      driver,
      await readFile(
        join(projectRoot, "test/fixtures/documentation-supervision/conversation.exp"),
        "utf8",
      ),
      { mode: 0o600 },
    );
    const sourceRevision = await gitOutput(repositoryRoot, ["rev-parse", "HEAD"]);
    const packageSha256 = sha256(await readFile(tarball));
    campaignSha256 = sha256(
      canonicalJson({
        evidencePath,
        sourceRevision,
        packageSha256,
        model: config.model.modelId,
        recipeVersion: corpus.recipeVersion,
        corpusManifestSha256: corpus.manifestSha256,
      }),
    );
    await retain({
      kind: "docsfab-documentation-supervision-proof-start",
      mode: "pilot",
      evidencePath,
      sourceRevision,
      package: { filename: record.filename, sha256: packageSha256 },
      model: config.model.modelId,
      policy: {
        recipeVersion: corpus.recipeVersion,
        corpusManifestSha256: corpus.manifestSha256,
        recipeSha256: corpus.recipeSha256,
        modelInputsSha256: corpus.modelInputsSha256,
        oracleSha256: corpus.oracleSha256,
      },
    });
    for (const item of DOCUMENTATION_SUPERVISION_PROOF_CASES) {
      phase = `${item.surface}:${item.id}`;
      const materialized = fixtureByArm.get(`${item.surface}:${item.id}`);
      const modelInput = projectDocumentationSupervisionModelInput({
        corpus,
        exampleId: item.input,
        fixture: materialized.fixture,
      });
      const prompt = buildDocumentationSupervisionPrompt({
        surface: item.surface,
        projection: modelInput.projection,
      });
      const beforeHead = await gitOutput(materialized.repository, ["rev-parse", "HEAD"]);
      const expectedObservation = await observeReaderTaskContextAdmissionV1(
        projectDocumentationSupervisionObservationInput({
          surface: item.surface,
          projection: modelInput.projection,
          repositoryPath: materialized.repository,
        }),
      );
      const expectedHandoff = readerTaskContextSupplier.createHandoff({
        readerContextInput: modelInput.projection.readerContext,
        inputOrigin: "explicit",
        admission: expectedObservation.admission,
        ...(expectedObservation.sourceBinding
          ? { sourceBinding: expectedObservation.sourceBinding }
          : {}),
      });
      const conversation = await runConversation({
        executable: installed.executable,
        driver,
        repository: materialized.repository,
        prompt,
        environment: proofEnvironment,
        allowWrite: item.surface === "workflow",
      });
      const session = await readOwnSession(
        sessionDirectory,
        conversation.sessionId,
        materialized.repository,
      );
      sessionFiles.push(session.path);
      const observed = inspectDocumentationSupervisionSession({
        ...session,
        expectedPrompt: prompt,
      });
      const readerBinding = verifyDocumentationSupervisionReaderBinding({
        surface: item.surface,
        projection: modelInput.projection,
        observed,
        expectedHandoff,
      });
      const unboundWorkflowDiagnostic =
        item.surface === "workflow"
          ? await readUnboundWorkflowDiagnostic({
              stateDirectory: proofEnvironment.DOCSFAB_STATE_DIR,
              workflows: observed.workflows,
              readerBinding,
              assertCredentialFree: assertModelResponseCredentialFree,
            })
          : null;
      const unchanged =
        beforeHead === (await gitOutput(materialized.repository, ["rev-parse", "HEAD"])) &&
        (await gitOutput(materialized.repository, ["status", "--porcelain"])) === "";
      // Evaluator-only bytes are first opened after this case's model candidate returns.
      const oracles = verifyDocumentationSupervisionOracles(
        corpus,
        await readFile(join(corpusRoot, "oracles.json")),
      );
      let evaluation;
      let candidate;
      let patchReceipt;
      let workflowEvidence;
      if (item.surface === "workflow") {
        const workflow = observed.workflows.find(
          (result) =>
            result.workflow === "update-documentation" &&
            sha256(canonicalJson(result)) === readerBinding.selectedResultSha256,
        );
        const oracle = oracles.cases[item.id];
        workflowEvidence = workflow
          ? await readWorkflowEvidence(proofEnvironment.DOCSFAB_STATE_DIR, workflow)
          : undefined;
        const patchEvaluation = workflow
          ? await evaluateDocumentationSupervisionWorkflowPatch({
              workflow,
              oracle,
              evaluatorRoot: root,
              caseId: item.id,
              selectedRepository: materialized.repository,
            })
          : { verified: false, receipt: { workflowResult: "missing" } };
        patchReceipt = patchEvaluation.receipt;
        candidate = {
          outcome: workflow?.editorial?.outcome ?? "unavailable",
          limitations: workflow?.editorial?.limitations ?? [],
          patchVerified: patchEvaluation.verified,
          rationaleWordCount: workflowEvidence?.rationaleWordCount ?? 0,
        };
        evaluation = evaluateDocumentationSupervisionCandidate({
          caseId: item.id,
          fixture: materialized.fixture,
          fixturePin: materialized.pin,
          candidate,
          oracles,
        });
      } else {
        const use = observed.skills.find(
          (skill) =>
            skill.skill === "plan-documentation" &&
            skill.resultSha256 === readerBinding.selectedResultSha256,
        );
        const expectedReview = {
          "update-candidate": "update-recommendation",
          "no-change-candidate": "no-change-recommendation",
          "insufficient-evidence": "insufficient-evidence",
        }[oracles.cases[item.id].expected_decision];
        candidate = { outcome: "independent-semantic-review-required" };
        evaluation = {
          status: "PENDING_SEMANTIC_REVIEW",
          expected: expectedReview,
          actual: "unreviewed-authored-assessment",
        };
        pendingReview = true;
        if (
          !use ||
          !SHA256.test(use.handoffSha256 ?? "") ||
          observed.mutatingCalls.length > 0 ||
          observed.workflows.length > 0
        ) {
          evaluation = { status: "FAIL", expected: "read-only-plan-skill", actual: "unverified" };
        }
      }
      const structurallyValid = evaluateDocumentationSupervisionStructuralValidity({
        surface: item.surface,
        expectedDecision: oracles.cases[item.id].expected_decision,
        conversation,
        observed,
        readerBinding,
        unchanged,
        selectedCheckoutVerified: patchReceipt?.selectedCheckoutVerified,
      });
      const status = !structurallyValid
        ? "FAIL"
        : evaluation.status === "PASS"
          ? "PASS"
          : evaluation.status === "PENDING_SEMANTIC_REVIEW"
            ? "PENDING_SEMANTIC_REVIEW"
            : "FAIL";
      failed ||= status === "FAIL";
      await retain({
        kind: "docsfab-documentation-supervision-case-result",
        case: item.id,
        surface: item.surface,
        status,
        fixtureManifestSha256: materialized.pin,
        sourceRevision: materialized.fixture.source_revision,
        modelInputSha256: modelInput.sha256,
        readerBinding,
        terminalFailure: conversation.terminalFailure,
        calls: observed.calls,
        skillUses: observed.skills,
        workflow: observed.workflows.map((result) => ({
          status: result.status,
          workflowStatus: result.workflowStatus,
          editorial: result.editorial,
          persistenceStatus: result.persistence?.status ?? "unavailable",
          patchSha256: result.changes?.patch?.sha256 ?? null,
        })),
        patchReceipt: patchReceipt ?? null,
        workflowEvidence: workflowEvidence ?? null,
        unboundWorkflowDiagnostic,
        authoredAssessment: observed.finalAssessment,
        finalTextSha256: observed.finalTextSha256,
        providerFailures: observed.providerFailures,
        usage: observed.usage,
        promptMatched: observed.promptMatched,
        selectedCheckoutUnchanged: unchanged,
        evaluation,
      });
    }
  } catch (error) {
    failed = true;
    const blocked = {
      kind: "docsfab-documentation-supervision-proof-blocked",
      status: "BLOCKED",
      phase,
      diagnostic: projectDocumentationSupervisionFailure(error),
      next:
        phase === "configuration"
          ? "Configure one supported DocsFab model through the normal protected profile loader."
          : phase === "prerequisites"
            ? "Install the local proof prerequisites before running the pilot."
            : "Inspect the named phase locally; blocked or unrun cases do not count as passing.",
    };
    if (retain) await retain(blocked);
    else console.error(JSON.stringify(blocked));
  } finally {
    await Promise.all(sessionFiles.map((path) => rm(path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
  else if (pendingReview) process.exitCode = 2;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  parseDocumentationSupervisionProofArguments(process.argv.slice(2));
  await runPilot();
}
