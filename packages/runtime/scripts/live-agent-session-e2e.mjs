// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Black-box E2E for the installed `docsfab live-agent` command.
 *
 * The test packs and installs DocsFab into an isolated prefix, starts the shipped
 * executable in a pseudo-terminal, and routes its model calls to a loopback-only
 * scripted HTTPS provider. It proves a direct natural-language reply, a
 * scripted skill selection and supporting-reference reads, clean exit, and automatic resume of the same Pi
 * session with prior conversation context. A resumed write-enabled session edits
 * manual changes, commits/pushes to a real local remote, calls a fixture forge
 * CLI, and declines a command without executing it. It also runs the installed
 * bounded documentation workflow against a scripted local provider, records a
 * successful run and patch, and verifies the source checkout stays unchanged.
 * On Linux it instead invokes the installed default draft-delivery path against
 * a disposable bare Git remote and strict fake GitLab/SSH protocol endpoints,
 * then checks the saved receipt and replay idempotency.
 *
 * It does not use real credentials or an external model, and therefore does not
 * evaluate third-party model quality, real forge authentication/MR creation, or
 * Slack transport. Linux BubbleWrap evidence is produced only by the tagged
 * Linux execution; macOS uses patch-only mode.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  installPackedDocsFab,
  parsePackedCandidateArguments,
  preparePackedCandidate,
} from "./lib/packed-cli.mjs";
import { terminalOutputWithoutElapsedProgress } from "./live-agent-session-e2e-progress.mjs";

const execute = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { artifactDirectoryLeaf } = parsePackedCandidateArguments(process.argv.slice(2));
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "docsfab-live-agent-e2e-")));
const modelId = "example/model";
const credential = "docsfab-e2e-placeholder";
const directPrompt = "Remember the project codename Bluebird.";
const skillPrompt =
  "Review the getting-started documentation and then verify its technical accuracy.";
const resumePrompt = "What project codename did I ask you to remember?";
const editPrompt = "Update my current manual edit in README.md directly.";
const adocEditPrompt = "Update manual/guide.adoc directly and preserve its syntax.";
const scopeEscapePrompt = "Try writing outside the configured manual directory.";
const installedTaskPrompt = "Update the exact AsciiDoc file granted for this bounded task.";
const savedRunPrompt =
  "Summarize saved review saved-review. Do not rerun, edit, or publish anything.";
const publishPrompt = "Commit README.md, push a topic branch, and create a draft MR.";
const declinePrompt = "Propose a command that I will decline.";
const liveWorkflowPublicationPrompt =
  "Correct docs/guide.md using the bounded documentation workflow and create a draft MR for its exact saved run.";
const expectedPreWorkflowProviderRequests = 26;
let providerToolCallSequence = 0;
let workflowCaptureDirectoryForEvidence;
let fakeGitLabStatePathForEvidence;
let ciEvidenceDirectoryForRetention;
const linuxDeliveryEvidenceForRetention = {
  schemaVersion: 1,
  status: "incomplete",
  qualification: "not-established",
  packageName: null,
  packageVersion: null,
  packageIntegrity: null,
  sourceRevision: null,
  cliRunId: null,
  liveAgentRunId: null,
  cliReceiptState: "unavailable",
  liveAgentReceiptState: "unavailable",
  cliBackendIdentity: "unavailable",
  liveAgentBackendIdentity: "unavailable",
  profileId: "docsfab-documentation-validation",
  profileVersion: "2",
  validatorIdentity: "docsfab-documentation-validator",
  isolationBoundary: "unverified",
  exactlyOneDraftPerRun: false,
  replayReusedExistingDraft: false,
  // One checkout claim per leg. The CLI run leaves the checkout untouched. The
  // write-enabled live-agent run applies its saved patch by design, so its claim
  // is that the checkout changed only by that patch, not that it is unchanged.
  cliSourceCheckoutUnchanged: false,
  liveAgentSourceCheckoutChangedOnlyByAppliedPatch: false,
  fakeForgeOnly: true,
  realGitLabPublication: "not-tested",
  stage: "setup",
  localFixtureGuardMutantsKilled: [],
};
ciEvidenceDirectoryForRetention = join(projectRoot, "ci-results", "2332", basename(temporaryRoot));

