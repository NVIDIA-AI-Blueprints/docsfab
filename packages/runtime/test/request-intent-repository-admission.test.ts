// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Request-intent repository and authority admission: the declared operation,
 * the existence matrix, documentation roots, the write scope, companions in
 * the navigation set, the zero-target rule, the failure order, and the host
 * inputs themselves. Each row asserts the parsed arm, code, location and
 * boundary or evidence beside an adjacent case that must pass.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { OperationalLimitError } from "../src/config/limits.js";
import {
  admitRequestIntent,
  decodeRequestIntentProposal,
  RequestIntentContractError,
  requestIntentExistencePaths,
  verifyRequestIntentDigest,
  type RequestIntentAdmissionResult,
  type RequestIntentBody,
  type RequestIntentExistenceKind,
  type RequestIntentOperation,
  type RequestIntentPathScope,
  type RequestIntentV1,
} from "../src/request-intent/index.js";
import { withinScope } from "../src/request-intent/host-input.js";
import { sealRequestIntent } from "../src/request-intent/seal.js";
import {
  admissionInput,
  CREATE_HOST,
  CREATE_INSTRUCTION,
  createProposal,
  DEFAULT_ROOTS,
  edited,
  type HostFixture,
  interpret,
  INVENTORY,
  limits,
  PILOT_REPOSITORY,
  pilotHost,
  type Proposal,
  question,
  UPDATE_HOST,
  UPDATE_INSTRUCTION,
  updateProposal,
} from "./helpers/request-intent-fixture.js";

const L = limits();

function arm(result: RequestIntentAdmissionResult) {
  return {
    outcome: result.outcome,
    code: "code" in result ? result.code : undefined,
    location: "location" in result ? result.location : undefined,
  };
}

function admitted(result: RequestIntentAdmissionResult): RequestIntentV1 {
  expect(result.outcome, JSON.stringify(arm(result))).toBe("admitted");
  if (result.outcome !== "admitted") throw new Error("Expected the proposal to be admitted.");
  return result.intent;
}

function hostFault(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RequestIntentContractError);
    return (error as RequestIntentContractError).code;
  }
  return undefined;
}

type Target = {
  path: string;
  role?: "write" | "companion-nav" | "companion-index";
  chosenFrom?: "named" | "inventory" | "proposed-new";
  quote?: string;
};

/** A proposal whose targets quote `Fix <path>`, in an instruction that names every path. */
function proposalOf(operation: RequestIntentOperation, targets: readonly Target[]) {
  return {
    operation,
    targets: targets.map((target) => ({
      path: target.path,
      role: target.role ?? "write",
      chosenFrom: target.chosenFrom ?? "named",
      quote: target.quote ?? `Fix ${target.path}`,
    })),
    authorityPreference: { preference: "unspecified", quote: null },
  };
}

function instructionFor(targets: readonly Target[]): string {
  return `${targets.map((target) => `Fix ${target.path} now.`).join(" ")} Keep it local.`;
}

function run(
  operation: RequestIntentOperation,
  targets: readonly Target[],
  host: HostFixture,
): RequestIntentAdmissionResult {
  return interpret(proposalOf(operation, targets), instructionFor(targets), host);
}

/** A host whose existence answers are stated, not derived from a repository. */
function answering(
  declaredOperation: RequestIntentOperation,
  answers: Record<string, RequestIntentExistenceKind>,
  overrides: Partial<HostFixture> = {},
): HostFixture {
  return pilotHost(declaredOperation, {
    existence: Object.entries(answers).map(([path, existing]) => ({ path, existing })),
    ...overrides,
  });
}

const STOP_CONSEQUENCE = "Nothing is written; the run stops until the operator reruns it.";

/** The closed option set each host question offers; `stop` is last and recommended. */
const OPTIONS: Record<string, readonly string[]> = {
  "request-intent-operation-mismatch": ["rerun-with-matching-workflow", "stop"],
  "request-intent-target-missing": ["name-a-target", "stop"],
  "request-intent-target-absent": ["rerun-as-create", "name-an-existing-page", "stop"],
  "request-intent-target-present": ["rerun-as-update", "name-a-new-path", "stop"],
  "request-intent-target-case-ambiguous": ["name-the-exact-path", "stop"],
  "request-intent-target-not-file": ["name-a-file", "stop"],
};

/** An admitted intent's body, edited and sealed again with a valid digest. */
function resealed(intent: RequestIntentV1, edit: Partial<RequestIntentBody>) {
  const { schemaVersion: _version, kind: _kind, digest: _digest, ...body } = intent;
  return JSON.parse(JSON.stringify(sealRequestIntent({ ...body, ...edit })));
}

describe("request-intent operation mismatch (R2)", () => {
  const restructure = () =>
    edited(updateProposal(), (p) => {
      p.operation = "restructure";
    });

  it("records an advisory when the proposal reads another operation than the run declared", () => {
    const result = interpret(restructure(), UPDATE_INSTRUCTION, UPDATE_HOST);
    expect(result).toMatchObject({
      outcome: "advisory",
      code: "request-intent-operation-mismatch",
      location: "$.operation",
      at: "$.operation",
      evidence: {
        declaredOperation: "update",
        operation: "restructure",
        observed: null,
        existing: null,
      },
    });
    if (result.outcome !== "advisory") return;
    // Never rerouted: the sealed intent keeps the operation the request reads as.
    expect(result.intent.operation).toBe("restructure");
    expect(result.intent.question).toBeNull();
    expect(result).not.toHaveProperty("question");
  });

  it.each([
    ["create", "update"],
    ["update", "create"],
    ["review", "update"],
    ["update", "review"],
    ["update", "restructure"],
  ] as const)(
    "records an advisory when the proposal reads %s and the run declared %s",
    (operation, declared) => {
      const result = run(
        operation,
        [{ path: "docs/cli.md" }],
        answering(declared, { "docs/cli.md": operation === "create" ? "absent" : "file" }),
      );
      expect(arm(result)).toEqual({
        outcome: "advisory",
        code: "request-intent-operation-mismatch",
        location: "$.operation",
      });
    },
  );

  it("asks no existence question for the operation the reading names", () => {
    // A create of an existing page would ask target-present under create;
    // the run performs the declared update, so the mismatch is all it records.
    const result = run(
      "create",
      [{ path: "docs/cli.md" }],
      answering("update", { "docs/cli.md": "file" }),
    );
    expect(arm(result)).toEqual({
      outcome: "advisory",
      code: "request-intent-operation-mismatch",
      location: "$.operation",
    });
  });

  it.each(["create", "update", "restructure", "review"] as const)(
    "admits a proposal whose operation equals the declared %s",
    (operation) => {
      const answer = operation === "create" ? "absent" : "file";
      admitted(
        run(operation, [{ path: "docs/cli.md" }], answering(operation, { "docs/cli.md": answer })),
      );
    },
  );
});

