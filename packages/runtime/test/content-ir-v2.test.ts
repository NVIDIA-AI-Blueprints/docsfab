// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { link, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildContentIndex,
  buildContentIndexV2,
  canonicalJson,
  contentIndexLimitations,
  ContentIndexDecodeError,
  decodeContentIndexV1,
  decodeContentIndexV2,
  diffContentIndexesV2,
  migrateContentIndexV1ToV2,
} from "../src/content-ir/index.js";
import type { ContentIndexV2 } from "../src/content-ir/index.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { ContextIndexValidationError, compileContext } from "../src/context/compiler.js";
import { IaScoringError, scoreIaCandidate } from "../src/ia/scoring.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => {
  vi.unstubAllEnvs();
});
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const EMPTY_ZIP = Buffer.concat([Buffer.from("PK\x05\x06", "binary"), Buffer.alloc(18)]);

describe("Content IR v2 tracked assets", () => {
  it("migrates a newly authored local legacy index without asset fields", async () => {
    const repositoryPath = await createRepository({
      "index.md": "# Local reference\n\nRead the [walkthrough](walkthrough.md).\n",
      "walkthrough.md":
        "# Walkthrough\n\n## Save a result\n\nSave the local result before closing the tool.\n",
    });
    try {
      const v1 = await buildContentIndex({
        repositoryPath,
        repositoryRevision: "a".repeat(40),
      });
      const decoded = decodeContentIndexV1(JSON.parse(canonicalJson(v1)));
      const migrated = migrateContentIndexV1ToV2(decoded);
      expect(decoded.schemaVersion).toBe(1);
      expect(decoded.edges.every((edge) => edge.kind !== ("asset-link" as never))).toBe(true);
      expect(migrated).toMatchObject({
        schemaVersion: 2,
        evidence: { assetCount: 0 },
      });
      expect(decodeContentIndexV2(migrated)).toEqual(migrated);
      const poisoned = { ...structuredClone(decoded), unexpected: true };
      expect(() =>
        scoreIaCandidate({
          index: poisoned as never,
          targetNodeIds: [],
          candidate: {} as never,
        }),
      ).toThrow(IaScoringError);
      expect(() => compileContext({ index: poisoned } as never)).toThrow(
        ContextIndexValidationError,
      );
      const sparse = structuredClone(decoded) as any;
      sparse.nodes = new Array(2);
      sparse.nodes[1] = structuredClone(decoded.nodes[0]);
      expect(() => decodeContentIndexV1(sparse)).toThrow(ContentIndexDecodeError);
      expect(() =>
        scoreIaCandidate({
          index: sparse,
          targetNodeIds: [],
          candidate: {} as never,
        }),
      ).toThrow(IaScoringError);
      expect(() => compileContext({ index: sparse } as never)).toThrow(ContextIndexValidationError);
      const propertyPoisoned = structuredClone(decoded) as any;
      propertyPoisoned.nodes.unexpected = structuredClone(decoded.nodes[0]);
      expect(() => decodeContentIndexV1(propertyPoisoned)).toThrow(ContentIndexDecodeError);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("materializes exact tree blobs despite export-subst and export-ignore attributes", async () => {
    const bytes = Buffer.from("$Format:%H$\0binary\n", "utf8");
    const repository = await createRepository({
      ".gitattributes": "data.bin export-subst\nindex.md export-ignore\n",
      "index.md": "# Fixture\n\n[Asset](data.bin)\n",
      "data.bin": bytes,
    });
    try {
      const index = await buildRevision(repository, "HEAD");
      const edge = index.edges.find((candidate) => candidate.kind === "asset-link");
      expect(index.evidence.documentCount).toBe(1);
      expect(edge).toMatchObject({
        target: {
          sourcePath: "data.bin",
          digest: createHash("sha256").update(bytes).digest("hex"),
        },
      });
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("parses CommonMark angle destinations with spaces and escapes", async () => {
    const repository = await createRepository({
      "index.md": "# Fixture\n\n![Space](<pixel image.png>)\n![Escape](<pixel\\(1\\).png>)\n",
      "pixel image.png": PNG_1X1,
      "pixel(1).png": PNG_1X1,
    });
    try {
      const index = await buildRevision(repository, "HEAD");
      expect(
        index.edges
          .filter((edge) => edge.kind === "asset-link")
          .map((edge) => edge.target.sourcePath)
          .sort(),
      ).toEqual(["pixel image.png", "pixel(1).png"]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("indexes genuine JSON, Markdown/HTML images, archive, and invalid-text binary assets", async () => {
    const repository = await createRepository({
      "index.md": [
        "# Assets",
        "",
        "[Dataset](data.json#record-1)",
        "![Inline image](pixel.png)",
        "![Reference image][pixel]",
        '<img src="pixel.png">',
        "[Archive](bundle.zip)",
        "[Opaque binary](raw.bin)",
        "[Guide](guide.md#details)",
        "",
        "[pixel]: pixel.png",
        "",
      ].join("\n"),
      "guide.md": "# Guide\n\n## Details\n",
      "data.json": '{"private":"ASSET_CONTENT_SENTINEL"}\n',
      "pixel.png": PNG_1X1,
      "bundle.zip": EMPTY_ZIP,
      "raw.bin": Buffer.from([0xff, 0xfe, 0x00, 0x80]),
    });
    try {
      const first = await buildRevision(repository, "HEAD");
      const second = await buildRevision(repository, "HEAD");
      const assets = first.edges.filter((edge) => edge.kind === "asset-link");

      expect(canonicalJson(first)).toBe(canonicalJson(second));
      expect(assets.map((edge) => edge.target.sourcePath).sort()).toEqual([
        "bundle.zip",
        "data.json",
        "pixel.png",
        "raw.bin",
      ]);
      expect(first.evidence.assetCount).toBe(4);
      for (const edge of assets) {
        expect(edge).toMatchObject({
          to: expect.stringMatching(/^asset:[a-f0-9]{64}$/u),
          target: {
            kind: "asset",
            repositoryRevision: first.repository.revision,
            digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        });
      }
      const serialized = canonicalJson(first);
      expect(serialized).not.toContain("ASSET_CONTENT_SENTINEL");
      expect(serialized).not.toContain(PNG_1X1.toString("base64"));
      expect(serialized).not.toContain("�");
      expect(decodeContentIndexV2(first)).toEqual(first);
      expect(first.edges).toContainEqual(expect.objectContaining({ kind: "outbound-link" }));
      const document = first.nodes.find(
        (node) => node.kind === "document" && node.sourcePath === "index.md",
      )!;
      const score = scoreIaCandidate({
        index: first,
        targetNodeIds: [document.id],
        candidate: {
          id: "candidate:asset-index",
          primaryAxis: "reader-job",
          secondaryAxes: [],
          groups: [
            {
              id: "group:assets",
              axis: "reader-job",
              canonicalPath: "assets",
              memberNodeIds: [document.id],
              evidence: [{ nodeId: document.id, path: document.sourcePath }],
            },
          ],
          placements: [
            {
              nodeId: document.id,
              proposedPath: document.sourcePath,
              evidence: [{ nodeId: document.id, path: document.sourcePath }],
            },
          ],
          evidence: [{ nodeId: document.id, path: document.sourcePath }],
        },
      });
      expect(score.eligibility.eligible).toBe(true);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("indexes a dataset link from the clean exact base export, not the dirty checkout", async () => {
    // Isolated git root: indexing this package's enclosing DocsFab tree would
    // pull Fern pages, invalid evaluation fixtures, and ../../ contributor links.
    const committed = '{"revision":"clean"}\n';
    const dirty = '{"revision":"dirty"}\n';
    const repository = await createRepository({
      "index.md": "# Guide\n\n[Dataset](evaluation/living-documentation/dataset.json)\n",
      "evaluation/living-documentation/dataset.json": committed,
    });
    try {
      await writeFile(join(repository, "evaluation/living-documentation/dataset.json"), dirty);
      const exactBaseRevision = await git(repository, ["rev-parse", "HEAD"]);
      const workspace = await prepareRepositoryWorkspace(repository, exactBaseRevision);
      try {
        const index = await buildContentIndexV2({ workspace });
        const edge = index.edges.find(
          (candidate) =>
            candidate.kind === "asset-link" &&
            candidate.target.sourcePath === "evaluation/living-documentation/dataset.json",
        );
        expect(index.repository.revision).toBe(exactBaseRevision);
        expect(edge).toMatchObject({
          target: {
            kind: "asset",
            repositoryRevision: exactBaseRevision,
            digest: createHash("sha256").update(committed).digest("hex"),
          },
        });
        expect(workspace.path).not.toBe(repository);
      } finally {
        await workspace.dispose();
      }
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  }, 15_000);

  it("records add, remove, rename, and digest changes while unchanged revision bindings stay structural", async () => {
    const repository = await createRepository({
      "index.md": "# Assets\n\n[Download](https://example.test/data.json)\n",
    });
    try {
      const initialRevision = await git(repository, ["rev-parse", "HEAD"]);
      const initial = await buildRevision(repository, initialRevision);
      await writeFile(join(repository, "data.json"), '{"version":1}\n');
      await writeFile(join(repository, "index.md"), "# Assets\n\n[Download](data.json)\n");
      const addedRevision = await commitFixture(repository, "add asset");
      const added = await buildRevision(repository, addedRevision);
      expect(diffContentIndexesV2(initial, added).documents).toEqual([
        expect.objectContaining({ sourcePath: "index.md", regions: ["graph"] }),
      ]);
      expect(diffContentIndexesV2(added, initial).documents).toEqual([
        expect.objectContaining({ sourcePath: "index.md", regions: ["graph"] }),
      ]);

      await writeFile(join(repository, "data.json"), '{"version":2}\n');
      await commitFixture(repository, "change asset");
      const changed = await buildRevision(repository, "HEAD");
      expect(diffContentIndexesV2(added, changed).documents).toEqual([
        expect.objectContaining({ sourcePath: "index.md", regions: ["graph"] }),
      ]);

      await rename(join(repository, "data.json"), join(repository, "renamed.json"));
      await writeFile(join(repository, "index.md"), "# Assets\n\n[Download](renamed.json)\n");
      await commitFixture(repository, "rename asset");
      const renamed = await buildRevision(repository, "HEAD");
      expect(diffContentIndexesV2(changed, renamed).documents).toEqual([
        expect.objectContaining({ sourcePath: "index.md", regions: ["graph"] }),
      ]);

      const unchangedAtNewBinding = structuredClone(renamed);
      unchangedAtNewBinding.repository.revision = "f".repeat(40);
      unchangedAtNewBinding.evidence.repositoryRevision = "f".repeat(40);
      for (const edge of unchangedAtNewBinding.edges) {
        if (edge.kind === "asset-link") edge.target.repositoryRevision = "f".repeat(40);
      }
      expect(diffContentIndexesV2(renamed, unchangedAtNewBinding).documents).toEqual([]);

      await rm(join(repository, "renamed.json"));
      await commitFixture(repository, "delete asset");
      await expect(buildRevision(repository, "HEAD")).rejects.toMatchObject({
        code: "broken-internal-target",
      });
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", "[Asset](missing.bin)", {}, "broken-internal-target"],
    ["missing image", "![Asset](missing.png)", {}, "broken-internal-target"],
    ["path escape", "[Asset](../../outside.bin)", {}, "unsafe-path"],
    ["invalid percent", "[Asset](data%ZZ.bin)", {}, "invalid-internal-target"],
    ["double decode", "[Asset](%252e%252e/secret.bin)", {}, "invalid-internal-target"],
    ["encoded absolute", "[Asset](%2Fetc/passwd)", {}, "unsafe-path"],
    ["encoded control", "[Asset](data%00.bin)", {}, "invalid-internal-target"],
    ["non-NFC Unicode", "[Asset](%65%CC%81.bin)", {}, "invalid-internal-target"],
    [
      "invalid query",
      "[Asset](data.bin?value=%ZZ)",
      { "data.bin": "ok" },
      "invalid-internal-target",
    ],
    [
      "extra query separator",
      "[Asset](data.bin?ok?%ZZ)",
      { "data.bin": "ok" },
      "invalid-internal-target",
    ],
    [
      "invalid asset fragment",
      "[Asset](data.bin#%ZZ)",
      { "data.bin": "ok" },
      "invalid-internal-target",
    ],
    [
      "extra fragment separator",
      "[Asset](data.bin#ok#%ZZ)",
      { "data.bin": "ok" },
      "invalid-internal-target",
    ],
    [
      "broken document fragment",
      "[Guide](guide.md#missing)",
      { "guide.md": "# Present\n" },
      "broken-internal-target",
    ],
    [
      "unquoted HTML image",
      "<img src=data.bin>",
      { "data.bin": "ok" },
      "unsupported-internal-target",
    ],
  ] as const)("fails precisely for %s", async (_label, linkText, files, code) => {
    const repository = await createRepository({
      "index.md": `# Fixture\n\n${linkText}\n`,
      ...files,
    });
    try {
      await expect(buildRevision(repository, "HEAD")).rejects.toMatchObject({ code });
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("accepts NFC percent paths and ignores valid query/asset fragments without anchor parsing", async () => {
    const repository = await createRepository({
      "index.md": "# Fixture\n\n[Asset](%C3%A9.bin?download=1#application-pointer)\n",
      "é.bin": Buffer.from([0xff, 0x00]),
    });
    try {
      const index = await buildRevision(repository, "HEAD");
      expect(index.edges).toContainEqual(
        expect.objectContaining({
          kind: "asset-link",
          target: expect.objectContaining({ sourcePath: "é.bin" }),
        }),
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rejects ignored, untracked, tracked symlink, and submodule targets", async () => {
    const untracked = await createRepository({
      ".gitignore": "ignored.bin\n",
      "index.md": "# Fixture\n\n[Asset](ignored.bin)\n",
    });
    await writeFile(join(untracked, "ignored.bin"), "not tracked");
    try {
      await expect(buildRevision(untracked, "HEAD")).rejects.toMatchObject({
        code: "broken-internal-target",
      });
    } finally {
      await rm(untracked, { recursive: true, force: true });
    }

    const symlinkRepository = await createRepository({
      "index.md": "# Fixture\n\n[Asset](link.bin)\n",
    });
    await symlink("index.md", join(symlinkRepository, "link.bin"));
    await commitFixture(symlinkRepository, "add symlink");
    try {
      await expect(buildRevision(symlinkRepository, "HEAD")).rejects.toMatchObject({
        code: "unsafe-path",
      });
    } finally {
      await rm(symlinkRepository, { recursive: true, force: true });
    }

    const submoduleRepository = await createRepository({
      "index.md": "# Fixture\n\n[Asset](vendor)\n",
    });
    const objectId = await git(submoduleRepository, ["rev-parse", "HEAD"]);
    await git(submoduleRepository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${objectId},vendor`,
    ]);
    await git(submoduleRepository, ["commit", "-m", "add gitlink"]);
    try {
      await expect(buildRevision(submoduleRepository, "HEAD")).rejects.toMatchObject({
        code: "unsupported-internal-target",
      });
    } finally {
      await rm(submoduleRepository, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated large links before I/O and leaves assets past a limit out by name", async () => {
    const repeatedLinks = Array.from({ length: 300 }, () => "[Large](large.bin)").join("\n");
    const repeated = await createRepository({
      "index.md": `# Repeated\n\n${repeatedLinks}\n`,
      "large.bin": Buffer.alloc(1024 * 1024, 0xa5),
    });
    try {
      expect((await buildRevision(repeated, "HEAD")).evidence.assetCount).toBe(1);
    } finally {
      await rm(repeated, { recursive: true, force: true });
    }

    // Lowered overrides keep the fixtures small; the defaults are far larger.
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSET_BYTES", String(1024 * 1024));
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_TOTAL_ASSET_BYTES", String(8 * 1024 * 1024));
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSETS", "4");
    const oversized = await createRepository({
      "index.md": "# Oversized\n\n[Asset](large.bin)\n",
      "large.bin": Buffer.alloc(1024 * 1024 + 1),
    });
    try {
      const built = await buildRevision(oversized, "HEAD");
      expect(built.evidence.assetCount).toBe(0);
      expect(contentIndexLimitations(built)).toMatchObject([
        { path: "large.bin", reason: "asset-too-large", linkedFrom: "index.md" },
      ]);
    } finally {
      await rm(oversized, { recursive: true, force: true });
    }

    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_TOTAL_ASSET_BYTES", String(2 * 1024 * 1024));
    const total = await createRepository({
      "index.md": "# Total\n\n[A](a.bin)\n[B](b.bin)\n[C](c.bin)\n",
      "a.bin": Buffer.alloc(1024 * 1024, 1),
      "b.bin": Buffer.alloc(1024 * 1024, 2),
      "c.bin": Buffer.alloc(1024 * 1024, 3),
    });
    try {
      const built = await buildRevision(total, "HEAD");
      expect(built.evidence.assetCount).toBe(2);
      expect(contentIndexLimitations(built)).toMatchObject([
        { path: "c.bin", reason: "asset-bytes-exceeded", linkedFrom: "index.md" },
      ]);
    } finally {
      await rm(total, { recursive: true, force: true });
    }

    const countFiles: Record<string, string> = {};
    const countLinks: string[] = [];
    for (let index = 0; index <= 4; index += 1) {
      countFiles[`assets/${index}.bin`] = "";
      countLinks.push(`[${index}](assets/${index}.bin)`);
    }
    const counted = await createRepository({
      "index.md": `# Count\n\n${countLinks.join("\n")}\n`,
      ...countFiles,
    });
    try {
      const built = await buildRevision(counted, "HEAD");
      expect(built.evidence.assetCount).toBe(4);
      expect(contentIndexLimitations(built)).toMatchObject([
        { path: "assets/4.bin", reason: "asset-count-exceeded", linkedFrom: "index.md" },
      ]);
    } finally {
      await rm(counted, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects invalid UTF-8 documents plus hardlink and in-place export substitution", async () => {
    const invalidDocument = await createRepository({
      "index.md": Buffer.from([0xff, 0xfe, 0x00]),
    });
    try {
      await expect(buildRevision(invalidDocument, "HEAD")).rejects.toMatchObject({
        code: "invalid-document-encoding",
      });
    } finally {
      await rm(invalidDocument, { recursive: true, force: true });
    }

    const repository = await createRepository({
      "index.md": "# Fixture\n\n[Asset](data.bin)\n",
      "data.bin": "original",
    });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      await rm(join(workspace.path, "data.bin"));
      await link(join(repository, "data.bin"), join(workspace.path, "data.bin"));
      await expect(buildContentIndexV2({ workspace })).rejects.toMatchObject({
        code: "tracked-file-changed",
      });
    } finally {
      await workspace.dispose();
    }
    const changedWorkspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      expect(Buffer.byteLength("modified")).toBe(Buffer.byteLength("original"));
      await writeFile(join(changedWorkspace.path, "data.bin"), "modified");
      await expect(buildContentIndexV2({ workspace: changedWorkspace })).rejects.toMatchObject({
        code: "tracked-file-changed",
      });
    } finally {
      await changedWorkspace.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("strict-decodes every asset target field and rejects unknown keys without a TypeError", async () => {
    const repository = await createRepository({
      "index.md": "# Fixture\n\n[Asset](data.bin)\n",
      "data.bin": "bytes",
    });
    try {
      const index = await buildRevision(repository, "HEAD");
      const mutations: Array<(value: Record<string, any>) => void> = [
        (value) => {
          value.edges[0].target.extra = true;
        },
        (value) => {
          value.edges[0].target.kind = "document";
        },
        (value) => {
          value.edges[0].target.sourcePath = "../escape.bin";
        },
        (value) => {
          value.edges[0].target.repositoryRevision = "f".repeat(40);
        },
        (value) => {
          value.edges[0].target.digest = "0".repeat(64);
        },
        (value) => {
          value.edges[0].to = "asset:" + "0".repeat(64);
        },
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(index) as unknown as Record<string, any>;
        mutate(changed);
        expect(() => decodeContentIndexV2(changed)).toThrow(ContentIndexDecodeError);
      }

      const consumerPoison = structuredClone(index) as unknown as Record<string, any>;
      consumerPoison.edges[0].target.extra = true;
      expect(() =>
        scoreIaCandidate({
          index: consumerPoison as unknown as ContentIndexV2,
          targetNodeIds: [],
          candidate: {} as never,
        }),
      ).toThrow(IaScoringError);
      expect(() =>
        compileContext({
          index: consumerPoison as unknown as ContentIndexV2,
        } as never),
      ).toThrow(ContextIndexValidationError);
      expect(() => scoreIaCandidate({ index: null } as never)).toThrow(IaScoringError);
      expect(() => compileContext({} as never)).toThrow(ContextIndexValidationError);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

async function createRepository(files: Record<string, string | Buffer>): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-content-ir-v2-"));
  await initFixtureRepo(repository, files);
  return repository;
}

async function buildRevision(repository: string, revision: string): Promise<ContentIndexV2> {
  const workspace = await prepareRepositoryWorkspace(repository, revision);
  try {
    return await buildContentIndexV2({ workspace });
  } finally {
    await workspace.dispose();
  }
}
