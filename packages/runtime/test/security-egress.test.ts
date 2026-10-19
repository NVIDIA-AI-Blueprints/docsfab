// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { egressText, egressValue, type HostRoot, hostRootSet } from "../src/security/egress.js";
import { publicRootPredicate } from "../src/security/public-roots.js";
import { configureCredential } from "./helpers/configured-credential.js";

const ROOTS: readonly HostRoot[] = [
  { kind: "workspace", path: "/abs/checkout" },
  { kind: "state", path: "/abs/state/" },
  { kind: "home", path: "/Users/alice" },
  { kind: "tmp", path: "/var/tmpdir" },
  { kind: "config", path: "/etc/docsfab" },
  { kind: "other", path: "/opt/extra root" },
  { kind: "state", path: "/srv/café" },
];

const GITLAB_TOKEN = `glpat-${"x".repeat(24)}`;
const CLIENT_SECRET = ["c7Hk", "Lq2W", "m9Zr", "T4vB", "n8"].join("");

function replace(text: string, roots: readonly HostRoot[] = ROOTS) {
  const result = egressText(text, hostRootSet(roots));
  if (!result.ok) throw new Error(`unexpected refusal ${result.code}`);
  return result;
}

const REPLACEMENTS = [
  ["/abs/checkout/docs/a.md", "docs/a.md", "workspace"],
  ["see /abs/checkout now", "see . now", "workspace"],
  ["/abs/checkout/", "./", "workspace"],
  ["file:///abs/checkout/docs/a.md", "docs/a.md", "workspace"],
  ["/abs/state/runs/1.json", "$DOCSFAB_STATE_DIR/runs/1.json", "state"],
  ["/abs/state", "$DOCSFAB_STATE_DIR", "state"],
  ["/Users/alice/notes.md", "~/notes.md", "home"],
  ["~alice/notes.md", "~/notes.md", "home"],
  ["/var/tmpdir/x", "$TMPDIR/x", "tmp"],
  ["cwd=/var/tmpdir.", "cwd=$TMPDIR.", "tmp"],
  ["/etc/docsfab/profile.yaml", "$DOCSFAB_CONFIG_ROOT/profile.yaml", "config"],
  ["/opt/extra root/bin", "$HOST_PATH/bin", "other"],
  ["file:///opt/extra root/bin", "$HOST_PATH/bin", "other"],
  ["file:///opt/extra%20root/bin", "$HOST_PATH/bin", "other"],
  ["file://localhost/abs/checkout/docs/a.md", "docs/a.md", "workspace"],
  ["file://localhost/opt/extra%20root/bin", "$HOST_PATH/bin", "other"],
  ["file://LOCALHOST/abs/checkout/docs/a.md", "docs/a.md", "workspace"],
  ["file://LocalHost/opt/extra%20root/bin", "$HOST_PATH/bin", "other"],
  ["位于/Users/alice/x", "位于~/x", "home"],
  ["ñ/Users/alice/x", "ñ~/x", "home"],
  ["文件/abs/checkout/docs/a.md", "文件docs/a.md", "workspace"],
  ["/abs/checkout的docs", ".的docs", "workspace"],
  ["/Users/aliceébis/x", "~ébis/x", "home"],
  ["file:///srv/caf%C3%A9/x", "$DOCSFAB_STATE_DIR/x", "state"],
  ["file:///srv/caf%c3%a9/x", "$DOCSFAB_STATE_DIR/x", "state"],
  ["FILE:///abs/checkout/docs/a.md", "docs/a.md", "workspace"],
  ["File://LocalHost/opt/extra%20root/bin", "$HOST_PATH/bin", "other"],
  ["файл/Users/alice/x", "файл~/x", "home"],
  ["cwd is /abs/checkout.", "cwd is ./.", "workspace"],
] as const;

const DOCUMENTATION_STRINGS = [
  "#!/usr/bin/env node",
  "/home/node",
  "/usr/local/bin",
  "C:\\Program Files",
  "~/.config/x",
  "file:42",
  "\\d+",
  "/run.sh",
  "a///b/./c",
  "wait... then /.//x",
  "https://example.com//a/./b",
];

