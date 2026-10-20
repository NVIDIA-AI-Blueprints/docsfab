// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * RequestIntentV1 decode and Correct-class admission: one row per rule, each
 * with its positive control, asserting the parsed result arm, code and
 * location. Offline: no model, no network, no repository.
 */
import { describe, expect, it } from "vitest";

import { limit, limitDefinition, OperationalLimitError } from "../src/config/limits.js";
import { OUTPUT_RULE_FAMILIES, OUTPUT_RULES } from "../src/contracts/model-output.js";
import {
  admitRequestIntent,
  decodeRequestIntentProposal,
  requestIntentWriteSet,
  RequestIntentContractError,
  verifyRequestIntentDigest,
  type RequestIntentAdmissionResult,
} from "../src/request-intent/index.js";
import { at, RequestIntentFault } from "../src/request-intent/kit.js";
import { faultOutcome, rejectedOutcome } from "../src/request-intent/outcome.js";
import {
  admissionInput,
  CREATE_HOST,
  CREATE_INSTRUCTION,
  createProposal,
  edited,
  interpret,
  INVENTORY,
  limits,
  PILOT_REPOSITORY,
  pilotHost,
  type Proposal,
  question,
  REVIEW_HOST,
  UPDATE_HOST,
  UPDATE_INSTRUCTION,
  updateProposal,
} from "./helpers/request-intent-fixture.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

const L = limits();

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

function admittedIntent(result: RequestIntentAdmissionResult) {
  expect(result.outcome, JSON.stringify(arm(result))).toBe("admitted");
  if (result.outcome !== "admitted") throw new Error("Expected the proposal to be admitted.");
  return result.intent;
}

describe("request-intent pilot shapes", () => {
  it("admits the create pilot with a proposed-new target and an evidence-only constraint", () => {
    const intent = admittedIntent(interpret(createProposal(), CREATE_INSTRUCTION, CREATE_HOST));
    expect(intent.operation).toBe("create");
    expect(intent.targets.map((target) => [target.path, target.chosenFrom])).toEqual([
      ["docs/telemetryctl-configuration.md", "proposed-new"],
    ]);
    expect(intent.constraints.map((constraint) => constraint.kind)).toEqual(["evidence-only"]);
    expect(intent.question).toBeNull();
  });

  it("admits the update pilot with an inventory target and two preserved passages", () => {
    const intent = admittedIntent(interpret(updateProposal(), UPDATE_INSTRUCTION, UPDATE_HOST));
    expect(intent.targets[0]).toMatchObject({
      path: "docs/configuration.md",
      chosenFrom: "inventory",
    });
    expect(intent.preserve.map((entry) => entry.quote.text)).toEqual([
      "retaining the existing troubleshooting advice and its stable anchor",
      "Keep unrelated documentation unchanged",
    ]);
  });

  it("declares every request-intent code in the catalog family, each with its retry", () => {
    const codes = [...OUTPUT_RULE_FAMILIES["request-intent"].codes].sort();
    expect(codes).toEqual(
      [
        "request-intent-companion-not-navigation",
        "request-intent-disclosure",
        "request-intent-duplicate-target",
        "request-intent-excluded-target",
        "request-intent-host-field",
        "request-intent-internal-path",
        "request-intent-inventory-unmatched",
        "request-intent-model-question",
        "request-intent-named-ungrounded",
        "request-intent-path-grammar",
        "request-intent-proposed-new-operation",
        "request-intent-question-count",
        "request-intent-question-default",
        "request-intent-quote-ungrounded",
        "request-intent-shape",
        "request-intent-size",
        "request-intent-operation-mismatch",
        "request-intent-outside-docs-root",
        "request-intent-outside-write-scope",
        "request-intent-target-absent",
        "request-intent-target-case-ambiguous",
        "request-intent-target-missing",
        "request-intent-target-not-file",
        "request-intent-target-not-granted",
        "request-intent-target-present",
      ].sort(),
    );
    expect(OUTPUT_RULES["request-intent-disclosure"].retry).toBe("terminal");
    expect(OUTPUT_RULES["request-intent-model-question"].retry).toBe("terminal");
    expect(OUTPUT_RULES["request-intent-shape"].retry).toBe("model-correctable");
    expect(OUTPUT_RULES["request-intent-named-ungrounded"].retry).toBe("model-correctable");
    expect(OUTPUT_RULES["request-intent-internal-path"]).toMatchObject({
      kind: "authority",
      retry: "terminal",
    });
  });
});

