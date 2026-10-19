// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import {
  isEditorialAssessmentStep,
  isEditorialPlanner,
} from "../src/harness/editorial-response-contract.js";
import { governedSkillVirtualRoot } from "../src/harness/confined-tools.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { expandGovernedSkillCommand, governedSkillBlock } from "../src/harness/pi-session.js";
import { skillPolicyTools } from "../src/harness/pi-tool-confine.js";
import { readVerifiedCatalogFile, verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import {
  TECHNICAL_FACT_DIMENSIONS,
  VERIFICATION_RESPONSE_CONTRACT,
} from "../src/workflow-execution/review-response.js";
import {
  bindSourceObligationLedgerV2,
  isProvisionalTechnicalVerification,
  PROVISIONAL_TECHNICAL_STEP_ID,
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
  sourceObligationScopeSha256,
  usesProvisionalVerificationJudgment,
} from "../src/workflow-execution/source-obligation.js";
import { sealOriginalSourceAuthority } from "../src/workflow-execution/source-obligation-authority.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");

const baseWorkflow = getWorkflow("update-documentation");
const workflow = { ...baseWorkflow, schemaVersion: 2 as const };
const readerContextInput = {
  schema_version: 1 as const,
  target_audience: "Orbit users",
  reader_job: "run an inspection",
  change_scope: ["docs/cli.md"],
  source_priority: ["public contract"],
  required_content: ["current command"],
  excluded_content: [],
  unresolved_questions: [],
};
const policy = { id: "docsfab-documentation-quality", version: "v0.1", sha256: "b".repeat(64) };
const inputReaderTaskContext = {
  schemaVersion: 1 as const,
  kind: "docsfab-reader-task-context-input" as const,
  inputOrigin: "explicit" as const,
  noChangeAssessment: "requires-evidence" as const,
  readerContextInput,
  baseline: {
    path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md" as const,
    sha256: "a".repeat(64),
    content: "Use actual reader and source evidence.",
  },
  policy,
  prompt: "Verified reader task context.",
};
const contextPacketReference = {
  kind: "context-packet" as const,
  schemaVersion: 1 as const,
  digest: "c".repeat(64),
  repositoryRevision: "d".repeat(40),
  repositoryContentDigest: "e".repeat(64),
};
const readerContext = {
  ...readerContextInput,
  impact_basis: {
    kind: "none" as const,
    rationale: "The admitted comparison preserves the documented public command.",
    evidence_refs: [{ uri: "repo://src/orbit.ts", sha256: "f".repeat(64) }],
  },
};
const readerContextProvenance = {
  schema_version: 1 as const,
  reader_context_sha256: "1".repeat(64),
  baseline_sha256: "a".repeat(64),
  admitted_revision: "d".repeat(40),
  workspace_snapshot_sha256: "2".repeat(64),
  repository_identity_sha256: "3".repeat(64),
  policy,
  comparison: { kind: "unknown" as const },
  sources: [
    { uri: "repo://src/orbit.ts", role: "public-contract" as const, sha256: "f".repeat(64) },
  ],
  observed_at: "2026-09-14T12:00:00.000Z",
  limitations: [],
};
const candidateReference = {
  kind: "editorial-decision" as const,
  schemaVersion: 3 as const,
  digest: "4".repeat(64),
  repositoryRevision: "d".repeat(40),
  repositoryContentDigest: "2".repeat(64),
};
const completedReaderTaskContext = {
  ...inputReaderTaskContext,
  kind: "docsfab-reader-task-context-completed" as const,
  readerContext,
  provenance: readerContextProvenance,
  prompt: "Completed host-validated reader task context.",
};

