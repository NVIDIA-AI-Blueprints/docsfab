// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { renderCliPresentation } from "../src/cli/presentation.js";
import {
  projectProfileDraft,
  projectProfileInspection,
  projectProfileProbe,
} from "../src/cli/profile-presentation.js";
import type { ProfileDraftRecord } from "../src/cli/profile-draft.js";
import type { ProfileProbeObservation } from "../src/cli/profile-probe.js";
import { limit } from "../src/config/limits.js";
import { projectCompositionList } from "../src/native-compositions/presentation.js";
import {
  projectSourceCommandOutcome,
  projectSourceCommandRefusal,
} from "../src/live-agent/source-presentation.js";
import type { LiveAttachedSourceV1 } from "../src/live-agent/source-commands.js";
import { resolvePresentationCapabilities, unicodeCellWidth } from "../src/operator/index.js";
import { profileApprovalFixture } from "./profile-approval-fixture.js";

describe("shared CLI inspection presentation", () => {
  it("keeps profile summary facts in verbose output and adds audit evidence", async () => {
    const { endpoint, report } = await profileApprovalFixture();
    const normal = renderCliPresentation(projectProfileInspection(report)).stdout;
    const verbose = renderCliPresentation(projectProfileInspection(report, true)).stdout;

    expect(normal).toContain("Model profile");
    expect(normal).toContain(`${report.subject.provider}/${report.subject.model}`);
    expect(normal).toContain(report.runtime.profileStatus);
    expect(verbose).toContain(`${report.subject.provider}/${report.subject.model}`);
    expect(verbose).toContain("Inspection digest");
    expect(verbose).toContain(report.sha256);
    expect(verbose).toContain(
      `Proposal digest: ${report.catalog.reconciliation?.proposal?.sha256}`,
    );
    expect(verbose).toContain(
      `Proposal provenance digest: ${report.catalog.reconciliation?.proposalProvenance?.sha256}`,
    );
    expect(verbose).toContain(`Decision digest: ${report.catalog.reconciliation?.decision.sha256}`);
    expect(normal).not.toContain(endpoint.apiKey);
    expect(verbose).not.toContain(endpoint.apiKey);
  });

  it("retains the reconciliation decision digest when catalog review is blocked", async () => {
    const { report } = await profileApprovalFixture();
    const reconciliation = report.catalog.reconciliation;
    expect(reconciliation).not.toBeNull();
    if (!reconciliation) throw new Error("The fixture must contain reconciliation evidence.");
    const blocked = {
      ...report,
      catalog: {
        ...report.catalog,
        reconciliation: {
          ...reconciliation,
          status: "blocked" as const,
          proposal: null,
          proposalProvenance: null,
        },
      },
    };
    const verbose = renderCliPresentation(projectProfileInspection(blocked, true)).stdout;

    expect(verbose).toContain(`Decision digest: ${reconciliation.decision.sha256}`);
    expect(verbose).not.toContain("Proposal digest:");
    expect(verbose).not.toContain("Proposal provenance digest:");
  });

  it("prints a runnable live probe action preserving route and model arguments", () => {
    const text = renderCliPresentation(
      projectProfileProbe({
        schemaVersion: 1,
        kind: "docsfab-profile-probe-observation",
        live: false,
        locator: "openai-api:gpt-4.1",
        verdict: "not-requested",
        compatibility: null,
      }),
    ).stdout;

    expect(text).toContain("docsfab profile probe --route openai-api --model 'gpt-4.1' --live");
  });

  it("keeps a live probe's provider explanation and recovery in human output", () => {
    const observation: ProfileProbeObservation = {
      schemaVersion: 1,
      kind: "docsfab-profile-probe-observation",
      live: true,
      locator: "openai-api:gpt-4.1",
      verdict: "unreachable",
      compatibility: {
        schemaVersion: 1,
        kind: "docsfab-endpoint-compatibility",
        verdict: "incompatible",
        maxOutputTokens: limit("endpointProbe.reasoningSampleMaxTokens").value,
        checks: [
          {
            id: "availability",
            status: "fail",
            finding: "credential-rejected",
            detail: "The provider refused the request.",
            cause: "provider-auth-refused",
            owner: "operator-configuration",
            nextAction: "Check the configured credential and retry the live probe.",
            providerMessage: "This credential is not accepted.",
            providerMessageTruncated: true,
          },
        ],
      },
    };
    const text = renderCliPresentation(projectProfileProbe(observation)).stdout;

    expect(text).toContain('Provider said: "This credential is not accepted." (truncated)');
    expect(text).toContain(
      "availability owner: operator-configuration (cause provider-auth-refused)",
    );
    expect(text).toContain(
      "availability next action: Check the configured credential and retry the live probe.",
    );
    expect(text).toContain("Configuration: unchanged");
  });

  it("keeps composition evidence visible in the default profile draft presentation", () => {
    const draft = {
      composition: {
        compositionId: "openai-gpt-4.1-pi",
        model: { resolvedId: "gpt-4.1" },
        deployment: { provider: "openai", routeId: "openai-api" },
        requestPolicy: undefined,
      },
      locator: "openai-api:gpt-4.1",
      verdict: "compatible",
      registryUnchanged: true,
      resealCommand: "node --import tsx scripts/reseal-composition-digests.mts",
      resealScript: "scripts/reseal-composition-digests.mts",
    } as unknown as ProfileDraftRecord;

    const text = renderCliPresentation(projectProfileDraft(draft)).stdout;

    expect(text).toContain("Provider: openai");
    expect(text).toContain("Model: gpt-4.1");
    expect(text).toContain("Route: openai-api");
  });

  it("keeps source revalidation state distinct and marks stale evidence", () => {
    const entry: LiveAttachedSourceV1 = {
      entryId: "source:test-entry",
      kind: "repository-file",
      label: "docs/release.md",
      locator: "repository-path:docs/release.md",
      repositoryPath: "docs/release.md",
      projectId: null,
      projectPath: null,
      changeNumber: null,
      format: "markdown",
      status: "attached",
      version: "sha256:recorded",
      limitations: [],
      historicalUse: [],
      requiredBy: [],
      revalidation: { state: "stale", basis: "recorded-digest", withinWindow: true },
    };
    const text = renderCliPresentation(
      projectSourceCommandOutcome({ kind: "listing", entries: [entry] }),
    ).stdout;

    expect(text).toContain("docs/release.md");
    expect(text).toContain("stale (recorded-digest)");
    expect(text).toContain("ATTENTION:");
    expect(text).not.toContain("fresh");
  });

  it("retains a merged-change project path when its numeric identity is unavailable", () => {
    const entry: LiveAttachedSourceV1 = {
      entryId: "source:merged-change",
      kind: "merged-change",
      label: "gitlab.example/team/docs!17",
      locator: "gitlab-project:team/docs!17",
      repositoryPath: null,
      projectId: null,
      projectPath: "team/docs",
      changeNumber: 17,
      format: "markdown",
      status: "attached",
      version: null,
      limitations: [],
      historicalUse: [],
      requiredBy: [],
      revalidation: null,
    };
    const text = renderCliPresentation(
      projectSourceCommandOutcome({ kind: "listing", entries: [entry] }),
    ).stdout;

    expect(text).toContain("Project: team/docs");
    expect(text).not.toContain("id null");
  });

  it("does not treat installed compositions as qualified or release eligible", () => {
    const text = renderCliPresentation(projectCompositionList([])).stdout;

    expect(text).toContain("No installed compositions were found.");
    expect(text).toContain("Technical approval: not established");
    expect(text).toContain("Release eligible: no");
  });

  it("answers an empty source inspection without implying that sources were unavailable", () => {
    const text = renderCliPresentation(
      projectSourceCommandOutcome({ kind: "listing", entries: [] }),
    ).stdout;

    expect(text).toContain("No sources are attached to this conversation.");
    expect(text).not.toContain("unavailable");
  });

  it("keeps source refusals on stderr and does not turn them into successful output", () => {
    const rendered = renderCliPresentation(
      projectSourceCommandRefusal("The selected repository is unavailable."),
    );

    expect(rendered.stdout).toBe("");
    expect(rendered.stderr).toContain("ATTENTION:");
    expect(rendered.stderr).toContain("The selected repository is unavailable.");
  });

  it("renders plain output within narrow terminal width without losing source facts", () => {
    const entry: LiveAttachedSourceV1 = {
      entryId: "source:long-label",
      kind: "repository-file",
      label: "docs/a-wide-grapheme-界-release-plan.md",
      locator: "repository-path:docs/a-wide-grapheme-界-release-plan.md",
      repositoryPath: "docs/a-wide-grapheme-界-release-plan.md",
      projectId: null,
      projectPath: null,
      changeNumber: null,
      format: "markdown",
      status: "attached",
      version: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      limitations: [],
      historicalUse: [],
      requiredBy: [],
      revalidation: { state: "fresh", basis: "recorded-digest", withinWindow: true },
    };
    const capabilities = resolvePresentationCapabilities({
      stdout: { isTTY: false, columns: 32 },
      stderr: { isTTY: false, columns: 32 },
      environment: {
        noColorPresent: true,
        forceColor: false,
        forceColorDisabled: false,
        ci: false,
        termDumb: false,
      },
      unicode: false,
    });
    const text = renderCliPresentation(
      projectSourceCommandOutcome({ kind: "listing", entries: [entry] }),
      capabilities,
    ).stdout;

    expect(text.replaceAll(/\s/gu, "")).toContain(entry.label.replaceAll(/\s/gu, ""));
    expect(text.replaceAll(/\s/gu, "")).toContain(entry.version);
    expect(text).not.toMatch(/\u001b\[/u);
    const tooWide = text.split("\n").filter((line) => unicodeCellWidth(line) > 32);
    expect(tooWide[0]).toBeUndefined();
  });
});
