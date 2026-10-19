// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogued `siteBootstrap.*` bounds the hosted site arm applies, each
 * driven through `runHostedWorkflow` at the limit and the limit plus one. The
 * catalog accessor is the injection seam: one name's value is replaced while
 * the arm still reads the catalog at its own call site, so the cases need
 * neither a 32 MiB bundle nor an 8 MiB record.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const capacity = vi.hoisted(() => ({ values: new Map<string, number>() }));
vi.mock("../src/config/catalog-capacity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/catalog-capacity.js")>();
  return {
    ...actual,
    catalogCapacity: (name: string) => capacity.values.get(name) ?? actual.catalogCapacity(name),
  };
});

import { catalogCapacity } from "../src/config/catalog-capacity.js";
import { loadSiteBootstrapApplicationBundle } from "../src/site-bootstrap/bundle.js";
import {
  approvedPlanFixture,
  removeHostedSiteFixtures,
  retainedSiteRunRecords,
  runSite,
  stagedRequest,
} from "./helpers/hosted-site-bootstrap.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execFile = promisify(execFileCallback);
/** Local budget for this suite; CI raises it through the catalogued default. */
const LOCAL_SUITE_TIMEOUT_MS = 180_000;

afterAll(removeHostedSiteFixtures);
beforeEach(() => capacity.values.clear());

describe("hosted site bootstrap catalogued bounds", {
  timeout: testTimeoutMs(LOCAL_SUITE_TIMEOUT_MS),
}, () => {
  it("admits the registered bundle at siteBootstrap.bundleMaxBytes and refuses it one byte over", async () => {
    const approved = await approvedPlanFixture();
    const size = approved.bundleBytes.byteLength;
    capacity.values.set("siteBootstrap.bundleMaxBytes", size);
    const at = await runSite(await stagedRequest(approved, { name: "bundle-at" }));
    expect(at.record.status).toBe("succeeded");
    // The same signed document, one byte over a bound one byte smaller. It is
    // refused on the size custody declared, before its bytes are read.
    capacity.values.set("siteBootstrap.bundleMaxBytes", size - 1);
    await expect(runSite(await stagedRequest(approved, { name: "bundle-up" }))).rejects.toThrow(
      "Site bootstrap application bundle rejected: bundle-too-large.",
    );
  });

  it("applies the same bundle bound at the parked command-line reader, at the limit and one byte over", async () => {
    // The `docsfab run site-bootstrap --plan <file>` reader loads the same
    // document through `loadSiteBootstrapApplicationBundle`, which refuses on
    // the file's own size before reading it.
    const approved = await approvedPlanFixture();
    const size = approved.bundleBytes.byteLength;
    const options = { now: new Date(), reviewerPolicy: approved.reviewerPolicy };
    capacity.values.set("siteBootstrap.bundleMaxBytes", size);
    await expect(
      loadSiteBootstrapApplicationBundle(approved.applicationPath, options),
    ).resolves.toMatchObject({ digest: approved.bundle.digest });
    capacity.values.set("siteBootstrap.bundleMaxBytes", size - 1);
    await expect(
      loadSiteBootstrapApplicationBundle(approved.applicationPath, options),
    ).rejects.toThrow("Site bootstrap application bundle rejected: bundle-too-large.");
  });

  it("admits the registered reviewer policy at siteBootstrap.reviewerPolicyMaxBytes and refuses it one byte over", async () => {
    const approved = await approvedPlanFixture();
    const size = approved.policyBytes.byteLength;
    capacity.values.set("siteBootstrap.reviewerPolicyMaxBytes", size);
    const at = await runSite(await stagedRequest(approved, { name: "policy-at" }));
    expect(at.record.status).toBe("succeeded");
    capacity.values.set("siteBootstrap.reviewerPolicyMaxBytes", size - 1);
    await expect(runSite(await stagedRequest(approved, { name: "policy-up" }))).rejects.toThrow(
      "Hosted site bootstrap refused a registered reviewer policy over its catalogued size: policy-too-large.",
    );
  });

  it("retains the operation record at siteBootstrap.runRecordMaxBytes and refuses it one byte over", async () => {
    const approved = await approvedPlanFixture();
    // Measured under the real catalogued bound, which retains every record this
    // run writes. Same-length fixture names keep the recorded checkout path, and
    // so the record size, identical across the three runs.
    const measured = await stagedRequest(approved, { name: "record-a" });
    expect((await runSite(measured)).record.status).toBe("succeeded");
    const largest = Math.max(
      ...(await retainedSiteRunRecords(measured.stateDirectory)).map((entry) => entry.bytes),
    );
    expect(largest).toBeLessThan(catalogCapacity("siteBootstrap.runRecordMaxBytes"));

    capacity.values.set("siteBootstrap.runRecordMaxBytes", largest);
    const at = await stagedRequest(approved, { name: "record-b" });
    expect((await runSite(at)).record.status).toBe("succeeded");
    expect(
      Math.max(...(await retainedSiteRunRecords(at.stateDirectory)).map((entry) => entry.bytes)),
    ).toBe(largest);

    capacity.values.set("siteBootstrap.runRecordMaxBytes", largest - 1);
    const over = await stagedRequest(approved, { name: "record-c" });
    // The runner records the step's refusal rather than rejecting: the run
    // ends `failed` with the store's named code and no patch.
    const refused = await runSite(over);
    const steps = JSON.stringify(refused.record.steps);
    expect(refused.record.status, steps).toBe("failed");
    expect(steps).toContain("artifact-too-large");
    expect(refused.patch).toBeNull();
    // Only the smaller queued and running records were retained, and the
    // outer checkout is untouched: finalize transfers nothing from a run
    // that did not succeed.
    const retained = await retainedSiteRunRecords(over.stateDirectory);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((entry) => entry.bytes < largest)).toBe(true);
    expect((await execFile("git", ["-C", over.checkout, "status", "--porcelain"])).stdout).toBe("");
  });
});
