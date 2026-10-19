// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  compressPaths,
  constraintDimensionIds,
  describeIdentifierPattern,
  qualityEvaluationRequiredKeyProjection,
  schemaFieldRuleLines,
  schemaRequiredKeyLines,
} from "../src/evaluation-report/schema-field-rules.js";
import { HOST_WRITTEN_EVALUATION_FIELDS } from "../src/evaluation-report/evaluation-target.js";
import { OUTPUT_RECORD_CONTRACTS } from "../src/contracts/model-output.generated.js";

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../quality/${path}`, import.meta.url), "utf8"));
const EVALUATION_SCHEMA = read("schemas/documentation-quality-evaluation.schema.json");
const PROFILE = read("profiles/docsfab-documentation-quality/profile.json");

describe("identifier patterns in plain words", () => {
  it("describes the evaluation schema's identifier pattern", () => {
    expect(describeIdentifierPattern("^[a-z0-9][a-z0-9-]*$")).toBe(
      "it starts with a lowercase letter or digit and then uses only lowercase letters, digits, and hyphens, with no uppercase letters, underscores, or spaces",
    );
  });

  it("names no excluded class the pattern allows, and picks the article", () => {
    expect(describeIdentifierPattern("^[A-Za-z0-9][A-Za-z0-9._:-]*$")).toBe(
      "it starts with an uppercase letter, lowercase letter, or digit and then uses only uppercase letters, lowercase letters, digits, dots, underscores, colons, and hyphens, with no spaces",
    );
  });

  it.each([
    // Adjacent shapes the words would misstate: a bounded repeat, one class,
    // an escape, a negated class, an unknown member, and no anchors.
    "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    "^[a-z]+$",
    "^[a-z0-9][a-z0-9\\-]*$",
    "^[^a-z][a-z]*$",
    "^[a-z0-9][a-z0-9/]*$",
    // A hyphen between two members is a range, not a hyphen.
    "^[a-z][.-:]*$",
    "[a-z0-9][a-z0-9-]*",
  ])("leaves %s as written", (pattern) => {
    expect(describeIdentifierPattern(pattern)).toBeUndefined();
  });
});

describe("evaluation schema field rules", () => {
  const lines = schemaFieldRuleLines(EVALUATION_SCHEMA, "evaluation");

  it("states the pattern and enum rules hosted models broke, from the schema", () => {
    expect(lines).toContain(
      "- $defs.dimensionResult.dimension_id matches ^[a-z0-9][a-z0-9-]*$: it starts with a lowercase letter or digit and then uses only lowercase letters, digits, and hyphens, with no uppercase letters, underscores, or spaces.",
    );
    expect(lines).toContain(
      "- metric_id matches ^[a-z0-9][a-z0-9-]*$: it starts with a lowercase letter or digit and then uses only lowercase letters, digits, and hyphens, with no uppercase letters, underscores, or spaces.",
    );
    expect(lines).toContain(
      '- applicability is exactly one of "required", "optional", "not-applicable".',
    );
    expect(lines).toContain(
      '- Each intended_outcome_classes entry is exactly one of "orientation", "conceptual-reasoning", "task-completion", "reference-lookup", "problem-recovery", "change-awareness".',
    );
    expect(lines).toContain("- evaluated_at is an RFC 3339 date-time string.");
  });

  it("lists each field name once when its rule is the same everywhere", () => {
    const names = lines.map((line) => /^- (?:Each )?(\S+)/u.exec(line)![1]);
    expect(new Set(names).size).toBe(names.length);
    // Reached through five constraints and three layers, stated once.
    expect(lines.filter((line) => line.startsWith("- applicability "))).toHaveLength(1);
  });

  it("qualifies a field name by path when its rule differs between places", () => {
    const schema = {
      type: "object",
      properties: {
        layer: {
          type: "object",
          properties: { decision: { enum: ["pass", "fail"] } },
        },
        overall: { $ref: "#/$defs/overall" },
      },
      $defs: {
        overall: {
          type: "object",
          properties: { decision: { enum: ["pass"] } },
        },
      },
    };
    expect(schemaFieldRuleLines(schema, "root")).toEqual([
      '- root.layer.decision is exactly one of "pass", "fail".',
      '- $defs.overall.decision is exactly one of "pass".',
    ]);
  });

  it("names where a rule applies when the same name is free text elsewhere", () => {
    // The schema's measure.method is free text; only the family evidence
    // method is closed, so an unqualified "method" rule would be false.
    expect(lines).toContain(
      '- evaluation.target.documentation_family_evidence[].method is exactly one of "path-convention", "information-architecture-record", "manual-reviewed".',
    );
    expect(lines.some((line) => line.startsWith("- method "))).toBe(false);
    // A finding's dimension_id is free text; the dimension result's is not.
    expect(lines.some((line) => line.startsWith("- dimension_id "))).toBe(false);
    const schema = {
      type: "object",
      properties: {
        closed: { type: "object", properties: { kind: { enum: ["a"] } } },
        open: { type: "object", properties: { kind: { type: "string" } } },
      },
    };
    expect(schemaFieldRuleLines(schema, "root")).toEqual([
      '- root.closed.kind is exactly one of "a".',
    ]);
  });

  it("states nothing for a schema without field rules, or for a non-object", () => {
    expect(
      schemaFieldRuleLines({ type: "object", properties: { a: { type: "string" } } }, "x"),
    ).toEqual([]);
    expect(schemaFieldRuleLines(["not", "a", "schema"], "x")).toEqual([]);
  });
});

describe("constraint dimension ids", () => {
  it("maps every schema constraint key to the profile's hyphenated id", () => {
    expect(constraintDimensionIds(EVALUATION_SCHEMA, PROFILE)).toEqual([
      ["accessibility_and_inclusion", "accessibility-and-inclusion"],
      ["global_and_localization_readiness", "global-and-localization-readiness"],
      ["safety_security_privacy", "safety-security-privacy"],
      ["legal_policy_support", "legal-policy-support"],
      ["human_agent_representation_parity", "human-agent-representation-parity"],
    ]);
  });

  it("leaves out a key with no profile id, or with two that spell it", () => {
    const schema = {
      properties: {
        constraints: { properties: { a_b: {}, c_d: {}, e_f: {} } },
      },
    };
    const profile = {
      constraints: { required: ["a-b", "c-d", "c_d"], conditional: ["x-y"] },
    };
    // c_d matches both "c-d" and "c_d"; e_f matches none.
    expect(constraintDimensionIds(schema, profile)).toEqual([["a_b", "a-b"]]);
    expect(constraintDimensionIds(schema, { constraints: "none" })).toEqual([]);
  });
});

describe("evaluation schema required keys", () => {
  const lines = schemaRequiredKeyLines(EVALUATION_SCHEMA, "evaluation");
  const defs = (EVALUATION_SCHEMA as { $defs: Record<string, { required?: string[] }> }).$defs;

  it("states each layer's exact keys where the layers are written", () => {
    expect(lines).toContain(
      "- evaluation.layers.{trustworthy_information,transferable_understanding,effective_experience} each must contain exactly these keys: decision, confidence, dimensions, hard_gate_failures, limitations.",
    );
  });

  /**
   * Every unconditional required list in the schema with the path it applies
   * at, walked independently of the code under test: through `$ref`,
   * properties, items, and `allOf` branches without an `if`.
   */
  function requiredListsByPath(schema: unknown): Array<{ path: string; required: string[] }> {
    type Node = Record<string, unknown>;
    const root = schema as Node;
    const isObject = (value: unknown): value is Node =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const deref = (node: Node): Node =>
      typeof node.$ref === "string"
        ? deref((root.$defs as Record<string, Node>)[node.$ref.split("/").at(-1)!]!)
        : node;
    const found: Array<{ path: string; required: string[] }> = [];
    const walk = (raw: Node, path: string, seen: Set<Node>): void => {
      const node = deref(raw);
      if (seen.has(node)) return;
      if (Array.isArray(node.required)) found.push({ path, required: node.required as string[] });
      const next = new Set(seen).add(node);
      for (const [name, child] of Object.entries((node.properties as Record<string, Node>) ?? {})) {
        if (isObject(child)) walk(child, `${path}.${name}`, next);
      }
      if (isObject(node.items)) walk(node.items, `${path}[]`, next);
      for (const branch of (node.allOf as Node[] | undefined) ?? []) {
        if (isObject(branch) && !isObject(branch.if)) walk(branch, path, next);
      }
    };
    walk(root, "evaluation", new Set());
    return found;
  }

  /** Expand `a.{x,y}.b` into `a.x.b` and `a.y.b`. */
  function expandPaths(subject: string): string[] {
    return subject.split(" and ").flatMap((pattern) => {
      const match = /^(.*?)\{([^{}]*)\}(.*)$/u.exec(pattern);
      return match
        ? match[2]!.split(",").flatMap((part) => expandPaths(`${match[1]}${part}${match[3]}`))
        : [pattern];
    });
  }

  it("states every required list the schema declares, at its path, word for word, so the two cannot drift", () => {
    const lists = requiredListsByPath(EVALUATION_SCHEMA);
    // The root, every shared definition, and every inline object, such as
    // evaluation.profile, evaluation.target, and evaluation.conditions[].
    expect(lists.map((list) => list.path)).toEqual(
      expect.arrayContaining([
        "evaluation",
        "evaluation.profile",
        "evaluation.evaluator",
        "evaluation.target",
        "evaluation.target.documentation_family_evidence[]",
        "evaluation.target.product_reference_model",
        "evaluation.layers",
        "evaluation.constraints",
        "evaluation.outcomes",
        "evaluation.conditions[]",
        "evaluation.layers.transferable_understanding",
      ]),
    );
    const stated = lines.map((line) => {
      const match = /^- (.+?) (?:each )?must contain (?:exactly )?these keys: ([^;.]+)[;.]/u.exec(
        line,
      );
      expect(match, line).not.toBeNull();
      return { paths: expandPaths(match![1]!), keys: match![2]! };
    });
    for (const { path, required } of lists) {
      const at = stated.filter((line) => line.paths.includes(path));
      expect(at, path).toHaveLength(1);
      expect(at[0]!.keys, path).toBe(required.join(", "));
    }
  });

  it("names the optional keys only of an object that admits no other key", () => {
    const schema = {
      type: "object",
      properties: {
        closed: {
          type: "object",
          additionalProperties: false,
          required: ["a"],
          properties: { a: {}, b: {} },
        },
        open: { type: "object", required: ["c"], properties: { c: {}, d: {} } },
      },
    };
    expect(schemaRequiredKeyLines(schema, "root")).toEqual([
      "- root.closed must contain these keys: a; it may also contain b; no other key.",
      "- root.open must contain these keys: c.",
    ]);
  });

  it("states a conditional branch's required list only under its condition", () => {
    // Parsed, as the locked schema is, so the conditional keeps its own keys.
    const schema: unknown = JSON.parse(
      '{"type":"object","required":["kind"],"properties":{"kind":{},"extra":{}},' +
        '"allOf":[{"if":{"properties":{"kind":{"const":"x"}}},"then":{"required":["extra"]}}]}',
    );
    expect(schemaRequiredKeyLines(schema, "root")).toEqual([
      '- root must contain these keys: kind; when kind is "x", also extra.',
    ]);
    // Adjacent: a condition on anything but one property's value is not stated.
    const multi: unknown = JSON.parse(
      '{"type":"object","required":["kind"],"properties":{"kind":{},"mode":{},"extra":{}},' +
        '"allOf":[{"if":{"properties":{"kind":{"const":"x"},"mode":{"const":"y"}}},"then":{"required":["extra"]}}]}',
    );
    expect(schemaRequiredKeyLines(multi, "root")).toEqual([
      "- root must contain these keys: kind.",
    ]);
  });

  it("merges paths that differ in one segment and keeps every other path", () => {
    expect(compressPaths(["a.x.c", "a.y.c", "b.c"])).toEqual(["a.{x,y}.c", "b.c"]);
    expect(compressPaths(["a.x.c", "a.y.d"])).toEqual(["a.x.c", "a.y.d"]);
  });
});

describe("required keys around conditionals and host-written fields", () => {
  it("states the keys a single-value condition adds, not as optional", () => {
    expect(schemaRequiredKeyLines(EVALUATION_SCHEMA, "evaluation")).toContain(
      '- evaluation.findings[] must contain these keys: id, severity, dimension_id, description, evidence, owner, acceptance_condition, status; when status is "verified", also resolution, verification_evidence; when status is "dismissed-with-rationale", also dismissal_rationale; no other key.',
    );
  });

  it("states the entry count a single-value condition sets on an array", () => {
    // Hosted Super hit min-items where a conditional pass needs a condition.
    const root = schemaRequiredKeyLines(EVALUATION_SCHEMA, "evaluation").find((line) =>
      line.startsWith("- evaluation must contain"),
    );
    expect(root).toContain(
      '; when overall_decision is "conditional-pass", conditions has at least 1 entry;',
    );
  });

  it("leaves a host-written field out of the keys the model writes, and names it as the host's", () => {
    const lines = schemaRequiredKeyLines(EVALUATION_SCHEMA, "evaluation", [
      "evaluation.target.paths",
    ]);
    const target = lines.find((line) => line.startsWith("- evaluation.target must"))!;
    expect(target).toMatch(/; leave out paths, which the host writes\.$/u);
    expect(target.slice(0, target.indexOf(";"))).not.toMatch(/\bpaths\b/u);
    // Adjacent: the same name elsewhere is still the model's to write.
    const evidence = lines.find((line) =>
      line.startsWith("- evaluation.target.documentation_family_evidence[] must"),
    )!;
    expect(evidence.split(";")[0]).toMatch(/\bpaths\b/u);
    expect(evidence).not.toContain("which the host writes");
  });

  it("does not descend into a host-written object when its schema is shared", () => {
    const schema = {
      $defs: {
        profile: {
          type: "object",
          required: ["id", "version"],
          properties: { id: {}, version: {} },
        },
      },
      type: "object",
      required: ["profile", "authorProfile"],
      properties: {
        profile: { $ref: "#/$defs/profile" },
        authorProfile: { $ref: "#/$defs/profile" },
      },
    };
    const lines = schemaRequiredKeyLines(schema, "root", ["root.profile"]);

    expect(lines).toContain(
      "- root must contain these keys: authorProfile; leave out profile, which the host writes.",
    );
    expect(lines).not.toContain("- root.profile must contain these keys: id, version.");
    expect(lines).toContain("- root.authorProfile must contain these keys: id, version.");
  });

  it("keeps shared references separate when one path derives a field", () => {
    const schema = {
      $defs: {
        judgment: {
          type: "object",
          required: ["confidence", "applicability"],
          additionalProperties: false,
          properties: { confidence: {}, applicability: {} },
        },
      },
      type: "object",
      required: ["derived", "authored"],
      properties: {
        derived: { $ref: "#/$defs/judgment" },
        authored: { $ref: "#/$defs/judgment" },
      },
    };
    const lines = schemaRequiredKeyLines(schema, "root", [], {
      hostDerived: ["root.derived.confidence"],
    });

    expect(lines).toContain(
      "- root.derived must contain exactly these keys: applicability; leave out confidence, which the host derives.",
    );
    expect(lines).toContain(
      "- root.authored must contain exactly these keys: confidence, applicability.",
    );
  });

  it("keeps conditional model obligations when the discriminator is host-written", () => {
    const schema: unknown = JSON.parse(
      '{"type":"object","required":["kind"],"additionalProperties":false,' +
        '"properties":{"kind":{},"detail":{}},"allOf":[{"if":{"properties":' +
        '{"kind":{"const":"host-selected"}},"required":["kind"]},"then":{"required":' +
        '["detail"]}}]}',
    );
    const lines = schemaRequiredKeyLines(schema, "root", ["root.kind"]);

    expect(lines).toContain(
      '- root must contain these keys: ; when kind is "host-selected", also detail; no other key; leave out kind, which the host writes.',
    );
  });

  it("projects the actual evaluation schema onto model-authored inputs", () => {
    const projection = qualityEvaluationRequiredKeyProjection(HOST_WRITTEN_EVALUATION_FIELDS);
    const deriveFields = OUTPUT_RECORD_CONTRACTS["quality-evaluation"].derive.map(
      (entry) => entry.field,
    );
    expect(deriveFields).toEqual([
      "$.evaluation.layers.*.dimensions[].applicability",
      "$.evaluation.constraints.{required}.applicability",
      "$.evaluation.layers.*.confidence",
      "$.evaluation.confidence",
      "$.evaluation.layers.*.hard_gate_failures",
      "$.evaluation.hard_gate_failures",
      "$.evaluation.layers.*.decision",
      "$.evaluation.overall_decision",
      "$.evaluation.conditions",
      "$.qualityScore.total",
    ]);
    expect(projection.hostDerived).toEqual([
      "evaluation.layers.*.confidence",
      "evaluation.confidence",
      "evaluation.overall_decision",
      "evaluation.conditions",
    ]);
    expect(projection.conditionallyAuthored).toEqual(["evaluation.layers.*.decision"]);
    expect(projection.hostWritten).toContain("evaluation.outcomes");
    expect(projection.hostWritten).not.toContain("evaluation.layers.*.dimensions[].dimension_id");

    const lines = schemaRequiredKeyLines(EVALUATION_SCHEMA, "evaluation", projection.hostWritten, {
      hostDerived: projection.hostDerived,
      conditionallyAuthored: projection.conditionallyAuthored,
    });
    const root = lines.find((line) => line.startsWith("- evaluation must contain"))!;
    expect(root.split(";")[0]).toContain(
      "these keys: target, layers, constraints, hard_gate_failures, findings, limitations",
    );
    expect(root).toContain(
      "leave out evaluation_id, evaluation_version, evaluated_at, model_version, profile, evaluator, outcomes, which the host writes",
    );
    expect(root).toContain(
      "leave out overall_decision, conditions, confidence, which the host derives",
    );
    expect(root).not.toContain('when overall_decision is "conditional-pass"');
    expect(lines.some((line) => line.startsWith("- evaluation.profile must"))).toBe(false);
    expect(lines.some((line) => line.startsWith("- evaluation.evaluator must"))).toBe(false);
    expect(lines.some((line) => line.startsWith("- evaluation.outcomes"))).toBe(false);

    const layer = lines.find((line) => line.startsWith("- evaluation.layers.{"))!;
    expect(layer.split(";")[0]).toContain("dimensions, hard_gate_failures, limitations");
    expect(layer.split(";")[0]).not.toContain("confidence");
    expect(layer).toContain("it may also contain decision");
    expect(layer).toContain("leave out confidence, which the host derives");

    const dimensions = lines.find((line) => line.includes(".dimensions[] each must contain"))!;
    expect(dimensions).toContain("dimension_id, applicability, assessment, confidence");

    const constraints = lines.find((line) => line.startsWith("- evaluation.constraints.{"))!;
    expect(constraints).toContain("applicability, assessment, confidence");
    expect(constraints).toContain("leave out dimension_id, which the host writes");

    const findings = lines.find((line) => line.startsWith("- evaluation.findings[]"))!;
    expect(findings).toContain('when status is "verified"');
    expect(findings).toContain('when status is "dismissed-with-rationale"');
    expect(findings).toContain("leave out id, owner, status, which the host writes");
  });

  it("states no field rule that only a conditional branch sets", () => {
    const schema: unknown = JSON.parse(
      '{"type":"object","properties":{"kind":{"enum":["a","b"]},"extra":{"type":"string"}},' +
        '"allOf":[{"if":{"properties":{"kind":{"const":"a"}}},"then":{"properties":{"mode":{"enum":["x"]}}}}]}',
    );
    expect(schemaFieldRuleLines(schema, "root")).toEqual(['- kind is exactly one of "a", "b".']);
  });
});
