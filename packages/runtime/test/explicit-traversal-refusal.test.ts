// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** The real canonical supplier refuses requested unsafe destinations before the model runs. */
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { ExplicitDocumentationWriteScopeError } from "../src/cli/first-pass.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const omitted = JSON.stringify({
  operation: "create",
  targets: [],
  authorityPreference: { preference: "unspecified", quote: null },
});

async function fixture(
  documentationRoots?: readonly string[],
  extraFiles: Readonly<Record<string, string>> = {},
) {
  const base = await roots.create("docsfab-traversal-scope-");
  const repositoryPath = join(base, "repository");
  await initFixtureRepo(repositoryPath, {
    "README.md": "# Product\n",
    "docs/a.md": "# Alpha\n",
    ...extraFiles,
    ".docsfab.json": `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      ...(documentationRoots ? { documentationRoots } : {}),
    })}\n`,
  });
  const config: DocsFabConfig = {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory: await roots.create("docsfab-traversal-state-"),
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
  return { base, repositoryPath, config };
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

function interpreter(reply: string) {
  let calls = 0;
  const port: RequestIntentInterpreterPort = {
    async call() {
      calls += 1;
      return { text: reply, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
  return {
    port,
    get calls() {
      return calls;
    },
  };
}

function expectOutsideWriteScopeRefusal(failure: unknown, context?: string) {
  expect(failure, context).toBeInstanceOf(ExplicitDocumentationWriteScopeError);
  expect(failure, context).toMatchObject({
    code: "request-intent-outside-write-scope",
    nextAction: expect.stringContaining("documentationRoots"),
  });
}

it.each([
  ["create-documentation", "../outside.md", "omitted"],
  ["create-documentation", "../outside.md", "returned"],
  ["create-documentation", "docs/../src/x.md", "omitted"],
  ["create-documentation", "docs/../src/x.md", "returned"],
  ["update-documentation", "../outside.md", "omitted"],
  ["update-documentation", "../outside.md", "returned"],
  ["update-documentation", "docs/../src/x.md", "omitted"],
  ["update-documentation", "docs/../src/x.md", "returned"],
] as const)("refuses %s destination %s before %s model reply", async (workflow, path, proposal) => {
  const { base, repositoryPath, config } = await fixture();
  const reply =
    proposal === "omitted"
      ? omitted
      : JSON.stringify({
          operation: workflow === "create-documentation" ? "create" : "update",
          targets: [{ path, role: "write", chosenFrom: "named", quote: path }],
          authorityPreference: { preference: "unspecified", quote: null },
        });
  const model = interpreter(reply);
  const instruction = `${workflow === "create-documentation" ? "Create" : "Update"} ${path} with release notes.`;
  const failure = await executeRunRequest(request(repositoryPath, instruction, workflow), config, {
    requestInterpreter: model.port,
  }).catch((error: unknown) => error);
  expectOutsideWriteScopeRefusal(failure);
  expect(model.calls).toBe(0);
  expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
  expect(await readFile(join(repositoryPath, "docs/a.md"), "utf8")).toBe("# Alpha\n");
  await expect(access(join(base, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(join(repositoryPath, "src/x.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

describe("adjacent real-supplier routes", () => {
  it.each([
    "Create docs/new.md and create a guide using README.md.",
    "Create docs/new.md and create a guide using docs/../private.md.",
    "Create docs/new.md and create a guide based on README.md.",
    "Create pages under docs/using/: a.md, b.md; create a guide using README.md.",
    "Create docs/new.md, then `Update ../outside.md` was the old instruction.",
    "Create docs/new.md and create a guide using README.md, then create docs/second.md.",
    "Create docs/new.md and create a summary of README.md in docs/summary.md.",
    "Create docs/new.md and create a summary of the README.md file in docs/summary.md.",
    "Create docs/new.md and create a summary of `README.md` in docs/summary.md.",
    "Create docs/new.md and create a summary of docs/../private.md in docs/summary.md.",
  ])("keeps a later source clause out of early refusal: %s", async (instruction) => {
    const { base, repositoryPath, config } = await fixture();
    const model = interpreter(omitted);
    const result = await executeRunRequest(request(repositoryPath, instruction), config, {
      requestInterpreter: model.port,
    });
    expect(model.calls).toBe(1);
    expect(result).toMatchObject({ error: "request-intent-target-missing", status: "needs-input" });
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
    await expect(access(join(base, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "Create docs/new.md and create a guide using README.md, then update ../outside.md.",
    "Create docs/new.md and create a guide using README.md. Create README.md.",
    "Create docs/new.md and create a guide using README.md. Update docs/../src/x.md.",
    "Create docs/new.md using evidence and update ../outside.md.",
    "Create docs/new.md using evidence and update docs/../src/x.md.",
    "Create two pages under docs/guides/: a.md, b.md using evidence and update ../outside.md.",
    "Create docs/new.md, then update `../outside.md`.",
    "Create docs/new.md using evidence and update src/new.md.",
    "Create docs/new.md and create a summary of README.md in src/summary.md.",
    "Create docs/new.md and create a summary of README.md in ../outside.md.",
    "Create docs/new.md and create README.md.",
    "Create pages under ../using/: a.md, b.md; create a guide using README.md.",
  ])("still refuses a later actual write or raw unsafe list: %s", async (instruction) => {
    const { base, repositoryPath, config } = await fixture();
    const model = interpreter(omitted);
    const failure = await executeRunRequest(request(repositoryPath, instruction), config, {
      requestInterpreter: model.port,
    }).catch((error: unknown) => error);
    expectOutsideWriteScopeRefusal(failure);
    expect(model.calls).toBe(0);
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
    await expect(access(join(base, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a later Update source clause in the ordinary model route", async () => {
    const { repositoryPath, config } = await fixture();
    const sentinel = new TypeError("later Update source reached interpretation");
    let calls = 0;
    const result = await executeRunRequest(
      request(
        repositoryPath,
        "Update docs/a.md and update a guide using README.md.",
        "update-documentation",
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
    expect(calls).toBe(1);
    expect(result).toBe(sentinel);
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
  });

  it.each([
    "Create a guide using README.md.",
    "Create a guide based on README.md.",
    "Create a guide with evidence from README.md.",
    "Create a guide according to README.md.",
    "Create a guide using docs/../private.md.",
    "Create a guide based on docs/../private.md.",
    "Create a guide using docs/source.md and ../outside.md.",
  ])("keeps first source-only mention out of early write refusal: %s", async (instruction) => {
    const { base, repositoryPath, config } = await fixture();
    const model = interpreter(omitted);
    const result = await executeRunRequest(request(repositoryPath, instruction), config, {
      requestInterpreter: model.port,
    });
    expect(model.calls).toBe(1);
    expect(result).toMatchObject({ error: "request-intent-target-missing", status: "needs-input" });
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
    await expect(access(join(base, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "Create a guide quoting `Update README.md`.",
    "Create a guide quoting `Update ../outside.md`.",
  ])("defers a quoted historical first path to interpretation: %s", async (instruction) => {
    const { repositoryPath, config } = await fixture();
    const sentinel = new TypeError("quoted history reached interpretation");
    let calls = 0;
    const failure = await executeRunRequest(request(repositoryPath, instruction), config, {
      requestInterpreter: {
        call: async () => {
          calls += 1;
          throw sentinel;
        },
      },
    }).catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(failure).toBe(sentinel);
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
  });

  it.each([
    "Create a guide using evidence and create README.md.",
    "Create a guide based on evidence and update ../outside.md.",
    "Create a guide with evidence from notes and update docs/../src/x.md.",
  ])("refuses a real write after an initial source cue: %s", async (instruction) => {
    const { base, repositoryPath, config } = await fixture();
    const model = interpreter(omitted);
    const failure = await executeRunRequest(request(repositoryPath, instruction), config, {
      requestInterpreter: model.port,
    }).catch((error: unknown) => error);
    expectOutsideWriteScopeRefusal(failure);
    expect(model.calls).toBe(0);
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
    await expect(access(join(base, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(repositoryPath, "src/x.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps an initial Update source out of early refusal while retaining a later traversal write", async () => {
    for (const [instruction, refuses] of [
      ["Update a guide using docs/../private.md.", false],
      ["Update a guide using evidence and update ../outside.md.", true],
    ] as const) {
      const { base, repositoryPath, config } = await fixture();
      const sentinel = new TypeError("Update interpretation reached");
      let calls = 0;
      const result = await executeRunRequest(
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
      if (refuses) {
        expectOutsideWriteScopeRefusal(result);
        expect(calls).toBe(0);
      } else {
        expect(result).toBe(sentinel);
        expect(calls).toBe(1);
      }
      expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
      await expect(access(join(base, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("checks a proven later write against configured roots without guessing source paths", async () => {
    for (const [instruction, refuses] of [
      ["Create a guide using README.md and update docs/a.md.", false],
      ["Create a guide using README.md and update fern/new.md.", true],
    ] as const) {
      const { repositoryPath, config } = await fixture(["docs"]);
      const sentinel = new TypeError("configured-root interpretation reached");
      let calls = 0;
      const result = await executeRunRequest(request(repositoryPath, instruction), config, {
        requestInterpreter: {
          call: async () => {
            calls += 1;
            throw sentinel;
          },
        },
      }).catch((error: unknown) => error);
      if (refuses) {
        expectOutsideWriteScopeRefusal(result);
        expect(calls).toBe(0);
      } else {
        expect(result).toBe(sentinel);
        expect(calls).toBe(1);
      }
      expect(await readFile(join(repositoryPath, "docs/a.md"), "utf8")).toBe("# Alpha\n");
    }
  });

  it("leaves an invented model traversal on the decoder's existing path-grammar stop", async () => {
    const { repositoryPath, config } = await fixture();
    const model = interpreter(
      JSON.stringify({
        operation: "create",
        targets: [
          { path: "../outside.md", role: "write", chosenFrom: "named", quote: "../outside.md" },
        ],
        authorityPreference: { preference: "unspecified", quote: null },
      }),
    );
    const result = await executeRunRequest(
      request(repositoryPath, "Create docs/new.md with release notes."),
      config,
      {
        requestInterpreter: model.port,
      },
    );
    expect(model.calls).toBeGreaterThan(0);
    expect(result).toMatchObject({ error: "request-intent-path-grammar", status: "failed" });
  });

  it.each([
    "Create docs/new.md. Consult README.md only as source evidence.",
    "Create docs/new.md. The old instruction said `Create README.md`.",
    "Create docs/new.md. Explain ../outside.md as existing context.",
    "Create docs/new.md. If needed, update docs/../src/x.md later.",
    "Create docs/new.md. Do not edit ../outside.md.",
    "Create docs/new.md and docs/second.md using README.md as source evidence.",
  ])(
    "allows safe destination interpretation with source or conditional mentions: %s",
    async (instruction) => {
      const { repositoryPath, config } = await fixture();
      const model = interpreter(omitted);
      const result = await executeRunRequest(request(repositoryPath, instruction), config, {
        requestInterpreter: model.port,
      });
      expect(model.calls).toBe(1);
      expect(result).toMatchObject({
        error: "request-intent-target-missing",
        status: "needs-input",
      });
    },
  );

  it("permits an explicitly configured tracked README update to reach interpretation", async () => {
    const { repositoryPath, config } = await fixture(["README.md"]);
    const sentinel = new TypeError("interpreter reached");
    let calls = 0;
    const failure = await executeRunRequest(
      request(repositoryPath, "Update README.md with release notes.", "update-documentation"),
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
});

it.each([
  ["docs/a.md and update ../outside.md.", "../outside.md"],
  ["`docs/a.md` and update ../outside.md.", "../outside.md"],
  ["`docs/a.md` and update docs/../src/x.md.", "docs/../src/x.md"],
  ["docs/a.md. Consult README.md as source. Update docs/../src/x.md.", "docs/../src/x.md"],
  [
    "docs/new.md using docs/source.md and ../outside.md. Update docs/../src/x.md.",
    "docs/../src/x.md",
  ],
  ["two pages under docs/guides/: a.md, b.md. Update ../outside.md.", "../outside.md"],
  ["two pages under docs/guides/: a.md, b.md. Update src/new.md.", "src/new.md"],
  ["two pages under ../src/: a.md, b.md.", "../src/a.md"],
  ["two pages under ../using/: a.md, b.md.", "../using/a.md"],
  ["pages under docs/guides/: a.md, b.md. Create pages under ../src/: c.md, d.md.", "../src/c.md"],
  ["docs/a.md. Change only the files ../outside.md.", "../outside.md"],
  ["docs/a.md. Update only the pages docs/../src/x.md.", "docs/../src/x.md"],
] as const)(
  "refuses compound unsafe destination %s before any model reply",
  async (tail, unsafePath) => {
    for (const workflow of ["create-documentation", "update-documentation"] as const) {
      for (const variant of ["omitted", "returned"] as const) {
        const { base, repositoryPath, config } = await fixture();
        const instruction = `${workflow === "create-documentation" ? "Create" : "Update"} ${tail}`;
        const reply =
          variant === "omitted"
            ? omitted
            : JSON.stringify({
                operation: workflow === "create-documentation" ? "create" : "update",
                targets: [
                  { path: unsafePath, role: "write", chosenFrom: "named", quote: unsafePath },
                ],
                authorityPreference: { preference: "unspecified", quote: null },
              });
        const model = interpreter(reply);
        const result = await executeRunRequest(
          request(repositoryPath, instruction, workflow),
          config,
          {
            requestInterpreter: model.port,
          },
        ).catch((error: unknown) => error);
        expectOutsideWriteScopeRefusal(result, `${workflow} ${variant}: ${instruction}`);
        expect(model.calls).toBe(0);
        expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
        await expect(access(join(base, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(join(repositoryPath, "src/x.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
  },
);

it.each([
  "two pages under docs/guides/: a.md, b.md. Create docs/other.md.",
  "two pages under docs/guides/: update.md, overview.md.",
  "two pages under docs/using/: a.md, b.md.",
  "two pages under docs/guides/: create.md, update-notes.md.",
  "pages under docs/guides/: a.md, b.md. Create pages under fern/guides/: c.md, d.md.",
  "a summary of README.md in docs/new.md.",
  "a summary of `README.md` in docs/new.md.",
  "a summary of the README.md file in docs/new.md.",
  "documentation describing README.md in docs/new.md.",
  "docs/new.md using docs/source.md and README.md.",
  "docs/new.md using docs/source.md and ../outside.md.",
  "docs/new.md. Leave ../outside.md untouched.",
  "docs/new.md. Do not update ../outside.md.",
] as const)("keeps compound safe destinations on normal interpretation: %s", async (tail) => {
  const { repositoryPath, config } = await fixture();
  const instruction = `Create ${tail}`;
  const model = interpreter(omitted);
  const result = await executeRunRequest(request(repositoryPath, instruction), config, {
    requestInterpreter: model.port,
  });
  expect(model.calls).toBe(1);
  expect(result, instruction).toMatchObject({
    error: "request-intent-target-missing",
    status: "needs-input",
  });
});

it.each(["create-documentation", "update-documentation"] as const)(
  "refuses a later unique root README update before interpreting a %s list request",
  async (workflow) => {
    const { repositoryPath, config } = await fixture();
    const sentinel = new TypeError("bare update reached interpretation");
    let calls = 0;
    const instruction = `${workflow === "create-documentation" ? "Create" : "Update"} two pages under docs/guides/: a.md, b.md. Update README.md.`;
    const failure = await executeRunRequest(
      request(repositoryPath, instruction, workflow),
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
    expect(calls).toBe(0);
    expectOutsideWriteScopeRefusal(failure);
    expect(await readdir(config.stateDirectory)).toEqual([]);
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
  },
);

it.each(["create-documentation", "update-documentation"] as const)(
  "still interprets a later ambiguous README update in a %s list request",
  async (workflow) => {
    const { repositoryPath, config } = await fixture(undefined, {
      "docs/README.md": "# Nested documentation\n",
    });
    const sentinel = new TypeError("ambiguous update reached interpretation");
    let calls = 0;
    const instruction = `${workflow === "create-documentation" ? "Create" : "Update"} two pages under docs/guides/: a.md, b.md. Update README.md.`;
    const failure = await executeRunRequest(
      request(repositoryPath, instruction, workflow),
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
    expect(calls).toBe(1);
    expect(failure).toBe(sentinel);
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Product\n");
    expect(await readFile(join(repositoryPath, "docs/README.md"), "utf8")).toBe(
      "# Nested documentation\n",
    );
  },
);

it.each([
  "two pages under docs/guides/: a.md, b.md. Create docs/other.md.",
  "pages under docs/guides/: a.md, b.md. Create pages under fern/guides/: c.md, d.md.",
  "a summary of README.md in docs/new.md.",
  "documentation describing README.md in docs/new.md.",
] as const)("does not add an early update refusal for compound safe wording: %s", async (tail) => {
  const { repositoryPath, config } = await fixture();
  const model = interpreter(omitted);
  const failure = await executeRunRequest(
    request(repositoryPath, `Update ${tail}`, "update-documentation"),
    config,
    { requestInterpreter: model.port },
  ).catch((error: unknown) => error);
  // The legacy update binder still evaluates the whole prose after intent.
  // This probe only establishes that the new destination witness did not
  // turn a source or unqualified list name into a pre-model refusal.
  expect(model.calls).toBe(1);
  expect(failure).toMatchObject({ code: "proposal-scope-unsafe-target" });
});

it.each([
  "two pages under docs/guides/: update.md, overview.md.",
  "a summary of `README.md` in docs/new.md.",
  "a summary of the README.md file in docs/new.md.",
  "docs/new.md using docs/source.md and README.md.",
  "docs/new.md using docs/source.md and ../outside.md.",
] as const)("defers ambiguous update provenance to normal interpretation: %s", async (tail) => {
  const { repositoryPath, config } = await fixture();
  const sentinel = new TypeError("update interpretation reached");
  let calls = 0;
  const failure = await executeRunRequest(
    request(repositoryPath, `Update ${tail}`, "update-documentation"),
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
  expect(calls).toBe(1);
  expect(failure).toBe(sentinel);
});

it("retains a safe later write after a source clause without an early refusal", async () => {
  const { repositoryPath, config } = await fixture();
  const sentinel = new TypeError("later safe write reached interpretation");
  let calls = 0;
  const failure = await executeRunRequest(
    request(repositoryPath, "Create docs/a.md. Consult README.md as source. Update docs/b.md."),
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
  expect(calls).toBe(1);
  expect(failure).toBe(sentinel);
});
