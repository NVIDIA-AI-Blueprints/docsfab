// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { testTimeoutMs } from "./helpers/test-timeouts.js";

import {
  decodeThreatModelV1,
  THREAT_MODEL_ID,
  THREAT_MODEL_REQUIRED_STAGES,
  ThreatModelContractError,
} from "../src/security/threat-model-contract.js";
import {
  decodeThreatModelReviewCandidate,
  decodeThreatModelReviewEvidenceRequest,
  GlabThreatModelReviewApi,
  type ThreatModelReviewApi,
  ThreatModelReviewVerificationError,
  verifyThreatModelReviews,
} from "../src/security/threat-model-reviews.js";

import { THREAT_MODEL_TEST_DESTINATION } from "./helpers/threat-model-candidate-inputs.js";

const MODEL_PATH = new URL("../security/threat-model.v1.json", import.meta.url);
const REVIEW_PATH = new URL("../security/threat-model-reviews.v1.json", import.meta.url);
const DOCUMENT_PATH = new URL("../docs/about/security-threat-model.md", import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(
  new URL("../src/security/threat-model-review-cli.ts", import.meta.url),
);
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const REFUSAL = "Threat-model review evidence is missing, stale, or invalid.";

const REQUIRED_STAGES = [
  "credential-configuration",
  "repository-export",
  "context-selection",
  "prompt-construction",
  "authorization",
  "provider-adapter",
  "catalog-metadata",
  "tool-call-and-result",
  "logs-and-diagnostics",
  "run-records",
  "patch-capture",
  "isolated-validation",
  "git",
  "gitlab",
] as const;

type Flow = {
  id: string;
  stage: string;
  data?: string;
  sources: string[];
  destinations: string[];
  threats: string[];
  controls: string[];
};

type Threat = {
  id: string;
  scenario: string;
  disposition: string;
  flows: string[];
  controls: string[];
};

type Control = {
  id: string;
  status: string;
  owner: string;
  flows: string[];
  threats: string[];
  requirement: string;
  verification: string;
};

type Decision = {
  id: string;
  question: string;
  decision: string;
  rationale: string;
  implementationIssues: number[];
};

type ThreatModel = {
  schemaVersion: number;
  modelId: string;
  status: string;
  requiredStages: string[];
  invariants: string[];
  zones: Array<{ id: string }>;
  flows: Flow[];
  threats: Threat[];
  controls: Control[];
  decisions: Decision[];
  acceptedRisks: Array<{ id: string; risk: string; reason: string }>;
  removedControls: Array<{ id: string; control: string; reason: string }>;
  outOfScope: string[];
  reviewGate: {
    requiredRoles: string[];
    decision: string;
    evidenceKind: string;
    approvalRuleNames: { security: string; product: string };
    binding: string;
    verification: string;
  };
};

async function load(): Promise<{
  model: ThreatModel;
  reviews: ReturnType<typeof decodeThreatModelReviewCandidate>;
  modelBytes: Buffer;
  documentBytes: Buffer;
  document: string;
}> {
  const [modelBytes, reviewBytes, documentBytes] = await Promise.all([
    readFile(MODEL_PATH),
    readFile(REVIEW_PATH),
    readFile(DOCUMENT_PATH),
  ]);
  return {
    model: JSON.parse(modelBytes.toString("utf8")) as ThreatModel,
    reviews: decodeThreatModelReviewCandidate(reviewBytes),
    modelBytes,
    documentBytes,
    document: documentBytes.toString("utf8"),
  };
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

class FixtureReviewApi implements ThreatModelReviewApi {
  afterGet?: (path: string, responses: Map<string, unknown>) => void;

  constructor(
    readonly responses: Map<string, unknown>,
    readonly host: string,
  ) {}

  async get(path: string): Promise<unknown> {
    if (!this.responses.has(path)) throw new Error(`unexpected fixture path: ${path}`);
    const result = structuredClone(this.responses.get(path));
    this.afterGet?.(path, this.responses);
    return result;
  }
}

function reviewApiFixture(input: {
  candidateBytes: Buffer;
  modelBytes: Buffer;
  documentBytes: Buffer;
}): {
  api: FixtureReviewApi;
  request: ReturnType<typeof decodeThreatModelReviewEvidenceRequest>;
  paths: {
    projectApprovals: string;
    mr: string;
    approvals: string;
    rules: string;
    versions: string;
    securityNote: string;
    productNote: string;
  };
} {
  const commit = "a".repeat(40);
  const candidate = JSON.parse(input.candidateBytes.toString("utf8")) as {
    gitlabHost: string;
    projectPath: string;
    packagePath: string;
    requiredApprovalRules: { security: string; product: string };
  };
  const project = encodeURIComponent(candidate.projectPath);
  const mr = `projects/${project}/merge_requests/77`;
  // GitLab names repository files by their path from the repository root.
  const file = (packageFile: string, bytes: Buffer): [string, unknown] => {
    const path = `${candidate.packagePath}/${packageFile}`;
    return [
      `projects/${project}/repository/files/${encodeURIComponent(path)}?ref=${commit}`,
      {
        file_path: path,
        encoding: "base64",
        content: bytes.toString("base64"),
        blob_id: "b".repeat(40),
        commit_id: commit,
      },
    ];
  };
  const security = { id: 101, username: "security-reviewer" };
  const product = { id: 202, username: "product-reviewer" };
  const paths = {
    projectApprovals: `projects/${project}/approvals`,
    mr,
    approvals: `${mr}/approvals`,
    rules: `${mr}/approval_state`,
    versions: `${mr}/versions`,
    securityNote: `${mr}/notes/501`,
    productNote: `${mr}/notes/502`,
  };
  const responses = new Map<string, unknown>([
    [
      mr,
      {
        id: 9001,
        iid: 77,
        project_id: 422255,
        sha: commit,
        state: "opened",
        detailed_merge_status: "mergeable",
        title: "ignored",
      },
    ],
    [
      paths.versions,
      [
        {
          id: 8001,
          head_commit_sha: commit,
          merge_request_id: 9001,
          state: "collected",
          patch_id_sha: "e".repeat(40),
          created_at: "2026-08-04T19:59:00.000Z",
        },
      ],
    ],
    [paths.projectApprovals, { reset_approvals_on_push: true, approvals_before_merge: 0 }],
    file("security/threat-model-reviews.v1.json", input.candidateBytes),
    file("security/threat-model.v1.json", input.modelBytes),
    file("docs/about/security-threat-model.md", input.documentBytes),
    [
      paths.rules,
      {
        approval_rules_overwritten: false,
        rules: [
          {
            id: 11,
            name: candidate.requiredApprovalRules.security,
            rule_type: "regular",
            approvals_required: 1,
            approved: true,
            approved_by: [security],
            eligible_approvers: [security],
          },
          {
            id: 12,
            name: candidate.requiredApprovalRules.product,
            rule_type: "regular",
            approvals_required: 1,
            approved: true,
            approved_by: [product],
            eligible_approvers: [product],
          },
        ],
      },
    ],
    [paths.approvals, { approved_by: [{ user: security }, { user: product }], approved: true }],
    [
      paths.securityNote,
      {
        id: 501,
        body: "approved this merge request",
        system: true,
        author: security,
        noteable_iid: 77,
        noteable_type: "MergeRequest",
        project_id: 422255,
        created_at: "2026-08-04T20:00:00.000Z",
      },
    ],
    [
      paths.productNote,
      {
        id: 502,
        body: "approved this merge request",
        system: true,
        author: product,
        noteable_iid: 77,
        noteable_type: "MergeRequest",
        project_id: 422255,
        created_at: "2026-08-04T20:01:00.000Z",
      },
    ],
  ]);
  return {
    api: new FixtureReviewApi(responses, candidate.gitlabHost),
    request: decodeThreatModelReviewEvidenceRequest({
      schemaVersion: 1,
      kind: "docsfab-threat-model-external-review-request",
      mergeRequestIid: 77,
      candidateCommit: commit,
      approvals: [
        { role: "security", approvalNoteId: 501 },
        { role: "product", approvalNoteId: 502 },
      ],
    }),
    paths,
  };
}

/** Runs the shipped CLI against a fake glab that answers the fixture's GitLab reads. */
async function withFakeGitlab(
  candidateBytes: Buffer,
  body: (context: {
    root: string;
    run: (cwd: string, host: string) => ReturnType<typeof spawnSync>;
    fetched: () => Promise<string[][]>;
  }) => Promise<void>,
): Promise<void> {
  const { modelBytes, documentBytes } = await load();
  const { api, request } = reviewApiFixture({ candidateBytes, modelBytes, documentBytes });
  const root = await mkdtemp(join(tmpdir(), "docsfab-threat-review-e2e-"));
  try {
    const responses = join(root, "responses.json");
    const calls = join(root, "calls.jsonl");
    const evidence = join(root, "evidence.json");
    await writeFile(responses, JSON.stringify(Object.fromEntries(api.responses)));
    await writeFile(calls, "");
    await writeFile(evidence, JSON.stringify(request));
    const executable = join(root, "glab");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = process.argv[5];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, "utf8"));
if (!Object.hasOwn(responses, path)) process.exit(1);
process.stdout.write(JSON.stringify(responses[path]));
`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const run = (cwd: string, host: string) =>
      spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, evidence, "--json"], {
        cwd,
        encoding: "utf8",
        env: {
          PATH: `${root}:${process.env.PATH ?? ""}`,
          HOME: root,
          TMPDIR: tmpdir(),
          DOCSFAB_THREAT_MODEL_REVIEW_GITLAB_HOST: host,
        },
      });
    const fetched = async () =>
      (await readFile(calls, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    await body({ root, run, fetched });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("credential and data-boundary threat model", () => {
  it("covers every required stage with unique zones, flows, threats, and controls", async () => {
    const { model, modelBytes } = await load();
    expect(() => decodeThreatModelV1(modelBytes)).not.toThrow();
    expect(REQUIRED_STAGES).toEqual(THREAT_MODEL_REQUIRED_STAGES);
    expect(model.schemaVersion).toBe(1);
    expect(model.modelId).toBe(THREAT_MODEL_ID);
    expect(model.status).toBe("review-controlled");
    expect(model.requiredStages).toEqual(REQUIRED_STAGES);
    expect([...new Set(model.flows.map((flow) => flow.stage))].sort()).toEqual(
      [...REQUIRED_STAGES].sort(),
    );
    expect(model.flows.length).toBeGreaterThan(REQUIRED_STAGES.length);

    for (const [prefix, values] of [
      ["Z", model.zones],
      ["F", model.flows],
      ["T", model.threats],
      ["C", model.controls],
      ["D", model.decisions],
      ["R", model.acceptedRisks],
      ["X", model.removedControls],
    ] as const) {
      const ids = values.map((value) => value.id);
      expect(unique(ids), `${prefix} identifiers must be unique`).toBe(true);
      for (const id of ids) expect(id).toMatch(new RegExp(`^${prefix}-\\d{2}$`, "u"));
    }
  });

  it("has no orphan or one-way flow, threat, and control mappings", async () => {
    const { model } = await load();
    const zones = new Set(model.zones.map((zone) => zone.id));
    const flows = new Map(model.flows.map((flow) => [flow.id, flow]));
    const threats = new Map(model.threats.map((threat) => [threat.id, threat]));
    const controls = new Map(model.controls.map((control) => [control.id, control]));

    for (const flow of model.flows) {
      expect(flow.sources.length).toBeGreaterThan(0);
      for (const source of flow.sources) {
        expect(zones.has(source), `${flow.id} source ${source}`).toBe(true);
      }
      expect(flow.destinations.length).toBeGreaterThan(0);
      expect(flow.threats.length).toBeGreaterThan(0);
      expect(flow.controls.length).toBeGreaterThan(0);
      for (const destination of flow.destinations) {
        expect(zones.has(destination), `${flow.id} destination ${destination}`).toBe(true);
      }
      for (const id of flow.threats) {
        expect(threats.get(id)?.flows, `${flow.id} -> ${id}`).toContain(flow.id);
      }
      for (const id of flow.controls) {
        expect(controls.get(id)?.flows, `${flow.id} -> ${id}`).toContain(flow.id);
      }
    }

    for (const threat of model.threats) {
      expect(validText(threat.scenario)).toBe(true);
      expect(validText(threat.disposition)).toBe(true);
      expect(threat.flows.length).toBeGreaterThan(0);
      expect(threat.controls.length).toBeGreaterThan(0);
      for (const id of threat.flows) expect(flows.has(id), `${threat.id} -> ${id}`).toBe(true);
      for (const id of threat.controls) {
        expect(controls.get(id)?.threats, `${threat.id} -> ${id}`).toContain(threat.id);
      }
    }

    for (const control of model.controls) {
      expect(validText(control.status)).toBe(true);
      expect(validText(control.owner)).toBe(true);
      expect(validText(control.requirement)).toBe(true);
      expect(validText(control.verification)).toBe(true);
      expect(control.flows.length).toBeGreaterThan(0);
      expect(control.threats.length).toBeGreaterThan(0);
      for (const id of control.flows) {
        expect(flows.has(id), `${control.id} -> ${id}`).toBe(true);
        expect(flows.get(id)?.controls, `${control.id} -> ${id}`).toContain(control.id);
      }
      for (const id of control.threats) {
        expect(threats.get(id)?.controls, `${control.id} -> ${id}`).toContain(control.id);
      }
    }
  });

  it("keeps request, response, catalog, record, GitLab, and validator directions explicit", async () => {
    const { model } = await load();
    const flows = new Map(model.flows.map((flow) => [flow.id, flow]));
    expect(flows.get("F-04")?.sources).toEqual(["Z-01", "Z-03"]);
    expect(flows.get("F-04")?.destinations).toEqual(["Z-09"]);
    expect(flows.get("F-06")?.sources).toEqual(["Z-12"]);
    expect(flows.get("F-06")?.destinations).toEqual(["Z-04"]);
    expect(flows.get("F-07")?.sources).toEqual(["Z-04"]);
    expect(flows.get("F-07")?.destinations).toEqual(["Z-12"]);
    expect(flows.get("F-12")?.sources.length).toBeGreaterThan(1);
    expect(flows.get("F-19")?.destinations).toEqual(["Z-07"]);
    expect(flows.get("F-20")?.sources).toEqual(["Z-07"]);
    expect(flows.get("F-23")?.destinations).toEqual(["Z-10"]);
    expect(flows.get("F-24")?.sources).toEqual(["Z-10"]);
    expect(flows.get("F-16")?.destinations).toEqual(["Z-11"]);
    expect(flows.get("F-17")?.sources).toEqual(["Z-11"]);
    expect(flows.get("F-09")?.data).toContain("model-proposed write bytes");
    expect(flows.get("F-09")?.threats).toContain("T-14");
    expect(flows.get("F-09")?.controls).toContain("C-09");
    expect(flows.get("F-26")?.sources).toEqual(["Z-01"]);
    expect(flows.get("F-26")?.destinations).toEqual(["Z-09", "Z-06", "Z-13"]);
  });

  it("binds every governed #47 lifecycle and #103 cascade-observation boundary into the decoded graph", async () => {
    const { model, modelBytes, document } = await load();
    expect(() => decodeThreatModelV1(modelBytes)).not.toThrow();
    expect(model.zones.map(({ id }) => id)).toContain("Z-13");
    const flows = new Map(model.flows.map((flow) => [flow.id, flow]));
    const expected: Record<
      string,
      { sources: string[]; destinations: string[]; controls: string[] }
    > = {
      "F-27": {
        sources: ["Z-05", "Z-09"],
        destinations: ["Z-13"],
        controls: ["C-19", "C-20", "C-23"],
      },
      "F-28": {
        sources: ["Z-13"],
        destinations: ["Z-07"],
        controls: ["C-18", "C-22", "C-23", "C-24"],
      },
      "F-29": {
        sources: ["Z-07"],
        destinations: ["Z-13"],
        controls: ["C-18", "C-22", "C-23", "C-24"],
      },
      "F-30": {
        sources: ["Z-13"],
        destinations: ["Z-05", "Z-09", "Z-08"],
        controls: ["C-18", "C-22", "C-24"],
      },
      "F-31": { sources: ["Z-13"], destinations: ["Z-07"], controls: ["C-19", "C-21", "C-23"] },
      "F-32": { sources: ["Z-13"], destinations: ["Z-07"], controls: ["C-19", "C-21", "C-23"] },
      "F-33": { sources: ["Z-13"], destinations: ["Z-07"], controls: ["C-19", "C-21", "C-23"] },
      "F-34": { sources: ["Z-13"], destinations: ["Z-07"], controls: ["C-19", "C-21", "C-23"] },
      "F-35": { sources: ["Z-13"], destinations: ["Z-07"], controls: ["C-19", "C-21", "C-23"] },
      "F-36": { sources: ["Z-13"], destinations: ["Z-07"], controls: ["C-19", "C-21", "C-23"] },
      "F-37": { sources: ["Z-13"], destinations: ["Z-07"], controls: ["C-19", "C-21", "C-23"] },
      "F-38": { sources: ["Z-07"], destinations: ["Z-13"], controls: ["C-21", "C-22", "C-23"] },
      "F-39": { sources: ["Z-13"], destinations: ["Z-07"], controls: ["C-19", "C-21", "C-23"] },
      "F-40": {
        sources: ["Z-13"],
        destinations: ["Z-05", "Z-08"],
        controls: ["C-20", "C-21", "C-22"],
      },
    };
    for (const [id, binding] of Object.entries(expected)) {
      const flow = flows.get(id);
      expect(flow?.sources, `${id} sources`).toEqual(binding.sources);
      expect(flow?.destinations, `${id} destinations`).toEqual(binding.destinations);
      for (const control of binding.controls)
        expect(flow?.controls, `${id} -> ${control}`).toContain(control);
      expect(document).toContain(`\`${id}\``);
    }
    expect(
      model.threats.filter(({ id }) => /^T-(?:1[5-9]|20|21)$/u.test(id)).map(({ id }) => id),
    ).toEqual(["T-15", "T-16", "T-17", "T-18", "T-19", "T-20", "T-21"]);
    expect(
      model.controls.filter(({ id }) => /^C-(?:1[89]|2[0-4])$/u.test(id)).map(({ id }) => id),
    ).toEqual(["C-18", "C-19", "C-20", "C-21", "C-22", "C-23", "C-24"]);
    for (const phrase of [
      "literal-safe transport channel",
      "final boundary immediately before each mutation",
      "reconcile-only",
      "post-rename",
      "destructive bulk close",
      "authentic assessment/workspace-bound",
      "trackerMutation: not-authorized",
    ])
      expect(document).toContain(phrase);

    const removeFlow = structuredClone(model as unknown as Record<string, unknown>);
    removeFlow.flows = (removeFlow.flows as Array<Record<string, unknown>>).filter(
      ({ id }) => id !== "F-31",
    );
    for (const threat of removeFlow.threats as Array<Record<string, unknown>>) {
      threat.flows = (threat.flows as string[]).filter((id) => id !== "F-31");
    }
    for (const control of removeFlow.controls as Array<Record<string, unknown>>) {
      control.flows = (control.flows as string[]).filter((id) => id !== "F-31");
    }
    expect(() => decodeThreatModelV1(removeFlow)).toThrow(ThreatModelContractError);

    const weakenFlow = structuredClone(model as unknown as Record<string, unknown>);
    const createFlow = (weakenFlow.flows as Array<Record<string, unknown>>).find(
      ({ id }) => id === "F-31",
    )!;
    createFlow.controls = (createFlow.controls as string[]).filter((id) => id !== "C-23");
    const transport = (weakenFlow.controls as Array<Record<string, unknown>>).find(
      ({ id }) => id === "C-23",
    )!;
    transport.flows = (transport.flows as string[]).filter((id) => id !== "F-31");
    expect(() => decodeThreatModelV1(weakenFlow)).toThrow(ThreatModelContractError);

    const removeDecision = structuredClone(model as unknown as Record<string, unknown>);
    removeDecision.decisions = (removeDecision.decisions as Array<Record<string, unknown>>).filter(
      ({ id }) => id !== "D-12",
    );
    expect(() => decodeThreatModelV1(removeDecision)).toThrow(ThreatModelContractError);

    const weakenCascadeObservation = structuredClone(model as unknown as Record<string, unknown>);
    const observation = (weakenCascadeObservation.flows as Array<Record<string, unknown>>).find(
      ({ id }) => id === "F-30",
    )!;
    observation.controls = (observation.controls as string[]).filter((id) => id !== "C-24");
    const cascadeControl = (
      weakenCascadeObservation.controls as Array<Record<string, unknown>>
    ).find(({ id }) => id === "C-24")!;
    cascadeControl.flows = (cascadeControl.flows as string[]).filter((id) => id !== "F-30");
    expect(() => decodeThreatModelV1(weakenCascadeObservation)).toThrow(ThreatModelContractError);

    const removeCascadeDecision = structuredClone(model as unknown as Record<string, unknown>);
    removeCascadeDecision.decisions = (
      removeCascadeDecision.decisions as Array<Record<string, unknown>>
    ).filter(({ id }) => id !== "D-13");
    expect(() => decodeThreatModelV1(removeCascadeDecision)).toThrow(ThreatModelContractError);
  });

  it("records the responsibility, exact-egress, shell, mode, and sharing decisions", async () => {
    const { model } = await load();
    expect(model.decisions.map((decision) => decision.id)).toEqual([
      "D-01",
      "D-02",
      "D-03",
      "D-04",
      "D-05",
      "D-06",
      "D-07",
      "D-08",
      "D-09",
      "D-10",
      "D-11",
      "D-12",
      "D-13",
    ]);
    for (const decision of model.decisions) {
      expect(validText(decision.question)).toBe(true);
      expect(validText(decision.decision)).toBe(true);
      expect(validText(decision.rationale)).toBe(true);
      expect(decision.implementationIssues.length).toBeGreaterThan(0);
    }
    expect(model.invariants.join("\n")).toContain(
      "Repository and CI credential enforcement belongs to GitLab",
    );
    expect(model.decisions.find(({ id }) => id === "D-02")?.decision).toContain(
      "exact serialized model message",
    );
    expect(model.decisions.find(({ id }) => id === "D-05")?.decision).toContain(
      "intentionally excluded",
    );
    expect(model.decisions.find(({ id }) => id === "D-01")?.decision).toContain("supersedes #32");
    expect(model.decisions.find(({ id }) => id === "D-07")?.decision).toContain("#52");
    expect(model.decisions.find(({ id }) => id === "D-09")?.decision).toContain("#37");
    expect(model.decisions.find(({ id }) => id === "D-12")?.decision).toContain("#47");
    expect(model.decisions.find(({ id }) => id === "D-13")?.decision).toContain("#103");
    expect(model.controls.find(({ id }) => id === "C-04")?.threats).not.toContain("T-02");
    expect(model.threats.find(({ id }) => id === "T-02")?.controls).not.toContain("C-04");
    expect(model.acceptedRisks.length).toBeGreaterThanOrEqual(8);
    expect(model.outOfScope.length).toBeGreaterThanOrEqual(6);
    expect(model.removedControls.map(({ id }) => id)).toEqual(["X-01", "X-02", "X-03"]);
  });

  it("keeps the human review document complete and explicit about pending approval", async () => {
    const { model, document } = await load();
    for (const entry of [
      ...model.zones,
      ...model.flows,
      ...model.threats,
      ...model.controls,
      ...model.decisions,
      ...model.acceptedRisks,
      ...model.removedControls,
    ]) {
      expect(document, `missing ${entry.id}`).toContain(`\`${entry.id}\``);
    }
    expect(document).toContain("does not self-assert approval");
    expect(document).toMatch(/GitLab and\s+organizational CI own credentials committed/u);
    expect(document).toContain("Why unrestricted shell is excluded");
    expect(document).toContain("Hosted inference");
    expect(document).toContain("Local inference");
    expect(document).toContain("Local-user GitLab delivery");
    expect(document).toContain("Authenticated Metadata and catalog boundary");
    expect(document).toContain("Isolated validation subprocess");
    expect(document).toContain("External approval gate");
  });

  it("uses a strict non-self-referential candidate manifest", async () => {
    const { model, reviews, modelBytes, documentBytes } = await load();
    const digest = createHash("sha256").update(modelBytes).digest("hex");
    const documentDigest = createHash("sha256").update(documentBytes).digest("hex");
    expect(reviews.schemaVersion).toBe(1);
    expect(reviews.modelId).toBe(model.modelId);
    expect(reviews.modelSha256).toBe(digest);
    expect(reviews.documentSha256).toBe(documentDigest);
    expect(reviews.projectPath).toBe(THREAT_MODEL_TEST_DESTINATION.projectPath);
    expect(reviews.gitlabHost).toBe(THREAT_MODEL_TEST_DESTINATION.gitlabHost);
    expect(reviews.packagePath).toBe("packages/runtime");
    expect(reviews.status).toBe("external-approval-required");
    expect(reviews.protocol).toBe("external-gitlab-approval-v1");
    // The rule names are the GitLab project's own; the candidate carries them.
    expect(Object.keys(reviews.requiredApprovalRules).sort()).toEqual(["product", "security"]);
    expect(reviews.requiredApprovalRules.security).toMatch(/\S/u);
    expect(reviews.requiredApprovalRules.product).toMatch(/\S/u);
    expect(reviews.requiredApprovalRules.security).not.toBe(reviews.requiredApprovalRules.product);
    expect(Object.hasOwn(reviews, "reviewedCommit")).toBe(false);
    expect(Object.hasOwn(reviews, "approvals")).toBe(false);
    expect(model.reviewGate.requiredRoles).toEqual(["security", "product"]);
    expect(model.reviewGate.decision).toBe("approved");
    expect(model.reviewGate.evidenceKind).toBe("gitlab-external-approval-verification");
    expect(model.reviewGate.approvalRuleNames).toEqual(reviews.requiredApprovalRules);
  });

  it("rejects closed-schema mutations across every semantic collection", async () => {
    const { model } = await load();
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value.unexpected = true;
      },
      (value) => {
        (value.zones as Array<Record<string, unknown>>)[0]!.description = "";
      },
      (value) => {
        (value.flows as Array<Record<string, unknown>>)[0]!.modes = ["invented"];
      },
      (value) => {
        (value.flows as Array<Record<string, unknown>>)[0]!.data = [];
      },
      (value) => {
        (value.threats as Array<Record<string, unknown>>)[0]!.impact = "";
      },
      (value) => {
        (value.controls as Array<Record<string, unknown>>)[0]!.status = "claimed-complete";
      },
      (value) => {
        (value.decisions as Array<Record<string, unknown>>)[0]!.implementationIssues = [];
      },
      (value) => {
        (value.acceptedRisks as Array<Record<string, unknown>>)[0]!.reason = "";
      },
      (value) => {
        (value.removedControls as Array<Record<string, unknown>>)[0]!.control = "";
      },
      (value) => {
        value.outOfScope = [""];
      },
      (value) => {
        (value.reviewGate as Record<string, unknown>).unexpected = true;
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(model as unknown as Record<string, unknown>);
      mutate(candidate);
      expect(() => decodeThreatModelV1(candidate)).toThrow(ThreatModelContractError);
    }
  });

  it("rejects dangling, one-way, and missing-stage graph semantics inside the decoder", async () => {
    const { model } = await load();
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        const flows = value.flows as Array<Record<string, unknown>>;
        flows[0]!.sources = ["Z-99"];
      },
      (value) => {
        const flows = value.flows as Array<Record<string, unknown>>;
        flows[0]!.destinations = ["Z-99"];
      },
      (value) => {
        const flows = value.flows as Array<Record<string, unknown>>;
        flows[0]!.threats = ["T-99"];
      },
      (value) => {
        const flows = value.flows as Array<Record<string, unknown>>;
        flows[0]!.controls = ["C-99"];
      },
      (value) => {
        const threats = value.threats as Array<Record<string, unknown>>;
        threats[0]!.flows = ["F-99"];
      },
      (value) => {
        const threats = value.threats as Array<Record<string, unknown>>;
        threats[0]!.controls = ["C-99"];
      },
      (value) => {
        const controls = value.controls as Array<Record<string, unknown>>;
        controls[0]!.flows = ["F-99"];
      },
      (value) => {
        const controls = value.controls as Array<Record<string, unknown>>;
        controls[0]!.threats = ["T-99"];
      },
      (value) => {
        const flows = value.flows as Array<Record<string, unknown>>;
        flows[0]!.threats = ["T-02"];
      },
      (value) => {
        const threats = value.threats as Array<Record<string, unknown>>;
        threats[0]!.controls = ["C-02"];
      },
      (value) => {
        const flows = value.flows as Array<Record<string, unknown>>;
        const authorization = flows.find(({ stage }) => stage === "authorization")!;
        authorization.stage = "git";
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(model as unknown as Record<string, unknown>);
      mutate(candidate);
      expect(() => decodeThreatModelV1(candidate)).toThrow(ThreatModelContractError);
    }
  });

  it("verifies only current API-returned rule approvals on the exact candidate", async () => {
    const { reviews, modelBytes, documentBytes } = await load();
    const candidateBytes = await readFile(REVIEW_PATH);
    const { api, request } = reviewApiFixture({ candidateBytes, modelBytes, documentBytes });
    await expect(verifyThreatModelReviews(reviews, request, api)).resolves.toEqual({
      schemaVersion: 1,
      kind: "docsfab-verified-threat-model-reviews",
      modelId: THREAT_MODEL_ID,
      gitlabHost: reviews.gitlabHost,
      projectPath: THREAT_MODEL_TEST_DESTINATION.projectPath,
      mergeRequestIid: 77,
      candidateCommit: "a".repeat(40),
      modelSha256: reviews.modelSha256,
      documentSha256: reviews.documentSha256,
      approvals: [
        { role: "security", approvalRuleId: 11, approvalNoteId: 501, reviewerUserId: 101 },
        { role: "product", approvalRuleId: 12, approvalNoteId: 502, reviewerUserId: 202 },
      ],
    });
  });

  it("names the directory that holds the reviewed files in this repository", async () => {
    const { reviews } = await load();
    const repositoryRoot = new URL("../../../", import.meta.url);
    for (const [local, file] of [
      [REVIEW_PATH, "security/threat-model-reviews.v1.json"],
      [MODEL_PATH, "security/threat-model.v1.json"],
      [DOCUMENT_PATH, "docs/about/security-threat-model.md"],
    ] as const) {
      const fromRoot = new URL(`${reviews.packagePath}/${file}`, repositoryRoot);
      expect(await readFile(fromRoot)).toEqual(await readFile(local));
    }
  });

  // Each case spawns the CLI through tsx once and the fake glab once per API read.
  it("verifies the checked-in candidate end to end through the CLI and the glab path gate", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const { reviews } = await load();
    const candidateBytes = await readFile(REVIEW_PATH);
    await withFakeGitlab(candidateBytes, async ({ run, fetched }) => {
      const result = run(PACKAGE_ROOT, reviews.gitlabHost);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(String(result.stdout))).toMatchObject({
        kind: "docsfab-verified-threat-model-reviews",
        gitlabHost: reviews.gitlabHost,
        projectPath: THREAT_MODEL_TEST_DESTINATION.projectPath,
        documentSha256: reviews.documentSha256,
      });
      const calls = await fetched();
      const commit = "a".repeat(40);
      expect(
        calls
          .map((args) => args[3]!)
          .filter((path) => path.includes("/repository/files/"))
          .sort(),
      ).toEqual(
        [
          "packages%2Fruntime%2Fdocs%2Fabout%2Fsecurity-threat-model.md",
          "packages%2Fruntime%2Fsecurity%2Fthreat-model-reviews.v1.json",
          "packages%2Fruntime%2Fsecurity%2Fthreat-model.v1.json",
        ].map(
          (file) =>
            `projects/${encodeURIComponent(THREAT_MODEL_TEST_DESTINATION.projectPath)}/repository/files/${file}?ref=${commit}`,
        ),
      );
      expect(
        calls.every((args) => args[1] === "--hostname" && args[2] === reviews.gitlabHost),
      ).toBe(true);
    });
  });

  it("reads the files under the packagePath a repository candidate names", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const candidate = {
      ...(await load()).reviews,
      gitlabHost: "gitlab.example.com",
      projectPath: "docs/product",
      packagePath: "runtime",
    };
    const candidateBytes = Buffer.from(JSON.stringify(candidate), "utf8");
    await withFakeGitlab(candidateBytes, async ({ root, run, fetched }) => {
      const checkout = join(root, "checkout");
      await mkdir(join(checkout, "security"), { recursive: true });
      await writeFile(join(checkout, "security", "threat-model-reviews.v1.json"), candidateBytes);
      const result = run(checkout, candidate.gitlabHost);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(String(result.stdout))).toMatchObject({
        gitlabHost: "gitlab.example.com",
        projectPath: "docs/product",
      });
      expect(
        (await fetched())
          .map((args) => args[3]!)
          .filter((path) => path.includes("/repository/files/"))
          .map((path) => path.split("/")[4])
          .sort(),
      ).toEqual([
        "runtime%2Fdocs%2Fabout%2Fsecurity-threat-model.md?ref=" + "a".repeat(40),
        "runtime%2Fsecurity%2Fthreat-model-reviews.v1.json?ref=" + "a".repeat(40),
        "runtime%2Fsecurity%2Fthreat-model.v1.json?ref=" + "a".repeat(40),
      ]);
    });
  });

  it("refuses a candidate whose packagePath is not a plain repository directory", async () => {
    const { reviews } = await load();
    const { packagePath: _omitted, ...missing } = reviews;
    expect(() => decodeThreatModelReviewCandidate(missing)).toThrow(REFUSAL);
    for (const packagePath of [
      "",
      42,
      "/packages/runtime",
      "packages/runtime/",
      "packages//runtime",
      ".",
      "..",
      "packages/../runtime",
      "./packages/runtime",
      "packages/.runtime",
      "packages%2Fruntime",
      "packages\\runtime",
      "packages/runtime ",
    ]) {
      expect(() => decodeThreatModelReviewCandidate({ ...reviews, packagePath })).toThrow(REFUSAL);
      expect(
        () =>
          new GlabThreatModelReviewApi(tmpdir(), "gitlab.example.com", packagePath as string, {
            DOCSFAB_THREAT_MODEL_REVIEW_GITLAB_HOST: "gitlab.example.com",
          }),
      ).toThrow(REFUSAL);
    }
    for (const packagePath of ["runtime", "packages/runtime", "a/b_c/d-e/v1.2"]) {
      expect(decodeThreatModelReviewCandidate({ ...reviews, packagePath }).packagePath).toBe(
        packagePath,
      );
    }
  });

  it("rejects approvals until GitLab has collected the exact current diff", async () => {
    const { reviews, modelBytes, documentBytes } = await load();
    const candidateBytes = await readFile(REVIEW_PATH);
    const scenarios: Array<(fixture: ReturnType<typeof reviewApiFixture>) => void> = [
      ({ api, paths }) => {
        const mr = api.responses.get(paths.mr) as Record<string, unknown>;
        mr.detailed_merge_status = "checking";
      },
      ({ api, paths }) => {
        const mr = api.responses.get(paths.mr) as Record<string, unknown>;
        mr.detailed_merge_status = "approvals_syncing";
      },
      ({ api, paths }) => {
        const versions = api.responses.get(paths.versions) as Array<Record<string, unknown>>;
        versions[0]!.patch_id_sha = null;
      },
      ({ api, paths }) => {
        const versions = api.responses.get(paths.versions) as Array<Record<string, unknown>>;
        versions[0]!.head_commit_sha = "b".repeat(40);
      },
      ({ api, paths }) => {
        const versions = api.responses.get(paths.versions) as Array<Record<string, unknown>>;
        versions[0]!.state = "collecting";
      },
    ];
    for (const mutate of scenarios) {
      const fixture = reviewApiFixture({ candidateBytes, modelBytes, documentBytes });
      mutate(fixture);
      await expect(verifyThreatModelReviews(reviews, fixture.request, fixture.api)).rejects.toThrow(
        ThreatModelReviewVerificationError,
      );
    }
  });

  it("rejects unrelated notes, invented roles, revocation, head drift, and file drift", async () => {
    const { reviews, modelBytes, documentBytes } = await load();
    const candidateBytes = await readFile(REVIEW_PATH);
    const scenarios: Array<(fixture: ReturnType<typeof reviewApiFixture>) => void> = [
      ({ api, paths }) => {
        const note = api.responses.get(paths.securityNote) as Record<string, unknown>;
        note.body = "mentioned in issue #109";
      },
      ({ api, paths }) => {
        const note = api.responses.get(paths.securityNote) as Record<string, unknown>;
        note.system = false;
      },
      ({ api, paths }) => {
        const state = api.responses.get(paths.rules) as Record<string, unknown>;
        const rules = state.rules as Array<Record<string, unknown>>;
        rules[0]!.approved_by = [{ id: 303, username: "unrelated-user" }];
      },
      ({ api, paths }) => {
        const approvals = api.responses.get(paths.approvals) as Record<string, unknown>;
        approvals.approved_by = [{ user: { id: 202, username: "product-reviewer" } }];
      },
      ({ api, paths }) => {
        const mr = api.responses.get(paths.mr) as Record<string, unknown>;
        mr.sha = "c".repeat(40);
      },
      ({ api, paths }) => {
        const settings = api.responses.get(paths.projectApprovals) as Record<string, unknown>;
        settings.reset_approvals_on_push = false;
      },
      ({ api, paths }) => {
        const product = api.responses.get(paths.productNote) as Record<string, unknown>;
        product.author = { id: 101, username: "security-reviewer" };
        const state = api.responses.get(paths.rules) as Record<string, unknown>;
        const rules = state.rules as Array<Record<string, unknown>>;
        rules[1]!.approved_by = [{ id: 101, username: "security-reviewer" }];
      },
      ({ api, paths }) => {
        const state = api.responses.get(paths.rules) as Record<string, unknown>;
        state.approval_rules_overwritten = true;
      },
      ({ api }) => {
        const path = [...api.responses.keys()].find((item) =>
          item.includes("docs%2Fabout%2Fsecurity-threat-model.md"),
        )!;
        const file = api.responses.get(path) as Record<string, unknown>;
        file.content = Buffer.from("drift", "utf8").toString("base64");
      },
    ];
    for (const mutate of scenarios) {
      const fixture = reviewApiFixture({ candidateBytes, modelBytes, documentBytes });
      mutate(fixture);
      await expect(verifyThreatModelReviews(reviews, fixture.request, fixture.api)).rejects.toThrow(
        ThreatModelReviewVerificationError,
      );
    }

    expect(() =>
      decodeThreatModelReviewEvidenceRequest({
        ...reviewApiFixture({ candidateBytes, modelBytes, documentBytes }).request,
        action: "approved",
      }),
    ).toThrow(ThreatModelReviewVerificationError);
    expect(() =>
      decodeThreatModelReviewCandidate({
        ...reviews,
        modelId: "different-model",
      }),
    ).toThrow(ThreatModelReviewVerificationError);
  });

  it("rechecks mutable GitLab state after awaited approval-note reads", async () => {
    const { reviews, modelBytes, documentBytes } = await load();
    const candidateBytes = await readFile(REVIEW_PATH);
    const fixture = reviewApiFixture({ candidateBytes, modelBytes, documentBytes });
    fixture.api.afterGet = (path, responses) => {
      if (path === fixture.paths.productNote) {
        const mr = responses.get(fixture.paths.mr) as Record<string, unknown>;
        mr.sha = "d".repeat(40);
      }
    };
    await expect(verifyThreatModelReviews(reviews, fixture.request, fixture.api)).rejects.toThrow(
      ThreatModelReviewVerificationError,
    );
  });

  it("rechecks exact settled diff identity after awaited approval-note reads", async () => {
    const { reviews, modelBytes, documentBytes } = await load();
    const candidateBytes = await readFile(REVIEW_PATH);
    for (const mutate of [
      (fixture: ReturnType<typeof reviewApiFixture>) => {
        const mr = fixture.api.responses.get(fixture.paths.mr) as Record<string, unknown>;
        mr.detailed_merge_status = "approvals_syncing";
      },
      (fixture: ReturnType<typeof reviewApiFixture>) => {
        const versions = fixture.api.responses.get(fixture.paths.versions) as Array<
          Record<string, unknown>
        >;
        versions[0]!.patch_id_sha = "f".repeat(40);
      },
    ]) {
      const fixture = reviewApiFixture({ candidateBytes, modelBytes, documentBytes });
      fixture.api.afterGet = (path) => {
        if (path === fixture.paths.productNote) mutate(fixture);
      };
      await expect(verifyThreatModelReviews(reviews, fixture.request, fixture.api)).rejects.toThrow(
        ThreatModelReviewVerificationError,
      );
    }
  });

  it("uses a closed review endpoint grammar and a purpose-minimized glab environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-threat-review-glab-"));
    try {
      const executable = join(root, "glab");
      await writeFile(
        executable,
        `#!/usr/bin/env node
const present = (name) => Object.hasOwn(process.env, name);
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  glabToken: present("GLAB_TOKEN"),
  gitlabToken: present("GITLAB_TOKEN"),
  sshAgent: present("SSH_AUTH_SOCK"),
  inference: present("OPENAI_API_KEY"),
  catalog: present("DOCSFAB_METADATA_API_KEY"),
  unrelated: present("DOCSFAB_UNRELATED_SECRET"),
}));
`,
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      const api = new GlabThreatModelReviewApi(root, "gitlab.example.test", "packages/runtime", {
        PATH: `${root}:${process.env.PATH ?? ""}`,
        HOME: root,
        DOCSFAB_THREAT_MODEL_REVIEW_GITLAB_HOST: "gitlab.example.test",
        GLAB_TOKEN: "present",
        GITLAB_TOKEN: "present",
        SSH_AUTH_SOCK: "/private/agent.sock",
        OPENAI_API_KEY: "present",
        DOCSFAB_METADATA_API_KEY: "present",
        DOCSFAB_UNRELATED_SECRET: "present",
      });
      await expect(api.get("projects/docs%2Fproduct/approvals")).resolves.toMatchObject({
        glabToken: true,
        gitlabToken: true,
        sshAgent: false,
        inference: false,
        catalog: false,
        unrelated: false,
      });
      const commit = "a".repeat(40);
      const files = "projects/docs%2Fproduct/repository/files";
      await expect(
        api.get(`${files}/packages%2Fruntime%2Fsecurity%2Fthreat-model.v1.json?ref=${commit}`),
      ).resolves.toMatchObject({ glabToken: true });
      for (const path of [
        "projects/docs%2Fproduct/merge_requests/77/diffs",
        "projects/docs%2Fproduct/merge_requests/77/versions/1",
        "projects/docs%2Fproduct/repository/files/README.md?ref=" + "a".repeat(40),
        "projects/docs%2Fproduct/approvals?unexpected=true",
        "projects/docs%2Fproduct/merge_requests/77/notes/501?unexpected=true",
        // The reviewed files at the repository root, in another package, or as lookalikes.
        `${files}/security%2Fthreat-model.v1.json?ref=${commit}`,
        `${files}/docs%2Fabout%2Fsecurity-threat-model.md?ref=${commit}`,
        `${files}/packages%2Fhost%2Fsecurity%2Fthreat-model.v1.json?ref=${commit}`,
        `${files}/packages%2Fruntime%2Fdocs%2Fsecurity-threat-model.md?ref=${commit}`,
        `${files}/packages%2Fruntime%2Fsecurity%2Fthreat-model-reviewsXv1Xjson?ref=${commit}`,
        `${files}/packagesX2Fruntime%2Fsecurity%2Fthreat-model.v1.json?ref=${commit}`,
        `${files}/packages%2Fruntime%2Fsecurity%2Fthreat-model-reviews.v2.json?ref=${commit}`,
      ]) {
        await expect(api.get(path)).rejects.toThrow(REFUSAL);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
