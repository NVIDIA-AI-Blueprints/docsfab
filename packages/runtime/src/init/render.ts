// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-facing render seam for DocsFab init plans, results, and failures.
 */
import {
  formatCheckGrid,
  pushSectionHeader,
  type CliFormatOptions,
  type ReadinessCheckRow,
} from "../operator/cli-format.js";
import {
  presentDecision,
  presentInspection,
  presentResult,
  renderPresentation,
  resolveProcessPresentationCapabilities,
  type DecisionPresentationFacts,
  type PresentationAction,
  type PresentationDocument,
  type PresentationField,
  type PresentationSection,
  type ResultPresentationFacts,
} from "../operator/index.js";
import {
  formatOperatorErrorEnvelope,
  serializeOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
  type OperatorErrorEnvelope,
} from "../operator/error-envelope.js";
import {
  formatRemediationLine,
  inferRemediationId,
  remediationText,
} from "../operator/remediation.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  COMMIT_DOCSFAB_JSON_ACTION,
  DOCSFAB_PROJECT_CONFIG_FILE,
  type InitApplyNextAction,
  type DocsFabInitPlan,
} from "./types.js";
import { assertCredentialFree } from "./shared.js";
import { assertDocsFabProjectConfig } from "./project-config.js";
import type { GitignoreAppendResult, GitignoreLimitExceeded } from "./gitignore.js";
import { ConfigurationRootPermissionError } from "../config/host-paths.js";
import { ConfigurationRootNotCanonicalError } from "./storage.js";

export const COMMIT_DOCSFAB_JSON_REMEDIATION =
  `Commit \`${DOCSFAB_PROJECT_CONFIG_FILE}\` locally on a task branch (not the default branch) before requesting a draft MR; do not add the project file to \`.gitignore\`. ` +
  "Run `docsfab doctor --use draft-mr` to check remaining publication prerequisites.";

export function serializeDocsFabInitPlan(plan: DocsFabInitPlan): string {
  assertCredentialFree(plan, "Initialization plan contained credential material and was withheld.");
  return canonicalizeJsonEvidence(plan as unknown as JsonEvidenceValue).trimEnd();
}

export type DocsFabInitRenderOptions = {
  readinessChecks?: readonly ReadinessCheckRow[];
} & CliFormatOptions;

export function formatDocsFabInitPlan(
  plan: DocsFabInitPlan,
  options: DocsFabInitRenderOptions = {},
): string {
  assertDocsFabProjectConfig(plan.projectConfig);
  const output = renderWithChecks(initPlanPresentation(plan), options, options.readinessChecks);
  assertCredentialFree(
    output,
    "Initialization output contained credential material and was withheld.",
  );
  return output;
}

function initField(
  label: string,
  value: string,
  importance?: "ordinary" | "material",
): PresentationField {
  return {
    label,
    evidence: { state: "known", value },
    ...(importance === undefined ? {} : { importance }),
  };
}

function initAction(remediation: InitApplyNextAction): PresentationAction {
  return {
    kind: "instruction",
    text:
      remediation === COMMIT_DOCSFAB_JSON_ACTION
        ? COMMIT_DOCSFAB_JSON_REMEDIATION
        : formatRemediationLine(remediation),
  };
}

function initAttention(plan: DocsFabInitPlan): { message: string } | null {
  if (plan.gitignore.limitExceeded)
    return { message: gitignoreLimitLine(plan.gitignore.limitExceeded) };
  if (plan.gitignore.action === "skip") {
    return {
      message: `The private .gitignore update was skipped: ${plan.gitignore.reason ?? "unavailable"}.`,
    };
  }
  if (plan.gitlabAuthentication !== "configured") {
    return {
      message: `GitLab authentication is ${plan.gitlabAuthentication}; project readiness is not established.`,
    };
  }
  if (plan.gitlabProject !== "ready")
    return { message: "The GitLab project could not be confirmed as ready." };
  if (plan.providerConfiguration !== "ready") {
    return {
      message: `Provider configuration is ${plan.providerConfiguration}; setup may need attention.`,
    };
  }
  if (plan.doctor !== "ready") return { message: `Host profile diagnose is ${plan.doctor}.` };
  return null;
}

