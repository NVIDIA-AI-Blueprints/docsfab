// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { internalContentPath } from "../config/internal-content.js";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  canonicalDigest,
  createContractKit,
  createHostAuthorityFactory,
  deepFreeze,
} from "../contract-kit/index.js";
import { resolveDocsFabProjectRoot } from "../config/host-paths.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { sha256 } from "../content-ir/canonical.js";

export const NATIVE_PILOT_CORPUS_ID = "routing-task-guide-v1" as const;
export const NATIVE_PILOT_COMPOSITION_IDS = Object.freeze([
  "anthropic-claude-opus-4.7-claude-code-native-pilot",
  "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
  "openai-gpt-5.6-sol-codex-native-pilot",
] as const);
export const NATIVE_PILOT_STEP_IDS = Object.freeze([
  "plan-documentation",
  "write-documentation",
  "lint-documentation",
  "verify-technical-accuracy",
  "review-documentation",
  "evaluate-document-quality",
] as const);

const INSTALLED_MANIFEST_PATH = "installed-manifest.json";

const MAX_KIT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_KIT_AGGREGATE_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const sourceCorpusPath = () => internalContentPath("nativePilotSource");
const sourceWorkflowPath = () => `${sourceCorpusPath()}/workflow.json`;
const sourceCompositionSubjectPath = () => `${sourceCorpusPath()}/composition-subject.json`;
const SOURCE_SKILL_LOCK_PATH = "packages/runtime/skill-crate/lock.json";
const SOURCE_QUALITY_PACK_PATH = "packages/runtime/quality-pack/manifest.json";
const SOURCE_QUALITY_LOCK_PATH = "packages/runtime/quality/lock.json";

export const NATIVE_PILOT_CORPUS_PATHS = Object.freeze({
  sourceManifest: "corpus/manifest.json",
  compositionSubject: "corpus/composition-subject.json",
  materializer: "corpus/scripts/materialize_fixture.py",
  cleanJourney: "corpus/scripts/run_clean_journey.py",
  documentChecker: "corpus/scripts/check_document.py",
  repositoryTemplate: "corpus/repository",
  descriptor: "cross-harness-descriptor.json",
  runtimeWorkflow: "runtime-bindings/workflows/create-documentation.json",
  runtimeSkillsRoot: "runtime-bindings/skills",
  activeSkillLock: "runtime-bindings/skill-crate/lock.json",
  activeSkillSet: "runtime-bindings/skill-set.json",
  activeQualityPack: "runtime-bindings/quality-pack/manifest.json",
  runtimeQualityRoot: "runtime-bindings/quality",
  activeQualityLock: "runtime-bindings/quality/lock.json",
} as const);

export interface NativePilotCorpusLimits {
  readonly contextWindow: 65_536;
  readonly maxInputTokens: 65_536;
  readonly maxOutputTokens: 8_192;
  readonly maxProviderTurnsPerStep: 4;
  readonly timeoutMs: 300_000;
  readonly maxResponseBytes: 65_536;
  readonly maxRetries: 0;
}

export interface NativePilotCorpusBindings {
  readonly sourceManifestSha256: string;
  readonly sourceFixtureSha256: string;
  readonly repositoryTreeSha256: string;
  readonly instructionSha256: string;
  readonly requestSha256: string;
  readonly briefSha256: string;
  readonly workflowSha256: string;
  readonly compositionSubjectSha256: string;
  readonly qualityPackSha256: string;
  readonly qualityPackBindingSha256: string;
  readonly rubricSha256: string;
  readonly skillSetSha256: string;
  readonly contextSha256: string;
  readonly executionEnvelopeSha256: string;
  readonly sourceBundleSha256: string;
  readonly profileSha256: string;
  readonly audienceScenarioSha256: string;
  readonly checkerSha256: string;
  readonly materializerSha256: string;
  readonly documentChecksSha256: string;
  readonly journeyOracleSha256: string;
  readonly thresholdsSha256: string;
  readonly dqaCategoryMappingSha256: string;
}

export interface NativePilotCorpusLockedFile {
  readonly path: string;
  readonly sha256: string;
  readonly mode: "100644" | "100755";
}

export interface NativePilotCorpusRuntimeBindings {
  readonly workflow: {
    readonly path: "runtime-bindings/workflows/create-documentation.json";
    readonly sha256: string;
  };
  readonly skillLock: { readonly path: string; readonly sha256: string };
  readonly skillSet: {
    readonly path: string;
    readonly sha256: string;
    readonly sourceLockSha256: string;
  };
  readonly qualityPack: {
    readonly path: string;
    readonly sha256: string;
    readonly bindingSha256: string;
  };
  readonly qualityLock: { readonly path: string; readonly sha256: string };
  readonly skills: readonly {
    readonly id: (typeof NATIVE_PILOT_STEP_IDS)[number];
    readonly root: string;
    readonly path: string;
    readonly sha256: string;
    readonly bundleSha256: string;
    readonly modeBoundBundleSha256: string;
    readonly toolPolicySha256: string;
    readonly files: readonly NativePilotCorpusBoundFile[];
    /** Quality-pack files the skill's Markdown links reach, by quality-pack path. */
    readonly qualityFiles: readonly NativePilotCorpusBoundFile[];
  }[];
  readonly bundleSha256: string;
}

export interface NativePilotCorpusBoundFile {
  readonly relativePath: string;
  readonly path: string;
  readonly sha256: string;
  readonly mode: "100644" | "100755";
}

export interface NativePilotCorpusSourceProvenance {
  readonly revision: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly snapshotSha256: string;
}

export interface NativePilotCompositionSubjectV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-native-pilot-composition-subject/v1";
  readonly sourceRevision: string;
  readonly compositionId: "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi";
  readonly model: {
    readonly requestedId: string;
    readonly resolvedId: string;
    readonly vendor: string;
  };
  readonly deployment: {
    readonly provider: string;
    readonly routeId: string;
    readonly transport: "openai-chat-completions";
    readonly bindingKind: "exact-origin";
    readonly identitySha256: string;
    readonly region: string | null;
  };
  readonly authentication: {
    readonly route: string;
    readonly credentialFamily: string;
    readonly mechanism: string;
  };
  readonly harness: { readonly id: "pi"; readonly policySha256: string };
  readonly adapters: Readonly<
    Record<
      "authentication" | "harness" | "providerConnection" | "routeEvidence",
      {
        readonly id: string;
        readonly version: string;
      }
    >
  >;
  readonly digests: {
    readonly installedManifestSha256: string;
    readonly compositionSha256: string;
    readonly candidateSha256: string;
    readonly workflowSha256: string;
    readonly packageLimitsSha256: string;
    readonly requestPolicySha256: string;
  };
  readonly limits: Readonly<
    Record<
      "candidate" | "composition" | "package",
      {
        readonly contextWindow: number;
        readonly maxInputTokens: number;
        readonly maxOutputTokens: number;
        readonly maxProviderTurns: number;
        readonly maxResponseBytes: number;
        readonly timeoutMs: number;
      }
    >
  >;
  readonly limitations: readonly string[];
  readonly technicalApproval: "not-established";
  readonly roleQualification: "not-established";
  readonly releaseEligible: false;
  readonly subjectSha256: string;
}

