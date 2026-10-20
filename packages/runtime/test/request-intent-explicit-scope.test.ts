// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Explicit operator scope is checked at the shipped run boundary, before interpretation. */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { preflightExplicitDocumentationWriteScope } from "../src/cli/first-pass.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { instructionSha256 } from "../src/cli/knowledge-resume.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const knowledgeDirectory = process.env.DOCSFAB_KNOWLEDGE_DIR;

async function fixture(
  documentationRoots?: readonly string[],
  extraFiles: Readonly<Record<string, string>> = {},
) {
  const base = await roots.create("docsfab-explicit-scope-");
  const repositoryPath = join(base, "repository");
  await initFixtureRepo(repositoryPath, {
    "README.md": "# Product\n",
    "docs/a.md": "# Alpha\n",
    ".docsfab.json": `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      ...(documentationRoots ? { documentationRoots } : {}),
    })}\n`,
    ...extraFiles,
  });
  const config: DocsFabConfig = {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory: await roots.create("docsfab-explicit-scope-state-"),
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
  return { repositoryPath, config };
}

function request(
  repositoryPath: string,
  instruction: string,
  workflow: "create-documentation" | "update-documentation" = "create-documentation",
): RunRequestWithPublishProjection {
  return {
    workflow,
    repositoryPath,
    revision: "HEAD",
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    patchOnly: true,
  } as RunRequestWithPublishProjection;
}

function port(reply: string) {
  const calls: string[] = [];
  const interpreter: RequestIntentInterpreterPort = {
    async call() {
      calls.push(reply);
      return { text: reply, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
  return { interpreter, calls };
}

const omitted = JSON.stringify({
  operation: "create",
  targets: [],
  authorityPreference: { preference: "unspecified", quote: null },
});
const returned = JSON.stringify({
  operation: "create",
  targets: [{ path: "README.md", role: "write", chosenFrom: "named", quote: "README.md" }],
  authorityPreference: { preference: "unspecified", quote: null },
});

describe.each(["create-documentation", "update-documentation"] as const)(
  "private negative scope for %s",
  (workflow) => {
    it.each([
      ["./docs/AGENTS.md", ["docs"]],
      ["docs/x/../AGENTS.md", ["docs"]],
      ["docs/ＡGENTS.md", ["docs"]],
      ["guides/WARP.md", ["docs"]],
      ["./docs/AGENTS.md and docs/a.md", ["docs"]],
      ["docs/a.md and ./docs/AGENTS.md", ["docs"]],
      ["docs/../src/x.md and site/content/AGENTS.md", ["site/content"]],
      ["site/content/AGENTS.md and docs/../src/x.md", ["site/content"]],
      ["./docs/../src/x.md and site/content/AGENTS.md", ["site/content"]],
      ["site/content/AGENTS.md and ./docs/../src/x.md", ["site/content"]],
      ["/.git/outside.md and site/content/AGENTS.md", ["site/content"]],
      ["site/content/AGENTS.md and /.git/outside.md", ["site/content"]],
    ] as const)("preserves the private refusal for %s", async (targets, documentationRoots) => {
      const { repositoryPath, config } = await fixture(documentationRoots);
      let interpreterCalls = 0;
      let executionCalls = 0;
      let progressEvents = 0;
      const failure = await executeRunRequest(
        request(
          repositoryPath,
          `${workflow === "create-documentation" ? "Create" : "Update"} ${targets} for developers.`,
          workflow,
        ),
        config,
        {
          onProgress: () => {
            progressEvents += 1;
          },
          harness: {
            runStep: async () => {
              executionCalls += 1;
              throw new TypeError("unexpected workflow execution");
            },
          },
          requestInterpreter: {
            call: async () => {
              interpreterCalls += 1;
              throw new TypeError("unexpected interpretation");
            },
          },
        },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "FirstRunProposalScopeError",
        code: "proposal-scope-unsafe-target",
        phase: "proposal-scope-admission",
        noWorkPerformed: true,
      });
      expect(toOperatorErrorEnvelope(failure)).toMatchObject({
        code: "proposal-scope-unsafe-target",
        failure: { class: "planning-refusal", layer: "cli" },
      });
      expect([interpreterCalls, executionCalls, progressEvents]).toEqual([0, 0, 0]);
      expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
      expect(await readFile(join(repositoryPath, "docs/a.md"), "utf8")).toBe("# Alpha\n");
    });
  },
);

describe.each(["create-documentation", "update-documentation"] as const)(
  "pure outside spelling for %s",
  (workflow) => {
    it.each([
      "./../outside.md",
      "./docs/../src/x.md",
      "/outside.md",
      "/.context/.git/outside.md",
      "/AGENTS.md/.git/outside.md",
    ])("keeps the typed refusal for %s", async (target) => {
      const { repositoryPath, config } = await fixture(["docs"]);
      const model = port(omitted);
      let executionCalls = 0;
      let progressEvents = 0;
      const failure = await executeRunRequest(
        request(
          repositoryPath,
          `${workflow === "create-documentation" ? "Create" : "Update"} ${target} for developers.`,
          workflow,
        ),
        config,
        {
          requestInterpreter: model.interpreter,
          onProgress: () => {
            progressEvents += 1;
          },
          harness: {
            runStep: async () => {
              executionCalls += 1;
              throw new TypeError("unexpected execution");
            },
          },
        },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "request-intent-outside-write-scope" });
      expect(toOperatorErrorEnvelope(failure)).toMatchObject({
        code: "request-intent-outside-write-scope",
        failure: { class: "planning-refusal", layer: "cli" },
      });
      expect((failure as Error).message).toContain(target);
      expect([model.calls.length, executionCalls, progressEvents]).toEqual([0, 0, 0]);
      expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
      expect(await readFile(join(repositoryPath, "docs/a.md"), "utf8")).toBe("# Alpha\n");
    });
  },
);

afterEach(() => {
  process.exitCode = undefined;
  if (knowledgeDirectory === undefined) delete process.env.DOCSFAB_KNOWLEDGE_DIR;
  else process.env.DOCSFAB_KNOWLEDGE_DIR = knowledgeDirectory;
});

describe("explicit create scope before model interpretation", () => {
  it.each(["create-documentation", "update-documentation"] as const)(
    "refuses the unique root README target for %s before interpretation or a saved run",
    async (workflow) => {
      const { repositoryPath, config } = await fixture();
      let calls = 0;
      const failure = await executeRunRequest(
        request(
          repositoryPath,
          `${workflow === "create-documentation" ? "Create" : "Update"} README.md, a developer note describing the greet command.`,
          workflow,
        ),
        config,
        {
          requestInterpreter: {
            call: async () => {
              calls += 1;
              throw new TypeError("unexpected interpretation");
            },
          },
        },
      ).catch((error: unknown) => error);
      expect(toOperatorErrorEnvelope(failure)).toMatchObject({
        code: "request-intent-outside-write-scope",
        failure: { class: "planning-refusal", layer: "cli" },
      });
      expect(calls).toBe(0);
      expect(await readdir(config.stateDirectory)).toEqual([]);
      expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
    },
  );

  it.each([
    {
      instruction: "Update README.md, a developer note describing the greet command.",
      files: { "docs/README.md": "# Documentation\n" },
    },
    {
      instruction: "Update docs/a.md. Consult README.md only as source evidence.",
      files: {},
    },
  ])(
    "keeps ambiguous basenames and README source mentions on interpretation",
    async ({ instruction, files }) => {
      const { repositoryPath, config } = await fixture(undefined, files);
      const sentinel = new TypeError("interpreter reached");
      let calls = 0;
      const failure = await executeRunRequest(
        request(repositoryPath, instruction, "update-documentation"),
        config,
        {
          requestInterpreter: {
            call: async () => {
              calls += 1;
              throw sentinel;
            },
          },
        },
      ).catch((error: unknown) => error);
      expect(failure).toBe(sentinel);
      expect(calls).toBe(1);
    },
  );

  it("uses a witnessed provider result at the shipped call site before an omitted model target", async () => {
    // Contract fixture only: installed qualification must use the canonical provider.
    const provider = await roots.create("docsfab-witness-provider-");
    await mkdir(join(provider, "src"));
    await writeFile(
      join(provider, "src", "first-pass-support.mjs"),
      `
      import { createHash } from "node:crypto";
      export function parseOrdinaryDocumentationRequest({ workflow, instruction, revision, purpose }) {
        if (purpose !== "negative-write-scope") throw new Error("purpose missing");
        return {
          workflow, instruction,
          instructionSha256: createHash("sha256").update(instruction.normalize("NFC")).digest("hex"),
          repositoryRevision: revision,
          targetPaths: [], dependencyPaths: [], scopePurpose: purpose,
          scopeRefusal: "unsafe-target",
        };
      }
    `,
    );
    process.env.DOCSFAB_KNOWLEDGE_DIR = provider;
    const { repositoryPath, config } = await fixture();
    const model = port(omitted);
    const failure = await executeRunRequest(
      request(repositoryPath, "Create README.md, a developer note describing the greet command."),
      config,
      { requestInterpreter: model.interpreter },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "request-intent-outside-write-scope" });
    expect(model.calls).toHaveLength(0);
  });

  it.each([omitted, returned])(
    "classifies the real witnessed README destination as outside the write scope before either model reply",
    async (reply) => {
      const { repositoryPath, config } = await fixture();
      const model = port(reply);
      const failure = await executeRunRequest(
        request(repositoryPath, "Create README.md, a developer note describing the greet command."),
        config,
        { requestInterpreter: model.interpreter },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "request-intent-outside-write-scope" });
      expect(model.calls).toHaveLength(0);
      expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
    },
  );

  it("still interprets a pathless create", async () => {
    const { repositoryPath, config } = await fixture();
    const model = port(omitted);
    const result = await executeRunRequest(
      request(repositoryPath, "Create a developer note describing the greet command."),
      config,
      { requestInterpreter: model.interpreter },
    );
    expect(model.calls).toHaveLength(1);
    expect(result).toMatchObject({ error: "request-intent-target-missing", status: "needs-input" });
  });

  it("keeps an unsafe source mention from becoming a destination refusal", async () => {
    const { repositoryPath, config } = await fixture();
    const model = port(omitted);
    const result = await executeRunRequest(
      request(repositoryPath, "Create docs/new.md. Use ../outside.md only as background evidence."),
      config,
      { requestInterpreter: model.interpreter },
    );
    expect(model.calls).toHaveLength(1);
    expect(result).toMatchObject({ error: "request-intent-target-missing", status: "needs-input" });
  });

  it.each([
    "Create docs/new.md. Consult README.md only as source evidence.",
    "Create docs/new.md. The old instruction said `Create README.md`.",
    "Create docs/new.md. Explain README.md as existing context.",
    "Create docs/new.md. If needed, update README.md later.",
    "Create docs/new.md. Do not edit README.md.",
    "Should we create README.md?",
  ])(
    "does not promote source, negated, or questioned paths to write scope: %s",
    async (instruction) => {
      const { repositoryPath, config } = await fixture();
      const sentinel = new TypeError("interpreter reached");
      let calls = 0;
      const failure = await executeRunRequest(request(repositoryPath, instruction), config, {
        requestInterpreter: {
          call: async () => {
            calls += 1;
            throw sentinel;
          },
        },
      }).catch((error: unknown) => error);
      expect(failure).toBe(sentinel);
      expect(calls).toBe(1);
    },
  );

  it("does not let caller-injected intent bypass the real witnessed destination refusal", async () => {
    const { repositoryPath, config } = await fixture();
    const model = port(omitted);
    const named = request(repositoryPath, "Create README.md for developers.");
    const failure = await executeRunRequest(
      {
        ...named,
        requestIntent: { admission: { outcome: "admitted" } },
      } as RunRequestWithPublishProjection,
      config,
      { requestInterpreter: model.interpreter },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "request-intent-outside-write-scope" });
    expect(model.calls).toHaveLength(0);
  });

  it.each(["create-documentation", "update-documentation"] as const)(
    "lets %s interpret a page with a current-directory prefix",
    async (workflow) => {
      const { repositoryPath, config } = await fixture(["docs"]);
      const sentinel = new TypeError("interpreter reached");
      let calls = 0;
      const failure = await executeRunRequest(
        request(
          repositoryPath,
          `${workflow === "create-documentation" ? "Create" : "Update"} ./docs/x.md for developers.`,
          workflow,
        ),
        config,
        {
          requestInterpreter: {
            call: async () => {
              calls += 1;
              throw sentinel;
            },
          },
        },
      ).catch((error: unknown) => error);
      expect(failure).toBe(sentinel);
      expect(calls).toBe(1);
    },
  );

  it.each(["create-documentation", "update-documentation"] as const)(
    "preserves the absolute %s destination in a refusal",
    async (workflow) => {
      const { repositoryPath, config } = await fixture(["docs"]);
      const model = port(omitted);
      const failure = await executeRunRequest(
        request(
          repositoryPath,
          `${workflow === "create-documentation" ? "Create" : "Update"} /tmp/abs.md for developers.`,
          workflow,
        ),
        config,
        { requestInterpreter: model.interpreter },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "request-intent-outside-write-scope" });
      expect((failure as Error).message).toContain("/tmp/abs.md");
      expect(model.calls).toHaveLength(0);
      expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
    },
  );

  it.each(["../outside.md", "docs/../src/x.md", "docs/../docs/notes.md"])(
    "uses one unsafe-target refusal for %s on create and update",
    async (path) => {
      const outcomes = [];
      for (const workflow of ["create-documentation", "update-documentation"] as const) {
        const { repositoryPath, config } = await fixture(["docs"]);
        const model = port(omitted);
        const failure = await executeRunRequest(
          request(
            repositoryPath,
            `${workflow === "create-documentation" ? "Create" : "Update"} ${path} for developers.`,
            workflow,
          ),
          config,
          { requestInterpreter: model.interpreter },
        ).catch((error: unknown) => error);
        outcomes.push((failure as { code?: string }).code);
        expect(model.calls).toHaveLength(0);
        expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
      }
      expect(outcomes).toEqual([
        "request-intent-outside-write-scope",
        "request-intent-outside-write-scope",
      ]);
    },
  );

  it("allows interpretation of an update to a configured tracked README file root", async () => {
    const { repositoryPath, config } = await fixture(["README.md"]);
    const sentinel = new TypeError("interpreter reached");
    let calls = 0;
    const failure = await executeRunRequest(
      request(repositoryPath, "Update README.md with the greet command.", "update-documentation"),
      config,
      {
        requestInterpreter: {
          call: async () => {
            calls += 1;
            throw sentinel;
          },
        },
      },
    ).catch((error: unknown) => error);
    expect(failure).toBe(sentinel);
    expect(calls).toBe(1);
  });

  it("keeps the existing create write-grant stop before the scope probe", async () => {
    const { repositoryPath, config } = await fixture();
    const model = port(omitted);
    const failure = await executeRunRequest(
      { ...request(repositoryPath, "Create README.md for developers."), allowWrite: false },
      config,
      { requestInterpreter: model.interpreter },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message:
        'Workflow "create-documentation" can modify files. Re-run with --allow-write after reviewing the plan.',
    });
    expect(model.calls).toHaveLength(0);
  });
});

