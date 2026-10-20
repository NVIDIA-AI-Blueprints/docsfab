// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Request-intent Correct-class hardening: whole-token grounding of named
 * targets, the full case fold for narrowing comparisons, verification
 * re-checks on re-sealed records, refusal of repository-internal paths, and
 * word-bounded quote grounding. Each row asserts the parsed arm, code,
 * location and boundary, beside an adjacent case that must pass.
 */
import { describe, expect, it } from "vitest";

import {
  groundQuote,
  RequestIntentContractError,
  requestIntentWriteSet,
  verifyRequestIntentDigest,
  type RequestIntentAdmissionResult,
  type RequestIntentBody,
  type RequestIntentV1,
} from "../src/request-intent/index.js";
import { RequestIntentFault } from "../src/request-intent/kit.js";
import { faultOutcome } from "../src/request-intent/outcome.js";
import { sealRequestIntent } from "../src/request-intent/seal.js";
import {
  CREATE_HOST,
  CREATE_INSTRUCTION,
  createProposal,
  DEFAULT_ROOTS,
  edited,
  interpret,
  pilotHost,
  type Proposal,
  question,
  REVIEW_HOST,
  UPDATE_HOST,
  UPDATE_INSTRUCTION,
  updateProposal,
} from "./helpers/request-intent-fixture.js";
import { detectCredentialRuleIds } from "../src/security/repository-scanner.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

function arm(result: RequestIntentAdmissionResult) {
  return {
    outcome: result.outcome,
    code: "code" in result ? result.code : undefined,
    location: "location" in result ? result.location : undefined,
  };
}

function rejected(code: string, location: string) {
  return { outcome: "rejected", code, location };
}

function admitted(result: RequestIntentAdmissionResult): RequestIntentV1 {
  expect(result.outcome, JSON.stringify(arm(result))).toBe("admitted");
  if (result.outcome !== "admitted") throw new Error("Expected the proposal to be admitted.");
  return result.intent;
}

/** One write target the operator named, quoted with `quote`, and nothing else. */
function namedUpdate(path: string, quote: string): Proposal {
  return {
    operation: "update",
    targets: [{ path, role: "write", chosenFrom: "named", quote }],
    authorityPreference: { preference: "unspecified", quote: null },
  };
}

/** A create with the given proposed-new target paths, each quoting the pilot's opening. */
function createWith(paths: readonly string[]): Proposal {
  return edited(createProposal(), (p) => {
    const base = (p.targets as Proposal[])[0]!;
    p.targets = paths.map((path) => ({ ...base, path }));
  });
}

