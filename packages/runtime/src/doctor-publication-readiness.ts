// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Draft-MR publication readiness for `docsfab doctor`.
 *
 * Answers "would `--draft-mr` publish from this checkout?" with the exact
 * resolution the post-write publication path uses: `observeLocalUserGitLabTarget`
 * and `planLocalUserPublicationFreshness` under the run-base policy `--draft-mr`
 * selects without an explicit `--revision`. No second resolver exists here. Doctor stays read-only:
 * `ensure-object` is reported, never executed, and the operator checkout is
 * never moved. Every failure degrades to a structured blocked/unknown
 * disposition with a reason; nothing in this module throws to its caller.
 */
import {
  LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL,
  LocalUserPublicationPreflightError,
  type LocalUserPublicationFailureCode,
} from "./delivery/contracts.js";
import {
  planLocalUserPublicationFreshness,
  type LocalUserPublicationRevisionPolicy,
} from "./delivery/freshness.js";
import {
  observeLocalUserGitLabTarget,
  type LocalUserGitLabTargetObservation,
  type ReadOnlyCommandRunner,
} from "./delivery/preflight.js";
import type { DoctorDiagnosticCode } from "./operator/situation-catalog.js";

/**
 * Conditions doctor establishes with its own checks before any GitLab target
 * observation is attempted. Each value is also a `DoctorDiagnosticCode`, so the
 * blocker and the emitted diagnostic name the same condition.
 */
export type DoctorDraftMrPreconditionCode = Extract<
  DoctorDiagnosticCode,
  | "runtime-git-missing"
  | "repository-unattached"
  | "project-config-missing"
  | "runtime-glab-missing"
  | "gitlab-project-mismatch"
  | "gitlab-login-missing"
  | "gitlab-login-unverified"
>;

export type DoctorDraftMrBlockerCode =
  | DoctorDraftMrPreconditionCode
  | LocalUserPublicationFailureCode;

/** Operator checkout tip compared with the live GitLab target-branch head. */
export type DoctorCheckoutTargetRelation =
  | "at-target"
  | "behind-target"
  | "ahead-of-target"
  | "diverged-from-target"
  | "unknown";

export interface DoctorDraftMrReadiness {
  /**
   * Whether the default `--draft-mr` run base would reach GitLab publication.
   *
   * `not-observed` is the offline default: reading the GitLab target is a live
   * call that doctor makes only when the operator opts in with `--live`.
   * `unknown` means the observation was attempted and did not resolve. Only
   * `not-observed` leaves the other auto-mode readiness unchanged; every other
   * state is a real disposition.
   */
  readonly state: "ready" | "blocked" | "unknown" | "not-observed";
  /** Run-base policy doctor evaluated, or null when nothing could be evaluated. */
  readonly revisionPolicy: LocalUserPublicationRevisionPolicy | null;
  /**
   * How the default run base would be obtained. `already-local` is the observed
   * freshness `noop`; `fetch-target-object` is `ensure-object`, which fetches one
   * commit object and never moves the checkout.
   */
  readonly runBaseAction: "already-local" | "fetch-target-object" | "unknown";
  readonly checkoutRelation: DoctorCheckoutTargetRelation;
  /** True when the checkout branch is not the GitLab target branch. */
  readonly featureBranch: boolean | null;
  /** Whether an explicit `--revision HEAD` (checkout-head) would still be refused. */
  readonly checkoutHeadRunBase: "usable" | "stale-revision" | "unknown";
  readonly blockers: readonly DoctorDraftMrBlockerCode[];
  /** Content-free explanation; never command output, URLs, or credentials. */
  readonly reason: string;
}

export interface DoctorDraftMrPublicationReadiness {
  readonly gitlabTargetBranch: string | null;
  readonly gitlabTargetRevision: string | null;
  readonly draftMrReadiness: DoctorDraftMrReadiness;
  /** Exact next argv while not ready; null once `--draft-mr` would publish. */
  readonly remediationArgv: readonly string[] | null;
}

export interface DoctorDraftMrReadinessInput {
  /** Canonical operator checkout root, or null when doctor attached none. */
  readonly repositoryPath: string | null;
  /** Blocking condition doctor already established; skips the observation. */
  readonly precondition?: DoctorDraftMrPreconditionCode;
  /** GitLab host doctor parsed from the configured remote, when known. */
  readonly gitlabHost?: string;
  readonly remoteName?: string;
  readonly targetBranch?: string;
}

