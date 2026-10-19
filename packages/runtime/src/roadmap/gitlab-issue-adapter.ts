// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import { runtimeEgressRootSet } from "../config/egress-roots.js";
import { egressText } from "../security/egress.js";
import { processPublicRoots } from "../security/host-roots.js";
import { roadmapDigest } from "./contracts/decode.js";
import { type RoadmapProjectIdentity } from "./contracts/ledger.js";
import { roadmapProjectEffectProofDigestV2, type RoadmapEffectIdentity } from "./execution-v2.js";
import {
  IssueLifecycleAdapterError,
  issueIdentityDigest,
  issueEffectIdentity,
  linkIdentityDigest,
  milestoneIdentityDigest,
  milestoneEffectIdentity,
  noteIdentityDigest,
  type IssueLifecycleMutationContext,
  type IssueLifecycleMutationMaterial,
  type IssueLifecycleProviderAdapter,
  type IssueLifecycleReconciliation,
  type IssueTrackerIssue,
  type IssueTrackerLink,
  type IssueTrackerMilestone,
  type IssueTrackerNote,
} from "./issue-adapter.js";
import { compareText } from "../shared/primitives.js";

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_PAGES = 10;
const SAFE_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const SAFE_PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MINIMUM_MUTATION_ACCESS = 30;

export interface GitLabIssueCommandResult {
  exitCode: number;
  stdout: Buffer;
  failure: "none" | "authentication" | "permission" | "not-found" | "conflict" | "external";
}

export interface GitLabIssueCommandRunner {
  run(
    command: "glab",
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
  ): Promise<GitLabIssueCommandResult>;
}

export class ExecGitLabIssueCommandRunner implements GitLabIssueCommandRunner {
  public run(
    command: "glab",
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
  ): Promise<GitLabIssueCommandResult> {
    return new Promise((resolveResult) => {
      const child = spawn(command, [...args], {
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const terminate = (): void => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const detail = Buffer.concat(stderr).toString("utf8").toLowerCase();
        const failure: GitLabIssueCommandResult["failure"] =
          exitCode === 0
            ? "none"
            : /401|authentication|unauthorized/u.test(detail)
              ? "authentication"
              : /403|forbidden|permission/u.test(detail)
                ? "permission"
                : /404|not found/u.test(detail)
                  ? "not-found"
                  : /409|conflict/u.test(detail)
                    ? "conflict"
                    : "external";
        resolveResult({ exitCode, stdout: Buffer.concat(stdout), failure });
      };
      const timer = setTimeout(() => {
        terminate();
        finish(1);
      }, options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > options.maxOutputBytes) {
          terminate();
          finish(1);
        } else stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= 65_536) stderr.push(Buffer.from(chunk));
      });
      child.once("error", () => finish(1));
      child.once("close", (code) => finish(code === 0 ? 0 : 1));
    });
  }
}

/** Fixed-command local-user GitLab issue adapter. Raw API responses never escape. */
export class LocalUserGitLabIssueAdapter implements IssueLifecycleProviderAdapter {
  public readonly provider = "gitlab";
  private readonly environment: NodeJS.ProcessEnv;
  private readonly publicRoots: ReadonlySet<string>;

  /**
   * `environment` defaults to this process's, whose public roots are the
   * startup set. Throws `PublicRootsOperatorError` when an explicit
   * environment's `DOCSFAB_PUBLIC_ROOTS` is invalid.
   */
  public constructor(
    private readonly commands: GitLabIssueCommandRunner = new ExecGitLabIssueCommandRunner(),
    environment?: NodeJS.ProcessEnv,
  ) {
    this.environment = environment ?? process.env;
    this.publicRoots = processPublicRoots(environment);
  }

  public async preflight(project: RoadmapProjectIdentity) {
    assertProject(project);
    const auth = await this.run(["auth", "status", "--hostname", project.host]);
    if (auth.exitCode !== 0) fail("authentication-unavailable");
    const user = object(await this.json(["api", "--hostname", project.host, "user"]));
    const username = string(user.username, 128);
    if (!SAFE_USERNAME.test(username)) fail("invalid-response");
    const rawProject = object(
      await this.json(["api", "--hostname", project.host, `projects/${project.projectId}`]),
    );
    if (
      integer(rawProject.id) !== project.projectId ||
      string(rawProject.path_with_namespace, 512) !== project.fullPath
    )
      fail("project-drift");
    const permissions = object(rawProject.permissions);
    const accessLevel = Math.max(
      access(objectOrEmpty(permissions.project_access)),
      access(objectOrEmpty(permissions.group_access)),
    );
    if (accessLevel < MINIMUM_MUTATION_ACCESS) fail("permission-denied");
    const defaultBranch =
      rawProject.default_branch === null ? "" : string(rawProject.default_branch, 255);
    return freeze({
      identity: {
        provider: "gitlab",
        host: project.host,
        username,
        identityDigest: roadmapDigest({ provider: "gitlab", host: project.host, username }),
      },
      project: { project: { ...project }, accessLevel, defaultBranch },
    });
  }

