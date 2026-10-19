// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { writeLeasedRunRecord } from "./lib/leased-run-record.mjs";
import { installedVersionIdentity } from "./lib/installed-version-identity.mjs";
import { hasInstalledGeneralHelpContract } from "./lib/installed-help-contract.mjs";
import {
  assertPackedLicenseMatches,
  assertPackedNoticeMatches,
  assertPackedCandidateReproducible,
  installPackedDocsFab,
  packDocsFab,
  preparePackedCandidate,
  parsePackedVerificationArguments,
  retainPackedArtifact,
  withExplicitModelSelection,
} from "./lib/packed-cli.mjs";
import { PACKAGE_LICENSE_FILES } from "./lib/package-license.mjs";
import { comparePackedArchives } from "./lib/packed-cli-diagnostics.mjs";

const execute = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const [packageLock, shrinkwrap] = await Promise.all([
  readFile(join(projectRoot, "package-lock.json"), "utf8"),
  readFile(join(projectRoot, "npm-shrinkwrap.json"), "utf8"),
]);
const packagedCliEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(?:MODEL|JUDGE|DOCSFAB|DOCSFAB|INFERENCE_HUB)_/u.test(name),
  ),
);
const { artifactDirectoryLeaf, outputDirectoryLeaf } = parsePackedVerificationArguments(
  process.argv.slice(2),
);
const retainedArtifactName = outputDirectoryLeaf;
const retainedArtifactRoot = outputDirectoryLeaf
  ? resolve(projectRoot, outputDirectoryLeaf)
  : undefined;
const candidateMetadata = artifactDirectoryLeaf
  ? JSON.parse(await readFile(join(projectRoot, artifactDirectoryLeaf, "metadata.json"), "utf8"))
  : undefined;
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "docsfab-packed-cli-")));
const npmEnvironment = {
  ...process.env,
  npm_config_cache: join(temporaryRoot, "npm-cache"),
  ...(candidateMetadata?.version
    ? { DOCSFAB_PACKAGE_FINAL_VERSION: candidateMetadata.version }
    : {}),
};
const staleBuildCanary = "dist/__stale_package_canary__/must-not-ship.js";
const knowledgeProviderFiles = [
  "attributed-snapshot.mjs",
  "backend.mjs",
  "evidence-source.mjs",
  "exports.mjs",
  "first-pass/error.mjs",
  "first-pass/evidence-frame.mjs",
  "first-pass-limits.generated.mjs",
  "first-pass/scan.mjs",
  "first-pass/parse.mjs",
  "first-pass/assess.mjs",
  "first-pass/partial.mjs",
  "first-pass-support.mjs",
  "first-pass.mjs",
  "model.mjs",
  "store.mjs",
];