export interface NativePilotCorpusSnapshot {
  readonly corpusId: typeof NATIVE_PILOT_CORPUS_ID;
  readonly track: "cross-harness-composition-six-step";
  readonly evidenceClass: "development-only-uncontained";
  readonly fixtureSha256: string;
  readonly sourceFixtureSha256: string;
  readonly installedManifestSha256: string;
  readonly installedManifestFileSha256: string;
  readonly descriptorSha256: string;
  readonly governedBundleSha256: string;
  readonly repositoryRevision: string;
  readonly repositoryGitTree: string;
  readonly repositoryTreeSha256: string;
  readonly allowedPage: "docs/routing/guide.md";
  readonly compositionIds: typeof NATIVE_PILOT_COMPOSITION_IDS;
  readonly limits: NativePilotCorpusLimits;
  readonly files: readonly NativePilotCorpusLockedFile[];
  readonly paths: typeof NATIVE_PILOT_CORPUS_PATHS;
  readonly runtimeBindings: NativePilotCorpusRuntimeBindings;
  readonly sourceProvenance: NativePilotCorpusSourceProvenance;
  readonly compositionSubject: NativePilotCompositionSubjectV1;
}

export interface BoundNativePilotCorpus extends NativePilotCorpusSnapshot {
  readonly bindings: NativePilotCorpusBindings;
}

export interface InstalledNativePilotCorpusAuthority {
  readonly kind: "docsfab-installed-native-pilot-corpus-authority";
}

export type NativePilotCorpusErrorCode =
  | "asset-read-failed"
  | "authority-invalid"
  | "checksum-mismatch"
  | "credential-material"
  | "digest-mismatch"
  | "file-set-mismatch"
  | "installed-manifest-digest-mismatch"
  | "invalid-shape"
  | "invalid-value"
  | "schema-mismatch"
  | "migration-required"
  | "unknown-corpus"
  | "unsafe-path";

export class NativePilotCorpusError extends Error {
  public constructor(public readonly code: NativePilotCorpusErrorCode) {
    super(`Native pilot corpus authority rejected (${code}).`);
    this.name = "NativePilotCorpusError";
  }
}

interface InstalledManifest {
  readonly corpusId: typeof NATIVE_PILOT_CORPUS_ID;
  readonly corpusRoot: "corpus";
  readonly descriptorPath: "cross-harness-descriptor.json";
  readonly descriptorSha256: string;
  readonly fixtureSha256: string;
  readonly bundleSha256: string;
  readonly files: readonly NativePilotCorpusLockedFile[];
  readonly installedManifestSha256: string;
}

interface CrossHarnessDescriptor {
  readonly corpusId: typeof NATIVE_PILOT_CORPUS_ID;
  readonly sourceTrack: "common-harness-whole-workflow";
  readonly track: "cross-harness-composition-six-step";
  readonly evidenceClass: "development-only-uncontained";
  readonly sourceRevision: string;
  readonly repositoryRevision: string;
  readonly allowedPage: "docs/routing/guide.md";
  readonly allowedChanges: readonly ["docs/routing/guide.md"];
  readonly compositionIds: typeof NATIVE_PILOT_COMPOSITION_IDS;
  readonly limits: NativePilotCorpusLimits;
  readonly bindings: NativePilotCorpusBindings;
  readonly sourceCorpusBundleSha256: string;
  readonly runtimeBindings: NativePilotCorpusRuntimeBindings;
  readonly sourceProvenance: NativePilotCorpusSourceProvenance;
  readonly fixtureSha256: string;
  readonly descriptorSha256: string;
}

interface CorpusVerifier {
  readonly manifest: InstalledManifest;
  readonly descriptor: CrossHarnessDescriptor;
  readonly snapshot: NativePilotCorpusSnapshot;
  readonly bytes: ReadonlyMap<string, Buffer>;
  verifyCurrent(): boolean;
}

function fail(code: NativePilotCorpusErrorCode): never {
  throw new NativePilotCorpusError(code);
}

