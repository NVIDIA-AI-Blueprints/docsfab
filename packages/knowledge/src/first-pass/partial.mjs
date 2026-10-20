// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Host-held documentation partial classification and later-answer binding.
 */
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { FIRST_PASS_SUPPORT_KIND } from "./assess.mjs";
import { FirstPassSupportError } from "./error.mjs";
import {
  SAFE_TARGET,
  isInsideAuthorizedWriteRoots,
  normalizeAuthorizedWriteRoots,
  requireText,
  sha256,
  stableJson,
} from "./parse.mjs";

export const DOCUMENTATION_PARTIAL_KIND = "docsfab-documentation-partial-result";
export const DOCUMENTATION_PARTIAL_APPLICABILITIES = Object.freeze([
  "useful-partial",
  "scaffold-only",
  "no-useful-deliverable",
  "cancellation",
  "execution-failure",
]);
const INSTALLATION_GUIDE =
  /\b(?:installation\s+guide|get[\s-]?started(?:\s+guide)?|getting\s+started|procedural\s+install)\b/iu;
const INSTALLATION_TARGET = /(?:^|\/)(?:get-started|getting-started|install(?:ation)?)\.mdx?$/iu;
const SCAFFOLD_REQUEST = /\b(?:scaffold|outline|labeled\s+structure)\b/iu;
const STRICT_ORIGINAL_ONLY =
  /\bstrict(?:[\s-]mode)?(?:\s+(?:original[- ]request|admission(?:\s+only)?))?/iu;

/**
 * Build the labeled host-held draft envelope from a real first-pass support
 * record. A canned object without matching supportSha256 cannot mint a draft.
 */
export function classifyDocumentationPartialFallback(input) {
  const support = requireExecutedSupport(input?.support);
  const instruction = requireText(input.instruction, "instruction");
  const authorizedWriteRoots = normalizeAuthorizedWriteRoots(input.authorizedWriteRoots);
  const obligations = withPageSupportGaps(support);
  const originalUnmet = [
    ...new Set(obligations.filter((item) => item.status !== "supported").map((item) => item.id)),
  ];
  const budgetFailed =
    support.terminationReason === "budget-exhausted" ||
    obligations.some((item) => item.status === "budget-exhausted");
  const installationGuide = isInstallationGuideCreate(support, instruction);
  const scaffoldRequested = SCAFFOLD_REQUEST.test(instruction);
  const strictOriginalOnly = STRICT_ORIGINAL_ONLY.test(instruction);
  const inScope = destinationInScope(support.targetPaths, authorizedWriteRoots);
  const conflicted = obligations.filter(
    (item) => item.status === "contradicted" && item.requiredSourceSupport,
  );
  const independentlySupported = obligations.filter(
    (item) =>
      item.status === "supported" &&
      item.requiredSourceSupport === true &&
      Array.isArray(item.evidenceSpanIds) &&
      item.evidenceSpanIds.length > 0 &&
      item.id !== "workflow-target-set" &&
      !item.id.startsWith("host-page-support"),
  );

  let applicability = "no-useful-deliverable";
  if (budgetFailed) {
    applicability = "execution-failure";
  } else if (support.workflow !== "create-documentation" || strictOriginalOnly) {
    applicability = "no-useful-deliverable";
  } else if (!inScope) {
    applicability = "cancellation";
  } else if (!installationGuide && !scaffoldRequested) {
    applicability = "no-useful-deliverable";
  } else if (independentlySupported.length > 0 && installationGuide) {
    applicability = "useful-partial";
  } else if (scaffoldRequested) {
    applicability = "scaffold-only";
  }

  let classified = obligations.map((item) =>
    Object.freeze({
      ...envelopeObligation(item, {
        applicability,
        independentlySupported,
        conflicted,
        originalIncomplete: originalUnmet.length > 0,
      }),
    }),
  );

  if (applicability === "useful-partial") {
    const hasIndependent = classified.some((item) =>
      independentlySupported.some(
        (row) => row.id === item.id && item.proposedDeliverable === "included-supported",
      ),
    );
    if (!hasIndependent) {
      applicability = "no-useful-deliverable";
      classified = obligations.map((item) =>
        Object.freeze({
          ...envelopeObligation(item, {
            applicability,
            independentlySupported,
            conflicted,
            originalIncomplete: originalUnmet.length > 0,
          }),
        }),
      );
    }
  }

  const questions = classified
    .filter((item) =>
      ["deferred", "conflicted", "cannot-proceed"].includes(item.proposedDeliverable),
    )
    .map((item) =>
      Object.freeze({
        obligationId: item.id,
        readerTask: readerTaskForObligation(item, instruction),
        neededSourceOrDecision: neededInputForObligation(item),
      }),
    );

  const claimsNotMade = claimsThatCannotBeMade(applicability, classified, instruction);
  const markdown = buildPartialMarkdown({
    applicability,
    classified,
    questions,
    instruction,
    support,
    repositoryPath: input.repositoryPath,
  });
  const includeDraft =
    (applicability === "useful-partial" || applicability === "scaffold-only") && markdown.length > 0;
  const bytesSha256 = includeDraft ? sha256(markdown) : undefined;
  const envelope = {
    schemaVersion: 1,
    kind: DOCUMENTATION_PARTIAL_KIND,
    originalRequest: {
      instructionSha256: support.instructionSha256,
      workflow: support.workflow,
      repositoryRevision: support.repositoryRevision,
      targetPaths: [...support.targetPaths],
    },
    sourceIdentity: {
      assessmentIdentitySha256: support.assessmentIdentitySha256,
      ...(typeof support.snapshotSha256 === "string"
        ? { snapshotSha256: support.snapshotSha256 }
        : {}),
      ...(typeof input.planBindingSha256 === "string"
        ? { planBindingSha256: input.planBindingSha256 }
        : {}),
    },
    applicability,
    ...(includeDraft
      ? {
          draft: {
            format: "markdown",
            bytesSha256,
            locator: `bytes:sha256:${bytesSha256}`,
          },
        }
      : { draft: null }),
    obligations: classified,
    unresolvedQuestions: questions,
    originalUnmetRequirementIds: originalUnmet,
    claimsNotMade,
    publicationEligible: false,
  };
  return Object.freeze({
    envelope: Object.freeze(envelope),
    markdown: includeDraft ? markdown : "",
    originalRequestCompletion: originalUnmet.length === 0 ? "complete" : "incomplete",
  });
}

