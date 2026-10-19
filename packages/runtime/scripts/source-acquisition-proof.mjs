#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Collect SourceAcquisitionQualificationV1 evidence. Run with `--help` for usage.
 *
 * Deterministic cells drive each entry point's shipped call sites (argument
 * parser, workspace export, tracked-source gate, source evidence, admission,
 * per-step reader and citer) over a real scratch Git repository, so identities
 * and digests come from real Git state and the shipped citation ledger.
 *
 * Only the workflow model is absent. Each row persists an `entry-point.json`
 * trace naming what ran and what did not, so a deterministic row is never
 * evidence that a model-backed workflow ran.
 *
 * Installed mode requires an explicit operator acknowledgment, an installed
 * CLI outside this checkout, and an absolute `--config-root`. Status and
 * reason codes come from the CLI's `--json` output and run record, never from
 * an exit code. The installed `docsfab live-agent` cell is recorded with a
 * limitation and never invoked, because it refuses a non-interactive terminal.
 *
 * Fixture models cannot qualify live cells. This file grants no host, model,
 * or provider authority.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const REASON = /^[a-z0-9][a-z0-9-]*$/u;
const INSTALLED_ACK = "context-v1-source-acquisition-installed-execution";
const INSTALLED_TIMEOUT_LIMIT = "sourceAcquisitionProof.installedInvocationTimeoutMs";
const INSTALLED_OUTPUT_LIMIT = "sourceAcquisitionProof.installedOutputMaxBytes";

/** The installed live-agent refuses a non-interactive terminal; never piped. */
export const LIVE_AGENT_TERMINAL_LIMITATION = "live-agent-requires-interactive-terminal";
/** Parsed from a `migration-required` operator envelope about the model profile. */
export const INSTALLED_MODEL_UNCONFIGURED = "installed-model-unconfigured";
/** Neither a run result nor an operator-error envelope could be read. */
export const INSTALLED_OUTPUT_UNPARSED = "installed-output-unparsed";
export const DECLARED_RUN_RECORD_KIND = "docsfab-source-acquisition-run-record";

const RUN_INSTRUCTION = "Update documentation from the attached source.";
const RUN_CHANGE_INSTRUCTION = "Update documentation from the attached merged change.";
const DO_REQUEST = "Update the Atlas drain interval documentation from the attached source.";
const LIVE_AGENT_TURN = "Update the Atlas documentation from the attached source.";
const FIXTURE_GITLAB_PROJECT_ID = 437040;
const DIRTY_WORKING_TREE_MARKER = "<p>Working tree only: the Atlas heartbeat is 999 seconds.</p>\n";

/** Stages of the shipped journey a deterministic cell does not execute. */
const DETERMINISTIC_NOT_INVOKED = Object.freeze([
  "local-workflow-assembly",
  "workflow-model",
  "workflow-steps",
  "run-record",
]);

export class SourceAcquisitionProofError extends Error {
  constructor(code, message = code) {
    super(`Source acquisition proof failed (${code}): ${message}.`);
    this.name = "SourceAcquisitionProofError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SourceAcquisitionProofError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function canonicalSha256(value) {
  return sha256(canonicalJson(value));
}

function object(value, code = "invalid-record") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(code);
  }
  return value;
}

function array(value, code = "invalid-record") {
  if (!Array.isArray(value)) fail(code);
  return value;
}