const kit = createContractKit<NativePilotCorpusErrorCode>({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const authorityFactory = createHostAuthorityFactory<
  "docsfab-installed-native-pilot-corpus-authority",
  CorpusVerifier
>({
  kind: "docsfab-installed-native-pilot-corpus-authority",
  invalidMessage: "invalid-native-pilot-corpus-verifier",
});

const BINDING_KEYS = [
  "sourceManifestSha256",
  "sourceFixtureSha256",
  "repositoryTreeSha256",
  "instructionSha256",
  "requestSha256",
  "briefSha256",
  "workflowSha256",
  "compositionSubjectSha256",
  "qualityPackSha256",
  "qualityPackBindingSha256",
  "rubricSha256",
  "skillSetSha256",
  "contextSha256",
  "executionEnvelopeSha256",
  "sourceBundleSha256",
  "profileSha256",
  "audienceScenarioSha256",
  "checkerSha256",
  "materializerSha256",
  "documentChecksSha256",
  "journeyOracleSha256",
  "thresholdsSha256",
  "dqaCategoryMappingSha256",
] as const satisfies readonly (keyof NativePilotCorpusBindings)[];

function safePath(value: unknown): string {
  const path = kit.string(value);
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail("unsafe-path");
  }
  return path;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("invalid-value");
  return value as number;
}

function parseLimits(value: unknown): NativePilotCorpusLimits {
  const root = kit.object(value);
  kit.exact(root, [
    "contextWindow",
    "maxInputTokens",
    "maxOutputTokens",
    "maxProviderTurnsPerStep",
    "timeoutMs",
    "maxResponseBytes",
    "maxRetries",
  ]);
  const limits = {
    contextWindow: positiveInteger(root.contextWindow),
    maxInputTokens: positiveInteger(root.maxInputTokens),
    maxOutputTokens: positiveInteger(root.maxOutputTokens),
    maxProviderTurnsPerStep: positiveInteger(root.maxProviderTurnsPerStep),
    timeoutMs: positiveInteger(root.timeoutMs),
    maxResponseBytes: positiveInteger(root.maxResponseBytes),
    maxRetries: root.maxRetries,
  };
  if (
    limits.contextWindow !== 65_536 ||
    limits.maxInputTokens !== 65_536 ||
    limits.maxOutputTokens !== 8_192 ||
    limits.maxProviderTurnsPerStep !== 4 ||
    limits.timeoutMs !== 300_000 ||
    limits.maxResponseBytes !== 65_536 ||
    limits.maxRetries !== 0
  ) {
    fail("invalid-value");
  }
  return limits as NativePilotCorpusLimits;
}

function parseBindings(value: unknown): NativePilotCorpusBindings {
  const root = kit.object(value);
  kit.exact(root, BINDING_KEYS);
  return Object.fromEntries(
    BINDING_KEYS.map((key) => [key, kit.hash(root[key])]),
  ) as unknown as NativePilotCorpusBindings;
}

function parseCompositionSubject(value: unknown): NativePilotCompositionSubjectV1 {
  return kit.decodeSealed(
    value,
    "docsfab-native-pilot-composition-subject/v1",
    "subjectSha256",
    [
      "sourceRevision",
      "compositionId",
      "model",
      "deployment",
      "authentication",
      "harness",
      "adapters",
      "digests",
      "limits",
      "limitations",
      "technicalApproval",
      "roleQualification",
      "releaseEligible",
    ],
    (body) => {
      const model = kit.object(body.model);
      kit.exact(model, ["requestedId", "resolvedId", "vendor"]);
      const deployment = kit.object(body.deployment);
      kit.exact(deployment, [
        "provider",
        "routeId",
        "transport",
        "bindingKind",
        "identitySha256",
        "region",
      ]);
      const authentication = kit.object(body.authentication);
      kit.exact(authentication, ["route", "credentialFamily", "mechanism"]);
      const harness = kit.object(body.harness);
      kit.exact(harness, ["id", "policySha256"]);
      const adapters = kit.object(body.adapters);
      kit.exact(adapters, ["authentication", "harness", "providerConnection", "routeEvidence"]);
      const normalizedAdapters = Object.fromEntries(
        Object.entries(adapters).map(([name, value]) => {
          const adapter = kit.object(value);
          kit.exact(adapter, ["id", "version"]);
          return [name, { id: kit.identifier(adapter.id), version: kit.string(adapter.version) }];
        }),
      );
      const digests = kit.object(body.digests);
      kit.exact(digests, [
        "installedManifestSha256",
        "compositionSha256",
        "candidateSha256",
        "workflowSha256",
        "packageLimitsSha256",
        "requestPolicySha256",
      ]);
      const limits = kit.object(body.limits);
      kit.exact(limits, ["candidate", "composition", "package"]);
      const normalizedLimits = Object.fromEntries(
        Object.entries(limits).map(([name, value]) => {
          const limit = kit.object(value);
          kit.exact(limit, [
            "contextWindow",
            "maxInputTokens",
            "maxOutputTokens",
            "maxProviderTurns",
            "maxResponseBytes",
            "timeoutMs",
          ]);
          return [
            name,
            Object.fromEntries(
              Object.entries(limit).map(([key, amount]) => [key, positiveInteger(amount)]),
            ),
          ];
        }),
      );
      const limitations = kit.array(body.limitations).map((item) => kit.identifier(item));
      if (
        limitations.length < 1 ||
        new Set(limitations).size !== limitations.length ||
        limitations.some((item, index) => index > 0 && limitations[index - 1]! >= item)
      ) {
        fail("invalid-value");
      }
      return {
        sourceRevision: kit.revision(body.sourceRevision),
        compositionId: kit.enumeration(body.compositionId, [
          "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
        ] as const),
        model: {
          requestedId: kit.string(model.requestedId),
          resolvedId: kit.string(model.resolvedId),
          vendor: kit.identifier(model.vendor),
        },
        deployment: {
          provider: kit.identifier(deployment.provider),
          routeId: kit.identifier(deployment.routeId),
          transport: kit.enumeration(deployment.transport, ["openai-chat-completions"] as const),
          bindingKind: kit.enumeration(deployment.bindingKind, ["exact-origin"] as const),
          identitySha256: kit.hash(deployment.identitySha256),
          region: deployment.region === null ? null : kit.identifier(deployment.region),
        },
        authentication: {
          route: kit.identifier(authentication.route),
          credentialFamily: kit.identifier(authentication.credentialFamily),
          mechanism: kit.identifier(authentication.mechanism),
        },
        harness: {
          id: kit.enumeration(harness.id, ["pi"] as const),
          policySha256: kit.hash(harness.policySha256),
        },
        adapters: normalizedAdapters,
        digests: {
          installedManifestSha256: kit.hash(digests.installedManifestSha256),
          compositionSha256: kit.hash(digests.compositionSha256),
          candidateSha256: kit.hash(digests.candidateSha256),
          workflowSha256: kit.hash(digests.workflowSha256),
          packageLimitsSha256: kit.hash(digests.packageLimitsSha256),
          requestPolicySha256: kit.hash(digests.requestPolicySha256),
        },
        limits: normalizedLimits,
        limitations,
        technicalApproval: kit.enumeration(body.technicalApproval, ["not-established"] as const),
        roleQualification: kit.enumeration(body.roleQualification, ["not-established"] as const),
        releaseEligible: body.releaseEligible === false ? false : fail("invalid-value"),
      };
    },
  ) as unknown as NativePilotCompositionSubjectV1;
}

function parseCompositionIds(value: unknown): typeof NATIVE_PILOT_COMPOSITION_IDS {
  const observed = kit.array(value).map((item) => kit.identifier(item));
  if (
    observed.length !== NATIVE_PILOT_COMPOSITION_IDS.length ||
    observed.some((item, index) => item !== NATIVE_PILOT_COMPOSITION_IDS[index])
  ) {
    fail("invalid-value");
  }
  return NATIVE_PILOT_COMPOSITION_IDS;
}

function parseRuntimeBindings(value: unknown): NativePilotCorpusRuntimeBindings {
  const root = kit.object(value);
  kit.exact(root, [
    "workflow",
    "skillLock",
    "skillSet",
    "qualityPack",
    "qualityLock",
    "skills",
    "bundleSha256",
  ]);
  const workflow = kit.object(root.workflow);
  kit.exact(workflow, ["path", "sha256"]);
  if (workflow.path !== NATIVE_PILOT_CORPUS_PATHS.runtimeWorkflow) fail("invalid-value");
  const skillLock = kit.object(root.skillLock);
  kit.exact(skillLock, ["path", "sha256"]);
  if (skillLock.path !== NATIVE_PILOT_CORPUS_PATHS.activeSkillLock) fail("invalid-value");
  const skillSet = kit.object(root.skillSet);
  kit.exact(skillSet, ["path", "sha256", "sourceLockSha256"]);
  if (skillSet.path !== NATIVE_PILOT_CORPUS_PATHS.activeSkillSet) fail("invalid-value");
  const qualityPack = kit.object(root.qualityPack);
  kit.exact(qualityPack, ["path", "sha256", "bindingSha256"]);
  if (qualityPack.path !== NATIVE_PILOT_CORPUS_PATHS.activeQualityPack) fail("invalid-value");
  const qualityLock = kit.object(root.qualityLock);
  kit.exact(qualityLock, ["path", "sha256"]);
  if (qualityLock.path !== NATIVE_PILOT_CORPUS_PATHS.activeQualityLock) fail("invalid-value");
  const skills = kit.array(root.skills).map((entry, index) => {
    const skill = kit.object(entry);
    kit.exact(skill, [
      "id",
      "root",
      "path",
      "sha256",
      "bundleSha256",
      "modeBoundBundleSha256",
      "toolPolicySha256",
      "files",
      "qualityFiles",
    ]);
    const id = kit.identifier(skill.id);
    if (id !== NATIVE_PILOT_STEP_IDS[index]) fail("invalid-value");
    const skillRoot = safePath(skill.root);
    if (skillRoot !== `${NATIVE_PILOT_CORPUS_PATHS.runtimeSkillsRoot}/${id}`) {
      fail("invalid-value");
    }
    const path = safePath(skill.path);
    if (path !== `${skillRoot}/SKILL.md`) {
      fail("invalid-value");
    }
    const files = kit.array(skill.files).map((entry) => {
      const file = kit.object(entry);
      kit.exact(file, ["relativePath", "path", "sha256", "mode"]);
      const relativePath = safePath(file.relativePath);
      const lockedPath = safePath(file.path);
      if (lockedPath !== `${skillRoot}/${relativePath}`) fail("invalid-value");
      return {
        relativePath,
        path: lockedPath,
        sha256: kit.hash(file.sha256),
        mode: kit.enumeration(file.mode, ["100644", "100755"] as const),
      };
    });
    if (
      files.length < 1 ||
      new Set(files.map((file) => file.relativePath)).size !== files.length ||
      files.some(
        (file, fileIndex) =>
          fileIndex > 0 && files[fileIndex - 1]!.relativePath >= file.relativePath,
      ) ||
      files.find((file) => file.relativePath === "SKILL.md")?.path !== path
    ) {
      fail("file-set-mismatch");
    }
    const bundleSha256 = kit.hash(skill.bundleSha256);
    if (
      sha256(files.map((file) => `${file.sha256}  ${file.relativePath}\n`).join("")) !==
      bundleSha256
    ) {
      fail("digest-mismatch");
    }
    const modeBoundBundleSha256 = kit.hash(skill.modeBoundBundleSha256);
    if (
      sha256(
        files.map((file) => `${file.mode} ${file.sha256}  ${file.relativePath}\n`).join(""),
      ) !== modeBoundBundleSha256
    ) {
      fail("digest-mismatch");
    }
    const qualityFiles = parseBoundFiles(
      skill.qualityFiles,
      NATIVE_PILOT_CORPUS_PATHS.runtimeQualityRoot,
    );
    if (qualityFiles.some((file) => file.path === NATIVE_PILOT_CORPUS_PATHS.activeQualityLock)) {
      fail("file-set-mismatch");
    }
    return {
      id: id as (typeof NATIVE_PILOT_STEP_IDS)[number],
      root: skillRoot,
      path,
      sha256: kit.hash(skill.sha256),
      bundleSha256,
      modeBoundBundleSha256,
      toolPolicySha256: kit.hash(skill.toolPolicySha256),
      files,
      qualityFiles,
    };
  });
  if (skills.length !== NATIVE_PILOT_STEP_IDS.length) fail("invalid-value");
  return {
    workflow: {
      path: NATIVE_PILOT_CORPUS_PATHS.runtimeWorkflow,
      sha256: kit.hash(workflow.sha256),
    },
    skillLock: {
      path: NATIVE_PILOT_CORPUS_PATHS.activeSkillLock,
      sha256: kit.hash(skillLock.sha256),
    },
    skillSet: {
      path: NATIVE_PILOT_CORPUS_PATHS.activeSkillSet,
      sha256: kit.hash(skillSet.sha256),
      sourceLockSha256: kit.hash(skillSet.sourceLockSha256),
    },
    qualityPack: {
      path: NATIVE_PILOT_CORPUS_PATHS.activeQualityPack,
      sha256: kit.hash(qualityPack.sha256),
      bindingSha256: kit.hash(qualityPack.bindingSha256),
    },
    qualityLock: {
      path: NATIVE_PILOT_CORPUS_PATHS.activeQualityLock,
      sha256: kit.hash(qualityLock.sha256),
    },
    skills,
    bundleSha256: kit.hash(root.bundleSha256),
  };
}

function parseBoundFiles(value: unknown, root: string): NativePilotCorpusBoundFile[] {
  const files = kit.array(value).map((entry) => {
    const file = kit.object(entry);
    kit.exact(file, ["relativePath", "path", "sha256", "mode"]);
    const relativePath = safePath(file.relativePath);
    const lockedPath = safePath(file.path);
    if (lockedPath !== `${root}/${relativePath}`) fail("invalid-value");
    return {
      relativePath,
      path: lockedPath,
      sha256: kit.hash(file.sha256),
      mode: kit.enumeration(file.mode, ["100644", "100755"] as const),
    };
  });
  if (
    files.some((file, index) => index > 0 && files[index - 1]!.relativePath >= file.relativePath)
  ) {
    fail("file-set-mismatch");
  }
  return files;
}

function parseSourceProvenance(value: unknown): NativePilotCorpusSourceProvenance {
  const root = kit.object(value);
  kit.exact(root, ["revision", "files", "snapshotSha256"]);
  const revision = kit.revision(root.revision);
  const files = kit.array(root.files).map((entry) => {
    const file = kit.object(entry);
    kit.exact(file, ["path", "sha256"]);
    return { path: safePath(file.path), sha256: kit.hash(file.sha256) };
  });
  if (
    files.length === 0 ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0)
  ) {
    fail("invalid-value");
  }
  const body = { revision, files };
  const snapshotSha256 = kit.hash(root.snapshotSha256);
  if (canonicalDigest(body) !== snapshotSha256) fail("digest-mismatch");
  return { ...body, snapshotSha256 };
}