describe("request-intent inventory and proposed-new origins (R11)", () => {
  it("rejects an inventory target that the inventory does not list", () => {
    const proposal = edited(updateProposal(), (p) => {
      (p.targets as Proposal[])[0]!.path = "docs/configuration-reference.md";
    });
    expect(arm(interpret(proposal, UPDATE_INSTRUCTION, UPDATE_HOST))).toEqual(
      rejected("request-intent-inventory-unmatched", "$.targets[].path"),
    );
  });

  it("matches inventory membership exactly, letter case included", () => {
    const proposal = edited(updateProposal(), (p) => {
      (p.targets as Proposal[])[0]!.path = "docs/Configuration.md";
    });
    expect(arm(interpret(proposal, UPDATE_INSTRUCTION, UPDATE_HOST))).toEqual(
      rejected("request-intent-inventory-unmatched", "$.targets[].path"),
    );
  });

  it("rejects proposed-new on an update and admits it on a create", () => {
    const proposal = edited(updateProposal(), (p) => {
      (p.targets as Proposal[])[0]!.chosenFrom = "proposed-new";
    });
    expect(arm(interpret(proposal, UPDATE_INSTRUCTION, UPDATE_HOST))).toEqual(
      rejected("request-intent-proposed-new-operation", "$.targets[].chosenFrom"),
    );
    expect(interpret(createProposal(), CREATE_INSTRUCTION, CREATE_HOST).outcome).toBe("admitted");
  });

  it("does not apply inventory membership to a named target", () => {
    const instruction = `${UPDATE_INSTRUCTION} The page is docs/not-in-inventory.md.`;
    const proposal = edited(updateProposal(), (p) => {
      (p.targets as Proposal[])[0]!.chosenFrom = "named";
      (p.targets as Proposal[])[0]!.path = "docs/not-in-inventory.md";
      (p.targets as Proposal[])[0]!.quote = "The page is docs/not-in-inventory.md";
    });
    // Tracked in the repository, but not in the inventory the model chose from.
    const host = pilotHost("update", {
      repository: { tracked: [...PILOT_REPOSITORY.tracked, "docs/not-in-inventory.md"] },
    });
    expect(interpret(proposal, instruction, host).outcome).toBe("admitted");
  });
});

