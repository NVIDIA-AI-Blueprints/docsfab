// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { parseDoctorArguments } from "../src/cli.js";
import {
  compileContext,
  ContextIndexValidationError,
  ContextResultValidationError,
  validateContextResult,
} from "../src/context/compiler.js";
import { DocsFabPublicationMetadataError } from "../src/delivery/metadata.js";
import { LocalUserPublicationPreflightError } from "../src/delivery/contracts.js";
import { formatDoctorFailure, mapDoctorFailure, serializeDoctorFailure } from "../src/doctor.js";
import { INFERENCE_STEP_ERROR_CODES, InferenceStepError } from "../src/execution/contracts.js";
import {
  formatInitFailure,
  mapInitFailure,
  parseDocsFabInitArguments,
  serializeInitFailure,
} from "../src/init.js";
import { ExternalInputContractError } from "../src/inputs/contracts.js";
import { FirstRunProposalScopeError } from "../src/init/first-run-bootstrap.js";
import { ConfigurationRootPermissionError } from "../src/config/host-paths.js";
import {
  INIT_CONFIGURATION_ROOT_DOCS_ANCHOR,
  INIT_CONFIGURATION_ROOT_NEXT_ACTION,
} from "../src/init/render.js";
import { ConfigurationRootNotCanonicalError } from "../src/init/storage.js";
import { FirstPassSupportPreflightError } from "../src/cli/first-pass.js";
import { FirstPassSupportValidationError } from "../src/cli/first-pass-support.js";
import {
  ModelProfileMigrationError,
  localMissingModelProfileLocator,
  parseModelEndpoint,
} from "../src/model/configuration.js";
import {
  DEFAULT_DOCS_ANCHORS,
  REMEDIATION_DOCS_ANCHORS,
  formatOperatorErrorEnvelope,
  isContractErrorLike,
  reportOperatorFailure,
  serializeOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import type { InferenceFailureCategory } from "../src/records/contracts.js";
import { SecurePathError } from "../src/roadmap/secure-path.js";
import {
  WorkflowTaskValidationError,
  normalizeWorkflowTaskInput,
} from "../src/workflow-contracts/task.js";

class SampleContractError extends Error {
  constructor(public readonly code: "invalid-shape" | "credential-material") {
    super(`Sample contract rejected: ${code}.`);
    this.name = "SampleContractError";
  }
}

const HOME = process.env.HOME ?? homedir();
describe("operator error envelope", () => {
  it("round-trips ContractError codes into a typed envelope", () => {
    const error = new ExternalInputContractError("invalid-shape");
    expect(isContractErrorLike(error)).toBe(true);

    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-operator-error",
      code: "invalid-shape",
      message: "External-input contract rejected: invalid-shape.",
    });
    expect(envelope.nextAction).toMatch(/Inspect the rejected artifact/u);
    expect(envelope.docsAnchor).toBeUndefined();

    const human = formatOperatorErrorEnvelope(envelope);
    expect(human).toContain(envelope.message);
    expect(human).toContain(`code: ${envelope.code}`);
    expect(human).toContain(`Next action: ${envelope.nextAction}`);
    expect(human).not.toMatch(/^Docs:/mu);

    const json = JSON.parse(serializeOperatorErrorEnvelope(envelope)) as {
      code: string;
      message: string;
      nextAction?: string;
    };
    expect(json.code).toBe("invalid-shape");
    expect(json.message).toBe(envelope.message);
    expect(json.nextAction).toBe(envelope.nextAction);
  });

  it("scrubs credential-shaped text from messages", () => {
    const error = new Error("Provider rejected api_key=nvapi-abcdefghijklmnopqrstuvwxyz012345");
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.message).not.toMatch(/nvapi-/u);
    expect(envelope.message).toMatch(/\[REDACTED/u);
  });

  it("assigns nextAction for stamped host and schema-mismatch codes", () => {
    const codes = ["transport-failed", "write-grant-rejected", "schema-mismatch"] as const;
    for (const code of codes) {
      const envelope = toOperatorErrorEnvelope(
        Object.assign(new Error(`${code} rejected.`), { code }),
      );
      expect(envelope.code).toBe(code);
      expect(envelope.nextAction).toEqual(expect.any(String));
      expect(envelope.nextAction!.length).toBeGreaterThan(0);
    }
  });

  it("attaches Docs from the catalog when gitlab-unauthenticated infers a remediation id", () => {
    const error = Object.assign(
      new Error(
        "Local-user GitLab publication preflight failed (gitlab-unauthenticated). Authenticate glab.",
      ),
      { code: "gitlab-unauthenticated" },
    );
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.kind).toBe("docsfab-operator-error");
    expect(envelope.code).toBe("gitlab-unauthenticated");
    expect(envelope.nextAction).toMatch(/glab auth login --hostname/u);
    expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
    expect(formatOperatorErrorEnvelope(envelope)).toMatch(/^Docs:/mu);
  });

  it("labels packet-in-flight nextAction as synthetic because host never throws it", () => {
    const envelope = toOperatorErrorEnvelope(
      Object.assign(new Error("packet-in-flight rejected."), { code: "packet-in-flight" }),
    );
    expect(envelope.code).toBe("packet-in-flight");
    expect(envelope.nextAction).toMatch(/in-flight host packet/u);
    expect(formatOperatorErrorEnvelope(envelope)).toContain("code: packet-in-flight");
  });

  it("replaces this host's roots and keeps other paths and JSON pointers", () => {
    const error = new Error(
      `Rejected path ${HOME}/egress-fixture/run-1.json at $.packet /schema/properties/name, not /usr/local/bin/node`,
    );
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.message).toBe(
      "Rejected path ~/egress-fixture/run-1.json at $.packet /schema/properties/name, not /usr/local/bin/node",
    );
  });

  it("scrubs URL-shaped messages and keeps JSON pointers", () => {
    const error = new Error("Callback https://gitlab.example/foo failed at /properties/name");
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.message).not.toMatch(/https?:\/\//iu);
    expect(envelope.message).not.toContain("gitlab.example");
    expect(envelope.message).toContain("/properties/name");
    expect(envelope.message).toMatch(/\[REDACTED/u);
  });

  it("preserves a recorded executable-route origin in operator output", () => {
    const message =
      'DocsFab recorded the origin "https://api.openai.com" for this composition; callback https://gitlab.example/foo failed.';
    const envelope = toOperatorErrorEnvelope(new Error(message));
    expect(envelope.message).toContain("https://api.openai.com");
    expect(envelope.message).not.toContain("gitlab.example");
    expect(envelope.message).toMatch(/\[REDACTED/u);
    const human = formatOperatorErrorEnvelope(envelope);
    expect(human).toContain("https://api.openai.com");
    expect(human).not.toContain("gitlab.example");
  });

  it("still redacts an executable-route host when the token is not origin-only", () => {
    const envelope = toOperatorErrorEnvelope(
      new Error("Callback https://api.openai.com/v1/secret-path failed"),
    );
    expect(envelope.message).not.toContain("api.openai.com");
    expect(envelope.message).toContain("[REDACTED]");
  });

  it("still scrubs credentials when a host root is also present", () => {
    const error = new Error(
      `Provider rejected api_key=nvapi-abcdefghijklmnopqrstuvwxyz012345 at ${HOME}/egress-fixture/secret`,
    );
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.message).not.toMatch(/nvapi-/u);
    expect(envelope.message).not.toContain(HOME);
    expect(envelope.message).toContain("~/egress-fixture/secret");
    expect(envelope.message).toMatch(/\[REDACTED/u);
  });

  it("keeps a privacy-safe selected-directory suffix through the CLI boundary", () => {
    for (const prefix of ["/home/operator", "/Users/operator", "/root"]) {
      const error = new LocalUserPublicationPreflightError("state-directory-not-run-store", {
        selectedDirectory: `${prefix}/workspace\nnext`,
      });
      const humanLines: string[] = [];
      const jsonLines: string[] = [];
      reportOperatorFailure(error, { write: (line) => humanLines.push(line) });
      reportOperatorFailure(error, { json: true, write: (line) => jsonLines.push(line) });
      const human = humanLines.join("\n");
      const json = jsonLines.join("\n");
      for (const output of [human, json]) {
        expect(output).toContain("Selected directory [REDACTED]/workspace");
        expect(output).not.toContain("/operator/");
        expect(output).toContain("\\x0a");
      }
    }
    const credential = new LocalUserPublicationPreflightError("state-directory-not-run-store", {
      selectedDirectory: "/home/operator/work/api_key=nvapi-abcdefghijklmnopqrstuvwxyz012345",
    });
    expect(toOperatorErrorEnvelope(credential).message).not.toContain("nvapi-");
  });

  it("does not retain raw selected-directory material on the thrown error", () => {
    const error = new LocalUserPublicationPreflightError("state-directory-not-run-store", {
      selectedDirectory:
        "/home/operator/work/api_key=nvapi-abcdefghijklmnopqrstuvwxyz012345\nhttps://example.test/private",
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("/home/operator");
    expect(serialized).not.toContain("nvapi-");
    expect(serialized).not.toContain("https://example.test");
    expect(serialized).toContain("[REDACTED]/work");
    expect(error.details?.selectedDirectory).toContain("[REDACTED]/work");
    expect(error.message).not.toContain("operator");
  });

  it("maps CLI usage failures to a stable code and next action", () => {
    expect(() => parseDoctorArguments(["--judge"])).toThrow(/requires --catalog/u);
    try {
      parseDoctorArguments(["--judge"]);
    } catch (error) {
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.code).toBe("cli-usage");
      expect(envelope.nextAction).toMatch(/docsfab --help/u);
      expect(formatOperatorErrorEnvelope(envelope)).toContain("Next action:");
    }
  });

  it("reports JSON failures with a stable code field", () => {
    const lines: string[] = [];
    const envelope = reportOperatorFailure(new SampleContractError("credential-material"), {
      json: true,
      write: (line) => lines.push(line),
    });
    expect(envelope.code).toBe("credential-material");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: "docsfab-operator-error",
      code: "credential-material",
    });
  });

  it("admits bound proposal-scope failure evidence without trusting lookalike properties", () => {
    const error = new FirstRunProposalScopeError(
      "proposal-scope-conflicting-targets",
      "The explicit target and change-only restriction conflict.",
      "a".repeat(64),
      "b".repeat(40),
    );
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope).toMatchObject({
      code: "proposal-scope-conflicting-targets",
      nextAction: expect.stringContaining("Make the requested targets"),
      details: {
        schemaVersion: 1,
        kind: "docsfab-proposal-scope-admission-failure",
        phase: "proposal-scope-admission",
        retryable: false,
        noWorkPerformed: true,
        instructionSha256: "a".repeat(64),
        repositoryRevision: "b".repeat(40),
      },
    });
    expect(formatOperatorErrorEnvelope(envelope)).toContain(
      "stopped before workflow/model execution or target mutation",
    );
    expect(JSON.parse(serializeOperatorErrorEnvelope(envelope))).toMatchObject({
      details: { retryable: false, noWorkPerformed: true },
    });

    const lookalike = Object.assign(new Error("lookalike"), {
      name: "FirstRunProposalScopeError",
      code: "proposal-scope-conflicting-targets",
      phase: "proposal-scope-admission",
      retryable: false,
      noWorkPerformed: true,
      instructionSha256: "not-a-hash",
      repositoryRevision: "b".repeat(40),
    });
    expect(toOperatorErrorEnvelope(lookalike).details).toBeUndefined();
  });

  it("carries the unresolved obligations on an insufficient-evidence stop", () => {
    const error = new FirstPassSupportValidationError(
      "insufficient-evidence",
      "First-pass support has unresolved mandatory obligations.",
      [
        {
          id: "decomposed-breaking-changes",
          targetPath: "docs/whats-new.md",
          condition: "The page states the Orchard 4.2.0 breaking changes.",
          status: "missing",
        },
        {
          id: "host-page-support",
          targetPath: "docs/whats-new.md",
          condition: "Substantive repository support is required for docs/whats-new.md.",
          status: "missing",
        },
      ],
    );

    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("insufficient-evidence");
    expect(envelope.details).toEqual({
      schemaVersion: 1,
      kind: "docsfab-first-pass-evidence-gap",
      phase: "first-pass-support",
      retryable: false,
      noWorkPerformed: true,
      unresolvedCount: 2,
      unresolved: [
        {
          id: "decomposed-breaking-changes",
          targetPath: "docs/whats-new.md",
          condition: "The page states the Orchard 4.2.0 breaking changes.",
          status: "missing",
        },
        {
          id: "host-page-support",
          targetPath: "docs/whats-new.md",
          condition: "Substantive repository support is required for docs/whats-new.md.",
          status: "missing",
        },
      ],
    });
    expect(JSON.parse(serializeOperatorErrorEnvelope(envelope))).toMatchObject({
      details: { unresolvedCount: 2 },
    });
    expect(formatOperatorErrorEnvelope(envelope)).toContain(
      "host-page-support (missing) docs/whats-new.md",
    );
  });

  it("bounds, scrubs, and refuses malformed insufficient-evidence details", () => {
    const flood = new FirstPassSupportValidationError(
      "insufficient-evidence",
      "First-pass support has unresolved mandatory obligations.",
      Array.from({ length: 40 }, (_unused, index) => ({
        id: `target-${String(index).padStart(2, "0")}`,
        targetPath: "docs/page.md",
        condition: `https://example.invalid/secret ${"c".repeat(400)}`,
        status: index === 0 ? "missing" : "invented-status",
      })),
    );
    const details = toOperatorErrorEnvelope(flood).details as {
      unresolvedCount: number;
      unresolved: { condition: string; status: string }[];
    };
    expect(details.unresolvedCount).toBe(40);
    expect(details.unresolved).toHaveLength(32);
    expect(details.unresolved[0]!.condition.length).toBe(240);
    expect(details.unresolved[0]!.condition).toContain("[REDACTED]");
    expect(details.unresolved[1]!.status).toBe("unknown");
    expect(JSON.stringify(details)).not.toContain("example.invalid");

    const otherCode = new FirstPassSupportValidationError(
      "invalid-support",
      "The first-pass support record is invalid.",
      [{ id: "target-01", targetPath: "docs/a.md", condition: "x", status: "missing" }],
    );
    expect(toOperatorErrorEnvelope(otherCode).details).toBeUndefined();

    const lookalike = Object.assign(new Error("lookalike"), {
      name: "FirstPassSupportValidationError",
      code: "insufficient-evidence",
      details: [{ id: 7, targetPath: "docs/a.md", condition: "x", status: "missing" }],
    });
    expect(toOperatorErrorEnvelope(lookalike).details).toBeUndefined();
  });

  it("projects only digest-bound first-pass support failure evidence", () => {
    const body = {
      schemaVersion: 1 as const,
      kind: "docsfab-first-pass-support-failure" as const,
      phase: "identity",
      rule: "identity-binding",
      location: "$response.identity",
      instructionSha256: "a".repeat(64),
      repositoryRevision: "b".repeat(40),
      modelCalls: { started: 2, completed: 2 },
      corrections: 1,
      lastPromptSha256: "c".repeat(64),
      lastResponseSha256: "d".repeat(64),
      lastIdentitySha256: "e".repeat(64),
    };
    const error = new FirstPassSupportPreflightError({
      ...body,
      evidenceSha256: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
    });

    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope).toMatchObject({
      code: "first-pass-support-invalid",
      details: {
        ...body,
        retryable: false,
      },
    });
    expect(formatOperatorErrorEnvelope(envelope)).toContain(
      "model calls started 2, completed 2, hinted correction rounds 1.",
    );
    expect(formatOperatorErrorEnvelope(envelope)).not.toContain("no work performed");

    const tampered = Object.assign(new Error("private rejected response"), {
      name: "FirstPassSupportPreflightError",
      code: "first-pass-support-invalid",
      retryable: false,
      evidence: { ...error.evidence, rule: "strict-json" },
    });
    const rejected = toOperatorErrorEnvelope(tampered);
    expect(rejected.details).toBeUndefined();
    expect(rejected.message).toBe("private rejected response");
  });
});

