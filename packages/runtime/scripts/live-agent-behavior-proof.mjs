// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Opt-in real-model proof. Unlike session-e2e, this never scripts provider replies. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parseNpmPackJson } from "./lib/packed-cli.mjs";
import {
  assessFocusedFinding,
  assessPullRequestReview,
  isFocusedQualityGuidance,
  proofFixture,
  proofConversationSeconds,
  summarizeProofRun,
} from "../test/fixtures/live-agent-behavior/proof-assertions.mjs";

const execute = promisify(execFile);
async function boundedPackageCommand(args, cwd) {
  const pending = execute("npm", args, {
    cwd,
    env: process.env,
    detached: true,
    timeout: 180_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  const stopGroup = () => {
    try {
      process.kill(-pending.child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  };
  const deadline = setTimeout(stopGroup, 180_000);
  try {
    return await pending;
  } finally {
    // The isolated process group contains only this proof's npm lifecycle children.
    clearTimeout(deadline);
    stopGroup();
  }
}
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cases = {
  direct: "In one sentence, what is the difference between a tutorial and a reference page?",
  focused:
    "Check the wording of the Quick Start paragraph in README.md for first-time users. Give me the most important clarity correction, without editing files.",
  progressive:
    "Review just the Quick Start paragraph in README.md for a new user's understanding. Investigate anything questionable before giving your findings; do not change files.",
  "pull-request":
    "can you review this PR https://github.com/example/bluebird/pull/161\n\nThe PR diff is supplied in review.diff, and this checkout is its head. Review the supplied evidence without accessing the network or changing files.",
  workflow:
    "Perform a complete documentation review of this repository, including quality and technical correctness, and return the review findings. Do not modify the repository.",
  clarification: "Write the missing guide for my product.",
};
const selected = process.env.DOCSFAB_PROOF_CASES?.split(",") ?? Object.keys(cases);
if (selected.some((name) => !Object.hasOwn(cases, name))) throw new Error("Unknown proof case.");
const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-behavior-proof-")));
const sessionFiles = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let failed = false;
let phase = "terminal-driver";

try {
  await execute("expect", ["-v"], { timeout: 10_000 });
  phase = "packaging";
  console.log("Packing and installing the current runtime for real-model behavior proof.");
  const packRoot = join(root, "pack");
  await mkdir(packRoot);
  const packed = parseNpmPackJson(
    (await boundedPackageCommand(["pack", "--json", "--pack-destination", packRoot], projectRoot))
      .stdout,
  );
  if (
    !Array.isArray(packed) ||
    packed.length !== 1 ||
    !/^docsfab-[a-z0-9.-]+\.tgz$/u.test(packed[0].filename)
  )
    throw new Error("Unexpected packed artifact.");
  const tarball = join(packRoot, packed[0].filename);
  phase = "installation";
  const installRoot = join(root, "install");
  await boundedPackageCommand(["install", "--global", "--prefix", installRoot, tarball], root);
  const executable = join(installRoot, "bin", "docsfab");
  const installedPackageRoot = join(installRoot, "lib", "node_modules", "docsfab");
  const imported = (path) => import(pathToFileURL(join(installedPackageRoot, "dist", path)).href);
  phase = "configuration";
  const { loadConfig } = await imported("config/runtime-loader.js");
  const { resolveDocsFabLiveAgentSessionDirectory } = await imported("config/host-paths.js");
  const { loadLiveAgentCapabilities } = await imported("live-agent/capabilities.js");
  const { repositoryVirtualCwd } = await imported("harness/pi-session.js");
  // Use the native loader. Never read, copy, or print the credential ourselves.
  const config = loadConfig(process.env);
  phase = "installed-assets";
  if (
    config.skillCrateDirectory !== join(installedPackageRoot, "skill-crate") ||
    config.qualityDirectory !== join(installedPackageRoot, "quality") ||
    config.qualityPackDirectory !== join(installedPackageRoot, "quality-pack")
  ) {
    throw new Error("The proof requires assets from its installed package.");
  }
  const capabilities = await loadLiveAgentCapabilities(config);
  const sessionDirectory = resolveDocsFabLiveAgentSessionDirectory(process.env);
  const qualityLock = JSON.parse(
    await readFile(join(config.qualityDirectory, "lock.json"), "utf8"),
  );
  const revision = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: projectRoot })
  ).stdout.trim();
  const sourceDirty = Boolean(
    (await execute("git", ["status", "--porcelain"], { cwd: projectRoot })).stdout.trim(),
  );
  console.log(
    JSON.stringify({
      revision,
      sourceDirty,
      tarballSha256: hash(await readFile(tarball)),
      model: config.model.modelId,
      qualityPack: capabilities.qualityPack,
    }),
  );
  const driver = join(root, "conversation.exp");
  await writeFile(
    driver,
    await readFile(join(projectRoot, "test/fixtures/live-agent-behavior/conversation.exp"), "utf8"),
    { mode: 0o600 },
  );
  for (const name of selected) {
    const caseStartedAt = Date.now();
    const conversationSeconds = proofConversationSeconds(name);
    console.log(`Running ${name} (${conversationSeconds}s conversation limit).`);
    phase = `fixture-${name}`;
    const repository = join(root, name);
    await mkdir(repository);
    const fixture = proofFixture(name);
    await writeFile(join(repository, "README.md"), fixture.readme);
    await writeFile(join(repository, "cli.mjs"), fixture.cli);
    if (fixture.diff) await writeFile(join(repository, "review.diff"), fixture.diff);
    await execute("git", ["init", "-q"], { cwd: repository });
    await execute(
      "git",
      ["add", "README.md", "cli.mjs", ...(fixture.diff ? ["review.diff"] : [])],
      {
        cwd: repository,
      },
    );
    await execute(
      "git",
      [
        "-c",
        "user.name=DocsFab proof",
        "-c",
        "user.email=proof@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Synthetic proof fixture",
      ],
      { cwd: repository },
    );
    let terminalFailure;
    let terminalOutput = "";
    phase = `conversation-${name}`;
    try {
      const result = await execute(
        "expect",
        ["-f", driver, executable, repository, cases[name], String(conversationSeconds)],
        {
          cwd: repository,
          timeout: (conversationSeconds + 90) * 1000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, NO_COLOR: "1", DOCSFAB_STATE_DIR: join(root, "runs", name) },
        },
      );
      terminalOutput = result.stdout;
    } catch (error) {
      terminalFailure =
        error.killed || error.code === 124 ? "timeout" : `terminal-exit-${error.code ?? "unknown"}`;
      terminalOutput = error.stdout ?? "";
    }
    const entries = [];
    phase = `receipt-${name}`;
    const sessionId = /^SESSION ([a-f0-9-]+)$/mu.exec(terminalOutput)?.[1];
    for (const filename of await readdir(sessionDirectory).catch(() => [])) {
      // Never inspect other users' or concurrent conversations.
      if (!sessionId || !filename.endsWith(`_${sessionId}.jsonl`)) continue;
      const path = join(sessionDirectory, filename);
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      const header = JSON.parse(lines[0]);
      if (header.cwd !== repositoryVirtualCwd(repository) || header.id !== sessionId) continue;
      sessionFiles.push(path);
      entries.push(...lines.slice(1).map((line) => JSON.parse(line)));
    }
    const messages = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    const calls = messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.filter((part) => part.type === "toolCall")
        : [],
    );
    const results = messages.filter((message) => message.role === "toolResult");
    const skillUses = results
      .filter((result) => !result.isError && result.details?.kind === "docsfab-live-skill")
      .map((result) => ({
        skill: result.details.skill,
        contentSha256: result.details.contentSha256,
        verified: capabilities.skills.some(
          (skill) =>
            skill.lock.id === result.details.skill &&
            skill.lock.contentSha256 === result.details.contentSha256,
        ),
      }));
    const qualityReads = [];
    const referenceUses = results
      .filter(
        (result) => !result.isError && result.details?.kind === "docsfab-live-skill-reference",
      )
      .map((result) => ({
        skill: result.details.skill,
        path: result.details.reference,
        sha256: result.details.sha256,
        verified: capabilities.skills.some(
          (skill) =>
            skill.lock.id === result.details.skill &&
            skill.lock.files.some(
              (file) =>
                file.path === result.details.reference && file.sha256 === result.details.sha256,
            ),
        ),
      }));
    for (const call of calls.filter((call) => call.name === "read")) {
      const path = call.arguments.path ?? "";
      const prefix = ".docsfab-governed-assets/quality/";
      const relative = path.startsWith(prefix)
        ? path.slice(prefix.length)
        : path.startsWith(`${config.qualityDirectory}/`)
          ? path.slice(config.qualityDirectory.length + 1)
          : undefined;
      const locked = qualityLock.files.find((file) => file.path === relative);
      const result = results.find((item) => item.toolCallId === call.id);
      if (locked && result && !result.isError && isFocusedQualityGuidance(relative))
        qualityReads.push({ path: relative, sha256: locked.sha256 });
    }
    const workflows = results
      .filter((result) => result.details?.kind === "docsfab-live-workflow-result")
      .map((result) => ({
        workflow: result.details.workflow,
        runId: result.details.runId,
        status: result.details.status,
        steps: result.details.steps.map((step) => ({ id: step.id, status: step.status })),
      }));
    const finalText =
      messages
        .filter((message) => message.role === "assistant")
        .at(-1)
        ?.content.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "";
    const distinct = new Set(skillUses.map((skill) => skill.skill));
    const meaningfulFinding =
      /--output/u.test(finalText) && /required|mandatory|missing|must/u.test(finalText);
    const suitableEditorialSkill = skillUses.some((skill) =>
      ["review-documentation", "lint-documentation", "evaluate-document-quality"].includes(
        skill.skill,
      ),
    );
    const targetRead = calls.some(
      (call) =>
        call.name === "read" &&
        /(?:^|\/)README\.md$/u.test(call.arguments.path ?? "") &&
        results.some((result) => result.toolCallId === call.id && !result.isError),
    );
    const editorialIndex = skillUses.findIndex((skill) =>
      ["review-documentation", "test-audience-understanding"].includes(skill.skill),
    );
    const progressiveSequence =
      editorialIndex >= 0 &&
      skillUses.findIndex((skill) => skill.skill === "verify-technical-accuracy") > editorialIndex;
    const sourceRead = calls.some(
      (call) =>
        call.name === "read" &&
        /(?:^|\/)cli\.mjs$/u.test(call.arguments.path ?? "") &&
        results.some((result) => result.toolCallId === call.id && !result.isError),
    );
    const diffRead = calls.some(
      (call) =>
        call.name === "read" &&
        /(?:^|\/)review\.diff$/u.test(call.arguments.path ?? "") &&
        results.some((result) => result.toolCallId === call.id && !result.isError),
    );
    const { clarityCorrection, groundedCommandCorrection } = assessFocusedFinding(
      finalText,
      sourceRead,
      fixture.readme,
    );
    const observedRuns = [];
    const runDirectory = join(root, "runs", name);
    for (const filename of await readdir(runDirectory).catch(() => [])) {
      if (!/^[a-f0-9-]+\.json$/u.test(filename)) continue;
      observedRuns.push(
        summarizeProofRun(JSON.parse(await readFile(join(runDirectory, filename), "utf8"))),
      );
    }
    const unchanged = !(
      await execute("git", ["status", "--porcelain"], { cwd: repository })
    ).stdout.trim();
    const useful =
      name === "direct"
        ? calls.length === 0 && /tutorial/iu.test(finalText) && /reference/iu.test(finalText)
        : name === "clarification"
          ? !calls.some((call) => call.name.startsWith("docsfab_")) &&
            /\?/u.test(finalText) &&
            /product|audience|guide/iu.test(finalText)
          : name === "pull-request"
            ? assessPullRequestReview({
                skillUses,
                workflows,
                targetRead,
                sourceRead,
                diffRead,
                finalText,
              })
            : name === "workflow"
              ? workflows.some(
                  (run) =>
                    run.workflow === "review-documentation" &&
                    run.status === "succeeded" &&
                    run.steps.length > 0,
                ) && meaningfulFinding
              : name === "progressive"
                ? distinct.size >= 2 &&
                  progressiveSequence &&
                  sourceRead &&
                  meaningfulFinding &&
                  workflows.length === 0
                : distinct.size >= 1 &&
                  suitableEditorialSkill &&
                  targetRead &&
                  qualityReads.length > 0 &&
                  workflows.length === 0 &&
                  (clarityCorrection || groundedCommandCorrection);
    const status =
      !terminalFailure &&
      useful &&
      unchanged &&
      skillUses.every((skill) => skill.verified) &&
      referenceUses.every((reference) => reference.verified) &&
      messages.filter((message) => message.role === "assistant").at(-1)?.stopReason === "stop" &&
      !messages.some(
        (message) =>
          message.role === "assistant" && ["error", "aborted"].includes(message.stopReason),
      )
        ? "PASS"
        : "FAIL";
    failed ||= status === "FAIL";
    console.log(
      JSON.stringify({
        case: name,
        status,
        terminalFailure,
        conversationSeconds,
        durationMs: Date.now() - caseStartedAt,
        fixture: { readmeSha256: hash(fixture.readme), sourceSha256: hash(fixture.cli) },
        tools: calls.map((call) => call.name),
        skillUses,
        referenceUses,
        qualityReads,
        workflows,
        observedRuns,
        meaningfulFinding,
        clarityCorrection,
        groundedCommandCorrection,
        suitableEditorialSkill,
        targetRead,
        progressiveSequence,
        sourceRead,
        diffRead,
        unchanged,
        useful,
        providerFailures: messages.filter(
          (message) => message.role === "assistant" && message.stopReason === "error",
        ).length,
        toolErrors: results
          .filter((result) => result.isError)
          .map((result) => ({ tool: result.toolName, category: "tool-rejected" })),
      }),
    );
  }
} catch {
  failed = true;
  // Provider exceptions can contain request payloads. Do not print their bodies.
  console.error(
    JSON.stringify({
      status: "BLOCKED",
      phase,
      next:
        phase === "terminal-driver"
          ? "Install expect before running the proof."
          : phase === "installed-assets"
            ? "Remove custom skill/quality asset-directory overrides before running installed-package proof."
            : phase === "configuration"
              ? "Run docsfab profile inspect."
              : "Inspect the named phase locally; no failed or skipped case counts as passing.",
    }),
  );
} finally {
  await Promise.all(sessionFiles.map((path) => rm(path, { force: true })));
  await rm(root, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
