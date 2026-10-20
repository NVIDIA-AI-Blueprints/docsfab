// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseCorpusCliOptions,
  publishCorpusReport,
  renderCorpusMarkdown,
  runCorpusCli,
} from "../src/quality-evaluation/corpus-cli.js";
import { assertCorpusReportSanitized } from "../src/quality-evaluation/corpus.js";
import { temporaryRoots } from "./helpers/temp.js";

vi.mock("../src/config/private-content-paths.js", () => ({
  PRIVATE_CONTENT_PATHS: Object.freeze({}),
}));

const temporary = temporaryRoots();

describe("living-documentation corpus CLI", () => {
  it("requires explicit write authorization and a destination together", () => {
    expect(() => parseCorpusCliOptions(["--allow-write"])).toThrow("requires both");
    expect(() => parseCorpusCliOptions(["--output-dir", "evidence"])).toThrow("requires both");
    expect(() =>
      parseCorpusCliOptions(["--allow-write", "--allow-write", "--output-dir", "evidence"]),
    ).toThrow("Duplicate");
    expect(() => parseCorpusCliOptions(["--unknown"])).toThrow("Unknown");
  });

  it("requires the complete private raw-evidence configuration for a live campaign", () => {
    expect(() =>
      parseCorpusCliOptions([
        "--live-campaign",
        "campaign.json",
        "--reviewer-policy",
        "reviewers.json",
        "--tested-revision",
        "1729e47c30bc89bc7e22c663022a5369a13ab19a",
      ]),
    ).toThrow("--artifact-store");
  });

  it("applies the sanitizer inside the publication boundary", async () => {
    const root = await temporary.create("docsfab-corpus-publish-");
    await expect(
      publishCorpusReport(
        join(root, "evidence"),
        '{"result":"glpat-examplecredential123456789"}\n',
        "# sanitized-looking markdown\n",
      ),
    ).rejects.toThrow();
    expect(() => assertCorpusReportSanitized({ result: "safe" })).not.toThrow();
  });

  it("rejects destination substitution without touching the symlink target", async () => {
    const root = await temporary.create("docsfab-corpus-substitution-");
    const target = join(root, "outside.txt");
    const output = join(root, "evidence");
    await writeFile(target, "unchanged\n");
    await symlink(target, output);

    await expect(publishCorpusReport(output, "{}\n", "# report\n")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("unchanged\n");
  });

  it("allows exactly one concurrent publisher and never replaces its destination", async () => {
    const root = await temporary.create("docsfab-corpus-concurrent-");
    const output = join(root, "evidence");
    const results = await Promise.allSettled([
      publishCorpusReport(output, "{}\n", "# first\n"),
      publishCorpusReport(output, "{}\n", "# second\n"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["# first\n", "# second\n"]).toContain(
      await readFile(join(output, "report.md"), "utf8"),
    );
    expect(await readFile(join(output, ".complete"), "utf8")).toBe("complete\n");
  });

  it("keeps child creation in the held cwd after the last identity check and rejects a path swap", async () => {
    const root = await temporary.create("docsfab-corpus-race-");
    const output = join(root, "evidence");
    const stolen = join(root, "stolen");
    let swapped = false;

    await expect(
      publishCorpusReport(output, "{}\n", "# report\n", {
        beforeFileOpen: async () => {
          if (swapped) return;
          swapped = true;
          await rename(output, stolen);
          await mkdir(output, { mode: 0o700 });
          await writeFile(join(output, "report.json"), "attacker-owned\n", { mode: 0o600 });
        },
      }),
    ).rejects.toThrow("identity changed");
    expect(await readFile(join(output, "report.json"), "utf8")).toBe("attacker-owned\n");
    await expect(readFile(join(output, "report.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(output, ".complete"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(stolen, "report.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(stolen, "report.md"), "utf8")).toBe("# report\n");
    expect(await readFile(join(stolen, ".complete"), "utf8")).toBe("complete\n");
  });
  it("refuses an unavailable internal corpus before publishing or invoking a judge", async () => {
    const log = vi.fn();
    const publish = vi.fn();
    const evaluate = vi.fn(async () => ({ agrees: true }));
    await expect(
      runCorpusCli(["--judge"], {
        log,
        publish,
        judge: { identity: { provider: "fake-judge", model: "deterministic" }, evaluate },
      }),
    ).rejects.toThrow("internal-content-unavailable: qualityBenchmarkRuntime");
    expect(log).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
