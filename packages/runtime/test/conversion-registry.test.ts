// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AMBIGUITY_UNIT_ANSWERS,
  CONSTRUCT_RULE_REGISTRY,
  CONVERSION_NODE_KINDS,
  CONVERSION_REFUSAL_NEXT_ACTIONS,
  ConversionContractError,
  NORMALIZED_DIRECTIVE_NODE_KINDS,
  buildConstructRuleIndex,
  constructKeyOf,
  constructRuleRegistryDigest,
  resolveNodeRule,
  type ConstructKey,
  type ConstructRule,
  type ConstructRuleRegistry,
  type ConversionNode,
  type ConversionRuleOverride,
} from "../src/conversion/index.js";

const span = { startLine: 1, endLine: 1 };

function directive(name: string, id = `directive-${name}`): ConversionNode {
  return { id, kind: "directive", name, options: [], body: { kind: "none" }, span };
}

function role(name: string, id = `role-${name}`): ConversionNode {
  return { id, kind: "role", name, content: "text", span };
}

/** Only the fields constructKeyOf reads; resolution never inspects the rest. */
function shallowNode(kind: string): ConversionNode {
  if (kind === "directive") return directive("note");
  if (kind === "role") return role("doc");
  if (kind === "include") {
    return {
      id: "include",
      kind: "include",
      mode: "literal",
      target: { kind: "local", path: "example.py" },
      other: [],
      span,
    };
  }
  return { id: kind, kind, span } as unknown as ConversionNode;
}

function rulesFor(construct: ConstructKey): ConstructRule[] {
  return CONSTRUCT_RULE_REGISTRY.rules.filter((rule) => rule.construct === construct);
}

function withRules(rules: readonly ConstructRule[]): ConstructRuleRegistry {
  return { version: CONSTRUCT_RULE_REGISTRY.version, rules };
}

function refusalOf(action: () => unknown): ConversionContractError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionContractError);
    return error as ConversionContractError;
  }
  throw new Error("expected a ConversionContractError");
}

