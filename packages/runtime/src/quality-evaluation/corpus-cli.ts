#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { internalContentPath } from "../config/internal-content.js";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCorpusReportSanitized,
  createDeterministicFakeCandidate,
  evaluateCorpus,
  runOfflineFakeCorpus,
  runOptionalCorpusJudge,
  type CorpusDeterministicEvaluation,
  type CorpusJudgeDisposition,
  type CorpusJudge,
} from "./corpus.js";
import { loadCorpusInputs, loadCorpusObservationSet } from "./corpus-files.js";
import { loadIaPlanReviewerPolicyFile } from "../ia/reviewer-policy-file.js";
import { loadConfig } from "../config/runtime-loader.js";
import type { ModelEndpointConfig } from "../model/configuration.js";
import { createModelConnection } from "../model/provider.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { runCliEntrypoint } from "../operator/cli-entrypoint.js";
import { isNodeError } from "../shared/primitives.js";

const modulePath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(modulePath), "../..");
const qualityBenchmarkRoot = () =>
  resolve(projectRoot, "../..", internalContentPath("qualityBenchmarkRuntime"));

export interface CorpusCliOptions {
  datasetPath: string;
  thresholdsPath: string;
  thresholdPredecessorPath: string;
  fakeCandidatesPath: string;
  liveCampaignPath?: string;
  artifactStorePath?: string;
  reviewerPolicyPath?: string;
  testedRevision?: string;
  outputDirectory?: string;
  allowWrite: boolean;
  judge: boolean;
}

export interface CorpusEvidenceReport {
  schemaVersion: 1;
  deterministic: CorpusDeterministicEvaluation;
  judge: CorpusJudgeDisposition;
  liveCampaign:
    | { status: "pending" }
    | {
        status: "passed" | "failed";
        evaluationDigest: string;
        runCount: number;
        testedRevision: string;
        model: { provider: string; model: string; profileSha256: string };
        metrics: CorpusDeterministicEvaluation["metrics"];
        gates: Array<{ gate: string; passed: boolean }>;
      };
  limitations: string[];
  sanitization: "passed";
}

export interface CorpusCliResult {
  exitCode: number;
  report: CorpusEvidenceReport;
  outputDirectory?: string;
}

export interface CorpusCliDependencies {
  publish(outputDirectory: string, json: string, markdown: string): Promise<void>;
  log(message: string): void;
  judge?: CorpusJudge;
  now?: Date;
}