/** Pure projection of the exact plan shown before the existing approval prompt. */
export function initPlanPresentation(plan: DocsFabInitPlan): PresentationDocument {
  assertDocsFabProjectConfig(plan.projectConfig);
  const fileEffects = plan.changedPaths.length
    ? plan.changedPaths.map((path) => initField("File effect", path, "material"))
    : [initField("File effects", "none")];
  const gitignoreEffect = initField(
    "Private .gitignore",
    `${plan.gitignore.action}${plan.gitignore.missingEntries.length ? `; missing entries: ${plan.gitignore.missingEntries.join(", ")}` : ""}${plan.gitignore.reason ? `; reason: ${plan.gitignore.reason}` : ""}`,
    plan.gitignore.action === "skip" ||
      plan.gitignore.action === "create" ||
      plan.gitignore.action === "append"
      ? "material"
      : "ordinary",
  );
  const detailSections: PresentationSection[] = [
    {
      title: "Proposed file effects",
      fields: [
        ...fileEffects,
        gitignoreEffect,
        ...(plan.gitignore.limitExceeded
          ? [initField("Limit", gitignoreLimitLine(plan.gitignore.limitExceeded), "material")]
          : []),
      ],
    },
    {
      title: "Setup status",
      fields: [
        initField("GitLab remote", plan.projectConfig.gitlab.remote),
        initField("GitLab default branch", plan.projectConfig.gitlab.defaultBranch),
        initField("GitLab authentication", plan.gitlabAuthentication),
        initField("GitLab project", plan.gitlabProject),
        initField("Provider configuration", plan.providerConfiguration),
        initField("Profile status", plan.profileStatus),
        initField("Host profile diagnose", `${plan.doctor} (not repository doctor)`),
        initField(
          "Private roots",
          "runs, evidence, delivery, receipts are user-private; paths withheld",
        ),
      ],
    },
  ];
  const inspection = presentInspection({
    title: "DocsFab initialization preview",
    subject: { state: "known", value: `${plan.repository} (path withheld)` },
    findings: [
      initField(
        "Project configuration",
        plan.change === "none"
          ? "already current; initialization will not rewrite .docsfab.json"
          : `will ${plan.change} ${DOCSFAB_PROJECT_CONFIG_FILE}`,
      ),
      initField("Plan digest", plan.sha256, "material"),
    ],
    sections: detailSections,
    attention: null,
  });
  const decisionFacts: DecisionPresentationFacts = {
    title: "Initialization approval",
    question: `Approve only these proposed effects for exact plan digest ${plan.sha256}? Nothing changes until approval.`,
    choices: [
      initField("Approve", "Yes; applies only after the exact digest is revalidated."),
      initField("Cancel", "Default; no project configuration is applied."),
    ],
    actions: [
      {
        kind: "instruction",
        text: `To apply, rerun docsfab init from the same repository context and repeat the same --repo and --remote selections; add --non-interactive --apply --approve-plan-sha256 ${plan.sha256}.`,
      },
      ...plan.nextActions.map(initAction),
    ],
    attention: initAttention(plan),
  };
  const decision = presentDecision(decisionFacts);
  return {
    title: inspection.title,
    attention: decision.attention,
    rows: [...inspection.rows, ...decision.rows],
    actions: decision.actions,
  };
}

/** Troubleshooting entry for a configuration root init refuses. */
export const INIT_CONFIGURATION_ROOT_DOCS_ANCHOR = "docs/troubleshooting.md";

/**
 * POSIX shell form that selects the root the way `resolveDocsFabConfigurationRoot`
 * does and prints its canonical path: `DOCSFAB_CONFIG_ROOT` when set and
 * non-empty; else `XDG_CONFIG_HOME/docsfab` when `XDG_CONFIG_HOME` is absolute
 * and normalized (a relative, `.`/`..`, doubled-slash, or trailing-slash value
 * is ignored, as init ignores it); else `$HOME/.config/docsfab`. It creates a
 * missing root owner-only first, and it exports nothing when any step fails.
 * Case patterns carry a leading `(` so bash 3.2 parses them inside `$(...)`.
 * Outside its scope: an `XDG_CONFIG_HOME` padded with whitespace (init trims it)
 * and `XDG_CONFIG_HOME=/`. `test/init-configuration-root-shell-form.test.ts`
 * executes this literal.
 */
