// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INFERENCE_REJECTION_LOCATION_GRAMMAR } from "../src/config/inference-rejection-limits.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { isDeclaredResponseContractKey } from "../src/execution/response-contract-vocabulary.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import {
  RESPONSE_REJECTION_RULE_HINTS,
  responseCorrectionInstruction,
} from "../src/harness/response-correction.js";
import { bindQualityArtifactResponseContract } from "../src/harness/editorial-response-contract.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { documentationPlanModeForWorkflow } from "../src/workflow-execution/plan-binding.js";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  CONTRACT_PLACEHOLDER_NOTATION,
  CONTRACT_PLACEHOLDER_REJECTION_CODE,
  CONTRACT_PLACEHOLDER_ROLES,
  CONTRACT_PLACEHOLDERS,
  contractPlaceholderScope,
  EMPTY_CONTRACT_PLACEHOLDER_SCOPE,
  findContractPlaceholder,
  findContractPlaceholderInReply,
  hostOwnedContractSections,
  isContractPlaceholder,
  RETIRED_CONTRACT_EXAMPLE_VALUES,
  type ContractPlaceholderRoleName,
  type ContractPlaceholderScope,
} from "../src/workflow-execution/contract-placeholders.js";
import { CONTRACT_PLACEHOLDER_RULE } from "../src/workflow-execution/contract-placeholder-rule-hints.js";
import {
  EDITORIAL_RESPONSE_CONTRACT,
  NESTED_EDITORIAL_REVIEW_RESULT_CONTRACT,
  NESTED_EDITORIAL_VERIFICATION_RESULT_CONTRACT,
  NESTED_VERIFICATION_RESULT_CONTRACT,
  OBLIGATION_REJECTION_CODES,
  REVIEW_VERDICTS,
  TECHNICAL_FACT_DIMENSIONS,
  TECHNICAL_SYNTHESIS_CONTRACT,
  VERIFICATION_RESPONSE_CONTRACT,
} from "../src/workflow-execution/review-response.js";
import {
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
  SOURCE_OBLIGATION_RESPONSE_CONTRACT,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT,
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
} from "../src/workflow-execution/source-obligation.js";
import { authoringManifestV3 } from "./helpers/authoring-manifest.js";
import {
  createRealAuthoringEvidenceFixture,
  type RealAuthoringEvidenceFixture,
} from "./helpers/authoring-evidence.js";
import { configureCredential } from "./helpers/configured-credential.js";

/**
 * A recorded review-documentation assessment whose `bounded-code` limitation
 * the model copied from the contract example; the authoring projector carried
 * it into the outcome as `finding:authoring-quality:bounded-code`. The evidence
 * reference is a fixture; the limitation list is the recorded one.
 */
const RECORDED_BOUNDED_CODE_PROPOSAL = {
  schemaVersion: 1,
  kind: "docsfab-editorial-assessment-proposal",
  assessment: "accepted",
  rationale: "The bounded technical evidence supports the admitted no-change candidate.",
  evidenceRefs: [
    {
      kind: "context-packet",
      schemaVersion: 1,
      digest: "c".repeat(64),
      repositoryRevision: "d".repeat(40),
      repositoryContentDigest: "e".repeat(64),
    },
  ],
  limitations: ["bounded-code"],
  recommendation: null,
} as const;

/** The two other recorded `bounded-code` limitation lists. */
const RECORDED_LIMITATION_LISTS = [
  ["bounded-code"],
  ["bounded-code", "no-runtime-observation"],
  ["bounded-code", "no-runtime-execution"],
] as const;

const EDITORIAL_SKILLS = new Set([
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
]);

