// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The change-source extension seams: the per-kind source decoder and codec
 * factory, the forge-reported body variant, the selector and kind-dispatch
 * tables, forge repository identities, the resolver's source and identity
 * parameters, per-kind producer ids, and the shared raw-object helpers. A
 * golden capture from the stack base pins the local record's bytes.
 *
 * Level labels: the forge variant is proven at DECODER level, kind
 * registration at REGISTRATION level with a test-only kind that never ships,
 * and annotated-tag verification at HELPER level.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHANGE_SOURCE_KIND_ARMS,
  resolveCliChangeSource,
  resolveCliChangeSourceEvidence,
  type ChangeSourceKindArm,
} from "../src/cli/run/source-acquisition.js";
import { MAX_GIT_OUTPUT_BYTES, runTrustedGit } from "../src/host-invoker/trusted-git.js";
import {
  CHANGE_SOURCE_KINDS,
  CHANGE_SOURCE_PROVENANCES,
  CHANGE_SOURCE_SELECTOR_ARMS,
  CHANGE_SOURCE_SOURCE_DECODERS,
  ChangeSourceContractError,
  ChangeSourceError,
  changeSourceProvenance,
  createChangeSource,
  createChangeSourceCodec,
  decodeChangeSourceV1,
  GIT_EMPTY_TREE_IDS,
  parseChangeSourceSelector,
  type ChangeSourceBodyV1,
  type ChangeSourceMemberV1,
  type ChangeSourceSelectorArm,
  type ChangeSourceSelectorMemberV1,
  type ChangeSourceSourceDecoder,
  type ResolvedChangeSourceV1,
} from "../src/inputs/change-source.js";
import {
  CHANGE_SOURCE_PRODUCER_IDS,
  digestChangeSourceProducerScope,
} from "../src/inputs/change-source/acquisition.js";
import { resolveLocalChangeSource } from "../src/inputs/change-source/local.js";
import {
  rawParents,
  readObjects,
  verified,
  type RawObjectReader,
} from "../src/inputs/change-source/objects.js";
import {
  decodePinnedRepositoryRevisionV1,
  githubRepositoryIdentity,
  gitlabProjectIdentity,
  PinnedRepositoryRevisionError,
  type PinnedRepositoryIdentityV1,
} from "../src/inputs/change-source/revision.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  buildGoldenRepository,
  commitFiles,
  fixtureGit,
  initChangeRepository,
  rewriteLooseObject,
} from "./support/change-source-fixture.js";

const roots = temporaryRoots();

async function repository(
  files?: Readonly<Record<string, string | Uint8Array | null>>,
  options?: { readonly objectFormat?: "sha1" | "sha256" },
) {
  return (await initChangeRepository(await roots.create("docsfab-seams-"), files, options))
    .repository;
}

/** The error a call throws, so its class and code can be asserted. */
async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function expectChangeSourceCode(run: () => unknown, code: string): Promise<void> {
  const error = await caught(run);
  expect(error).toBeInstanceOf(ChangeSourceError);
  expect((error as ChangeSourceError).code).toBe(code);
}

async function expectContractCode(run: () => unknown, code: string): Promise<void> {
  const error = await caught(run);
  expect(error).toBeInstanceOf(ChangeSourceContractError);
  expect((error as ChangeSourceContractError).code).toBe(code);
}

async function expectPinnedCode(run: () => unknown, code: string): Promise<void> {
  const error = await caught(run);
  expect(error).toBeInstanceOf(PinnedRepositoryRevisionError);
  expect((error as PinnedRepositoryRevisionError).code).toBe(code);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function manifestText(resolved: ResolvedChangeSourceV1<ChangeSourceMemberV1>): string {
  return Buffer.from(resolved.manifestBytes).toString("utf8");
}

const id = (character: string) => character.repeat(40);

/** A strict local-verified body of the test-only kind. */
function strictBody(
  source: ChangeSourceMemberV1 = { kind: "test-forge", provenance: "local-verified" },
): ChangeSourceBodyV1<ChangeSourceMemberV1> {
  return {
    source,
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository: gitlabProjectIdentity({ host: "gitlab.example.test", projectId: 7 }),
      base: id("a"),
      head: id("b"),
    },
    objectFormat: "sha1",
    rangeSemantics: "three-dot",
    mergeBase: id("a"),
    diffFrom: id("a"),
    baseTree: id("d"),
    headTree: id("e"),
    commits: [{ id: id("b"), parents: [id("a")], subject: "Change the export path" }],
    files: [
      {
        status: "M",
        similarity: null,
        oldPath: "src/export.ts",
        newPath: "src/export.ts",
        oldMode: "100644",
        newMode: "100644",
        oldBlob: id("1"),
        newBlob: id("2"),
        binary: false,
        added: 1,
        removed: 1,
      },
    ],
    labels: [],
    protocol: { renameSimilarityPercent: 50, contextLines: 3, diffAlgorithm: "myers" },
  };
}