describe("egressText root replacement", () => {
  it.each(REPLACEMENTS)("replaces %j", (input, expected, kind) => {
    expect(replace(input)).toEqual({ ok: true, text: expected, replaced: [kind] });
  });

  it("replaces the longest root first", () => {
    const roots: HostRoot[] = [
      { kind: "tmp", path: "/var/tmpdir" },
      { kind: "workspace", path: "/var/tmpdir/ws" },
    ];
    expect(replace("/var/tmpdir/ws/docs/a.md and /var/tmpdir/x", roots)).toEqual({
      ok: true,
      text: "docs/a.md and $TMPDIR/x",
      replaced: ["workspace", "tmp"],
    });
  });

  it("matches only at path boundaries", () => {
    for (const text of [
      "/var/tmpdirfoo/x",
      "/var/tmpdir-2",
      "/abs/checkout.git",
      "/mnt/abs/checkout/x",
      "~alicex/notes",
      "/mnt//abs/checkout/x",
      "docs//Users/alice/x",
      "docs/~alice/x",
      "/abs/checkout..git",
      "/abs/checkout...x",
    ]) {
      expect(replace(text)).toEqual({ ok: true, text, replaced: [] });
    }
  });

  it("replaces a root joined to the previous root by a separator", () => {
    for (const [input, expected, kinds] of [
      ["/abs/checkout//Users/alice/x", "./~/x", ["workspace", "home"]],
      ["/abs/checkout/~alice/x", "~/x", ["workspace", "home"]],
      ["/abs/state//var/tmpdir/x", "$DOCSFAB_STATE_DIR/$TMPDIR/x", ["state", "tmp"]],
    ] as const) {
      expect(replace(input)).toEqual({ ok: true, text: expected, replaced: kinds });
    }
  });

  it.each([
    ["/abs/checkout///Users/alice/x", "./~/x", ["workspace", "home"]],
    ["/abs/checkout/.//Users/alice", "./~", ["workspace", "home"]],
    ["/abs/checkout//./Users/alice/x", "./~/x", ["workspace", "home"]],
    ["/abs/checkout//~alice/x", "./~/x", ["workspace", "home"]],
    ["/abs/checkout//file:///Users/alice/x", "./~/x", ["workspace", "home"]],
    ["/abs/state///var/tmpdir/./x", "$DOCSFAB_STATE_DIR/$TMPDIR/x", ["state", "tmp"]],
    [
      "/abs/state/.//var/tmpdir//Users/alice",
      "$DOCSFAB_STATE_DIR/$TMPDIR/~",
      ["state", "tmp", "home"],
    ],
    ["/abs/checkout/./docs/a.md", "docs/a.md", ["workspace"]],
    ["/abs/checkout//docs/a.md", "docs/a.md", ["workspace"]],
    ["/abs/checkout/./Users/alice/x", "Users/alice/x", ["workspace"]],
    ["cwd is /abs/checkout...", "cwd is ./...", ["workspace"]],
    ["wrote /var/tmpdir.. then", "wrote $TMPDIR.. then", ["tmp"]],
  ] as const)("reads the separator run after a root as one separator: %j", (input, text, kinds) => {
    expect(replace(input)).toEqual({ ok: true, text, replaced: kinds });
  });

  it("leaves no root behind a separator run", () => {
    for (const separators of ["/", "//", "///", "/./", "/.//", "//./", "/././/"]) {
      for (const tail of ["/Users/alice/x", "~alice/x", "file:///Users/alice/x", "docs/a.md"]) {
        const input = `/abs/checkout${separators}${tail}`;
        const { text } = replace(input);
        expect(text, input).not.toMatch(/\/abs\/checkout|(?:^|[^A-Za-z])\/Users\/alice|~alice/u);
      }
    }
  });

  it("leaves documentation strings unchanged", () => {
    const roots: HostRoot[] = [...ROOTS, { kind: "tmp", path: "/tmp" }];
    for (const text of DOCUMENTATION_STRINGS) {
      expect(replace(text, roots)).toEqual({ ok: true, text, replaced: [] });
    }
  });

  it("ignores empty, bare-root, and relative roots", () => {
    const roots: HostRoot[] = [
      { kind: "other", path: "" },
      { kind: "other", path: "/" },
      { kind: "other", path: "docs" },
    ];
    expect(replace("/ docs/a.md /x", roots)).toEqual({
      ok: true,
      text: "/ docs/a.md /x",
      replaced: [],
    });
  });

  it("is idempotent over the corpus", () => {
    const roots = hostRootSet(ROOTS);
    for (const input of [
      ...REPLACEMENTS.map(([text]) => text),
      ...DOCUMENTATION_STRINGS,
      "/var/tmpdir/var/tmpdir/x",
      "/abs/checkout/docs/abs/checkout/a.md",
      "HOME=/Users/alice/Users/alice",
      "/abs/checkout//Users/alice/x",
      "/abs/checkout/~alice/x",
      "/abs/checkout///Users/alice/x",
      "/abs/checkout/.//Users/alice",
      "/abs/checkout//./Users/alice/x",
      "/abs/checkout/./Users/alice/x",
      "/abs/state/.//var/tmpdir//Users/alice",
      "cwd is /abs/checkout...",
      "/abs/checkout///",
    ]) {
      const once = egressText(input, roots);
      const twice = once.ok ? egressText(once.text, roots) : once;
      expect(twice.ok && twice.text).toBe(once.ok && once.text);
    }
  });

  it("replaces win32 backslash, forward-slash, and file URI forms", () => {
    const roots = hostRootSet([{ kind: "workspace", path: "C:\\Work\\my repo" }], {
      platform: "win32",
    });
    for (const [input, expected] of [
      ["C:\\Work\\my repo\\docs\\a.md", "docs\\a.md"],
      ["C:/Work/my repo/docs/a.md", "docs/a.md"],
      ["file:///C:/Work/my%20repo/docs/a.md", "docs/a.md"],
      ["file:///C:/Work/my repo/docs/a.md", "docs/a.md"],
      ["file://localhost/C:/Work/my%20repo/docs/a.md", "docs/a.md"],
      ["C:\\Program Files", "C:\\Program Files"],
    ]) {
      const result = egressText(input as string, roots);
      expect(result.ok && result.text).toBe(expected);
    }
  });
});