function editorialFixture(): Omit<HarnessStepInput, "workflow" | "step"> {
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
  const readerContext = {
    ...readerContextInput,
    impact_basis: {
      kind: "none" as const,
      rationale: "The admitted comparison preserves the documented public command.",
      evidence_refs: [{ uri: "repo://src/orbit.ts", sha256: "f".repeat(64) }],
    },
  };
  const policy = {
    id: "docsfab-documentation-quality",
    version: "v0.1",
    sha256: "b".repeat(64),
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
      {
        uri: "repo://src/orbit.ts",
        role: "public-contract" as const,
        sha256: "f".repeat(64),
      },
    ],
    observed_at: "2026-09-14T12:00:00.000Z",
    limitations: [],
  };
  const evidenceRefs = [RECORDED_BOUNDED_CODE_PROPOSAL.evidenceRefs[0]];
  const candidateReference = {
    kind: "editorial-decision" as const,
    schemaVersion: 3 as const,
    digest: "4".repeat(64),
    repositoryRevision: "d".repeat(40),
    repositoryContentDigest: "2".repeat(64),
  };
  return {
    repositoryPath: "/tmp/repository",
    readerContextInput,
    readerContext,
    readerContextProvenance,
    readerTaskContext: {
      schemaVersion: 1 as const,
      kind: "docsfab-reader-task-context-completed" as const,
      inputOrigin: "explicit" as const,
      noChangeAssessment: "requires-evidence" as const,
      readerContextInput,
      readerContext,
      provenance: readerContextProvenance,
      baseline: {
        path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md" as const,
        sha256: "a".repeat(64),
        content: "Use actual reader and source evidence.",
      },
      policy,
      prompt: "Completed host-validated reader task context.",
    },
    editorialEvidenceRefs: [...evidenceRefs, candidateReference],
    editorialCandidate: {
      reference: candidateReference,
      proposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-proposal",
        candidate: "no-change",
        rationale: "The admitted comparison preserves the public option behavior.",
        evidenceRefs,
        limitations: [],
        impactBasis: readerContext.impact_basis,
      },
    },
  } as unknown as Omit<HarnessStepInput, "workflow" | "step">;
}

const authoringWorkflow = parseWorkflowManifestSnapshot(
  authoringManifestV3(),
  "create-documentation",
  {
    "documentation-audit": documentationAuditSearch,
    "documentation-observation": documentationObservationSearch,
  },
);
let authoring: RealAuthoringEvidenceFixture;

beforeAll(async () => {
  authoring = await createRealAuthoringEvidenceFixture(authoringWorkflow, { actionable: true });
});
afterAll(async () => authoring?.dispose());

interface RenderedPrompt {
  readonly name: string;
  readonly prompt: string;
  /** Values the host copied from the step input: bound data, not examples. */
  readonly data: ReadonlySet<string>;
}

function inputStrings(input: Partial<HarnessStepInput>): ReadonlySet<string> {
  const strings = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  const { workflow: _workflow, step: _step, ...rest } = input;
  walk(rest);
  return strings;
}

function rendered(name: string, input: HarnessStepInput): RenderedPrompt {
  return { name, prompt: buildHostStepPrompt(input), data: inputStrings(input) };
}