function fail(message) {
  throw new Error(`Packed CLI verification failed: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertNoCompiledTestFiles(paths) {
  const testFile = paths.find((path) => path.endsWith(".test.js"));
  if (testFile) fail(`compiled test file ${testFile} was packed`);
}

function assertPackageContents(files) {
  const paths = files.map((file) => file.path);
  assertNoCompiledTestFiles(paths);
  const required = [
    "package.json",
    "npm-shrinkwrap.json",
    "README.md",
    ...PACKAGE_LICENSE_FILES,
    "SECURITY.md",
    "docs/get-started/installation-reference.md",
    "dist/launcher.js",
    "dist/cli.js",
    ...knowledgeProviderFiles.map((filename) => `dist/knowledge-provider/src/${filename}`),
    "bin/docsfab.mjs",
    "bin/source-checkout-refresh.mjs",
    "skill-crate/lock.json",
    "governed-assets/lock.json",
    "skill-crate/write-documentation/SKILL.md",
    "skill-crate/assess-documentation-readiness/SKILL.md",
    "quality/lock.json",
    "quality/rubrics/task-guide.yaml",
    "quality-pack/manifest.json",
    "model-compositions/installed-manifest.json",
    "model-compositions/adapter-registry.json",
    "model-compositions/candidate-projections.json",
    "model-compositions/composition-registry.json",
    "model-compositions/workflow-catalog.json",
    "workflows/create-documentation.json",
    "workflows/review-documentation.json",
    "workflows/restructure-documentation.json",
    "workflows/update-documentation.json",
    "workflows/readiness.json",
    "workflows/release-documentation-readiness.json",
    "NOTICE",
  ];
  for (const path of required) {
    if (!paths.includes(path)) fail(`required file ${path} is absent`);
  }
  if (
    paths.some((path) => {
      const segments = path.split("/");
      return segments[0] === "governed-assets" && segments[1] === "model-comparison";
    })
  ) {
    fail("campaign kit skill copies must not ship in the product tarball");
  }

  const allowedRoots = new Set([
    "package.json",
    "npm-shrinkwrap.json",
    "README.md",
    ...PACKAGE_LICENSE_FILES,
    "NOTICE",
    "SECURITY.md",
    "docs",
    "bin",
    "dist",
    "skill-crate",
    "governed-assets",
    "quality",
    "quality-pack",
    "model-compositions",
    "workflows",
  ]);
  for (const path of paths) {
    const root = path.split("/")[0];
    if (!allowedRoots.has(root)) fail(`developer or private artifact ${path} was packed`);
    if (path.endsWith(".d.ts") || path.endsWith(".map")) {
      fail(`developer build artifact ${path} was packed`);
    }
    if (
      root === "docs" &&
      !new Set([
        "docs/README.md",
        "docs/get-started/README.md",
        "docs/get-started/installation-reference.md",
      ]).has(path)
    ) {
      fail(`developer documentation input ${path} was packed`);
    }
    if (path === staleBuildCanary || path.includes("__stale_package_canary__")) {
      fail(`stale compiler output ${path} was packed`);
    }
    if (
      /(^|\/)(?:\.env(?:\.|$)|\.npmrc|\.git|\.docsfab|\.docsfab|node_modules)(?:\/|$)/u.test(path)
    ) {
      fail(`private or generated path ${path} was packed`);
    }
  }

  const excludedRuntimeBuilds = new Set([
    "dist/acceptance-cli.js",
    "dist/acceptance-export-doctor.js",
    "dist/acceptance-judge.js",
    "dist/campaign-judge-cli.js",
    "dist/campaign-judge.js",
    "dist/scorecard-cli.js",
    "dist/scorecard-render.js",
    "dist/scorecard.js",
    "dist/delivery/acceptance-cli.js",
    "dist/delivery/acceptance-chain.js",
    "dist/delivery/acceptance-manifest.js",
    "dist/delivery/acceptance.js",
    "dist/delivery/acceptance-worker.js",
    "dist/delivery/index.js",
    "dist/quality-evaluation/corpus-cli.js",
    "dist/quality-evaluation/documentation-navigation.js",
    "dist/quality-evaluation/maturity-cascade-cli.js",
    "dist/quality-evaluation/maturity-cascade-files.js",
    "dist/quality-evaluation/maturity-cascade.js",
  ]);
  for (const path of paths) {
    if (excludedRuntimeBuilds.has(path)) fail(`developer-only entrypoint ${path} was packed`);
  }
}

function assertResult(result, expected) {
  if (result.stdout !== expected.stdout || result.stderr !== expected.stderr) {
    fail(`unexpected command output: ${JSON.stringify(result)}`);
  }
}

try {
  if (packageLock !== shrinkwrap) {
    fail("npm-shrinkwrap.json does not exactly match package-lock.json");
  }
  const packRoot = join(temporaryRoot, "pack");
  const repeatPackRoot = join(temporaryRoot, "pack-repeat");
  const installRoot = join(temporaryRoot, "install");
  const outsideRoot = join(temporaryRoot, "outside-source");
  const firstPassRepositoryPath = join(temporaryRoot, "first-pass-repository");
  const firstPassStateDirectory = join(temporaryRoot, "first-pass-state", "runs");
  const doctorRepositoryPath = join(temporaryRoot, "doctor-repository");
  const configurationRoot = join(temporaryRoot, "plain-configuration");
  const privateStateRoot = join(temporaryRoot, "private-state");
  const pilotCampaignRoot = join(temporaryRoot, "pilot-campaign");
  const fakeBin = join(temporaryRoot, "fake-bin");
  await Promise.all([
    mkdir(packRoot),
    mkdir(repeatPackRoot),
    mkdir(installRoot),
    mkdir(outsideRoot),
    mkdir(firstPassRepositoryPath),
    mkdir(firstPassStateDirectory, { recursive: true, mode: 0o700 }),
    mkdir(doctorRepositoryPath),
    mkdir(configurationRoot, { mode: 0o700 }),
    mkdir(privateStateRoot, { mode: 0o700 }),
    mkdir(pilotCampaignRoot, { mode: 0o700 }),
    mkdir(fakeBin, { mode: 0o700 }),
  ]);
  await mkdir(join(projectRoot, "dist", "__stale_package_canary__"), { recursive: true });
  await writeFile(
    join(projectRoot, staleBuildCanary),
    'throw new Error("stale compiler output was packaged");\n',
    "utf8",
  );

  const candidate = await preparePackedCandidate({
    projectRoot,
    packDestination: packRoot,
    env: npmEnvironment,
    artifactDirectoryLeaf,
  });
  const { record: candidateRecord, tarball } = candidate;
  if (
    candidateRecord.name !== packageJson.name ||
    candidateRecord.version !== (candidateMetadata?.version ?? packageJson.version)
  ) {
    fail("packed name or version does not match package.json");
  }
  if (
    typeof candidateRecord.integrity !== "string" ||
    !candidateRecord.integrity.startsWith("sha512-")
  ) {
    fail("npm did not emit a SHA-512 artifact integrity value");
  }
  const candidateArchive = await execute("tar", ["-tzf", tarball], { encoding: "utf8" });
  const candidatePaths = candidateArchive.stdout
    .split("\n")
    .filter((path) => path.startsWith("package/"))
    .map((path) => path.slice("package/".length));
  assertNoCompiledTestFiles(candidatePaths);

  const tarballBytes = await readFile(tarball);
  const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  const sha1 = createHash("sha1").update(tarballBytes).digest("hex");
  if (candidateRecord.integrity !== integrity || candidateRecord.size !== tarballBytes.byteLength) {
    fail("npm pack metadata does not match the exact tarball bytes");
  }

  const { record: repeatedRecord, tarball: repeatedTarballPath } = await packDocsFab({
    projectRoot,
    packDestination: repeatPackRoot,
    env: npmEnvironment,
    finalVersion: candidateRecord.version,
  });
  if (repeatedRecord.filename !== `docsfab-${candidateRecord.version}.tgz`) {
    fail("repeat clean prepack did not return the same package artifact identity");
  }
  const repeatedTarball = await readFile(repeatedTarballPath);
  try {
    assertPackedCandidateReproducible(tarballBytes, repeatedTarball);
  } catch {
    if (retainedArtifactRoot) {
      const diagnosticsRoot = join(retainedArtifactRoot, "diagnostics");
      await mkdir(diagnosticsRoot, { recursive: true, mode: 0o700 });
      let diagnostics;
      try {
        diagnostics = comparePackedArchives(tarballBytes, repeatedTarball);
      } catch (error) {
        diagnostics = {
          schemaVersion: 1,
          kind: "docsfab-packed-reproducibility-diagnostic",
          classification: "diagnostic-unavailable-review-required",
          gate: "failed",
          reasonCode: typeof error?.code === "string" ? error.code : "bounded-archive-parse-failed",
        };
      }
      await writeFile(
        join(diagnosticsRoot, "reproducibility.json"),
        `${JSON.stringify(diagnostics, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    fail("packed candidate and clean prepack did not produce byte-identical tarballs");
  }
  if (
    repeatedRecord.name !== packageJson.name ||
    repeatedRecord.version !== candidateRecord.version ||
    repeatedRecord.integrity !== integrity ||
    repeatedRecord.shasum !== sha1 ||
    repeatedRecord.size !== tarballBytes.byteLength
  ) {
    fail("repeat npm pack metadata does not match the exact candidate bytes");
  }
  assertPackageContents(repeatedRecord.files);
  for (const licenseFile of PACKAGE_LICENSE_FILES) {
    const packedLicense = await execute(
      "tar",
      ["-xOf", repeatedTarballPath, `package/${licenseFile}`],
      { encoding: "buffer" },
    );
    const [packageLicense, acceptedLicense] = await Promise.all([
      readFile(join(projectRoot, licenseFile)),
      readFile(resolve(projectRoot, "../..", licenseFile)),
    ]);
    try {
      assertPackedLicenseMatches(packageLicense, acceptedLicense);
      assertPackedLicenseMatches(packedLicense.stdout, acceptedLicense);
    } catch {
      fail(`packed ${licenseFile} does not match the accepted repository license source`);
    }
  }
  const packedNotice = await execute("tar", ["-xOf", repeatedTarballPath, "package/NOTICE"], {
    encoding: "buffer",
  });
  const [packageNotice, acceptedNotice] = await Promise.all([
    readFile(join(projectRoot, "NOTICE")),
    readFile(resolve(projectRoot, "../../NOTICE")),
  ]);
  try {
    assertPackedNoticeMatches(packageNotice, acceptedNotice);
    assertPackedNoticeMatches(packedNotice.stdout, acceptedNotice);
  } catch {
    fail("packed NOTICE does not match the accepted repository notice source");
  }
  const packRecord = repeatedRecord;

  const { installedPackageRoot, executable } = await installPackedDocsFab({
    tarball,
    installRoot,
    cwd: outsideRoot,
    env: npmEnvironment,
  });
  const installedLauncher = join(installedPackageRoot, "dist", "launcher.js");
  if (((await stat(installedLauncher)).mode & 0o100) === 0) {
    fail("installed launcher is not executable by its owner");
  }
  const [skillLock, assetLock, qualityLock] = await Promise.all([
    readFile(join(installedPackageRoot, "skill-crate", "lock.json"), "utf8").then(JSON.parse),
    readFile(join(installedPackageRoot, "governed-assets", "lock.json"), "utf8").then(JSON.parse),
    readFile(join(installedPackageRoot, "quality", "lock.json"), "utf8").then(JSON.parse),
  ]);
  const installedKnowledgeProviderFiles = await Promise.all(
    knowledgeProviderFiles.map(async (filename) => {
      const [canonical, installed] = await Promise.all([
        readFile(join(projectRoot, "..", "knowledge", "src", filename)),
        readFile(join(installedPackageRoot, "dist", "knowledge-provider", "src", filename)),
      ]);
      return { filename, canonical, installed };
    }),
  );
  if (
    installedKnowledgeProviderFiles.some(({ canonical, installed }) => !canonical.equals(installed))
  ) {
    fail("installed first-pass provider closure differs from its canonical knowledge sources");
  }
  const [
    { verifyCatalogSkill },
    { verifyGovernedAssetBundle, verifyGovernedAssetCatalog },
    { verifyQualityPack },
    {
      listInstalledModelCompositions,
      loadInstalledModelCompositionAuthority,
      resolveInstalledExecutableComposition,
    },
  ] = await Promise.all([
    import(pathToFileURL(join(installedPackageRoot, "dist", "skills", "catalog-crate.js")).href),
    import(pathToFileURL(join(installedPackageRoot, "dist", "assets", "lock.js")).href),
    import(pathToFileURL(join(installedPackageRoot, "dist", "quality-pack", "manifest.js")).href),
    import(pathToFileURL(join(installedPackageRoot, "dist", "model-composition", "index.js")).href),
  ]);
  for (const skill of skillLock.skills) {
    await verifyCatalogSkill({
      skillCrateDirectory: join(installedPackageRoot, "skill-crate"),
      skillId: skill.id,
      grantedTools: skill.toolPolicy.granted,
    });
  }
  const governedBundleIds = await verifyGovernedAssetCatalog(installedPackageRoot);
  for (const bundleId of governedBundleIds) {
    await verifyGovernedAssetBundle(installedPackageRoot, bundleId);
  }
  await verifyQualityPack({
    skillCrateDirectory: join(installedPackageRoot, "skill-crate"),
    qualityDirectory: join(installedPackageRoot, "quality"),
    qualityPackDirectory: join(installedPackageRoot, "quality-pack"),
  });
  const { authority: compositionAuthority, snapshot: compositionSnapshot } =
    await loadInstalledModelCompositionAuthority();
  // Restated on purpose as an independent witness of the packed artifact;
  // importing the source constant would make the check a tautology.
  //
  // Other copies to update together (grep the composition IDs; variable names
  // differ): scripts/check-model-compositions.mjs,
  // test/model-composition-assets.test.ts, test/native-composition-cli.test.ts.
  //
  // Order matters: this compares serialized arrays in the snapshot's sorted
  // order, while check-model-compositions.mjs compares with a sorting
  // `sameValues`.
  const expectedExecutableCompositionIds = [
    "anthropic-claude-opus-4.7-pi",
    "nvidia-inference-claude-opus-5-pi",
    "nvidia-inference-claude-sonnet-5-pi",
    "nvidia-inference-deepseek-v4-pro-pi",
    "nvidia-inference-gpt-6-sol-pi",
    "nvidia-inference-nemotron-3-super-v3-pi",
    "nvidia-inference-nemotron-3-ultra-pi",
    "nvidia-inference-qwen3-5-397b-a17b-pi",
    "nvidia-nemotron-3-super-120b-a12b-pi",
    "nvidia-nemotron-3-ultra-550b-a55b-pi",
    "nvidia-nemotron-3.5-lightning-30b-a3b-pi",
  ];
  const expectedPreflightCompositionIds = [
    "anthropic-claude-opus-4.7-claude-code-preflight",
    "openai-gpt-6-sol-codex-preflight",
  ];
  // Installed for provenance only; never executable.
  const expectedRetiredCompositionIds = [
    "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
    "openai-gpt-5.6-sol-codex-preflight",
    "openai-gpt-5.6-sol-pi",
  ];
  // The complete installed set is compared by identity, not a pinned count,
  // read from the packed registry, so a missing or unlisted lane fails.
  const installedCompositionIds = listInstalledModelCompositions(compositionAuthority)
    .map((entry) => entry.compositionId)
    .sort();
  const expectedInstalledCompositionIds = [
    ...expectedExecutableCompositionIds,
    ...expectedPreflightCompositionIds,
    ...expectedRetiredCompositionIds,
  ].sort();
  if (
    JSON.stringify(compositionSnapshot.executableCompositionIds) !==
      JSON.stringify(expectedExecutableCompositionIds) ||
    JSON.stringify(compositionSnapshot.preflightCompositionIds) !==
      JSON.stringify(expectedPreflightCompositionIds) ||
    JSON.stringify(installedCompositionIds) !== JSON.stringify(expectedInstalledCompositionIds)
  ) {
    fail("installed model-composition registry differs from the package trust root");
  }
  const packedComposition = resolveInstalledExecutableComposition({
    authority: compositionAuthority,
    compositionId: "nvidia-inference-gpt-6-sol-pi",
    workflowId: "create-documentation",
  });
  // A packed retired record must refuse a new selection by name (#1512).
  let packedRetiredRefusal = null;
  try {
    resolveInstalledExecutableComposition({
      authority: compositionAuthority,
      compositionId: "openai-gpt-5.6-sol-pi",
      workflowId: "create-documentation",
    });
  } catch (error) {
    packedRetiredRefusal = error;
  }
  if (packedRetiredRefusal?.code !== "composition-retired") {
    fail("a packed retired composition can still be selected for a new execution");
  }
  // Independent of the source workflow loader, whose projection of the create
  // workflow would make the install check tautological.
  const expectedPackedCreateWorkflowSteps = [
    ["plan-documentation", "read-only", 1, "plan-documentation", "documentation-planner"],
    [
      "derive-source-obligations",
      "read-only",
      2,
      "verify-technical-accuracy",
      "technical-verifier",
    ],
    ["write-documentation", "write", 3, "write-documentation", "senior-technical-writer"],
    ["lint-documentation", "read-only", 4, "lint-documentation", "documentation-linter"],
    [
      "provisional-technical-verification",
      "read-only",
      5,
      "verify-technical-accuracy",
      "technical-verifier",
    ],
    ["review-documentation", "read-only", 6, "review-documentation", "senior-editor"],
    [
      "verify-technical-accuracy",
      "read-only",
      7,
      "verify-technical-accuracy",
      "technical-verifier",
    ],
    ["revise-documentation", "write", 8, "write-documentation", "senior-technical-writer"],
    ["lint-revised-documentation", "read-only", 9, "lint-documentation", "documentation-linter"],
    [
      "provisional-revised-technical-verification",
      "read-only",
      10,
      "verify-technical-accuracy",
      "technical-verifier",
    ],
    [
      "verify-revised-technical-accuracy",
      "read-only",
      11,
      "verify-technical-accuracy",
      "technical-verifier",
    ],
    ["review-revised-documentation", "read-only", 12, "review-documentation", "senior-editor"],
    [
      "test-audience-understanding",
      "read-only",
      13,
      "test-audience-understanding",
      "target-audience-proxy",
    ],
    [
      "evaluate-document-quality",
      "read-only",
      14,
      "evaluate-document-quality",
      "documentation-quality-evaluator",
    ],
  ].map(([stepId, stepMode, stepOrdinal, skillId, role]) => ({
    stepId,
    stepMode,
    stepOrdinal,
    skillId,
    role,
  }));
  if (
    packedComposition.composition.deployment.transport !== "openai-chat-completions" ||
    packedComposition.workflow.workflowId !== "create-documentation" ||
    packedComposition.workflow.sourcePath !== "workflows/create-documentation.json" ||
    JSON.stringify(packedComposition.workflow.steps) !==
      JSON.stringify(expectedPackedCreateWorkflowSteps) ||
    packedComposition.technicalApproval !== "not-established" ||
    packedComposition.releaseEligible !== false
  ) {
    fail("installed model composition did not resolve outside the source repository");
  }

  const version = await execute(executable, ["--version"], { cwd: outsideRoot });
  const expectedVersion = await installedVersionIdentity(
    installedPackageRoot,
    candidateRecord.version,
    fail,
  );
  assertResult(version, { stdout: expectedVersion, stderr: "" });

  const help = await execute(executable, ["help"], { cwd: outsideRoot });
  if (!hasInstalledGeneralHelpContract(help.stdout)) {
    fail("installed help contract is missing");
  }
  if (help.stderr !== "") fail("installed help wrote to stderr");
  const helpAlias = await execute(executable, ["--help"], { cwd: outsideRoot });
  assertResult(helpAlias, help);

  const configuredKnowledgeDirectory = process.env.DOCSFAB_KNOWLEDGE_DIR;
  const sourceWorkingDirectory = process.cwd();
  delete process.env.DOCSFAB_KNOWLEDGE_DIR;
  process.chdir(outsideRoot);
  try {
    const { bindFirstPassKnowledge, bindFirstRunProposalScope } = await import(
      pathToFileURL(join(installedPackageRoot, "dist", "cli", "first-pass.js")).href
    );
    // The installed package resolves its own retry policy from its limits
    // catalog, as loadConfig does; first pass sizes its model budget from it.
    const { parseRetryPolicy } = await import(
      pathToFileURL(join(installedPackageRoot, "dist", "config", "retry-policy.js")).href
    );
    const firstPassConfig = {
      projectRoot: installedPackageRoot,
      stateDirectory: firstPassStateDirectory,
      retryPolicy: parseRetryPolicy({}),
    };
    const firstPassRequest = {
      workflow: "update-documentation",
      repositoryPath: firstPassRepositoryPath,
      revision: "a".repeat(40),
      instruction: "Update docs/guide.md and docs/reference.md.",
      allowWrite: true,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
    };
    const proposalScope = await bindFirstRunProposalScope({
      request: firstPassRequest,
      config: firstPassConfig,
      revision: firstPassRequest.revision,
    });
    if (
      proposalScope?.workflow !== "update-documentation" ||
      JSON.stringify(proposalScope.targetPaths) !==
        JSON.stringify(["docs/guide.md", "docs/reference.md"])
    ) {
      fail("installed first-pass request parser did not bind an ordinary documentation request");
    }
    const singleTargetAssessment = await bindFirstRunProposalScope({
      request: {
        ...firstPassRequest,
        instruction: "Assess whether docs/cli.md needs an update based on current behavior.",
      },
      config: firstPassConfig,
      revision: firstPassRequest.revision,
    });
    if (singleTargetAssessment !== undefined) {
      fail("installed multi-page parser captured a single-target reader assessment");
    }
    const singleTargetWrite = await bindFirstRunProposalScope({
      request: {
        ...firstPassRequest,
        instruction: "Update docs/guide.md.",
      },
      config: firstPassConfig,
      revision: firstPassRequest.revision,
    });
    if (
      singleTargetWrite?.workflow !== "update-documentation" ||
      JSON.stringify(singleTargetWrite.targetPaths) !== JSON.stringify(["docs/guide.md"])
    ) {
      fail("installed parser did not bind an explicit single-target documentation update");
    }
    await writeFile(
      join(firstPassRepositoryPath, "README.md"),
      "# Installed first-pass fixture\n\nThe widget command reports its installed version.\n",
    );
    let unexpectedSupportModelCall = false;
    let firstPassError;
    try {
      await bindFirstPassKnowledge({
        request: {
          ...firstPassRequest,
          instruction: "Assess whether docs/cli.md needs an update based on current behavior.",
        },
        config: firstPassConfig,
        workspacePath: firstPassRepositoryPath,
        revision: firstPassRequest.revision,
        status: () => undefined,
        supportModelBridge: {
          call: async () => {
            unexpectedSupportModelCall = true;
            throw new Error("single-target reader assessment must not call a support model");
          },
          lastAssessmentIdentitySha256: () => undefined,
          lastAssessmentBindingSha256: () => undefined,
        },
      });
    } catch (error) {
      firstPassError = error;
    }
    const installedSnapshotPath = join(
      firstPassRepositoryPath,
      ".docsfab",
      "reference-model",
      "knowledge-accepted-snapshot.json",
    );
    const installedSnapshot = JSON.parse(await readFile(installedSnapshotPath, "utf8"));
    if (
      !firstPassError ||
      firstPassError.code !== "insufficient-evidence" ||
      installedSnapshot.kind !== "knowledge-accepted-snapshot" ||
      unexpectedSupportModelCall
    ) {
      fail(
        "installed first-pass gatherer did not retain its honest reader-assessment candidate without a model",
      );
    }
  } finally {
    process.chdir(sourceWorkingDirectory);
    if (configuredKnowledgeDirectory === undefined) {
      delete process.env.DOCSFAB_KNOWLEDGE_DIR;
    } else {
      process.env.DOCSFAB_KNOWLEDGE_DIR = configuredKnowledgeDirectory;
    }
  }

  const onboarding = await execute(executable, [], { cwd: outsideRoot });
  if (
    !onboarding.stdout.startsWith("DocsFab first run\n") ||
    !onboarding.stdout.includes("State: blocked until setup") ||
    !onboarding.stdout.includes("Configure DocsFab: 'docsfab' 'setup'") ||
    !onboarding.stdout.includes(
      "Reason: Bootstrap the host policy profile and configuration root",
    ) ||
    onboarding.stdout.includes("[1/5]") ||
    onboarding.stdout.includes("Repository discovery") ||
    onboarding.stderr !== ""
  ) {
    fail("installed no-argument onboarding contract is missing");
  }

  const list = await execute(executable, ["list"], { cwd: outsideRoot });
  const listLines = list.stdout.split("\n");
  if (listLines.at(-1) === "") listLines.pop();
  // Source declarations are the oracle for the separately installed artifact.
  // Do not infer expected entries from its CLI output or keep a second public
  // workflow list that drifts when another executable manifest is registered.
  const { PUBLIC_WORKFLOW_NAMES } = await import(
    pathToFileURL(join(projectRoot, "dist/workflow-registry/manifest.js")).href
  );
  const expectedEntries = await Promise.all(
    PUBLIC_WORKFLOW_NAMES.map(async (name) => {
      const manifest = JSON.parse(
        await readFile(join(projectRoot, "workflows", `${name}.json`), "utf8"),
      );
      return `  ${name}: ${manifest.title}`;
    }),
  );
  const expectedListLines = [
    "Available workflows",
    ...expectedEntries,
    ...PUBLIC_WORKFLOW_NAMES.map((name) => `Plan ${name}: 'docsfab' 'plan' '${name}'`),
  ];
  if (JSON.stringify(listLines) !== JSON.stringify(expectedListLines) || list.stderr !== "") {
    fail("installed workflow listing failed outside the source repository");
  }

  const productTestStarted = Date.now();
  const productTest = await execute(executable, ["test", "--json"], {
    cwd: outsideRoot,
    env: packagedCliEnvironment,
    timeout: 10_000,
  });
  const productTestResult = JSON.parse(productTest.stdout);
  if (
    productTestResult.kind !== "docsfab-offline-product-test" ||
    productTestResult.status !== "passed" ||
    productTestResult.isolation?.credentials !== "not-used" ||
    productTestResult.isolation?.network !== "not-used" ||
    productTestResult.retry?.status !== "idempotent" ||
    productTestResult.retry?.externalMutationCount !== 1 ||
    productTest.stderr !== "" ||
    Date.now() - productTestStarted > 10_000
  ) {
    fail("installed offline product test did not complete safely within the runtime bound");
  }

  const example = await readFile(join(projectRoot, ".env.example"), "utf8");
  const configuration = withExplicitModelSelection(
    example
      .split(/(?<=\n)/u)
      .filter(
        (line) =>
          !/^DOCSFAB_(?:SKILL_CRATE_DIR|QUALITY_DIR|QUALITY_PACK_DIR|STATE_DIR)=/u.test(line),
      )
      .join("")
      .replace(/^MODEL_API_KEY=.*$/mu, "MODEL_API_KEY=packed-cli-proof-not-a-credential")
      .replace(/^DOCSFAB_CODEX_EXECUTABLE=.*$/mu, "DOCSFAB_CODEX_EXECUTABLE=/bin/false")
      .replace(/^DOCSFAB_CLAUDE_EXECUTABLE=.*$/mu, "DOCSFAB_CLAUDE_EXECUTABLE=/bin/false")
      .replace(/^DOCSFAB_PYTHON_EXECUTABLE=.*$/mu, "DOCSFAB_PYTHON_EXECUTABLE=/usr/bin/python3"),
  );
  await writeFile(join(configurationRoot, ".env"), configuration, { mode: 0o600 });
  const externalConfigurationEnvironment = {
    ...packagedCliEnvironment,
    DOCSFAB_CONFIG_ROOT: configurationRoot,
    XDG_STATE_HOME: privateStateRoot,
  };
  let pilotEnvironmentError;
  try {
    await execute(
      executable,
      [
        "composition",
        "pilot-campaign",
        "--corpus",
        "routing-task-guide-v1",
        "--campaign-root",
        pilotCampaignRoot,
        "--nemotron-record",
        join(temporaryRoot, "missing-nemotron-record.json"),
        "--nemotron-patch",
        join(temporaryRoot, "missing-nemotron.patch"),
        "--forbidden-root",
        installedPackageRoot,
        "--forbidden-root",
        outsideRoot,
        "--acknowledge-development-only-uncontained",
      ],
      {
        cwd: outsideRoot,
        env: externalConfigurationEnvironment,
        timeout: 10_000,
      },
    );
  } catch (error) {
    pilotEnvironmentError = error;
  }
  if (
    !pilotEnvironmentError ||
    pilotEnvironmentError.code !== 1 ||
    !pilotEnvironmentError.stderr.includes("asset-read-failed") ||
    pilotEnvironmentError.stderr.includes("environment-invalid")
  ) {
    fail(
      "installed pilot did not load executable paths from the config-root .env before refusing an unpackaged campaign kit",
    );
  }
  const doctorRepository = await realpath(doctorRepositoryPath);
  await execute("git", ["init", "--initial-branch", "main"], { cwd: doctorRepository });
  await execute("git", ["config", "user.name", "DocsFab Package Verification"], {
    cwd: doctorRepository,
  });
  await execute("git", ["config", "user.email", "docsfab-package@example.test"], {
    cwd: doctorRepository,
  });
  await execute(
    "git",
    ["remote", "add", "origin", "https://gitlab.example.test/group/project.git"],
    { cwd: doctorRepository },
  );
  await writeFile(
    join(doctorRepository, "package.json"),
    JSON.stringify({ scripts: { check: "node validate.js" } }),
  );
  await writeFile(join(doctorRepository, "README.md"), "# Installed doctor fixture\n");
  await writeFile(
    join(doctorRepository, ".docsfab.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
    })}\n`,
    { mode: 0o600 },
  );
  await execute("git", ["add", "--", "package.json", "README.md", ".docsfab.json"], {
    cwd: doctorRepository,
  });
  await execute(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "--message", "Create installed doctor fixture"],
    {
      cwd: doctorRepository,
    },
  );
  const privateProjectRoot = join(
    privateStateRoot,
    "docsfab",
    "projects",
    createHash("sha256").update(doctorRepository).digest("hex"),
  );
  await Promise.all(
    ["runs", "evidence", "delivery", "receipts"].map(async (leaf) => {
      const path = join(privateProjectRoot, leaf);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );
  const fakeGlab = join(fakeBin, "glab");
  await writeFile(
    fakeGlab,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("glab package-verification-fake");
else if (args === "config get host") console.log("gitlab.example.test");
else if (args === "config get token --host gitlab.example.test") console.log("configured");
else process.exitCode = 1;
`,
  );
  await chmod(fakeGlab, 0o700);
  externalConfigurationEnvironment.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;
  const doctor = await execute(executable, ["doctor"], {
    cwd: doctorRepository,
    env: externalConfigurationEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (
    !doctor.stdout.startsWith("DocsFab doctor\n") ||
    !doctor.stdout.includes("Result: ready for local-review") ||
    !doctor.stdout.includes("local-review readiness: ready; blockers: none") ||
    !doctor.stdout.includes(
      "ATTENTION: The selected use local-review is ready; optional draft-MR readiness is blocked.",
    ) ||
    !doctor.stdout.includes("Optional draft-MR blocker: gitlab-target-not-observed") ||
    !doctor.stdout.includes("Continue: 'docsfab' 'list'") ||
    !doctor.stdout.includes("DocsFab configuration: ready\n") ||
    doctor.stdout.includes("local-patch readiness:") ||
    doctor.stdout.includes("Read-only retry policy:") ||
    doctor.stdout.includes("Policy model:") ||
    doctor.stdout.includes("Auto modes ready:") ||
    doctor.stderr !== "" ||
    doctor.stdout.includes("packed-cli-proof-not-a-credential") ||
    doctor.stdout.includes(projectRoot) ||
    doctor.stdout.includes(configurationRoot)
  ) {
    fail("installed offline doctor did not use the plain external configuration root safely");
  }
  for (const catalogArgs of [
    ["doctor", "--catalog"],
    ["doctor", "--live", "--catalog"],
    ["doctor", "--catalog", "--json"],
    // `--live` with `--json` must still emit the schema-v1 readiness record,
    // not an operator-error envelope.
    ["doctor", "--live", "--catalog", "--json"],
  ]) {
    try {
      await execute(executable, catalogArgs, {
        cwd: outsideRoot,
        env: externalConfigurationEnvironment,
        maxBuffer: 16 * 1024 * 1024,
      });
      fail("catalog-aware doctor bypassed blocked staged readiness");
    } catch (error) {
      const selectedUseBlocked = catalogArgs.includes("--json")
        ? (() => {
            try {
              const readiness = JSON.parse(error.stdout);
              return (
                readiness.kind === "docsfab-doctor-readiness" &&
                readiness.selectedUse === "local-review" &&
                readiness.status === "blocked" &&
                readiness.useReadiness?.["local-review"]?.status === "blocked"
              );
            } catch {
              return false;
            }
          })()
        : error.stdout.startsWith("DocsFab doctor\n") &&
          error.stdout.includes("Result: blocked for local-review\n") &&
          /local-review readiness: blocked; blockers: (?!none\n)[a-z][a-z0-9-]*(?:, [a-z][a-z0-9-]*)*\n/u.test(
            error.stdout,
          );
      if (
        error.code !== 1 ||
        !selectedUseBlocked ||
        error.stdout.includes("model profile inspection")
      ) {
        fail("catalog-aware doctor did not preserve staged readiness");
      }
    }
  }
  const profile = await execute(executable, ["profile", "inspect"], {
    cwd: outsideRoot,
    env: externalConfigurationEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (
    !profile.stdout.startsWith("Model profile\n") ||
    profile.stderr !== "" ||
    profile.stdout.includes("packed-cli-proof-not-a-credential") ||
    profile.stdout.includes(projectRoot) ||
    profile.stdout.includes(configurationRoot)
  ) {
    fail(
      "installed offline profile inspection did not use the plain external configuration root safely",
    );
  }

  // The install has no devDependencies, so doctor --limits must project a
  // saved leased run without tsx. host.yaml names another state directory to
  // prove the exported DOCSFAB_STATE_DIR still selects the one read.
  let tsxResolvable = true;
  try {
    createRequire(join(installedPackageRoot, "package.json")).resolve("tsx/cjs/api");
  } catch {
    tsxResolvable = false;
  }
  if (tsxResolvable) fail("the installed package can resolve the tsx devDependency");
  const limitsRoot = join(temporaryRoot, "doctor-limits");
  const limitsStateDirectory = join(limitsRoot, "runs");
  const limitsConfigurationRoot = join(limitsRoot, "configuration");
  await mkdir(limitsConfigurationRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(limitsConfigurationRoot, "host.yaml"),
    [
      "schemaVersion: 1",
      "kind: docsfab-host-config",
      "compositionId: packed-limits-composition",
      "paths:",
      `  stateDir: ${join(limitsRoot, "host-runs")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const { observed: limitsObserved } = await writeLeasedRunRecord({
    packageRoot: installedPackageRoot,
    stateDirectory: limitsStateDirectory,
    recordId: "packed-limits-run",
  });
  let doctorLimits;
  try {
    doctorLimits = await execute(executable, ["doctor", "--limits", "--json"], {
      cwd: outsideRoot,
      env: {
        ...packagedCliEnvironment,
        DOCSFAB_CONFIG_ROOT: limitsConfigurationRoot,
        DOCSFAB_STATE_DIR: limitsStateDirectory,
        DOCSFAB_READ_ONLY_MAX_RETRIES: "2",
        DOCSFAB_SERVICE_ENV_FILE: join(limitsRoot, "absent-service.env"),
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    fail(`installed doctor --limits failed after a saved run: ${error.stderr || error.message}`);
  }
  const limitsReport = JSON.parse(doctorLimits.stdout);
  const limitRows = new Map(limitsReport.rows.map((row) => [row.name, row]));
  const retryRow = limitRows.get("retry.maxRetries");
  if (
    limitsReport.kind !== "docsfab-doctor-limits" ||
    limitsReport.exitCode !== 0 ||
    retryRow?.value !== 2 ||
    retryRow.observedMaxSeen !== 1 ||
    retryRow.headroomPercent !== 50 ||
    Object.entries(limitsObserved).some(
      ([name, value]) =>
        limitRows.get(name)?.observedMaxSeen !== value ||
        limitRows.get(name)?.headroomPercent === null,
    )
  ) {
    fail("installed doctor --limits did not report the saved run's measured rows and headroom");
  }

  try {
    await execute(executable, ["not-a-command"], { cwd: outsideRoot });
    fail("an unknown command exited successfully");
  } catch (error) {
    if (error.code !== 1 || !error.stderr.startsWith('Unknown command "not-a-command".')) {
      fail("unknown-command exit or diagnostic changed");
    }
  }

  try {
    await execute(installedLauncher, ["run", "readiness", "--repo", outsideRoot], {
      cwd: outsideRoot,
      // Keep Node available for the launcher's shebang while proving that the
      // command's git prerequisite is still reported from an empty PATH.
      env: { ...process.env, PATH: dirname(process.execPath) },
    });
    fail("a workflow without git exited successfully");
  } catch (error) {
    if (
      error.code !== 1 ||
      error.stdout !== "" ||
      !error.stderr.startsWith(
        "This DocsFab command requires git. Install git, ensure it is on PATH, and retry.\n",
      )
    ) {
      fail("missing-prerequisite exit or diagnostic changed");
    }
  }

  if (retainedArtifactRoot) {
    const sourceRevision = process.env.CI_COMMIT_SHA;
    if (!sourceRevision || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceRevision)) {
      fail("--output-dir requires one full CI_COMMIT_SHA source revision");
    }
    if (candidate.sourceRevision !== sourceRevision) {
      fail("packed candidate source revision changed before final retention");
    }
    await retainPackedArtifact({
      projectRoot,
      artifactRoot: retainedArtifactRoot,
      tarball,
      record: packRecord,
      sourceRevision,
      sourceVersion: candidate.sourceVersion,
      // Schema-v1 metadata has no clean-source attestation. Keep it ineligible
      // for publication when re-retaining the verified bytes as schema v2.
      sourceClean: candidate.sourceClean === true,
    });
    const retainedTarball = join(retainedArtifactRoot, "docsfab.tgz");
    const retainedBytes = await readFile(retainedTarball);
    const verifier = join(projectRoot, "scripts", "verify-release-artifact.mjs");
    const releaseEnvironment = {
      ...process.env,
      CI_COMMIT_SHA: sourceRevision,
      CI_COMMIT_TAG: `v${packRecord.version}`,
    };
    const corrupted = Buffer.from(retainedBytes);
    corrupted[0] = corrupted[0] ^ 1;
    await writeFile(retainedTarball, corrupted);
    try {
      await execute(process.execPath, [verifier, retainedArtifactName], {
        cwd: projectRoot,
        env: releaseEnvironment,
      });
      fail("release verifier accepted a corrupted retained tarball");
    } catch (error) {
      if (error.code !== 1 || !error.stderr.includes("do not match verified integrity")) {
        throw error;
      }
    } finally {
      await writeFile(retainedTarball, retainedBytes);
    }
    await execute(process.execPath, [verifier, retainedArtifactName], {
      cwd: projectRoot,
      env: releaseEnvironment,
    });
  }

  console.log(`PASS packed ${packRecord.name}@${packRecord.version}`);
  console.log(`Integrity: ${packRecord.integrity}`);
  console.log(`Files: ${packRecord.entryCount}; unpacked bytes: ${packRecord.unpackedSize}`);
  console.log(
    `Verified ${skillLock.skills.length} locked skills, ${qualityLock.bars.length} quality bars, and ${assetLock.bundles.length} governed asset bundles.`,
  );
  console.log(
    artifactDirectoryLeaf
      ? "The retained candidate and a clean prepack produced byte-identical tarballs."
      : "Two clean prepack runs produced byte-identical tarballs.",
  );
  console.log(
    "Installed executable passed outside-source version, help, list, first-pass provider, test, config-root .env loading with unpackaged campaign kit refusal, exit, and prerequisite checks.",
  );
  console.log(
    "Installed offline product test, doctor, and profile inspection passed with fake/local boundaries.",
  );
  console.log(
    "Installed doctor --limits measured a saved leased run without devDependencies, from the exported DOCSFAB_STATE_DIR.",
  );
  if (retainedArtifactRoot)
    console.log(`Retained exact verified artifact: ${retainedArtifactRoot}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
