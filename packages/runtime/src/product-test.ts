// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "./json-evidence.js";
import type { CliFormatOptions } from "./operator/cli-format.js";
import {
  offlineProductTestPresentation,
  renderCliPresentation,
  resolveCliPresentationCapabilities,
} from "./cli/discovery-presentation.js";
import { sha256 } from "./content-ir/canonical.js";

const MAX_SYNTHETIC_PATCH_BYTES = 4 * 1024;
const SYNTHETIC_SOURCE = "# Example project\n\nA small documentation fixture.\n";
const SYNTHETIC_POSTIMAGE = `${SYNTHETIC_SOURCE}\n## Verify locally\n\nRun the documented validation command before review.\n`;

export const OFFLINE_PRODUCT_TEST_STEPS = [
  "assessment",
  "workflow-selection",
  "synthetic-patch",
  "validation",
  "tracker-reconciliation",
  "branch-publication",
  "merge-request-publication",
  "idempotent-retry",
] as const;

export type OfflineProductTestStep = (typeof OFFLINE_PRODUCT_TEST_STEPS)[number];

export interface OfflineProductTestResult {
  schemaVersion: 1;
  kind: "docsfab-offline-product-test";
  status: "passed";
  isolation: { credentials: "not-used"; network: "not-used"; sourceCheckout: "unchanged" };
  assessment: { gapId: string; evidenceSha256: string };
  decision: { workflow: "update-documentation"; disposition: "execute" };
  patch: { sha256: string; byteLength: number; changedPaths: readonly ["README.md"] };
  validation: { status: "passed"; checkCount: 3; stateSha256: string };
  tracker: { status: "reconciled"; gapId: string };
  publication: {
    branch: string;
    mergeRequest: "draft";
    publicationSha256: string;
    externalMutationCount: 1;
  };
  retry: { status: "idempotent"; sameReceipt: true; externalMutationCount: 1 };
  steps: ReadonlyArray<{ id: OfflineProductTestStep; status: "passed" }>;
  sha256: string;
}

interface FakePublicationReceipt {
  branch: string;
  mergeRequest: "draft";
  publicationSha256: string;
}

class OfflineFakeProvider {
  assess(source: string): OfflineProductTestResult["assessment"] {
    const evidenceSha256 = sha256(source);
    return Object.freeze({
      gapId: `documentation-gap-${evidenceSha256.slice(0, 16)}`,
      evidenceSha256,
    });
  }

  select(assessment: OfflineProductTestResult["assessment"]): OfflineProductTestResult["decision"] {
    if (!assessment.gapId.startsWith("documentation-gap-")) {
      throw new Error("Offline fake provider received an invalid assessment.");
    }
    return Object.freeze({ workflow: "update-documentation", disposition: "execute" });
  }
}

class OfflineFakeGitLab {
  readonly #receipts = new Map<string, FakePublicationReceipt>();
  #mutationCount = 0;

  publish(idempotencyKey: string, patchSha256: string): FakePublicationReceipt {
    const existing = this.#receipts.get(idempotencyKey);
    if (existing) return existing;
    const branch = `docsfab-run/offline-test-${patchSha256.slice(0, 12)}`;
    const receipt = Object.freeze({
      branch,
      mergeRequest: "draft" as const,
      publicationSha256: sha256(`${idempotencyKey}\n${branch}\ndraft\n${patchSha256}`),
    });
    this.#receipts.set(idempotencyKey, receipt);
    this.#mutationCount += 1;
    return receipt;
  }

  get mutationCount(): number {
    return this.#mutationCount;
  }
}

/**
 * A bounded product-level proof with deterministic fake provider and GitLab
 * boundaries. It performs no filesystem, credential, subprocess, or network I/O.
 */
export function runOfflineProductTest(): OfflineProductTestResult {
  const provider = new OfflineFakeProvider();
  const assessment = provider.assess(SYNTHETIC_SOURCE);
  const decision = provider.select(assessment);
  const patchBytes = Buffer.from(
    [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -3,1 +3,5 @@",
      " A small documentation fixture.",
      "+",
      "+## Verify locally",
      "+",
      "+Run the documented validation command before review.",
      "",
    ].join("\n"),
  );
  if (patchBytes.byteLength <= 0 || patchBytes.byteLength > MAX_SYNTHETIC_PATCH_BYTES) {
    throw new Error("Offline product test produced an unbounded synthetic patch.");
  }
  const patchSha256 = sha256(patchBytes);
  const appliedPostimage = `${SYNTHETIC_SOURCE}${patchBytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n")}\n`;

  const validationChecks = [
    appliedPostimage === SYNTHETIC_POSTIMAGE,
    SYNTHETIC_POSTIMAGE.includes("## Verify locally"),
    !SYNTHETIC_POSTIMAGE.includes("credential"),
  ];
  if (validationChecks.some((check) => !check)) {
    throw new Error("Offline product test synthetic validation failed.");
  }
  const stateSha256 = sha256(SYNTHETIC_POSTIMAGE);

  const idempotencyKey = sha256(`${assessment.gapId}\n${decision.workflow}\n${patchSha256}`);
  const gitlab = new OfflineFakeGitLab();
  const first = gitlab.publish(idempotencyKey, patchSha256);
  const retry = gitlab.publish(idempotencyKey, patchSha256);
  if (first !== retry || gitlab.mutationCount !== 1) {
    throw new Error("Offline product test publication retry was not idempotent.");
  }

  const resultWithoutDigest = {
    schemaVersion: 1,
    kind: "docsfab-offline-product-test",
    status: "passed",
    isolation: { credentials: "not-used", network: "not-used", sourceCheckout: "unchanged" },
    assessment,
    decision,
    patch: { sha256: patchSha256, byteLength: patchBytes.byteLength, changedPaths: ["README.md"] },
    validation: { status: "passed", checkCount: 3, stateSha256 },
    tracker: { status: "reconciled", gapId: assessment.gapId },
    publication: {
      branch: first.branch,
      mergeRequest: first.mergeRequest,
      publicationSha256: first.publicationSha256,
      externalMutationCount: gitlab.mutationCount,
    },
    retry: { status: "idempotent", sameReceipt: true, externalMutationCount: gitlab.mutationCount },
    steps: OFFLINE_PRODUCT_TEST_STEPS.map((id) => ({ id, status: "passed" as const })),
  } as const;
  const sha256Digest = sha256(
    canonicalizeJsonEvidence(resultWithoutDigest as unknown as JsonEvidenceValue),
  );
  return Object.freeze({ ...resultWithoutDigest, sha256: sha256Digest });
}

export function serializeOfflineProductTest(result: OfflineProductTestResult): string {
  return canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue);
}

export interface FormatOfflineProductTestOptions extends CliFormatOptions {
  /** Stamped-dialect short shape: verdict plus the result record digest only. */
  quiet?: boolean;
}

/**
 * Stamped-dialect human projection: a weighted verdict line, followed on the
 * default shape by grouped STEPS / SIMULATION / PUBLICATION / RESULT sections.
 * There is no NEXT line: `docsfab test` never returns a failed result (a
 * divergence throws instead).
 */
export function formatOfflineProductTest(
  result: OfflineProductTestResult,
  options: FormatOfflineProductTestOptions = {},
): string {
  const { quiet, ...formatOptions } = options;
  const document = offlineProductTestPresentation(result, quiet ? "quiet" : "normal");
  return renderCliPresentation(document, resolveCliPresentationCapabilities(formatOptions));
}