function requireExecutedSupport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FirstPassSupportError(
      "assessment-invalid",
      "A documentation partial cannot be minted from a canned object without first-pass execution.",
    );
  }
  if (value.kind !== FIRST_PASS_SUPPORT_KIND || value.schemaVersion !== 1) {
    throw new FirstPassSupportError(
      "assessment-invalid",
      "A documentation partial cannot be minted from a canned object without first-pass execution.",
    );
  }
  const { supportSha256, ...body } = value;
  if (typeof supportSha256 !== "string" || supportSha256 !== sha256(stableJson(body))) {
    throw new FirstPassSupportError(
      "assessment-invalid",
      "A documentation partial cannot be minted from a canned object without first-pass execution.",
    );
  }
  if (
    typeof value.assessmentIdentitySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.assessmentIdentitySha256) ||
    !value.assessmentIdentity
  ) {
    throw new FirstPassSupportError(
      "assessment-invalid",
      "A documentation partial requires executed assessment identity.",
    );
  }
  return value;
}

function isInstallationGuideCreate(support, instruction) {
  if (support.workflow !== "create-documentation") return false;
  if (INSTALLATION_GUIDE.test(instruction)) return true;
  return support.targetPaths.some((path) => INSTALLATION_TARGET.test(path));
}

function destinationInScope(targetPaths, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  if (!Array.isArray(targetPaths) || targetPaths.length === 0) return false;
  return targetPaths.every(
    (path) =>
      typeof path === "string" &&
      SAFE_TARGET.test(path) &&
      posix.normalize(path) === path &&
      isInsideAuthorizedWriteRoots(path, roots),
  );
}

function envelopeObligation(item, context) {
  return {
    id: item.id,
    origin: item.origin,
    targetPaths: [...item.targetPaths],
    condition: item.condition,
    status: item.status,
    evidenceSpanIds: [...(item.evidenceSpanIds ?? [])],
    detail: item.detail ?? "",
    proposedDeliverable: proposedDeliverableFor(item, context),
  };
}

