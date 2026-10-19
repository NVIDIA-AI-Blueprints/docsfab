// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDocsFabEnvironment } from "../src/config/host-paths.js";
import {
  compactStructuredEvidenceInput,
  resolveEvidenceInputFormatPolicy,
  serializeConsumedEvidenceSummaries,
} from "../src/harness/evidence-input-format.js";

describe("compact structured evidence input", () => {
  it("resolves the experimental policy once from an explicit supported environment value", () => {
    expect(resolveEvidenceInputFormatPolicy({})).toBe("canonical-json-string-v1");
    expect(
      resolveEvidenceInputFormatPolicy({ DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT: "0" }),
    ).toBe("canonical-json-string-v1");
    expect(
      resolveEvidenceInputFormatPolicy({ DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT: "1" }),
    ).toBe("compact-json-experimental-v1");
    expect(() =>
      resolveEvidenceInputFormatPolicy({ DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT: "true" }),
    ).toThrow(
      "DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT must be unset, 0, or 1; unsupported values refuse runtime startup.",
    );
  });

  it("resolves the run policy after loading the selected DocsFab env file", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-evidence-format-env-"));
    try {
      const configRoot = join(root, "config");
      mkdirSync(configRoot, { mode: 0o700 });
      writeFileSync(join(configRoot, ".env"), "DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT=1\n");
      const environment: NodeJS.ProcessEnv = { DOCSFAB_CONFIG_ROOT: configRoot };
      loadDocsFabEnvironment(environment);
      expect(resolveEvidenceInputFormatPolicy(environment)).toBe("compact-json-experimental-v1");

      writeFileSync(
        join(configRoot, ".env"),
        "DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT=maybe\n",
      );
      const invalidEnvironment: NodeJS.ProcessEnv = { DOCSFAB_CONFIG_ROOT: configRoot };
      loadDocsFabEnvironment(invalidEnvironment);
      expect(() => resolveEvidenceInputFormatPolicy(invalidEnvironment)).toThrow(
        "DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT must be unset, 0, or 1; unsupported values refuse runtime startup.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves JSON values, order, exact strings, and optional-field presence", () => {
    const values = [
      { id: "dup", value: 'quote: " and slash \\', optional: null },
      { id: "dup", value: "line one\nline two", optional: "" },
      { id: "large", value: "900719925474099312345", present: false },
      { id: "boolean-text", value: "false" },
      { id: "unicode", value: "雪🙂" },
    ];
    const canonical = JSON.stringify(values, null, 2);
    const formatted = compactStructuredEvidenceInput(canonical);

    expect(formatted).toBeDefined();
    expect(formatted!.length).toBeLessThan(canonical.length);
    expect(JSON.parse(formatted!)).toStrictEqual(JSON.parse(canonical));
    expect(formatted).toContain('"optional":null');
    expect(formatted).toContain('"optional":""');
    expect(formatted).toContain('"value":"900719925474099312345"');
    expect(canonical).toContain("\n  {");
  });

  it("keeps default handoff bytes and stored summaries intact while compacting only the model copy", () => {
    const summaries = [
      {
        stepId: "verify",
        summary: JSON.stringify({ caveat: "quoted | value", facts: [1, 2] }, null, 2),
      },
      { stepId: "review", summary: "ordinary prose remains unchanged" },
    ];
    const canonical = summaries.map((summary) => summary.summary);
    const defaultWire = serializeConsumedEvidenceSummaries(summaries, "canonical-json-string-v1");
    const experimentalWire = serializeConsumedEvidenceSummaries(
      summaries,
      "compact-json-experimental-v1",
    );

    expect(defaultWire).toBe(JSON.stringify(summaries));
    expect(JSON.parse(experimentalWire)[0].summary).toBe(
      '{"caveat":"quoted | value","facts":[1,2]}',
    );
    expect(JSON.parse(experimentalWire)[1].summary).toBe("ordinary prose remains unchanged");
    expect(experimentalWire.length).toBeLessThan(defaultWire.length);
    expect(summaries.map((summary) => summary.summary)).toStrictEqual(canonical);
  });

  it("preserves number lexemes, nested arrays, quotes, delimiters, and multiline strings", () => {
    const canonical =
      '{\n "items": [[1, 1.00, 1e+9], ["a,b", "x|y", "line\\nnext"]],\n "n": 9007199254740993\n}';
    const formatted = compactStructuredEvidenceInput(canonical);

    expect(formatted).toBe(
      '{"items":[[1,1.00,1e+9],["a,b","x|y","line\\nnext"]],"n":9007199254740993}',
    );
  });

  it.each(["plain prose { not json", "null", "42", '"text"', '{"truncated":'])(
    "leaves unsupported or non-structured input unchanged by declining it: %s",
    (source) => {
      expect(compactStructuredEvidenceInput(source)).toBeUndefined();
    },
  );
});
