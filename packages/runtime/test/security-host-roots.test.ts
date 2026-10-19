// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { homedir, tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveDocsFabConfigurationRoot,
  resolveDocsFabProjectRoot,
  resolveDocsFabPublicationRoots,
} from "../src/config/host-paths.js";
import { runtimeEgressRootSet } from "../src/config/egress-roots.js";
import { processHostRoots } from "../src/harness/source-tools.js";
import {
  egressText,
  type HostRoot,
  type HostRootSet,
  hostRootSet,
} from "../src/security/egress.js";
import {
  processHostRootSet,
  resetStartupPublicRootsForTest,
  validateStartupPublicRoots,
} from "../src/security/host-roots.js";
import {
  declaredPublicRoots,
  PublicRootsOperatorError,
  publicRootPredicate,
} from "../src/security/public-roots.js";

const HOME = "/srv/lane-roots/home/alice";
const TMP = "/srv/lane-roots/tmp";
const CHECKOUT = "/srv/lane-roots/checkout";
const SECOND_CHECKOUT = "/srv/lane-roots/second";
const STATE = "/srv/lane-roots/state/runs";

/**
 * The model-facing builder as `harness/source-tools.ts`,
 * `live-agent/source-commands.ts` and `review/contracts.ts` each wrote it.
 */
function modelFacingOracle(workspaceRoots: readonly string[] = []): HostRootSet {
  return hostRootSet(
    [
      ...workspaceRoots.map((path) => ({ kind: "workspace" as const, path })),
      { kind: "home", path: homedir() },
      { kind: "tmp", path: tmpdir() },
    ],
    { isPublic: publicRootPredicate(declaredPublicRoots()) },
  );
}

interface PublisherOracleOptions {
  readonly workspace?: string;
  readonly stateDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly publicRoots?: ReadonlySet<string>;
}

/** The publisher builder as `config/egress-roots.ts` wrote it. */
function publisherOracle(options: PublisherOracleOptions = {}): HostRootSet {
  const environment = options.environment ?? process.env;
  const home = oracleAbsolute(environment.HOME) ?? oracleAttempt(homedir);
  const workspace = options.workspace ?? oracleAttempt(() => process.cwd());
  const roots: HostRoot[] = [];
  if (workspace && !(home && oracleContains(workspace, home))) {
    roots.push({ kind: "workspace", path: workspace });
  }
  const publication = oracleAttempt(() =>
    resolveDocsFabPublicationRoots(environment, options.stateDirectory),
  );
  for (const path of [
    options.stateDirectory,
    publication?.stateDirectory,
    publication?.deliveryRoot,
    publication?.receiptRoot,
  ]) {
    if (path) roots.push({ kind: "state", path });
  }
  const config = oracleAttempt(() => resolveDocsFabConfigurationRoot(environment));
  if (config) roots.push({ kind: "config", path: config });
  const install = resolveDocsFabProjectRoot();
  if (!workspace || !oracleContains(workspace, install)) {
    roots.push({ kind: "other", path: install });
  }
  if (home) roots.push({ kind: "home", path: home });
  const tmp = oracleAbsolute(environment.TMPDIR) ?? oracleAttempt(tmpdir);
  if (tmp) roots.push({ kind: "tmp", path: tmp });
  const publicRoots =
    options.publicRoots ?? declaredPublicRoots(options.environment ?? process.env);
  return hostRootSet(roots, { isPublic: publicRootPredicate(publicRoots) });
}

function oracleContains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function oracleAbsolute(value: string | undefined): string | undefined {
  return value && isAbsolute(value) ? value : undefined;
}

function oracleAttempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