const PRECONDITION_REASON: Readonly<Record<DoctorDraftMrPreconditionCode, string>> = Object.freeze({
  "runtime-git-missing":
    "Draft-MR readiness needs the git runtime to read the checkout; none is available.",
  "repository-unattached":
    "Draft-MR readiness needs an attached Git worktree; --repo selected none.",
  "project-config-missing":
    "Draft-MR readiness needs the DocsFab project configuration to select the GitLab remote and target branch.",
  "runtime-glab-missing":
    "Draft-MR readiness needs the glab runtime to observe the GitLab target branch; none is available.",
  "gitlab-project-mismatch":
    "The configured GitLab remote is missing, ambiguous, or unsafe, so no GitLab target can be observed.",
  "gitlab-login-missing":
    "No host-managed GitLab credential is available, so the GitLab target branch cannot be observed.",
  "gitlab-login-unverified":
    "GitLab credential readiness could not be verified, so the GitLab target branch was not observed.",
});

/**
 * The run base `--draft-mr` selects without `--revision`, as
 * `revisionPolicyForDraftMr` implements it. Duplicated here so a top-level
 * doctor module does not depend on `src/cli/`.
 */
const DEFAULT_DRAFT_MR_REVISION_POLICY: LocalUserPublicationRevisionPolicy = "target-branch-head";

/** Environmental codes: the disposition is undetermined rather than refused. */
const UNDETERMINED_CODES: ReadonlySet<LocalUserPublicationFailureCode> = new Set([
  "gitlab-unreachable",
  "gitlab-response-invalid",
]);

/**
 * Report whether `docsfab run … --draft-mr` would publish from this checkout.
 *
 * Read-only by construction: the only commands issued are the shared
 * observation's and two local `git` ancestry reads.
 */
export async function inspectDraftMrPublicationReadiness(
  input: DoctorDraftMrReadinessInput,
  commands: ReadOnlyCommandRunner,
): Promise<DoctorDraftMrPublicationReadiness> {
  if (input.precondition) {
    return blockedBy(input.precondition, PRECONDITION_REASON[input.precondition], input);
  }
  if (!input.repositoryPath) {
    return blockedBy("repository-unattached", PRECONDITION_REASON["repository-unattached"], input);
  }

  let observation: LocalUserGitLabTargetObservation;
  try {
    observation = await observeLocalUserGitLabTarget(
      {
        repositoryPath: input.repositoryPath,
        ...(input.remoteName ? { remoteName: input.remoteName } : {}),
        ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
      },
      commands,
    );
  } catch (error) {
    return fromObservationFailure(error, input);
  }

  // Both plans come from the shared freshness planner; doctor decides nothing
  // about run-base selection on its own.
  const revisionPolicy = DEFAULT_DRAFT_MR_REVISION_POLICY;
  const planInput = {
    requestedRevision: "HEAD",
    headRevision: observation.headRevision,
    headBranch: observation.headBranch,
    targetBranch: observation.target.name,
    gitlabRevision: observation.target.revision,
  } as const;
  const plan = planLocalUserPublicationFreshness({ ...planInput, revisionPolicy });
  const checkoutHeadPlan = planLocalUserPublicationFreshness({
    ...planInput,
    revisionPolicy: "checkout-head",
  });

  const relation = await compareCheckoutWithTarget(
    commands,
    observation.repositoryPath,
    observation.headRevision,
    observation.target.revision,
  );
  const featureBranch = observation.headBranch !== observation.target.name;

  // Readiness covers every publication gate this observation can answer, so an
  // access level below `LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL` is reported here
  // rather than after a full write workflow. The run base adds no blocker: under
  // `target-branch-head` the planner returns only `noop` or `ensure-object`.
  const blockers: DoctorDraftMrBlockerCode[] = [];
  if (observation.project.accessLevel < LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL) {
    blockers.push("insufficient-push-access");
  }
  const ready = blockers.length === 0;
  const runBaseAction =
    plan.action === "noop"
      ? ("already-local" as const)
      : plan.action === "ensure-object"
        ? ("fetch-target-object" as const)
        : ("unknown" as const);
  const checkoutHeadRunBase =
    checkoutHeadPlan.action === "fail" ? ("stale-revision" as const) : ("usable" as const);

  return Object.freeze({
    gitlabTargetBranch: observation.target.name,
    gitlabTargetRevision: observation.target.revision,
    draftMrReadiness: Object.freeze({
      state: ready ? ("ready" as const) : ("blocked" as const),
      revisionPolicy,
      runBaseAction,
      checkoutRelation: relation,
      featureBranch,
      checkoutHeadRunBase,
      blockers: Object.freeze([...blockers]),
      reason: readyReason({
        blockers,
        featureBranch,
        relation,
        runBaseAction,
        checkoutHeadRunBase,
        targetBranch: observation.target.name,
      }),
    }),
    remediationArgv: ready
      ? null
      : argvFor(mostActionableBlocker(blockers), {
          ...input,
          projectId: observation.project.id,
        }),
  });
}