describe("public and generic roots", () => {
  const cited = publicRootPredicate(new Set(["/home/node", "/workspace"]));

  it("leaves a declared public root as written", () => {
    const text = "docs text target=/home/node";
    const roots = hostRootSet([{ kind: "home", path: "/home/node" }], { isPublic: cited });
    expect(egressText(text, roots)).toEqual({ ok: true, text, replaced: [] });
    expect(egressText("~node/x", roots)).toEqual({ ok: true, text: "~node/x", replaced: [] });
  });

  it("replaces the same root when nothing marks it public", () => {
    const roots = hostRootSet([{ kind: "home", path: "/home/node" }]);
    expect(egressText("docs text target=/home/node", roots)).toEqual({
      ok: true,
      text: "docs text target=~",
      replaced: ["home"],
    });
  });

  it("leaves a declared public workspace root as written", () => {
    const text = "cd /workspace/docs";
    const roots = hostRootSet([{ kind: "workspace", path: "/workspace" }], { isPublic: cited });
    expect(egressText(text, roots)).toEqual({ ok: true, text, replaced: [] });
  });

  it("rewrites an undeclared workspace root repository-relative", () => {
    const roots = hostRootSet([{ kind: "workspace", path: "/srv/checkout" }], { isPublic: cited });
    expect(egressText("/srv/checkout/docs/a.md", roots)).toEqual({
      ok: true,
      text: "docs/a.md",
      replaced: ["workspace"],
    });
  });

  it("never treats a generic temporary directory as a root, whatever its kind", () => {
    const roots = hostRootSet([
      { kind: "tmp", path: "/tmp" },
      { kind: "workspace", path: "/tmp/" },
      { kind: "other", path: "/var/tmp" },
      { kind: "state", path: "/private/tmp" },
      { kind: "config", path: "/private/var/tmp/" },
    ]);
    const text = "/tmp/x /var/tmp/y /private/tmp/z /private/var/tmp/w file:///tmp/x";
    expect(egressText(text, roots)).toEqual({ ok: true, text, replaced: [] });
  });

  it("keeps a subpath of a generic temporary directory as a root", () => {
    const roots = hostRootSet([{ kind: "tmp", path: "/tmp/job-123" }]);
    expect(egressText("/tmp/job-123/out and /tmp/other", roots)).toEqual({
      ok: true,
      text: "$TMPDIR/out and /tmp/other",
      replaced: ["tmp"],
    });
  });
});

describe("egressText realpath variants", () => {
  let base = "";
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "egress root "));
    await mkdir(join(base, "real"));
    await symlink(join(base, "real"), join(base, "link"));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("replaces both the logical path and its realpath", async () => {
    const logical = join(base, "link");
    const physical = await realpath(logical);
    expect(physical).not.toBe(logical);
    const roots = hostRootSet([{ kind: "workspace", path: logical }]);
    for (const root of [logical, physical, pathToFileURL(physical).href]) {
      const result = egressText(`${root}/docs/a.md`, roots);
      expect(result).toEqual({ ok: true, text: "docs/a.md", replaced: ["workspace"] });
    }
  });

  it("leaves only the declared form of a symlinked root as written", async () => {
    const logical = join(base, "link");
    const physical = await realpath(logical);
    const text = `${logical}/x ${physical}/y`;
    const physicalDeclared = hostRootSet([{ kind: "home", path: logical }], {
      isPublic: publicRootPredicate(new Set([physical])),
    });
    expect(egressText(text, physicalDeclared)).toEqual({
      ok: true,
      text: `~/x ${physical}/y`,
      replaced: ["home"],
    });
    const logicalDeclared = hostRootSet([{ kind: "home", path: logical }], {
      isPublic: publicRootPredicate(new Set([logical])),
    });
    expect(egressText(text, logicalDeclared)).toEqual({
      ok: true,
      text: `${logical}/x ~/y`,
      replaced: ["home"],
    });
  });

  it("resolves a missing leaf through its existing ancestor", async () => {
    const logical = join(base, "link", "missing");
    const physical = join(await realpath(join(base, "link")), "missing");
    const roots = hostRootSet([{ kind: "state", path: logical }]);
    expect(egressText(`${physical}/x`, roots)).toEqual({
      ok: true,
      text: "$DOCSFAB_STATE_DIR/x",
      replaced: ["state"],
    });
  });
});