async function persistLinuxDeliveryEvidence() {
  if (process.platform !== "linux" || !ciEvidenceDirectoryForRetention) return;
  await mkdir(ciEvidenceDirectoryForRetention, { recursive: true, mode: 0o700 });
  await writeFile(
    join(ciEvidenceDirectoryForRetention, "linux-delivery-summary.json"),
    `${JSON.stringify(linuxDeliveryEvidenceForRetention, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function fail(message) {
  throw new Error(`Live-agent E2E failed: ${message}`);
}

try {
  const packRoot = join(temporaryRoot, "pack");
  const installRoot = join(temporaryRoot, "install");
  const repositoryRoot = join(temporaryRoot, "repository");
  const taskRepositoryRoot = join(temporaryRoot, "task-repository");
  const taskInputRoot = join(temporaryRoot, "task-input");
  const taskResultRoot = join(temporaryRoot, "task-result");
  const taskStateRoot = join(temporaryRoot, "task-state");
  const workflowRepositoryRoot = join(temporaryRoot, "workflow-repository");
  const configurationRoot = join(temporaryRoot, "configuration");
  const tlsRoot = join(temporaryRoot, "tls");
  const homeRoot = join(temporaryRoot, "home");
  const npmCacheRoot = join(temporaryRoot, "npm-cache");
  const expectScriptPath = join(temporaryRoot, "interactive-session.exp");
  const remoteRoot = join(repositoryRoot, ".git", "fixture-remote.git");
  const binRoot = join(temporaryRoot, "bin");
  const workflowBareRemoteRoot = join(temporaryRoot, "workflow-remote.git");
  const fakeGitLabStatePath = join(repositoryRoot, ".fixture-gitlab-state.json");
  fakeGitLabStatePathForEvidence = fakeGitLabStatePath;
  await Promise.all(
    [
      packRoot,
      installRoot,
      repositoryRoot,
      taskRepositoryRoot,
      taskInputRoot,
      taskResultRoot,
      taskStateRoot,
      workflowRepositoryRoot,
      configurationRoot,
      tlsRoot,
      homeRoot,
      npmCacheRoot,
      binRoot,
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await writeFile(join(repositoryRoot, "README.md"), "# Live-agent E2E fixture\n", "utf8");
  await mkdir(join(repositoryRoot, "manual"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "manual", "guide.adoc"),
    "= Manual Guide\n\n:toc:\n\ninclude::parts/shared.adoc[]\n",
    "utf8",
  );
  await mkdir(join(repositoryRoot, "manual", "parts"), { recursive: true });
  await writeFile(join(repositoryRoot, "manual", "parts", "shared.adoc"), "== Shared\n", "utf8");
  await writeFile(
    join(repositoryRoot, ".docsfab.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      documentationRoots: ["manual"],
    })}\n`,
    "utf8",
  );
  const git = (args) => execute("git", args, { cwd: repositoryRoot });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "DocsFab Fixture"]);
  await git(["config", "user.email", "fixture@example.test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["config", "core.hooksPath", "/dev/null"]);
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  await mkdir(join(taskRepositoryRoot, "manual"), { recursive: true });
  await writeFile(
    join(taskRepositoryRoot, "manual", "guide.adoc"),
    "= Task Guide\n\ninclude::shared.adoc[]\n",
    "utf8",
  );
  await writeFile(join(taskRepositoryRoot, "manual", "shared.adoc"), "== Shared\n", "utf8");
  await writeFile(
    join(taskRepositoryRoot, ".docsfab.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      documentationRoots: ["manual"],
    })}\n`,
    "utf8",
  );
  await execute("git", ["init", "-b", "main", taskRepositoryRoot]);
  await execute("git", ["-C", taskRepositoryRoot, "config", "user.name", "DocsFab Fixture"]);
  await execute("git", ["-C", taskRepositoryRoot, "config", "user.email", "fixture@example.test"]);
  await execute("git", ["-C", taskRepositoryRoot, "config", "core.hooksPath", "/dev/null"]);
  await execute("git", ["-C", taskRepositoryRoot, "add", "."]);
  await execute("git", [
    "-C",
    taskRepositoryRoot,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  await execute("git", ["-C", taskRepositoryRoot, "switch", "-c", "docsfab-e2e-task"]);
  await mkdir(join(workflowRepositoryRoot, "docs"), { recursive: true });
  await writeFile(join(workflowRepositoryRoot, "README.md"), "# Workflow fixture\n", "utf8");
  const originalWorkflowGuide = "# Guide\n\nChecks run without network restrictions.\n";
  await writeFile(join(workflowRepositoryRoot, "docs", "guide.md"), originalWorkflowGuide, "utf8");
  await mkdir(join(workflowRepositoryRoot, "src"), { recursive: true });
  await writeFile(
    join(workflowRepositoryRoot, "src", "validate.js"),
    'export const validationArgs = ["bwrap", "--unshare-net"];\n',
    "utf8",
  );
  await execute("git", ["init", "-b", "main", workflowRepositoryRoot]);
  await execute("git", ["-C", workflowRepositoryRoot, "config", "user.name", "DocsFab Fixture"]);
  await execute("git", [
    "-C",
    workflowRepositoryRoot,
    "config",
    "user.email",
    "fixture@example.test",
  ]);
  await execute("git", ["-C", workflowRepositoryRoot, "add", "."]);
  // Signing is off for this one fixture commit only. A checkout-local
  // commit.gpgsign is configuration the host publisher refuses, so persisting it
  // here would stop the default draft delivery below with remote-drift.
  await execute("git", [
    "-C",
    workflowRepositoryRoot,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "workflow fixture",
  ]);
  await execute("git", ["init", "--bare", workflowBareRemoteRoot]);
  await execute("git", [
    "-C",
    workflowRepositoryRoot,
    "remote",
    "add",
    "origin",
    "git@gitlab.example.test:group/project.git",
  ]);
  await execute("git", ["-C", workflowRepositoryRoot, "push", workflowBareRemoteRoot, "main:main"]);
  await writeDeliveryProtocolFixture({
    binRoot,
    bareRepository: workflowBareRemoteRoot,
    statePath: fakeGitLabStatePath,
  });
  const sshEnvironment = { ...process.env, PATH: `${binRoot}:${process.env.PATH ?? ""}` };
  const seededWorkflowRevision = (
    await execute("git", ["-C", workflowRepositoryRoot, "rev-parse", "HEAD"])
  ).stdout.trim();
  const remoteWorkflowRevision = (
    await execute("git", ["-C", workflowRepositoryRoot, "ls-remote", "origin", "refs/heads/main"], {
      env: sshEnvironment,
    })
  ).stdout
    .trim()
    .split(/\s+/u)[0];
  if (remoteWorkflowRevision !== seededWorkflowRevision) {
    fail("strict SSH fixture did not read the real local bare repository through git-upload-pack");
  }
  await execute("git", ["init", "--bare", remoteRoot]);
  await git(["remote", "add", "origin", remoteRoot]);
  // Only the external forge is a fixture. File edits, Git commit, and push are real.
  const legacyForgeResult = await execute(
    "glab",
    [
      "mr",
      "create",
      "--draft",
      "--source-branch",
      "docs/current-work",
      "--target-branch",
      "main",
      "--title",
      "Update",
      "--description",
      "Documentation",
      "--yes",
    ],
    { env: sshEnvironment },
  );
  if (
    !legacyForgeResult.stdout.includes("https://gitlab.example.test/team/repo/-/merge_requests/1")
  ) {
    fail("fixture glab did not preserve the existing live-agent forge command contract");
  }
  await execute("glab", ["auth", "status", "--hostname", "gitlab.example.test"], {
    env: sshEnvironment,
  });
  const fixtureUser = JSON.parse(
    (
      await execute("glab", ["api", "--hostname", "gitlab.example.test", "user"], {
        env: sshEnvironment,
      })
    ).stdout,
  );
  const fixtureProjectId = JSON.parse(
    (
      await execute(
        "glab",
        [
          "api",
          "--hostname",
          "gitlab.example.test",
          "graphql",
          "-f",
          "query=project",
          "-F",
          "fullPath=group/project",
        ],
        { env: sshEnvironment },
      )
    ).stdout,
  ).data.project.id;
  const fixtureProject = JSON.parse(
    (
      await execute("glab", ["api", "--hostname", "gitlab.example.test", "projects/99"], {
        env: sshEnvironment,
      })
    ).stdout,
  );
  const fixtureTarget = JSON.parse(
    (
      await execute(
        "glab",
        ["api", "--hostname", "gitlab.example.test", "projects/99/repository/branches/main"],
        { env: sshEnvironment },
      )
    ).stdout,
  );
  const fixtureProtectedBranches = JSON.parse(
    (
      await execute(
        "glab",
        [
          "api",
          "--hostname",
          "gitlab.example.test",
          "projects/99/protected_branches?per_page=100&page=1",
        ],
        { env: sshEnvironment },
      )
    ).stdout,
  );
  const fixtureMergeRequests = JSON.parse(
    (
      await execute(
        "glab",
        [
          "api",
          "--hostname",
          "gitlab.example.test",
          "projects/99/merge_requests?scope=all&state=all&source_branch=docs%2Ffixture&per_page=100&page=1",
        ],
        { env: sshEnvironment },
      )
    ).stdout,
  );
  if (
    fixtureUser.username !== "fixture-user" ||
    fixtureProjectId !== "gid://gitlab/Project/99" ||
    fixtureProject.path_with_namespace !== "group/project" ||
    fixtureTarget.name !== "main" ||
    !fixtureTarget.protected ||
    fixtureProtectedBranches.length !== 0 ||
    fixtureMergeRequests.length !== 0
  ) {
    fail("strict fake GitLab protocol fixture did not serve the expected preflight responses");
  }
  const assertFixtureRefuses = async (program, args, label, environment = sshEnvironment) => {
    let rejected = false;
    try {
      await execute(program, args, { env: environment });
    } catch {
      rejected = true;
    }
    if (!rejected) fail(`strict delivery fixture accepted ${label}`);
  };
  const assertOracleMutantKilled = async ({
    name,
    program,
    args,
    file,
    guard,
    mutate,
    prepare,
  }) => {
    const mutantRoot = join(temporaryRoot, `fixture-mutant-${name}`);
    await mkdir(mutantRoot, { recursive: true, mode: 0o700 });
    await writeDeliveryProtocolFixture({
      binRoot: mutantRoot,
      bareRepository: workflowBareRemoteRoot,
      statePath: join(mutantRoot, "state.json"),
    });
    const fixturePath = join(mutantRoot, file);
    const source = await readFile(fixturePath, "utf8");
    let mutantSource;
    if (mutate) {
      mutantSource = mutate(source);
    } else {
      const originalGuard = source.split("\n").find((line) => guard.test(line));
      if (!originalGuard) fail(`fixture mutant ${name} could not locate its named guard`);
      mutantSource = source.replace(originalGuard, "if (false) reject();");
    }
    if (mutantSource === source) fail(`fixture mutant ${name} did not apply`);
    await writeFile(fixturePath, mutantSource, { encoding: "utf8", mode: 0o700 });
    const mutantEnvironment = {
      ...sshEnvironment,
      PATH: `${mutantRoot}:${sshEnvironment.PATH ?? ""}`,
    };
    await prepare?.(mutantEnvironment);
    let refusalAssertionFailed = false;
    try {
      await assertFixtureRefuses(program, args, `mutant ${name}`, mutantEnvironment);
    } catch (error) {
      refusalAssertionFailed =
        error instanceof Error && error.message.includes(`accepted mutant ${name}`);
    }
    if (!refusalAssertionFailed) {
      fail(`fixture refusal assertion did not kill mutant ${name}`);
    }
    linuxDeliveryEvidenceForRetention.localFixtureGuardMutantsKilled.push(name);
    await persistLinuxDeliveryEvidence();
  };
  await assertFixtureRefuses(
    "ssh",
    ["git@gitlab.unexpected.test", "git-upload-pack 'group/project.git'"],
    "an unexpected SSH host",
  );
  await assertFixtureRefuses(
    "ssh",
    ["-o", "SendEnv=GIT_PROTOCOL", "git@gitlab.example.test", "git-upload-pack 'group/other.git'"],
    "an unexpected SSH repository",
  );
  await assertOracleMutantKilled({
    name: "ssh-host",
    program: "ssh",
    args: ["git@gitlab.unexpected.test", "git-upload-pack 'group/project.git'"],
    file: "ssh",
    mutate: (source) =>
      source
        .replace(
          "while (index < args.length && args[index] !== host)",
          "while (index < args.length && !args[index].startsWith('git@'))",
        )
        .replace(
          "if (args[index] !== host || index + 2 !== args.length)",
          "if (args[index] !== host) process.exit(0); if (index + 2 !== args.length)",
        ),
  });
  await assertOracleMutantKilled({
    name: "ssh-repository",
    program: "ssh",
    args: [
      "-o",
      "SendEnv=GIT_PROTOCOL",
      "git@gitlab.example.test",
      "git-upload-pack 'group/other.git'",
    ],
    file: "ssh",
    mutate: (source) => {
      const line = source.split("\n").find((entry) => entry.includes("if (command !=="));
      return line
        ? source.replace(line, `if (command.includes('group/other.git')) process.exit(0); ${line}`)
        : source;
    },
  });
  const originalFakeState = await readFile(fakeGitLabStatePath, "utf8");
  const validFixturePost = [
    "api",
    "--hostname",
    "gitlab.example.test",
    "--method",
    "POST",
    "projects/99/merge_requests",
    "--field",
    "title=Draft: [DocsFab Run] fixture",
    "--field",
    "description=docsfab-publication-provenance:v1 fixture",
    "--field",
    "source_branch=main",
    "--field",
    "target_branch=main",
    "--field",
    "remove_source_branch=false",
    "--field",
    "squash=false",
  ];
  const unexpectedFieldPost = [...validFixturePost, "--field", "unexpected=value"];
  await assertFixtureRefuses("glab", unexpectedFieldPost, "an unexpected merge-request field");
  await assertOracleMutantKilled({
    name: "mr-fields",
    program: "glab",
    args: unexpectedFieldPost,
    file: "glab-fixture.mjs",
    guard: /if \(Object\.keys\(fields\)\.sort\(\)/u,
  });
  await execute("glab", validFixturePost, { env: sshEnvironment });
  await assertFixtureRefuses("glab", validFixturePost, "a duplicate source-branch MR");
  await assertOracleMutantKilled({
    name: "mr-duplicate",
    program: "glab",
    args: validFixturePost,
    file: "glab-fixture.mjs",
    guard: /if \(current\.created\.some/u,
    prepare: (environment) => execute("glab", validFixturePost, { env: environment }),
  });
  await writeFile(fakeGitLabStatePath, originalFakeState, { encoding: "utf8", mode: 0o600 });
  if (process.platform === "darwin") await writeDarwinExpectScript(expectScriptPath);

  const npmEnvironment = {
    ...process.env,
    NPM_CONFIG_CACHE: npmCacheRoot,
    npm_config_cache: npmCacheRoot,
  };
  const candidate = await preparePackedCandidate({
    projectRoot,
    packDestination: packRoot,
    env: npmEnvironment,
    artifactDirectoryLeaf,
  });
  const { tarball } = candidate;
  const { executable, installedPackageRoot } = await installPackedDocsFab({
    tarball,
    installRoot,
    cwd: temporaryRoot,
    env: npmEnvironment,
  });
  const installedPackage = JSON.parse(
    await readFile(join(installedPackageRoot, "package.json"), "utf8"),
  );
  linuxDeliveryEvidenceForRetention.packageName = installedPackage.name;
  linuxDeliveryEvidenceForRetention.packageVersion = installedPackage.version;
  linuxDeliveryEvidenceForRetention.packageIntegrity = candidate.integrity;
  linuxDeliveryEvidenceForRetention.sourceRevision = candidate.sourceRevision;

  const { certificatePath, keyPath } = await createLocalCertificate(tlsRoot);
  const providerRequests = [];
  let liveWorkflowRunId;
  const workflowCaptureDirectory = join(
    projectRoot,
    "..",
    "..",
    ".docsfab",
    "reports",
    "2332",
    "workflow-model-requests",
    basename(temporaryRoot),
  );
  workflowCaptureDirectoryForEvidence = workflowCaptureDirectory;
  let providerFailure;
  let publicationTurn = 0;
  let installedTaskTurn = 0;
  let savedRunTurn = 0;
  const { classifyInstalledSessionRequest } = await import("./live-agent-session-e2e-dispatch.mjs");
  const provider = createServer(
    {
      cert: readFileSync(certificatePath),
      key: readFileSync(keyPath),
    },
    async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          fail(`provider received unexpected ${request.method} ${request.url}`);
        }
        const payload = JSON.parse(await readRequestBody(request));
        providerRequests.push(payload);
        const index = providerRequests.length;
        const installedScenario = classifyInstalledSessionRequest(payload, {
          installedTaskPrompt,
          savedRunPrompt,
          liveWorkflowPublicationPrompt,
        });
        if (index === 12) {
          await mkdir(workflowCaptureDirectory, { recursive: true, mode: 0o700 });
          await writeFile(
            join(workflowCaptureDirectory, "request-12.json"),
            JSON.stringify(payload, null, 2),
          );
        }
        const serialized = JSON.stringify(payload);
        // From the publication session on, the bounded workflow the live agent
        // starts makes model calls of its own between the agent's turns. The
        // agent's turns are told apart by the message they answer: the user's
        // request, the workflow result, then each publication result.
        const lastMessage = payload.messages?.at?.(-1);
        const lastText =
          typeof lastMessage?.content === "string"
            ? lastMessage.content
            : JSON.stringify(lastMessage?.content ?? "");
        const liveAgentTurn = installedScenario === "live-workflow-publication-session";
        const turn = !liveAgentTurn
          ? 0
          : lastMessage?.role === "user" && lastText.includes(liveWorkflowPublicationPrompt)
            ? 1
            : lastMessage?.role === "tool" &&
                lastText.includes('"kind":"docsfab-live-workflow-result"')
              ? 2
              : lastMessage?.role === "tool" && lastText.includes("Draft merge request: ")
                ? publicationTurn++ === 0
                  ? 3
                  : 4
                : 0;
        if (index >= 15) {
          await mkdir(workflowCaptureDirectory, { recursive: true, mode: 0o700 });
          await writeFile(
            join(workflowCaptureDirectory, `request-${index}.json`),
            JSON.stringify(payload, null, 2),
          );
        }
        let body;
        if (index === 1) {
          if (payload.tools.some((tool) => ["write", "edit", "bash"].includes(tool.function.name)))
            fail("read-only session exposed mutation tools");
          if (!serialized.includes(directPrompt)) fail("direct prompt did not reach the provider");
          body = textTurn("Stored Bluebird.");
        } else if (index === 2) {
          if (!serialized.includes(skillPrompt))
            fail("multi-skill prompt did not reach the provider");
          body = toolTurn("docsfab_use_skill", { skill: "review-documentation" });
        } else if (index === 3) {
          if (!serialized.includes("Apply the locked DocsFab skill review-documentation")) {
            fail("first skill result did not return to the live conversation");
          }
          body = toolTurn("docsfab_use_skill", {
            skill: "review-documentation",
            reference: "references/review-methods.md",
          });
        } else if (index === 4) {
          if (!serialized.includes("Peer Review and Understanding Methods")) {
            fail("packaged supporting reference did not return to the live conversation");
          }
          body = toolTurn("docsfab_use_skill", { skill: "verify-technical-accuracy" });
        } else if (index === 5) {
          if (!serialized.includes("Apply the locked DocsFab skill verify-technical-accuracy")) {
            fail("additional skill result did not return to the live conversation");
          }
          body = textTurn("Review and technical-accuracy checks complete.");
        } else if (index === 6) {
          if (
            !serialized.includes(directPrompt) ||
            !serialized.includes("Stored Bluebird.") ||
            !serialized.includes(skillPrompt) ||
            !serialized.includes("Apply the locked DocsFab skill review-documentation") ||
            !serialized.includes("Apply the locked DocsFab skill verify-technical-accuracy") ||
            !serialized.includes("Review and technical-accuracy checks complete.") ||
            !serialized.includes(resumePrompt)
          ) {
            fail("the resumed provider request did not contain prior conversation context");
          }
          body = textTurn("Bluebird remembered.");
        } else if (index === 7) {
          for (const name of ["edit", "write", "bash"]) {
            if (!payload.tools.some((tool) => tool.function.name === name))
              fail(`write session omitted ${name}`);
          }
          body = toolTurn("docsfab_use_skill", { skill: "write-documentation" });
        } else if (index === 8) {
          if (!serialized.includes("Apply the locked DocsFab skill write-documentation"))
            fail("write skill result did not return before the README edit");
          body = toolTurn("edit", {
            path: "README.md",
            edits: [{ oldText: "Manual addition", newText: "Manual addition plus agent update" }],
          });
        } else if (index === 9) {
          if (
            !(await readFile(join(repositoryRoot, "README.md"), "utf8")).includes(
              "Manual addition plus agent update",
            )
          )
            fail("direct edit was not persisted");
          body = textTurn("Current README edit updated.");
        } else if (index === 10) {
          if (!serialized.includes(adocEditPrompt))
            fail("AsciiDoc request did not reach the provider");
          body = toolTurn("docsfab_use_skill", { skill: "write-documentation" });
        } else if (index === 11) {
          if (!serialized.includes("Apply the locked DocsFab skill write-documentation"))
            fail("write skill result did not return before the AsciiDoc edit");
          body = toolTurn("edit", {
            path: "manual/guide.adoc",
            edits: [{ oldText: "= Manual Guide", newText: "= Updated Manual Guide" }],
          });
        } else if (index === 12) {
          const guide = await readFile(join(repositoryRoot, "manual", "guide.adoc"), "utf8");
          if (
            !guide.startsWith("= Updated Manual Guide\n") ||
            !guide.includes(":toc:\n") ||
            !guide.includes("include::parts/shared.adoc[]\n") ||
            (await readFile(join(repositoryRoot, "manual", "parts", "shared.adoc"), "utf8")) !==
              "== Shared\n"
          ) {
            fail("configured AsciiDoc edit did not preserve the original syntax and include");
          }
          if (
            await readFile(join(repositoryRoot, "manual", "guide.md"), "utf8").then(
              () => true,
              () => false,
            )
          ) {
            fail("configured AsciiDoc edit created a replacement Markdown file");
          }
          body = textTurn("Configured AsciiDoc edit updated.");
        } else if (index === 13) {
          if (!serialized.includes(scopeEscapePrompt))
            fail("scope-escape request did not reach the provider");
          body = toolTurn("docsfab_use_skill", { skill: "write-documentation" });
        } else if (index === 14) {
          if (!serialized.includes("Apply the locked DocsFab skill write-documentation"))
            fail("write skill result did not return before the scope probe");
          body = toolTurn("write", { path: "outside.txt", content: "must stay denied\n" });
        } else if (index === 15) {
          if (!serialized.includes("outside this session's documentation scope"))
            fail("installed configured-root scope refusal was not returned to the model");
          if (
            await readFile(join(repositoryRoot, "outside.txt"), "utf8").then(
              () => true,
              () => false,
            )
          )
            fail("configured-root session wrote outside its tracked grant");
          body = textTurn("Outside write refused by the host scope.");
        } else if (index === 16) {
          body = toolTurn("docsfab_use_skill", { skill: "write-documentation" });
        } else if (index === 17) {
          if (!serialized.includes("Apply the locked DocsFab skill write-documentation"))
            fail("write skill result did not return before the publication command");
          body = toolTurn("bash", {
            command: [
              "set -e",
              ...Array.from({ length: 12 }, (_, n) => `# Approval fixture line ${n + 1}`),
              "git diff --check",
              "git switch -c docs/current-work",
              "git commit --only -m 'docs: update' -- README.md",
              "git push origin HEAD:refs/heads/docs/current-work",
              "glab mr create --draft --source-branch docs/current-work --target-branch main --title Update --description Documentation --yes",
            ].join("\n"),
          });
        } else if (index === 18) {
          if (!serialized.includes("https://gitlab.example.test/team/repo/-/merge_requests/1"))
            fail("forge CLI result did not return to the model");
          body = textTurn("Current changes published to the fixture MR.");
        } else if (index === 19) {
          body = toolTurn("docsfab_use_skill", { skill: "write-documentation" });
        } else if (index === 20) {
          if (!serialized.includes("Apply the locked DocsFab skill write-documentation"))
            fail("write skill result did not return before the declined command");
          body = toolTurn("bash", { command: "touch declined.txt" });
        } else if (index === 21) {
          if (!serialized.includes("The host command was cancelled"))
            fail("declined approval was not returned");
          body = textTurn("Command declined; no changes made.");
        } else if (installedScenario === "installed-bounded-task") {
          const taskTurn = installedTaskTurn++;
          if (taskTurn === 0) {
            if (!payload.tools.some((tool) => tool.function.name === "edit"))
              fail("installed bounded task omitted its confined edit tool");
            body = toolTurn("docsfab_use_skill", { skill: "write-documentation" });
          } else if (taskTurn === 1) {
            if (!serialized.includes("Apply the locked DocsFab skill write-documentation"))
              fail("write skill result did not return before the bounded-task edit");
            body = toolTurn("edit", {
              path: "manual/guide.adoc",
              edits: [{ oldText: "= Task Guide", newText: "= Updated Task Guide" }],
            });
          } else {
            body = textTurn(
              JSON.stringify({
                schemaVersion: 1,
                kind: "docsfab-live-agent-task-declaration",
                decision: "change",
                evidenceIds: ["host-diff"],
              }),
            );
          }
        } else if (installedScenario === "saved-run-recovery") {
          if (savedRunTurn++ === 0) {
            if (
              payload.tools.some((tool) => ["write", "edit", "bash"].includes(tool.function.name))
            )
              fail("saved-run recovery exposed mutation tools in read-only mode");
            if (!payload.tools.some((tool) => tool.function.name === "docsfab_read_run"))
              fail("saved-run tool was not registered in the installed session");
            body = toolTurn("docsfab_read_run", { runId: "saved-review" });
          } else {
            if (!serialized.includes("Saved fixture review finding."))
              fail("saved findings did not reach the model");
            body = textTurn("Saved review recovered without rerunning it.");
          }
        } else if (turn === 1) {
          if (
            !serialized.includes("docsfab_run_workflow") ||
            !serialized.includes("Correct docs/guide.md")
          ) {
            fail("live-agent did not receive the bounded documentation-and-publication request");
          }
          // The instruction is the user's message verbatim; the agent's own
          // detail goes in context, as the tool requires.
          body = toolTurn("docsfab_run_workflow", {
            workflow: "update-documentation",
            instruction: liveWorkflowPublicationPrompt,
            context:
              "Correct docs/guide.md: replace the inaccurate sentence about network access and explain validation runs using BubbleWrap with --unshare-net, as shown in src/validate.js.",
          });
        } else if (turn === 2) {
          // The tool result is JSON text inside the request, so read it unescaped.
          const runId = /"kind":"docsfab-live-workflow-result","runId":"([0-9a-f-]{36})"/u.exec(
            lastText,
          )?.[1];
          if (!runId || !lastText.includes('"workflowStatus":"succeeded"')) {
            fail("live-agent workflow result did not contain a successful saved run identity");
          }
          liveWorkflowRunId = runId;
          body = toolTurn("docsfab_publish_workflow", { runId });
        } else if (turn === 3) {
          if (
            !serialized.includes(
              "Draft merge request: https://gitlab.example.test/group/project/-/merge_requests/",
            )
          ) {
            fail("live-agent publication result did not include the fake-forge draft MR");
          }
          body = toolTurn("docsfab_publish_workflow", { runId: liveWorkflowRunId });
        } else if (turn === 4) {
          if (
            !serialized.includes(
              "Draft merge request: https://gitlab.example.test/group/project/-/merge_requests/",
            )
          ) {
            fail("live-agent idempotent publication replay did not return the existing draft MR");
          }
          body = textTurn("The fixture draft MR is open for the saved documentation run.");
        } else if (index >= 15) {
          await mkdir(workflowCaptureDirectory, { recursive: true, mode: 0o700 });
          await writeFile(
            join(workflowCaptureDirectory, `request-${index}.json`),
            JSON.stringify(payload, null, 2),
          );
          const prompt = payload.messages
            .map((message) => {
              const content = message.content;
              return typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content
                      .map((part) => (typeof part.text === "string" ? part.text : ""))
                      .join("\n")
                  : "";
            })
            .join("\n");
          const admittedEvidenceRefsText =
            /The only artifact references admitted for evidenceRefs are: (\[[^\n]+\])/u.exec(
              prompt,
            )?.[1];
          const admittedEvidenceRefs = admittedEvidenceRefsText
            ? JSON.parse(admittedEvidenceRefsText)
            : [];
          body = prompt.includes("Runtime request-interpretation response contract")
            ? textTurn(
                JSON.stringify({
                  operation: "update",
                  targets: [
                    {
                      path: "docs/guide.md",
                      role: "write",
                      chosenFrom: "named",
                      quote: "docs/guide.md",
                    },
                  ],
                  authorityPreference: { preference: "unspecified", quote: null },
                }),
              )
            : prompt.includes("Runtime reader-impact planner response contract")
              ? textTurn(
                  JSON.stringify({
                    summary:
                      "Update docs/guide.md to correct its network statement using the implementation in src/validate.js; preserve unrelated guidance.",
                    planBinding: {
                      mode: "update",
                      pages: [{ path: "docs/guide.md", disposition: "update" }],
                      sourceBindings: [
                        {
                          pagePath: "docs/guide.md",
                          sources: ["docs/guide.md", "src/validate.js"],
                        },
                      ],
                    },
                    editorialDecisionProposal: {
                      candidate: "update",
                      rationale:
                        "The current page claims checks have no network restrictions, while the fixture implementation declares BubbleWrap --unshare-net.",
                      slotIds: ["current-documentation", "public-contract"],
                    },
                  }),
                )
              : prompt.includes("Runtime source-obligation response contract") &&
                  !prompt.includes("[source-line 1]")
                ? toolTurn("read", { path: "src/validate.js" })
                : prompt.includes("Runtime source-obligation response contract")
                  ? textTurn(
                      JSON.stringify({
                        completeness: "bounded-not-proven",
                        dimensions: [
                          {
                            dimension: "input-representations",
                            status: "unverified",
                            reason:
                              "The bound fixture source does not establish input representations.",
                            sourceLocators: [],
                            obligations: [],
                          },
                          {
                            dimension: "defaults-and-overrides",
                            status: "unverified",
                            reason:
                              "The bound fixture source does not establish defaults or overrides.",
                            sourceLocators: [],
                            obligations: [],
                          },
                          {
                            dimension: "mutable-state",
                            status: "unverified",
                            reason: "The bound fixture source does not establish mutable state.",
                            sourceLocators: [],
                            obligations: [],
                          },
                          {
                            dimension: "destination-and-trust",
                            status: "unverified",
                            reason:
                              "The bound fixture source does not establish destination or trust behavior.",
                            sourceLocators: [],
                            obligations: [],
                          },
                          {
                            dimension: "error-status-retry",
                            status: "unverified",
                            reason:
                              "The bound fixture source does not establish error, status, or retry behavior.",
                            sourceLocators: [],
                            obligations: [],
                          },
                          {
                            dimension: "environment-prerequisite",
                            status: "applicable",
                            reason: "The source declares the validation environment prerequisite.",
                            sourceLocators: [],
                            obligations: [
                              {
                                dimension: "environment-prerequisite",
                                sourceLocators: ["src/validate.js:1"],
                                statement:
                                  "The validation argv uses BubbleWrap with --unshare-net.",
                                evidenceClass: "source-observation",
                                uncertainty:
                                  "This source proves the declared argv only; runtime isolation is evaluated by the delivery boundary.",
                              },
                            ],
                          },
                        ],
                        limitations: [
                          "The bound fixture source does not establish input representations.",
                          "The bound fixture source does not establish defaults or overrides.",
                          "The bound fixture source does not establish mutable state.",
                          "The bound fixture source does not establish destination or trust behavior.",
                          "The bound fixture source does not establish error, status, or retry behavior.",
                        ],
                      }),
                    )
                  : prompt.includes("test-audience-understanding") &&
                      !prompt.includes('<skill name="evaluate-document-quality"')
                    ? await (async () => {
                        const reply = JSON.stringify({
                          summary:
                            "No approved audience protocol, scenario corpus, or representative participant is bound to this run; no audience test was performed.",
                          editorialAssessmentProposal: {
                            schemaVersion: 1,
                            kind: "docsfab-editorial-assessment-proposal",
                            assessment: "not-applicable",
                            rationale:
                              "This fixture has no authorized audience-testing protocol or participant.",
                            evidenceRefs: admittedEvidenceRefs,
                            limitations: [],
                            recommendation: null,
                          },
                        });
                        const turn = textTurn(reply);
                        await writeFile(
                          join(workflowCaptureDirectory, "audience-response-hit.json"),
                          JSON.stringify(
                            {
                              index,
                              promptLength: prompt.length,
                              admittedEvidenceRefs,
                              reply,
                              bytes: Buffer.byteLength(turn),
                            },
                            null,
                            2,
                          ),
                        );
                        return turn;
                      })()
                    : prompt.includes('<skill name="review-documentation"') &&
                        !prompt.includes("[source-line")
                      ? toolTurn("read", { path: "docs/guide.md" })
                      : prompt.includes('<skill name="review-documentation"')
                        ? textTurn(
                            JSON.stringify({
                              summary: { verdict: "pass", issues: [] },
                              editorialAssessmentProposal: {
                                schemaVersion: 1,
                                kind: "docsfab-editorial-assessment-proposal",
                                assessment: "accepted",
                                rationale:
                                  "Independent review confirms the edited sentence is clear and agrees with the source evidence.",
                                evidenceRefs: admittedEvidenceRefs,
                                limitations: [],
                                recommendation: null,
                              },
                            }),
                          )
                        : prompt.includes('<skill name="evaluate-document-quality"')
                          ? (() => {
                              const repositoryRevision =
                                admittedEvidenceRefs[0]?.repositoryRevision ?? "unknown";
                              // The current UPDATE contract: the outer editorial envelope keeps summary and
                              // editorialAssessmentProposal, and summary holds the two-key answer object and then the report.
                              // The host writes the Validated result summary, so the report omits it.
                              const profilePath =
                                /Use the locked profile at quality\/(\S+?\.json)\./u.exec(
                                  prompt,
                                )?.[1];
                              const profile = JSON.parse(
                                readFileSync(
                                  join(installedPackageRoot, "quality", profilePath ?? "unknown"),
                                  "utf8",
                                ),
                              );
                              const limitations = [
                                "Audience testing was not performed because this run has no authorized protocol or participant.",
                                "No rubric was selected for the generic page path.",
                              ];
                              const report = [
                                "# Documentation quality evaluation report",
                                "",
                                "## Findings",
                                "",
                                "The available fixture supports the corrected statement, but no representative audience outcome or safely selected rubric is available. The experimental profile does not permit a pass decision.",
                                "",
                                "## Evidence gaps and limitations",
                                "",
                                ...limitations.map((limitation) => `- Limitation: ${limitation}`),
                              ].join("\n");
                              return textTurn(
                                JSON.stringify({
                                  summary: `${JSON.stringify({ evaluation: scriptedQualityEvaluation(profile, repositoryRevision, limitations), qualityScore: null })}\n\n${report}`,
                                  editorialAssessmentProposal: {
                                    schemaVersion: 1,
                                    kind: "docsfab-editorial-assessment-proposal",
                                    assessment: "accepted",
                                    rationale:
                                      "The quality assessment preserves the user-requested update while recording the missing audience and rubric evidence.",
                                    evidenceRefs: admittedEvidenceRefs,
                                    limitations: [
                                      "audience.protocol-unavailable",
                                      "rubric.family-unavailable",
                                    ],
                                    recommendation: null,
                                  },
                                }),
                              );
                            })()
                          : prompt.includes(
                                "Runtime independent editorial assessment response contract",
                              ) &&
                              prompt.includes('<skill name="verify-technical-accuracy"') &&
                              !prompt.includes("[source-line")
                            ? toolTurn("read", { path: "src/validate.js" })
                            : prompt.includes(
                                  "Runtime independent editorial assessment response contract",
                                ) &&
                                prompt.includes('<skill name="verify-technical-accuracy"') &&
                                !prompt.includes("Validation runs with BubbleWrap")
                              ? toolTurn("read", { path: "docs/guide.md" })
                              : prompt.includes(
                                    "Runtime independent editorial assessment response contract",
                                  ) && prompt.includes('<skill name="verify-technical-accuracy"')
                                ? textTurn(
                                    JSON.stringify({
                                      summary: {
                                        review: { verdict: "pass", issues: [] },
                                        coverage: [
                                          {
                                            path: "docs/guide.md",
                                            status: "verified",
                                            evidence: ["src/validate.js:1", "docs/guide.md:3"],
                                            reason:
                                              "The changed network statement matches the complete one-line fixture argv; this review covers only that statement.",
                                          },
                                        ],
                                        factInventory: {
                                          completeness: "bounded-not-proven",
                                          dimensions: [
                                            {
                                              dimension: "input-representations",
                                              status: "not-applicable",
                                              reason:
                                                "The one-line fixture declares no accepted input representations.",
                                              sourceLocators: ["src/validate.js:1"],
                                              facts: [],
                                            },
                                            {
                                              dimension: "defaults-and-overrides",
                                              status: "not-applicable",
                                              reason:
                                                "The one-line fixture declares no defaults or overrides.",
                                              sourceLocators: ["src/validate.js:1"],
                                              facts: [],
                                            },
                                            {
                                              dimension: "mutable-state",
                                              status: "not-applicable",
                                              reason:
                                                "The one-line fixture declares no mutable state.",
                                              sourceLocators: ["src/validate.js:1"],
                                              facts: [],
                                            },
                                            {
                                              dimension: "destination-and-trust",
                                              status: "not-applicable",
                                              reason:
                                                "The one-line fixture declares no destination or trust boundary.",
                                              sourceLocators: ["src/validate.js:1"],
                                              facts: [],
                                            },
                                            {
                                              dimension: "error-status-retry",
                                              status: "not-applicable",
                                              reason:
                                                "The one-line fixture declares no error, status, or retry behavior.",
                                              sourceLocators: ["src/validate.js:1"],
                                              facts: [],
                                            },
                                            {
                                              dimension: "environment-prerequisite",
                                              status: "applicable",
                                              reason:
                                                "The fixture requires BubbleWrap with network unsharing.",
                                              sourceLocators: [],
                                              facts: [
                                                {
                                                  id: "FACT-001",
                                                  dimension: "environment-prerequisite",
                                                  sourceLocators: ["src/validate.js:1"],
                                                  statement:
                                                    "Validation uses BubbleWrap with --unshare-net.",
                                                  documentationDisposition: "documented",
                                                  uncertainty:
                                                    "The source proves the declared argv; actual isolation behavior is established separately by the installed delivery probe.",
                                                  issueIds: [],
                                                },
                                              ],
                                            },
                                          ],
                                          limitations: [],
                                        },
                                      },
                                      editorialAssessmentProposal: {
                                        schemaVersion: 1,
                                        kind: "docsfab-editorial-assessment-proposal",
                                        assessment: "accepted",
                                        rationale:
                                          "Independent source and page reads confirm the updated network statement.",
                                        evidenceRefs: admittedEvidenceRefs,
                                        limitations: [],
                                        recommendation: null,
                                      },
                                    }),
                                  )
                                : prompt.includes(
                                      "Successfully replaced 1 block(s) in docs/guide.md",
                                    )
                                  ? textTurn(
                                      "Updated docs/guide.md to state that validation uses BubbleWrap with --unshare-net, matching src/validate.js.",
                                    )
                                  : prompt.includes('"write-documentation"') ||
                                      prompt.includes("Use the locked write-documentation")
                                    ? toolTurn("edit", {
                                        path: "docs/guide.md",
                                        edits: [
                                          {
                                            oldText: "Checks run without network restrictions.",
                                            newText:
                                              "Validation runs with BubbleWrap's `--unshare-net` option.",
                                          },
                                        ],
                                      })
                                    : textTurn("{}");
        } else {
          fail(`provider received unexpected request ${index}`);
        }
        if (index >= 15) {
          await mkdir(workflowCaptureDirectory, { recursive: true, mode: 0o700 });
          if (liveAgentTurn) {
            await writeFile(
              join(workflowCaptureDirectory, `request-${index}.json`),
              JSON.stringify(payload, null, 2),
            );
          }
          await writeFile(
            join(workflowCaptureDirectory, `response-${index}.json`),
            JSON.stringify(
              {
                providerRequestSequence: index,
                responseBytes: Buffer.byteLength(body),
                responseBody: body,
              },
              null,
              2,
            ),
          );
        } else if (index === 12) {
          await mkdir(workflowCaptureDirectory, { recursive: true, mode: 0o700 });
          await writeFile(
            join(workflowCaptureDirectory, "request-12.json"),
            JSON.stringify(payload, null, 2),
          );
          await writeFile(
            join(workflowCaptureDirectory, "response-12.json"),
            JSON.stringify(
              {
                providerRequestSequence: index,
                responseBytes: Buffer.byteLength(body),
                responseBody: body,
              },
              null,
              2,
            ),
          );
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(body);
      } catch (error) {
        providerFailure = error;
        if (providerRequests.length === 12) {
          await writeFile(
            join(workflowCaptureDirectory, "provider-error-12.txt"),
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          ).catch(() => undefined);
        }
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "scripted provider failure" } }));
      }
    },
  );
  await listen(provider);

  try {
    const address = provider.address();
    if (!address || typeof address === "string") fail("local provider did not bind a TCP port");
    await writeModelConfiguration(configurationRoot, `https://127.0.0.1:${address.port}/v1`);
    const environment = isolatedEnvironment({
      configurationRoot,
      certificatePath,
      homeRoot,
    });

    const first = await runInteractiveSession({
      executable,
      repositoryRoot,
      environment,
      expectScriptPath,
      turns: [
        { prompt: directPrompt, expected: "DocsFab: Stored Bluebird." },
        {
          prompt: skillPrompt,
          expected: "DocsFab: Review and technical-accuracy checks complete.",
        },
      ],
    });
    assertStartup(first.output);

    const second = await runInteractiveSession({
      executable,
      repositoryRoot,
      environment,
      expectScriptPath,
      turns: [{ prompt: resumePrompt, expected: "DocsFab: Bluebird remembered." }],
    });
    assertStartup(second.output);

    if (first.sessionId !== second.sessionId) {
      fail(`session did not resume (${first.sessionId} != ${second.sessionId})`);
    }
    if (providerFailure) throw providerFailure;
    await writeFile(
      join(repositoryRoot, "README.md"),
      "# Live-agent E2E fixture\nManual addition\n",
    );
    await writeFile(join(repositoryRoot, "unrelated.txt"), "Preserve unrelated staged work\n");
    await git(["add", "unrelated.txt"]);
    const third = await runInteractiveSession({
      executable,
      repositoryRoot,
      expectScriptPath,
      allowWrite: true,
      environment: { ...environment, PATH: `${binRoot}:${environment.PATH}` },
      turns: [
        { prompt: editPrompt, expected: "DocsFab: Current README edit updated." },
        { prompt: adocEditPrompt, expected: "DocsFab: Configured AsciiDoc edit updated." },
        {
          prompt: scopeEscapePrompt,
          expected: "DocsFab: Outside write refused by the host scope.",
        },
        {
          prompt: publishPrompt,
          expected: "DocsFab: Current changes published to the fixture MR.",
          approval: "y",
        },
        {
          prompt: declinePrompt,
          expected: "DocsFab: Command declined; no changes made.",
          approval: "n",
        },
      ],
    });
    if (third.sessionId !== first.sessionId) fail("write-enabled session did not resume");
    for (const marker of [
      "APPROVAL · Host command",
      "[y] Approve  [n] Cancel (default: cancel):",
      "│ git diff --check",
    ]) {
      if (!third.output.includes(marker)) fail(`missing readable approval marker: ${marker}`);
    }
    if (third.output.includes("display lines hidden") || third.output.includes("[v]")) {
      fail("approval hid script content or offered the removed replay option");
    }
    if (third.output.indexOf("glab mr create") > third.output.indexOf("(default: cancel):")) {
      fail("approval prompt appeared before the final publication command");
    }
    if (
      !(
        await execute("git", ["--git-dir", remoteRoot, "show", "docs/current-work:README.md"])
      ).stdout.includes("Manual addition plus agent update")
    )
      fail("published commit omitted current edits");
    if ((await git(["diff", "--cached", "--name-only"])).stdout.trim() !== "unrelated.txt")
      fail("unrelated staged work was changed");
    if ((await readdir(repositoryRoot)).includes("declined.txt")) fail("declined command executed");
    if (providerFailure) throw providerFailure;

    const taskEnvironment = { ...environment, DOCSFAB_STATE_DIR: taskStateRoot };
    const taskProbe = await readInstalledTaskInputs({
      repositoryPath: taskRepositoryRoot,
      environment: taskEnvironment,
    });
    const taskRequest = {
      schemaVersion: 1,
      kind: "docsfab-live-agent-task-request",
      taskId: "installed-e2e-task",
      sessionId: "installed-e2e-session",
      prompt: {
        encoding: "utf-8",
        text: installedTaskPrompt,
        sha256: createHash("sha256").update(installedTaskPrompt, "utf8").digest("hex"),
      },
      baseline: {
        repositoryRevision: taskProbe.repositoryRevision,
        contentSha256: taskProbe.contentSha256,
      },
      sources: [],
      scope: {
        documentationRoots: ["manual/guide.adoc"],
        requestedPaths: ["manual/guide.adoc"],
        writeClass: "documentation",
      },
      requiredEvidence: [],
      effectiveConfig: taskProbe.effectiveConfig,
    };
    const taskFile = join(taskInputRoot, "task.json");
    await writeFile(taskFile, `${JSON.stringify(taskRequest)}\n`, { mode: 0o600 });
    const taskRun = await execute(
      executable,
      [
        "live-agent",
        "--repo",
        taskRepositoryRoot,
        "--task-file",
        taskFile,
        "--result-dir",
        taskResultRoot,
        "--docs-file",
        "manual/guide.adoc",
        "--allow-write",
        "--json",
      ],
      { cwd: temporaryRoot, env: taskEnvironment },
    );
    const taskSummary = JSON.parse(taskRun.stdout);
    if (
      taskSummary.executionStatus !== "completed" ||
      (await readFile(join(taskRepositoryRoot, "manual", "guide.adoc"), "utf8")) !==
        "= Updated Task Guide\n\ninclude::shared.adoc[]\n" ||
      (await readFile(join(taskRepositoryRoot, "manual", "shared.adoc"), "utf8")) !== "== Shared\n"
    ) {
      fail("installed bounded task did not update only its exact tracked AsciiDoc grant");
    }
    if (providerFailure) throw providerFailure;
    const runDirectory = join(configurationRoot, ".docsfab", "runs");
    await mkdir(runDirectory, { recursive: true });
    const savedRecordPath = join(runDirectory, "saved-review.json");
    const savedRecord = JSON.stringify({
      schemaVersion: 2,
      id: "saved-review",
      workflow: "review-documentation",
      status: "succeeded",
      repository: { sourcePath: repositoryRoot, revision: "a".repeat(40) },
      changes: { files: [] },
      steps: [
        {
          id: "review-documentation",
          skill: "review-documentation",
          status: "succeeded",
          summary: "Saved fixture review finding.",
        },
      ],
    });
    await writeFile(savedRecordPath, savedRecord);
    const fourth = await runInteractiveSession({
      executable,
      repositoryRoot,
      environment,
      expectScriptPath,
      turns: [
        {
          prompt: savedRunPrompt,
          expected: "DocsFab: Saved review recovered without rerunning it.",
        },
      ],
    });
    if (
      fourth.output.includes("APPROVAL") ||
      !fourth.output.includes("Reading saved run: saved-review")
    )
      fail("saved-run recovery requested approval or did not identify the run");
    if ((await readFile(savedRecordPath, "utf8")) !== savedRecord)
      fail("saved-run inspection mutated the record");
    if (providerRequests.length !== expectedPreWorkflowProviderRequests) {
      fail(
        `expected ${expectedPreWorkflowProviderRequests} provider requests across the interactive, bounded-task, and saved-run journeys, observed ${providerRequests.length}`,
      );
    }
    if (installedTaskTurn !== 3)
      fail(`expected 3 installed bounded-task turns, observed ${installedTaskTurn}`);
    if (savedRunTurn !== 2) fail(`expected 2 saved-run recovery turns, observed ${savedRunTurn}`);
    const workflowFirstProviderRequest = providerRequests.length + 1;
    const deliveryOracleEnabled = process.platform === "linux";
    if (deliveryOracleEnabled) {
      linuxDeliveryEvidenceForRetention.cliRunId = null;
      linuxDeliveryEvidenceForRetention.status = "running";
      linuxDeliveryEvidenceForRetention.stage = "cli-workflow";
      await persistLinuxDeliveryEvidence();
    }
    let workflowResult;
    try {
      const completed = await execute(
        executable,
        [
          "run",
          "update-documentation",
          "--repo",
          workflowRepositoryRoot,
          "--instruction",
          "Correct docs/guide.md: replace the inaccurate sentence about network access and explain validation runs using Bubblewrap with --unshare-net, as shown in src/validate.js.",
          ...(deliveryOracleEnabled ? ["--draft-mr"] : ["--patch-only"]),
          "--json",
        ],
        {
          cwd: workflowRepositoryRoot,
          env: { ...environment, PATH: `${binRoot}:${environment.PATH ?? ""}` },
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      workflowResult = runResultFromStdout(completed.stdout);
    } catch (error) {
      // Keep the first provider requests and the refusal for diagnosis;
      // success is not asserted here.
      await mkdir(workflowCaptureDirectory, { recursive: true, mode: 0o700 });
      let result;
      try {
        result = runResultFromStdout(error.stdout ?? "{}");
      } catch {
        result = undefined;
      }
      if (typeof result?.execution?.recordPath === "string") {
        await writeFile(
          join(workflowCaptureDirectory, "failed-run-record.json"),
          await readFile(result.execution.recordPath),
        );
      }
      workflowResult = result;
      await writeFile(
        join(workflowCaptureDirectory, "cli-refusal.txt"),
        `${error.stdout ?? ""}\n${error.stderr ?? error.message ?? ""}`,
      );
    }
    if (providerRequests.length <= expectedPreWorkflowProviderRequests)
      fail("the workflow did not reach its model provider");
    await mkdir(workflowCaptureDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(workflowCaptureDirectory, "summary.json"),
      JSON.stringify(
        {
          runId: workflowResult?.execution?.runId ?? null,
          firstProviderRequestSequence: workflowFirstProviderRequest,
          lastProviderRequestSequence: providerRequests.length,
          requestCount: providerRequests.length,
          workflowReachedProvider: true,
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(workflowCaptureDirectory, "workflow-result.json"),
      // A refusal can print no parseable result; record null and fail below.
      JSON.stringify(workflowResult ?? null, null, 2),
    );
    if (workflowResult?.execution?.status !== "succeeded") {
      fail(
        `installed documentation workflow did not succeed (status=${workflowResult?.execution?.status ?? "missing"})`,
      );
    }
    if (deliveryOracleEnabled) {
      linuxDeliveryEvidenceForRetention.cliRunId = workflowResult.execution.runId;
      linuxDeliveryEvidenceForRetention.stage = "cli-delivery";
      await persistLinuxDeliveryEvidence();
    }
    const workflowRecord = JSON.parse(await readFile(workflowResult.execution.recordPath, "utf8"));
    await writeFile(
      join(workflowCaptureDirectory, "workflow-run-record.json"),
      JSON.stringify(workflowRecord, null, 2),
    );
    const requiredWorkflowSteps = [
      "plan-documentation",
      "derive-source-obligations",
      "write-documentation",
      "lint-documentation",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ];
    for (const stepId of requiredWorkflowSteps) {
      if (workflowRecord.steps.find((step) => step.id === stepId)?.status !== "succeeded") {
        fail(`installed workflow run record does not show ${stepId} succeeded`);
      }
    }
    const workflowPatch = await readFile(workflowResult.execution.patchPath, "utf8");
    if (
      !workflowPatch.includes("Validation runs with BubbleWrap") ||
      !workflowPatch.includes("Checks run without network restrictions.")
    ) {
      fail("successful workflow patch does not contain the expected documentation replacement");
    }
    await writeFile(join(workflowCaptureDirectory, "workflow.patch"), workflowPatch);
    if (
      (await readFile(join(workflowRepositoryRoot, "docs", "guide.md"), "utf8")) !==
      originalWorkflowGuide
    ) {
      fail("patch-only workflow mutated the source checkout");
    }
    if (
      (
        await execute("git", ["-C", workflowRepositoryRoot, "status", "--porcelain"])
      ).stdout.trim() !== ""
    ) {
      fail("workflow delivery mutated the source checkout");
    }
    if (deliveryOracleEnabled) {
      // The two checks above passed: the CLI run left the checkout untouched.
      linuxDeliveryEvidenceForRetention.cliSourceCheckoutUnchanged = true;
      // A live `run --json` names the opened draft MR in nextSteps; the
      // RunResultV1 publication field belongs to saved-run replay (`runs show`).
      const [mergeRequestUrl, nextReason] = workflowResult?.nextSteps ?? [];
      if (nextReason !== "Draft MR is up." || typeof mergeRequestUrl !== "string") {
        fail(
          `installed workflow delivery did not publish a draft MR (nextSteps=${JSON.stringify(workflowResult?.nextSteps ?? null)})`,
        );
      }
      const glabState = JSON.parse(await readFile(fakeGitLabStatePath, "utf8"));
      if (
        glabState.created.length !== 1 ||
        glabState.calls.filter((call) => call.method === "POST").length !== 1 ||
        glabState.created[0].web_url !== mergeRequestUrl
      ) {
        fail("installed workflow delivery did not create exactly one fake-forge MR");
      }
      const shippedIndexPath = join(
        installedPackageRoot,
        "dist",
        "delivery",
        "run-delivery-index.js",
      );
      const { lookupSavedRunDelivery } = await import(pathToFileURL(shippedIndexPath).href);
      const stateDirectory = join(configurationRoot, ".docsfab", "runs");
      const lookup = await lookupSavedRunDelivery({
        environment,
        stateDirectory,
        runId: workflowResult.execution.runId,
      });
      const validation = lookup.status === "found" ? lookup.receipt.evidence.validation : undefined;
      if (
        lookup.status !== "found" ||
        lookup.receipt.state !== "opened" ||
        validation?.backendIdentity !== "linux-bubblewrap" ||
        validation.profileId !== "docsfab-documentation-validation" ||
        validation.profileVersion !== "2" ||
        validation.validatorIdentity !== "docsfab-documentation-validator" ||
        !validation.results.some(
          (result) => result.id === "isolation-boundary" && result.status === "passed",
        )
      ) {
        fail(
          "installed delivery receipt did not verify the opened MR with built-in Linux BubbleWrap validation evidence",
        );
      }
      linuxDeliveryEvidenceForRetention.cliReceiptState = lookup.receipt.state;
      linuxDeliveryEvidenceForRetention.cliBackendIdentity = validation.backendIdentity;
      linuxDeliveryEvidenceForRetention.isolationBoundary = "passed";
      linuxDeliveryEvidenceForRetention.stage = "cli-receipt-verified";
      await persistLinuxDeliveryEvidence();
      await writeFile(
        join(workflowCaptureDirectory, "delivery-lookup.json"),
        JSON.stringify(lookup, null, 2),
      );
      const openedMr = glabState.created[0];
      const replay = await execute(
        executable,
        [
          "publish",
          workflowResult.execution.runId,
          "--repo",
          workflowRepositoryRoot,
          "--draft-mr",
          "--execute",
          "--confirm-plan-sha256",
          lookup.receipt.planSha256,
          "--json",
        ],
        {
          cwd: workflowRepositoryRoot,
          env: { ...environment, PATH: `${binRoot}:${environment.PATH ?? ""}` },
          timeout: 120_000,
        },
      );
      JSON.parse(replay.stdout);
      const replayedGlabState = JSON.parse(await readFile(fakeGitLabStatePath, "utf8"));
      if (
        replayedGlabState.created.length !== 1 ||
        replayedGlabState.calls.filter((call) => call.method === "POST").length !== 1 ||
        replayedGlabState.created[0].iid !== openedMr.iid
      ) {
        fail(
          "installed CLI replay created a duplicate draft MR instead of reusing the opened delivery",
        );
      }
      const livePublication = await runInteractiveSession({
        executable,
        repositoryRoot: workflowRepositoryRoot,
        environment: { ...environment, PATH: `${binRoot}:${environment.PATH ?? ""}` },
        expectScriptPath,
        allowWrite: true,
        turns: [
          {
            prompt: liveWorkflowPublicationPrompt,
            expected: "DocsFab: The fixture draft MR is open for the saved documentation run.",
            approval: "pub:y,pub:y",
          },
        ],
      });
      if (
        !livePublication.output.includes("Create a draft MR for run") ||
        !livePublication.output.includes("[y/N]") ||
        !liveWorkflowRunId
      ) {
        fail("installed live-agent did not confirm publication of its successful saved run");
      }
      await writeFile(
        join(workflowCaptureDirectory, "live-workflow-run-id.txt"),
        `${liveWorkflowRunId}\n`,
      );
      const completedGlabState = JSON.parse(await readFile(fakeGitLabStatePath, "utf8"));
      if (
        completedGlabState.created.length !== 2 ||
        completedGlabState.calls.filter((call) => call.method === "POST").length !== 2 ||
        completedGlabState.created.some((mr) => mr.state !== "opened" || mr.draft !== true)
      ) {
        fail(
          "CLI and live-agent did not produce exactly one opened draft each for distinct saved runs",
        );
      }
      const liveLookup = await lookupSavedRunDelivery({
        environment,
        stateDirectory,
        runId: liveWorkflowRunId,
      });
      const liveValidation =
        liveLookup.status === "found" ? liveLookup.receipt.evidence.validation : undefined;
      if (
        liveLookup.status !== "found" ||
        liveLookup.receipt.state !== "opened" ||
        liveValidation?.backendIdentity !== "linux-bubblewrap" ||
        liveValidation.profileId !== "docsfab-documentation-validation" ||
        liveValidation.profileVersion !== "2" ||
        liveValidation.validatorIdentity !== "docsfab-documentation-validator" ||
        !liveValidation.results.some(
          (result) => result.id === "isolation-boundary" && result.status === "passed",
        )
      ) {
        fail(
          "live-agent saved-run delivery receipt did not verify the opened built-in Linux BubbleWrap validation",
        );
      }
      linuxDeliveryEvidenceForRetention.liveAgentRunId = liveWorkflowRunId;
      linuxDeliveryEvidenceForRetention.liveAgentReceiptState = liveLookup.receipt.state;
      linuxDeliveryEvidenceForRetention.liveAgentBackendIdentity = liveValidation.backendIdentity;
      linuxDeliveryEvidenceForRetention.stage = "live-agent-receipt-verified";
      await persistLinuxDeliveryEvidence();
      await writeFile(
        join(workflowCaptureDirectory, "live-delivery-lookup.json"),
        JSON.stringify(liveLookup, null, 2),
      );
      // The CLI run left the checkout untouched (checked above). A write-enabled
      // live-agent workflow applies its saved patch to the checkout by design,
      // and publishing commits and pushes from a delivery worktree, so the
      // checkout keeps that one applied edit on the same HEAD.
      const liveCheckoutHead = (
        await execute("git", ["-C", workflowRepositoryRoot, "rev-parse", "HEAD"])
      ).stdout.trim();
      const liveCheckoutStatus = (
        await execute("git", ["-C", workflowRepositoryRoot, "status", "--porcelain"])
      ).stdout.trim();
      if (
        liveCheckoutHead !== seededWorkflowRevision ||
        liveCheckoutStatus !== "M docs/guide.md" ||
        !(await readFile(join(workflowRepositoryRoot, "docs", "guide.md"), "utf8")).includes(
          "Validation runs with BubbleWrap",
        )
      ) {
        fail("live-agent delivery changed the source checkout beyond its applied workflow patch");
      }
      linuxDeliveryEvidenceForRetention.liveAgentSourceCheckoutChangedOnlyByAppliedPatch = true;
      linuxDeliveryEvidenceForRetention.exactlyOneDraftPerRun =
        completedGlabState.created.length === 2 &&
        completedGlabState.calls.filter((call) => call.method === "POST").length === 2;
      linuxDeliveryEvidenceForRetention.replayReusedExistingDraft =
        openedMr.iid === completedGlabState.created[0].iid &&
        completedGlabState.calls.filter((call) => call.method === "POST").length === 2;
      const linuxDeliveryEvidence = {
        candidateIntegrity: candidate.integrity,
        sourceRevision: candidate.sourceRevision,
        cliRunId: workflowResult.execution.runId,
        liveAgentRunId: liveWorkflowRunId,
        cliReceiptState: lookup.receipt.state,
        liveAgentReceiptState: liveLookup.receipt.state,
        backendIdentity: validation.backendIdentity,
        liveAgentBackendIdentity: liveValidation.backendIdentity,
        profileId: validation.profileId,
        profileVersion: validation.profileVersion,
        validatorIdentity: validation.validatorIdentity,
        isolationBoundary: "passed",
        liveAgentIsolationBoundary: "passed",
        cliSourceCheckoutUnchanged: true,
        liveAgentSourceCheckoutChangedOnlyByAppliedPatch: true,
        cliReplayReusedOpenedMr: true,
        cliDraftMrIid: openedMr.iid,
        liveAgentDraftMrIid: completedGlabState.created[1].iid,
        totalDraftMrCreatesForTwoRuns: completedGlabState.calls.filter(
          (call) => call.method === "POST",
        ).length,
      };
      Object.assign(linuxDeliveryEvidenceForRetention, {
        status: "passed",
        qualification: "installed-linux-bubblewrap-fake-forge-regression",
        cliRunId: workflowResult.execution.runId,
        liveAgentRunId: liveWorkflowRunId,
        cliReceiptState: lookup.receipt.state,
        liveAgentReceiptState: liveLookup.receipt.state,
        cliBackendIdentity: validation.backendIdentity,
        liveAgentBackendIdentity: liveValidation.backendIdentity,
        isolationBoundary: "passed",
        exactlyOneDraftPerRun: linuxDeliveryEvidenceForRetention.exactlyOneDraftPerRun,
        replayReusedExistingDraft: true,
        draftCreateCount: completedGlabState.calls.filter((call) => call.method === "POST").length,
        qualificationLimits: [
          "fake-forge-only",
          "real-gitlab-authentication-and-publication-not-tested",
          "backend-source-mutants-not-yet-qualified",
        ],
      });
      await writeFile(
        join(workflowCaptureDirectory, "linux-delivery-summary.json"),
        JSON.stringify(linuxDeliveryEvidence, null, 2),
      );
      await persistLinuxDeliveryEvidence();
      console.log(`LINUX_DELIVERY_EVIDENCE ${JSON.stringify(linuxDeliveryEvidence)}`);
    }
    const sessions = await readdir(join(configurationRoot, ".docsfab", "live-agent", "sessions"));
    if (
      sessions.filter((entry) => entry.endsWith(".jsonl")).length !==
      (deliveryOracleEnabled ? 2 : 1)
    ) {
      fail("unexpected number of persisted Pi session files");
    }
  } finally {
    provider.closeAllConnections();
    await new Promise((resolveClose, rejectClose) => {
      provider.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }

  console.log(
    "PASS installed live-agent E2E: skills, resume, direct edits, approved commit/push, fixture forge CLI, declined command, and approval-free saved-run recovery",
  );
  console.log(
    `Candidate ${candidate.origin} integrity ${candidate.integrity}; source revision ${candidate.sourceRevision}.`,
  );
} finally {
  await persistLinuxDeliveryEvidence().catch(() => {});
  if (workflowCaptureDirectoryForEvidence && fakeGitLabStatePathForEvidence) {
    try {
      await mkdir(workflowCaptureDirectoryForEvidence, { recursive: true, mode: 0o700 });
      await writeFile(
        join(workflowCaptureDirectoryForEvidence, "fake-glab-transcript.json"),
        await readFile(fakeGitLabStatePathForEvidence),
      );
    } catch {
      // The protocol fixture may not have started before an earlier failure.
    }
  }
  if (workflowCaptureDirectoryForEvidence) {
    try {
      const fixtureRepository = join(temporaryRoot, "repository");
      const repositoryState = await execute("git", [
        "-C",
        fixtureRepository,
        "status",
        "--short",
        "--branch",
      ]);
      const remoteRefs = await execute("git", [
        "--git-dir",
        join(fixtureRepository, ".git", "fixture-remote.git"),
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ]);
      await writeFile(
        join(workflowCaptureDirectoryForEvidence, "legacy-repository-state.txt"),
        `status:\n${repositoryState.stdout}\nremote refs:\n${remoteRefs.stdout}`,
      );
    } catch {
      // The legacy fixture may not have been initialized before an earlier failure.
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function createLocalCertificate(directory) {
  const configPath = join(directory, "openssl.cnf");
  const certificatePath = join(directory, "certificate.pem");
  const keyPath = join(directory, "private-key.pem");
  await writeFile(
    configPath,
    `[req]
distinguished_name = subject
x509_extensions = extensions
prompt = no

[subject]
CN = localhost

[extensions]
subjectAltName = @alternatives
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign

[alternatives]
DNS.1 = localhost
IP.1 = 127.0.0.1
`,
    "utf8",
  );
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-config",
    configPath,
  ]);
  await chmod(keyPath, 0o600);
  return { certificatePath, keyPath };
}

async function writeModelConfiguration(configurationRoot, baseUrl) {
  const profile = [
    "MODEL_PROVIDER=test-provider",
    `MODEL_BASE_URL=${baseUrl}`,
    `MODEL_ID=${modelId}`,
    "MODEL_API_FORMAT=chat_completions",
    `MODEL_API_KEY=${credential}`,
    "MODEL_CONTEXT_WINDOW=128000",
    "MODEL_MAX_INPUT_TOKENS=128000",
    "MODEL_MAX_OUTPUT_TOKENS=16384",
    "MODEL_API_MIN_OUTPUT_TOKENS=16",
    "MODEL_CONTEXT_RESERVE_TOKENS=4096",
    "MODEL_REASONING=false",
    "MODEL_INPUT_TYPES=text",
    "MODEL_SUPPORTS_DEVELOPER_ROLE=false",
    "MODEL_SUPPORTS_REASONING_EFFORT=false",
    "MODEL_COMPATIBLE_API_FORMATS=chat_completions",
    "MODEL_INPUT_COST_PER_MILLION=unknown",
    "MODEL_OUTPUT_COST_PER_MILLION=unknown",
    "MODEL_CACHE_READ_COST_PER_MILLION=unknown",
    "MODEL_CACHE_WRITE_COST_PER_MILLION=unknown",
    "MODEL_PROFILE_APPROVED_SOURCE=https://metadata.example.test/models/example-model",
    "MODEL_PROFILE_EFFECTIVE_DATE=2020-01-01",
    "MODEL_PROFILE_REVIEW_AFTER=2099-12-31",
    "",
  ].join("\n");
  await writeFile(join(configurationRoot, ".env"), profile, { encoding: "utf8", mode: 0o600 });
}

async function writeDeliveryProtocolFixture({ binRoot, bareRepository, statePath }) {
  const glabProgramPath = join(binRoot, "glab-fixture.mjs");
  const sshScript = `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nconst host = "git@gitlab.example.test";\nconst allowedOptions = new Set(["-o\\0SendEnv=GIT_PROTOCOL", "-p\\0" + "22"]);\nlet index = 0;\nwhile (index < args.length && args[index] !== host) {\n  const flag = args[index++];\n  const value = args[index++];\n  if (!allowedOptions.has(flag + "\\0" + value)) { console.error("fixture SSH rejected unexpected option"); process.exit(91); }\n}\nif (args[index] !== host || index + 2 !== args.length) { console.error("fixture SSH rejected unexpected host/shape"); process.exit(92); }\nconst command = args[index + 1];\nif (command !== "git-upload-pack 'group/project.git'" && command !== "git-receive-pack 'group/project.git'") { console.error("fixture SSH rejected unexpected repository/service"); process.exit(93); }\nconst service = command.startsWith("git-upload-pack ") ? "git-upload-pack" : "git-receive-pack";\nconst child = spawnSync(service, [${JSON.stringify(bareRepository)}], { stdio: "inherit", env: process.env });\nif (child.error) { console.error("fixture Git service failed"); process.exit(94); }\nprocess.exit(child.status ?? 95);\n`;
  const glabScript = `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const host = "gitlab.example.test";
const project = "group/project";
const projectId = 99;
const bare = ${JSON.stringify(bareRepository)};
const statePath = ${JSON.stringify(statePath)};
const state = async () => { try { return JSON.parse(await readFile(statePath, "utf8")); } catch { return { calls: [], created: [] }; } };
const save = async (value) => writeFile(statePath, JSON.stringify(value, null, 2), { mode: 0o600 });
const output = (value) => { process.stdout.write(JSON.stringify(value) + "\\n"); process.exit(0); };
const reject = (message = "fixture glab rejected unexpected protocol") => { console.error(message); process.exit(96); };
const git = (args) => { const result = spawnSync("git", ["--git-dir", bare, ...args], { encoding: "utf8" }); if (result.status !== 0) reject(); return result.stdout.trim(); };
if (args.join(" ") === "mr create --draft --source-branch docs/current-work --target-branch main --title Update --description Documentation --yes") {
  process.stdout.write("https://gitlab.example.test/team/repo/-/merge_requests/1\\n"); process.exit(0);
}
const callState = await state();
callState.calls.push({ method: args.includes("POST") ? "POST" : args[0], args });
await save(callState);
const key = args.join(" ");
if (key === "version") { process.stdout.write("glab version 1.0.0 (fixture)\\n"); process.exit(0); }
if (key === "auth status --hostname " + host) process.exit(0);
if (key === "api --hostname " + host + " user") output({ username: "fixture-user" });
if (args[0] === "api" && args[1] === "--hostname" && args[2] === host && args[3] === "graphql") {
  const fullPath = args.find((value) => value.startsWith("fullPath="))?.slice("fullPath=".length);
  if (fullPath !== project) reject();
  output({ data: { project: { id: "gid://gitlab/Project/" + projectId, fullPath: project } } });
}
if (key === "api --hostname " + host + " projects/" + projectId || key === "api --hostname " + host + " projects/" + encodeURIComponent(project)) output({ id: projectId, path_with_namespace: project, default_branch: "main", permissions: { project_access: { access_level: 30 }, group_access: null } });
if (key === "api --hostname " + host + " projects/" + projectId + "/repository/branches/main") output({ name: "main", protected: true, commit: { id: git(["rev-parse", "refs/heads/main"]) } });
if (key === "api --hostname " + host + " projects/" + projectId + "/protected_branches?per_page=100&page=1" || key === "api --hostname " + host + " projects/" + projectId + "/protected_branches?per_page=100") output([]);
if (args[0] === "api" && args[1] === "--hostname" && args[2] === host && args[3]?.startsWith("projects/" + projectId + "/merge_requests?")) {
  const sourceBranch = new URLSearchParams(args[3].split("?")[1]).get("source_branch");
  const current = await state();
  output(current.created.filter((mr) => mr.source_branch === sourceBranch));
}
if (args.slice(0, 6).join(" ") === "api --hostname " + host + " --method POST projects/" + projectId + "/merge_requests") {
  const fields = {};
  for (let i = 6; i < args.length; i += 2) {
    if (args[i] !== "--field" || !args[i + 1]) reject();
    const separator = args[i + 1].indexOf("=");
    if (separator < 1 || fields[args[i + 1].slice(0, separator)] !== undefined) reject();
    fields[args[i + 1].slice(0, separator)] = args[i + 1].slice(separator + 1);
  }
  if (Object.keys(fields).sort().join(",") !== "description,remove_source_branch,source_branch,squash,target_branch,title" || fields.target_branch !== "main" || fields.remove_source_branch !== "false" || fields.squash !== "false" || !fields.title?.startsWith("Draft: [DocsFab Run] ") || !fields.description?.includes("docsfab-publication-provenance:v1")) reject();
  const head = git(["rev-parse", "refs/heads/" + fields.source_branch]);
  const current = await state();
  if (current.created.some((mr) => mr.source_branch === fields.source_branch)) reject("fixture refuses a duplicate MR creation POST");
  const mr = { iid: current.created.length + 1, state: "opened", draft: true, title: fields.title, description: fields.description, source_branch: fields.source_branch, target_branch: fields.target_branch, sha: head, web_url: "https://" + host + "/" + project + "/-/merge_requests/" + (current.created.length + 1), source_project_id: projectId, target_project_id: projectId };
  current.created.push(mr);
  await save(current);
  output(mr);
}
reject();
`;
  await Promise.all([
    writeFile(join(binRoot, "ssh"), sshScript, { encoding: "utf8", mode: 0o700 }),
    writeFile(glabProgramPath, glabScript, { encoding: "utf8", mode: 0o700 }),
    writeFile(join(binRoot, "glab"), `#!/bin/sh\nexec node "${glabProgramPath}" "$@"\n`, {
      encoding: "utf8",
      mode: 0o700,
    }),
  ]);
}

async function writeDarwinExpectScript(path) {
  await writeFile(
    path,
    String.raw`set timeout 30
log_user 1

proc expect_exact {value} {
  expect {
    -exact $value { return }
    timeout { puts stderr "timed out waiting for: $value"; exit 124 }
    eof { puts stderr "live-agent exited while waiting for: $value"; exit 125 }
  }
}

set command [lindex $argv 0]
set repository [lindex $argv 1]
set turn_count [lindex $argv 2]
set write_mode [lindex $argv 3]
if {$write_mode eq "yes"} {
  spawn -noecho $command live-agent --repo $repository
} else {
  spawn -noecho $command live-agent --repo $repository --read-only
}

for {set index 0} {$index < $turn_count} {incr index} {
  set prompt [lindex $argv [expr {4 + ($index * 3)}]]
  set expected [lindex $argv [expr {5 + ($index * 3)}]]
  set approval [lindex $argv [expr {6 + ($index * 3)}]]
  expect_exact "You: "
  send -- "$prompt\r"
  if {$approval ne ""} {
    foreach answer [split $approval ","] {
      if {[string match "pub:*" $answer]} {
        set answer [string range $answer 4 end]
        expect_exact {[y/N] }
      } else {
        expect_exact {(default: cancel): }
      }
      send -- "$answer\r"
    }
  }
  expect_exact $expected
}

expect_exact "You: "
send -- "/exit\r"
expect eof
set wait_result [wait]
exit [lindex $wait_result 3]
`,
    { encoding: "utf8", mode: 0o700 },
  );
}

/**
 * The RunResultV1 object from `run --json` stdout. With draft delivery, the
 * publication envelope and the `Draft merge request:` line come first, so this
 * reads the last top-level JSON document: the last line that opens with `{`
 * from which the rest of stdout parses as a `docsfab-run-result`.
 */
function runResultFromStdout(stdout) {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    let value;
    try {
      value = JSON.parse(lines.slice(index).join("\n"));
    } catch {
      continue;
    }
    if (value?.kind === "docsfab-run-result") return value;
  }
  return JSON.parse(stdout);
}

function isolatedEnvironment({ configurationRoot, certificatePath, homeRoot }) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:MODEL|JUDGE|DOCSFAB|DOCSFAB|INFERENCE_HUB)_/u.test(name) &&
        name !== "PI_OFFLINE" &&
        name !== "PI_CODING_AGENT_DIR" &&
        name !== "NODE_EXTRA_CA_CERTS",
    ),
  );
  return {
    ...environment,
    HOME: homeRoot,
    DOCSFAB_CONFIG_ROOT: configurationRoot,
    NODE_EXTRA_CA_CERTS: certificatePath,
    NO_COLOR: "1",
    PI_CODING_AGENT_DIR: join(homeRoot, ".pi"),
    TERM: "xterm-256color",
  };
}

async function readInstalledTaskInputs({ repositoryPath, environment }) {
  const loader = resolve(projectRoot, "node_modules/tsx/dist/loader.mjs");
  const taskRunnerUrl = pathToFileURL(resolve(projectRoot, "src/live-agent/task-runner.ts")).href;
  const configLoaderUrl = pathToFileURL(resolve(projectRoot, "src/config/runtime-loader.ts")).href;
  const source = [
    'import { execFileSync } from "node:child_process";',
    `import { repositoryBaselineContentSha256, liveAgentTaskEffectiveConfiguration } from ${JSON.stringify(taskRunnerUrl)};`,
    `import { loadConfig } from ${JSON.stringify(configLoaderUrl)};`,
    `const repositoryPath = ${JSON.stringify(repositoryPath)};`,
    "const config = loadConfig(process.env);",
    'console.log(JSON.stringify({ repositoryRevision: execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), contentSha256: await repositoryBaselineContentSha256(repositoryPath), effectiveConfig: liveAgentTaskEffectiveConfiguration(config, process.env) }));',
  ].join("\n");
  const result = await execute(
    process.execPath,
    ["--import", loader, "--input-type=module", "-e", source],
    { cwd: projectRoot, env: environment },
  );
  return JSON.parse(result.stdout);
}

async function runInteractiveSession({
  executable,
  repositoryRoot,
  environment,
  expectScriptPath,
  turns,
  allowWrite = false,
}) {
  if (process.platform === "darwin") {
    return runDarwinInteractiveSession({
      executable,
      repositoryRoot,
      environment,
      expectScriptPath,
      turns,
      allowWrite,
    });
  }

  const command = [executable, "live-agent", "--repo", repositoryRoot];
  if (!allowWrite) command.push("--read-only");
  const child = spawn("script", ["-qefc", command.map(shellQuote).join(" "), "/dev/null"], {
    cwd: repositoryRoot,
    env: environment,
    stdio: "pipe",
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));

  for (let index = 0; index < turns.length; index += 1) {
    await waitForOutput(
      () => promptCount(output) >= index + 1,
      child,
      () => output,
    );
    child.stdin.write(`${turns[index].prompt}\n`);
    if (turns[index].approval) {
      const approvals = turns[index].approval.split(",");
      for (const rawAnswer of approvals) {
        const publicationConfirmation = rawAnswer.startsWith("pub:");
        const answer = publicationConfirmation ? rawAnswer.slice(4) : rawAnswer;
        const marker = publicationConfirmation ? /\[y\/N\] /gu : /\(default: cancel\): /gu;
        const previous = output.match(marker)?.length ?? 0;
        await waitForOutput(
          () => (output.match(marker)?.length ?? 0) > previous,
          child,
          () => output,
          { allowProgress: true },
        );
        child.stdin.write(`${answer}\n`);
      }
    }
    await waitForOutput(
      () => normalizeTerminalOutput(output).includes(turns[index].expected),
      child,
      () => output,
      { allowProgress: true },
    );
  }
  await waitForOutput(
    () => promptCount(output) >= turns.length + 1,
    child,
    () => output,
  );
  child.stdin.write("/exit\n");
  child.stdin.end();
  const code = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("interactive process did not exit")), 30_000),
    ),
  ]);
  if (code !== 0) fail(`interactive process exited ${code}: ${normalizeTerminalOutput(output)}`);

  const normalized = normalizeTerminalOutput(output);
  const match = /^Session\s+([^\n]+)$/mu.exec(normalized);
  if (!match) fail(`readiness output did not report a session: ${normalized}`);
  return { output: normalized, sessionId: match[1].trim() };
}

