// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { notInterpreted } from "./helpers/first-pass-intent.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { planOperatorNamedPaths } from "../src/cli/run/plan-operator-naming.js";
import { handleDoCommand } from "../src/cli/commands/do.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { OperatorInputResumePlanV1 } from "../src/inputs/operator-input-fill.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import { continueLiveAgentEditorialInputAsk, runBoundedWorkflow } from "../src/live-agent/host.js";
import { planLiveAgentEditorialInputAskTurn } from "../src/live-agent/workflow-delivery.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import { PLAN_TARGET_NOT_NAMED_CODE } from "../src/workflow-execution/plan-binding.js";
import {
  NO_OPERATOR_NAMED_PATHS,
  operatorNamedPaths,
} from "../src/repository/operator-named-paths.js";
import type { RunRecord } from "../src/records/contracts.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import {
  observePublicContract,
  orbitOptionChangeRepository,
} from "./helpers/orbit-option-change-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("operator naming survives its original request", () => {
  it.each([false, true])(
    "a live continuation keeps the original request's naming (named=%s)",
    { timeout: testTimeoutMs(90_000) },
    async (named) => {
      const fixture = await orbitOptionChangeRepository("docsfab-naming-live-continue", roots, {
        files: { "docs/AGENTS.md": "# Instructions\n\nUse --old.\n" },
      });
      const impactSource = await observePublicContract(fixture.repository, fixture.head);
      const instruction = named
        ? "Update docs/AGENTS.md for the new option."
        : "Update the documentation for the new option.";
      const original = await executeRunRequest(
        parseRunArguments([
          "update-documentation",
          "--repo",
          fixture.repository,
          "--instruction",
          instruction,
          "--patch-only",
          "--revision",
          fixture.head,
          "--comparison-base",
          fixture.base,
          "--reader-source",
          "current-documentation=docs/cli.md",
        ]),
        fixture.config,
        {
          silent: true,
          harness: new EditorialProtocolHarness({
            candidate: "no-change",
            impactSource,
            plannerPages: [
              { path: "docs/absent.md", disposition: "retain" },
              { path: "docs/cli.md", disposition: "retain" },
              { path: "docs/AGENTS.md", disposition: "retain" },
            ],
          }),
        },
      );
      expect(original?.status, original?.error).toBe("needs-input");
      const turn = await planLiveAgentEditorialInputAskTurn({
        stateDirectory: fixture.config.stateDirectory,
        repositoryPath: fixture.repository,
        revision: "HEAD",
        replyText: "src/orbit.ts",
      });
      expect(turn.kind).toBe("input-ask-resume");
      if (turn.kind !== "input-ask-resume") throw new Error("No live continuation was planned.");
      const harness = new EditorialProtocolHarness({
        candidate: "update",
        impactSource,
        writePlannedPages: true,
        plannerPages: [{ path: "docs/AGENTS.md", disposition: "update" }],
      });
      const continued = await continueLiveAgentEditorialInputAsk(turn.plan, {
        repositoryPath: fixture.repository,
        allowWrite: true,
        config: fixture.config,
        persist: async () => ({ status: "not-needed" }),
        runWorkflow: (request) => runBoundedWorkflow({ ...request, executionHarness: harness }),
      });
      if (named) {
        expect(continued.status, continued.error).toBe("succeeded");
        expect(continued.changes?.files.map((file) => file.path)).toContain("docs/AGENTS.md");
      } else {
        expect(readRunFailure(continued)?.code).toBe(PLAN_TARGET_NOT_NAMED_CODE);
        expect(harness.stepIds).not.toContain("write-documentation");
      }
    },
  );

  it("walks two supersessions to the first explicit target and ignores intermediate targets", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-naming-chain-"));
    roots.push(stateDirectory);
    const instruction = "Update the selected documentation.";
    const knowledgeMarker = notInterpreted("continuation");
    const continuation = {
      ...knowledgeMarker,
      admission: { ...knowledgeMarker.admission, reason: "operator-input-resume" },
    };
    const records = [
      { id: "first", instruction, operatorTargetPaths: ["docs/AGENTS.md"] },
      {
        id: "middle",
        instruction,
        operatorTargetPaths: ["docs/CLAUDE.md"],
        requestIntent: continuation,
      },
      {
        id: "last",
        instruction,
        operatorTargetPaths: ["docs/WARP.md"],
        requestIntent: continuation,
      },
    ];
    for (const record of records)
      await writeFile(join(stateDirectory, `${record.id}.json`), JSON.stringify(record));
    await mkdir(join(stateDirectory, "input-ask-supersession"));
    for (const [originalRunId, supersededBy] of [
      ["first", "middle"],
      ["middle", "last"],
    ]) {
      await writeFile(
        join(stateDirectory, "input-ask-supersession", `${originalRunId}.1.json`),
        JSON.stringify({
          schemaVersion: 1,
          sequence: 1,
          kind: "docsfab-input-ask-supersession",
          originalRunId,
          supersededBy,
        }),
      );
    }
    const named = await planOperatorNamedPaths({
      request: {
        instruction,
        operatorInputResume: {
          originalRunId: "last",
          workflow: "update-documentation",
          instruction,
          instructionSha256: "e".repeat(64),
          repositoryPath: "/fixture/repository",
          revision: "f".repeat(40),
          fills: [],
          skipPlanner: false,
          skipSearchObserve: false,
          revalidate: true,
          verifiedNoChange: false,
          readerSources: [],
          slots: [],
        },
      },
      stateDirectory,
      trackedPaths: ["docs/AGENTS.md", "docs/CLAUDE.md", "docs/WARP.md"],
    });
    expect(
      named.names("docs/AGENTS.md"),
      "only the first request's explicit input grants naming",
    ).toBe(true);
    expect(named.names("docs/CLAUDE.md")).toBe(false);
    expect(named.names("docs/WARP.md")).toBe(false);
  });

  it("the real writer retains an explicit target for do --continue", {
    timeout: testTimeoutMs(90_000),
  }, async () => {
    const fixture = await orbitOptionChangeRepository("docsfab-naming-original-target", roots, {
      files: { "docs/AGENTS.md": "# Instructions\n\nThe option is --old.\n" },
    });
    const impactSource = await observePublicContract(fixture.repository, fixture.head);
    const instruction = "Update the selected documentation for the new option.";
    const original = await executeRunRequest(
      parseRunArguments([
        "update-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        instruction,
        "--patch-only",
        "--comparison-workspace",
        "--context-path",
        "docs/AGENTS.md",
        "--reader-source",
        "current-documentation=docs/cli.md",
      ]),
      fixture.config,
      {
        silent: true,
        harness: new EditorialProtocolHarness({
          candidate: "no-change",
          impactSource,
          plannerPages: [
            { path: "docs/absent.md", disposition: "retain" },
            { path: "docs/AGENTS.md", disposition: "retain" },
            { path: "docs/cli.md", disposition: "retain" },
          ],
        }),
      },
    );
    expect(original?.status, original?.error).toBe("needs-input");
    const saved = JSON.parse(
      await readFile(join(fixture.config.stateDirectory, `${original!.id}.json`), "utf8"),
    );
    expect(
      saved.operatorTargetPaths,
      "the writer must save only the operator's explicit target",
    ).toEqual(["docs/AGENTS.md"]);
    let continued: RunRecord | undefined;
    await handleDoCommand(
      [
        "--repo",
        fixture.repository,
        "--continue",
        original!.id,
        "--attach",
        "src/orbit.ts",
        "--patch-only",
        "--quiet",
      ],
      {
        stateDirectory: fixture.config.stateDirectory,
        runWorkflow: async (request) => {
          continued = await executeRunRequest(request, fixture.config, {
            silent: true,
            harness: new EditorialProtocolHarness({
              candidate: "update",
              impactSource,
              writePlannedPages: true,
              plannerPages: [{ path: "docs/AGENTS.md", disposition: "update" }],
            }),
          });
          return continued;
        },
      },
    );
    expect(continued?.status, continued?.error).toBe("succeeded");
    expect(continued?.changes?.files.map((file) => file.path)).toContain("docs/AGENTS.md");
    expect(
      continued?.operatorTargetPaths,
      "a continuation record must retain first-request explicit targets for literal NEXT",
    ).toEqual(["docs/AGENTS.md"]);
  });

  it("retains the original explicit target input when an InputAsk continuation resumes", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-operator-naming-"));
    roots.push(stateDirectory);
    const instruction = "Update the selected documentation for the new option.";
    await writeFile(
      join(stateDirectory, "original-target.json"),
      JSON.stringify({
        id: "original-target",
        instruction,
        operatorTargetPaths: ["docs/AGENTS.md"],
      }),
    );
    await writeFile(
      join(stateDirectory, "other-target.json"),
      JSON.stringify({
        id: "other-target",
        instruction,
        operatorTargetPaths: ["docs/CLAUDE.md"],
      }),
    );
    const resume: OperatorInputResumePlanV1 = {
      originalRunId: "original-target",
      workflow: "update-documentation",
      instruction,
      instructionSha256: "a".repeat(64),
      repositoryPath: "/fixture/repository",
      revision: "b".repeat(40),
      fills: [],
      skipPlanner: false,
      skipSearchObserve: false,
      revalidate: true,
      verifiedNoChange: false,
      readerSources: [],
      slots: [],
    };
    const named = await planOperatorNamedPaths({
      request: { instruction, operatorInputResume: resume },
      stateDirectory,
      trackedPaths: ["docs/AGENTS.md", "docs/CLAUDE.md"],
    });
    expect(
      named.names("docs/AGENTS.md"),
      "the original explicit target must survive continuation",
    ).toBe(true);
    expect(named.names("docs/CLAUDE.md"), "another run must not contribute naming authority").toBe(
      false,
    );
    expect(
      JSON.parse(await readFile(join(stateDirectory, "original-target.json"), "utf8"))
        .operatorTargetPaths,
    ).toEqual(["docs/AGENTS.md"]);
  });

  it("fails closed when the original request record cannot be walked (control)", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-operator-naming-missing-"));
    roots.push(stateDirectory);
    const resume = {
      originalRunId: "missing-original",
      workflow: "update-documentation",
      instruction: "Update docs/AGENTS.md.",
      instructionSha256: "c".repeat(64),
      repositoryPath: "/fixture/repository",
      revision: "d".repeat(40),
      fills: [],
      skipPlanner: false,
      skipSearchObserve: false,
      revalidate: true,
      verifiedNoChange: false,
      readerSources: [],
      slots: [],
    } as const;
    const named = await planOperatorNamedPaths({
      request: { instruction: resume.instruction, operatorInputResume: resume },
      stateDirectory,
      trackedPaths: ["docs/AGENTS.md"],
    });
    expect(named.names("docs/AGENTS.md")).toBe(false);
  });
});

describe("a live edit names the complete hidden path", () => {
  it("does not treat the documentation root as naming every hidden file beneath it", () => {
    const scope = new DocumentationScope();
    expect(
      scope.allowsDirectEdit("docs/.operator-notes/guide.md", NO_OPERATOR_NAMED_PATHS),
      "a directory grant must not name its hidden descendants",
    ).toBe(false);
  });

  it("permits the exact named file under the same documentation root (control)", () => {
    const scope = new DocumentationScope();
    const named = operatorNamedPaths({ texts: ["Update docs/.operator-notes/guide.md."] });
    expect(scope.allowsDirectEdit("docs/.operator-notes/guide.md", named)).toBe(true);
    expect(scope.allowsDirectEdit("docs/.operator-notes/other.md", named)).toBe(false);
  });

  it("keeps normal pages and an agents directory writable without naming (control)", () => {
    const scope = new DocumentationScope();
    for (const path of ["docs/guide.md", "docs/agents-guide.md", "docs/agents/index.md"]) {
      expect(scope.allowsDirectEdit(path, NO_OPERATOR_NAMED_PATHS), path).toBe(true);
    }
  });
});