/** The same change as a forge reported it: every nullable field null, a forge omission. */
function forgeBody(): ChangeSourceBodyV1<ChangeSourceMemberV1> {
  const strict = strictBody({ kind: "test-forge", provenance: "forge-reported" });
  return {
    ...strict,
    baseTree: null,
    headTree: null,
    files: [
      {
        status: "M",
        similarity: null,
        oldPath: "src/export.ts",
        newPath: "src/export.ts",
        oldMode: null,
        newMode: null,
        oldBlob: null,
        newBlob: null,
        binary: false,
        added: null,
        removed: null,
        diffOmitted: {
          code: "change-source-file-diff-omitted",
          basis: "forge-omitted",
          forgeReason: "too-large",
        },
      },
    ],
    protocol: { provider: "gitlab" },
  };
}

/** A test-only member decoder: closed keys, provenance carried explicitly. */
const testForgeDecoder: ChangeSourceSourceDecoder = (root, decode) => {
  decode.exact(root, ["kind", "provenance"]);
  return {
    kind: "test-forge",
    provenance: decode.enumeration(root.provenance, CHANGE_SOURCE_PROVENANCES),
  };
};

const testCodec = createChangeSourceCodec({
  ...CHANGE_SOURCE_SOURCE_DECODERS,
  "test-forge": testForgeDecoder,
});

function withFile(
  body: ChangeSourceBodyV1<ChangeSourceMemberV1>,
  patch: Record<string, unknown>,
): ChangeSourceBodyV1<ChangeSourceMemberV1> {
  return {
    ...body,
    files: [{ ...body.files[0]!, ...patch }] as ChangeSourceBodyV1["files"],
  };
}

describe("golden local record (T2)", () => {
  it(
    "resolves byte-identical manifests and scope digests to the stack-base capture, and defaults equal explicit defaults",
    async () => {
      const golden = JSON.parse(
        await readFile(
          fileURLToPath(
            new URL("./fixtures/change-source/golden-local-range-v1.json", import.meta.url),
          ),
          "utf8",
        ),
      ) as {
        identity: PinnedRepositoryIdentityV1;
        readScope: string[];
        cases: Record<string, { manifest: string; producerScopeSha256: string }>;
      };
      const repo = await buildGoldenRepository(await roots.create("docsfab-golden-"));
      const workspaceRevision = await fixtureGit(repo, ["rev-parse", "feature"]);
      const selectors: Record<string, string> = {
        "two-dot": "main..feature",
        "three-dot": "main...feature",
        "root-single-commit": "root",
      };
      expect(Object.keys(golden.cases).sort()).toEqual(Object.keys(selectors).sort());
      for (const [name, value] of Object.entries(selectors)) {
        const selector = parseChangeSourceSelector(value);
        const injected = await resolveLocalChangeSource({
          sourcePath: repo,
          selector,
          workspaceRevision,
          repository: golden.identity,
        });
        expect(
          Buffer.from(injected.manifestBytes).equals(Buffer.from(golden.cases[name]!.manifest)),
          name,
        ).toBe(true);
        expect(
          digestChangeSourceProducerScope({
            changeSource: injected.changeSource,
            readScope: golden.readScope,
          }),
          name,
        ).toBe(golden.cases[name]!.producerScopeSha256);

        const defaults = await resolveLocalChangeSource({
          sourcePath: repo,
          selector,
          workspaceRevision,
        });
        const explicit = await resolveLocalChangeSource({
          sourcePath: repo,
          selector,
          workspaceRevision,
          source: { kind: "local-range" },
          repository: { kind: "local-checkout", identitySha256: sha256Hex(repo) },
        });
        expect(
          Buffer.from(explicit.manifestBytes).equals(Buffer.from(defaults.manifestBytes)),
        ).toBe(true);
        expect(Buffer.from(explicit.diffBytes).equals(Buffer.from(defaults.diffBytes))).toBe(true);
        expect(defaults.changeSource.revision.repository).toEqual({
          kind: "local-checkout",
          identitySha256: sha256Hex(repo),
        });
      }
    },
    testTimeoutMs(60_000),
  );
});

