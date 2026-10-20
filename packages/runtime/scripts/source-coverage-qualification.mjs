#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Collect source-coverage-v1 qualification evidence.
 *
 * Deterministic mode exercises retained, explicitly fixture-only records. Installed
 * mode invokes the installed `docsfab run <workflow>` surface and then reads the
 * retained RunRecord and artifact store. This file defines no quality threshold,
 * run store, model credential, or provider authorization.
 */

import { internalContentPath } from "../src/config/internal-content.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const fixtureRoot = resolve(runtimeRoot, "test/fixtures/source-coverage-runner");
const trustedCorpusToolRoot = resolve(repositoryRoot, internalContentPath("sourceCoverageTools"));
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const INSTALLED_ACK = "source-coverage-v1-installed-execution";
const MAX_BUFFER = 16 * 1024 * 1024;
const WORKFLOW_BY_JOURNEY = Object.freeze({
  CREATE: "create-documentation",
  UPDATE: "update-documentation",
  REVIEW: "review-documentation",
});

export class SourceCoverageQualificationError extends Error {
  constructor(code, message = code) {
    super(`Source coverage qualification failed (${code}): ${message}.`);
    this.name = "SourceCoverageQualificationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SourceCoverageQualificationError(code, message);
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

function exact(value, keys, code = "invalid-record") {
  const actual = Object.keys(object(value, code)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function safeRelativePath(value, code = "unsafe-path") {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(code);
  }
  return value;
}

function within(root, child, code = "unsafe-path") {
  const target = resolve(root, child);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(code);
  return target;
}

function digest(value, code = "invalid-record") {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function identifier(value, code = "invalid-record") {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(code);
  return value;
}

function evidenceStatus(record, evidence, requested) {
  const fixtureModel = record.models.some(
    (model) => model.provider === "fixture" || model.model === "deterministic",
  );
  if (requested === "fixture-only") {
    if (!fixtureModel || evidence.fixtureId !== "source-coverage-runner-v1") {
      fail("fixture-evidence-invalid");
    }
    return "fixture-only";
  }
  if (fixtureModel || !evidence.installedIdentity) {
    fail("fixture-evidence-cannot-qualify-installed");
  }
  const identity = object(evidence.installedIdentity, "installed-identity-invalid");
  exact(
    identity,
    ["packageName", "packageVersion", "packageJsonSha256", "cliSha256", "workflowSha256"],
    "installed-identity-invalid",
  );
  if (
    identity.packageName !== "docsfab" ||
    typeof identity.packageVersion !== "string" ||
    !identity.packageVersion ||
    !SHA256.test(identity.packageJsonSha256) ||
    !SHA256.test(identity.cliSha256) ||
    !SHA256.test(identity.workflowSha256)
  ) {
    fail("installed-identity-invalid");
  }
  return "installed";
}

function usage() {
  return `DocsFab source coverage qualification (#830 collector, #839 matrix)

Deterministic fixture collection:
  node scripts/source-coverage-qualification.mjs --mode deterministic --corpus <source-coverage-v1>

v1 matrix collection (15 primary cells plus declared variants; writes report.json):
  node scripts/source-coverage-qualification.mjs --mode deterministic --matrix v1 \\
    --corpus <source-coverage-v1> --output /absolute/report-dir
  node scripts/source-coverage-qualification.mjs --mode installed --matrix v1 \\
    --corpus <source-coverage-v1> --output /absolute/report-dir

Installed live collection (invokes named workflows; the acknowledgment records
operator intent but grants no host/model authority or credentials):
  node scripts/source-coverage-qualification.mjs --mode installed --corpus <source-coverage-v1> \\
    --installed-cli /absolute/path/to/docsfab --work-root /absolute/private/path \\
    --acknowledge-installed-execution ${INSTALLED_ACK}
`;
}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (
      argument === "--mode" ||
      argument === "--corpus" ||
      argument === "--installed-cli" ||
      argument === "--work-root" ||
      argument === "--acknowledge-installed-execution" ||
      argument === "--matrix" ||
      argument === "--output"
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
  const mode = values.get("--mode");
  const corpus = values.get("--corpus");
  const matrix = values.get("--matrix") ?? null;
  const output = values.get("--output") ?? null;
  if (mode !== "deterministic" && mode !== "installed") {
    fail("invalid-arguments", "--mode must be deterministic or installed");
  }
  if (!corpus) fail("invalid-arguments", "--corpus is required");
  if (matrix !== null && matrix !== "v1") fail("invalid-arguments", "--matrix must be v1");
  if (output !== null && !isAbsolute(output))
    fail("invalid-arguments", "--output must be absolute");
  if (mode === "deterministic") {
    for (const key of ["--installed-cli", "--work-root", "--acknowledge-installed-execution"]) {
      if (values.has(key)) fail("invalid-arguments", `${key} is installed-mode only`);
    }
  } else {
    const liveRequested = [
      "--installed-cli",
      "--work-root",
      "--acknowledge-installed-execution",
    ].some((key) => values.has(key));
    if (liveRequested) {
      if (values.get("--acknowledge-installed-execution") !== INSTALLED_ACK) {
        fail(
          "installed-execution-not-acknowledged",
          `pass --acknowledge-installed-execution ${INSTALLED_ACK}`,
        );
      }
      for (const key of ["--installed-cli", "--work-root"]) {
        const value = values.get(key);
        if (!value || !isAbsolute(value)) fail("invalid-arguments", `${key} must be absolute`);
      }
    } else if (matrix !== "v1" || !output) {
      fail(
        "invalid-arguments",
        "installed mode requires --matrix v1 --output, or live --installed-cli/--work-root/--acknowledge-installed-execution",
      );
    }
  }
  return {
    help: false,
    mode,
    matrix,
    output: output ? resolve(output) : null,
    corpus: resolve(corpus),
    installedCli: values.get("--installed-cli") ?? null,
    workRoot: values.get("--work-root") ?? null,
    installedExecutionAcknowledgment: values.get("--acknowledge-installed-execution") ?? null,
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
        const [runs, quality, artifacts, inputs, structural, runResult, contractKit] =
          await Promise.all([
            import("../src/cli/commands/runs.ts"),
            import("../src/evaluation-report/index.ts"),
            import("../src/artifacts/index.ts"),
            import("../src/inputs/index.ts"),
            import("../src/delivery/structural-documentation-validator.ts"),
            import("../src/operator/run-result.ts"),
            import("../src/contract-kit/index.ts"),
          ]);
        const fixtureKit = contractKit.createContractKit({
          fail: (code) => fail(code),
          codes: {
            invalidShape: "fixture-invalid",
            invalidValue: "fixture-invalid",
            digestMismatch: "fixture-invalid",
            credentialMaterial: "fixture-invalid",
            schemaMismatch: "fixture-invalid",
          },
        });
        return {
          decodeSavedRunRecord: runs.decodeSavedRunRecord,
          decodeQualityValidationBinding: quality.decodeQualityValidationBinding,
          decodeQualityValidatorReceipt: quality.decodeQualityValidatorReceipt,
          parseQualityReportProjection: quality.parseQualityReportProjection,
          stageFinalQualityReport: quality.stageFinalQualityReport,
          loadStagedQualityArtifact: quality.loadStagedQualityArtifact,
          sealQualityValidationBinding: quality.sealQualityValidationBinding,
          sealQualityValidatorReceipt: quality.sealQualityValidatorReceipt,
          DurableArtifactStore: artifacts.DurableArtifactStore,
          decodeSourceEvidenceFinal:
            typeof artifacts.decodeSourceEvidenceFinal === "function"
              ? artifacts.decodeSourceEvidenceFinal
              : typeof inputs.decodeSourceEvidenceFinal === "function"
                ? inputs.decodeSourceEvidenceFinal
                : null,
          classifySourceMediaType:
            typeof inputs.classifySourceMediaType === "function"
              ? inputs.classifySourceMediaType
              : null,
          sourceExtractorAdapters: Array.isArray(inputs.DEFAULT_SOURCE_EXTRACTOR_ADAPTERS)
            ? inputs.DEFAULT_SOURCE_EXTRACTOR_ADAPTERS
            : [],
          decodeExternalInputAccessLedger: inputs.decodeExternalInputAccessLedger,
          decodeExternalInputCitationLedger: inputs.decodeExternalInputCitationLedger,
          validateStructuralDocumentation: structural.validateStructuralDocumentation,
          decodeRunResultV1: runResult.decodeRunResultV1,
          fixtureKit,
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

async function walkFiles(root, prefix = "") {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = within(root, name);
    if (entry.isSymbolicLink()) fail("corpus-integrity-invalid", `symlink ${name}`);
    if (entry.isDirectory()) files.push(...(await walkFiles(root, name)));
    else if (entry.isFile()) files.push({ name, path });
    else fail("corpus-integrity-invalid", `unsupported node ${name}`);
  }
  return files;
}

function fileMode(stat) {
  return (stat.mode & 0o100) === 0 ? "100644" : "100755";
}

export async function loadCorpus(corpusPath) {
  const root = await realpath(resolve(corpusPath)).catch(() => fail("corpus-unavailable"));
  let supplierReport;
  try {
    const { stdout } = await execute(
      "python3",
      [resolve(trustedCorpusToolRoot, "validate_corpus.py"), "--corpus", root, "--json"],
      {
        env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
        maxBuffer: MAX_BUFFER,
        timeout: 60_000,
      },
    );
    supplierReport = object(JSON.parse(stdout), "corpus-integrity-invalid");
  } catch (error) {
    if (error instanceof SourceCoverageQualificationError) throw error;
    fail(
      "corpus-integrity-invalid",
      error instanceof Error ? error.message : "trusted corpus validator rejected the corpus",
    );
  }
  const [manifestBytes, scenariosBytes, oracleBytes] = await Promise.all([
    readFile(within(root, "manifest.json")),
    readFile(within(root, "scenarios.json")),
    readFile(within(root, "oracles/expectations.json")),
  ]);
  let manifest;
  let scenariosFile;
  let oracle;
  try {
    manifest = object(JSON.parse(manifestBytes.toString("utf8")), "corpus-integrity-invalid");
    scenariosFile = object(JSON.parse(scenariosBytes.toString("utf8")), "corpus-integrity-invalid");
    oracle = object(JSON.parse(oracleBytes.toString("utf8")), "corpus-integrity-invalid");
  } catch (error) {
    if (error instanceof SourceCoverageQualificationError) throw error;
    fail("corpus-integrity-invalid", "invalid JSON");
  }
  if (manifest.schemaVersion !== 1 || manifest.id !== "source-coverage-v1") {
    fail("corpus-integrity-invalid", "unsupported manifest");
  }
  const { manifestSha256, ...manifestBody } = manifest;
  if (digest(manifestSha256, "corpus-integrity-invalid") !== canonicalSha256(manifestBody)) {
    fail("corpus-integrity-invalid", "manifest digest mismatch");
  }
  if (
    supplierReport.kind !== "docsfab-source-corpus-validation" ||
    supplierReport.corpusId !== manifest.id ||
    object(supplierReport.manifest, "corpus-integrity-invalid").sha256 !== manifestSha256 ||
    canonicalJson(array(supplierReport.primaryCells, "corpus-integrity-invalid")) !==
      canonicalJson(manifest.scenarios.map((scenario) => scenario.id)) ||
    canonicalJson(array(supplierReport.variants, "corpus-integrity-invalid")) !==
      canonicalJson(
        array(manifest.variants, "corpus-integrity-invalid").map((variant) => variant.id),
      )
  ) {
    fail("corpus-integrity-invalid", "trusted validator report does not bind the loaded matrix");
  }
  const discovered = await walkFiles(root);
  const ledger = new Map(
    array(manifest.files, "corpus-integrity-invalid").map((row) => {
      exact(row, ["path", "sha256", "mode"], "corpus-integrity-invalid");
      return [safeRelativePath(row.path, "corpus-integrity-invalid"), row];
    }),
  );
  for (const file of discovered) {
    if (file.name === "manifest.json") continue;
    const expected = ledger.get(file.name);
    if (!expected) fail("corpus-integrity-invalid", `undeclared file ${file.name}`);
    const [bytes, stat] = await Promise.all([readFile(file.path), lstat(file.path)]);
    if (sha256(bytes) !== expected.sha256 || fileMode(stat) !== expected.mode) {
      fail("corpus-integrity-invalid", `changed file ${file.name}`);
    }
    ledger.delete(file.name);
  }
  if (ledger.size > 0)
    fail("corpus-integrity-invalid", `missing file ${ledger.keys().next().value}`);
  if (canonicalJson(manifest.scenarios) !== canonicalJson(scenariosFile.scenarios)) {
    fail("corpus-integrity-invalid", "scenario projection mismatch");
  }
  const scenarios = array(manifest.scenarios, "corpus-integrity-invalid");
  const variants = array(manifest.variants, "corpus-integrity-invalid");
  const oracleScenarios = new Map(
    array(oracle.scenarios, "corpus-integrity-invalid").map((item) => [item.id, item]),
  );
  const oracleVariants = new Map(
    array(oracle.variants, "corpus-integrity-invalid").map((item) => [item.id, item]),
  );
  if (
    scenarios.length !== 15 ||
    scenarios.some(
      (scenario) => scenario.oracleId !== scenario.id || !oracleScenarios.has(scenario.id),
    )
  ) {
    fail("corpus-integrity-invalid", "primary scenario/oracle matrix mismatch");
  }
  if (variants.length !== 11 || variants.some((variant) => !oracleVariants.has(variant.id))) {
    fail("corpus-integrity-invalid", "variant/oracle matrix mismatch");
  }
  return {
    root,
    manifest,
    scenarios,
    variants,
    oracle,
    oracleScenarios,
    oracleVariants,
    routes: new Map(array(oracle.routes).map((item) => [item.id, item])),
    facts: new Map(array(oracle.facts).map((item) => [item.id, item])),
  };
}

async function materializeScenario(corpus, scenario, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  let receipt;
  try {
    const { stdout } = await execute(
      "python3",
      [
        resolve(trustedCorpusToolRoot, "materialize_fixture.py"),
        "--corpus",
        corpus.root,
        "--scenario",
        scenario.id,
        "--destination",
        destination,
      ],
      {
        env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
        maxBuffer: MAX_BUFFER,
        timeout: 60_000,
      },
    );
    receipt = object(JSON.parse(stdout), "corpus-materialization-invalid");
  } catch (error) {
    if (error instanceof SourceCoverageQualificationError) throw error;
    fail("corpus-materialization-invalid", error instanceof Error ? error.message : scenario.id);
  }
  exact(
    receipt,
    ["kind", "schemaVersion", "scenarioId", "manifestSha256", "fileLedgerSha256"],
    "corpus-materialization-invalid",
  );
  if (
    receipt.kind !== "docsfab-source-corpus-materialization" ||
    receipt.schemaVersion !== 1 ||
    receipt.scenarioId !== scenario.id ||
    receipt.manifestSha256 !== corpus.manifest.manifestSha256 ||
    !SHA256.test(receipt.fileLedgerSha256)
  ) {
    fail("corpus-materialization-invalid", scenario.id);
  }
}

function headingFor(path) {
  if (path.endsWith(".rst")) return "Atlas Queue\n===========\n";
  if (path.endsWith(".yml") || path.endsWith(".yaml") || path.endsWith(".js")) return "";
  return "# Atlas Queue\n";
}

async function addFixtureOutputs(root, oracleScenario, scenario) {
  for (const output of array(oracleScenario.outputs)) {
    const path = within(root, safeRelativePath(output.path));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let current = await readFile(path, "utf8").catch(() => "");
    const additions = array(output.requiredText).filter(
      (text) => typeof text === "string" && !current.includes(text),
    );
    if (!current && additions.length > 0) current = headingFor(output.path);
    if (additions.length > 0) {
      if (output.path === "fern/docs.yml") {
        current +=
          "      - page: Tutorial\n        path: pages/tutorial.mdx\n        slug: tutorial\n";
      } else if (output.path === "mkdocs.yml") {
        current += "      - Tutorial: tutorial.md\n";
      } else if (output.path === "sidebars.js") {
        current += "// tutorial\n";
      } else if (output.path === "manual/index.rst") {
        current += "   tutorial\n";
      } else {
        current += `${current.endsWith("\n") ? "" : "\n"}${additions.join("\n")}\n`;
      }
    }
    if (!current) current = "# fixture output\n";
    await writeFile(path, current, { mode: 0o600 });
  }
}

async function replaceRequired(root, path, before, after) {
  const target = within(root, safeRelativePath(path));
  const current = await readFile(target, "utf8");
  if (!current.includes(before)) fail("fixture-invalid", `mutation preimage absent in ${path}`);
  await writeFile(target, current.replace(before, after), { mode: 0o600 });
}

async function readCandidateFile(root, relativePath, missingCode) {
  const path = within(root, safeRelativePath(relativePath));
  const metadata = await lstat(path).catch(() => fail(missingCode, relativePath));
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("unsafe-candidate-path", relativePath);
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path).catch(() => fail(missingCode, relativePath));
  const rel = relative(canonicalRoot, canonicalPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("unsafe-candidate-path", relativePath);
  }
  return readFile(canonicalPath, "utf8");
}

function validQualityMarkdown(revision, paths, artifactIds) {
  const summary = {
    report_contract: "docsfab-quality-report-v0.1",
    target: { paths, repository_revision: revision, documentation_revision: revision },
    profile: { id: "docsfab-documentation-quality", version: "v0.1" },
    evaluation: { decision: "insufficient-evidence", confidence: 1, hard_gate_failures: [] },
    rubric: {
      status: "unavailable",
      reason: "Deterministic source-coverage fixture has no selected quality rubric.",
    },
    validation: { evaluation: "passed", quality_score: "unavailable", report_binding: "passed" },
    artifact_locators: {
      evaluation: `record:sha256:${artifactIds.evaluation}`,
      quality_score: null,
      quality_report: `record:sha256:${artifactIds.report}`,
    },
  };
  return `# Fixture quality report\n\n## Validated result summary\n\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\`\n`;
}

function fixtureSourceEvidence(contracts, runId, revision, facts, mutation) {
  const runIdSha256 = sha256(runId);
  const repository = { identitySha256: sha256("/fixture/source-coverage-v1"), revision };
  const observations = facts
    .map((fact, index) =>
      contracts.fixtureKit.seal("docsfab-external-input-access-observation", "observationSha256", {
        inputId: `fact:${fact.id}`,
        stepId: "verify-technical-accuracy",
        outcome: "opened",
        observedContentDigestSha256: sha256(JSON.stringify(fact.value)),
        accessorId: "fixture-source-reader",
        evidenceSha256s: [sha256(fact.source)],
        observedAt: `2026-09-14T00:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    )
    .sort((left, right) => left.observationSha256.localeCompare(right.observationSha256));
  const accessLedger = contracts.fixtureKit.seal(
    "docsfab-external-input-access-ledger",
    "ledgerSha256",
    {
      runIdSha256,
      repository,
      observations,
    },
  );
  const citations = facts
    .map((fact, index) =>
      contracts.fixtureKit.seal("docsfab-external-input-citation", "citationSha256", {
        inputId: `fact:${fact.id}`,
        stepId: "verify-technical-accuracy",
        role: "evidence",
        supportedClaimSha256: contracts.fixtureKit.canonicalDigest({
          id: fact.id,
          statement: fact.statement,
        }),
        accessObservationSha256: observations.find((entry) => entry.inputId === `fact:${fact.id}`)
          .observationSha256,
        entrySha256: sha256(`entry:${fact.id}`),
        sourceKind: "repository-document",
        versionDigestSha256: sha256(`${revision}:${fact.source}`),
        disclosurePolicy: "cite-and-quote",
      }),
    )
    .sort((left, right) => left.citationSha256.localeCompare(right.citationSha256));
  const reconciliation = facts
    .map((fact) => ({
      inputId: `fact:${fact.id}`,
      state: "accessed-and-used",
      lifecycleState: "cited",
      citationCount: 1,
      accessCount: 1,
    }))
    .sort((left, right) => left.inputId.localeCompare(right.inputId));
  const citationLedger = contracts.fixtureKit.seal(
    "docsfab-external-input-citation-ledger",
    "ledgerSha256",
    {
      runIdSha256,
      repository,
      citations,
      diagnostics: [],
      reconciliation,
    },
  );
  if (mutation === "fabricated-citation") {
    const tampered = structuredClone(citationLedger);
    tampered.citations[0].citationSha256 = "0".repeat(64);
    return { accessLedger, citationLedger: tampered };
  }
  return { accessLedger, citationLedger };
}

function validatorReceipt(contracts, validator, inputs) {
  return contracts.sealQualityValidatorReceipt({
    validator,
    program: "python3",
    scriptSha256: sha256(`validator:${validator}`),
    inputPayloadSha256s: inputs,
    outcome: "passed",
    exitCode: 0,
    stdoutSha256: sha256("passed"),
    stderrSha256: sha256(""),
  });
}

async function fixtureRecord(contracts, scenario, oracleScenario, artifactStore, mutation) {
  const runId = `fixture-${scenario.id}`;
  const revision = sha256(`revision:${scenario.id}`).slice(0, 40);
  const expectedPaths = [...scenario.expectedOutputPaths];
  const artifactIds = {
    evaluation: sha256(`${runId}:evaluation`),
    score: sha256(`${runId}:score`),
    report: sha256(`${runId}:report`),
  };
  let markdown = validQualityMarkdown(revision, expectedPaths, artifactIds);
  if (mutation === "malformed-quality-report") markdown = "# malformed fixture report\n";
  const staged = await contracts.stageFinalQualityReport({
    store: artifactStore,
    reportMarkdown: markdown,
    bindings: {
      runId,
      repositoryRevision: revision,
      selectionSha256: sha256(`${runId}:selection`),
      evaluatorIdentitySha256: sha256(`${runId}:evaluator`),
      qualityPackBindingSha256: sha256("fixture-quality-pack"),
    },
  });
  const evaluationPayload = sha256(`${runId}:evaluation-payload`);
  const profilePayload = sha256("fixture-profile");
  const qualityArtifactValidation = contracts.sealQualityValidationBinding({
    runId,
    repositoryRevision: revision,
    selectionSha256: sha256(`${runId}:selection`),
    qualityPackBindingSha256: sha256("fixture-quality-pack"),
    evaluatorIdentitySha256: sha256(`${runId}:evaluator`),
    status: "passed",
    failureCode: null,
    artifacts: {
      evaluation: { recordSha256: artifactIds.evaluation, payloadSha256: evaluationPayload },
      qualityScore: null,
      candidateReport: staged.binding,
      finalReport: staged.binding,
    },
    validatorAssets: {
      evaluationScriptSha256: sha256("validator:evaluation"),
      evaluationSchemaSha256: sha256("schema:evaluation"),
      qualityScoreScriptSha256: sha256("validator:quality-score"),
      reportScriptSha256: sha256("validator:report-binding"),
    },
    validators: {
      evaluation: validatorReceipt(contracts, "evaluation", [
        evaluationPayload,
        sha256("schema:evaluation"),
        profilePayload,
      ]),
      qualityScore: null,
      reportBinding: validatorReceipt(contracts, "report-binding", [
        evaluationPayload,
        staged.binding.payloadSha256,
        profilePayload,
      ]),
    },
  });
  const writeJourney = scenario.journey !== "REVIEW";
  const writePaths = mutation === "bootstrap-only" ? [".docsfab.json"] : expectedPaths;
  const sourceBindings = expectedPaths.map((path) => ({
    pagePath: path,
    sources: [...scenario.requiredFactIds].map((id) => `fact:${id}`),
  }));
  const planBody = {
    kind: "docsfab-documentation-plan-binding",
    schemaVersion: 1,
    mode: scenario.journey === "CREATE" ? "create" : "update",
    pages: expectedPaths.map((path) => ({
      path,
      disposition: scenario.journey === "CREATE" ? "create" : "update",
    })),
    sourceBindings,
  };
  const planBinding = { ...planBody, digest: canonicalSha256(planBody) };
  const steps = [
    ...(writeJourney
      ? [
          {
            id: "plan-documentation",
            skill: "plan-documentation",
            status: "succeeded",
            planBinding,
          },
          ...(mutation === "writer-absent"
            ? []
            : [
                {
                  id: "write-documentation",
                  skill: "write-documentation",
                  status: "succeeded",
                  planBinding,
                },
              ]),
        ]
      : []),
    { id: "lint-documentation", skill: "lint-documentation", status: "succeeded" },
    { id: "verify-technical-accuracy", skill: "verify-technical-accuracy", status: "succeeded" },
    {
      id: "evaluate-document-quality",
      skill: "evaluate-document-quality",
      status: "succeeded",
      summary: markdown,
    },
  ];
  const record = {
    schemaVersion: 2,
    id: runId,
    workflow: WORKFLOW_BY_JOURNEY[scenario.journey],
    repository: { sourcePath: "/fixture/source-coverage-v1", requestedRevision: "HEAD", revision },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-14T00:00:00.000Z",
    models: [{ provider: "fixture", model: "deterministic" }],
    skills: [],
    qualityArtifactValidation,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    changes: {
      files: writePaths.map((path) => ({
        path,
        status: path === ".docsfab.json" ? "added" : "modified",
      })),
      patch: {
        sha256: sha256(`${runId}:patch`),
        byteLength: 1,
        lineCount: 1,
        artifactPath: `/fixture/${runId}.patch`,
        format: "git-diff",
      },
    },
    steps,
  };
  const facts = scenario.requiredFactIds.map((id) => object(contracts.__corpus.facts.get(id)));
  const sourceEvidence = fixtureSourceEvidence(contracts, runId, revision, facts, mutation);
  return {
    record,
    markdown,
    staged,
    sourceEvidence,
    fixtureId: "source-coverage-runner-v1",
  };
}

async function validateLocalLinks(root, changedPaths) {
  const markup = changedPaths.filter((path) => /\.(?:md|mdx)$/u.test(path));
  const link = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu;
  for (const path of markup) {
    const source = await readCandidateFile(root, path, "documentation-output-absent");
    for (const match of source.matchAll(link)) {
      const target = match[1];
      if (!target || /^(?:[a-z]+:|#|\/)/iu.test(target)) continue;
      const [file, anchor] = target.split("#", 2);
      const targetPath = resolve(dirname(within(root, path)), decodeURIComponent(file));
      const rel = relative(root, targetPath);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        fail("unresolved-link", `${path} -> ${target}`);
      }
      let targetText = null;
      for (const candidate of [
        targetPath,
        `${targetPath}.md`,
        `${targetPath}.mdx`,
        `${targetPath}.rst`,
      ]) {
        const candidateRelative = relative(root, candidate).split(sep).join("/");
        targetText = await readCandidateFile(root, candidateRelative, "unresolved-link").catch(
          (error) => {
            if (
              error instanceof SourceCoverageQualificationError &&
              error.code === "unresolved-link"
            ) {
              return null;
            }
            throw error;
          },
        );
        if (targetText !== null) break;
      }
      if (targetText === null) fail("unresolved-link", `${path} -> ${target}`);
      if (anchor) {
        const normalized = anchor.toLowerCase();
        const heading = new RegExp(`^#{1,6}\\s+.*${normalized.replaceAll("-", "[ -]")}.*$`, "imu");
        if (!heading.test(targetText) && !targetText.includes(`(${anchor})=`)) {
          fail("unresolved-anchor", `${path} -> ${target}`);
        }
      }
    }
  }
}

async function qualifyCandidate(input) {
  const { contracts, corpus, scenario, oracleScenario, candidateRoot, evidence, artifactStore } =
    input;
  const record = contracts.decodeSavedRunRecord(evidence.record, evidence.record.id);
  const authenticatedEvidenceStatus = evidenceStatus(record, evidence, input.requiredProvenance);
  if (record.status !== "succeeded" || record.workflow !== WORKFLOW_BY_JOURNEY[scenario.journey]) {
    fail("run-not-succeeded");
  }
  const writer = record.steps.find(
    (step) =>
      step.id === "write-documentation" &&
      step.skill === "write-documentation" &&
      step.status === "succeeded",
  );
  if (scenario.journey !== "REVIEW" && !writer) fail("writer-absent");
  const changed = array(record.changes?.files).map((file) => safeRelativePath(object(file).path));
  const expected = new Set(scenario.expectedOutputPaths);
  if (scenario.expectedOutputPaths.some((path) => !changed.includes(path))) {
    fail("documentation-output-absent");
  }
  if (changed.some((path) => !expected.has(path))) fail("outside-output-paths");
  if (scenario.journey !== "REVIEW") {
    const plan = object(writer.planBinding);
    const bindings = array(plan.sourceBindings);
    if (
      scenario.expectedOutputPaths.some(
        (path) =>
          !bindings.some(
            (binding) => binding.pagePath === path && array(binding.sources).length > 0,
          ),
      )
    ) {
      fail("source-binding-absent");
    }
  }
  let accessLedger;
  let citationLedger;
  try {
    accessLedger = contracts.decodeExternalInputAccessLedger(evidence.sourceEvidence.accessLedger);
    citationLedger = contracts.decodeExternalInputCitationLedger(
      evidence.sourceEvidence.citationLedger,
    );
  } catch {
    fail("citation-integrity-invalid");
  }
  const expectedRunIdSha256 = sha256(record.id);
  const expectedRepositoryIdentitySha256 = sha256(record.repository.sourcePath);
  if (
    accessLedger.runIdSha256 !== expectedRunIdSha256 ||
    citationLedger.runIdSha256 !== expectedRunIdSha256 ||
    accessLedger.repository.identitySha256 !== expectedRepositoryIdentitySha256 ||
    citationLedger.repository.identitySha256 !== expectedRepositoryIdentitySha256 ||
    accessLedger.repository.revision !== record.repository.revision ||
    citationLedger.repository.revision !== record.repository.revision
  ) {
    fail("citation-run-mismatch");
  }
  const observations = new Map(
    accessLedger.observations.map((observation) => [observation.observationSha256, observation]),
  );
  for (const citation of citationLedger.citations) {
    const observation = observations.get(citation.accessObservationSha256);
    if (
      !observation ||
      observation.inputId !== citation.inputId ||
      observation.stepId !== citation.stepId ||
      observation.outcome !== "opened"
    ) {
      fail("citation-integrity-invalid");
    }
  }
  const claims = new Set(citationLedger.citations.map((citation) => citation.supportedClaimSha256));
  for (const factId of scenario.requiredFactIds) {
    const fact = corpus.facts.get(factId);
    if (
      !fact ||
      !claims.has(contracts.fixtureKit.canonicalDigest({ id: fact.id, statement: fact.statement }))
    ) {
      fail("fabricated-citation");
    }
  }
  const binding = contracts.decodeQualityValidationBinding(record.qualityArtifactValidation);
  if (
    binding.status !== "passed" ||
    binding.runId !== record.id ||
    !binding.artifacts.finalReport
  ) {
    fail("quality-validation-not-passed");
  }
  for (const receipt of Object.values(binding.validators).filter(Boolean)) {
    if (contracts.decodeQualityValidatorReceipt(receipt).outcome !== "passed") {
      fail("quality-validation-not-passed");
    }
  }
  const finalArtifact = await contracts.loadStagedQualityArtifact(
    artifactStore,
    binding.artifacts.finalReport.recordSha256,
  );
  if (finalArtifact.payloadSha256 !== binding.artifacts.finalReport.payloadSha256) {
    fail("quality-artifact-invalid");
  }
  try {
    contracts.parseQualityReportProjection(finalArtifact.payload, {
      repositoryRevision: record.repository.revision,
      patchSha256: record.changes?.patch?.sha256 ?? null,
    });
  } catch {
    fail("quality-report-invalid");
  }
  for (const output of oracleScenario.outputs) {
    const text = await readCandidateFile(candidateRoot, output.path, "documentation-output-absent");
    if (output.requiredText.some((required) => !text.includes(required)))
      fail("missing-required-text");
  }
  for (const preserved of oracleScenario.preservedFacts) {
    const text = await readCandidateFile(candidateRoot, preserved.path, "missing-required-text");
    if (!text.includes(preserved.contains)) fail("missing-required-text");
  }
  for (const routeId of scenario.requiredRouteIds) {
    const route = corpus.routes.get(routeId);
    if (!route) fail("corpus-integrity-invalid");
    const text = await readCandidateFile(candidateRoot, route.path, "unresolved-link");
    if (!text.includes(route.anchorMarker)) fail("unresolved-anchor");
    if (route.navigation) {
      const navigation = await readCandidateFile(
        candidateRoot,
        route.navigation.path,
        "missing-navigation-entry",
      );
      if (!navigation.includes(route.navigation.entry)) fail("missing-navigation-entry");
    }
  }
  await validateLocalLinks(candidateRoot, changed);
  if (scenario.configuration === "fern" || scenario.configuration === "plain-markdown") {
    try {
      await contracts.validateStructuralDocumentation(candidateRoot, changed);
    } catch (error) {
      const check = error && typeof error === "object" && "check" in error ? error.check : null;
      fail(
        check === "documentation-relative-links"
          ? "unresolved-link"
          : "structural-validation-failed",
        `${scenario.id}: ${error instanceof Error ? error.message : "validator rejected candidate"}`,
      );
    }
  }
  return {
    scenarioId: scenario.id,
    configuration: scenario.configuration,
    journey: scenario.journey,
    status: "passed",
    evidenceStatus: authenticatedEvidenceStatus,
    recordId: record.id,
    artifactIds: {
      qualityReport: binding.artifacts.finalReport.recordSha256,
      accessLedger: accessLedger.ledgerSha256,
      citationLedger: citationLedger.ledgerSha256,
    },
    ...(authenticatedEvidenceStatus === "installed"
      ? { installedIdentity: evidence.installedIdentity }
      : {}),
  };
}

async function applyNegative(root, oracleScenario, negative) {
  if (negative.mutation === "missing-required-text") {
    const mutation = oracleScenario.mutations.find((item) => item.kind === "missing-required-text");
    await replaceRequired(root, mutation.path, mutation.before, mutation.after);
  } else if (negative.mutation === "bad-link") {
    const path = oracleScenario.outputs[0].path;
    const target = within(root, path);
    await writeFile(target, `${await readFile(target, "utf8")}\n[missing](missing.md)\n`);
  } else if (negative.mutation === "bad-anchor") {
    const mutation = oracleScenario.mutations.find((item) => item.kind === "broken-link-anchor");
    await replaceRequired(root, mutation.path, mutation.before, mutation.after);
  } else if (negative.mutation === "navigation-deletion") {
    const mutation = oracleScenario.mutations.find(
      (item) => item.kind === "deleted-navigation-entry",
    );
    await replaceRequired(root, mutation.path, mutation.before, mutation.after);
  } else if (negative.mutation === "symlink-output") {
    const output = oracleScenario.outputs[0].path;
    const target = within(root, output);
    const outside = join(dirname(root), `${negative.id}-outside.md`);
    await writeFile(outside, await readFile(target), { mode: 0o600 });
    await unlink(target);
    await symlink(outside, target);
  } else if (
    ![
      "writer-absent",
      "bootstrap-only",
      "config-escape",
      "fabricated-citation",
      "malformed-quality-report",
      "fake-installed-evidence",
      "swapped-ledger",
    ].includes(negative.mutation)
  ) {
    fail("fixture-invalid", `unknown negative mutation ${negative.mutation}`);
  }
}

async function loadFixtureManifest() {
  const path = within(fixtureRoot, "records.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  exact(value, ["schemaVersion", "kind", "knownGoodScenarioIds", "negativeRecords"]);
  if (value.schemaVersion !== 1 || value.kind !== "docsfab-source-coverage-runner-fixtures") {
    fail("fixture-invalid");
  }
  return value;
}

async function deterministicCollection(corpus, contracts) {
  const fixture = await loadFixtureManifest();
  const declared = array(fixture.knownGoodScenarioIds);
  if (
    declared.length !== corpus.scenarios.length ||
    corpus.scenarios.some((scenario) => !declared.includes(scenario.id))
  ) {
    fail("fixture-invalid", "known-good matrix does not cover the corpus");
  }
  contracts.__corpus = corpus;
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "docsfab-source-coverage-")));
  const artifactStore = new contracts.DurableArtifactStore(join(temporary, "artifacts"));
  const cells = [];
  for (const scenario of corpus.scenarios) {
    const candidateRoot = join(temporary, "positive", scenario.id);
    const oracleScenario = corpus.oracleScenarios.get(scenario.id);
    await materializeScenario(corpus, scenario, candidateRoot);
    await addFixtureOutputs(candidateRoot, oracleScenario, scenario);
    const evidence = await fixtureRecord(contracts, scenario, oracleScenario, artifactStore, null);
    cells.push(
      await qualifyCandidate({
        contracts,
        corpus,
        scenario,
        oracleScenario,
        candidateRoot,
        evidence,
        artifactStore,
        requiredProvenance: "fixture-only",
      }),
    );
  }
  const negativeControls = [];
  for (const negative of array(fixture.negativeRecords)) {
    exact(negative, ["id", "scenarioId", "mutation", "expectedCondition"]);
    const scenario = corpus.scenarios.find((item) => item.id === negative.scenarioId);
    const oracleScenario = corpus.oracleScenarios.get(negative.scenarioId);
    if (!scenario || !oracleScenario)
      fail("fixture-invalid", `unknown scenario ${negative.scenarioId}`);
    const candidateRoot = join(temporary, "negative", negative.id);
    await materializeScenario(corpus, scenario, candidateRoot);
    await addFixtureOutputs(candidateRoot, oracleScenario, scenario);
    await applyNegative(candidateRoot, oracleScenario, negative);
    const recordMutation =
      negative.mutation === "config-escape"
        ? "config-escape"
        : negative.mutation === "fake-installed-evidence"
          ? null
          : negative.mutation;
    const evidence = await fixtureRecord(
      contracts,
      scenario,
      oracleScenario,
      artifactStore,
      recordMutation,
    );
    if (negative.mutation === "config-escape") {
      evidence.record.changes.files.push({ path: "evidence/settings.json", status: "modified" });
    }
    if (negative.mutation === "swapped-ledger") {
      const otherRunId = "fixture-plain-markdown-create";
      const otherRevision = sha256("revision:plain-markdown-create").slice(0, 40);
      const facts = scenario.requiredFactIds.map((id) => object(corpus.facts.get(id)));
      evidence.sourceEvidence = fixtureSourceEvidence(
        contracts,
        otherRunId,
        otherRevision,
        facts,
        null,
      );
    }
    let observed = "no-failure";
    try {
      await qualifyCandidate({
        contracts,
        corpus,
        scenario,
        oracleScenario,
        candidateRoot,
        evidence,
        artifactStore,
        requiredProvenance:
          negative.mutation === "fake-installed-evidence" ? "installed" : "fixture-only",
      });
    } catch (error) {
      observed =
        error instanceof SourceCoverageQualificationError ? error.code : "unexpected-error";
    }
    if (observed !== negative.expectedCondition) {
      fail(
        "negative-control-mismatch",
        `${negative.id} expected ${negative.expectedCondition}, got ${observed}`,
      );
    }
    negativeControls.push({
      id: negative.id,
      recordId: evidence.record.id,
      expectedCondition: negative.expectedCondition,
      observedCondition: observed,
      status: "passed",
    });
  }
  return { cells, negativeControls };
}

export function buildInstalledInvocation(scenario, executable, repositoryPath, revision) {
  const workflow = WORKFLOW_BY_JOURNEY[scenario.journey];
  if (!workflow) fail("corpus-integrity-invalid", `unknown journey ${scenario.journey}`);
  const argv = ["run", workflow, "--repo", repositoryPath, "--revision", revision, "--json"];
  if (scenario.journey !== "REVIEW") {
    argv.push(
      "--instruction",
      `Complete source-coverage-v1 scenario ${scenario.id}. Restrict documentation changes to: ${scenario.expectedOutputPaths.join(", ")}.`,
      "--patch-only",
      "--allow-write",
    );
  }
  return { executable, argv };
}

async function installedCliIdentity(cli, workflow) {
  const packageRoot = resolve(dirname(cli), "..");
  const packageJsonPath = resolve(packageRoot, "package.json");
  const workflowPath = resolve(packageRoot, "workflows", `${workflow}.json`);
  const [packageJsonBytes, cliBytes, workflowBytes] = await Promise.all([
    readFile(packageJsonPath),
    readFile(cli),
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
    packageJson.bin?.docsfab !== "./bin/docsfab.mjs" ||
    (await realpath(resolve(packageRoot, packageJson.bin.docsfab))) !== cli
  ) {
    fail("installed-identity-invalid");
  }
  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    packageJsonSha256: sha256(packageJsonBytes),
    cliSha256: sha256(cliBytes),
    workflowSha256: sha256(workflowBytes),
  };
}

async function git(cwd, argv) {
  return execute("git", argv, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: MAX_BUFFER,
    timeout: 30_000,
  });
}

async function initializeFixtureRepository(root) {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "DocsFab source coverage"]);
  await git(root, ["config", "user.email", "source-coverage@example.invalid"]);
  await git(root, ["config", "commit.gpgSign", "false"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "source coverage fixture"]);
  return (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
}

function scrubbedChildEnvironment() {
  const admitted =
    /^(?:PATH|HOME|TMPDIR|LANG|LC_[A-Z_]+|TERM|NO_COLOR|NODE_[A-Z_]+|SSL_CERT_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|DOCSFAB_[A-Z_]+|OPENAI_[A-Z_]+|ANTHROPIC_[A-Z_]+|NVIDIA_[A-Z_]+)$/u;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && admitted.test(key)),
  );
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export async function validateInstalledRunLocators(result, record, stateDirectory) {
  await validateInstalledRecordLocator(result, stateDirectory);
  const runId = identifier(result.execution.runId, "installed-run-result-invalid");
  const patchPath = result.execution.patchPath;
  const recordPatch = record.changes?.patch ?? null;
  if ((patchPath === null) !== (recordPatch === null)) fail("installed-run-patch-mismatch");
  if (patchPath !== null) {
    const expectedPatchPath = resolve(dirname(stateDirectory), "patches", `${runId}.patch`);
    if (
      resolve(patchPath) !== expectedPatchPath ||
      recordPatch.artifactPath !== expectedPatchPath ||
      result.execution.patchSha256 !== recordPatch.sha256
    ) {
      fail("installed-run-patch-mismatch");
    }
    await assertRegularContainedPath(
      resolve(stateDirectory, "../../.."),
      expectedPatchPath,
      "installed-run-patch-mismatch",
    );
    if (sha256(await readFile(expectedPatchPath)) !== recordPatch.sha256) {
      fail("installed-run-patch-mismatch");
    }
  }
}