describe("egress credential screen", () => {
  it("refuses a configured credential without echoing it", () => {
    configureCredential(GITLAB_TOKEN);
    const result = egressText(`/abs/checkout/a.md token=${GITLAB_TOKEN}`, hostRootSet(ROOTS));
    expect(result).toEqual({ ok: false, code: "credential-material" });
    expect(JSON.stringify(result)).not.toContain(GITLAB_TOKEN);
  });

  it("publishes text that only looks like a credential (#1807)", () => {
    const text = `/abs/checkout/a.md token=${GITLAB_TOKEN} my_client_secret="${CLIENT_SECRET}"`;
    expect(egressText(text, hostRootSet(ROOTS))).toMatchObject({ ok: true });
    expect(egressValue({ lines: ["ok", GITLAB_TOKEN] }, hostRootSet(ROOTS))).toMatchObject({
      ok: true,
    });
  });

  it("refuses a configured credential in a quoted assignment, in text and in a value", () => {
    configureCredential(CLIENT_SECRET);
    const assignment = `my_client_secret="${CLIENT_SECRET}"`;
    expect(egressText(assignment, hostRootSet(ROOTS))).toEqual({
      ok: false,
      code: "credential-material",
    });
    for (const value of [{ note: assignment }, { [assignment]: 1 }]) {
      expect(egressValue(value, hostRootSet(ROOTS))).toEqual({
        ok: false,
        code: "credential-material",
      });
    }
  });

  it("allows placeholder examples that the canonical publication screen allows", () => {
    const roots = hostRootSet(ROOTS);
    for (const text of ['password: "changeme"', "token = ${GITLAB_TOKEN}"]) {
      expect(egressText(text, roots)).toEqual({ ok: true, text, replaced: [] });
      expect(egressValue({ example: text }, roots)).toEqual({
        ok: true,
        value: { example: text },
        replaced: [],
      });
    }
  });

  it("refuses a configured credential keyed inside a value", () => {
    configureCredential("abcdefghijklmnop");
    const result = egressValue({ nested: { api_key: "abcdefghijklmnop" } }, hostRootSet(ROOTS));
    expect(result).toEqual({ ok: false, code: "credential-material" });
  });
});

describe("egressValue", () => {
  it("replaces roots in nested strings and object keys", () => {
    const value = {
      "/abs/checkout/docs/a.md": 1,
      files: ["/abs/checkout/docs/a.md", { log: "/abs/state/run.json" }],
      count: 2,
      flag: true,
      empty: null,
    };
    expect(egressValue(value, hostRootSet(ROOTS))).toEqual({
      ok: true,
      value: {
        "docs/a.md": 1,
        files: ["docs/a.md", { log: "$DOCSFAB_STATE_DIR/run.json" }],
        count: 2,
        flag: true,
        empty: null,
      },
      replaced: ["workspace", "state"],
    });
  });

  it("refuses a structure the canonical value screen cannot walk with its own code", () => {
    const cyclic: Record<string, unknown> = { a: "/abs/checkout/x" };
    cyclic.self = cyclic;
    let deep: unknown = "/abs/checkout/x";
    for (let depth = 0; depth < 1000; depth += 1) deep = { deep };
    for (const value of [
      cyclic,
      { when: new Date(0) },
      { entries: new Map([["a", "b"]]) },
      // biome-ignore lint/suspicious/noSparseArray: the sparse array is the case under test.
      { lines: [, "x"] },
      deep,
    ]) {
      expect(egressValue(value, hostRootSet(ROOTS))).toEqual({
        ok: false,
        code: "egress-unwalkable-value",
      });
    }
  });

  it("refuses keys that collide after replacement", () => {
    const value = { nested: { "/abs/checkout/a.md": 1, "a.md": 2 } };
    expect(egressValue(value, hostRootSet(ROOTS))).toEqual({
      ok: false,
      code: "egress-key-collision",
    });
  });

  it("refuses a configured credential nested in an array", () => {
    configureCredential(GITLAB_TOKEN);
    const result = egressValue({ lines: ["ok", GITLAB_TOKEN] }, hostRootSet(ROOTS));
    expect(result).toEqual({ ok: false, code: "credential-material" });
  });
});
