// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants as fsConstants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { skippedHostLimitFile } from "./config/host-limit-file.js";
import {
  resolveDocsFabLiveAgentSessionDirectory,
  resolveDocsFabProjectRoot,
  resolveDocsFabConfigurationRoot,
  ConfigurationRootPermissionError,
} from "./config/host-paths.js";
import { captureConfigurationRoot, ConfigurationRootNotCanonicalError } from "./init/storage.js";
import { INIT_CONFIGURATION_ROOT_NEXT_ACTION } from "./init/render.js";
import { discoverRepository } from "./init/gitlab-probe.js";
import type { SkippedHostLimitFile } from "./config/limit-resolution.js";
import {
  summarizeLocalSessionStorage,
  type LocalSessionStorageSummaryV1,
} from "./live-agent/local-sessions.js";
import { firstPassDocumentationWriteRoots } from "./cli/first-pass.js";
import {
  DocumentationScope,
  documentationLayoutAdvice,
  type DocumentationLayoutAdvice,
} from "./live-agent/documentation-scope.js";
import { parseGitLabRemote, type ReadOnlyCommandRunner } from "./delivery/preflight.js";
import {
  ExecDoctorPublicationCommandRunner,
  ExecDoctorReadinessCommandRunner,
} from "./doctor-readiness/command-runners.js";
import type { DoctorReadinessCommandRunner } from "./doctor-readiness/command-runners.js";
export type { DoctorReadinessCommandRunner } from "./doctor-readiness/command-runners.js";
import { LocalUserPublicationPreflightError } from "./delivery/contracts.js";
import { inspectLegacyPolicyProfileReadiness } from "./setup/profile-readiness.js";
import { createModelEvidence } from "./model/profile-evidence.js";
import { configuredModelEvidenceDefectMessage } from "./model/profile-inspection.js";
import { loadConfig, type DocsFabConfig } from "./config/runtime-loader.js";
import { diagnose } from "./doctor.js";
import {
  blockedDraftMrPublicationReadiness,
  inspectDraftMrPublicationReadiness,
  notObservedDraftMrPublicationReadiness,
  type DoctorDraftMrPreconditionCode,
  type DoctorDraftMrReadiness,
} from "./doctor-publication-readiness.js";
import {
  assertDocsFabProjectConfig,
  DOCSFAB_PROJECT_CONFIG_FILE,
  resolveDocsFabPrivateRoots,
  type DocsFabProjectConfigV1,
} from "./init.js";
import { parseJsonEvidence } from "./json-evidence.js";
import {
  uncomparedConfiguredCredentials,
  type UncomparedConfiguredCredential,
} from "./security/configured-credentials.js";
import {
  inspectOutboundProxy,
  OutboundProxyRefusal,
  type OutboundProxyReport,
  type ProxyRuntime,
} from "./model/outbound-http-policy.js";
import {
  EndpointCompatibilityError,
  type EndpointCompatibilityReport,
} from "./profile/endpoint-compatibility.js";
import { remediationText } from "./operator/remediation.js";
import {
  NO_SUPPORTED_GITLAB_REMOTE_NEXT_ACTION,
  type DoctorDiagnosticCode,
} from "./operator/situation-catalog.js";
import {
  classifyProjectConfigCheckout,
  PROJECT_CONFIG_UNTRACKED_CODE,
  REPOSITORY_SOURCE_DIRTY_CODE,
  resolveProjectConfigAuthority,
  trackedHeadRegularFiles,
  trackedHeadPaths,
} from "./project-config-preflight.js";
import {
  DOCUMENTATION_SOURCE_ADAPTER_IDS,
  DOCUMENTATION_GENERATORS_WITHOUT_ADAPTER,
  resolveDocumentationSourceAdapter,
  type DocumentationSourceAdapterId,
  type DocumentationSourceCapability,
  type DocumentationSourceCapabilityState,
} from "./repository/documentation-source-support.js";
import { QualityPackError } from "./quality-pack/manifest.js";
import { reinstallAction } from "./quality-pack/restore.js";
import {
  diag,
  endpointCompatibilityDiagnostic,
  insecureEndpointDiagnostic,
  isInferenceHubMetadataField,
  liveCompatibilityOf,
  modelSettingCredentialDiagnostic,
  outboundProxyConfigurationDiagnostics,
  outboundProxyDiagnostic,
  profileIssues,
  qualityPackDiagnostic,
  retiredSelectionDiagnostic,
  type DoctorReadinessDiagnosticCode,
} from "./doctor-readiness/diagnostics.js";
import { formatDoctorReadiness } from "./doctor-readiness/render.js";
import { withRepositoryWorkspace } from "./repository/workspace/materialize.js";
import {
  probeRequiredCheckReadiness,
  type RequiredCheckReadinessLimitation,
} from "./workflow-execution/required-check-readiness.js";

export { formatDoctorReadiness, isInferenceHubMetadataField };

export { PROJECT_CONFIG_UNTRACKED_CODE, REPOSITORY_SOURCE_DIRTY_CODE, reinstallAction };
export type { DoctorDiagnosticCode };

export type DoctorReadinessArea =
  | "installation"
  | "configuration"
  | "repository"
  | "provider"
  | "gitlab"
  | "private-state"
  | "validation";

export interface DoctorDiagnostic {
  area: DoctorReadinessArea;
  code: DoctorReadinessDiagnosticCode;
  explanation: string;
  nextCommand: string;
}