describe("per-kind source decoding (T3)", () => {
  const localBody = strictBody({ kind: "local-range" });

  it("decodes the local member and keys the shipped decoder table by exactly the shipped kinds", () => {
    const sealed = createChangeSource(localBody);
    expect(decodeChangeSourceV1(JSON.parse(JSON.stringify(sealed))).source).toEqual({
      kind: "local-range",
    });
    expect(Object.keys(CHANGE_SOURCE_SOURCE_DECODERS)).toEqual([...CHANGE_SOURCE_KINDS]);
    expect(changeSourceProvenance({ kind: "local-range" })).toBe("local-verified");
  });

  it("refuses an unknown or inherited kind, an extra key, and a provenance key on the local member", async () => {
    const sealed = JSON.parse(JSON.stringify(createChangeSource(localBody)));
    for (const kind of ["unknown-kind", "constructor", "__proto__", 7]) {
      await expectContractCode(
        () => decodeChangeSourceV1({ ...sealed, source: { kind } }),
        "change-source-contract-invalid-value",
      );
    }
    await expectContractCode(
      () => createChangeSource({ ...localBody, source: { kind: "unknown-kind" } }),
      "change-source-contract-invalid-value",
    );
    for (const source of [
      { kind: "local-range", extra: true },
      { kind: "local-range", provenance: "local-verified" },
    ]) {
      await expectContractCode(
        () => decodeChangeSourceV1({ ...sealed, source }),
        "change-source-contract-invalid-shape",
      );
    }
  });

  it("refuses a record of a kind the shipped codec lacks, sealed by a factory codec that has it", async () => {
    const sealed = JSON.parse(JSON.stringify(testCodec.create(forgeBody())));
    expect(testCodec.decode(sealed).source).toEqual({
      kind: "test-forge",
      provenance: "forge-reported",
    });
    await expectContractCode(
      () => decodeChangeSourceV1(sealed),
      "change-source-contract-invalid-value",
    );
  });

  it("refuses an arm whose member renames its kind or names an unknown provenance", async () => {
    // The table also holds the renamed-to kind, so only the arm-output check refuses.
    const renaming = createChangeSourceCodec({
      ...CHANGE_SOURCE_SOURCE_DECODERS,
      "test-forge": () => ({ kind: "local-range" }),
    });
    await expectContractCode(
      () => renaming.create(strictBody({ kind: "test-forge" })),
      "change-source-contract-invalid-value",
    );
    const bogus = createChangeSourceCodec({
      "test-forge": () => ({ kind: "test-forge", provenance: "bogus" as "forge-reported" }),
    });
    await expectContractCode(
      () => bogus.create(strictBody({ kind: "test-forge" })),
      "change-source-contract-invalid-value",
    );
    // Control: a member without provenance is local-verified and seals strictly.
    const plain = createChangeSourceCodec({ "test-forge": () => ({ kind: "test-forge" }) });
    expect(plain.create(strictBody({ kind: "test-forge" })).source).toEqual({ kind: "test-forge" });
  });
});

describe("object format widths (Amendment T)", () => {
  type Body = ChangeSourceBodyV1<ChangeSourceMemberV1>;
  const wide = (character: string) => character.repeat(64);
  const sha1Body = strictBody({ kind: "local-range" });
  const sha256Body: Body = {
    ...sha1Body,
    revision: { ...sha1Body.revision, base: wide("a"), head: wide("b") },
    objectFormat: "sha256",
    mergeBase: wide("a"),
    diffFrom: wide("a"),
    baseTree: wide("d"),
    headTree: wide("e"),
    commits: [{ id: wide("b"), parents: [wide("a")], subject: "Change the export path" }],
    files: [{ ...sha1Body.files[0]!, oldBlob: wide("1"), newBlob: wide("2") }],
  };
  // Every object id position in a record, each set to one replacement id. The
  // pinned revision already refuses a base whose width differs from its head,
  // so the base position moves with the head, and the head is also tried alone.
  const positions: Readonly<Record<string, (body: Body, value: string) => Body>> = {
    "revision.base": (body, value) => ({
      ...body,
      revision: { ...body.revision, base: value, head: value },
    }),
    "revision.head": (body, value) => {
      const { base: _base, ...revision } = body.revision;
      return { ...body, revision: { ...revision, head: value } };
    },
    mergeBase: (body, value) => ({ ...body, mergeBase: value }),
    diffFrom: (body, value) => ({ ...body, diffFrom: value }),
    baseTree: (body, value) => ({ ...body, baseTree: value }),
    headTree: (body, value) => ({ ...body, headTree: value }),
    "commits[].id": (body, value) => ({ ...body, commits: [{ ...body.commits[0]!, id: value }] }),
    "commits[].parents": (body, value) => ({
      ...body,
      commits: [{ ...body.commits[0]!, parents: [value] }],
    }),
    "files[].oldBlob": (body, value) => withFile(body, { oldBlob: value }),
    "files[].newBlob": (body, value) => withFile(body, { newBlob: value }),
  };

  it("covers all ten id positions, each refused at the other format's width in both directions", async () => {
    expect(Object.keys(positions)).toHaveLength(10);
    // Controls: every id at its record's width decodes, in both formats.
    expect(createChangeSource(sha1Body).objectFormat).toBe("sha1");
    expect(createChangeSource(sha256Body).objectFormat).toBe("sha256");
    for (const [position, set] of Object.entries(positions)) {
      for (const [body, foreign, own] of [
        [sha1Body, wide("f"), id("f")],
        [sha256Body, id("f"), wide("f")],
      ] as const) {
        // Adjacent condition: the same position at the record's own width decodes.
        expect(createChangeSource(set(body, own)).objectFormat, position).toBe(body.objectFormat);
        const error = await caught(() => createChangeSource(set(body, foreign)));
        expect(error, `${position} in a ${body.objectFormat} record`).toBeInstanceOf(
          ChangeSourceContractError,
        );
        expect((error as ChangeSourceContractError).code, position).toBe(
          "change-source-contract-invalid-value",
        );
      }
    }
  });

  it("leaves a base whose width differs from its head to the pinned revision's own refusal", async () => {
    await expectPinnedCode(
      () =>
        createChangeSource({
          ...sha1Body,
          revision: { ...sha1Body.revision, base: wide("f") },
        }),
      "pinned-revision-invalid-value",
    );
  });

  it("does not treat an absent base or a null merge base or diff base as a width mismatch", () => {
    const { base: _base, ...withoutBase } = sha256Body.revision;
    const sparse: Body = { ...sha256Body, revision: withoutBase, mergeBase: null, diffFrom: null };
    expect(createChangeSource(sparse).objectFormat).toBe("sha256");
  });

  it(
    "resolves a real SHA-256 repository through the local resolver, root commit against the SHA-256 empty tree",
    async () => {
      const repo = await repository({ "a.md": "one\n" }, { objectFormat: "sha256" });
      await commitFiles(repo, { "a.md": "two\n", "b.md": "bee\n" }, "second commit");
      const workspaceRevision = await fixtureGit(repo, ["rev-parse", "HEAD"]);
      expect(await fixtureGit(repo, ["rev-parse", "--show-object-format"])).toBe("sha256");

      const range = await resolveLocalChangeSource({
        sourcePath: repo,
        selector: parseChangeSourceSelector("HEAD~1..HEAD"),
        workspaceRevision,
      });
      const record = decodeChangeSourceV1(JSON.parse(manifestText(range)));
      expect(record.objectFormat).toBe("sha256");
      expect(record.revision.head).toBe(workspaceRevision);
      expect(record.revision.head).toMatch(/^[a-f0-9]{64}$/u);
      expect(record.headTree).toBe(await fixtureGit(repo, ["rev-parse", "HEAD^{tree}"]));
      expect(record.files.map((entry) => entry.newBlob?.length)).toEqual([64, 64]);

      const root = await resolveLocalChangeSource({
        sourcePath: repo,
        selector: parseChangeSourceSelector("HEAD~1"),
        workspaceRevision,
      });
      expect(root.changeSource.diffFrom).toBeNull();
      expect(root.changeSource.baseTree).toBe(GIT_EMPTY_TREE_IDS.sha256);
      // The empty tree id per format, from git itself.
      expect(await fixtureGit(repo, ["hash-object", "-t", "tree", "/dev/null"])).toBe(
        GIT_EMPTY_TREE_IDS.sha256,
      );
      const sha1 = await repository();
      expect(await fixtureGit(sha1, ["hash-object", "-t", "tree", "/dev/null"])).toBe(
        GIT_EMPTY_TREE_IDS.sha1,
      );
    },
    testTimeoutMs(60_000),
  );
});