function editorialStepInput(step: HarnessStepInput["step"]): HarnessStepInput {
  if (step.skill === "plan-documentation") {
    return {
      repositoryPath: "/tmp/repository",
      workflow,
      step,
      readerContextInput,
      readerTaskContext: inputReaderTaskContext,
      editorialEvidenceRefs: [contextPacketReference],
    };
  }
  return {
    repositoryPath: "/tmp/repository",
    workflow,
    step,
    readerContextInput,
    readerTaskContext: completedReaderTaskContext,
    readerContext,
    readerContextProvenance,
    editorialEvidenceRefs: [contextPacketReference, candidateReference],
    editorialCandidate: {
      reference: candidateReference,
      proposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-proposal",
        candidate: "no-change",
        rationale: "The admitted comparison preserves the public option behavior.",
        evidenceRefs: [contextPacketReference],
        limitations: [],
        impactBasis: readerContext.impact_basis,
      },
    },
  };
}

/**
 * A host-bound V2 source-obligation ledger for `ledgerWorkflow`. Only a V2
 * ledger selects the provisional judgment-only contract.
 */
function sourceObligationLedgerV2(
  ledgerWorkflow: HarnessStepInput["workflow"],
): NonNullable<HarnessStepInput["sourceObligationLedger"]> {
  const sourceSha256 = "f".repeat(64);
  const deriveInput = {
    runId: "envelope-deference-run",
    repositoryPath: "/tmp/repository",
    workflow: ledgerWorkflow,
    step: ledgerWorkflow.steps.find((candidate) => candidate.id === "derive-source-obligations")!,
    planBinding: createDocumentationPlanBinding({
      mode: "create",
      pages: [{ path: "docs/guide.md", disposition: "create" as const }],
      sourceBindings: [{ pagePath: "docs/guide.md", sources: ["src/api.ts"] }],
    }),
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    searchEvidence: searchStepEvidence({
      evidenceSha256: "b".repeat(64),
      workspaceSnapshotSha256: "c".repeat(64),
    }),
  } satisfies HarnessStepInput;
  return bindSourceObligationLedgerV2(
    {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
        dimension === "input-representations"
          ? {
              dimension,
              status: "applicable" as const,
              reason: "The fixture source establishes structured input behavior.",
              sourceLocators: [],
              obligations: [
                {
                  id: "OBL-INPUT-1",
                  dimension,
                  sourceLocators: ["src/api.ts:10"],
                  statement: "The fixture source accepts a structured input representation.",
                  evidenceClass: "source-observation" as const,
                  uncertainty: "The source was inspected but the operation was not executed.",
                },
              ],
            }
          : {
              dimension,
              status: "not-applicable" as const,
              reason: `The bounded fixture establishes no ${dimension} source obligation.`,
              sourceLocators: ["src/api.ts:1"],
              obligations: [],
            },
      ),
      limitations: [],
    },
    deriveInput,
    [{ path: "src/api.ts", sha256: sourceSha256 }],
    sealOriginalSourceAuthority({
      runId: deriveInput.runId,
      scope: "create-plan-sources",
      repositoryRevision: deriveInput.evidenceIdentity.repositoryRevision,
      scopeSha256: sourceObligationScopeSha256(deriveInput),
      workspaceSnapshotSha256: "c".repeat(64),
      members: [{ path: "src/api.ts", mode: 0o644, byteLength: 1, sourceSha256 }],
    }).evidence,
  );
}

/**
 * Build the step's first user message the way `PiHarness` does: the verified
 * catalog skill block, named by its virtual root, replaces the host prompt's
 * `/skill:<id> ` prefix. Split the skill body from the host step text.
 */
async function expandHostStep(
  input: HarnessStepInput,
): Promise<{ skillBlock: string; stepText: string }> {
  const { id, skill } = input.step;
  const verified = await verifyCatalogSkill({
    skillCrateDirectory,
    skillId: skill,
    grantedTools: skillPolicyTools(input.step.mode, input.step.kind),
  });
  const block = governedSkillBlock(
    { id: verified.skill.id, virtualRoot: governedSkillVirtualRoot(verified.skill.id) },
    (await readVerifiedCatalogFile(verified, "SKILL.md")).toString("utf8"),
  );
  const expanded = expandGovernedSkillCommand(buildHostStepPrompt(input), skill, block);
  expect(expanded.startsWith(block), id).toBe(true);
  expect(expanded, id).not.toContain(skillCrateDirectory);
  expect(
    expanded.startsWith(
      `<skill name="${skill}" location="${governedSkillVirtualRoot(skill)}/SKILL.md">`,
    ),
    id,
  ).toBe(true);
  const blockEnd = expanded.indexOf("\n</skill>\n\n");
  expect(blockEnd, id).toBeGreaterThan(0);
  return { skillBlock: expanded.slice(0, blockEnd), stepText: expanded.slice(blockEnd) };
}

