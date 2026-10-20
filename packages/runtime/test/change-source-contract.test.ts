// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `--change` grammar, its run-only CLI admission, the closed contract
 * decoders, and the failure-class catalog for every change-source code.
 */
import { describe, expect, it } from "vitest";

import { handleSourcesCommand } from "../src/cli/commands/sources.js";
import { parseDoArguments } from "../src/cli/commands/do-parse.js";
import { parseLiveAgentArguments } from "../src/cli/commands/live-agent.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION } from "../src/inputs/merged-mr-instruction.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.js";
import {
  CHANGE_SOURCE_REFUSAL_CODES,
  ChangeSourceError,
  createChangeSource,
  decodeChangeSourceV1,
  parseChangeSourceSelector,
  type ChangeSourceBodyV1,
} from "../src/inputs/change-source.js";
import {
  decodePinnedRepositoryRevisionV1,
  PinnedRepositoryRevisionError,
} from "../src/inputs/change-source/revision.js";
import { operatorCodeFailureClass } from "../src/operator/failure-classification.js";

const BASE = [
  "update-documentation",
  "--repo",
  "/tmp/change-source-cli",
  "--instruction",
  "Update the guide.",
];

function refusalCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ChangeSourceError) return error.code;
    throw error;
  }
  return undefined;
}

describe("--change selector grammar", () => {
  it("accepts two-dot, three-dot, single-commit and symbolic forms, matching ... before ..", () => {
    expect(parseChangeSourceSelector("HEAD~1..HEAD")).toMatchObject({
      form: "two-dot",
      base: "HEAD~1",
      head: "HEAD",
    });
    expect(parseChangeSourceSelector("main...feature/x")).toMatchObject({
      form: "three-dot",
      base: "main",
      head: "feature/x",
    });
    expect(parseChangeSourceSelector("v1.0..v1.1")).toMatchObject({ base: "v1.0", head: "v1.1" });
    expect(parseChangeSourceSelector("HEAD")).toMatchObject({
      form: "single-commit",
      base: null,
      head: "HEAD",
    });
    expect(parseChangeSourceSelector("a".repeat(40))).toMatchObject({ head: "a".repeat(40) });
    expect(parseChangeSourceSelector("HEAD^2")).toMatchObject({ head: "HEAD^2" });
  });

  it("refuses open ranges, revision suffixes, reflog, search and path forms by grammar", () => {
    for (const value of [
      "A..",
      "..B",
      "A...",
      "...B",
      "HEAD^!",
      "HEAD^@",
      "HEAD@{1}",
      "@{-1}",
      ":/fix",
      "HEAD:docs/a.md",
      "^main",
      "-p",
      "a b",
      "A....B",
    ]) {
      expect(
        refusalCode(() => parseChangeSourceSelector(value)),
        value,
      ).toBe("change-source-selector-grammar");
    }
  });

  it("refuses URLs and merge-request references as an unsupported kind, never as a range", () => {
    // GitLab merge request forms and github.com pull or commit URLs belong to their own kinds.
    for (const value of [
      "https://gitlab.example.test/group/project/-/compare/a...b",
      "https://forge.example.test/org/repo/pull/7",
      "github.com/org/repo/pull/7",
      "git@gitlab.example.test:group/project.git",
    ]) {
      expect(
        refusalCode(() => parseChangeSourceSelector(value)),
        value,
      ).toBe("change-source-kind-unsupported");
    }
  });
});

