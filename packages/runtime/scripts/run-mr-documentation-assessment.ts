// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI-only: assess documentation impact of a named change set.
 *
 * Unlike the merged-MR discovery path (src/cli/run/merged-mr-update.ts), this
 * resolves changed paths locally with `git diff BASE SOURCE`, not the working
 * tree, which on merged-results or merge-train checkouts would include
 * target-only files. Resolving the change set needs no network lookup.
 *
 * Two GitLab-shaped BASE/SOURCE pairs, never mixed:
 *
 * - Default-branch push, where the job runs: CI_COMMIT_BEFORE_SHA to
 *   CI_COMMIT_SHA. Protected CI/CD variables reach only protected refs, so an
 *   MR pipeline cannot reach a model.
 * - Merge-request pipeline: CI_MERGE_REQUEST_DIFF_BASE_SHA to
 *   CI_MERGE_REQUEST_SOURCE_BRANCH_SHA. CI_COMMIT_SHA is the merged-results
 *   commit there and must never substitute for the source SHA.
 *
 * GitLab zeroes CI_COMMIT_BEFORE_SHA on schedule, web, and api pipelines and
 * on a branch's first commit; those resolve to no-diff-base rather than
 * assessing the whole tree.
 *
 * Extractor-eligible changed paths become --source bindings on
 * "docsfab run update-documentation --patch-only --json". --patch-only keeps
 * the patch on disk without applying it to the checkout: this job posts
 * nothing and writes no tracker entry.
 * Paths --source does not accept (notably .md) are listed in skippedPaths;
 * the workflow still runs against the checkout, so a documentation-only MR
 * gets a real verdict.
 *
 * Every path through this script, including a missing credential, a
 * resolution failure, or a failed workflow invocation, ends in a written
 * result.json.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { resolveSecretsEnvPath } from "../src/config/split-layout.js";
import { supportedSourceExtensions } from "../src/inputs/source-extractor-registry.js";
import { redactCredentialMaterial } from "../src/security/credential-material.js";

const defaultExecute = promisify(execFile);

const ASSESSED_WORKFLOWS = ["update-documentation"] as const;

type ChangedPathStatus = "resolved" | "no-diff-base" | "no-source-sha" | "diff-failed";

export interface ChangedPathResolution {
  readonly status: ChangedPathStatus;
  readonly reason?: string;
  readonly changedPathCount: number;
  readonly sourcePaths: string[];
  readonly skippedPaths: string[];
}

/**
 * Coded outcome for a run that resolved no change set, distinct from
 * `insufficient-evidence` (the model credential was not prepared).
 */
export function unresolvedOutcome(status: ChangedPathStatus): string {
  return status === "diff-failed" ? "resolution-error" : "no-change-set";
}

/** Merge-request identity for the assessed change set. */
export interface ChangeIdentity {
  readonly iid: string | undefined;
  readonly title: string | undefined;
  readonly targetBranch: string | undefined;
  readonly source: "merge-request-variables" | "merge-commit-message" | "none";
}

/**
 * Recover the merge request from the landed merge commit, offline. A
 * default-branch push sets no CI_MERGE_REQUEST_* variables; a direct push is
 * not a merge commit and yields no identity.
 *
 * The `See merge request` trailer is trusted only with GitLab's own merge
 * header present, since anyone can write that trailer into a commit body. The
 * last match wins, because GitLab appends its trailer after body text.
 *
 * The identity is advisory metadata for a human reader; nothing branches on
 * it, and it grants no authority.
 */
export function parseMergeCommitIdentity(message: string | undefined): ChangeIdentity {
  const none = {
    iid: undefined,
    title: undefined,
    targetBranch: undefined,
    source: "none",
  } as const;
  if (!message?.trim()) return none;
  const lines = message.split("\n");
  const targetBranch = /^Merge branch '[^']*' into '([^']*)'/u.exec(lines[0] ?? "")?.[1];
  // No merge header means this is not a GitLab merge commit, so any trailer
  // in the body is unattributable text rather than GitLab's own record.
  if (targetBranch === undefined) return none;
  const trailers = [...message.matchAll(/^See merge request \S*!(\d+)\s*$/gmu)];
  const iid = trailers.at(-1)?.[1];
  // Subject of the merged work: the first non-empty line after the merge
  // header, excluding trailers.
  const subject = lines
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line !== "" && !/^(?:See merge request|Closes|Co-Authored-By)\b/u.test(line));
  return { iid, title: singleLine(subject), targetBranch, source: "merge-commit-message" };
}