/** A skill sentence that names an outer or top-level shape. */
const OUTER_SHAPE = /\b(top-level|top level|outer)\b/i;
/** Wording that yields that shape to the host contract or makes it conditional. */
const DEFERS_OR_CONDITIONAL = /\b(host|contract|unless|otherwise)\b/i;
const DEFERENCE_RULE =
  /(host-supplied response contract in the step prompt|host supplies a response contract in the step prompt|follow the host.s response contract)/;
const EDITORIAL_ENVELOPE = "`{summary, editorialAssessmentProposal}`";
const PLANNER_CONTRACT = "Runtime reader-impact planner response contract (host-owned):";
const ASSESSMENT_CONTRACT =
  "Runtime independent editorial assessment response contract (host-owned):";

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 0);
}

describe("editorial skill envelope deference (#1125)", () => {
  it("gives every update-documentation editorial step one outer response contract", async () => {
    const editorialSteps = workflow.steps.filter((step) => {
      const input = editorialStepInput(step);
      return isEditorialAssessmentStep(input) || isEditorialPlanner(input);
    });
    expect([...new Set(editorialSteps.map((step) => step.skill))].sort()).toEqual([
      "evaluate-document-quality",
      "plan-documentation",
      "review-documentation",
      "test-audience-understanding",
      "verify-technical-accuracy",
    ]);

    for (const step of editorialSteps) {
      const input = editorialStepInput(step);
      const { skillBlock, stepText } = await expandHostStep(input);
      const normalizedSkill = skillBlock.replace(/\s+/g, " ");

      const hostContract = isEditorialPlanner(input) ? PLANNER_CONTRACT : ASSESSMENT_CONTRACT;
      expect(stepText, step.id).toContain(hostContract);
      expect(skillBlock, step.id).not.toContain(hostContract);

      // The skill yields the outer shape to the host contract in the same message.
      expect(DEFERENCE_RULE.test(normalizedSkill), `${step.id} defers to the host contract`).toBe(
        true,
      );
      if (isEditorialAssessmentStep(input)) {
        expect(stepText, step.id).toContain(`{"summary":`);
        expect(stepText, step.id).toContain(`"editorialAssessmentProposal":`);
        expect(normalizedSkill.includes(EDITORIAL_ENVELOPE), `${step.id} names the envelope`).toBe(
          true,
        );
      }

      // No skill sentence may prescribe an outer shape unconditionally.
      const unconditional = sentences(skillBlock).filter(
        (sentence) => OUTER_SHAPE.test(sentence) && !DEFERS_OR_CONDITIONAL.test(sentence),
      );
      expect(unconditional, step.id).toEqual([]);
    }
  });
});