function digest(value, code = "invalid-record") {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function optionalDigest(value) {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function byKey(key) {
  return (left, right) => (left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0);
}

function usage() {
  return `DocsFab source acquisition proof (#802)

Deterministic collection (shipped entry-point call sites over scratch Git
repositories; no workflow model; live cells recorded pending):
  node scripts/source-acquisition-proof.mjs \\
    --manifest ../quality/benchmarks/runtime/evaluation/context-v1-source-acquisition/manifest.json \\
    --results /absolute/docsfab-context-ct5-source-acquisition-results.json

Installed collection (requires operator acknowledgment; grants no credentials):
  node scripts/source-acquisition-proof.mjs \\
    --manifest ../quality/benchmarks/runtime/evaluation/context-v1-source-acquisition/manifest.json \\
    --results /absolute/results.json \\
    --installed-cli /absolute/path/to/docsfab.mjs \\
    --work-root /absolute/private/path \\
    --acknowledge-installed-execution ${INSTALLED_ACK}
`;
}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (
      argument === "--manifest" ||
      argument === "--results" ||
      argument === "--installed-cli" ||
      argument === "--work-root" ||
      argument === "--acknowledge-installed-execution" ||
      argument === "--config-root"
    ) {
      if (values.has(argument)) fail("invalid-arguments", `duplicated ${argument}`);
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        fail("invalid-arguments", `${argument} requires a value`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    fail("invalid-arguments", `unknown option ${argument}`);
  }
  const manifest = values.get("--manifest");
  const results = values.get("--results");
  if (!manifest) fail("invalid-arguments", "--manifest is required");
  if (!results) fail("invalid-arguments", "--results is required");
  if (!isAbsolute(results)) fail("invalid-arguments", "--results must be absolute");
  const installedCli = values.get("--installed-cli") ?? null;
  const workRoot = values.get("--work-root") ?? null;
  const configRoot = values.get("--config-root") ?? null;
  const ack = values.get("--acknowledge-installed-execution") ?? null;
  const liveRequested = Boolean(installedCli || workRoot || ack);
  if (liveRequested) {
    if (ack !== INSTALLED_ACK) {
      fail(
        "installed-execution-not-acknowledged",
        `pass --acknowledge-installed-execution ${INSTALLED_ACK}`,
      );
    }
    if (!installedCli || !isAbsolute(installedCli)) {
      fail("invalid-arguments", "--installed-cli must be absolute");
    }
    if (!workRoot || !isAbsolute(workRoot)) {
      fail("invalid-arguments", "--work-root must be absolute");
    }
    // Without an isolated config root the installed CLI would silently fall
    // back to the operator's real DocsFab configuration.
    if (!configRoot || !isAbsolute(configRoot)) {
      fail(
        "installed-config-root-required",
        "--config-root must be absolute and is required for installed collection",
      );
    }
  }
  return {
    help: false,
    manifest: resolve(manifest),
    results: resolve(results),
    installedCli,
    workRoot,
    configRoot,
    installedExecutionAcknowledgment: ack,
  };
}

let contractPromise;
export async function loadRuntimeContracts() {
  if (!contractPromise) {
    contractPromise = (async () => {
      let unregister = () => undefined;
      try {
        const { register } = await import("tsx/esm/api");
        unregister = register();
        const [
          acquisition,
          gitlabProvider,
          discovery,
          selection,
          sourceCommands,
          host,
          cliSource,
          workspace,
          resolver,
          evidence,
          artifacts,
          policy,
          catalog,
          runArguments,
          doCommand,
          liveAgentCommand,
          firstPass,
          citations,
          limits,
          runResult,
          runs,
        ] = await Promise.all([
          import("../src/inputs/source-acquisition.ts"),
          import("../src/inputs/gitlab-source-provider.ts"),
          import("../src/inputs/source-discovery.ts"),
          import("../src/inputs/merged-mr-selection.ts"),
          import("../src/live-agent/source-commands.ts"),
          import("../src/live-agent/host.ts"),
          import("../src/cli/run/source-acquisition.ts"),
          import("../src/repository/workspace/materialize.ts"),
          import("../src/inputs/source-resolver.ts"),
          import("../src/inputs/source-evidence.ts"),
          import("../src/inputs/source-evidence-artifacts.ts"),
          import("../src/inputs/source-step-policy.ts"),
          import("../src/workflow-registry/catalog.ts"),
          import("../src/cli/run-arguments.ts"),
          import("../src/cli/commands/do.ts"),
          import("../src/cli/commands/live-agent.ts"),
          import("../src/cli/first-pass.ts"),
          import("../src/records/source-citations.ts"),
          import("../src/config/limits.ts"),
          import("../src/operator/run-result.ts"),
          import("../src/cli/commands/runs.ts"),
        ]);
        return {
          SOURCE_ACQUISITION_REFUSAL_CODES: acquisition.SOURCE_ACQUISITION_REFUSAL_CODES,
          gitlabMrReadEndpoint: gitlabProvider.gitlabMrReadEndpoint,
          GITLAB_READ_PAGE_SIZE: gitlabProvider.GITLAB_READ_PAGE_SIZE,
          GITLAB_SOURCE_PROVIDER_ID: gitlabProvider.GITLAB_SOURCE_PROVIDER_ID,
          resolveGitLabAcquisitionScope: gitlabProvider.resolveGitLabAcquisitionScope,
          discoverSourceDescriptors: discovery.discoverSourceDescriptors,
          resolveMergedMrDateWindow: selection.resolveMergedMrDateWindow,
          createLiveAgentSourceSelection: sourceCommands.createLiveAgentSourceSelection,
          SOURCE_COMMAND_PREFIX: sourceCommands.SOURCE_COMMAND_PREFIX,
          SourceCommandError: sourceCommands.SourceCommandError,
          createLiveAgentBoundedRunner: host.createLiveAgentBoundedRunner,
          createLiveAgentSourcePorts: host.createLiveAgentSourcePorts,
          liveAgentWorkflowRunRequest: host.liveAgentWorkflowRunRequest,
          resolveCliSourceEvidence: cliSource.resolveCliSourceEvidence,
          resolveCliChangeRequestSourceEvidence: cliSource.resolveCliChangeRequestSourceEvidence,
          assertBoundSourcesTracked: cliSource.assertBoundSourcesTracked,
          createWorkspaceTrackedSourceReader: cliSource.createWorkspaceTrackedSourceReader,
          withRepositoryWorkspace: workspace.withRepositoryWorkspace,
          admitRunSourceBinding: resolver.admitRunSourceBinding,
          projectSourceRequestContext: evidence.projectSourceRequestContext,
          sourceClaimSha256: artifacts.sourceClaimSha256,
          SourceCitationError: artifacts.SourceCitationError,
          stepAdmitsSourceRead: policy.stepAdmitsSourceRead,
          stepAdmitsSourceCite: policy.stepAdmitsSourceCite,
          getWorkflow: catalog.getWorkflow,
          parseRunArguments: runArguments.parseRunArguments,
          handleDoCommand: doCommand.handleDoCommand,
          parseLiveAgentArguments: liveAgentCommand.parseLiveAgentArguments,
          needsFirstPassKnowledge: firstPass.needsFirstPassKnowledge,
          decodeSourceRunCitations: citations.decodeSourceRunCitations,
          limit: limits.limit,
          decodeRunResultV1: runResult.decodeRunResultV1,
          decodeSavedRunRecord: runs.decodeSavedRunRecord,
        };
      } catch (error) {
        fail(
          "runtime-contracts-unavailable",
          error instanceof Error ? error.message : "runtime contract modules could not be loaded",
        );
      } finally {
        unregister();
      }
    })();
  }
  return contractPromise;
}

export async function testedRepositoryState(root = repositoryRoot) {
  const revision = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (!REVISION.test(revision)) fail("invalid-revision");
  const dirty = Boolean(
    (await execute("git", ["status", "--porcelain"], { cwd: root })).stdout.trim(),
  );
  return {
    testedRevision: dirty ? null : revision,
    worktreeBaseRevision: revision,
    testedWorktreeDirty: dirty,
  };
}

export async function loadManifest(manifestPath) {
  const path = await realpath(resolve(manifestPath)).catch(() => fail("manifest-unavailable"));
  const bytes = await readFile(path);
  const manifest = object(JSON.parse(bytes.toString("utf8")), "manifest-invalid");
  const { manifestSha256, ...body } = manifest;
  if (digest(manifestSha256, "manifest-digest-invalid") !== canonicalSha256(body)) {
    fail("manifest-digest-invalid");
  }
  if (manifest.schemaVersion !== 1 || manifest.id !== "context-v1-source-acquisition") {
    fail("manifest-identity-invalid");
  }
  if (manifest.installedAck !== INSTALLED_ACK) fail("manifest-identity-invalid");
  const factsPath = join(dirname(path), "expected-facts.json");
  const factsBytes = await readFile(factsPath);
  const expectedFacts = object(JSON.parse(factsBytes.toString("utf8")), "expected-facts-invalid");
  const { expectedFactsSha256, ...factsBody } = expectedFacts;
  if (digest(expectedFactsSha256, "expected-facts-digest-invalid") !== canonicalSha256(factsBody)) {
    fail("expected-facts-digest-invalid");
  }
  return { root: dirname(path), manifest, expectedFacts };
}

function fixturePath(corpusRoot, relativePath) {
  if (!relativePath) return null;
  const target = resolve(corpusRoot, relativePath);
  if (pathRelativeSafe(corpusRoot, target) !== relativePath.split(sep).join("/")) {
    fail("unsafe-path", relativePath);
  }
  return target;
}

function pathRelativeSafe(root, child) {
  const rel = relative(root, child);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("unsafe-path");
  return rel.split(sep).join("/");
}

function emptyMetrics() {
  return {
    expectedCriticalFacts: 0,
    supportedCriticalFacts: 0,
    unresolvedCriticalFacts: 0,
    unsupportedMaterialClaims: 0,
    authorityViolations: 0,
    custodyViolations: 0,
    evidenceViolations: 0,
    sourceBytes: 0,
    sourceRequests: 0,
    modelCalls: 0,
    latencyMs: 0,
    costUsd: null,
  };
}

function metricsFromFacts(expectedCase, factResults, extras = {}) {
  const expectedCriticalFacts = array(expectedCase.facts).filter((item) => item).length;
  const byId = new Map(factResults.map((item) => [item.factId, item]));
  let supportedCriticalFacts = 0;
  let unresolvedCriticalFacts = 0;
  let unsupportedMaterialClaims = 0;
  for (const item of expectedCase.facts) {
    const observed = byId.get(item.factId);
    if (observed?.status === "supported") supportedCriticalFacts += 1;
    else if (observed?.status === "unresolved") unresolvedCriticalFacts += 1;
    else if (observed?.status === "unsupported") unsupportedMaterialClaims += 1;
  }
  return {
    ...emptyMetrics(),
    expectedCriticalFacts,
    supportedCriticalFacts,
    unresolvedCriticalFacts,
    unsupportedMaterialClaims,
    ...extras,
  };
}

function unresolvedFacts(expectedCase) {
  return array(expectedCase.facts)
    .map((item) => ({
      factId: item.factId,
      status: "unresolved",
      claimSha256: null,
      citationSha256s: [],
    }))
    .sort(byKey("factId"));
}

function oracleCaseSha256(spec, expectedCase) {
  return canonicalSha256({ spec, expectedCase });
}

async function writeEvidence(resultsDir, caseId, name, value) {
  const relative = `source-acquisition-evidence/${caseId}/${name}`;
  const target = join(resultsDir, relative);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  await writeFile(target, bytes, { mode: 0o600 });
  return { path: relative.split(sep).join("/"), sha256: sha256(bytes) };
}

/**
 * The sealed representation descriptors a citation ledger carries.
 *
 * Each descriptor is persisted exactly as sealed, with no key added, so a
 * checker can re-derive `representationSha256` from its body. Its observation
 * id is carried alongside, not merged in; the pair addresses a derivative.
 *
 * The descriptors are content-free (identities, digests, byte offsets, coded
 * limitations), so persisting them leaks no source text. The text itself is
 * not persisted.
 */
function representationLedger(entries) {
  return [...(entries ?? [])]
    .filter((entry) => entry?.representation && entry?.observation?.observationId)
    .map((entry) => ({
      observationId: entry.observation.observationId,
      representation: entry.representation,
    }))
    .sort(
      (left, right) =>
        byKey("observationId")(left, right) ||
        byKey("representationId")(left.representation, right.representation),
    );
}

/**
 * The per-case span-citation ledger the checker verifies against.
 *
 * The sealed citation records are content-free (identities and digests), so
 * persisting them leaks nothing the binding record did not already carry, and
 * lets a checker re-derive a citation digest instead of trusting the row.
 *
 * `representations` is a sibling array, never a key added onto a sealed
 * citation, which would break the seal the checker re-derives. The installed
 * path never sees derivatives, so it persists none.
 */
function citationLedger(caseId, bindingSha256, spanCitations, representations) {
  return {
    schemaVersion: 1,
    kind: "docsfab-source-acquisition-citation-ledger",
    caseId,
    bindingSha256,
    representations: [...(representations ?? [])],
    spanCitations: [...(spanCitations ?? [])].sort(byKey("spanCitationSha256")),
  };
}

function pendingRow(
  spec,
  expectedCase,
  limitations,
  reasonCode = spec.expectedDisposition.reasonCode,
) {
  const pendingStatus =
    spec.expectedDisposition.status === "complete"
      ? "unavailable"
      : spec.expectedDisposition.status;
  const factResults = unresolvedFacts(expectedCase);
  return {
    receiptId: spec.receiptId,
    caseId: spec.caseId,
    entryPoint: spec.entryPoint,
    executionMode: spec.executionMode,
    providerId: spec.providerId,
    expectedDisposition: spec.expectedDisposition,
    observedDisposition: { status: pendingStatus, reasonCode },
    runId: null,
    sourceInvocationId: null,
    runRecordSha256: null,
    sourceBindingSha256: null,
    sourceEvidenceSha256: null,
    patchSha256: null,
    validationEvidenceSha256: null,
    modelProfileSha256: null,
    oracleCaseSha256: oracleCaseSha256(spec, expectedCase),
    factResults,
    metrics: metricsFromFacts(expectedCase, factResults),
    limitations: [...new Set(limitations)].sort(),
    evidenceRefs: [],
  };
}

// Scratch repositories: deterministic cells bind files committed to real Git,
// so the shipped reader answers from an exported revision.

function scratchGitEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function runGit(cwd, args) {
  return (await execute("git", args, { cwd, env: scratchGitEnvironment() })).stdout;
}

async function writeRepositoryFiles(repository, files) {
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(repository, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

async function createScratchRepository(root, name, files) {
  const repository = join(root, name);
  await mkdir(repository, { recursive: true, mode: 0o700 });
  await runGit(repository, ["init", "-q"]);
  await runGit(repository, ["config", "user.name", "DocsFab source acquisition"]);
  await runGit(repository, ["config", "user.email", "source-acquisition@example.invalid"]);
  await runGit(repository, ["config", "commit.gpgSign", "false"]);
  await writeRepositoryFiles(repository, files);
  await runGit(repository, ["add", "--all"]);
  await runGit(repository, ["commit", "-q", "--allow-empty", "-m", "source acquisition fixture"]);
  return repository;
}

async function repositoryHead(repository) {
  const revision = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
  if (!REVISION.test(revision)) fail("invalid-revision");
  return revision;
}

/** Absolute scratch paths never enter persisted evidence. */
function portableArgv(argv, roots) {
  return argv.map((value) => {
    for (const root of roots) {
      if (value === root) return "<scratch>";
      if (value.startsWith(`${root}${sep}`)) {
        return `<scratch>/${value
          .slice(root.length + 1)
          .split(sep)
          .join("/")}`;
      }
    }
    return value;
  });
}

// Shared CLI host acquisition reached by `docsfab run`, `docsfab do`, and a
// `live-agent` bounded workflow.

/**
 * The operator-derived part of the admitted request. The model-backed fields
 * `executeLocalWorkflow` adds do not exist without a configured model, and the
 * trace says so.
 */
function admittedRequestProjection(request, workspace, runId) {
  return {
    runId,
    workflow: request.workflow,
    workspacePath: workspace.path,
    repository: {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    ...(request.instruction ? { instruction: request.instruction } : {}),
    allowWrite: request.allowWrite === true,
  };
}

function refusalCode(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && REASON.test(code) ? code : null;
}

/**
 * Read and cite through the admitted run capability, narrowed per step as the
 * runner does. Citation digests are the shipped citer's own receipts; an
 * unread span is refused by the shipped screen, not by this collector.
 */
function readAndCite(input) {
  const { contracts, capability, policy, workflowName, expectedCase, factsById, unread } = input;
  const workflow = contracts.getWorkflow(workflowName);
  const readStep = workflow.steps.find((step) => contracts.stepAdmitsSourceRead(policy, step));
  const citeStep = workflow.steps.find(
    (step) => step.mode === "write" && contracts.stepAdmitsSourceCite(policy, step),
  );
  if (!readStep || !citeStep) fail("source-step-grant-missing", workflowName);
  const grant = (step, cite) => ({
    stepId: step.id,
    workflow: workflow.name,
    readSource: contracts.stepAdmitsSourceRead(policy, step),
    citeSource: cite && step.mode === "write" && contracts.stepAdmitsSourceCite(policy, step),
    remainingBudgetBytes: policy.perStepBudgetBytes,
  });
  const reader = capability.forStep(grant(readStep, false));
  if (!reader) fail("source-step-grant-missing", readStep.id);
  const spans = reader.listSources();
  const read = unread
    ? []
    : spans.map((span) => ({
        span,
        text: reader.read({
          observationId: span.observationId,
          representationId: span.representationId,
          spanIds: [span.spanId],
        }).text,
      }));
  // A new step supersedes the reader exactly as the runner does, then the
  // citer narrows the same generation.
  capability.forStep(grant(citeStep, true));
  const citer = capability.citerForStep(grant(citeStep, true));
  if (!citer) fail("source-step-grant-missing", citeStep.id);
  const factResults = [];
  const citationRefusals = [];
  for (const item of array(expectedCase.facts)) {
    const fact = factsById.get(item.factId);
    const statement = typeof fact?.statement === "string" ? fact.statement : null;
    const needle = typeof fact?.needle === "string" && fact.needle ? fact.needle : null;
    const targets = unread
      ? spans
      : needle
        ? read.filter((entry) => entry.text.includes(needle)).map((entry) => entry.span)
        : [];
    if (!statement || targets.length === 0) {
      factResults.push({
        factId: item.factId,
        status: "unresolved",
        claimSha256: null,
        citationSha256s: [],
      });
      continue;
    }
    const [first] = targets;
    const spanIds = targets
      .filter(
        (span) =>
          span.observationId === first.observationId &&
          span.representationId === first.representationId,
      )
      .map((span) => span.spanId);
    try {
      const receipt = citer.cite({
        claim: statement,
        observationId: first.observationId,
        representationId: first.representationId,
        spanIds,
      });
      factResults.push({
        factId: item.factId,
        status: "supported",
        claimSha256: receipt.supportedClaimSha256,
        citationSha256s: [...new Set(receipt.spanCitationSha256s)].sort(),
      });
    } catch (error) {
      if (!(error instanceof contracts.SourceCitationError)) throw error;
      citationRefusals.push({ factId: item.factId, code: error.code });
      factResults.push({
        factId: item.factId,
        status: "unsupported",
        claimSha256: contracts.sourceClaimSha256(statement),
        citationSha256s: [],
      });
    }
  }
  return {
    factResults: factResults.sort(byKey("factId")),
    readStepId: readStep.id,
    citeStepId: citeStep.id,
    spansListed: spans.length,
    spansRead: read.length,
    citationRefusals: citationRefusals.sort(byKey("factId")),
    // The sealed citations, so the checker can re-derive each digest.
    spanCitations: capability.spanCitations(),
  };
}

function observedFromAcquired(entries, limitations) {
  const gaps = new Set(entries.flatMap((entry) => entry.evidenceGaps ?? []));
  if (gaps.has("truncated-merge-request-text")) {
    return { status: "partial", reasonCode: "truncated-merge-request-text" };
  }
  const noText =
    limitations.includes("no-text-layer") ||
    limitations.includes("non-text-content-excluded") ||
    entries.every((entry) => !new TextDecoder().decode(entry.derivative).trim());
  return noText
    ? { status: "partial", reasonCode: "no-text-layer" }
    : { status: "complete", reasonCode: "acquired" };
}

/**
 * Export the request's revision, gate and acquire through the shipped CLI
 * host, admit the binding, then read and cite. Returns a row fragment and the
 * content-free trace persisted as `entry-point.json`.
 */
async function acquireThroughCliHost(input) {
  const { contracts, request, expectedCase, factsById, unread = false, gitlab = null } = input;
  const started = Date.now();
  return contracts.withRepositoryWorkspace(
    request.repositoryPath,
    request.revision ?? "HEAD",
    async (workspace) => {
      const runId = randomUUID();
      const repository = {
        identitySha256: sha256(workspace.sourcePath),
        revision: workspace.revision,
      };
      const admitted = admittedRequestProjection(request, workspace, runId);
      const sourcePaths = [...(request.sourcePaths ?? [])];
      const invoked = ["withRepositoryWorkspace"];
      const trace = {
        runId,
        runIdSha256: sha256(runId),
        repository,
        workflow: request.workflow,
        sourcePaths,
        invoked,
      };
      const inspection = input.inspectWorkspace
        ? await input.inspectWorkspace(workspace, contracts)
        : null;
      let evidence;
      try {
        if (sourcePaths.length > 0 && contracts.needsFirstPassKnowledge(request)) {
          invoked.push("assertBoundSourcesTracked");
          await contracts.assertBoundSourcesTracked({
            reader: contracts.createWorkspaceTrackedSourceReader(workspace),
            sourcePaths,
          });
        }
        if (gitlab) {
          invoked.push("resolveCliChangeRequestSourceEvidence");
          evidence = await contracts.resolveCliChangeRequestSourceEvidence({
            workspace,
            scope: gitlab.scope,
            readerFor: gitlab.readerFor,
            mergeRequestIids: [gitlab.iid],
            admittedRequest: admitted,
            runId,
            ...(sourcePaths.length > 0 ? { sourcePaths } : {}),
          });
        } else {
          invoked.push("resolveCliSourceEvidence");
          evidence = await contracts.resolveCliSourceEvidence({
            workspace,
            sourcePaths,
            admittedRequest: admitted,
            runId,
          });
        }
      } catch (error) {
        const code = refusalCode(error);
        if (!code) throw error;
        const factResults = unresolvedFacts(expectedCase);
        return {
          observedDisposition: { status: "denied", reasonCode: code },
          runId,
          sourceBindingSha256: null,
          sourceEvidenceSha256: null,
          factResults,
          metrics: metricsFromFacts(expectedCase, factResults, {
            latencyMs: Date.now() - started,
          }),
          limitations: [],
          binding: null,
          inspection,
          spanCitations: [],
          representations: [],
          trace: { ...trace, refusal: code, ...(inspection ? { inspection } : {}) },
        };
      }
      const entries = evidence.acquired.acquired;
      const binding = evidence.acquired.binding;
      const runner = evidence.runnerBinding;
      const requestSha256 = contracts.projectSourceRequestContext(admitted, {
        runId,
        workspaceIdentitySha256: runner.workspaceIdentitySha256,
        repository,
      });
      invoked.push("admitRunSourceBinding");
      const capability = contracts.admitRunSourceBinding({
        reference: evidence.reference,
        service: runner.service,
        context: {
          runId,
          requestSha256,
          repository,
          workspaceIdentitySha256: runner.workspaceIdentitySha256,
          repositoryContentDigest: runner.repositoryContentDigest,
        },
      });
      invoked.push(
        "SourceRunCapabilityV1.forStep",
        "SourceStepReaderV1.read",
        "SourceRunCapabilityV1.citerForStep",
        "SourceStepCiterV1.cite",
      );
      const cited = readAndCite({
        contracts,
        capability,
        policy: runner.policy,
        workflowName: request.workflow,
        expectedCase,
        factsById,
        unread,
      });
      const limitations = [
        ...new Set(
          entries.flatMap((entry) => [
            ...(entry.representation?.limitations ?? []),
            ...(entry.evidenceGaps ?? []),
          ]),
        ),
      ].sort();
      return {
        observedDisposition: observedFromAcquired(entries, limitations),
        runId,
        sourceBindingSha256: binding.bindingSha256,
        sourceEvidenceSha256: entries[0]?.observation.observationSha256 ?? null,
        factResults: cited.factResults,
        metrics: metricsFromFacts(expectedCase, cited.factResults, {
          sourceBytes: entries.reduce((total, entry) => total + entry.derivative.byteLength, 0),
          sourceRequests: entries.length,
          latencyMs: Date.now() - started,
        }),
        limitations,
        binding,
        inspection,
        spanCitations: cited.spanCitations,
        representations: representationLedger(entries),
        trace: {
          ...trace,
          requestSha256,
          workspaceIdentitySha256: runner.workspaceIdentitySha256,
          repositoryContentDigest: runner.repositoryContentDigest,
          bindingSha256: binding.bindingSha256,
          observations: entries.map((entry) => ({
            observationId: entry.observation.observationId,
            observationSha256: entry.observation.observationSha256,
          })),
          readStepId: cited.readStepId,
          citeStepId: cited.citeStepId,
          spansListed: cited.spansListed,
          spansRead: cited.spansRead,
          citationRefusals: cited.citationRefusals,
          ...(inspection ? { inspection } : {}),
        },
      };
    },
  );
}

async function finishHost(ctx, acquired, entry) {
  const { spec, expectedCase, evidenceRoot } = ctx;
  const refs = [];
  if (acquired.binding) {
    refs.push({
      kind: "source-domain",
      ...(await writeEvidence(evidenceRoot, spec.caseId, "binding.json", {
        bindingSha256: acquired.sourceBindingSha256,
        limitations: acquired.limitations,
      })),
    });
    refs.push({
      kind: "source-domain",
      ...(await writeEvidence(
        evidenceRoot,
        spec.caseId,
        "citations.json",
        citationLedger(
          spec.caseId,
          acquired.sourceBindingSha256,
          acquired.spanCitations,
          acquired.representations,
        ),
      )),
    });
  }
  refs.push({
    kind: "run",
    ...(await writeEvidence(evidenceRoot, spec.caseId, "entry-point.json", {
      schemaVersion: 1,
      kind: "docsfab-source-acquisition-entry-point-trace",
      caseId: spec.caseId,
      entryPoint: spec.entryPoint,
      argv: portableArgv(entry.argv, ctx.scratchRoots),
      ...acquired.trace,
      invoked: [...entry.invoked, ...acquired.trace.invoked],
      notInvoked: [...(entry.notInvoked ?? []), ...DETERMINISTIC_NOT_INVOKED],
      observedDisposition: acquired.observedDisposition,
    })),
  });
  refs.sort(byKey("path"));
  return {
    receiptId: spec.receiptId,
    caseId: spec.caseId,
    entryPoint: spec.entryPoint,
    executionMode: spec.executionMode,
    providerId: spec.providerId,
    expectedDisposition: spec.expectedDisposition,
    observedDisposition: acquired.observedDisposition,
    runId: acquired.runId,
    sourceInvocationId: null,
    runRecordSha256: null,
    sourceBindingSha256: acquired.sourceBindingSha256,
    sourceEvidenceSha256: acquired.sourceEvidenceSha256,
    patchSha256: null,
    validationEvidenceSha256: null,
    modelProfileSha256: null,
    oracleCaseSha256: oracleCaseSha256(spec, expectedCase),
    factResults: acquired.factResults,
    metrics: acquired.metrics,
    limitations: acquired.limitations,
    evidenceRefs: refs,
  };
}

function runArgv(repository, sourcePath) {
  return [
    "update-documentation",
    "--repo",
    repository,
    "--source",
    sourcePath,
    "--patch-only",
    "--json",
    "--instruction",
    RUN_INSTRUCTION,
  ];
}

function doArgv(repository, sourcePath) {
  return [DO_REQUEST, "--repo", repository, "--source", sourcePath, "--patch-only", "--json"];
}

async function runEntryPointCell(ctx, options) {
  const argv = runArgv(options.repository, options.sourcePath);
  const request = ctx.contracts.parseRunArguments(argv);
  const acquired = await acquireThroughCliHost({
    contracts: ctx.contracts,
    request,
    expectedCase: ctx.expectedCase,
    factsById: ctx.factsById,
    unread: options.unread === true,
    ...(options.inspectWorkspace ? { inspectWorkspace: options.inspectWorkspace } : {}),
  });
  return {
    acquired,
    entry: { argv, invoked: ["parseRunArguments"], notInvoked: ["executeRunRequest"] },
  };
}

/**
 * Catalog `docsfab do`: the shipped parser and outcome router decide the
 * workflow, then the routed request is captured at the command's own
 * `runWorkflow` seam instead of executing a model-backed run.
 */
async function doEntryPointCell(ctx, options) {
  const argv = doArgv(options.repository, options.sourcePath);
  let routed;
  let decision;
  const exitCode = process.exitCode;
  try {
    decision = await ctx.contracts.handleDoCommand(argv, {
      stateDirectory: join(ctx.scratchRoot, `${ctx.spec.caseId}-state`),
      runWorkflow: async (request) => {
        routed = request;
      },
    });
  } finally {
    process.exitCode = exitCode;
  }
  if (!routed) fail("do-route-not-selected", decision?.status ?? "no routing decision");
  const acquired = await acquireThroughCliHost({
    contracts: ctx.contracts,
    request: routed,
    expectedCase: ctx.expectedCase,
    factsById: ctx.factsById,
  });
  return {
    acquired,
    entry: {
      argv,
      invoked: ["handleDoCommand", `routeOutcomeRequest:${routed.workflow}`],
      notInvoked: ["executeRunRequest"],
    },
  };
}

function liveAgentPorts(contracts, repositoryPath) {
  return contracts.createLiveAgentSourcePorts({
    repositoryPath,
    environment: scratchGitEnvironment(),
    entryPoint: "live-terminal",
  });
}

/**
 * `docsfab live-agent`: the shipped parser, host `/sources` ports and
 * selection, and the bounded-run callback. Its `runWorkflow` seam acquires the
 * selected request through the same CLI host call site.
 */
async function liveAgentEntryPointCell(ctx, options) {
  const { contracts } = ctx;
  const argv = ["--repo", options.repository, "--source", options.sourcePath, "--read-only"];
  const parsed = contracts.parseLiveAgentArguments(argv);
  const selection = contracts.createLiveAgentSourceSelection({
    ...(parsed.sourcePaths ? { sourcePaths: parsed.sourcePaths } : {}),
    ports: liveAgentPorts(contracts, parsed.repositoryPath),
  });
  const invoked = [
    "parseLiveAgentArguments",
    "createLiveAgentSourcePorts",
    "createLiveAgentSourceSelection",
  ];
  if (options.revalidate) {
    await selection.dispatch(`${contracts.SOURCE_COMMAND_PREFIX} refresh`);
    await selection.dispatch(`${contracts.SOURCE_COMMAND_PREFIX} revalidate`);
    invoked.push(
      `${contracts.SOURCE_COMMAND_PREFIX} refresh`,
      `${contracts.SOURCE_COMMAND_PREFIX} revalidate`,
    );
  }
  let acquired;
  const runner = contracts.createLiveAgentBoundedRunner({
    selection,
    repositoryPath: parsed.repositoryPath,
    allowWrite: parsed.allowWrite,
    config: {},
    persist: async () => ({ status: "not-needed" }),
    runWorkflow: async (runInput) => {
      const request = contracts.liveAgentWorkflowRunRequest(runInput);
      acquired = await acquireThroughCliHost({
        contracts,
        request,
        expectedCase: ctx.expectedCase,
        factsById: ctx.factsById,
      });
      return { id: acquired.runId, workflow: runInput.workflow, status: "succeeded" };
    },
  });
  await runner("update-documentation", LIVE_AGENT_TURN);
  if (!acquired) fail("live-agent-run-not-started");
  invoked.push("createLiveAgentBoundedRunner", "liveAgentWorkflowRunRequest");
  return {
    acquired,
    entry: { argv, invoked, notInvoked: ["runLiveAgent-terminal-session", "runBoundedWorkflow"] },
  };
}

async function staleBind(ctx, html) {
  const { contracts, spec, evidenceRoot, expectedCase } = ctx;
  const sourcePath = "docs/atlas-heartbeat.html";
  const repository = await createScratchRepository(ctx.scratchRoot, spec.caseId, {
    [sourcePath]: html,
  });
  const argv = ["--repo", repository, "--source", sourcePath, "--read-only"];
  const parsed = contracts.parseLiveAgentArguments(argv);
  const selection = contracts.createLiveAgentSourceSelection({
    sourcePaths: parsed.sourcePaths,
    ports: liveAgentPorts(contracts, parsed.repositoryPath),
  });
  await selection.dispatch(`${contracts.SOURCE_COMMAND_PREFIX} refresh`);
  const before = await repositoryHead(repository);
  await appendFile(join(repository, ...sourcePath.split("/")), "<p>Revised after attach.</p>\n");
  await runGit(repository, ["commit", "-q", "-am", "source changed after attach"]);
  const after = await repositoryHead(repository);
  const revalidated = await selection.dispatch(`${contracts.SOURCE_COMMAND_PREFIX} revalidate`);
  const started = [];
  const runner = contracts.createLiveAgentBoundedRunner({
    selection,
    repositoryPath: parsed.repositoryPath,
    allowWrite: parsed.allowWrite,
    config: {},
    persist: async () => ({ status: "not-needed" }),
    runWorkflow: async (request) => {
      started.push(request.workflow);
      return { id: "should-not-run", workflow: request.workflow, status: "succeeded" };
    },
  });
  let refusal;
  try {
    await runner("update-documentation", LIVE_AGENT_TURN);
  } catch (error) {
    refusal = error;
  }
  if (!(refusal instanceof contracts.SourceCommandError) || refusal.code !== "bind-stale") {
    fail(
      "stale-bind-missing",
      refusal instanceof Error ? refusal.message : "the bounded runner started",
    );
  }
  if (started.length !== 0) fail("stale-bind-started-workflow");
  const verdicts = (revalidated?.results ?? []).map((result) => ({
    state: result.state,
    recordedVersion: result.recordedVersion ?? null,
    observedVersion: result.observedVersion ?? null,
  }));
  const refs = [
    {
      kind: "lifecycle",
      ...(await writeEvidence(evidenceRoot, spec.caseId, "refusal.json", {
        code: refusal.code,
        message: refusal.message,
      })),
    },
    {
      kind: "run",
      ...(await writeEvidence(evidenceRoot, spec.caseId, "entry-point.json", {
        schemaVersion: 1,
        kind: "docsfab-source-acquisition-entry-point-trace",
        caseId: spec.caseId,
        entryPoint: spec.entryPoint,
        argv: portableArgv(argv, ctx.scratchRoots),
        invoked: [
          "parseLiveAgentArguments",
          "createLiveAgentSourcePorts",
          "createLiveAgentSourceSelection",
          `${contracts.SOURCE_COMMAND_PREFIX} refresh`,
          `${contracts.SOURCE_COMMAND_PREFIX} revalidate`,
          "createLiveAgentBoundedRunner",
        ],
        notInvoked: [
          "runLiveAgent-terminal-session",
          "runBoundedWorkflow",
          ...DETERMINISTIC_NOT_INVOKED,
        ],
        revisions: { attached: before, revalidated: after },
        verdicts,
        refusal: refusal.code,
        // The trace carries the observed disposition so the checker can refuse
        // a row edited afterwards to claim another (`run-disposition-mismatch`).
        observedDisposition: { status: "changed", reasonCode: refusal.code },
      })),
    },
  ].sort(byKey("path"));
  return {
    receiptId: spec.receiptId,
    caseId: spec.caseId,
    entryPoint: spec.entryPoint,
    executionMode: spec.executionMode,
    providerId: spec.providerId,
    expectedDisposition: spec.expectedDisposition,
    observedDisposition: { status: "changed", reasonCode: refusal.code },
    runId: null,
    sourceInvocationId: null,
    runRecordSha256: null,
    sourceBindingSha256: null,
    sourceEvidenceSha256: null,
    patchSha256: null,
    validationEvidenceSha256: null,
    modelProfileSha256: null,
    oracleCaseSha256: oracleCaseSha256(spec, expectedCase),
    factResults: [],
    metrics: emptyMetrics(),
    limitations: [],
    evidenceRefs: refs,
  };
}

async function searchRefusal(ctx) {
  const { contracts, spec, evidenceRoot, expectedCase } = ctx;
  const repository = await createScratchRepository(ctx.scratchRoot, spec.caseId, {});
  const selection = contracts.createLiveAgentSourceSelection({
    ports: liveAgentPorts(contracts, repository),
  });
  let refusal;
  try {
    await selection.dispatch(`${contracts.SOURCE_COMMAND_PREFIX} search`);
  } catch (error) {
    refusal = error;
  }
  if (!(refusal instanceof contracts.SourceCommandError) || refusal.code !== "search-unavailable") {
    fail(
      "search-refusal-missing",
      refusal instanceof Error ? refusal.message : "search returned without a refusal",
    );
  }
  return {
    ...pendingRow(
      spec,
      expectedCase,
      ["searcher-absent-until-live-provider"],
      "search-unavailable",
    ),
    observedDisposition: { status: "unavailable", reasonCode: "search-unavailable" },
    limitations: ["searcher-absent-until-live-provider"],
    runId: null,
    evidenceRefs: [
      {
        kind: "lifecycle",
        ...(await writeEvidence(evidenceRoot, spec.caseId, "refusal.json", {
          code: refusal.code,
          message: refusal.message,
        })),
      },
    ],
  };
}

async function discoverPageTwo(contracts, pageOne, pageTwo) {
  const pagesRead = [];
  const scope = {
    schemaVersion: 1,
    kind: "docsfab-source-discovery-scope",
    providerId: contracts.GITLAB_SOURCE_PROVIDER_ID,
    host: "gitlab.example.invalid",
    projectId: FIXTURE_GITLAB_PROJECT_ID,
    projectPath: "team/docs-project",
  };
  const window = contracts.resolveMergedMrDateWindow({
    timeZone: "America/Los_Angeles",
    startDate: "2026-09-14",
    endDate: "2026-09-15",
  });
  const result = await contracts.discoverSourceDescriptors({
    scope,
    window,
    targetBranch: "main",
    port: {
      orderedDescendingByMergedAt: true,
      async fetchPage(page) {
        pagesRead.push(page);
        const payload = page === 1 ? pageOne : pageTwo;
        return {
          items: payload.items,
          nextPage: payload.nextPage,
          truncated: false,
        };
      },
    },
  });
  const pageTwoEndpoint = contracts.gitlabMrReadEndpoint({
    operation: "list_merged",
    projectPath: "team/docs-project",
    limit: contracts.GITLAB_READ_PAGE_SIZE,
    page: 2,
  });
  if (!pageTwoEndpoint.includes("page=2")) fail("gitlab-page-two-endpoint-invalid");
  if (!pagesRead.includes(2)) fail("gitlab-discovery-stopped-at-first-page");
  if (result.coverage.pagesRead < 2) fail("gitlab-discovery-stopped-at-first-page");
  return { result, pagesRead, pageTwoEndpoint };
}

/**
 * `docsfab run --pr`: the shipped parser mints the change-request selector,
 * the scope is proved by the shipped resolver, and the merged change is bound
 * by the same host call site the CLI uses. Only the forge transport is a
 * fixture projection; no network or token is involved.
 */
async function gitlabRunCell(ctx, projection) {
  const { contracts } = ctx;
  const repository = await createScratchRepository(ctx.scratchRoot, ctx.spec.caseId, {});
  const argv = [
    "update-documentation",
    "--repo",
    repository,
    "--pr",
    projection.url,
    "--patch-only",
    "--json",
    "--instruction",
    RUN_CHANGE_INSTRUCTION,
  ];
  const request = contracts.parseRunArguments(argv);
  const selector = request.changeRequestSelector;
  if (!selector || typeof selector.host !== "string" || typeof selector.projectPath !== "string") {
    fail("gitlab-selector-invalid", ctx.spec.caseId);
  }
  const scope = await contracts.resolveGitLabAcquisitionScope({
    reference: { host: selector.host, projectPath: selector.projectPath },
    identityPort: {
      async resolveProjectIdentity(reference) {
        return {
          host: reference.host,
          projectPath: reference.projectPath,
          projectId: FIXTURE_GITLAB_PROJECT_ID,
        };
      },
    },
  });
  const acquired = await acquireThroughCliHost({
    contracts,
    request,
    expectedCase: ctx.expectedCase,
    factsById: ctx.factsById,
    gitlab: {
      scope,
      iid: selector.number,
      readerFor: () => ({
        async readMergeRequest(iid) {
          return iid === projection.iid ? projection : undefined;
        },
      }),
    },
  });
  return {
    acquired,
    entry: {
      argv,
      invoked: ["parseRunArguments", "resolveGitLabAcquisitionScope"],
      notInvoked: ["executeRunRequest", "gitlab-forge-transport"],
    },
  };
}

/**
 * `dirty-uncommitted`: a committed file is modified in the working tree and
 * the selected file is staged but never committed. The shipped reader answers
 * from the exported revision, so the selection is refused and the modified
 * tracked file reads as its committed bytes; otherwise the cell records
 * `working-tree-bytes-bound`.
 */
async function dirtyUncommittedCell(ctx, bytes) {
  const trackedPath = "docs/atlas-heartbeat.html";
  const uncommittedPath = "docs/uncommitted-heartbeat.html";
  const repository = await createScratchRepository(ctx.scratchRoot, ctx.spec.caseId, {
    [trackedPath]: bytes,
  });
  await appendFile(join(repository, ...trackedPath.split("/")), DIRTY_WORKING_TREE_MARKER);
  await writeRepositoryFiles(repository, { [uncommittedPath]: bytes });
  await runGit(repository, ["add", "--", uncommittedPath]);
  const porcelain = (await runGit(repository, ["status", "--porcelain"]))
    .split("\n")
    .filter((line) => line.trim())
    .sort();
  if (!porcelain.includes(` M ${trackedPath}`) || !porcelain.includes(`A  ${uncommittedPath}`)) {
    fail("dirty-fixture-invalid", porcelain.join(", "));
  }
  const workingBytes = await readFile(join(repository, ...trackedPath.split("/")));
  const cell = await runEntryPointCell(ctx, {
    repository,
    sourcePath: uncommittedPath,
    inspectWorkspace: async (workspace, contracts) => {
      const reader = contracts.createWorkspaceTrackedSourceReader(workspace);
      const tracked = Buffer.from(
        await reader.readTrackedBytes(trackedPath, workingBytes.byteLength),
      );
      return {
        workingTreeDirty: true,
        porcelain,
        committedSha256: sha256(bytes),
        workingTreeSha256: sha256(workingBytes),
        trackedReadSha256: sha256(tracked),
        workingTreeBytesExcluded: sha256(tracked) === sha256(bytes),
        uncommittedPathTracked: await reader.isTrackedRegularFile(uncommittedPath),
      };
    },
  });
  const inspection = cell.acquired.inspection;
  if (!inspection.workingTreeBytesExcluded || inspection.uncommittedPathTracked) {
    cell.acquired.observedDisposition = {
      status: "changed",
      reasonCode: "working-tree-bytes-bound",
    };
  }
  return cell;
}

/** `denied-untracked`: the selected path exists nowhere, not even on disk. */
async function deniedUntrackedCell(ctx) {
  const sourcePath = "docs/never-committed.txt";
  const repository = await createScratchRepository(ctx.scratchRoot, ctx.spec.caseId, {});
  return runEntryPointCell(ctx, {
    repository,
    sourcePath,
    inspectWorkspace: async (workspace, contracts) => {
      const present = await readFile(join(repository, ...sourcePath.split("/"))).then(
        () => true,
        () => false,
      );
      return {
        workingTreeDirty: Boolean((await runGit(repository, ["status", "--porcelain"])).trim()),
        pathPresentInWorkingTree: present,
        pathTracked: await contracts
          .createWorkspaceTrackedSourceReader(workspace)
          .isTrackedRegularFile(sourcePath),
      };
    },
  });
}

async function localFixtureCell(ctx, bytes) {
  const { spec } = ctx;
  const sourcePath = `docs/${spec.fixture.split("/").pop()}`;
  const repository = await createScratchRepository(ctx.scratchRoot, spec.caseId, {
    [sourcePath]: bytes,
  });
  if (spec.entryPoint === "do") return doEntryPointCell(ctx, { repository, sourcePath });
  if (spec.entryPoint === "live-agent") {
    return liveAgentEntryPointCell(ctx, {
      repository,
      sourcePath,
      revalidate: spec.receiptId === "context-v1-resume",
    });
  }
  return runEntryPointCell(ctx, {
    repository,
    sourcePath,
    unread: spec.caseId === "unread-citation-run-deterministic",
  });
}

async function collectCase(input) {
  const { contracts, spec, expectedCase, corpusRoot, evidenceRoot, installed } = input;
  const bytes = spec.fixture ? await readFile(fixturePath(corpusRoot, spec.fixture)) : null;

  if (spec.executionMode === "live" && !installed) {
    const reason =
      spec.liveRequirement === "compaction-evidence"
        ? "compaction-unreleased"
        : spec.providerId === "brave" || spec.providerId === "https"
          ? "public-web-source-binding-unreleased"
          : "live-execution-not-acknowledged";
    return pendingRow(spec, expectedCase, [reason], reason);
  }

  if (spec.caseId === "sources-search-refusal-live-agent-deterministic") {
    return searchRefusal(input);
  }

  if (spec.caseId === "direct-https-run-deterministic") {
    return pendingRow(spec, expectedCase, ["https-fetcher-unreleased"], "https-fetcher-unreleased");
  }
  if (spec.caseId === "public-search-run-live" || spec.caseId === "direct-https-run-live") {
    return pendingRow(
      spec,
      expectedCase,
      ["public-web-source-binding-unreleased"],
      "public-web-source-binding-unreleased",
    );
  }
  if (spec.caseId === "compaction-subcell-live") {
    return pendingRow(spec, expectedCase, ["compaction-unreleased"], "compaction-unreleased");
  }

  if (
    spec.caseId === "stale-bind-live-agent-deterministic" ||
    spec.caseId === "resume-stale-live-agent-deterministic"
  ) {
    return staleBind(input, bytes);
  }

  if (spec.caseId === "gitlab-discovery-page-two-run-deterministic") {
    const pageOne = JSON.parse(
      await readFile(fixturePath(corpusRoot, "fixtures/gitlab/list-page-1.json"), "utf8"),
    );
    const pageTwo = JSON.parse(
      await readFile(fixturePath(corpusRoot, "fixtures/gitlab/list-page-2.json"), "utf8"),
    );
    const discovery = await discoverPageTwo(contracts, pageOne, pageTwo);
    const coverageSha256 = canonicalSha256(discovery.result.coverage);
    // Discovery mints no run and writes no trace, but its declared
    // `sourceEvidenceSha256` still needs a record outside the row; the
    // checker finds it by the `run` evidence kind.
    const ref = await writeEvidence(evidenceRoot, spec.caseId, "discovery.json", {
      ...declaredRunIdentity(spec, { sourceEvidenceSha256: coverageSha256 }),
      pagesRead: discovery.pagesRead,
      pageTwoEndpoint: discovery.pageTwoEndpoint,
      descriptorCount: discovery.result.descriptors.length,
      coverage: discovery.result.coverage.disposition,
    });
    return {
      receiptId: spec.receiptId,
      caseId: spec.caseId,
      entryPoint: spec.entryPoint,
      executionMode: spec.executionMode,
      providerId: spec.providerId,
      expectedDisposition: spec.expectedDisposition,
      observedDisposition: { status: "complete", reasonCode: "acquired" },
      // Discovery walks pages; it mints no run and binds no source.
      runId: null,
      sourceInvocationId: null,
      runRecordSha256: null,
      sourceBindingSha256: null,
      sourceEvidenceSha256: coverageSha256,
      patchSha256: null,
      validationEvidenceSha256: null,
      modelProfileSha256: null,
      oracleCaseSha256: oracleCaseSha256(spec, expectedCase),
      factResults: [],
      metrics: {
        ...emptyMetrics(),
        sourceRequests: discovery.result.coverage.pagesRead,
      },
      limitations: [],
      evidenceRefs: [{ kind: "run", ...ref }],
    };
  }

  if (spec.executionMode === "live") {
    return collectInstalledCase(input, bytes);
  }

  let cell;
  if (spec.caseId === "denied-untracked-run-deterministic") {
    cell = await deniedUntrackedCell(input);
  } else if (spec.caseId === "dirty-uncommitted-run-deterministic") {
    cell = await dirtyUncommittedCell(input, bytes);
  } else if (spec.providerId === "gitlab" && bytes) {
    cell = await gitlabRunCell(input, JSON.parse(bytes.toString("utf8")));
  } else if (spec.providerId === "local" && bytes && spec.fixture) {
    cell = await localFixtureCell(input, bytes);
  } else {
    fail("unhandled-deterministic-cell", spec.caseId);
  }
  return finishHost(input, cell.acquired, cell.entry);
}

// Installed mode.

export async function installedCliIdentity(cli, workflow = "update-documentation") {
  const resolvedCli = await realpath(cli).catch(() => fail("installed-identity-invalid"));
  const packageRoot = resolve(dirname(resolvedCli), "..");
  const packageJsonPath = resolve(packageRoot, "package.json");
  const workflowPath = resolve(packageRoot, "workflows", `${workflow}.json`);
  const [packageJsonBytes, cliBytes, workflowBytes] = await Promise.all([
    readFile(packageJsonPath),
    readFile(resolvedCli),
    readFile(workflowPath),
  ]).catch(() => fail("installed-identity-invalid"));
  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  } catch {
    fail("installed-identity-invalid");
  }
  if (
    packageJson.name !== "docsfab" ||
    typeof packageJson.version !== "string" ||
    !packageJson.version ||
    packageJson.bin?.docsfab !== "./bin/docsfab.mjs"
  ) {
    fail("installed-identity-invalid");
  }
  const resolvedBin = await realpath(resolve(packageRoot, packageJson.bin.docsfab)).catch(() =>
    fail("installed-identity-invalid"),
  );
  if (resolvedBin !== resolvedCli) fail("installed-identity-invalid");
  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    packageJsonSha256: sha256(packageJsonBytes),
    cliSha256: sha256(cliBytes),
    workflowSha256: sha256(workflowBytes),
  };
}

/** Installed collection needs the run-record decoders before any invocation. */
export function requireInstalledSourceEvidenceContracts(contracts) {
  if (
    typeof contracts.decodeSourceRunCitations !== "function" ||
    typeof contracts.sourceClaimSha256 !== "function" ||
    typeof contracts.limit !== "function" ||
    typeof contracts.decodeRunResultV1 !== "function" ||
    typeof contracts.decodeSavedRunRecord !== "function"
  ) {
    fail("installed-source-evidence-contract-unavailable");
  }
}

export function installedEnv(stateDirectory, configRoot) {
  // HOME is the per-case state directory (mode 0o700), never the operator's:
  // with a real HOME the installed CLI could read or write the operator's
  // dotfiles and credentials even with DOCSFAB_CONFIG_ROOT set.
  const env = {
    PATH: process.env.PATH,
    HOME: stateDirectory,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    TERM: "dumb",
    NODE_PATH: process.env.NODE_PATH,
    GIT_TERMINAL_PROMPT: "0",
    CI: "1",
  };
  if (configRoot) env.DOCSFAB_CONFIG_ROOT = configRoot;
  env.DOCSFAB_STATE_DIR = stateDirectory;
  return env;
}

/**
 * Run one installed invocation under the catalog bounds. A bound that stops
 * the child is returned as a coded stop naming the limit, never as a result.
 */
export async function invokeInstalled(contracts, cli, argv, options) {
  const limitOptions = options.limitOptions ?? {};
  const timeout = contracts.limit(INSTALLED_TIMEOUT_LIMIT, limitOptions);
  const output = contracts.limit(INSTALLED_OUTPUT_LIMIT, limitOptions);
  const started = Date.now();
  try {
    const result = await execute(process.execPath, [cli, ...argv], {
      cwd: options.cwd,
      env: installedEnv(options.stateDirectory, options.configRoot),
      timeout: timeout.value,
      maxBuffer: output.value,
    });
    return {
      code: 0,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsedMs: Date.now() - started,
      limitStop: null,
    };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const stopFor = (bound, observed) => ({
      limit: bound.name,
      value: bound.value,
      unit: bound.unit,
      refusal: bound.refusal,
      observed,
    });
    const limitStop =
      error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? { ...stopFor(output, output.value + 1), observedIsLowerBound: true }
        : error?.killed === true
          ? stopFor(timeout, elapsedMs)
          : null;
    return {
      code: typeof error?.code === "number" ? error.code : null,
      signal: typeof error?.signal === "string" ? error.signal : null,
      stdout,
      stderr,
      elapsedMs,
      limitStop,
    };
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/** Every top-level JSON object in a stream, whether one line or pretty-printed. */
function jsonDocuments(text) {
  const documents = [];
  const source = String(text ?? "");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (character === BACKSLASH) escaped = true;
      else if (character === QUOTE) inString = false;
      continue;
    }
    if (character === QUOTE && depth > 0) {
      inString = true;
    } else if (character === OPEN_BRACE) {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === CLOSE_BRACE && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const value = JSON.parse(source.slice(start, index + 1));
          if (value && typeof value === "object" && !Array.isArray(value)) documents.push(value);
        } catch {
          // Not JSON: skip the fragment rather than inventing a document.
        }
        start = -1;
      }
    }
  }
  return documents;
}

function factsFromCitations(contracts, expectedCase, factsById, citations) {
  const bySupportedClaim = new Map();
  for (const step of citations?.steps ?? []) {
    for (const citation of step.citations) {
      const list = bySupportedClaim.get(citation.supportedClaimSha256) ?? [];
      list.push(citation.spanCitationSha256);
      bySupportedClaim.set(citation.supportedClaimSha256, list);
    }
  }
  return array(expectedCase.facts)
    .map((item) => {
      const statement = factsById.get(item.factId)?.statement;
      const claimSha256 =
        typeof statement === "string" ? contracts.sourceClaimSha256(statement) : null;
      const cited = claimSha256 ? bySupportedClaim.get(claimSha256) : undefined;
      return cited && cited.length > 0
        ? {
            factId: item.factId,
            status: "supported",
            claimSha256,
            citationSha256s: [...new Set(cited)].sort(),
          }
        : { factId: item.factId, status: "unresolved", claimSha256: null, citationSha256s: [] };
    })
    .sort(byKey("factId"));
}

async function parseRunResult(contracts, result, context, stop) {
  let envelope;
  try {
    envelope = contracts.decodeRunResultV1(result);
  } catch {
    return stop("unavailable", INSTALLED_OUTPUT_UNPARSED, {
      output: "docsfab-run-result",
      reason: "run-result-envelope-invalid",
    });
  }
  // A completed proof cell must bind the envelope result digest: refuse rather
  // than record a null digest, even when a supplied decoder is laxer.
  if (typeof envelope.resultSha256 !== "string" || !SHA256.test(envelope.resultSha256)) {
    return stop("unavailable", INSTALLED_OUTPUT_UNPARSED, {
      output: "docsfab-run-result",
      reason: "run-result-digest-invalid",
    });
  }
  const execution = envelope.execution;
  const runId = execution.runId;
  const recordPath = typeof execution.recordPath === "string" ? execution.recordPath : null;
  if (!runId || !recordPath) {
    return stop("unavailable", INSTALLED_OUTPUT_UNPARSED, {
      output: "docsfab-run-result",
      reason: "execution-fields-missing",
    });
  }
  const stateRoot = await realpath(context.stateDirectory).catch(() => null);
  const recordReal = await realpath(recordPath).catch(() => null);
  if (!stateRoot || !recordReal || !recordReal.startsWith(`${stateRoot}${sep}`)) {
    return stop("unavailable", "installed-record-unavailable", {
      output: "docsfab-run-result",
      runId,
    });
  }
  const recordBytes = await readFile(recordReal);
  let record;
  try {
    record = JSON.parse(recordBytes.toString("utf8"));
  } catch {
    return stop("unavailable", "installed-record-unavailable", {
      output: "docsfab-run-result",
      runId,
    });
  }
  const parsed = {
    output: "docsfab-run-result",
    runId,
    runStatus: typeof execution.status === "string" ? execution.status : null,
    resultSha256: envelope.resultSha256,
    recordPath: relative(stateRoot, recordReal).split(sep).join("/"),
    runRecordSha256: sha256(recordBytes),
  };
  if (
    !record ||
    typeof record !== "object" ||
    record.id !== runId ||
    record.workflow !== execution.workflow ||
    record.repository?.revision !== context.repositoryRevision ||
    (context.expectedWorkflow && record.workflow !== context.expectedWorkflow)
  ) {
    return stop("unavailable", "installed-record-identity-mismatch", parsed);
  }
  try {
    contracts.decodeSavedRunRecord(record, runId);
  } catch {
    return stop("unavailable", "installed-record-unavailable", parsed);
  }
  if (record.status !== execution.status) {
    return stop("unavailable", "installed-record-status-mismatch", {
      ...parsed,
      envelopeStatus: execution.status,
      recordStatus: record.status,
    });
  }
  const sourceBindingSha256 = optionalDigest(record.sourceBinding?.digest);
  let citations = null;
  if (record.sourceCitations !== undefined) {
    try {
      citations = contracts.decodeSourceRunCitations(record.sourceCitations);
    } catch {
      return stop("unavailable", "installed-record-citations-invalid", parsed);
    }
    if (citations.bindingSha256 !== sourceBindingSha256) {
      return stop("unavailable", "installed-record-citations-invalid", parsed);
    }
  }
  const status = record.status;
  let observedDisposition;
  if (status === "succeeded") {
    observedDisposition = sourceBindingSha256
      ? { status: "complete", reasonCode: "acquired" }
      : { status: "unavailable", reasonCode: "installed-source-binding-absent" };
  } else if (status === "needs-input" || status === "needs-human-decision") {
    observedDisposition = { status: "needs-input", reasonCode: `installed-run-${status}` };
  } else {
    observedDisposition = {
      status: "unavailable",
      reasonCode:
        status && REASON.test(status) ? `installed-run-${status}` : "installed-run-failed",
    };
  }
  const limitations = new Set();
  if (!citations) limitations.add("installed-record-citations-absent");
  if (observedDisposition.status !== "complete") limitations.add(observedDisposition.reasonCode);
  return {
    observedDisposition,
    runId,
    runRecordSha256: parsed.runRecordSha256,
    sourceBindingSha256,
    sourceEvidenceSha256: citations ? canonicalSha256(record.sourceCitations) : null,
    patchSha256: optionalDigest(execution.patchSha256),
    validationEvidenceSha256: record.qualityArtifactValidation
      ? canonicalSha256(record.qualityArtifactValidation)
      : null,
    modelProfileSha256:
      Array.isArray(record.models) && record.models.length > 0
        ? canonicalSha256(record.models)
        : null,
    factResults: factsFromCitations(contracts, context.expectedCase, context.factsById, citations),
    spanCitations: (citations?.steps ?? []).flatMap((step) => step.citations),
    limitations: [...limitations].sort(),
    parsed,
  };
}

/**
 * Derive an installed cell's disposition from what the CLI actually wrote.
 *
 * A `docsfab-run-result` envelope is followed to its run record under the
 * collector's own state directory; a `docsfab-operator-error` envelope
 * contributes its own code. The only translation is a `migration-required`
 * envelope that names the model profile, which becomes the declared
 * `installed-model-unconfigured` limitation. Anything else is
 * `installed-output-unparsed`. The exit code is recorded, never interpreted.
 */
export async function parseInstalledOutcome(contracts, invocation, context) {
  const base = {
    runId: null,
    runRecordSha256: null,
    sourceBindingSha256: null,
    sourceEvidenceSha256: null,
    patchSha256: null,
    validationEvidenceSha256: null,
    modelProfileSha256: null,
    factResults: unresolvedFacts(context.expectedCase),
    spanCitations: [],
  };
  const stop = (status, reasonCode, parsed, limitations = [reasonCode]) => ({
    ...base,
    observedDisposition: { status, reasonCode },
    limitations: [...new Set(limitations)].sort(),
    parsed,
  });
  if (invocation.limitStop) {
    return stop("unavailable", invocation.limitStop.refusal, {
      output: "limit-stop",
      limitStop: invocation.limitStop,
    });
  }
  const documents = [...jsonDocuments(invocation.stdout), ...jsonDocuments(invocation.stderr)];
  const result = documents.find((document) => document.kind === "docsfab-run-result");
  if (result) return parseRunResult(contracts, result, context, stop);
  const operatorError = documents.find((document) => document.kind === "docsfab-operator-error");
  if (operatorError) {
    const code =
      typeof operatorError.code === "string" && REASON.test(operatorError.code)
        ? operatorError.code
        : null;
    if (!code) {
      return stop("unavailable", INSTALLED_OUTPUT_UNPARSED, {
        output: "docsfab-operator-error",
        reason: "code-missing",
      });
    }
    const message = typeof operatorError.message === "string" ? operatorError.message : "";
    const reasonCode =
      code === "migration-required" && /model profile/iu.test(message)
        ? INSTALLED_MODEL_UNCONFIGURED
        : code;
    const denied = contracts.SOURCE_ACQUISITION_REFUSAL_CODES.includes(code);
    return stop(
      denied ? "denied" : "unavailable",
      reasonCode,
      { output: "docsfab-operator-error", operatorErrorCode: code, messageSha256: sha256(message) },
      denied ? [] : [reasonCode],
    );
  }
  return stop("unavailable", INSTALLED_OUTPUT_UNPARSED, {
    output: "unrecognized",
    documentKinds: documents.map((document) =>
      typeof document.kind === "string" ? document.kind : null,
    ),
  });
}

/**
 * The run identity a row's evidence carries when there is no trace to write
 * (installed and discovery cells). It repeats the row's declared identity, so
 * a row edited after collection contradicts it. The checker finds the record
 * by the `run` evidence kind, not by file name.
 */
function declaredRunIdentity(spec, outcome = null) {
  const runId = outcome?.runId ?? null;
  return {
    schemaVersion: 1,
    kind: DECLARED_RUN_RECORD_KIND,
    caseId: spec.caseId,
    entryPoint: spec.entryPoint,
    runId,
    runIdSha256: runId === null ? null : sha256(runId),
    bindingSha256: outcome?.sourceBindingSha256 ?? null,
    sourceEvidenceSha256: outcome?.sourceEvidenceSha256 ?? null,
  };
}

function installedIdentityEvidence(identity) {
  return {
    packageName: identity.packageName,
    packageVersion: identity.packageVersion,
    packageJsonSha256: identity.packageJsonSha256,
    cliSha256: identity.cliSha256,
    workflowSha256: identity.workflowSha256,
  };
}

function pendingInstalled(spec, expectedCase, limitation, evidenceRefs = []) {
  return {
    ...pendingRow(spec, expectedCase, [limitation], limitation),
    evidenceRefs: [...evidenceRefs].sort(byKey("path")),
  };
}

async function collectInstalledCase(input, bytes) {
  const { contracts, spec, expectedCase, factsById, installed, evidenceRoot } = input;
  const identity = installed.identity;
  if (spec.providerId === "gitlab") {
    const ref = await writeEvidence(evidenceRoot, spec.caseId, "installed.json", {
      ...declaredRunIdentity(spec),
      invoked: false,
      ...installedIdentityEvidence(identity),
      note: "Authenticated GitLab identity is host configuration. This collector does not embed a live merge-request selector or token.",
    });
    return pendingInstalled(spec, expectedCase, "gitlab-live-credentials-unconfigured", [
      { kind: "run", ...ref },
    ]);
  }
  if (spec.providerId !== "local" || !bytes || !spec.fixture) {
    return pendingInstalled(spec, expectedCase, "public-web-source-binding-unreleased");
  }
  if (spec.entryPoint === "live-agent") {
    // Piping stdin would record the terminal refusal as an outcome, so the
    // cell is not invoked and names the missing capability instead.
    const ref = await writeEvidence(evidenceRoot, spec.caseId, "installed.json", {
      ...declaredRunIdentity(spec),
      invoked: false,
      ...installedIdentityEvidence(identity),
      limitation: LIVE_AGENT_TERMINAL_LIMITATION,
      note: "docsfab live-agent requires an attached interactive terminal and has no non-interactive mode; this collector does not allocate a terminal.",
    });
    return pendingInstalled(spec, expectedCase, LIVE_AGENT_TERMINAL_LIMITATION, [
      { kind: "run", ...ref },
    ]);
  }
  const caseRoot = join(installed.workRoot, spec.caseId);
  const stateDirectory = join(caseRoot, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const sourcePath = `docs/${spec.fixture.split("/").pop()}`;
  const scratch = await createScratchRepository(caseRoot, "repository", { [sourcePath]: bytes });
  const repositoryRevision = await repositoryHead(scratch);
  // The installed binary takes the subcommand; the in-process parsers do not.
  const argv =
    spec.entryPoint === "do"
      ? ["do", ...doArgv(scratch, sourcePath)]
      : ["run", ...runArgv(scratch, sourcePath)];
  const started = Date.now();
  const invocation = await invokeInstalled(contracts, installed.cli, argv, {
    cwd: scratch,
    stateDirectory,
    configRoot: installed.configRoot,
  });
  const outcome = await parseInstalledOutcome(contracts, invocation, {
    stateDirectory,
    repositoryRevision,
    expectedWorkflow: spec.entryPoint === "do" ? null : "update-documentation",
    expectedCase,
    factsById,
  });
  const ref = await writeEvidence(evidenceRoot, spec.caseId, "installed.json", {
    ...declaredRunIdentity(spec, outcome),
    invoked: true,
    argv: portableArgv(argv, [installed.workRoot]),
    exitCode: invocation.code,
    signal: invocation.signal,
    elapsedMs: invocation.elapsedMs,
    stdoutSha256: sha256(invocation.stdout),
    stderrSha256: sha256(invocation.stderr),
    repositoryRevision,
    parsed: outcome.parsed,
    ...installedIdentityEvidence(identity),
  });
  // The same two records the in-process path persists, so one checker
  // verifies both paths.
  const identityRefs = [];
  if (outcome.sourceBindingSha256) {
    identityRefs.push({
      kind: "source-domain",
      ...(await writeEvidence(evidenceRoot, spec.caseId, "binding.json", {
        bindingSha256: outcome.sourceBindingSha256,
        limitations: outcome.limitations,
      })),
    });
    identityRefs.push({
      kind: "source-domain",
      ...(await writeEvidence(
        evidenceRoot,
        spec.caseId,
        "citations.json",
        citationLedger(spec.caseId, outcome.sourceBindingSha256, outcome.spanCitations),
      )),
    });
  }
  return {
    receiptId: spec.receiptId,
    caseId: spec.caseId,
    entryPoint: spec.entryPoint,
    executionMode: spec.executionMode,
    providerId: spec.providerId,
    expectedDisposition: spec.expectedDisposition,
    observedDisposition: outcome.observedDisposition,
    runId: outcome.runId,
    sourceInvocationId: null,
    runRecordSha256: outcome.runRecordSha256,
    sourceBindingSha256: outcome.sourceBindingSha256,
    sourceEvidenceSha256: outcome.sourceEvidenceSha256,
    patchSha256: outcome.patchSha256,
    validationEvidenceSha256: outcome.validationEvidenceSha256,
    modelProfileSha256: outcome.modelProfileSha256,
    oracleCaseSha256: oracleCaseSha256(spec, expectedCase),
    factResults: outcome.factResults,
    metrics: metricsFromFacts(expectedCase, outcome.factResults, {
      latencyMs: Date.now() - started,
    }),
    limitations: outcome.limitations,
    evidenceRefs: [{ kind: "run", ...ref }, ...identityRefs].sort(byKey("path")),
  };
}

export async function collectSourceAcquisition(options) {
  const [{ root, manifest, expectedFacts }, contracts, repositoryState] = await Promise.all([
    loadManifest(options.manifest),
    loadRuntimeContracts(),
    testedRepositoryState(),
  ]);
  let installed = null;
  if (options.installedCli) {
    if (options.installedExecutionAcknowledgment !== INSTALLED_ACK) {
      fail("installed-execution-not-acknowledged");
    }
    requireInstalledSourceEvidenceContracts(contracts);
    const cli = await realpath(options.installedCli).catch(() => fail("installed-cli-unavailable"));
    if (cli === repositoryRoot || cli.startsWith(`${repositoryRoot}${sep}`)) {
      fail("installed-cli-unavailable", "installed CLI must be outside the source checkout");
    }
    const identity = await installedCliIdentity(cli);
    installed = {
      cli,
      identity,
      workRoot: options.workRoot,
      configRoot: options.configRoot,
    };
  }
  const evidenceRoot = dirname(options.results);
  await mkdir(join(evidenceRoot, "source-acquisition-evidence"), { recursive: true, mode: 0o700 });
  const factsById = new Map(array(expectedFacts.facts).map((item) => [item.id, item]));
  const expectedById = new Map(array(expectedFacts.cases).map((item) => [item.caseId, item]));
  const scratchRoot = await mkdtemp(join(tmpdir(), "docsfab-source-acquisition-"));
  const scratchRoots = [scratchRoot, await realpath(scratchRoot)].sort(
    (left, right) => right.length - left.length,
  );
  const cases = [];
  try {
    for (const spec of array(manifest.cases)) {
      const expectedCase = expectedById.get(spec.caseId) ?? { facts: [] };
      cases.push(
        await collectCase({
          contracts,
          spec,
          expectedCase,
          factsById,
          corpusRoot: root,
          evidenceRoot,
          installed,
          scratchRoot,
          scratchRoots,
        }),
      );
    }
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
  cases.sort((left, right) => {
    const leftKey = `${left.receiptId}\0${left.caseId}\0${left.entryPoint}\0${left.executionMode}`;
    const rightKey = `${right.receiptId}\0${right.caseId}\0${right.entryPoint}\0${right.executionMode}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const body = {
    schemaVersion: 1,
    kind: "docsfab-source-acquisition-qualification",
    testedRevision: repositoryState.testedRevision,
    installedArtifactSha256: installed ? installed.identity.cliSha256 : null,
    manifestSha256: manifest.manifestSha256,
    expectedFactsSha256: expectedFacts.expectedFactsSha256,
    cases,
  };
  return { ...body, qualificationSha256: canonicalSha256(body) };
}

export async function writeResults(path, envelope) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  let handle;
  try {
    handle = await open(path, flags, 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      fail("qualification-output-exists");
    }
    fail(
      "qualification-output-path-invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    const info = await handle.stat();
    if (info.isSymbolicLink?.() || !info.isFile()) fail("qualification-output-path-invalid");
    await handle.writeFile(`${canonicalJson(envelope)}\n`, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const envelope = await collectSourceAcquisition(options);
  await writeResults(options.results, envelope);
  process.stdout.write(
    `${canonicalJson({ qualificationSha256: envelope.qualificationSha256, cases: envelope.cases.length })}\n`,
  );
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
