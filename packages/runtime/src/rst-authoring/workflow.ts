// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import { limit, refuseLimit } from "../config/limits.js";
import { parseJsonEvidence } from "../json-evidence.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { readTrackedRepositoryFile } from "../repository/workspace/tracked-read.js";
import { analyzeRstRegions } from "./regions.js";
import { selectRstRegion } from "./regions.js";
import { applyRstProseEdit, verifyRstPreservation } from "./preservation.js";
import { RstRegionError, type RstAnalysis, type RstPreservationReceipt } from "./contracts.js";

export interface RstAuthoringRegion {
  readonly id: string;
  readonly kind: "replace" | "insert";
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface RstAuthoringInput {
  readonly path: string;
  readonly baseSha256: string;
  readonly newline: RstAnalysis["newline"];
  readonly regions: readonly RstAuthoringRegion[];
}

export interface PreparedRstAuthoring {
  readonly input: RstAuthoringInput;
  readonly analysis: RstAnalysis;
  readonly original: Uint8Array;
}

/** Process-local base and exact selection kept until patch capture. */
export interface RstCaptureBinding {
  prepared?: PreparedRstAuthoring;
  region?: RstAuthoringRegion;
  receipt?: RstPreservationReceipt;
}

function absolutePage(workspacePath: string, path: string): string {
  if (
    !/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.rst$/u.test(path) ||
    path.split("/").some((part) => part.startsWith("."))
  ) {
    throw new RstRegionError(
      "The selected RST page path does not meet the exact safe grammar.",
      "rst-edit-region-unsupported",
      path,
      {
        start: 0,
        end: 0,
      },
    );
  }
  return join(workspacePath, ...path.split("/"));
}

async function readRegularPage(workspacePath: string, path: string): Promise<Uint8Array> {
  await assertNoLinkedAncestor(workspacePath, path);
  const absolute = absolutePage(workspacePath, path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new RstRegionError(
      "The selected RST page is not a unique regular file.",
      "rst-edit-region-unsupported",
      path,
      { start: 0, end: 0 },
    );
  }
  const bound = limit("authoring.plannedPageMaxBytes");
  if (metadata.size > bound.value) refuseLimit(bound, metadata.size);
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > bound.value) refuseLimit(bound, bytes.byteLength);
    const after = await handle.stat();
    if (
      after.ino !== metadata.ino ||
      after.dev !== metadata.dev ||
      after.nlink !== 1 ||
      after.size !== metadata.size
    ) {
      throw new RstRegionError(
        "The selected RST page changed while its bytes were being read.",
        "rst-preservation-mismatch",
        path,
        {
          start: 0,
          end: bytes.byteLength,
        },
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertNoLinkedAncestor(workspacePath: string, path: string): Promise<void> {
  const root = await realpath(workspacePath);
  let parent = root;
  for (const segment of path.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    const metadata = await lstat(parent);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(parent)) !== parent
    ) {
      throw new RstRegionError(
        "The selected RST page path crosses an unbound directory ancestor.",
        "rst-edit-region-unsupported",
        path,
        { start: 0, end: 0 },
      );
    }
  }
}

export async function prepareRstAuthoring(
  workspacePath: string,
  path: string,
  repositoryWorkspace: RepositoryWorkspace,
): Promise<PreparedRstAuthoring> {
  const original = await readRegularPage(workspacePath, path);
  const tracked = await readTrackedRepositoryFile(
    repositoryWorkspace,
    path,
    limit("authoring.plannedPageMaxBytes").value,
  );
  if (!Buffer.from(original).equals(tracked)) {
    throw new RstRegionError(
      "The private workspace page differs from the tracked base revision.",
      "rst-preservation-mismatch",
      path,
      { start: 0, end: original.byteLength },
    );
  }
  const analysis = analyzeRstRegions(path, original);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const regions: RstAuthoringRegion[] = [
    ...analysis.paragraphs.map((paragraph) => ({
      id: `${path}@${analysis.baseSha256}:replace:${paragraph.start}:${paragraph.end}`,
      kind: "replace" as const,
      start: paragraph.start,
      end: paragraph.end,
      text: decoder.decode(original.subarray(paragraph.start, paragraph.end)),
    })),
    ...analysis.insertionSlots.map((slot) => ({
      id: `${path}@${analysis.baseSha256}:insert:${slot.offset}`,
      kind: "insert" as const,
      start: slot.offset,
      end: slot.offset,
      text: "",
    })),
  ];
  if (regions.length === 0) {
    throw new RstRegionError(
      "The selected RST page has no eligible top-level prose region.",
      "rst-edit-region-unsupported",
      path,
      { start: 0, end: original.length },
    );
  }
  return {
    input: { path, baseSha256: analysis.baseSha256, newline: analysis.newline, regions },
    analysis,
    original,
  };
}

/** Admit one exact model proposal, then materialize it with the host's selected byte manifest. */
export async function applyRstAuthoringProposal(
  workspacePath: string,
  prepared: PreparedRstAuthoring,
  response: string,
  validateCandidate: (candidate: Uint8Array) => Promise<void>,
): Promise<{
  readonly receipt: RstPreservationReceipt;
  readonly region: RstAuthoringRegion;
  readonly prose: string;
}> {
  let proposal: unknown;
  try {
    proposal = parseJsonEvidence(response);
  } catch {
    /* coded below */
  }
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new RstRegionError(
      "The writer must return a strict region/prose JSON object.",
      "rst-edit-region-unsupported",
      prepared.input.path,
      { start: 0, end: 0 },
    );
  }
  const object = proposal as Record<string, unknown>;
  if (
    Object.keys(object).sort().join(",") !== "prose,regionId" ||
    typeof object.regionId !== "string" ||
    typeof object.prose !== "string"
  ) {
    throw new RstRegionError(
      "The writer proposal must contain only regionId and prose strings.",
      "rst-edit-region-unsupported",
      prepared.input.path,
      { start: 0, end: 0 },
    );
  }
  const region = prepared.input.regions.find((candidate) => candidate.id === object.regionId);
  if (!region) {
    throw new RstRegionError(
      "The writer selected a region outside the sealed base.",
      "rst-edit-region-unsupported",
      prepared.input.path,
      { start: 0, end: 0 },
    );
  }
  const selection = selectRstRegion(
    prepared.analysis,
    region.kind === "replace"
      ? { kind: "replace", start: region.start, end: region.end }
      : { kind: "insert", offset: region.start },
  );
  const edited = applyRstProseEdit(prepared.original, selection, object.prose);
  const pageBound = limit("authoring.plannedPageMaxBytes");
  if (edited.bytes.byteLength > pageBound.value) {
    refuseLimit(pageBound, edited.bytes.byteLength);
  }
  await validateCandidate(edited.bytes);
  await assertNoLinkedAncestor(workspacePath, prepared.input.path);
  const absolute = absolutePage(workspacePath, prepared.input.path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new RstRegionError(
      "The selected page kind changed before host materialization began.",
      "rst-preservation-mismatch",
      prepared.input.path,
      { start: 0, end: 0 },
    );
  }
  const handle = await open(absolute, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  try {
    const current = await handle.readFile();
    if (!Buffer.from(current).equals(Buffer.from(prepared.original))) {
      throw new RstRegionError(
        "The sealed base bytes changed before host materialization began.",
        "rst-preservation-mismatch",
        prepared.input.path,
        { start: 0, end: current.length },
      );
    }
    const before = await handle.stat();
    if (before.ino !== metadata.ino || before.dev !== metadata.dev || before.nlink !== 1) {
      throw new RstRegionError(
        "The selected page identity changed before host materialization began.",
        "rst-preservation-mismatch",
        prepared.input.path,
        { start: 0, end: current.length },
      );
    }
    let offset = 0;
    while (offset < edited.bytes.byteLength) {
      const written = await handle.write(
        edited.bytes,
        offset,
        edited.bytes.byteLength - offset,
        offset,
      );
      if (written.bytesWritten === 0)
        throw new Error(
          "The RST host materialization operation made no progress while writing candidate bytes.",
        );
      offset += written.bytesWritten;
    }
    await handle.truncate(edited.bytes.byteLength);
  } finally {
    await handle.close();
  }
  return { receipt: edited.receipt, region, prose: object.prose };
}

/** Recheck the exact retained candidate against its tracked base before patch capture. */
export async function verifyRetainedRstCandidate(
  workspacePath: string,
  binding: RstCaptureBinding,
): Promise<void> {
  const { prepared, region, receipt } = binding;
  if (!prepared || !region || !receipt) {
    throw new Error(
      "rst-preservation-mismatch: The sealed RST capture binding is unavailable before patch capture.",
    );
  }
  const candidate = await readRegularPage(workspacePath, receipt.path);
  const selection = selectRstRegion(
    prepared.analysis,
    region.kind === "replace"
      ? { kind: "replace", start: region.start, end: region.end }
      : { kind: "insert", offset: region.start },
  );
  const admitted = verifyRstPreservation(prepared.original, candidate, selection);
  if (JSON.stringify(admitted) !== JSON.stringify(receipt)) {
    throw new RstRegionError(
      "The retained candidate does not match the host-applied preservation receipt.",
      "rst-preservation-mismatch",
      receipt.path,
      { start: receipt.selectedStart, end: receipt.selectedEnd },
    );
  }
}