/** Every rendered host prompt whose contracts this file audits. */
function renderedHostPrompts(): RenderedPrompt[] {
  const prompts: RenderedPrompt[] = [];
  const update = getWorkflow("update-documentation");
  if (update.schemaVersion !== 2) throw new Error("update-documentation must be schema V2.");
  const planner = update.steps.find((step) => step.skill === "plan-documentation")!;
  prompts.push(
    rendered("update editorial planner", {
      ...editorialFixture(),
      workflow: update,
      step: planner,
    }),
  );
  const branches = update.branching?.branches ?? [];
  expect(branches.length).toBeGreaterThan(0);
  for (const branch of branches) {
    for (const step of branch.steps) {
      if (!EDITORIAL_SKILLS.has(step.skill) || step.id === "derive-source-obligations") continue;
      prompts.push(
        rendered(`update ${branch.id} ${step.id}`, {
          ...editorialFixture(),
          workflow: update,
          step,
        }),
      );
    }
  }
  for (const name of ["create-documentation", "restructure-documentation"] as const) {
    const workflow = getWorkflow(name);
    const step = workflow.steps.find((candidate) => candidate.skill === "plan-documentation")!;
    expect(documentationPlanModeForWorkflow(name), name).toBeDefined();
    prompts.push(
      rendered(`${name} planner`, { repositoryPath: "/tmp/repository", workflow, step }),
    );
  }
  const review = getWorkflow("review-documentation");
  for (const step of review.steps) {
    if (step.skill === "evaluate-document-quality") {
      const input = bindQualityArtifactResponseContract({
        repositoryPath: "/tmp/repository",
        workflow: review,
        step,
        qualityProfileSelection: {
          selectionSha256: "a".repeat(64),
          profileAssetPath: "profiles/docsfab-documentation-quality/profile.json",
          profileId: "docsfab-documentation-quality",
          profileVersion: "v0.1",
          profileModel: "documentation-quality-model-v0.2",
          repositoryRevision: "c".repeat(40),
        } as NonNullable<HarnessStepInput["qualityProfileSelection"]>,
      });
      prompts.push(rendered(`review ${step.id} quality`, input));
    }
    const entry = rendered(`review ${step.id}`, {
      repositoryPath: "/tmp/repository",
      workflow: review,
      step,
    });
    if (hostOwnedContractSections(entry.prompt).length > 0) prompts.push(entry);
  }
  // The CREATE revision writer also has a structured contract.
  if (authoring.selection.kind !== "revise") throw new Error("fixture must select revision");
  const reviseStep = authoringWorkflow
    .authoringSchedule!.branches.find((branch) => branch.id === "revise")!
    .steps.find((candidate) => candidate.id === "revise-documentation")!;
  prompts.push(
    rendered("create revision writer", {
      runId: authoring.runId,
      repositoryPath: authoring.root,
      workflow: authoringWorkflow,
      step: reviseStep,
      evidenceIdentity: { repositoryRevision: authoring.revision },
      authoringRevisionInput: authoring.selection.input,
    }),
  );
  for (const [name, contract] of Object.entries({
    SOURCE_OBLIGATION_RESPONSE_CONTRACT,
    TECHNICAL_CORRECTION_RESPONSE_CONTRACT,
    PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
    TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
    VERIFICATION_RESPONSE_CONTRACT,
    NESTED_VERIFICATION_RESULT_CONTRACT,
    NESTED_EDITORIAL_VERIFICATION_RESULT_CONTRACT,
    TECHNICAL_SYNTHESIS_CONTRACT,
    EDITORIAL_RESPONSE_CONTRACT,
    NESTED_EDITORIAL_REVIEW_RESULT_CONTRACT,
  })) {
    prompts.push({ name, prompt: contract, data: new Set() });
  }
  return prompts;
}

/** Every rule hint a bounded retry can quote, including location-specific ones. */
function retryHintTexts(): string[] {
  return Object.values(RESPONSE_REJECTION_RULE_HINTS).flatMap((hint) => [
    hint.rule,
    ...Object.values(hint.atLocation ?? {}),
  ]);
}

/**
 * Every double-quoted string on a line, in order, so quotes pair up the way
 * JSON and prose both write them. A string followed by `:` is a JSON key.
 */
const QUOTED = /"((?:[^"\\]|\\.)*)"(:?)/gu;
/** The key an example value sits under, through any earlier array members. */
const EXAMPLE_KEY = /"([A-Za-z_]+)":\[?(?:"(?:[^"\\]|\\.)*",)*$/u;

interface ExampleValue {
  readonly value: string;
  /** The JSON key it sits under, or `undefined` for a value quoted in prose. */
  readonly key: string | undefined;
}

/**
 * Every quoted value on every line of a host-owned section: JSON-shaped
 * values in a shape, and values quoted in prose, such as `such as "x"`.
 */