const ENVIRONMENTS: readonly (readonly [string, Readonly<Record<string, string | undefined>>])[] = [
  ["plain", { HOME, TMPDIR: `${TMP}/`, DOCSFAB_PUBLIC_ROOTS: undefined }],
  ["a public HOME", { HOME, TMPDIR: TMP, DOCSFAB_PUBLIC_ROOTS: HOME }],
  [
    "a public checkout and HOME",
    { HOME, TMPDIR: TMP, DOCSFAB_PUBLIC_ROOTS: [CHECKOUT, HOME].join(delimiter) },
  ],
  ["a HOME inside the checkout", { HOME: `${CHECKOUT}/home`, TMPDIR: TMP }],
  ["a relative HOME and TMPDIR", { HOME: "alice", TMPDIR: "tmp" }],
  ["a generic TMPDIR", { HOME, TMPDIR: "/tmp" }],
  [
    "state and delivery overrides",
    {
      HOME,
      TMPDIR: TMP,
      DOCSFAB_STATE_DIR: STATE,
      DOCSFAB_DELIVERY_ROOT: "/srv/lane-roots/delivery",
    },
  ],
];

function corpus(roots: HostRootSet): string[] {
  const texts = [
    "#!/usr/bin/env node",
    "/home/node",
    "/usr/local/bin",
    "C:\\Program Files",
    "~/.config/x",
    "file:42",
    "/run.sh",
  ];
  for (const root of [
    HOME,
    TMP,
    CHECKOUT,
    SECOND_CHECKOUT,
    STATE,
    `${CHECKOUT}/home`,
    resolveDocsFabProjectRoot(),
    ...roots.variants.map(({ text }) => text),
  ]) {
    texts.push(
      `${root}/docs/a.md`,
      `cwd is ${root}.`,
      `${root}//${HOME}/x`,
      `file://${root}/x`,
      `~${basename(root)}/notes.md`,
    );
  }
  return texts;
}

function expectSameReplacement(actual: HostRootSet, expected: HostRootSet): void {
  expect(actual.variants).toEqual(expected.variants);
  expect(actual.pattern?.source).toBe(expected.pattern?.source);
  for (const text of corpus(expected)) {
    expect(egressText(text, actual), text).toEqual(egressText(text, expected));
  }
}

describe("processHostRootSet", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetStartupPublicRootsForTest();
  });

  function stub(environment: Readonly<Record<string, string | undefined>>): void {
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  }

  it.each(ENVIRONMENTS)("builds the model-facing root set unchanged with %s", (_label, env) => {
    stub(env);
    for (const workspaceRoots of [[], [CHECKOUT], [CHECKOUT, SECOND_CHECKOUT]]) {
      expectSameReplacement(processHostRoots(workspaceRoots), modelFacingOracle(workspaceRoots));
      expectSameReplacement(
        processHostRootSet({ workspaceRoots }),
        modelFacingOracle(workspaceRoots),
      );
    }
  });

  it.each(ENVIRONMENTS)("builds the publisher root set unchanged with %s", (_label, env) => {
    stub(env);
    const explicit = { HOME: "/srv/lane-roots/other-home", TMPDIR: "/srv/lane-roots/other-tmp" };
    for (const options of [
      {},
      { workspace: CHECKOUT },
      { workspace: CHECKOUT, stateDirectory: STATE },
      { environment: explicit },
      { environment: { ...explicit, DOCSFAB_PUBLIC_ROOTS: explicit.HOME } },
      { workspace: CHECKOUT, publicRoots: new Set([CHECKOUT]) },
    ] satisfies PublisherOracleOptions[]) {
      expectSameReplacement(runtimeEgressRootSet(options), publisherOracle(options));
    }
  });

  it("keeps the startup declaration for every later root set", () => {
    stub({ HOME, TMPDIR: TMP, DOCSFAB_PUBLIC_ROOTS: HOME });
    expect([...validateStartupPublicRoots()]).toEqual([HOME]);
    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "relative");

    for (const roots of [processHostRootSet(), runtimeEgressRootSet({ workspace: CHECKOUT })]) {
      expect(egressText(`${HOME}/x ${TMP}/y`, roots)).toEqual({
        ok: true,
        text: `${HOME}/x $TMPDIR/y`,
        replaced: ["tmp"],
      });
    }
  });

  it("parses an explicit environment instead of the startup declaration", () => {
    stub({ HOME, TMPDIR: TMP });
    validateStartupPublicRoots();

    expect(() =>
      processHostRootSet({ environment: { HOME, DOCSFAB_PUBLIC_ROOTS: "relative" } }),
    ).toThrow(PublicRootsOperatorError);
    const roots = processHostRootSet({ environment: { HOME, DOCSFAB_PUBLIC_ROOTS: HOME } });
    expect(egressText(`${HOME}/x`, roots)).toEqual({ ok: true, text: `${HOME}/x`, replaced: [] });
  });

  it("parses this process's declaration again once the startup set is reset", () => {
    stub({ HOME, TMPDIR: TMP, DOCSFAB_PUBLIC_ROOTS: HOME });
    validateStartupPublicRoots();
    resetStartupPublicRootsForTest();
    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", undefined);

    expect(egressText(`${HOME}/x`, processHostRootSet())).toEqual({
      ok: true,
      text: "~/x",
      replaced: ["home"],
    });
  });

  it("refuses an invalid startup declaration", () => {
    expect(() => validateStartupPublicRoots({ DOCSFAB_PUBLIC_ROOTS: "/workspace/" })).toThrow(
      PublicRootsOperatorError,
    );
  });
});

