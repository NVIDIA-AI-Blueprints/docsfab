// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectCredentialRuleIds,
  detectCredentialRuleIdsInValue,
  LocalRepositorySecurityScanner,
  SECURITY_RULE_IDS,
} from "../src/security/repository-scanner.js";
import { redactSecrets } from "../src/security/redaction.js";
import {
  containsAssignedCredential,
  redactCredentialMaterial,
} from "../src/security/credential-material.js";

async function repositoryFixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "docsfab-scan-"));
  await mkdir(join(path, "docs"));
  return path;
}

describe("LocalRepositorySecurityScanner", () => {
  it("detects and redacts standalone metadata tokens, JSON headers, and prefixed env keys", () => {
    const metadataToken = ["ihub", "_api_", "m".repeat(24)].join("");
    const inferenceToken = ["nv", "api-", "n".repeat(24)].join("");
    const metadataBoundaryToken = ["ihub", "_api_", "u".repeat(19), "-"].join("");
    const inferenceBoundaryToken = ["nv", "api-", "v".repeat(19), "-"].join("");
    const headerName = ["x", "-api", "-key"].join("");
    const envName = ["INFERENCE", "HUB", "METADATA", "API", "KEY"].join("_");
    const headerValue = "h".repeat(24);
    const envValue = "e".repeat(24);

    expect(detectCredentialRuleIds(metadataToken)).toContain(SECURITY_RULE_IDS.metadataApiToken);
    expect(detectCredentialRuleIds(inferenceToken)).toContain(SECURITY_RULE_IDS.nvidiaApiKey);
    expect(detectCredentialRuleIds(metadataBoundaryToken)).toContain(
      SECURITY_RULE_IDS.metadataApiToken,
    );
    expect(detectCredentialRuleIds(inferenceBoundaryToken)).toContain(
      SECURITY_RULE_IDS.nvidiaApiKey,
    );
    expect(detectCredentialRuleIdsInValue({ headers: { [headerName]: headerValue } })).toContain(
      SECURITY_RULE_IDS.metadataAssignedSecret,
    );
    expect(detectCredentialRuleIds(`${envName}=${envValue}`)).toContain(
      SECURITY_RULE_IDS.metadataAssignedSecret,
    );

    const redacted = redactSecrets(
      new Error(
        `${JSON.stringify({ [headerName]: headerValue })} ${envName}=${envValue} ${metadataBoundaryToken} ${inferenceBoundaryToken}`,
      ),
      [],
    );
    for (const forbidden of [
      headerName,
      headerValue,
      envName,
      envValue,
      metadataBoundaryToken,
      inferenceBoundaryToken,
    ]) {
      expect(redacted).not.toContain(forbidden);
    }
  });

  it("fails structured metadata scans closed without invoking accessors", () => {
    let getterCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "headers", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "untrusted";
      },
    });
    const sparse: unknown[] = [];
    sparse.length = 1;
    const decorated: unknown[] = [];
    Object.defineProperty(decorated, "metadata", { enumerable: true, value: "untrusted" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const deepRoot = deep;
    for (let index = 0; index < 30; index += 1) {
      const child: Record<string, unknown> = {};
      deep.child = child;
      deep = child;
    }

    for (const value of [accessor, sparse, decorated, cyclic, deepRoot]) {
      expect(detectCredentialRuleIdsInValue(value)).toContain(
        SECURITY_RULE_IDS.metadataAssignedSecret,
      );
    }
    expect(getterCalls).toBe(0);
  });

  it("bounds long underscore-rich assignment scanning", () => {
    const safe = "a_".repeat(50_000);
    const startedAt = performance.now();
    expect(detectCredentialRuleIds(safe)).toEqual([]);
    expect(redactSecrets(safe, [])).toBe(safe);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("passes safe text, binary content, and dotenv templates", async () => {
    const repositoryPath = await repositoryFixture();
    await writeFile(join(repositoryPath, "README.md"), "Safe documentation.\n");
    await writeFile(join(repositoryPath, ".env.example"), "API_KEY=<your key>\n");
    await writeFile(join(repositoryPath, "docs", "pixel.bin"), Buffer.from([0, 1, 2, 3, 255]));

    const result = await new LocalRepositorySecurityScanner().scan(repositoryPath);

    expect(result).toEqual({
      ruleSet: "docsfab-local-v2",
      status: "passed",
      scannedFiles: 3,
      binaryFiles: 1,
      findings: [],
    });
  });

  it("reports representative credentials by path and stable rule only", async () => {
    const repositoryPath = await repositoryFixture();
    await writeFile(join(repositoryPath, "docs", "aws.md"), "credential: AKIA1234567890ABCDEF\n");
    await writeFile(
      join(repositoryPath, "docs", "gitlab.md"),
      "token: glpat-1234567890abcdefghijk\n",
    );
    await writeFile(join(repositoryPath, "docs", "google.md"), `token: AIza${"a".repeat(35)}\n`);
    await writeFile(
      join(repositoryPath, "docs", "openai.md"),
      `token: ${"sk-"}${"1234567890abcdefghijklmnop"}\n`,
    );
    await writeFile(
      join(repositoryPath, "docs", "private.pem.txt"),
      "-----BEGIN PRIVATE KEY-----\nsensitive-material\n",
    );
    await writeFile(
      join(repositoryPath, "docs", "generic.env.example"),
      "client_secret=abcdefghijklmnopqrstuvwxyz\n",
    );

    const result = await new LocalRepositorySecurityScanner().scan(repositoryPath);

    expect(result.status).toBe("blocked");
    expect(result.findings).toEqual([
      {
        path: "docs/aws.md",
        ruleId: SECURITY_RULE_IDS.awsAccessKey,
      },
      {
        path: "docs/generic.env.example",
        ruleId: SECURITY_RULE_IDS.assignedSecret,
      },
      {
        path: "docs/gitlab.md",
        ruleId: SECURITY_RULE_IDS.gitlabToken,
      },
      {
        path: "docs/google.md",
        ruleId: SECURITY_RULE_IDS.googleApiKey,
      },
      {
        path: "docs/openai.md",
        ruleId: SECURITY_RULE_IDS.openAiApiKey,
      },
      {
        path: "docs/private.pem.txt",
        ruleId: SECURITY_RULE_IDS.privateKey,
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("AKIA1234567890ABCDEF");
    expect(serialized).not.toContain("glpat-1234567890abcdefghijk");
    expect(serialized).not.toContain(`AIza${"a".repeat(35)}`);
    expect(serialized).not.toContain("sensitive-material");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("scans ASCII credential markers inside binary files", async () => {
    const repositoryPath = await repositoryFixture();
    const prefix = Buffer.from([0, 1, 2, 3]);
    const credential = Buffer.from("nvapi-1234567890abcdefghijk");
    await writeFile(join(repositoryPath, "docs", "asset.bin"), Buffer.concat([prefix, credential]));

    const result = await new LocalRepositorySecurityScanner().scan(repositoryPath);

    expect(result.binaryFiles).toBe(1);
    expect(result.findings).toEqual([
      {
        path: "docs/asset.bin",
        ruleId: SECURITY_RULE_IDS.nvidiaApiKey,
      },
    ]);
  });

  it("blocks files that cannot be completely scanned", async () => {
    const repositoryPath = await repositoryFixture();
    await writeFile(join(repositoryPath, "large.txt"), "12345");
    await writeFile(join(repositoryPath, "unreadable.txt"), "not inspected");
    await chmod(join(repositoryPath, "unreadable.txt"), 0o000);
    await symlink("README.md", join(repositoryPath, "linked.md"));

    const result = await new LocalRepositorySecurityScanner({
      maxFileBytes: 4,
    }).scan(repositoryPath);

    expect(result.status).toBe("blocked");
    expect(result.findings).toEqual([
      { path: "large.txt", ruleId: SECURITY_RULE_IDS.fileTooLarge },
      { path: "linked.md", ruleId: SECURITY_RULE_IDS.symbolicLink },
      {
        path: "unreadable.txt",
        ruleId: SECURITY_RULE_IDS.unreadableFile,
      },
    ]);
  });

  it("fails closed when traversal itself fails", async () => {
    const result = await new LocalRepositorySecurityScanner().scan("/path/that/does/not/exist");

    expect(result).toEqual({
      ruleSet: "docsfab-local-v2",
      status: "failed",
      scannedFiles: 0,
      binaryFiles: 0,
      findings: [{ path: ".", ruleId: SECURITY_RULE_IDS.scannerFailure }],
    });
  });
});

/**
 * The canonical key classification fans out: the same classifier feeds the
 * `credential.assigned-secret` rule applied to every scanned repository file
 * (repository-scanner.ts), `inspectCredentialMetadata`, and every
 * `redactCredentialMaterial` call site across both packages. These assertions
 * execute that fan-out rather than asserting it in prose.
 */
describe("Task #1218 canonical key classification fan-out", () => {
  // A random-looking stand-in assembled at run time. EXAMPLE repeated is a
  // documentation placeholder, which #1807 exempts, so it cannot exercise key
  // classification.
  const VALUE = ["Qm7Zp2Rk", "4Xv9TnLw", "4bYcH8sJ", "Wd3F"].join("");

  it("raises credential.assigned-secret for a quoted token key and a CLI long flag", () => {
    for (const probe of [
      `"token": "${VALUE}"`,
      `{"token":"${VALUE}"}`,
      `glab api --private-token=${VALUE} projects/437040`,
    ]) {
      expect(detectCredentialRuleIds(probe), probe).toContain(SECURITY_RULE_IDS.assignedSecret);
    }
  });

  it("leaves the adjacent keys, a single-hyphen flag and an unquoted token identifier unclassified", () => {
    for (const probe of [
      `non-token: ${VALUE}`,
      `token-count: ${VALUE}`,
      `"tokens": "${VALUE}"`,
      `"auth-token-history": "${VALUE}"`,
      `-private-token=${VALUE}`,
      // This rule runs over every scanned repository file. The line below is
      // real Python from packages/runtime/quality/checks/validate_json_artifact.py,
      // which the quality-pack integrity check also reads through
      // detectCredentialRuleIds and reports "tampered" on a hit. An unquoted bare
      // `token` is an ordinary identifier, and the parser-backed reference filter
      // cannot help because it parses TypeScript, not Python.
      '        token = raw_token.replace("~1", "/").replace("~0", "~")',
      `token = ${VALUE}`,
    ]) {
      expect(detectCredentialRuleIds(probe), probe).toEqual([]);
      expect(containsAssignedCredential(probe), probe).toBe(false);
    }
  });

  it("walks a nested wire value and reports the rule for a token field, without a quote to read", () => {
    // The structured branch: a decoded object's own key is a field name, so no
    // quote is required or available. Losing this branch would make the text
    // form stricter than the wire form.
    expect(detectCredentialRuleIdsInValue({ request: { headers: { token: VALUE } } })).toContain(
      SECURITY_RULE_IDS.assignedSecret,
    );
    // The value floor this class is gated on, at the limit. The adjacent test
    // below drives limit-1; with only limit-1 asserted, the floor could be
    // raised without a red assertion anywhere.
    expect(VALUE.slice(0, 12)).toHaveLength(12);
    expect(
      detectCredentialRuleIdsInValue({ request: { headers: { token: VALUE.slice(0, 12) } } }),
    ).toContain(SECURITY_RULE_IDS.assignedSecret);
  });

  it("leaves adjacent field names unclassified in the structured walk too", () => {
    for (const value of [
      { request: { headers: { tokens: VALUE } } },
      { request: { body: { "token-count": VALUE } } },
      { request: { body: { "non-token": VALUE } } },
      // Below the 12-character value floor, at the key that does classify.
      { request: { headers: { token: VALUE.slice(0, 11) } } },
    ]) {
      expect(detectCredentialRuleIdsInValue(value), JSON.stringify(value)).toEqual([]);
    }
  });

  it("redacts a quoted token assignment and keeps the flag legible on a CLI long flag", () => {
    expect(redactCredentialMaterial(`{"token":"${VALUE}"}`)).toBe('{[REDACTED_CREDENTIAL]"}');
    // The leading boundary is capturing and the redaction starts after it, so
    // the `--` survives and an operator can still read which flag was elided.
    expect(redactCredentialMaterial(`glab api --private-token=${VALUE} projects/437040`)).toBe(
      "glab api --[REDACTED_CREDENTIAL] projects/437040",
    );
    // Adjacent: an ordinary counter field is left byte-for-byte alone.
    expect(redactCredentialMaterial(`token-count: ${VALUE}`)).toBe(`token-count: ${VALUE}`);
  });
});
