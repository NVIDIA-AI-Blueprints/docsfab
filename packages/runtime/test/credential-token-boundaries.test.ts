// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { containsTokenShapedText } from "../scripts/docsfab-preflight.mjs";
import {
  containsRepositorySourceCredentialMaterial,
  redactCredentialMaterial,
} from "../src/security/credential-material.js";
import {
  detectCredentialRuleIds,
  detectCredentialRuleIdsInValue,
  LocalRepositorySecurityScanner,
  SECURITY_RULE_IDS,
} from "../src/security/repository-scanner.js";
import {
  CREDENTIAL_TOKEN_SHAPES,
  DOCUMENT_CREDENTIAL_SHAPES,
  TEXT_CREDENTIAL_SHAPES,
  containsTextCredentialShape,
} from "../src/security/text-credential-shapes.js";

// Synthetic, token-shaped fixtures assembled at run time; no source line
// carries a credential.
const letters = (length: number) =>
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(3).slice(0, length);
const upper = (length: number) => "QWERTYUPZXCVBNMLKJHGFDSAQWERTY".slice(0, length);
const mixed = (length: number) => "a1B2c3D4e5F6g7H8i9J0".repeat(6).slice(0, length);
const githubPrefix = ["gh", "p_"].join("");
const awsPrefix = ["AK", "IA"].join("");
const githubPatPrefix = ["github", "pat", ""].join("_");
const github = (body: string) => `${githubPrefix}${body}`;
const aws = (body: string) => `${awsPrefix}${body}`;
const github36 = github(mixed(36));
const aws16 = aws(upper(16));

const R = SECURITY_RULE_IDS;

/** [case, value, the one credential rule it must raise]. */
const EMBEDDED: readonly (readonly [name: string, value: string, ruleId: string])[] = [
  ["a GitHub token after an identifier prefix", `x_${github36}`, R.githubToken],
  ["a GitHub token between identifier segments", `x_${github36}_y`, R.githubToken],
  [
    "a fine-grained GitHub token after an identifier prefix",
    `x_${githubPatPrefix}${mixed(40)}`,
    R.githubToken,
  ],
  ["a digit-free GitHub token after a lowercase prefix", `my${github(letters(36))}`, R.githubToken],
  [
    "a fine-grained GitHub token after a lowercase prefix",
    `my${githubPatPrefix}${mixed(22)}_${mixed(59)}`,
    R.githubToken,
  ],
  ["an AWS key id before an identifier suffix", `${aws16}_x`, R.awsAccessKey],
  ["an AWS key id after an identifier prefix", `x_${aws16}`, R.awsAccessKey],
  ["a digit-free AWS key id after a camelCase prefix", `my${aws(upper(16))}`, R.awsAccessKey],
  ["an AWS key id before a camelCase suffix", `${aws16}Key`, R.awsAccessKey],
  ["an AWS key id before a digit suffix", `${aws16}1`, R.awsAccessKey],
  [
    "an AWS temporary key id after an identifier prefix",
    `x_${["AS", "IA"].join("")}${upper(16)}`,
    R.awsAccessKey,
  ],
  [
    "a Google API key after a camelCase prefix",
    `x${["AI", "za"].join("")}${letters(35)}`,
    R.googleApiKey,
  ],
  [
    "a Google API key before an identifier suffix",
    `${["AI", "za"].join("")}${letters(35)}_x`,
    R.googleApiKey,
  ],
  [
    "a Google API key whose body ends in - before a letter",
    `${["AI", "za"].join("")}${letters(34)}-x`,
    R.googleApiKey,
  ],
  [
    "a Google API key whose body ends in - before a camelCase suffix",
    `x_${["AI", "za"].join("")}${mixed(34)}-Key`,
    R.googleApiKey,
  ],
  [
    "a GitLab token after an identifier prefix",
    `x_${["gl", "pat"].join("")}-${mixed(20)}`,
    R.gitlabToken,
  ],
  [
    "a Slack token between identifier segments",
    `x_${["xo", "xb"].join("")}-${mixed(20)}_y`,
    R.slackToken,
  ],
  [
    "a Slack refresh token after an identifier prefix",
    `x_${["xo", "xe"].join("")}-${mixed(12)}`,
    R.slackToken,
  ],
  [
    "a Slack app token after an identifier prefix",
    `x_${["xa", "pp"].join("")}-${mixed(12)}`,
    R.slackToken,
  ],
  [
    "an OpenAI key after an identifier prefix",
    `x_${["s", "k"].join("")}-${mixed(20)}`,
    R.openAiApiKey,
  ],
  [
    "a Google OAuth token after an identifier prefix",
    `x_${["ya", "29"].join("")}.${mixed(20)}`,
    R.googleOauthToken,
  ],
  [
    "an NVIDIA key after an identifier prefix",
    `x_${["nv", "api"].join("")}-${mixed(20)}`,
    R.nvidiaApiKey,
  ],
  // A hyphen or underscore before a key starts it, as for the shared shapes.
  ["an NVIDIA key after a hyphen", `x-${["nv", "api"].join("")}-${mixed(20)}`, R.nvidiaApiKey],
  [
    "a metadata API key after a hyphen",
    `x-${["ihub", "api", ""].join("_")}${mixed(20)}`,
    R.metadataApiToken,
  ],
  [
    "a metadata API key after an identifier prefix",
    `x_${["ihub", "api", ""].join("_")}${mixed(20)}`,
    R.metadataApiToken,
  ],
  [
    "a GitLab token after a hyphenated word",
    `stop-${["gl", "pat"].join("")}-${mixed(20)}`,
    R.gitlabToken,
  ],
  ["a GitHub token after a one-letter prefix", `a_${github36}`, R.githubToken],
  ["a JWT after an identifier prefix", `x_eyJ${mixed(8)}.${mixed(8)}.${mixed(8)}`, R.jwt],
];