describe("Windows home and temporary spellings", () => {
  const PROFILE = "C:\\Users\\alice";
  const GIT_BASH_HOME = "D:\\home\\alice";
  const TEMP = `${PROFILE}\\AppData\\Local\\Temp`;
  const SHELL_TMP = "D:\\tmp";
  const OTHER_TMP = "E:\\scratch";

  function replaced(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, text: string) {
    return egressText(text, processHostRootSet({ environment, platform, publicRoots: new Set() }));
  }

  it("replaces USERPROFILE, TEMP and TMP beside a HOME and TMPDIR that differ", () => {
    const environment = {
      HOME: GIT_BASH_HOME,
      USERPROFILE: PROFILE,
      TMPDIR: SHELL_TMP,
      TEMP,
      TMP: OTHER_TMP,
    };
    const text = [
      `${GIT_BASH_HOME}\\notes.md`,
      `${PROFILE}\\Documents\\a.md`,
      `${SHELL_TMP}\\x`,
      `${TEMP}\\y`,
      `${OTHER_TMP}\\z`,
    ].join(" ");

    expect(replaced(environment, "win32", text)).toEqual({
      ok: true,
      text: "~\\notes.md ~\\Documents\\a.md $TMPDIR\\x $TMPDIR\\y $TMPDIR\\z",
      replaced: ["home", "tmp"],
    });
  });

  it("falls back to USERPROFILE and TEMP when HOME and TMPDIR are unset", () => {
    const text = `${PROFILE}\\a.md ${TEMP}\\b`;
    expect(replaced({ USERPROFILE: PROFILE, TEMP }, "win32", text)).toEqual({
      ok: true,
      text: "~\\a.md $TMPDIR\\b",
      replaced: ["home", "tmp"],
    });
  });

  it("keeps HOME and TMPDIR the only spellings on POSIX", () => {
    const environment = {
      HOME,
      USERPROFILE: "/srv/lane-roots/profile",
      TMPDIR: TMP,
      TEMP: "/srv/lane-roots/temp",
      TMP: "/srv/lane-roots/tmp-two",
    };
    const text = `${HOME}/a /srv/lane-roots/profile/b ${TMP}/c /srv/lane-roots/temp/d /srv/lane-roots/tmp-two/e`;
    for (const platform of ["linux", "darwin"] as const) {
      expect(replaced(environment, platform, text)).toEqual({
        ok: true,
        text: "~/a /srv/lane-roots/profile/b $TMPDIR/c /srv/lane-roots/temp/d /srv/lane-roots/tmp-two/e",
        replaced: ["home", "tmp"],
      });
    }
  });
});
