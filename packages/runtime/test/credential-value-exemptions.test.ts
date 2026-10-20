// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  detectCredentialRuleIds,
  detectCredentialRuleIdsInValue,
  SECURITY_RULE_IDS,
} from "../src/security/repository-scanner.js";
import {
  containsStrictAssignedCredential,
  isPlaceholderWordGrammar,
  PLACEHOLDER_WORD_GRAMMAR,
  redactCredentialMaterial,
} from "../src/security/credential-material.js";
import { detectStrictCredentialRuleIds } from "../src/security/repository-scanner.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

// Random-looking stand-ins are built at run time, so no source line carries a
// credential-shaped literal for repository secret scanners to match.
const KEY_LIKE = plantedCredentialValue(1, 24);
const BEARER = plantedCredentialValue(2, 24);
const QUOTED = plantedCredentialValue(3, 20);
const assigned = [SECURITY_RULE_IDS.assignedSecret, SECURITY_RULE_IDS.metadataAssignedSecret];

function expectNotAssigned(text: string): void {
  const ruleIds = detectCredentialRuleIds(text);
  for (const ruleId of assigned) expect(ruleIds, text).not.toContain(ruleId);
}

function expectAssigned(text: string): void {
  expect(
    detectCredentialRuleIds(text).some((ruleId) => assigned.includes(ruleId as never)),
    text,
  ).toBe(true);
}

/** A placeholder spelled with words counts unless the owner enables the word grammar. */
function expectWordGrammar(text: string): void {
  const flagged = detectCredentialRuleIds(text).some((ruleId) =>
    assigned.includes(ruleId as never),
  );
  expect(flagged, text).toBe(!PLACEHOLDER_WORD_GRAMMAR);
}

describe("credential values: the six #1807 false-positive patterns", () => {
  it("does not read a syntactic placeholder in a sample Secret manifest as a credential", () => {
    for (const value of ["<your-password-here>", "YOUR_DB_PASSWORD", "xxxxxxxxxxxxxxxx"]) {
      expectNotAssigned(`apiVersion: v1\nkind: Secret\nstringData:\n  password: ${value}\n`);
    }
  });

  // Owner decision pending: these depend on PLACEHOLDER_WORD_GRAMMAR. While it is
  // off, they count, and the first pass withholds the manifest and continues.
  it("reads a word-spelled placeholder password per the word-grammar setting", () => {
    for (const value of [
      "mysecretpassword",
      "changeme1234",
      // base64 of the placeholder password123, as a `data:` value
      Buffer.from("password123").toString("base64"),
    ]) {
      expectWordGrammar(`apiVersion: v1\nkind: Secret\nstringData:\n  password: ${value}\n`);
      expect(isPlaceholderWordGrammar(value), value).toBe(true);
    }
  });

  it("does not read an unbraced environment passthrough as a credential", () => {
    expectNotAssigned("docker run -e NGC_API_KEY=$NGC_API_KEY nvcr.io/nim/model:latest\n");
    expectNotAssigned("API_KEY=$(NGC_API_KEY)\n");
  });

  it("does not read a Go struct field holding a volume-source literal as a credential", () => {
    expectNotAssigned("\t\t\tSecret: &corev1.SecretVolumeSource{\n\t\t\t\tSecretName: name,\n");
    expectNotAssigned("\t\t\tSecret: &corev1.SecretVolumeSource{SecretName: name},\n");
    expectNotAssigned("\t\t\tSecret: corev1.Secret{},\n");
  });

  it("does not read a CRD key whose value is a nested mapping as an assignment", () => {
    expectNotAssigned(
      "                  secret:\n                    description: SecretRef is name of the authentication secret\n",
    );
  });

  it("does not read a Go variable named secret assigned a struct literal as a credential", () => {
    expectNotAssigned("\tvar secret = corev1.Secret{\n");
    expectNotAssigned("\tsecret = &corev1.Secret{\n");
    expectNotAssigned("secret:=&corev1.Secret{\n");
  });

  it("does not read a copy of another struct's password field as a credential", () => {
    expectNotAssigned("\tcfg.Password = opts.Password\n");
    expectNotAssigned("\t\tPassword: spec.Auth.Password,\n");
    expectNotAssigned("\tdsn.Password = settings.DB_PASSWORD\n");
  });
});

