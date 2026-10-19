// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { parseDoArguments } from "../src/cli/commands/do.js";
import { LIVE_AGENT_USAGE, parseLiveAgentArguments } from "../src/cli/commands/live-agent.js";
import {
  CHANGE_REQUEST_SELECTOR_OPTIONS,
  parseRunArguments,
  SELECTOR_OPTION_REFUSAL_CODES,
  SELECTOR_OPTION_REFUSALS,
  SOURCE_OPTION_REFUSAL_CODES,
  SOURCE_OPTION_REFUSALS,
} from "../src/cli/run-arguments.js";
import { doHelp, runHelp, usage } from "../src/cli/usage.js";
import { resolveCliChangeRequestEvidenceFromSelector } from "../src/cli/run/source-acquisition.js";
import type { CommandRunner } from "../src/init/types.js";
import {
  CHANGE_REQUEST_SELECTOR_REFUSAL_CODES,
  isValidatedChangeRequestSelector,
  CHANGE_REQUEST_SELECTOR_FIELDS,
} from "../src/inputs/change-request-selector.js";
import { canonicalGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { createSourceFixture } from "./support/source-acquisition-cli.js";
import { temporaryRoots } from "./helpers/temp.js";

const HOST = "gitlab.example.test";
const PROJECT_PATH = "team/docs-project";
const PROJECT_ID = 437_040;
const MR_IID = 813;
const RUN_ID = "change-request-alias-run";
const REPO = "/tmp/docsfab-798c3-alias-repo";
const INSTRUCTION = "Update the export guide for the merged change.";
const FIXED_CLOCK = () => new Date("2026-09-17T12:00:00.000Z");

const roots = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

/** Every value form the selector accepts, so the alias is proven across all of them. */
const VALUE_FORMS: readonly string[] = [
  `https://${HOST}/${PROJECT_PATH}/-/merge_requests/${MR_IID}`,
  `${HOST}/${PROJECT_PATH}!${MR_IID}`,
  `!${MR_IID}`,
  `${MR_IID}`,
];

function runArgv(option: string, value: string, ...extra: readonly string[]): string[] {
  return [
    "update-documentation",
    "--repo",
    REPO,
    "--instruction",
    INSTRUCTION,
    option,
    value,
    ...extra,
  ];
}

/** Key-sorted, so a field's position cannot hide a difference. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function digestOf(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortDeep(value)))
    .digest("hex");
}

/**
 * The three source-aware surfaces, each driven through its own real parser:
 * each has its own argument loop, and a spelling missing from one is consumed
 * as an unknown token, not as a selector.
 */
const SURFACES: ReadonlyArray<{
  readonly name: string;
  readonly parse: (...tokens: string[]) => unknown;
}> = [
  {
    name: "run",
    parse: (...tokens) =>
      parseRunArguments([
        "update-documentation",
        "--repo",
        REPO,
        "--instruction",
        INSTRUCTION,
        ...tokens,
      ]),
  },
  {
    name: "do",
    parse: (...tokens) => parseDoArguments([INSTRUCTION, "--repo", REPO, ...tokens]),
  },
  {
    name: "live-agent",
    parse: (...tokens) => parseLiveAgentArguments(["--repo", REPO, ...tokens]),
  },
];

function selectorOf(parsed: unknown): unknown {
  return (parsed as { changeRequestSelector?: unknown }).changeRequestSelector;
}

function glabStub(
  calls?: { hostnames: string[]; endpoints: string[] },
  options: { projectPath?: string; iid?: number } = {},
): CommandRunner {
  return {
    async run(_command, args) {
      const endpoint = String(args.at(-1));
      if (calls) {
        const hostnameIndex = args.indexOf("--hostname");
        calls.hostnames.push(hostnameIndex >= 0 ? String(args[hostnameIndex + 1]) : "(none)");
        calls.endpoints.push(endpoint);
      }
      if (endpoint.includes("/merge_requests/")) {
        return {
          stdout: JSON.stringify({
            iid: options.iid ?? MR_IID,
            title: "Require an explicit export path",
            description: "The export command now requires an explicit output path.",
            state: "merged",
            merged_at: "2026-09-16T11:30:00Z",
            target_branch: "main",
            source_branch: "feature/export-path",
            merge_commit_sha: "a".repeat(40),
            squash_commit_sha: null,
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: JSON.stringify({
          id: PROJECT_ID,
          path_with_namespace: options.projectPath ?? PROJECT_PATH,
        }),
        stderr: "",
        exitCode: 0,
      };
    },
  } as CommandRunner;
}

/**
 * `--mr` is an alias, so it must be indistinguishable, not merely accepted:
 * these assert identical outputs at every surface and value form, or two
 * operators citing one merge request would bind different evidence.
 */
describe("docsfab --mr alias (#798)", () => {
  it("names both spellings as one option in the shipped list", () => {
    expect([...CHANGE_REQUEST_SELECTOR_OPTIONS]).toEqual(["--pr", "--mr"]);
  });

  it("leaves the selector record itself untouched", () => {
    // The alias is a second option name and nothing else: the record's field set
    // and value space are closed.
    const parsed = selectorOf(parseRunArguments(runArgv("--mr", `${HOST}/${PROJECT_PATH}!813`)));
    expect(isValidatedChangeRequestSelector(parsed)).toBe(true);
    expect(Object.keys(parsed as object).sort()).toEqual(
      [...CHANGE_REQUEST_SELECTOR_FIELDS].sort(),
    );
  });

  it.each(SURFACES.map((surface) => surface.name))(
    "admits both spellings identically at the %s surface",
    (name) => {
      const surface = SURFACES.find((candidate) => candidate.name === name)!;
      for (const value of VALUE_FORMS) {
        const viaPr = surface.parse("--pr", value);
        const viaMr = surface.parse("--mr", value);
        expect(selectorOf(viaMr)).toBeDefined();
        expect(selectorOf(viaMr)).toEqual(selectorOf(viaPr));
        // The whole admitted request, so a spelling leaked anywhere moves the digest.
        expect(digestOf(viaMr)).toBe(digestOf(viaPr));
      }
    },
  );

  it("parses one merge request to one selector at every surface", () => {
    // Cross-surface: `do` and `live-agent` must reach the record `run` reaches.
    const value = `${HOST}/${PROJECT_PATH}!${MR_IID}`;
    const selectors = SURFACES.flatMap((surface) => [
      selectorOf(surface.parse("--pr", value)),
      selectorOf(surface.parse("--mr", value)),
    ]);
    expect(selectors).toHaveLength(6);
    expect(new Set(selectors.map((selector) => JSON.stringify(selector))).size).toBe(1);
    expect(isValidatedChangeRequestSelector(selectors[0])).toBe(true);
  });

  it("accepts the attached-value form for both spellings at every surface", () => {
    // An inexact token must not be silently ignored: the run would proceed with
    // no selector, and no later gate could notice.
    for (const surface of SURFACES) {
      for (const option of CHANGE_REQUEST_SELECTOR_OPTIONS) {
        const attached = surface.parse(`${option}=${MR_IID}`);
        const spaced = surface.parse(option, `${MR_IID}`);
        expect(selectorOf(attached)).toBeDefined();
        expect(selectorOf(attached)).toEqual(selectorOf(spaced));
      }
    }
  });

  it("refuses a near miss rather than ignoring it", () => {
    // Derived from the option surface: nothing else on this CLI starts with
    // `--mr`, while `--pr` has longer siblings that all continue with a letter.
    for (const surface of SURFACES) {
      for (const typo of ["--mr813", "--mrs", "--pr813", "--pr-813"]) {
        let raised: unknown;
        try {
          surface.parse(typo, `${MR_IID}`);
        } catch (error) {
          raised = error;
        }
        expect((raised as { code?: string }).code, `${surface.name} ${typo}`).toBe(
          "selector-option-typo",
        );
        expect((raised as Error).message).toContain("--pr=<reference>");
      }
    }
    expect(() =>
      parseRunArguments(["update-documentation", "--repo", REPO, "--instruction", INSTRUCTION]),
    ).not.toThrow();
    expect(selectorOf(parseRunArguments(runArgv("--mr", `${MR_IID}`)))).toBeDefined();
    expect(selectorOf(parseRunArguments(runArgv(`--mr=${MR_IID}`, "--json")))).toBeDefined();
  });

  it("refuses both spellings together identically at every surface", () => {
    const value = `!${MR_IID}`;
    for (const surface of SURFACES) {
      for (const pair of [
        ["--pr", value, "--mr", value],
        ["--pr", value, "--mr", `!${MR_IID + 1}`],
        ["--mr", value, "--mr", value],
      ]) {
        let message = "";
        try {
          surface.parse(...pair);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/at most once in total/u);
        for (const option of CHANGE_REQUEST_SELECTOR_OPTIONS) {
          expect(message).toContain(option);
        }
      }
      expect(selectorOf(surface.parse("--mr", value))).toBeDefined();
    }
  });

  it("names both spellings in every refusal that names one", () => {
    // An operator who typed `--mr` must not be told to drop `--pr`.
    const refusals: Array<() => unknown> = [
      () => parseRunArguments(["review-documentation", "--repo", REPO, "--mr", `!${MR_IID}`]),
      () =>
        parseRunArguments([
          "update-documentation",
          "--repo",
          REPO,
          "--resume-from",
          "run-1",
          "--canon-snapshot",
          "{}",
          "--mr",
          `!${MR_IID}`,
        ]),
      () =>
        parseRunArguments([
          "update-documentation",
          "--repo",
          REPO,
          "--instruction",
          "Update docs for merge requests merged into main on 2026-09-15 in America/Los_Angeles.",
          "--mr",
          `!${MR_IID}`,
        ]),
      () => parseRunArguments(runArgv("--pr", `!${MR_IID}`, "--mr", `!${MR_IID}`)),
    ];
    for (const refusal of refusals) {
      let message = "";
      try {
        refusal();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message.length).toBeGreaterThan(0);
      for (const option of CHANGE_REQUEST_SELECTOR_OPTIONS) {
        expect(message).toContain(option);
      }
    }
  });

  it("binds byte-identical evidence under either spelling", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    workspaces.push(workspace);

    const bind = async (option: string, iid = MR_IID) => {
      const parsed = parseRunArguments(runArgv(option, `${HOST}/${PROJECT_PATH}!${iid}`));
      return resolveCliChangeRequestEvidenceFromSelector({
        workspace,
        selector: parsed.changeRequestSelector!,
        admittedRequest: {
          workflow: parsed.workflow,
          instruction: parsed.instruction,
          allowWrite: parsed.allowWrite,
          readerTaskContext: { schemaVersion: 1 },
        },
        runId: RUN_ID,
        checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
        commands: glabStub(undefined, { iid }),
        environment: {},
        // `observedAt` is sealed into the receipt; a live clock would make runs differ.
        now: FIXED_CLOCK,
      });
    };

    const viaPr = await bind("--pr");
    const viaMr = await bind("--mr");
    expect(viaMr.acquired.acquired[0]!.locator).toBe(viaPr.acquired.acquired[0]!.locator);
    expect(viaMr.acquired.acquired[0]!.observation.observationId).toBe(
      viaPr.acquired.acquired[0]!.observation.observationId,
    );
    expect(viaMr.acquired.producerScopes).toEqual(viaPr.acquired.producerScopes);
    expect(viaMr.acquired.binding.bindingSha256).toBe(viaPr.acquired.binding.bindingSha256);
    expect(viaMr.reference).toEqual(viaPr.reference);

    // Positive control: these digests move when the evidence moves.
    const other = await bind("--mr", MR_IID + 1);
    expect(other.acquired.acquired[0]!.locator).not.toBe(viaPr.acquired.acquired[0]!.locator);
    expect(other.acquired.acquired[0]!.observation.observationId).not.toBe(
      viaPr.acquired.acquired[0]!.observation.observationId,
    );
    expect(other.acquired.binding.bindingSha256).not.toBe(viaPr.acquired.binding.bindingSha256);
  });

  it("uses a host that is not this checkout's remote exactly as typed", async () => {
    // Cross-host is allowed, but nothing is rehosted: the read goes to the named
    // host, and the sealed identity says so.
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    workspaces.push(workspace);

    const OTHER_HOST = "Forge-B.Example.Test";
    const OTHER_PATH = "other-group/other-project";
    const calls = { hostnames: [] as string[], endpoints: [] as string[] };
    let checkoutCalls = 0;
    const parsed = parseRunArguments(
      runArgv("--mr", `https://${OTHER_HOST}/${OTHER_PATH}/-/merge_requests/${MR_IID}`),
    );
    expect(parsed.changeRequestSelector?.host).toBe(OTHER_HOST.toLowerCase());
    expect(parsed.changeRequestSelector?.host).not.toBe(HOST);

    const evidence = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector: parsed.changeRequestSelector!,
      admittedRequest: {
        workflow: parsed.workflow,
        instruction: parsed.instruction,
        allowWrite: parsed.allowWrite,
        readerTaskContext: { schemaVersion: 1 },
      },
      runId: RUN_ID,
      // A decoy, not a throw: a successful but unused host proves the checkout is
      // not preferred, not merely not required.
      checkout: async () => {
        checkoutCalls += 1;
        return { host: HOST, projectPath: PROJECT_PATH };
      },
      commands: glabStub(calls, { projectPath: OTHER_PATH }),
      environment: {},
      now: FIXED_CLOCK,
    });

    expect(checkoutCalls).toBe(0);
    expect(calls.hostnames).toHaveLength(2);
    expect(calls.hostnames).toEqual([OTHER_HOST.toLowerCase(), OTHER_HOST.toLowerCase()]);
    expect(calls.hostnames).not.toContain(HOST);
    expect(calls.endpoints[0]).toBe(`projects/${encodeURIComponent(OTHER_PATH)}`);

    const entry = evidence.acquired.acquired[0]!;
    expect(evidence.acquired.scope).toMatchObject({
      host: OTHER_HOST.toLowerCase(),
      projectId: PROJECT_ID,
      projectPath: OTHER_PATH,
    });
    expect(entry.locator).toBe(
      canonicalGitlabMrReviewLocator({
        host: OTHER_HOST.toLowerCase(),
        projectId: PROJECT_ID,
        mergeRequestIid: MR_IID,
      }),
    );
    expect(entry.locator).not.toContain(HOST);
  });

  it("documents the alias on every surface that documents the option", () => {
    // Row content, not mere presence: prose can mention `--mr` while the option
    // table lists only `--pr`.
    for (const help of [runHelp(), doHelp()]) {
      expect(help).toMatch(/^ {2}--pr, --mr <url-or-reference>\s{2,}\S/mu);
    }
    // The live-agent help wraps its description onto the next line, so the row
    // is the option line plus the description that follows it.
    expect(LIVE_AGENT_USAGE).toMatch(
      /^ {2}--pr, --mr <url-or-reference>\n\s+Attach one merged merge request/mu,
    );
    expect(LIVE_AGENT_USAGE).toMatch(/\[--pr \| --mr <url-or-reference>\]/u);
    expect(usage()).toMatch(/\[--pr \| --mr <url-or-reference>\]/u);
    // Every option description in the run help starts at one column.
    const columns = new Set<number>();
    for (const line of runHelp().split("\n")) {
      const match = /^ {2}(--\S.*?)\s{2,}(\S)/u.exec(line);
      if (match) columns.add(line.indexOf(match[2]!, 2 + match[1]!.length));
    }
    expect([...columns]).toHaveLength(1);

    const page = (path: string) =>
      readFileSync(new URL(`../../../docs/${path}`, import.meta.url), "utf8");
    expect(page("get-started/runner-quickstart.md")).toMatch(/`--mr` is an exact alias/u);

    // Every table row naming the option must name both spellings; one occurrence
    // per page would let a second row name only `--pr`.
    for (const path of [
      "reference/status-and-configuration/runtime-cli-and-configuration.md",
      "reference/status-and-configuration/live-agent.md",
    ]) {
      const rows = page(path)
        .split("\n")
        .filter((line) => line.startsWith("|") && /`--pr\b/u.test(line));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatch(/`--mr`/u);
      }
    }
    // The live-agent option row names both spellings in its name cell.
    const optionRow = page("reference/status-and-configuration/live-agent.md")
      .split("\n")
      .find((line) => line.startsWith("| `--pr`"));
    expect(optionRow).toBeDefined();
    expect(optionRow!.split("|")[1]).toMatch(/`--pr`, `--mr`/u);
  });

  it("states that a named forge host is used as typed", () => {
    expect(runHelp()).toContain("Nothing is rehosted.");
    const quickstart = readFileSync(
      new URL("../../../docs/get-started/runner-quickstart.md", import.meta.url),
      "utf8",
    );
    expect(quickstart).toContain("used exactly as typed");
    expect(quickstart).toContain("nothing is rehosted");
  });

  it("carries a remediation on the near-miss refusal like every other selector stop", () => {
    expect([...CHANGE_REQUEST_SELECTOR_REFUSAL_CODES]).toContain("selector-option-typo");
  });

  it("accepts and refuses --source in exactly the same forms", () => {
    // `--source=docs/a.html` is the same trap as `--mr=!813`; one helper governs
    // both options, so the forms cannot drift apart.
    for (const surface of SURFACES) {
      const attached = surface.parse("--source=docs/release-notes.html");
      const spaced = surface.parse("--source", "docs/release-notes.html");
      expect((attached as { sourcePaths?: readonly string[] }).sourcePaths).toEqual([
        "docs/release-notes.html",
      ]);
      expect(digestOf(attached)).toBe(digestOf(spaced));
    }

    // A near miss is refused with its own coded stop, whether it extends the name
    // or is a proper prefix of it.
    for (const surface of SURFACES) {
      for (const typo of ["--sour", "--sourc", "--sourceX", "--source-x"]) {
        let raised: unknown;
        try {
          surface.parse(typo, "docs/a.md");
        } catch (error) {
          raised = error;
        }
        expect((raised as { code?: string }).code, `${surface.name} ${typo}`).toBe(
          "source-option-form-unrecognized",
        );
      }
    }
    for (const tokens of [["--source"], ["--source="]]) {
      let raised: unknown;
      try {
        parseRunArguments([
          "update-documentation",
          "--repo",
          REPO,
          "--instruction",
          INSTRUCTION,
          ...tokens,
        ]);
      } catch (error) {
        raised = error;
      }
      expect((raised as { code?: string }).code).toBe("source-option-value-missing");
    }
    // Control: the spaced form still binds.
    expect(
      (
        parseRunArguments([
          "update-documentation",
          "--repo",
          REPO,
          "--instruction",
          INSTRUCTION,
          "--source",
          "docs/a.md",
        ]) as { sourcePaths?: readonly string[] }
      ).sourcePaths,
    ).toEqual(["docs/a.md"]);
  });

  it.each([...SOURCE_OPTION_REFUSAL_CODES])(
    "names a condition and the change that clears it on the %s stop",
    (code) => {
      const message = SOURCE_OPTION_REFUSALS[code];
      expect(message).not.toContain(code);
      const sentences = message.split(". ").filter((part) => part.trim().length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(sentences.at(-1)).toMatch(/^(?:Write|Pass|Use|Name|Run|Correct)\b/u);
      expect(message.endsWith(".")).toBe(true);
      // A --source stop must not tell the operator about --pr.
      expect(message).toContain("--source");
      expect(message).not.toContain("--pr");
    },
  );

  it("gives a clear missing-value refusal on every surface", () => {
    const messages = new Map<string, string>();
    for (const surface of SURFACES) {
      try {
        surface.parse("--pr");
      } catch (error) {
        messages.set(surface.name, (error as Error).message);
      }
    }
    expect([...messages.keys()]).toEqual(SURFACES.map((surface) => surface.name));
    const runMessage = messages.get("run");
    const doMessage = messages.get("do");
    const liveAgentMessage = messages.get("live-agent");
    expect(runMessage).toBe(SELECTOR_OPTION_REFUSALS["selector-option-value-missing"]);
    expect(doMessage).toBe(runMessage);
    expect(liveAgentMessage).toContain("--pr");
    expect(liveAgentMessage).toContain("GitHub pull-request URL");
    expect(liveAgentMessage).toContain("GitLab merge-request reference");
    for (const option of CHANGE_REQUEST_SELECTOR_OPTIONS) {
      expect(runMessage).toContain(option);
    }
  });

  it.each([...SELECTOR_OPTION_REFUSAL_CODES])(
    "names a condition and the change that clears it on the selector %s stop",
    (code) => {
      const message = SELECTOR_OPTION_REFUSALS[code];
      expect(message).not.toContain(code);
      const sentences = message.split(". ").filter((part) => part.trim().length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(sentences.at(-1)).toMatch(/^(?:Write|Pass|Use|Name|Run|Correct)\b/u);
      expect(message.endsWith(".")).toBe(true);
      for (const option of CHANGE_REQUEST_SELECTOR_OPTIONS) {
        expect(message).toContain(option);
      }
    },
  );
});
