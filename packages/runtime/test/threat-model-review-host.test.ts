// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { testTimeoutMs } from "./helpers/test-timeouts.js";

import {
  decodeThreatModelReviewCandidate,
  GlabThreatModelReviewApi,
  THREAT_MODEL_REVIEW_GITLAB_HOST_ENV,
  ThreatModelReviewHostError,
  ThreatModelReviewVerificationError,
  verifyThreatModelReviews,
  type ThreatModelReviewApi,
} from "../src/security/threat-model-reviews.js";

const CANDIDATE_PATH = new URL("../security/threat-model-reviews.v1.json", import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(
  new URL("../src/security/threat-model-review-cli.ts", import.meta.url),
);
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
// Each case below spawns the CLI through tsx once.
const CLI_CASE = { timeout: testTimeoutMs(15_000) };
const NEUTRAL_HOST = "gitlab.example.com";
const PACKAGE_PATH = "packages/runtime";
const LONGEST_HOST = `${"a".repeat(63)}.`.repeat(3) + "b".repeat(61);
const OVERLONG_HOST = `${"a".repeat(63)}.`.repeat(3) + "b".repeat(62);
const REFUSAL = "Threat-model review evidence is missing, stale, or invalid.";
const MALFORMED_HOSTS: readonly unknown[] = [
  undefined,
  "",
  42,
  "GitLab.Example.com",
  "gitlab.example.com:8443",
  "user@gitlab.example.com",
  "-gitlab.example.com",
  "gitlab.example.com/group",
  " gitlab.example.com",
  "localhost",
  OVERLONG_HOST,
  `${"a".repeat(64)}.example.com`,
  `gitlab.${"b".repeat(64)}`,
];

async function checkedInCandidate(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(CANDIDATE_PATH, "utf8")) as Record<string, unknown>;
}

function request() {
  return {
    schemaVersion: 1,
    kind: "docsfab-threat-model-external-review-request",
    mergeRequestIid: 77,
    candidateCommit: "a".repeat(40),
    approvals: [
      { role: "security", approvalNoteId: 501 },
      { role: "product", approvalNoteId: 502 },
    ],
  };
}

class RecordingApi implements ThreatModelReviewApi {
  readonly paths: string[] = [];

  constructor(readonly host: string) {}

  async get(path: string): Promise<unknown> {
    this.paths.push(path);
    return {};
  }
}