async function assertRegularContainedPath(boundary, path, code) {
  const lexicalBoundary = resolve(boundary);
  const lexicalPath = resolve(path);
  const lexicalRelative = relative(lexicalBoundary, lexicalPath);
  if (
    !lexicalRelative ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    fail(code);
  }
  let current = lexicalBoundary;
  const boundaryMetadata = await lstat(current).catch(() => fail(code));
  if (!boundaryMetadata.isDirectory() || boundaryMetadata.isSymbolicLink()) fail(code);
  const parts = lexicalRelative.split(sep);
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const metadata = await lstat(current).catch(() => fail(code));
    if (metadata.isSymbolicLink()) fail(code);
    if (index === parts.length - 1 ? !metadata.isFile() : !metadata.isDirectory()) fail(code);
  }
  const [canonicalBoundary, canonicalPath] = await Promise.all([
    realpath(lexicalBoundary).catch(() => fail(code)),
    realpath(lexicalPath).catch(() => fail(code)),
  ]);
  const canonicalRelative = relative(canonicalBoundary, canonicalPath);
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative)
  ) {
    fail(code);
  }
}

export async function validateInstalledRecordLocator(result, stateDirectory) {
  const runId = identifier(result.execution.runId, "installed-run-result-invalid");
  const expectedRecordPath = resolve(stateDirectory, `${runId}.json`);
  if (resolve(result.execution.recordPath) !== expectedRecordPath) {
    fail("installed-run-record-location-invalid");
  }
  await assertRegularContainedPath(
    resolve(stateDirectory, "../../.."),
    expectedRecordPath,
    "installed-run-record-location-invalid",
  );
}

