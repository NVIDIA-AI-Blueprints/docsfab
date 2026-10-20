// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  FirstPassSupportPreflightError,
  wrapKnowledgeAdapterFailure,
  KnowledgeAdapterOperatorError,
} from "../src/cli/first-pass.js";
import { KnowledgeResumeError } from "../src/cli/knowledge-resume.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const knowledgeRoot = resolve(runtimeRoot, "..", "knowledge");

const services: Array<{ close: () => Promise<void> }> = [];

afterAll(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

function evidenceSourceError(code: string): Error {
  return Object.assign(new Error(`Source evidence rejected: ${code}.`), {
    name: "EvidenceSourceError",
    code,
  });
}

describe("knowledge adapter wrap", () => {
  it("wraps a knowledge reducer Error once as docsfab-operator-error", () => {
    const reducer = new Error("Claim must reference at least one evidence id");
    const wrapped = wrapKnowledgeAdapterFailure(reducer);
    expect(wrapped).toBeInstanceOf(KnowledgeAdapterOperatorError);
    const envelope = toOperatorErrorEnvelope(wrapped);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-operator-error",
      code: "operator-error",
      message: reducer.message,
    });
    expect(wrapKnowledgeAdapterFailure(wrapped)).toBe(wrapped);
    const again = toOperatorErrorEnvelope(envelope);
    expect(again.kind).toBe("docsfab-operator-error");
    expect(again.code).toBe(envelope.code);
    expect(again.message).toBe(envelope.message);
  });

  it("identity-passes EvidenceSourceError kebab codes instead of wrapping twice", () => {
    const error = evidenceSourceError("invalid-shape");
    const wrapped = wrapKnowledgeAdapterFailure(error);
    const envelope = toOperatorErrorEnvelope(wrapped);
    expect(envelope.kind).toBe("docsfab-operator-error");
    expect(envelope.code).toBe("invalid-shape");
    expect(toOperatorErrorEnvelope(wrapped).code).toBe("invalid-shape");
  });

  it("keeps quality finding ids out of envelope.code", () => {
    const tech = Object.assign(new Error("Technical accuracy failed."), { code: "TECH-001" });
    expect(toOperatorErrorEnvelope(tech).code).not.toBe("TECH-001");
    expect(toOperatorErrorEnvelope(wrapKnowledgeAdapterFailure(tech)).code).not.toBe("TECH-001");

    const html = Object.assign(new Error("HTML doctype is missing."), { code: "html-doctype" });
    expect(toOperatorErrorEnvelope(html).code).not.toBe("html-doctype");
    expect(toOperatorErrorEnvelope(wrapKnowledgeAdapterFailure(html)).code).toBe("operator-error");
  });

  it("passes through first-pass and resume errors without a second wrap", () => {
    const resume = new KnowledgeResumeError(
      "needs-authorization",
      "First-pass support needs an authorization decision.",
    );
    expect(wrapKnowledgeAdapterFailure(resume)).toBe(resume);

    const preflight = new FirstPassSupportPreflightError({
      schemaVersion: 1,
      kind: "docsfab-first-pass-support-failure",
      phase: "assessment",
      rule: "assessment-invalid",
      location: "$response",
      instructionSha256: "a".repeat(64),
      repositoryRevision: "b".repeat(40),
      modelCalls: { started: null, completed: null },
      corrections: null,
      lastPromptSha256: null,
      lastResponseSha256: null,
      lastIdentitySha256: null,
      evidenceSha256: "c".repeat(64),
    });
    expect(wrapKnowledgeAdapterFailure(preflight)).toBe(preflight);
  });
});

describe("knowledge evidence HTTP status", () => {
  it("does not project kebab EvidenceSourceError.code as HTTP 500", async () => {
    const [{ createKnowledgeServer }, { EvidenceSourceError }] = await Promise.all([
      import(pathToFileURL(resolve(knowledgeRoot, "src", "server.mjs")).href) as Promise<{
        createKnowledgeServer: (input: { backend: object; port?: number }) => {
          listen: () => Promise<{ host: string; port: number }>;
          close: () => Promise<void>;
        };
      }>,
      import(pathToFileURL(resolve(knowledgeRoot, "src", "evidence-source.mjs")).href) as Promise<{
        EvidenceSourceError: new (code: string) => Error & { code: string };
      }>,
    ]);
    const backend = {
      health: () => ({ ok: true }),
      getState: () => ({ version: 0, tasks: {}, projects: {} }),
      getEvents: () => [],
      dispatch: async () => {
        throw new EvidenceSourceError("invalid-shape");
      },
    };
    const service = createKnowledgeServer({ backend, port: 0 });
    services.push(service);
    const address = await service.listen();
    const response = await fetch(`http://${address.host}:${address.port}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "source.register",
        expectedVersion: 0,
        actor: "adapter-test",
        input: { projectId: "PRJ-001" },
      }),
    });
    expect(response.status).toBe(400);
    expect(response.status).not.toBe(500);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/invalid-shape/u);
  });
});