describe("envelope-invisible class codes", () => {
  const profileIssue = {
    profile: "MODEL" as const,
    field: "MODEL_ID",
    message: "missing required environment variable",
  };

  it("exposes kebab-case .code accepted by isContractErrorLike", () => {
    const cases: Array<{ error: Error & { readonly code: string }; code: string }> = [
      { error: new ContextResultValidationError("$.packet"), code: "invalid-context-result" },
      { error: new ContextIndexValidationError("$"), code: "invalid-context-index" },
      { error: new DocsFabPublicationMetadataError(), code: "invalid-publication-metadata" },
      { error: new WorkflowTaskValidationError("shape"), code: "shape" },
      { error: new SecurePathError(), code: "insecure-path" },
      { error: new ModelProfileMigrationError([profileIssue]), code: "migration-required" },
      {
        error: new InferenceStepError("Model step failed [throttled].", "throttled", true),
        code: "throttled",
      },
    ];

    for (const { error, code } of cases) {
      expect(error.code).toBe(code);
      expect(isContractErrorLike(error)).toBe(true);
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.code).toBe(code);
      expect(envelope.code).not.toBe("operator-error");
    }
  });

  it("keeps WorkflowTaskValidationError.reason and exposes it as .code", () => {
    try {
      normalizeWorkflowTaskInput({
        runId: "!!!",
        workflow: "review-documentation",
        task: null,
        repository: { identitySha256: "a".repeat(64), revision: "b".repeat(40) },
        allowWrite: false,
      });
      throw new Error("expected WorkflowTaskValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowTaskValidationError);
      const validation = error as WorkflowTaskValidationError;
      expect(validation.reason).toBe("run-id");
      expect(validation.code).toBe("run-id");
      expect(isContractErrorLike(validation)).toBe(true);
      expect(toOperatorErrorEnvelope(validation).code).toBe("run-id");
    }
  });

  it("maps InferenceStepError.category to .code without flattening the taxonomy", () => {
    const categories = Object.keys(INFERENCE_STEP_ERROR_CODES) as InferenceFailureCategory[];
    const codes = new Set<string>();
    for (const category of categories) {
      const error = new InferenceStepError(`failed as ${category}`, category, false);
      expect(error.category).toBe(category);
      expect(error.code).toBe(INFERENCE_STEP_ERROR_CODES[category]);
      expect(error.code).toBe(category);
      expect(isContractErrorLike(error)).toBe(true);
      expect(toOperatorErrorEnvelope(error).code).toBe(category);
      codes.add(error.code);
    }
    expect(codes.size).toBe(categories.length);
  });

  it("asserts .code on thrown context validation instances", () => {
    try {
      compileContext({} as never);
      throw new Error("expected ContextIndexValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextIndexValidationError);
      const validation = error as ContextIndexValidationError;
      expect(validation.code).toBe("invalid-context-index");
      expect(isContractErrorLike(validation)).toBe(true);
      expect(toOperatorErrorEnvelope(validation).code).toBe("invalid-context-index");
    }

    try {
      validateContextResult({});
      throw new Error("expected ContextResultValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextResultValidationError);
      const validation = error as ContextResultValidationError;
      expect(validation.code).toBe("invalid-context-result");
      expect(isContractErrorLike(validation)).toBe(true);
      expect(toOperatorErrorEnvelope(validation).code).toBe("invalid-context-result");
    }
  });
});

describe("do/run missing-profile NEXT", () => {
  it("keeps shared envelopes scrubbed while retaining generated paths only for genuine missing-profile errors", () => {
    const root = resolve(tmpdir(), "docsfab missing profile root");
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    try {
      let failure: unknown;
      try {
        parseModelEndpoint({ DOCSFAB_CONFIG_ROOT: root });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ModelProfileMigrationError);
      const envelope = toOperatorErrorEnvelope(failure);
      expect(envelope.message).toContain("host.yaml and secrets.env");
      expect(envelope.message).not.toContain(root);
      expect(formatOperatorErrorEnvelope(envelope)).not.toContain(root);
      expect(serializeOperatorErrorEnvelope(envelope)).not.toContain(root);
      expect(localMissingModelProfileLocator(failure)?.join("\n")).toContain(root);

      (failure as Error).message = `unrelated path ${root}`;
      const mutated = toOperatorErrorEnvelope(failure);
      expect(mutated.message).not.toContain(root);
      expect(serializeOperatorErrorEnvelope(mutated)).not.toContain(root);
      expect(localMissingModelProfileLocator(failure)?.join("\n")).toContain(root);

      const lookalike = Object.assign(new Error(`Configuration root: ${root}`), {
        name: "ModelProfileMigrationError",
        code: "migration-required",
        reason: "no-profile",
      });
      const spoof = toOperatorErrorEnvelope(lookalike);
      expect(spoof.message).not.toContain(root);
      expect(formatOperatorErrorEnvelope(spoof)).not.toContain(root);
      expect(localMissingModelProfileLocator(lookalike)).toBeUndefined();

      const genuine = failure as ModelProfileMigrationError;
      const injected = new ModelProfileMigrationError(
        genuine.issues.map((issue, index) => (index === 0 ? { ...issue, field: root } : issue)),
        { origin: "fresh" },
        { DOCSFAB_CONFIG_ROOT: root },
      );
      expect(injected.reason).toBe("invalid-profile");
      expect(toOperatorErrorEnvelope(injected).message).not.toContain(root);
      expect(localMissingModelProfileLocator(injected)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("points a fully missing MODEL_* block at profile seed, not profile inspect", () => {
    let failure: unknown;
    try {
      parseModelEndpoint({});
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    expect((failure as ModelProfileMigrationError).reason).toBe("no-profile");

    const envelope = toOperatorErrorEnvelope(failure);
    expect(envelope.code).toBe("migration-required");
    expect(envelope.nextAction).toBe(
      "Run `docsfab profile seed --preset <id>` to create an unsigned MODEL_* profile (without `--preset` it names the choices), then set MODEL_API_KEY before retrying.",
    );
    expect(envelope.nextAction).toContain("docsfab profile seed");
    expect(envelope.nextAction).not.toMatch(/profile inspect|profile approve/u);
    expect(envelope.docsAnchor).toBe(
      "docs/reference/status-and-configuration/model-profile-fields.md",
    );
    expect(envelope.docsAnchor).not.toBe("docs/about/architecture-overview.md");

    const human = formatOperatorErrorEnvelope(envelope);
    expect(human).toContain("Next action: Run `docsfab profile seed --preset <id>`");
    expect(human).not.toMatch(/profile inspect|profile approve/u);
  });

  it("routes a partially configured (invalid, not missing) profile to field correction", () => {
    const oldEnvironment = {
      MODEL_PROVIDER: "test-provider",
      MODEL_BASE_URL: "https://inference.example.test/v1",
      MODEL_ID: "example/model",
      MODEL_API_FORMAT: "chat_completions",
      MODEL_API_KEY: "test-secret",
    };
    let failure: unknown;
    try {
      parseModelEndpoint(oldEnvironment);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    expect((failure as ModelProfileMigrationError).reason).toBe("invalid-profile");

    const envelope = toOperatorErrorEnvelope(failure);
    expect(envelope.code).toBe("migration-required");
    expect(envelope.message).toContain("MODEL_CONTEXT_WINDOW");
    expect(envelope.nextAction).toBe(
      "Correct the listed MODEL_* or JUDGE_* fields in the environment or DocsFab configuration root, then run `docsfab doctor` to confirm the profile loads.",
    );
    expect(envelope.nextAction).toContain("docsfab doctor");
    expect(envelope.nextAction).not.toMatch(/profile inspect|profile approve/u);
    expect(envelope.nextAction).not.toContain("docsfab profile seed");
  });
});

describe("doctor and init boundary mapping", () => {
  it("maps doctor failures through the envelope with an actionable next step", () => {
    const error = new ExternalInputContractError("migration-required");
    const envelope = mapDoctorFailure(error);
    expect(envelope.code).toBe("migration-required");
    expect(formatDoctorFailure(error)).toContain("Next action:");
    expect(JSON.parse(serializeDoctorFailure(error))).toMatchObject({
      code: "migration-required",
      kind: "docsfab-operator-error",
    });
  });

  it("maps init argument failures with init next-action wording", () => {
    expect(() => parseDocsFabInitArguments(["--json"], "/tmp")).toThrow(
      /requires --non-interactive/u,
    );
    try {
      parseDocsFabInitArguments(["--json"], "/tmp");
    } catch (error) {
      const envelope = mapInitFailure(error);
      expect(envelope.code).toBe("cli-usage");
      expect(formatInitFailure(error)).toMatch(/--json` requires `--non-interactive/u);
      expect(JSON.parse(serializeInitFailure(error))).toMatchObject({
        code: "cli-usage",
        kind: "docsfab-operator-error",
      });
    }
  });
});

describe("init configuration-root refusal (#1438)", () => {
  it("keeps a usable instruction when the resolved path names a host root", () => {
    // A private TMPDIR: without one, Linux uses the generic `/tmp`, which is never a root.
    const privateTmp = join(tmpdir(), `docsfab-envelope-tmp-${process.pid}`);
    vi.stubEnv("TMPDIR", privateTmp);
    try {
      expectInstructionsWithoutHostRoots([
        join(HOME, ".config", "docsfab-egress-fixture"),
        join(privateTmp, "docsfab-egress-fixture"),
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  function expectInstructionsWithoutHostRoots(canonicalPaths: readonly string[]): void {
    for (const canonicalPath of canonicalPaths) {
      const error = new ConfigurationRootNotCanonicalError(canonicalPath, canonicalPath);
      const text = formatInitFailure(error);
      // Operator output replaces the host root; the instruction does not depend on it.
      expect(text).not.toContain(canonicalPath);
      expect(text).toContain("code: configuration-root-not-canonical");
      expect(text).toContain("failure class: operator-input (layer cli)");
      const nextAction = text.split("\n").find((line) => line.startsWith("Next action: "));
      expect(nextAction).toBe(`Next action: ${INIT_CONFIGURATION_ROOT_NEXT_ACTION}`);
      expect(nextAction).toContain('cd "$r" && pwd -P');
      expect(nextAction).toContain('mkdir -p -m 700 "$r"');
      expect(nextAction).not.toContain("[REDACTED]");
      expect(text).toContain(`Docs: ${INIT_CONFIGURATION_ROOT_DOCS_ANCHOR}`);
      expect(JSON.parse(serializeInitFailure(error))).toMatchObject({
        code: "configuration-root-not-canonical",
        nextAction: INIT_CONFIGURATION_ROOT_NEXT_ACTION,
        docsAnchor: INIT_CONFIGURATION_ROOT_DOCS_ANCHOR,
      });
    }
  }

  it("shows a home-relative resolved path, which the sanitizer leaves visible", () => {
    const error = new ConfigurationRootNotCanonicalError("/Users/u/cfg", "~/cfg");
    expect(formatInitFailure(error)).toContain('resolves to "~/cfg"');
  });

  it("leaves other configuration-root failures on their existing mapping", () => {
    // The same words without the typed refusal, and a different coded init
    // error, must not borrow the canonical-root advice.
    for (const error of [
      new Error("DocsFab configuration root must use one canonical path."),
      new Error("DocsFab configuration root appeared after preview."),
      Object.assign(new Error("DocsFab configuration root has no safe existing ancestor."), {
        code: "configuration-root-unsafe",
      }),
    ]) {
      const envelope = mapInitFailure(error);
      expect(envelope.code).not.toBe("configuration-root-not-canonical");
      expect(envelope.nextAction).not.toBe(INIT_CONFIGURATION_ROOT_NEXT_ACTION);
      expect(envelope.docsAnchor).not.toBe(INIT_CONFIGURATION_ROOT_DOCS_ANCHOR);
    }
  });
});

describe("docs anchors resolve to repository files", () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repositoryRoot = resolve(projectRoot, "../..");
  const docsRoot = resolve(repositoryRoot, "docs");

  function missingAnchors(map: Readonly<Partial<Record<string, string>>>): string[] {
    return Object.entries(map).flatMap(([key, docsPath]) => {
      if (docsPath === undefined) return [];
      const absolute = resolve(repositoryRoot, docsPath);
      // Containment is checked on the resolved path with the separator
      // appended: `docs/../AGENTS.md` passes a lexical prefix check, and
      // `docs-internal/` would pass one without the separator. existsSync is
      // true for directories, so isFile() is required too. statSync follows
      // symlinks, so a symlink to a regular file counts; one to a directory,
      // or a broken one, does not.
      const contained = absolute.startsWith(`${docsRoot}${sep}`);
      if (contained && existsSync(absolute) && statSync(absolute).isFile()) {
        return [];
      }
      return [`${key} -> ${docsPath}`];
    });
  }

  it("resolves every DEFAULT_DOCS_ANCHORS value to an existing file under docs/", () => {
    const missing = missingAnchors(DEFAULT_DOCS_ANCHORS);
    expect(missing, `missing DEFAULT_DOCS_ANCHORS paths: ${missing.join("; ")}`).toEqual([]);
  });

  it("resolves every REMEDIATION_DOCS_ANCHORS value to an existing file under docs/", () => {
    const missing = missingAnchors(REMEDIATION_DOCS_ANCHORS);
    expect(missing, `missing REMEDIATION_DOCS_ANCHORS paths: ${missing.join("; ")}`).toEqual([]);
  });

  it("resolves the init configuration-root anchor to an existing file under docs/", () => {
    const missing = missingAnchors({
      "configuration-root-not-canonical": INIT_CONFIGURATION_ROOT_DOCS_ANCHOR,
      "configuration-root-not-private": INIT_CONFIGURATION_ROOT_DOCS_ANCHOR,
    });
    expect(missing).toEqual([]);
  });

  it("projects an explicit configuration-root permission refusal consistently in init", () => {
    const root = "/tmp/docsfab config root";
    const error = new ConfigurationRootPermissionError(root, 0o775, {
      DOCSFAB_CONFIG_ROOT: root,
    });
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope).toMatchObject({
      code: "configuration-root-not-private",
      message: expect.stringContaining("mode 0775"),
      nextAction: 'Run `chmod 700 "$DOCSFAB_CONFIG_ROOT"`, then run the command again.',
      docsAnchor: "docs/manage/check-readiness.md",
      failure: { class: "operator-input", layer: "cli" },
    });

    expect(mapInitFailure(error)).toMatchObject({
      code: "configuration-root-not-private",
      nextAction: envelope.nextAction,
      docsAnchor: INIT_CONFIGURATION_ROOT_DOCS_ANCHOR,
    });
  });

  it("rejects a directory anchor even though it exists on disk", () => {
    const missing = missingAnchors({ "directory-anchor": "docs/reference" });
    expect(missing).toEqual(["directory-anchor -> docs/reference"]);
  });

  it("rejects a traversal that escapes docs/ while satisfying a lexical prefix", () => {
    // docs/../AGENTS.md starts with "docs/", exists, and is a regular file, so
    // only containment on the resolved path refuses it.
    const missing = missingAnchors({ "traversal-anchor": "docs/../AGENTS.md" });
    expect(missing).toEqual(["traversal-anchor -> docs/../AGENTS.md"]);
  });

  it("rejects a sibling directory whose name merely begins with docs", () => {
    const missing = missingAnchors({ "sibling-anchor": "docs-internal/page.md" });
    expect(missing).toEqual(["sibling-anchor -> docs-internal/page.md"]);
  });
});