describe("request-intent exclusions only subtract (R7)", () => {
  it("rejects a target that an exclusion names, never dropping it silently", () => {
    const proposal = edited(updateProposal(), (p) => {
      p.exclusions = [
        {
          path: "docs/configuration.md",
          quote: "Keep unrelated documentation unchanged",
        },
      ];
    });
    expect(arm(interpret(proposal, UPDATE_INSTRUCTION, UPDATE_HOST))).toEqual(
      rejected("request-intent-excluded-target", "$.exclusions[].path"),
    );
  });

  it("rejects a target inside an excluded directory, and not a sibling that shares its prefix", () => {
    const inside = edited(updateProposal(), (p) => {
      p.exclusions = [{ path: "docs", quote: "Keep unrelated documentation unchanged" }];
    });
    expect(arm(interpret(inside, UPDATE_INSTRUCTION, UPDATE_HOST))).toEqual(
      rejected("request-intent-excluded-target", "$.exclusions[].path"),
    );
    const sibling = edited(updateProposal(), (p) => {
      p.exclusions = [
        {
          path: "docs/configuration",
          quote: "Keep unrelated documentation unchanged",
        },
      ];
    });
    expect(interpret(sibling, UPDATE_INSTRUCTION, UPDATE_HOST).outcome).toBe("admitted");
  });

  it.each([
    ["a letter-case variant of the target file", "docs/Configuration.md"],
    ["a letter-case variant of its directory", "Docs"],
    ["an upper-case spelling of the whole path", "DOCS/CONFIGURATION.MD"],
  ])(
    "rejects an exclusion naming %s, which a case-folding checkout opens as the target",
    (_name, path) => {
      const proposal = edited(updateProposal(), (p) => {
        p.exclusions = [{ path, quote: "Keep unrelated documentation unchanged" }];
      });
      expect(arm(interpret(proposal, UPDATE_INSTRUCTION, UPDATE_HOST))).toEqual(
        rejected("request-intent-excluded-target", "$.exclusions[].path"),
      );
    },
  );

  it("folds the target side too: a lower-case exclusion names an upper-case target", () => {
    const instruction = `${UPDATE_INSTRUCTION} The page is Docs/Configuration.md.`;
    const proposal = edited(updateProposal(), (p) => {
      (p.targets as Proposal[])[0]!.chosenFrom = "named";
      (p.targets as Proposal[])[0]!.path = "Docs/Configuration.md";
      (p.targets as Proposal[])[0]!.quote = "The page is Docs/Configuration.md";
      p.exclusions = [
        { path: "docs/configuration.md", quote: "Keep unrelated documentation unchanged" },
      ];
    });
    expect(arm(interpret(proposal, instruction, UPDATE_HOST))).toEqual(
      rejected("request-intent-excluded-target", "$.exclusions[].path"),
    );
  });

  it("keeps the segment bound under the letter-case fold", () => {
    // Adjacent: a case variant of a prefix that is not a whole segment excludes nothing.
    const sibling = edited(updateProposal(), (p) => {
      p.exclusions = [
        { path: "Docs/Configuration", quote: "Keep unrelated documentation unchanged" },
      ];
    });
    const intent = admittedIntent(interpret(sibling, UPDATE_INSTRUCTION, UPDATE_HOST));
    expect(requestIntentWriteSet(intent)).toEqual(["docs/configuration.md"]);
  });

  it("subtracts a letter-case variant exclusion from a write set the caller assembled", () => {
    const intent = admittedIntent(interpret(updateProposal(), UPDATE_INSTRUCTION, UPDATE_HOST));
    const quote = intent.targets[0]!.quote;
    expect(
      requestIntentWriteSet({
        targets: intent.targets,
        exclusions: [{ path: "Docs/Configuration.md", quote }],
      }),
    ).toEqual([]);
    expect(
      requestIntentWriteSet({ targets: intent.targets, exclusions: [{ path: "DOCS", quote }] }),
    ).toEqual([]);
  });

  it("records an exclusion of a non-target and adds nothing to the write set", () => {
    const proposal = edited(updateProposal(), (p) => {
      p.exclusions = [
        {
          path: "docs/troubleshooting.md",
          quote: "Keep unrelated documentation unchanged",
        },
      ];
    });
    const intent = admittedIntent(interpret(proposal, UPDATE_INSTRUCTION, UPDATE_HOST));
    expect(intent.exclusions.map((entry) => entry.path)).toEqual(["docs/troubleshooting.md"]);
    expect(requestIntentWriteSet(intent)).toEqual(["docs/configuration.md"]);
  });

  it("subtracts an excluded path from a write set the caller assembled", () => {
    const intent = admittedIntent(interpret(updateProposal(), UPDATE_INSTRUCTION, UPDATE_HOST));
    const writeSet = requestIntentWriteSet({
      targets: intent.targets,
      exclusions: [{ path: "docs/configuration.md", quote: intent.targets[0]!.quote }],
    });
    expect(writeSet).toEqual([]);
  });
});

describe("request-intent model questions (R9)", () => {
  it("rejects two questions", () => {
    const proposal = edited(createProposal(), (p) => {
      p.questions = [question(), question({ question: "Should the guide cover the defaults?" })];
    });
    expect(arm(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
      rejected("request-intent-question-count", "$.questions"),
    );
  });

  it("records one valid question as an advisory, unanswered, with the grounded intent sealed", () => {
    const proposal = edited(createProposal(), (p) => {
      p.questions = [question()];
    });
    const result = interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST);
    expect(arm(result)).toEqual({
      outcome: "advisory",
      code: "request-intent-model-question",
      location: "$.questions[]",
    });
    if (result.outcome !== "advisory") throw new Error("Expected the advisory arm.");
    expect(result.at).toBe("$.questions[0]");
    expect(result.intent.question).toEqual(question());
    expect(result.intent.question?.recommendedDefault).toBe("docs/cli.md");
  });

  it("rejects a recommended default that is not one of the options", () => {
    const proposal = edited(createProposal(), (p) => {
      p.questions = [question({ recommendedDefault: "docs/home.md" })];
    });
    expect(arm(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
      rejected("request-intent-question-default", "$.questions[].recommendedDefault"),
    );
  });

  it("rejects a question with no options or a repeated option", () => {
    for (const options of [[], ["docs/cli.md", "docs/cli.md"]]) {
      const proposal = edited(createProposal(), (p) => {
        p.questions = [question({ options })];
      });
      expect(
        arm(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST)),
        JSON.stringify(options),
      ).toEqual(rejected("request-intent-question-default", "$.questions[].options"));
    }
  });

  it("treats an empty questions list as no question", () => {
    const proposal = edited(createProposal(), (p) => {
      p.questions = [];
    });
    expect(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST).outcome).toBe("admitted");
  });
});