describe("construct rule registry exhaustiveness", () => {
  it("gives every IR node kind exactly one registry rule", () => {
    for (const kind of CONVERSION_NODE_KINDS) {
      const keys: ConstructKey[] =
        kind === "directive"
          ? ["directive:*"]
          : kind === "role"
            ? ["role:*"]
            : kind === "include"
              ? ["include:markup", "include:literal", "include:remote"]
              : [constructKeyOf(shallowNode(kind))];
      for (const key of keys) {
        expect(rulesFor(key), `${kind} -> ${key}`).toHaveLength(1);
      }
    }
  });

  it("keeps every registry key unique and reachable from an IR node kind", () => {
    const keys = CONSTRUCT_RULE_REGISTRY.rules.map((rule) => rule.construct);
    expect(new Set(keys).size).toBe(keys.length);
    const typedKeys = new Set(
      CONVERSION_NODE_KINDS.filter(
        (kind) => kind !== "directive" && kind !== "role" && kind !== "include",
      ).map((kind) => `node:${kind}`),
    );
    for (const key of keys) {
      const family = key.split(":", 1)[0];
      if (family === "node") expect(typedKeys.has(key), key).toBe(true);
      else expect(["include", "directive", "role"], key).toContain(family);
    }
    expect(() => buildConstructRuleIndex()).not.toThrow();
  });

  it("resolves every IR node kind to exactly one disposition through the index", () => {
    const index = buildConstructRuleIndex();
    const dispositions = new Set(["convert", "judge", "drop-with-notice", "refuse"]);
    for (const kind of CONVERSION_NODE_KINDS) {
      const { rule } = resolveNodeRule(index, shallowNode(kind));
      expect(dispositions.has(rule.disposition.disposition), kind).toBe(true);
    }
  });

  it("refuses a node kind the IR does not define with a named code", () => {
    const refusal = refusalOf(() =>
      constructKeyOf({ id: "mystery-1", kind: "admonitionish", span } as unknown as ConversionNode),
    );
    expect(refusal.code).toBe("conversion-unknown-node-kind");
    expect(refusal.nodeId).toBe("mystery-1");
    expect(refusal.nextAction).toBe(
      CONVERSION_REFUSAL_NEXT_ACTIONS["conversion-unknown-node-kind"],
    );
    expect(() =>
      resolveNodeRule(buildConstructRuleIndex(), {
        id: "mystery-2",
        kind: "admonitionish",
        span,
      } as unknown as ConversionNode),
    ).toThrow(expect.objectContaining({ code: "conversion-unknown-node-kind" }));
  });

  it("refuses a registry that gives one construct a second disposition", () => {
    const duplicate: ConstructRule = {
      construct: "directive:note",
      rule: { disposition: "drop-with-notice", reason: { code: "decorative", text: "x" } },
    };
    const refusal = refusalOf(() =>
      buildConstructRuleIndex(withRules([...CONSTRUCT_RULE_REGISTRY.rules, duplicate])),
    );
    expect(refusal.code).toBe("conversion-construct-ambiguous");
    expect(refusal.construct).toBe("directive:note");
  });

  it("refuses a registry that leaves an IR node kind without a rule", () => {
    for (const missing of ["node:thematicBreak", "include:remote", "directive:*", "role:*"]) {
      const refusal = refusalOf(() =>
        buildConstructRuleIndex(
          withRules(CONSTRUCT_RULE_REGISTRY.rules.filter((rule) => rule.construct !== missing)),
        ),
      );
      expect(refusal.code, missing).toBe("conversion-construct-unregistered");
      expect(refusal.construct).toBe(missing);
    }
  });

  it("refuses registry rules that cannot apply as written", () => {
    const invalid: ConstructRule[] = [
      {
        construct: "node:directive" as ConstructKey,
        rule: { disposition: "convert", convert: { target: "unwrap" } },
      },
      {
        construct: "node:admonitionish" as ConstructKey,
        rule: { disposition: "convert", convert: { target: "unwrap" } },
      },
      {
        construct: "include:snippet" as ConstructKey,
        rule: { disposition: "convert", convert: { target: "unwrap" } },
      },
      {
        construct: "directive:literalinclude",
        rule: { disposition: "convert", convert: { target: "unwrap" } },
      },
      { construct: "node:paragraph", rule: { disposition: "judge", unitKind: "custom-construct" } },
      {
        construct: "directive:Note",
        rule: { disposition: "convert", convert: { target: "unwrap" } },
      },
      { construct: "directive:only", rule: { disposition: "judge", unitKind: "remote-include" } },
    ];
    for (const rule of invalid) {
      const rules = CONSTRUCT_RULE_REGISTRY.rules.filter(
        (entry) => entry.construct !== rule.construct,
      );
      const refusal = refusalOf(() => buildConstructRuleIndex(withRules([...rules, rule])));
      expect(refusal.code, rule.construct).toBe("conversion-registry-invalid");
    }
  });

  it("refuses a directive node that readers must normalize into a typed node", () => {
    const index = buildConstructRuleIndex();
    for (const name of Object.keys(NORMALIZED_DIRECTIVE_NODE_KINDS)) {
      expect(rulesFor(`directive:${name}`), name).toHaveLength(0);
      const refusal = refusalOf(() => resolveNodeRule(index, directive(name)));
      expect(refusal.code, name).toBe("conversion-directive-not-normalized");
    }
  });

  it("refuses a generic raw directive whose formats include html", () => {
    const index = buildConstructRuleIndex();
    for (const argument of ["html", "HTML", "latex html"]) {
      const refusal = refusalOf(() =>
        resolveNodeRule(index, {
          id: "raw-1",
          kind: "directive",
          name: "raw",
          argument,
          options: [],
          body: { kind: "text", value: "<div>important</div>" },
          span,
        }),
      );
      expect(refusal.code, argument).toBe("conversion-directive-not-normalized");
    }
    const latex = resolveNodeRule(index, {
      id: "raw-2",
      kind: "directive",
      name: "raw",
      argument: "latex",
      options: [],
      body: { kind: "text", value: "\\newpage" },
      span,
    });
    expect(latex.rule.disposition.disposition).toBe("drop-with-notice");
  });

  it("refuses a directive or role name that is not lower case", () => {
    const index = buildConstructRuleIndex();
    for (const node of [directive("Note"), role("Ref"), directive("nemo-Gallery")]) {
      const refusal = refusalOf(() => resolveNodeRule(index, node));
      expect(refusal.code, node.id).toBe("conversion-construct-name-not-normalized");
      expect(refusal.nodeId).toBe(node.id);
    }
  });

  it("decides an unregistered directive or role name by its fallback rule", () => {
    const index = buildConstructRuleIndex();
    const custom = resolveNodeRule(index, directive("nemo-gallery"));
    expect(custom.construct).toBe("directive:nemo-gallery");
    expect(custom.rule.key).toBe("directive:*");
    expect(custom.rule.disposition).toEqual({ disposition: "judge", unitKind: "custom-construct" });
    const customRole = resolveNodeRule(index, role("nemo-version"));
    expect(customRole.rule.key).toBe("role:*");
    expect(customRole.rule.disposition).toEqual({
      disposition: "judge",
      unitKind: "custom-construct",
    });
  });

  it("is frozen and has a stable digest", () => {
    expect(Object.isFrozen(CONSTRUCT_RULE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(CONSTRUCT_RULE_REGISTRY.rules)).toBe(true);
    expect(Object.isFrozen(CONSTRUCT_RULE_REGISTRY.rules[0]?.rule)).toBe(true);
    expect(constructRuleRegistryDigest()).toMatch(/^[0-9a-f]{64}$/u);
    expect(constructRuleRegistryDigest()).toBe(
      constructRuleRegistryDigest(withRules([...CONSTRUCT_RULE_REGISTRY.rules])),
    );
    expect(constructRuleRegistryDigest(withRules(CONSTRUCT_RULE_REGISTRY.rules.slice(1)))).not.toBe(
      constructRuleRegistryDigest(),
    );
  });
});

describe("construct rule registry seed", () => {
  const ruleOf = (construct: ConstructKey) => rulesFor(construct)[0]?.rule;

  it("maps the legacy admonition table to callout tones", () => {
    const tones: Record<string, string> = {
      note: "note",
      seealso: "note",
      tip: "tip",
      hint: "tip",
      important: "info",
      versionadded: "info",
      versionchanged: "info",
      warning: "warning",
      caution: "warning",
      danger: "warning",
      attention: "warning",
      error: "warning",
      deprecated: "warning",
    };
    for (const [name, tone] of Object.entries(tones)) {
      expect(ruleOf(`directive:${name}`), name).toEqual({
        disposition: "convert",
        convert: { target: "callout", tone, title: "none" },
      });
    }
  });

  it("maps the legacy layout directives and the MyST-to-Fern overlay components", () => {
    expect(ruleOf("directive:tab-set")).toEqual({
      disposition: "convert",
      convert: { target: "tabs" },
    });
    expect(ruleOf("directive:tab-item")).toMatchObject({ convert: { target: "tab" } });
    expect(ruleOf("directive:grid")).toMatchObject({ convert: { target: "card-group" } });
    expect(ruleOf("directive:grid-item-card")).toMatchObject({ convert: { target: "card" } });
    expect(ruleOf("directive:dropdown")).toMatchObject({ convert: { target: "collapsible" } });
    expect(ruleOf("directive:admonition")).toMatchObject({ convert: { target: "collapsible" } });
    expect(ruleOf("node:figure")).toMatchObject({ convert: { target: "framed-image" } });
    expect(ruleOf("directive:list-table")).toMatchObject({
      convert: { target: "table", from: "list-table" },
    });
    expect(ruleOf("directive:mermaid")).toMatchObject({
      convert: { target: "diagram", language: "mermaid" },
    });
    expect(ruleOf("role:doc")).toMatchObject({
      convert: { target: "cross-reference", resolveIn: "route-table" },
    });
    expect(ruleOf("role:ref")).toMatchObject({
      convert: { target: "cross-reference", resolveIn: "label-table" },
    });
    expect(ruleOf("role:py:class")).toMatchObject({ convert: { target: "inline-code" } });
    expect(ruleOf("role:kbd")).toMatchObject({ convert: { target: "keyboard" } });
    expect(ruleOf("role:bdg-primary")).toMatchObject({
      convert: { target: "badge", variant: "primary" },
    });
  });

  it("drops the legacy removals with a reason and refuses API reference generation", () => {
    for (const construct of [
      "directive:toctree",
      "directive:contents",
      "directive:todo",
      "role:octicon",
    ] as const) {
      const rule = ruleOf(construct);
      expect(rule?.disposition, construct).toBe("drop-with-notice");
      if (rule?.disposition === "drop-with-notice") {
        expect(rule.reason.text.length, construct).toBeGreaterThan(0);
      }
    }
    expect(ruleOf("directive:automodule")).toMatchObject({
      disposition: "refuse",
      reason: "api-reference-generation",
    });
    expect(ruleOf("directive:only")).toEqual({
      disposition: "judge",
      unitKind: "conditional-content",
    });
  });

  it("records the intentional improvements over the legacy converter", () => {
    expect(ruleOf("node:codeBlock")).toMatchObject({
      convert: {
        target: "code-block",
        keep: expect.arrayContaining(["caption", "emphasize-lines"]),
      },
    });
    expect(ruleOf("include:literal")).toMatchObject({
      convert: { target: "code-include", honor: expect.arrayContaining(["lines", "pyobject"]) },
    });
    expect(ruleOf("directive:csv-table")).toMatchObject({
      convert: { target: "table", from: "csv", quoting: "rfc4180", file: "local-only" },
    });
    expect(ruleOf("include:remote")).toEqual({ disposition: "judge", unitKind: "remote-include" });
    const improved = CONSTRUCT_RULE_REGISTRY.rules
      .filter((rule) => rule.improvement !== undefined)
      .map((rule) => rule.construct)
      .sort();
    expect(improved).toEqual([
      "directive:autoclass",
      "directive:autodoc2-docstring",
      "directive:autofunction",
      "directive:automodule",
      "directive:autosummary",
      "directive:csv-table",
      "directive:only",
      "include:literal",
      "include:markup",
      "include:remote",
      "node:codeBlock",
      "node:target",
      "role:std:term",
    ]);
  });

  it("admits ask-operator for every ambiguity unit kind", () => {
    for (const [kind, answers] of Object.entries(AMBIGUITY_UNIT_ANSWERS)) {
      expect(answers, kind).toContain("ask-operator");
    }
  });
});

describe("plan-level rule overrides", () => {
  const operator = { source: "operator" } as const;

  it("replaces the registry rule for one construct and records its provenance", () => {
    const index = buildConstructRuleIndex(undefined, [
      {
        kind: "construct",
        construct: "role:nemo-version",
        override: { rule: "keep-literal", text: "26.10" },
        provenance: { source: "judged-answer", unitId: "unit:node:role-1" },
      },
      {
        kind: "construct",
        construct: "directive:nvidia-note",
        override: { rule: "map-to-construct", construct: "directive:note" },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "directive:todo",
        override: { rule: "map-to-construct", construct: "directive:note" },
        provenance: operator,
      },
    ]);
    const version = resolveNodeRule(index, role("nemo-version"));
    expect(version.rule).toEqual({
      key: "role:nemo-version",
      source: "plan-rule",
      provenance: { source: "judged-answer", unitId: "unit:node:role-1" },
      disposition: { disposition: "convert", convert: { target: "literal-text", text: "26.10" } },
    });
    expect(resolveNodeRule(index, directive("nvidia-note")).rule.disposition).toEqual(
      rulesFor("directive:note")[0]?.rule,
    );
    expect(resolveNodeRule(index, directive("todo")).rule.source).toBe("plan-rule");
  });

  it("records judged-answer provenance as the drop reason code", () => {
    const reason = "Generated by the build.";
    const index = buildConstructRuleIndex(undefined, [
      {
        kind: "construct",
        construct: "directive:nemo-gallery",
        override: { rule: "drop", reason },
        provenance: { source: "judged-answer", unitId: "unit:node:gallery-1" },
      },
      {
        kind: "construct",
        construct: "role:nemo-icon",
        override: { rule: "drop", reason },
        provenance: operator,
      },
    ]);
    expect(resolveNodeRule(index, directive("nemo-gallery")).rule.disposition).toEqual({
      disposition: "drop-with-notice",
      reason: { code: "judged-answer", text: reason },
    });
    expect(resolveNodeRule(index, role("nemo-icon")).rule.disposition).toEqual({
      disposition: "drop-with-notice",
      reason: { code: "operator-rule", text: reason },
    });
  });

  it("maps to a registered construct with parameters for the same intent", () => {
    const index = buildConstructRuleIndex(undefined, [
      {
        kind: "construct",
        construct: "directive:nvidia-subheading",
        override: {
          rule: "map-to-construct",
          construct: "directive:rubric",
          parameters: { target: "heading", depth: 2 },
        },
        provenance: { source: "judged-answer", unitId: "unit:node:sub-1" },
      },
      {
        kind: "construct",
        construct: "role:nvidia-beta",
        override: {
          rule: "map-to-construct",
          construct: "role:bdg-primary",
          parameters: { target: "badge", variant: "warning" },
        },
        provenance: operator,
      },
    ]);
    expect(resolveNodeRule(index, directive("nvidia-subheading")).rule.disposition).toEqual({
      disposition: "convert",
      convert: { target: "heading", depth: 2 },
    });
    expect(resolveNodeRule(index, directive("rubric")).rule.disposition).toEqual(
      rulesFor("directive:rubric")[0]?.rule,
    );
    expect(resolveNodeRule(index, role("nvidia-beta")).rule.disposition).toEqual({
      disposition: "convert",
      convert: { target: "badge", variant: "warning" },
    });
  });

  it("refuses two plan-level rules for one construct", () => {
    const rule: ConversionRuleOverride = {
      kind: "construct",
      construct: "role:nemo-version",
      override: { rule: "keep-literal", text: "26.10" },
      provenance: operator,
    };
    expect(() => buildConstructRuleIndex(undefined, [rule, rule])).toThrow(
      expect.objectContaining({ code: "conversion-construct-ambiguous" }),
    );
    const substitution: ConversionRuleOverride = {
      kind: "substitution",
      name: "version",
      literal: "26.10",
      provenance: operator,
    };
    expect(() => buildConstructRuleIndex(undefined, [substitution, substitution])).toThrow(
      expect.objectContaining({ code: "conversion-construct-ambiguous" }),
    );
  });

  it("refuses plan-level rules that cannot bind", () => {
    const invalid: ConversionRuleOverride[] = [
      {
        kind: "construct",
        construct: "directive:*",
        override: { rule: "drop", reason: "everything" },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "directive:literalinclude",
        override: { rule: "drop", reason: "normalized" },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "directive:nvidia-note",
        override: { rule: "map-to-construct", construct: "directive:only" },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "directive:nvidia-note",
        override: { rule: "map-to-construct", construct: "role:guilabel" },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "directive:nvidia-note",
        override: { rule: "map-to-construct", construct: "directive:not-registered" },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "role:nemo-version",
        override: { rule: "keep-literal", text: "" },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "role:nemo-version",
        override: { rule: "drop", reason: "  " },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "role:nemo-version",
        override: { rule: "keep-literal", text: " \n " },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "role:Nemo-version",
        override: { rule: "keep-literal", text: "26.10" },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "directive:nvidia-subheading",
        override: {
          rule: "map-to-construct",
          construct: "directive:rubric",
          parameters: { target: "callout", tone: "note", title: "none" },
        },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "directive:nvidia-table",
        override: {
          rule: "map-to-construct",
          construct: "directive:list-table",
          parameters: { target: "table", from: "node" },
        },
        provenance: operator,
      },
      {
        kind: "construct",
        construct: "role:nemo-version",
        override: {
          rule: "map-to-construct",
          construct: "role:kbd",
          parameters: { target: "literal-text", text: "26.10" },
        },
        provenance: operator,
      },
      { kind: "substitution", name: "release", literal: "", provenance: operator },
      { kind: "substitution", name: "release", literal: "   ", provenance: operator },
    ];
    for (const override of invalid) {
      const refusal = refusalOf(() => buildConstructRuleIndex(undefined, [override]));
      expect(refusal.code, JSON.stringify(override)).toBe("conversion-override-invalid");
    }
  });
});