async function runDarwinInteractiveSession({
  executable,
  repositoryRoot,
  environment,
  expectScriptPath,
  turns,
  allowWrite,
}) {
  const child = spawn(
    "expect",
    [
      "-f",
      expectScriptPath,
      executable,
      repositoryRoot,
      String(turns.length),
      allowWrite ? "yes" : "no",
      ...turns.flatMap((turn) => [turn.prompt, turn.expected, turn.approval ?? ""]),
    ],
    { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const code = await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((_, reject) =>
      setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("interactive process did not exit"));
      }, 60_000),
    ),
  ]);
  if (code !== 0) fail(`interactive process exited ${code}: ${normalizeTerminalOutput(output)}`);

  const normalized = normalizeTerminalOutput(output);
  for (const turn of turns) {
    if (!normalized.includes(turn.expected)) {
      fail(`interactive process omitted ${JSON.stringify(turn.expected)}: ${normalized}`);
    }
  }
  const match = /^Session\s+([^\n]+)$/mu.exec(normalized);
  if (!match) fail(`readiness output did not report a session: ${normalized}`);
  return { output: normalized, sessionId: match[1].trim() };
}

function assertStartup(output) {
  for (const expected of ["LIVE DOCUMENTATION AGENT", "● READY  DocsFab live agent"]) {
    if (!output.includes(expected)) fail(`startup output omitted ${JSON.stringify(expected)}`);
  }
  for (const [label, pattern] of [
    ["available skills", /Skills\s+\d+ available/u],
    ["available workflows", /Workflows\s+\d+ available/u],
    ["terminal mode", /Mode\s+read-only · terminal/u],
  ]) {
    if (!pattern.test(output)) fail(`startup output omitted ${label}`);
  }
}

