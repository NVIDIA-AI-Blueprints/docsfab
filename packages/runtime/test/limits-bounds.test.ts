// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  enforceLimit,
  formatLimitExceeded,
  formatLimitObservation,
  refuseLimit,
  type ResolvedLimit,
} from "../src/config/limits.js";
import { LIMIT_DEFINITIONS } from "../src/config/limits.generated.js";

function resolvedFrom(definition: (typeof LIMIT_DEFINITIONS)[number]): ResolvedLimit {
  return {
    name: definition.name,
    value: definition.value,
    source: "config/limits.yaml",
    unit: definition.unit,
    warnAt: definition.warnAt,
    refusal: definition.refusal,
    remediation: definition.remediation,
  };
}

describe("operational limit bounds", () => {
  it.each(LIMIT_DEFINITIONS)("$name holds at the limit", (definition) => {
    expect(() => enforceLimit(resolvedFrom(definition), definition.value)).not.toThrow();
  });

  it.each(LIMIT_DEFINITIONS)("$name refuses at the limit plus one", (definition) => {
    const limitRow = resolvedFrom(definition);
    const observed = definition.value + 1;
    const message = `${limitRow.refusal}: ${observed} exceeds ${limitRow.name} = ${limitRow.value} ${limitRow.unit}. ${limitRow.remediation} Follow the named remediation.`;
    expect(() => enforceLimit(limitRow, observed)).toThrow(message);
    expect(() => refuseLimit(limitRow, observed)).toThrow(message);
  });

  it("closes every catalogued refusal with the remediation sentence exactly once", () => {
    // The formatter appends it, so a catalog remediation that ends with it too
    // printed it twice.
    const repeated = LIMIT_DEFINITIONS.filter((definition) => {
      const row = resolvedFrom(definition);
      return [formatLimitObservation(row, definition.value + 1), formatLimitExceeded(row)].some(
        (line) => line.split("Follow the named remediation.").length - 1 !== 1,
      );
    }).map((definition) => definition.name);
    expect(repeated).toEqual([]);
  });
});