export interface DoctorReadinessResult {
  schemaVersion: 1;
  kind: "docsfab-doctor-readiness";
  status: "ready" | "blocked";
  /** The use whose verdict controls status and the CLI exit code. */
  selectedUse?: DoctorUse;
  useReadiness?: Readonly<Record<DoctorUse, DoctorUseReadiness>>;
  /** Named capability limits which degrade a step without refusing the use. */
  limitations?: readonly Pick<DoctorDiagnostic, "code" | "explanation" | "nextCommand">[];
  repositoryPath: string | null;
  /** Registry states for generators identified by tracked HEAD configuration. */
  documentationGenerators?: readonly DoctorDocumentationGenerator[];
  liveConnectivity: {
    requested: boolean;
    provider: "not-requested" | "not-attempted" | "passed" | "failed";
    gitlab: "not-requested" | "not-attempted" | "passed" | "failed";
  };
  /** The live endpoint compatibility verdict; null unless the probe ran. */
  endpointCompatibility: EndpointCompatibilityReport | null;
  /**
   * Effective outbound proxy, credentials removed; read offline, never dialed.
   * Absent from results serialized before doctor reported it.
   */
  outboundProxy?: OutboundProxyReport;
  /**
   * Local live-agent session count, size, oldest age, and the age bound.
   * Informational; it never blocks readiness.
   */
  liveAgentSessions?: LocalSessionStorageSummaryV1;
  /**
   * Each configured credential source with a value a matching minimum leaves
   * uncompared, by source and rule, never the value or its length (#1807).
   * Informational; it never blocks readiness.
   */
  configuredCredentialsNotCompared?: readonly UncomparedConfiguredCredential[];
  /**
   * The installed host limits file skipped because this user cannot read it.
   * Informational; it never blocks readiness. Absent when the file was read
   * or does not exist.
   */
  hostLimitsFile?: SkippedHostLimitFile;
  checks: ReadonlyArray<{
    area: DoctorReadinessArea;
    status: "ready" | "blocked";
  }>;
  diagnostics: readonly DoctorDiagnostic[];
  validationCommand: "npm run check" | "npm test" | null;
  /** Scope reported by current doctor runs; absent from older readiness records. */
  validationScope?: {
    readiness: "prerequisites-only";
    deliveryConfinement: "not-checked";
  };
  repositoryRevision: string | null;
  /** Operator checkout branch, or null when HEAD is not on one safe branch. */
  checkoutBranch: string | null;
  /** Operator checkout tip; the same exact identity as `repositoryRevision`. */
  checkoutRevision: string | null;
  /** Project authority used by local execution, separate from host model configuration. */
  projectConfiguration?: {
    readonly authority: "tracked" | "defaults" | "invalid";
    readonly effectiveRevision: string | null;
    readonly effectiveRoots: readonly string[];
    readonly checkout:
      | "clean"
      | "missing"
      | "ignored"
      | "untracked"
      | "staged"
      | "modified"
      | "unknown";
  };
  /** Live GitLab target branch, or null when it could not be observed. */
  gitlabTargetBranch: string | null;
  /** Live GitLab target-branch head, or null when it could not be observed. */
  gitlabTargetRevision: string | null;
  /** Whether `--draft-mr` would publish from this checkout, and why not. */
  draftMrReadiness: DoctorDraftMrReadiness;
  /** Exact next argv while draft-MR publication is not ready; null when ready. */
  remediationArgv: readonly string[] | null;
  autoModesReady: readonly ("dry-run" | "patch-only" | "draft-mr")[];
}

export interface DoctorDocumentationGenerator {
  readonly root: string;
  readonly generator: string;
  readonly configurationPaths: readonly string[];
  /** Null when the registry inventories a generator without an adapter. */
  readonly adapterId: DocumentationSourceAdapterId | null;
  readonly capabilities: Readonly<
    Record<DocumentationSourceCapability, DocumentationSourceCapabilityState>
  > | null;
}

/** Detection is informational; workflow applicability still binds candidate bytes. */
function detectDocumentationGenerators(
  paths: readonly string[],
): readonly DoctorDocumentationGenerator[] {
  const locations = [
    ...DOCUMENTATION_SOURCE_ADAPTER_IDS.flatMap((id) =>
      resolveDocumentationSourceAdapter(id).configurationLocations.map((location) => ({
        generator: id as string,
        location,
      })),
    ),
    ...Object.entries(DOCUMENTATION_GENERATORS_WITHOUT_ADAPTER).flatMap(([generator, entry]) =>
      entry.configurationLocations.map((location) => ({ generator, location })),
    ),
  ].sort((left, right) => right.location.length - left.location.length);
  const detected = new Map<string, { root: string; generator: string; paths: string[] }>();
  for (const path of paths) {
    // A longer location wins, so docs/conf.py is not also a root-level conf.py.
    const match = locations.find(
      ({ location }) => path === location || path.endsWith(`/${location}`),
    );
    if (!match) continue;
    const root = path === match.location ? "." : path.slice(0, -match.location.length - 1);
    const key = `${root}\0${match.generator}`;
    const entry = detected.get(key) ?? { root, generator: match.generator, paths: [] };
    entry.paths.push(path);
    detected.set(key, entry);
  }
  if (detected.size === 0 && paths.some((path) => /\.mdx?$/u.test(path))) {
    detected.set(".\0plain-markdown", { root: ".", generator: "plain-markdown", paths: [] });
  }
  return [...detected.values()]
    .sort((left, right) =>
      left.root < right.root
        ? -1
        : left.root > right.root
          ? 1
          : left.generator < right.generator
            ? -1
            : left.generator > right.generator
              ? 1
              : 0,
    )
    .map(({ root, generator, paths: configurationPaths }) => {
      const adapterId = (DOCUMENTATION_SOURCE_ADAPTER_IDS as readonly string[]).includes(generator)
        ? (generator as DocumentationSourceAdapterId)
        : null;
      return {
        root,
        generator,
        configurationPaths: configurationPaths.sort(),
        adapterId,
        capabilities: adapterId ? resolveDocumentationSourceAdapter(adapterId).capabilities : null,
      };
    });
}

export type DoctorUse = "local-review" | "local-patch" | "draft-mr";

export interface DoctorUseReadiness {
  readonly status: "ready" | "blocked" | "unknown";
  readonly checks: DoctorReadinessResult["checks"];
  readonly diagnostics: readonly DoctorDiagnostic[];
  readonly blockers?: readonly DoctorReadinessDiagnosticCode[];
}

