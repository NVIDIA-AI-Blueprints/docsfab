// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SecurityScanReport } from "./contracts.js";
import {
  CREDENTIAL_LIKE_CONTENT,
  type CredentialFinding,
  credentialFindingLocation,
  sortCredentialFindings,
} from "./credential-findings.js";
import { credentialRuleLine, detectCredentialRuleIds } from "./repository-scanner.js";

/** Where a finding in the operator's request text points. */
export const REQUEST_TEXT_LOCATION = "request:instruction";

const CREDENTIAL_RULE_PREFIX = "credential.";

export interface CredentialLikeContent {
  readonly findings: CredentialFinding[];
  /** The content-free run-record warning, or undefined when nothing was found. */
  readonly warning: string | undefined;
}

/**
 * Credential-like content a run read and continued past (#1807): each
 * credential rule the repository scan matched, with the first line it matches
 * in that file, and each rule the request text matches. Never the text.
 */
export async function collectCredentialLikeContent(input: {
  readonly runId: string;
  readonly report: SecurityScanReport;
  readonly workspacePath: string;
  readonly requestText?: string;
}): Promise<CredentialLikeContent> {
  const rulesByPath = new Map<string, string[]>();
  for (const finding of input.report.findings) {
    if (!finding.ruleId.startsWith(CREDENTIAL_RULE_PREFIX)) continue;
    rulesByPath.set(finding.path, [...(rulesByPath.get(finding.path) ?? []), finding.ruleId]);
  }
  const findings: CredentialFinding[] = [];
  for (const [path, rules] of rulesByPath) {
    let content: string | undefined;
    try {
      // The scanner decodes the same way, so the line matches what it saw.
      content = (await readFile(join(input.workspacePath, path))).toString("latin1");
    } catch {
      content = undefined;
    }
    for (const rule of rules) {
      const line = content === undefined ? undefined : credentialRuleLine(content, rule);
      findings.push({
        code: CREDENTIAL_LIKE_CONTENT,
        location: credentialFindingLocation(path, line),
        rule,
      });
    }
  }
  const requestRules = input.requestText ? detectCredentialRuleIds(input.requestText) : [];
  for (const rule of requestRules) {
    findings.push({ code: CREDENTIAL_LIKE_CONTENT, location: REQUEST_TEXT_LOCATION, rule });
  }
  return {
    findings: sortCredentialFindings(findings),
    warning: credentialLikeContentWarning(input.runId, rulesByPath.size, requestRules.length > 0),
  };
}

function credentialLikeContentWarning(
  runId: string,
  files: number,
  request: boolean,
): string | undefined {
  if (files === 0 && !request) return undefined;
  const holders = [
    ...(files > 0 ? [`${String(files)} repository file${files === 1 ? "" : "s"}`] : []),
    ...(request ? ["the request text"] : []),
  ].join(" and ");
  const verb = files === 1 && !request ? "holds" : "hold";
  return `${CREDENTIAL_LIKE_CONTENT}: ${holders} ${verb} text that looks like a credential. DocsFab used it and continued; only its own configured credentials stop a run. The maintainers decide whether it is a real credential. \`docsfab runs show ${runId}\` lists each path, line, and rule.`;
}