describe("request-intent existence matrix for write targets", () => {
  type Expected = "admit" | "host-fault" | string;
  const cells: readonly [
    RequestIntentOperation,
    "named" | "inventory" | "proposed-new",
    RequestIntentExistenceKind,
    Expected,
  ][] = [
    ["update", "named", "file", "admit"],
    ["update", "named", "case-fold", "request-intent-target-case-ambiguous"],
    ["update", "named", "directory", "request-intent-target-not-file"],
    ["update", "named", "parent-file", "request-intent-target-not-file"],
    ["update", "named", "absent", "request-intent-target-absent"],
    ["update", "named", "file-not-granted", "request-intent-target-not-granted"],
    ["update", "inventory", "file", "admit"],
    ["update", "inventory", "case-fold", "request-intent-target-case-ambiguous"],
    ["update", "inventory", "directory", "host-fault"],
    ["update", "inventory", "parent-file", "host-fault"],
    ["update", "inventory", "absent", "host-fault"],
    ["update", "inventory", "file-not-granted", "request-intent-target-not-granted"],
    ["restructure", "named", "file", "admit"],
    ["restructure", "named", "case-fold", "request-intent-target-case-ambiguous"],
    ["restructure", "named", "directory", "request-intent-target-not-file"],
    ["restructure", "named", "parent-file", "request-intent-target-not-file"],
    ["restructure", "named", "absent", "request-intent-target-absent"],
    ["restructure", "named", "file-not-granted", "request-intent-target-not-granted"],
    ["restructure", "inventory", "file", "admit"],
    ["restructure", "inventory", "absent", "host-fault"],
    ["create", "named", "absent", "admit"],
    ["create", "named", "file", "request-intent-target-present"],
    ["create", "named", "case-fold", "request-intent-target-present"],
    ["create", "named", "directory", "request-intent-target-present"],
    ["create", "named", "parent-file", "request-intent-target-present"],
    ["create", "named", "file-not-granted", "request-intent-target-present"],
    ["create", "proposed-new", "absent", "admit"],
    ["create", "proposed-new", "file", "request-intent-target-present"],
    ["create", "proposed-new", "directory", "request-intent-target-present"],
    ["create", "inventory", "file", "request-intent-target-present"],
    ["create", "inventory", "file-not-granted", "request-intent-target-present"],
    ["create", "inventory", "absent", "host-fault"],
    ["review", "named", "file", "admit"],
    ["review", "named", "case-fold", "request-intent-target-case-ambiguous"],
    ["review", "named", "directory", "request-intent-target-not-file"],
    ["review", "named", "parent-file", "request-intent-target-not-file"],
    ["review", "named", "absent", "request-intent-target-absent"],
    ["review", "named", "file-not-granted", "admit"],
    ["review", "inventory", "file", "admit"],
    ["review", "inventory", "file-not-granted", "admit"],
    ["review", "inventory", "absent", "host-fault"],
    ["review", "inventory", "directory", "host-fault"],
    ["review", "inventory", "parent-file", "host-fault"],
  ];

  it.each(cells)("%s of a %s target answered %s: %s", (operation, origin, existing, expected) => {
    const path = "docs/page.md";
    const host = answering(operation, { [path]: existing }, { inventory: [...INVENTORY, path] });
    const go = () => run(operation, [{ path, chosenFrom: origin }], host);
    if (expected === "host-fault") {
      expect(hostFault(go)).toBe("host-input-invalid");
      return;
    }
    const result = go();
    if (expected === "admit") {
      expect(admitted(result).targets[0]!.path).toBe(path);
      return;
    }
    if (expected === "request-intent-target-not-granted") {
      expect(result).toEqual({
        outcome: "refused",
        code: expected,
        location: "$.targets[].path",
        at: "$.targets[0].path",
        retry: "terminal",
        boundary: {
          kind: "write-grant",
          observed: path,
          remediation:
            "Have the host that grants this run's writes cover this page, or name a page the grant covers.",
        },
      });
      return;
    }
    expect(result).toMatchObject({
      outcome: "question",
      code: expected,
      location: "$.targets[].path",
      at: "$.targets[0].path",
      evidence: { declaredOperation: operation, operation, observed: path, existing },
      question: {
        options: OPTIONS[expected],
        recommendedDefault: "stop",
        consequence: STOP_CONSEQUENCE,
      },
    });
  });

  it("words a case-fold answer as any collision without a base, links and submodules included", () => {
    const path = "docs/page.md";
    for (const operation of ["create", "update"] as const) {
      const result = run(operation, [{ path }], answering(operation, { [path]: "case-fold" }));
      if (result.outcome !== "question")
        throw new Error(`expected a question, got ${result.outcome}`);
      expect(result.question.question, operation).toContain(
        "exists under another letter case or as a link, submodule, or excluded entry",
      );
      expect(result.question.question, operation).not.toContain("only when letter case is ignored");
    }
  });

  it("reports the first write target in proposal order, at its own index", () => {
    const targets = [{ path: "docs/a.md" }, { path: "docs/b.md" }, { path: "docs/c.md" }];
    const host = answering("update", {
      "docs/a.md": "file",
      "docs/b.md": "directory",
      "docs/c.md": "absent",
    });
    expect(run("update", targets, host)).toMatchObject({
      code: "request-intent-target-not-file",
      at: "$.targets[1].path",
      evidence: { observed: "docs/b.md", existing: "directory" },
    });
  });

  it("asks nothing about companions: only write-role targets are asked", () => {
    const proposal = proposalOf("update", [
      { path: "docs/cli.md" },
      { path: "docs/index.md", role: "companion-index" },
    ]);
    const decoded = decodeRequestIntentProposal(proposal, {
      instruction: instructionFor([{ path: "docs/cli.md" }, { path: "docs/index.md" }]),
      limits: L,
    });
    if (decoded.outcome !== "decoded") throw new Error("Expected the proposal to decode.");
    expect(requestIntentExistencePaths(decoded)).toEqual(["docs/cli.md"]);
  });
});

describe("request-intent create over an existing entry (R5), against the oracle mapping", () => {
  const repository = {
    tracked: ["docs/cli.md", "docs/guides/a.md", "docs/a.md", "docs/index.md"],
    notGranted: ["docs/cli.md"],
  };
  const host = pilotHost("create", { repository });

  it.each([
    ["a fold-equal file", "docs/CLI.md", "case-fold"],
    ["a directory", "docs/guides", "directory"],
    ["a path under a file", "docs/a.md/b.md", "parent-file"],
    ["a file outside the update grant", "docs/cli.md", "file-not-granted"],
    ["an exact file", "docs/index.md", "file"],
  ])("asks when the create target is %s", (_name, path, existing) => {
    expect(run("create", [{ path }], host)).toMatchObject({
      outcome: "question",
      code: "request-intent-target-present",
      location: "$.targets[].path",
      evidence: { observed: path, existing },
      question: { options: ["rerun-as-update", "name-a-new-path", "stop"] },
    });
  });

  it("admits a create target the repository does not have", () => {
    admitted(run("create", [{ path: "docs/new.md" }], host));
  });
});