/** Ordinary identifiers, and the adjacent shapes each boundary must leave alone. */
const ORDINARY: readonly (readonly [name: string, value: string])[] = [
  ["snake_case words", "transferable_understanding score_2024_q1 sha256_digest interpretation2"],
  ["a plural word before a GitHub-like prefix", "highs_and_lows_per_window_size_for_the_chart"],
  [
    "a word ending in a key prefix",
    "task-runner-configuration-file risk-assessment-for-the-quarter",
  ],
  ["a snake_case segment ending in a key prefix", "my_desk-assignment-for-the-quarter"],
  ["a camelCase Asia", "The AsiaPacificOperation team"],
  ["an uppercase run containing ASIA", "SOUTHEASTASIAREGIONIDENTIFIER"],
  ["a SCREAMING_SNAKE ASIA segment", "ASIA_PACIFIC_REGION_IDENTIFIER"],
  ["an uppercase environment name with a metadata prefix", "X_IHUB_API_KEY_FILE_PATH_FOR_TESTS"],
  ["a GitHub prefix without its underscore", `token${githubPrefix.slice(0, 3)}${letters(36)}`],
  ["a short GitHub body after a lowercase prefix", `my${github(letters(35))}`],
  ["a long GitHub body after a lowercase prefix", `my${github(letters(37))}`],
  ["an AWS prefix inside an uppercase run", `X${aws16}`],
  ["a short AWS body after an identifier prefix", `x_${aws(upper(15))}`],
  ["a Google prefix before a longer body", `x${["AI", "za"].join("")}${letters(40)}`],
  ["a GitLab prefix inside a word", `my${["gl", "pat"].join("")}-${mixed(20)}`],
  // A key prefix that ends a longer word is not a key.
  ["an OpenAI-like prefix ending a word", `task-${mixed(20)}`],
  ["a GitHub-like prefix ending a word", `laughs_${mixed(20)}`],
  ["an NVIDIA prefix inside a word", `un${["nv", "api"].join("")}-${mixed(20)}`],
  ["a metadata prefix inside a word", `x${["ihub", "api", ""].join("_")}${mixed(20)}`],
];

const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function repositoryWith(files: Record<string, string>): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "docsfab-token-boundary-"));
  repositories.push(path);
  for (const [name, content] of Object.entries(files)) await writeFile(join(path, name), content);
  return path;
}