  public async searchIssues(
    project: RoadmapProjectIdentity,
    query: string,
  ): Promise<IssueTrackerIssue[]> {
    assertProject(project);
    if (!query || query.length > 256 || /[\0-\x1f\x7f]/u.test(query)) fail("invalid-response");
    const endpoint = `projects/${project.projectId}/issues?scope=all&search=${encodeURIComponent(query)}`;
    return (await this.pages(project, endpoint)).map(issue);
  }

  public async searchMilestones(
    project: RoadmapProjectIdentity,
    query: string,
  ): Promise<IssueTrackerMilestone[]> {
    assertProject(project);
    if (!query || query.length > 256 || /[\0-\x1f\x7f]/u.test(query)) fail("invalid-response");
    const endpoint = `projects/${project.projectId}/milestones?search=${encodeURIComponent(query)}`;
    return (await this.pages(project, endpoint)).map(milestone);
  }

  public async getIssue(
    project: RoadmapProjectIdentity,
    iid: number,
  ): Promise<IssueTrackerIssue | undefined> {
    const value = await this.optionalJson(
      project,
      `projects/${project.projectId}/issues/${positive(iid)}`,
    );
    return value === undefined ? undefined : issue(value);
  }

  public async getMilestone(
    project: RoadmapProjectIdentity,
    iid: number,
  ): Promise<IssueTrackerMilestone | undefined> {
    const values = await this.pages(
      project,
      `projects/${project.projectId}/milestones?iids%5B%5D=${positive(iid)}`,
    );
    const matches = values.map(milestone).filter((item) => item.iid === iid);
    if (matches.length > 1) fail("invalid-response");
    return matches[0];
  }

  public async listLabels(project: RoadmapProjectIdentity): Promise<string[]> {
    return (await this.pages(project, `projects/${project.projectId}/labels`))
      .map((value) => string(object(value).name, 128))
      .sort(compareText);
  }

  public async listLinks(
    project: RoadmapProjectIdentity,
    iid: number,
  ): Promise<IssueTrackerLink[]> {
    const values = await this.pages(
      project,
      `projects/${project.projectId}/issues/${positive(iid)}/links`,
    );
    return values.map((value) => link(value, iid));
  }