export function parseCorpusCliOptions(args: readonly string[]): CorpusCliOptions {
  const valueOptions = new Set([
    "--dataset",
    "--thresholds",
    "--threshold-predecessor",
    "--fake-candidates",
    "--live-campaign",
    "--artifact-store",
    "--reviewer-policy",
    "--tested-revision",
    "--output-dir",
  ]);
  const values = new Map<string, string>();
  let allowWrite = false;
  let judge = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--allow-write") {
      if (allowWrite) throw new Error("Duplicate --allow-write option.");
      allowWrite = true;
      continue;
    }
    if (token === "--judge") {
      if (judge) throw new Error("Duplicate --judge option.");
      judge = true;
      continue;
    }
    if (!valueOptions.has(token) || values.has(token))
      throw new Error(`Unknown or duplicate corpus option: ${token}.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    values.set(token, value);
    index += 1;
  }
  const outputDirectory = values.get("--output-dir");
  if (allowWrite !== Boolean(outputDirectory)) {
    throw new Error("Corpus publication requires both --output-dir and --allow-write.");
  }
  const liveCampaignPath = values.get("--live-campaign");
  const artifactStorePath = values.get("--artifact-store");
  const reviewerPolicyPath = values.get("--reviewer-policy");
  const testedRevision = values.get("--tested-revision");
  if (
    Boolean(liveCampaignPath) !== Boolean(artifactStorePath) ||
    Boolean(liveCampaignPath) !== Boolean(reviewerPolicyPath) ||
    Boolean(liveCampaignPath) !== Boolean(testedRevision)
  ) {
    throw new Error(
      "Live campaigns require --live-campaign, --artifact-store, --reviewer-policy, and --tested-revision together.",
    );
  }
  return {
    datasetPath: resolve(
      values.get("--dataset") ??
        join(qualityBenchmarkRoot(), "evaluation/living-documentation/dataset.json"),
    ),
    thresholdsPath: resolve(
      values.get("--thresholds") ??
        join(qualityBenchmarkRoot(), "evaluation/living-documentation/thresholds.json"),
    ),
    thresholdPredecessorPath: resolve(
      values.get("--threshold-predecessor") ??
        join(qualityBenchmarkRoot(), "evaluation/living-documentation/thresholds-v1.json"),
    ),
    fakeCandidatesPath: resolve(
      values.get("--fake-candidates") ??
        join(qualityBenchmarkRoot(), "evaluation/living-documentation/fake-candidates.json"),
    ),
    ...(liveCampaignPath ? { liveCampaignPath: resolve(liveCampaignPath) } : {}),
    ...(artifactStorePath ? { artifactStorePath: resolve(artifactStorePath) } : {}),
    ...(reviewerPolicyPath ? { reviewerPolicyPath: resolve(reviewerPolicyPath) } : {}),
    ...(testedRevision ? { testedRevision } : {}),
    ...(outputDirectory ? { outputDirectory: resolve(outputDirectory) } : {}),
    allowWrite,
    judge,
  };
}

export async function runCorpusCli(
  args: readonly string[],
  dependencies: Partial<CorpusCliDependencies> = {},
): Promise<CorpusCliResult> {
  const options = parseCorpusCliOptions(args);
  const inputs = await loadCorpusInputs({
    projectRoot: qualityBenchmarkRoot(),
    datasetPath: options.datasetPath,
    thresholdsPath: options.thresholdsPath,
    thresholdPredecessorPath: options.thresholdPredecessorPath,
    fakeCandidatesPath: options.fakeCandidatesPath,
  });
  const offlineObservations = await runOfflineFakeCorpus(inputs.dataset, {
    id: "deterministic-fake",
    run: async (input, index) => {
      const fixture = inputs.fakeCandidates.cases.find((item) => item.caseId === input.caseId)!;
      return createDeterministicFakeCandidate(input, index, fixture.artifact, {
        providerOutcome: fixture.providerOutcome,
        ...(fixture.failureClass ? { failureClass: fixture.failureClass } : {}),
      });
    },
  });
  const deterministic = evaluateCorpus(inputs.dataset, offlineObservations, inputs.thresholds);
  let liveCampaign: CorpusEvidenceReport["liveCampaign"] = { status: "pending" };
  let judgeEvaluation = deterministic;
  if (options.liveCampaignPath) {
    const reviewerPolicy = await loadIaPlanReviewerPolicyFile(options.reviewerPolicyPath!);
    const observations = await loadCorpusObservationSet(options.liveCampaignPath, inputs.dataset, {
      reviewerPolicy,
      expectedTestedRevision: options.testedRevision!,
      artifactStoreRoot: options.artifactStorePath!,
      fixtureProjectRoot: qualityBenchmarkRoot(),
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    if (observations.mode !== "live")
      throw new Error("--live-campaign requires live observations.");
    const evaluation = evaluateCorpus(inputs.dataset, observations, inputs.thresholds);
    judgeEvaluation = evaluation;
    liveCampaign = {
      status: evaluation.passed ? "passed" : "failed",
      evaluationDigest: evaluation.digest,
      runCount: evaluation.runCount,
      testedRevision: observations.authorization!.testedRevision,
      model: { ...observations.runs[0]!.provider.model! },
      metrics: evaluation.metrics,
      gates: evaluation.gates.map(({ gate, passed }) => ({ gate, passed })),
    };
  }
  const configuredJudge =
    options.judge && judgeEvaluation.passed
      ? (dependencies.judge ?? configuredCorpusJudge(loadConfig().judge))
      : undefined;
  const judge = await runOptionalCorpusJudge(judgeEvaluation, configuredJudge);
  const limitations =
    liveCampaign.status === "pending"
      ? [
          "Offline observations use deterministic fake providers and cannot establish live provider reliability.",
          "No authorized five-run live planning campaign was supplied.",
        ]
      : [
          "The live campaign contains five observations per planning case and does not establish population-level quality.",
        ];
  if (judge.status === "not-run" && judge.reason === "not-configured") {
    limitations.push(
      "Optional semantic judgment was not configured; deterministic gates remain authoritative.",
    );
  } else if (judge.status === "failed") {
    limitations.push(
      "Optional semantic judgment failed; deterministic gates remain authoritative.",
    );
  } else if (judge.status === "disagreed") {
    limitations.push(
      "Optional semantic judgment disagreed; deterministic gates remain authoritative.",
    );
  }
  const report: CorpusEvidenceReport = {
    schemaVersion: 1,
    deterministic,
    judge,
    liveCampaign,
    limitations,
    sanitization: "passed",
  };
  assertCorpusReportSanitized(report);
  const log = dependencies.log ?? console.log;
  log(`Deterministic corpus: ${deterministic.passed ? "passed" : "failed"}`);
  log(`Live campaign: ${liveCampaign.status}`);
  if (options.outputDirectory) {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = renderCorpusMarkdown(report);
    await (dependencies.publish ?? publishCorpusReport)(options.outputDirectory, json, markdown);
    log("Published sanitized corpus evidence.");
  } else {
    log("Publication: dry run");
  }
  const exitCode = deterministic.passed && liveCampaign.status !== "failed" ? 0 : 1;
  return {
    exitCode,
    report,
    ...(options.outputDirectory ? { outputDirectory: options.outputDirectory } : {}),
  };
}

export function renderCorpusMarkdown(report: CorpusEvidenceReport): string {
  const metrics = report.deterministic.metrics;
  const gates = report.deterministic.gates
    .map((item) => `| ${item.gate} | ${item.passed ? "passed" : "failed"} |`)
    .join("\n");
  const liveMetrics =
    report.liveCampaign.status === "pending"
      ? ""
      : `\n## Live campaign metrics\n\n` +
        `- Runs: ${report.liveCampaign.runCount}\n` +
        `- Tested DocsFab revision: ${report.liveCampaign.testedRevision}\n` +
        `- Model profile: ${report.liveCampaign.model.provider}/${report.liveCampaign.model.model} (${report.liveCampaign.model.profileSha256})\n` +
        `- Placement agreement: ${report.liveCampaign.metrics.placementAgreement}\n` +
        `- Recall@3: ${report.liveCampaign.metrics.recallAt3}\n` +
        `- Mean reciprocal rank: ${report.liveCampaign.metrics.meanReciprocalRank}\n` +
        `- Provider blanks: ${report.liveCampaign.metrics.providerBlanks}\n` +
        `- Unclassified failures: ${report.liveCampaign.metrics.unclassifiedFailures}\n` +
        `- Latency (min/median/max ms): ${report.liveCampaign.metrics.latencyMs.minimum}/${report.liveCampaign.metrics.latencyMs.median}/${report.liveCampaign.metrics.latencyMs.maximum}\n` +
        `- Tokens (input/output/cache-read/cache-write/total; turns): ${report.liveCampaign.metrics.tokens.input}/${report.liveCampaign.metrics.tokens.output}/${report.liveCampaign.metrics.tokens.cacheRead}/${report.liveCampaign.metrics.tokens.cacheWrite}/${report.liveCampaign.metrics.tokens.total}; ${report.liveCampaign.metrics.tokens.turns}\n` +
        `- Cost (USD): ${report.liveCampaign.metrics.costUsd ?? "unknown"}\n`;
  return (
    `# Living-documentation evaluation corpus\n\n` +
    `Dataset: \`${report.deterministic.dataset.id}@${report.deterministic.dataset.revision}\`  \n` +
    `Deterministic result: **${report.deterministic.passed ? "passed" : "failed"}**  \n` +
    `Live campaign: **${report.liveCampaign.status}**\n\n` +
    `## Metrics\n\n` +
    `- Artifact validity: ${metrics.artifactValidityRate}\n` +
    `- Evidence coverage: ${metrics.evidenceCoverage}\n` +
    `- Placement agreement: ${metrics.placementAgreement}\n` +
    `- Recall@3: ${metrics.recallAt3}\n` +
    `- Mean reciprocal rank: ${metrics.meanReciprocalRank}\n` +
    `- No-result rate: ${metrics.noResultRate}\n` +
    `- Orphans: ${metrics.orphanCount}\n` +
    `- Duplicate canonical homes: ${metrics.duplicateCanonicalHomeCount}\n` +
    `- Latency (min/median/max ms): ${metrics.latencyMs.minimum}/${metrics.latencyMs.median}/${metrics.latencyMs.maximum}\n` +
    `- Tokens (input/output/cache-read/cache-write/total; turns): ${metrics.tokens.input}/${metrics.tokens.output}/${metrics.tokens.cacheRead}/${metrics.tokens.cacheWrite}/${metrics.tokens.total}; ${metrics.tokens.turns}\n` +
    `- Cost (USD): ${metrics.costUsd ?? "unknown"}\n\n` +
    `## Gates\n\n| Gate | Result |\n| --- | --- |\n${gates}\n${liveMetrics}\n` +
    `## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`
  );
}

