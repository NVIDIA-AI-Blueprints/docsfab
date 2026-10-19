// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, open, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type {
  RepositorySecurityScanner,
  SecurityScanFinding,
  SecurityScanReport,
} from "./contracts.js";
import {
  containsInferenceCredential,
  containsLegacyAssignedCredential,
  containsMetadataAssignedCredential,
  containsMetadataCredential,
  containsStrictLegacyAssignedCredential,
  containsStrictMetadataAssignedCredential,
  inspectCredentialMetadata,
} from "./credential-material.js";
import { CREDENTIAL_TOKEN_SHAPES as TOKEN } from "./text-credential-shapes.js";

export const SECURITY_SCAN_RULE_SET = "docsfab-local-v2";
export const DEFAULT_MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;

export const SECURITY_RULE_IDS = {
  awsAccessKey: "credential.aws-access-key-id",
  githubToken: "credential.github-token",
  gitlabToken: "credential.gitlab-token",
  slackToken: "credential.slack-token",
  googleApiKey: "credential.google-api-key",
  googleOauthToken: "credential.google-oauth-token",
  openAiApiKey: "credential.openai-api-key",
  nvidiaApiKey: "credential.nvidia-api-key",
  metadataApiToken: "credential.metadata-api-token",
  privateKey: "credential.private-key",
  jwt: "credential.jwt",
  assignedSecret: "credential.assigned-secret",
  metadataAssignedSecret: "credential.metadata-assigned-secret",
  fileTooLarge: "policy.file-too-large",
  unreadableFile: "policy.unreadable-file",
  symbolicLink: "policy.symbolic-link",
  unsupportedFileType: "policy.unsupported-file-type",
  scannerFailure: "scanner.internal-failure",
} as const;

interface ScannerOptions {
  maxFileBytes?: number;
}

interface CredentialRule {
  id: string;
  detects(content: string): boolean;
}

const CREDENTIAL_RULES: readonly CredentialRule[] = [
  regexRule(
    SECURITY_RULE_IDS.privateKey,
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/i,
  ),
  regexRule(SECURITY_RULE_IDS.awsAccessKey, TOKEN.aws),
  regexRule(SECURITY_RULE_IDS.githubToken, TOKEN.github),
  regexRule(SECURITY_RULE_IDS.gitlabToken, TOKEN.gitlab),
  regexRule(SECURITY_RULE_IDS.slackToken, TOKEN.slack, TOKEN.slackRefresh, TOKEN.slackApp),
  regexRule(SECURITY_RULE_IDS.googleApiKey, TOKEN.googleApiKey),
  regexRule(SECURITY_RULE_IDS.googleOauthToken, TOKEN.googleOauth),
  regexRule(SECURITY_RULE_IDS.openAiApiKey, TOKEN.openai),
  { id: SECURITY_RULE_IDS.nvidiaApiKey, detects: containsInferenceCredential },
  { id: SECURITY_RULE_IDS.metadataApiToken, detects: containsMetadataCredential },
  regexRule(SECURITY_RULE_IDS.jwt, TOKEN.jwt),
  {
    id: SECURITY_RULE_IDS.assignedSecret,
    detects(content): boolean {
      return containsLegacyAssignedCredential(content);
    },
  },
  {
    id: SECURITY_RULE_IDS.metadataAssignedSecret,
    detects(content): boolean {
      return containsMetadataAssignedCredential(content);
    },
  },
];

export class LocalRepositorySecurityScanner implements RepositorySecurityScanner {
  private readonly maxFileBytes: number;

