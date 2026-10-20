// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PUBLIC_COMMAND_ALIASES,
  PUBLIC_COMMAND_REGISTRY,
  findPublicCommand,
  resolvePublicCommandName,
} from "../src/cli/command-registry.js";
import { generalHelp } from "../src/cli/usage.js";

const ROUTER_SOURCE = readFileSync(new URL("../src/cli/router.ts", import.meta.url), "utf8");
const DEFAULT_RUN_PATTERN = /if \(command !== "run" && !PUBLIC_COMMAND_REGISTRY/u;
const HELP_ROUTER_PATTERN = /resolveHelpRequest\(\[command, \.\.\.args\]\)/u;

function routerEqualityCommandLiterals(source: string): string[] {
  return [...source.matchAll(/\bcommand === "([^"]+)"/gu)].map((match) => match[1]!);
}

describe("public command registry vs router", () => {
  it("keeps every router-dispatched name in the registry and every registry name dispatched", () => {
    const literals = routerEqualityCommandLiterals(ROUTER_SOURCE);
    const registryNames = PUBLIC_COMMAND_REGISTRY.map((command) => command.name);
    expect(new Set(registryNames).size).toBe(registryNames.length);

    const dispatchedNames = new Set<string>();
    for (const literal of literals) {
      dispatchedNames.add(resolvePublicCommandName(literal));
    }

    const defaultRun = DEFAULT_RUN_PATTERN.test(ROUTER_SOURCE);
    const equalityRun = literals.includes("run");
    expect(defaultRun || equalityRun).toBe(true);
    if (defaultRun) dispatchedNames.add("run");

    // `help` and its aliases dispatch through the registry-driven help router.
    expect(HELP_ROUTER_PATTERN.test(ROUTER_SOURCE)).toBe(true);
    expect(literals).not.toContain("help");
    dispatchedNames.add("help");
    expect(registryNames).toContain("help");
    expect(registryNames).not.toContain("--help");
    expect(registryNames).not.toContain("-h");
    expect(PUBLIC_COMMAND_ALIASES["--help"]).toBe("help");
    expect(PUBLIC_COMMAND_ALIASES["-h"]).toBe("help");
    expect(findPublicCommand("--help")?.name).toBe("help");
    expect(findPublicCommand("-h")?.name).toBe("help");
    expect(findPublicCommand("toString")).toBeUndefined();
    if (defaultRun) {
      expect(literals).not.toContain("run");
    }

    expect([...dispatchedNames].sort()).toEqual([...registryNames].sort());
  });

  it("derives generalHelp from the public command registry", () => {
    const help = generalHelp();
    expect(help).toContain("Commands");
    for (const command of PUBLIC_COMMAND_REGISTRY) {
      expect(help.split("\n")).toContain(`  ${command.name}: ${command.description}`);
      expect(typeof command.readOnly).toBe("boolean");
    }
  });
});