export const INIT_CONFIGURATION_ROOT_SHELL_FORM =
  'docsfab_root="$(x="${XDG_CONFIG_HOME-}"; case "$x" in (/) ;; (*//*|*/./*|*/../*|*/.|*/..|*/|[!/]*) x= ;; esac; r="${DOCSFAB_CONFIG_ROOT:-${x:-$HOME/.config}/docsfab}"; mkdir -p -m 700 "$r" && cd "$r" && pwd -P)" && export DOCSFAB_CONFIG_ROOT="$docsfab_root"';

/**
 * Next action for `configuration-root-not-canonical`. It names no path
 * literal, so the host-path redaction in operator output cannot empty it.
 */
export const INIT_CONFIGURATION_ROOT_NEXT_ACTION = `Rerun docsfab init with DOCSFAB_CONFIG_ROOT set to the resolved path in the message; this shell form finds it and creates a missing root owner-only first: ${INIT_CONFIGURATION_ROOT_SHELL_FORM}`;

/** Map init-boundary failures through the operator error envelope. */
export function mapInitFailure(error: unknown): OperatorErrorEnvelope {
  if (error instanceof ConfigurationRootPermissionError) {
    return toOperatorErrorEnvelope(error, {
      nextAction: error.nextAction,
      docsAnchor: INIT_CONFIGURATION_ROOT_DOCS_ANCHOR,
    });
  }
  // Condition: the typed non-canonical-root refusal from init storage. Its own
  // advice replaces the message-inferred remediation, whose `doctor` fallback
  // cannot detect this root. Every other error, including other
  // configuration-root failures, keeps the inferred mapping below.
  if (error instanceof ConfigurationRootNotCanonicalError) {
    return toOperatorErrorEnvelope(error, {
      nextAction: INIT_CONFIGURATION_ROOT_NEXT_ACTION,
      docsAnchor: INIT_CONFIGURATION_ROOT_DOCS_ANCHOR,
    });
  }
  const hint = initFailureNextAction(error);
  return toOperatorErrorEnvelope(error, hint ? { nextAction: hint } : {});
}

export function formatInitFailure(error: unknown): string {
  return formatOperatorErrorEnvelope(mapInitFailure(error));
}

export function serializeInitFailure(error: unknown): string {
  return serializeOperatorErrorEnvelope(mapInitFailure(error));
}

export function initFailureNextAction(error: unknown): string | undefined {
  const id = inferRemediationId(error);
  return id ? remediationText(id) : undefined;
}

export function formatInitResult(
  result: {
    status: string;
    mutation: "applied" | "none";
    changedPaths?: readonly string[];
    uncertainPaths?: readonly string[];
    nextActions: readonly InitApplyNextAction[];
    gitignore?: GitignoreAppendResult;
  },
  options: DocsFabInitRenderOptions = {},
): string {
  const output = renderWithChecks(initResultPresentation(result), options, options.readinessChecks);
  assertCredentialFree(
    output,
    "Initialization output contained credential material and was withheld.",
  );
  return output;
}