describe("request-intent documentation roots (R4)", () => {
  const roots: readonly RequestIntentPathScope[] = [{ kind: "root", path: "docs" }];
  // A scope that covers every probe, so only the root can refuse.
  const wide: readonly RequestIntentPathScope[] = [
    { kind: "root", path: "docs" },
    { kind: "root", path: "docs-archive" },
    { kind: "root", path: "Docs" },
    { kind: "file", path: "nav.json" },
  ];
  const host = (overrides: Partial<HostFixture> = {}) =>
    pilotHost("create", {
      docsRoot: roots,
      grantedWriteScope: wide,
      navigationSet: ["docs/nav.yml", "nav.json"],
      repository: { tracked: ["docs/nav.yml", "nav.json"] },
      ...overrides,
    });

  it.each(["docs-archive/x.md", "Docs/x.md", "guides/x.md", "x.md", "docs"])(
    "refuses the create target %j outside every root, naming the roots",
    (path) => {
      expect(run("create", [{ path }], host())).toEqual({
        outcome: "refused",
        code: "request-intent-outside-docs-root",
        location: "$.targets[].path",
        at: "$.targets[0].path",
        retry: "terminal",
        boundary: {
          kind: "docs-root",
          roots,
          observed: path,
          remediation: "Name a new page under docs.",
        },
      });
    },
  );

  it.each(["docs/x.md", "docs/deep/er/x.md"])(
    "admits the create target %j under the root",
    (path) => {
      admitted(run("create", [{ path }], host()));
    },
  );

  it("admits a create whose existing companions sit inside the scope but outside the root", () => {
    const targets: Target[] = [
      { path: "docs/new.md" },
      { path: "docs/nav.yml", role: "companion-nav" },
      { path: "nav.json", role: "companion-nav" },
    ];
    admitted(run("create", targets, host()));
  });

  it("applies only to create: an update of an existing page outside the roots admits", () => {
    const update = pilotHost("update", {
      docsRoot: roots,
      grantedWriteScope: wide,
      repository: { tracked: ["docs-archive/x.md"] },
    });
    admitted(run("update", [{ path: "docs-archive/x.md" }], update));
  });

  it("names a run with no root in its remediation", () => {
    expect(run("create", [{ path: "docs/x.md" }], host({ docsRoot: [] }))).toMatchObject({
      code: "request-intent-outside-docs-root",
      boundary: {
        roots: [],
        remediation:
          "This run declares no documentation root, so it cannot create a page; run a workflow that declares one.",
      },
    });
  });

  it("refuses a page at the root's own path on the first-pass journey, where docs/ does not exist yet", () => {
    const firstPass = pilotHost("create", { repository: { tracked: ["src/cli/configure.ts"] } });
    const proposal = proposalOf("create", [{ path: "docs", quote: "Add docs" }]);
    const result = interpret(proposal, "Add docs for the configure command.", firstPass);
    expect(result).toMatchObject({
      outcome: "refused",
      code: "request-intent-outside-docs-root",
      at: "$.targets[0].path",
      boundary: { kind: "docs-root", roots: DEFAULT_ROOTS, observed: "docs" },
    });
  });

  it("refuses a page at a narrowed root's own path and admits one under it", () => {
    const narrowed = host({ docsRoot: [{ kind: "root", path: "docs/api" }] });
    expect(run("create", [{ path: "docs/api" }], narrowed)).toMatchObject({
      outcome: "refused",
      code: "request-intent-outside-docs-root",
      boundary: { kind: "docs-root", observed: "docs/api" },
    });
    admitted(run("create", [{ path: "docs/api/x.md" }], narrowed));
  });

  it("covers a file root by exact path only", () => {
    const fileRoot = host({ docsRoot: [{ kind: "file", path: "docs/x.md" }] });
    admitted(run("create", [{ path: "docs/x.md" }], fileRoot));
    expect(arm(run("create", [{ path: "docs/x.md/y.md" }], fileRoot)).code).toBe(
      "request-intent-outside-docs-root",
    );
  });
});

describe("request-intent write scope (R8)", () => {
  const SDK_INSTRUCTION =
    "Split the SDK reference in docs/sdk-reference.md into task pages and update nav.json so readers can find them.";
  const sdkProposal = () => ({
    operation: "restructure",
    targets: [
      {
        path: "docs/sdk-reference.md",
        role: "write",
        chosenFrom: "named",
        quote: "Split the SDK reference in docs/sdk-reference.md",
      },
      { path: "nav.json", role: "companion-nav", chosenFrom: "named", quote: "update nav.json" },
    ],
    authorityPreference: { preference: "unspecified", quote: null },
  });
  const sdkHost = (grantedWriteScope: readonly RequestIntentPathScope[]) =>
    pilotHost("restructure", {
      repository: { tracked: ["docs/sdk-reference.md", "nav.json"] },
      // nav.json is a known navigation file, so the companion rule passes and only the scope decides.
      navigationSet: ["nav.json"],
      grantedWriteScope,
    });

  it("refuses the restructure pilot's root nav.json companion outside the docs and fern roots", () => {
    expect(interpret(sdkProposal(), SDK_INSTRUCTION, sdkHost(DEFAULT_ROOTS))).toEqual({
      outcome: "refused",
      code: "request-intent-outside-write-scope",
      location: "$.targets[].path",
      at: "$.targets[1].path",
      retry: "terminal",
      boundary: {
        kind: "write-scope",
        grant: DEFAULT_ROOTS,
        observed: "nav.json",
        remediation:
          "This run may write only docs, fern; name only paths inside it. To write a Markdown or MDX page outside it, add the page, or its directory, to documentationRoots in .docsfab.json; source, CI, and agent instruction files stay read-only.",
      },
    });
  });

  it("admits the same pilot when the grant adds nav.json as a file", () => {
    const grant = [...DEFAULT_ROOTS, { kind: "file" as const, path: "nav.json" }];
    admitted(interpret(sdkProposal(), SDK_INSTRUCTION, sdkHost(grant)));
  });

  it.each(["fern2/x.md", "src/x.ts", "Docs/x.md", "docsx/x.md", "fern", "docs"])(
    "refuses the update target %j outside the grant",
    (path) => {
      const host = pilotHost("update", { repository: { tracked: [path] } });
      expect(run("update", [{ path }], host)).toMatchObject({
        outcome: "refused",
        code: "request-intent-outside-write-scope",
        at: "$.targets[0].path",
        boundary: { kind: "write-scope", observed: path },
      });
    },
  );

  it("names an empty write scope in its remediation", () => {
    const host = pilotHost("update", { grantedWriteScope: [] });
    expect(run("update", [{ path: "docs/cli.md" }], host)).toMatchObject({
      code: "request-intent-outside-write-scope",
      boundary: {
        grant: [],
        remediation:
          "This run may write nothing; name only paths inside it. To write a Markdown or MDX page outside it, add the page, or its directory, to documentationRoots in .docsfab.json; source, CI, and agent instruction files stay read-only.",
      },
    });
  });

  it("does not apply to a review, which writes nothing", () => {
    const host = pilotHost("review", {
      grantedWriteScope: [],
      repository: { tracked: ["src/x.ts"] },
    });
    admitted(run("review", [{ path: "src/x.ts" }], host));
  });

  it("agrees with the knowledge write-root check on slash-terminated roots, the roots themselves included", async () => {
    const knowledge = pathToFileURL(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../knowledge/src/first-pass/parse.mjs"),
    ).href;
    const { isInsideAuthorizedWriteRoots } = (await import(knowledge)) as {
      isInsideAuthorizedWriteRoots: (path: string, roots: readonly string[]) => boolean;
    };
    const slashRoots = ["docs/", "fern/"];
    for (const path of [
      "docs/x.md",
      "fern/a/b.md",
      "docs-archive/x.md",
      "Docs/x.md",
      "fern2/x.md",
      "nav.json",
      "docs",
      "fern",
    ]) {
      expect(withinScope(path, DEFAULT_ROOTS), path).toBe(
        isInsideAuthorizedWriteRoots(path, slashRoots),
      );
    }
    // Divergence: a root written without its slash, which the host input never carries.
    expect(isInsideAuthorizedWriteRoots("docs-archive/x.md", ["docs"])).toBe(true);
    expect(withinScope("docs-archive/x.md", [{ kind: "root", path: "docs" }])).toBe(false);
  });
});