export async function materializeInstalledCandidate(result, record, candidateRoot) {
  if (result.execution.patchPath === null) return;
  try {
    await git(candidateRoot, ["apply", "--check", result.execution.patchPath]);
    await git(candidateRoot, ["apply", result.execution.patchPath]);
  } catch {
    fail("installed-run-patch-mismatch");
  }
  const actual = (await git(candidateRoot, ["diff", "--name-only", "HEAD", "--"])).stdout
    .split("\n")
    .filter(Boolean)
    .sort();
  const declared = array(record.changes?.files)
    .map((file) => safeRelativePath(object(file).path))
    .sort();
  if (canonicalJson(actual) !== canonicalJson(declared)) fail("installed-run-patch-mismatch");
}

export function requireInstalledSourceEvidenceContracts(contracts) {
  if (typeof contracts.decodeSourceEvidenceFinal !== "function") {
    fail(
      "installed-source-evidence-contract-unavailable",
      "the current runtime has no SourceEvidenceFinalV1 decoder; installed execution was not started",
    );
  }
}

async function loadInstalledSourceEvidence(contracts, artifactStore, record) {
  requireInstalledSourceEvidenceContracts(contracts);
  const uses = record.steps.flatMap((step) => step.artifacts ?? []);
  const finalUses = uses.filter(
    (use) => use.reference?.schemaVersion === 2 && use.reference.kind === "source-evidence-final",
  );
  if (finalUses.length !== 1) fail("installed-source-evidence-absent");
  const reference = finalUses[0].reference;
  if (
    reference.repositoryRevision !== record.repository.revision ||
    typeof reference.digest !== "string" ||
    !SHA256.test(reference.digest)
  ) {
    fail("installed-source-evidence-invalid");
  }
  let finalRecord;
  let accessLedger;
  let citationLedger;
  try {
    finalRecord = contracts.decodeSourceEvidenceFinal(
      await artifactStore.getRecord(reference.digest),
    );
    if (finalRecord.evidenceSha256 !== reference.digest) fail("installed-source-evidence-invalid");
    accessLedger = contracts.decodeExternalInputAccessLedger(
      await artifactStore.getRecord(finalRecord.accessLedgerSha256),
    );
    citationLedger = contracts.decodeExternalInputCitationLedger(
      await artifactStore.getRecord(finalRecord.citationLedgerSha256),
    );
  } catch (error) {
    if (error instanceof SourceCoverageQualificationError) throw error;
    fail("installed-source-evidence-invalid");
  }
  return { finalRecord, accessLedger, citationLedger };
}

