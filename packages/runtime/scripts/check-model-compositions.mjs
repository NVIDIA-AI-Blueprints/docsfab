#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { iaDiscoverySearch } from "../src/ia/discovery-search-plan.ts";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.ts";
import { documentationObservationSearch } from "../src/search/observation-search-plan.ts";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.ts";
import {
  listInstalledModelCompositions,
  loadInstalledModelCompositionAuthority,
  resolveInstalledComposition,
  resolveInstalledExecutableComposition,
} from "../src/model-composition/index.ts";
import { verifyCandidateSource } from "./candidate-source-binding.mjs";

const EXPECTED_EXECUTABLE = [
  "anthropic-claude-opus-4.7-pi",
  // Nemotron 3 lanes bind `chat-template-kwarg`, measured to suppress
  // reasoning on these SKUs; the retired 49B record keeps `/no_think`. Evidence:
  // docs/internal/evidence/nemotron3-request-policy-probe-2026-08-24/.
  "nvidia-nemotron-3-super-120b-a12b-pi",
  "nvidia-nemotron-3-ultra-550b-a55b-pi",
  "nvidia-nemotron-3.5-lightning-30b-a3b-pi",
  // Inference Hub lanes: the same `chat-template-kwarg` control, measured on
  // this route (docs/internal/evidence/inference-hub-request-policy-probe-2026-08-26/).
  // nemotron-3.5-lightning has no lane here: no control suppressed its split on
  // this route. Controls are measured per (model id, route).
  "nvidia-inference-nemotron-3-super-v3-pi",
  "nvidia-inference-nemotron-3-ultra-pi",
  "nvidia-inference-qwen3-5-397b-a17b-pi",
  // DeepSeek V4 Pro binds `nvidia/deepseek-ai/deepseek-v4-pro` with NO request
  // policy. Basis (#1454): a 2026-09-28 probe of 2 prompts at 128 tokens, no
  // tool prompt, returned content with no reasoning split. The former `azure/`
  // id split without a control on 2026-08-26 and now returns 403; the new id is
  // not yet checked with tool prompts.
  "nvidia-inference-deepseek-v4-pro-pi",
  // Anthropic Claude through the Inference Hub. Not reasoning-split, so no
  // installed request policy: the provider refuses the policy's fixed
  // sampling. Secondary records.
  "nvidia-inference-claude-opus-5-pi",
  "nvidia-inference-claude-sonnet-5-pi",
  // OpenAI GPT-6 Sol through the Inference Hub: `harness-compatible` (text in
  // `content`), so no installed request policy. The primary composition and
  // the CI live-model binding (`LIVE_MODEL_CI_COMPOSITION_ID`). Context, input,
  // and output are the Inference Hub Metadata values (1,050,000 / 1,050,000 /
  // 128,000, read 2026-09-28, #1454); the route also accepted 128,000 output.
  "nvidia-inference-gpt-6-sol-pi",
];
const EXPECTED_PREFLIGHT = [
  "anthropic-claude-opus-4.7-claude-code-preflight",
  // Successor of the retired GPT-5.6 Codex preflight (#1512). Same route;
  // requests the Codex slug `gpt-6-sol` and pins codex-cli 0.155.1 through the
  // 1.1.0 Codex adapter records, while the retired record keeps 0.147.0.
  "openai-gpt-6-sol-codex-preflight",
];
// Retired records stay installed so completed run records keep rebinding to
// their exact digests. They must never reappear in the executable set, and
// selecting one for a new execution must fail closed with `composition-retired`.
// Each entry names its reason, so a record cannot be retired under the other
// reason's evidence, and its declared successor, which must be live.
const EXPECTED_RETIRED = {
  // NVIDIA ended nvidia/llama-3.3-nemotron-super-49b-v1.5 on the API Catalog
  // route on 2026-08-26T09:00:00Z (HTTP 410 observed 2026-09-10).
  "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi": {
    reason: "provider-end-of-life",
    successor: undefined,
  },
  // NVIDIA disables GPT-5.6 in its Codex environment effective 2026-09-30
  // (provider notice forwarded by Lawrence Lane, #1512).
  "openai-gpt-5.6-sol-codex-preflight": {
    reason: "provider-end-of-life",
    successor: "openai-gpt-6-sol-codex-preflight",
  },
  // The direct OpenAI API still serves gpt-5.6-sol; Lawrence Lane retired it
  // by decision on 2026-09-28 (#1512).
  "openai-gpt-5.6-sol-pi": {
    reason: "superseded-by-operator-decision",
    successor: "nvidia-inference-gpt-6-sol-pi",
  },
};
const EXPECTED_RETIRED_IDS = Object.keys(EXPECTED_RETIRED);
const EXPECTED_WORKFLOWS = [
  // The snapshot's workflow ids, hosted jobs included. `live-agent-turn` has no
  // local entry point and shares the review job's composition record, because
  // `compositionSha256` covers the declared tool set, not the workflow name or
  // step ids.
  "audit-documentation",
  "bootstrap",
  "create-documentation",
  "foundation",
  "foundation-to-patch",
  "ia-analysis",
  "ia-plan",
  "live-agent-turn",
  "readiness",
  "release-documentation-readiness",
  "reconcile-product-behavior",
  "review-documentation",
  "restructure-documentation",
  "site-bootstrap",
  "update-documentation",
];
const WORKFLOW_STEP_ROLES = {
  "assess-documentation-readiness": "documentation-auditor",
  "doc-context-analyzer": "documentation-foundation-inspector",
  "audit-documentation": "documentation-auditor",
  "evaluate-document-quality": "documentation-quality-evaluator",
  "lint-documentation": "documentation-linter",
  "plan-documentation": "documentation-planner",
  "reconcile-product-behavior": "product-behavior-analyst",
  "review-documentation": "senior-editor",
  "test-audience-understanding": "target-audience-proxy",
  "verify-technical-accuracy": "technical-verifier",
  "repo-bootstrap": "senior-technical-writer",
  "template-scaffold-site": "site-scaffold-operator",
  "tpl-design-ia": "information-architecture-designer",
  "write-documentation": "senior-technical-writer",
};

