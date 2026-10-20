// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/router.js";
import { usage } from "../src/cli/usage.js";
import {
  listInstalledModelCompositions,
  loadInstalledModelCompositionAuthority,
  ModelCompositionError,
  resolveInstalledComposition,
} from "../src/model-composition/index.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import {
  CODEX_0_155_1_EXECUTABLE_POLICY,
  CODEX_0_155_1_HARNESS_POLICY,
  CODEX_PREFLIGHT_PINS,
} from "../src/native-compositions/cli.js";
import {
  CLAUDE_PREFLIGHT_REPORTED_VERSION,
  CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION,
  CODEX_PREFLIGHT_REPORTED_VERSION,
  NATIVE_PREFLIGHT_INPUT_KIND,
  buildNativePreflightEnvironment,
  createCodexNativePreflightAdapter,
  handleCompositionCommand,
  parseCompositionCliArguments,
  parseNativePreflightObservationV1,
  type NativePreflightHost,
  type NativePreflightProcessObservation,
  type NativePreflightProcessRequest,
} from "../src/native-compositions/index.js";
import { validateLocalRequest } from "../src/native-compositions/local-host.js";

function compositionRow(text: string, compositionId: string): string {
  const normalized = text.replace(/\n[ \t]*/gu, " ");
  const marker = `${compositionId}: `;
  const start = normalized.indexOf(marker);
  if (start < 0) return "";
  const rest = normalized.slice(start + marker.length);
  const next = rest.search(/\s[a-z0-9][a-z0-9._-]*: status=/iu);
  return rest.slice(0, next < 0 ? rest.length : next);
}

