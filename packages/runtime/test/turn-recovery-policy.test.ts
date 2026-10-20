// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { limit, limitDefinition } from "../src/config/limits.js";
import { EXECUTION_LEASE_DEFAULTS } from "../src/execution/lease-contracts.js";
import { resolveTurnRecoveryPolicy } from "../src/model/turn-recovery-policy.js";

const isolated = { environment: {}, hostFile: null, projectFile: null };

describe("turn recovery policy", () => {
  it("derives the greatest recovery allowance from every admitted provider-turn envelope", () => {
    const maximum = EXECUTION_LEASE_DEFAULTS.maxProviderTurns;
    expect(limitDefinition("governance.maxCompactions").max).toBe(maximum);
    expect(limitDefinition("governance.maxConsecutiveLengthStoppedToolTurns").max).toBe(maximum);
    for (let turns = 1; turns <= maximum; turns += 1) {
      expect(resolveTurnRecoveryPolicy(turns, isolated)).toEqual({
        maxCompactions: turns,
        maxConsecutiveLengthStoppedToolTurns: turns,
        minRecentToolTurns: 1,
      });
    }
  });

  it("permits lower recovery capacity while preserving a separately raised recent-group minimum", () => {
    expect(
      resolveTurnRecoveryPolicy(8, {
        ...isolated,
        environment: {
          DOCSFAB_GOVERNANCE_MAX_COMPACTIONS: "0",
          DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS: "3",
          DOCSFAB_GOVERNANCE_MIN_RECENT_TOOL_TURNS: "10",
        },
      }),
    ).toEqual({
      maxCompactions: 0,
      maxConsecutiveLengthStoppedToolTurns: 3,
      minRecentToolTurns: 10,
    });
  });

  it.each([
    ["governance.maxCompactions", "DOCSFAB_GOVERNANCE_MAX_COMPACTIONS"],
    [
      "governance.maxConsecutiveLengthStoppedToolTurns",
      "DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS",
    ],
    ["governance.minRecentToolTurns", "DOCSFAB_GOVERNANCE_MIN_RECENT_TOOL_TURNS"],
  ])("refuses boundary plus one for %s", (name, environmentName) => {
    const maximum = limitDefinition(name).max;
    expect(() =>
      resolveTurnRecoveryPolicy(maximum, {
        ...isolated,
        environment: { [environmentName]: String(maximum + 1) },
      }),
    ).toThrow();
  });
});

/**
 * These normal-mode budget entries declare no environment override, so their
 * boundary is only reachable through a host limits file keyed by the entry
 * name. These rows exercise the catalog range, so a `max` that cannot express
 * the value it bounds fails here.
 */
describe("normal-mode budget catalog entries", () => {
  const hostFile = (assignments: string): string => {
    const directory = mkdtempSync(join(tmpdir(), "docsfab-normal-mode-limits-"));
    const path = join(directory, "service.env");
    writeFileSync(path, assignments, "utf8");
    return path;
  };

  it.each([["execution.normalModeTokenBudgetTurns"], ["execution.normalModeMaxElapsedMs"]])(
    "admits %s at its declared maximum and refuses one past it",
    (name) => {
      const definition = limitDefinition(name);
      // The shipped default is the maximum for both: a normal-mode attempt is
      // admitted for the whole budget, never a fraction of it.
      expect(definition.value).toBe(definition.max);
      expect(definition.override).toBeNull();

      expect(
        limit(name, {
          environment: {},
          projectFile: null,
          hostFile: hostFile(`${name}=${definition.max}\n`),
        }).value,
      ).toBe(definition.max);

      expect(() =>
        limit(name, {
          environment: {},
          projectFile: null,
          hostFile: hostFile(`${name}=${definition.max + 1}\n`),
        }),
      ).toThrow(`${name} must be an integer`);
    },
  );
});