function fail(message) {
  throw new Error(`Model-composition check failed: ${message}`);
}

function sameValues(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

const repoRoot = await realpath(
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  }).trim(),
);
const workflowCatalog = JSON.parse(
  await readFile(
    resolve(repoRoot, "packages/runtime/model-compositions/workflow-catalog.json"),
    "utf8",
  ),
);
for (const workflowId of [
  "audit-documentation",
  "bootstrap",
  "create-documentation",
  "foundation",
  "foundation-to-patch",
  "ia-analysis",
  "ia-plan",
  "review-documentation",
  "reconcile-product-behavior",
  "site-bootstrap",
]) {
  const installed = workflowCatalog.workflows.find((entry) => entry.workflowId === workflowId);
  const sourcePath = `workflows/${workflowId}.json`;
  const source = JSON.parse(
    await readFile(resolve(repoRoot, "packages/runtime", sourcePath), "utf8"),
  );
  const workflow = parseWorkflowManifestSnapshot(source, workflowId, {
    "documentation-audit": documentationAuditSearch,
    "documentation-observation": documentationObservationSearch,
    "information-architecture-discovery": iaDiscoverySearch,
  });
  // The validated V3 projection includes every declared revision phase; the
  // runtime selects its finite retain/revise path only after prefix execution.
  const expectedSteps = workflow.steps.map((step, index) => ({
    stepId: step.id,
    stepMode: step.mode,
    stepOrdinal: index + 1,
    skillId: step.skill,
    role: WORKFLOW_STEP_ROLES[step.skill],
  }));
  if (
    installed?.sourcePath !== sourcePath ||
    expectedSteps.some((step) => step.role === undefined) ||
    JSON.stringify(installed.steps) !== JSON.stringify(expectedSteps)
  ) {
    fail(`${workflowId} installed step topology differs from its canonical workflow`);
  }
}
const { authority, snapshot } = await loadInstalledModelCompositionAuthority();
if (
  !sameValues(snapshot.executableCompositionIds, EXPECTED_EXECUTABLE) ||
  !sameValues(snapshot.preflightCompositionIds, EXPECTED_PREFLIGHT) ||
  !sameValues(snapshot.workflowIds, EXPECTED_WORKFLOWS)
) {
  fail("installed composition or workflow set differs from the frozen composition slice");
}