function exampleValues(section: string): ExampleValue[] {
  return section.split("\n").flatMap((line) =>
    [...line.matchAll(QUOTED)]
      .filter((match) => match[2] !== ":")
      .map((match) => ({
        value: JSON.parse(`"${match[1]}"`) as string,
        key: EXAMPLE_KEY.exec(line.slice(0, match.index))?.[1],
      })),
  );
}

/**
 * Closed vocabulary a shape may show: required constants, or a `|` choice
 * whose every member is one. A closed-enum decoder decides each, so none is an
 * example value a model could copy into a real finding.
 */
const CLOSED_VOCABULARY = new Set<string>([
  ...REVIEW_VERDICTS,
  ...TECHNICAL_FACT_DIMENSIONS,
  // The closed rejection codes the applicable-dimension rule names.
  ...OBLIGATION_REJECTION_CODES,
  "verified",
  "unverified",
  "bounded-not-proven",
  "applicable",
  "not-applicable",
  "documented",
  // The remaining documentationDisposition values the verification contract lists.
  "omitted",
  "conflicting",
  "unverified-policy",
  "product-defect",
  // Quality profile scope and dimension assessment values the quality contract requires.
  "documentation-set",
  "fail",
  "required",
  "not-assessed",
  "none",
  // The revision writer's issue dispositions.
  "applied",
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  "docsfab-editorial-assessment-proposal",
  "accepted",
  "rejected",
  "update",
  "no-change",
  "insufficient-evidence",
  "product-gap",
  "evidence-limitation",
  "retain",
  "out-of-scope",
  "create",
  "restructure",
  "move",
  "needs-input",
  "missing-information",
  "ambiguous-scope",
  "missing-source",
  "unresolved-decision",
  "blocked-dependency",
]);

function isClosedVocabulary(value: string): boolean {
  return value.split("|").every((member) => CLOSED_VOCABULARY.has(member));
}

const ROLE_NAMES = Object.keys(CONTRACT_PLACEHOLDER_ROLES) as ContractPlaceholderRoleName[];
const FULL_SCOPE: ContractPlaceholderScope = new Set(ROLE_NAMES);

function roleOf(placeholder: string): ContractPlaceholderRoleName | undefined {
  return ROLE_NAMES.find((name) => CONTRACT_PLACEHOLDER_ROLES[name].placeholder === placeholder);
}

function editorialAssessmentInput(skill: string): HarnessStepInput {
  const update = getWorkflow("update-documentation");
  if (update.schemaVersion !== 2) throw new Error("update-documentation must be schema V2.");
  const step = update
    .branching!.branches.flatMap((branch) => branch.steps)
    .find((candidate) => candidate.skill === skill)!;
  return { ...editorialFixture(), workflow: update, step } as HarnessStepInput;
}