describe("credential values: field shapes from the 2026-10-05 benchmark lanes", () => {
  it.each([
    ["an environment-variable name in a CLI example", "holmes ask --api-key=NVIDIA_API_KEY\n"],
    ["a credential-store template", 'password: "{{env.DB_PASSWORD}}"\n'],
    ["an upper-case example key", "api_key: YOUR_API_KEY_HERE\n"],
    [
      "a scheme-qualified variable name",
      "Authorization: Bearer openshell:resolve:env:GITHUB_TOKEN\n",
    ],
    ["an angle-bracket bearer placeholder", "`Authorization: Bearer <opaque-key>` header\n"],
    [
      "an angle-bracket placeholder with a number",
      '"app_password": "<16-character-app-password>"\n',
    ],
    ["a backtick-wrapped default", "- Password: `minioadmin`\n"],
    ["a Python type annotation", "    api_key: Optional[SecretStr] = None\n"],
    // Megatron-Bridge training/config.py: a dataclass field with no value.
    ["a declaration with a None default", "    comet_api_key: Optional[str] = None\n"],
    ["a declaration with no default", "    comet_api_key: Optional[str]\n"],
    [
      "a declaration defaulting to an environment lookup",
      '    comet_api_key: Optional[str] = os.environ.get("COMET_API_KEY")\n',
    ],
    ["a type name", "    api_key: SerializableSecretStr = Field(\n"],
    [
      "a qualified environment lookup",
      'ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")\n',
    ],
    ["a Rust environment lookup", '        api_key: std::env::var("OPENAI_API_KEY").ok(),\n'],
    ["a field copy closed by a brace", '{"email": self.email, "password": self.password}\n'],
    [
      "a field copy closed by a parenthesis",
      "Client(domain=self.config.domain, api_key=self.config.api_key)\n",
    ],
    ["an AWS ARN segment", '"Resource": "arn:aws:secretsmanager:*:*:secret:agent-db-*"\n'],
    ["a file path", 'authorization = "/var/run/secrets/otel/token"\n'],
    ["an upper-case variable name", "authorization = PHOENIX_COLLECTOR\n"],
    ["a masked example", "api_key: xxxxxxxxxxxxxxxx\n"],
  ])("does not read %s as a credential", (_name, text) => {
    expectNotAssigned(text);
  });

  it("pins the word grammar itself, whichever way the switch is set", () => {
    for (const value of [
      "mysecretpassword",
      "changeme1234",
      "your-anthropic-api-key",
      "encrypted_token_data",
      Buffer.from("password123").toString("base64"),
    ]) {
      expect(isPlaceholderWordGrammar(value), value).toBe(true);
    }
    // A pass phrase names nothing, and random text splits into no words.
    for (const value of ["correct-horse-battery-staple", "CorrectHorseBatteryStaple", KEY_LIKE]) {
      expect(isPlaceholderWordGrammar(value), value).toBe(false);
    }
  });

  // Owner decision pending: these depend on PLACEHOLDER_WORD_GRAMMAR.
  it.each([
    ["an export with an example key", 'export ANTHROPIC_API_KEY="your-anthropic-api-key"\n'],
    ["three plain words", '      "token": "encrypted_token_data",\n'],
  ])("reads %s per the word-grammar setting", (_name, text) => {
    expectWordGrammar(text);
  });
});

describe("credential values: a literal beside a reference or code shape still counts", () => {
  // #1807 review, MAJOR-1: the exemption covers the reference, not the literal next to it.
  it.each([
    ["a Python lookup's default", `DB_PASSWORD = os.environ.get("DB_PASSWORD", "${QUOTED}")\n`],
    ["a JavaScript fallback with ||", `const apiKey = process.env.API_KEY || "${QUOTED}";\n`],
    ["a JavaScript fallback with ??", `  apiKey: process.env.API_KEY ?? "${QUOTED}",\n`],
    ["a SecretStr default", `    api_key: Optional[SecretStr] = SecretStr("${QUOTED}")\n`],
    ["a Field default", `    api_key: SerializableSecretStr = Field("${QUOTED}")\n`],
    [
      "a multi-line Field default",
      `    api_key: SerializableSecretStr = Field(\n        default="${QUOTED}",\n    )\n`,
    ],
    ["a Go composite literal's field", `\tSecret: &Secret{Value: "${QUOTED}"},\n`],
    [
      "an upper-case name in a URL query",
      "https://git.example.com/x.git?private_token=LOCK_TOKEN_NAME\n",
    ],
  ])("detects %s beside a reference or code shape", (_name, text) => {
    expectAssigned(text);
  });

  it.each([
    ["a Python lookup without a default", 'DB_PASSWORD = os.environ.get("DB_PASSWORD")\n'],
    [
      "a lookup whose default is a name",
      'api_key = os.environ.get("API_KEY", "FALLBACK_API_KEY")\n',
    ],
    [
      "a composite literal without a literal",
      "\tSecret: &corev1.SecretVolumeSource{\n\t\tSecretName: name,\n\t},\n",
    ],
    [
      "an apostrophe after a lookup",
      'api_key = os.environ.get("API_KEY")  # don\'t hard-code it\n',
    ],
  ])("leaves %s clean", (_name, text) => {
    expectNotAssigned(text);
  });
});