describe("request-intent companions are known navigation or index files (R6)", () => {
  const targets = (role: "companion-nav" | "companion-index", path: string): Target[] => [
    { path: "docs/new.md" },
    { path, role },
  ];
  const host = pilotHost("create", {
    repository: { tracked: ["docs/index.md", "docs/nav.yml"] },
    navigationSet: ["docs/index.md", "docs/nav.yml"],
  });

  it.each([
    ["companion-nav", "docs/sidebar.yml"],
    ["companion-index", "docs/guides/index.md"],
    ["companion-index", "Docs/index.md"],
    ["companion-nav", "docs/nav.yml.bak"],
  ] as const)("rejects a %s %j outside the navigation set", (role, path) => {
    expect(run("create", targets(role, path), host)).toMatchObject({
      outcome: "rejected",
      code: "request-intent-companion-not-navigation",
      location: "$.targets[].path",
      at: "$.targets[1].path",
      retry: "model-correctable",
    });
  });

  it.each([
    ["companion-nav", "docs/nav.yml"],
    ["companion-index", "docs/index.md"],
  ] as const)("admits a %s %j in the navigation set", (role, path) => {
    admitted(run("create", targets(role, path), host));
  });

  it("does not require a write target to be in the navigation set", () => {
    admitted(run("create", [{ path: "docs/new.md" }], pilotHost("create", { navigationSet: [] })));
  });
});

describe("request-intent restructure destinations", () => {
  it("admits an absent destination under a root when another target exists as a file", () => {
    const host = answering("restructure", { "docs/cli.md": "file", "docs/cli-tasks.md": "absent" });
    admitted(run("restructure", [{ path: "docs/cli.md" }, { path: "docs/cli-tasks.md" }], host));
    // Proposal order does not decide which target is the source.
    admitted(run("restructure", [{ path: "docs/cli-tasks.md" }, { path: "docs/cli.md" }], host));
  });

  it("asks about every absent target when none exists", () => {
    const host = answering("restructure", { "docs/a-new.md": "absent", "docs/b-new.md": "absent" });
    expect(
      arm(run("restructure", [{ path: "docs/a-new.md" }, { path: "docs/b-new.md" }], host)),
    ).toEqual({
      outcome: "question",
      code: "request-intent-target-absent",
      location: "$.targets[].path",
    });
  });

  it("asks about an absent destination outside the documentation roots", () => {
    // The shipped producer grants every restructure target a file entry, so
    // the scope admits it and only the existence rule decides.
    const host = answering(
      "restructure",
      { "docs/cli.md": "file", "guides/cli-tasks.md": "absent" },
      { grantedWriteScope: [...DEFAULT_ROOTS, { kind: "file", path: "guides/cli-tasks.md" }] },
    );
    const result = run(
      "restructure",
      [{ path: "docs/cli.md" }, { path: "guides/cli-tasks.md" }],
      host,
    );
    expect(result).toMatchObject({
      outcome: "question",
      code: "request-intent-target-absent",
      at: "$.targets[1].path",
    });
  });

  it.each([
    ["a directory", "docs/guide", "directory"],
    ["under an existing file", "docs/cli.md/tasks.md", "parent-file"],
  ] as const)(
    "asks about a destination that is %s beside the source, before or after it",
    (_name, path, existing) => {
      const host = answering("restructure", { "docs/index.md": "file", [path]: existing });
      const after = run("restructure", [{ path: "docs/index.md" }, { path }], host);
      expect(after).toMatchObject({
        outcome: "question",
        code: "request-intent-target-not-file",
        at: "$.targets[1].path",
      });
      const before = run("restructure", [{ path }, { path: "docs/index.md" }], host);
      expect(before).toMatchObject({
        outcome: "question",
        code: "request-intent-target-not-file",
        at: "$.targets[0].path",
      });
    },
  );

  it("asks when the only other target is a case variant, not an exact file", () => {
    const host = answering("restructure", {
      "docs/CLI.md": "case-fold",
      "docs/cli-tasks.md": "absent",
    });
    expect(
      run("restructure", [{ path: "docs/CLI.md" }, { path: "docs/cli-tasks.md" }], host),
    ).toMatchObject({ outcome: "question", code: "request-intent-target-case-ambiguous" });
  });

  it("keeps the absent-target question for an update beside an existing page", () => {
    const host = answering("update", { "docs/cli.md": "file", "docs/cli-tasks.md": "absent" });
    expect(
      run("update", [{ path: "docs/cli.md" }, { path: "docs/cli-tasks.md" }], host),
    ).toMatchObject({
      outcome: "question",
      code: "request-intent-target-absent",
      at: "$.targets[1].path",
    });
  });
});

