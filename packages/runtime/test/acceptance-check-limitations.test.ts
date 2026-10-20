// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_CHECK_LIMITATIONS,
  ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE,
  acceptanceCheckExcludedFiles,
  acceptanceCheckLimitationCauses,
  applicableAcceptanceCheckLimitations,
  parseAcceptanceCheckLimitationRecord,
} from "../src/acceptance-check-limitations.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = join(import.meta.dirname, "..");
const UID_VIEW_FILES = [
  "test/roadmap-issue-cli-security.test.ts",
  "test/doc-improvement-cli.test.ts",
  "test/native-composition-preflight.test.ts",
  "test/live-agent-task-export.test.ts",
  "test/live-agent-task-runner.test.ts",
];
const REGISTRY_FILE = "test/packed-profile-probe.test.ts";
const REGISTRY_LIMITATION = ACCEPTANCE_CHECK_LIMITATIONS.find(
  (limitation) => limitation.file === REGISTRY_FILE,
)!;
// A file outside the catalog: the positive control that every other file still runs.
const CONTROL_FILE = "test/acceptance.test.ts";
const HOST_OWNER = { outside: 0, inside: 0 };
const UNMAPPED_OWNER = { outside: 0, inside: 65534 };
const LIST_TIMEOUT_MS = testTimeoutMs(60_000);
const LIST_OUTPUT_BYTES = 16 * 1024 * 1024;

function files(limitations: ReadonlyArray<{ file: string }>): string[] {
  return limitations.map((limitation) => limitation.file);
}

describe("acceptance check limitations", () => {
  it("names each limited file once, with a reason that leads with its cause", async () => {
    expect(files(ACCEPTANCE_CHECK_LIMITATIONS)).toEqual([...UID_VIEW_FILES, REGISTRY_FILE]);
    for (const limitation of ACCEPTANCE_CHECK_LIMITATIONS) {
      await access(join(runtimeRoot, limitation.file));
      expect(limitation.reason).toMatch(
        limitation.cause === "host-uid-view"
          ? /^uid-namespace path trust: /u
          : /^registry metadata: /u,
      );
    }
  });

  it("leaves out the ownership-bound files when the sandbox shows another owner of /", () => {
    expect(
      files(
        applicableAcceptanceCheckLimitations({
          networkDenied: true,
          hostRootOwner: UNMAPPED_OWNER,
        }),
      ),
    ).toEqual([...UID_VIEW_FILES, REGISTRY_FILE]);
  });

  it("keeps the ownership-bound files when the sandbox shows the host owner of /", () => {
    expect(
      files(
        applicableAcceptanceCheckLimitations({ networkDenied: true, hostRootOwner: HOST_OWNER }),
      ),
    ).toEqual([REGISTRY_FILE]);
  });

  it("keeps the ownership-bound files when the owner of / inside was not measured", () => {
    for (const hostRootOwner of [{ outside: 0, inside: null }, undefined]) {
      expect(
        files(
          applicableAcceptanceCheckLimitations({
            networkDenied: true,
            ...(hostRootOwner ? { hostRootOwner } : {}),
          }),
        ),
      ).toEqual([REGISTRY_FILE]);
    }
  });

  it("leaves out the registry-bound file in every network-denied check, and only there", () => {
    for (const hostRootOwner of [HOST_OWNER, UNMAPPED_OWNER, { outside: 0, inside: null }]) {
      expect(
        files(applicableAcceptanceCheckLimitations({ networkDenied: true, hostRootOwner })),
      ).toContain(REGISTRY_FILE);
      expect(
        files(applicableAcceptanceCheckLimitations({ networkDenied: false, hostRootOwner })),
      ).not.toContain(REGISTRY_FILE);
    }
  });

  it("selects files only for the causes the environment names", () => {
    const both = applicableAcceptanceCheckLimitations({
      networkDenied: true,
      hostRootOwner: UNMAPPED_OWNER,
    });
    expect(acceptanceCheckLimitationCauses(both)).toBe("host-uid-view,registry-metadata");
    expect(
      files(
        acceptanceCheckExcludedFiles({
          [ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]: acceptanceCheckLimitationCauses(both),
        }),
      ),
    ).toEqual([...UID_VIEW_FILES, REGISTRY_FILE]);
    expect(
      files(
        acceptanceCheckExcludedFiles({
          [ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]: "registry-metadata",
        }),
      ),
    ).toEqual([REGISTRY_FILE]);
    expect(acceptanceCheckExcludedFiles({})).toEqual([]);
    expect(
      acceptanceCheckExcludedFiles({ [ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]: "unknown-cause" }),
    ).toEqual([]);
  });

  it("accepts recorded evidence only when its exclusions follow from its own measurement", () => {
    const unmapped = {
      networkDenied: true,
      hostRootOwner: UNMAPPED_OWNER,
      excluded: applicableAcceptanceCheckLimitations({
        networkDenied: true,
        hostRootOwner: UNMAPPED_OWNER,
      }),
    };
    const parsed = parseAcceptanceCheckLimitationRecord(JSON.parse(JSON.stringify(unmapped)));
    expect(parsed && files(parsed.excluded)).toEqual([...UID_VIEW_FILES, REGISTRY_FILE]);
    const sameOwner = {
      networkDenied: true,
      hostRootOwner: HOST_OWNER,
      excluded: [REGISTRY_LIMITATION],
    };
    expect(parseAcceptanceCheckLimitationRecord(sameOwner)?.excluded).toHaveLength(1);

    // The registry-bound entry follows the ownership-bound ones, as the first test pins.
    const registryIndex = UID_VIEW_FILES.length;
    // One entry changed in place, so the record keeps the expected length.
    const withEntry = (index: number, change: Record<string, unknown>) => ({
      ...unmapped,
      excluded: unmapped.excluded.map((entry, at) =>
        at === index ? { ...entry, ...change } : entry,
      ),
    });
    for (const forged of [
      // Ownership-bound files left out although the sandbox showed the host owner.
      { ...sameOwner, excluded: unmapped.excluded },
      // A network-denied check that hides its registry-bound exclusion.
      { ...unmapped, excluded: unmapped.excluded.slice(0, registryIndex) },
      // The registry-bound exclusion with an edited reason.
      withEntry(registryIndex, { reason: "edited" }),
      // An ownership-bound exclusion naming another file, another cause, or an extra field.
      withEntry(0, { file: CONTROL_FILE }),
      withEntry(0, { cause: "registry-metadata" }),
      withEntry(0, { extra: true }),
      { ...unmapped, extra: true },
      { ...unmapped, hostRootOwner: { outside: 0, inside: -1 } },
      { ...unmapped, hostRootOwner: { outside: 0 } },
      { ...unmapped, networkDenied: "true" },
    ]) {
      expect(parseAcceptanceCheckLimitationRecord(forged)).toBeUndefined();
    }
  });
});

