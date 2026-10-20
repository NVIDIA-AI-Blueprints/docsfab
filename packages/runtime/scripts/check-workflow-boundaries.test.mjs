// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";

// Runnable with `node --test` and collectable by Vitest; Vitest's `expect`
// works outside its runner.
const { afterEach, describe, it } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

import { loadLimitDefinitions } from "./check-limits.mjs";
import { WORKFLOW_SCHEMA_FILENAME, checkWorkflowBoundaries } from "./check-workflow-boundaries.mjs";

const FULL_SCAN_CASE = Object.freeze({
  timeout: loadLimitDefinitions().find((entry) => entry.name === "test.ciTimeoutMs").value,
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);
const manifestRoot = join(packageRoot, "workflows");
const sourceRoot = join(packageRoot, "src");
const roots = [];
const exec = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function copyManifests() {
  const parent = await mkdtemp(join(tmpdir(), "docsfab-workflow-boundaries-"));
  roots.push(parent);
  const workflows = join(parent, "workflows");
  await cp(manifestRoot, workflows, { recursive: true });
  return workflows;
}

async function updateEvaluatePrompt(workflows, name, prompt) {
  const path = join(workflows, `${name}.json`);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const step = manifest.steps.find((candidate) => candidate.id === "evaluate-document-quality");
  step.prompt = prompt;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function updateV2Manifest(workflows, mutate = () => undefined) {
  const path = join(workflows, "update-documentation.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function updateV3Manifest(workflows, mutate = () => undefined) {
  const path = join(workflows, "create-documentation.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function checkCopied(workflows) {
  return checkWorkflowBoundaries({
    root: packageRoot,
    manifestRoot: workflows,
    sourceRoot,
  });
}

describe("check-workflow-boundaries", () => {
  it("executes direct and symlinked entry points while imports stay inert", async () => {
    const workflows = await copyManifests();
    const parent = dirname(workflows);
    const scripts = join(parent, "scripts");
    await mkdir(scripts);
    await mkdir(join(parent, "src"));
    const entry = join(scripts, "check-workflow-boundaries.mjs");
    await cp(join(scriptDir, "check-workflow-boundaries.mjs"), entry);
    const linked = join(parent, "check-linked.mjs");
    await symlink(entry, linked);
    for (const path of [entry, linked]) {
      const { stdout } = await exec(process.execPath, [path]);
      expect(stdout.trim()).toBe("Workflow ownership boundaries are clean.");
    }
    for (const argv of [
      undefined,
      join(workflows, "workflow.schema.json"),
      join(parent, "missing.mjs"),
    ]) {
      const { stdout } = await exec(process.execPath, [
        "--input-type=module",
        "-e",
        `process.argv[1] = ${JSON.stringify(argv)}; await import(${JSON.stringify(pathToFileURL(linked).href)}); console.log("imported");`,
      ]);
      expect(stdout.trim()).toBe("imported");
    }
  });

  it("pins the nested composition's declared child and write mode field by field", async () => {
    // Each mutation changes one pinned field of the one manifest that may
    // declare `invokes`. The last row removes `invokes`, still a rejection
    // because the pin is an equality check.
    const nativeStepRejection =
      "Workflow boundary check rejected the declared native step in foundation-to-patch.json.";
    for (const [mutation, message] of [
      [
        { invokes: "update-documentation" },
        'workflows/foundation-to-patch.json.steps[0].invokes must equal "create-documentation" in the runtime workflow manifest.',
      ],
      [{ invokes: undefined }, nativeStepRejection],
      [{ mode: "read-only" }, nativeStepRejection],
      [{ skill: "write-documentation" }, nativeStepRejection],
      [{ operation: "foundation" }, nativeStepRejection],
      [{ kind: "inference" }, nativeStepRejection],
    ]) {
      const workflows = await copyManifests();
      const path = join(workflows, "foundation-to-patch.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      Object.assign(manifest.steps[0], mutation);
      if (mutation.invokes === undefined) delete manifest.steps[0].invokes;
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => checkCopied(workflows)).toThrow(message);
    }
    // Positive control: the unmutated manifest passes the same check.
    const clean = await copyManifests();
    expect(checkCopied(clean)).toMatch(/boundaries are clean/u);
  });

  it("allowlists the checked-in workflow schema beside the closed job-json set", () => {
    expect(checkWorkflowBoundaries({ root: packageRoot })).toMatch(/boundaries are clean/u);
  });

  it("rejects semantic workflow relabeling or write-mode expansion", async () => {
    for (const mutation of [
      { id: "answer-question" },
      { skill: "review-documentation" },
      { mode: "write" },
    ]) {
      const workflows = await copyManifests();
      const path = join(workflows, "reconcile-product-behavior.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      Object.assign(manifest.steps[0], mutation);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => checkCopied(workflows)).toThrow(
        /semantic comparison step binding|read-only evaluate step/u,
      );
    }
  });

  it("rejects an extra key on a public job manifest", async () => {
    const workflows = await copyManifests();
    const path = join(workflows, "review-documentation.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.router = "model-selected";
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => checkCopied(workflows)).toThrow(
      /unsupported by the runtime workflow manifest schema: router/u,
    );
  });

  it("rejects an extra job JSON file", async () => {
    const workflows = await copyManifests();
    await writeFile(join(workflows, "ninth-job.json"), "{}\n");
    expect(() => checkCopied(workflows)).toThrow(/expected exactly/u);
  });

  it("requires bootstrap to retain its exact single guidance writer", async () => {
    const workflows = await copyManifests();
    const path = join(workflows, "bootstrap.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    for (const mutate of [
      (value) => {
        value.steps[0].mode = "read-only";
      },
      (value) => {
        value.steps[0].skill = "write-documentation";
      },
      (value) => {
        value.steps.push({ ...value.steps[0], id: "extra-guidance" });
      },
    ]) {
      const manifest = structuredClone(original);
      mutate(manifest);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => checkCopied(workflows)).toThrow();
    }
  });

  it("requires the template audit to keep its one read-only host-operation step", async () => {
    const workflows = await copyManifests();
    const path = join(workflows, "audit-documentation.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    expect(checkCopied(workflows)).toBe("Workflow ownership boundaries are clean.");
    for (const mutate of [
      (value) => {
        value.steps[0].kind = "evaluate";
      },
      (value) => {
        value.steps[0].mode = "write";
      },
      (value) => {
        value.steps[0].skill = "review-documentation";
      },
      (value) => {
        value.steps[0].searchPlan = "documentation-audit";
        value.steps[0].searchMode = "observe";
      },
      (value) => {
        value.steps.push({ ...value.steps[0], id: "audit-template-conformance-again" });
        value.contextPolicy.steps.push({
          ...value.contextPolicy.steps[0],
          stepId: "audit-template-conformance-again",
        });
      },
    ]) {
      const manifest = structuredClone(original);
      mutate(manifest);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => checkCopied(workflows)).toThrow(
        "Workflow boundary check requires audit-documentation to be one read-only host-operation template audit step.",
      );
    }
  });

  it("rejects a missing job JSON file", async () => {
    const workflows = await copyManifests();
    await rm(join(workflows, "create-documentation.json"));
    expect(() => checkCopied(workflows)).toThrow(/expected exactly/u);
  });

  it("fails closed when the workflow schema file is missing", async () => {
    const workflows = await copyManifests();
    await rm(join(workflows, WORKFLOW_SCHEMA_FILENAME));
    expect(() => checkCopied(workflows)).toThrow(/workflow\.schema\.json/u);
  });

  it("allows evaluate prompts that reference the sealed artifacts and schema", async () => {
    const workflows = await copyManifests();
    await updateEvaluatePrompt(
      workflows,
      "review-documentation",
      "Produce evaluation.json, quality-score.json when available, and quality-report.md. The model writes the report narrative; the host writes the validated result summary.",
    );
    expect(checkCopied(workflows)).toMatch(/boundaries are clean/u);
  });

  it("rejects a copied hard-gate decision policy in an evaluate prompt", async () => {
    const workflows = await copyManifests();
    await updateEvaluatePrompt(
      workflows,
      "review-documentation",
      "Produce evaluation.json, quality-score.json, and quality-report.md. The model writes the report narrative; the host writes the validated result summary. A hard_gate failure forces fail before any other result.",
    );
    expect(() => checkCopied(workflows)).toThrow(/copied hard-gate policy/u);
  });

  it("rejects a copied insufficient-evidence policy in an evaluate prompt", async () => {
    const workflows = await copyManifests();
    await updateEvaluatePrompt(
      workflows,
      "review-documentation",
      "Produce evaluation.json, quality-score.json, and quality-report.md. The model writes the report narrative; the host writes the validated result summary. If a rubric is unavailable, use insufficient evidence.",
    );
    expect(() => checkCopied(workflows)).toThrow(/copied insufficient-evidence policy/u);
  });

  it("accepts the single closed V2 update manifest and validates both selected paths", async () => {
    const workflows = await copyManifests();
    await updateV2Manifest(workflows);
    expect(checkCopied(workflows)).toMatch(/boundaries are clean/u);
  });

  it("rejects an extra V2 branch instead of treating the suffix as permissive", async () => {
    const workflows = await copyManifests();
    await updateV2Manifest(workflows, (manifest) => {
      manifest.branches.push({
        ...manifest.branches[1],
        steps: [...manifest.branches[1].steps],
      });
    });
    expect(() => checkCopied(workflows)).toThrow(/at most 2/u);
  });

  it("requires evaluator prompt policy on the V2 no-change selected path", async () => {
    const workflows = await copyManifests();
    await updateV2Manifest(workflows, (manifest) => {
      const branch = manifest.branches.find((candidate) => candidate.id === "assess-no-change");
      branch.steps.find((step) => step.id === "evaluate-document-quality").prompt =
        "Apply a copied hard gate policy.";
    });
    expect(() => checkCopied(workflows)).toThrow(/required the evaluation\.json/u);
  });

  it("rejects V2 selection or policy paths that do not match actual JSON steps", async () => {
    const workflows = await copyManifests();
    await updateV2Manifest(workflows, (manifest) => {
      manifest.selection.afterStepId = "invented-step";
    });
    expect(() => checkCopied(workflows)).toThrow(/final prefix step/u);

    const policyWorkflows = await copyManifests();
    await updateV2Manifest(policyWorkflows, (manifest) => {
      manifest.branches[0].contextPolicy.steps.reverse();
    });
    expect(() => checkCopied(policyWorkflows)).toThrow(/context policy entries/u);
  });

  it("accepts the closed V3 CREATE topology and validates both selected paths", async () => {
    const workflows = await copyManifests();
    await updateV3Manifest(workflows);
    expect(checkCopied(workflows)).toMatch(/boundaries are clean/u);
  });

  it("rejects a malformed V3 branch selected path", async () => {
    const workflows = await copyManifests();
    await updateV3Manifest(workflows, (manifest) => {
      const retain = manifest.branches.find((branch) => branch.id === "retain");
      retain.steps[0].id = "review-documentation";
      retain.contextPolicy.steps[0].stepId = "review-documentation";
    });
    expect(() => checkCopied(workflows)).toThrow(/duplicate step identity/u);
  });

  it("requires evaluator prompt policy on every V3 selected path", async () => {
    const workflows = await copyManifests();
    await updateV3Manifest(workflows, (manifest) => {
      const revise = manifest.branches.find((branch) => branch.id === "revise");
      revise.steps.find((step) => step.id === "evaluate-document-quality").prompt =
        "Evaluate only from the available evidence.";
    });
    expect(() => checkCopied(workflows)).toThrow(/required the evaluation\.json/u);
  });

  /**
   * Regression cover for `checkHostedManifestShape`, which pins the step mode
   * and kind the host's tool-policy digest does not seal. Without these cases
   * a no-op check leaves the suite green.
   */
  async function updateHostedManifest(workflows, mutate) {
    const path = join(workflows, "live-agent-turn.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    mutate(manifest);
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async function updateNativeManifest(workflows, mutate) {
    const path = join(workflows, "foundation.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    mutate(manifest);
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  // Only the success path walks every TypeScript file under src/, which takes
  // seconds on a loaded machine, so this case gets the CI timeout.
  it(
    "accepts the hosted manifest as checked in, exempt from evaluate-prompt hygiene",
    FULL_SCAN_CASE,
    async () => {
      // Positive control: the hosted manifest has no evaluate-document-quality
      // step, and must not be required to have one.
      const workflows = await copyManifests();
      expect(checkCopied(workflows)).toMatch(/boundaries are clean/u);
    },
  );

  it("rejects a hosted manifest step that can write", async () => {
    const workflows = await copyManifests();
    await updateHostedManifest(workflows, (manifest) => {
      manifest.steps[0].mode = "write";
    });
    expect(() => checkCopied(workflows)).toThrow(/read-only evaluate step with no search plan/u);
  });

  it("rejects a hosted manifest step that declares a search plan", async () => {
    // A search plan adds get_section to the granted set, which is exactly the
    // drift that would break the byte-identical ten-tool identity.
    const workflows = await copyManifests();
    await updateHostedManifest(workflows, (manifest) => {
      manifest.steps[0].searchPlan = "documentation-observation";
      manifest.steps[0].searchMode = "observe";
    });
    expect(() => checkCopied(workflows)).toThrow(/read-only evaluate step with no search plan/u);
  });

  it("rejects a hosted manifest step that is not an evaluate step", async () => {
    const workflows = await copyManifests();
    await updateHostedManifest(workflows, (manifest) => {
      manifest.steps[0].kind = "inference";
    });
    expect(() => checkCopied(workflows)).toThrow(/read-only evaluate step with no search plan/u);
  });

  it("rejects a second step in the hosted manifest", async () => {
    const workflows = await copyManifests();
    await updateHostedManifest(workflows, (manifest) => {
      manifest.steps.push({ ...manifest.steps[0], id: "answer-again" });
      manifest.contextPolicy.steps.push({
        ...manifest.contextPolicy.steps[0],
        stepId: "answer-again",
      });
    });
    expect(() => checkCopied(workflows)).toThrow(/exactly one step in the hosted manifest/u);
  });

  it("rejects a native hosted manifest whose declared step drifts from its executor", async () => {
    // The foundation manifest selects a host executor by name rather than by
    // model choice, so every pinned field is compared. `kind: "inference"` is
    // the field that would hand the step back to the model.
    const workflows = await copyManifests();
    await updateNativeManifest(workflows, (manifest) => {
      manifest.steps[0].kind = "inference";
    });
    expect(() => checkCopied(workflows)).toThrow(
      "Workflow boundary check rejected the declared native step in foundation.json.",
    );
  });

  it("rejects a native operation name the runtime manifest grammar does not install", async () => {
    // Adjacent condition: this one is refused by the shared schema grammar
    // before the native shape rule compares fields, so it names a different error.
    const workflows = await copyManifests();
    await updateNativeManifest(workflows, (manifest) => {
      manifest.steps[0].operation = "shell-command";
    });
    expect(() => checkCopied(workflows)).toThrow(
      "workflows/foundation.json.steps[0].operation must be one of ia-plan, site-bootstrap, foundation, foundation-to-patch in the runtime workflow manifest.",
    );
  });

  it("accepts the native hosted manifest exactly as checked in", async () => {
    // Positive control for both refusals above: the untouched manifest passes.
    const workflows = await copyManifests();
    await updateNativeManifest(workflows, () => undefined);
    expect(checkCopied(workflows)).toMatch(/boundaries are clean/u);
  }, 30_000);
});
