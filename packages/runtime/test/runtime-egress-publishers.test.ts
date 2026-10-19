// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runtimeEgressRootSet } from "../src/config/egress-roots.js";
import {
  localUserGitIdentitySha256,
  type LocalUserPublicationPlanV1,
} from "../src/delivery/contracts.js";
import {
  DeterministicLocalGitPublisher,
  ExecFileGitPublisherCommandRunner,
} from "../src/delivery/git-publisher.js";
import {
  type GitLabPublisherCommandResult,
  type GitLabPublisherCommandRunner,
  LocalUserGitLabPublisherAdapter,
} from "../src/delivery/gitlab-adapter.js";
import { buildDocsFabPublicationMetadata } from "../src/delivery/metadata.js";
import { localUserPublicationPlanSha256 } from "../src/delivery/contracts.js";
import type { DeliveryWorktreeReadyAttestation } from "../src/delivery/worktree.js";
import {
  hostedQualityMarkdownPath,
  hostedQualityReportPath,
  persistHostedQualityReport,
} from "../src/evaluation-report/hosted-report.js";
import {
  formatOperatorErrorEnvelope,
  serializeOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { roadmapDigest } from "../src/roadmap/contracts/decode.js";
import type { RoadmapMutationOperationV2 } from "../src/roadmap/execution-v2.js";
import {
  type GitLabIssueCommandResult,
  type GitLabIssueCommandRunner,
  LocalUserGitLabIssueAdapter,
} from "../src/roadmap/gitlab-issue-adapter.js";
import type { IssueLifecycleMutationContext } from "../src/roadmap/issue-adapter.js";
import { hostRootSet } from "../src/security/egress.js";
import {
  resetStartupPublicRootsForTest,
  validateStartupPublicRoots,
} from "../src/security/host-roots.js";
import { git, hermeticGitEnv } from "./helpers/git.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

// Assembled so the literal never appears whole in this file.
const GITLAB_TOKEN = ["glpat", "-", "a".repeat(24)].join("");
// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest(GITLAB_TOKEN);
const COMMIT = "b".repeat(40);
const DOCUMENTATION_PATHS = "/usr/local/bin/node /home/node/app";
// Documentation placeholders the canonical credential rules accept.
const DOC_EXAMPLES = 'password: "changeme" and token = ${GITLAB_TOKEN}';

interface Fixture {
  base: string;
  physicalBase: string;
  checkout: string;
  workspace: string;
  state: string;
  config: string;
  home: string;
  tmp: string;
  environment: NodeJS.ProcessEnv;
}

let fixture: Fixture;

/** One line naming every root kind, a realpath and a file:// variant, and documentation paths. */
function hostText(): string {
  return [
    `${fixture.workspace}/docs/a.md`,
    `${fixture.physicalBase}/checkout/docs/b.md`,
    pathToFileURL(join(fixture.workspace, "docs", "c.md")).href,
    `${fixture.state}/run-1.json`,
    `${join(fixture.base, "state", "delivery")}/tree`,
    `${fixture.config}/host.yaml`,
    `${fixture.home}/notes.md`,
    `${fixture.tmp}/scratch.txt`,
    DOCUMENTATION_PATHS,
  ].join(" ");
}

const PUBLISHED_TEXT = [
  "docs/a.md",
  "docs/b.md",
  "docs/c.md",
  "$DOCSFAB_STATE_DIR/run-1.json",
  "$DOCSFAB_STATE_DIR/tree",
  "$DOCSFAB_CONFIG_ROOT/host.yaml",
  "~/notes.md",
  "$TMPDIR/scratch.txt",
  DOCUMENTATION_PATHS,
].join(" ");

function expectNoHostRoot(text: string): void {
  expect(text).not.toContain(fixture.base);
  expect(text).not.toContain(fixture.physicalBase);
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "docsfab-egress-publishers-"));
  const checkout = join(base, "checkout");
  const workspace = join(base, "linked-checkout");
  const state = join(base, "state", "runs");
  const config = join(base, "config");
  const home = join(base, "home");
  // A private temporary root: the generic `/tmp` is never a host root.
  const tmp = join(base, "tmp");
  await mkdir(tmp, { recursive: true });
  await mkdir(join(checkout, "docs"), { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(config, { recursive: true });
  await chmod(config, 0o700);
  await mkdir(home, { recursive: true });
  // The workspace root is a link, so its physical path is a distinct variant.
  await symlink(checkout, workspace, "dir");
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmp,
    DOCSFAB_CONFIG_ROOT: config,
    DOCSFAB_STATE_DIR: state,
  };
  fixture = {
    base,
    physicalBase: await realpath(base),
    checkout,
    workspace,
    state,
    config,
    home,
    tmp,
    environment,
  };
  vi.stubEnv("HOME", home);
  vi.stubEnv("TMPDIR", tmp);
  vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", undefined);
  vi.stubEnv("DOCSFAB_CONFIG_ROOT", config);
  vi.stubEnv("DOCSFAB_STATE_DIR", state);
  vi.spyOn(process, "cwd").mockReturnValue(workspace);
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(fixture.base, { recursive: true, force: true });
});