function proposedDeliverableFor(item, context) {
  const { applicability, independentlySupported, conflicted, originalIncomplete } = context;
  if (applicability === "scaffold-only") {
    return item.requiredSourceSupport ||
      item.id.startsWith("target-") ||
      item.id.startsWith("host-page-support")
      ? "template-structure"
      : "deferred";
  }
  if (
    applicability === "no-useful-deliverable" ||
    applicability === "cancellation" ||
    applicability === "execution-failure"
  ) {
    if (item.status === "budget-exhausted") return "cannot-proceed";
    if (item.status === "contradicted") return "conflicted";
    return "deferred";
  }
  if (item.status === "budget-exhausted") return "cannot-proceed";
  if (item.status === "contradicted") return "conflicted";
  if (item.id === "workflow-target-set") return originalIncomplete ? "deferred" : "included-supported";
  if (item.id.startsWith("host-page-support")) {
    return item.status === "supported" ? "included-supported" : "deferred";
  }
  if (independentlySupported.some((row) => row.id === item.id)) {
    return conflicted.some((row) => obligationDependsOnConflict(item, row))
      ? "cannot-proceed"
      : "included-supported";
  }
  if (item.status === "supported" && item.requiredSourceSupport === false) {
    return "included-supported";
  }
  return "deferred";
}

function withPageSupportGaps(support) {
  const obligations = Array.isArray(support.obligations) ? [...support.obligations] : [];
  const pageSupport = new Set(
    obligations
      .filter(
        (item) =>
          item.status === "supported" &&
          item.requiredSourceSupport === true &&
          Array.isArray(item.evidenceSpanIds) &&
          item.evidenceSpanIds.length > 0 &&
          Array.isArray(item.targetPaths) &&
          item.targetPaths.length === 1,
      )
      .flatMap((item) => item.targetPaths),
  );
  for (const targetPath of support.targetPaths ?? []) {
    if (pageSupport.has(targetPath)) continue;
    const id = `host-page-support:${targetPath}`;
    if (obligations.some((item) => item.id === id)) continue;
    obligations.push({
      id,
      origin: "workflow",
      targetPaths: [targetPath],
      condition: `Substantive repository support is required for ${targetPath}.`,
      requiredSourceSupport: true,
      status: "missing",
      evidenceSpanIds: [],
      detail: "No supported page-specific obligation cited evidence for this target.",
    });
  }
  return obligations;
}

function obligationSlot(item) {
  const condition = item.condition.toLowerCase();
  if (condition.includes("macos") || condition.includes("mac os")) return "macos";
  if (condition.includes("linux")) return "linux";
  if (condition.includes("windows")) return "windows";
  if (condition.includes("prereq")) return "prereq";
  if (condition.includes("verif")) return "verify";
  if (condition.includes("troubleshoot")) return "troubleshoot";
  if (/\b(?:apt|brew|pip|npm i|curl |wget |install command)\b/iu.test(condition)) {
    return "install-command";
  }
  return item.id;
}

function obligationDependsOnConflict(item, conflicted) {
  if (item.id === conflicted.id) return true;
  return obligationSlot(item) === obligationSlot(conflicted);
}

function readerTaskForObligation(item, instruction) {
  const condition = item.condition.toLowerCase();
  if (condition.includes("macos") || condition.includes("mac os")) return "Install on macOS";
  if (condition.includes("linux")) return "Install on Linux";
  if (condition.includes("windows")) return "Install on Windows";
  if (condition.includes("prereq")) return "Confirm prerequisites";
  if (condition.includes("verif")) return "Verify the installation";
  if (condition.includes("troubleshoot")) return "Troubleshoot the installation";
  if (INSTALLATION_GUIDE.test(instruction)) return "Complete the requested installation guide";
  return `Resolve ${item.id}`;
}

function neededInputForObligation(item) {
  if (item.status === "contradicted") {
    return `Accountable product decision or source correction for the sources that disagree on ${item.id}: ${item.condition}`;
  }
  if (item.status === "budget-exhausted") {
    return "A new first-pass assessment within the model and acquisition budgets.";
  }
  return "Repository evidence or a product decision bound to the current revision and plan.";
}

