#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";

import {
  bundleId,
  canonicalDigest,
  copyCorpusFiles,
  corpusId,
  fail,
  fileMode,
  governedRoot,
  relativePath,
  repositoryRoot,
  runtimeRoot,
  serialized,
  sha256,
  sourceFiles,
  sourceRelative,
  sourceRoot,
  targetRelative,
  targetRoot,
} from "./generate-model-comparison-kit-corpus.mjs";

// The public repository: the internal and exported trees stamp the same
// identity, and each revision is a content digest rather than a commit.
const repositoryUrl = "https://github.com/NVIDIA-AI-Blueprints/docsfab.git";
const crossHarnessCompositionIds = [
  "anthropic-claude-opus-4.7-claude-code-native-pilot",
  "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
  "openai-gpt-5.6-sol-codex-native-pilot",
];
const workflowStepIds = [
  "plan-documentation",
  "write-documentation",
  "lint-documentation",
  "verify-technical-accuracy",
  "review-documentation",
  "evaluate-document-quality",
];
const workflowSourceRelative = `${sourceRelative}/workflow.json`;
const skillLockSourceRelative = "packages/runtime/skill-crate/lock.json";
const qualityPackSourceRelative = "packages/runtime/quality-pack/manifest.json";
const qualityLockSourceRelative = "packages/runtime/quality/lock.json";
const activeSkillLockPath = "runtime-bindings/skill-crate/lock.json";
const activeSkillSetPath = "runtime-bindings/skill-set.json";
const activeQualityPackPath = "runtime-bindings/quality-pack/manifest.json";
// The kit mirrors the runtime mount: the quality-pack manifest names its lock
// as ../quality/lock.json, and skills/<id>/ sits beside quality/, so a skill
// file's Markdown link reaches a quality file relative to that file.
const activeQualityRoot = "runtime-bindings/quality";
const activeQualityLockPath = `${activeQualityRoot}/lock.json`;
// An inline Markdown link target, without its optional title.
const markdownLinkTarget = /\]\(<?([^)\s>]+)>?(?:\s[^)]*)?\)/gu;
// A link target that climbs out of its directory toward a quality/ directory.
const qualityTraversal = /(?:^|\/)\.\.\/(?:\.\.\/)*quality\//u;
const canonicalSkillSourceRelatives = workflowStepIds.map((id) => `packages/skills/${id}`);
// The catalog crate and its lock are generated in an earlier stage of the
// derived-state pipeline. They are intentionally allowed to be dirty here;
// runtimeBindingFiles() below verifies their bytes against the canonical
// sources and lock instead of using Git history as provenance.

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} is not an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} field set changed`);
  }
}

function parseSourceManifest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("source manifest is not valid JSON");
  }
  if (
    value?.schemaVersion !== 1 ||
    value?.kind !== "docsfab-model-comparison-corpus" ||
    value?.id !== corpusId ||
    value?.track !== "common-harness-whole-workflow" ||
    !/^[a-f0-9]{64}$/.test(value.fixtureSha256 ?? "") ||
    !Array.isArray(value.allowedChanges) ||
    value.allowedPage !== "docs/routing/guide.md"
  ) {
    fail("source manifest does not match the frozen corpus contract");
  }
  exactKeys(
    value.limits,
    [
      "contextWindow",
      "maxInputTokens",
      "maxOutputTokens",
      "maxProviderTurnsPerStep",
      "timeoutMs",
      "maxResponseBytes",
      "maxRetries",
    ],
    "source limits",
  );
  return value;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail(`${label} is not a lowercase SHA-256`);
  }
  return value;
}

function sourceBindings(sourceManifest, sourceManifestSha256) {
  return {
    sourceManifestSha256,
    sourceFixtureSha256: requireHash(sourceManifest.fixtureSha256, "fixtureSha256"),
    repositoryTreeSha256: requireHash(sourceManifest.repositoryTreeSha256, "repositoryTreeSha256"),
    instructionSha256: requireHash(sourceManifest.instructionSha256, "instructionSha256"),
    requestSha256: requireHash(sourceManifest.requestSha256, "requestSha256"),
    briefSha256: requireHash(sourceManifest.briefSha256, "briefSha256"),
    workflowSha256: requireHash(sourceManifest.workflow?.sourceSha256, "workflowSha256"),
    compositionSubjectSha256: requireHash(
      sourceManifest.compositionSubjectSha256,
      "compositionSubjectSha256",
    ),
    qualityPackSha256: requireHash(sourceManifest.qualityPackSha256, "qualityPackSha256"),
    qualityPackBindingSha256: requireHash(
      sourceManifest.qualityPackBindingSha256,
      "qualityPackBindingSha256",
    ),
    rubricSha256: requireHash(sourceManifest.rubricSha256, "rubricSha256"),
    skillSetSha256: requireHash(sourceManifest.skillSetSha256, "skillSetSha256"),
    contextSha256: requireHash(sourceManifest.contextSha256, "contextSha256"),
    executionEnvelopeSha256: requireHash(
      sourceManifest.executionEnvelopeSha256,
      "executionEnvelopeSha256",
    ),
    sourceBundleSha256: requireHash(sourceManifest.sourceBundleSha256, "sourceBundleSha256"),
    profileSha256: requireHash(sourceManifest.profileSha256, "profileSha256"),
    audienceScenarioSha256: requireHash(
      sourceManifest.audienceScenarioSha256,
      "audienceScenarioSha256",
    ),
    checkerSha256: requireHash(sourceManifest.checkerSha256, "checkerSha256"),
    materializerSha256: requireHash(sourceManifest.materializerSha256, "materializerSha256"),
    documentChecksSha256: requireHash(sourceManifest.documentChecksSha256, "documentChecksSha256"),
    journeyOracleSha256: requireHash(sourceManifest.journeyOracleSha256, "journeyOracleSha256"),
    thresholdsSha256: requireHash(sourceManifest.thresholdsSha256, "thresholdsSha256"),
    dqaCategoryMappingSha256: requireHash(
      sourceManifest.dqaCategoryMappingSha256,
      "dqaCategoryMappingSha256",
    ),
  };
}

function sourceBundleSha256(files) {
  return sha256(
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.mode} ${file.sha256}  ${file.path}\n`)
      .join(""),
  );
}