/**
 * Flatten author-controlled text to one line without control characters, so
 * a subject quoted into the model instruction cannot break out of its
 * sentence. It does not try to defeat adversarial natural language.
 */
function singleLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const flattened = value
    // Cc covers the C0/C1 control ranges, including U+0085 NEL; Cf covers
    // format characters such as U+200B ZWSP. Neither is matched by \s.
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, " ")
    // \s also covers U+2028/U+2029 (Zl/Zp), which some renderers treat as line
    // breaks. Do not narrow this to [ \t]; a test pins U+2028.
    .replaceAll(/\s+/gu, " ")
    .trim();
  return flattened === "" ? undefined : flattened;
}

/** Prefer GitLab's merge-request variables; fall back to the merge commit. */
export function resolveChangeIdentity(env: NodeJS.ProcessEnv): ChangeIdentity {
  const iid = env.CI_MERGE_REQUEST_IID?.trim() || undefined;
  const title = env.CI_MERGE_REQUEST_TITLE?.trim() || undefined;
  const targetBranch = env.CI_MERGE_REQUEST_TARGET_BRANCH?.trim() || undefined;
  if (iid || title || targetBranch) {
    return { iid, title, targetBranch, source: "merge-request-variables" };
  }
  return parseMergeCommitIdentity(env.CI_COMMIT_MESSAGE);
}

/** One GitLab-shaped BASE/SOURCE pair; see resolveAssessmentRevisions. */
export interface AssessmentRevisions {
  readonly diffBaseSha: string | undefined;
  readonly sourceSha: string | undefined;
}

type WorkflowAssessmentStatus = "completed" | "skipped" | "invocation-error";

export interface WorkflowAssessmentResult {
  readonly workflow: (typeof ASSESSED_WORKFLOWS)[number];
  readonly status: WorkflowAssessmentStatus;
  readonly exitCode: number | null;
  readonly outcome: unknown;
  readonly decision: unknown;
  readonly patchSha256: string | null;
  readonly patchIncluded: boolean;
  readonly raw: unknown;
  readonly stderrTail: string | null;
}

export interface ExecuteResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecuteFn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; maxBuffer: number },
) => Promise<ExecuteResult>;

export interface AssessmentRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly execute: ExecuteFn;
  readonly credentialPrepared: (configurationRoot: string | undefined) => Promise<boolean>;
  readonly now: () => Date;
}

/**
 * Well-known durable credential formats. `redactCredentialMaterial` already
 * covers assigned `key=` / `token=` values and nvapi-/ihub_api_ shapes; these
 * close bare values and `Bearer <token>` so a prefix never remains on disk.
 */
const BEARER_SHAPE = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/giu;
const LOOSE_ASSIGNMENT_SHAPE =
  /\b(?:key|token|secret|password|bearer|authorization)["']?\s*[:=]\s*["']?[^\s"'#;,]{8,}/giu;
const WELL_KNOWN_SECRET_SHAPE =
  /(?:\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|\bya29\.[A-Za-z0-9._-]{20,}\b|\bihub_api_[A-Za-z0-9_-]{20,}\b|\bnvapi-[A-Za-z0-9_-]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b)/giu;

const MISSING_CREDENTIAL_REASON =
  "MODEL_API_KEY was not prepared for this pipeline. This push-only job has " +
  "no secret-store credential path (the secret-store role binds web, api and schedule " +
  "sources only); its sole key source is the copied protected MODEL_API_KEY " +
  "project variable. Retiring that copy disables this job. The owner has " +
  "not chosen a Vault push binding; until they do, retiring the copied " +
  "variable goes dark. Do not restore a copied key that was removed on " +
  "purpose (see #1087). The written result is insufficient-evidence, not a " +
  "missing artifact.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Redact credential material without leaving a secret prefix on disk. */
export function scrub(text: string): string {
  let output = redactCredentialMaterial(text);
  output = output.replace(LOOSE_ASSIGNMENT_SHAPE, "[REDACTED]");
  output = output.replace(BEARER_SHAPE, "[REDACTED]");
  output = output.replace(WELL_KNOWN_SECRET_SHAPE, "[REDACTED]");
  return output;
}

export function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrubDeep(inner)]));
  }
  return value;
}