export interface DoctorReadinessOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  live?: boolean;
  use?: DoctorUse;
  /** Test seam for host-native check availability. */
  platform?: NodeJS.Platform;
  /** Test seam for the host's required-check isolation probe. */
  probeRequiredCheckReadiness?: (
    repositoryRoot: string,
    revision: string,
  ) => Promise<RequiredCheckReadinessLimitation | undefined>;
  commands?: DoctorReadinessCommandRunner;
  /**
   * Read-only git/glab seam for the shared GitLab target observation. Defaults
   * to `commands` when supplied, so one injected fake drives the whole doctor.
   */
  publicationCommands?: ReadOnlyCommandRunner;
  loadConfiguration?: () => DocsFabConfig;
  validateConfiguration?: (config: DocsFabConfig) => Promise<unknown>;
  checkProviderConnectivity?: (config: DocsFabConfig) => Promise<unknown>;
  checkPrivateAccess?: (path: string) => Promise<void>;
  /** Test seam for Node's proxy capability; defaults to this process. */
  proxyRuntime?: ProxyRuntime;
}

const AREAS: readonly DoctorReadinessArea[] = [
  "installation",
  "configuration",
  "repository",
  "provider",
  "gitlab",
  "private-state",
  "validation",
];

/** Publication setup does not gate a local run from a revision-bound workspace. */
const PUBLICATION_ONLY_CODES: ReadonlySet<DoctorReadinessDiagnosticCode> = new Set([
  "project-config-missing",
  "no-supported-gitlab-remote",
  "project-config-invalid",
  "project-config-untracked",
  "repository-state-blocked",
  "repository-source-dirty",
  "git-identity-missing",
  "runtime-glab-missing",
  "gitlab-project-mismatch",
  "gitlab-login-missing",
  "gitlab-login-unverified",
  "gitlab-live-unavailable",
  "private-state-missing",
  "private-state-unsafe",
]);

/** A committed invalid project file is also read by the local bootstrap. */
function appliesToLocalUse(
  diagnostic: DoctorDiagnostic,
  committedProjectConfigInvalid: boolean,
): boolean {
  return (
    !PUBLICATION_ONLY_CODES.has(diagnostic.code) ||
    (diagnostic.code === "project-config-invalid" && committedProjectConfigInvalid)
  );
}

function useView(
  use: DoctorUse,
  diagnostics: readonly DoctorDiagnostic[],
  blockingCodes: ReadonlySet<DoctorReadinessDiagnosticCode>,
  publication: DoctorDraftMrReadiness,
  publicationRemediationArgv: readonly string[] | null,
  committedProjectConfigInvalid: boolean,
): DoctorUseReadiness {
  const active = diagnostics;
  const blockers = active.filter(
    (diagnostic) =>
      blockingCodes.has(diagnostic.code) &&
      (use === "draft-mr" || appliesToLocalUse(diagnostic, committedProjectConfigInvalid)),
  );
  if (use === "draft-mr") {
    if (publication.state === "not-observed") {
      blockers.push(
        diag(
          "gitlab",
          "gitlab-target-not-observed",
          publication.reason,
          "docsfab doctor --live --use draft-mr",
        ),
      );
    } else if (publication.state !== "ready") {
      blockers.push(
        diag(
          "gitlab",
          "draft-mr-publication-blocked",
          publication.reason,
          publicationRemediationArgv?.join(" ") ?? "docsfab doctor --live --use draft-mr",
        ),
      );
    }
  }
  const blockedAreas = new Set(blockers.map((diagnostic) => diagnostic.area));
  const checks = AREAS.filter(
    (area) => use === "draft-mr" || (area !== "gitlab" && area !== "private-state"),
  ).map((area) => ({
    area,
    status: blockedAreas.has(area) ? ("blocked" as const) : ("ready" as const),
  }));
  return {
    status:
      blockers.length > 0
        ? "blocked"
        : use === "draft-mr" && publication.state === "unknown"
          ? "unknown"
          : "ready",
    checks,
    diagnostics: [...active, ...blockers.filter((item) => !active.includes(item))],
    blockers: blockers.map((item) => item.code),
  };
}

/**
 * Advice when the checkout keeps its pages outside every recognized
 * documentation directory, under the same scope the live agent applies. It is
 * advisory: an uninspectable checkout adds nothing here, and the repository
 * checks above and the write paths themselves report it.
 */
async function inspectDocumentationLayoutAdvice(
  repositoryRoot: string,
  effectiveRoots: readonly string[],
): Promise<DocumentationLayoutAdvice | undefined> {
  try {
    const scope = new DocumentationScope(
      [],
      effectiveRoots.filter((root) => root.endsWith("/")),
      effectiveRoots.filter((root) => !root.endsWith("/")),
    );
    return documentationLayoutAdvice(await scope.inspectLayout(repositoryRoot));
  } catch {
    return undefined;
  }
}

/** Catalog `init` row: preview, then digest-bound apply. Not bare `docsfab init --apply`. */
const INIT_PREVIEW_THEN_DIGEST_APPLY = remediationText("init");

