#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exact packed CLI, real Pi read, then cold public-package review planning. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  installPackedDocsFab,
  parsePackedCandidateArguments,
  preparePackedCandidate,
} from "./lib/packed-cli.mjs";

const execute = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { artifactDirectoryLeaf } = parsePackedCandidateArguments(process.argv.slice(2));
const scratch = await realpath(await mkdtemp(join(tmpdir(), "docsfab-installed-locator-")));
const host = "gitlab.example.test";
const projectPath = "team/docs-project";
const projectId = 4242;
const iid = 813;
const mrUrl = `https://${host}/${projectPath}/-/merge_requests/${iid}`;
const beforeText = "# Before\n";
const afterText = "# Reviewed head\n";
// Independent of the cold planner: the scripted run must retain all three rows.
// Quality report DQ-TRACE-001 projects to finding:1; the technical IDs survive unchanged.
const expectedFixtureFindingIds = [
  "issue:provisional-technical-verification:TECH-001",
  "issue:verify-technical-accuracy:TECH-001",
];
const expectedFixtureFindingCount = 3;
const model = "example/model";
const placeholder = "zQ8vFm23gLp1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(`Installed locator acceptance: ${message}`);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};

function isolatedEnvironment(root, bin) {
  return {
    TMPDIR: tmpdir(),
    LANG: "C.UTF-8",
    HOME: join(root, "home"),
    DOCSFAB_CONFIG_ROOT: join(root, "config"),
    DOCSFAB_STATE_DIR: join(root, "config", ".docsfab", "runs"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    MODEL_PROVIDER: "test-provider",
    MODEL_ID: model,
    MODEL_API_FORMAT: "chat_completions",
    MODEL_API_KEY: placeholder,
    MODEL_CONTEXT_WINDOW: "128000",
    MODEL_MAX_INPUT_TOKENS: "128000",
    MODEL_MAX_OUTPUT_TOKENS: "16384",
    MODEL_API_MIN_OUTPUT_TOKENS: "16",
    MODEL_CONTEXT_RESERVE_TOKENS: "4096",
    MODEL_REASONING: "false",
    MODEL_INPUT_TYPES: "text",
    MODEL_SUPPORTS_DEVELOPER_ROLE: "false",
    MODEL_SUPPORTS_REASONING_EFFORT: "false",
    MODEL_COMPATIBLE_API_FORMATS: "chat_completions",
    MODEL_INPUT_COST_PER_MILLION: "unknown",
    MODEL_OUTPUT_COST_PER_MILLION: "unknown",
    MODEL_CACHE_READ_COST_PER_MILLION: "unknown",
    MODEL_CACHE_WRITE_COST_PER_MILLION: "unknown",
    MODEL_PROFILE_APPROVED_SOURCE: "https://metadata.example.test/models/example-model",
    MODEL_PROFILE_EFFECTIVE_DATE: "2020-01-01",
    MODEL_PROFILE_REVIEW_AFTER: "2099-12-31",
  };
}

function sse(delta, finishReason = "stop") {
  const chunks = [
    {
      id: "installed-locator",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
    },
    {
      id: "installed-locator",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

let toolSequence = 0;
let installedQualityRoot;
let reviewedRevision;
function toolRead() {
  toolSequence += 1;
  return sse(
    {
      tool_calls: [
        {
          index: 0,
          id: `read-${toolSequence}`,
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
        },
      ],
    },
    "tool_calls",
  );
}

function textReply(value) {
  return sse({ content: typeof value === "string" ? value : JSON.stringify(value) });
}

function qualityEvaluation(profile, revision) {
  const limitation = "Direct outcome evidence is unavailable for this scripted local review.";
  const inventoryGap = "The one-line fixture does not establish this dimension.";
  const inventoryDimensions = [
    "defaults-and-overrides",
    "mutable-state",
    "destination-and-trust",
    "error-status-retry",
    "environment-prerequisite",
  ];
  const limitations = [
    limitation,
    inventoryGap,
    ...inventoryDimensions.map((dimensionId) => `${dimensionId}: ${inventoryGap}`),
  ];
  const dimension = (dimensionId) => ({
    dimension_id: dimensionId,
    applicability: "required",
    assessment: "not-assessed",
    confidence: 0,
    evidence: [],
    measures: [],
    rationale: limitation,
  });
  const constraint = (dimensionId, optional = false) => ({
    dimension_id: dimensionId,
    applicability: optional ? "not-applicable" : "required",
    assessment: optional ? "not-applicable" : "not-assessed",
    confidence: 0,
    evidence: [],
    measures: [],
    rationale: limitation,
  });
  return {
    evaluation_id: "installed-locator-evaluation",
    evaluation_version: "v0.1",
    evaluated_at: "2026-09-11T12:00:00Z",
    model_version: "documentation-quality-model-v0.2",
    profile: { id: "docsfab-documentation-quality", version: "v0.1" },
    evaluator: {
      provider_id: "scripted-evaluator",
      provider_type: "agent",
      independent_of_authors: true,
      independence_evidence: "The scripted evaluator is independent of the fixture author.",
    },
    target: {
      scope_type: "documentation-set",
      documentation_families: ["procedural"],
      documentation_family_evidence: [
        {
          family: "procedural",
          paths: ["README.md"],
          method: "path-convention",
          evidence_locator: "inventory:README.md",
          rationale: "The tracked README is the fixture documentation target.",
        },
      ],
      repository_revision: revision,
      documentation_revision: revision,
      paths: ["README.md"],
      product_reference_model: { id: "fixture-product", version: "v1" },
      approved_evidence_revision: "fixture-evidence-v1",
      product_version: "fixture-v1",
      environment: "deterministic-test",
      delivery_surface_locator: "fixture:README.md",
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
    findings: [
      {
        id: "DQ-TRACE-001",
        severity: "major",
        dimension_id: "factual-accuracy",
        description:
          "FACT-1 links TECH-001 to the reviewed opening line. The fixture proves this opening line only.",
        evidence: [
          {
            evidence_class: "grounded-judgment",
            strength: "direct",
            provider_id: "scripted-evaluator",
            locator: "README.md:1",
            description: "The registered confined read returned the exact reviewed head bytes.",
          },
        ],
        owner: "documentation owner",
        acceptance_condition: "Resolve FACT-1 and TECH-001 against README.md:1.",
        status: "open",
      },
    ],
    limitations,
  };
}

function providerReply(payload) {
  assert(payload?.model === model && payload?.stream === true, "unexpected model request identity");
  const prompt = (payload.messages ?? [])
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.map((part) => part.text ?? "")
          : [],
    )
    .join("\n");
  if (prompt.includes("Runtime request-interpretation response contract"))
    return textReply({
      operation: "review",
      targets: [],
      authorityPreference: { preference: "unspecified", quote: null },
    });
  if (prompt.includes('<skill name="evaluate-document-quality"')) {
    const profilePath = /Use the locked profile at quality\/(\S+?\.json)\./u.exec(prompt)?.[1];
    assert(
      profilePath && installedQualityRoot && reviewedRevision,
      "quality profile was not bound",
    );
    const profile = JSON.parse(readFileSync(join(installedQualityRoot, profilePath), "utf8"));
    return textReply(
      `${JSON.stringify({ evaluation: qualityEvaluation(profile, reviewedRevision), qualityScore: null })}\n\n# Documentation quality evaluation report\n\n## Evidence gaps and limitations\n\n- Limitation: Direct outcome evidence is unavailable for this scripted local review.`,
    );
  }
  if (prompt.includes("Runtime source-obligation response contract")) {
    if (!prompt.includes("[source-line 1]")) return toolRead();
    return textReply({
      completeness: "bounded-not-proven",
      dimensions: [
        {
          dimension: "input-representations",
          status: "applicable",
          reason: "The reviewed opening line states the input representation.",
          sourceLocators: [],
          obligations: [
            {
              dimension: "input-representations",
              sourceLocators: ["README.md:1"],
              statement: "The reviewed head names the input representation.",
              evidenceClass: "source-observation",
              uncertainty: "The fixture proves this opening line only.",
            },
          ],
        },
        ...[
          "defaults-and-overrides",
          "mutable-state",
          "destination-and-trust",
          "error-status-retry",
          "environment-prerequisite",
        ].map((dimension) => ({
          dimension,
          status: "unverified",
          reason: "The one-line fixture does not establish this dimension.",
          sourceLocators: [],
          obligations: [],
        })),
      ],
      limitations: ["The one-line fixture does not establish this dimension."],
    });
  }
  if (
    prompt.includes("Runtime provisional technical verification judgment contract") ||
    prompt.includes("Runtime semantic technical-correction proposal V3 contract")
  ) {
    if (!prompt.includes("[source-line 1]")) return toolRead();
    return textReply({
      verdict: "needs-revision",
      coverage: [
        {
          path: "README.md",
          status: "verified",
          evidence: ["README.md:1"],
          reason: "The opening line was checked.",
        },
      ],
      issueJudgments: [
        {
          id: "TECH-001",
          severity: "major",
          category: "technical_accuracy",
          location: "README.md:1",
          obligationIds: ["OBL-INPUT-REPRESENTATIONS-1"],
        },
      ],
      obligationJudgments: [
        {
          obligationId: "OBL-INPUT-REPRESENTATIONS-1",
          disposition: "retained",
          documentationDisposition: "conflicting",
          issueIds: ["TECH-001"],
        },
      ],
    });
  }
  if (prompt.includes("Runtime independent editorial assessment response contract")) {
    const refs = [...prompt.matchAll(/"kind":"[^"]+","[^\n]*?"/gu)];
    const evidenceRefs = refs.length ? [] : [];
    return textReply({
      summary: "The read-only fixture review is complete.",
      editorialAssessmentProposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-assessment-proposal",
        assessment: "not-applicable",
        rationale:
          "The fixture provides no independent editorial assessment beyond the bounded technical review.",
        evidenceRefs,
        limitations: [],
        recommendation: null,
      },
    });
  }
  if (prompt.includes('<skill name="audit-documentation"'))
    return textReply("README.md:1 was inventoried at the pinned revision.");
  if (prompt.includes('<skill name="verify-technical-accuracy"')) return toolRead();
  if (prompt.includes('<skill name="review-documentation"'))
    return textReply(JSON.stringify({ verdict: "pass", issues: [] }));
  if (prompt.includes('<skill name="test-audience-understanding"'))
    return textReply(
      "Insufficient evidence: no authorized audience protocol or representative participant.",
    );
  if (prompt.includes('<skill name="evaluate-document-quality"'))
    return textReply("Insufficient evidence: no audience protocol or scoring oracle.");
  fail(`unexpected scripted Pi request (${sha256(prompt)})`);
}

function listen(server) {
  return new Promise((ok, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      ok();
    });
  });
}

async function command(program, args, options = {}) {
  return execute(program, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
}

async function git(repo, env, ...args) {
  return (await command("git", args, { cwd: repo, env })).stdout.trim();
}

function runResultFromStdout(stdout) {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    try {
      const value = JSON.parse(lines.slice(index).join("\n"));
      if (value?.kind === "docsfab-run-result") return value;
    } catch {
      // The first opening brace may be part of a preceding status document.
    }
  }
  return null;
}

async function writeFakeGlab(bin, base, head) {
  const script = join(bin, "glab");
  await writeFile(
    script,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const endpoint = args.at(-1);
if (args[0] !== "api" || args[1] !== "--hostname" || args[2] !== ${JSON.stringify(host)} || args[3] !== "--method" || args[4] !== "GET") process.exit(91);
const project = { id: ${projectId}, path_with_namespace: ${JSON.stringify(projectPath)} };
const mr = { id: 9100813, iid: ${iid}, project_id: ${projectId}, target_project_id: ${projectId}, source_project_id: ${projectId}, state: "opened", target_branch: "main", source_branch: "topic", sha: ${JSON.stringify(head)}, merge_commit_sha: null, squash_commit_sha: null, changes_count: "1", diff_refs: { base_sha: ${JSON.stringify(base)}, start_sha: ${JSON.stringify(base)}, head_sha: ${JSON.stringify(head)} }, references: { full: ${JSON.stringify(`${projectPath}!${iid}`)} } };
if (endpoint === "projects/${encodeURIComponent(projectPath)}" || endpoint === "projects/${projectId}") process.stdout.write(JSON.stringify(project));
else if (endpoint === "projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}" || endpoint === "projects/${projectId}/merge_requests/${iid}") process.stdout.write(JSON.stringify(mr));
else process.exit(92);
`,
    { mode: 0o700 },
  );
  await chmod(script, 0o700);
}

async function main() {
  const packRoot = join(scratch, "pack");
  const installRoot = join(scratch, "installed");
  const bin = join(scratch, "bin");
  const repo = join(scratch, "checkout");
  await Promise.all(
    [packRoot, installRoot, bin, repo, join(scratch, "home"), join(scratch, "config")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await Promise.all(
    [join(scratch, "home"), join(scratch, "config")].map((path) => chmod(path, 0o700)),
  );
  const env = isolatedEnvironment(scratch, bin);
  const candidate = await preparePackedCandidate({
    projectRoot,
    packDestination: packRoot,
    env,
    artifactDirectoryLeaf,
  });
  assert(
    candidate.record.name === "docsfab" && candidate.integrity === candidate.record.integrity,
    "packed candidate identity mismatch",
  );
  const installed = await installPackedDocsFab({
    tarball: candidate.tarball,
    installRoot,
    cwd: scratch,
    env,
  });
  installedQualityRoot = join(installed.installedPackageRoot, "quality");
  assert(
    (await realpath(installed.installedPackageRoot)).startsWith(await realpath(installRoot)),
    "installed root escaped private prefix",
  );
  assert(
    !(await realpath(installed.executable)).startsWith(projectRoot),
    "installed executable resolves into source checkout",
  );
  const packageJson = JSON.parse(
    await readFile(join(installed.installedPackageRoot, "package.json"), "utf8"),
  );
  assert(
    packageJson.name === "docsfab" && packageJson.version === candidate.record.version,
    "installed package identity mismatch",
  );
  await git(repo, env, "init", "--initial-branch", "main");
  await git(repo, env, "config", "user.name", "DocsFab Acceptance");
  await git(repo, env, "config", "user.email", "acceptance@example.invalid");
  await git(repo, env, "config", "commit.gpgsign", "false");
  await git(repo, env, "remote", "add", "origin", `https://${host}/${projectPath}.git`);
  await writeFile(join(repo, "README.md"), beforeText);
  await writeFile(
    join(repo, ".docsfab.json"),
    JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      documentationRoots: ["README.md"],
    }),
  );
  await git(repo, env, "add", "--all");
  await git(repo, env, "commit", "-m", "Base documentation");
  const base = await git(repo, env, "rev-parse", "HEAD");
  await git(repo, env, "checkout", "-b", "topic");
  await writeFile(join(repo, "README.md"), afterText);
  await git(repo, env, "add", "README.md");
  await git(repo, env, "commit", "-m", "Review head");
  const head = await git(repo, env, "rev-parse", "HEAD");
  reviewedRevision = head;
  const nativeBlob = await git(repo, env, "rev-parse", "HEAD:README.md");
  await writeFakeGlab(bin, base, head);
  let modelCalls = 0;
  let serverFailure;
  const provider = createServer(async (request, response) => {
    try {
      assert(
        request.method === "POST" && request.url === "/v1/chat/completions",
        "unexpected model endpoint",
      );
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      modelCalls += 1;
      const body = providerReply(payload);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(body);
    } catch (error) {
      serverFailure = error;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "scripted provider refusal" } }));
    }
  });
  await listen(provider);
  const address = provider.address();
  assert(address && typeof address !== "string", "loopback provider did not bind");
  env.MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  let run;
  try {
    const output = await command(
      installed.executable,
      [
        "run",
        "review-documentation",
        "--repo",
        repo,
        "--instruction",
        "Review README.md for technical accuracy.",
        "--change",
        mrUrl,
        "--json",
      ],
      { cwd: scratch, env },
    );
    run = runResultFromStdout(output.stdout);
  } catch (error) {
    if (serverFailure) throw serverFailure;
    const reported = runResultFromStdout(error.stdout ?? "");
    fail(
      `installed run failed: ${reported?.failures?.map((entry) => entry.code).join(",") ?? error.code ?? "unclassified"}`,
    );
  } finally {
    await new Promise((ok) => provider.close(ok));
  }
  if (serverFailure) throw serverFailure;
  assert(
    run?.execution?.runId && run?.execution?.status === "succeeded",
    "installed review did not succeed",
  );
  assert(
    (await git(repo, env, "status", "--porcelain")) === "",
    "installed review mutated checkout",
  );
  const runId = run.execution.runId;
  const stateDirectory = env.DOCSFAB_STATE_DIR;
  const record = JSON.parse(await readFile(join(stateDirectory, `${runId}.json`), "utf8"));
  const reference = record.steps?.find(
    (step) => step.id === "verify-technical-accuracy",
  )?.reviewLocatorObservation;
  assert(reference?.objectSha256, "registered Pi read did not retain a locator object");
  const sourceModule = await import(
    pathToFileURL(join(installed.installedPackageRoot, "dist/inputs/change-source/gitlab.js"))
  );
  const selectorModule = await import(
    pathToFileURL(join(installed.installedPackageRoot, "dist/inputs/change-source.js"))
  );
  const targetModule = await import(
    pathToFileURL(join(installed.installedPackageRoot, "dist/review/target-migration.js"))
  );
  const resultModule = await import(
    pathToFileURL(join(installed.installedPackageRoot, "dist/review/run-result.js"))
  );
  const source = (
    await sourceModule.resolveGitLabMergeRequestChangeSource({
      selector: selectorModule.parseChangeSourceSelector(mrUrl),
      sourcePath: repo,
      repositoryPath: repo,
      workspaceRevision: head,
      forge: {
        commands: {
          async run(_program, args) {
            const answer = await command(join(bin, "glab"), args, { cwd: repo, env });
            return { stdout: answer.stdout, stderr: answer.stderr, exitCode: 0 };
          },
        },
        environment: env,
      },
    })
  ).changeSource;
  assert(source.files.length === 1, "source did not bind exactly one changed file");
  assert(
    source.files[0]?.newBlob === nativeBlob,
    "native source blob differs from checked-out head",
  );
  const target = targetModule.createReviewTargetV2(
    {
      scmProvider: "gitlab",
      host,
      projectId,
      mergeRequestIid: iid,
      sourceFork: false,
      sourceBranch: "topic",
      targetBranch: "main",
      baseSha: base,
      headSha: head,
      trigger: "api",
      requestIdentitySha256: sha256("installed-review"),
      workflow: "review-documentation",
      deliveryIntent: "comment-existing-mr",
      logicalRequestId: "installed-review",
      changeSourceSha256: source.changeSourceSha256,
    },
    source,
  );
  const result = resultModule.reviewResultFromRun(record, { target, source });
  const beforeBytes = Buffer.from(beforeText);
  const afterBytes = Buffer.from(afterText);
  assert(
    sha256(afterBytes) === sha256(await readFile(join(repo, "README.md"))),
    "head bytes drifted",
  );
  const delivery = {
    snapshot: {
      changeSourceSha256: source.changeSourceSha256,
      files: [
        {
          oldPath: "README.md",
          newPath: "README.md",
          beforeBytes,
          afterBytes,
          beforeSha256: sha256(beforeBytes),
          afterSha256: sha256(afterBytes),
          state: "complete",
          hunks: [
            {
              lines: [
                { kind: "removed", text: beforeText.trimEnd(), beforeLine: 1, afterLine: null },
                { kind: "added", text: afterText.trimEnd(), beforeLine: null, afterLine: 1 },
              ],
            },
          ],
        },
      ],
    },
    artifact: {
      kind: "retained-review-result",
      id: "installed-review",
      resultSha256: result.resultSha256,
    },
    actor: { host, id: "fixture-actor" },
    capabilities: { scmProvider: "gitlab", host, summary: true, inline: true },
  };
  const modelCallsBeforeCold = modelCalls;
  const runRecordBytes = await readFile(join(stateDirectory, `${runId}.json`));
  const artifactPath = join(
    dirname(stateDirectory),
    "artifacts",
    "objects",
    "sha256",
    `${reference.objectSha256}.json`,
  );
  const originalObjectBytes = await readFile(artifactPath);
  const corruptRoot = join(scratch, "corrupt");
  const corruptStateDirectory = join(corruptRoot, "runs");
  const corruptObjectPath = join(
    dirname(corruptStateDirectory),
    "artifacts",
    "objects",
    "sha256",
    `${reference.objectSha256}.json`,
  );
  await mkdir(corruptStateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(corruptObjectPath), { recursive: true, mode: 0o700 });
  const corruptRunPath = join(corruptStateDirectory, `${runId}.json`);
  await copyFile(join(stateDirectory, `${runId}.json`), corruptRunPath);
  await chmod(corruptRunPath, 0o600);
  await writeFile(corruptObjectPath, "{corrupt", { mode: 0o600 });
  for (const directory of [
    corruptRoot,
    corruptStateDirectory,
    join(corruptRoot, "artifacts"),
    join(corruptRoot, "artifacts", "objects"),
    dirname(corruptObjectPath),
  ]) {
    assert(
      ((await stat(directory)).mode & 0o7777) === 0o700,
      "corrupt fixture directory is not private",
    );
  }
  for (const file of [corruptRunPath, corruptObjectPath]) {
    assert(((await stat(file)).mode & 0o7777) === 0o600, "corrupt fixture file is not private");
  }
  const corruptRunRecordBytes = await readFile(corruptRunPath);
  const corruptObjectBytes = await readFile(corruptObjectPath);
  await rm(repo, { recursive: true, force: true });
  const consumer = join(scratch, "consumer");
  await mkdir(join(consumer, "node_modules"), { recursive: true });
  await symlink(installed.installedPackageRoot, join(consumer, "node_modules", "docsfab"));
  await writeFile(
    join(consumer, "input.json"),
    JSON.stringify({
      stateDirectory,
      corruptStateDirectory,
      installedPackageRoot: installed.installedPackageRoot,
      runId,
      target,
      source,
      delivery,
      expectedFixtureFindingIds,
      expectedFixtureFindingCount,
    }),
  );
  const child = `import { readFile, writeFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { planRetainedReviewDelivery } from 'docsfab/review-delivery';
const input = JSON.parse(await readFile(new URL('./input.json', import.meta.url), 'utf8'));
const resolved = await realpath(createRequire(import.meta.url).resolve('docsfab/review-delivery'));
if (!resolved.startsWith(input.installedPackageRoot + '/')) throw Error('public package resolved into source');
for (const file of input.delivery.snapshot.files) { file.beforeBytes = Uint8Array.from(file.beforeBytes.data); file.afterBytes = Uint8Array.from(file.afterBytes.data); }
const args = { stateDirectory: input.stateDirectory, runId: input.runId, binding: { target: input.target, source: input.source }, delivery: input.delivery };
const plan = await planRetainedReviewDelivery(args);
const observedIds = plan.findings.map((finding) => finding.originalId);
if (observedIds.length !== input.expectedFixtureFindingCount ||
    input.expectedFixtureFindingIds.some((id) => observedIds.filter((observed) => observed === id).length !== 1))
  throw Error('cold plan lost a scripted fixture finding');
const covered = plan.actions.flatMap((action) => action.kind === 'publish-inline' ? [action.findingId] : action.findingIds);
for (const finding of plan.findings) {
  if (finding.disposition.kind === 'unsupported' ? covered.includes(finding.inventoryId) : covered.filter((id) => id === finding.inventoryId).length !== 1)
    throw Error('finding action coverage changed');
}
const findings = plan.findings.map((finding) => ({ id: finding.originalId, disposition: finding.disposition, limitations: finding.limitations }));
const mismatch = { ...input.target, headSha: '0'.repeat(input.target.headSha.length) };
let mismatchRefused = false; try { await planRetainedReviewDelivery({ ...args, binding: { ...args.binding, target: mismatch } }); } catch { mismatchRefused = true; }
if (!mismatchRefused) throw Error('mismatched target was accepted');
const corrupt = await planRetainedReviewDelivery({ ...args, stateDirectory: input.corruptStateDirectory });
const corruptTechnical = corrupt.findings.find((finding) => finding.originalId === 'issue:verify-technical-accuracy:TECH-001');
const corruptRefused = !corrupt.actions.some((action) => action.kind === 'publish-inline') &&
  corrupt.findings.every((finding) => finding.disposition.kind !== 'inline-candidate') &&
  corruptTechnical?.limitations.includes('review-locator:observation-invalid');
if (!corruptRefused) throw Error('corrupt object retained inline authority');
await writeFile(new URL('./result.json', import.meta.url), JSON.stringify({ findings, mismatchRefused, corruptRefused, actions: plan.actions.map((action) => action.kind) }));
`;
  await writeFile(join(consumer, "cold.mjs"), child);
  const cold = await command(process.execPath, [join(consumer, "cold.mjs")], {
    cwd: consumer,
    env: { ...env, MODEL_BASE_URL: "http://127.0.0.1:1/v1" },
  });
  assert(cold.stderr === "", "cold installed consumer wrote an error");
  const planned = JSON.parse(await readFile(join(consumer, "result.json"), "utf8"));
  assert(
    planned.findings.some(
      (finding) =>
        finding.disposition.kind === "inline-candidate" &&
        finding.disposition.anchor?.side === "after" &&
        finding.disposition.anchor?.path === "README.md" &&
        finding.disposition.anchor?.startLine === 1,
    ),
    "no exact head-byte after-side anchor",
  );
  assert(planned.mismatchRefused && planned.corruptRefused, "negative controls did not refuse");
  assert(modelCalls === modelCallsBeforeCold, "cold consumer replayed model requests");
  assert(
    sha256(await readFile(join(stateDirectory, `${runId}.json`))) === sha256(runRecordBytes) &&
      sha256(await readFile(artifactPath)) === sha256(originalObjectBytes),
    "cold consumer mutated retained evidence",
  );
  assert(
    (await readFile(corruptRunPath)).equals(corruptRunRecordBytes) &&
      (await readFile(corruptObjectPath)).equals(corruptObjectBytes),
    "cold consumer mutated corrupt-control evidence",
  );
  const proof = {
    kind: "docsfab-installed-review-locator-proof",
    package: {
      name: packageJson.name,
      version: packageJson.version,
      integrity: candidate.integrity,
    },
    run: {
      id: runId,
      sha256: sha256(await readFile(join(stateDirectory, `${runId}.json`))),
      objectSha256: reference.objectSha256,
    },
    source: {
      changeSourceSha256: source.changeSourceSha256,
      base,
      head,
      nativeBlob,
      headBytesSha256: sha256(afterBytes),
    },
    plan: {
      dispositions: planned.findings.map((finding) => finding.disposition.kind),
      inlineAnchors: planned.findings
        .filter((finding) => finding.disposition.kind === "inline-candidate")
        .map((finding) => finding.disposition.anchor),
      actions: planned.actions,
      mismatchRefused: planned.mismatchRefused,
      corruptRefused: planned.corruptRefused,
    },
    outbound: { modelCalls, modelReplayCalls: modelCalls - modelCallsBeforeCold, forgeWrites: 0 },
  };
  await mkdir(join(projectRoot, "ci-results", "2547"), { recursive: true });
  await writeFile(
    join(projectRoot, "ci-results", "2547", "installed-proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

try {
  await main();
} finally {
  await rm(scratch, { recursive: true, force: true });
}