  public async reconcile(
    context: IssueLifecycleMutationContext,
  ): Promise<IssueLifecycleReconciliation> {
    const material = this.outbound(context.material);
    if (material.action === "create-issue" || material.action === "create-saga") {
      const marker = operationMarker(context);
      const matches = (await this.searchIssues(context.project, marker)).filter(
        (item) => item.descriptionDigest === textDigest(withMarker(material.description, marker)),
      );
      if (matches.length > 1) return { disposition: "ambiguous", failureCode: "duplicate-create" };
      return matches.length === 1
        ? {
            disposition: "found",
            effect: issueEffectIdentity(matches[0]!, context.operationProofDigest),
          }
        : { disposition: "absent" };
    }
    if (material.action === "create-milestone") {
      const marker = operationMarker(context);
      const matches = (await this.searchMilestones(context.project, material.title)).filter(
        (item) =>
          item.titleDigest === textDigest(material.title) &&
          item.descriptionDigest === textDigest(withMarker(material.description, marker)),
      );
      if (matches.length > 1) return { disposition: "ambiguous", failureCode: "duplicate-create" };
      if (matches.length === 1)
        return {
          disposition: "found",
          effect: milestoneEffectIdentity(matches[0]!, context.operationProofDigest),
        };
      return { disposition: "absent" };
    }
    if (material.action === "comment") {
      const target = requiredIssue(context.targetIssue);
      const marker = operationMarker(context);
      const notes = await this.pages(
        context.project,
        `projects/${context.project.projectId}/issues/${target.iid}/notes?sort=asc&order_by=created_at`,
      );
      const matches = notes.filter((value) => string(object(value).body, 262_144).includes(marker));
      if (matches.length > 1) return { disposition: "ambiguous", failureCode: "duplicate-note" };
      return matches.length === 1
        ? { disposition: "found", effect: noteEffect(note(matches[0]!, target.iid)) }
        : { disposition: "absent" };
    }
    if (material.action === "link-parent-task") {
      const target = requiredIssue(context.targetIssue);
      const related = requiredIssue(context.relatedIssue);
      const marker = operationMarker(context);
      const notes = await this.pages(
        context.project,
        `projects/${context.project.projectId}/issues/${target.iid}/notes?sort=asc&order_by=created_at`,
      );
      const matches = notes.filter((value) => string(object(value).body, 262_144).includes(marker));
      if (matches.length > 1) return { disposition: "ambiguous", failureCode: "duplicate-link" };
      if (matches.length === 0) return { disposition: "absent" };
      return {
        disposition: "found",
        effect: parentTaskEffect(note(matches[0]!, target.iid), related.iid),
      };
    }
    if (material.action === "link-related" || material.action === "link-blocks") {
      const target = requiredIssue(context.targetIssue);
      const related = requiredIssue(context.relatedIssue);
      const desired = material.action === "link-related" ? "related" : "blocks";
      const matches = (await this.listLinks(context.project, target.iid)).filter(
        (item) => item.relatedIid === related.iid && item.linkType === desired,
      );
      if (matches.length > 1) return { disposition: "ambiguous", failureCode: "duplicate-link" };
      return matches.length === 1
        ? { disposition: "found", effect: linkEffect(matches[0]!) }
        : { disposition: "absent" };
    }
    const target = requiredIssue(context.targetIssue);
    if (
      (material.action === "update-title" && target.titleDigest === textDigest(material.title)) ||
      (material.action === "update-description" &&
        target.descriptionDigest === textDigest(material.description)) ||
      (material.action === "add-labels" &&
        material.labels.every((label) => target.labels.includes(label))) ||
      (material.action === "remove-labels" &&
        material.labels.every((label) => !target.labels.includes(label))) ||
      (material.action === "assign-milestone" && target.milestoneIid === material.milestoneIid) ||
      (material.action === "close" && target.state === "closed") ||
      (material.action === "reopen" && target.state === "opened")
    ) {
      return { disposition: "found", effect: issueEffectIdentity(target) };
    }
    return { disposition: "absent" };
  }

  public async mutate(context: IssueLifecycleMutationContext): Promise<RoadmapEffectIdentity> {
    context.assertAuthorized();
    const material = this.outbound(context.material);
    if (material.action === "create-issue" || material.action === "create-saga") {
      if (material.milestoneIid !== undefined)
        await this.assertCurrentMilestone(context, material.milestoneIid);
      const fields = [
        `title=${material.title}`,
        `description=${withMarker(material.description, operationMarker(context))}`,
        `labels=${material.labels.join(",")}`,
        ...(material.milestoneIid === undefined
          ? []
          : [`milestone_id=${context.targetMilestone!.externalId}`]),
      ];
      const value = await this.authorizedMutation(
        context,
        "POST",
        `projects/${context.project.projectId}/issues`,
        fields,
      );
      return issueEffectIdentity(issue(value), context.operationProofDigest);
    }
    if (material.action === "create-milestone") {
      const fields = [
        `title=${material.title}`,
        `description=${withMarker(material.description, operationMarker(context))}`,
        ...(material.dueDate ? [`due_date=${material.dueDate}`] : []),
      ];
      return milestoneEffectIdentity(
        milestone(
          await this.authorizedMutation(
            context,
            "POST",
            `projects/${context.project.projectId}/milestones`,
            fields,
          ),
        ),
        context.operationProofDigest,
      );
    }
    const target = await this.assertCurrentIssue(context);
    if (material.action === "assign-milestone")
      await this.assertCurrentMilestone(context, material.milestoneIid);
    if (material.action === "comment") {
      const value = await this.authorizedMutation(
        context,
        "POST",
        `projects/${context.project.projectId}/issues/${target.iid}/notes`,
        [`body=${withMarker(material.body, operationMarker(context))}`],
      );
      return noteEffect(note(value, target.iid));
    }
    if (material.action.startsWith("link-")) {
      const related = requiredIssue(context.relatedIssue);
      await this.assertIssueCurrent(context.project, related);
      if (material.action === "link-parent-task") {
        const marker = operationMarker(context);
        const body = `${marker}\n- [ ] #${related.iid}`;
        const value = await this.authorizedMutation(
          context,
          "POST",
          `projects/${context.project.projectId}/issues/${target.iid}/notes`,
          [`body=${body}`],
        );
        return parentTaskEffect(note(value, target.iid), related.iid);
      }
      const linkType = material.action === "link-blocks" ? "blocks" : "relates_to";
      const value = await this.authorizedMutation(
        context,
        "POST",
        `projects/${context.project.projectId}/issues/${target.iid}/links`,
        [
          `target_project_id=${context.project.projectId}`,
          `target_issue_iid=${related.iid}`,
          `link_type=${linkType}`,
        ],
      );
      return linkEffect(link(value, target.iid));
    }
    const fields: string[] =
      material.action === "update-title"
        ? [`title=${material.title}`]
        : material.action === "update-description"
          ? [`description=${material.description}`]
          : material.action === "add-labels"
            ? [`add_labels=${material.labels.join(",")}`]
            : material.action === "remove-labels"
              ? [`remove_labels=${material.labels.join(",")}`]
              : material.action === "assign-milestone"
                ? [`milestone_id=${context.targetMilestone!.externalId}`]
                : material.action === "close"
                  ? ["state_event=close"]
                  : material.action === "reopen"
                    ? ["state_event=reopen"]
                    : unsupported();
    return issueEffectIdentity(
      issue(
        await this.authorizedMutation(
          context,
          "PUT",
          `projects/${context.project.projectId}/issues/${target.iid}`,
          fields,
        ),
      ),
    );
  }