describe("request-intent zero write targets", () => {
  it.each(["update", "restructure"] as const)(
    "records an advisory when a %s names no target, and the workflow chooses the pages",
    (operation) => {
      const proposal = { ...proposalOf(operation, []), preserve: [{ quote: "Keep it local" }] };
      const result = interpret(proposal, "Keep it local.", pilotHost(operation));
      expect(result).toMatchObject({
        outcome: "advisory",
        code: "request-intent-target-missing",
        location: "$.targets",
        at: "$.targets",
        evidence: { declaredOperation: operation, operation, observed: null, existing: null },
        intent: { operation, targets: [], question: null },
      });
    },
  );

  it.each(["create", "update", "review"] as const)(
    "asks which page when a create run's %s reading names no target",
    (operation) => {
      const proposal = {
        ...proposalOf(operation, []),
        preserve: [{ quote: "Keep it local" }],
        questions: [question()],
      };
      const result = interpret(proposal, "Keep it local.", pilotHost("create"));
      expect(result).toMatchObject({
        outcome: "question",
        code: "request-intent-target-missing",
        location: "$.targets",
        at: "$.targets",
        evidence: { declaredOperation: "create", operation, observed: null, existing: null },
        question: {
          question: "The request names no page to create. Which page is meant?",
          options: ["name-a-target", "stop"],
          recommendedDefault: "stop",
          consequence: STOP_CONSEQUENCE,
        },
      });
      if (result.outcome !== "question") return;
      // The host's question replaces the model's, as for every host question.
      expect(result.intent.question).toEqual(result.question);
    },
  );

  it("records the advisory instead of the model's own question", () => {
    const proposal = {
      ...proposalOf("update", []),
      preserve: [{ quote: "Keep it local" }],
      questions: [question()],
    };
    const result = interpret(proposal, "Keep it local.", pilotHost("update"));
    expect(result).toMatchObject({ outcome: "advisory", code: "request-intent-target-missing" });
    if (result.outcome !== "advisory") return;
    expect(result.intent.question).toBeNull();
  });

  it("records an advisory when only companions are named", () => {
    const host = pilotHost("update", { navigationSet: ["docs/index.md"] });
    expect(arm(run("update", [{ path: "docs/index.md", role: "companion-index" }], host))).toEqual({
      outcome: "advisory",
      code: "request-intent-target-missing",
      location: "$.targets",
    });
  });

  it("admits a review with no target", () => {
    const proposal = { ...proposalOf("review", []), preserve: [{ quote: "Keep it local" }] };
    admitted(interpret(proposal, "Keep it local.", pilotHost("review")));
  });

  it("admits a review that names only companions, as a review writes nothing", () => {
    const host = pilotHost("review", { navigationSet: ["docs/index.md"] });
    admitted(run("review", [{ path: "docs/index.md", role: "companion-index" }], host));
  });
});

describe("request-intent failure order across stages", () => {
  const both = <T>(first: T, second: T): [T, T][] => [
    [first, second],
    [second, first],
  ];

  it("lets decode win: an extra key beside a named target that does not exist", () => {
    const proposal = { ...proposalOf("update", [{ path: "docs/missing.md" }]), audience: "x" };
    const result = interpret(proposal, instructionFor([{ path: "docs/missing.md" }]), UPDATE_HOST);
    expect(arm(result)).toEqual({
      outcome: "rejected",
      code: "request-intent-shape",
      location: "$",
    });
  });

  it.each(both<Target>({ path: "docs/cli.md", quote: "Rewrite everything" }, { path: "src/x.ts" }))(
    "lets an ungrounded quote win over a target outside the scope",
    (first, second) => {
      const host = pilotHost("update", { repository: { tracked: ["docs/cli.md", "src/x.ts"] } });
      expect(arm(run("update", [first, second], host)).code).toBe(
        "request-intent-quote-ungrounded",
      );
    },
  );

  it.each(
    both<Target>({ path: "docs/new.md" }, { path: "docs/sidebar.yml", role: "companion-nav" }).map(
      ([a, b]) => [a, b, { path: "guides/x.md" }] as const,
    ),
  )(
    "lets a companion outside the navigation set win over a create outside the roots",
    (a, b, c) => {
      expect(arm(run("create", [a, b, c], CREATE_HOST)).code).toBe(
        "request-intent-companion-not-navigation",
      );
      expect(arm(run("create", [c, a, b], CREATE_HOST)).code).toBe(
        "request-intent-companion-not-navigation",
      );
    },
  );

  it.each(both<Target>({ path: "docs/cli.md" }, { path: "src/x.ts" }))(
    "refuses a target outside the scope before asking about the operation",
    (first, second) => {
      const host = pilotHost("create", { repository: { tracked: ["docs/cli.md", "src/x.ts"] } });
      expect(arm(run("update", [first, second], host)).code).toBe(
        "request-intent-outside-write-scope",
      );
    },
  );

  it.each(both<Target>({ path: "docs/cli.md" }, { path: "src/x.ts" }))(
    "refuses an existing page outside the update grant before a target outside the scope",
    (first, second) => {
      const host = answering("update", { "docs/cli.md": "file-not-granted", "src/x.ts": "file" });
      expect(arm(run("update", [first, second], host)).code).toBe(
        "request-intent-target-not-granted",
      );
    },
  );

  it.each(both<Target>({ path: "guides/x.md" }, { path: "fern/x.md" }))(
    "refuses a create outside the roots before one inside the roots but outside the scope",
    (first, second) => {
      const host = pilotHost("create", { grantedWriteScope: [{ kind: "root", path: "docs" }] });
      expect(arm(run("create", [first, second], host)).code).toBe(
        "request-intent-outside-docs-root",
      );
      expect(arm(run("create", [{ path: "fern/x.md" }], host)).code).toBe(
        "request-intent-outside-write-scope",
      );
    },
  );

  it("refuses an internal path before an existing page outside the grant", () => {
    const host = answering("update", { "docs/cli.md": "file-not-granted", ".git/config": "file" });
    for (const targets of both<Target>({ path: "docs/cli.md" }, { path: ".git/config" })) {
      expect(arm(run("update", targets, host)).code).toBe("request-intent-internal-path");
    }
  });

  it("records a missing target before the operation, and the operation before existence", () => {
    const missing = { ...proposalOf("create", []), preserve: [{ quote: "Keep it local" }] };
    expect(arm(interpret(missing, "Keep it local.", pilotHost("update")))).toEqual({
      outcome: "advisory",
      code: "request-intent-target-missing",
      location: "$.targets",
    });
    const present = answering("update", { "docs/cli.md": "file" });
    expect(arm(run("create", [{ path: "docs/cli.md" }], present))).toEqual({
      outcome: "advisory",
      code: "request-intent-operation-mismatch",
      location: "$.operation",
    });
  });

  it("asks the host's question instead of the model's, and seals only the host's", () => {
    const proposal = {
      ...proposalOf("update", [{ path: "docs/missing.md" }]),
      questions: [question()],
    };
    const result = interpret(proposal, instructionFor([{ path: "docs/missing.md" }]), UPDATE_HOST);
    expect(result).toMatchObject({ outcome: "question", code: "request-intent-target-absent" });
    if (result.outcome !== "question") return;
    expect(result.intent.question).toEqual(result.question);
    expect(result.question.options).toEqual(["rerun-as-create", "name-an-existing-page", "stop"]);
  });

  it("lets a refusal win over the host's question and the model's", () => {
    const proposal = { ...proposalOf("create", [{ path: "src/x.ts" }]), questions: [question()] };
    const host = pilotHost("update");
    expect(arm(interpret(proposal, instructionFor([{ path: "src/x.ts" }]), host)).code).toBe(
      "request-intent-outside-docs-root",
    );
  });

  it("checks the inventory origin before the inventory/existence agreement", () => {
    const host = answering("update", { "docs/not-listed.md": "absent" });
    expect(
      arm(run("update", [{ path: "docs/not-listed.md", chosenFrom: "inventory" }], host)),
    ).toEqual({
      outcome: "rejected",
      code: "request-intent-inventory-unmatched",
      location: "$.targets[].path",
    });
  });

  it("lets each failure alone return its own code", () => {
    expect(
      arm(
        run(
          "update",
          [{ path: "src/x.ts" }],
          pilotHost("update", { repository: { tracked: ["src/x.ts"] } }),
        ),
      ).code,
    ).toBe("request-intent-outside-write-scope");
    expect(
      arm(
        run(
          "create",
          [{ path: "guides/x.md" }],
          pilotHost("create", { grantedWriteScope: [{ kind: "root", path: "guides" }] }),
        ),
      ).code,
    ).toBe("request-intent-outside-docs-root");
  });
});

