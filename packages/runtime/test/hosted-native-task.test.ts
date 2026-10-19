// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  parseHostRuntimeNativeTask,
  sealHostRuntimeNativeTask,
} from "../src/host-invoker/native-task.js";
import { HostRuntimeContractError } from "../src/host-invoker/contract-error.js";
import { ArtifactValidationError } from "../src/artifacts/contracts.js";
import { configureCredential } from "./helpers/configured-credential.js";

const reference = {
  receiptLocator: `cas:${"a".repeat(32)}:${"b".repeat(64)}`,
  artifactSha256: "c".repeat(64),
};

/**
 * Refusals assert the exact `HostRuntimeContractError.code`: the same call can
 * fail at the inert/credential gate, at `kit.string`, or at the rule under
 * test, and only the code tells them apart.
 */
function contractCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof HostRuntimeContractError) return error.code;
    throw error;
  }
  return "no-refusal";
}

/**
 * A `site-bootstrap` plan reference is validated by the artifact contract, not
 * the native-task kit, so it surfaces as `ArtifactValidationError`, the class
 * the host-side `catch` in `parseJobNativeTask` / `parseSlackNativeTask`
 * handles.
 */
function artifactCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ArtifactValidationError) return error.code;
    throw error;
  }
  return "no-refusal";
}

const patchTask = {
  workflow: "foundation-to-patch" as const,
  task: { kind: "foundation-to-patch" as const, intendedPaths: ["docs/guide.md"] },
  inputs: [reference],
};