/** Project post-apply facts without inferring success from the mutation alone. */
export function initResultPresentation(result: {
  status: string;
  mutation: "applied" | "none";
  changedPaths?: readonly string[];
  uncertainPaths?: readonly string[];
  nextActions: readonly InitApplyNextAction[];
  gitignore?: GitignoreAppendResult;
}): PresentationDocument {
  const changedPaths = result.changedPaths ?? [];
  const uncertainPaths = result.uncertainPaths ?? [];
  const nextActions = result.nextActions.map(initAction);
  const gitignoreLine = result.gitignore ? gitignoreStatusLine(result.gitignore) : undefined;
  const attention =
    result.status === "ready" &&
    uncertainPaths.length === 0 &&
    result.gitignore?.status !== "unknown"
      ? null
      : {
          message:
            uncertainPaths.length > 0
              ? `File state is uncertain for ${uncertainPaths.join(", ")}; inspect it before retrying.`
              : result.status === "applied-cleanup-required"
                ? "Initialization applied, but cleanup remains required."
                : result.status === "needs-attention"
                  ? "Initialization needs attention after applying its changes."
                  : "Initialization completed with an uncertain private .gitignore write state.",
        };
  const facts: ResultPresentationFacts = {
    title:
      result.mutation === "applied" ? "Initialization applied" : "Initialization already current",
    outcome: initField(
      "Mutation",
      result.mutation === "applied" ? "applied" : "none; project configuration was not rewritten",
    ),
    statusPlanes: [initField("Initialization status", `${result.status}.`)],
    effects: [
      initField("Changed files", changedPaths.length > 0 ? changedPaths.join(", ") : "none"),
      ...uncertainPaths.map((path) => initField("File state uncertain", path, "material")),
      ...(gitignoreLine ? [initField("Private .gitignore", gitignoreLine)] : []),
      ...(result.gitignore?.limitExceeded
        ? [initField("Limit", gitignoreLimitLine(result.gitignore.limitExceeded), "material")]
        : []),
    ],
    summary: "Private run, evidence, delivery, and receipt roots are ready (paths withheld).",
    primaryAction: nextActions[0] ?? {
      kind: "instruction",
      text: "No further action is required.",
    },
    nextActions: nextActions.slice(1),
    attention,
  };
  return presentResult(facts);
}

function renderWithChecks(
  document: PresentationDocument,
  options: DocsFabInitRenderOptions,
  readinessChecks?: readonly ReadinessCheckRow[],
): string {
  const capabilities = resolveProcessPresentationCapabilities({
    ...(options.tty === undefined
      ? {}
      : { stdout: { isTTY: options.tty }, stderr: { isTTY: options.tty } }),
    environment: {
      ...(options.noColor === undefined ? {} : { noColorPresent: options.noColor }),
      ...(options.forceColor === undefined ? {} : { forceColor: options.forceColor }),
      ...(options.forceColorDisabled === undefined
        ? {}
        : { forceColorDisabled: options.forceColorDisabled }),
      ...(options.ci === undefined ? {} : { ci: options.ci }),
      ...(options.termDumb === undefined ? {} : { termDumb: options.termDumb }),
    },
  });
  const lines = renderPresentation(document, capabilities).stdout.trimEnd().split("\n");
  if (readinessChecks?.length) {
    pushSectionHeader(lines, "CHECKS", options);
    lines.push(...formatCheckGrid(readinessChecks, options));
  }
  return lines.join("\n");
}

/**
 * Host-profile diagnose (`plan.doctor` / checkSharedDoctor), not repository doctor.
 */
function formatHostDiagnoseLine(doctor: DocsFabInitPlan["doctor"]): string {
  return `Host profile diagnose: ${doctor} (not repository doctor)`;
}

function gitignoreStatusLine(result: GitignoreAppendResult): string | undefined {
  if (result.status === "created" || result.status === "appended") {
    return `Private \`.gitignore\` fragment ${result.status}: ${result.added.map((entry) => `\`${entry}\``).join(", ")} (never \`${DOCSFAB_PROJECT_CONFIG_FILE}\`).`;
  }
  if (result.reason === "changed-after-approval")
    return ".gitignore changed after approval; the approved fragment was not applied. Preview and approve a fresh plan.";
  if (result.status === "unknown")
    return ".gitignore write state is unknown; inspect the file before retrying.";
  if (result.status === "skipped")
    return `Private \`.gitignore\` fragment skipped: ${result.reason ?? "unavailable"}.`;
  return undefined;
}

function gitignoreLimitLine(exceeded: GitignoreLimitExceeded): string {
  return `${exceeded.code}: observed ${exceeded.observedBytes} bytes; configured ${exceeded.configuredBytes} bytes; scope: ${exceeded.scope}. ${exceeded.remediation}`;
}