interface Listed {
  files: string[];
  stderr: string;
}

function listTestFiles(causes: string | undefined): Promise<Listed> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  // A nested Vitest must not inherit this worker's pool identity.
  for (const name of Object.keys(environment)) {
    if (name.startsWith("VITEST")) delete environment[name];
  }
  delete environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE];
  if (causes !== undefined) environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE] = causes;
  environment.VITEST_MAX_WORKERS = "1";
  return new Promise((resolveList, rejectList) => {
    execFile(
      process.execPath,
      [join(runtimeRoot, "node_modules", "vitest", "vitest.mjs"), "list", "--filesOnly", "--json"],
      {
        cwd: runtimeRoot,
        env: environment,
        timeout: LIST_TIMEOUT_MS,
        maxBuffer: LIST_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectList(new Error(`vitest list failed: ${stderr}`, { cause: error }));
          return;
        }
        const listed = JSON.parse(stdout) as Array<{ file: string }>;
        resolveList({
          files: listed.map((entry) =>
            entry.file
              .slice(runtimeRoot.length + 1)
              .split("\\")
              .join("/"),
          ),
          stderr,
        });
      },
    );
  });
}

describe("acceptance check limitations in the Vitest configuration", () => {
  it(
    "leaves out exactly the named causes' files, says so, and keeps every other file",
    async () => {
      const [unset, registry, both] = await Promise.all([
        listTestFiles(undefined),
        listTestFiles("registry-metadata"),
        listTestFiles("host-uid-view,registry-metadata"),
      ]);

      expect(unset.files).toEqual(expect.arrayContaining([...UID_VIEW_FILES, REGISTRY_FILE]));
      expect(unset.stderr).not.toContain("Acceptance check limitation");

      expect(registry.files).not.toContain(REGISTRY_FILE);
      expect(registry.files).toEqual(expect.arrayContaining(UID_VIEW_FILES));
      expect(registry.files).toHaveLength(unset.files.length - 1);
      expect(registry.stderr).toContain(
        `Acceptance check limitation: ${REGISTRY_FILE} not run (${REGISTRY_LIMITATION.reason})`,
      );

      for (const file of [...UID_VIEW_FILES, REGISTRY_FILE]) expect(both.files).not.toContain(file);
      expect(both.files).toHaveLength(unset.files.length - UID_VIEW_FILES.length - 1);
      for (const limitation of ACCEPTANCE_CHECK_LIMITATIONS) {
        expect(both.stderr).toContain(
          `Acceptance check limitation: ${limitation.file} not run (${limitation.reason})`,
        );
      }
      // Positive control: a file outside the catalog runs under every value.
      for (const listed of [unset, registry, both]) expect(listed.files).toContain(CONTROL_FILE);
    },
    LIST_TIMEOUT_MS,
  );
});
