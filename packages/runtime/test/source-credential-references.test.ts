// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  assertConfinedToolResultCredentialFree,
  assertModelRequestCredentialFree,
  assertModelResponseCredentialFree,
  CredentialBoundaryError,
} from "../src/security/credential-isolation.js";
import { redactSecrets } from "../src/security/redaction.js";
import { detectCredentialRuleIds } from "../src/security/repository-scanner.js";
import { configureCredential } from "./helpers/configured-credential.js";

const source = [
  'import { authorizeLocalUserPublication } from "./publication.js";',
  "const preparationAuthorization = getPreparationAuthorization();",
  "const receipt = createReceipt({ authorization: preparationAuthorization });",
  'const authorization = authorizeLocalUserPublication({ command: "publish" });',
  "function validate(authorization: LocalUserPublicationAuthorizationV1): void {}",
  "const configuration = { api_key: configurationValues.apiKey };",
].join("\n");
// Assembled at run time; random-looking, so the detector flags it and a
// configured copy is compared.
const syntheticSecret = ["q7Rz", "Lm2X", "pW9k", "Tn4V", "bY6c", "Hd3J"].join("");
const boundaries = [
  assertConfinedToolResultCredentialFree,
  assertModelRequestCredentialFree,
  assertModelResponseCredentialFree,
];

describe("source references at credential boundaries", () => {
  it("loads the shared scanner through native TypeScript imports used by the host", () => {
    const moduleUrl = new URL("../src/security/credential-material.ts", import.meta.url).href;
    const program = [
      `import { containsAssignedCredential } from ${JSON.stringify(moduleUrl)};`,
      `if (containsAssignedCredential(${JSON.stringify(source)})) process.exit(1);`,
      `if (!containsAssignedCredential('password="${syntheticSecret}"')) process.exit(2);`,
    ].join("\n");
    expect(() =>
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", program],
        {
          timeout: 10_000,
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
  });

  it("admits complete source references without treating code as credential values", () => {
    expect(detectCredentialRuleIds(source)).toEqual([]);
    expect(redactSecrets(source, [])).toBe(source);
    for (const boundary of boundaries) {
      expect(() =>
        boundary({ messages: [{ role: "toolResult", content: [{ type: "text", text: source }] }] }),
      ).not.toThrow();
    }
  });

  it.each([
    `authorization: ${syntheticSecret},`,
    `authorization=${syntheticSecret}`,
    `api_key=${syntheticSecret}`,
    `const authorization = "${syntheticSecret}";`,
    `const authorization = \`${syntheticSecret}\`;`,
    `const authorization = "Bearer ${syntheticSecret}";`,
    `const authorization: PublicationAuthorization = "${syntheticSecret}";`,
    `const request = { authorization: "${syntheticSecret}" };`,
    `const authorization = createAuthorization({password:"${syntheticSecret}"});`,
    `const request = { authorization: authorities["${syntheticSecret}"] };`,
    `// const authorization = "${syntheticSecret}";`,
  ])(
    "flags and redacts literal or ambiguous assignments, and refuses only a configured value (%#)",
    (unsafe) => {
      expect(detectCredentialRuleIds(unsafe)).toContain("credential.assigned-secret");
      expect(redactSecrets(unsafe, [])).not.toContain(syntheticSecret);
      // A shape alone is a finding, never a boundary refusal (#1807).
      for (const boundary of boundaries) {
        expect(() => boundary({ content: [{ type: "text", text: unsafe }] })).not.toThrow();
      }
      configureCredential(syntheticSecret);
      for (const boundary of boundaries) {
        expect(() => boundary({ content: [{ type: "text", text: unsafe }] })).toThrow(
          CredentialBoundaryError,
        );
      }
    },
  );

  it("does not hide a credential beside a valid reference or inside a call", () => {
    const unsafe = `${source}\nconst options = { password: "${syntheticSecret}" };`;
    expect(detectCredentialRuleIds(unsafe)).toContain("credential.assigned-secret");
    expect(redactSecrets(unsafe, [])).not.toContain(syntheticSecret);
    const providerToken = `glpat-${"x".repeat(24)}`;
    const nested = `${source}\nconst authorization = authorizeSomething({ value: "${providerToken}" });`;
    expect(detectCredentialRuleIds(nested)).toContain("credential.gitlab-token");
    for (const boundary of boundaries) {
      expect(() => boundary({ content: [{ type: "text", text: unsafe }] })).not.toThrow();
      expect(() => boundary({ content: [{ type: "text", text: nested }] })).not.toThrow();
    }
    configureCredential(syntheticSecret);
    configureCredential(providerToken);
    for (const boundary of boundaries) {
      expect(() => boundary({ content: [{ type: "text", text: unsafe }] })).toThrow();
      expect(() => boundary({ content: [{ type: "text", text: nested }] })).toThrow();
    }
  });

  it.each([
    "const authorization = createAuthorization(1234567890123456);",
    "const authorization = createAuthorization(1234567890123456n);",
    "const authorization = createAuthorization(1000000000000000000000000000000);",
    'const authorization = createAuthorization("abcdef" + "ghijkl" + "mnopqr");',
    'const authorization = createAuthorization({ password: "abcdef" + "ghijkl" });',
    'function validate(authorization: CredentialHolder<"abcdefghijklmnopqrstuvwx">): void {}',
    'interface Options { authorization: CredentialHolder<"abcdefghijklmnopqrstuvwx"> }',
  ])("flags literal data nested in references and does not refuse that data (%#)", (unsafe) => {
    expect(detectCredentialRuleIds(unsafe)).toContain("credential.assigned-secret");
    for (const boundary of boundaries) {
      expect(() => boundary({ content: [{ type: "text", text: unsafe }] })).not.toThrow();
    }
  });

  it("refuses a configured credential in credential-named transport data, and passes a name", () => {
    for (const boundary of boundaries) {
      expect(() => boundary({ authorization: "preparationAuthorization" })).not.toThrow();
      expect(() => boundary({ headers: { "x-api-key": syntheticSecret } })).not.toThrow();
    }
    configureCredential(syntheticSecret);
    for (const boundary of boundaries) {
      expect(() => boundary({ authorization: "preparationAuthorization" })).not.toThrow();
      expect(() => boundary({ headers: { "x-api-key": syntheticSecret } })).toThrow();
      expect(() => boundary({ toJSON: () => ({ authorization: syntheticSecret }) })).toThrow();
    }
  });

  it("checks escaped credentials in the exact serialized transport values", () => {
    configureCredential(syntheticSecret);
    const first = syntheticSecret.charCodeAt(0).toString(16).padStart(4, "0");
    const escaped = JSON.parse(`{"text":"authorization: \\u${first}${syntheticSecret.slice(1)}"}`);
    for (const boundary of boundaries) {
      expect(() => boundary(escaped)).toThrow(CredentialBoundaryError);
    }
  });

  it("does not exempt invalid, incomplete, or oversized source", () => {
    for (const candidate of [
      "authorization: preparationAuthorization,",
      `${source}\nconst unfinished = {`,
      `${source}\n${" ".repeat(1024 * 1024)}`,
    ]) {
      expect(detectCredentialRuleIds(candidate)).toContain("credential.assigned-secret");
    }
  });
});