function claimsThatCannotBeMade(applicability, classified, instruction) {
  const claims = ["Publication eligibility", "Original CREATE completion from a narrowed artifact"];
  if (applicability !== "useful-partial") {
    claims.push("A supported installation procedure");
  }
  if (classified.some((item) => item.proposedDeliverable === "deferred")) {
    claims.push("Commands or steps for deferred obligations");
  }
  for (const item of classified) {
    if (item.proposedDeliverable === "conflicted") {
      claims.push(`Either disagreeing source for ${item.id} as product truth`);
    }
  }
  if (applicability === "scaffold-only") {
    claims.push("That labeled headings are product evidence");
  }
  if (/\bmacos\b/iu.test(instruction) || classified.some((item) => /macos/iu.test(item.condition))) {
    if (classified.some((item) => /macos/iu.test(item.condition) && item.proposedDeliverable !== "included-supported")) {
      claims.push("Any macOS command");
    }
  }
  return Object.freeze([...new Set(claims)]);
}

function buildPartialMarkdown(input) {
  const { applicability, classified, questions, support, repositoryPath } = input;
  if (applicability === "scaffold-only") {
    return [
      "# Installation guide scaffold (host-held, not publication-eligible)",
      "",
      "This labeled outline is a writer-continuable structure. Headings are template structure, not product evidence. The original request remains incomplete.",
      "",
      "## Prerequisites",
      "",
      "_Deferred: supply repository evidence or a product decision._",
      "",
      "## Install",
      "",
      "_Deferred: no product commands._",
      "",
      "## Verify",
      "",
      "_Deferred: no product commands._",
      "",
      "## Troubleshoot",
      "",
      "_Deferred: no product commands._",
      "",
    ].join("\n");
  }
  if (applicability !== "useful-partial") return "";
  const included = classified.filter(
    (item) =>
      item.proposedDeliverable === "included-supported" &&
      item.id !== "workflow-target-set" &&
      !item.id.startsWith("host-page-support"),
  );
  const lines = [
    "# Installation guide draft (host-held, not publication-eligible)",
    "",
    "This labeled draft retains independently supported sections. It is not a complete installation guide, a supported procedure, or a publishable page. The original request remains incomplete.",
    "",
    "## Supported sections",
    "",
  ];
  const spans = new Map((support.sourceSpans ?? []).map((span) => [span.id, span]));
  for (const item of included) {
    lines.push(`### ${item.condition}`, "");
    lines.push(`Obligation \`${item.id}\` is independently supported.`, "");
    for (const spanId of item.evidenceSpanIds) {
      const span = spans.get(spanId);
      if (!span) continue;
      lines.push(`Evidence: \`${span.path}\` lines ${span.lineStart}-${span.lineEnd}.`, "");
      const quoted = sanitizeQuotedEvidence(quoteSpan(repositoryPath, span), classified);
      if (quoted) {
        lines.push("```", quoted, "```", "");
      }
    }
  }
  const deferred = classified.filter((item) =>
    ["deferred", "conflicted", "cannot-proceed"].includes(item.proposedDeliverable),
  );
  if (deferred.length > 0) {
    lines.push("## Unresolved", "");
    for (const item of deferred) {
      const question = questions.find((entry) => entry.obligationId === item.id);
      const heading = question?.readerTask ?? item.id;
      lines.push(`### ${heading}`, "");
      lines.push(`Status: ${item.proposedDeliverable}. No product commands are minted here.`, "");
      if (question) {
        lines.push(`Question: ${question.neededSourceOrDecision}`, "");
      }
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function quoteSpan(repositoryPath, span) {
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0) return "";
  if (!span?.path || !Number.isSafeInteger(span.lineStart) || !Number.isSafeInteger(span.lineEnd)) {
    return "";
  }
  try {
    const absolute = join(repositoryPath, ...span.path.split("/"));
    const text = readFileSync(absolute, "utf8");
    const lines = text.normalize("NFC").replace(/\r\n?/gu, "\n").split("\n");
    if (span.lineEnd > lines.length || span.lineStart < 1) return "";
    const excerpt = lines.slice(span.lineStart - 1, span.lineEnd).join("\n");
    if (span.spanSha256 && sha256(excerpt) !== span.spanSha256) return "";
    return excerpt;
  } catch {
    return "";
  }
}

function sanitizeQuotedEvidence(excerpt, classified) {
  if (!excerpt) return "";
  const blocked = classified.filter((item) =>
    ["deferred", "conflicted", "cannot-proceed"].includes(item.proposedDeliverable),
  );
  const drop = [];
  if (blocked.some((item) => obligationSlot(item) === "macos")) {
    drop.push(/\b(?:brew|macos|mac os)\b/iu);
  }
  if (blocked.some((item) => obligationSlot(item) === "linux")) {
    drop.push(/\b(?:apt-get|apt install)\b/iu);
  }
  if (blocked.some((item) => obligationSlot(item) === "install-command")) {
    drop.push(/\b(?:apt-get|apt install|brew install|pip install|npm i |curl |wget )\b/iu);
  }
  if (drop.length === 0) return excerpt;
  return excerpt
    .split("\n")
    .filter((line) => !drop.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();
}

/**
 * Bind a later answer to current source/plan/result identity and refresh the
 * draft. A stale identity invalidates only the named obligations.
 */
export function applyDocumentationPartialAnswer(input) {
  const classified = classifyDocumentationPartialFallback({
    support: input.support,
    instruction: input.instruction,
    repositoryPath: input.repositoryPath,
    authorizedWriteRoots: input.authorizedWriteRoots,
    planBindingSha256: input.currentIdentity?.planBindingSha256,
  });
  const current = requirePartialIdentity(input.currentIdentity, "currentIdentity");
  const bound = requirePartialIdentity(input.answerBoundIdentity, "answerBoundIdentity");
  const stale = !samePartialIdentity(current, bound);
  const answeredIds = new Set(input.answeredObligationIds ?? []);
  const obligations = classified.envelope.obligations.map((item) => {
    if (!answeredIds.has(item.id)) return item;
    if (stale) {
      return Object.freeze({
        ...item,
        status: item.status === "supported" ? item.status : "missing",
        proposedDeliverable:
          item.proposedDeliverable === "included-supported" ? item.proposedDeliverable : "deferred",
        detail: stale
          ? "Stale answer identity; affected evidence is invalid until revalidated."
          : item.detail,
      });
    }
    return Object.freeze({
      ...item,
      detail:
        "Current attributed answer recorded. Original CREATE stays incomplete until first-pass reassessment cites support.",
    });
  });
  const originalUnmet = [
    ...new Set(obligations.filter((item) => item.status !== "supported").map((item) => item.id)),
  ];
  const included = obligations.filter((item) => item.proposedDeliverable === "included-supported");
  let applicability = classified.envelope.applicability;
  if (originalUnmet.length === 0) {
    applicability = classified.envelope.applicability;
  } else if (included.some((item) => item.requiredSourceSupport !== false && item.id !== "workflow-target-set")) {
    applicability = "useful-partial";
  }
  const envelope = Object.freeze({
    ...classified.envelope,
    applicability,
    obligations,
    originalUnmetRequirementIds: originalUnmet,
    unresolvedQuestions: classified.envelope.unresolvedQuestions.filter((question) =>
      originalUnmet.includes(question.obligationId),
    ),
  });
  return Object.freeze({
    envelope,
    markdown: classified.markdown,
    originalRequestCompletion: "incomplete",
    stale,
  });
}

function requirePartialIdentity(value, label) {
  if (!value || typeof value !== "object") {
    throw new FirstPassSupportError("assessment-invalid", `${label} is required.`);
  }
  if (
    typeof value.assessmentIdentitySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.assessmentIdentitySha256) ||
    typeof value.repositoryRevision !== "string"
  ) {
    throw new FirstPassSupportError("assessment-invalid", `${label} is not a bound identity.`);
  }
  return value;
}

function samePartialIdentity(left, right) {
  return (
    left.assessmentIdentitySha256 === right.assessmentIdentitySha256 &&
    left.repositoryRevision === right.repositoryRevision &&
    (left.snapshotSha256 ?? null) === (right.snapshotSha256 ?? null) &&
    (left.planBindingSha256 ?? null) === (right.planBindingSha256 ?? null)
  );
}
