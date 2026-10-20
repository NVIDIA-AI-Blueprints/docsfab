// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import { decodeThreatModelV1, THREAT_MODEL_ID } from "./threat-model-contract.js";
import { sha256 } from "../content-ir/canonical.js";
import { isDnsHostname } from "../shared/dns-hostname.js";

const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u;
// Repository-relative directory: no leading, trailing, or empty segment, and no
// segment that starts with a dot, so ".", "..", and hidden directories are refused.
const PACKAGE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/u;
const USERNAME = /^[A-Za-z0-9_.-]+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SETTLING_MERGE_STATUSES = new Set(["checking", "approvals_syncing"]);
const MAX_API_BYTES = 1_000_000;
const REQUIRED_ROLES = ["security", "product"] as const;
// The verifier reads exactly these files under the candidate's packagePath; the
// glab path gate admits no others.
const CANDIDATE_FILE = "security/threat-model-reviews.v1.json";
const MODEL_FILE = "security/threat-model.v1.json";
const DOCUMENT_FILE = "docs/about/security-threat-model.md";
type ReviewRole = (typeof REQUIRED_ROLES)[number];

export interface ThreatModelReviewCandidateV1 {
  schemaVersion: 1;
  kind: "docsfab-threat-model-review-candidate";
  modelId: typeof THREAT_MODEL_ID;
  modelSha256: string;
  documentSha256: string;
  projectPath: string;
  /** Repository-relative directory of the package that holds the reviewed files. */
  packagePath: string;
  gitlabHost: string;
  protocol: "external-gitlab-approval-v1";
  requiredApprovalRules: Record<ReviewRole, string>;
  status: "external-approval-required";
}

export interface ThreatModelReviewEvidenceRequestV1 {
  schemaVersion: 1;
  kind: "docsfab-threat-model-external-review-request";
  mergeRequestIid: number;
  candidateCommit: string;
  approvals: Array<{ role: ReviewRole; approvalNoteId: number }>;
}

export interface VerifiedThreatModelReviewsV1 {
  schemaVersion: 1;
  kind: "docsfab-verified-threat-model-reviews";
  modelId: typeof THREAT_MODEL_ID;
  gitlabHost: string;
  projectPath: string;
  mergeRequestIid: number;
  candidateCommit: string;
  modelSha256: string;
  documentSha256: string;
  approvals: Array<{
    role: ReviewRole;
    approvalRuleId: number;
    approvalNoteId: number;
    reviewerUserId: number;
  }>;
}

export interface ThreatModelReviewApi {
  readonly host: string;
  get(path: string): Promise<unknown>;
}

export class ThreatModelReviewVerificationError extends Error {
  readonly code = "invalid-threat-model-review-evidence" as const;

  constructor() {
    super("Threat-model review evidence is missing, stale, or invalid.");
    this.name = "ThreatModelReviewVerificationError";
  }
}

/** Operator setting naming the only GitLab host that receives glab credentials for review reads. */
export const THREAT_MODEL_REVIEW_GITLAB_HOST_ENV = "DOCSFAB_THREAT_MODEL_REVIEW_GITLAB_HOST";

export class ThreatModelReviewHostError extends Error {
  constructor(
    message: string,
    readonly code: "threat-model-review-host-required" | "threat-model-review-host-mismatch",
  ) {
    super(message);
    this.name = "ThreatModelReviewHostError";
  }
}