async function regularBindingFile(sourcePath, targetPath, expectedSha256) {
  const stat = await lstat(sourcePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail(`runtime binding is not one regular file: ${targetPath}`);
  }
  const bytes = await readFile(sourcePath);
  const observedSha256 = sha256(bytes);
  if (expectedSha256 && observedSha256 !== expectedSha256) {
    fail(`runtime binding digest differs from the source corpus: ${targetPath}`);
  }
  return {
    path: targetPath,
    sourcePath,
    bytes,
    sha256: observedSha256,
    mode: fileMode(stat),
  };
}

function isCampaignSkillReprint(path) {
  return (
    path === "installed-manifest.json" ||
    path === "cross-harness-descriptor.json" ||
    path === "runtime-bindings/skill-set.json" ||
    path.startsWith("runtime-bindings/skill-crate/") ||
    path.startsWith("runtime-bindings/skills/") ||
    path.startsWith("runtime-bindings/quality-pack/") ||
    path.startsWith(`${activeQualityRoot}/`)
  );
}

function governedSourceContentRevision(files, runtimeFiles) {
  const entries = [
    ...files.map((file) => ({
      path: `${sourceRelative}/${file.path}`,
      sha256: file.sha256,
      mode: file.mode,
    })),
    ...runtimeFiles.map((file) => ({
      path:
        file.sourcePath === null
          ? `${targetRelative}/${file.path}`
          : relative(repositoryRoot, file.sourcePath).split("\\").join("/"),
      sha256: file.sha256,
      mode: file.mode,
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const revision = canonicalDigest({
    kind: "docsfab-governed-source-content/v1",
    files: entries,
  });
  if (!/^[a-f0-9]{64}$/.test(revision)) fail("governed source content revision is unavailable");
  return revision;
}

async function runtimeBindingFiles(files, sourceManifest) {
  const skillSetFile = files.find((file) => file.path === "skill-set.json");
  if (!skillSetFile) fail("source skill-set is absent");
  let skillSet;
  try {
    skillSet = JSON.parse(skillSetFile.bytes.toString("utf8"));
  } catch {
    fail("source skill-set is not valid JSON");
  }
  if (
    skillSet?.schemaVersion !== 1 ||
    skillSet?.kind !== "docsfab-model-comparison-skill-set" ||
    !Array.isArray(skillSet.orderedSkills) ||
    skillSet.orderedSkills.length !== workflowStepIds.length ||
    !/^[a-f0-9]{64}$/u.test(skillSet.sourceLockSha256 ?? "") ||
    skillSet.orderedSkills.some(
      (skill, index) =>
        skill?.id !== workflowStepIds[index] ||
        !/^[a-f0-9]{64}$/u.test(skill.contentSha256 ?? "") ||
        !/^[a-f0-9]{64}$/u.test(skill.bundleSha256 ?? ""),
    )
  ) {
    fail("source skill-set does not match the frozen six-step workflow");
  }
  const skillLockFile = await regularBindingFile(
    resolve(repositoryRoot, skillLockSourceRelative),
    activeSkillLockPath,
  );
  let skillLock;
  try {
    skillLock = JSON.parse(skillLockFile.bytes.toString("utf8"));
  } catch {
    fail("runtime skill lock is not valid JSON");
  }
  if (skillLock?.schemaVersion !== 1 || !Array.isArray(skillLock.skills)) {
    fail("runtime skill lock has an unsupported contract");
  }
  if (
    sourceManifest.workflow?.sourcePath !== workflowSourceRelative ||
    sourceManifest.bindingFiles?.workflow !== workflowSourceRelative ||
    sourceManifest.bindingFiles?.compositionSubject !== "composition-subject.json"
  ) {
    fail("source manifest does not name the frozen pilot bindings");
  }
  const compositionSubjectFile = files.find((file) => file.path === "composition-subject.json");
  if (
    !compositionSubjectFile ||
    compositionSubjectFile.sha256 !==
      requireHash(sourceManifest.compositionSubjectSha256, "compositionSubjectSha256")
  ) {
    fail("source composition subject differs from the frozen pilot binding");
  }
  const workflow = await regularBindingFile(
    resolve(repositoryRoot, workflowSourceRelative),
    "runtime-bindings/workflows/create-documentation.json",
    requireHash(sourceManifest.workflow.sourceSha256, "workflowSha256"),
  );
  // The corpus workflow and skill-set describe the frozen six-step benchmark.
  // Current product workflows may evolve independently; this campaign keeps
  // its exact source bytes while active skill bundles remain factory-bound.
  const skillBundles = await Promise.all(
    skillSet.orderedSkills.map(async (skill) => {
      const locked = skillLock.skills.find((entry) => entry.id === skill.id);
      if (
        !locked ||
        !locked.toolPolicy ||
        !Array.isArray(locked.files) ||
        locked.files.length < 1
      ) {
        fail(`runtime skill lock differs from the source corpus: ${skill.id}`);
      }
      const lockedPaths = locked.files.map((file) => file.path);
      if (
        new Set(lockedPaths).size !== lockedPaths.length ||
        !lockedPaths.includes("SKILL.md") ||
        sha256(
          [...locked.files]
            .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
            .map((file) => `${file.sha256}  ${file.path}\n`)
            .join(""),
        ) !== locked.bundleSha256
      ) {
        fail(`runtime skill bundle lock is invalid: ${skill.id}`);
      }
      const bundleFiles = await Promise.all(
        locked.files.map(async (lockedFile) => {
          if (
            typeof lockedFile.path !== "string" ||
            typeof lockedFile.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(lockedFile.sha256)
          ) {
            fail(`runtime skill bundle file is invalid: ${skill.id}`);
          }
          const canonicalSourcePath = `packages/skills/${skill.id}/${lockedFile.path}`;
          const canonicalPath = resolve(repositoryRoot, canonicalSourcePath);
          if (
            relativePath(resolve(repositoryRoot, `packages/skills/${skill.id}`), canonicalPath) !==
            lockedFile.path
          ) {
            fail(`runtime skill bundle path is unsafe: ${skill.id}`);
          }
          const canonicalStat = await lstat(canonicalPath);
          if (
            canonicalStat.isSymbolicLink() ||
            !canonicalStat.isFile() ||
            canonicalStat.nlink !== 1
          ) {
            fail(`canonical skill source is not one regular file: ${skill.id}`);
          }
          const canonicalBytes = await readFile(canonicalPath);
          if (sha256(canonicalBytes) !== lockedFile.sha256) {
            fail(`canonical skill source differs from the runtime lock: ${skill.id}`);
          }
          const file = await regularBindingFile(
            resolve(runtimeRoot, "skill-crate", skill.id, lockedFile.path),
            `runtime-bindings/skills/${skill.id}/${lockedFile.path}`,
            lockedFile.sha256,
          );
          if (fileMode(canonicalStat) !== file.mode) {
            fail(`canonical and runtime skill modes differ: ${skill.id}`);
          }
          return {
            ...file,
            canonicalSourcePath,
            skillId: skill.id,
            relativePath: lockedFile.path,
            lockedBundleSha256: locked.bundleSha256,
            toolPolicySha256: canonicalDigest(locked.toolPolicy),
          };
        }),
      );
      const skillBody = bundleFiles.find((file) => file.relativePath === "SKILL.md");
      if (!skillBody) fail(`runtime skill body is absent: ${skill.id}`);
      return bundleFiles;
    }),
  );
  const activeSkillSetBytes = Buffer.from(
    serialized({
      schemaVersion: 1,
      kind: "docsfab-active-model-comparison-skill-set",
      sourceLockSha256: skillLockFile.sha256,
      orderedSkills: workflowStepIds.map((id) => {
        const locked = skillLock.skills.find((entry) => entry.id === id);
        if (!locked) fail(`runtime skill lock is missing active skill: ${id}`);
        return {
          id,
          contentSha256: locked.contentSha256,
          bundleSha256: locked.bundleSha256,
        };
      }),
    }),
    "utf8",
  );
  const activeSkillSet = {
    path: activeSkillSetPath,
    sourcePath: null,
    bytes: activeSkillSetBytes,
    sha256: sha256(activeSkillSetBytes),
    mode: "100644",
    activeSkillSet: true,
  };
  const qualityPack = await qualityPackBindingFile(skillLockFile.sha256);
  const qualityFiles = await linkedQualityFiles(skillBundles.flat(), qualityPack);
  return [
    workflow,
    ...skillBundles.flat(),
    skillLockFile,
    activeSkillSet,
    qualityPack,
    ...qualityFiles,
  ];
}

/**
 * Stage the quality-pack files that the pilot skills link to, plus the quality
 * lock that binds them, so a native step packet carries what its skill tells
 * the model to read. A link that names no locked quality file fails the build.
 */
async function linkedQualityFiles(skillFiles, qualityPack) {
  const lockFile = await regularBindingFile(
    resolve(repositoryRoot, qualityLockSourceRelative),
    activeQualityLockPath,
    qualityPack.qualityLockSha256,
  );
  let lock;
  try {
    lock = JSON.parse(lockFile.bytes.toString("utf8"));
  } catch {
    fail("runtime quality lock is not valid JSON");
  }
  // Version 2 is the lock contract the runtime admits; it carries productDefaults.
  if (lock?.schemaVersion !== 2 || !Array.isArray(lock.files)) {
    fail("runtime quality lock has an unsupported contract");
  }
  const lockedSha256 = new Map(lock.files.map((file) => [file.path, file.sha256]));
  const linkedBy = new Map();
  for (const file of skillFiles) {
    if (!file.relativePath.endsWith(".md")) continue;
    for (const match of file.bytes.toString("utf8").matchAll(markdownLinkTarget)) {
      const qualityPath = mountedQualityPath(file.skillId, file.relativePath, match[1]);
      if (qualityPath === undefined) continue;
      if (!lockedSha256.has(qualityPath)) {
        fail(
          `skill links a file the quality lock does not bind: ${file.skillId} -> ${qualityPath}`,
        );
      }
      const skills = linkedBy.get(qualityPath) ?? new Set();
      skills.add(file.skillId);
      linkedBy.set(qualityPath, skills);
    }
  }
  // The benchmark checker imports the same policy code as runtime validation.
  // These locked inputs are required by the checker even though the benchmark
  // skill does not directly link to them.
  for (const qualityPath of [
    "checks/quality_decision_policy.py",
    "profiles/docsfab-documentation-quality/profile.json",
  ]) {
    if (!lockedSha256.has(qualityPath)) {
      fail(`benchmark checker quality input is not locked: ${qualityPath}`);
    }
    if (!linkedBy.has(qualityPath))
      linkedBy.set(qualityPath, new Set(["evaluate-document-quality"]));
  }
  const qualityRoot = resolve(runtimeRoot, "quality");
  const canonicalQualityRoot = resolve(repositoryRoot, "packages/quality");
  const staged = await Promise.all(
    [...linkedBy.keys()].sort().map(async (qualityPath) => {
      const expectedSha256 = lockedSha256.get(qualityPath);
      const runtimePath = resolve(qualityRoot, qualityPath);
      const canonicalPath = resolve(canonicalQualityRoot, qualityPath);
      if (
        relativePath(qualityRoot, runtimePath) !== qualityPath ||
        relativePath(canonicalQualityRoot, canonicalPath) !== qualityPath
      ) {
        fail(`linked quality path is unsafe: ${qualityPath}`);
      }
      const canonical = await regularBindingFile(canonicalPath, qualityPath, expectedSha256);
      const file = await regularBindingFile(
        runtimePath,
        `${activeQualityRoot}/${qualityPath}`,
        expectedSha256,
      );
      if (canonical.mode !== file.mode) {
        fail(`canonical and runtime quality modes differ: ${qualityPath}`);
      }
      return {
        ...file,
        qualityPath,
        canonicalSourcePath: `packages/quality/${qualityPath}`,
        linkedBySkillIds: [...linkedBy.get(qualityPath)].sort(),
      };
    }),
  );
  return [{ ...lockFile, activeQualityLock: true }, ...staged];
}

/**
 * Resolve a skill file's Markdown link target against the mount layout. Return
 * the quality-pack path it names, or undefined for a link that stays outside
 * the quality pack. A traversal toward quality/ that misses the mounted pack
 * fails rather than going unstaged.
 */
function mountedQualityPath(skillId, fileRelativePath, rawTarget) {
  const target = rawTarget.replace(/[?#].*$/u, "");
  if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("/")) {
    return undefined;
  }
  let decoded;
  try {
    decoded = decodeURI(target);
  } catch {
    fail(`skill link target is not a valid URI: ${skillId}/${fileRelativePath} -> ${rawTarget}`);
  }
  const resolved = posix.normalize(
    posix.join("skills", skillId, posix.dirname(fileRelativePath), decoded),
  );
  if (resolved.startsWith("quality/") && resolved.length > "quality/".length) {
    return resolved.slice("quality/".length);
  }
  if (qualityTraversal.test(decoded)) {
    fail(
      `skill link does not resolve into the mounted quality pack: ${skillId}/${fileRelativePath} -> ${rawTarget}`,
    );
  }
  return undefined;
}

async function qualityPackBindingFile(skillLockSha256) {
  const file = await regularBindingFile(
    resolve(repositoryRoot, qualityPackSourceRelative),
    activeQualityPackPath,
  );
  let manifest;
  try {
    manifest = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    fail("runtime quality-pack manifest is not valid JSON");
  }
  exactKeys(
    manifest,
    ["schemaVersion", "id", "version", "skillCrate", "quality", "bindingSha256"],
    "runtime quality-pack manifest",
  );
  exactKeys(
    manifest.skillCrate,
    ["lockPath", "lockSha256", "skillIds"],
    "runtime quality-pack skill crate",
  );
  exactKeys(
    manifest.quality,
    ["lockPath", "lockSha256", "bundleSha256", "barIds"],
    "runtime quality-pack quality binding",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.id !== "docsfab-default" ||
    manifest.version !== "1.0.0" ||
    manifest.skillCrate.lockPath !== "../skill-crate/lock.json" ||
    manifest.skillCrate.lockSha256 !== skillLockSha256 ||
    !Array.isArray(manifest.skillCrate.skillIds) ||
    manifest.quality.lockPath !== "../quality/lock.json" ||
    !/^[a-f0-9]{64}$/u.test(manifest.quality.lockSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(manifest.quality.bundleSha256 ?? "") ||
    !Array.isArray(manifest.quality.barIds) ||
    manifest.bindingSha256 !==
      sha256(`${manifest.skillCrate.lockSha256}\n${manifest.quality.lockSha256}\n`)
  ) {
    fail("runtime quality-pack manifest binding is invalid");
  }
  return {
    ...file,
    qualityPackBindingSha256: manifest.bindingSha256,
    qualityLockSha256: manifest.quality.lockSha256,
  };
}

function runtimeBindingDescriptor(files) {
  const workflow = files.find(
    (file) => file.path === "runtime-bindings/workflows/create-documentation.json",
  );
  if (!workflow) fail("projected workflow binding is absent");
  const skillLock = files.find((file) => file.path === activeSkillLockPath);
  const skillSet = files.find((file) => file.path === activeSkillSetPath);
  const qualityPack = files.find((file) => file.path === activeQualityPackPath);
  const qualityLock = files.find((file) => file.activeQualityLock);
  if (
    !skillLock ||
    !skillSet?.activeSkillSet ||
    !qualityPack?.qualityPackBindingSha256 ||
    !qualityLock
  ) {
    fail("projected active-campaign metadata is absent");
  }
  const skills = workflowStepIds.map((id) => {
    const skillFiles = files
      .filter((candidate) => candidate.skillId === id)
      .sort((left, right) =>
        left.relativePath < right.relativePath
          ? -1
          : left.relativePath > right.relativePath
            ? 1
            : 0,
      );
    const file = skillFiles.find((candidate) => candidate.relativePath === "SKILL.md");
    if (!file || skillFiles.length < 1) fail(`projected skill binding is absent: ${id}`);
    return {
      id,
      root: `runtime-bindings/skills/${id}`,
      path: file.path,
      sha256: file.sha256,
      bundleSha256: file.lockedBundleSha256,
      modeBoundBundleSha256: sha256(
        skillFiles
          .map((entry) => `${entry.mode} ${entry.sha256}  ${entry.relativePath}\n`)
          .join(""),
      ),
      toolPolicySha256: file.toolPolicySha256,
      files: skillFiles.map((entry) => ({
        relativePath: entry.relativePath,
        path: entry.path,
        sha256: entry.sha256,
        mode: entry.mode,
      })),
      qualityFiles: files
        .filter((candidate) => candidate.linkedBySkillIds?.includes(id))
        .map((entry) => ({
          relativePath: entry.qualityPath,
          path: entry.path,
          sha256: entry.sha256,
          mode: entry.mode,
        })),
    };
  });
  return {
    workflow: { path: workflow.path, sha256: workflow.sha256 },
    skillLock: { path: skillLock.path, sha256: skillLock.sha256 },
    skillSet: {
      path: skillSet.path,
      sha256: skillSet.sha256,
      sourceLockSha256: skillLock.sha256,
    },
    qualityPack: {
      path: qualityPack.path,
      sha256: qualityPack.sha256,
      bindingSha256: qualityPack.qualityPackBindingSha256,
    },
    qualityLock: { path: qualityLock.path, sha256: qualityLock.sha256 },
    skills,
    bundleSha256: sourceBundleSha256(files),
  };
}

function sourceProvenance(files, runtimeFiles, revision, skillLockSha256) {
  const entries = [
    ...files.map((file) => ({
      path: `${sourceRelative}/${file.path}`,
      sha256: file.sha256,
    })),
    {
      path: qualityPackSourceRelative,
      sha256: runtimeFiles.find((file) => file.path === activeQualityPackPath)?.sha256,
    },
    ...runtimeFiles
      .filter((file) => file.skillId)
      .flatMap((file) => [
        { path: file.canonicalSourcePath, sha256: file.sha256 },
        {
          path: `packages/runtime/skill-crate/${file.skillId}/${file.relativePath}`,
          sha256: file.sha256,
        },
      ]),
    { path: skillLockSourceRelative, sha256: skillLockSha256 },
    ...runtimeFiles
      .filter((file) => file.activeQualityLock)
      .map((file) => ({ path: qualityLockSourceRelative, sha256: file.sha256 })),
    ...runtimeFiles
      .filter((file) => file.qualityPath)
      .flatMap((file) => [
        { path: file.canonicalSourcePath, sha256: file.sha256 },
        { path: `packages/runtime/quality/${file.qualityPath}`, sha256: file.sha256 },
      ]),
  ]
    .map((entry) => {
      if (!entry.path || !entry.sha256) fail("source provenance entry is incomplete");
      return entry;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const body = { revision, files: entries };
  return { ...body, snapshotSha256: canonicalDigest(body) };
}

function buildDescriptor(
  files,
  runtimeFiles,
  sourceManifest,
  sourceManifestSha256,
  sourceRevision,
  skillLockSha256,
) {
  const runtimeBindings = runtimeBindingDescriptor(runtimeFiles);
  const bindings = {
    ...sourceBindings(sourceManifest, sourceManifestSha256),
    workflowSha256: runtimeBindings.workflow.sha256,
    skillSetSha256: runtimeBindings.skillSet.sha256,
    qualityPackSha256: runtimeBindings.qualityPack.sha256,
    qualityPackBindingSha256: runtimeBindings.qualityPack.bindingSha256,
  };
  const body = {
    corpusId,
    sourceTrack: sourceManifest.track,
    track: "cross-harness-composition-six-step",
    evidenceClass: "development-only-uncontained",
    sourceRevision: sourceManifest.source.revision,
    repositoryRevision: sourceManifest.revision,
    allowedPage: sourceManifest.allowedPage,
    allowedChanges: [...sourceManifest.allowedChanges],
    compositionIds: [...crossHarnessCompositionIds],
    limits: { ...sourceManifest.limits },
    bindings,
    sourceCorpusBundleSha256: sourceBundleSha256(files),
    runtimeBindings,
    sourceProvenance: sourceProvenance(files, runtimeFiles, sourceRevision, skillLockSha256),
  };
  const fixtureSha256 = canonicalDigest(body);
  const envelope = {
    schemaVersion: 1,
    kind: "docsfab-cross-harness-pilot-corpus/v1",
    ...body,
    fixtureSha256,
  };
  return { ...envelope, descriptorSha256: canonicalDigest(envelope) };
}

function buildInstalledManifest(files, runtimeFiles, descriptorBytes, descriptor) {
  const projectedFiles = [
    {
      path: "cross-harness-descriptor.json",
      sha256: sha256(descriptorBytes),
      mode: "100644",
    },
    ...files.map((file) => ({
      path: `corpus/${file.path}`,
      sha256: file.sha256,
      mode: file.mode,
    })),
    ...runtimeFiles.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      mode: file.mode,
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const body = {
    corpusId,
    bundleHashFormat: "sha256-mode-lines-v1",
    corpusRoot: "corpus",
    descriptorPath: "cross-harness-descriptor.json",
    descriptorSha256: descriptor.descriptorSha256,
    fixtureSha256: descriptor.fixtureSha256,
    bundleSha256: sha256(
      projectedFiles.map((file) => `${file.mode} ${file.sha256}  ${file.path}\n`).join(""),
    ),
    files: projectedFiles,
  };
  const envelope = {
    schemaVersion: 1,
    kind: "docsfab-installed-model-comparison-kit/v1",
    ...body,
  };
  return { ...envelope, installedManifestSha256: canonicalDigest(envelope) };
}

function provenanceManifest(bundle) {
  return [
    `repository ${bundle.source.repository}\n`,
    `revision ${bundle.source.revision}\n`,
    `source-path ${bundle.source.path}\n`,
    `local-path ${bundle.localPath}\n`,
    `version ${bundle.version}\n`,
    `license ${bundle.license}\n`,
    ...[...bundle.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.sha256}  ${file.path}\n`),
  ].join("");
}

function buildGovernedBundle(
  files,
  runtimeFiles,
  descriptorBytes,
  installedManifestBytes,
  sourceRevision,
) {
  const lockedFiles = [
    { path: "cross-harness-descriptor.json", sha256: sha256(descriptorBytes) },
    { path: "installed-manifest.json", sha256: sha256(installedManifestBytes) },
    ...files.map((file) => ({
      path: `corpus/${file.path}`,
      sha256: file.sha256,
    })),
    ...runtimeFiles.map((file) => ({ path: file.path, sha256: file.sha256 })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const body = {
    id: bundleId,
    version: "1.0.0",
    license: "UNLICENSED",
    localPath: targetRelative,
    source: {
      repository: repositoryUrl,
      revision: sourceRevision,
      path: sourceRelative,
    },
    bundleSha256: "",
    files: lockedFiles,
  };
  return { ...body, bundleSha256: sha256(provenanceManifest(body)) };
}

async function expectedProjection() {
  const files = await sourceFiles();
  if (files.length === 0) fail("source corpus is empty");
  const manifestFile = files.find((file) => file.path === "manifest.json");
  if (!manifestFile) fail("source corpus manifest is absent");
  const sourceManifest = parseSourceManifest(manifestFile.bytes);
  const runtimeFiles = await runtimeBindingFiles(files, sourceManifest);
  const skillLockSha256 = sha256(await readFile(resolve(repositoryRoot, skillLockSourceRelative)));
  const sourceRevision = governedSourceContentRevision(files, runtimeFiles);
  const descriptor = buildDescriptor(
    files,
    runtimeFiles,
    sourceManifest,
    manifestFile.sha256,
    sourceRevision,
    skillLockSha256,
  );
  const descriptorBytes = Buffer.from(serialized(descriptor), "utf8");
  const installedManifest = buildInstalledManifest(
    files,
    runtimeFiles,
    descriptorBytes,
    descriptor,
  );
  const installedManifestBytes = Buffer.from(serialized(installedManifest), "utf8");
  const bundle = buildGovernedBundle(
    files,
    runtimeFiles,
    descriptorBytes,
    installedManifestBytes,
    sourceRevision,
  );
  return {
    files,
    runtimeFiles,
    descriptorBytes,
    installedManifestBytes,
    bundle,
  };
}

async function writeProjection(expected) {
  if (dirname(targetRoot) !== resolve(governedRoot, "model-comparison")) {
    fail("target root is unsafe");
  }
  await rm(targetRoot, { recursive: true, force: true });
  await copyCorpusFiles(expected.files);
  for (const file of expected.runtimeFiles) {
    const destination = resolve(targetRoot, file.path);
    relativePath(targetRoot, destination);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    if (file.sourcePath === null) await writeFile(destination, file.bytes);
    else await copyFile(file.sourcePath, destination);
    await chmod(destination, file.mode === "100755" ? 0o755 : 0o644);
  }
  await writeFile(resolve(targetRoot, "cross-harness-descriptor.json"), expected.descriptorBytes, {
    mode: 0o644,
  });
  await writeFile(resolve(targetRoot, "installed-manifest.json"), expected.installedManifestBytes, {
    mode: 0o644,
  });
}

async function actualFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(root, entry.name);
    const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`generated kit contains a symbolic link: ${relativeName}`);
    if (entry.isDirectory()) files.push(...(await actualFiles(path, relativeName)));
    else if (entry.isFile()) files.push(relativeName);
    else fail(`generated kit contains an unsupported node: ${relativeName}`);
  }
  return files;
}

async function checkProjection(expected) {
  const required = expected.bundle.files.filter((file) => !isCampaignSkillReprint(file.path));
  let observedPaths;
  try {
    observedPaths = new Set(await actualFiles(targetRoot));
  } catch {
    fail("generated kit is absent or unreadable");
  }
  for (const file of required) {
    if (!observedPaths.has(file.path)) {
      fail(`generated kit file is stale: ${file.path}`);
    }
    if (sha256(await readFile(resolve(targetRoot, file.path))) !== file.sha256) {
      fail(`generated kit file is stale: ${file.path}`);
    }
  }
  await checkInstalledMetadata(expected, observedPaths);
}

async function readKitJson(path) {
  try {
    return JSON.parse(await readFile(resolve(targetRoot, path), "utf8"));
  } catch {
    fail(`generated kit file is unreadable: ${path}`);
  }
}

const withoutKeys = (value, keys) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

async function resealSourceManifest() {
  const manifestPath = resolve(sourceRoot, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("source manifest is unreadable");
  }
  if (!Array.isArray(manifest.checkerFiles) || manifest.checkerFiles.length === 0) {
    fail("source manifest checkerFiles is missing");
  }
  const checkerFiles = await Promise.all(
    manifest.checkerFiles.map(async (entry) => {
      if (typeof entry?.path !== "string") fail("source manifest checker path is invalid");
      const path = resolve(sourceRoot, entry.path);
      relativePath(sourceRoot, path);
      const stat = await lstat(path).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        fail(`source manifest checker file is missing or unsafe: ${entry.path}`);
      }
      return { path: entry.path, sha256: sha256(await readFile(path)) };
    }),
  );
  const materializerPath = resolve(sourceRoot, "scripts/materialize_fixture.py");
  const materializerStat = await lstat(materializerPath).catch(() => null);
  if (!materializerStat?.isFile() || materializerStat.isSymbolicLink()) {
    fail("source materializer is missing or unsafe");
  }
  const body = {
    ...withoutKeys(manifest, ["manifestSha256", "fixtureSha256"]),
    checkerFiles,
    checkerSha256: canonicalDigest(checkerFiles),
    materializerSha256: sha256(await readFile(materializerPath)),
  };
  const manifestSha256 = canonicalDigest(body);
  const fixtureSha256 = canonicalDigest({ ...body, manifestSha256 });
  await writeFile(manifestPath, serialized({ ...body, manifestSha256, fixtureSha256 }));
}

// Descriptor fields that derive only from the frozen corpus. Everything else in
// the descriptor hashes the campaign skill reprints, which skill MRs leave
// stale by design, so those are checked for self-consistency only.
const corpusDerivedDescriptorFields = [
  "corpusId",
  "sourceTrack",
  "track",
  "evidenceClass",
  "sourceRevision",
  "repositoryRevision",
  "allowedPage",
  "allowedChanges",
  "compositionIds",
  "limits",
  "sourceCorpusBundleSha256",
];
const skillDerivedBindingFields = [
  "skillSetSha256",
  "qualityPackSha256",
  "qualityPackBindingSha256",
];

/**
 * The installed manifest and descriptor are campaign reprints, so they are
 * not compared byte-for-byte with a fresh projection. They must still be
 * sealed, describe exactly the kit on disk, and agree with the frozen corpus.
 */
async function checkInstalledMetadata(expected, observedPaths) {
  const installed = await readKitJson("installed-manifest.json");
  const descriptor = await readKitJson("cross-harness-descriptor.json");
  if (
    installed.installedManifestSha256 !==
    canonicalDigest(withoutKeys(installed, ["installedManifestSha256"]))
  ) {
    fail("generated kit installed-manifest.json self-seal mismatch");
  }
  const listed = new Set();
  for (const file of installed.files ?? []) {
    listed.add(file.path);
    const path = resolve(targetRoot, file.path);
    relativePath(targetRoot, path);
    let bytes;
    try {
      bytes = await readFile(path);
    } catch {
      fail(`generated kit installed-manifest.json lists a missing file: ${file.path}`);
    }
    if (sha256(bytes) !== file.sha256 || fileMode(await lstat(path)) !== file.mode) {
      fail(`generated kit installed-manifest.json is stale for: ${file.path}`);
    }
  }
  for (const path of observedPaths) {
    if (path !== "installed-manifest.json" && !listed.has(path)) {
      fail(`generated kit installed-manifest.json omits: ${path}`);
    }
  }
  const bundleSha256 = sha256(
    installed.files.map((file) => `${file.mode} ${file.sha256}  ${file.path}\n`).join(""),
  );
  if (installed.bundleSha256 !== bundleSha256) {
    fail("generated kit installed-manifest.json bundle digest mismatch");
  }
  if (
    descriptor.descriptorSha256 !==
      canonicalDigest(withoutKeys(descriptor, ["descriptorSha256"])) ||
    descriptor.fixtureSha256 !==
      canonicalDigest(
        withoutKeys(descriptor, ["schemaVersion", "kind", "fixtureSha256", "descriptorSha256"]),
      )
  ) {
    fail("generated kit cross-harness-descriptor.json self-seal mismatch");
  }
  if (
    installed.descriptorSha256 !== descriptor.descriptorSha256 ||
    installed.fixtureSha256 !== descriptor.fixtureSha256
  ) {
    fail("generated kit installed-manifest.json does not pin its descriptor");
  }
  const fresh = JSON.parse(expected.descriptorBytes.toString("utf8"));
  for (const field of corpusDerivedDescriptorFields) {
    if (
      canonicalDigest({ value: descriptor[field] }) !== canonicalDigest({ value: fresh[field] })
    ) {
      fail(`generated kit cross-harness-descriptor.json is stale: ${field}`);
    }
  }
  if (
    canonicalDigest(withoutKeys(descriptor.bindings ?? {}, skillDerivedBindingFields)) !==
    canonicalDigest(withoutKeys(fresh.bindings, skillDerivedBindingFields))
  ) {
    fail("generated kit cross-harness-descriptor.json is stale: bindings");
  }
}

const arguments_ = process.argv.slice(2);
const checkOnly = arguments_.length === 1 && arguments_[0] === "--check";
const resealOnly = arguments_.length === 1 && arguments_[0] === "--reseal-source-manifest";
if (arguments_.length > 0 && !checkOnly && !resealOnly) {
  fail("only --check or --reseal-source-manifest is supported");
}

if (resealOnly) await resealSourceManifest();
const expected = await expectedProjection();
if (checkOnly) await checkProjection(expected);
else await writeProjection(expected);

console.log(
  `${checkOnly ? "Model-comparison kit is current" : "Updated model-comparison kit"}: ` +
    `${expected.files.length} source files, ${expected.runtimeFiles.length} runtime bindings, ` +
    expected.bundle.bundleSha256,
);
