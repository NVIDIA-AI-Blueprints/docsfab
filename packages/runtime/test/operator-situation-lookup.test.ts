// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createContractKit } from "../src/contract-kit/index.js";
import { ExternalInputContractError } from "../src/inputs/contracts.js";
import { ScorecardRecordError } from "../src/execution/inference-evidence.js";
import { ModelProfileMigrationError, parseModelEndpoint } from "../src/model/configuration.js";
import {
  DEFAULT_NEXT_ACTIONS,
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { remediationText } from "../src/operator/remediation.js";
import {
  SITUATION_LOOKUP_ROWS,
  WRITE_GRANT_INERT_NEXT_ACTION,
  situationRowFor,
} from "../src/operator/situation-lookup.js";
import {
  HostProgressMapError,
  mapProgressEventToHostAppend,
} from "../src/records/host-progress.js";
import {
  assertModelRequestCredentialFree,
  CredentialBoundaryError,
} from "../src/security/credential-isolation.js";
import {
  normalizeWorkflowTaskInput,
  WorkflowTaskValidationError,
} from "../src/workflow-contracts/task.js";
import { configureCredential } from "./helpers/configured-credential.js";

const GITLAB_TOKEN = `glpat-${"a".repeat(24)}`;

function duckHost(name: string, code: string, message = `${name} rejected: ${code}.`): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { code });
  return error;
}