describe("request-intent host inputs for repository admission", () => {
  const asked = ["docs/telemetryctl-configuration.md"];
  const decoded = () => {
    const result = decodeRequestIntentProposal(createProposal(), {
      instruction: CREATE_INSTRUCTION,
      limits: L,
    });
    if (result.outcome !== "decoded") throw new Error("Expected the pilot to decode.");
    return result;
  };
  const valid = () => admissionInput(CREATE_INSTRUCTION, CREATE_HOST, asked);
  const admit = (input: unknown) => () => admitRequestIntent(decoded(), input as never);

  it("admits the complete pilot input", () => {
    expect(admit(valid())().outcome).toBe("admitted");
  });

  it.each([
    ["a missing answer", []],
    [
      "an extra answer",
      [
        { path: asked[0], existing: "absent" },
        { path: "docs/other.md", existing: "absent" },
      ],
    ],
    ["an answer for another path", [{ path: "docs/other.md", existing: "absent" }]],
    [
      "one path answered twice",
      [
        { path: asked[0], existing: "absent" },
        { path: asked[0], existing: "absent" },
      ],
    ],
    ["an unknown kind", [{ path: asked[0], existing: "missing" }]],
    ["an untyped answer", [{ path: asked[0] }]],
    ["an extra key", [{ path: asked[0], existing: "absent", base: "x" }]],
    ["a bare path", [asked[0]]],
    ["no list", undefined],
  ])("refuses %s as a host fault, never as absent", (_name, existence) => {
    expect(hostFault(admit({ ...valid(), existence }))).toBe("host-input-invalid");
  });

  it.each([undefined, "edit", "Create", null])(
    "refuses the declared operation %j",
    (declaredOperation) => {
      expect(hostFault(admit({ ...valid(), declaredOperation }))).toBe("host-input-invalid");
    },
  );

  it.each([
    ["an empty path", { kind: "root", path: "" }],
    ["the root slash", { kind: "root", path: "/" }],
    ["a dot", { kind: "root", path: "." }],
    ["a parent", { kind: "root", path: ".." }],
    ["a trailing slash", { kind: "root", path: "docs/" }],
    ["an absolute path", { kind: "root", path: "/docs" }],
    ["an untyped entry", { path: "docs" }],
    ["an unknown kind", { kind: "directory", path: "docs" }],
    ["an extra key", { kind: "root", path: "docs", recursive: true }],
    ["a bare string", "docs"],
  ])("refuses %s in either scope list", (_name, entry) => {
    expect(hostFault(admit({ ...valid(), docsRoot: [entry] }))).toBe("host-input-invalid");
    expect(hostFault(admit({ ...valid(), grantedWriteScope: [entry] }))).toBe("host-input-invalid");
  });

  it.each([
    ["not a list", "docs"],
    ["a non-string entry", [7]],
    ["an absolute entry", ["/docs/index.md"]],
    ["a trailing slash", ["docs/"]],
  ])("refuses a navigation set that is %s", (_name, navigationSet) => {
    expect(hostFault(admit({ ...valid(), navigationSet }))).toBe("host-input-invalid");
  });

  it.each(["docsRoot", "grantedWriteScope"])("refuses a %s that is not a list", (field) => {
    expect(hostFault(admit({ ...valid(), [field]: { kind: "root", path: "docs" } }))).toBe(
      "host-input-invalid",
    );
  });

  it("checks the proposal-independent host inputs before decoding the proposal", () => {
    const smuggled = { outcome: "decoded", proposal: { ...createProposal(), audience: "x" } };
    expect(
      hostFault(() =>
        admitRequestIntent(smuggled as never, { ...valid(), declaredOperation: "x" } as never),
      ),
    ).toBe("host-input-invalid");
  });

  it("checks the existence answers only once the proposal decodes", () => {
    const smuggled = { outcome: "decoded", proposal: { ...createProposal(), audience: "x" } };
    const result = admitRequestIntent(smuggled as never, { ...valid(), existence: [] } as never);
    expect(arm(result)).toEqual({
      outcome: "rejected",
      code: "request-intent-shape",
      location: "$",
    });
  });

  it.each([
    [
      "navigationSet",
      L.maxNavigationEntries,
      (count: number) => Array.from({ length: count }, (_, index) => `docs/nav-${index}.yml`),
    ],
    [
      "grantedWriteScope",
      L.maxWriteScopeEntries,
      (count: number) =>
        Array.from({ length: count }, (_, index) => ({
          kind: "root",
          path: index === 0 ? "docs" : `docs-${index}`,
        })),
    ],
    [
      "docsRoot",
      L.maxDocsRootEntries,
      (count: number) =>
        Array.from({ length: count }, (_, index) => ({
          kind: "root",
          path: index === 0 ? "docs" : `docs-${index}`,
        })),
    ],
  ] as const)(
    "admits %s at its bound and refuses one entry more through refuseLimit",
    (field, bound, entries) => {
      expect(admit({ ...valid(), [field]: entries(bound.value) })().outcome).toBe("admitted");
      let thrown: unknown;
      try {
        admit({ ...valid(), [field]: entries(bound.value + 1) })();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OperationalLimitError);
      expect(thrown).toMatchObject({
        limitName: bound.name,
        observed: bound.value + 1,
        code:
          bound.name === "requestIntent.maxNavigationEntries"
            ? "request-intent-max-navigation-entries-bound"
            : bound.name === "requestIntent.maxWriteScopeEntries"
              ? "request-intent-max-write-scope-entries-bound"
              : "request-intent-max-docs-root-entries-bound",
      });
    },
  );

  it("derives the pilot hosts' answers from their repository, not from a default", () => {
    expect(
      admissionInput(UPDATE_INSTRUCTION, UPDATE_HOST, ["docs/configuration.md", "docs/new.md"])
        .existence,
    ).toEqual([
      { path: "docs/configuration.md", existing: "file" },
      { path: "docs/new.md", existing: "absent" },
    ]);
    expect(PILOT_REPOSITORY.tracked).toContain("docs/configuration.md");
  });
});