describe("host contract placeholders (#1282)", () => {
  let prompts: RenderedPrompt[];
  beforeAll(() => {
    prompts = renderedHostPrompts();
  });

  it("renders every audited contract", () => {
    for (const { name, prompt } of prompts) {
      expect(hostOwnedContractSections(prompt).length, name).toBeGreaterThan(0);
    }
    const sections = prompts.flatMap(({ prompt }) => hostOwnedContractSections(prompt)).join("\n");
    for (const header of [
      "Runtime planner response contract (host-owned):\nReturn exactly one of these JSON object shapes",
      "Runtime reader-impact planner response contract (host-owned):",
      "Runtime independent editorial assessment response contract (host-owned):",
      "Runtime quality artifact response contract (host-owned):",
      "Runtime technical verification response contract (host-owned):",
      "Nested technical verification result contract (host-owned):",
      "Runtime editorial review response contract (host-owned):",
      "Nested editorial review result contract (host-owned):",
      "Runtime source-obligation response contract (host-owned):",
      "Runtime provisional technical verification judgment contract (host-owned):",
      "Runtime authoring-revision response contract (host-owned):",
    ]) {
      expect(sections, header).toContain(header);
    }
    const values = prompts.flatMap(({ prompt }) =>
      hostOwnedContractSections(prompt).flatMap(exampleValues),
    );
    expect(values.length).toBeGreaterThan(40);
  });

  it("shows no contract example that could pass admission as a real value", () => {
    const copyable = new Set<string>();
    for (const { name, prompt, data } of prompts) {
      for (const section of hostOwnedContractSections(prompt)) {
        for (const { value } of exampleValues(section)) {
          if (data.has(value)) continue;
          if (!isContractPlaceholder(value) && !isClosedVocabulary(value)) {
            copyable.add(`${name}: ${JSON.stringify(value)}`);
          }
        }
      }
    }
    expect([...copyable]).toEqual([]);
  });

  it("places each placeholder only under a key its role refuses it at", () => {
    const placed = new Set<ContractPlaceholderRoleName>();
    for (const { name, prompt } of prompts) {
      for (const section of hostOwnedContractSections(prompt)) {
        for (const { value, key } of exampleValues(section)) {
          const owner = roleOf(value);
          if (!owner) continue;
          expect(CONTRACT_PLACEHOLDER_ROLES[owner].keys, `${name}: ${value}`).toContain(key);
          placed.add(owner);
        }
      }
    }
    expect(placed.has("limitationCode")).toBe(true);
    expect(new Set(Object.values(CONTRACT_PLACEHOLDERS)).size).toBe(ROLE_NAMES.length);
  });

  it("derives the placeholder set from the contracts: every notation is registered and used", () => {
    const registered = new Set<string>(Object.values(CONTRACT_PLACEHOLDERS));
    const used = new Set<string>();
    const texts = [
      ...prompts.flatMap(({ prompt }) => hostOwnedContractSections(prompt)),
      ...retryHintTexts(),
    ];
    for (const text of texts) {
      for (const [notation] of text.matchAll(CONTRACT_PLACEHOLDER_NOTATION)) {
        expect(registered.has(notation), notation).toBe(true);
        used.add(notation);
      }
    }
    expect([...registered].filter((placeholder) => !used.has(placeholder))).toEqual([]);
  });

  it("retires only literals that describe no run, and no contract or hint shows one", () => {
    const texts = [
      ...prompts.flatMap(({ prompt }) => hostOwnedContractSections(prompt)),
      ...retryHintTexts(),
    ];
    for (const value of RETIRED_CONTRACT_EXAMPLE_VALUES) {
      for (const text of texts) expect(text, value).not.toContain(JSON.stringify(value));
      // A sentence could be a true answer, so no retired literal is one.
      expect(value, value).not.toMatch(/[a-z]\.$/u);
    }
    expect(RETIRED_CONTRACT_EXAMPLE_VALUES).toContain("bounded-code");
    for (const text of retryHintTexts()) expect(text).not.toContain("no-runtime-observation");
  });

  it("scopes each step to the placeholders its own contract rendered", () => {
    const assessment = contractPlaceholderScope(
      buildHostStepPrompt(editorialAssessmentInput("review-documentation")),
    );
    expect(assessment.has("limitationCode")).toBe(true);
    const planner = prompts.find(({ name }) => name === "create-documentation planner")!;
    const plannerScope = contractPlaceholderScope(planner.prompt);
    expect(plannerScope.has("planSummary")).toBe(true);
    expect(plannerScope.has("limitationCode")).toBe(false);
    expect(
      contractPlaceholderScope(
        "Step prompt.\n\nEvidence: <limitation code the evidence establishes>",
      ),
    ).toBe(EMPTY_CONTRACT_PLACEHOLDER_SCOPE);
    expect(
      contractPlaceholderScope(
        "Source-readiness response contract (host-owned):\nReturn one JSON object with no Markdown fences.",
      ),
    ).toBe(EMPTY_CONTRACT_PLACEHOLDER_SCOPE);
  });
});