const summaries = listInstalledModelCompositions(authority);
if (
  summaries.length !==
    EXPECTED_EXECUTABLE.length + EXPECTED_PREFLIGHT.length + EXPECTED_RETIRED_IDS.length ||
  summaries.some(
    (entry) => entry.technicalApproval !== "not-established" || entry.releaseEligible !== false,
  )
) {
  fail("a composition makes an approval or release claim");
}
if (
  !sameValues(
    summaries.filter((entry) => entry.status === "retired").map((entry) => entry.compositionId),
    EXPECTED_RETIRED_IDS,
  ) ||
  summaries.some((entry) => (entry.status === "retired") !== (entry.retirement !== undefined))
) {
  fail("the retired composition set or its retirement evidence differs from the frozen slice");
}

for (const [compositionId, expected] of Object.entries(EXPECTED_RETIRED)) {
  const bound = resolveInstalledComposition({
    authority,
    compositionId,
    workflowId: "review-documentation",
  });
  const retirement = bound.composition.retirement;
  const successor = retirement?.successorCompositionId;
  if (
    bound.composition.status !== "retired" ||
    retirement?.reason !== expected.reason ||
    !bound.composition.limitations.includes(expected.reason) ||
    successor !== expected.successor ||
    (successor !== undefined &&
      !snapshot.executableCompositionIds.includes(successor) &&
      !snapshot.preflightCompositionIds.includes(successor)) ||
    snapshot.executableCompositionIds.includes(compositionId) ||
    snapshot.preflightCompositionIds.includes(compositionId)
  ) {
    fail("a retired composition is missing its retirement evidence or is still executable");
  }
  let refused = null;
  try {
    resolveInstalledExecutableComposition({
      authority,
      compositionId,
      workflowId: "review-documentation",
    });
  } catch (error) {
    refused = error;
  }
  if (refused?.code !== "composition-retired") {
    fail("a retired composition can still be selected for a new execution");
  }
}

for (const workflowId of EXPECTED_WORKFLOWS) {
  for (const compositionId of EXPECTED_EXECUTABLE) {
    const bound = resolveInstalledExecutableComposition({ authority, compositionId, workflowId });
    if (
      bound.composition.executionClass !== "pi-provider" ||
      bound.adapters.providerConnection.status !== "implemented" ||
      bound.adapters.harness.status !== "implemented"
    ) {
      fail("an executable composition does not bind implemented Pi adapters");
    }
  }
}

for (const compositionId of EXPECTED_PREFLIGHT) {
  const bound = resolveInstalledComposition({
    authority,
    compositionId,
    workflowId: "review-documentation",
  });
  if (
    bound.composition.executionClass !== "preflight-only" ||
    Object.values(bound.adapters).some((entry) => entry.status !== "preflight-only")
  ) {
    fail("a native CLI record is not preflight-only");
  }
}

for (const compositionId of snapshot.compositionIds) {
  const bound = resolveInstalledComposition({
    authority,
    compositionId,
    workflowId: "review-documentation",
  });
  await verifyCandidateSource({
    repositoryRoot: repoRoot,
    locator: bound.candidate.source.locator,
    sha256: bound.candidate.source.sha256,
  });
  const sourceNames = bound.composition.authentication.sourceNames;
  if (sourceNames.some((name) => name.startsWith("INFERENCE_HUB_"))) {
    fail("an inference composition depends on route-approval metadata credentials");
  }
}

console.log(
  `Model compositions are current: ${EXPECTED_EXECUTABLE.length} executable, ${EXPECTED_PREFLIGHT.length} preflight-only, ${EXPECTED_RETIRED_IDS.length} retired, ${EXPECTED_WORKFLOWS.length} workflows`,
);