/** Parse `A, B, or C` / `A, B, and C` field lists from one host contract sentence. */
function contractFieldList(contract: string, pattern: RegExp): string[] {
  const match = pattern.exec(contract);
  expect(match, `host contract matches ${pattern}`).not.toBeNull();
  return match![1]!
    .split(/,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+/u)
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

const PROVISIONAL_REQUIRED_FIELDS = contractFieldList(
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
  /one JSON object with exactly ([^.]+?), without/u,
);
const PROVISIONAL_FORBIDDEN_FIELDS = contractFieldList(
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
  /Do not return ([^.]+)\./u,
);
/** The skill's name for the ordinary `{review, coverage, factInventory}` set. */
const ORDINARY_WRAPPER = /\b(three-field|wrapper)\b/iu;
const PROVISIONAL_DEFERENCE =
  /return exactly what the host provisional contract in the step prompt specifies/u;

/** Skill sentences that address the provisional mode and prescribe a host-forbidden shape. */
function provisionalShapeConflicts(text: string): string[] {
  return sentences(text).filter((sentence) => {
    if (!/provisional/iu.test(sentence)) return false;
    if (ORDINARY_WRAPPER.test(sentence)) return true;
    return PROVISIONAL_FORBIDDEN_FIELDS.some((field) =>
      new RegExp(`[\`{"\\s,]${field}[\`}",]`, "u").test(sentence),
    );
  });
}

describe("verify-technical-accuracy provisional deference (#1157)", () => {
  it("derives the host-forbidden field set from the provisional contract", () => {
    expect(PROVISIONAL_REQUIRED_FIELDS).toEqual([
      "verdict",
      "coverage",
      "issueJudgments",
      "obligationJudgments",
    ]);
    expect(PROVISIONAL_FORBIDDEN_FIELDS).toEqual([
      "review",
      "factInventory",
      "obligationAccounting",
    ]);
    // The detector must catch both retired prescriptions.
    expect(
      provisionalShapeConflicts(
        "Otherwise, ordinary and provisional verification return exactly the top-level `review`, `coverage`, and `factInventory` fields.",
      ),
    ).toHaveLength(1);
    expect(
      provisionalShapeConflicts(
        "For `provisional-technical-verification`, independently compare the candidate with the frozen source and obligation proposals, then return the existing three-field verification wrapper as the top-level object unless the host contract nests it.",
      ),
    ).toHaveLength(1);
  });

  it("names no host-forbidden field in any provisional-mode skill text", async () => {
    const provisionalWorkflow = getWorkflow("create-documentation");
    const step = provisionalWorkflow.steps.find(
      (candidate) => candidate.id === PROVISIONAL_TECHNICAL_STEP_ID,
    );
    expect(step).toBeDefined();
    const unbound: HarnessStepInput = {
      repositoryPath: "/tmp/repository",
      workflow: provisionalWorkflow,
      step: step!,
    };
    const input: HarnessStepInput = {
      ...unbound,
      sourceObligationLedger: sourceObligationLedgerV2(provisionalWorkflow),
    };
    expect(isProvisionalTechnicalVerification(input)).toBe(true);
    expect(usesProvisionalVerificationJudgment(input)).toBe(true);
    expect(usesProvisionalVerificationJudgment(unbound)).toBe(false);

    // Without a V2 ledger the step keeps the full contract its decoder admits.
    const unboundStep = await expandHostStep(unbound);
    expect(unboundStep.stepText).toContain(VERIFICATION_RESPONSE_CONTRACT);
    expect(unboundStep.stepText).not.toContain(PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT);

    const { skillBlock, stepText } = await expandHostStep(input);
    // The host provisional contract reaches the same prompt, outside the skill body.
    expect(stepText).toContain(PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT);
    expect(stepText).not.toContain(VERIFICATION_RESPONSE_CONTRACT);
    expect(skillBlock).not.toContain(PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT);

    // The provisional mode names no host-forbidden field and defers its
    // whole shape to that host contract.
    expect(provisionalShapeConflicts(skillBlock)).toEqual([]);
    expect(
      PROVISIONAL_DEFERENCE.test(skillBlock.replace(/\s+/g, " ")),
      "provisional mode defers to the host provisional contract",
    ).toBe(true);

    // The references the skill tells the model to read ship in the same crate.
    const referenceDirectory = resolve(skillCrateDirectory, "verify-technical-accuracy/references");
    for (const name of (await readdir(referenceDirectory)).sort()) {
      const reference = await readFile(resolve(referenceDirectory, name), "utf8");
      expect(provisionalShapeConflicts(reference), name).toEqual([]);
    }
  });
});