describe("docsfab run --change admission", () => {
  it("admits both attachment forms on both source-aware workflows and keeps the selector off the projection fields", () => {
    const spaced = parseRunArguments([...BASE, "--change", "HEAD~1..HEAD"]);
    const attached = parseRunArguments([...BASE, "--change=HEAD~1..HEAD"]);
    expect(spaced.changeSource).toEqual(attached.changeSource);
    expect(spaced.changeSource).toMatchObject({ form: "two-dot", base: "HEAD~1", head: "HEAD" });
    const created = parseRunArguments([
      "create-documentation",
      "--instruction",
      "Create the page.",
      "--change",
      "HEAD",
      "--source",
      "docs/a.md",
    ]);
    expect(created.changeSource).toMatchObject({ form: "single-commit" });
    expect(created.sourcePaths).toEqual(["docs/a.md"]);
    expect(Object.hasOwn(parseRunArguments(BASE), "changeSource")).toBe(false);
  });

  it("admits --change beside a full --revision", () => {
    const parsed = parseRunArguments([
      ...BASE,
      "--change",
      "HEAD~1..HEAD",
      "--revision",
      "c".repeat(40),
    ]);
    expect(parsed.revision).toBe("c".repeat(40));
    expect(parsed.changeSource).toBeDefined();
  });

  it("admits an immutable --change basis for read-only review without widening --source or --pr", () => {
    const review = [
      "review-documentation",
      "--repo",
      "/tmp/change-source-cli",
      "--instruction",
      "Review the changed guide.",
    ];
    const admitted = parseRunArguments([...review, "--change", "HEAD~1..HEAD"]);
    expect(admitted.changeSource).toEqual(parseChangeSourceSelector("HEAD~1..HEAD"));
    expect(admitted.allowWrite).toBe(false);
    expect(() => parseRunArguments([...review, "--source", "docs/guide.md"])).toThrow();
    expect(() => parseRunArguments([...review, "--pr", "813"])).toThrow();
    expect(() => parseRunArguments([...review, "--change", "HEAD", "--pr", "813"])).toThrow();
  });

  it("refuses each combination it cannot bind, by code", () => {
    const cases: Array<[readonly string[], string]> = [
      [[...BASE, "--change", "HEAD", "--mr", "813"], "change-source-selector-conflict"],
      [[...BASE, "--pr=813", "--change=HEAD"], "change-source-selector-conflict"],
      [[...BASE, "--change", "HEAD", "--change", "HEAD~1"], "change-source-selector-repeated"],
      [[...BASE, "--change"], "change-source-option-value-missing"],
      [[...BASE, "--change="], "change-source-option-value-missing"],
      [[...BASE, "--change-range", "HEAD"], "change-source-option-form-unrecognized"],
      [[...BASE, "--chang", "HEAD"], "change-source-option-form-unrecognized"],
      [
        [...BASE, "--change", "https://forge.example.test/org/repo/pull/7"],
        "change-source-kind-unsupported",
      ],
      [
        [
          "update-documentation",
          "--instruction",
          MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
          "--change",
          "HEAD",
        ],
        "change-source-date-window-conflict",
      ],
      [
        [
          "create-documentation",
          "--resume-from",
          "stopped-run",
          "--canon-snapshot",
          "snapshot.json",
          "--allow-write",
          "--accept-candidate-snapshot",
          "--authority-id",
          "operator",
          "--change",
          "HEAD",
        ],
        "change-source-resume-unsupported",
      ],
      [["audit-documentation", "--change", "HEAD"], "change-source-workflow-unsupported"],
    ];
    for (const [argv, code] of cases) {
      expect(
        refusalCode(() => parseRunArguments([...argv])),
        argv.join(" "),
      ).toBe(code);
    }
  });

  it("keeps --changed-path on its own retired refusal", () => {
    expect(() => parseRunArguments([...BASE, "--changed-path", "src/a.ts"])).toThrowError(
      "The --changed-path option is not supported. Use review-documentation for read-only review.",
    );
  });

  it("is not admitted by the shared source admission: live-agent and sources refuse it", async () => {
    expect(() => parseLiveAgentArguments(["--change=HEAD"])).toThrowError(
      "DocsFab live-agent does not recognize the option: --change=HEAD.",
    );
    expect(() => parseLiveAgentArguments(["--change", "HEAD"])).toThrowError(
      "DocsFab live-agent does not recognize the option: --change.",
    );
    const errors: string[] = [];
    const result = await handleSourcesCommand(["--change=HEAD"], {
      write: () => undefined,
      writeError: (text) => errors.push(text),
      cwd: "/tmp",
    });
    process.exitCode = undefined;
    expect(result.refused).toBe(true);
    expect(errors.join("")).toContain("ATTENTION: That is not an option this command accepts");
    // `do` admits it through its own call, after the shared admission.
    expect(parseDoArguments(["update the guide", "--change=HEAD"]).changeSource).toEqual(
      parseChangeSourceSelector("HEAD"),
    );
  });
});

