// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile as execFileCallback } from "node:child_process";
import { appendFileSync, linkSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { catalogCapacity } from "../src/config/catalog-capacity.js";
import { canonicalDigest } from "../src/content-ir/index.js";
import { sealHostRuntimeTerminal } from "../src/host-invoker/contracts.js";
import { assembleHostedNativeSite } from "../src/host-invoker/native-site.js";
import { iaPlanReviewerPolicyDigest } from "../src/ia/plan-review.js";
import type { RunRecord } from "../src/records/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  approvedPlanFixture,
  nativePatchPath,
  removeHostedSiteFixtures,
  REQUEST_PRINCIPAL,
  retainedSiteRunRecords,
  runSite,
  stagedRequest,
} from "./helpers/hosted-site-bootstrap.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execFile = promisify(execFileCallback);
/** Local budget for this suite; CI raises it through the catalogued default. */
const LOCAL_SUITE_TIMEOUT_MS = 180_000;

afterAll(removeHostedSiteFixtures);

describe("hosted site bootstrap", { timeout: testTimeoutMs(LOCAL_SUITE_TIMEOUT_MS) }, () => {
  it("scaffolds the outer checkout from a signed, current plan and seals a zero-model terminal", async () => {
    const approved = await approvedPlanFixture();
    const staged = await stagedRequest(approved, {});
    const result = await runSite(staged);
    expect(
      result.record.status,
      JSON.stringify(result.record.steps.map((step) => [step.id, step.status, step.summary])),
    ).toBe("succeeded");
    // A deterministic apply of an already-signed plan records no model use.
    expect(result.record.models).toEqual([]);
    // The step's skill evidence names the crate the lock pins, by the lock's
    // digests.
    const lock = JSON.parse(
      await readFile(join(import.meta.dirname, "..", "skill-crate", "lock.json"), "utf8"),
    ) as { skills: { id: string; contentSha256: string; bundleSha256: string }[] };
    const pinned = lock.skills.find((skill) => skill.id === "template-scaffold-site")!;
    expect(result.record.steps[0]?.skillEvidence?.id).toBe("template-scaffold-site");
    expect(result.record.steps[0]?.skillEvidence?.contentSha256).toBe(pinned.contentSha256);
    expect(result.record.steps[0]?.skillEvidence?.bundleSha256).toBe(pinned.bundleSha256);
    // The outer checkout the request names, not the disposable workspace the
    // step wrote in, carries every approved output; this fails if
    // `nativeAssembly.finalize` is never called.
    const porcelain = (
      await execFile("git", [
        "-C",
        staged.checkout,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    ).stdout.trim();
    expect(porcelain).not.toBe("");
    const approvedPaths = approved.bundle.plan.payload.outputScope.map((output) => output.path);
    for (const output of approved.bundle.plan.payload.outputScope) {
      expect(porcelain, output.path).toContain(output.path);
      expect((await readFile(join(staged.checkout, output.path), "utf8")).length).toBeGreaterThan(
        0,
      );
    }
    // The source repository the fixture chain was built from is untouched.
    expect(
      (await execFile("git", ["-C", approved.repository, "status", "--porcelain"])).stdout,
    ).toBe("");
    // The real operation record survived the private workspace it was made in.
    const retained = await retainedSiteRunRecords(staged.stateDirectory);
    expect(
      retained.map((entry) => [entry.record.status, entry.record.mutationBoundaryEntered]),
    ).toContainEqual(["succeeded", true]);
    // The catalogued bounds admit this representative journey: the signed
    // bundle, the registered reviewer policy and every retained record fit.
    const largestRecord = Math.max(...retained.map((entry) => entry.bytes));
    for (const [name, observed] of [
      ["siteBootstrap.bundleMaxBytes", approved.bundleBytes.byteLength],
      ["siteBootstrap.reviewerPolicyMaxBytes", approved.policyBytes.byteLength],
      ["siteBootstrap.runRecordMaxBytes", largestRecord],
    ] as const)
      expect(observed, name).toBeLessThan(catalogCapacity(name));
    // `site-bootstrap` installs a single host-operation step, so
    // `scheduleCanInvokeInference` is `false` and the terminal seals
    // `succeeded` with zero models. The record and patch are the run's own,
    // sealed against the request the grant was issued for.
    expect(result.patch).toBeTypeOf("string");
    expect(result.patchEvidence).not.toBeNull();
    const terminal = sealHostRuntimeTerminal({
      request: staged.request,
      status: "succeeded",
      runtimeRecord: result.record,
      patch: result.patch,
      patchEvidence: result.patchEvidence!,
    });
    expect(terminal.status).toBe("succeeded");
    expect(terminal.patchEvidence!.changes.map((change) => change.path).sort()).toEqual(
      [...approvedPaths].sort(),
    );
  });

  it("refuses a request that is not one registered bundle under a separate write grant", async () => {
    // The arm's guard, at the two disjuncts reachable through
    // `runHostedWorkflow`; the others are refused upstream.
    const approved = await approvedPlanFixture();
    for (const [name, options] of [
      ["two selected inputs", { name: "two-inputs", extraInput: true }],
      ["grant without a typed native task", { name: "no-task", withoutNativeTask: true }],
    ] as const) {
      const staged = await stagedRequest(approved, options);
      await expect(runSite(staged), name).rejects.toThrow(
        "Hosted site bootstrap requires one registered signed-plan bundle and a separate write grant.",
      );
    }
  });

  it("refuses bytes without exact producing-plan and registered approval provenance", async () => {
    // Each disjunct of the provenance guard, driven separately through the
    // runner; each row changes one field of the journey's request.
    const approved = await approvedPlanFixture();
    for (const [name, options] of [
      [
        "no registered import",
        {
          name: "no-import",
          approvedImport: null,
          sourceOverrides: { principalId: REQUEST_PRINCIPAL },
        },
      ],
      [
        "produced by another workflow",
        { name: "wrong-producer", sourceOverrides: { workflow: "ia-analysis" } },
      ],
      [
        "produced at another revision",
        { name: "wrong-revision", sourceOverrides: { revision: "f".repeat(40) } },
      ],
    ] as const) {
      const staged = await stagedRequest(approved, options);
      await expect(runSite(staged), name).rejects.toThrow(
        "Hosted site bootstrap lacks exact producing-plan and registered approval provenance.",
      );
    }
  });

  it("refuses a reviewer policy that is not the one the import registered", async () => {
    // A well-formed but different policy. It passes the private byte reader (its
    // own content digest is registered) and `validateIaPlanReviewerPolicy`, so
    // only the digest comparison against the registered value can refuse it.
    const approved = await approvedPlanFixture();
    const substitute = { ...approved.reviewerPolicy, id: "docsfab:other-reviewers" };
    const substituteBytes = Buffer.from(
      JSON.stringify({
        ...substitute,
        digest: iaPlanReviewerPolicyDigest({
          id: substitute.id,
          version: substitute.version,
          reviewers: substitute.reviewers,
        }),
      }),
    );
    const staged = await stagedRequest(approved, {
      name: "policy-substitution",
      policyBytes: substituteBytes,
    });
    await expect(runSite(staged)).rejects.toThrow(
      "Hosted site bootstrap reviewer policy differs from the registered import.",
    );
  });

  it("refuses a selection whose task plan or repository revision is not the signed one", async () => {
    // `invalid-bundle` is the task/bundle disagreement; `stale-repository` is a
    // checkout that moved after the plan was signed.
    const approved = await approvedPlanFixture();
    const wrongPlan = await stagedRequest(approved, {
      name: "wrong-plan",
      taskPlanOverrides: { digest: "f".repeat(64) },
    });
    await expect(runSite(wrongPlan)).rejects.toThrow("Site bootstrap failed: invalid-bundle.");
    const moved = await stagedRequest(approved, { name: "moved-tree", advanceCheckout: true });
    expect(moved.revision).not.toBe(approved.revision);
    await expect(runSite(moved)).rejects.toThrow("Site bootstrap failed: stale-repository.");
  });

  it("refuses a bundle whose reviewer signature does not verify under the registered policy", async () => {
    // A forged approval that is otherwise self-consistent: both digests are
    // recomputed, so only the signature is wrong. The registered import and
    // policy are real, so the arm must verify the signature itself.
    const approved = await approvedPlanFixture();
    const forged = structuredClone(approved.bundle);
    forged.review.signature = Buffer.alloc(
      Buffer.from(forged.review.signature, "base64url").length,
    ).toString("base64url");
    const { digest: _reviewDigest, ...unsignedReview } = forged.review;
    forged.review.digest = canonicalDigest(unsignedReview);
    const { digest: _bundleDigest, ...unsignedBundle } = forged;
    forged.digest = canonicalDigest(unsignedBundle);
    const staged = await stagedRequest(approved, {
      name: "forged-review",
      bundleBytes: Buffer.from(JSON.stringify(forged)),
    });
    await expect(runSite(staged)).rejects.toThrow("IA plan review rejected: signature-mismatch.");
    expect(await retainedSiteRunRecords(staged.stateDirectory)).toEqual([]);
    expect((await execFile("git", ["-C", staged.checkout, "status", "--porcelain"])).stdout).toBe(
      "",
    );
  });

  it("refuses a signed plan whose approved outputs leave the installed write ceiling", async () => {
    // Approval and authorization are separate: the plan is the journey's signed
    // document, but the grant's ceiling excludes one approved output.
    const approved = await approvedPlanFixture();
    const paths = approved.bundle.plan.payload.outputScope.map((output) => output.path);
    expect(paths.length).toBeGreaterThan(1);
    const staged = await stagedRequest(approved, {
      name: "narrow-ceiling",
      pathCeiling: paths.slice(1),
    });
    await expect(runSite(staged)).rejects.toThrow(
      "The signed site plan exceeds the installed workflow's write scope.",
    );
  });

  it("transfers nothing when the captured patch artifact changes before finalize", async () => {
    // The runner emits its terminal `run-status` after the patch is persisted
    // and before `finalize`, so a change then falls between capture and
    // transfer. Each tamper keeps every other property of the file.
    const approved = await approvedPlanFixture();
    for (const [name, tamper, message] of [
      [
        "patch-grown",
        (path: string) => appendFileSync(path, "\n"),
        "The native patch artifact is no longer the recorded private file.",
      ],
      [
        "patch-linked",
        (path: string) => linkSync(path, `${path}.second-name`),
        "The native patch artifact is no longer the recorded private file.",
      ],
      [
        "patch-edited",
        (path: string) => {
          const bytes = readFileSync(path);
          bytes[bytes.length - 2] ^= 1;
          writeFileSync(path, bytes);
        },
        "The native patch artifact differs from recorded evidence.",
      ],
    ] as const) {
      const staged = await stagedRequest(approved, { name });
      let tampered = false;
      await expect(
        runSite(staged, (event) => {
          if (event.type !== "run-status" || event.status !== "succeeded") return;
          tamper(nativePatchPath(staged));
          tampered = true;
        }),
        name,
      ).rejects.toThrow(message);
      expect(tampered, name).toBe(true);
      expect(
        (await execFile("git", ["-C", staged.checkout, "status", "--porcelain"])).stdout,
        name,
      ).toBe("");
    }
  });

  it("finalizes only a succeeded run whose record carries exactly the approved evidence", async () => {
    // The arm's `finalize` closure, driven with records the runner could only
    // produce if one of its seams failed, against the operation record this
    // assembly's step wrote.
    const approved = await approvedPlanFixture();
    const staged = await stagedRequest(approved, { name: "finalize" });
    const workflow = getWorkflow("site-bootstrap");
    const expected = approved.bundle.plan.payload.outputScope.map((output) => output.path).sort();
    const missing = join(staged.stateDirectory, "native-patches", "absent.patch");
    const complete = {
      status: "succeeded",
      impactPostflight: { status: "completed", changedPaths: expected },
      changes: {
        patch: { artifactPath: missing, byteLength: 1, sha256: "0".repeat(64) },
        files: expected.map((path) => ({ path })),
      },
    };
    const record = (value: Record<string, unknown>) => value as unknown as RunRecord;
    const workspace = await prepareRepositoryWorkspace(staged.checkout, staged.revision);
    try {
      const assembly = await assembleHostedNativeSite({ request: staged.request, workspace });
      try {
        // Before the step has run there is no completed operation to finalize.
        await expect(assembly.finalize!(record(complete))).rejects.toThrow(
          "Site generation has no completed operation and actual patch evidence.",
        );
        const outcome = await assembly.hostOperations!.runStep({
          repositoryPath: workspace.path,
          workflow,
          step: workflow.steps[0]!,
          task: staged.request.packet.nativeTask!.task,
          runId: staged.request.runId,
        });
        expect(outcome.outcome).toBe("succeeded");
        // A run that did not succeed transfers nothing and is not an error here.
        await expect(assembly.finalize!(record({ ...complete, status: "failed" }))).resolves.toBe(
          undefined,
        );
        await expect(
          assembly.finalize!(record({ ...complete, changes: { files: complete.changes.files } })),
        ).rejects.toThrow("Site generation has no completed operation and actual patch evidence.");
        for (const impactPostflight of [
          { status: "failed", reason: "analysis-failed" },
          { status: "completed", changedPaths: expected.slice(1) },
        ])
          await expect(
            assembly.finalize!(record({ ...complete, impactPostflight })),
          ).rejects.toThrow(
            "Site generation lacks completed impact evidence for the exact approved outputs.",
          );
        await expect(
          assembly.finalize!(
            record({
              ...complete,
              changes: {
                ...complete.changes,
                files: [...complete.changes.files, { path: "UNAPPROVED.md" }],
              },
            }),
          ),
        ).rejects.toThrow("The generated site differs from the exact signed output scope.");
        // The complete record passes the checks above and stops at the artifact,
        // which this record names as a file that does not exist.
        await expect(assembly.finalize!(record(complete))).rejects.toThrow("ENOENT");
      } finally {
        await assembly.repositoryEvidence?.dispose();
      }
    } finally {
      await workspace.dispose();
    }
    expect((await execFile("git", ["-C", staged.checkout, "status", "--porcelain"])).stdout).toBe(
      "",
    );
  });

  it("admits a foreign producing principal only when the row carries a registered import", async () => {
    // The `native-custody-actor-binding` relaxation: a foreign row without the
    // registered import is refused on `site-bootstrap` and `ia-plan` alike.
    const approved = await approvedPlanFixture();
    await expect(
      stagedRequest(approved, { name: "foreign-no-import", approvedImport: null }),
    ).rejects.toThrow("native-custody-actor-binding");
    await expect(
      stagedRequest(approved, {
        name: "foreign-ia-plan",
        approvedImport: null,
        taskWorkflow: "ia-plan",
      }),
    ).rejects.toThrow("native-custody-actor-binding");
    // A foreign row carrying an import under an `ia-plan` task does not reach
    // the actor check: the custody parser refuses an approval-ledger row under
    // any task but `site-bootstrap` first.
    await expect(
      stagedRequest(approved, { name: "foreign-ia-plan-import", taskWorkflow: "ia-plan" }),
    ).rejects.toThrow("native-custody-task-input-binding");
  });
});