describe("request-intent Supply questions are sealed and re-verify", () => {
  const cases: readonly [string, () => RequestIntentAdmissionResult, string][] = [
    [
      "target missing on a create",
      () =>
        interpret(
          { ...proposalOf("create", []), preserve: [{ quote: "Keep it local" }] },
          "Keep it local.",
          pilotHost("create"),
        ),
      "request-intent-target-missing",
    ],
    [
      "target absent",
      () =>
        run("update", [{ path: "docs/new.md" }], answering("update", { "docs/new.md": "absent" })),
      "request-intent-target-absent",
    ],
    [
      "target present",
      () =>
        run("create", [{ path: "docs/cli.md" }], answering("create", { "docs/cli.md": "file" })),
      "request-intent-target-present",
    ],
    [
      "case-ambiguous target",
      () =>
        run(
          "update",
          [{ path: "docs/CLI.md" }],
          answering("update", { "docs/CLI.md": "case-fold" }),
        ),
      "request-intent-target-case-ambiguous",
    ],
    [
      "target not a file",
      () => run("update", [{ path: "docs/cli" }], answering("update", { "docs/cli": "directory" })),
      "request-intent-target-not-file",
    ],
  ];

  it.each(cases)(
    "%s: seals the question and verifies it from the record",
    (_name, result, code) => {
      const outcome = result();
      expect(outcome).toMatchObject({ outcome: "question", code });
      if (outcome.outcome !== "question") return;
      expect(outcome.intent.question).not.toBeNull();
      expect(outcome.intent.question).toEqual(outcome.question);
      expect(outcome.question.recommendedDefault).toBe("stop");
      expect(outcome.question.options).toContain("stop");
      expect(outcome.question.consequence).toBe(STOP_CONSEQUENCE);
      const recorded = JSON.parse(JSON.stringify(outcome.intent));
      const text =
        code === "request-intent-target-missing"
          ? "Keep it local."
          : instructionFor(outcome.intent.targets.map((target) => ({ path: target.path })));
      expect(verifyRequestIntentDigest(recorded, text)).toEqual(outcome.intent);
    },
  );

  it.each([
    [
      "operation mismatch",
      () =>
        run("create", [{ path: "docs/new.md" }], answering("update", { "docs/new.md": "absent" })),
      instructionFor([{ path: "docs/new.md" }]),
      "request-intent-operation-mismatch",
    ],
    [
      "target missing on an update",
      () =>
        interpret(
          { ...proposalOf("update", []), preserve: [{ quote: "Keep it local" }] },
          "Keep it local.",
          pilotHost("update"),
        ),
      "Keep it local.",
      "request-intent-target-missing",
    ],
  ] as const)(
    "%s: seals the reading with no question and verifies it from the record",
    (_name, result, instruction, code) => {
      const outcome = result();
      expect(outcome).toMatchObject({ outcome: "advisory", code });
      if (outcome.outcome !== "advisory") return;
      expect(outcome.intent.question).toBeNull();
      const recorded = JSON.parse(JSON.stringify(outcome.intent));
      expect(verifyRequestIntentDigest(recorded, instruction)).toEqual(outcome.intent);
    },
  );

  it("builds every question from structure: the observed path and operations, never the request", () => {
    const first = run(
      "update",
      [{ path: "docs/new.md" }],
      answering("update", { "docs/new.md": "absent" }),
    );
    const second = interpret(
      proposalOf("update", [{ path: "docs/new.md", quote: "Please fix docs/new.md" }]),
      "Please fix docs/new.md quickly, it is urgent.",
      answering("update", { "docs/new.md": "absent" }),
    );
    expect(first.outcome === "question" && second.outcome === "question").toBe(true);
    if (first.outcome !== "question" || second.outcome !== "question") return;
    expect(second.question).toEqual(first.question);
    expect(first.question.question).toBe(
      "The request asks to update docs/new.md, which does not exist. What should happen?",
    );
  });

  it("keeps a null sealed question meaning admitted", () => {
    const intent = admitted(interpret(updateProposal(), UPDATE_INSTRUCTION, UPDATE_HOST));
    expect(intent.question).toBeNull();
    const recorded = resealed(intent, { question: null });
    expect(verifyRequestIntentDigest(recorded, UPDATE_INSTRUCTION).question).toBeNull();
  });
});