/** The corpus judge over the configured judge model; exported for its wire tests. */
export function configuredCorpusJudge(config: ModelEndpointConfig | undefined): CorpusJudge {
  if (!config) {
    throw new Error("Corpus --judge requires JUDGE_ENABLED=true and JUDGE_* configuration.");
  }
  return {
    identity: { provider: config.providerId, model: config.modelId },
    evaluate: async (request) => {
      const connection = await createModelConnection(config);
      const response = await connection.runtime.completeSimple(
        connection.model,
        {
          systemPrompt: [
            "You are DocsFab's advisory living-documentation corpus judge.",
            "Use only the content-minimized digests, metrics, and gate results supplied.",
            "Return one JSON object with agrees (boolean).",
            "Do not return repository content, paths, credentials, or excerpts.",
          ].join("\n"),
          messages: [{ role: "user", content: JSON.stringify(request), timestamp: Date.now() }],
        },
        { maxTokens: Math.min(config.profile.maxOutputTokens, 256), maxRetries: 0 },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error("Corpus judge inference failed.");
      }
      const text = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      const parsed = JSON.parse(text) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof (parsed as { agrees?: unknown }).agrees !== "boolean"
      ) {
        throw new Error("Corpus judge returned an invalid decision.");
      }
      return { agrees: (parsed as { agrees: boolean }).agrees };
    },
  };
}