/** Read-only readiness inspection. No command in this function is mutating. */
export async function inspectDoctorReadiness(
  options: DoctorReadinessOptions = {},
): Promise<DoctorReadinessResult> {
  const cwd = await canonicalDirectory(options.cwd ?? process.cwd()).catch(() =>
    resolve(options.cwd ?? process.cwd()),
  );
  const environment = options.environment ?? process.env;
  const commands = options.commands ?? new ExecDoctorReadinessCommandRunner(environment);
  const diagnostics: DoctorDiagnostic[] = [];
  const blocked = new Set<DoctorReadinessArea>();
  const blockingCodes = new Set<DoctorReadinessDiagnosticCode>();
  let providerConnectivity: DoctorReadinessResult["liveConnectivity"]["provider"] = options.live
    ? "not-attempted"
    : "not-requested";
  let gitlabConnectivity: DoctorReadinessResult["liveConnectivity"]["gitlab"] = options.live
    ? "not-attempted"
    : "not-requested";
  let repositoryRevision: string | null = null;
  let checkoutBranch: string | null = null;
  let gitlabLiveHost: string | undefined;
  let gitlabLiveRepository: string | undefined;
  let endpointCompatibility: EndpointCompatibilityReport | null = null;
  let gitlabHost: string | undefined;
  let draftMrPrecondition: DoctorDraftMrPreconditionCode | undefined;
  const add = (diagnostic: DoctorDiagnostic, blocking = true): void => {
    if (
      !diagnostics.some((item) => item.code === diagnostic.code && item.area === diagnostic.area)
    ) {
      diagnostics.push(diagnostic);
    }
    if (blocking) {
      blocked.add(diagnostic.area);
      blockingCodes.add(diagnostic.code);
    }
  };

  try {
    await captureConfigurationRoot(
      resolveDocsFabConfigurationRoot(environment),
      options.homeDirectory ?? homedir(),
    );
  } catch (error) {
    if (error instanceof ConfigurationRootNotCanonicalError) {
      add(
        diag(
          "configuration",
          "configuration-root-not-canonical",
          error.message,
          INIT_CONFIGURATION_ROOT_NEXT_ACTION,
        ),
      );
    } else if (error instanceof ConfigurationRootPermissionError) {
      add(diag("configuration", "configuration-root-not-private", error.message, error.nextAction));
    }
  }

  if (!(await installationReady())) {
    add(
      diag(
        "installation",
        "installation-invalid",
        "The installed package is missing its immutable governed assets.",
        reinstallAction(),
      ),
    );
  }

  const gitVersion = await commands.run("git", ["--version"], cwd);
  if (gitVersion.exitCode !== 0) {
    add(
      diag(
        "repository",
        "runtime-git-missing",
        "The git runtime required for repository inspection is unavailable.",
        "git --version",
      ),
    );
    draftMrPrecondition ??= "runtime-git-missing";
  }

  let repositoryRoot: string | undefined;
  let projectConfig: DocsFabProjectConfigV1 | undefined;
  let projectConfiguration: DoctorReadinessResult["projectConfiguration"];
  let committedProjectConfigInvalid = false;
  if (gitVersion.exitCode === 0) {
    const top = await commands.run("git", ["rev-parse", "--show-toplevel"], cwd);
    if (top.exitCode !== 0 || !top.stdout.trim()) {
      add(
        diag(
          "repository",
          "repository-unattached",
          "The current directory is not attached to a Git worktree.",
          "cd <repository> && docsfab doctor --repo <path>",
        ),
      );
    } else {
      repositoryRoot = await canonicalDirectory(top.stdout.trim()).catch(() => undefined);
      if (!repositoryRoot) {
        add(
          diag(
            "repository",
            "repository-unattached",
            "Git reported a repository root that is unavailable.",
            "cd <repository> && docsfab doctor",
          ),
        );
      } else {
        const branch = await commands.run(
          "git",
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          repositoryRoot,
        );
        if (branch.exitCode === 0 && safeIdentity(branch.stdout.trim())) {
          checkoutBranch = branch.stdout.trim();
        }
        if (branch.exitCode !== 0 || !safeIdentity(branch.stdout.trim())) {
          add(
            diag(
              "repository",
              "repository-state-blocked",
              "The repository must be on one safely named branch for autonomous work.",
              "git switch <branch>",
            ),
          );
        }
        const exactHead = await commands.run(
          "git",
          ["rev-parse", "--verify", "HEAD^{commit}"],
          repositoryRoot,
        );
        if (exactHead.exitCode === 0) {
          const candidate = exactHead.stdout.trim();
          if (!exactRevision(candidate)) {
            add(
              diag(
                "repository",
                "repository-revision-invalid",
                "Git returned an invalid HEAD commit identity.",
                "git fsck --full",
              ),
            );
          } else {
            const accessible = await commands.run(
              "git",
              ["cat-file", "-e", `${candidate}^{commit}`],
              repositoryRoot,
            );
            if (accessible.exitCode !== 0) {
              add(
                diag(
                  "repository",
                  "repository-revision-inaccessible",
                  "The exact HEAD commit object is not locally accessible.",
                  "git fetch --all --prune",
                ),
              );
            } else {
              repositoryRevision = candidate;
            }
          }
        } else {
          const rawHead = await commands.run(
            "git",
            ["rev-parse", "--verify", "HEAD"],
            repositoryRoot,
          );
          if (rawHead.exitCode === 0) {
            add(
              diag(
                "repository",
                exactRevision(rawHead.stdout.trim())
                  ? "repository-revision-inaccessible"
                  : "repository-revision-invalid",
                exactRevision(rawHead.stdout.trim())
                  ? "HEAD names a revision whose commit object is not locally accessible."
                  : "Git returned an invalid HEAD revision identity.",
                exactRevision(rawHead.stdout.trim())
                  ? "git fetch --all --prune"
                  : "git fsck --full",
              ),
            );
          } else if (branch.exitCode === 0) {
            add(
              diag(
                "repository",
                "repository-revision-unborn",
                "The current branch does not yet contain a commit.",
                "git commit",
              ),
            );
          } else {
            add(
              diag(
                "repository",
                "repository-revision-missing",
                "The repository has no resolvable HEAD revision.",
                "git switch <branch>",
              ),
            );
          }
        }
        const [name, email] = await Promise.all([
          commands.run("git", ["config", "--get", "user.name"], repositoryRoot),
          commands.run("git", ["config", "--get", "user.email"], repositoryRoot),
        ]);
        if (
          name.exitCode !== 0 ||
          email.exitCode !== 0 ||
          !name.stdout.trim() ||
          !email.stdout.trim()
        ) {
          add(
            diag(
              "repository",
              "git-identity-missing",
              "Git author identity is not configured for this repository.",
              "git config user.name <name> && git config user.email <email>",
            ),
          );
        }
        // Local bootstrap reads tracked HEAD authority before its unconfigured
        // bypass. Working bytes are only checkout advice.
        try {
          const authority = await resolveProjectConfigAuthority(repositoryRoot);
          if (authority.status === "tracked") projectConfig = authority.config;
        } catch {
          committedProjectConfigInvalid = true;
          add(
            Object.freeze({
              area: "configuration",
              code: "project-config-invalid",
              explanation:
                "The committed DocsFab project configuration at HEAD is invalid; local work cannot load its project authority.",
              nextCommand:
                "Correct .docsfab.json and commit the valid file, then rerun docsfab doctor.",
            }),
          );
        }
        let workingConfigPresent = false;
        let workingConfigInvalid = false;
        try {
          await readProjectConfig(repositoryRoot);
          workingConfigPresent = true;
        } catch (error) {
          const missing = error instanceof MissingProjectConfigError;
          workingConfigPresent = !missing;
          workingConfigInvalid = !missing;
        }
        if (!workingConfigPresent && projectConfig) {
          add(
            diag(
              "configuration",
              "project-config-missing",
              "The working DocsFab project file is missing; local execution still uses the valid committed configuration.",
              "Restore .docsfab.json from HEAD before publication.",
            ),
          );
        } else if (workingConfigInvalid && !committedProjectConfigInvalid) {
          add(
            diag(
              "configuration",
              "project-config-invalid",
              projectConfig
                ? "The working DocsFab project file is invalid or unsafe; local execution still uses the valid committed configuration."
                : "The uncommitted DocsFab project file is invalid or unsafe; local execution uses default documentation roots.",
              projectConfig
                ? "Repair the working .docsfab.json or restore the committed file."
                : "Repair .docsfab.json and commit it before publication.",
            ),
            false,
          );
        }
        const configuredRoots = projectConfig?.documentationRoots;
        const effectiveRoots = committedProjectConfigInvalid
          ? []
          : firstPassDocumentationWriteRoots(
              configuredRoots,
              "local-widen",
              await trackedHeadRegularFiles(repositoryRoot, configuredRoots ?? []),
            ).roots;
        const layoutAdvice = committedProjectConfigInvalid
          ? undefined
          : await inspectDocumentationLayoutAdvice(repositoryRoot, effectiveRoots);
        if (layoutAdvice) {
          add(
            diag(
              "repository",
              "documentation-layout-unrecognized",
              layoutAdvice.finding,
              layoutAdvice.remedies.join(" "),
            ),
            false,
          );
        }
        const status = await commands.run(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all"],
          repositoryRoot,
        );
        const listed = await commands.run(
          "git",
          ["ls-tree", "--name-only", "HEAD", "--", DOCSFAB_PROJECT_CONFIG_FILE],
          repositoryRoot,
        );
        const inspection = classifyProjectConfigCheckout({
          porcelain: status.exitCode === 0 ? status.stdout : "",
          trackedInRevision:
            listed.exitCode === 0 && listed.stdout.trim() === DOCSFAB_PROJECT_CONFIG_FILE,
          projectConfigPresent: workingConfigPresent,
        });
        if (!committedProjectConfigInvalid && !inspection.trackedInRevision) {
          const noSupportedRemote =
            !workingConfigPresent &&
            (await discoverRepository(repositoryRoot, {
              run: (command, args, path) => commands.run(command, args, path),
            }).then(
              (discovery) => discovery.candidates.length === 0,
              () => false,
            ));
          if (!workingConfigPresent) {
            add(
              noSupportedRemote
                ? diag(
                    "configuration",
                    "no-supported-gitlab-remote",
                    "No supported uncredentialed GitLab remote is available for project setup. Local work can continue without it.",
                    NO_SUPPORTED_GITLAB_REMOTE_NEXT_ACTION,
                  )
                : diag(
                    "configuration",
                    "project-config-missing",
                    "This repository has no committed DocsFab project configuration; local work uses default documentation roots.",
                    `docsfab init --repo ${repositoryRoot}`,
                  ),
            );
          }
        }
        const configPorcelain = inspection.porcelainLines.find(
          (line) =>
            line.slice(3) === DOCSFAB_PROJECT_CONFIG_FILE ||
            line.slice(3).endsWith(` -> ${DOCSFAB_PROJECT_CONFIG_FILE}`),
        );
        const checkout =
          status.exitCode !== 0 || listed.exitCode !== 0
            ? "unknown"
            : !workingConfigPresent
              ? "missing"
              : configPorcelain?.startsWith("??")
                ? "untracked"
                : configPorcelain && configPorcelain[0] !== " "
                  ? "staged"
                  : configPorcelain
                    ? "modified"
                    : listed.stdout.trim() === DOCSFAB_PROJECT_CONFIG_FILE
                      ? "clean"
                      : "ignored";
        projectConfiguration = {
          authority: committedProjectConfigInvalid
            ? "invalid"
            : projectConfig
              ? "tracked"
              : "defaults",
          effectiveRevision: projectConfig ? repositoryRevision : null,
          effectiveRoots,
          checkout,
        };
        if (inspection.codes.includes(PROJECT_CONFIG_UNTRACKED_CODE)) {
          add(
            diag(
              "configuration",
              PROJECT_CONFIG_UNTRACKED_CODE,
              "The DocsFab project configuration is not tracked in the current revision.",
              `git add ${DOCSFAB_PROJECT_CONFIG_FILE} && git commit`,
            ),
          );
        }
        if (inspection.codes.includes(REPOSITORY_SOURCE_DIRTY_CODE)) {
          add(
            diag(
              "repository",
              REPOSITORY_SOURCE_DIRTY_CODE,
              "The worktree has dirty porcelain that blocks clean-revision commands.",
              "git status",
            ),
          );
        }
      }
    }
  }

  const nativeLintLimitation =
    (options.platform ?? process.platform) !== "linux" && repositoryRoot
      ? diag(
          "validation",
          "native-lint-platform-unavailable",
          "Repository-native lint checks in the review workflow require Linux with working bubblewrap user namespaces; the review can continue with this limitation recorded.",
          "Rerun the documentation review on a Linux host with working bubblewrap user namespaces to execute native lint checks.",
        )
      : undefined;
  let requiredCheckLimitation: RequiredCheckReadinessLimitation | undefined;
  if (repositoryRoot && repositoryRevision) {
    // Avoid a second materialization when the tracked revision has no
    // instruction files. The final probe reads the exact exported HEAD tree.
    const instructionPaths = (await trackedHeadPaths(repositoryRoot)).filter((path) =>
      /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|COPILOT-INSTRUCTIONS)\.md$/iu.test(path),
    );
    if (instructionPaths.length > 0) {
      requiredCheckLimitation = options.probeRequiredCheckReadiness
        ? await options.probeRequiredCheckReadiness(repositoryRoot, repositoryRevision)
        : await withRepositoryWorkspace(repositoryRoot, "HEAD", (workspace) =>
            probeRequiredCheckReadiness(workspace),
          );
    }
  }

  let modelConfig: DocsFabConfig | undefined;
  try {
    modelConfig = (options.loadConfiguration ?? loadConfig)();
  } catch (error) {
    const retired = retiredSelectionDiagnostic(error);
    if (retired) add(retired);
    const keyInSetting = modelSettingCredentialDiagnostic(error);
    if (keyInSetting) add(keyInSetting);
    const issues = retired || keyInSetting ? [] : profileIssues(error);
    const inferenceIssues = issues.filter((field) => !isInferenceHubMetadataField(field));
    if (inferenceIssues.includes("MODEL_API_KEY")) {
      add(
        diag(
          "provider",
          "provider-credentials-missing",
          "The host-managed policy-provider credential is missing.",
          "docsfab setup",
        ),
      );
    }
    if (
      !retired &&
      !keyInSetting &&
      (inferenceIssues.length === 0
        ? issues.length === 0
        : inferenceIssues.some((field) => field !== "MODEL_API_KEY"))
    ) {
      add(
        diag(
          "provider",
          "provider-configuration-invalid",
          "The host-managed policy-provider configuration is incomplete or invalid.",
          "docsfab setup",
        ),
      );
    }
    if (issues.some(isInferenceHubMetadataField)) {
      // Metadata absence is diagnose-only and must not block run.
      add(
        diag(
          "provider",
          "metadata-api-key-missing",
          "Inference Hub Metadata uses a distinct optional credential; its absence does not block docsfab run.",
          "Catalog inspect remains optional.",
        ),
        false,
      );
    }
  }
  if (
    modelConfig &&
    (!modelConfig.model.apiKey || !modelConfig.model.providerId || !modelConfig.model.modelId)
  ) {
    add(
      diag(
        "provider",
        "provider-credentials-missing",
        "The host-managed policy-provider credential is missing.",
        "docsfab setup",
      ),
    );
  }
  if (modelConfig && !blocked.has("provider")) {
    const profileReadiness = inspectLegacyPolicyProfileReadiness(modelConfig.model.profile);
    if (!profileReadiness.ready && profileReadiness.code !== "ready") {
      add(
        diag(
          "provider",
          profileReadiness.code,
          profileReadiness.explanation,
          profileReadiness.nextCommand,
        ),
      );
    }
    // Handles one condition: a loaded policy or enabled judge profile whose run
    // evidence projection has a defect (the rule `profile inspect` applies), so
    // doctor can confirm the correction the `profile-evidence-invalid` next
    // action asks for. Load failures were reported above; valid evidence adds
    // nothing.
    const evidenceDefects = [
      configuredModelEvidenceDefectMessage(createModelEvidence(modelConfig.model), "policy"),
      modelConfig.judge
        ? configuredModelEvidenceDefectMessage(createModelEvidence(modelConfig.judge), "judge")
        : undefined,
    ].filter((message): message is string => message !== undefined);
    if (evidenceDefects.length > 0) {
      add(
        diag(
          "provider",
          "provider-profile-evidence-invalid",
          evidenceDefects.join(" "),
          "docsfab doctor",
        ),
      );
    }
    try {
      await (options.validateConfiguration ?? ((config) => diagnose(config)))(modelConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const refusedAtRegistration =
        retiredSelectionDiagnostic(error) ?? insecureEndpointDiagnostic(error);
      if (refusedAtRegistration) {
        add(refusedAtRegistration);
      } else if (error instanceof QualityPackError) {
        add(qualityPackDiagnostic(error));
      } else if (/^(?:Skill|No governed skills|Context-source)/u.test(message)) {
        add(
          diag(
            "installation",
            "installation-runtime-invalid",
            "The installed governed runtime could not be inspected safely.",
            reinstallAction(),
          ),
        );
      } else {
        add(
          diag(
            "provider",
            "provider-runtime-unavailable",
            "The configured policy provider could not be registered for offline use.",
            "docsfab profile inspect",
          ),
        );
      }
    }
  }
  if (repositoryRoot && projectConfig) {
    const privateRoots = resolveDocsFabPrivateRoots(
      repositoryRoot,
      environment,
      options.homeDirectory ?? homedir(),
    );
    const states = await Promise.all(
      Object.values(privateRoots).map((path) =>
        privateDirectoryState(path, options.checkPrivateAccess),
      ),
    );
    if (states.some((state) => state === "missing")) {
      add(
        diag(
          "private-state",
          "private-state-missing",
          "One or more owner-private DocsFab state roots have not been allocated.",
          INIT_PREVIEW_THEN_DIGEST_APPLY,
        ),
      );
    } else if (states.some((state) => state === "unsafe")) {
      add(
        diag(
          "private-state",
          "private-state-unsafe",
          "One or more DocsFab state roots are not canonical owner-private directories.",
          INIT_PREVIEW_THEN_DIGEST_APPLY,
        ),
      );
    }
  }

  const validationCommand: DoctorReadinessResult["validationCommand"] = null;
  // Validation is selected by the trusted delivery/validation profile, not by
  // target repository package scripts. Doctor only establishes that the
  // repository can reach the readiness boundary; a run-specific validator is
  // chosen later by delivery validation from the sealed workflow, changed paths,
  // and host policy inputs.

  if (!draftMrPrecondition && !repositoryRoot) draftMrPrecondition = "repository-unattached";
  else if (!draftMrPrecondition && !projectConfig) draftMrPrecondition = "project-config-missing";

  if (repositoryRoot && projectConfig) {
    const glab = await commands.run("glab", ["--version"], repositoryRoot);
    if (glab.exitCode !== 0) {
      add(
        diag(
          "gitlab",
          "runtime-glab-missing",
          "The glab runtime required for GitLab readiness is unavailable.",
          "glab --version",
        ),
      );
      draftMrPrecondition ??= "runtime-glab-missing";
    } else {
      const remote = await commands.run(
        "git",
        ["remote", "get-url", "--all", projectConfig.gitlab.remote],
        repositoryRoot,
      );
      const host = remote.exitCode === 0 ? safeGitLabHost(remote.stdout) : undefined;
      if (!host) {
        add(
          diag(
            "gitlab",
            "gitlab-project-mismatch",
            "The configured GitLab remote is missing, ambiguous, or unsafe.",
            INIT_PREVIEW_THEN_DIGEST_APPLY,
          ),
        );
        draftMrPrecondition ??= "gitlab-project-mismatch";
      } else {
        gitlabHost = host;
        const credential = await commands.probeCredential(
          "glab",
          ["config", "get", "token", "--host", host],
          repositoryRoot,
        );
        if (credential === "missing") {
          add(
            diag(
              "gitlab",
              "gitlab-login-missing",
              "No host-managed GitLab credential is available for the repository host.",
              "glab auth login",
            ),
          );
          draftMrPrecondition ??= "gitlab-login-missing";
        } else if (credential === "unverified") {
          add(
            diag(
              "gitlab",
              "gitlab-login-unverified",
              "DocsFab could not verify local GitLab credential readiness without reading the credential.",
              "glab auth login",
            ),
          );
          draftMrPrecondition ??= "gitlab-login-unverified";
        } else if (options.live) {
          gitlabLiveHost = host;
          gitlabLiveRepository = repositoryRoot;
        }
      }
    }
  }

  // The same read-only resolution the post-write publication path uses.
  // Nothing below mutates the checkout; failures degrade to blocked/unknown.
  // The network observation obeys the same gate as the other live boundaries
  // (`options.live` and an otherwise-clean offline verdict) and runs after
  // `blocked` is final: a host blocked for a local reason spends no time on
  // GitLab, and the record never carries target facts while `liveConnectivity`
  // says the boundary was not attempted. Conditions doctor established locally
  // still produce a real blocker without any call.
  const publication = draftMrPrecondition
    ? blockedDraftMrPublicationReadiness(draftMrPrecondition, {
        repositoryPath: repositoryRoot ?? null,
        ...(gitlabHost ? { gitlabHost } : {}),
      })
    : !options.live
      ? notObservedDraftMrPublicationReadiness()
      : diagnostics.some(
            (item) =>
              blockingCodes.has(item.code) &&
              appliesToLocalUse(item, committedProjectConfigInvalid),
          )
        ? notObservedDraftMrPublicationReadiness(
            "Doctor did not contact GitLab because offline readiness is blocked locally. Resolve the local diagnostics, then re-run with --live.",
          )
        : await inspectDraftMrPublicationReadiness(
            {
              repositoryPath: repositoryRoot ?? null,
              ...(gitlabHost ? { gitlabHost } : {}),
              ...(projectConfig ? { remoteName: projectConfig.gitlab.remote } : {}),
              ...(projectConfig?.gitlab.defaultBranch
                ? { targetBranch: projectConfig.gitlab.defaultBranch }
                : {}),
            },
            options.publicationCommands ??
              options.commands ??
              new ExecDoctorPublicationCommandRunner(environment),
          );
  // Offline and connection-free; added after the live check, which they do not gate.
  const outboundProxy = inspectOutboundProxy(environment, options.proxyRuntime);
  const proxyConfigurationDiagnostics = outboundProxyConfigurationDiagnostics(outboundProxy);
  if (
    options.live &&
    modelConfig &&
    !diagnostics.some(
      (item) =>
        blockingCodes.has(item.code) && appliesToLocalUse(item, committedProjectConfigInvalid),
    )
  ) {
    const providerLive = await Promise.allSettled([
      (options.checkProviderConnectivity ?? ((config) => diagnose(config, { live: true })))(
        modelConfig,
      ),
    ]).then((results) => results[0]!);
    if (providerLive.status === "fulfilled") {
      providerConnectivity = "passed";
      endpointCompatibility = liveCompatibilityOf(providerLive.value);
    } else if (insecureEndpointDiagnostic(providerLive.reason)) {
      providerConnectivity = "failed";
      add(insecureEndpointDiagnostic(providerLive.reason)!);
    } else if (providerLive.reason instanceof OutboundProxyRefusal) {
      providerConnectivity = "failed";
      const refusal = providerLive.reason;
      // Configuration names every invalid proxy variable; the live provider
      // failure remains a separate finding so its check cannot appear ready.
      add(
        proxyConfigurationDiagnostics.some((item) => item.code === refusal.code)
          ? diag(
              "provider",
              refusal.code,
              "Live provider connectivity was refused because of the proxy configuration described below.",
              refusal.nextAction,
            )
          : outboundProxyDiagnostic(refusal),
      );
    } else if (providerLive.reason instanceof EndpointCompatibilityError) {
      providerConnectivity = "failed";
      endpointCompatibility = providerLive.reason.report;
      add(endpointCompatibilityDiagnostic(providerLive.reason));
    } else {
      providerConnectivity = "failed";
      add(
        diag(
          "provider",
          "provider-live-unavailable",
          "Live policy-provider connectivity could not be verified.",
          "docsfab doctor --live",
        ),
      );
    }
  }
  if (options.live && gitlabLiveHost && gitlabLiveRepository) {
    gitlabConnectivity =
      publication.draftMrReadiness.state === "ready" ||
      (publication.draftMrReadiness.state === "blocked" &&
        publication.draftMrReadiness.blockers.includes("insufficient-push-access"))
        ? "passed"
        : publication.draftMrReadiness.state === "not-observed"
          ? "not-attempted"
          : "failed";
    if (gitlabConnectivity === "failed") {
      const unauthenticated =
        publication.draftMrReadiness.blockers.includes("gitlab-unauthenticated");
      add(
        diag(
          "gitlab",
          "gitlab-live-unavailable",
          publication.draftMrReadiness.reason,
          unauthenticated
            ? remediationText("glab-auth-login")
            : remediationText("retry-gitlab-api"),
        ),
      );
    }
  }
  for (const diagnostic of proxyConfigurationDiagnostics) add(diagnostic);
  const liveAgentSessions = await summarizeLocalSessionStorage({
    directory: () => resolveDocsFabLiveAgentSessionDirectory(environment),
    environment,
  });
  const configuredCredentialsNotCompared = uncomparedConfiguredCredentials(environment);
  const hostLimitsFile = skippedHostLimitFile(undefined, environment);
  const useReadiness = {
    "local-review": useView(
      "local-review",
      diagnostics,
      blockingCodes,
      publication.draftMrReadiness,
      publication.remediationArgv,
      committedProjectConfigInvalid,
    ),
    "local-patch": useView(
      "local-patch",
      diagnostics,
      blockingCodes,
      publication.draftMrReadiness,
      publication.remediationArgv,
      committedProjectConfigInvalid,
    ),
    "draft-mr": useView(
      "draft-mr",
      diagnostics,
      blockingCodes,
      publication.draftMrReadiness,
      publication.remediationArgv,
      committedProjectConfigInvalid,
    ),
  } satisfies Record<DoctorUse, DoctorUseReadiness>;
  const selectedUse = options.use ?? "local-review";
  const selectedView = useReadiness[selectedUse];
  const status = selectedView.status === "ready" ? "ready" : "blocked";
  const checks = selectedView.checks;
  const autoModesReady: DoctorReadinessResult["autoModesReady"] = [
    ...(useReadiness["local-review"].status === "ready" ? ["dry-run" as const] : []),
    ...(useReadiness["local-patch"].status === "ready" ? ["patch-only" as const] : []),
    ...(useReadiness["draft-mr"].status === "ready" ? ["draft-mr" as const] : []),
  ];
  const documentationGenerators = repositoryRoot
    ? detectDocumentationGenerators(await trackedHeadPaths(repositoryRoot))
    : [];
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-doctor-readiness",
    status,
    selectedUse,
    useReadiness,
    ...(nativeLintLimitation || requiredCheckLimitation
      ? {
          limitations: [
            ...(nativeLintLimitation ? [nativeLintLimitation] : []),
            ...(requiredCheckLimitation ? [requiredCheckLimitation] : []),
          ],
        }
      : {}),
    repositoryPath: repositoryRoot ?? null,
    documentationGenerators,
    liveConnectivity: {
      requested: Boolean(options.live),
      provider: providerConnectivity,
      gitlab: gitlabConnectivity,
    },
    endpointCompatibility,
    outboundProxy,
    liveAgentSessions,
    configuredCredentialsNotCompared,
    ...(hostLimitsFile ? { hostLimitsFile } : {}),
    checks,
    diagnostics: selectedView.diagnostics,
    validationCommand,
    validationScope: {
      readiness: "prerequisites-only",
      deliveryConfinement: "not-checked",
    } as const,
    repositoryRevision,
    checkoutBranch,
    checkoutRevision: repositoryRevision,
    ...(projectConfiguration ? { projectConfiguration } : {}),
    gitlabTargetBranch: publication.gitlabTargetBranch,
    gitlabTargetRevision: publication.gitlabTargetRevision,
    draftMrReadiness: publication.draftMrReadiness,
    remediationArgv: publication.remediationArgv,
    autoModesReady,
  });
}