describe("draft MR metadata and commit message", () => {
  it("replaces every root in the title, commit message, and description", () => {
    const metadata = buildDocsFabPublicationMetadata({
      plan: plan(),
      workflowOutcome: hostText(),
      changedPaths: ["docs/guide.md"],
    });
    expect(metadata.mergeRequestTitle).toMatch(/^Draft: \[DocsFab Run\] docs\/a\.md docs\/b\.md/u);
    expect(metadata.commitMessage.startsWith("DocsFab: docs/a.md docs/b.md")).toBe(true);
    expect(metadata.mergeRequestDescription).toContain(
      // The outcome display is bounded, so only its head is compared.
      `**Catalog outcome (subtitle):** *${PUBLISHED_TEXT.slice(0, 120)}`,
    );
    for (const text of [
      metadata.mergeRequestTitle,
      metadata.commitMessage,
      metadata.mergeRequestDescription,
    ]) {
      expectNoHostRoot(text);
    }
  });

  it("keeps screening Markdown strikethrough next to a home placeholder", () => {
    const build = (workflowOutcome: string) => () =>
      buildDocsFabPublicationMetadata({
        plan: plan(),
        workflowOutcome,
        changedPaths: ["docs/guide.md"],
      });
    expect(build(`Refresh ${fixture.home}/docs`)().mergeRequestTitle).toMatch(/Refresh ~\/docs$/u);
    expect(build(`Refresh ~struck~ ${fixture.home}/docs`)).toThrow(
      expect.objectContaining({ code: "invalid-publication-metadata" }),
    );
  });

  it("refuses credential material in draft MR metadata", () => {
    expect(() =>
      buildDocsFabPublicationMetadata({
        plan: plan(),
        workflowOutcome: `Refresh docs ${GITLAB_TOKEN}`,
        changedPaths: ["docs/guide.md"],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-publication-metadata" }));
  });

  it("writes the commit object with the checkout and host roots replaced", async () => {
    const repository = fixture.checkout;
    await git(repository, ["init", "--quiet"]);
    await git(repository, ["config", "user.name", "Maintainer"]);
    await git(repository, ["config", "user.email", "maintainer@example.test"]);
    await git(repository, ["remote", "add", "origin", "git@gitlab.example.test:group/docs.git"]);
    await writeFile(join(repository, "guide.md"), "before\n", "utf8");
    await git(repository, ["add", "guide.md"]);
    await git(repository, ["commit", "--quiet", "--no-gpg-sign", "-m", "Base"]);
    const baseRevision = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, ["branch", "docsfab/run-1", baseRevision]);
    await writeFile(join(repository, "guide.md"), "after\n", "utf8");
    await git(repository, ["add", "guide.md"]);
    const tree = await git(repository, ["write-tree"]);
    const selectedPlan = plan({ baseRevision });
    const ready = { tree } as DeliveryWorktreeReadyAttestation;
    const gitCommands = new ExecFileGitPublisherCommandRunner();
    // Publish with the same isolated Git configuration as fixture setup.
    const publisher = new DeterministicLocalGitPublisher(
      {
        run: (command, args, cwd, options) =>
          gitCommands.run(command, args, cwd, {
            ...options,
            env: hermeticGitEnv(options.env),
          }),
      },
      fixture.environment,
    );
    const commitMessage = `DocsFab: Refresh docs\n\n${hostText()}\n`;

    const revision = await publisher.ensureCommit({
      plan: selectedPlan,
      ready,
      commitMessage,
      cwd: fixture.workspace,
    });

    const published = await git(repository, ["show", "-s", "--format=%B", revision]);
    expect(published).toBe(`DocsFab: Refresh docs\n\n${PUBLISHED_TEXT}`);
    await expect(
      publisher.assertCommit({
        plan: selectedPlan,
        ready,
        commitMessage,
        commitRevision: revision,
        cwd: fixture.workspace,
      }),
    ).resolves.toBeUndefined();
    await expect(
      publisher.ensureCommit({
        plan: selectedPlan,
        ready,
        commitMessage: `${commitMessage}${GITLAB_TOKEN}\n`,
        cwd: fixture.workspace,
      }),
    ).rejects.toMatchObject({ code: "commit-failed" });
  });

  it("opens the draft MR with the roots replaced in title and description", async () => {
    const commands = new MergeRequestCommands();
    const adapter = new LocalUserGitLabPublisherAdapter(commands, fixture.environment);
    const selectedPlan = plan();
    // Metadata built without roots, so only the adapter can replace them.
    const metadata = buildDocsFabPublicationMetadata({
      plan: selectedPlan,
      workflowOutcome: `Refresh ${fixture.home}/docs`,
      changedPaths: ["docs/guide.md"],
      hostRoots: hostRootSet([]),
    });
    expect(metadata.mergeRequestTitle).toContain(fixture.home);

    await adapter.openDraftMergeRequest({
      plan: selectedPlan,
      cwd: fixture.workspace,
      title: metadata.mergeRequestTitle,
      description: `${metadata.mergeRequestDescription}\n${hostText()}`,
      headRevision: COMMIT,
      metadata,
    });

    expect(commands.title).toBe(metadata.mergeRequestTitle.replace(fixture.home, "~"));
    expect(commands.title?.endsWith("] Refresh ~/docs")).toBe(true);
    expect(commands.description).toContain("**Catalog outcome (subtitle):** *Refresh ~/docs*");
    expect(commands.description?.endsWith(`\n${PUBLISHED_TEXT}`)).toBe(true);
    expectNoHostRoot(commands.title ?? "");
    expectNoHostRoot(commands.description ?? "");

    const refused = new MergeRequestCommands();
    await expect(
      new LocalUserGitLabPublisherAdapter(refused, fixture.environment).openDraftMergeRequest({
        plan: selectedPlan,
        cwd: fixture.workspace,
        title: metadata.mergeRequestTitle,
        description: `${metadata.mergeRequestDescription}\n${GITLAB_TOKEN}`,
        headRevision: COMMIT,
        metadata,
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(refused.title).toBeUndefined();
  });
});

describe("roadmap issues and notes", () => {
  it("creates issues and notes with the roots replaced and reconciles the published text", async () => {
    const runner = new IssueCommands();
    const adapter = new LocalUserGitLabIssueAdapter(runner, fixture.environment);
    const operation = roadmapOperation("operation:create-issue", "issue");
    const context: IssueLifecycleMutationContext = {
      project: PROJECT,
      operation,
      material: {
        operationKey: operation.key,
        action: "create-issue",
        title: `Refresh ${fixture.workspace}/docs`,
        description: hostText(),
        labels: [],
      },
      operationProofDigest: "f".repeat(64),
      ...OPERATOR,
      assertAuthorized() {},
    };

    await adapter.mutate(context);

    const fields = runner.mutationFields();
    expect(fields).toContain("title=Refresh docs");
    const description = fields.find((field) => field.startsWith("description="))!;
    expect(description.startsWith(`description=${PUBLISHED_TEXT}\n\n<!-- `)).toBe(true);
    expectNoHostRoot(fields.join("\n"));
    runner.searchResults = [
      { ...rawIssue(9), description: description.slice("description=".length) },
    ];
    await expect(adapter.reconcile(context)).resolves.toMatchObject({ disposition: "found" });

    const note = roadmapOperation("operation:comment", "comment");
    await adapter.mutate({
      project: PROJECT,
      operation: note,
      material: { operationKey: note.key, action: "comment", body: hostText() },
      targetIssue: await adapter.getIssue(PROJECT, 7),
      ...OPERATOR,
      assertAuthorized() {},
    });
    const body = runner.mutationFields().find((field) => field.startsWith("body="))!;
    expect(body.startsWith(`body=${PUBLISHED_TEXT}\n\n<!-- `)).toBe(true);
  });

  it("refuses credential material before any mutation", async () => {
    const runner = new IssueCommands();
    const adapter = new LocalUserGitLabIssueAdapter(runner, fixture.environment);
    const operation = roadmapOperation("operation:create-issue", "issue");
    await expect(
      adapter.mutate({
        project: PROJECT,
        operation,
        material: {
          operationKey: operation.key,
          action: "create-issue",
          title: "Refresh docs",
          description: `token ${GITLAB_TOKEN}`,
          labels: [],
        },
        operationProofDigest: "f".repeat(64),
        ...OPERATOR,
        assertAuthorized() {},
      }),
    ).rejects.toMatchObject({ code: "material-invalid" });
    expect(runner.mutations).toHaveLength(0);
  });
});

describe("hosted quality report", () => {
  it("persists HTML and Markdown with the roots replaced", async () => {
    await persistHostedQualityReport({
      stateDirectory: fixture.state,
      runId: "run-egress",
      quality: null,
      markdown: `Evaluator notes: ${hostText()}`,
      reviewFindings: [
        {
          id: "finding-1",
          severity: "minor",
          code: "stale-path",
          summary: hostText(),
          path: `${fixture.workspace}/docs/a.md`,
        },
      ],
      findingLimitations: [`review-findings-artifact:${fixture.state}/findings.json`],
      environment: fixture.environment,
    });

    const markdown = await readFile(hostedQualityMarkdownPath(fixture.state, "run-egress"), "utf8");
    expect(markdown).toBe(`Evaluator notes: ${PUBLISHED_TEXT}`);
    const html = await readFile(hostedQualityReportPath(fixture.state, "run-egress"), "utf8");
    expect(html).toContain("Path: docs/a.md");
    expect(html).toContain("review-findings-artifact:$DOCSFAB_STATE_DIR/findings.json");
    expect(html).toContain("~/notes.md");
    expect(html).toContain(DOCUMENTATION_PATHS);
    expectNoHostRoot(markdown);
    expectNoHostRoot(html);
  });

  it("refuses credential material in the hosted report", async () => {
    await expect(
      persistHostedQualityReport({
        stateDirectory: fixture.state,
        runId: "run-egress-credential",
        quality: null,
        markdown: `Evaluator notes: ${GITLAB_TOKEN}`,
        environment: fixture.environment,
      }),
    ).rejects.toMatchObject({ name: "HostedQualityReportError", code: "credential-material" });
  });
});

describe("operator envelope", () => {
  it("replaces this host's roots in human and JSON output", () => {
    const envelope = toOperatorErrorEnvelope(new Error(`Rejected ${hostText()}`));
    expect(envelope.message).toBe(`Rejected ${PUBLISHED_TEXT}`);
    const human = formatOperatorErrorEnvelope(envelope);
    const json = serializeOperatorErrorEnvelope(envelope);
    expect(human).toContain(`Rejected ${PUBLISHED_TEXT}`);
    expect(JSON.parse(json).message).toBe(`Rejected ${PUBLISHED_TEXT}`);
    for (const text of [human, json]) expectNoHostRoot(text);
  });

  it("keeps redacting credential material", () => {
    const credential = ["nvapi", "-", "abcdefghijklmnopqrstuvwxyz012345"].join("");
    const envelope = toOperatorErrorEnvelope(
      new Error(`Provider rejected ${credential} at ${fixture.home}/project`),
    );
    expect(envelope.message).not.toContain(credential);
    expect(envelope.message).toContain("[REDACTED");
    expect(envelope.message).toContain("~/project");
  });
});

describe("runtime egress root set", () => {
  it("names the run's roots from the environment and the working directory", () => {
    const roots = runtimeEgressRootSet();
    const kinds = new Map(roots.variants.map(({ text, kind }) => [text, kind]));
    expect(kinds.get(fixture.workspace)).toBe("workspace");
    expect(kinds.get(fixture.state)).toBe("state");
    expect(kinds.get(join(fixture.base, "state", "receipts"))).toBe("state");
    expect(kinds.get(fixture.config)).toBe("config");
    expect(kinds.get(fixture.home)).toBe("home");
    expect(kinds.get(fixture.tmp)).toBe("tmp");
  });

  it("leaves declared public roots as written and replaces them when undeclared", async () => {
    const text = `${fixture.home}/notes.md ${fixture.workspace}/docs/a.md`;
    const publishedBody = async (environment: NodeJS.ProcessEnv): Promise<string> => {
      const runner = new IssueCommands();
      const note = roadmapOperation("operation:comment", "comment");
      const adapter = new LocalUserGitLabIssueAdapter(runner, environment);
      await adapter.mutate({
        project: PROJECT,
        operation: note,
        material: { operationKey: note.key, action: "comment", body: text },
        targetIssue: await adapter.getIssue(PROJECT, 7),
        ...OPERATOR,
        assertAuthorized() {},
      });
      const body = runner.mutationFields().find((field) => field.startsWith("body="))!;
      return body.slice("body=".length).split("\n\n<!--")[0]!;
    };
    const declared = [fixture.home, fixture.workspace].join(delimiter);

    expect(await publishedBody({ ...fixture.environment, DOCSFAB_PUBLIC_ROOTS: declared })).toBe(
      text,
    );
    expect(await publishedBody(fixture.environment)).toBe("~/notes.md docs/a.md");

    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", fixture.home);
    try {
      expect(toOperatorErrorEnvelope(new Error(text)).message).toBe(
        `${fixture.home}/notes.md docs/a.md`,
      );
    } finally {
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", undefined);
    }
  });

  it("refuses an invalid declaration when a publisher is constructed", () => {
    const environment = { ...fixture.environment, DOCSFAB_PUBLIC_ROOTS: "relative/root" };
    const invalid = { name: "PublicRootsOperatorError", code: "public-roots-invalid" };
    expect(() => new LocalUserGitLabIssueAdapter(new IssueCommands(), environment)).toThrow(
      expect.objectContaining(invalid),
    );
    expect(
      () => new LocalUserGitLabPublisherAdapter(new MergeRequestCommands(), environment),
    ).toThrow(expect.objectContaining(invalid));
    expect(
      () =>
        new DeterministicLocalGitPublisher(new ExecFileGitPublisherCommandRunner(), environment),
    ).toThrow(expect.objectContaining(invalid));
    // The envelope still renders, replacing every root.
    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "relative/root");
    try {
      expect(toOperatorErrorEnvelope(new Error(`${fixture.home}/x`)).message).toBe("~/x");
    } finally {
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", undefined);
    }
  });

  it("takes the startup declaration when a publisher is given no environment", async () => {
    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", fixture.home);
    validateStartupPublicRoots();
    // A later value is not a new declaration.
    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "relative/root");
    try {
      const text = `${fixture.home}/notes.md ${fixture.workspace}/docs/a.md`;
      const runner = new IssueCommands();
      const note = roadmapOperation("operation:comment", "comment");
      const issues = new LocalUserGitLabIssueAdapter(runner);
      await issues.mutate({
        project: PROJECT,
        operation: note,
        material: { operationKey: note.key, action: "comment", body: text },
        targetIssue: await issues.getIssue(PROJECT, 7),
        ...OPERATOR,
        assertAuthorized() {},
      });
      const body = runner.mutationFields().find((field) => field.startsWith("body="))!;
      expect(body.slice("body=".length).split("\n\n<!--")[0]).toBe(
        `${fixture.home}/notes.md docs/a.md`,
      );

      const commands = new MergeRequestCommands();
      const selectedPlan = plan();
      const metadata = buildDocsFabPublicationMetadata({
        plan: selectedPlan,
        workflowOutcome: "Refresh docs",
        changedPaths: ["docs/guide.md"],
        hostRoots: hostRootSet([]),
      });
      await new LocalUserGitLabPublisherAdapter(commands).openDraftMergeRequest({
        plan: selectedPlan,
        cwd: fixture.workspace,
        title: metadata.mergeRequestTitle,
        description: `${metadata.mergeRequestDescription}\n${text}`,
        headRevision: COMMIT,
        metadata,
      });
      expect(commands.description?.endsWith(`\n${fixture.home}/notes.md docs/a.md`)).toBe(true);

      // A later valid declaration cannot expand the startup set. In particular,
      // the private credential-enriched environment is not a new root grant.
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", fixture.workspace);
      const privateRootText = `${fixture.workspace}/private.md`;
      const boundedCommands = new MergeRequestCommands();
      await new LocalUserGitLabPublisherAdapter(boundedCommands).openDraftMergeRequest({
        plan: selectedPlan,
        cwd: fixture.workspace,
        title: metadata.mergeRequestTitle,
        description: `${metadata.mergeRequestDescription}\n${privateRootText}`,
        headRevision: COMMIT,
        metadata,
      });
      expect(boundedCommands.description).not.toContain(privateRootText);
      expect(boundedCommands.description).toContain("private.md");

      expect(
        () => new DeterministicLocalGitPublisher(new ExecFileGitPublisherCommandRunner()),
      ).not.toThrow();
    } finally {
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", undefined);
      resetStartupPublicRootsForTest();
    }
  });
});

describe("documentation credential placeholders", () => {
  it("pass through every publisher", async () => {
    // The outcome's markup screen refuses `_`, so it carries only the first example.
    const metadata = buildDocsFabPublicationMetadata({
      plan: plan(),
      workflowOutcome: 'Document password: "changeme"',
      changedPaths: ["docs/guide.md"],
    });
    expect(metadata.commitMessage).toContain('Document password: "changeme"');
    expect(metadata.mergeRequestDescription).toContain('Document password: "changeme"');

    const commands = new MergeRequestCommands();
    await new LocalUserGitLabPublisherAdapter(commands, fixture.environment).openDraftMergeRequest({
      plan: plan(),
      cwd: fixture.workspace,
      title: metadata.mergeRequestTitle,
      description: `${metadata.mergeRequestDescription}\n${DOC_EXAMPLES}`,
      headRevision: COMMIT,
      metadata,
    });
    expect(commands.description?.endsWith(`\n${DOC_EXAMPLES}`)).toBe(true);

    const runner = new IssueCommands();
    const adapter = new LocalUserGitLabIssueAdapter(runner, fixture.environment);
    const note = roadmapOperation("operation:comment", "comment");
    await adapter.mutate({
      project: PROJECT,
      operation: note,
      material: { operationKey: note.key, action: "comment", body: DOC_EXAMPLES },
      targetIssue: await adapter.getIssue(PROJECT, 7),
      ...OPERATOR,
      assertAuthorized() {},
    });
    expect(runner.mutationFields().some((field) => field.startsWith(`body=${DOC_EXAMPLES}`))).toBe(
      true,
    );

    await persistHostedQualityReport({
      stateDirectory: fixture.state,
      runId: "run-egress-doc-examples",
      quality: null,
      markdown: DOC_EXAMPLES,
      environment: fixture.environment,
    });
    expect(
      await readFile(hostedQualityMarkdownPath(fixture.state, "run-egress-doc-examples"), "utf8"),
    ).toBe(DOC_EXAMPLES);

    // The envelope keeps its existing assignment redaction but is not withheld.
    const message = toOperatorErrorEnvelope(new Error(`Example ${DOC_EXAMPLES}`)).message;
    expect(message.startsWith("Example password=[REDACTED]")).toBe(true);
  });
});

class MergeRequestCommands implements GitLabPublisherCommandRunner {
  public title: string | undefined;
  public description: string | undefined;

  public async run(
    _command: "glab",
    args: readonly string[],
  ): Promise<GitLabPublisherCommandResult> {
    if (!args.includes("POST")) return { exitCode: 1, stdout: Buffer.from("") };
    this.title = args.find((value) => value.startsWith("title="))!.slice("title=".length);
    this.description = args
      .find((value) => value.startsWith("description="))!
      .slice("description=".length);
    const request = {
      iid: 7,
      state: "opened",
      draft: true,
      source_branch: "docsfab/run-1",
      target_branch: "main",
      sha: COMMIT,
      source_project_id: 42,
      target_project_id: 42,
      title: this.title,
      description: this.description,
    };
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify(request)) };
  }
}

const PROJECT = {
  provider: "gitlab",
  host: "gitlab.example.com",
  fullPath: "group/docs",
  projectId: 42,
};
const TIME = "2026-08-05T00:00:00.000Z";
const OPERATOR = {
  operatorIdentityDigest: roadmapDigest({
    provider: "gitlab",
    host: PROJECT.host,
    username: "maintainer",
  }),
  expectedAccessLevel: 40,
};

class IssueCommands implements GitLabIssueCommandRunner {
  public readonly mutations: string[][] = [];
  public searchResults: unknown[] = [];

  public mutationFields(): string[] {
    return this.mutations.flat().filter((_value, index, all) => all[index - 1] === "--raw-field");
  }

  public async run(_command: "glab", args: readonly string[]): Promise<GitLabIssueCommandResult> {
    const methodIndex = args.indexOf("--method");
    if (methodIndex >= 0) this.mutations.push([...args]);
    const endpoint = methodIndex >= 0 ? args[methodIndex + 2]! : args.at(-1)!;
    let value: unknown;
    if (args[0] === "auth") value = {};
    else if (methodIndex < 0 && endpoint === "user") value = { username: "maintainer" };
    else if (methodIndex < 0 && endpoint === "projects/42") {
      value = {
        id: 42,
        path_with_namespace: "group/docs",
        default_branch: "main",
        permissions: { project_access: { access_level: 40 }, group_access: null },
      };
    } else if (methodIndex < 0 && endpoint.includes("/issues?")) value = this.searchResults;
    else if (methodIndex < 0) value = rawIssue(7);
    else if (endpoint.endsWith("/notes")) {
      value = { id: 91, body: "note", created_at: TIME, updated_at: TIME };
    } else value = rawIssue(9);
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify(value)), failure: "none" };
  }
}