export interface CorpusPublicationHooks {
  /** Test-only race injection after the destination is exclusively reserved. */
  afterDestinationReserved?(): Promise<void> | void;
  /** Test-only race injection after the held cwd check and before child creation. */
  beforeFileOpen?(name: string): Promise<void> | void;
}

export async function publishCorpusReport(
  outputDirectory: string,
  json: string,
  markdown: string,
  hooks: CorpusPublicationHooks = {},
): Promise<void> {
  assertCorpusReportSanitized(parseJsonEvidence(Buffer.from(json, "utf8")));
  assertCorpusReportSanitized(markdown);
  const requestedOutput = resolve(outputDirectory);
  const parent = await pinExistingDirectory(dirname(requestedOutput));
  let directory: FileHandle | undefined;
  try {
    await assertPinnedDirectory(parent);
    try {
      // mkdir is the no-clobber publication reservation on every supported
      // platform. Unlike rename(2), it cannot replace a concurrently created
      // empty directory.
      await mkdir(requestedOutput, { mode: 0o700 });
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new Error("Corpus publication destination already exists.");
      }
      throw error;
    }
    directory = await openDirectory(requestedOutput);
    await directory.chmod(0o700);
    const directoryStat = await directory.stat();
    assertPrivateOutputDirectory(directoryStat);
    await assertHeldPublicationDirectory(directory, requestedOutput, directoryStat);
    await hooks.afterDestinationReserved?.();
    await assertHeldPublicationDirectory(directory, requestedOutput, directoryStat);
    await publishThroughHeldWorkingDirectory(
      requestedOutput,
      directoryStat,
      [
        ["report.json", json],
        ["report.md", markdown],
        [".complete", "complete\n"],
      ],
      hooks,
    );
    await directory.sync();
    await assertHeldPublicationDirectory(directory, requestedOutput, directoryStat);
    await assertPinnedDirectory(parent);
    await parent.handle.sync();
  } finally {
    await directory?.close().catch(() => undefined);
    await parent.handle.close().catch(() => undefined);
  }
}