  public constructor(options: ScannerOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_SCANNED_FILE_BYTES;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1) {
      throw new Error("maxFileBytes must be a positive safe integer.");
    }
  }

  public async scan(repositoryPath: string): Promise<SecurityScanReport> {
    const root = resolve(repositoryPath);
    const findings: SecurityScanFinding[] = [];
    let scannedFiles = 0;
    let binaryFiles = 0;

    try {
      const files = await collectFiles(root, root, findings);
      for (const file of files) {
        const initialStat = await lstat(file.absolutePath);
        if ((initialStat.mode & 0o444) === 0) {
          findings.push({
            path: file.relativePath,
            ruleId: SECURITY_RULE_IDS.unreadableFile,
          });
          continue;
        }
        if (initialStat.size > this.maxFileBytes) {
          findings.push({
            path: file.relativePath,
            ruleId: SECURITY_RULE_IDS.fileTooLarge,
          });
          continue;
        }

        const handle = await open(file.absolutePath, "r");
        try {
          const stat = await handle.stat();
          if (stat.size > this.maxFileBytes) {
            findings.push({
              path: file.relativePath,
              ruleId: SECURITY_RULE_IDS.fileTooLarge,
            });
            continue;
          }

          const content = await handle.readFile();
          if (content.byteLength > this.maxFileBytes) {
            findings.push({
              path: file.relativePath,
              ruleId: SECURITY_RULE_IDS.fileTooLarge,
            });
            continue;
          }

          scannedFiles += 1;
          if (content.includes(0)) binaryFiles += 1;
          const scanText = content.toString("latin1");
          for (const ruleId of detectCredentialRuleIds(scanText)) {
            findings.push({ path: file.relativePath, ruleId });
          }
        } finally {
          await handle.close();
        }
      }
    } catch {
      return {
        ruleSet: SECURITY_SCAN_RULE_SET,
        status: "failed",
        scannedFiles,
        binaryFiles,
        findings: [{ path: ".", ruleId: SECURITY_RULE_IDS.scannerFailure }],
      };
    }

    findings.sort(compareFindings);
    return {
      ruleSet: SECURITY_SCAN_RULE_SET,
      status: findings.length === 0 ? "passed" : "blocked",
      scannedFiles,
      binaryFiles,
      findings,
    };
  }
}

/** Returns stable rule IDs only; matched values never leave this module. */
export function detectCredentialRuleIds(content: string): string[] {
  return CREDENTIAL_RULES.filter((rule) => rule.detects(content)).map((rule) => rule.id);
}

/**
 * The 1-based line where `ruleId` first matches `content`: the last line of
 * the shortest line prefix the rule matches. Undefined when the rule is
 * unknown or does not match. Only the line number leaves this module.
 */
export function credentialRuleLine(content: string, ruleId: string): number | undefined {
  const rule = CREDENTIAL_RULES.find((candidate) => candidate.id === ruleId);
  if (!rule?.detects(content)) return undefined;
  const lines = content.split("\n");
  let low = 1;
  let high = lines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rule.detects(lines.slice(0, middle).join("\n"))) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The assignment rules under the strict value rule; the token rules are shared. */
const STRICT_CREDENTIAL_RULES: readonly CredentialRule[] = CREDENTIAL_RULES.map((rule) =>
  rule.id === SECURITY_RULE_IDS.assignedSecret
    ? { id: rule.id, detects: containsStrictLegacyAssignedCredential }
    : rule.id === SECURITY_RULE_IDS.metadataAssignedSecret
      ? { id: rule.id, detects: containsStrictMetadataAssignedCredential }
      : rule,
);

/**
 * The rules a redacting screen applies: references and documentation
 * placeholders still count, because over-redaction is cosmetic and a missed
 * value leaks. Screens that stop a run use `detectCredentialRuleIds`.
 */
export function detectStrictCredentialRuleIds(content: string): string[] {
  return STRICT_CREDENTIAL_RULES.filter((rule) => rule.detects(content)).map((rule) => rule.id);
}

/** Recursively scans every JSON-like key and string value without retaining matches. */
export function detectCredentialRuleIdsInValue(value: unknown): string[] {
  const ruleIds = new Set<string>();
  const inspection = inspectCredentialMetadata(value, (candidate) => {
    for (const ruleId of detectCredentialRuleIds(candidate)) ruleIds.add(ruleId);
  });
  if (inspection.legacyAssignedCredential) {
    ruleIds.add(SECURITY_RULE_IDS.assignedSecret);
  }
  if (inspection.metadataAssignedCredential || inspection.unsafeStructure) {
    ruleIds.add(SECURITY_RULE_IDS.metadataAssignedSecret);
  }
  return [...ruleIds].sort();
}

function regexRule(id: string, ...patterns: readonly RegExp[]): CredentialRule {
  return { id, detects: (content) => patterns.some((pattern) => pattern.test(content)) };
}

async function collectFiles(
  root: string,
  directory: string,
  findings: SecurityScanFinding[],
): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const files: Array<{ absolutePath: string; relativePath: string }> = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = repositoryRelativePath(root, absolutePath);
    if (entry.isSymbolicLink()) {
      findings.push({
        path: relativePath,
        ruleId: SECURITY_RULE_IDS.symbolicLink,
      });
    } else if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolutePath, findings)));
    } else if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
    } else {
      findings.push({
        path: relativePath,
        ruleId: SECURITY_RULE_IDS.unsupportedFileType,
      });
    }
  }
  return files;
}

function repositoryRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  return value || ".";
}

function compareFindings(left: SecurityScanFinding, right: SecurityScanFinding): number {
  return left.path.localeCompare(right.path) || left.ruleId.localeCompare(right.ruleId);
}