export function decodeThreatModelReviewCandidate(
  value: string | Uint8Array | unknown,
): ThreatModelReviewCandidateV1 {
  const root = closed(parsed(value), [
    "schemaVersion",
    "kind",
    "modelId",
    "modelSha256",
    "documentSha256",
    "projectPath",
    "packagePath",
    "gitlabHost",
    "protocol",
    "requiredApprovalRules",
    "status",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-threat-model-review-candidate" ||
    !isDnsHostname(root.gitlabHost) ||
    root.protocol !== "external-gitlab-approval-v1" ||
    root.status !== "external-approval-required"
  )
    invalid();
  if (root.modelId !== THREAT_MODEL_ID) invalid();
  digest(root.modelSha256);
  digest(root.documentSha256);
  if (typeof root.projectPath !== "string" || !PROJECT_PATH.test(root.projectPath)) invalid();
  if (!isPackagePath(root.packagePath)) invalid();
  const rules = closed(root.requiredApprovalRules, REQUIRED_ROLES);
  for (const role of REQUIRED_ROLES) text(rules[role], 128);
  if (rules.security === rules.product) invalid();
  return root as unknown as ThreatModelReviewCandidateV1;
}

export function decodeThreatModelReviewEvidenceRequest(
  value: string | Uint8Array | unknown,
): ThreatModelReviewEvidenceRequestV1 {
  const root = closed(parsed(value), [
    "schemaVersion",
    "kind",
    "mergeRequestIid",
    "candidateCommit",
    "approvals",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-threat-model-external-review-request")
    invalid();
  positiveInteger(root.mergeRequestIid);
  if (typeof root.candidateCommit !== "string" || !COMMIT.test(root.candidateCommit)) invalid();
  const approvals = denseArray(root.approvals).map((value) => {
    const approval = closed(value, ["role", "approvalNoteId"]);
    if (!REQUIRED_ROLES.includes(approval.role as ReviewRole)) invalid();
    positiveInteger(approval.approvalNoteId);
    return approval as unknown as { role: ReviewRole; approvalNoteId: number };
  });
  if (
    approvals.length !== REQUIRED_ROLES.length ||
    new Set(approvals.map(({ role }) => role)).size !== REQUIRED_ROLES.length ||
    new Set(approvals.map(({ approvalNoteId }) => approvalNoteId)).size !== approvals.length
  )
    invalid();
  approvals.sort(
    (left, right) => REQUIRED_ROLES.indexOf(left.role) - REQUIRED_ROLES.indexOf(right.role),
  );
  root.approvals = approvals;
  return root as unknown as ThreatModelReviewEvidenceRequestV1;
}

export async function verifyThreatModelReviews(
  candidateValue: ThreatModelReviewCandidateV1 | unknown,
  requestValue: ThreatModelReviewEvidenceRequestV1 | unknown,
  api: ThreatModelReviewApi,
): Promise<VerifiedThreatModelReviewsV1> {
  const candidate = decodeThreatModelReviewCandidate(candidateValue);
  const request = decodeThreatModelReviewEvidenceRequest(requestValue);
  // Evidence is only trusted from the GitLab host the candidate names.
  if (api.host !== candidate.gitlabHost) hostMismatch(candidate.gitlabHost, api.host);
  const project = encodeURIComponent(candidate.projectPath);
  const mrBase = `projects/${project}/merge_requests/${request.mergeRequestIid}`;
  const mergeRequest = closed(
    await api.get(mrBase),
    ["id", "iid", "project_id", "sha", "state", "detailed_merge_status"],
    true,
  );
  const initialMergeRequest = settledMergeRequest(
    mergeRequest,
    request.mergeRequestIid,
    request.candidateCommit,
  );
  const initialDiff = currentDiffVersion(
    await api.get(`${mrBase}/versions`),
    initialMergeRequest.id,
    request.candidateCommit,
  );
  const approvalSettings = closed(
    await api.get(`projects/${project}/approvals`),
    ["reset_approvals_on_push"],
    true,
  );
  if (approvalSettings.reset_approvals_on_push !== true) invalid();

  const [candidateFile, modelFile, documentFile] = reviewFilePaths(candidate.packagePath);
  const remoteCandidateBytes = await repositoryFile(
    api,
    project,
    candidateFile,
    request.candidateCommit,
  );
  const remoteCandidate = decodeThreatModelReviewCandidate(remoteCandidateBytes);
  if (canonical(remoteCandidate) !== canonical(candidate)) invalid();
  const [modelBytes, documentBytes] = await Promise.all([
    repositoryFile(api, project, modelFile, request.candidateCommit),
    repositoryFile(api, project, documentFile, request.candidateCommit),
  ]);
  if (
    sha256(modelBytes) !== candidate.modelSha256 ||
    sha256(documentBytes) !== candidate.documentSha256
  )
    invalid();
  const model = decodeThreatModelV1(modelBytes);
  if (model.modelId !== candidate.modelId) invalid();
  const reviewGate = object(model.reviewGate);
  if (canonical(reviewGate.approvalRuleNames) !== canonical(candidate.requiredApprovalRules))
    invalid();

  const approvalState = closed(
    await api.get(`${mrBase}/approval_state`),
    ["approval_rules_overwritten", "rules"],
    true,
  );
  if (approvalState.approval_rules_overwritten !== false) invalid();
  const rules = denseArray(approvalState.rules);
  const approvalsState = closed(await api.get(`${mrBase}/approvals`), ["approved_by"], true);
  const currentlyApproved = userMap(approvalsState.approved_by);
  const verified: VerifiedThreatModelReviewsV1["approvals"] = [];
  const reviewerIds = new Set<number>();

  for (const requested of request.approvals) {
    const expectedRuleName = candidate.requiredApprovalRules[requested.role];
    const matchingRules = rules.filter((value) => {
      const item = object(value);
      return item.name === expectedRuleName;
    });
    if (matchingRules.length !== 1) invalid();
    const rule = closed(
      matchingRules[0],
      ["id", "name", "rule_type", "approvals_required", "approved", "approved_by"],
      true,
    );
    positiveInteger(rule.id);
    positiveInteger(rule.approvals_required);
    if (rule.name !== expectedRuleName || rule.rule_type !== "regular" || rule.approved !== true)
      invalid();
    const ruleApproved = userMap(rule.approved_by);
    const note = closed(
      await api.get(`${mrBase}/notes/${requested.approvalNoteId}`),
      ["id", "body", "system", "author", "noteable_iid", "noteable_type", "project_id"],
      true,
    );
    if (
      note.id !== requested.approvalNoteId ||
      note.body !== "approved this merge request" ||
      note.system !== true ||
      note.noteable_iid !== request.mergeRequestIid ||
      note.noteable_type !== "MergeRequest" ||
      note.project_id !== initialMergeRequest.projectId
    )
      invalid();
    const author = gitlabUser(note.author);
    const ruleUser = ruleApproved.get(author.id);
    const currentUser = currentlyApproved.get(author.id);
    if (
      !ruleUser ||
      !currentUser ||
      ruleUser.username !== author.username ||
      currentUser.username !== author.username ||
      reviewerIds.has(author.id)
    )
      invalid();
    reviewerIds.add(author.id);
    verified.push({
      role: requested.role,
      approvalRuleId: rule.id as number,
      approvalNoteId: requested.approvalNoteId,
      reviewerUserId: author.id,
    });
  }

  // Re-pin every mutable GitLab fact after the awaited note reads. A push,
  // revocation, or rule override during verification must not yield a receipt.
  const [
    finalMergeRequestValue,
    finalVersionsValue,
    finalSettingsValue,
    finalStateValue,
    finalApprovalsValue,
  ] = await Promise.all([
    api.get(mrBase),
    api.get(`${mrBase}/versions`),
    api.get(`projects/${project}/approvals`),
    api.get(`${mrBase}/approval_state`),
    api.get(`${mrBase}/approvals`),
  ]);
  const finalMergeRequest = settledMergeRequest(
    closed(
      finalMergeRequestValue,
      ["id", "iid", "project_id", "sha", "state", "detailed_merge_status"],
      true,
    ),
    request.mergeRequestIid,
    request.candidateCommit,
  );
  const finalDiff = currentDiffVersion(
    finalVersionsValue,
    finalMergeRequest.id,
    request.candidateCommit,
  );
  const finalSettings = closed(finalSettingsValue, ["reset_approvals_on_push"], true);
  const finalState = closed(finalStateValue, ["approval_rules_overwritten", "rules"], true);
  const finalApprovals = closed(finalApprovalsValue, ["approved_by"], true);
  if (
    finalMergeRequest.projectId !== initialMergeRequest.projectId ||
    finalMergeRequest.id !== initialMergeRequest.id ||
    finalDiff.id !== initialDiff.id ||
    finalDiff.patchIdSha !== initialDiff.patchIdSha ||
    finalSettings.reset_approvals_on_push !== true ||
    finalState.approval_rules_overwritten !== false
  )
    invalid();
  const finalRules = denseArray(finalState.rules);
  const finalApprovedUsers = userMap(finalApprovals.approved_by);
  for (const approval of verified) {
    const expectedName = candidate.requiredApprovalRules[approval.role];
    const matches = finalRules.filter((value) => {
      const rule = object(value);
      return rule.id === approval.approvalRuleId && rule.name === expectedName;
    });
    if (matches.length !== 1) invalid();
    const rule = closed(
      matches[0],
      ["id", "name", "rule_type", "approvals_required", "approved", "approved_by"],
      true,
    );
    positiveInteger(rule.approvals_required);
    if (
      rule.rule_type !== "regular" ||
      rule.approved !== true ||
      !userMap(rule.approved_by).has(approval.reviewerUserId) ||
      !finalApprovedUsers.has(approval.reviewerUserId)
    )
      invalid();
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-verified-threat-model-reviews",
    modelId: candidate.modelId,
    gitlabHost: candidate.gitlabHost,
    projectPath: candidate.projectPath,
    mergeRequestIid: request.mergeRequestIid,
    candidateCommit: request.candidateCommit,
    modelSha256: candidate.modelSha256,
    documentSha256: candidate.documentSha256,
    approvals: verified.map((approval) => Object.freeze(approval)),
  });
}

export class GlabThreatModelReviewApi implements ThreatModelReviewApi {
  private readonly allowedPath: RegExp;

  constructor(
    private readonly cwd: string,
    readonly host: string,
    packagePath: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    if (!isDnsHostname(host) || !isPackagePath(packagePath)) invalid();
    // The candidate host is repository data; only the operator's setting may
    // decide where glab sends its credentials.
    const trusted = environment[THREAT_MODEL_REVIEW_GITLAB_HOST_ENV];
    if (!isDnsHostname(trusted)) {
      throw new ThreatModelReviewHostError(
        `Set ${THREAT_MODEL_REVIEW_GITLAB_HOST_ENV} to the bare lowercase hostname of the GitLab that holds the threat-model review.`,
        "threat-model-review-host-required",
      );
    }
    if (host !== trusted) hostMismatch(host, trusted);
    this.allowedPath = reviewApiPath(packagePath);
  }

  async get(path: string): Promise<unknown> {
    if (!this.allowedPath.test(path)) invalid();
    const output = await runGlab(
      ["api", "--hostname", this.host, path],
      this.cwd,
      this.environment,
    );
    try {
      return JSON.parse(output.toString("utf8")) as unknown;
    } catch {
      invalid();
    }
  }
}

const PROJECT_API_PATH = "[A-Za-z0-9_.-]+(?:%2F[A-Za-z0-9_.-]+)+";

function isPackagePath(value: unknown): value is string {
  return typeof value === "string" && PACKAGE_PATH.test(value);
}

function reviewFilePaths(packagePath: string): readonly [string, string, string] {
  return [
    `${packagePath}/${CANDIDATE_FILE}`,
    `${packagePath}/${MODEL_FILE}`,
    `${packagePath}/${DOCUMENT_FILE}`,
  ];
}

/** Endpoint grammar for one client: the review endpoints plus the three files under packagePath. */
function reviewApiPath(packagePath: string): RegExp {
  const files = reviewFilePaths(packagePath)
    .map((path) => encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  return new RegExp(
    `^projects\\/${PROJECT_API_PATH}\\/(?:` +
      `approvals|` +
      `merge_requests\\/[1-9]\\d*(?:\\/(?:approval_state|approvals|versions|notes\\/[1-9]\\d*))?|` +
      `repository\\/files\\/(?:${files})\\?ref=[0-9a-f]{40}` +
      `)$`,
    "u",
  );
}

async function repositoryFile(
  api: ThreatModelReviewApi,
  project: string,
  path: string,
  revision: string,
): Promise<Buffer> {
  const encodedPath = encodeURIComponent(path);
  const response = closed(
    await api.get(`projects/${project}/repository/files/${encodedPath}?ref=${revision}`),
    ["file_path", "encoding", "content", "blob_id", "commit_id"],
    true,
  );
  if (
    response.file_path !== path ||
    response.encoding !== "base64" ||
    response.commit_id !== revision ||
    typeof response.content !== "string" ||
    !/^[A-Za-z0-9+/=\r\n]+$/u.test(response.content) ||
    response.content.length > 2_000_000
  )
    invalid();
  const bytes = Buffer.from(response.content.replace(/\s/gu, ""), "base64");
  if (bytes.length === 0 || bytes.length > MAX_API_BYTES) invalid();
  return bytes;
}

function userMap(value: unknown): Map<number, { id: number; username: string }> {
  const users = denseArray(value).map((entry) => {
    const source = object(entry);
    return gitlabUser(Object.hasOwn(source, "user") ? source.user : source);
  });
  const result = new Map<number, { id: number; username: string }>();
  for (const user of users) {
    if (result.has(user.id)) invalid();
    result.set(user.id, user);
  }
  return result;
}

function gitlabUser(value: unknown): { id: number; username: string } {
  const user = closed(value, ["id", "username"], true);
  positiveInteger(user.id);
  if (typeof user.username !== "string" || !USERNAME.test(user.username)) invalid();
  return { id: user.id as number, username: user.username };
}

function runGlab(args: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("glab", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: threatModelReviewGlabEnvironment(environment),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new ThreatModelReviewVerificationError());
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("timeout"));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_API_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("output"));
      } else chunks.push(Buffer.from(chunk));
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(code === 0 ? undefined : new Error("exit")));
  });
}