function parseLockedFiles(value: unknown): readonly NativePilotCorpusLockedFile[] {
  const files = kit.array(value).map((entry) => {
    const root = kit.object(entry);
    kit.exact(root, ["path", "sha256", "mode"]);
    return {
      path: safePath(root.path),
      sha256: kit.hash(root.sha256),
      mode: kit.enumeration(root.mode, ["100644", "100755"] as const),
    };
  });
  if (
    files.length === 0 ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0)
  ) {
    fail("file-set-mismatch");
  }
  return files;
}

function fileBundleSha256(files: readonly NativePilotCorpusLockedFile[]): string {
  return sha256(files.map((file) => `${file.mode} ${file.sha256}  ${file.path}\n`).join(""));
}

function parseInstalledManifest(value: unknown): InstalledManifest {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "corpusId",
    "bundleHashFormat",
    "corpusRoot",
    "descriptorPath",
    "descriptorSha256",
    "fixtureSha256",
    "bundleSha256",
    "files",
    "installedManifestSha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-installed-model-comparison-kit/v1" ||
    root.corpusId !== NATIVE_PILOT_CORPUS_ID ||
    root.bundleHashFormat !== "sha256-mode-lines-v1" ||
    root.corpusRoot !== "corpus" ||
    root.descriptorPath !== "cross-harness-descriptor.json"
  ) {
    fail("schema-mismatch");
  }
  const files = parseLockedFiles(root.files);
  const bundleSha256 = kit.hash(root.bundleSha256);
  if (fileBundleSha256(files) !== bundleSha256) fail("checksum-mismatch");
  const body = {
    schemaVersion: 1,
    kind: "docsfab-installed-model-comparison-kit/v1",
    corpusId: NATIVE_PILOT_CORPUS_ID,
    bundleHashFormat: "sha256-mode-lines-v1",
    corpusRoot: "corpus",
    descriptorPath: "cross-harness-descriptor.json",
    descriptorSha256: kit.hash(root.descriptorSha256),
    fixtureSha256: kit.hash(root.fixtureSha256),
    bundleSha256,
    files,
  } as const;
  const installedManifestSha256 = kit.hash(root.installedManifestSha256);
  if (canonicalDigest(body) !== installedManifestSha256) fail("digest-mismatch");
  return { ...body, installedManifestSha256 };
}