describe("request-intent named paths in CJK and full-width text", () => {
  it.each([
    ["Han text before and after", "请更新docs/cli.md的内容。", "更新docs/cli.md"],
    ["an ideographic full stop", "请更新docs/cli.md。", "docs/cli.md"],
    ["an ideographic comma", "更新docs/cli.md，然后停止。", "docs/cli.md"],
    ["full-width parentheses", "请更新（docs/cli.md）。", "docs/cli.md"],
    ["corner brackets", "请更新「docs/cli.md」。", "docs/cli.md"],
    ["a full-width colon", "docs/cli.md：修正标志。", "docs/cli.md"],
    ["Katakana before", "ページdocs/cli.mdを更新", "ページdocs/cli.md"],
    ["Thai after", "แก้ไขdocs/cli.mdตอนนี้", "docs/cli.md"],
    ["Latin words inside the Han text after", "更新docs/cli.md中的flags部分", "docs/cli.md"],
    ["Han text ending in an ASCII full stop", "请更新docs/cli.md的内容.", "docs/cli.md"],
    ["Han text and a fragment after", "更新docs/cli.md的内容#flags", "docs/cli.md"],
    [
      "another path after a full-width bracket",
      "更新docs/cli.md的内容（见docs/a.md）",
      "docs/cli.md",
    ],
    [
      "another path before a full-width bracket",
      "（docs/a.md）请更新docs/cli.md",
      "更新docs/cli.md",
    ],
  ])("admits a named docs/cli.md written with %s", (_name, instruction, quote) => {
    const proposal = proposalOf("update", [{ path: "docs/cli.md", quote }]);
    expect(admitted(interpret(proposal, instruction, UPDATE_HOST)).targets[0]!.path).toBe(
      "docs/cli.md",
    );
  });

  it.each([
    ["part of a longer Han segment", "docs/指", "更新docs/指南.md。", "更新docs/指南.md"],
    [
      "part of a longer Latin name before Han",
      "docs/cli",
      "更新docs/cli.mdx的内容",
      "更新docs/cli.mdx",
    ],
    ["a Latin letter before the path", "docs/cli.md", "更新xdocs/cli.md的内容", "更新xdocs/cli.md"],
    [
      "a prefix of a mixed-script file name",
      "docs/api",
      "请创建docs/api参考.md页面",
      "创建docs/api",
    ],
    ["a prefix of a mixed-script directory", "docs/api", "更新docs/api参考/x.md", "更新docs/api"],
    // No slash or dot follows, but an unextended path may run on into Han text.
    ["an unextended prefix of a mixed-script name", "docs/api", "更新docs/api参考", "更新docs/api"],
    // Only an extension on the last segment counts, and a leading dot is none.
    [
      "an unextended name under a dotted directory",
      "docs/v1.0/api",
      "更新docs/v1.0/api参考",
      "更新docs/v1.0/api",
    ],
    ["an unextended dot-file name", "docs/.pages", "更新docs/.pages参考", "更新docs/.pages"],
    // An extended path still runs on past an edge into a dot or a slash.
    [
      "an extended prefix of a mixed-script file name",
      "docs/v1.0",
      "请创建docs/v1.0参考.md页面",
      "创建docs/v1.0",
    ],
    [
      "an extended prefix of a mixed-script directory",
      "docs/v1.0",
      "更新docs/v1.0参考/指南",
      "更新docs/v1.0",
    ],
    ["the Han tail of a longer Han name", "南.md", "更新指南.md的内容", "更新指南.md"],
    [
      "a prefix of a mixed-script path with no extension",
      "docs/api",
      "更新docs/api参考/指南",
      "更新docs/api",
    ],
    [
      "part of a longer Han name with no extension",
      "docs/指",
      "更新docs/指南的内容",
      "更新docs/指",
    ],
    ["a suffix of a mixed-script directory", "docs/x.md", "请看a/参考docs/x.md", "参考docs/x.md"],
    [
      "a suffix past a dotted mixed-script name",
      "docs/x.md",
      "请看v1.参考docs/x.md",
      "参考docs/x.md",
    ],
    // Errs closed: a Han conjunction between two paths leaves neither a whole token.
    [
      "joined to another path by Han text",
      "docs/cli.md",
      "更新docs/cli.md和docs/api.md",
      "更新docs/cli.md",
    ],
  ])("rejects a named path that is %s", (_name, path, instruction, quote) => {
    const proposal = proposalOf("update", [{ path, quote }]);
    expect(arm(interpret(proposal, instruction, UPDATE_HOST))).toEqual({
      outcome: "rejected",
      code: "request-intent-named-ungrounded",
      location: "$.targets[].path",
    });
  });

  it("rejects a create that grounds a named docs/api on the operator's docs/api参考.md", () => {
    const proposal = proposalOf("create", [{ path: "docs/api", quote: "创建docs/api" }]);
    expect(arm(interpret(proposal, "请创建docs/api参考.md页面", CREATE_HOST))).toEqual({
      outcome: "rejected",
      code: "request-intent-named-ungrounded",
      location: "$.targets[].path",
    });
    // The whole mixed-script name grounds.
    const whole = proposalOf("create", [{ path: "docs/api参考.md", quote: "创建docs/api参考.md" }]);
    admitted(interpret(whole, "请创建docs/api参考.md页面", CREATE_HOST));
  });

  it.each(["请创建docs/api 参考页面", "请创建docs/api。", "请创建「docs/api」页面"])(
    "grounds an unextended named path that a space, mark or bracket ends: %s",
    (instruction) => {
      const quote = instruction.includes("「") ? "docs/api" : "创建docs/api";
      const named = proposalOf("create", [{ path: "docs/api", quote }]);
      expect(admitted(interpret(named, instruction, CREATE_HOST)).targets[0]!.path).toBe(
        "docs/api",
      );
    },
  );

  it("still needs ASCII sentence punctuation to end the token", () => {
    const proposal = proposalOf("update", [{ path: "docs/cli.md", quote: "更新docs/cli.md.bak" }]);
    expect(arm(interpret(proposal, "更新docs/cli.md.bak的内容", UPDATE_HOST)).code).toBe(
      "request-intent-named-ungrounded",
    );
  });
});

describe("request-intent .git aliases a file system opens as .git", () => {
  const createAt = (path: string) =>
    edited(createProposal(), (p) => {
      (p.targets as Proposal[])[0]!.path = path;
    });

  it.each([
    ".git./config",
    ".git /config",
    "docs/.git../x",
    "docs/.GIT. /x",
    "docs/.g‌it/x",
    "﻿.git/HEAD",
  ])("refuses the target %j as the internal segment .git", (path) => {
    expect(interpret(createAt(path), CREATE_INSTRUCTION, CREATE_HOST)).toMatchObject({
      outcome: "refused",
      code: "request-intent-internal-path",
      boundary: { kind: "internal-segment", segment: ".git", observed: path },
    });
  });

  it.each([
    "docs/.gitkeep",
    "docs/.git-notes.md",
    "docs/git./x.md",
    "docs/.github/x.md",
    "docs/x.git/y.md",
  ])("admits the target %j, which a file system does not open as .git", (path) => {
    expect(
      admitted(interpret(createAt(path), CREATE_INSTRUCTION, CREATE_HOST)).targets[0]!.path,
    ).toBe(path);
  });

  it("refuses a re-sealed record whose target is a .git alias", () => {
    const intent = admitted(interpret(createProposal(), CREATE_INSTRUCTION, CREATE_HOST));
    const forged = resealed(intent, {
      targets: [{ ...intent.targets[0]!, path: ".git./config" }],
    });
    let code: string | undefined;
    try {
      verifyRequestIntentDigest(forged, CREATE_INSTRUCTION);
    } catch (error) {
      code = (error as RequestIntentContractError).code;
    }
    expect(code).toBe("sealed-internal-path");
  });
});