/** Closed environment for read-only GitLab review API calls; no Git/SSH capability. */
function threatModelReviewGlabEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    TMPDIR: source.TMPDIR,
    GLAB_TOKEN: source.GLAB_TOKEN,
    GITLAB_TOKEN: source.GITLAB_TOKEN,
    LC_ALL: "C",
    LANG: "C",
    NO_COLOR: "1",
    PAGER: "cat",
    GLAB_PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  return Object.fromEntries(Object.entries(result).filter((entry) => entry[1] !== undefined));
}

function settledMergeRequest(
  value: Record<string, unknown>,
  expectedIid: number,
  expectedCommit: string,
): { id: number; projectId: number } {
  positiveInteger(value.id);
  positiveInteger(value.project_id);
  if (
    value.iid !== expectedIid ||
    value.sha !== expectedCommit ||
    value.state !== "opened" ||
    typeof value.detailed_merge_status !== "string" ||
    SETTLING_MERGE_STATUSES.has(value.detailed_merge_status)
  )
    invalid();
  text(value.detailed_merge_status, 64);
  return { id: value.id, projectId: value.project_id };
}

function currentDiffVersion(
  value: unknown,
  mergeRequestId: number,
  expectedCommit: string,
): { id: number; patchIdSha: string } {
  const versions = denseArray(value);
  if (versions.length === 0) invalid();
  const current = closed(
    versions[0],
    ["id", "head_commit_sha", "merge_request_id", "state", "patch_id_sha"],
    true,
  );
  positiveInteger(current.id);
  if (
    current.head_commit_sha !== expectedCommit ||
    current.merge_request_id !== mergeRequestId ||
    current.state !== "collected" ||
    typeof current.patch_id_sha !== "string" ||
    !COMMIT.test(current.patch_id_sha)
  )
    invalid();
  return { id: current.id, patchIdSha: current.patch_id_sha };
}

function parsed(value: string | Uint8Array | unknown): unknown {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) return value;
  try {
    return JSON.parse(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
  } catch {
    invalid();
  }
}

function closed(
  value: unknown,
  keys: readonly string[],
  allowExtra = false,
): Record<string, unknown> {
  const result = object(value);
  if (
    !allowExtra &&
    (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
  )
    invalid();
  if (allowExtra && keys.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}

function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  return value as Record<string, unknown>;
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length || value.length > 128)
    invalid();
  return value;
}

function positiveInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid();
}

function text(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) invalid();
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function invalid(): never {
  throw new ThreatModelReviewVerificationError();
}

function hostMismatch(candidateHost: string, clientHost: string): never {
  throw new ThreatModelReviewHostError(
    `The review candidate names GitLab host ${candidateHost}, but the review client is bound to ${clientHost} (${THREAT_MODEL_REVIEW_GITLAB_HOST_ENV}); no GitLab request was made.`,
    "threat-model-review-host-mismatch",
  );
}