  /**
   * Material as published, with this host's roots replaced. Reconcile and
   * mutate both use it, so digests of created text match on retry.
   */
  private outbound(material: IssueLifecycleMutationMaterial): IssueLifecycleMutationMaterial {
    const roots = runtimeEgressRootSet({
      environment: this.environment,
      publicRoots: this.publicRoots,
    });
    const egress = (text: string): string => {
      const result = egressText(text, roots);
      if (!result.ok) fail("material-invalid");
      return result.text;
    };
    return {
      ...material,
      ...("title" in material ? { title: egress(material.title) } : {}),
      ...("description" in material ? { description: egress(material.description) } : {}),
      ...("body" in material ? { body: egress(material.body) } : {}),
    } as IssueLifecycleMutationMaterial;
  }

  private async assertCurrentIssue(
    context: IssueLifecycleMutationContext,
  ): Promise<IssueTrackerIssue> {
    const expected = requiredIssue(context.targetIssue);
    return this.assertIssueCurrent(context.project, expected);
  }

  private async assertIssueCurrent(
    project: RoadmapProjectIdentity,
    expected: IssueTrackerIssue,
  ): Promise<IssueTrackerIssue> {
    const current = await this.getIssue(project, expected.iid);
    if (
      !current ||
      current.updatedAt !== expected.updatedAt ||
      current.identityDigest !== expected.identityDigest
    ) {
      fail("tracker-drift");
    }
    return current;
  }

  private async assertCurrentMilestone(
    context: IssueLifecycleMutationContext,
    iid: number,
  ): Promise<IssueTrackerMilestone> {
    const expected = context.targetMilestone;
    if (!expected || expected.iid !== iid) fail("missing-target");
    const current = await this.getMilestone(context.project, iid);
    if (
      !current ||
      current.updatedAt !== expected.updatedAt ||
      current.identityDigest !== expected.identityDigest
    ) {
      fail("tracker-drift");
    }
    return current;
  }

  private async authorizedMutation(
    context: IssueLifecycleMutationContext,
    method: "POST" | "PUT",
    endpoint: string,
    fields: string[],
  ): Promise<unknown> {
    const boundary = await this.preflight(context.project);
    if (
      boundary.identity.identityDigest !== context.operatorIdentityDigest ||
      boundary.project.accessLevel !== context.expectedAccessLevel
    )
      fail("authentication-revoked");
    // This is intentionally the final synchronous check after all asynchronous reads.
    context.assertAuthorized();
    const result = await this.run([
      "api",
      "--hostname",
      context.project.host,
      "--method",
      method,
      endpoint,
      ...fields.flatMap((field) => ["--raw-field", field]),
    ]);
    if (result.exitCode !== 0) {
      if (result.failure === "authentication") fail("authentication-revoked");
      if (result.failure === "permission") fail("permission-denied");
      if (result.failure === "conflict") fail("tracker-drift");
      // The server may have committed before the local command lost its response.
      fail("ambiguous-effect", true);
    }
    return parse(result.stdout);
  }