const RETIRED_CODEX_PREFLIGHT = "openai-gpt-5.6-sol-codex-preflight";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("docsfab composition CLI", () => {
  it("lists the immutable installed compositions with composition ceilings visible", async () => {
    const lines: string[] = [];
    await handleCompositionCommand(["list", "--json"], { log: (line) => lines.push(line) });

    const result = JSON.parse(lines.join("\n")) as {
      technicalApproval: string;
      releaseEligible: boolean;
      compositions: Array<{
        compositionId: string;
        executionClass: string;
        status: string;
        retirement?: {
          reason: string;
          effectiveAt: string;
          successorCompositionId?: string;
        };
      }>;
    };
    expect(result.technicalApproval).toBe("not-established");
    expect(result.releaseEligible).toBe(false);
    expect(result.compositions.map((entry) => entry.compositionId)).toEqual([
      "anthropic-claude-opus-4.7-claude-code-preflight",
      "anthropic-claude-opus-4.7-pi",
      "nvidia-inference-claude-opus-5-pi",
      "nvidia-inference-claude-sonnet-5-pi",
      "nvidia-inference-deepseek-v4-pro-pi",
      "nvidia-inference-gpt-6-sol-pi",
      "nvidia-inference-nemotron-3-super-v3-pi",
      "nvidia-inference-nemotron-3-ultra-pi",
      "nvidia-inference-qwen3-5-397b-a17b-pi",
      "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
      "nvidia-nemotron-3-super-120b-a12b-pi",
      "nvidia-nemotron-3-ultra-550b-a55b-pi",
      "nvidia-nemotron-3.5-lightning-30b-a3b-pi",
      "openai-gpt-5.6-sol-codex-preflight",
      "openai-gpt-5.6-sol-pi",
      "openai-gpt-6-sol-codex-preflight",
    ]);
    // Three preflight-only records are listed; the GPT-5.6 Codex one is retired.
    expect(
      result.compositions
        .filter((entry) => entry.executionClass === "preflight-only")
        .map((entry) => [entry.compositionId, entry.status]),
    ).toEqual([
      ["anthropic-claude-opus-4.7-claude-code-preflight", "active"],
      ["openai-gpt-5.6-sol-codex-preflight", "retired"],
      ["openai-gpt-6-sol-codex-preflight", "active"],
    ]);
    // The retired record stays listed for provenance, with its reason and
    // instant, so an operator does not select it.
    const retired = result.compositions.filter((entry) => entry.status === "retired");
    expect(retired.map((entry) => entry.compositionId)).toEqual([
      "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
      "openai-gpt-5.6-sol-codex-preflight",
      "openai-gpt-5.6-sol-pi",
    ]);
    expect(retired[0]?.retirement).toMatchObject({
      reason: "provider-end-of-life",
      effectiveAt: "2026-08-26T09:00:00.000Z",
    });
    expect(retired[1]?.retirement).toMatchObject({
      reason: "provider-end-of-life",
      effectiveAt: "2026-09-30T00:00:00.000Z",
      successorCompositionId: "openai-gpt-6-sol-codex-preflight",
    });
    expect(retired[2]?.retirement).toMatchObject({
      reason: "superseded-by-operator-decision",
      effectiveAt: "2026-09-28T00:00:00.000Z",
      successorCompositionId: "nvidia-inference-gpt-6-sol-pi",
    });
    expect(
      result.compositions
        .filter((entry) => entry.status !== "retired")
        .every((entry) => entry.retirement === undefined),
    ).toBe(true);
  });

  it("projects only public facts and retirement fields from every immutable installed record", async () => {
    const { authority } = await loadInstalledModelCompositionAuthority();
    const installed = listInstalledModelCompositions(authority);
    const before = JSON.stringify(installed);
    const lines: string[] = [];
    await handleCompositionCommand(["list", "--json"], { log: (line) => lines.push(line) });
    const json = lines.join("\n");
    const result = JSON.parse(json) as { compositions: Array<Record<string, unknown>> };
    expect(Object.keys(result).sort()).toEqual(
      ["schemaVersion", "kind", "technicalApproval", "releaseEligible", "compositions"].sort(),
    );
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-installed-model-composition-list",
      technicalApproval: "not-established",
      releaseEligible: false,
    });
    expect(result.compositions).toHaveLength(installed.length);
    const scalarKeys = [
      "compositionId",
      "status",
      "executionClass",
      "modelId",
      "provider",
      "routeId",
      "transport",
      "harnessId",
      "technicalApproval",
      "releaseEligible",
    ] as const;
    let privateTextsChecked = 0;
    for (const [index, composition] of installed.entries()) {
      const actual = result.compositions[index]!;
      const retirement = composition.retirement;
      expect(Object.keys(actual).sort(), composition.compositionId).toEqual(
        [...scalarKeys, ...(retirement ? ["retirement"] : [])].sort(),
      );
      for (const key of scalarKeys) {
        expect(actual[key], `${composition.compositionId}: ${key}`).toEqual(composition[key]);
      }
      if (!retirement) continue;
      const actualRetirement = actual.retirement as Record<string, unknown>;
      expect(Object.keys(actualRetirement).sort(), composition.compositionId).toEqual(
        [
          "reason",
          "effectiveAt",
          ...(retirement.successorCompositionId !== undefined ? ["successorCompositionId"] : []),
        ].sort(),
      );
      expect(actualRetirement.reason).toBe(retirement.reason);
      expect(actualRetirement.effectiveAt).toBe(retirement.effectiveAt);
      expect(actualRetirement.successorCompositionId).toBe(retirement.successorCompositionId);
      const privateTexts =
        retirement.reason === "superseded-by-operator-decision"
          ? [
              retirement.decision.decidedBy,
              retirement.decision.statement,
              retirement.decision.record,
            ]
          : [retirement.providerNotice];
      for (const text of privateTexts) {
        expect(json.includes(JSON.stringify(text)), composition.compositionId).toBe(false);
        privateTextsChecked += 1;
      }
    }
    expect(privateTextsChecked).toBeGreaterThan(0);
    expect(JSON.stringify(installed)).toBe(before);
    expect(Object.isFrozen(installed)).toBe(true);
  });

  it("marks the retired composition in the human-readable list", async () => {
    const lines: string[] = [];
    await handleCompositionCommand(["list"], { log: (line) => lines.push(line) });
    const text = lines.join("\n");
    expect(text).toContain("Installed compositions");
    expect(text).toContain("Technical approval: not established");
    expect(text).toContain("Release eligible: no");
    expect(text).toContain(
      "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi: status=retired; class=pi-provider; model=nvidia/llama-3.3-nemotron-super-49b-v1.5; route=nvidia-api-catalog; harness=pi; retirement=provider-end-of-life (2026-08-26)",
    );
    expect(text).toContain(
      "nvidia-nemotron-3-super-120b-a12b-pi: status=active; class=pi-provider; model=nvidia/nemotron-3-super-120b-a12b; route=nvidia-api-catalog; harness=pi",
    );
    expect(compositionRow(text, "openai-gpt-5.6-sol-pi")).toContain(
      "status=retired; class=pi-provider; model=gpt-5.6-sol; route=openai-api; harness=pi; retirement=superseded-by-operator-decision (2026-09-28)",
    );
    expect(compositionRow(text, "openai-gpt-5.6-sol-codex-preflight")).toContain(
      "status=retired; class=preflight-only; model=gpt-5.6-sol; route=codex-chatgpt-managed; harness=codex; retirement=provider-end-of-life (2026-09-30)",
    );
    expect(compositionRow(text, "openai-gpt-5.6-sol-codex-preflight")).not.toContain(
      "openai-gpt-5.6-sol-pi: status=",
    );
    expect(text).toContain("openai-gpt-6-sol-codex-preflight: status=active");
  });

  it("runs the installed Claude composition as fixed provider-offline preflight operations", async () => {
    const requests: NativePreflightProcessRequest[] = [];
    const fakeHost: NativePreflightHost = {
      inspectExecutable: async () => ({
        canonicalPath: "/opt/docsfab/bin/claude.exe",
        basename: "claude.exe",
        sha256: "a".repeat(64),
        identitySha256: "b".repeat(64),
        trusted: true,
      }),
      runProcess: async (request) => {
        requests.push(request);
        return request.operation === "version"
          ? processObservation(`${CLAUDE_PREFLIGHT_REPORTED_VERSION}\n`)
          : processObservation(
              JSON.stringify({
                loggedIn: true,
                authMethod: "claude.ai",
                apiProvider: "firstParty",
                email: "private@example.test",
                orgId: "private-org",
                orgName: "Private Org",
                subscriptionType: "enterprise",
              }),
            );
      },
    };
    const lines: string[] = [];
    await handleCompositionCommand(
      ["preflight", "--composition", "anthropic-claude-opus-4.7-claude-code-preflight", "--json"],
      {
        environment: {
          DOCSFAB_CLAUDE_EXECUTABLE: "/opt/docsfab/bin/claude",
          HOME: "/Users/tester",
          TMPDIR: "/private/tmp",
          LANG: "C",
          USER: "tester",
          LOGNAME: "tester",
          ANTHROPIC_API_KEY: "must-not-cross-the-boundary",
        },
        createHost: () => fakeHost,
        resolveExecutable: async () => "/opt/docsfab/bin/claude.exe",
        log: (line) => lines.push(line),
      },
    );

    const result = JSON.parse(lines.join("\n")) as {
      terminalCode: string;
      observedModel: unknown;
      capabilities: { modelEgress: string; workflowExecution: string };
      environment: { variableNames: string[] };
    };
    expect(result.terminalCode).toBe("preflight-ready");
    expect(result.observedModel).toBeNull();
    expect(result.capabilities).toEqual({
      modelEgress: "unavailable",
      workflowExecution: "unavailable",
    });
    expect(result.environment.variableNames).toEqual(["HOME", "LANG", "LOGNAME", "TMPDIR", "USER"]);
    expect(lines.join("\n")).not.toContain("private@example.test");
    expect(lines.join("\n")).not.toContain("must-not-cross-the-boundary");
    expect(requests.map((request) => request.arguments)).toEqual([
      ["--version"],
      ["auth", "status", "--json"],
    ]);
    expect(requests.every((request) => !("prompt" in request) && !("stdin" in request))).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("rejects executable Pi compositions and malformed CLI shapes before any host operation", async () => {
    const resolveExecutable = vi.fn();
    await expect(
      handleCompositionCommand(["preflight", "--composition", "anthropic-claude-opus-4.7-pi"], {
        resolveExecutable,
      }),
    ).rejects.toThrow(/not an installed native preflight composition/u);
    expect(resolveExecutable).not.toHaveBeenCalled();

    // A retired record refuses by name, before the generic preflight check and
    // before any host operation, and points at its declared successor.
    for (const [compositionId, successor] of [
      ["openai-gpt-5.6-sol-codex-preflight", "openai-gpt-6-sol-codex-preflight"],
      ["openai-gpt-5.6-sol-pi", "nvidia-inference-gpt-6-sol-pi"],
    ] as const) {
      const refusal = await handleCompositionCommand(
        ["preflight", "--composition", compositionId],
        {
          environment: { DOCSFAB_CODEX_EXECUTABLE: "/opt/docsfab/bin/codex" },
          resolveExecutable,
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal, compositionId).toBeInstanceOf(ModelCompositionError);
      expect((refusal as ModelCompositionError).code).toBe("composition-retired");
      expect((refusal as ModelCompositionError).message).toContain(`"${compositionId}" is retired`);
      expect((refusal as ModelCompositionError).nextAction).toContain(
        `Select its successor, \`${successor}\``,
      );
    }
    expect(resolveExecutable).not.toHaveBeenCalled();

    await expect(
      handleCompositionCommand(
        ["preflight", "--composition", "anthropic-claude-opus-4.7-claude-code-preflight"],
        {
          environment: { PATH: "/target-controlled/bin" },
          resolveExecutable,
        },
      ),
    ).rejects.toThrow("DOCSFAB_CLAUDE_EXECUTABLE");
    expect(resolveExecutable).not.toHaveBeenCalled();

    expect(() => parseCompositionCliArguments(["list", "--json", "--json"])).toThrow(
      /must not be duplicated/u,
    );
    expect(() => parseCompositionCliArguments(["preflight", "--composition", "../escape"])).toThrow(
      /requires --composition/u,
    );
    expect(() => parseCompositionCliArguments(["preflight", "--allow-write"])).toThrow(
      /requires --composition/u,
    );
  });

  it("keeps a retained record bound to the retired GPT-5.6 Codex preflight valid while refusing a new preflight", async () => {
    const { authority, snapshot } = await loadInstalledModelCompositionAuthority();
    const registry = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, "..", "model-compositions", "composition-registry.json"),
        "utf8",
      ),
    ) as { compositions: Array<{ compositionId: string; compositionSha256: string }> };
    const sealedSha256 = registry.compositions.find(
      (entry) => entry.compositionId === RETIRED_CODEX_PREFLIGHT,
    )?.compositionSha256;
    expect(sealedSha256).toMatch(/^[a-f0-9]{64}$/u);

    // Provenance: the retired record still binds, at its sealed digest, with
    // its candidate and its preflight-only adapters.
    const bound = resolveInstalledComposition({
      authority,
      compositionId: RETIRED_CODEX_PREFLIGHT,
      workflowId: snapshot.workflowIds[0]!,
    });
    expect(bound.composition.status).toBe("retired");
    expect(bound.composition.executionClass).toBe("preflight-only");
    expect(bound.composition.compositionSha256).toBe(sealedSha256);
    expect(bound.candidate.compositionId).toBe(RETIRED_CODEX_PREFLIGHT);
    expect(bound.candidate.compositionSha256).toBe(sealedSha256);
    expect(bound.composition.harness.id).toBe("codex");
    expect(bound.composition.model.resolvedId).toBe("gpt-5.6-sol");
    expect(Object.keys(bound.adapters).length).toBeGreaterThan(0);
    expect(Object.values(bound.adapters).every((entry) => entry.status === "preflight-only")).toBe(
      true,
    );

    // A sealed observation recorded against it before retirement still
    // round-trips through the observation decoder.
    const fakeHost: NativePreflightHost = {
      inspectExecutable: async () => ({
        canonicalPath: "/opt/docsfab/bin/codex",
        basename: "codex",
        sha256: "a".repeat(64),
        identitySha256: "b".repeat(64),
        trusted: true,
      }),
      runProcess: async (request) => {
        validateLocalRequest(request);
        return request.operation === "version"
          ? processObservation(`${CODEX_PREFLIGHT_REPORTED_VERSION}\n`)
          : request.operation === "authentication"
            ? {
                ...processObservation(""),
                stderr: Buffer.from("Logged in using ChatGPT\n", "utf8"),
                stderrBytes: Buffer.byteLength("Logged in using ChatGPT\n"),
              }
            : processObservation(
                JSON.stringify({ models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" }] }),
              );
      },
    };
    const retained = await createCodexNativePreflightAdapter(fakeHost).preflight({
      schemaVersion: 1,
      kind: NATIVE_PREFLIGHT_INPUT_KIND,
      harnessId: "codex",
      routeId: "codex-chatgpt-managed",
      executionClass: "preflight-only",
      requestedModel: bound.composition.model.resolvedId,
      executablePath: "/opt/docsfab/bin/codex",
      expectedExecutable: {
        basename: "codex",
        sha256: "a".repeat(64),
        identitySha256: "b".repeat(64),
        reportedVersion: CODEX_PREFLIGHT_REPORTED_VERSION,
      },
      environment: { HOME: "/Users/tester", LANG: "C", TMPDIR: "/private/tmp" },
    });
    expect(retained.requestedModel).toBe("gpt-5.6-sol");
    // The 0.147.0 pin keeps judging availability against the bundled catalog.
    expect(retained.catalog.source).toBe("codex-bundled");
    expect(retained.preflightSha256).toMatch(/^[a-f0-9]{64}$/u);
    const reparsed = parseNativePreflightObservationV1(JSON.parse(JSON.stringify(retained)));
    expect(reparsed).toEqual(retained);

    // A NEW preflight of the retired id refuses by name before any host step.
    const resolveExecutable = vi.fn();
    const refusal = await handleCompositionCommand(
      ["preflight", "--composition", RETIRED_CODEX_PREFLIGHT, "--json"],
      {
        environment: { DOCSFAB_CODEX_EXECUTABLE: "/opt/docsfab/bin/codex" },
        createHost: () => fakeHost,
        resolveExecutable,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ModelCompositionError);
    expect((refusal as ModelCompositionError).code).toBe("composition-retired");
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("pins the GPT-6 Sol Codex preflight to codex-cli 0.155.1 while the retired record keeps 0.147.0", async () => {
    // #1512: the live preflight of 2026-09-28 found codex-cli 0.155.1 with slug
    // gpt-6-sol. The GPT-6 record binds the 1.1.0 adapter records, whose
    // digests reproduce from the checked-in policy bodies; the retired GPT-5.6
    // record keeps the sealed 1.0.0 pin so retained evidence still binds.
    expect(CODEX_PREFLIGHT_PINS["1.1.0"]).toEqual({
      reportedVersion: "codex-cli 0.155.1",
      executablePolicySha256: canonicalDigest(CODEX_0_155_1_EXECUTABLE_POLICY),
      environmentPolicySha256: CODEX_PREFLIGHT_PINS["1.0.0"]!.environmentPolicySha256,
      harnessPolicySha256: canonicalDigest(CODEX_0_155_1_HARNESS_POLICY),
    });
    expect(CODEX_PREFLIGHT_PINS["1.0.0"]!.reportedVersion).toBe("codex-cli 0.147.0");
    expect(CODEX_0_155_1_EXECUTABLE_POLICY.qualifyingObservation).toEqual({
      observedAt: "2026-09-28",
      executableSha256: "8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e",
      identitySha256: "da932e583204c8f039fb6d1012ca2ea01978f32c409792c05a83ce8a3a2fcb7e",
    });
    expect(CODEX_0_155_1_HARNESS_POLICY.catalogModel).toEqual({
      slug: "gpt-6-sol",
      defaultReasoningLevel: "medium",
    });

    const { authority, snapshot } = await loadInstalledModelCompositionAuthority();
    const workflowId = snapshot.workflowIds[0]!;
    const current = resolveInstalledComposition({
      authority,
      compositionId: "openai-gpt-6-sol-codex-preflight",
      workflowId,
    });
    expect(current.composition.model.resolvedId).toBe("gpt-6-sol");
    expect(current.adapters.authentication.version).toBe("1.1.0");
    expect(current.adapters.harness.version).toBe("1.1.0");
    expect(current.adapters.authentication.executablePolicySha256).toBe(
      CODEX_PREFLIGHT_PINS["1.1.0"]!.executablePolicySha256,
    );
    expect(current.composition.harness.policySha256).toBe(
      CODEX_PREFLIGHT_PINS["1.1.0"]!.harnessPolicySha256,
    );
    const retired = resolveInstalledComposition({
      authority,
      compositionId: RETIRED_CODEX_PREFLIGHT,
      workflowId,
    });
    expect(retired.adapters.authentication.version).toBe("1.0.0");
    expect(retired.adapters.harness.version).toBe("1.0.0");
    expect(retired.composition.harness.policySha256).toBe(
      CODEX_PREFLIGHT_PINS["1.0.0"]!.harnessPolicySha256,
    );

    // The live 0.155.1 bundled catalog lacks gpt-6-sol; the account catalog
    // (what NVIDIA's Codex environment serves) lists it.
    const BUNDLED_0_155_1 = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5", "codex-auto-review"];
    const runPreflight = async (options: {
      readonly reportedVersion: string;
      readonly accountSlugs?: readonly string[];
      readonly loginStatus?: string;
    }) => {
      const requests: NativePreflightProcessRequest[] = [];
      const catalog = (slugs: readonly string[]) =>
        processObservation(
          JSON.stringify({ models: slugs.map((slug) => ({ slug, display_name: slug })) }),
        );
      const host: NativePreflightHost = {
        inspectExecutable: async () => ({
          canonicalPath: "/opt/docsfab/bin/codex",
          basename: "codex",
          sha256: "a".repeat(64),
          identitySha256: "b".repeat(64),
          trusted: true,
        }),
        runProcess: async (request) => {
          // The real local host's pre-spawn admission (argv allowlist,
          // environment, bounds). A request it refuses never reaches a spawn,
          // exactly as on a real host.
          validateLocalRequest(request);
          requests.push(request);
          if (request.operation === "version") {
            return processObservation(`${options.reportedVersion}\n`);
          }
          if (request.operation === "authentication") {
            const status = `${options.loginStatus ?? "Logged in using ChatGPT"}\n`;
            return {
              ...processObservation(""),
              stderr: Buffer.from(status, "utf8"),
              stderrBytes: Buffer.byteLength(status),
            };
          }
          return request.arguments.includes("--bundled")
            ? catalog(BUNDLED_0_155_1)
            : catalog(options.accountSlugs ?? ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"]);
        },
      };
      const lines: string[] = [];
      process.exitCode = 0;
      await handleCompositionCommand(
        ["preflight", "--composition", "openai-gpt-6-sol-codex-preflight", "--json"],
        {
          environment: {
            DOCSFAB_CODEX_EXECUTABLE: "/opt/docsfab/bin/codex",
            HOME: "/Users/tester",
            TMPDIR: "/private/tmp",
            LANG: "C",
          },
          createHost: () => host,
          resolveExecutable: async () => "/opt/docsfab/bin/codex",
          log: (line) => lines.push(line),
        },
      );
      return {
        result: JSON.parse(lines.join("\n")) as {
          terminalCode: string;
          requestedModel: string;
          executable: { reportedVersion: string };
          authentication: { status: string };
          catalog: { source: string; availability: string; projectionSha256: string | null };
        },
        requests,
        exitCode: process.exitCode,
      };
    };

    // Account catalog lists gpt-6-sol: ready, judged against the account
    // catalog even though the bundled catalog of the same CLI lacks it.
    const ready = await runPreflight({ reportedVersion: CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION });
    expect(ready.result).toMatchObject({
      terminalCode: "preflight-ready",
      requestedModel: "gpt-6-sol",
      executable: { reportedVersion: "codex-cli 0.155.1" },
      catalog: { source: "codex-account", availability: "available" },
    });
    expect(ready.result.catalog.projectionSha256).toBe(
      canonicalDigest({
        source: "codex-account",
        modelSlugs: ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"],
      }),
    );
    expect(ready.requests.map((request) => request.arguments)).toEqual([
      ["--version"],
      ["login", "status"],
      ["debug", "models"],
    ]);
    expect(ready.exitCode ?? 0).toBe(0);
    const reparsed = parseNativePreflightObservationV1(ready.result);
    expect(reparsed.executable.reportedVersion).toBe("codex-cli 0.155.1");
    expect(reparsed.catalog.source).toBe("codex-account");

    // Account catalog lacks gpt-6-sol: model-unavailable, with no fallback.
    const missing = await runPreflight({
      reportedVersion: CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION,
      accountSlugs: ["gpt-6-astra", "gpt-6-luna"],
    });
    expect(missing.result).toMatchObject({
      terminalCode: "model-unavailable",
      catalog: { source: "codex-account", availability: "unavailable" },
    });
    expect(missing.requests.map((request) => request.arguments)).toEqual([
      ["--version"],
      ["login", "status"],
      ["debug", "models"],
    ]);
    expect(missing.exitCode).toBe(1);
    expect(parseNativePreflightObservationV1(missing.result).terminalCode).toBe(
      "model-unavailable",
    );

    // Authentication not ready: the existing refusal, before any catalog.
    const unauthenticated = await runPreflight({
      reportedVersion: CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION,
      loginStatus: "Not logged in",
    });
    expect(unauthenticated.result).toMatchObject({
      terminalCode: "authentication-mismatch",
      authentication: { status: "unavailable" },
      catalog: { source: "codex-account", availability: "not-observed", projectionSha256: null },
    });
    expect(unauthenticated.requests.map((request) => request.arguments)).toEqual([
      ["--version"],
      ["login", "status"],
    ]);
    expect(unauthenticated.exitCode).toBe(1);

    // The old CLI no longer satisfies the GPT-6 record's pin.
    const drifted = await runPreflight({ reportedVersion: CODEX_PREFLIGHT_REPORTED_VERSION });
    expect(drifted.result.terminalCode).toBe("executable-drift");
    expect(drifted.requests.map((request) => request.arguments)).toEqual([["--version"]]);
    expect(drifted.exitCode).toBe(1);
  });

  it("builds a minimal auth-store environment and wires composition list through the router", async () => {
    expect(
      buildNativePreflightEnvironment({
        HOME: "/Users/tester",
        TMPDIR: "/private/tmp/",
        USER: "tester",
        LOGNAME: "tester",
        OPENAI_API_KEY: "not-forwarded",
      }),
    ).toEqual({
      HOME: "/Users/tester",
      LOGNAME: "tester",
      TMPDIR: "/private/tmp",
      USER: "tester",
    });
    expect(usage()).toContain("docsfab composition list [--json]");
    expect(usage()).toContain("no model or workflow egress");

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => output.push(String(value)));
    process.argv = [originalArgv[0]!, originalArgv[1]!, "composition", "list"];
    await main();
    expect(output.join("\n")).toContain("openai-gpt-6-sol-codex-preflight");
  });
});

function processObservation(stdout: string): NativePreflightProcessObservation {
  const output = Buffer.from(stdout, "utf8");
  return {
    status: "settled",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout: output,
    stderr: Buffer.alloc(0),
    stdoutBytes: output.byteLength,
    stderrBytes: 0,
    stdoutOverflow: false,
    stderrOverflow: false,
  };
}