async function refusal(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectHostRefusal(
  error: unknown,
  code: "threat-model-review-host-required" | "threat-model-review-host-mismatch",
): void {
  expect(error).toBeInstanceOf(ThreatModelReviewHostError);
  expect((error as ThreatModelReviewHostError).code).toBe(code);
  expect((error as Error).message).toContain(THREAT_MODEL_REVIEW_GITLAB_HOST_ENV);
}

function operator(host: string): NodeJS.ProcessEnv {
  return { [THREAT_MODEL_REVIEW_GITLAB_HOST_ENV]: host };
}

async function fakeGlab(root: string): Promise<string> {
  const calls = join(root, "calls.jsonl");
  const executable = join(root, "glab");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("{}");
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  await writeFile(calls, "");
  return calls;
}

async function glabCalls(calls: string): Promise<string[][]> {
  return (await readFile(calls, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function withCli(
  body: (cli: {
    root: string;
    calls: string;
    run: (cwd: string, environment: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-threat-review-cli-"));
  try {
    const calls = await fakeGlab(root);
    const evidence = join(root, "evidence.json");
    await writeFile(evidence, JSON.stringify(request()));
    const run = (cwd: string, environment: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, evidence, "--json"], {
        cwd,
        encoding: "utf8",
        env: {
          PATH: `${root}:${process.env.PATH ?? ""}`,
          HOME: root,
          TMPDIR: tmpdir(),
          ...environment,
        },
      });
    await body({ root, calls, run });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function cliCode(result: { stderr: string | Buffer }): string {
  return (JSON.parse(String(result.stderr)) as { code: string }).code;
}

function expectRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(ThreatModelReviewVerificationError);
  expect((error as ThreatModelReviewVerificationError).code).toBe(
    "invalid-threat-model-review-evidence",
  );
  expect((error as Error).message).toBe(REFUSAL);
}

describe("threat-model review GitLab host", () => {
  it("takes the host from the candidate data and admits any DNS hostname", async () => {
    const candidate = await checkedInCandidate();
    expect(decodeThreatModelReviewCandidate(candidate).gitlabHost).toBe(candidate.gitlabHost);
    expect(
      decodeThreatModelReviewCandidate({ ...candidate, gitlabHost: NEUTRAL_HOST }).gitlabHost,
    ).toBe(NEUTRAL_HOST);
    expect([LONGEST_HOST.length, OVERLONG_HOST.length]).toEqual([253, 254]);
    expect(
      decodeThreatModelReviewCandidate({ ...candidate, gitlabHost: LONGEST_HOST }).gitlabHost,
    ).toBe(LONGEST_HOST);
    const longLastLabel = `gitlab.${"b".repeat(63)}`;
    expect(
      decodeThreatModelReviewCandidate({ ...candidate, gitlabHost: longLastLabel }).gitlabHost,
    ).toBe(longLastLabel);
  });

  it("refuses a candidate whose host is missing or not a bare hostname", async () => {
    const candidate = await checkedInCandidate();
    const { gitlabHost: _omitted, ...missing } = candidate;
    expectRefusal(await refusal(() => decodeThreatModelReviewCandidate(missing)));
    for (const gitlabHost of MALFORMED_HOSTS) {
      expectRefusal(
        await refusal(() => decodeThreatModelReviewCandidate({ ...candidate, gitlabHost })),
      );
    }
  });

  it("refuses a glab client without a bare hostname", async () => {
    for (const host of MALFORMED_HOSTS) {
      expectRefusal(
        await refusal(
          () =>
            new GlabThreatModelReviewApi(
              tmpdir(),
              host as string,
              PACKAGE_PATH,
              operator(NEUTRAL_HOST),
            ),
        ),
      );
    }
    expect(
      new GlabThreatModelReviewApi(tmpdir(), NEUTRAL_HOST, PACKAGE_PATH, operator(NEUTRAL_HOST))
        .host,
    ).toBe(NEUTRAL_HOST);
  });

  it("requires the operator-configured review host before a glab client exists", async () => {
    expectHostRefusal(
      await refusal(() => new GlabThreatModelReviewApi(tmpdir(), NEUTRAL_HOST, PACKAGE_PATH, {})),
      "threat-model-review-host-required",
    );
    for (const configured of MALFORMED_HOSTS) {
      if (typeof configured !== "string") continue;
      expectHostRefusal(
        await refusal(
          () =>
            new GlabThreatModelReviewApi(
              tmpdir(),
              NEUTRAL_HOST,
              PACKAGE_PATH,
              operator(configured),
            ),
        ),
        "threat-model-review-host-required",
      );
    }
    expectHostRefusal(
      await refusal(
        () =>
          new GlabThreatModelReviewApi(
            tmpdir(),
            NEUTRAL_HOST,
            PACKAGE_PATH,
            operator("gitlab.other.example"),
          ),
      ),
      "threat-model-review-host-mismatch",
    );
    expect(
      new GlabThreatModelReviewApi(tmpdir(), LONGEST_HOST, PACKAGE_PATH, operator(LONGEST_HOST))
        .host,
    ).toBe(LONGEST_HOST);
  });

  it("refuses evidence read from a host other than the candidate's before any API read", async () => {
    const candidate = { ...(await checkedInCandidate()), gitlabHost: NEUTRAL_HOST };
    const elsewhere = new RecordingApi("gitlab.other.example");
    expectHostRefusal(
      await refusal(() => verifyThreatModelReviews(candidate, request(), elsewhere)),
      "threat-model-review-host-mismatch",
    );
    expect(elsewhere.paths).toEqual([]);

    const matching = new RecordingApi(NEUTRAL_HOST);
    expectRefusal(await refusal(() => verifyThreatModelReviews(candidate, request(), matching)));
    expect(matching.paths[0]).toBe(
      `projects/${encodeURIComponent(String(candidate.projectPath))}/merge_requests/77`,
    );
  });

  it("refuses the CLI before glab runs when no review host is configured", CLI_CASE, async () => {
    await withCli(async ({ run, calls }) => {
      const result = run(PACKAGE_ROOT, {});
      expect(result.status).toBe(1);
      expect(cliCode(result)).toBe("threat-model-review-host-required");
      // The setting's name contains MODEL_, but it is not a model-profile setting.
      expect(JSON.parse(String(result.stderr))).not.toHaveProperty("nextAction");
      expect(await glabCalls(calls)).toEqual([]);
    });
  });

  it(
    "refuses the CLI before glab runs when the configured host is not the candidate's",
    CLI_CASE,
    async () => {
      await withCli(async ({ run, calls }) => {
        const result = run(PACKAGE_ROOT, operator(NEUTRAL_HOST));
        expect(result.status).toBe(1);
        expect(cliCode(result)).toBe("threat-model-review-host-mismatch");
        expect(await glabCalls(calls)).toEqual([]);
      });
    },
  );

  it(
    "sends the checked-in candidate to glab when the operator configured its host",
    CLI_CASE,
    async () => {
      const candidate = await checkedInCandidate();
      await withCli(async ({ run, calls }) => {
        const result = run(PACKAGE_ROOT, operator(String(candidate.gitlabHost)));
        expect(result.status).toBe(1);
        expect(cliCode(result)).toBe("invalid-threat-model-review-evidence");
        expect((await glabCalls(calls))[0]).toEqual([
          "api",
          "--hostname",
          candidate.gitlabHost,
          `projects/${encodeURIComponent(String(candidate.projectPath))}/merge_requests/77`,
        ]);
      });
    },
  );

  it(
    "sends glab to the host a repository candidate names, not a built-in host",
    CLI_CASE,
    async () => {
      const candidate = await checkedInCandidate();
      await withCli(async ({ root, run, calls }) => {
        const checkout = join(root, "checkout");
        await mkdir(join(checkout, "security"), { recursive: true });
        await writeFile(
          join(checkout, "security", "threat-model-reviews.v1.json"),
          JSON.stringify({ ...candidate, gitlabHost: NEUTRAL_HOST }),
        );
        const result = run(checkout, operator(NEUTRAL_HOST));
        expect(result.status).toBe(1);
        expect(cliCode(result)).toBe("invalid-threat-model-review-evidence");
        expect(await glabCalls(calls)).toEqual([
          [
            "api",
            "--hostname",
            NEUTRAL_HOST,
            `projects/${encodeURIComponent(String(candidate.projectPath))}/merge_requests/77`,
          ],
        ]);
      });
    },
  );

  it(
    "never spawns glab for a repository candidate that names a different host",
    CLI_CASE,
    async () => {
      const candidate = await checkedInCandidate();
      await withCli(async ({ root, run, calls }) => {
        const checkout = join(root, "checkout");
        await mkdir(join(checkout, "security"), { recursive: true });
        await writeFile(
          join(checkout, "security", "threat-model-reviews.v1.json"),
          JSON.stringify({ ...candidate, gitlabHost: "127.0.0.1" }),
        );
        const result = run(checkout, {
          ...operator(String(candidate.gitlabHost)),
          GITLAB_TOKEN: "dummy-probe-value",
        });
        expect(result.status).toBe(1);
        expect(cliCode(result)).toBe("threat-model-review-host-mismatch");
        expect(await glabCalls(calls)).toEqual([]);
      });
    },
  );

  it("passes the configured host to glab", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-threat-review-host-"));
    try {
      const executable = join(root, "glab");
      await writeFile(
        executable,
        `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }));
`,
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      const api = new GlabThreatModelReviewApi(root, NEUTRAL_HOST, PACKAGE_PATH, {
        PATH: `${root}:${process.env.PATH ?? ""}`,
        HOME: root,
        ...operator(NEUTRAL_HOST),
      });
      await expect(api.get("projects/docs%2Fproduct/approvals")).resolves.toEqual({
        args: ["api", "--hostname", NEUTRAL_HOST, "projects/docs%2Fproduct/approvals"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
