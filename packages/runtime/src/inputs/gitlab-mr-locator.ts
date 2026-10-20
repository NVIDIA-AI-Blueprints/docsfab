// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-free GitLab MR locator for `gitlab-mr-note` review bindings.
 * Uses numeric project identity; never a tokenized URL or host filesystem path.
 */

import { digestExternalInputLocator, ExternalInputContractError } from "./contracts.js";

const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface GitlabMrReviewLocatorInputV1 {
  host: string;
  projectId: number;
  mergeRequestIid: number;
}

function fail(code: "invalid-shape" | "invalid-value"): never {
  throw new ExternalInputContractError(code);
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("invalid-value");
  }
  return value;
}

/** Canonical, credential-free locator text. Digested before durable records retain it. */
export function canonicalGitlabMrReviewLocator(input: GitlabMrReviewLocatorInputV1): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid-shape");
  const root = input as unknown as Record<string, unknown>;
  if (Object.keys(root).some((key) => !["host", "projectId", "mergeRequestIid"].includes(key))) {
    fail("invalid-shape");
  }
  if (
    !Object.hasOwn(root, "host") ||
    !Object.hasOwn(root, "projectId") ||
    !Object.hasOwn(root, "mergeRequestIid")
  ) {
    fail("invalid-shape");
  }
  const host = root.host;
  if (
    typeof host !== "string" ||
    host !== host.normalize("NFC") ||
    !HOST.test(host) ||
    host.includes("/")
  ) {
    fail("invalid-value");
  }
  const projectId = positiveInteger(root.projectId);
  const mergeRequestIid = positiveInteger(root.mergeRequestIid);
  return `gitlab-mr:v1:host=${host}:project=${projectId}:mr=${mergeRequestIid}`;
}

/** Digest a GitLab MR locator without retaining the canonical text in the record. */
export function digestGitlabMrReviewLocator(input: GitlabMrReviewLocatorInputV1): string {
  return digestExternalInputLocator(canonicalGitlabMrReviewLocator(input));
}