describe("request-intent named targets ground on a whole path token", () => {
  it.each([
    ["a longer file name", "Update docs/cli.mdx today.", "Update docs/cli.mdx"],
    ["a longer directory name", "Update xdocs/cli.md today.", "Update xdocs/cli.md"],
    ["a parent-directory spelling", "Update ../docs/cli.md today.", "Update ../docs/cli.md"],
    ["a `./` that does not open a token", "Update x./docs/cli.md today.", "Update x./docs/cli.md"],
    // The quote ends on the path, but the request goes on: edges are judged in the request.
    ["a backup file past the quote's end", "Update docs/cli.md.bak today.", "Update docs/cli.md"],
    ["punctuation followed by a letter", "Update docs/cli.md,v2 today.", "Update docs/cli.md,v2"],
    ["a path only after the quote", "Update the page; it is docs/cli.md.", "Update the page"],
    ["a path only before the quote", "docs/cli.md is stale. Update the page.", "Update the page"],
  ])("rejects a named docs/cli.md quoted from %s", (_name, instruction, quote) => {
    expect(arm(interpret(namedUpdate("docs/cli.md", quote), instruction, UPDATE_HOST))).toEqual(
      rejected("request-intent-named-ungrounded", "$.targets[].path"),
    );
  });

  it("rejects a named target the operator never wrote, on the update pilot", () => {
    const proposal = edited(updateProposal(), (p) => {
      (p.targets as Proposal[])[0]!.chosenFrom = "named";
      (p.targets as Proposal[])[0]!.path = "docs/cli-reference-to-match.md";
    });
    const result = interpret(proposal, UPDATE_INSTRUCTION, UPDATE_HOST);
    expect(arm(result)).toEqual(rejected("request-intent-named-ungrounded", "$.targets[].path"));
    expect(result).toMatchObject({
      at: "$.targets[0].path",
      retry: "model-correctable",
    });
  });

  it("matches the named path in exact letter case", () => {
    expect(
      arm(
        interpret(
          namedUpdate("docs/cli.md", "Update docs/CLI.md"),
          "Update docs/CLI.md now.",
          UPDATE_HOST,
        ),
      ),
    ).toEqual(rejected("request-intent-named-ungrounded", "$.targets[].path"));
  });

  it.each([
    ["a sentence period", "Update docs/cli.md.", "Update docs/cli.md"],
    ["a comma", "Fix docs/cli.md, then stop.", "docs/cli.md"],
    ["a colon", "docs/cli.md: fix the flags.", "docs/cli.md"],
    ["brackets", "Fix the page (docs/cli.md) now.", "docs/cli.md"],
    ["backticks", "Fix `docs/cli.md` now.", "docs/cli.md"],
    ["a Markdown link", "Fix [CLI](docs/cli.md) now.", "docs/cli.md"],
    ["typographic quotes", "Fix “docs/cli.md” now.", "docs/cli.md"],
    ["a fragment", "Fix docs/cli.md#flags now.", "docs/cli.md"],
    ["punctuation before a closing bracket", "Fix the page (see docs/cli.md.) now.", "docs/cli.md"],
    ["a `./` prefix", "Fix ./docs/cli.md now.", "./docs/cli.md"],
    ["the end of the request", "Fix docs/cli.md", "Fix docs/cli.md"],
    [
      "a later whole occurrence",
      "Move xdocs/cli.md into docs/cli.md now.",
      "xdocs/cli.md into docs/cli.md",
    ],
  ])("admits a named docs/cli.md written with %s", (_name, instruction, quote) => {
    const intent = admitted(interpret(namedUpdate("docs/cli.md", quote), instruction, UPDATE_HOST));
    expect(intent.targets[0]!.path).toBe("docs/cli.md");
  });

  it.each([
    ["exact", "docs/cli.md"],
    ["folded", "DOCS/CLI.MD"],
  ])("seals a later span that names the path when the first %s hit does not", (_name, quote) => {
    const instruction = "Fix docs/cli.md.bak and docs/cli.md now.";
    const intent = admitted(interpret(namedUpdate("docs/cli.md", quote), instruction, UPDATE_HOST));
    expect(intent.targets[0]!.quote).toEqual({ text: "docs/cli.md", start: 24, end: 35 });
  });

  it("keeps the first word-bounded span for an inventory target", () => {
    const instruction = "Fix docs/cli.md.bak and docs/cli.md now.";
    const proposal = edited(namedUpdate("docs/cli.md", "docs/cli.md"), (p) => {
      (p.targets as Proposal[])[0]!.chosenFrom = "inventory";
    });
    expect(admitted(interpret(proposal, instruction, UPDATE_HOST)).targets[0]!.quote.start).toBe(4);
  });

  it("applies only to named targets: inventory and proposed-new quotes need not hold the path", () => {
    expect(
      admitted(interpret(updateProposal(), UPDATE_INSTRUCTION, UPDATE_HOST)).targets[0]!.chosenFrom,
    ).toBe("inventory");
    expect(
      admitted(interpret(createProposal(), CREATE_INSTRUCTION, CREATE_HOST)).targets[0]!.chosenFrom,
    ).toBe("proposed-new");
  });

  it("runs after quote grounding and origin, and before exclusions", () => {
    const instruction = "Update docs/cli.mdx today. Keep docs untouched.";
    const ungroundedFirst = namedUpdate("docs/cli.md", "Rewrite everything");
    expect(arm(interpret(ungroundedFirst, instruction, UPDATE_HOST))).toEqual(
      rejected("request-intent-quote-ungrounded", "$.targets[].quote"),
    );
    const excludedToo = {
      ...namedUpdate("docs/cli.md", "Update docs/cli.mdx"),
      exclusions: [{ path: "docs", quote: "Keep docs untouched" }],
    };
    expect(arm(interpret(excludedToo, instruction, UPDATE_HOST))).toEqual(
      rejected("request-intent-named-ungrounded", "$.targets[].path"),
    );
  });
});