const HELD_CWD_PUBLISHER = String.raw`
const { constants } = require("node:fs");
const { lstat, open } = require("node:fs/promises");
const names = ["report.json", "report.md", ".complete"];
const expected = JSON.parse(process.env.DOCSFAB_PUBLICATION_IDENTITY || "null");
let index = 0;
let active = false;
const send = (value) => { if (process.send) process.send(value); };
const fail = async (handle) => {
  if (handle) {
    await handle.truncate(0).catch(() => undefined);
    await handle.sync().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
  send({ type: "failed" });
  process.exitCode = 1;
  process.disconnect?.();
};
const assertHeldCwd = async () => {
  const stat = await lstat(".");
  if (!expected || !stat.isDirectory() || stat.dev !== expected.dev ||
      stat.ino !== expected.ino || stat.uid !== expected.uid || stat.mode !== expected.mode) {
    throw new Error("identity");
  }
};
const ready = async () => {
  await assertHeldCwd();
  send({ type: "ready", name: names[index] });
};
process.on("message", async (message) => {
  if (active || !message || message.type !== "write" || message.name !== names[index] ||
      typeof message.content !== "string") return fail();
  active = true;
  let handle;
  try {
    handle = await open(
      message.name,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== expected.uid || (opened.mode & 0o7777) !== 0o600) {
      throw new Error("file");
    }
    await handle.writeFile(message.content, "utf8");
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.dev !== opened.dev || written.ino !== opened.ino ||
        written.uid !== expected.uid || (written.mode & 0o7777) !== 0o600 ||
        written.size !== Buffer.byteLength(message.content, "utf8")) {
      throw new Error("file");
    }
    await handle.close();
    handle = undefined;
    index += 1;
    active = false;
    if (index === names.length) {
      const directory = await open(".", constants.O_RDONLY | constants.O_DIRECTORY);
      await directory.sync();
      await directory.close();
      send({ type: "complete" });
      process.disconnect?.();
      return;
    }
    await ready();
  } catch {
    await fail(handle);
  }
});
ready().catch(() => fail());
`;

async function publishThroughHeldWorkingDirectory(
  path: string,
  expected: Stats,
  entries: ReadonlyArray<readonly [string, string]>,
  hooks: CorpusPublicationHooks,
): Promise<void> {
  if (typeof constants.O_DIRECTORY !== "number" || typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Corpus publication requires held-working-directory support.");
  }
  const identity = JSON.stringify({
    dev: expected.dev,
    ino: expected.ino,
    uid: expected.uid,
    mode: expected.mode,
  });
  const child = spawn(process.execPath, ["-e", HELD_CWD_PUBLISHER], {
    cwd: path,
    env: { DOCSFAB_PUBLICATION_IDENTITY: identity },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await coordinateHeldPublisher(child, entries, hooks);
}

async function coordinateHeldPublisher(
  child: ChildProcess,
  entries: ReadonlyArray<readonly [string, string]>,
  hooks: CorpusPublicationHooks,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let index = 0;
    let settled = false;
    const reject = (): void => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(new Error("Corpus publication held-directory writer failed."));
    };
    child.once("error", reject);
    child.once("exit", () => {
      if (!settled) reject();
    });
    child.on("message", (message: unknown) => {
      void (async () => {
        if (!message || typeof message !== "object") return reject();
        const value = message as { type?: unknown; name?: unknown };
        if (value.type === "failed") return reject();
        if (value.type === "complete") {
          if (index !== entries.length || settled) return reject();
          settled = true;
          resolvePromise();
          return;
        }
        const entry = entries[index];
        if (value.type !== "ready" || !entry || value.name !== entry[0]) return reject();
        await hooks.beforeFileOpen?.(entry[0]);
        if (settled || !child.connected) return reject();
        index += 1;
        child.send({ type: "write", name: entry[0], content: entry[1] }, (error) => {
          if (error) reject();
        });
      })().catch(reject);
    });
  });
}