async function installedCollection(corpus, contracts, options) {
  if (options.installedExecutionAcknowledgment !== INSTALLED_ACK) {
    fail("installed-execution-not-acknowledged");
  }
  const cli = await realpath(options.installedCli).catch(() => fail("installed-cli-unavailable"));
  if (cli === repositoryRoot || cli.startsWith(`${repositoryRoot}${sep}`)) {
    fail("installed-cli-unavailable", "installed CLI must be outside the source checkout");
  }
  const workRoot = await realpath(options.workRoot).catch(async () => {
    await mkdir(options.workRoot, { recursive: true, mode: 0o700 });
    return realpath(options.workRoot);
  });
  if (workRoot === repositoryRoot || workRoot.startsWith(`${repositoryRoot}${sep}`)) {
    fail("unsafe-path", "installed work root must be outside the source checkout");
  }
  requireInstalledSourceEvidenceContracts(contracts);
  await installedCliIdentity(cli, WORKFLOW_BY_JOURNEY.CREATE);
  const campaign = await realpath(await mkdtemp(join(workRoot, "source-coverage-v1-")));
  const cells = [];
  for (const scenario of corpus.scenarios) {
    const candidateRoot = join(campaign, scenario.id);
    const stateDirectory = join(campaign, "state", scenario.id, "runs");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await materializeScenario(corpus, scenario, candidateRoot);
    const revision = await initializeFixtureRepository(candidateRoot);
    const invocation = buildInstalledInvocation(scenario, cli, candidateRoot, revision);
    const identity = await installedCliIdentity(cli, WORKFLOW_BY_JOURNEY[scenario.journey]);
    const { stdout } = await execute(invocation.executable, invocation.argv, {
      cwd: candidateRoot,
      env: { ...scrubbedChildEnvironment(), DOCSFAB_STATE_DIR: stateDirectory },
      maxBuffer: MAX_BUFFER,
      timeout: 30 * 60_000,
    });
    let result;
    try {
      result = contracts.decodeRunResultV1(JSON.parse(stdout));
    } catch {
      fail("installed-run-result-invalid", scenario.id);
    }
    if (
      result.execution.runId !== identifier(result.execution.runId) ||
      result.execution.workflow !== WORKFLOW_BY_JOURNEY[scenario.journey] ||
      resolve(result.execution.repository.path) !== resolve(candidateRoot) ||
      result.execution.status !== "succeeded"
    ) {
      fail("installed-run-result-invalid", scenario.id);
    }
    const recordPath = resolve(result.execution.recordPath);
    await validateInstalledRecordLocator(result, stateDirectory);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    if (
      record.id !== result.execution.runId ||
      record.workflow !== result.execution.workflow ||
      record.repository.revision !== result.execution.repository.revision
    ) {
      fail("installed-run-record-mismatch", scenario.id);
    }
    await validateInstalledRunLocators(result, record, stateDirectory);
    await materializeInstalledCandidate(result, record, candidateRoot);
    const artifactRoot = resolve(dirname(stateDirectory), "artifacts");
    const artifactStore = new contracts.DurableArtifactStore(artifactRoot);
    const sourceEvidence = await loadInstalledSourceEvidence(contracts, artifactStore, record);
    const evidence = { record, sourceEvidence, installedIdentity: identity };
    cells.push(
      await qualifyCandidate({
        contracts,
        corpus,
        scenario,
        oracleScenario: corpus.oracleScenarios.get(scenario.id),
        candidateRoot,
        evidence,
        artifactStore,
        requiredProvenance: "installed",
      }),
    );
  }
  return { cells, negativeControls: [], campaignRoot: campaign };
}