describe("credential tokens embedded in identifiers", () => {
  it.each(EMBEDDED)("flags %s in text and as a JSON key", (_name, value, ruleId) => {
    expect(detectCredentialRuleIds(value)).toEqual([ruleId]);
    expect(detectCredentialRuleIds(`const ${value} = 1;`)).toEqual([ruleId]);
    expect(detectCredentialRuleIdsInValue({ [value]: "unrelated" })).toEqual([ruleId]);
    expect(detectCredentialRuleIdsInValue({ field: [value] })).toEqual([ruleId]);
  });

  it.each(ORDINARY)("leaves %s unflagged", (_name, value) => {
    expect(detectCredentialRuleIds(value)).toEqual([]);
    expect(detectCredentialRuleIdsInValue({ [value]: value })).toEqual([]);
    expect(containsTextCredentialShape(value)).toBe(false);
  });

  it("reports embedded tokens by path and rule through the repository scanner", async () => {
    const repositoryPath = await repositoryWith({
      "github.md": `Set x_${github36} in the profile.\n`,
      "aws-suffix.md": `Use ${aws16}_x here.\n`,
      "aws-prefix.json": `${JSON.stringify({ [`x_${aws16}`]: true })}\n`,
      "ordinary.md": `${ORDINARY.map(([, value]) => value).join("\n")}\n`,
    });

    const result = await new LocalRepositorySecurityScanner().scan(repositoryPath);

    expect(result.status).toBe("blocked");
    expect(result.findings).toEqual([
      { path: "aws-prefix.json", ruleId: R.awsAccessKey },
      { path: "aws-suffix.md", ruleId: R.awsAccessKey },
      { path: "github.md", ruleId: R.githubToken },
    ]);
    expect(JSON.stringify(result)).not.toContain(github36);
    expect(JSON.stringify(result)).not.toContain(aws16);
  });

  it("flags the same embedded tokens in every screen built on the shared shapes", () => {
    for (const value of [`x_${github36}`, `${aws16}_x`, `x_${aws16}`, `my${github(letters(36))}`]) {
      const line = `The value ${value} appears here.`;
      expect(containsTextCredentialShape(line)).toBe(true);
      expect(containsTokenShapedText(line)).toBe(true);
    }
    expect(DOCUMENT_CREDENTIAL_SHAPES.some((shape) => shape.test(`x_${github36}`))).toBe(true);
    expect(containsRepositorySourceCredentialMaterial(`const value = "x_${github36}";`)).toBe(true);
  });

  it.each([
    [
      "the document list's NVIDIA key",
      DOCUMENT_CREDENTIAL_SHAPES,
      `x_${["nv", "api"].join("")}-${mixed(20)}`,
    ],
    ["the text list's JWT head", TEXT_CREDENTIAL_SHAPES, `x_eyJ${mixed(10)}.${mixed(10)}.`],
    [
      "the text list's bearer value",
      TEXT_CREDENTIAL_SHAPES,
      `x_${["Bear", "er"].join("")} ${mixed(16)}`,
    ],
  ] as const)("flags %s after an identifier prefix", (_name, shapes, value) => {
    expect(shapes.some((shape) => shape.test(value))).toBe(true);
    expect(shapes.some((shape) => shape.test(value.slice("x_".length)))).toBe(true);
    expect(shapes.some((shape) => shape.test(`x${value.slice("x_".length)}`))).toBe(false);
  });

  it("redacts an NVIDIA key after an identifier prefix", () => {
    const key = `${["nv", "api"].join("")}-${mixed(24)}`;
    const redacted = redactCredentialMaterial(`x_${key} done`);
    expect(redacted).not.toContain(key);
    expect(redacted).toBe("x_[REDACTED] done");
  });

  it("redacts NVIDIA and metadata keys after a hyphen", () => {
    const nvidia = `${["nv", "api"].join("")}-${mixed(24)}`;
    const metadata = `${["ihub", "api", ""].join("_")}${mixed(24)}`;
    expect(redactCredentialMaterial(`x-${nvidia} done`)).toBe("x-[REDACTED] done");
    expect(redactCredentialMaterial(`x-${metadata} done`)).toBe("x-[REDACTED] done");
    // A prefix inside a word is not a key, so the text is left as written.
    expect(redactCredentialMaterial(`un${nvidia} done`)).toBe(`un${nvidia} done`);
  });

  it("anchors no shared shape on a word boundary, which treats _ as part of a word", () => {
    const shapes = [
      ...Object.values(CREDENTIAL_TOKEN_SHAPES),
      ...DOCUMENT_CREDENTIAL_SHAPES,
      ...TEXT_CREDENTIAL_SHAPES,
    ];
    expect(shapes.filter((shape) => shape.source.includes("\\b"))).toEqual([]);
    expect(Object.isFrozen(CREDENTIAL_TOKEN_SHAPES)).toBe(true);
    expect(shapes.filter((shape) => shape.global || shape.sticky)).toEqual([]);
  });
});