  private async optionalJson(
    project: RoadmapProjectIdentity,
    endpoint: string,
  ): Promise<unknown | undefined> {
    assertProject(project);
    const result = await this.run(["api", "--hostname", project.host, endpoint]);
    if (result.failure === "not-found") return undefined;
    if (result.exitCode !== 0) commandFailure(result.failure);
    return parse(result.stdout);
  }

  private async pages(project: RoadmapProjectIdentity, endpoint: string): Promise<unknown[]> {
    assertProject(project);
    const output: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const values = array(
        await this.json([
          "api",
          "--hostname",
          project.host,
          `${endpoint}${separator}per_page=100&page=${page}`,
        ]),
      );
      output.push(...values);
      if (values.length < 100) return output;
    }
    fail("invalid-response");
  }

  private async json(args: readonly string[]): Promise<unknown> {
    const result = await this.run(args);
    if (result.exitCode !== 0) commandFailure(result.failure);
    return parse(result.stdout);
  }

  private run(args: readonly string[]): Promise<GitLabIssueCommandResult> {
    return this.commands.run("glab", args, {
      env: credentialFreeChildEnvironment(this.environment),
      timeoutMs: 20_000,
      maxOutputBytes: MAX_OUTPUT,
    });
  }
}

function issue(value: unknown): IssueTrackerIssue {
  const root = object(value);
  const iid = positive(root.iid);
  const title = string(root.title, 512);
  const description = root.description === null ? "" : string(root.description, 262_144);
  const state: IssueTrackerIssue["state"] =
    root.state === "opened" || root.state === "closed" ? root.state : invalid();
  const labels = array(root.labels)
    .map((item) => string(item, 128))
    .sort(compareText);
  const milestoneValue =
    root.milestone === null || root.milestone === undefined ? undefined : object(root.milestone);
  const milestoneIid = milestoneValue === undefined ? undefined : positive(milestoneValue.iid);
  const updatedAt = timestamp(root.updated_at);
  const body = {
    iid,
    titleDigest: textDigest(title),
    descriptionDigest: textDigest(description),
    state,
    labels,
    ...(milestoneIid === undefined ? {} : { milestoneIid }),
    updatedAt,
  };
  return freeze({ ...body, identityDigest: issueIdentityDigest(body) });
}

function milestone(value: unknown): IssueTrackerMilestone {
  const root = object(value);
  const iid = positive(root.iid);
  const externalId = String(positive(root.id));
  const state: IssueTrackerMilestone["state"] =
    root.state === "active" || root.state === "closed" ? root.state : invalid();
  const updatedAt = timestamp(root.updated_at);
  const description = root.description === null ? "" : string(root.description, 262_144);
  const body = {
    iid,
    externalId,
    titleDigest: textDigest(string(root.title, 512)),
    descriptionDigest: textDigest(description),
    state,
    updatedAt,
  };
  return freeze({ ...body, identityDigest: milestoneIdentityDigest(body) });
}

function note(value: unknown, issueIid: number): IssueTrackerNote {
  const root = object(value);
  const externalId = String(positive(root.id));
  const updatedAt = timestamp(root.updated_at ?? root.created_at);
  const body = { externalId, issueIid, updatedAt };
  return freeze({ ...body, identityDigest: noteIdentityDigest(body) });
}

function link(value: unknown, subjectIid: number): IssueTrackerLink {
  const root = object(value);
  const relatedIid = positive(root.iid ?? root.target_issue_iid);
  const rawType = String(root.link_type ?? "relates_to");
  const linkType: IssueTrackerLink["linkType"] =
    rawType === "blocks" ? "blocks" : rawType === "parent-task" ? "parent-task" : "related";
  const externalId = String(positive(root.id ?? root.link_id));
  const updatedAt = timestamp(root.updated_at ?? root.created_at);
  const body = { externalId, subjectIid, relatedIid, linkType, updatedAt };
  return freeze({ ...body, identityDigest: linkIdentityDigest(body) });
}

function noteEffect(value: IssueTrackerNote): RoadmapEffectIdentity {
  return freeze({
    kind: "note",
    targetKey: `note:${value.issueIid}:${value.externalId}`,
    externalId: value.externalId,
    state: "present",
    updatedAt: value.updatedAt,
    identityDigest: value.identityDigest,
    subjectTargetKey: `issue:${value.issueIid}`,
  });
}