const INSTALLED_PENDING_REASON =
  "No granted installed CLI outside this checkout, work root, or --acknowledge-installed-execution was supplied. Live named workflows were not invoked. Fixture-only, admission-only, and empty-model records cannot qualify an installed cell.";

function evidenceFamilyAdapter(contracts, variant) {
  const samplePath = array(variant.fixtureFiles)[0]?.path;
  if (!samplePath || typeof contracts.classifySourceMediaType !== "function") {
    return { registered: false, mediaType: null, extractorIds: [] };
  }
  const mediaType = contracts.classifySourceMediaType(samplePath) ?? null;
  if (!mediaType) {
    return { registered: false, mediaType: null, extractorIds: [] };
  }
  const extractors = array(contracts.sourceExtractorAdapters).filter((adapter) =>
    array(adapter.mediaTypes).includes(mediaType),
  );
  return {
    registered: extractors.length > 0,
    mediaType,
    extractorIds: extractors.map((adapter) => identifier(adapter.id)).sort(),
  };
}

async function collectVariantLanes(corpus, contracts) {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "docsfab-source-coverage-variants-")),
  );
  const lanes = [];
  for (const variant of corpus.variants) {
    const oracleVariant = corpus.oracleVariants.get(variant.id);
    if (!oracleVariant) fail("corpus-integrity-invalid", `missing oracle variant ${variant.id}`);
    const candidateRoot = join(temporary, variant.id);
    await materializeScenario(corpus, variant, candidateRoot);
    for (const assertion of array(oracleVariant.assertions)) {
      exact(assertion, ["path", "contains"], "corpus-integrity-invalid");
      const bytes = await readFile(within(candidateRoot, safeRelativePath(assertion.path)));
      if (!bytes.includes(Buffer.from(assertion.contains))) {
        fail("variant-assertion-failed", `${variant.id}: ${assertion.path}`);
      }
    }
    const outputs = array(oracleVariant.outputs);
    const adapter = String(variant.id).startsWith("evidence-")
      ? evidenceFamilyAdapter(contracts, variant)
      : null;
    lanes.push({
      scenarioId: variant.id,
      kind: "variant",
      configuration: variant.configuration,
      status: "passed",
      evidenceStatus: "fixture-only",
      assertionStatus: "passed",
      outputStatus: outputs.length > 0 ? "pending-installed-writer" : "not-applicable",
      limitation:
        typeof variant.expectedLimitation === "string" ? variant.expectedLimitation : null,
      adapter,
    });
  }
  return lanes;
}