describe("name-keyed situation lookup", () => {
  it("splits write-grant-rejected nextAction by error.name, not by message regex", () => {
    const message = "write-grant-rejected rejected.";
    const inert = duckHost("HostProgressMapError", "write-grant-rejected", message);
    const mistakenCopy = duckHost("Error", "write-grant-rejected", message);
    const inertEnvelope = toOperatorErrorEnvelope(inert);
    const copyEnvelope = toOperatorErrorEnvelope(mistakenCopy);
    expect(inertEnvelope.code).toBe("write-grant-rejected");
    expect(copyEnvelope.code).toBe("write-grant-rejected");
    expect(inertEnvelope.nextAction).toBe(WRITE_GRANT_INERT_NEXT_ACTION);
    expect(copyEnvelope.nextAction).toBe(DEFAULT_NEXT_ACTIONS["write-grant-rejected"]);
    expect(inertEnvelope.nextAction).not.toBe(copyEnvelope.nextAction);
    expect(situationRowFor(inert, "write-grant-rejected")?.mapsFrom).not.toMatch(
      /^\/.+\/[gimsuy]*$/u,
    );
  });

  it("maps HostProgressMapError write-grant-rejected from the real throw site", () => {
    expect(() =>
      mapProgressEventToHostAppend("pkt-1", {
        sequence: 1,
        type: "run-status",
        runId: "--allow-write",
        status: "running",
      }),
    ).toThrow(HostProgressMapError);
    try {
      mapProgressEventToHostAppend("pkt-1", {
        sequence: 1,
        type: "run-status",
        runId: "--allow-write",
        status: "running",
      });
      throw new Error("expected HostProgressMapError");
    } catch (error) {
      expect(error).toBeInstanceOf(HostProgressMapError);
      expect((error as HostProgressMapError).name).toBe("HostProgressMapError");
      expect((error as HostProgressMapError).code).toBe("write-grant-rejected");
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.code).toBe("write-grant-rejected");
      expect(envelope.nextAction).toBe(WRITE_GRANT_INERT_NEXT_ACTION);
      expect(situationRowFor(error, "write-grant-rejected")?.mapsFrom).toContain(
        "records/host-progress.ts",
      );
    }
  });

  it("documents host classes that actually throw write-grant-rejected", () => {
    const names = SITUATION_LOOKUP_ROWS.filter((row) => row.code === "write-grant-rejected").map(
      (row) => row.errorName,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "HostProgressMapError",
        "HostJobError",
        "SlackSlashError",
        "GitLabMrMentionError",
        "GitLabMrReplyError",
        "GitLabRepositoryEventError",
        "GitLabMergeRequestEventError",
        "LiveAgentSurfaceError",
        "SlackSocketAdapterError",
        "ForgeChangeSourceError",
      ]),
    );
    for (const name of names) {
      if (name === "HostProgressMapError") continue;
      const envelope = toOperatorErrorEnvelope(duckHost(name, "write-grant-rejected"));
      expect(envelope.code).toBe("write-grant-rejected");
      expect(envelope.nextAction).toBe(WRITE_GRANT_INERT_NEXT_ACTION);
    }
  });

  it("adds rows for HostJobError collision codes that host actually throws", () => {
    const target = toOperatorErrorEnvelope(duckHost("HostJobError", "write-target-conflict"));
    const packet = toOperatorErrorEnvelope(duckHost("HostJobError", "packet-conflict"));
    expect(target.code).toBe("write-target-conflict");
    expect(packet.code).toBe("packet-conflict");
    expect(target.nextAction).toMatch(/same repository and branch/u);
    expect(packet.nextAction).toMatch(/packet fingerprint/u);
    expect(
      situationRowFor(duckHost("HostJobError", "write-target-conflict"), "write-target-conflict")
        ?.mapsFrom,
    ).toContain("jobs/spine.ts");
    expect(
      situationRowFor(duckHost("HostJobError", "packet-conflict"), "packet-conflict")?.mapsFrom,
    ).toContain("jobs/spine.ts");
  });

  it("keeps catalog retry-gitlab-api nextAction over publication .action", () => {
    const error = duckHost(
      "LocalUserPublicationPreflightError",
      "gitlab-unreachable",
      "Local-user GitLab publication preflight failed (gitlab-unreachable). GitLab API for the selected remote host is unreachable.",
    );
    Object.assign(error, {
      action:
        "GitLab API for the selected remote host is unreachable. Confirm network or VPN, then retry `glab api --hostname <host from git remote> user`.",
    });
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("gitlab-unreachable");
    expect(envelope.nextAction).toBe(remediationText("retry-gitlab-api"));
    expect(envelope.nextAction).toContain("Do not log in unless");
    expect(envelope.nextAction).not.toBe((error as { action?: string }).action);
  });

  it("attaches catalog Docs for gitlab-unauthenticated via inferred remediation id", () => {
    const error = duckHost(
      "LocalUserPublicationPreflightError",
      "gitlab-unauthenticated",
      "Local-user GitLab publication preflight failed (gitlab-unauthenticated). Authenticate glab.",
    );
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("gitlab-unauthenticated");
    expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
    expect(formatOperatorErrorEnvelope(envelope)).toMatch(/^Docs:/mu);
  });

  it("does not invent a packet-in-flight throw; duck-types keep the code-only default", () => {
    expect(SITUATION_LOOKUP_ROWS.some((row) => row.code === "packet-in-flight")).toBe(false);
    const envelope = toOperatorErrorEnvelope(
      Object.assign(new Error("packet-in-flight rejected."), { code: "packet-in-flight" }),
    );
    expect(envelope.code).toBe("packet-in-flight");
    expect(envelope.nextAction).toBe(DEFAULT_NEXT_ACTIONS["packet-in-flight"]);
  });

  it("does not add a session-conflict throw row; host returns that code without throwing", () => {
    expect(SITUATION_LOOKUP_ROWS.some((row) => row.code === "session-conflict")).toBe(false);
  });

  it("keeps WorkflowTaskValidationError shape bytes and maps them without renaming", () => {
    const error = new WorkflowTaskValidationError("shape");
    const envelope = toOperatorErrorEnvelope(error);
    expect(error.code).toBe("shape");
    expect(envelope.code).toBe("shape");
    expect(envelope.code).not.toBe("invalid-shape");
    expect(envelope.nextAction).toBe(DEFAULT_NEXT_ACTIONS["invalid-shape"]);
    expect(situationRowFor(error, "shape")?.mapsFrom).toContain("workflow-contracts/task.ts");
  });

  it("passes kit fail(code) through WorkflowTaskValidationError to envelope.code", () => {
    const kit = createContractKit({
      fail: (code: "shape" | "migration-required") => {
        throw new WorkflowTaskValidationError(code);
      },
      codes: {
        invalidShape: "shape",
        invalidValue: "shape",
        digestMismatch: "shape",
        credentialMaterial: "shape",
        schemaMismatch: "migration-required",
      },
    });
    try {
      kit.decodeSealed(
        { schemaVersion: 2, kind: "docsfab-task-kit", digest: "a".repeat(64) },
        "docsfab-task-kit",
        "digest",
        [],
        () => ({}),
      );
      throw new Error("expected kit schemaMismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowTaskValidationError);
      expect((error as WorkflowTaskValidationError).code).toBe("migration-required");
      expect(toOperatorErrorEnvelope(error).code).toBe("migration-required");
    }

    try {
      normalizeWorkflowTaskInput({
        workflow: "review-documentation",
        task: Object.create(null),
        repository: { identitySha256: "a".repeat(64), revision: "b".repeat(40) },
        allowWrite: false,
      });
      throw new Error("expected WorkflowTaskValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowTaskValidationError);
      expect((error as WorkflowTaskValidationError).code).toBe("shape");
      expect(toOperatorErrorEnvelope(error).code).toBe("shape");
    }
  });

  it("passes kit fail(code) through ScorecardRecordError to envelope.code", () => {
    const kit = createContractKit({
      fail: (code: "invalid-scorecard-run-record" | "migration-required") => {
        throw new ScorecardRecordError(code);
      },
      codes: {
        invalidShape: "invalid-scorecard-run-record",
        invalidValue: "invalid-scorecard-run-record",
        digestMismatch: "invalid-scorecard-run-record",
        credentialMaterial: "invalid-scorecard-run-record",
        schemaMismatch: "migration-required",
      },
    });
    try {
      kit.decodeSealed(
        { schemaVersion: 2, kind: "docsfab-scorecard-kit", digest: "a".repeat(64) },
        "docsfab-scorecard-kit",
        "digest",
        [],
        () => ({}),
      );
      throw new Error("expected kit schemaMismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(ScorecardRecordError);
      expect((error as ScorecardRecordError).code).toBe("migration-required");
      expect(toOperatorErrorEnvelope(error).code).toBe("migration-required");
    }
  });

  it("maps ModelProfileMigrationError migration-required from parseModelEndpoint", () => {
    let failure: unknown;
    try {
      parseModelEndpoint({});
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const envelope = toOperatorErrorEnvelope(failure);
    expect(envelope.code).toBe("migration-required");
    expect(envelope.nextAction).toContain("docsfab profile seed");
    expect(situationRowFor(failure, "migration-required")?.mapsFrom).toContain(
      "parseModelEndpoint",
    );
  });

  it("maps ExternalInputContractError migration-required without sharing the profile-seed action", () => {
    const error = new ExternalInputContractError("migration-required");
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("migration-required");
    expect(envelope.nextAction).toBe(DEFAULT_NEXT_ACTIONS["migration-required"]);
    expect(envelope.nextAction).not.toContain("profile seed");
    expect(situationRowFor(error, "migration-required")?.mapsFrom).toContain("inputs/contracts.ts");
  });

  it("exposes CredentialBoundaryError.nextAction as a string field on the envelope", () => {
    configureCredential(GITLAB_TOKEN);
    try {
      assertModelRequestCredentialFree({
        messages: [{ role: "user", content: `token ${GITLAB_TOKEN}` }],
      });
      throw new Error("expected CredentialBoundaryError");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialBoundaryError);
      const boundary = error as CredentialBoundaryError;
      expect(typeof boundary.nextAction).toBe("string");
      expect(typeof (boundary as { nextAction?: unknown }).nextAction).not.toBe("function");
      const envelope = toOperatorErrorEnvelope(boundary);
      expect(envelope.code).toBe("credential-isolation-boundary");
      expect(envelope.nextAction).toBe(boundary.nextAction);
      expect(envelope.nextAction).toContain("transport authentication");
      expect(envelope.nextAction).not.toContain(GITLAB_TOKEN);
    }
  });

  it("keeps deployment-binding-mismatch throw-site nextAction on ModelCompositionError", () => {
    const error = duckHost("ModelCompositionError", "deployment-binding-mismatch");
    Object.assign(error, {
      nextAction: "Set MODEL_BASE_URL to the composition's exact absolute HTTPS URL, then retry.",
    });
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("deployment-binding-mismatch");
    expect(envelope.nextAction).toBe(
      "Set MODEL_BASE_URL to the composition's exact absolute HTTPS URL, then retry.",
    );
    expect(situationRowFor(error, "deployment-binding-mismatch")?.mapsFrom).toContain(
      "assertInstalledDeploymentBaseUrl",
    );
  });

  it("maps transport-failed host throw names without message regex", () => {
    const names = SITUATION_LOOKUP_ROWS.filter((row) => row.code === "transport-failed").map(
      (row) => row.errorName,
    );
    expect(names.length).toBeGreaterThan(1);
    const message = "transport-failed rejected.";
    for (const name of names) {
      const envelope = toOperatorErrorEnvelope(duckHost(name, "transport-failed", message));
      expect(envelope.code).toBe("transport-failed");
      expect(envelope.nextAction).toBe(DEFAULT_NEXT_ACTIONS["transport-failed"]);
      expect(
        situationRowFor(duckHost(name, "transport-failed"), "transport-failed")?.mapsFrom,
      ).not.toMatch(/^\/.+\/[gimsuy]*$/u);
    }
  });
});