function parseDescriptor(value: unknown): CrossHarnessDescriptor {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
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
    "bindings",
    "sourceCorpusBundleSha256",
    "runtimeBindings",
    "sourceProvenance",
    "fixtureSha256",
    "descriptorSha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-cross-harness-pilot-corpus/v1" ||
    root.corpusId !== NATIVE_PILOT_CORPUS_ID ||
    root.sourceTrack !== "common-harness-whole-workflow" ||
    root.track !== "cross-harness-composition-six-step" ||
    root.evidenceClass !== "development-only-uncontained" ||
    root.allowedPage !== "docs/routing/guide.md"
  ) {
    fail("schema-mismatch");
  }
  const allowedChanges = kit.array(root.allowedChanges).map((item) => safePath(item));
  if (allowedChanges.length !== 1 || allowedChanges[0] !== "docs/routing/guide.md") {
    fail("invalid-value");
  }
  const body = {
    corpusId: NATIVE_PILOT_CORPUS_ID,
    sourceTrack: "common-harness-whole-workflow" as const,
    track: "cross-harness-composition-six-step" as const,
    evidenceClass: "development-only-uncontained" as const,
    sourceRevision: kit.revision(root.sourceRevision),
    repositoryRevision: kit.revision(root.repositoryRevision),
    allowedPage: "docs/routing/guide.md" as const,
    allowedChanges: ["docs/routing/guide.md"] as const,
    compositionIds: parseCompositionIds(root.compositionIds),
    limits: parseLimits(root.limits),
    bindings: parseBindings(root.bindings),
    sourceCorpusBundleSha256: kit.hash(root.sourceCorpusBundleSha256),
    runtimeBindings: parseRuntimeBindings(root.runtimeBindings),
    sourceProvenance: parseSourceProvenance(root.sourceProvenance),
  };
  const fixtureSha256 = kit.hash(root.fixtureSha256);
  if (canonicalDigest(body) !== fixtureSha256) fail("digest-mismatch");
  const envelope = {
    schemaVersion: 1,
    kind: "docsfab-cross-harness-pilot-corpus/v1",
    ...body,
    fixtureSha256,
  } as const;
  const descriptorSha256 = kit.hash(root.descriptorSha256);
  if (canonicalDigest(envelope) !== descriptorSha256) fail("digest-mismatch");
  return { ...envelope, descriptorSha256 };
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function readLockedFile(
  directory: string,
  file: NativePilotCorpusLockedFile,
): Promise<Buffer> {
  const path = resolve(directory, file.path);
  if (!contained(directory, path)) fail("unsafe-path");
  try {
    const [canonicalDirectory, canonicalPath] = await Promise.all([
      realpath(directory),
      realpath(path),
    ]);
    if (!contained(canonicalDirectory, canonicalPath)) fail("unsafe-path");
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_KIT_FILE_BYTES ||
      ((before.mode & 0o111) === 0 ? "100644" : "100755") !== file.mode
    ) {
      fail("unsafe-path");
    }
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      fail("unsafe-path");
    }
    if (sha256(bytes) !== file.sha256) fail("checksum-mismatch");
    return bytes;
  } catch (error) {
    if (error instanceof NativePilotCorpusError) throw error;
    fail("asset-read-failed");
  }
}

async function resolveTrustedKitDirectory(projectRoot: string): Promise<string> {
  const directory = resolve(
    projectRoot,
    internalContentPath("modelComparisonInstalled"),
    NATIVE_PILOT_CORPUS_ID,
  );
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(projectRoot);
  } catch {
    fail("asset-read-failed");
  }
  if (!contained(projectRoot, directory)) fail("unsafe-path");
  const components = relative(projectRoot, directory).split(sep).filter(Boolean);
  let canonicalDirectory = canonicalRoot;
  for (const [index] of components.entries()) {
    const candidate = resolve(projectRoot, ...components.slice(0, index + 1));
    let metadata;
    let canonicalCandidate: string;
    try {
      [metadata, canonicalCandidate] = await Promise.all([lstat(candidate), realpath(candidate)]);
    } catch {
      fail("asset-read-failed");
    }
    if (!contained(canonicalRoot, canonicalCandidate)) fail("unsafe-path");
    if (index === components.length - 1) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("asset-read-failed");
    } else if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail("unsafe-path");
    }
    canonicalDirectory = canonicalCandidate;
  }
  if (!contained(canonicalRoot, canonicalDirectory)) fail("unsafe-path");
  return canonicalDirectory;
}

function sourceCorpusBundleSha256(files: readonly NativePilotCorpusLockedFile[]): string {
  const corpusFiles = files
    .filter((file) => file.path.startsWith("corpus/"))
    .map((file) => ({ ...file, path: file.path.slice("corpus/".length) }));
  return fileBundleSha256(corpusFiles);
}

function selectedFilesBundleSha256(
  files: readonly NativePilotCorpusLockedFile[],
  paths: ReadonlySet<string>,
): string {
  return fileBundleSha256(files.filter((file) => paths.has(file.path)));
}