describe("credential values: positive controls stay detected", () => {
  it.each([
    ["a realistic key-like value", `api_key = "${KEY_LIKE}"\n`],
    ["a bearer token value", `Authorization: Bearer ${BEARER}\n`],
    ["a quoted long random string", `password: "${QUOTED}"\n`],
    ["an unquoted environment value", `NGC_API_KEY=${KEY_LIKE}\n`],
    ["a vendor prefix with a random tail", `NOTION_API_KEY=secret_${KEY_LIKE}\n`],
    ["a dotted literal token", `api_key: SG.${QUOTED}.${BEARER}\n`],
    ["a cookie carrying a session token", `Cookie: session_token=${KEY_LIKE}\n`],
    ["a value on the next line of a YAML key", `password:\n  ${QUOTED}\n`],
    // The Kubernetes Secret example value: base64 of a random-looking string.
    ["base64 of a random value", `password: ${Buffer.from("1f2d1e2e67df").toString("base64")}\n`],
    ["a random value in angle brackets", `password: <${QUOTED}>\n`],
    ["a random value behind a marker word", `password: my-${plantedCredentialValue(4, 14)}\n`],
    ["upper-case segments with digits", `api_key: ${["X7K2", "M9P3", "Q8R5", "T4V6"].join("_")}\n`],
    ["a random value with a closing parenthesis", `password: ${QUOTED})\n`],
    ["a random dotted path ending in a random name", `password: cfg.${QUOTED}\n`],
    ["a random value that starts with a slash", `api_key: /${QUOTED}\n`],
    ["a pass phrase in PascalCase", "password: CorrectHorseBatteryStaple\n"],
    ["two plain words", "password: correct_horse\n"],
    // Three plain words are exempt only when one names a value, as in
    // encrypted_token_data, so a generated pass phrase still counts.
    ["a pass phrase of plain words", "password: correct-horse-battery-staple\n"],
    ["a pass phrase joined by underscores", "api_key = correct_horse_battery_staple\n"],
    // The Megatron-Bridge pair: the same declaration with a real-looking value.
    ["a literal after a type annotation", `    comet_api_key: Optional[str] = "${QUOTED}"\n`],
    ["a literal without an annotation", `comet_api_key = "${KEY_LIKE}"\n`],
  ])("detects %s", (_name, text) => {
    expectAssigned(text);
  });

  // #1807 review, MAJOR-2: a decoded field is a literal, so it keeps the strict
  // rule, and redaction keeps it too: over-redaction costs nothing.
  it("keeps credential-named structured fields on the strict rule", () => {
    expect(detectCredentialRuleIdsInValue({ password: QUOTED })).toContain(
      SECURITY_RULE_IDS.assignedSecret,
    );
    for (const value of ["{{env.DB_PASSWORD}}", "HOST_SECRET_NAME", "mysecretpassword"]) {
      expect(detectCredentialRuleIdsInValue({ token: value }), value).toContain(
        SECURITY_RULE_IDS.assignedSecret,
      );
    }
  });

  it("judges a literal beside a reference by the strict rule when redacting", () => {
    // The detector exempts an angle-bracket placeholder; the strict rule counts it.
    const text = 'comet_api_key: Optional[str] = "<comet-api-key-value>"';
    expectNotAssigned(text);
    expect(redactCredentialMaterial(text)).not.toContain("comet-api-key-value");
  });

  it("counts a quoted literal beside a reference that holds #, ;, or ,", () => {
    for (const separator of ["#", ";", ","]) {
      const literal = `${QUOTED.slice(0, 8)}${separator}${QUOTED.slice(8)}`;
      const text = `DB_PASSWORD = os.environ.get("DB_PASSWORD", "${literal}")\n`;
      expectAssigned(text);
      expect(redactCredentialMaterial(text), separator).not.toContain(QUOTED.slice(8));
    }
  });

  it("redacts with the strict rule, references and placeholders included", () => {
    expect(redactCredentialMaterial(`password: "${QUOTED}"`)).not.toContain(QUOTED);
    expect(redactCredentialMaterial(`comet_api_key: Optional[str] = "${QUOTED}"`)).not.toContain(
      QUOTED,
    );
    for (const text of [
      "docker run -e NGC_API_KEY=$NGC_API_KEY image",
      "API_KEY=supersecretvalue99",
      `api_key=${"x".repeat(24)}`,
    ]) {
      expect(redactCredentialMaterial(text), text).toContain("[REDACTED_CREDENTIAL]");
      expect(
        detectStrictCredentialRuleIds(text).some((ruleId) => assigned.includes(ruleId as never)),
        text,
      ).toBe(true);
      expect(containsStrictAssignedCredential(text), text).toBe(true);
    }
  });
});