describe("hosted native task selection", () => {
  it("preserves the canonical IA scope and target relation", () => {
    for (const workflow of ["ia-analysis", "ia-plan"] as const) {
      // `scope === "site"` must carry no target; `section`/`page` must carry
      // one. Both halves of that relation are asserted.
      expect(
        contractCode(() =>
          sealHostRuntimeNativeTask({
            workflow,
            task: {
              kind: "ia-plan",
              scope: "site",
              mode: "create",
              target: { sourcePath: "docs/" },
            } as never,
            inputs: [],
          }),
        ),
      ).toBe("native-task-ia-target-binding");
      for (const scope of ["section", "page"] as const) {
        expect(
          contractCode(() =>
            sealHostRuntimeNativeTask({
              workflow,
              task: { kind: "ia-plan", scope, mode: "reevaluate" },
              inputs: [],
            }),
          ),
        ).toBe("native-task-ia-target-binding");
      }
      // Candidate-parent fields are not part of the canonical hosted target.
      expect(
        contractCode(() =>
          sealHostRuntimeNativeTask({
            workflow,
            task: {
              kind: "ia-plan",
              scope: "page",
              mode: "reevaluate",
              target: { sourcePath: "docs/a.md", candidateParentPath: "docs/b.md" },
            } as never,
            inputs: [],
          }),
        ),
      ).toBe("native-task-invalid-shape");
      expect(
        sealHostRuntimeNativeTask({
          workflow,
          task: { kind: "ia-plan", scope: "site", mode: "create" },
          inputs: [],
        }).task,
      ).toEqual({ kind: "ia-plan", scope: "site", mode: "create" });
    }
    // An unknown scope is an enumeration refusal, not a target-binding refusal.
    expect(
      contractCode(() =>
        sealHostRuntimeNativeTask({
          workflow: "ia-plan",
          task: { kind: "ia-plan", scope: "chapter", mode: "create" } as never,
          inputs: [],
        }),
      ),
    ).toBe("native-task-invalid-value");
  });

  it("retains an exact selected input and domain task without creating authority", () => {
    const task = sealHostRuntimeNativeTask({
      workflow: "ia-plan",
      task: {
        kind: "ia-plan",
        scope: "section",
        mode: "reevaluate",
        target: { sourcePath: "docs/guide.md", anchor: "installation" },
      },
      inputs: [reference],
    });
    expect(parseHostRuntimeNativeTask(JSON.parse(JSON.stringify(task)))).toEqual(task);
    expect(Object.isFrozen(task.task)).toBe(true);
    expect(Object.isFrozen(task.inputs)).toBe(true);
    expect(task).not.toHaveProperty("authorization");
  });

  it("binds identical IA task shapes to the selected analysis or planning workflow", () => {
    const input = {
      task: { kind: "ia-plan" as const, scope: "site" as const, mode: "create" as const },
      inputs: [],
    };
    const analysis = sealHostRuntimeNativeTask({ ...input, workflow: "ia-analysis" });
    const planning = sealHostRuntimeNativeTask({ ...input, workflow: "ia-plan" });
    expect(analysis.taskSha256).not.toBe(planning.taskSha256);
    expect(
      contractCode(() => parseHostRuntimeNativeTask({ ...analysis, workflow: "ia-plan" })),
    ).toBe("native-task-digest-mismatch");
  });

  it("refuses task-supplied approvals, policies, host paths and workflow substitution", () => {
    for (const extra of [
      { authorization: { decidedAt: "2026-09-22T00:00:00.000Z" } },
      { allowWrite: true },
      { reviewerPolicy: {} },
      { artifactRoot: "/srv/foreign" },
    ]) {
      expect(
        contractCode(() =>
          sealHostRuntimeNativeTask({
            ...patchTask,
            task: { ...patchTask.task, ...extra } as never,
          }),
        ),
      ).toBe("native-task-invalid-shape");
    }
    // One violating character per case, so each clause of `repositoryPath` has
    // its own assertion.
    for (const path of [
      "/etc/passwd",
      "../foreign.md",
      "docs/../foreign.md",
      "docs//guide.md",
      "C:\\secret",
      "docs\\guide.md",
      "docs/a:b.md",
    ]) {
      expect(
        contractCode(() =>
          sealHostRuntimeNativeTask({
            ...patchTask,
            task: { ...patchTask.task, intendedPaths: [path] },
          }),
        ),
      ).toBe("native-task-repository-path");
    }
    // A NUL byte is refused one layer earlier, by `kit.string`, so it carries
    // the generic value code and `repositoryPath` needs no NUL clause.
    expect(
      contractCode(() =>
        sealHostRuntimeNativeTask({
          ...patchTask,
          task: { ...patchTask.task, intendedPaths: ["docs/\0guide.md"] },
        }),
      ),
    ).toBe("native-task-invalid-value");
    // A `Users/` segment and a dotted directory are ordinary tracked
    // documentation.
    expect(
      sealHostRuntimeNativeTask({
        ...patchTask,
        task: { ...patchTask.task, intendedPaths: ["docs/Users/index.md", "docs/v1.2/guide.md"] },
      }).task,
    ).toEqual({
      kind: "foundation-to-patch",
      intendedPaths: ["docs/Users/index.md", "docs/v1.2/guide.md"],
    });
    for (const intendedPaths of [[], ["docs/a.md", "docs/a.md"]]) {
      expect(
        contractCode(() =>
          sealHostRuntimeNativeTask({ ...patchTask, task: { ...patchTask.task, intendedPaths } }),
        ),
      ).toBe("native-task-intended-paths");
    }
    // Workflow substitution: a `foundation-to-patch` body under `foundation`
    // carries a key `foundation` does not have, so the shape rule catches it.
    expect(
      contractCode(() => sealHostRuntimeNativeTask({ ...patchTask, workflow: "foundation" })),
    ).toBe("native-task-invalid-shape");
    // A same-shaped body whose `kind` does not match the workflow is refused by
    // the binding rule, not the shape rule.
    expect(
      contractCode(() =>
        sealHostRuntimeNativeTask({
          workflow: "foundation",
          task: { kind: "foundation-to-patch" } as never,
          inputs: [],
        }),
      ),
    ).toBe("native-task-workflow-binding");
    expect(
      contractCode(() =>
        sealHostRuntimeNativeTask({ ...patchTask, inputs: [reference, { ...reference }] }),
      ),
    ).toBe("native-task-duplicate-input");
    // Two different retained inputs are not a duplicate.
    expect(
      sealHostRuntimeNativeTask({
        ...patchTask,
        inputs: [reference, { ...reference, artifactSha256: "d".repeat(64) }],
      }).inputs,
    ).toHaveLength(2);
  });

  it("refuses a configured credential in a documentation path in either task shape", () => {
    // Every shape is built from repeated characters, so this source file
    // carries no token-shaped literal of its own.
    const filler = "a".repeat(20);
    // A credential shape alone seals (#1807); only a configured credential is
    // refused, so each shape below is configured first.
    expect(
      sealHostRuntimeNativeTask({
        ...patchTask,
        task: { ...patchTask.task, intendedPaths: [`docs/glpat-${filler}.md`] },
      }).task,
    ).toEqual({ kind: "foundation-to-patch", intendedPaths: [`docs/glpat-${filler}.md`] });
    for (const shape of [
      `glpat-${filler}`,
      `github_pat_${filler}`,
      `xoxb-${filler}`,
      `nvapi-${filler}`,
      `sk-proj-${filler}`,
    ]) {
      configureCredential(shape);
    }
    // One shape per runtime credential rule a repository-relative path can
    // spell. `repositoryPath` accepts all of them, so
    // `kit.rejectCredentials(input)` in `sealHostRuntimeNativeTask` is the rule
    // that refuses them.
    const credentialPaths = [
      `docs/glpat-${filler}.md`,
      `docs/github_pat_${filler}.md`,
      `docs/xoxb-${filler}.md`,
      `docs/nvapi-${filler}.md`,
      `docs/sk-proj-${filler}.md`,
    ];
    for (const path of credentialPaths) {
      expect(
        contractCode(() =>
          sealHostRuntimeNativeTask({
            ...patchTask,
            task: { ...patchTask.task, intendedPaths: [path] },
          }),
        ),
      ).toBe("native-task-credential-material");
      expect(
        contractCode(() =>
          sealHostRuntimeNativeTask({
            workflow: "ia-plan",
            task: { kind: "ia-plan", scope: "page", mode: "create", target: { sourcePath: path } },
            inputs: [reference],
          }),
        ),
      ).toBe("native-task-credential-material");
    }
    // The free-text `anchor` is screened by the same rule.
    expect(
      contractCode(() =>
        sealHostRuntimeNativeTask({
          workflow: "ia-plan",
          task: {
            kind: "ia-plan",
            scope: "page",
            mode: "create",
            target: { sourcePath: "docs/guide.md", anchor: `glpat-${filler}` },
          },
          inputs: [reference],
        }),
      ),
    ).toBe("native-task-credential-material");
    // A piece of a configured credential, here its first 25 characters, is
    // refused too, so a truncated copy cannot pass.
    const truncated = `docs/glpat-${"a".repeat(19)}.md`;
    expect(
      contractCode(() =>
        sealHostRuntimeNativeTask({
          ...patchTask,
          task: { ...patchTask.task, intendedPaths: [truncated] },
        }),
      ),
    ).toBe("native-task-credential-material");
    // The runtime scanner has no `label=value` assigned-secret rule, so this
    // shape is sealed unrefused here. The Slack grammar re-applies its own
    // credential screen for these parameters
    // (`packages/host/src/slack-slash/native-task.ts`); if the runtime scanner
    // learns the shape, this fails and that host comment needs revisiting.
    const assignedSecretPath = "docs/token=abcdefgh.md";
    expect(
      sealHostRuntimeNativeTask({
        ...patchTask,
        task: { ...patchTask.task, intendedPaths: [assignedSecretPath] },
      }).task,
    ).toEqual({ kind: "foundation-to-patch", intendedPaths: [assignedSecretPath] });
  });

  it("requires an exact retained receipt reference and rejects task or artifact tampering", () => {
    const task = sealHostRuntimeNativeTask({
      workflow: "foundation",
      task: { kind: "foundation" },
      inputs: [reference],
    });
    for (const locator of ["file:///etc/passwd", "/srv/artifacts/result.json", "cas:bad:bad"]) {
      expect(
        contractCode(() =>
          sealHostRuntimeNativeTask({
            workflow: "foundation",
            task: { kind: "foundation" },
            inputs: [{ ...reference, receiptLocator: locator }],
          }),
        ),
      ).toBe("native-task-receipt-locator");
    }
    for (const tampered of [
      { ...task, inputs: [{ ...reference, artifactSha256: "d".repeat(64) }] },
      { ...task, inputs: [] },
    ]) {
      expect(contractCode(() => parseHostRuntimeNativeTask(tampered))).toBe(
        "native-task-digest-mismatch",
      );
    }
    expect(contractCode(() => parseHostRuntimeNativeTask({ ...task, schemaVersion: 2 }))).toBe(
      "native-task-schema-version",
    );
    // Positive control: the untampered record round-trips.
    expect(parseHostRuntimeNativeTask(JSON.parse(JSON.stringify(task)))).toEqual(task);
  });

  it("uses the existing sealed IA-plan artifact reference for site input without trusting approval", () => {
    const plan = {
      kind: "ia-plan" as const,
      schemaVersion: 1 as const,
      digest: "d".repeat(64),
      repositoryRevision: "e".repeat(40),
      repositoryContentDigest: "f".repeat(64),
    };
    const task = sealHostRuntimeNativeTask({
      workflow: "site-bootstrap",
      task: { kind: "site-bootstrap", plan },
      inputs: [reference],
    });
    expect(parseHostRuntimeNativeTask(task).task).toEqual({ kind: "site-bootstrap", plan });
    // The plan reference is validated by the artifact contract, so these
    // refusals are `ArtifactValidationError`, not `HostRuntimeContractError`.
    expect(
      artifactCode(() =>
        sealHostRuntimeNativeTask({
          workflow: "site-bootstrap",
          task: { kind: "site-bootstrap", plan: { ...plan, approved: true } } as never,
          inputs: [reference],
        }),
      ),
    ).toBe("unknown-field");
    expect(
      artifactCode(() =>
        sealHostRuntimeNativeTask({
          workflow: "site-bootstrap",
          task: { kind: "site-bootstrap", plan: { ...plan, digest: "not-a-digest" } } as never,
          inputs: [reference],
        }),
      ),
    ).toBe("invalid-type");
  });
});