describe("repository identity members (T4)", () => {
  const HOST = "gitlab.example.test";

  it("builds each forge identity as the digest of its canonical JSON and decodes all three members", () => {
    const gitlab = gitlabProjectIdentity({ host: HOST, projectId: 123 });
    expect(gitlab).toEqual({
      kind: "gitlab-project",
      identitySha256: sha256Hex(`{"host":"${HOST}","projectId":123}`),
    });
    const github = githubRepositoryIdentity({ host: "github.com", repositoryId: 456 });
    expect(github).toEqual({
      kind: "github-repository",
      identitySha256: sha256Hex('{"host":"github.com","repositoryId":456}'),
    });
    expect(gitlabProjectIdentity({ host: "gitlab.com", projectId: 123 }).identitySha256).not.toBe(
      gitlab.identitySha256,
    );
    const head = id("b");
    for (const repository of [
      gitlab,
      github,
      { kind: "local-checkout", identitySha256: "c".repeat(64) },
    ]) {
      expect(
        decodePinnedRepositoryRevisionV1({
          schemaVersion: 1,
          kind: "docsfab-pinned-repository-revision",
          repository,
          head,
        }).repository,
      ).toEqual(repository);
    }
  });

  it("refuses an unknown identity kind and an extra identity key", async () => {
    const head = id("b");
    const revision = (repository: unknown) => () =>
      decodePinnedRepositoryRevisionV1({
        schemaVersion: 1,
        kind: "docsfab-pinned-repository-revision",
        repository,
        head,
      });
    await expectPinnedCode(
      revision({ kind: "bitbucket-repository", identitySha256: "c".repeat(64) }),
      "pinned-revision-invalid-value",
    );
    await expectPinnedCode(
      revision({ kind: "gitlab-project", identitySha256: "c".repeat(64), projectId: 1 }),
      "pinned-revision-invalid-shape",
    );
  });

  it("refuses every non-canonical host and id instead of normalizing it", async () => {
    for (const host of [
      "GitLab.Example.test",
      "https://gitlab.example.test",
      "gitlab.example.test/",
      "gitlab.example.test.",
      "gitlab.example.test/group",
      " gitlab.example.test",
      "user@gitlab.example.test",
      "gitlab.example.test:8443",
      "",
    ]) {
      await expectPinnedCode(
        () => gitlabProjectIdentity({ host, projectId: 123 }),
        "pinned-revision-invalid-value",
      );
      await expectPinnedCode(
        () => githubRepositoryIdentity({ host, repositoryId: 123 }),
        "pinned-revision-invalid-value",
      );
    }
    for (const projectId of ["123", 0, -1, 1.5, 2 ** 53]) {
      await expectPinnedCode(
        () => gitlabProjectIdentity({ host: HOST, projectId: projectId as number }),
        "pinned-revision-invalid-value",
      );
      await expectPinnedCode(
        () => githubRepositoryIdentity({ host: HOST, repositoryId: projectId as number }),
        "pinned-revision-invalid-value",
      );
    }
    // Control: the canonical spelling builds.
    expect(gitlabProjectIdentity({ host: HOST, projectId: 123 }).kind).toBe("gitlab-project");
  });
});