describe("change-source contract decoders", () => {
  const head = "b".repeat(40);
  const body: ChangeSourceBodyV1 = {
    source: { kind: "local-range" },
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository: { kind: "local-checkout", identitySha256: "c".repeat(64) },
      base: "a".repeat(40),
      head,
    },
    objectFormat: "sha1",
    rangeSemantics: "two-dot",
    mergeBase: null,
    diffFrom: "a".repeat(40),
    baseTree: "d".repeat(40),
    headTree: "e".repeat(40),
    commits: [{ id: head, parents: ["a".repeat(40)], subject: "Café, NFD: Café" }],
    files: [
      {
        status: "M",
        similarity: null,
        oldPath: "docs/a.md",
        newPath: "docs/a.md",
        oldMode: "100644",
        newMode: "100644",
        oldBlob: "1".repeat(40),
        newBlob: "2".repeat(40),
        binary: false,
        added: 1,
        removed: 1,
      },
    ],
    labels: [],
    protocol: { renameSimilarityPercent: 50, contextLines: 3, diffAlgorithm: "myers" },
  };

  it("round-trips a sealed change source and keeps non-NFC repository text exactly", () => {
    const sealed = createChangeSource(body);
    const decoded = decodeChangeSourceV1(JSON.parse(JSON.stringify(sealed)));
    expect(decoded).toEqual(sealed);
    expect(decoded.commits[0]!.subject).toBe("Café, NFD: Café");
  });

  it("refuses an extra key, a stale digest, and a symbolic revision", () => {
    const sealed = JSON.parse(JSON.stringify(createChangeSource(body)));
    expect(() => decodeChangeSourceV1({ ...sealed, extra: true })).toThrowError(
      expect.objectContaining({ code: "change-source-contract-invalid-shape" }),
    );
    expect(() =>
      decodeChangeSourceV1({ ...sealed, labels: ["info-attributes-present"] }),
    ).toThrowError(expect.objectContaining({ code: "change-source-contract-digest-mismatch" }));
    expect(() =>
      createChangeSource({ ...body, revision: { ...body.revision, head: "HEAD" } }),
    ).toThrowError(PinnedRepositoryRevisionError);
  });

  it("decodes the commit-list labels, and the ancestry marker only beside its label", () => {
    const other = "f".repeat(40);
    const two = [
      { id: other, parents: ["a".repeat(40)], subject: "base history" },
      { id: head, parents: [other], subject: "the change" },
    ];
    const marked = (values: readonly unknown[]) =>
      two.map((entry, index) => ({ ...entry, descendsFromDiffBase: values[index] }));
    const label = "commit-list-may-include-base-history" as const;
    const invalid = expect.objectContaining({ code: "change-source-contract-invalid-value" });

    const incomplete = createChangeSource({ ...body, labels: ["commit-list-incomplete-shallow"] });
    expect(decodeChangeSourceV1(JSON.parse(JSON.stringify(incomplete))).labels).toEqual([
      "commit-list-incomplete-shallow",
    ]);
    const overlisted = createChangeSource({
      ...body,
      commits: marked([false, true]) as ChangeSourceBodyV1["commits"],
      labels: [label],
    });
    const decoded = decodeChangeSourceV1(JSON.parse(JSON.stringify(overlisted)));
    expect(decoded.commits.map((entry) => entry.descendsFromDiffBase)).toEqual([false, true]);

    // The label without a marker, a marker without the label, a partial or
    // non-boolean marker, and a label with every commit proven all refuse.
    for (const variant of [
      { commits: two, labels: [label] },
      { commits: marked([false, true]), labels: [] },
      { commits: [marked([false])[0], two[1]], labels: [label] },
      { commits: marked(["no", true]), labels: [label] },
      { commits: marked([true, true]), labels: [label] },
    ]) {
      expect(() =>
        createChangeSource({ ...body, ...variant } as unknown as ChangeSourceBodyV1),
      ).toThrowError(invalid);
    }
  });

  it("decodes the shared pinned revision shape with and without a base", () => {
    const repository = { kind: "local-checkout", identitySha256: "c".repeat(64) };
    expect(
      decodePinnedRepositoryRevisionV1({
        schemaVersion: 1,
        kind: "docsfab-pinned-repository-revision",
        repository,
        head,
      }),
    ).toEqual({ schemaVersion: 1, kind: "docsfab-pinned-repository-revision", repository, head });
    expect(() =>
      decodePinnedRepositoryRevisionV1({
        schemaVersion: 1,
        kind: "docsfab-pinned-repository-revision",
        repository,
        base: "a".repeat(64),
        head,
      }),
    ).toThrowError(expect.objectContaining({ code: "pinned-revision-invalid-value" }));
  });
});

describe("change-source failure classes", () => {
  it("classes every change-source refusal and every change-source limit refusal", () => {
    for (const code of CHANGE_SOURCE_REFUSAL_CODES) {
      expect(operatorCodeFailureClass(code), code).toBeDefined();
    }
    expect(operatorCodeFailureClass("change-source-integrity-mismatch")).toBe("contract-shape");
    expect(operatorCodeFailureClass("change-source-git-failed")).toBe("infrastructure");
    expect(operatorCodeFailureClass("change-source-selector-grammar")).toBe("operator-input");
    for (const name of [
      "changeSources.commitsMax",
      "changeSources.changedFilesMax",
      "changeSources.diffMaxBytes",
      "changeSources.shallowBoundaryCommitsMax",
    ]) {
      expect(operatorCodeFailureClass(LIMIT_DEFINITION_BY_NAME[name]!.refusal), name).toBe("bound");
    }
  });
});