function mostActionableBlocker(
  blockers: readonly DoctorDraftMrBlockerCode[],
): DoctorDraftMrBlockerCode {
  return blockers.includes("insufficient-push-access")
    ? "insufficient-push-access"
    : (blockers[0] ?? "gitlab-response-invalid");
}

function readyReason(input: {
  blockers: readonly DoctorDraftMrBlockerCode[];
  featureBranch: boolean;
  relation: DoctorCheckoutTargetRelation;
  runBaseAction: "already-local" | "fetch-target-object" | "unknown";
  checkoutHeadRunBase: "usable" | "stale-revision";
  targetBranch: string;
}): string {
  if (input.blockers.includes("insufficient-push-access")) {
    return `The GitLab target ${input.targetBranch} was observed, but this account is below the Developer access level DocsFab needs to push a source branch. Ask for Developer-or-higher project access, or keep patch-only delivery.`;
  }
  if (input.blockers.length > 0) {
    return "The selected run base is not GitLab's current target-branch revision.";
  }
  const base =
    input.runBaseAction === "already-local"
      ? `The checkout is already at GitLab's ${input.targetBranch} revision.`
      : `The run base is GitLab's ${input.targetBranch} revision; DocsFab fetches that commit object and leaves the checkout where it is.`;
  if (input.checkoutHeadRunBase === "usable") return base;
  const detected = input.featureBranch
    ? `The checkout is on a non-target branch and is ${relationPhrase(input.relation)} GitLab's ${input.targetBranch}.`
    : `The checkout is ${relationPhrase(input.relation)} GitLab's ${input.targetBranch}.`;
  return `${base} ${detected} An explicit --revision HEAD would still be refused as stale-revision; run without --revision, or use --revision ${input.targetBranch} after git fetch.`;
}

function relationPhrase(relation: DoctorCheckoutTargetRelation): string {
  switch (relation) {
    case "at-target":
      return "level with";
    case "behind-target":
      return "behind";
    case "ahead-of-target":
      return "ahead of";
    case "diverged-from-target":
      return "diverged from";
    default:
      return "not locally comparable with";
  }
}

/**
 * Local-only ancestry read. The commit identities come from the shared
 * observation; this only names their relation for the operator.
 */
async function compareCheckoutWithTarget(
  commands: ReadOnlyCommandRunner,
  repositoryPath: string,
  headRevision: string,
  targetRevision: string,
): Promise<DoctorCheckoutTargetRelation> {
  if (headRevision.toLowerCase() === targetRevision.toLowerCase()) return "at-target";
  const present = await commands.run(
    "git",
    ["cat-file", "-e", `${targetRevision}^{commit}`],
    repositoryPath,
  );
  if (present.exitCode !== 0) return "unknown";
  const behind = await commands.run(
    "git",
    ["merge-base", "--is-ancestor", headRevision, targetRevision],
    repositoryPath,
  );
  if (behind.exitCode === 0) return "behind-target";
  const ahead = await commands.run(
    "git",
    ["merge-base", "--is-ancestor", targetRevision, headRevision],
    repositoryPath,
  );
  return ahead.exitCode === 0 ? "ahead-of-target" : "diverged-from-target";
}

function fromObservationFailure(
  error: unknown,
  input: DoctorDraftMrReadinessInput,
): DoctorDraftMrPublicationReadiness {
  if (error instanceof LocalUserPublicationPreflightError) {
    return disposition(
      UNDETERMINED_CODES.has(error.code) ? "unknown" : "blocked",
      error.code,
      error.action,
      input,
    );
  }
  return disposition(
    "unknown",
    "gitlab-response-invalid",
    "The GitLab target observation did not complete; readiness is undetermined.",
    input,
  );
}

function blockedBy(
  code: DoctorDraftMrBlockerCode,
  reason: string,
  input: DoctorDraftMrReadinessInput,
): DoctorDraftMrPublicationReadiness {
  return disposition("blocked", code, reason, input);
}