describe("forge-reported body variant, decoder level (T5)", () => {
  it("seals a forge-reported body with null tree fields, a forge protocol and a forge omission", () => {
    const sealed = testCodec.create(forgeBody());
    const decoded = testCodec.decode(JSON.parse(JSON.stringify(sealed)));
    expect(decoded).toEqual(sealed);
    expect(decoded.baseTree).toBeNull();
    expect(decoded.files[0]!.diffOmitted).toEqual({
      code: "change-source-file-diff-omitted",
      basis: "forge-omitted",
      forgeReason: "too-large",
    });
    expect(decoded.protocol).toEqual({ provider: "gitlab" });
  });

  it("refuses each forge-only shape, one field at a time, under local-verified provenance", async () => {
    const strict = strictBody();
    // Control: the strict body of the same kind seals.
    expect(testCodec.create(strict).source).toEqual({
      kind: "test-forge",
      provenance: "local-verified",
    });
    const invalid = "change-source-contract-invalid-value";
    for (const [label, body, code] of [
      ["null base tree", { ...strict, baseTree: null }, invalid],
      ["null head tree", { ...strict, headTree: null }, invalid],
      ["null old mode", withFile(strict, { oldMode: null }), invalid],
      ["null new blob", withFile(strict, { newBlob: null }), invalid],
      [
        "forge protocol",
        { ...strict, protocol: { provider: "gitlab" } },
        "change-source-contract-invalid-shape",
      ],
      [
        "forge omission",
        withFile(strict, {
          diffOmitted: {
            code: "change-source-file-diff-omitted",
            basis: "forge-omitted",
            forgeReason: "collapsed",
          },
        }),
        invalid,
      ],
      [
        "local protocol with a provider key",
        { ...strict, protocol: { ...strict.protocol, provider: "gitlab" } },
        "change-source-contract-invalid-shape",
      ],
    ] as const) {
      const error = await caught(() =>
        testCodec.create(body as ChangeSourceBodyV1<ChangeSourceMemberV1>),
      );
      expect(error, label).toBeInstanceOf(ChangeSourceContractError);
      expect((error as ChangeSourceContractError).code, label).toBe(code);
    }
  });

  it("keeps the omission shapes closed per basis and the commit ids required under forge", async () => {
    const forge = forgeBody();
    const forgeOmission = forge.files[0]!.diffOmitted!;
    const shape = "change-source-contract-invalid-shape";
    for (const diffOmitted of [
      { ...forgeOmission, limitName: "changeSources.fileDiffMaxBytes" },
      { ...forgeOmission, observedBytes: 10 },
      { code: "change-source-file-diff-omitted", basis: "forge-omitted" },
      {
        code: "change-source-file-diff-omitted",
        basis: "measured",
        limitName: "changeSources.fileDiffMaxBytes",
        limitBytes: 10,
      },
      {
        code: "change-source-file-diff-omitted",
        basis: "measured",
        observedBytes: 11,
        limitBytes: 10,
      },
      {
        code: "change-source-file-diff-omitted",
        basis: "upper-bound",
        observedBytes: 11,
        limitName: "changeSources.fileDiffMaxBytes",
      },
    ]) {
      await expectContractCode(() => testCodec.create(withFile(forge, { diffOmitted })), shape);
    }
    await expectContractCode(
      () =>
        testCodec.create(
          withFile(forge, {
            diffOmitted: { ...forgeOmission, forgeReason: "unknown-reason" },
          }),
        ),
      "change-source-contract-invalid-value",
    );
    // A measured omission stays valid in a forge-reported record.
    expect(
      testCodec.create(
        withFile(forge, {
          diffOmitted: {
            code: "change-source-file-diff-omitted",
            basis: "measured",
            observedBytes: 11,
            limitName: "changeSources.fileDiffMaxBytes",
            limitBytes: 10,
          },
        }),
      ).files[0]!.diffOmitted!.basis,
    ).toBe("measured");
    await expectPinnedCode(
      () =>
        testCodec.create({
          ...forge,
          revision: { ...forge.revision, head: null as unknown as string },
        }),
      "pinned-revision-invalid-value",
    );
    await expectContractCode(
      () =>
        testCodec.create({
          ...forge,
          commits: [{ id: null as unknown as string, parents: [id("a")], subject: "x" }],
        }),
      "change-source-contract-invalid-value",
    );
    // The local protocol names no forge, so a forge-reported record refuses it.
    await expectContractCode(
      () => testCodec.create({ ...forge, protocol: strictBody().protocol }),
      shape,
    );
    // Control: the shipped codec refuses the same forge body by kind.
    await expectContractCode(
      () => createChangeSource(forge),
      "change-source-contract-invalid-value",
    );
  });
});

