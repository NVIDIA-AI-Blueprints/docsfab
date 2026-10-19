// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import { withLocalPreservationSourceWorkspace } from "../src/cli/run/execution.js";
import type { EvidenceInputFormatPolicyV1 } from "../src/harness/evidence-input-format.js";
import { resolvePreservationDeliveryPolicy } from "../src/workflow-execution/preservation-delivery-policy.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function assembled(
  workflow: string,
  evidenceInputFormatPolicy?: EvidenceInputFormatPolicyV1,
) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-preservation-policy-"));
  roots.push(root);
  const { services } = await createLocalWorkflowApplicationServices({
    config: {
      stateDirectory: join(root, "runs"),
      skillCrateDirectory: resolve("skill-crate"),
      qualityDirectory: resolve("quality"),
      qualityPackDirectory: resolve("quality-pack"),
    },
    request: { workflow },
    workflow: { schemaVersion: 2 },
    preservationDeliveryPolicy: resolvePreservationDeliveryPolicy({
      workflow,
      environment: process.env,
    }),
    ...(evidenceInputFormatPolicy ? { evidenceInputFormatPolicy } : {}),
    workspace: {},
    repositoryEvidence: {},
    baseHarness: {},
  } as never);
  return services;
}

describe("local preservation experiment assembly", () => {
  it("passes the default and explicit treatments to the actual runner ports", async () => {
    const control = await assembled("restructure-documentation");
    expect(control).toMatchObject({
      evidenceInputFormatPolicy: "canonical-json-string-v1",
      preservationBaseDelivery: "eager",
      preservationObservationReuse: false,
    });
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT", "1");
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE", "1");
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE", "1");
    const combined = await assembled("restructure-documentation", "compact-json-experimental-v1");
    expect(combined).toMatchObject({
      evidenceInputFormatPolicy: "compact-json-experimental-v1",
      preservationBaseDelivery: "stage-specific",
      preservationObservationReuse: true,
    });
    const unrelated = await assembled("update-documentation");
    expect(unrelated).toMatchObject({
      preservationBaseDelivery: "eager",
      preservationObservationReuse: false,
    });
  });

  it("requires stage delivery for reuse and refuses invalid eligible values", async () => {
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE", "1");
    expect(await assembled("restructure-documentation")).toMatchObject({
      preservationBaseDelivery: "eager",
      preservationObservationReuse: false,
    });
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE", "1");
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE", "bad");
    await expect(assembled("restructure-documentation")).rejects.toThrow(
      "DOCSFAB_EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE must be 0 or 1",
    );
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE", "0");
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE", "bad");
    await expect(assembled("restructure-documentation")).rejects.toThrow(
      "DOCSFAB_EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE must be 0 or 1",
    );
    expect(await assembled("update-documentation")).toMatchObject({
      preservationBaseDelivery: "eager",
      preservationObservationReuse: false,
    });
  });

  it("keeps direct application assembly independent of polluted process settings", async () => {
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT", "invalid");
    expect(await assembled("restructure-documentation")).toMatchObject({
      evidenceInputFormatPolicy: "canonical-json-string-v1",
    });
    expect(
      await assembled("restructure-documentation", "compact-json-experimental-v1"),
    ).toMatchObject({
      evidenceInputFormatPolicy: "compact-json-experimental-v1",
    });
  });

  it("resolves the CLI evidence treatment before local application assembly", async () => {
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT", "1");
    const services = await withLocalPreservationSourceWorkspace(
      {} as never,
      "restructure-documentation",
      async (_source, _preservation, evidenceInputFormatPolicy) =>
        assembled("restructure-documentation", evidenceInputFormatPolicy),
    );
    expect(services).toMatchObject({
      evidenceInputFormatPolicy: "compact-json-experimental-v1",
    });

    vi.stubEnv("DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT", "invalid");
    await expect(
      withLocalPreservationSourceWorkspace({} as never, "restructure-documentation", async () =>
        assembled("restructure-documentation"),
      ),
    ).rejects.toThrow("DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT must be unset, 0, or 1");
  });
});