/**
 * Structured disposition when no GitLab target was observed. Every field that
 * depends on the observation is explicitly unknown rather than absent, so a
 * `--json` consumer never has to distinguish "missing" from "not determined".
 */
export function unobservedDraftMrReadiness(
  state: "blocked" | "unknown" | "not-observed",
  code: DoctorDraftMrBlockerCode | null,
  reason: string,
): DoctorDraftMrReadiness {
  return Object.freeze({
    state,
    revisionPolicy: null,
    runBaseAction: "unknown" as const,
    checkoutRelation: "unknown" as const,
    featureBranch: null,
    checkoutHeadRunBase: "unknown" as const,
    blockers: Object.freeze(code === null ? [] : [code]),
    reason,
  });
}

/**
 * Offline disposition. Doctor makes no GitLab call unless the operator asks for
 * live checks, so the structured fields stay present and say why they hold no
 * target.
 */
export function notObservedDraftMrPublicationReadiness(
  reason = "Doctor did not contact GitLab. Draft-MR publication readiness is a live fact; re-run with --live to observe the target branch.",
): DoctorDraftMrPublicationReadiness {
  return Object.freeze({
    gitlabTargetBranch: null,
    gitlabTargetRevision: null,
    draftMrReadiness: unobservedDraftMrReadiness("not-observed", null, reason),
    remediationArgv: null,
  });
}

/**
 * A condition doctor established locally, with no GitLab call. These are real
 * `--draft-mr` prerequisites, so they are reported as blockers rather than as
 * an unobserved state, and they stay available offline.
 */
export function blockedDraftMrPublicationReadiness(
  code: DoctorDraftMrPreconditionCode,
  input: DoctorDraftMrReadinessInput,
): DoctorDraftMrPublicationReadiness {
  return disposition("blocked", code, PRECONDITION_REASON[code], input);
}

function disposition(
  state: "blocked" | "unknown",
  code: DoctorDraftMrBlockerCode,
  reason: string,
  input: DoctorDraftMrReadinessInput,
): DoctorDraftMrPublicationReadiness {
  return Object.freeze({
    gitlabTargetBranch: null,
    gitlabTargetRevision: null,
    draftMrReadiness: unobservedDraftMrReadiness(state, code, reason),
    remediationArgv: argvFor(code, input),
  });
}

/**
 * Exact operator argv for one blocker. Every `docsfab` form here is a shipped
 * invocation from the CLI usage text and parses through the shipped parser.
 */
function argvFor(
  code: DoctorDraftMrBlockerCode,
  input: DoctorDraftMrReadinessInput & { readonly projectId?: number },
): readonly string[] {
  // `--repo .` would resolve against the operator's current directory, not the
  // diagnosed repository, so an unattached checkout omits the option.
  const repoOption = input.repositoryPath ? ["--repo", input.repositoryPath] : [];
  const login = input.gitlabHost
    ? ["glab", "auth", "login", "--hostname", input.gitlabHost]
    : ["glab", "auth", "login"];
  switch (code) {
    case "runtime-git-missing":
      return Object.freeze(["git", "--version"]);
    case "runtime-glab-missing":
    case "glab-unavailable":
      return Object.freeze(["glab", "--version"]);
    case "gitlab-login-missing":
    case "gitlab-login-unverified":
    case "gitlab-unauthenticated":
      return Object.freeze(login);
    case "gitlab-unreachable":
    case "gitlab-response-invalid":
      return Object.freeze(["docsfab", "doctor", ...repoOption, "--live"]);
    case "project-config-missing":
    case "gitlab-project-mismatch":
    case "missing-remote":
    case "ambiguous-remote":
    case "ambiguous-remote-url":
    case "unsupported-remote":
    case "project-mismatch":
    case "target-branch-missing":
      return Object.freeze(["docsfab", "init", ...repoOption]);
    case "insufficient-push-access":
      // Nothing local grants project access. `members/all` needs at least
      // Guest, so it would itself be refused for a non-member; the project
      // endpoint is readable by anyone who can read the project at all and
      // names the maintainers to ask.
      return Object.freeze(
        input.gitlabHost && input.projectId !== undefined
          ? ["glab", "api", "--hostname", input.gitlabHost, `projects/${input.projectId}`]
          : ["docsfab", "doctor", ...repoOption, "--live"],
      );
    default:
      return Object.freeze(["docsfab", "doctor", ...repoOption]);
  }
}
