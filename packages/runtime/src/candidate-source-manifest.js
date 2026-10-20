// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

export const CANDIDATE_SOURCE_STATUSES = ["added", "modified", "deleted", "renamed"];

/** Canonical C..H source manifest shared by host admission and runtime review assembly. */
export function normalizeCandidateSourceManifestV1(value, hooks) {
  assertInert(value, hooks.fail);
  hooks.rejectCredentials(value);
  if (!Array.isArray(value) || value.length < 1 || value.length > 512) hooks.fail("invalid-shape");
  const changes = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      hooks.fail("invalid-shape");
    const keys = ["path", "status", "previousPath"];
    if (
      Object.keys(candidate).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(candidate, key))
    )
      hooks.fail("invalid-shape");
    const path = safePath(candidate.path, hooks.fail);
    if (
      typeof candidate.status !== "string" ||
      !CANDIDATE_SOURCE_STATUSES.includes(candidate.status)
    )
      hooks.fail("invalid-value");
    const previousPath =
      candidate.previousPath === null ? null : safePath(candidate.previousPath, hooks.fail);
    if ((candidate.status === "renamed") !== (previousPath !== null) || previousPath === path)
      hooks.fail("invalid-value");
    return Object.freeze({ path, status: candidate.status, previousPath });
  });
  if (new Set(changes.map(({ path }) => path)).size !== changes.length) hooks.fail("invalid-value");
  return freezeDeep([...changes].sort((left, right) => left.path.localeCompare(right.path)));
}

export function candidateSourceManifestSha256V1(value, hooks) {
  return createHash("sha256")
    .update(canonicalJson(normalizeCandidateSourceManifestV1(value, hooks)))
    .digest("hex");
}

function safePath(value, fail) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail("invalid-value");
  return value;
}

function assertInert(value, fail) {
  let nodes = 0;
  const active = new Set();
  const visit = (candidate, depth) => {
    nodes += 1;
    if (nodes > 10_000 || depth > 16) fail("invalid-shape");
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "string") {
      if (candidate.length > 512) fail("invalid-value");
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || !Number.isSafeInteger(candidate)) fail("invalid-value");
      return;
    }
    if (
      candidate === undefined ||
      typeof candidate !== "object" ||
      nodeUtilTypes.isProxy(candidate) ||
      active.has(candidate)
    )
      fail("invalid-shape");
    const array = Array.isArray(candidate);
    const proto = Object.getPrototypeOf(candidate);
    if (
      (array && proto !== Array.prototype) ||
      (!array && proto !== Object.prototype && proto !== null)
    )
      fail("invalid-shape");
    active.add(candidate);
    const keys = Reflect.ownKeys(candidate);
    if (
      keys.some((key) => typeof key !== "string") ||
      (array && keys.length !== candidate.length + 1)
    )
      fail("invalid-shape");
    for (const key of keys) {
      if (key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("invalid-shape");
      visit(descriptor.value, depth + 1);
    }
    active.delete(candidate);
  };
  visit(value, 0);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}