/** A test-only selector arm that claims `<project>/pull/<n>` values, never shipped. */
const testPullArm: ChangeSourceSelectorArm = (value) => {
  const match = /^([a-z0-9-]+\/[a-z0-9-]+)\/pull\/(\d+)$/u.exec(value);
  return match === null
    ? undefined
    : ({
        schemaVersion: 1,
        kind: "docsfab-change-source-selector",
        source: "test-forge",
        project: match[1]!,
        number: Number(match[2]),
      } as ChangeSourceSelectorMemberV1);
};

function sealedForgeResolution(): ResolvedChangeSourceV1<ChangeSourceMemberV1> {
  const forge = forgeBody();
  const changeSource = testCodec.create({
    ...forge,
    files: [
      forge.files[0]!,
      {
        ...forge.files[0]!,
        oldPath: "docs/large.md",
        newPath: "docs/large.md",
        diffOmitted: {
          code: "change-source-file-diff-omitted",
          basis: "measured",
          observedBytes: 11,
          limitName: "changeSources.fileDiffMaxBytes",
          limitBytes: 10,
        },
      },
    ],
  });
  return {
    changeSource,
    manifestBytes: new TextEncoder().encode(`${JSON.stringify(changeSource, null, 2)}\n`),
    diffBytes: new TextEncoder().encode("diff --git a/src/export.ts b/src/export.ts\n"),
  };
}

describe("kind registration, registration level (T6)", () => {
  it("parses a registered arm's value before the foreign-form refusal, and leaves every range local", async () => {
    const arms = [...CHANGE_SOURCE_SELECTOR_ARMS, testPullArm];
    expect(parseChangeSourceSelector("group/project/pull/7", arms)).toEqual({
      schemaVersion: 1,
      kind: "docsfab-change-source-selector",
      source: "test-forge",
      project: "group/project",
      number: 7,
    });
    // Control: the shipped table still refuses it as an unsupported kind.
    await expectChangeSourceCode(
      () => parseChangeSourceSelector("group/project/pull/7"),
      "change-source-kind-unsupported",
    );
    for (const value of [
      "HEAD",
      "HEAD~2..HEAD",
      "v1.2..v1.3",
      "main...feature/x",
      "feature/pull-request-ui..main",
      "group/project..main",
      "a".repeat(40),
      "release-1.0",
    ]) {
      expect(parseChangeSourceSelector(value, arms).source, value).toBe("local-range");
      expect(parseChangeSourceSelector(value, arms)).toEqual(parseChangeSourceSelector(value));
    }
    // The empty value refuses before any arm, even one that claims everything.
    const greedy: ChangeSourceSelectorArm = () => ({
      schemaVersion: 1,
      kind: "docsfab-change-source-selector",
      source: "test-forge",
    });
    await expectChangeSourceCode(
      () => parseChangeSourceSelector("", [greedy]),
      "change-source-option-value-missing",
    );
    expect(parseChangeSourceSelector("HEAD", [greedy]).source).toBe("test-forge");
  });

  it(
    "dispatches a registered kind to its own arm, mints its own producer id, and never falls back to the local resolver",
    async () => {
      const repo = await repository();
      const workspace = await prepareRepositoryWorkspace(repo, "HEAD");
      try {
        let localCalls = 0;
        let forgeCalls = 0;
        const localArm: ChangeSourceKindArm = (input) => {
          localCalls += 1;
          return CHANGE_SOURCE_KIND_ARMS["local-range"]!(input);
        };
        const forgeArm: ChangeSourceKindArm = async (input) => {
          forgeCalls += 1;
          expect(input.forge).toBeUndefined();
          return sealedForgeResolution();
        };
        const selector = parseChangeSourceSelector("group/project/pull/7", [testPullArm]);
        const statuses: string[] = [];
        const resolved = await resolveCliChangeSource(
          { workspace, selector, onStatus: (message) => statuses.push(message) },
          { "local-range": localArm, "test-forge": forgeArm },
        );
        expect([forgeCalls, localCalls]).toEqual([1, 0]);
        expect(resolved.changeSource.source.kind).toBe("test-forge");
        const omissions = statuses.filter((line) =>
          line.startsWith("change-source-file-diff-omitted: "),
        );
        expect(omissions).toEqual([
          "change-source-file-diff-omitted: src/export.ts diff was not sent by the forge (too-large); it stays listed in the change manifest without its diff",
          "change-source-file-diff-omitted: docs/large.md diff is 11 bytes, over changeSources.fileDiffMaxBytes = 10; it stays listed in the change manifest without its diff",
        ]);

        const producerIds = {
          ...CHANGE_SOURCE_PRODUCER_IDS,
          "test-forge": "change-source-test-forge",
        };
        const evidence = await resolveCliChangeSourceEvidence({
          workspace,
          resolved,
          admittedRequest: { workflow: "update-documentation", allowWrite: true },
          runId: "change-source-seams",
          producerIds,
        });
        expect(evidence.acquired.acquired.map((entry) => entry.observation.producerId)).toEqual([
          "change-source-test-forge",
          "change-source-test-forge",
        ]);
        expect(evidence.acquired.producerScopes.map((scope) => scope.producerId)).toEqual([
          "change-source-test-forge",
        ]);

        // A producer map without the kind refuses rather than borrow the local id.
        await expectChangeSourceCode(
          () =>
            resolveCliChangeSourceEvidence({
              workspace,
              resolved,
              admittedRequest: { workflow: "update-documentation", allowWrite: true },
              runId: "change-source-seams",
            }),
          "change-source-kind-unsupported",
        );

        // A parse arm with no kind arm refuses before any resolver runs.
        const orphan: ChangeSourceSelectorMemberV1 = {
          schemaVersion: 1,
          kind: "docsfab-change-source-selector",
          source: "test-orphan",
        };
        for (const source of ["test-orphan", "constructor"]) {
          await expectChangeSourceCode(
            () =>
              resolveCliChangeSource(
                { workspace, selector: { ...orphan, source } },
                { "local-range": localArm, "test-forge": forgeArm },
              ),
            "change-source-kind-unsupported",
          );
        }
        expect([forgeCalls, localCalls]).toEqual([1, 0]);

        // Control: a range still goes to the local arm, through the shipped default too.
        const local = await resolveCliChangeSource(
          { workspace, selector: parseChangeSourceSelector("HEAD", [testPullArm]) },
          { "local-range": localArm, "test-forge": forgeArm },
        );
        expect([forgeCalls, localCalls]).toEqual([1, 1]);
        expect(local.changeSource.source).toEqual({ kind: "local-range" });
        const shipped = await resolveCliChangeSource({
          workspace,
          selector: parseChangeSourceSelector("HEAD"),
        });
        expect(Buffer.from(shipped.manifestBytes).equals(Buffer.from(local.manifestBytes))).toBe(
          true,
        );
        await expectChangeSourceCode(
          () => resolveCliChangeSource({ workspace, selector }),
          "change-source-kind-unsupported",
        );
      } finally {
        await workspace.dispose();
      }
    },
    testTimeoutMs(60_000),
  );
});