function rawIssue(iid: number) {
  return {
    iid,
    title: `Issue ${iid}`,
    description: "Body",
    state: "opened",
    labels: ["docs"],
    milestone: null,
    created_at: TIME,
    updated_at: TIME,
  };
}

function roadmapOperation(key: string, kind: "issue" | "comment"): RoadmapMutationOperationV2 {
  const effectKind = kind === "comment" ? "note" : "issue";
  return {
    key,
    kind,
    findingIds: ["finding:one"],
    dependsOnOperationKeys: [],
    target:
      kind === "issue"
        ? { source: "project", targetKey: "project:42" }
        : { source: "ledger-observation", targetKey: "issue:7" },
    preconditions: [],
    proposal: { kind, intent: kind === "issue" ? "create" : "comment", effectKind },
    proposalDigest: "a".repeat(64),
    materialDigest: "b".repeat(64),
    materialBytes: 10,
    expectedEffectKind: effectKind,
    idempotencyKey: "c".repeat(64),
  } as RoadmapMutationOperationV2;
}

function plan(overrides: { baseRevision?: string } = {}): LocalUserPublicationPlanV1 {
  const candidate = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "run-1", recordSha256: "d".repeat(64) },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "ssh" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: overrides.baseRevision ?? "a".repeat(40),
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab/run-1",
    patch: {
      format: "git-diff",
      sha256: createHash("sha256").update("patch").digest("hex"),
      byteLength: 5,
      changedFileCount: 1,
    },
    validationCommand: "npm run check",
    mergeRequest: { draft: true },
    fallback: { mode: "patch-only", preserved: true },
    checks: {
      repository: "passed",
      remote: "passed",
      revision: "current",
      gitIdentity: "configured",
      gitlabAuthentication: "authenticated",
      pushAccess: "allowed",
      sourceBranch: "unprotected",
    },
  } as const;
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate as never) };
}