function assertBoundInputs(
  manifest: InstalledManifest,
  descriptor: CrossHarnessDescriptor,
  bytes: ReadonlyMap<string, Buffer>,
): {
  readonly repositoryGitTree: string;
  readonly compositionSubject: NativePilotCompositionSubjectV1;
} {
  if (
    manifest.descriptorSha256 !== descriptor.descriptorSha256 ||
    manifest.fixtureSha256 !== descriptor.fixtureSha256 ||
    sourceCorpusBundleSha256(manifest.files) !== descriptor.sourceCorpusBundleSha256
  ) {
    fail("digest-mismatch");
  }
  const runtimePaths = new Set([
    descriptor.runtimeBindings.workflow.path,
    descriptor.runtimeBindings.skillLock.path,
    descriptor.runtimeBindings.skillSet.path,
    descriptor.runtimeBindings.qualityPack.path,
    descriptor.runtimeBindings.qualityLock.path,
    ...descriptor.runtimeBindings.skills.flatMap((skill) => skill.files.map((file) => file.path)),
    ...descriptor.runtimeBindings.skills.flatMap((skill) =>
      skill.qualityFiles.map((file) => file.path),
    ),
  ]);
  if (
    selectedFilesBundleSha256(manifest.files, runtimePaths) !==
    descriptor.runtimeBindings.bundleSha256
  ) {
    fail("digest-mismatch");
  }
  const provenance = new Map(
    descriptor.sourceProvenance.files.map((file) => [file.path, file.sha256]),
  );
  for (const file of manifest.files.filter((candidate) => candidate.path.startsWith("corpus/"))) {
    const sourcePath = `${sourceCorpusPath()}/${file.path.slice("corpus/".length)}`;
    if (provenance.get(sourcePath) !== file.sha256) fail("digest-mismatch");
  }
  if (
    provenance.get(sourceWorkflowPath()) !== descriptor.runtimeBindings.workflow.sha256 ||
    provenance.get(sourceCompositionSubjectPath()) !==
      descriptor.bindings.compositionSubjectSha256 ||
    provenance.get(SOURCE_SKILL_LOCK_PATH) !== descriptor.runtimeBindings.skillLock.sha256 ||
    provenance.get(SOURCE_QUALITY_PACK_PATH) !== descriptor.runtimeBindings.qualityPack.sha256 ||
    provenance.get(SOURCE_QUALITY_LOCK_PATH) !== descriptor.runtimeBindings.qualityLock.sha256
  ) {
    fail("digest-mismatch");
  }
  for (const skill of descriptor.runtimeBindings.skills) {
    for (const file of skill.files) {
      if (
        provenance.get(`packages/skills/${skill.id}/${file.relativePath}`) !== file.sha256 ||
        provenance.get(`packages/runtime/skill-crate/${skill.id}/${file.relativePath}`) !==
          file.sha256
      ) {
        fail("digest-mismatch");
      }
    }
    for (const file of skill.qualityFiles) {
      if (
        provenance.get(`packages/quality/${file.relativePath}`) !== file.sha256 ||
        provenance.get(`packages/runtime/quality/${file.relativePath}`) !== file.sha256
      ) {
        fail("digest-mismatch");
      }
    }
  }
  const expectedBindings: ReadonlyArray<[string, keyof NativePilotCorpusBindings]> = [
    [NATIVE_PILOT_CORPUS_PATHS.sourceManifest, "sourceManifestSha256"],
    ["corpus/instruction.txt", "instructionSha256"],
    ["corpus/request.json", "requestSha256"],
    ["corpus/brief.json", "briefSha256"],
    [NATIVE_PILOT_CORPUS_PATHS.compositionSubject, "compositionSubjectSha256"],
    ["corpus/context-packet.json", "contextSha256"],
    ["corpus/execution-envelope.json", "executionEnvelopeSha256"],
    ["corpus/source-bundle.json", "sourceBundleSha256"],
    ["corpus/audience/scenarios.json", "audienceScenarioSha256"],
    [NATIVE_PILOT_CORPUS_PATHS.materializer, "materializerSha256"],
    ["corpus/oracles/document-checks.json", "documentChecksSha256"],
    ["corpus/oracles/journey.json", "journeyOracleSha256"],
    ["corpus/thresholds.json", "thresholdsSha256"],
    ["corpus/mappings/dqa-categories.json", "dqaCategoryMappingSha256"],
  ];
  for (const [path, binding] of expectedBindings) {
    const value = bytes.get(path);
    if (!value || sha256(value) !== descriptor.bindings[binding]) fail("digest-mismatch");
  }
  const workflowBytes = bytes.get(descriptor.runtimeBindings.workflow.path);
  if (
    !workflowBytes ||
    sha256(workflowBytes) !== descriptor.runtimeBindings.workflow.sha256 ||
    descriptor.runtimeBindings.workflow.sha256 !== descriptor.bindings.workflowSha256
  ) {
    fail("digest-mismatch");
  }
  const compositionSubjectBytes = bytes.get(NATIVE_PILOT_CORPUS_PATHS.compositionSubject);
  if (!compositionSubjectBytes) fail("file-set-mismatch");
  let compositionSubject: NativePilotCompositionSubjectV1;
  try {
    compositionSubject = parseCompositionSubject(parseJsonEvidence(compositionSubjectBytes));
  } catch {
    fail("invalid-value");
  }
  if (
    compositionSubject.sourceRevision !== "b4ae437de0c761f0346cbf9eb9bdfec82508065b" ||
    compositionSubject.digests.workflowSha256 !== descriptor.bindings.workflowSha256
  ) {
    fail("digest-mismatch");
  }
  const skillSetBytes = bytes.get("corpus/skill-set.json");
  if (!skillSetBytes) fail("file-set-mismatch");
  let frozenSkillSet: unknown;
  try {
    frozenSkillSet = parseJsonEvidence(skillSetBytes);
  } catch {
    fail("invalid-value");
  }
  const frozenSkillSetRoot = kit.object(frozenSkillSet);
  kit.exact(frozenSkillSetRoot, ["schemaVersion", "kind", "sourceLockSha256", "orderedSkills"]);
  const frozenOrderedSkills = kit.array(frozenSkillSetRoot.orderedSkills);
  if (
    frozenSkillSetRoot.schemaVersion !== 1 ||
    frozenSkillSetRoot.kind !== "docsfab-model-comparison-skill-set" ||
    frozenOrderedSkills.length !== NATIVE_PILOT_STEP_IDS.length ||
    frozenOrderedSkills.some(
      (entry, index) => kit.object(entry).id !== NATIVE_PILOT_STEP_IDS[index],
    )
  ) {
    fail("digest-mismatch");
  }
  const activeSkillLockBytes = bytes.get(descriptor.runtimeBindings.skillLock.path);
  const activeSkillSetBytes = bytes.get(descriptor.runtimeBindings.skillSet.path);
  const activeQualityPackBytes = bytes.get(descriptor.runtimeBindings.qualityPack.path);
  if (!activeSkillLockBytes || !activeSkillSetBytes || !activeQualityPackBytes) {
    fail("file-set-mismatch");
  }
  if (
    sha256(activeSkillLockBytes) !== descriptor.runtimeBindings.skillLock.sha256 ||
    sha256(activeSkillSetBytes) !== descriptor.runtimeBindings.skillSet.sha256 ||
    sha256(activeQualityPackBytes) !== descriptor.runtimeBindings.qualityPack.sha256 ||
    descriptor.runtimeBindings.skillSet.sourceLockSha256 !==
      descriptor.runtimeBindings.skillLock.sha256 ||
    descriptor.bindings.workflowSha256 !== descriptor.runtimeBindings.workflow.sha256 ||
    descriptor.bindings.skillSetSha256 !== descriptor.runtimeBindings.skillSet.sha256 ||
    descriptor.bindings.qualityPackSha256 !== descriptor.runtimeBindings.qualityPack.sha256 ||
    descriptor.bindings.qualityPackBindingSha256 !==
      descriptor.runtimeBindings.qualityPack.bindingSha256
  ) {
    fail("digest-mismatch");
  }
  let activeSkillLock: unknown;
  let activeSkillSet: unknown;
  let activeQualityPack: unknown;
  try {
    activeSkillLock = parseJsonEvidence(activeSkillLockBytes);
    activeSkillSet = parseJsonEvidence(activeSkillSetBytes);
    activeQualityPack = parseJsonEvidence(activeQualityPackBytes);
  } catch {
    fail("invalid-value");
  }
  const activeSkillSetRoot = kit.object(activeSkillSet);
  kit.exact(activeSkillSetRoot, ["schemaVersion", "kind", "sourceLockSha256", "orderedSkills"]);
  if (
    activeSkillSetRoot.schemaVersion !== 1 ||
    activeSkillSetRoot.kind !== "docsfab-active-model-comparison-skill-set" ||
    activeSkillSetRoot.sourceLockSha256 !== descriptor.runtimeBindings.skillLock.sha256
  ) {
    fail("digest-mismatch");
  }
  const orderedSkills = kit.array(activeSkillSetRoot.orderedSkills);
  if (orderedSkills.length !== descriptor.runtimeBindings.skills.length) fail("digest-mismatch");
  const activeSkillLockRoot = kit.object(activeSkillLock);
  const activeSkillLockEntries = kit.array(activeSkillLockRoot.skills);
  if (
    activeSkillLockRoot.schemaVersion !== 1 ||
    activeSkillLockEntries.length < orderedSkills.length
  ) {
    fail("digest-mismatch");
  }
  const activeSkillLockById = new Map(
    activeSkillLockEntries.map((entry) => {
      const locked = kit.object(entry);
      return [kit.identifier(locked.id), locked] as const;
    }),
  );
  if (activeSkillLockById.size !== activeSkillLockEntries.length) fail("digest-mismatch");
  descriptor.runtimeBindings.skills.forEach((skill, index) => {
    const expected = kit.object(orderedSkills[index]);
    kit.exact(expected, ["id", "contentSha256", "bundleSha256"]);
    const locked = activeSkillLockById.get(skill.id);
    const skillBytes = bytes.get(skill.path);
    if (
      !locked ||
      expected.id !== skill.id ||
      expected.contentSha256 !== skill.sha256 ||
      expected.bundleSha256 !== skill.bundleSha256 ||
      locked.contentSha256 !== skill.sha256 ||
      locked.bundleSha256 !== skill.bundleSha256 ||
      !skillBytes ||
      sha256(skillBytes) !== skill.sha256
    ) {
      fail("digest-mismatch");
    }
    for (const file of skill.files) {
      const fileBytes = bytes.get(file.path);
      const manifestFile = manifest.files.find((candidate) => candidate.path === file.path);
      if (
        !fileBytes ||
        !manifestFile ||
        file.sha256 !== manifestFile.sha256 ||
        file.mode !== manifestFile.mode ||
        sha256(fileBytes) !== file.sha256
      ) {
        fail("digest-mismatch");
      }
    }
  });
  const qualityPackRoot = kit.object(activeQualityPack);
  kit.exact(qualityPackRoot, [
    "schemaVersion",
    "id",
    "version",
    "skillCrate",
    "quality",
    "bindingSha256",
  ]);
  const qualityPackSkillCrate = kit.object(qualityPackRoot.skillCrate);
  kit.exact(qualityPackSkillCrate, ["lockPath", "lockSha256", "skillIds"]);
  const qualityPackQuality = kit.object(qualityPackRoot.quality);
  kit.exact(qualityPackQuality, ["lockPath", "lockSha256", "bundleSha256", "barIds"]);
  const qualityPackSkillIds = kit
    .array(qualityPackSkillCrate.skillIds)
    .map((id) => kit.identifier(id));
  if (
    qualityPackRoot.schemaVersion !== 1 ||
    qualityPackRoot.id !== "docsfab-default" ||
    qualityPackRoot.version !== "1.0.0" ||
    qualityPackSkillCrate.lockPath !== "../skill-crate/lock.json" ||
    qualityPackSkillCrate.lockSha256 !== descriptor.runtimeBindings.skillLock.sha256 ||
    canonicalDigest(qualityPackSkillIds) !== canonicalDigest([...activeSkillLockById.keys()]) ||
    qualityPackQuality.lockPath !== "../quality/lock.json" ||
    sha256(
      `${kit.hash(qualityPackSkillCrate.lockSha256)}\n${kit.hash(qualityPackQuality.lockSha256)}\n`,
    ) !== descriptor.runtimeBindings.qualityPack.bindingSha256 ||
    qualityPackRoot.bindingSha256 !== descriptor.runtimeBindings.qualityPack.bindingSha256 ||
    qualityPackQuality.lockSha256 !== descriptor.runtimeBindings.qualityLock.sha256
  ) {
    fail("digest-mismatch");
  }
  assertBoundQualityFiles(manifest, descriptor, bytes);
  const sourceManifestBytes = bytes.get(NATIVE_PILOT_CORPUS_PATHS.sourceManifest);
  if (!sourceManifestBytes) fail("file-set-mismatch");
  let sourceManifest: unknown;
  try {
    sourceManifest = parseJsonEvidence(sourceManifestBytes);
  } catch {
    fail("invalid-value");
  }
  kit.assertInert(sourceManifest);
  kit.rejectCredentials(sourceManifest);
  const root = kit.object(sourceManifest);
  const repository = kit.object(root.repository);
  const repositoryGitTree = kit.revision(repository.gitTree);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-model-comparison-corpus" ||
    root.id !== NATIVE_PILOT_CORPUS_ID ||
    root.track !== descriptor.sourceTrack ||
    root.fixtureSha256 !== descriptor.bindings.sourceFixtureSha256 ||
    root.compositionSubjectSha256 !== descriptor.bindings.compositionSubjectSha256 ||
    root.skillSetSha256 !== sha256(skillSetBytes) ||
    root.revision !== descriptor.repositoryRevision ||
    root.repositoryTreeSha256 !== descriptor.bindings.repositoryTreeSha256
  ) {
    fail("digest-mismatch");
  }
  return { repositoryGitTree, compositionSubject };
}