function linkEffect(value: IssueTrackerLink): RoadmapEffectIdentity {
  return freeze({
    kind: "link",
    targetKey: `link:${value.externalId}`,
    externalId: value.externalId,
    state: "present",
    updatedAt: value.updatedAt,
    identityDigest: value.identityDigest,
    subjectTargetKey: `issue:${value.subjectIid}`,
    relatedTargetKey: `issue:${value.relatedIid}`,
  });
}

function parentTaskEffect(value: IssueTrackerNote, relatedIid: number): RoadmapEffectIdentity {
  const item: IssueTrackerLink = {
    externalId: value.externalId,
    subjectIid: value.issueIid,
    relatedIid,
    linkType: "parent-task",
    updatedAt: value.updatedAt,
    identityDigest: linkIdentityDigest({
      externalId: value.externalId,
      subjectIid: value.issueIid,
      relatedIid,
      linkType: "parent-task",
      updatedAt: value.updatedAt,
    }),
  };
  return linkEffect(item);
}

function operationMarker(context: IssueLifecycleMutationContext): string {
  const proof =
    context.operationProofDigest ?? roadmapProjectEffectProofDigestV2(context.operation);
  if (!SHA256.test(proof)) fail("invalid-response");
  return `<!-- docsfab-roadmap:v2 operation=${context.operation.key} idempotency=${context.operation.idempotencyKey} proof=${proof} -->`;
}

function withMarker(body: string, marker: string): string {
  return body.includes(marker) ? body : `${body.replace(/\s+$/u, "")}\n\n${marker}`;
}

function requiredIssue(value: IssueTrackerIssue | undefined): IssueTrackerIssue {
  if (!value) fail("missing-target");
  return value;
}

function credentialFreeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "/usr/bin:/bin",
    HOME: source.HOME ?? "/dev/null",
    XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
    GLAB_CONFIG_DIR: source.GLAB_CONFIG_DIR,
    SSL_CERT_FILE: source.SSL_CERT_FILE,
    SSL_CERT_DIR: source.SSL_CERT_DIR,
    LANG: "C",
    LC_ALL: "C",
    GLAB_HOST: undefined,
    GLAB_TOKEN: undefined,
    GITLAB_TOKEN: undefined,
    GITLAB_ACCESS_TOKEN: undefined,
    CI_JOB_TOKEN: undefined,
    PRIVATE_TOKEN: undefined,
    OAUTH_TOKEN: undefined,
  };
  return env;
}

function assertProject(project: RoadmapProjectIdentity): void {
  if (
    project.provider !== "gitlab" ||
    !SAFE_HOST.test(project.host) ||
    !SAFE_PROJECT_PATH.test(project.fullPath) ||
    !Number.isSafeInteger(project.projectId) ||
    project.projectId < 1
  ) {
    fail("project-drift");
  }
}

function parse(bytes: Buffer): unknown {
  if (bytes.length < 1 || bytes.length > MAX_OUTPUT) fail("invalid-response");
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    fail("invalid-response");
  }
}

function commandFailure(failureValue: GitLabIssueCommandResult["failure"]): never {
  if (failureValue === "authentication") fail("authentication-revoked");
  if (failureValue === "permission") fail("permission-denied");
  if (failureValue === "conflict") fail("tracker-drift");
  fail("external-failure", true);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-response");
  return value as Record<string, unknown>;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value === null || value === undefined ? {} : object(value);
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) fail("invalid-response");
  return value;
}

function string(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /\0/u.test(value))
    fail("invalid-response");
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) fail("invalid-response");
  return Number(value);
}

function positive(value: unknown): number {
  const result = integer(value);
  if (result < 1) fail("invalid-response");
  return result;
}

function access(value: Record<string, unknown>): number {
  return value.access_level === undefined ? 0 : integer(value.access_level);
}

function timestamp(value: unknown): string {
  const result = string(value, 64);
  if (Number.isNaN(Date.parse(result)) || !/(?:Z|[+-]\d\d:\d\d)$/u.test(result))
    fail("invalid-response");
  return new Date(result).toISOString();
}
function textDigest(value: string): string {
  return roadmapDigest({ contract: "issue-tracker-text-v1", value });
}
function invalid(): never {
  return fail("invalid-response");
}
function unsupported(): never {
  return fail("unsupported-operation");
}
function fail(
  code: ConstructorParameters<typeof IssueLifecycleAdapterError>[0],
  retryable = false,
): never {
  throw new IssueLifecycleAdapterError(code, retryable);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