describe("request-intent narrowing comparisons use the full case fold", () => {
  it.each(["docſ", "docſ/configuration.md", "DOCſ/CONFIGURATION.MD"])(
    "rejects the exclusion %j on the update pilot, which a case-folding checkout opens as the target",
    (path) => {
      const proposal = edited(updateProposal(), (p) => {
        p.exclusions = [{ path, quote: "Keep unrelated documentation unchanged" }];
      });
      expect(arm(interpret(proposal, UPDATE_INSTRUCTION, UPDATE_HOST))).toEqual(
        rejected("request-intent-excluded-target", "$.exclusions[].path"),
      );
    },
  );

  it.each([
    ["sharp s and SS", ["docs/straße.md", "docs/STRASSE.md"]],
    ["capital sharp s and ss", ["docs/STRAẞE.md", "docs/strasse.md"]],
    ["final and medial sigma", ["docs/ας.md", "docs/ΑΣ.md"]],
    ["final sigma in a directory", ["docs/ας/x.md", "docs/ασ/x.md"]],
  ])("rejects two targets that differ only by %s as duplicates", (_name, paths) => {
    expect(arm(interpret(createWith(paths), CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
      rejected("request-intent-duplicate-target", "$.targets[].path"),
    );
  });

  it("admits targets whose folded names still differ", () => {
    const intent = admitted(
      interpret(
        createWith(["docs/strasse-guide.md", "docs/strass.md"]),
        CREATE_INSTRUCTION,
        CREATE_HOST,
      ),
    );
    expect(requestIntentWriteSet(intent)).toEqual(["docs/strasse-guide.md", "docs/strass.md"]);
  });

  it("keeps a sibling whose folded name only shares a prefix with an exclusion", () => {
    const proposal = edited(updateProposal(), (p) => {
      p.exclusions = [
        {
          path: "docſ/configuration",
          quote: "Keep unrelated documentation unchanged",
        },
      ];
    });
    expect(
      requestIntentWriteSet(admitted(interpret(proposal, UPDATE_INSTRUCTION, UPDATE_HOST))),
    ).toEqual(["docs/configuration.md"]);
  });
});

/** An admitted intent's body, edited and sealed again with a valid digest. */
function resealed(intent: RequestIntentV1, edit: (body: Record<string, unknown>) => void) {
  const body = JSON.parse(JSON.stringify(intent)) as Record<string, unknown>;
  delete body.schemaVersion;
  delete body.kind;
  delete body.digest;
  edit(body);
  return JSON.parse(JSON.stringify(sealRequestIntent(body as unknown as RequestIntentBody)));
}

function verifyFault(value: unknown, instruction = UPDATE_INSTRUCTION): string | undefined {
  try {
    verifyRequestIntentDigest(value, instruction);
  } catch (error) {
    expect(error).toBeInstanceOf(RequestIntentContractError);
    return (error as RequestIntentContractError).code;
  }
  return undefined;
}

type Entry = Record<string, unknown>;

describe("request-intent verification re-checks the path rules a re-seal could skip", () => {
  const intent = () => admitted(interpret(updateProposal(), UPDATE_INSTRUCTION, UPDATE_HOST));
  const withTargets = (paths: readonly string[]) => (body: Record<string, unknown>) => {
    const first = (body.targets as Entry[])[0]!;
    body.targets = paths.map((path) => ({
      ...first,
      path,
      chosenFrom: "named",
    }));
  };
  const quoteOf = (body: Record<string, unknown>) => (body.targets as Entry[])[0]!.quote;

  it.each([
    ["an upper-case copy", ["docs/configuration.md", "DOCS/CONFIGURATION.MD"]],
    ["sharp s and SS", ["docs/straße.md", "docs/STRASSE.md"]],
  ])("refuses re-sealed duplicate targets: %s", (_name, paths) => {
    expect(verifyFault(resealed(intent(), withTargets(paths)))).toBe("sealed-duplicate-target");
  });

  it("verifies re-sealed targets whose folded names differ", () => {
    const valid = resealed(intent(), withTargets(["docs/strasse-guide.md", "docs/strass.md"]));
    expect(verifyFault(valid)).toBeUndefined();
  });

  it("refuses a re-sealed exclusion that names or contains a target", () => {
    for (const path of ["docs", "docſ/configuration.md"]) {
      const forged = resealed(intent(), (body) => {
        body.exclusions = [{ path, quote: quoteOf(body) }];
      });
      expect(verifyFault(forged), path).toBe("sealed-excluded-target");
    }
    const sibling = resealed(intent(), (body) => {
      body.exclusions = [{ path: "docs/troubleshooting.md", quote: quoteOf(body) }];
    });
    expect(verifyFault(sibling)).toBeUndefined();
  });

  it.each([
    ["target", withTargets([".git/config"])],
    ["nested target", withTargets(["docs/.GIT/x.md"])],
    [
      "source",
      (body: Record<string, unknown>) =>
        void (body.sources = [{ path: ".git/config", quote: quoteOf(body) }]),
    ],
  ])("refuses a re-sealed internal %s", (_name, edit) => {
    expect(verifyFault(resealed(intent(), edit))).toBe("sealed-internal-path");
  });

  it("verifies a re-sealed internal exclusion, which only narrows", () => {
    const forged = resealed(intent(), (body) => {
      body.exclusions = [{ path: ".git", quote: quoteOf(body) }];
    });
    expect(verifyFault(forged)).toBeUndefined();
  });

  it("never emits two fold-equal paths in the write set, keeping the first spelling", () => {
    const quote = intent().targets[0]!.quote;
    const target = (path: string) => ({
      path,
      role: "write" as const,
      chosenFrom: "named" as const,
      quote,
    });
    expect(
      requestIntentWriteSet({
        targets: [target("docs/straße.md"), target("docs/STRASSE.md"), target("docs/other.md")],
        exclusions: [],
      }),
    ).toEqual(["docs/straße.md", "docs/other.md"]);
  });
});

describe("request-intent refuses repository-internal paths", () => {
  const internalBoundary = (observed: string) => ({
    kind: "internal-segment",
    segment: ".git",
    observed,
    remediation:
      "Remove the path from the request; repository internals are never read or written.",
  });

  it.each([".git/config", "docs/.git/x", ".GIT/HEAD", "docs/.Git"])(
    "refuses the target %j with its boundary",
    (path) => {
      const result = interpret(createWith([path]), CREATE_INSTRUCTION, CREATE_HOST);
      expect(result).toEqual({
        outcome: "refused",
        code: "request-intent-internal-path",
        location: "$.targets[].path",
        at: "$.targets[0].path",
        retry: "terminal",
        boundary: internalBoundary(path),
      });
    },
  );

  it.each([".git/config", "docs/.git/x", ".GIT/HEAD"])("refuses the source %j", (path) => {
    const proposal = edited(createProposal(), (p) => {
      p.sources = [{ path, quote: "the configure command" }];
    });
    expect(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST)).toMatchObject({
      outcome: "refused",
      code: "request-intent-internal-path",
      location: "$.sources[].path",
      at: "$.sources[0].path",
      boundary: internalBoundary(path),
    });
  });

  it.each([
    [
      "target",
      () => namedUpdate(".git/config", "Fix .git/config"),
      "Fix .git/config now.",
      "targets",
    ],
    [
      "source",
      () =>
        edited(createProposal(), (p) => {
          p.sources = [{ path: ".git/config", quote: "the configure command" }];
        }),
      CREATE_INSTRUCTION,
      "sources",
    ],
  ])("refuses an internal %s before the model's question", (_name, base, instruction, list) => {
    const proposal = edited(base(), (p) => {
      p.questions = [question()];
    });
    expect(interpret(proposal, instruction, UPDATE_HOST)).toEqual({
      outcome: "refused",
      code: "request-intent-internal-path",
      location: `$.${list}[].path`,
      at: `$.${list}[0].path`,
      retry: "terminal",
      boundary: internalBoundary(".git/config"),
    });
  });

  // The boundary echoes the observed path, so the credential check must run
  // first. Only one of DocsFab's own configured credentials is a disclosure; a
  // credential shape alone is an internal path like any other (#1807).
  it.each(["target", "source"])(
    "refuses a configured-credential internal %s as a disclosure, without echoing it",
    (list) => {
      const interpretInternal = (secret: string) => {
        const path = `.git/${secret}`;
        return list === "target"
          ? interpret(namedUpdate(path, `Fix ${path}`), `Fix ${path} now.`, UPDATE_HOST)
          : interpret(
              edited(createProposal(), (p) => {
                p.sources = [{ path, quote: "the configure command" }];
              }),
              CREATE_INSTRUCTION,
              CREATE_HOST,
            );
      };
      expect(arm(interpretInternal(["AKIA", "M4N8B2V6C1X5Z9L3"].join("")))).toMatchObject({
        outcome: "refused",
        code: "request-intent-internal-path",
      });

      // A configured value that does not look like a credential, so only the
      // exact match makes it a disclosure.
      const credential = configureCredential(["meadow", plantedCredentialValue(100, 24)].join("-"));
      expect(detectCredentialRuleIds(`.git/${credential}`)).toEqual([]);
      const result = interpretInternal(credential);
      expect(arm(result)).toEqual({
        outcome: "refused",
        code: "request-intent-disclosure",
        location: "$",
      });
      expect(JSON.stringify(result)).not.toContain(credential);
    },
  );

  it("lets a Correct failure win over an internal path", () => {
    const proposal = edited(createWith([".git/config"]), (p) => {
      (p.targets as Proposal[])[0]!.quote = "Rewrite the repository internals";
    });
    expect(arm(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
      rejected("request-intent-quote-ungrounded", "$.targets[].quote"),
    );
  });

  it.each(["docs/git.md", "docs/.gitkeep", "docs/.gitignore.md", "git/x.md"])(
    "admits the target %j, which only resembles an internal segment",
    (path) => {
      // `git` is a documentation root here, so only the internal-segment check could refuse.
      const roots = [...DEFAULT_ROOTS, { kind: "root" as const, path: "git" }];
      const host = pilotHost("create", { docsRoot: roots, grantedWriteScope: roots });
      expect(
        admitted(interpret(createWith([path]), CREATE_INSTRUCTION, host)).targets[0]!.path,
      ).toBe(path);
    },
  );

  it("admits .github/workflows/ci.yml as a source", () => {
    const proposal = edited(createProposal(), (p) => {
      p.sources = [{ path: ".github/workflows/ci.yml", quote: "the configure command" }];
    });
    expect(admitted(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST)).sources[0]!.path).toBe(
      ".github/workflows/ci.yml",
    );
  });

  it("admits an exclusion of .git, which only narrows", () => {
    const instruction = "Update docs/x.md; do not touch .git";
    const proposal = {
      ...namedUpdate("docs/x.md", "Update docs/x.md"),
      exclusions: [{ path: ".git", quote: "do not touch .git" }],
    };
    const intent = admitted(interpret(proposal, instruction, UPDATE_HOST));
    expect(intent.exclusions.map((entry) => entry.path)).toEqual([".git"]);
    expect(requestIntentWriteSet(intent)).toEqual(["docs/x.md"]);
  });

  it("refuses an authority fault only with its boundary; without one it is a module defect", () => {
    const boundary = internalBoundary(".git/config") as never;
    const fault = new RequestIntentFault(
      "request-intent-internal-path",
      "$.targets[].path",
      "$.targets[0].path",
      undefined,
      boundary,
    );
    expect(faultOutcome(fault)).toMatchObject({ outcome: "refused", boundary });
    const bare = new RequestIntentFault(
      "request-intent-internal-path",
      "$.targets[].path",
      "$.targets[0].path",
    );
    expect(() => faultOutcome(bare)).toThrow(bare);
  });
});

describe("request-intent quotes ground on word boundaries", () => {
  it.each([
    ["a word inside a longer one (end edge)", "Please address the page.", "add"],
    ["a word inside a longer one (start edge)", "Please address the page.", "dress"],
    ["a prefix of the next word", "Adding pages is next.", "add"],
    ["a span ending before its letter's combining mark", "Update the q̃ entry.", "Update the q"],
    ["a spaced script", "한국어문서 업데이트", "국어문서"],
    ["an astral letter before the span", "x \u{1D400}add y", "add"],
  ])("rejects %s", (_name, instruction, quote) => {
    expect(groundQuote(instruction, quote)).toBeUndefined();
    const proposal = {
      operation: "review",
      targets: [],
      preserve: [{ quote }],
      authorityPreference: { preference: "unspecified", quote: null },
    };
    expect(arm(interpret(proposal, instruction, REVIEW_HOST))).toEqual(
      rejected("request-intent-quote-ungrounded", "$.preserve[].quote"),
    );
  });

  it.each([
    ["a whole word", "Add docs/x.md", "Add", 0],
    ["a later whole word after a sub-word hit", "address it, then add docs/x.md", "add", 17],
    ["a later exact hit, folded", "address it, then ADD docs/x.md", "add", 17],
    ["a run of a no-space script", "请更新docs/cli.md", "更新docs/cli.md", 1],
    ["a span ending on a combining mark", "Update the q̃ entry.", "Update the q̃", 0],
    ["a possessive", "Ask the operator's team.", "operator", 8],
    ["a hyphenated word", "Then re-run it.", "run", 8],
    ["a version token", "Update the v2 page.", "v2", 11],
  ])("grounds %s", (_name, instruction, quote, start) => {
    const span = groundQuote(instruction, quote);
    expect(span?.start).toBe(start);
    expect(instruction.slice(span!.start, span!.end).toLowerCase()).toBe(quote.toLowerCase());
  });
});