/** Bind each linked quality file to the staged quality lock the pack names. */
function assertBoundQualityFiles(
  manifest: InstalledManifest,
  descriptor: CrossHarnessDescriptor,
  bytes: ReadonlyMap<string, Buffer>,
): void {
  const lockBytes = bytes.get(descriptor.runtimeBindings.qualityLock.path);
  if (!lockBytes) fail("file-set-mismatch");
  if (sha256(lockBytes) !== descriptor.runtimeBindings.qualityLock.sha256) {
    fail("digest-mismatch");
  }
  let lock: unknown;
  try {
    lock = parseJsonEvidence(lockBytes);
  } catch {
    fail("invalid-value");
  }
  const lockRoot = kit.object(lock);
  // Version 2 is the lock contract the runtime admits; it carries productDefaults.
  if (lockRoot.schemaVersion !== 2) fail("digest-mismatch");
  const locked = new Map(
    kit.array(lockRoot.files).map((entry) => {
      const file = kit.object(entry);
      return [safePath(file.path), kit.hash(file.sha256)] as const;
    }),
  );
  for (const skill of descriptor.runtimeBindings.skills) {
    for (const file of skill.qualityFiles) {
      const fileBytes = bytes.get(file.path);
      const manifestFile = manifest.files.find((candidate) => candidate.path === file.path);
      if (
        !fileBytes ||
        !manifestFile ||
        file.sha256 !== manifestFile.sha256 ||
        file.mode !== manifestFile.mode ||
        sha256(fileBytes) !== file.sha256 ||
        locked.get(file.relativePath) !== file.sha256
      ) {
        fail("digest-mismatch");
      }
    }
  }
}

