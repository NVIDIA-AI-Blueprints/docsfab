// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Independent immutable Git originals before the runtime admits ambiguous source text. */
import { createHash } from "node:crypto";
import {
  parseHostRuntimeRequest,
  parseHostRuntimeRequestData,
  qualifyHostRuntimeSemanticComparisonSources,
  semanticComparisonSourceProofInputs,
  type HostRuntimeRequestV1,
} from "./contracts.js";
import { MAX_GIT_OUTPUT_BYTES, runTrustedGit } from "./trusted-git.js";

function fail(): never {
  throw new Error("Hosted semantic source original is unavailable or differs.");
}

export async function readHostRuntimeRequestSources(
  input: unknown,
  signal?: AbortSignal,
): Promise<HostRuntimeRequestV1> {
  const request = parseHostRuntimeRequestData(input),
    chunk = request.packet.semanticComparison;
  if (request.workflow !== "reconcile-product-behavior" || !chunk)
    return parseHostRuntimeRequest(request);
  const candidates = semanticComparisonSourceProofInputs(chunk);
  if (candidates.length === 0) return parseHostRuntimeRequest(request);
  const revision = (
    await runTrustedGit(request.workspacePath, ["rev-parse", "--verify", "HEAD"], signal)
  )
    .toString("utf8")
    .trim();
  const tree = (
    await runTrustedGit(
      request.workspacePath,
      ["rev-parse", "--verify", `${request.revision}^{tree}`],
      signal,
    )
  )
    .toString("utf8")
    .trim();
  if (revision !== request.revision || tree !== request.sourceTreeObjectId) fail();
  const originals = new Map<string, string>();
  for (const item of candidates) {
    if (
      !item.sourcePath ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(item.version) ||
      !["repository-before", "repository-after", "supporting-context"].includes(item.kind) ||
      item.totalBytes > MAX_GIT_OUTPUT_BYTES
    )
      fail();
    const key = JSON.stringify([item.version, item.sourcePath, item.sourceContentSha256]);
    if (originals.has(key)) continue;
    const metadata = (
      await runTrustedGit(
        request.workspacePath,
        ["ls-tree", "-z", item.version, "--", `:(literal)${item.sourcePath}`],
        signal,
      )
    ).toString("utf8");
    const row = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/u.exec(metadata);
    if (!row || row[3] !== item.sourcePath) fail();
    const oid = row[2]!;
    const bytes = await runTrustedGit(
      request.workspacePath,
      ["cat-file", "blob", oid],
      signal,
      item.totalBytes + 1,
    );
    if (
      bytes.length !== item.totalBytes ||
      createHash(oid.length === 40 ? "sha1" : "sha256")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") !== oid
    )
      fail();
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return fail();
    }
    originals.set(key, content);
  }
  qualifyHostRuntimeSemanticComparisonSources(chunk, (item) =>
    originals.get(JSON.stringify([item.version, item.sourcePath, item.sourceContentSha256])),
  );
  return parseHostRuntimeRequest(request);
}