async function installationReady(): Promise<boolean> {
  const root = resolveDocsFabProjectRoot();
  try {
    const [skillCrate, quality, qualityPack, assets] = await Promise.all([
      lstat(resolve(root, "skill-crate", "lock.json")),
      lstat(resolve(root, "quality", "lock.json")),
      lstat(resolve(root, "quality-pack", "manifest.json")),
      lstat(resolve(root, "governed-assets", "lock.json")),
    ]);
    return skillCrate.isFile() && quality.isFile() && qualityPack.isFile() && assets.isFile();
  } catch {
    return false;
  }
}

class MissingProjectConfigError extends Error {}

async function readProjectConfig(repositoryRoot: string): Promise<DocsFabProjectConfigV1> {
  const path = resolve(repositoryRoot, DOCSFAB_PROJECT_CONFIG_FILE);
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingProjectConfigError();
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size <= 0 ||
      before.size > 8 * 1024 ||
      before.nlink !== 1 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid()) ||
      (before.mode & 0o022) !== 0
    )
      throw new Error("unsafe project config");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size)
      throw new Error("changed project config");
    const value = parseJsonEvidence(bytes);
    assertDocsFabProjectConfig(value);
    return value;
  } finally {
    await handle.close();
  }
}

async function privateDirectoryState(
  path: string,
  checkAccess: ((path: string) => Promise<void>) | undefined,
): Promise<"ready" | "missing" | "unsafe"> {
  try {
    const [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
    const structurallySafe =
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      canonical === path &&
      (metadata.mode & 0o077) === 0 &&
      (metadata.mode & 0o300) === 0o300 &&
      (typeof process.getuid !== "function" || metadata.uid === process.getuid());
    if (!structurallySafe) return "unsafe";
    await (checkAccess ?? ((candidate) => access(candidate, fsConstants.W_OK | fsConstants.X_OK)))(
      path,
    );
    return "ready";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

function safeGitLabHost(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) return undefined;
  try {
    return parseGitLabRemote(lines[0]!).host;
  } catch (error) {
    // Only an unsupported remote is an operator-correctable mismatch.
    if (
      error instanceof LocalUserPublicationPreflightError &&
      error.code === "unsupported-remote"
    ) {
      return undefined;
    }
    throw error;
  }
}

function safeIdentity(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("//")
  );
}

function exactRevision(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not directory");
  return canonical;
}