/** A raw-object reader over the trusted runner, as the local resolver builds one. */
function reader(repo: string, shallow = false): RawObjectReader {
  return {
    run: (args, options) =>
      runTrustedGit(repo, args, undefined, MAX_GIT_OUTPUT_BYTES, options?.input),
    objectFormat: "sha1",
    shallow,
  };
}

describe("raw-object helpers, helper level (T7)", () => {
  it(
    "re-hashes an annotated tag, refusing a tampered one by role and a commit read as a tag",
    async () => {
      const repo = await repository();
      await fixtureGit(repo, ["tag", "-a", "v1", "-m", "release v1"]);
      const tag = await fixtureGit(repo, ["rev-parse", "v1"]);
      const commit = await fixtureGit(repo, ["rev-parse", "HEAD"]);
      const intact = await readObjects(reader(repo), [tag, commit]);
      expect(verified(reader(repo), intact, tag, "tag", "tag v1").type).toBe("tag");
      await expectChangeSourceCode(
        () => verified(reader(repo), intact, commit, "tag", "tag v1"),
        "change-source-revision-unresolved",
      );

      await rewriteLooseObject(repo, tag, (body) =>
        Buffer.from(body.toString("latin1").replace("release v1", "RELEASE V1"), "latin1"),
      );
      // Positive control: git still reads the tampered object without complaint.
      expect(await fixtureGit(repo, ["cat-file", "-t", tag])).toBe("tag");
      expect(await fixtureGit(repo, ["cat-file", "tag", tag])).toContain("RELEASE V1");
      const tampered = await readObjects(reader(repo), [tag]);
      const error = await caught(() => verified(reader(repo), tampered, tag, "tag", "tag v1"));
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect((error as ChangeSourceError).code).toBe("change-source-integrity-mismatch");
      expect((error as ChangeSourceError).detail).toBe("tag v1");
    },
    testTimeoutMs(60_000),
  );

  it(
    "reads raw parents in first-seen order without repeats, and refuses a tampered commit by its role",
    async () => {
      const repo = await repository();
      const root = await fixtureGit(repo, ["rev-parse", "HEAD"]);
      const side = await commitFiles(repo, { "side.md": "side\n" }, "side");
      await fixtureGit(repo, ["checkout", "-q", "-b", "other", root]);
      const other = await commitFiles(repo, { "other.md": "other\n" }, "other");
      await fixtureGit(repo, ["merge", "-q", "--no-ff", "-m", "merge", side]);
      const merge = await fixtureGit(repo, ["rev-parse", "HEAD"]);
      expect(await rawParents(reader(repo), [merge, other, side], "boundary")).toEqual([
        other,
        side,
        root,
      ]);
      await rewriteLooseObject(repo, side, (body) =>
        Buffer.from(body.toString("latin1").replace("side", "SIDE"), "latin1"),
      );
      const error = await caught(() => rawParents(reader(repo), [merge, side], "boundary"));
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect((error as ChangeSourceError).code).toBe("change-source-integrity-mismatch");
      expect((error as ChangeSourceError).detail).toBe("boundary");
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a tag missing from a shallow clone as a git failure, while a missing commit is missing history",
    async () => {
      const origin = await repository();
      await commitFiles(origin, { "a.md": "one\n" }, "second");
      await fixtureGit(origin, ["tag", "-a", "v1", "-m", "release v1", "HEAD~1"]);
      const tag = await fixtureGit(origin, ["rev-parse", "v1"]);
      const parent = await fixtureGit(origin, ["rev-parse", "HEAD~1"]);
      const clone = `${await roots.create("docsfab-seams-shallow-")}/clone`;
      await fixtureGit(origin, [
        "clone",
        "-q",
        "--no-tags",
        "--depth",
        "1",
        `file://${origin}`,
        clone,
      ]);
      expect(await fixtureGit(clone, ["rev-parse", "--is-shallow-repository"])).toBe("true");
      const objects = await readObjects(reader(clone, true), [tag, parent]);
      expect(objects.size).toBe(0);
      await expectChangeSourceCode(
        () => verified(reader(clone, true), objects, tag, "tag", "tag v1"),
        "change-source-git-failed",
      );
      await expectChangeSourceCode(
        () => verified(reader(clone, true), objects, parent, "commit", "base"),
        "change-source-history-unavailable",
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a loose commit rewritten so git log prints the altered message, at the resolver and the helper",
    async () => {
      const repo = await repository();
      const interior = await commitFiles(
        repo,
        { "a.md": "one\n" },
        "Require an explicit export path",
      );
      await commitFiles(repo, { "a.md": "two\n" }, "head commit");
      await rewriteLooseObject(repo, interior, (body) =>
        Buffer.from(body.toString("latin1").replace("explicit", "optional"), "latin1"),
      );
      // Positive control: git log prints the altered message.
      expect(await fixtureGit(repo, ["log", "--format=%s", "HEAD~2..HEAD"])).toContain(
        "Require an optional export path",
      );
      const workspaceRevision = await fixtureGit(repo, ["rev-parse", "HEAD"]);
      const error = await caught(() =>
        resolveLocalChangeSource({
          sourcePath: repo,
          selector: parseChangeSourceSelector("HEAD~2..HEAD"),
          workspaceRevision,
        }),
      );
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect((error as ChangeSourceError).code).toBe("change-source-integrity-mismatch");
      expect((error as ChangeSourceError).detail).toBe("commit 1");
      await expectChangeSourceCode(
        async () =>
          verified(
            reader(repo),
            await readObjects(reader(repo), [interior]),
            interior,
            "commit",
            "commit 1",
          ),
        "change-source-integrity-mismatch",
      );
    },
    testTimeoutMs(60_000),
  );
});

describe("resolver source and identity parameters (T8)", () => {
  it(
    "seals a caller identity, refuses a forge-reported source before any git call, and admits a local-verified one up to the seal",
    async () => {
      const repo = await repository();
      await commitFiles(repo, { "a.md": "one\n" }, "second");
      const workspaceRevision = await fixtureGit(repo, ["rev-parse", "HEAD"]);
      const selector = parseChangeSourceSelector("HEAD~1..HEAD");
      const identity = gitlabProjectIdentity({ host: "gitlab.example.test", projectId: 7 });
      const defaults = await resolveLocalChangeSource({
        sourcePath: repo,
        selector,
        workspaceRevision,
      });
      const injected = await resolveLocalChangeSource({
        sourcePath: repo,
        selector,
        workspaceRevision,
        repository: identity,
      });
      expect(injected.changeSource.revision.repository).toEqual(identity);
      const scope = (resolved: ResolvedChangeSourceV1<ChangeSourceMemberV1>) =>
        digestChangeSourceProducerScope({ changeSource: resolved.changeSource, readScope: ["."] });
      expect(scope(injected)).not.toBe(scope(defaults));

      for (const sourcePath of [repo, `${repo}-absent`]) {
        const calls: string[][] = [];
        await expectContractCode(
          () =>
            resolveLocalChangeSource({
              sourcePath,
              selector,
              workspaceRevision,
              source: { kind: "test-forge", provenance: "forge-reported" },
              observeGit: (args) => calls.push([...args]),
            }),
          "change-source-contract-invalid-value",
        );
        expect(calls).toEqual([]);
      }

      // Adjacent: a local-verified member of another kind passes the gate and
      // reads git, and only the shipped codec, which lacks the kind, refuses it.
      const calls: string[][] = [];
      await expectContractCode(
        () =>
          resolveLocalChangeSource({
            sourcePath: repo,
            selector,
            workspaceRevision,
            source: { kind: "test-forge" },
            observeGit: (args) => calls.push([...args]),
          }),
        "change-source-contract-invalid-value",
      );
      expect(calls.length).toBeGreaterThan(0);
    },
    testTimeoutMs(60_000),
  );
});