async function assertHeldPublicationDirectory(
  handle: FileHandle,
  path: string,
  expected: Stats,
): Promise<void> {
  const opened = await handle.stat();
  const leaf = await lstat(path);
  assertPrivateOutputDirectory(opened);
  assertPrivateOutputDirectory(leaf);
  if (
    opened.dev !== expected.dev ||
    opened.ino !== expected.ino ||
    leaf.dev !== expected.dev ||
    leaf.ino !== expected.ino ||
    leaf.uid !== expected.uid ||
    leaf.mode !== expected.mode
  ) {
    throw new Error("Corpus publication directory identity changed.");
  }
}

interface PinnedDirectory {
  path: string;
  canonicalPath: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  ancestors: Array<{ path: string; dev: number; ino: number; uid: number; mode: number }>;
  handle: FileHandle;
}

async function pinExistingDirectory(path: string): Promise<PinnedDirectory> {
  const canonical = await realpath(path);
  const handle = await openDirectory(canonical);
  const stat = await handle.stat();
  if (!stat.isDirectory()) {
    await handle.close();
    throw new Error("Corpus publication parent is not a directory.");
  }
  const leaf = await lstat(canonical);
  if (leaf.isSymbolicLink() || leaf.dev !== stat.dev || leaf.ino !== stat.ino) {
    await handle.close();
    throw new Error("Corpus publication parent identity changed.");
  }
  return {
    path: canonical,
    canonicalPath: canonical,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    ancestors: await capturePublicationAncestors(canonical),
    handle,
  };
}

async function openDirectory(path: string): Promise<FileHandle> {
  if (typeof constants.O_DIRECTORY !== "number" || typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Corpus publication requires no-follow directory handles.");
  }
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function assertPinnedDirectory(
  expected: PinnedDirectory,
  privateDirectory = false,
): Promise<void> {
  if ((await realpath(expected.path)) !== expected.canonicalPath) {
    throw new Error("Corpus publication directory identity changed.");
  }
  for (const ancestor of expected.ancestors) {
    const stat = await lstat(ancestor.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== ancestor.dev ||
      stat.ino !== ancestor.ino ||
      stat.uid !== ancestor.uid ||
      stat.mode !== ancestor.mode
    ) {
      throw new Error("Corpus publication ancestor identity changed.");
    }
  }
  const opened = await expected.handle.stat();
  const leaf = await lstat(expected.path);
  if (
    !opened.isDirectory() ||
    leaf.isSymbolicLink() ||
    !leaf.isDirectory() ||
    opened.dev !== expected.dev ||
    opened.ino !== expected.ino ||
    leaf.dev !== expected.dev ||
    leaf.ino !== expected.ino ||
    leaf.uid !== expected.uid ||
    opened.mode !== expected.mode ||
    leaf.mode !== expected.mode
  ) {
    throw new Error("Corpus publication directory identity changed.");
  }
  if (privateDirectory) assertPrivateOutputDirectory(opened);
}

async function capturePublicationAncestors(path: string): Promise<PinnedDirectory["ancestors"]> {
  const paths: string[] = [];
  let current = dirname(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  paths.reverse();
  return Promise.all(
    paths.map(async (ancestorPath) => {
      const stat = await lstat(ancestorPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Corpus publication ancestor is unsafe.");
      }
      return { path: ancestorPath, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
    }),
  );
}

function assertPrivateOutputDirectory(stat: Stats): void {
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o7777) !== 0o700
  ) {
    throw new Error("Corpus publication directory is not owner-private.");
  }
}

function assertPrivateOutputFile(stat: Stats): void {
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o7777) !== 0o600 ||
    stat.nlink !== 1
  ) {
    throw new Error("Corpus publication file is not owner-private.");
  }
}

function noFollow(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

runCliEntrypoint(import.meta.url, () => runCorpusCli(process.argv.slice(2)));
