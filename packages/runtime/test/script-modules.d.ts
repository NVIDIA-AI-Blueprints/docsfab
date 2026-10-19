// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

declare module "*scripts/bwrap-behavior-probe.mjs" {
  export function buildBwrapArguments(scratch: string, hostTmpSentinel: string): string[];
}

declare module "*scripts/check-ci-heavy-manifest.mjs" {
  export function allHeavyFiles(): string[];
}

declare module "*scripts/vitest-ci.mjs" {
  export const smokeFiles: string[];
}

declare module "*scripts/dogfood/create-documentation-no-doc/plan.mjs" {
  export const CREATE_DOCUMENTATION_INSTRUCTION: string;
  export const CRATE_STEPS: readonly string[];
  export function runtimeRootFromHere(here?: string): string;
  export function factoryRootFromRuntime(runtimeRoot: string): string;
  export function assertNotFactoryPath(repositoryPath: string, factoryRoot: string): void;
  export function initPreviewArgv(repositoryPath: string): string[];
  export function initApplyArgv(repositoryPath: string, planSha256: string): string[];
  export function createDocumentationArgv(repositoryPath: string): string[];
  export function extractInitPlanSha256(stdout: string): unknown;
  export function extractRunResult(stdout: string): {
    runId: string;
    recordPath: string;
    exitCode: unknown;
  };
  export function crateStepStatuses<Id, Status = unknown>(record: {
    readonly steps: ReadonlyArray<{ readonly id: Id; readonly status?: Status }>;
  }): Array<{ id: Id; status: Status | "unknown" }>;
  export function assertCrateSteps<Id>(record: {
    readonly steps: ReadonlyArray<{ readonly id: Id }>;
  }): Id[];
  export function assertCrateSteps(record: unknown): unknown[];
  export function parseCliArgs(argv: readonly string[]): {
    live: boolean;
    keep: boolean;
    remoteUrl?: string;
  };
  export function noDocFixturePath(runtimeRoot: string): string;
  export function copyNoDocFixture(runtimeRoot: string, destination: string): Promise<void>;
  export function initializeThrowawayGit(
    repositoryPath: string,
    remoteUrl: string | null,
  ): Promise<void>;
  export function sanitizeOriginUrl(url: unknown, label?: string): string;
  export function requireUncredentialedRemoteUrl(url: unknown): string;
  export const REMOTE_REQUIRED_CODE: string;
  export const REMOTE_REQUIRED_REMEDIATION: string;
  export type ThrowawayRemote =
    | { source: "argument" | "factory-origin"; url: string }
    | { source: "none"; url: null };
  export function resolveThrowawayRemote(
    factoryRoot: string,
    remoteUrl: string | undefined,
  ): Promise<ThrowawayRemote>;
  export function requireLiveRemote(remote: ThrowawayRemote): string;
  export function remoteReport(remote: ThrowawayRemote): Record<string, string>;
  export const RUNTIME_ENV_REMEDIATION: string;
  export function provisionRuntimeEnv(runtimeRoot: string, configRoot: string): Promise<string>;
  export const LAUNCHER_MAX_BUFFER_LIMIT: string;
  export interface CatalogBound {
    name: string;
    value: number;
    unit: string;
    refusal: string;
    remediation: string;
  }
  export function readCatalogLimit(factoryRoot: string, name: string): Promise<CatalogBound>;
  export function captureBounded(
    command: string,
    argv: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
    bound: CatalogBound,
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

declare module "*scripts/check-dependency-exceptions.mjs" {
  export interface DependencyException {
    pi: string;
    minimatch: string;
    minimatchBraceRange: string;
    braceExpansion: string;
    reviewOn: string;
  }
  export interface DependencyPackageJson {
    readonly dependencies?: Readonly<Record<string, string | undefined>>;
  }
  export interface DependencyLockPackage {
    readonly version?: string;
    readonly dev?: boolean;
    readonly hasShrinkwrap?: boolean;
    readonly dependencies?: Readonly<Record<string, string | undefined>>;
  }
  export interface DependencyLock {
    readonly packages?: Readonly<Record<string, DependencyLockPackage | undefined>>;
  }
  export const activeException: DependencyException | null;
  export function validateDependencyState(input: {
    packageJson: DependencyPackageJson;
    lock: DependencyLock;
    today: string;
    exception?: DependencyException | null;
  }): string[];
}

declare module "*scripts/resolve-typescript-compiler.mjs" {
  export function resolveTypeScriptCompiler(): string;
}

declare module "*scripts/check-package-imports.mjs" {
  export interface PackageImportViolation {
    importer: string;
    spec: string;
    resolved: string;
    prefix: string;
  }
  export function findPackageImportViolations(options?: {
    root?: string;
    importers?: readonly string[];
  }): PackageImportViolation[];
}

declare module "*scripts/lib/packed-cli.mjs" {
  export function parseNpmPackJson(stdout: string): unknown;
}

declare module "*scripts/lib/staged-output.mjs" {
  export function replaceDirectoryAfterBuild(
    target: string,
    build: (staging: string) => Promise<void>,
    options?: { rename?: (from: string, to: string) => Promise<void> },
  ): Promise<void>;
}

declare module "*scripts/verify-release-artifact.mjs" {
  export interface VerifiedReleaseArtifact {
    readonly name: string;
    readonly version: string;
    readonly sourceRevision: string;
    readonly integrity: string;
    readonly tarballPath: string;
  }
  export function verifyReleaseArtifact(input: {
    projectRoot: string;
    artifactRoot: string;
    commitTag: string | undefined;
    commitSha: string | undefined;
  }): Promise<VerifiedReleaseArtifact>;
}

declare module "*scripts/check-soft-deps.mjs" {
  export interface SoftDependencyRule {
    readonly id: string;
    readonly description: string;
    readonly from: readonly string[];
    readonly forbid: readonly string[];
  }
  export interface SoftDependencyException {
    readonly rule: string;
    readonly importer: string;
    readonly imported: string;
    readonly reason?: string;
    readonly tracking?: string;
  }
  export interface SoftDependencyEdge {
    fromPackage: string;
    toPackage: string;
    importer: string;
    imported: string;
    spec: string;
  }
  export interface SoftDependencyViolation extends SoftDependencyEdge {
    rule: string;
    description: string;
  }
  export interface SoftDependencyResult {
    violations: SoftDependencyViolation[];
    edges: SoftDependencyEdge[];
    staleExceptions: string[];
    exceptions: readonly SoftDependencyException[];
  }
  export const RULES: readonly SoftDependencyRule[];
  export const ALLOWED_AUTONOMY_IMPORTS: readonly string[];
  export function findSoftDependencyViolations(options?: {
    exceptions?: readonly SoftDependencyException[];
    srcRoot?: string;
  }): SoftDependencyResult;
}

declare module "*bin/source-checkout-refresh.mjs" {
  export function isSourceCheckout(packageRoot: string): boolean;
  export function shouldRefreshCompiledLauncher(
    packageRoot: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<boolean>;
  export function compiledLauncherWatchPaths(packageRoot: string): Promise<string[]>;
  export function refreshCompiledLauncherIfStale(
    packageRoot: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      runBuild?: (packageRoot: string) => void;
      write?: (line: string) => void;
    },
  ): Promise<void>;
  export function compiledWorkflowCatalogMismatchesDisk(packageRoot: string): boolean;
  export function readCompiledWorkflowNames(source: string): string[] | undefined;
}