function verifierFor(authority: InstalledNativePilotCorpusAuthority): CorpusVerifier {
  const verifier = authorityFactory.lookup(authority);
  if (!verifier?.verifyCurrent()) fail("authority-invalid");
  return verifier;
}

async function listKitFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail("unsafe-path");
    if (entry.isDirectory()) files.push(...(await listKitFiles(directory, path)));
    else files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function loadFromTrustedProjectRoot(projectRoot: string): Promise<{
  authority: InstalledNativePilotCorpusAuthority;
  snapshot: NativePilotCorpusSnapshot;
}> {
  const directory = await resolveTrustedKitDirectory(projectRoot);
  const manifestPath = resolve(directory, INSTALLED_MANIFEST_PATH);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch {
    fail("asset-read-failed");
  }
  const installedManifestFileSha256 = sha256(manifestBytes);
  let manifestValue: unknown;
  try {
    manifestValue = parseJsonEvidence(manifestBytes);
  } catch {
    fail("invalid-value");
  }
  const manifest = parseInstalledManifest(manifestValue);
  let kitPaths: string[];
  try {
    kitPaths = await listKitFiles(directory);
  } catch (error) {
    if (error instanceof NativePilotCorpusError) throw error;
    fail("asset-read-failed");
  }
  const expectedPaths = [...manifest.files.map((file) => file.path), INSTALLED_MANIFEST_PATH].sort(
    (left, right) => left.localeCompare(right),
  );
  if (JSON.stringify(kitPaths) !== JSON.stringify(expectedPaths)) fail("file-set-mismatch");
  const values = await Promise.all(
    manifest.files.map(async (file) => [file.path, await readLockedFile(directory, file)] as const),
  );
  const aggregateBytes = values.reduce((total, [, bytes]) => total + bytes.byteLength, 0);
  if (aggregateBytes > MAX_KIT_AGGREGATE_BYTES) fail("invalid-value");
  const bytes = new Map<string, Buffer>(values.map(([path, value]) => [path, Buffer.from(value)]));
  const descriptorBytes = bytes.get(manifest.descriptorPath);
  const descriptorFile = manifest.files.find((file) => file.path === manifest.descriptorPath);
  if (!descriptorBytes || !descriptorFile || sha256(descriptorBytes) !== descriptorFile.sha256) {
    fail("checksum-mismatch");
  }
  let descriptorValue: unknown;
  try {
    descriptorValue = parseJsonEvidence(descriptorBytes);
  } catch {
    fail("invalid-value");
  }
  const descriptor = parseDescriptor(descriptorValue);
  const { repositoryGitTree, compositionSubject } = assertBoundInputs(manifest, descriptor, bytes);
  bytes.set(INSTALLED_MANIFEST_PATH, Buffer.from(manifestBytes));
  const governedBundleSha256 = fileBundleSha256([
    ...manifest.files,
    { path: INSTALLED_MANIFEST_PATH, sha256: installedManifestFileSha256, mode: "100644" },
  ]);
  const snapshot: NativePilotCorpusSnapshot = deepFreeze({
    corpusId: NATIVE_PILOT_CORPUS_ID,
    track: descriptor.track,
    evidenceClass: descriptor.evidenceClass,
    fixtureSha256: descriptor.fixtureSha256,
    sourceFixtureSha256: descriptor.bindings.sourceFixtureSha256,
    installedManifestSha256: manifest.installedManifestSha256,
    installedManifestFileSha256,
    descriptorSha256: descriptor.descriptorSha256,
    governedBundleSha256,
    repositoryRevision: descriptor.repositoryRevision,
    repositoryGitTree,
    repositoryTreeSha256: descriptor.bindings.repositoryTreeSha256,
    allowedPage: descriptor.allowedPage,
    compositionIds: NATIVE_PILOT_COMPOSITION_IDS,
    limits: descriptor.limits,
    files: manifest.files.map((file) => ({ ...file })),
    paths: NATIVE_PILOT_CORPUS_PATHS,
    runtimeBindings: descriptor.runtimeBindings,
    sourceProvenance: descriptor.sourceProvenance,
    compositionSubject,
  });
  const verifier: CorpusVerifier = {
    manifest,
    descriptor,
    snapshot,
    bytes,
    verifyCurrent: () => true,
  };
  return {
    authority: authorityFactory.create(verifier) as InstalledNativePilotCorpusAuthority,
    snapshot,
  };
}

/** Load the single package-bound cross-harness corpus from the installed runtime. */
export async function loadInstalledNativePilotCorpusAuthority(): Promise<{
  authority: InstalledNativePilotCorpusAuthority;
  snapshot: NativePilotCorpusSnapshot;
}> {
  return loadFromTrustedProjectRoot(resolveDocsFabProjectRoot());
}

/** Resolve the immutable corpus descriptor without exposing its installed host path. */
export function resolveInstalledNativePilotCorpus(input: {
  readonly authority: InstalledNativePilotCorpusAuthority;
  readonly corpusId: string;
}): BoundNativePilotCorpus {
  kit.assertInert(input);
  const root = kit.object(input);
  kit.exact(root, ["authority", "corpusId"]);
  if (root.corpusId !== NATIVE_PILOT_CORPUS_ID) fail("unknown-corpus");
  const verifier = verifierFor(root.authority as InstalledNativePilotCorpusAuthority);
  return deepFreeze({
    ...verifier.snapshot,
    bindings: { ...verifier.descriptor.bindings },
  });
}

/** Return a fresh copy of one exact locked kit file. Paths are kit-relative. */
export function readInstalledNativePilotCorpusFile(input: {
  readonly authority: InstalledNativePilotCorpusAuthority;
  readonly path: string;
}): Buffer {
  kit.assertInert(input);
  const root = kit.object(input);
  kit.exact(root, ["authority", "path"]);
  const verifier = verifierFor(root.authority as InstalledNativePilotCorpusAuthority);
  const path = safePath(root.path);
  const bytes = verifier.bytes.get(path);
  if (!bytes) fail("unsafe-path");
  return Buffer.from(bytes);
}

/** Internal test seam; it is intentionally not re-exported by the package barrel. */
export async function loadInstalledNativePilotCorpusAuthorityFromTrustedRootForTest(
  projectRoot: string,
): Promise<{
  authority: InstalledNativePilotCorpusAuthority;
  snapshot: NativePilotCorpusSnapshot;
}> {
  return loadFromTrustedProjectRoot(projectRoot);
}