function pendingInstalledCells(corpus) {
  return corpus.scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    configuration: scenario.configuration,
    journey: scenario.journey,
    status: "pending",
    evidenceStatus: "pending",
    pendingReason: INSTALLED_PENDING_REASON,
    recordId: null,
    artifactIds: null,
  }));
}

export async function writeQualificationOutput(output, report) {
  await mkdir(output, { recursive: true, mode: 0o700 }).catch(() =>
    fail("qualification-output-path-invalid"),
  );
  const metadata = await lstat(output).catch(() => fail("qualification-output-path-invalid"));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("qualification-output-path-invalid");
  }
  const pinnedOutput = await realpath(output).catch(() =>
    fail("qualification-output-path-invalid"),
  );
  const reportPath = join(pinnedOutput, "report.json");
  let handle;
  try {
    handle = await open(
      reportPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch {
    fail("qualification-output-exists", "report.json already exists or is unsafe");
  }
  try {
    await handle.writeFile(`${canonicalJson(report)}\n`);
  } finally {
    await handle.close();
  }
}

export async function testedRepositoryState(root = repositoryRoot) {
  try {
    const commandOptions = {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: MAX_BUFFER,
      timeout: 10_000,
    };
    const [revisionResult, statusResult] = await Promise.all([
      execute("git", ["rev-parse", "HEAD"], commandOptions),
      execute("git", ["status", "--porcelain=v1", "--untracked-files=normal"], commandOptions),
    ]);
    const worktreeBaseRevision = revisionResult.stdout.trim();
    if (!REVISION.test(worktreeBaseRevision)) {
      return { testedRevision: null, worktreeBaseRevision: null, testedWorktreeDirty: null };
    }
    const testedWorktreeDirty = statusResult.stdout.trim().length > 0;
    return {
      testedRevision: testedWorktreeDirty ? null : worktreeBaseRevision,
      worktreeBaseRevision,
      testedWorktreeDirty,
    };
  } catch {
    return { testedRevision: null, worktreeBaseRevision: null, testedWorktreeDirty: null };
  }
}

function reportEvidenceStatus(mode, cells) {
  if (mode === "deterministic") return "fixture-only";
  if (
    cells.length > 0 &&
    cells.every((cell) => cell.status === "passed" && cell.evidenceStatus === "installed")
  ) {
    return "installed";
  }
  if (cells.length > 0 && cells.every((cell) => cell.status === "pending")) return "pending";
  return "mixed";
}

function sealReport(mode, corpus, collection, contracts, matrix) {
  const passedCells = collection.cells.filter((cell) => cell.status === "passed").length;
  const pendingCells = collection.cells.filter((cell) => cell.status === "pending").length;
  const failedCells = collection.cells.filter(
    (cell) => cell.status !== "passed" && cell.status !== "pending",
  ).length;
  const variants = array(collection.variants ?? []);
  const summary = {
    requiredCells: corpus.scenarios.length,
    passedCells,
    failedCells,
    installedQualified:
      mode === "installed" &&
      collection.cells.length === corpus.scenarios.length &&
      collection.cells.every(
        (cell) => cell.status === "passed" && cell.evidenceStatus === "installed",
      ),
  };
  if (matrix === "v1") {
    summary.pendingCells = pendingCells;
    summary.requiredVariants = corpus.variants.length;
    summary.passedVariantAssertions = variants.filter(
      (lane) => lane.assertionStatus === "passed",
    ).length;
    summary.pendingVariantOutputs = variants.filter(
      (lane) => lane.outputStatus === "pending-installed-writer",
    ).length;
    summary.failedVariants = variants.filter((lane) => lane.status === "failed").length;
  }
  const body = {
    schemaVersion: 1,
    kind: "docsfab-source-coverage-qualification-report",
    mode,
    ...(matrix === "v1" ? { matrix } : {}),
    evidenceStatus: reportEvidenceStatus(mode, collection.cells),
    corpus: { id: corpus.manifest.id, manifestSha256: corpus.manifest.manifestSha256 },
    testedRevision: collection.testedRevision ?? null,
    testedWorktreeDirty: collection.testedWorktreeDirty ?? null,
    worktreeBaseRevision: collection.worktreeBaseRevision ?? null,
    cells: collection.cells,
    negativeControls: collection.negativeControls,
    ...(matrix === "v1" ? { variants } : {}),
    summary,
    ...(collection.campaignRoot ? { campaignRoot: collection.campaignRoot } : {}),
  };
  return contracts.fixtureKit.seal(
    "docsfab-source-coverage-qualification-report",
    "reportSha256",
    Object.fromEntries(
      Object.entries(body).filter(([key]) => !["schemaVersion", "kind"].includes(key)),
    ),
  );
}

export async function collectSourceCoverage(options) {
  const matrix = options.matrix ?? null;
  if (
    options.mode === "installed" &&
    options.installedCli &&
    options.installedExecutionAcknowledgment !== INSTALLED_ACK
  ) {
    fail("installed-execution-not-acknowledged");
  }
  const contractsPromise = loadRuntimeContracts();
  if (options.mode === "installed" && options.installedCli) {
    const contracts = await contractsPromise;
    requireInstalledSourceEvidenceContracts(contracts);
    const cli = await realpath(options.installedCli).catch(() => fail("installed-cli-unavailable"));
    if (cli === repositoryRoot || cli.startsWith(`${repositoryRoot}${sep}`)) {
      fail("installed-cli-unavailable", "installed CLI must be outside the source checkout");
    }
    await installedCliIdentity(cli, WORKFLOW_BY_JOURNEY.CREATE);
  }
  const [corpus, contracts, repositoryState] = await Promise.all([
    loadCorpus(options.corpus),
    contractsPromise,
    testedRepositoryState(),
  ]);
  let collection;
  if (options.mode === "deterministic") {
    collection = await deterministicCollection(corpus, contracts);
    if (matrix === "v1") collection.variants = await collectVariantLanes(corpus, contracts);
  } else if (!options.installedCli) {
    collection = {
      cells: pendingInstalledCells(corpus),
      negativeControls: [],
      variants: matrix === "v1" ? await collectVariantLanes(corpus, contracts) : [],
    };
  } else {
    collection = await installedCollection(corpus, contracts, options);
    if (matrix === "v1") collection.variants = await collectVariantLanes(corpus, contracts);
  }
  Object.assign(collection, repositoryState);
  const report = sealReport(options.mode, corpus, collection, contracts, matrix);
  if (options.output) await writeQualificationOutput(options.output, report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await collectSourceCoverage(options);
  process.stdout.write(`${canonicalJson(report)}\n`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
