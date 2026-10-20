// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Append-only operator situation catalog: next-action text, docs anchors,
 * remediation ids, doctor diagnostic ids, and publication/delivery action
 * sentences. Public envelope JSON keeps `kind: "docsfab-operator-error"` with
 * `envelope.code === error.code`. Host must not import this module.
 */

import type { FailureClass } from "./failure-class.js";

export type SituationFamily =
  | "doctor"
  | "publication"
  | "delivery"
  | "remediation"
  | "contract"
  | "operator";

export type SituationClassification = "situation" | "frozen-stem" | "ambiguous";

export interface SituationRow {
  readonly id: string;
  readonly family: SituationFamily;
  readonly classification: SituationClassification;
  /** Rows that share an id across families must agree on the class. */
  readonly failureClass: FailureClass;
  readonly nextAction?: string;
  readonly publicationAction?: string;
  readonly deliveryAction?: string;
  readonly docsAnchor?: string;
  /** When set, inferred-remediation docs lookup prefers this row over the code. */
  readonly docsAnchorOverride?: true;
  readonly remediationId?: string;
  /** Reserved for name-keyed lookup; unused. */
  readonly errorName?: string;
  /** Contributes `DEFAULT_NEXT_ACTIONS[id]`. */
  readonly inEnvelope?: true;
}

const TROUBLESHOOTING_DOCS = "docs/troubleshooting.md";
const CLI_HUMAN_OUTPUT_DOCS = "docs/reference/status-and-configuration/human-output-and-json.md";
const CONFIGURATION_DOCS = "docs/reference/status-and-configuration/project-configuration.md";
const DOCTOR_DOCS = "docs/manage/check-readiness.md";
const RST_CAPABILITY_DOCS = "docs/reference/status-and-configuration/document-validation.md";
const PROFILE_DOCS = "docs/reference/status-and-configuration/model-profile-approval.md";
const MODEL_SETUP_DOCS = "docs/configure/model.md";
const MODEL_MIGRATION_DOCS = MODEL_SETUP_DOCS;
const MODEL_FIELDS_DOCS = "docs/reference/status-and-configuration/model-profile-fields.md";
const ARCHITECTURE_DOCS = "docs/about/architecture.md";
const SECURITY_DOCS = "docs/about/security.md";

/**
 * The refused-Git-setting remediation (#2363): the same words are the
 * remediation, the publication-preflight action, and the envelope next action,
 * for the stop before the model run and the stop at publication alike.
 */
const REMOVE_REFUSED_GIT_SETTING_TEXT =
  "DocsFab refused a Git setting that can run a command, change how it pushes, or turn signing on. Remove it from the file that sets it; `git config --show-origin --list` shows each setting's file. Then run the same command again. core.sshCommand and core.askPass can move to your global Git config instead, when HOME is an absolute path outside the checkout. If DocsFab had already written the change, run `docsfab publish <run-id>` instead of the same command; the write is preserved.";

/** The Git version, remote, or configuration DocsFab could not verify (#2363). */
const REPAIR_GIT_CHECKOUT_TEXT =
  "DocsFab could not verify the checkout's Git setup, and stopped. Check that `git --version` is 2.9.5 or newer, that `git remote get-url --push --all <remote>` prints the one project URL the plan names, that `git config --show-origin --list` prints without an error and gives every setting a value, and that `git config --includes --show-origin --null --list | wc -c` is no larger than delivery.gitConfigurationListingMaxBytes, 2097152 bytes by default (DOCSFAB_DELIVERY_GIT_CONFIGURATION_LISTING_MAX_BYTES raises it). Then run the same command again, or `docsfab publish <run-id>` if DocsFab had already written the change; the write is preserved.";

const REMEDIATION_SITUATIONS = [
  {
    id: "glab-auth-login",
    family: "remediation",
    classification: "situation",
    failureClass: "auth",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Run `glab auth login --hostname <host from the selected remote>`; no SCM credential is stored by DocsFab.",
  },
  {
    id: "retry-gitlab-api",
    family: "remediation",
    classification: "situation",
    failureClass: "infrastructure",
    nextAction:
      "GitLab API for the selected remote host is unreachable. Confirm network or VPN, then retry `glab api --hostname <host from git remote> user`. Do not log in unless `glab auth status --hostname <host from git remote>` reports not logged in.",
  },
  {
    id: "verify-gitlab-project-access",
    family: "remediation",
    classification: "situation",
    failureClass: "auth",
    inEnvelope: true,
    nextAction: "Verify `glab` access to the selected GitLab project, then initialize again.",
  },
  {
    id: "update-docsfab-runtime",
    family: "remediation",
    classification: "situation",
    failureClass: "auth",
    nextAction:
      "Update DocsFab and retry publication of the saved run. Current versions support documentation MRs against DocsFab itself.",
  },
  {
    id: "select-git-repository",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction: "Pass --repo at a local Git checkout. The selected path is not a Git work tree.",
  },
  {
    id: "use-git-repository-root",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction: "Pass --repo at the Git repository root, not a subdirectory.",
  },
  {
    id: "clean-tracked-source",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction:
      "Commit, stash, or discard tracked and staged changes, then retry. Untracked files are allowed.",
  },
  {
    id: "remove-unsafe-git-configuration",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction:
      "Retry from a checkout whose local Git config does not enable hooks, fsmonitor, includes, or content filters.",
  },
  {
    id: "remove-refused-git-setting",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction: REMOVE_REFUSED_GIT_SETTING_TEXT,
  },
  {
    id: "repair-git-checkout",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction: REPAIR_GIT_CHECKOUT_TEXT,
  },
  {
    id: "select-publication-remote",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction:
      "Pass --remote <name> on do, run, or publish. DocsFab selects origin when that remote exists.",
  },
  {
    id: "retry-recorded-source-path",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction: "Retry publication against the same --repo path the succeeded run recorded.",
  },
  {
    id: "profile-inspect",
    family: "remediation",
    classification: "situation",
    failureClass: "auth",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "Run `docsfab profile inspect`; use `docsfab profile approve` only for exact reviewed evidence.",
  },
  {
    id: "profile-inspection-clock-invalid",
    family: "remediation",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "Verify and correct the host clock or time synchronization before generating fresh inspection evidence. Preserve saved reports, and do not approve evidence from the failed inspection.",
  },
  {
    id: "invalid-model-profile-approval",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "Run `docsfab profile inspect --catalog --json` and review the exact proposal and evidence before continuing.",
  },
  {
    id: "profile-apply-rejected",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "Run `docsfab doctor` and correct any reported configuration issue before retrying the requested profile operation.",
  },
  {
    id: "profile-owner-artifact-rejected",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "Restore the intended owner-controlled profile artifact as a regular owner-only file and have its owner verify it before continuing.",
  },
  {
    id: "profile-apply-ambiguous",
    family: "remediation",
    classification: "ambiguous",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "The apply outcome is uncertain. Do not retry approval or begin another profile mutation. Preserve the configuration root, `.env.docsfab-apply.lock`, `.env.docsfab-transaction.json`, `.env.docsfab-recovery.claim`, and any staged receipt; have the configuration-root owner reconcile the transaction before any further profile mutation.",
  },
  {
    id: "profile-rollback-ambiguous",
    family: "remediation",
    classification: "ambiguous",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "The rollback outcome is uncertain. Do not retry rollback or begin another profile mutation. Preserve the configuration root, `.env.docsfab-apply.lock`, `.env.docsfab-transaction.json`, `.env.docsfab-recovery.claim`, and any staged receipt; have the configuration-root owner reconcile the transaction before any further profile mutation.",
  },
  {
    id: "invalid-model-profile-configuration",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "Correct the listed MODEL_* or JUDGE_* fields in the environment or DocsFab configuration root, then run `docsfab doctor` to confirm the profile loads.",
  },
  {
    id: "unsupported-model-profile-api-format",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "Set MODEL_API_FORMAT or JUDGE_API_FORMAT to a format supported by the selected route, then run `docsfab doctor` to confirm the profile loads.",
  },
  {
    // Doctor reports the same rule as `provider-profile-evidence-invalid`, which
    // routes here. This action must not name `docsfab profile inspect`; plain
    // doctor re-runs the rule to confirm.
    id: "profile-evidence-invalid",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: PROFILE_DOCS,
    nextAction:
      "Correct the MODEL_* or JUDGE_* setting the message names, in the environment or the DocsFab configuration root, then run `docsfab doctor`, which re-checks the profile evidence. When the message names no setting, update DocsFab.",
  },
  {
    // The only defect is a lapsed review date. Separates gathering fresh
    // evidence (re-inspection) from applying reviewed evidence (re-approval).
    id: "profile-review-lapsed",
    family: "remediation",
    classification: "situation",
    failureClass: "auth",
    nextAction:
      "The profile review date has passed. To re-inspect, run `docsfab profile inspect --catalog --json` and compare the provider's current limits; to re-approve, pass that exact reviewed report to `docsfab profile approve`. Change MODEL_PROFILE_REVIEW_AFTER or JUDGE_PROFILE_REVIEW_AFTER only after that review.",
  },
  {
    id: "profile-setup",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction: "docsfab setup",
  },
  {
    id: "profile-seed",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    docsAnchor: MODEL_FIELDS_DOCS,
    docsAnchorOverride: true,
    nextAction:
      "Run `docsfab profile seed --preset <id>` to create an unsigned MODEL_* profile (without `--preset` it names the choices), then set MODEL_API_KEY before retrying.",
  },
  {
    id: "doctor",
    family: "remediation",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    docsAnchor: DOCTOR_DOCS,
    nextAction: "Run `docsfab doctor` for the stable offline readiness diagnostic.",
  },
  {
    id: "init",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction:
      "Preview with `docsfab init --non-interactive`, then apply with `docsfab init --non-interactive --apply --approve-plan-sha256 <digest>` using that exact digest.",
  },
  {
    id: "cli-usage",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: CLI_HUMAN_OUTPUT_DOCS,
    nextAction: "Run `docsfab --help` and correct the flagged option or argument.",
  },
  {
    id: "init-cli-usage",
    family: "remediation",
    classification: "situation",
    failureClass: "operator-input",
    nextAction:
      "Run `docsfab init --help` and correct the flagged option; `--json` requires `--non-interactive`.",
  },
] as const satisfies readonly SituationRow[];

