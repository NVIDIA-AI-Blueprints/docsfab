// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  containsRepositorySourceCredentialMaterial,
  isCompleteRepositoryCode,
  RepositorySourceParserUnavailableError,
} from "../src/security/credential-material-core.js";

const CORE_PATH = fileURLToPath(
  new URL("../src/security/credential-material-core.js", import.meta.url),
);
// The dependency-free sibling the core imports; dist and a checkout carry both.
const SHAPES_PATH = fileURLToPath(
  new URL("../src/security/text-credential-shapes.js", import.meta.url),
);
// Fixtures are assembled at run time so this file carries no credential-shaped text.
const credentialKey = ["tok", "en"].join("");
const referencedSource = `export const ${credentialKey} = process.env.DOCSFAB_VALUE;\n`;
const literalSource = `export const ${credentialKey} = "${"a".repeat(16)}";\n`;
const hardShape = ["glpat", "-", "b".repeat(24)].join("");
const incompleteSource = "export const = ;\n";

type Probe =
  | { readonly kind: "returned"; readonly value: unknown }
  | {
      readonly kind: "threw";
      readonly name: string;
      readonly code: unknown;
      readonly causeCode: unknown;
      readonly message: string;
    };
type Probes = Record<
  "completeReferenced" | "screenReferenced" | "screenLiteral" | "screenHardShape",
  Probe
>;

/**
 * Run the detached copy under plain Node, exactly as the host-only recovery
 * release loads it: no vitest transforms, no runtime node_modules above it.
 */
function probeDetached(copy: string): Probes {
  const script = `
    const core = await import(process.argv[1]);
    const inputs = JSON.parse(process.argv[2]);
    const probe = (run) => {
      try {
        return { kind: "returned", value: run() };
      } catch (error) {
        return {
          kind: "threw",
          name: error?.name,
          code: error?.code,
          causeCode: error?.cause?.code,
          message: String(error?.message),
        };
      }
    };
    process.stdout.write(JSON.stringify({
      completeReferenced: probe(() => core.isCompleteRepositoryCode(inputs.referencedSource)),
      screenReferenced: probe(() => core.containsRepositorySourceCredentialMaterial(inputs.referencedSource)),
      screenLiteral: probe(() => core.containsRepositorySourceCredentialMaterial(inputs.literalSource)),
      screenHardShape: probe(() => core.containsRepositorySourceCredentialMaterial(inputs.hardShape)),
    }));
  `;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      copy,
      JSON.stringify({ referencedSource, literalSource, hardShape }),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(output) as Probes;
}

function expectRefusal(probe: Probe): void {
  expect(probe.kind).toBe("threw");
  if (probe.kind !== "threw") return;
  expect(probe.name).toBe("RepositorySourceParserUnavailableError");
  expect(probe.code).toBe("repository-source-parser-unavailable");
  expect(probe.causeCode).toBe("MODULE_NOT_FOUND");
  expect(probe.message).toContain("@babel/parser is not installed for packages/runtime");
}

describe("repository source screen parser availability", () => {
  it("screens complete source with the installed parser: references admitted, literal initializers and hard shapes refused", () => {
    expect(isCompleteRepositoryCode(referencedSource)).toBe(true);
    expect(isCompleteRepositoryCode(incompleteSource)).toBe(false);
    expect(containsRepositorySourceCredentialMaterial(referencedSource)).toBe(false);
    expect(containsRepositorySourceCredentialMaterial(literalSource)).toBe(true);
    expect(containsRepositorySourceCredentialMaterial(hardShape)).toBe(true);
    expect(new RepositorySourceParserUnavailableError().code).toBe(
      "repository-source-parser-unavailable",
    );
  });

  it.each([
    ["short object literal", 'export const value = { token: "' + "q".repeat(8) + '" };'],
    ["call literal", 'export const value = { token: getValue("' + "q".repeat(8) + '") };'],
    [
      "member call literal",
      'export const value = { token: getValue("' + "q".repeat(9) + '").value };',
    ],
    [
      "typed initializer",
      'export const token: CredentialHandle = getValue("' + "q".repeat(8) + '");',
    ],
    [
      "primitive annotation",
      'export interface X { token: CredentialHandle }\nconst token: string = "' +
        "q".repeat(8) +
        '";',
    ],
    ["class annotation", 'class C { private token: string = "' + "q".repeat(8) + '"; }'],
    ["parameter default", 'function f(token: string = "' + "q".repeat(8) + '") {}'],
    ["multiline call", 'const token = f(\n"' + "q".repeat(8) + '"\n);'],
    ["long call literal", 'export const value = { token: getValue("' + "a".repeat(32) + '") };'],
    [
      "literal after interface",
      'export interface X { token: CredentialHandle }\nconst password = "' + "b".repeat(32) + '";',
    ],
    ["JSON literal", JSON.stringify({ token: "c".repeat(32) })],
    ["comment literal", "/* token: " + "d".repeat(32) + " */\nexport const enabled = true;"],
  ])("refuses existing %s credential initializer evidence", (_name, source) => {
    expect(containsRepositorySourceCredentialMaterial(source)).toBe(true);
  });

  it("requires complete source context for a typed reference even when source contains a literal NUL", () => {
    // The exact complete/partial source pair from the retained semantic fixture.
    const complete =
      "export interface Configuration { token: CredentialHandle }\n" +
      "export const requiresMention = false;\n" +
      'export const terminator = "\0";\n';
    const fragment = complete.slice(complete.indexOf("token:"));
    expect(isCompleteRepositoryCode(complete)).toBe(true);
    expect(containsRepositorySourceCredentialMaterial(complete)).toBe(false);
    expect(isCompleteRepositoryCode(fragment)).toBe(false);
    expect(containsRepositorySourceCredentialMaterial(fragment)).toBe(true);
  });

  it("loads without the parser package, then refuses to admit source rather than calling it clean or complete", () => {
    const directory = mkdtempSync(join(tmpdir(), "docsfab-parser-absence-"));
    try {
      const copy = join(directory, "credential-material-core.js");
      copyFileSync(CORE_PATH, copy);
      copyFileSync(SHAPES_PATH, join(directory, "text-credential-shapes.js"));
      // Precondition: nothing above the detached copy resolves the parser package.
      expect(() => createRequire(copy)("@babel/parser")).toThrow(/Cannot find module/);

      const probes = probeDetached(copy);
      // Module evaluation itself succeeded (the probe ran); admission is refused.
      expectRefusal(probes.completeReferenced);
      expectRefusal(probes.screenReferenced);
      expectRefusal(probes.screenLiteral);
      // A hard credential shape is refused before the parser is consulted, so an
      // absent parser cannot hide it.
      expect(probes.screenHardShape).toEqual({ kind: "returned", value: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