describe("contract placeholder admission (#1282)", () => {
  const assessmentScope = (): ContractPlaceholderScope =>
    contractPlaceholderScope(buildHostStepPrompt(editorialAssessmentInput("review-documentation")));

  it("refuses the recorded bounded-code assessment at its contract location", () => {
    const scope = assessmentScope();
    const reply = JSON.stringify({
      summary: { verdict: "pass", issues: [] },
      editorialAssessmentProposal: RECORDED_BOUNDED_CODE_PROPOSAL,
    });
    expect(findContractPlaceholderInReply(reply, scope, isDeclaredResponseContractKey)).toEqual({
      code: CONTRACT_PLACEHOLDER_REJECTION_CODE,
      location: "$.editorialAssessmentProposal.limitations[]",
    });
    for (const limitations of RECORDED_LIMITATION_LISTS) {
      const recorded = JSON.stringify({
        summary: { verdict: "pass", issues: [] },
        editorialAssessmentProposal: { ...RECORDED_BOUNDED_CODE_PROPOSAL, limitations },
      });
      expect(
        findContractPlaceholderInReply(recorded, scope, isDeclaredResponseContractKey)?.code,
        limitations.join(","),
      ).toBe(CONTRACT_PLACEHOLDER_REJECTION_CODE);
    }
  });

  it("admits the same assessment once the limitation states a real limit", () => {
    const reply = JSON.stringify({
      summary: { verdict: "pass", issues: [] },
      editorialAssessmentProposal: {
        ...RECORDED_BOUNDED_CODE_PROPOSAL,
        limitations: ["no-runtime-observation"],
      },
    });
    expect(
      findContractPlaceholderInReply(reply, assessmentScope(), isDeclaredResponseContractKey),
    ).toBeUndefined();
  });

  it.each(ROLE_NAMES)("refuses the placeholder of %s only at a key it occupies", (name) => {
    const entry = CONTRACT_PLACEHOLDER_ROLES[name];
    const scope = new Set([name]);
    for (const key of entry.keys) {
      for (const value of [entry.placeholder, ...entry.retired]) {
        expect(
          findContractPlaceholder({ [key]: value }, scope, () => false)?.code,
          `${key}: ${value}`,
        ).toBe(CONTRACT_PLACEHOLDER_REJECTION_CODE);
        // Surrounding whitespace is not a different value.
        expect(
          findContractPlaceholder({ [key]: [` ${value}\n`] }, scope, () => false),
        ).toBeDefined();
      }
    }
    // Outside its scope, or at a key it never occupies, the same value is admitted.
    expect(
      findContractPlaceholder(
        { [entry.keys[0]!]: entry.placeholder },
        EMPTY_CONTRACT_PLACEHOLDER_SCOPE,
        () => false,
      ),
    ).toBeUndefined();
    expect(
      findContractPlaceholder({ quote: entry.placeholder }, scope, () => false),
    ).toBeUndefined();
  });

  it("admits the critic's four true values, whatever the scope", () => {
    const probes: Array<readonly [string, unknown]> = [
      [
        "a true not-applicable reason",
        {
          factInventory: {
            dimensions: [
              {
                dimension: "mutable-state",
                status: "not-applicable",
                reason: "The cited source defines no mutable state in scope.",
                sourceLocators: ["src/cli.ts:4-9"],
                facts: [],
              },
            ],
          },
        },
      ],
      [
        "an ordinary review finding and change",
        {
          issues: [
            {
              id: "REV-001",
              finding: "The reader cannot find the required prerequisite.",
              required_change: "Document the source-supported prerequisite.",
            },
          ],
        },
      ],
      [
        "a readiness citation quoting an identifier",
        { criteria: [{ citations: [{ path: "docs/api.md", quote: "sourceLocator" }] }] },
      ],
      [
        "a bootstrap evidence quote",
        { evidence: [{ path: "docs/review.md", quote: "<severity>" }] },
      ],
    ];
    for (const [name, value] of probes) {
      expect(
        findContractPlaceholder(value, FULL_SCOPE, isDeclaredResponseContractKey),
        name,
      ).toBeUndefined();
    }
  });

  it("never pre-empts a disclosure refusal: any reply with a configured credential yields", () => {
    const credential = `api_key=${configureCredential("syntheticxxxxxxxxxxxxxxxxxxxxxxxx")}`;
    // One copied placeholder or retired literal per role, at its first key.
    for (const name of ROLE_NAMES) {
      const entry = CONTRACT_PLACEHOLDER_ROLES[name];
      for (const value of [entry.placeholder, ...entry.retired]) {
        const copied = { [entry.keys[0]!]: [value] };
        expect(
          findContractPlaceholderInReply(JSON.stringify(copied), FULL_SCOPE, () => false)?.code,
          `${name}: ${value}`,
        ).toBe(CONTRACT_PLACEHOLDER_REJECTION_CODE);
        // Credential material anywhere, in a value or a key, leaves the reply
        // to the step's own terminal refusal, wherever that runs.
        for (const withCredential of [
          { ...copied, note: credential },
          { ...copied, nested: [{ deep: `prefix ${credential}` }] },
        ]) {
          expect(
            findContractPlaceholderInReply(JSON.stringify(withCredential), FULL_SCOPE, () => false),
            `${name}: ${value}`,
          ).toBeUndefined();
        }
      }
    }
  });

  it("names contract positions only, never reply keys, indices, or values", () => {
    const scope = new Set<ContractPlaceholderRoleName>(["factStatement", "limitationCode"]);
    const rejection = findContractPlaceholder(
      {
        summary: {
          coverage: [{ path: "docs/cli.md", reason: "fine" }],
          factInventory: {
            dimensions: [{ facts: [{ statement: CONTRACT_PLACEHOLDERS.factStatement }] }],
          },
        },
      },
      scope,
      isDeclaredResponseContractKey,
    );
    expect(rejection?.location).toBe("$.summary.factInventory.dimensions[].facts[].statement");
    // An undeclared key is reply content: the location stops at its parent.
    const undeclared = findContractPlaceholder(
      { summary: { the_customer_password_is_x: { limitations: ["bounded-code"] } } },
      scope,
      isDeclaredResponseContractKey,
    );
    expect(undeclared?.location).toBe("$.summary");
    for (const found of [rejection, undeclared]) {
      expect(INFERENCE_REJECTION_LOCATION_GRAMMAR.test(found!.location)).toBe(true);
    }
  });

  it("matches values, not keys, and leaves non-JSON replies to their own decoder", () => {
    const scope = new Set<ContractPlaceholderRoleName>(["limitationCode"]);
    expect(findContractPlaceholder({ "bounded-code": "fine" }, scope, () => true)).toBeUndefined();
    expect(findContractPlaceholderInReply("bounded-code", scope, () => true)).toBeUndefined();
    expect(findContractPlaceholderInReply('{"a":', scope, () => true)).toBeUndefined();
    // A root value sits under no key, so under no contract position.
    expect(findContractPlaceholderInReply('["bounded-code"]', scope, () => true)).toBeUndefined();
    // Plausible real values an earlier example showed are never retired.
    for (const value of ["docs/page.md", "src/file.ts:42", "TECH-001", "missing-information"]) {
      expect(isContractPlaceholder(value), value).toBe(false);
    }
  });

  it("gives a retry the placeholder rule, never the rejected value", () => {
    const section = responseCorrectionInstruction({
      rejection: {
        code: CONTRACT_PLACEHOLDER_REJECTION_CODE,
        location: "$.editorialAssessmentProposal.limitations[]",
      },
    });
    expect(section).toContain(
      "failed host rule contract-placeholder-copied at $.editorialAssessmentProposal.limitations[]",
    );
    expect(section).toContain(CONTRACT_PLACEHOLDER_RULE);
    expect(section).not.toContain("bounded-code");
  });
});