describe("request-intent closed decode (R13) and path grammar", () => {
  it("admits the minimal proposal: an operation, no targets, and an unspecified preference", () => {
    const result = interpret(
      {
        operation: "review",
        targets: [],
        authorityPreference: { preference: "unspecified", quote: null },
      },
      UPDATE_INSTRUCTION,
      REVIEW_HOST,
    );
    const intent = admittedIntent(result);
    expect(intent).toMatchObject({
      operation: "review",
      sources: [],
      preserve: [],
      question: null,
    });
  });

  it.each([
    ["an unknown root key", (p: Proposal) => void (p.audience = "operators"), "$"],
    ["a missing required key", (p: Proposal) => void delete p.targets, "$"],
    [
      "an operation outside the enum",
      (p: Proposal) => void (p.operation = "rewrite"),
      "$.operation",
    ],
    [
      "a role outside the enum",
      (p: Proposal) => void ((p.targets as Proposal[])[0]!.role = "companion"),
      "$.targets[].role",
    ],
    [
      "an unknown target key",
      (p: Proposal) => void ((p.targets as Proposal[])[0]!.reason = "named"),
      "$.targets[]",
    ],
    [
      "a constraint kind outside the enum",
      (p: Proposal) => void (p.constraints = [{ kind: "publish", quote: "the configure command" }]),
      "$.constraints[].kind",
    ],
    [
      "a quote that is not a string",
      (p: Proposal) => void ((p.targets as Proposal[])[0]!.quote = 7),
      "$.targets[].quote",
    ],
    [
      "a stated preference without a quote",
      (p: Proposal) =>
        void (p.authorityPreference = {
          preference: "documentation",
          quote: null,
        }),
      "$.authorityPreference.quote",
    ],
    [
      "an unspecified preference with a quote",
      (p: Proposal) =>
        void (p.authorityPreference = {
          preference: "unspecified",
          quote: "the configure command",
        }),
      "$.authorityPreference.quote",
    ],
    [
      "a question that is not an object",
      (p: Proposal) => void (p.questions = ["Which page?"]),
      "$.questions[]",
    ],
  ])("rejects %s with the shape code", (_name, edit, location) => {
    expect(arm(interpret(edited(createProposal(), edit), CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
      rejected("request-intent-shape", location),
    );
  });

  it.each(["instructionSha256", "kind", "schemaVersion", "digest"])(
    "rejects the host-stamped key %s with its own code",
    (key) => {
      const proposal = edited(createProposal(), (p) => {
        p[key] = key === "schemaVersion" ? 1 : "a".repeat(64);
      });
      expect(arm(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
        rejected("request-intent-host-field", "$"),
      );
    },
  );

  it("rejects a target named twice, also when only letter case differs", () => {
    for (const second of [
      "docs/telemetryctl-configuration.md",
      "docs/Telemetryctl-Configuration.md",
    ]) {
      const proposal = edited(createProposal(), (p) => {
        const targets = p.targets as Proposal[];
        targets.push({ ...targets[0]!, path: second });
      });
      expect(arm(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST)), second).toEqual(
        rejected("request-intent-duplicate-target", "$.targets[].path"),
      );
    }
  });

  it("admits two targets whose paths differ by more than letter case", () => {
    const proposal = edited(createProposal(), (p) => {
      const targets = p.targets as Proposal[];
      targets.push({
        ...targets[0]!,
        path: "docs/telemetryctl-configuration.mdx",
      });
    });
    expect(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST).outcome).toBe("admitted");
  });

  it.each([
    "/docs/x.md",
    "docs//x.md",
    "docs/./x.md",
    "docs/x.md/",
    "../x.md",
    "docs/../x.md",
    "docs\\x.md",
    "docs/x\u0007.md",
    "docs/x\u007f.md",
    "",
    "docs/café.md",
  ])("rejects the path %j by the path grammar", (path) => {
    const proposal = edited(createProposal(), (p) => {
      (p.targets as Proposal[])[0]!.path = path;
    });
    expect(arm(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
      rejected("request-intent-path-grammar", "$.targets[].path"),
    );
  });

  it("applies the path grammar to sources and exclusions", () => {
    const source = edited(createProposal(), (p) => {
      p.sources = [{ path: "/src/cli/configure.ts", quote: "the configure command" }];
    });
    expect(arm(interpret(source, CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
      rejected("request-intent-path-grammar", "$.sources[].path"),
    );
    const exclusion = edited(createProposal(), (p) => {
      p.exclusions = [{ path: "docs/", quote: "the configure command" }];
    });
    expect(arm(interpret(exclusion, CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
      rejected("request-intent-path-grammar", "$.exclusions[].path"),
    );
  });

  it.each(["docs/café.md", "fern/pages/v2 reference.mdx", "docs/~notes/a+b.md", "nav.json"])(
    "admits the structurally safe path %j without a character whitelist",
    (path) => {
      const proposal = edited(createProposal(), (p) => {
        (p.targets as Proposal[])[0]!.path = path.normalize("NFC");
      });
      // Granted as a single file, in a repository that does not have it yet.
      const host = pilotHost("create", {
        repository: { tracked: INVENTORY },
        docsRoot: [{ kind: "file", path: path.normalize("NFC") }],
        grantedWriteScope: [{ kind: "file", path: path.normalize("NFC") }],
      });
      expect(interpret(proposal, CREATE_INSTRUCTION, host).outcome).toBe("admitted");
    },
  );

  it("carries the concrete index of the failing entry", () => {
    const proposal = edited(createProposal(), (p) => {
      const targets = p.targets as Proposal[];
      targets.push(
        { ...targets[0]!, path: "docs/second.md" },
        { ...targets[0]!, path: "docs//third.md" },
      );
    });
    const result = interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST);
    expect(result).toMatchObject({
      code: "request-intent-path-grammar",
      at: "$.targets[2].path",
    });
  });
});

describe("request-intent bounds (R12)", () => {
  function bounded(
    result: RequestIntentAdmissionResult,
    location: string,
    name: string,
    observed: number,
  ) {
    expect(arm(result)).toEqual(rejected("request-intent-size", location));
    expect(result).toMatchObject({
      bound: { name, observed, scope: "per-run" },
    });
    expect((result as { bound: { limit: number } }).bound.limit).toBe(observed - 1);
  }

  function targets(count: number): Proposal {
    return edited(createProposal(), (p) => {
      const base = (p.targets as Proposal[])[0]!;
      p.targets = Array.from({ length: count }, (_, index) => ({
        ...base,
        path: `docs/page-${index}.md`,
      }));
      p.constraints = [];
      p.sources = [];
      p.authorityPreference = { preference: "unspecified", quote: null };
    });
  }

  it("admits the target bound exactly and rejects one more", () => {
    const max = L.maxTargets.value;
    expect(interpret(targets(max), CREATE_INSTRUCTION, CREATE_HOST).outcome).toBe("admitted");
    bounded(
      interpret(targets(max + 1), CREATE_INSTRUCTION, CREATE_HOST),
      "$.targets",
      L.maxTargets.name,
      max + 1,
    );
  });

  it("counts quotes across every quote-bearing field", () => {
    const base = createProposal();
    const baseQuotes = 4;
    const withPreserved = (count: number) =>
      edited(base, (p) => {
        p.preserve = Array.from({ length: count }, () => ({
          quote: "the configure command",
        }));
      });
    const max = L.maxQuotes.value;
    expect(
      interpret(withPreserved(max - baseQuotes), CREATE_INSTRUCTION, CREATE_HOST).outcome,
    ).toBe("admitted");
    bounded(
      interpret(withPreserved(max - baseQuotes + 1), CREATE_INSTRUCTION, CREATE_HOST),
      "$",
      L.maxQuotes.name,
      max + 1,
    );
  });

  it("admits a quote at its bound and rejects one character more", () => {
    const max = L.maxQuoteChars.value;
    // Each length is its own whole word, so only the size bound can refuse it.
    const passage = (length: number) => "q".repeat(length);
    const instruction = `${CREATE_INSTRUCTION} ${passage(max)} ${passage(max + 1)}`;
    const quoting = (length: number) =>
      edited(createProposal(), (p) => {
        p.preserve = [{ quote: passage(length) }];
      });
    expect(interpret(quoting(max), instruction, CREATE_HOST).outcome).toBe("admitted");
    bounded(
      interpret(quoting(max + 1), instruction, CREATE_HOST),
      "$.preserve[].quote",
      L.maxQuoteChars.name,
      max + 1,
    );
  });

  it("bounds the question text and its consequence separately", () => {
    const max = L.maxQuestionChars.value;
    for (const field of ["question", "consequence"] as const) {
      const asking = (length: number) =>
        edited(createProposal(), (p) => {
          p.questions = [question({ [field]: "w".repeat(length) })];
        });
      expect(interpret(asking(max), CREATE_INSTRUCTION, CREATE_HOST).outcome, field).toBe(
        "advisory",
      );
      bounded(
        interpret(asking(max + 1), CREATE_INSTRUCTION, CREATE_HOST),
        `$.questions[].${field}`,
        L.maxQuestionChars.name,
        max + 1,
      );
    }
  });

  it("bounds the option count and each option's length", () => {
    const maxOptions = L.maxQuestionOptions.value;
    const offering = (count: number) =>
      edited(createProposal(), (p) => {
        const options = Array.from({ length: count }, (_, index) => `docs/option-${index}.md`);
        p.questions = [question({ options, recommendedDefault: options[0] })];
      });
    expect(interpret(offering(maxOptions), CREATE_INSTRUCTION, CREATE_HOST).outcome).toBe(
      "advisory",
    );
    bounded(
      interpret(offering(maxOptions + 1), CREATE_INSTRUCTION, CREATE_HOST),
      "$.questions[].options",
      L.maxQuestionOptions.name,
      maxOptions + 1,
    );
    const maxChars = L.maxOptionChars.value;
    const longOption = (length: number) =>
      edited(createProposal(), (p) => {
        const option = "o".repeat(length);
        p.questions = [
          question({
            options: [option, "docs/cli.md"],
            recommendedDefault: option,
          }),
        ];
      });
    expect(interpret(longOption(maxChars), CREATE_INSTRUCTION, CREATE_HOST).outcome).toBe(
      "advisory",
    );
    bounded(
      interpret(longOption(maxChars + 1), CREATE_INSTRUCTION, CREATE_HOST),
      "$.questions[].options[]",
      L.maxOptionChars.name,
      maxChars + 1,
    );
  });

  it("refuses an inventory over its bound through refuseLimit, and admits one at it", () => {
    const max = L.maxInventoryEntries.value;
    const inventory = (count: number) => [
      "docs/configuration.md",
      ...Array.from({ length: count - 1 }, (_, index) => `docs/generated/page-${index}.md`),
    ];
    const host = (count: number) => pilotHost("update", { inventory: inventory(count) });
    expect(interpret(updateProposal(), UPDATE_INSTRUCTION, host(max)).outcome).toBe("admitted");
    let thrown: unknown;
    try {
      interpret(updateProposal(), UPDATE_INSTRUCTION, host(max + 1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperationalLimitError);
    expect(thrown).toMatchObject({
      code: "request-intent-max-inventory-entries-bound",
      limitName: L.maxInventoryEntries.name,
      observed: max + 1,
    });
  });

  it("reports a shared contract bound as a size rejection at the root", () => {
    const proposal = edited(createProposal(), (p) => {
      p.preserve = [{ quote: "z".repeat(limit("runtime.contract.maxStringChars").value + 1) }];
    });
    const result = interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST);
    expect(arm(result)).toEqual(rejected("request-intent-size", "$"));
    expect(result).toMatchObject({
      bound: {
        name: "runtime.contract.maxStringChars",
        scope: limitDefinition("runtime.contract.maxStringChars").scope,
      },
    });
  });
});

describe("request-intent failure order", () => {
  const extraKey = (p: Proposal) => void (p.audience = "operators");
  const ungrounded = (p: Proposal) =>
    void ((p.sources as Proposal[])[0]!.quote = "Read every module in the repository");
  // Question edits append, so two edits compose in either build order.
  const asked = (p: Proposal) => (p.questions as unknown[] | undefined) ?? [];
  const twoQuestions = (p: Proposal) => void (p.questions = [...asked(p), question(), question()]);
  const oneQuestion = (p: Proposal) => void (p.questions = [...asked(p), question()]);
  const newOnUpdate = (p: Proposal) => {
    p.operation = "update";
  };
  const excludedTarget = (p: Proposal) =>
    void (p.exclusions = [
      { path: "docs/telemetryctl-configuration.md", quote: "the configure command" },
    ]);
  const credentialQuestion = (p: Proposal) =>
    void (p.questions = [
      ...asked(p),
      question({ consequence: `It stores ${["AKIA", "Q".repeat(16)].join("")} there.` }),
    ]);

  it.each([
    ["an extra key and an ungrounded quote", [extraKey, ungrounded], "request-intent-shape", "$"],
    [
      "an ungrounded quote and a model question",
      [ungrounded, oneQuestion],
      "request-intent-quote-ungrounded",
      "$.sources[].quote",
    ],
    [
      "an ungrounded quote and two questions",
      [ungrounded, twoQuestions],
      "request-intent-quote-ungrounded",
      "$.sources[].quote",
    ],
    [
      "an ungrounded quote and a proposed-new update",
      [ungrounded, newOnUpdate],
      "request-intent-quote-ungrounded",
      "$.sources[].quote",
    ],
    [
      "a proposed-new update and an excluded target",
      [newOnUpdate, excludedTarget],
      "request-intent-proposed-new-operation",
      "$.targets[].chosenFrom",
    ],
    [
      "an excluded target and two questions",
      [excludedTarget, twoQuestions],
      "request-intent-excluded-target",
      "$.exclusions[].path",
    ],
    [
      "two questions and a credential-shaped consequence",
      [twoQuestions, credentialQuestion],
      "request-intent-question-count",
      "$.questions",
    ],
    [
      "a proposed-new update and two questions",
      [newOnUpdate, twoQuestions],
      "request-intent-proposed-new-operation",
      "$.targets[].chosenFrom",
    ],
  ])("returns the earlier rule for %s, in either build order", (_name, edits, code, location) => {
    for (const order of [edits, [...edits].reverse()]) {
      const proposal = edited(createProposal(), (p) => order.forEach((edit) => edit(p)));
      expect(arm(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST))).toEqual(
        rejected(code, location),
      );
    }
  });

  it("returns each single failure's own code when it is alone", () => {
    expect(
      arm(interpret(edited(createProposal(), extraKey), CREATE_INSTRUCTION, CREATE_HOST)).code,
    ).toBe("request-intent-shape");
    expect(
      arm(interpret(edited(createProposal(), ungrounded), CREATE_INSTRUCTION, CREATE_HOST)).code,
    ).toBe("request-intent-quote-ungrounded");
    expect(
      arm(interpret(edited(createProposal(), oneQuestion), CREATE_INSTRUCTION, CREATE_HOST)).code,
    ).toBe("request-intent-model-question");
  });

  it("re-runs decode inside admission, so a caller cannot skip it", () => {
    const smuggled = {
      outcome: "decoded",
      proposal: { ...createProposal(), audience: "operators" },
    };
    const result = admitRequestIntent(
      smuggled as never,
      admissionInput(CREATE_INSTRUCTION, CREATE_HOST, ["docs/telemetryctl-configuration.md"]),
    );
    expect(arm(result)).toEqual(rejected("request-intent-shape", "$"));
  });
});

describe("request-intent disclosure refusal", () => {
  // One of DocsFab's own configured credentials for each test, a value that
  // does not look like a credential, so only the exact match makes it a
  // disclosure; and a credential shape that is not configured, which is
  // request text like any other (#1807).
  const credential = ["meadow", plantedCredentialValue(101, 24)].join("-");
  const shaped = ["AKIA", "M4N8B2V6C1X5Z9L3"].join("");
  configureCredentialsForEachTest(credential);

  it("refuses a grounded quote of a configured credential in the request text, without retry", () => {
    const instruction = `${CREATE_INSTRUCTION} The staging key ${credential} must stay out of the guide.`;
    const proposal = edited(createProposal(), (p) => {
      p.preserve = [{ quote: `The staging key ${credential} must stay out of the guide` }];
    });
    const result = interpret(proposal, instruction, CREATE_HOST);
    expect(result).toMatchObject({
      outcome: "refused",
      code: "request-intent-disclosure",
      location: "$",
      retry: "terminal",
    });
  });

  it("refuses a configured credential in the model's question", () => {
    const proposal = edited(createProposal(), (p) => {
      p.questions = [question({ consequence: `DocsFab stores ${credential} in the guide.` })];
    });
    expect(arm(interpret(proposal, CREATE_INSTRUCTION, CREATE_HOST))).toEqual({
      outcome: "refused",
      code: "request-intent-disclosure",
      location: "$",
    });
  });

  it("admits a grounded quote of credential-shaped request text that is not configured", () => {
    const instruction = `${CREATE_INSTRUCTION} The staging key ${shaped} must stay out of the guide.`;
    const proposal = edited(createProposal(), (p) => {
      p.preserve = [{ quote: `The staging key ${shaped} must stay out of the guide` }];
    });
    const result = interpret(proposal, instruction, CREATE_HOST);
    expect(result.outcome).toBe("admitted");
    if (result.outcome !== "admitted") return;
    expect(JSON.stringify(result.intent)).toContain(shaped);
  });

  it.each([
    "Document the API key rotation flow in docs/security/keys.md",
    "explain the --token-file flag in docs/security/keys.md",
    "update the secrets management page docs/security/keys.md",
  ])("admits the benign request %j", (instruction) => {
    const proposal = {
      operation: "update",
      targets: [
        {
          path: "docs/security/keys.md",
          role: "write",
          chosenFrom: "named",
          quote: instruction,
        },
      ],
      authorityPreference: { preference: "unspecified", quote: null },
    };
    const host = pilotHost("update", {
      repository: { tracked: [...PILOT_REPOSITORY.tracked, "docs/security/keys.md"] },
    });
    const result = interpret(proposal, instruction, host);
    expect(result.outcome).toBe("admitted");
    if (result.outcome !== "admitted") return;
    expect(
      verifyRequestIntentDigest(JSON.parse(JSON.stringify(result.intent)), instruction),
    ).toEqual(result.intent);
  });
});

describe("request-intent host inputs", () => {
  it("throws a typed host fault for a missing instruction, inventory, or limit", () => {
    const decoded = decodeRequestIntentProposal(createProposal(), {
      instruction: CREATE_INSTRUCTION,
      limits: L,
    });
    const valid = admissionInput(CREATE_INSTRUCTION, CREATE_HOST, [
      "docs/telemetryctl-configuration.md",
    ]);
    expect(admitRequestIntent(decoded as never, valid).outcome).toBe("admitted");
    for (const input of [
      { ...valid, instruction: undefined },
      { ...valid, inventory: undefined },
      { ...valid, inventory: [7] },
      { ...valid, limits: { ...L, maxQuotes: undefined } },
      {
        ...valid,
        limits: {
          ...L,
          maxQuotes: { ...L.maxQuotes, name: "requestIntent.maxTargets" },
        },
      },
    ]) {
      let thrown: unknown;
      try {
        admitRequestIntent(decoded as never, input as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(Object.keys(input))).toBeInstanceOf(RequestIntentContractError);
      expect(thrown).toMatchObject({ code: "host-input-invalid" });
    }
  });

  it("checks the inventory bound before any proposal rule, so a bad proposal still refuses", () => {
    const tooMany = Array.from(
      { length: L.maxInventoryEntries.value + 1 },
      (_, index) => `p${index}`,
    );
    let thrown: unknown;
    try {
      const proposal = edited(updateProposal(), (p) => void (p.audience = "x"));
      admitRequestIntent({ outcome: "decoded", proposal } as never, {
        ...admissionInput(UPDATE_INSTRUCTION, UPDATE_HOST, ["docs/configuration.md"]),
        inventory: tooMany,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperationalLimitError);
  });
});

describe("request-intent fault mapping scope", () => {
  const limitError = new OperationalLimitError(L.maxTargets, L.maxTargets.value + 1);
  const hostError = new RequestIntentContractError(
    "host-input-invalid",
    "a host input was malformed.",
  );

  it("maps a correctable fault to the rejected arm with the catalog retry", () => {
    const fault = new RequestIntentFault("request-intent-shape", "$.operation", "$.operation");
    expect(rejectedOutcome(fault)).toMatchObject({
      outcome: "rejected",
      code: "request-intent-shape",
      location: "$.operation",
      retry: "model-correctable",
    });
    expect(
      faultOutcome(new RequestIntentFault("request-intent-disclosure", null, null)),
    ).toMatchObject({
      outcome: "refused",
      location: "$",
      retry: "terminal",
    });
  });

  it.each([
    ["an operational limit refusal", limitError],
    ["a host contract fault", hostError],
    ["a plain error", new TypeError("x is not a function")],
    [
      "the terminal model-question code",
      new RequestIntentFault("request-intent-model-question", "$.questions[]", "$.questions[0]"),
    ],
  ])("rethrows %s unchanged from both mappings", (_name, error) => {
    expect(() => rejectedOutcome(error)).toThrow(error);
    expect(() => faultOutcome(error)).toThrow(error);
  });

  it("does not map the terminal disclosure fault to a rejection during decode", () => {
    const fault = new RequestIntentFault("request-intent-disclosure", null, null);
    expect(() => rejectedOutcome(fault)).toThrow(fault);
  });

  it("places only an unplaced shape fault at the read's location", () => {
    expect(() =>
      at("$.operation", "$.operation", () => {
        throw new RequestIntentFault("request-intent-shape", null, null);
      }),
    ).toThrow(expect.objectContaining({ location: "$.operation", at: "$.operation" }));
    const placed = new RequestIntentFault(
      "request-intent-shape",
      "$.targets[].role",
      "$.targets[0].role",
    );
    const size = new RequestIntentFault("request-intent-size", null, null);
    for (const error of [placed, size, limitError, hostError]) {
      expect(() =>
        at("$.operation", "$.operation", () => {
          throw error;
        }),
      ).toThrow(error);
    }
  });
});
