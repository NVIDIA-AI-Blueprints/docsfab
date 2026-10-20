// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path";

export interface PilotCampaignCliArguments {
  readonly command: "pilot-campaign";
  readonly corpusId: "routing-task-guide-v1";
  readonly campaignRoot: string;
  readonly nemotronRecordPath: string;
  readonly nemotronPatchPath: string | null;
  readonly nemotronDocumentPath: string | null;
  readonly forbiddenRoots: readonly [string, string];
  readonly acknowledged: true;
  readonly json: boolean;
}

export type PilotCampaignCliErrorCode =
  | "acknowledgement-required"
  | "artifact-invalid"
  | "campaign-failed"
  | "campaign-root-invalid"
  | "environment-invalid"
  | "forbidden-root-mismatch"
  | "invalid-arguments"
  | "nemotron-freshness"
  | "persistence-failed"
  | "proxy-evidence-invalid"
  | "replay-root-invalid";

export class PilotCampaignCliError extends Error {
  public constructor(public readonly code: PilotCampaignCliErrorCode) {
    super(`Native pilot campaign rejected (${code}).`);
    this.name = "PilotCampaignCliError";
  }
}

export function fail(code: PilotCampaignCliErrorCode): never {
  throw new PilotCampaignCliError(code);
}

export function canonicalArgumentPath(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096) {
    fail("invalid-arguments");
  }
  return value;
}

export function configuredExecutable(value: string | undefined): string {
  if (!value?.trim()) fail("environment-invalid");
  return canonicalArgumentPath(value.trim());
}

export function parsePilotCampaignCliArguments(args: readonly string[]): PilotCampaignCliArguments {
  const values = new Map<string, string[]>();
  let acknowledged = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--acknowledge-development-only-uncontained") {
      if (acknowledged) fail("invalid-arguments");
      acknowledged = true;
      continue;
    }
    if (token === "--json") {
      if (json) fail("invalid-arguments");
      json = true;
      continue;
    }
    if (
      token !== "--corpus" &&
      token !== "--campaign-root" &&
      token !== "--nemotron-record" &&
      token !== "--nemotron-patch" &&
      token !== "--nemotron-document" &&
      token !== "--forbidden-root"
    ) {
      fail("invalid-arguments");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--") || value.includes("\0")) fail("invalid-arguments");
    const current = values.get(token) ?? [];
    current.push(value);
    values.set(token, current);
    index += 1;
  }
  if (!acknowledged) fail("acknowledgement-required");
  const one = (name: string): string => {
    const observed = values.get(name);
    if (observed?.length !== 1) fail("invalid-arguments");
    return observed[0]!;
  };
  const corpusId = one("--corpus");
  if (corpusId !== "routing-task-guide-v1") fail("invalid-arguments");
  const forbiddenRoots = values.get("--forbidden-root");
  if (forbiddenRoots?.length !== 2 || new Set(forbiddenRoots).size !== 2) {
    fail("invalid-arguments");
  }
  const campaignRoot = canonicalArgumentPath(one("--campaign-root"));
  const nemotronRecordPath = canonicalArgumentPath(one("--nemotron-record"));
  const patchValues = values.get("--nemotron-patch");
  if (patchValues && patchValues.length !== 1) fail("invalid-arguments");
  const nemotronPatchPath = patchValues ? canonicalArgumentPath(patchValues[0]!) : null;
  const documentValues = values.get("--nemotron-document");
  if (documentValues && documentValues.length !== 1) fail("invalid-arguments");
  const nemotronDocumentPath = documentValues ? canonicalArgumentPath(documentValues[0]!) : null;
  return {
    command: "pilot-campaign",
    corpusId,
    campaignRoot,
    nemotronRecordPath,
    nemotronPatchPath,
    nemotronDocumentPath,
    forbiddenRoots: [
      canonicalArgumentPath(forbiddenRoots[0]!),
      canonicalArgumentPath(forbiddenRoots[1]!),
    ],
    acknowledged: true,
    json,
  };
}