describe("negative-only provider result contract", () => {
  const instruction = "Create docs/new.md for developers.";
  const revision = "a".repeat(40);
  const identity = {
    workflow: "create-documentation" as const,
    instruction,
    instructionSha256: instructionSha256(instruction),
    repositoryRevision: revision,
  };

  async function probe(
    parser: NonNullable<
      Parameters<typeof preflightExplicitDocumentationWriteScope>[0]["ordinaryRequestParser"]
    >,
    documentationRoots?: readonly string[],
  ) {
    const { config } = await fixture();
    return preflightExplicitDocumentationWriteScope({
      request: {
        workflow: "create-documentation",
        instruction,
        instructionContext: "Create README.md from unrelated caller context.",
        allowWrite: true,
      } as RunRequestWithPublishProjection,
      config,
      revision,
      ordinaryRequestParser: parser,
      ...(documentationRoots === undefined ? {} : { documentationRoots }),
    });
  }

  it("accepts only a matching empty-path destination refusal and passes the purpose", async () => {
    let observed: unknown;
    const failure = await probe((input) => {
      observed = input;
      return {
        ...identity,
        targetPaths: [],
        dependencyPaths: [],
        scopePurpose: "negative-write-scope",
        scopeRefusal: "unsafe-target",
      };
    }).catch((error: unknown) => error);
    expect(observed).toEqual({
      workflow: identity.workflow,
      instruction,
      revision,
      purpose: "negative-write-scope",
    });
    expect(failure).toMatchObject({ code: "request-intent-outside-write-scope" });
  });

  it("gives configuration remediation when the internal scope probe has no granted root", async () => {
    const failure = await probe(
      () => ({
        ...identity,
        targetPaths: [],
        dependencyPaths: [],
        scopePurpose: "negative-write-scope",
        scopeRefusal: "unsafe-target",
      }),
      [],
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "request-intent-outside-write-scope",
      nextAction: expect.stringContaining("documentationRoots"),
    });
    expect((failure as { nextAction: string }).nextAction).not.toContain("inside none");
  });

  it.each([
    {
      ...identity,
      targetPaths: ["docs/new.md"],
      dependencyPaths: [],
      scopePurpose: "negative-write-scope",
      scopeRefusal: "unsafe-target",
    },
    {
      ...identity,
      targetPaths: [],
      dependencyPaths: ["docs/source.md"],
      scopePurpose: "negative-write-scope",
      scopeRefusal: "unsafe-target",
    },
    {
      ...identity,
      targetPaths: [],
      dependencyPaths: [],
      scopePurpose: "negative-write-scope",
      scopeRefusal: "other",
    },
    { ...identity, targetPaths: [], scopePurpose: "negative-write-scope" },
    { ...identity, targetPaths: [7], dependencyPaths: [], scopePurpose: "negative-write-scope" },
  ])(
    "rejects malformed refusal results without turning them into scope refusals",
    async (parsed) => {
      const failure = await probe(() => parsed as never).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "knowledge-provider-unavailable" });
    },
  );

  it("propagates mismatched identity and unexpected parser faults", async () => {
    const mismatch = await probe(() => ({
      ...identity,
      repositoryRevision: "other",
      targetPaths: [],
      dependencyPaths: [],
      scopePurpose: "negative-write-scope",
    })).catch((error: unknown) => error);
    expect(mismatch).toMatchObject({ code: "proposal-scope-binding-mismatch" });
    const unexpected = new TypeError("parser defect");
    await expect(
      probe(() => {
        throw unexpected;
      }),
    ).rejects.toBe(unexpected);
  });

  it("does not use a positive parser result as an admitted binding", async () => {
    await expect(
      probe(() => ({
        ...identity,
        targetPaths: ["docs/new.md"],
        dependencyPaths: [],
        scopePurpose: "negative-write-scope",
      })),
    ).resolves.toBeUndefined();
  });

  it("checks witnessed positive destinations only as negative scope evidence", async () => {
    const failure = await probe(() => ({
      ...identity,
      targetPaths: ["README.md"],
      dependencyPaths: [],
      scopePurpose: "negative-write-scope",
    })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "request-intent-outside-write-scope" });
  });

  it("discards unmarked legacy results before inspecting identity or paths", async () => {
    await expect(
      probe(() => ({
        ...identity,
        repositoryRevision: "wrong",
        targetPaths: ["README.md"],
        scopeRefusal: "unsafe-target",
      })),
    ).resolves.toBeUndefined();
  });

  it.each([null, 4, {}, [], "not part of this request.md"])(
    "rejects malformed diagnostic-only spelling without echoing provider data: %j",
    async (originalTarget) => {
      const failure = await probe(
        () =>
          ({
            ...identity,
            targetPaths: [],
            dependencyPaths: [],
            scopePurpose: "negative-write-scope",
            scopeRefusal: "unsafe-target",
            originalTarget,
          }) as never,
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "knowledge-provider-unavailable" });
      expect(String(failure)).not.toContain("not part of this request");
    },
  );

  it("does not execute a diagnostic getter and keeps absent diagnostics compatible", async () => {
    let reads = 0;
    const parsed = {
      ...identity,
      targetPaths: [],
      dependencyPaths: [],
      scopePurpose: "negative-write-scope",
      scopeRefusal: "unsafe-target",
      get originalTarget() {
        reads += 1;
        throw new Error("attacker diagnostic getter");
      },
    };
    const failure = await probe(() => parsed as never).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "knowledge-provider-unavailable" });
    expect(String(failure)).not.toContain("attacker");
    expect(reads).toBe(0);
    const legacy = await probe(() => ({
      ...identity,
      targetPaths: [],
      dependencyPaths: [],
      scopePurpose: "negative-write-scope",
      scopeRefusal: "unsafe-target",
    })).catch((error: unknown) => error);
    expect(legacy).toMatchObject({ code: "request-intent-outside-write-scope" });
  });

  it.each([
    ["update-documentation", true, ["docs/a.rst"], ["docs/a.rst"], true],
    ["create-documentation", true, ["docs/a.rst"], ["docs/a.rst"], false],
    ["update-documentation", false, ["docs/a.rst"], ["docs/a.rst"], false],
    ["update-documentation", true, ["docs/a.rst"], ["docs/other.rst"], false],
    [
      "update-documentation",
      true,
      ["docs/a.rst", "docs/b.rst"],
      ["docs/a.rst", "docs/b.rst"],
      false,
    ],
  ] as const)(
    "keeps exact UPDATE-only RST admission: %s patch=%s paths=%j list=%j",
    async (workflow, patchOnly, targetPaths, rstUpdatePaths, allowed) => {
      const { config } = await fixture(["docs"]);
      const text = `${workflow === "create-documentation" ? "Create" : "Update"} docs/a.rst for developers.`;
      const result = preflightExplicitDocumentationWriteScope({
        request: {
          workflow,
          instruction: text,
          allowWrite: true,
          patchOnly,
        } as RunRequestWithPublishProjection,
        config,
        revision,
        documentationRoots: ["docs"],
        rstUpdatePaths,
        ordinaryRequestParser: () => ({
          workflow,
          instruction: text,
          instructionSha256: instructionSha256(text),
          repositoryRevision: revision,
          targetPaths,
          dependencyPaths: [],
          scopePurpose: "negative-write-scope",
        }),
      });
      if (allowed) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toMatchObject({ code: "proposal-scope-input-invalid" });
    },
  );

  it.each([null, 4, [], "parse-result", new Date(0), Promise.resolve({})])(
    "rejects a non-record provider result as a contract fault: %j",
    async (value) => {
      const failure = await probe(() => value as never).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "knowledge-provider-unavailable" });
    },
  );

  it.each([null, "other", 4, false])("rejects unknown scope purpose %j", async (value) => {
    const failure = await probe(
      () =>
        ({
          ...identity,
          targetPaths: [],
          dependencyPaths: [],
          scopePurpose: value,
        }) as never,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "knowledge-provider-unavailable" });
  });

  it("defers known ordinary-parser refusals but propagates an unrelated coded fault", async () => {
    const ordinary = Object.assign(new Error("legacy ambiguous"), {
      name: "FirstPassSupportError",
      code: "ambiguous-targets",
    });
    await expect(
      probe(() => {
        throw ordinary;
      }),
    ).resolves.toBeUndefined();
    const unrelated = Object.assign(new TypeError("producer defect"), { code: "unsafe-target" });
    await expect(
      probe(() => {
        throw unrelated;
      }),
    ).rejects.toBe(unrelated);
  });
});