function promptCount(output) {
  return normalizeTerminalOutput(output).match(/^You:/gmu)?.length ?? 0;
}

function normalizeTerminalOutput(output) {
  return output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replaceAll("\r", "")
    .trim();
}

async function waitForOutput(predicate, child, getOutput, { allowProgress = false } = {}) {
  let deadline = Date.now() + 30_000;
  let previousProgress = terminalOutputWithoutElapsedProgress(getOutput());
  while (!predicate()) {
    if (child.exitCode !== null) {
      fail(
        `interactive process exited before expected output: ${normalizeTerminalOutput(getOutput())}`,
      );
    }
    const progress = terminalOutputWithoutElapsedProgress(getOutput());
    if (allowProgress && progress !== previousProgress) {
      // Completed steps and substantive output count; elapsed-only spinner redraws do not.
      deadline = Date.now() + 30_000;
    }
    previousProgress = progress;
    if (Date.now() >= deadline) {
      child.kill("SIGTERM");
      fail(`timed out waiting for terminal output: ${normalizeTerminalOutput(getOutput())}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The scripted evaluator's `evaluation`: each dimension the locked profile requires, judged
 * "not-assessed" with no evidence, as test/support/authoring-quality-fixture.ts does. The host
 * writes the target paths and its other minted fields before validating it.
 */
function scriptedQualityEvaluation(profile, revision, limitations) {
  const dimension = (dimensionId) => ({
    dimension_id: dimensionId,
    applicability: "required",
    assessment: "not-assessed",
    confidence: 0,
    evidence: [],
    measures: [],
    rationale: "No direct evidence is available for this scripted evaluation.",
  });
  const constraint = (dimensionId, optional = false) => ({
    dimension_id: dimensionId,
    applicability: optional ? "not-applicable" : "required",
    assessment: optional ? "not-applicable" : "not-assessed",
    confidence: 0,
    evidence: [],
    measures: [],
    rationale: optional
      ? "The scripted evaluation does not declare global readiness."
      : "No direct evidence is available for this scripted evaluation.",
  });
  return {
    evaluation_id: "live-agent-e2e-evaluation",
    evaluation_version: "v0.1",
    evaluated_at: "2026-09-11T12:00:00Z",
    model_version: "documentation-quality-model-v0.2",
    profile: { id: "docsfab-documentation-quality", version: "v0.1" },
    evaluator: {
      provider_id: "scripted-evaluator",
      provider_type: "agent",
      independent_of_authors: true,
      independence_evidence: "The scripted evaluator is independent of the target author.",
    },
    target: {
      scope_type: "documentation-set",
      documentation_families: ["procedural"],
      documentation_family_evidence: [
        {
          family: "procedural",
          paths: ["docs/"],
          method: "path-convention",
          evidence_locator: "inventory:docs",
          rationale: "The tracked documentation path identifies a procedural family.",
        },
      ],
      repository_revision: revision,
      documentation_revision: revision,
      paths: ["docs/guide.md"],
      product_reference_model: { id: "workflow-fixture", version: "v1" },
      approved_evidence_revision: "workflow-fixture-evidence-v1",
      product_version: "fixture-v1",
      environment: "deterministic-test",
      delivery_surface_locator: "fixture:docs",
      risk_boundary: "General information only.",
      risk_classes: ["general-information"],
      audiences: ["developer"],
      intended_outcomes: ["complete the documented task"],
      intended_outcome_classes: ["task-completion"],
    },
    layers: Object.fromEntries(
      Object.entries(profile.applicability.documentation_set.required_dimensions_by_layer).map(
        ([layerId, dimensions]) => [
          layerId,
          {
            decision: "insufficient-evidence",
            confidence: 0,
            dimensions: dimensions.map(dimension),
            hard_gate_failures: [],
            limitations,
          },
        ],
      ),
    ),
    constraints: {
      accessibility_and_inclusion: constraint("accessibility-and-inclusion"),
      global_and_localization_readiness: constraint("global-and-localization-readiness", true),
      safety_security_privacy: constraint("safety-security-privacy"),
      legal_policy_support: constraint("legal-policy-support"),
      human_agent_representation_parity: constraint("human-agent-representation-parity"),
    },
    outcomes: { human: [], agent: [] },
    hard_gate_failures: [],
    overall_decision: "insufficient-evidence",
    conditions: [],
    confidence: 0,
    findings: [],
    limitations,
  };
}

function textTurn(text) {
  return sse([
    {
      id: "docsfab-live-e2e",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "docsfab-live-e2e",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

function toolTurn(name, parameters) {
  providerToolCallSequence += 1;
  return sse([
    {
      id: "docsfab-live-e2e-tool",
      object: "chat.completion.chunk",
      created: 2,
      model: modelId,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-live-agent-e2e-${providerToolCallSequence}`,
                type: "function",
                function: { name, arguments: JSON.stringify(parameters) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "docsfab-live-e2e-tool",
      object: "chat.completion.chunk",
      created: 2,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

function sse(chunks) {
  return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(
    "",
  );
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}
