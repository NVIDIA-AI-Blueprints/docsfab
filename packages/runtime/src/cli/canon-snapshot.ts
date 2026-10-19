// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import {
  KnowledgeSnapshotImportError,
  decodeKnowledgeAcceptedSnapshot,
  importFoundationCanonFromKnowledgeSnapshot,
  type KnowledgeResumeReceiptV1,
  type KnowledgeSnapshotHostAccept,
} from "../canon/index.js";
import type {
  CreateDocumentationTaskInput,
  UpdateDocumentationTaskInput,
} from "../workflow-contracts/contracts.js";
import {
  inspectRequestedPageSupport,
  inspectKnowledgeSnapshotResume,
  KnowledgeResumeError,
  knowledgeResumeNeedsInputMessage,
  type RequestedPageIntent,
} from "./knowledge-resume.js";

export type DocumentationCanonWorkflow = "create-documentation" | "update-documentation";

export interface DocumentationCanonBinding {
  readonly task: CreateDocumentationTaskInput | UpdateDocumentationTaskInput;
  readonly knowledgeResumeReceipt?: KnowledgeResumeReceiptV1;
}

/**
 * Import a knowledge snapshot and return the closed create-documentation
 * task that records the host-held canon digest. Candidate snapshots require
 * host-accept with an operator authority id.
 */
export async function importCreateDocumentationCanonTask(
  snapshotPath: string,
  hostAccept?: KnowledgeSnapshotHostAccept,
): Promise<CreateDocumentationTaskInput> {
  const task = await importDocumentationCanonTask(snapshotPath, "create-documentation", hostAccept);
  return task as CreateDocumentationTaskInput;
}

export async function importDocumentationCanonTask(
  snapshotPath: string,
  workflow: DocumentationCanonWorkflow,
  hostAccept?: KnowledgeSnapshotHostAccept,
): Promise<CreateDocumentationTaskInput | UpdateDocumentationTaskInput> {
  return (await importDocumentationCanonBinding(snapshotPath, workflow, undefined, hostAccept))
    .task;
}

/**
 * With `intent`, its write targets select the page the snapshot must support
 * and the request words are not read; without one they are.
 */
export async function importDocumentationCanonBinding(
  snapshotPath: string,
  workflow: DocumentationCanonWorkflow,
  instruction?: string,
  hostAccept?: KnowledgeSnapshotHostAccept,
  intent?: RequestedPageIntent,
): Promise<DocumentationCanonBinding> {
  let text: string;
  try {
    text = await readFile(snapshotPath, "utf8");
  } catch {
    throw new Error(`${workflow} --canon-snapshot could not read the snapshot file.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`The --canon-snapshot file is not valid JSON for ${workflow}.`);
  }
  let snapshot;
  try {
    snapshot = decodeKnowledgeAcceptedSnapshot(value);
  } catch (error) {
    if (error instanceof KnowledgeSnapshotImportError) {
      throw new Error(`The ${workflow} --canon-snapshot import was rejected: ${error.code}.`);
    }
    throw error;
  }
  const resume =
    instruction === undefined
      ? inspectKnowledgeSnapshotResume(snapshot)
      : inspectRequestedPageSupport(snapshot, instruction, intent);
  if (resume.disposition === "needs-input" && resume.stopReason) {
    throw new KnowledgeResumeError(
      resume.stopReason,
      knowledgeResumeNeedsInputMessage(resume.stopReason),
    );
  }
  if (snapshot.status === "candidate" && hostAccept === undefined) {
    throw new Error(
      "A candidate --canon-snapshot requires --accept-candidate-snapshot and --authority-id <id>.",
    );
  }
  if (snapshot.status !== "candidate" && hostAccept !== undefined) {
    throw new Error(
      "--accept-candidate-snapshot is only valid when the snapshot status is candidate.",
    );
  }
  try {
    const canon = importFoundationCanonFromKnowledgeSnapshot(value, hostAccept);
    return {
      task: {
        kind: workflow,
        canonSha256: canon.canonSha256,
      },
      ...(resume.receipt ? { knowledgeResumeReceipt: resume.receipt } : {}),
    };
  } catch (error) {
    if (error instanceof KnowledgeSnapshotImportError) {
      throw new Error(`The ${workflow} --canon-snapshot import was rejected: ${error.code}.`);
    }
    throw error;
  }
}