/** Keep outcome identity, not the unsanitized workflow envelope. */
export function minimizeWorkflowJson(parsed: Record<string, unknown>): Record<string, unknown> {
  const execution = isRecord(parsed.execution) ? parsed.execution : null;
  const product = isRecord(parsed.product) ? parsed.product : null;
  const editorial = isRecord(parsed.editorial) ? parsed.editorial : null;
  return {
    kind: typeof parsed.kind === "string" ? parsed.kind : null,
    runId: execution && typeof execution.runId === "string" ? execution.runId : null,
    status: execution && typeof execution.status === "string" ? execution.status : null,
    exitCode: execution && typeof execution.exitCode === "number" ? execution.exitCode : null,
    disposition: product ? (product.disposition ?? null) : null,
    outcome: editorial ? (editorial.outcome ?? null) : null,
    decision: editorial ? (editorial.decision ?? null) : null,
  };
}

export async function defaultCredentialPrepared(
  configurationRoot: string | undefined,
): Promise<boolean> {
  if (!configurationRoot?.trim()) return false;
  try {
    await access(resolveSecretsEnvPath(configurationRoot), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRuntime(env: NodeJS.ProcessEnv = process.env): AssessmentRuntime {
  return {
    env,
    execute: defaultExecute as ExecuteFn,
    credentialPrepared: defaultCredentialPrepared,
    now: () => new Date(),
  };
}

/** GitLab sets CI_COMMIT_BEFORE_SHA to all-zeros when it has no previous SHA. */
export function usableCommitBeforeSha(value: string | undefined): string | undefined {
  const beforeSha = value?.trim();
  if (!beforeSha || /^0+$/u.test(beforeSha)) return undefined;
  return beforeSha;
}

/**
 * Pick one named BASE/SOURCE pair, never a mix of the two. A merge-request
 * pipeline's source SHA is never replaced with CI_COMMIT_SHA, which is the
 * merged-results commit there rather than the MR source revision.
 */
export function resolveAssessmentRevisions(env: NodeJS.ProcessEnv): AssessmentRevisions {
  const mergeRequestBase = env.CI_MERGE_REQUEST_DIFF_BASE_SHA?.trim() || undefined;
  const mergeRequestSource = env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA?.trim() || undefined;
  if (mergeRequestBase || mergeRequestSource) {
    return { diffBaseSha: mergeRequestBase, sourceSha: mergeRequestSource };
  }
  return {
    diffBaseSha: usableCommitBeforeSha(env.CI_COMMIT_BEFORE_SHA),
    sourceSha: env.CI_COMMIT_SHA?.trim() || undefined,
  };
}

export async function resolveChangedPaths(input: {
  readonly repositoryRoot: string;
  readonly diffBaseSha: string | undefined;
  readonly sourceSha: string | undefined;
  readonly execute?: ExecuteFn;
}): Promise<ChangedPathResolution> {
  const execute = input.execute ?? (defaultExecute as ExecuteFn);
  const { repositoryRoot, diffBaseSha, sourceSha } = input;
  if (!diffBaseSha) {
    return {
      status: "no-diff-base",
      reason:
        "No usable diff base: CI_MERGE_REQUEST_DIFF_BASE_SHA is unset, and " +
        "CI_COMMIT_BEFORE_SHA is missing or all-zeros. GitLab only supplies a real " +
        "previous SHA on a push; schedule, web, and api pipelines and a branch's " +
        "first commit are all-zeros and cannot name a landed change set.",
      changedPathCount: 0,
      sourcePaths: [],
      skippedPaths: [],
    };
  }
  if (!sourceSha) {
    return {
      status: "no-source-sha",
      reason:
        "No usable source revision: neither CI_MERGE_REQUEST_SOURCE_BRANCH_SHA nor " +
        "CI_COMMIT_SHA is set. This job diffs an exact source revision against its " +
        "base so a merged-results or merge-train checkout cannot contribute " +
        "target-only paths, so it will not fall back to the working tree.",
      changedPathCount: 0,
      sourcePaths: [],
      skippedPaths: [],
    };
  }

  const args = ["diff", "--name-only", "--diff-filter=ACMR", diffBaseSha, sourceSha, "--", "."];
  let stdout: string;
  try {
    ({ stdout } = await execute("git", args, {
      cwd: repositoryRoot,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    return {
      status: "diff-failed",
      reason: error instanceof Error ? error.message : String(error),
      changedPathCount: 0,
      sourcePaths: [],
      skippedPaths: [],
    };
  }

  const allChanged = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const supported = new Set(supportedSourceExtensions());
  const eligible: string[] = [];
  const skipped: string[] = [];
  for (const path of allChanged) {
    // Defense in depth: --source also refuses these, and name-only diff
    // output does not emit them.
    if (path.startsWith("../") || isAbsolute(path) || path.includes("\0")) {
      skipped.push(path);
      continue;
    }
    const dot = path.lastIndexOf(".");
    const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
    if (supported.has(extension)) {
      eligible.push(path);
    } else {
      skipped.push(path);
    }
  }

  return {
    status: "resolved",
    changedPathCount: allChanged.length,
    sourcePaths: [...new Set(eligible)],
    skippedPaths: skipped,
  };
}

export function buildInstruction(input: {
  readonly iid: string | undefined;
  readonly title: string | undefined;
  readonly targetBranch: string | undefined;
  readonly sourcePathCount: number;
  /** True when assessing a change set already merged to the default branch. */
  readonly landed?: boolean;
}): string {
  // On the default branch the change set has already merged.
  const fallback = input.landed ? "the change set that landed" : "this merge request";
  const identity = input.iid ? "merge request !" + input.iid : fallback;
  const titled = input.title ? ' ("' + input.title + '")' : "";
  const target = input.targetBranch ? (input.landed ? " on " : " into ") + input.targetBranch : "";
  const evidence =
    input.sourcePathCount > 0
      ? "The changed paths bound below as sources are the evidence for this change; the rest " +
        "of the repository is available for full context. "
      : "No changed path matched a supported --source extractor; assess the checkout itself, " +
        "including tracked documentation such as Markdown. ";
  return (
    "Assess the documentation impact of " +
    identity +
    titled +
    (input.landed ? "" : ", merging") +
    target +
    ". " +
    evidence +
    "If a user-facing reader would need documentation updated as a result of these " +
    "changes -- commands, configuration, defaults, installation, workflows, or " +
    "observable behavior -- make the minimal correct update. If no documentation " +
    "change is needed, report that plainly. If the available evidence is not enough " +
    "to decide, report the specific gap rather than guessing either way."
  );
}

async function stageScrubbedPatch(
  sourcePath: string,
  destinationPath: string,
): Promise<{ patchIncluded: boolean; patchSha256: string | null }> {
  const original = await readFile(sourcePath, "utf8");
  const cleaned = scrub(original);
  await writeFile(destinationPath, cleaned, "utf8");
  return {
    patchIncluded: true,
    patchSha256: createHash("sha256").update(cleaned, "utf8").digest("hex"),
  };
}

async function runWorkflowAssessment(input: {
  readonly workflow: (typeof ASSESSED_WORKFLOWS)[number];
  readonly runtimeRoot: string;
  readonly repositoryRoot: string;
  readonly instruction: string;
  readonly sourcePaths: readonly string[];
  readonly stageDirectory: string;
  readonly execute: ExecuteFn;
}): Promise<WorkflowAssessmentResult> {
  const sourceFlags = input.sourcePaths.flatMap((path) => ["--source", path]);
  const args = [
    "--import",
    "tsx",
    "src/cli.ts",
    "run",
    input.workflow,
    "--repo",
    input.repositoryRoot,
    "--revision",
    "HEAD",
    "--instruction",
    input.instruction,
    ...sourceFlags,
    "--patch-only",
    "--json",
  ];

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  try {
    const result = await input.execute(process.execPath, args, {
      cwd: input.runtimeRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    stdout = execError.stdout ?? "";
    stderr = execError.stderr ?? (error instanceof Error ? error.message : String(error));
    exitCode = typeof execError.code === "number" ? execError.code : 1;
  }

  let parsed: Record<string, unknown> | null = null;
  const trimmed = stdout.trim();
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  let patchIncluded = false;
  let patchSha256: string | null = null;
  const patchPathValue = parsed ? parsed.patchPath : undefined;
  const nestedPatchPath =
    parsed && isRecord(parsed.execution) && typeof parsed.execution.patchPath === "string"
      ? parsed.execution.patchPath
      : null;
  const patchPath = typeof patchPathValue === "string" ? patchPathValue : nestedPatchPath;
  if (patchPath) {
    try {
      const destination = join(input.stageDirectory, input.workflow + ".patch");
      const staged = await stageScrubbedPatch(patchPath, destination);
      patchIncluded = staged.patchIncluded;
      patchSha256 = staged.patchSha256;
    } catch {
      // No patch (e.g. a no-change verdict) is not a separate failure; the
      // outcome fields already say so.
    }
  }

  const editorialValue = parsed ? parsed.editorial : undefined;
  const editorial = isRecord(editorialValue) ? editorialValue : null;

  const stderrTrimmed = stderr.trim();
  const stderrTail =
    stderrTrimmed.length > 0 ? scrub(stderrTrimmed.split("\n").slice(-40).join("\n")) : null;

  return {
    workflow: input.workflow,
    status: parsed !== null ? "completed" : "invocation-error",
    exitCode,
    outcome: editorial ? (editorial.outcome ?? null) : null,
    decision: editorial ? (editorial.decision ?? null) : null,
    patchSha256,
    patchIncluded,
    raw: parsed ? scrubDeep(minimizeWorkflowJson(parsed)) : null,
    stderrTail,
  };
}

function skippedWorkflow(
  workflow: (typeof ASSESSED_WORKFLOWS)[number],
  outcome: unknown = null,
): WorkflowAssessmentResult {
  return {
    workflow,
    status: "skipped",
    exitCode: null,
    outcome,
    decision: null,
    patchSha256: null,
    patchIncluded: false,
    raw: null,
    stderrTail: null,
  };
}

async function writeArtifact(stageDirectory: string, artifact: unknown): Promise<unknown> {
  await mkdir(stageDirectory, { recursive: true });
  const sanitized = scrubDeep(artifact);
  await writeFile(
    join(stageDirectory, "result.json"),
    JSON.stringify(sanitized, null, 2) + "\n",
    "utf8",
  );
  return sanitized;
}

async function writeReadme(stageDirectory: string, lines: readonly string[]): Promise<void> {
  await writeFile(join(stageDirectory, "README.md"), scrub(lines.join("\n")) + "\n", "utf8");
}

export async function runMrDocumentationAssessment(
  runtime: AssessmentRuntime = defaultRuntime(),
): Promise<unknown> {
  const env = runtime.env;
  const stageDirectory = env.MR_ASSESSMENT_STAGE_DIR?.trim();
  if (!stageDirectory) {
    throw new Error("MR_ASSESSMENT_STAGE_DIR must name a collectable staging directory.");
  }
  await mkdir(stageDirectory, { recursive: true });

  const repositoryRoot = resolve(env.CI_PROJECT_DIR ?? process.cwd());
  const runtimeRoot = resolve(repositoryRoot, "packages/runtime");
  const identity = resolveChangeIdentity(env);
  const { iid, title, targetBranch } = identity;
  // A default-branch run assesses work that has already merged.
  const landed = identity.source !== "merge-request-variables";
  const { diffBaseSha, sourceSha } = resolveAssessmentRevisions(env);
  const configurationRoot = env.DOCSFAB_CONFIG_ROOT?.trim();

  const resolution = await resolveChangedPaths({
    repositoryRoot,
    diffBaseSha,
    sourceSha,
    execute: runtime.execute,
  });

  const credentialPrepared = await runtime.credentialPrepared(configurationRoot);
  const workflows: WorkflowAssessmentResult[] = [];

  if (!credentialPrepared) {
    for (const workflow of ASSESSED_WORKFLOWS) {
      workflows.push(skippedWorkflow(workflow, "insufficient-evidence"));
    }
    const artifact = {
      schemaVersion: 1,
      kind: "docsfab-mr-documentation-assessment",
      generatedAt: runtime.now().toISOString(),
      status: "insufficient-evidence",
      reason: MISSING_CREDENTIAL_REASON,
      mergeRequest: {
        iid: iid ?? null,
        title: title ?? null,
        targetBranch: targetBranch ?? null,
        identitySource: identity.source,
        diffBaseSha: diffBaseSha ?? null,
        sourceSha: sourceSha ?? null,
      },
      pathResolution: resolution,
      workflows,
    };
    const sanitized = await writeArtifact(stageDirectory, artifact);
    await writeReadme(stageDirectory, [
      "# MR documentation assessment (#1087)",
      "",
      "Non-blocking, informational only. See result.json for the structured verdict.",
      "A no-change or insufficient-evidence decision is a normal, expected result.",
      "",
      "Path resolution: " + resolution.status,
      "Credential: insufficient-evidence -- MODEL credential was not prepared.",
    ]);
    process.exitCode = 1;
    return sanitized;
  }

  if (resolution.status === "resolved") {
    const instruction = buildInstruction({
      iid,
      title,
      targetBranch,
      sourcePathCount: resolution.sourcePaths.length,
      landed,
    });
    for (const workflow of ASSESSED_WORKFLOWS) {
      workflows.push(
        await runWorkflowAssessment({
          workflow,
          runtimeRoot,
          repositoryRoot,
          instruction,
          sourcePaths: resolution.sourcePaths,
          stageDirectory,
          execute: runtime.execute,
        }),
      );
    }
  } else {
    for (const workflow of ASSESSED_WORKFLOWS) {
      workflows.push(skippedWorkflow(workflow, unresolvedOutcome(resolution.status)));
    }
  }

  const unresolved = resolution.status !== "resolved";
  const artifact = {
    schemaVersion: 1,
    kind: "docsfab-mr-documentation-assessment",
    generatedAt: runtime.now().toISOString(),
    // A run that resolved no change set says so in a coded field and a
    // non-zero exit, or it would read as a completed assessment.
    ...(unresolved
      ? {
          status: unresolvedOutcome(resolution.status),
          reason: resolution.reason ?? `Path resolution: ${resolution.status}.`,
        }
      : {}),
    mergeRequest: {
      iid: iid ?? null,
      title: title ?? null,
      targetBranch: targetBranch ?? null,
      // Provenance of the identity: variables, merge commit, or none.
      identitySource: identity.source,
      diffBaseSha: diffBaseSha ?? null,
      sourceSha: sourceSha ?? null,
    },
    pathResolution: resolution,
    workflows,
  };

  const sanitized = await writeArtifact(stageDirectory, artifact);
  const workflowLines = workflows.map(
    (workflow) =>
      "Workflow " +
      workflow.workflow +
      ": " +
      workflow.status +
      (workflow.outcome ? ", outcome=" + String(workflow.outcome) : ""),
  );
  await writeReadme(stageDirectory, [
    "# MR documentation assessment (#1087)",
    "",
    "Non-blocking, informational only. See result.json for the structured verdict.",
    "A no-change or insufficient-evidence decision is a normal, expected result --",
    "the question this job answers is whether that decision was correct for this",
    "the real content of this merge request, not whether it matches a fixed baseline.",
    "",
    "Path resolution: " + resolution.status + (resolution.reason ? " -- " + resolution.reason : ""),
    ...workflowLines,
  ]);
  // The job is allow_failure, so this never gates a merge; the non-zero exit
  // signals that the run assessed nothing.
  if (unresolved) process.exitCode = 1;
  return sanitized;
}

async function reportFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error("run-mr-documentation-assessment: " + message);
  // Even a crash must not leave the artifact missing: write what we can, then
  // fail the step.
  const stageDirectory = process.env.MR_ASSESSMENT_STAGE_DIR?.trim();
  if (stageDirectory) {
    try {
      await writeArtifact(stageDirectory, {
        schemaVersion: 1,
        kind: "docsfab-mr-documentation-assessment",
        generatedAt: new Date().toISOString(),
        status: "resolution-error",
        error: message,
      });
    } catch {
      // Best effort; the job's own failure text already carries the message.
    }
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = resolve(new URL(import.meta.url).pathname);
if (invokedPath === modulePath) {
  runMrDocumentationAssessment().catch(reportFailure);
}