const DOCTOR_SITUATIONS = [
  {
    id: "installation-invalid",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "installation-runtime-invalid",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  // `QualityPackError` codes: the installed quality pack failed verification.
  // Doctor reports the code `run` reports; the error names the restore step.
  // A pack failure is classed by the error's type (`failure-classification.ts`).
  // Seven of these codes are also thrown by other errors (the skill crate and
  // governed skill integrity errors, the content index, the artifact store, the
  // reader task context), so a bare code names no cause: those rows are ambiguous
  // stems of class `unknown`, and the other throwers keep reading `unknown`.
  // `invalid-manifest` is the one code only the pack throws.
  {
    id: "lock-unavailable",
    family: "doctor",
    classification: "ambiguous",
    failureClass: "unknown",
  },
  {
    id: "invalid-lock",
    family: "doctor",
    classification: "ambiguous",
    failureClass: "unknown",
  },
  {
    id: "invalid-manifest",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "stale",
    family: "doctor",
    classification: "ambiguous",
    failureClass: "unknown",
  },
  {
    id: "tampered",
    family: "doctor",
    classification: "ambiguous",
    failureClass: "unknown",
  },
  {
    id: "unsafe-path",
    family: "doctor",
    classification: "ambiguous",
    failureClass: "unknown",
  },
  {
    id: "file-set-mismatch",
    family: "doctor",
    classification: "ambiguous",
    failureClass: "unknown",
  },
  {
    id: "checksum-mismatch",
    family: "doctor",
    classification: "ambiguous",
    failureClass: "unknown",
  },
  {
    // A quality lock that predates its schema; the id is shared with the contract stem.
    id: "migration-required",
    family: "doctor",
    classification: "ambiguous",
    failureClass: "contract-shape",
  },
  {
    id: "runtime-git-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "runtime-glab-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "runtime-validation-tool-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "project-config-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
    remediationId: "init",
  },
  {
    id: "configuration-root-not-canonical",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "configuration-root-not-private",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
    docsAnchor: DOCTOR_DOCS,
  },
  {
    id: "native-lint-platform-unavailable",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "required-check-isolation-unavailable",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "gitlab-target-not-observed",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "draft-mr-publication-blocked",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "project-config-invalid",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
    remediationId: "init",
  },
  {
    id: "project-config-untracked",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "repository-unattached",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "repository-state-blocked",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "repository-source-dirty",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    // Advisory, never blocking: pages sit outside every recognized
    // documentation directory, so they are read-only until granted.
    id: "documentation-layout-unrecognized",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "repository-revision-unborn",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "repository-revision-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "repository-revision-inaccessible",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "repository-revision-invalid",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "git-identity-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "provider-credentials-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "auth",
    remediationId: "profile-setup",
  },
  {
    id: "metadata-api-key-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "auth",
  },
  {
    // #1512: the configured model selection is retired. The thrown refusal
    // carries its own successor remediation, which doctor reports verbatim.
    id: "composition-retired",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "provider-configuration-invalid",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
    remediationId: "profile-setup",
  },
  {
    id: "provider-profile-unapproved",
    family: "doctor",
    classification: "situation",
    failureClass: "auth",
    remediationId: "profile-setup",
  },
  {
    id: "provider-profile-stale",
    family: "doctor",
    classification: "situation",
    failureClass: "auth",
    remediationId: "profile-setup",
  },
  {
    // Same rule as `profile inspect`, so doctor can confirm the correction.
    id: "provider-profile-evidence-invalid",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
    remediationId: "profile-evidence-invalid",
  },
  {
    id: "provider-runtime-unavailable",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
    remediationId: "profile-inspect",
  },
  {
    id: "provider-live-unavailable",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    // Plain HTTP to a host that is not loopback, found by doctor; the
    // diagnostic's next command is the transport refusal's own next action.
    id: "model-endpoint-insecure-transport",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    // A proxy variable doctor cannot use; the diagnostic names the variable.
    id: "outbound-proxy-invalid",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    // A proxy variable is set on a Node without built-in proxy support.
    id: "outbound-proxy-not-enabled",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    // `doctor --live`: the configured proxy could not be reached.
    id: "outbound-proxy-unreachable",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    // `doctor --live`: the proxy refused the tunnel to the model endpoint (403).
    id: "outbound-proxy-denied",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    // `doctor --live`: the proxy asked for proxy authentication (407).
    id: "outbound-proxy-auth-required",
    family: "doctor",
    classification: "situation",
    failureClass: "auth",
  },
  {
    // The live endpoint compatibility probe found a check the endpoint fails;
    // the diagnostic's next command is that check's own next action.
    id: "endpoint-incompatible",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
  {
    id: "gitlab-login-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "auth",
    remediationId: "glab-auth-login",
  },
  {
    id: "gitlab-login-unverified",
    family: "doctor",
    classification: "situation",
    failureClass: "auth",
    remediationId: "glab-auth-login",
  },
  {
    id: "gitlab-live-unavailable",
    family: "doctor",
    classification: "situation",
    failureClass: "infrastructure",
  },
  {
    id: "gitlab-project-mismatch",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
    remediationId: "init",
  },
  {
    id: "private-state-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
    remediationId: "init",
  },
  {
    id: "private-state-unsafe",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
    remediationId: "init",
  },
  {
    id: "validation-command-missing",
    family: "doctor",
    classification: "situation",
    failureClass: "operator-input",
  },
] as const satisfies readonly SituationRow[];

const SAVED_RUN_NOT_FOUND_NEXT_ACTION =
  "The saved run record was not found. Run `docsfab runs list` with the same `--state-dir` selection and choose an existing run. A deleted run cannot be shipped or published.";

const PUBLICATION_SITUATIONS = [
  {
    id: "invalid-input",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Correct the publication options and retry the read-only preflight.",
  },
  {
    id: "authorization-expired",
    family: "publication",
    classification: "situation",
    failureClass: "auth",
    publicationAction: "Review the unchanged plan and issue a fresh publication authorization.",
  },
  {
    id: "invalid-run-record",
    family: "publication",
    classification: "situation",
    failureClass: "contract-shape",
    publicationAction: "Select an intact DocsFab schema-v2 run record.",
  },
  {
    id: "saved-run-not-found",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    nextAction: SAVED_RUN_NOT_FOUND_NEXT_ACTION,
    publicationAction: SAVED_RUN_NOT_FOUND_NEXT_ACTION,
    docsAnchor: "docs/troubleshooting.md",
  },
  {
    id: "state-directory-not-run-store",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Pass --state-dir at the run-store directory, not its parent.",
  },
  {
    id: "run-record-contract-gap",
    family: "publication",
    classification: "situation",
    failureClass: "contract-shape",
    publicationAction:
      "This succeeded write cannot be published because DocsFab rejected a legal run-record field. Retrying the same record will not help; the patch remains preserved.",
  },
  {
    id: "run-not-succeeded",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "Publish only a terminal successful run; the preserved patch remains available.",
  },
  {
    id: "run-not-write-capable",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Select a successful run that executed an authorized write step.",
  },
  {
    id: "patch-ineligible",
    family: "publication",
    classification: "situation",
    failureClass: "contract-shape",
    publicationAction:
      "Select a run with internally consistent standard Git patch and changed-file evidence.",
  },
  {
    id: "patch-unavailable",
    family: "publication",
    classification: "situation",
    failureClass: "infrastructure",
    publicationAction: "Restore the private patch artifact recorded by the run and retry.",
  },
  {
    id: "patch-mismatch",
    family: "publication",
    classification: "situation",
    failureClass: "contract-shape",
    publicationAction:
      "Restore the exact digest-bound patch artifact recorded by the run and retry.",
  },
  {
    id: "patch-credential-material",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "Remove the configured credential from the changed files and rotate it, then run the workflow again; DocsFab never publishes its own credentials.",
  },
  {
    id: "repository-mismatch",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    remediationId: "retry-recorded-source-path",
    publicationAction:
      "Retry publication against the same --repo path the succeeded run recorded. This is not tracked dirt, a subdirectory, or a missing Git checkout.",
  },
  {
    id: "not-a-git-repository",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    remediationId: "select-git-repository",
    publicationAction:
      "Pass --repo at a local Git checkout. The selected path is not a Git work tree.",
  },
  {
    id: "not-repository-root",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    remediationId: "use-git-repository-root",
    publicationAction: "Pass --repo at the Git repository root, not a subdirectory.",
  },
  {
    id: "tracked-source-dirty",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    remediationId: "clean-tracked-source",
    publicationAction:
      "Commit, stash, or discard tracked and staged changes, then retry. Untracked files are allowed.",
  },
  {
    id: "unsafe-git-configuration",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    remediationId: "remove-unsafe-git-configuration",
    publicationAction:
      "Retry from a checkout whose local Git config does not enable hooks, fsmonitor, includes, or content filters.",
  },
  {
    // Delivery preflight's refusal of a Git setting the host publisher refuses
    // (#2363). The receipt code of the same name is the operator row below.
    id: "git-configuration-refused",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    remediationId: "remove-refused-git-setting",
    publicationAction: REMOVE_REFUSED_GIT_SETTING_TEXT,
  },
  {
    // Delivery preflight could not read the Git configuration the publisher
    // will read (#2363). The receipt code of the same name is the operator
    // row below.
    id: "git-checkout-unverified",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    remediationId: "repair-git-checkout",
    publicationAction: REPAIR_GIT_CHECKOUT_TEXT,
  },
  {
    id: "head-revision-invalid",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "Attach the checkout to a named branch whose HEAD is a Git commit, then retry.",
  },
  {
    id: "detached-head",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Attach the source checkout to a local branch before retrying preflight.",
  },
  {
    id: "missing-remote",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Configure a GitLab remote or select an existing remote explicitly.",
  },
  {
    id: "ambiguous-remote",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    remediationId: "select-publication-remote",
    publicationAction:
      "Pass --remote <name> on do, run, or publish. DocsFab selects origin when that remote exists.",
  },
  {
    id: "ambiguous-remote-url",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Configure exactly one fetch URL for the selected remote.",
  },
  {
    id: "unsupported-remote",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Use an uncredentialed GitLab SSH or HTTPS remote.",
  },
  {
    id: "git-identity-missing",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Configure local Git user.name and user.email before publishing.",
  },
  {
    id: "glab-unavailable",
    family: "publication",
    classification: "situation",
    failureClass: "infrastructure",
    publicationAction: "Install glab and retry the read-only preflight.",
  },
  {
    id: "gitlab-unauthenticated",
    family: "publication",
    classification: "situation",
    failureClass: "auth",
    inEnvelope: true,
    remediationId: "glab-auth-login",
    publicationAction:
      "Authenticate glab for the selected GitLab host with `glab auth login --hostname <host from the selected remote>` and retry.",
  },
  {
    id: "gitlab-unreachable",
    family: "publication",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    remediationId: "retry-gitlab-api",
    publicationAction:
      "GitLab API for the selected remote host is unreachable. Confirm network or VPN, then retry `glab api --hostname <host from git remote> user`.",
  },
  {
    id: "gitlab-response-invalid",
    family: "publication",
    classification: "situation",
    failureClass: "infrastructure",
    publicationAction: "Verify glab and GitLab API availability, then retry.",
  },
  {
    id: "project-mismatch",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Select a remote whose GitLab project matches its canonical API identity.",
  },
  {
    id: "insufficient-push-access",
    family: "publication",
    classification: "situation",
    failureClass: "auth",
    publicationAction: "Ask for Developer-or-higher project access or keep patch-only delivery.",
  },
  {
    id: "target-branch-missing",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Select an existing GitLab target branch.",
  },
  {
    id: "run-revision-missing",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "The run base commit is missing locally. Fetch the repository or create a new run at GitLab's current target-branch revision.",
  },
  {
    // Preflight could not build the private copy of the run base plus the
    // verified patch that a source-aware validation binds to (#2359). Only a
    // patch that does not apply falls back, so delivery names patch-conflict.
    id: "validation-candidate-unavailable",
    family: "publication",
    classification: "situation",
    failureClass: "infrastructure",
    publicationAction:
      "DocsFab could not build the private copy of the run base plus the patch that it validates. Check that the run's base commit is still in this checkout and that the DocsFab state directory is writable and has free space, then retry the publication.",
  },
  {
    id: "stale-revision",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    // Phase-neutral on every surface. A succeeded write is preserved, so ship
    // republishes it once the target branch contains the run base (#2120).
    // GitLab advancing past the run base alone is publishable.
    publicationAction:
      "The run base is not an ancestor of GitLab's target branch; for example, it is only on another branch, or the target-branch history was rewritten. Merge it into the target branch, then republish a preserved write with `docsfab ship <run-id> --repo <path>`; or start a new run from a commit on the target branch.",
  },
  {
    id: "run-revision-unpushed",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    // GitLab does not have the run base commit at all (#2120). DocsFab never
    // pushes it on the operator's behalf.
    publicationAction:
      "GitLab does not have the run base commit; it was never pushed. Push that commit to the target branch, then republish a preserved write with `docsfab ship <run-id> --repo <path>`; or start a new run from a commit that is already on the target branch.",
  },
  {
    id: "revision-head-rewritten",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "The MR branch no longer descends from the head DocsFab last pushed; someone rewrote it. DocsFab does not revise a rewritten branch. Review the MR and start a new publication instead.",
  },
  {
    id: "revision-mr-not-open",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "The merge request is no longer an open draft on the recorded branch and target. Reopen it or mark it as a draft again, or start a new publication.",
  },
  {
    id: "revision-requester-mismatch",
    family: "publication",
    classification: "situation",
    failureClass: "auth",
    publicationAction:
      "Only the GitLab user who requested the original publication can revise it. Authenticate glab as that user, or start a new publication.",
  },
  {
    id: "revision-parent-mismatch",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "The revision request does not match the recorded parent delivery for the named field. Revise from the latest recorded delivery of this merge request.",
  },
  {
    id: "revision-receipt-store-missing",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "A revision needs the receipt root that holds the original delivery. Pass the same --receipt-root the original publication used.",
  },
  {
    id: "revision-object-missing",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "The head DocsFab last pushed is missing from this checkout. Fetch the merge request branch into the repository, then retry.",
  },
  {
    id: "revision-parent-record-unavailable",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "The original delivery's plan or run record is missing or changed. Restore the original run record and receipt root, then retry.",
  },
  {
    id: "revision-shallow-repository",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "This checkout is shallow, so DocsFab cannot prove the branch history. Run git fetch --unshallow, then retry.",
  },
  {
    id: "revision-head-moved",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "The merge request branch moved after this revision started. Start the revision again from the branch's current head.",
  },
  {
    id: "revision-root-marker-mismatch",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction:
      "The merge request no longer carries the original DocsFab provenance marker (and, for a composition draft, its exact title and warning). Restore them, or start a new publication.",
  },
  {
    id: "unsafe-source-branch",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Choose a new, valid non-default source branch.",
  },
  {
    id: "source-branch-is-default",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Choose a source branch distinct from the GitLab default branch.",
  },
  {
    id: "source-branch-is-target",
    family: "publication",
    classification: "situation",
    failureClass: "operator-input",
    publicationAction: "Choose a source branch distinct from the merge-request target branch.",
  },
  {
    id: "source-branch-protected",
    family: "publication",
    classification: "situation",
    failureClass: "auth",
    publicationAction: "Choose a source branch not covered by GitLab branch protection.",
  },
  {
    id: "protected-branch-check-incomplete",
    family: "publication",
    classification: "situation",
    failureClass: "bound",
    publicationAction: "Reduce or review the project protection rules before publishing.",
  },
  {
    // The catalog refusal of runs.recordMaxBytes; the message names the
    // observed size, the bound, and how to raise it.
    id: "runs-record-max-bytes-bound",
    family: "publication",
    classification: "situation",
    failureClass: "bound",
    publicationAction:
      "The saved run record is larger than runs.recordMaxBytes. Raise that bound as this message names, then rerun the same publication command; the record and its patch are unchanged.",
  },
] as const satisfies readonly SituationRow[];

const DELIVERY_SITUATIONS = [
  {
    id: "invalid-delivery-input",
    family: "delivery",
    classification: "situation",
    failureClass: "operator-input",
    deliveryAction:
      "Use the exact authorized publication plan and absolute operator-selected paths.",
  },
  {
    id: "authorization-mismatch",
    family: "delivery",
    classification: "situation",
    failureClass: "auth",
    deliveryAction: "Authorize the exact publication plan before materializing delivery state.",
  },
  {
    id: "delivery-root-unsafe",
    family: "delivery",
    classification: "situation",
    failureClass: "operator-input",
    deliveryAction: "Select an owner-controlled, non-symlinked delivery directory.",
  },
  {
    id: "delivery-collision",
    family: "delivery",
    classification: "situation",
    failureClass: "operator-input",
    deliveryAction:
      "Preserve the existing delivery and use a distinct run or explicitly clean it up.",
  },
  {
    id: "source-repository-mismatch",
    family: "delivery",
    classification: "situation",
    failureClass: "operator-input",
    deliveryAction: "Use the exact source checkout recorded by the successful run.",
  },
  {
    id: "source-state-changed",
    family: "delivery",
    classification: "situation",
    failureClass: "operator-input",
    deliveryAction: "Restore the source checkout to its pre-delivery state before retrying.",
  },
  {
    // The succeeded run's record has a legal field delivery could not decode
    // (#2366). It used to read as run-record-mismatch.
    id: "run-record-contract-gap",
    family: "delivery",
    classification: "situation",
    failureClass: "contract-shape",
    deliveryAction:
      "DocsFab could not decode a legal field of this succeeded run's record while preparing delivery. Retrying the same record will not help; the patch remains preserved.",
  },
  {
    id: "run-record-mismatch",
    family: "delivery",
    classification: "situation",
    failureClass: "contract-shape",
    deliveryAction: "Use the exact private run record reviewed during preflight.",
  },
  {
    id: "patch-mismatch",
    family: "delivery",
    classification: "situation",
    failureClass: "contract-shape",
    deliveryAction: "Restore the exact private patch reviewed during preflight.",
  },
  {
    id: "patch-path-mismatch",
    family: "delivery",
    classification: "situation",
    failureClass: "contract-shape",
    deliveryAction: "Regenerate the run evidence so patch paths and recorded changes agree.",
  },
  {
    id: "base-revision-mismatch",
    family: "delivery",
    classification: "situation",
    failureClass: "contract-shape",
    deliveryAction: "Materialize only the exact immutable revision recorded by the run.",
  },
  {
    id: "worktree-creation-failed",
    family: "delivery",
    classification: "situation",
    failureClass: "infrastructure",
    deliveryAction:
      "Inspect Git worktree and branch state; the verified recovery patch remains preserved.",
  },
  {
    id: "patch-conflict",
    family: "delivery",
    classification: "situation",
    failureClass: "operator-input",
    deliveryAction:
      "Resolve base drift by creating a new governed run; the failed delivery remains preserved.",
  },
  {
    id: "patch-application-failed",
    family: "delivery",
    classification: "situation",
    failureClass: "infrastructure",
    deliveryAction: "Inspect the preserved delivery worktree and verified recovery patch.",
  },
  {
    id: "delivery-credential-material",
    family: "delivery",
    classification: "situation",
    failureClass: "operator-input",
    deliveryAction:
      "Remove the configured credential from the changed files and rotate it, then run the workflow again; DocsFab never publishes its own credentials.",
  },
  {
    id: "validation-failed",
    family: "delivery",
    classification: "situation",
    failureClass: "model-content",
    deliveryAction: "Inspect the preserved worktree, then retry through a new authorized delivery.",
  },
  {
    id: "validation-isolation-unavailable",
    family: "delivery",
    classification: "situation",
    failureClass: "infrastructure",
    deliveryAction: "Configure a supported deny-network, write-confined OS sandbox.",
  },
  {
    id: "validation-mutated-delivery",
    family: "delivery",
    classification: "situation",
    failureClass: "infrastructure",
    deliveryAction:
      "Inspect the preserved worktree; validation changed the governed patch or Git state.",
  },
  {
    id: "cleanup-refused",
    family: "delivery",
    classification: "situation",
    failureClass: "operator-input",
    deliveryAction:
      "Use the explicit operator-discard confirmation for failed or uncommitted delivery state.",
  },
  {
    id: "cleanup-failed",
    family: "delivery",
    classification: "situation",
    failureClass: "infrastructure",
    deliveryAction:
      "Inspect the preserved delivery and Git worktree registration before retrying cleanup.",
  },
] as const satisfies readonly SituationRow[];

const CONTRACT_SITUATIONS = [
  {
    id: "invalid-shape",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction:
      "Inspect the rejected artifact against the published contract schema, then retry with a conforming payload.",
  },
  {
    id: "invalid-value",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction: "Correct the invalid field value and retry with a valid payload.",
  },
  {
    id: "invalid-catalog",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction:
      "Use the sealed catalog published by DocsFab; do not substitute a hand-edited catalog.",
  },
  {
    id: "invalid-observation",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction: "Rebuild the observation from host-owned evidence and retry.",
  },
  {
    id: "invalid-finding",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction: "Rebuild the finding from sealed observation evidence and retry.",
  },
  {
    id: "invalid-authority",
    family: "contract",
    classification: "situation",
    failureClass: "auth",
    inEnvelope: true,
    nextAction: "Issue a fresh host authority receipt for the exact operation, then retry.",
  },
  {
    id: "authority-required",
    family: "contract",
    classification: "situation",
    failureClass: "auth",
    inEnvelope: true,
    nextAction: "Provide a valid host authority receipt for this operation, then retry.",
  },
  {
    id: "authority-replayed",
    family: "contract",
    classification: "situation",
    failureClass: "auth",
    inEnvelope: true,
    nextAction: "Issue a fresh authority receipt; replayed receipts are rejected.",
  },
  {
    id: "credential-material",
    family: "contract",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    nextAction:
      "Remove credential material from the payload; DocsFab never stores SCM or model credentials in records.",
  },
  {
    id: "credential-isolation-boundary",
    family: "contract",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    nextAction:
      "Remove DocsFab's own configured credential from the request, source, or repository content that carried it, and rotate it; host credentials belong only in transport authentication.",
  },
  {
    id: "digest-mismatch",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction: "Recompute digests from the exact sealed bytes and retry with matching evidence.",
  },
  {
    id: "duplicate-input",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction: "Deduplicate the conflicting input entry and retry with a unique binding.",
  },
  {
    id: "lifecycle-conflict",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction: "Respect the sealed lifecycle state; replan before mutating a conflicting record.",
  },
  {
    id: "substitution",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction: "Reject substituted material; retry with the exact previously sealed artifact.",
  },
  {
    id: "migration-required",
    family: "contract",
    classification: "ambiguous",
    failureClass: "contract-shape",
    inEnvelope: true,
    docsAnchor: ARCHITECTURE_DOCS,
    nextAction: "Migrate the artifact to the current schema version before retrying.",
  },
  {
    id: "replan-required",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction: "Replan from the current sealed evidence before authorizing further mutations.",
  },
  {
    id: "invalid-record",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction: "Inspect the rejected record path, correct the contract fields, and retry.",
  },
  {
    id: "invalid-authorization",
    family: "contract",
    classification: "situation",
    failureClass: "auth",
    inEnvelope: true,
    nextAction: "Issue a fresh exact authorization for the intended operation, then retry.",
  },
  {
    id: "schema-mismatch",
    family: "contract",
    classification: "frozen-stem",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction: "Correct the artifact kind or shape to match the sealed schema, then retry.",
  },
  {
    id: "proposal-scope-input-invalid",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction:
      "Correct the proposal scope so it names an explicit safe documentation target, then start a new run.",
  },
  {
    id: "plan-target-not-named",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Name each intended agent instruction file or hidden file by its exact repository-relative path in your own request, then start a new run. Naming does not override other protected paths or the write roots.",
  },
  {
    id: "proposal-scope-unsafe-target",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction:
      "Name each page as a relative Markdown path under the write roots the message names, outside protected, hidden, code, and CI directories, and not an agent instruction file such as AGENTS.md. To write in another documentation directory, list it in documentationRoots in .docsfab.json, then start a new run.",
  },
  {
    id: "ambiguous-targets",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction:
      "Name the documentation page the request writes, under docs/, fern/, or a documentationRoots entry in .docsfab.json, then start a new run.",
  },
  {
    // Configuration narrowed the write roots to none; every write path that
    // needs a root refuses with this same code, message, and action.
    id: "documentation-roots-outside-write-roots",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    docsAnchor: CONFIGURATION_DOCS,
    nextAction:
      "Fix documentationRoots in .docsfab.json so that at least one entry is a write root by the rule the message states, or remove documentationRoots to write under docs/ and fern/, then commit the file and start a new run.",
  },
  {
    id: "proposal-scope-ambiguous-targets",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction:
      "Amend the instruction to name one unambiguous documentation target or one consistent bounded target set, then start a new run.",
  },
  {
    id: "proposal-scope-duplicate-targets",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction:
      "Name each page once, or ask for a change to the page in every mention, then start a new run.",
  },
  {
    id: "proposal-scope-conflicting-targets",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction:
      "Make the requested targets and change-only restriction agree, then start a new run.",
  },
  {
    id: "proposal-scope-binding-mismatch",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction:
      "Rebuild the proposal scope for the exact instruction digest and repository revision before starting a new run.",
  },
  {
    id: "proposal-scope-excludes-project-config",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction:
      "Amend the explicit proposal scope to include the required project configuration and documentation target before starting a new run.",
  },
  {
    id: "proposal-scope-non-actionable-targets",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    nextAction:
      "Rephrase the instruction as a request to proceed with the change to the named pages, then start a new run.",
  },
  {
    id: "first-pass-support-invalid",
    family: "contract",
    classification: "situation",
    failureClass: "planning-refusal",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Correct the named first-pass support contract or evidence rule, then start a new run. Do not repeat unchanged inference.",
  },
  {
    // Sealed source authority evidence, a binding, or a request broke the
    // authority's contract; the message names the rule. Same text as
    // INVALID_ORIGINAL_SOURCE_AUTHORITY_NEXT_ACTION in
    // workflow-execution/source-obligation-authority.ts;
    // test/source-obligation-authority-paths.test.ts holds the two equal.
    id: "invalid-original-source-authority",
    family: "contract",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction:
      "Start a new run from the current checkout; do not edit or reuse the refused run evidence. If a new run stops with the same rule, report the run id and the rule to DocsFab maintainers.",
  },
] as const satisfies readonly SituationRow[];

export const NO_SUPPORTED_GITLAB_REMOTE_NEXT_ACTION =
  "For GitLab-backed setup or publication, use a checkout connected to the intended GitLab project. Local patch-only workflows can run without a remote. Do not add a fabricated remote.";

/** Shared actionable guidance for CLI capability errors and the operator catalog. */
export const RST_CAPABILITY_NEXT_ACTIONS = {
  "rst-capability-unsupported-operation":
    "Use update-documentation with --patch-only for one existing Sphinx RST page, or select a supported Markdown or MDX target.",
  "rst-capability-unsupported-cardinality":
    "Split the RST changes into separate update tasks, or use supported Markdown or MDX targets.",
  "rst-capability-unsupported-delivery":
    "Add --patch-only to the existing update command, or select a supported Markdown or MDX target.",
  "rst-capability-unsupported-adapter":
    "Use one existing RST page under a tracked Sphinx configuration, or select a supported Markdown or MDX target.",
  "rst-capability-admission-required":
    "Run one existing Sphinx RST page through the DocsFab CLI with update-documentation and --patch-only, or select a supported Markdown or MDX target.",
} as const;

/** The one remedy for a stop in loading, reading, or finding the installed governed skills. */
const INSTALLED_SKILLS_NEXT_ACTION =
  "DocsFab could not use its installed governed skills, and the error withholds host paths. Reinstall DocsFab from its exact release, or rebuild a source checkout, then run the same command again.";

const OPERATOR_SITUATIONS = [
  {
    id: "rst-capability-unsupported-operation",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: RST_CAPABILITY_DOCS,
    nextAction: RST_CAPABILITY_NEXT_ACTIONS["rst-capability-unsupported-operation"],
  },
  {
    id: "rst-capability-unsupported-cardinality",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: RST_CAPABILITY_DOCS,
    nextAction: RST_CAPABILITY_NEXT_ACTIONS["rst-capability-unsupported-cardinality"],
  },
  {
    id: "rst-capability-unsupported-delivery",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: RST_CAPABILITY_DOCS,
    nextAction: RST_CAPABILITY_NEXT_ACTIONS["rst-capability-unsupported-delivery"],
  },
  {
    id: "rst-capability-unsupported-adapter",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: RST_CAPABILITY_DOCS,
    nextAction: RST_CAPABILITY_NEXT_ACTIONS["rst-capability-unsupported-adapter"],
  },
  {
    id: "rst-capability-admission-required",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: RST_CAPABILITY_DOCS,
    nextAction: RST_CAPABILITY_NEXT_ACTIONS["rst-capability-admission-required"],
  },
  {
    id: "no-supported-gitlab-remote",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction: NO_SUPPORTED_GITLAB_REMOTE_NEXT_ACTION,
  },
  {
    id: "operator-error",
    family: "operator",
    classification: "situation",
    failureClass: "unknown",
    inEnvelope: true,
    nextAction: "Correct the reported condition, then retry the command.",
  },
  {
    id: "internal-error",
    family: "operator",
    classification: "situation",
    failureClass: "unknown",
    inEnvelope: true,
    nextAction:
      "Report this message to the DocsFab maintainers. DocsFab failed internally; it did not judge the named file invalid and left it unchanged.",
  },
  {
    id: "factory-project-denied",
    family: "operator",
    classification: "frozen-stem",
    failureClass: "auth",
    inEnvelope: true,
    remediationId: "update-docsfab-runtime",
  },
  {
    id: "host-unreachable",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    remediationId: "retry-gitlab-api",
  },
  {
    // The host publisher's receipt code for a Git identity that changed after
    // the plan bound it (#2362). It used to report as remote-drift.
    id: "git-identity-drift",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Git user.name or user.email changed after DocsFab planned this publication, and DocsFab commits only as the identity the plan bound. Set them back to the identity you published with, then retry the same publish. To publish as the new identity, start a new run.",
  },
  {
    // Git configuration the host refuses to publish with (#2363): found by
    // delivery preflight before the model run, or by the publisher before it
    // commits, pushes, or opens the merge request. It used to report as
    // remote-drift. The remediation carries the text, so the code's own name
    // does not send the envelope to the doctor fallback.
    id: "git-configuration-refused",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    remediationId: "remove-refused-git-setting",
  },
  {
    // The checkout's Git version, remote, or configuration could not be
    // verified (#2363). The publisher's `unsafe-configuration` used to report
    // as remote-drift, which sent the operator to GitLab.
    id: "git-checkout-unverified",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    remediationId: "repair-git-checkout",
  },
  {
    id: "repository-ownership-mismatch",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Run DocsFab as the checkout owner, or prepare a dedicated CI/container checkout for the DocsFab user. If ownership already matches, grant that user read access to the repository and its Git metadata, then retry. See Repository Access in docs/troubleshooting.md.",
  },
  {
    id: "repository-access-denied",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Run DocsFab as the checkout owner, or prepare a dedicated CI/container checkout for the DocsFab user. If ownership already matches, grant that user read access to the repository and its Git metadata, then retry. See Repository Access in docs/troubleshooting.md.",
  },
  {
    // #1512: a retired installed composition, legacy shortcut, preset, or raw
    // model id. Kind: change the request. The refusal's own nextAction names
    // the successor; this row is the fallback when it carries none.
    id: "composition-retired",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: MODEL_MIGRATION_DOCS,
    nextAction:
      "Select the retired selection's successor. For a GPT-5.x selection, run `docsfab setup --profile nvidia-inference-gpt-6-sol-pi` to move to GPT-6 Sol with `MODEL_API_KEY`, or choose another model with `docsfab setup` in a terminal.",
  },
  {
    // Non-interactive setup named no model; DocsFab has no default model.
    // Same text as SETUP_MODEL_CHOICES in setup/model-choice.ts;
    // test/setup-model-choice.test.ts holds the two equal.
    id: "setup-model-choice-required",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: MODEL_SETUP_DOCS,
    nextAction:
      "Run `docsfab setup` in a terminal to choose a provider, or pass `--provider <openai|openai-compatible|anthropic|anthropic-compatible> --model <id>` (compatible providers also need `--endpoint <url>`), or pass `--profile <compositionId>` with an installed composition from `docsfab composition list`.",
  },
  {
    // `docsfab profile seed` named no --preset; seed has no default model.
    // Same text as PROFILE_SEED_CHOICES in model/profile-apply/seed-choice.ts;
    // first-run-seed.test.ts holds the two equal.
    id: "profile-seed-choice-required",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: MODEL_FIELDS_DOCS,
    nextAction:
      "Choose a model with `docsfab setup`, then enter MODEL_API_KEY through the hidden setup prompt.",
  },
  {
    // A preset endpoint that is not a plain URL: unparseable, or carrying a
    // user name, password, query, or fragment. Another endpoint than the
    // preset's own is recorded, never refused.
    id: "deployment-binding-mismatch",
    family: "operator",
    classification: "ambiguous",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Set MODEL_BASE_URL, or the baseUrl setting, to a plain HTTPS URL with no user name, password, query, or fragment, then retry.",
  },
  {
    // Plain HTTP to a host that is not loopback. Kind: change the request.
    // Same text as INSECURE_MODEL_ENDPOINT_NEXT_ACTION in
    // model/endpoint-transport.ts; test/model-endpoint-transport.test.ts holds
    // the two equal.
    id: "model-endpoint-insecure-transport",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: MODEL_SETUP_DOCS,
    nextAction:
      "Use an HTTPS endpoint URL, or, for a model server on this machine, use plain HTTP with the host localhost, 127.0.0.1, or [::1], then rerun docsfab setup.",
  },
  {
    // A model key held back from an endpoint the operator did not configure;
    // nothing was sent. Kind: recover the configuration. Same text as
    // CREDENTIAL_ENDPOINT_UNTRUSTED_NEXT_ACTION in
    // security/model-credential-release.js; test/model-credential-release.test.ts
    // holds the two equal.
    id: "credential-endpoint-untrusted",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: SECURITY_DOCS,
    nextAction:
      "Set the model endpoint in your own DocsFab configuration with `docsfab setup` or MODEL_BASE_URL, then run the same command again.",
  },
  {
    // A proxy variable DocsFab cannot use; nothing was sent. Kind: change the
    // setting. Same text as OUTBOUND_PROXY_INVALID_NEXT_ACTION in
    // model/outbound-http-policy.ts; test/outbound-http-policy.test.ts holds
    // the two equal.
    id: "outbound-proxy-invalid",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: SECURITY_DOCS,
    nextAction:
      "Set the named proxy variable to an http:// or https:// proxy URL with a host, for example http://proxy.example.com:3128, or unset it, or add the target host to NO_PROXY; then run docsfab doctor and retry.",
  },
  {
    // A proxy applies but Node's proxy support is off in this process; nothing
    // was sent. Same text as OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION.
    id: "outbound-proxy-not-enabled",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: SECURITY_DOCS,
    nextAction:
      "Run DocsFab through the docsfab command on the Node.js release DocsFab requires, which turns on Node's built-in proxy support, or start Node with --use-env-proxy; otherwise unset the proxy variable or add the target host to NO_PROXY, then retry.",
  },
  {
    // The proxy refused the TCP connection or its name did not resolve; nothing
    // reached the target. Same text as OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION.
    id: "outbound-proxy-unreachable",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    docsAnchor: SECURITY_DOCS,
    nextAction:
      "Check that the proxy named by HTTPS_PROXY or HTTP_PROXY is running and reachable from this machine and that the variable names its host and port, or add the target host to NO_PROXY to connect directly; then run docsfab doctor --live and retry.",
  },
  {
    // The proxy answered the tunnel request with 403. Same text as
    // OUTBOUND_PROXY_DENIED_NEXT_ACTION.
    id: "outbound-proxy-denied",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: SECURITY_DOCS,
    nextAction:
      "Ask the proxy administrator to allow the target host, or set HTTPS_PROXY or HTTP_PROXY to a proxy that allows it, or add the target host to NO_PROXY to connect directly; then retry.",
  },
  {
    // The proxy answered the tunnel request with 407. Same text as
    // OUTBOUND_PROXY_AUTH_REQUIRED_NEXT_ACTION.
    id: "outbound-proxy-auth-required",
    family: "operator",
    classification: "situation",
    failureClass: "auth",
    inEnvelope: true,
    docsAnchor: SECURITY_DOCS,
    nextAction:
      "Add the proxy user name and password to the proxy URL in HTTPS_PROXY or HTTP_PROXY, written as user:password@ before the proxy host with reserved characters percent-encoded, or use a proxy that needs no authentication; then retry.",
  },
  {
    id: "transport-failed",
    family: "operator",
    classification: "situation",
    failureClass: "flake",
    inEnvelope: true,
    nextAction: "Retry the host or channel transport after the transient failure clears.",
  },
  {
    id: "write-grant-rejected",
    family: "operator",
    classification: "ambiguous",
    failureClass: "auth",
    inEnvelope: true,
    nextAction: "Retry through a host that already holds a write grant for this repository.",
  },
  {
    id: "packet-in-flight",
    family: "operator",
    classification: "frozen-stem",
    failureClass: "flake",
    inEnvelope: true,
    // Synthetic catalog row only: host never emits `packet-in-flight`. Live
    // collisions stay write-target-conflict / packet-conflict / session-conflict.
    nextAction: "Wait for the in-flight host packet to settle, then retry.",
  },
  {
    id: "knowledge-provider-unavailable",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction:
      "Reinstall or update DocsFab so its bundled knowledge provider is complete. If DOCSFAB_KNOWLEDGE_DIR is set, point it at a knowledge provider that matches this DocsFab version, or unset it. Then retry the same request.",
  },
  {
    // A tracked path the original source authority refuses; the message names
    // the path and the rule. Same text as SOURCE_AUTHORITY_PATH_REFUSED_NEXT_ACTION
    // in workflow-execution/source-obligation-authority.ts;
    // test/source-obligation-authority-paths.test.ts holds the two equal.
    id: "source-authority-path-refused",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Rename the tracked file or directory the message names so its path follows the named rule, or stop tracking it, then commit the change and rerun the same command.",
  },
  {
    id: "aggregate-timeout",
    family: "operator",
    classification: "situation",
    failureClass: "bound",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "The workspace export made no progress for the whole no-progress window, repository.workspaceExportStallMs. An export that keeps making progress is never stopped, so tree size alone does not cause this stop. Check that git and the disk respond, then retry. If they are healthy and one step legitimately takes longer on this host, for example under heavy load, raise DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS. Run `docsfab doctor` for offline readiness; it does not materialize the workspace.",
  },
  {
    // The same no-progress window as aggregate-timeout, reached while one
    // file's bytes were streaming from git.
    id: "per-blob-timeout",
    family: "operator",
    classification: "situation",
    failureClass: "bound",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "The file being exported made no progress for the whole no-progress window, repository.workspaceExportStallMs: no bytes arrived from git or were written to the workspace, so git or a disk stopped answering. Check that git and the disk respond, then retry. If they are healthy and one step legitimately takes longer on this host, for example under heavy load, raise DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS. Run `docsfab doctor` for offline readiness; it does not materialize the workspace.",
  },
  {
    // A write step reads what is left of every required source, in windows
    // when they do not all fit, so this stop means a source no step read has
    // not one span that fits in what is left of its source-read budget, or the
    // source is unavailable or spanless. Kind: raise the budget or change the
    // request. The step error names each source, its bytes, and the budget.
    id: "required-source-unread",
    family: "operator",
    classification: "situation",
    failureClass: "bound",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES, the write step's source-read budget (sources.readResponseCeilingBytes), to at least the bytes the step error names, or bind fewer or smaller sources, such as fewer --source files or a narrower merge-request date range, then start a new run. The saved run names each source, the bytes it needs, and the budget.",
  },
  {
    // A write step whose context packet does not fit its input-window share
    // even trimmed to its first target. Read-only steps continue without the
    // packet instead; the step record's contextPreflight.limit names the
    // share, the token budget, and the packet's measured tokens.
    id: "preflight-budget-exceeded",
    family: "operator",
    classification: "situation",
    failureClass: "bound",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Raise the context packet share that the step's contextPreflight.limit names, DOCSFAB_CONTEXT_LOCAL_PACKET_INPUT_SHARE_BASIS_POINTS or DOCSFAB_CONTEXT_CORPUS_PACKET_INPUT_SHARE_BASIS_POINTS, up to 10000. A run without an attested input window sizes packets from DOCSFAB_CONTEXT_PACKET_FALLBACK_INPUT_TOKENS: raise it, or bind an installed composition or a model profile with current metadata. Then start a new run.",
  },
  {
    // The coverage check re-verified a citation the cite screen minted from
    // the same ledger and it failed: a DocsFab producer defect, never the
    // model's. Kind: correct; the operator reports it and keeps the patch.
    id: "source-citation-ledger-contradiction",
    family: "operator",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction:
      "Report the run id and this message to the DocsFab owners: the run's own citation ledger contradicted itself, which is a DocsFab defect, not a problem with your request or the written documentation. The saved run keeps the written patch for review; retrying the unchanged request is not expected to help.",
  },
  {
    // The coverage check could not read a planned page for a reason other than
    // its absence: a host file-system failure. Kind: recover, then a new run.
    id: "source-citation-page-unreadable",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction:
      "Make the run's workspace readable to DocsFab: check the permissions of the planned page the step error names, and the disk it is on. Then start a new run. The saved run keeps any patch the step wrote.",
  },
  {
    // The content index refused something in the checkout while a step's
    // context preflight built it. Read-only steps continue without a packet;
    // only a write step, which needs one, stops. contextPreflight.cause
    // names the content index code and the file.
    id: "content-index-refused",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Fix the file that the step's contextPreflight.cause names, then commit the change and start a new run. For duplicate-node-identity, give each page its own frontmatter id; for empty-page-anchor or duplicate-page-anchor, edit the line the message names. Read-only steps already continued without a context packet; a write step needs one.",
  },
  {
    // Reading the checkout to build a step's content index failed with a
    // file-system error, which contextPreflight.cause names.
    id: "content-index-unreadable",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Check that the disk responds and that the file or directory the step's contextPreflight.cause names is readable, then start a new run. Read-only steps already continued without a context packet; a write step needs one.",
  },
  {
    // DocsFab's own compiler refused the input DocsFab built for a step, or
    // building the index or packet threw an error that is neither a content
    // index refusal nor a file-system error. contextPreflight.cause names the
    // raw reason.
    id: "context-compile-failed",
    family: "operator",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Report this DocsFab defect with `docsfab why --json` output; the step's contextPreflight.cause names the compiler's raw reason. Read-only steps already continued without a context packet. A write step needs one, so a new run of the same revision stops the same way.",
  },
  {
    // A focused step selected a page, or a directory on its path, that is an
    // alias such as a tracked symlink. DocsFab never follows it.
    id: "navigation-alias-refused",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Select the page the symlink that the step's contextPreflight.cause names links to, instead of the symlink, or replace the tracked symlink with that page and commit the change. Then start a new run. Read-only steps already continued without a context packet; a write step needs one.",
  },
  {
    // The message names the entry's index; neither text echoes its value.
    id: "public-roots-invalid",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    nextAction:
      "Correct the numbered DOCSFAB_PUBLIC_ROOTS entry, counting from 0. List normalized absolute paths joined by the platform path delimiter, with no empty entry, surrounding whitespace, trailing separator, or filesystem root. Unset DOCSFAB_PUBLIC_ROOTS to declare none, then retry.",
  },
  {
    // A page in the indexed checkout has an anchor that normalizes to nothing.
    // The message names the page, the line, and the edit. Same text as
    // PAGE_ANCHOR_NEXT_ACTIONS in content-ir/contracts.ts;
    // test/content-ir-page-anchors.test.ts holds the two equal.
    id: "empty-page-anchor",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Edit the line the message names: give the heading, explicit anchor, MyST label, or HTML id a letter or digit, or put a blank line before a --- or === line meant as a thematic break. Commit the change, then rerun the same command.",
  },
  {
    // A page in the indexed checkout defines one anchor twice. Same text as
    // PAGE_ANCHOR_NEXT_ACTIONS in content-ir/contracts.ts.
    id: "duplicate-page-anchor",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Edit the line the message names: rename the explicit anchor, MyST label, or HTML id so that no other anchor on the page uses it. Commit the change, then rerun the same command.",
  },
  {
    // The catalog refusal of artifacts.maxObjectBytes (#1932). The artifact
    // store raises it during editorial admission, before a run record exists,
    // so `docsfab why` has no record to read and the envelope carries the
    // remediation. Same text as the limit's remediation in
    // config/limits/artifacts.yaml; test/artifact-object-limit-stop.test.ts
    // holds the two equal. Kind: raise the bound.
    id: "artifacts-max-object-bytes-bound",
    family: "operator",
    classification: "situation",
    failureClass: "bound",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Raise DOCSFAB_ARTIFACTS_MAX_OBJECT_BYTES, or artifacts.maxObjectBytes in the host limits file, above the observed size (at most 536870887 bytes), then rerun the same command. Stored objects are unchanged.",
  },
  {
    // The host limits file that DOCSFAB_SERVICE_ENV_FILE or a caller names
    // cannot be read, or the installed file fails with an error other than a
    // permission denial. The message names the file and the reason. An
    // installed file the user may not read is skipped with a warning instead.
    id: "host-limits-file-unreadable",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    docsAnchor: TROUBLESHOOTING_DOCS,
    nextAction:
      "Set DOCSFAB_SERVICE_ENV_FILE to a limits file this user can read, such as an empty file that you own, then rerun the same command. The service's own limit overrides do not apply to runs that name another file.",
  },
  // The live doctor's own stops. Each withholds its cause on purpose, because
  // endpoint, provider, and host-path detail can carry a credential or a private
  // location, so the code is the one place the condition is named. Doctor
  // readiness sorts these stops by the first words of the message, so a reworded
  // message moves a stop to another diagnostic.
  {
    // A stop in loading the installed governed skills, before any provider call.
    id: "skill-loading-failed",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction: INSTALLED_SKILLS_NEXT_ACTION,
  },
  {
    // The loader answered, but DocsFab could not read the skills it loaded.
    id: "skill-inspection-failed",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction: INSTALLED_SKILLS_NEXT_ACTION,
  },
  {
    // The loader reported diagnostics for the skills; the message counts them.
    id: "skill-loading-diagnostics-reported",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction: INSTALLED_SKILLS_NEXT_ACTION,
  },
  {
    // The configured skills directory held no governed skill.
    id: "governed-skills-not-found",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction: INSTALLED_SKILLS_NEXT_ACTION,
  },
  {
    // The repository's instruction files could not be inspected.
    id: "context-source-inspection-failed",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction:
      "DocsFab could not inspect the repository's instruction files, and the error withholds host paths. Check that the checkout's instruction files, such as AGENTS.md, are readable by this user, then run the same command again.",
  },
  {
    // The same situation doctor readiness reports as `provider-runtime-unavailable`.
    id: "policy-model-registration-failed",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction:
      "DocsFab could not register the policy model's provider, and the error withholds endpoint detail. Check the MODEL_* provider, endpoint, model, and key settings with `docsfab doctor`, then run the same command again.",
  },
  {
    id: "judge-model-registration-failed",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction:
      "DocsFab could not register the judge model's provider, and the error withholds endpoint detail. Check the JUDGE_* provider, endpoint, model, and key settings, then run the same command again.",
  },
  {
    // The provider registered, but not the configured model. The remediation is
    // named here so it does not depend on the message's wording.
    id: "policy-model-not-available",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    remediationId: "doctor",
  },
  {
    id: "judge-model-not-available",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    remediationId: "doctor",
  },
  {
    // The live connectivity probe did not pass. Its cause could be the network,
    // the key, or the provider, and the message keeps none of them.
    id: "live-model-check-failed",
    family: "operator",
    classification: "situation",
    failureClass: "infrastructure",
    inEnvelope: true,
    nextAction:
      "The live provider check did not succeed, and the error withholds the provider's reply. Check that the model endpoint is reachable from this machine and accepts the configured key, then run `docsfab doctor --live` again.",
  },
  {
    // The request policy reserves more of the context window, or asks for more
    // output tokens, than the model's effective limits leave. The message names
    // each value.
    id: "model-request-policy-exceeds-limits",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    nextAction:
      "Lower the request policy's reserved context or minimum output tokens, or raise the effective limits the message names, then run the same command again.",
  },
  {
    // The acceptance export doctor refused the export's readiness. The message
    // names each difference, and a networked phase's summary keeps none of them.
    id: "acceptance-export-disposition-unexpected",
    family: "operator",
    classification: "situation",
    failureClass: "operator-input",
    inEnvelope: true,
    remediationId: "doctor",
  },
  {
    // The live diagnosis returned without a provider result, which the doctor
    // does not do for a live request.
    id: "acceptance-export-live-diagnosis-incomplete",
    family: "operator",
    classification: "situation",
    failureClass: "contract-shape",
    inEnvelope: true,
    nextAction:
      "The live provider diagnosis returned without a provider result, which DocsFab does not expect. Run the acceptance again. If it stops the same way, report this DocsFab defect with the acceptance manifest.",
  },
] as const satisfies readonly SituationRow[];

export type DoctorDiagnosticCode = (typeof DOCTOR_SITUATIONS)[number]["id"];
export type OperatorRemediationId = (typeof REMEDIATION_SITUATIONS)[number]["id"];
export type LocalUserPublicationFailureCode = (typeof PUBLICATION_SITUATIONS)[number]["id"];
export type DeliveryWorktreeFailureCode = (typeof DELIVERY_SITUATIONS)[number]["id"];
export type SituationId =
  | DoctorDiagnosticCode
  | OperatorRemediationId
  | LocalUserPublicationFailureCode
  | DeliveryWorktreeFailureCode
  | (typeof CONTRACT_SITUATIONS)[number]["id"]
  | (typeof OPERATOR_SITUATIONS)[number]["id"];

export const SITUATION_CATALOG: readonly SituationRow[] = [
  ...DOCTOR_SITUATIONS,
  ...REMEDIATION_SITUATIONS,
  ...PUBLICATION_SITUATIONS,
  ...DELIVERY_SITUATIONS,
  ...CONTRACT_SITUATIONS,
  ...OPERATOR_SITUATIONS,
];

export const DOCTOR_DIAGNOSTIC_CODES: readonly DoctorDiagnosticCode[] = DOCTOR_SITUATIONS.map(
  (row) => row.id,
);

export const OPERATOR_REMEDIATION_IDS: readonly OperatorRemediationId[] =
  REMEDIATION_SITUATIONS.map((row) => row.id);

const FAMILY_PRECEDENCE: readonly SituationFamily[] = [
  "operator",
  "contract",
  "publication",
  "remediation",
  "delivery",
  "doctor",
];

const REMEDIATION_TEXT = Object.freeze(
  Object.fromEntries(REMEDIATION_SITUATIONS.map((row) => [row.id, row.nextAction])),
) as Readonly<Record<OperatorRemediationId, string>>;

function freezeStringRecord(
  entries: Iterable<readonly [string, string]>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(entries));
}

function envelopeNextAction(row: SituationRow): string | undefined {
  if (row.nextAction) return row.nextAction;
  if (row.remediationId && row.remediationId in REMEDIATION_TEXT) {
    return REMEDIATION_TEXT[row.remediationId as OperatorRemediationId];
  }
  return undefined;
}

export const DEFAULT_NEXT_ACTIONS: Readonly<Record<string, string>> = freezeStringRecord(
  SITUATION_CATALOG.flatMap((row) => {
    if (!row.inEnvelope) return [];
    const action = envelopeNextAction(row);
    return action ? [[row.id, action] as const] : [];
  }),
);

export const DEFAULT_DOCS_ANCHORS: Readonly<Record<string, string>> = freezeStringRecord(
  SITUATION_CATALOG.flatMap((row) =>
    row.docsAnchor && !row.docsAnchorOverride ? [[row.id, row.docsAnchor] as const] : [],
  ),
);

export const REMEDIATION_DOCS_ANCHORS: Readonly<Partial<Record<OperatorRemediationId, string>>> =
  Object.freeze(
    Object.fromEntries(
      (REMEDIATION_SITUATIONS as readonly SituationRow[]).flatMap((row) =>
        row.docsAnchorOverride && row.docsAnchor
          ? [[row.id as OperatorRemediationId, row.docsAnchor] as const]
          : [],
      ),
    ),
  );

export const PUBLICATION_ACTIONS: Readonly<Record<LocalUserPublicationFailureCode, string>> =
  Object.freeze(
    Object.fromEntries(PUBLICATION_SITUATIONS.map((row) => [row.id, row.publicationAction])),
  ) as Readonly<Record<LocalUserPublicationFailureCode, string>>;

export const DELIVERY_ACTIONS: Readonly<Record<DeliveryWorktreeFailureCode, string>> =
  Object.freeze(
    Object.fromEntries(DELIVERY_SITUATIONS.map((row) => [row.id, row.deliveryAction])),
  ) as Readonly<Record<DeliveryWorktreeFailureCode, string>>;

export const DOCTOR_DIAGNOSTIC_REMEDIATION: Readonly<
  Partial<Record<DoctorDiagnosticCode, OperatorRemediationId>>
> = Object.freeze(
  Object.fromEntries(
    (DOCTOR_SITUATIONS as readonly SituationRow[]).flatMap((row) =>
      row.remediationId
        ? [[row.id as DoctorDiagnosticCode, row.remediationId as OperatorRemediationId] as const]
        : [],
    ),
  ),
);

export function situationRowsForId(id: string): readonly SituationRow[] {
  return SITUATION_CATALOG.filter((row) => row.id === id);
}

export function situationRowForId(id: string): SituationRow | undefined {
  const rows = situationRowsForId(id);
  if (rows.length === 0) return undefined;
  for (const family of FAMILY_PRECEDENCE) {
    const match = rows.find((row) => row.family === family);
    if (match) return match;
  }
  return rows[0];
}

export function isOperatorRemediationId(value: string): value is OperatorRemediationId {
  return (OPERATOR_REMEDIATION_IDS as readonly string[]).includes(value);
}

export function isDoctorDiagnosticCode(value: string): value is DoctorDiagnosticCode {
  return (DOCTOR_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

export function catalogRemediationText(id: OperatorRemediationId): string {
  return REMEDIATION_TEXT[id];
}

export function remediationIdForSituation(id: string): OperatorRemediationId | undefined {
  if (isOperatorRemediationId(id)) return id;
  const row = situationRowForId(id);
  if (row?.remediationId && isOperatorRemediationId(row.remediationId)) return row.remediationId;
  return undefined;
}

export function remediationIdForDoctorDiagnostic(code: string): OperatorRemediationId | undefined {
  if (!isDoctorDiagnosticCode(code)) return undefined;
  return DOCTOR_DIAGNOSTIC_REMEDIATION[code];
}

/**
 * Docs lookup for the operator envelope: a remediation override wins, then the
 * code's catalog row, then the inferred remediation row's anchor.
 */
export function resolveSituationDocsAnchor(
  code: string,
  remediationId?: OperatorRemediationId,
): string | undefined {
  if (remediationId) {
    const override = REMEDIATION_DOCS_ANCHORS[remediationId];
    if (override) return override;
  }
  return (
    DEFAULT_DOCS_ANCHORS[code] ?? (remediationId ? DEFAULT_DOCS_ANCHORS[remediationId] : undefined)
  );
}

export class SituationRejection extends Error {
  readonly code: string;
  readonly situationId: SituationId;

  constructor(id: SituationId, cause?: unknown) {
    const row = situationRowForId(id);
    const message =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string" && cause.trim().length > 0
          ? cause.trim()
          : `DocsFab rejected the request (${id}).`;
    super(message);
    this.name = "SituationRejection";
    this.situationId = id;
    this.code = row?.id ?? id;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** Operator-boundary verb. Closed-schema `fail(contractCode)` stays local to kits. */
export function rejectSituation(id: SituationId, cause?: unknown): never {
  throw new SituationRejection(id, cause);
}
