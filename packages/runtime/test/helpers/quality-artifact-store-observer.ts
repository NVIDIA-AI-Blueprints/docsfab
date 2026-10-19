// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Test-only, bounded observation of the fixture's real quality artifact store. */
import { ArtifactStoreError } from "../../src/artifacts/store.js";
import { RunMaintenanceGateError } from "../../src/records/run-maintenance-gate.js";

type Kind = "evaluation" | "quality-score" | "candidate-report" | "final-report" | "unknown";
type Operation = "putRecord" | "getRecord";
type ErrorClass = "RunMaintenanceGateError" | "ArtifactStoreError" | "SyscallError" | "unknown";

export interface ObservedRecordStore {
  putRecord(digest: string, value: unknown): Promise<unknown>;
  getRecord(digest: string): Promise<unknown>;
}

const KINDS: readonly Kind[] = [
  "evaluation",
  "quality-score",
  "candidate-report",
  "final-report",
  "unknown",
];
const OPERATIONS: readonly Operation[] = ["putRecord", "getRecord"];
const STORE_CODES = new Set([
  "invalid-digest",
  "unsafe-path",
  "not-found",
  "symlink",
  "invalid-node",
  "insecure-permissions",
  "owner-mismatch",
  "artifact-too-large",
  "artifacts-max-object-bytes-bound",
  "invalid-json",
  "invalid-artifact",
  "integrity-mismatch",
]);
const GATE_CODES = new Set(["held", "unsafe", "tombstoned", "object-deleted"]);
const SYSCALL_CODES = new Set([
  "EACCES",
  "EPERM",
  "ENOENT",
  "EEXIST",
  "ENOTDIR",
  "EMFILE",
  "ENOSPC",
  "ETIMEDOUT",
]);

function kindOf(value: unknown): Kind {
  try {
    if (value === null || typeof value !== "object") return "unknown";
    const kind = (value as { artifactKind?: unknown }).artifactKind;
    return typeof kind === "string" && KINDS.includes(kind as Kind) && kind !== "unknown"
      ? (kind as Kind)
      : "unknown";
  } catch {
    return "unknown";
  }
}

function closedError(error: unknown): { class: ErrorClass; code: string } {
  try {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (error instanceof RunMaintenanceGateError) {
      return {
        class: "RunMaintenanceGateError",
        code: typeof code === "string" && GATE_CODES.has(code) ? code : "unknown",
      };
    }
    if (error instanceof ArtifactStoreError) {
      return {
        class: "ArtifactStoreError",
        code: typeof code === "string" && STORE_CODES.has(code) ? code : "unknown",
      };
    }
    if (typeof code === "string" && SYSCALL_CODES.has(code)) {
      return { class: "SyscallError", code };
    }
  } catch {
    // An accessor or proxy may throw while inspected. Never replace the original error.
  }
  return { class: "unknown", code: "unknown" };
}

interface MutableCount {
  kind: Kind;
  operation: Operation;
  returned: number;
  threw: number;
  nullReadback: number;
  undefinedReadback: number;
  errors: Map<string, number>;
}

/** Snapshot contains only fixed kind/operation rows and closed error labels. */
export function observeQualityArtifactStore(store: ObservedRecordStore): {
  summary: () => readonly {
    kind: Kind;
    operation: Operation;
    returned: number;
    threw: number;
    nullReadback: number;
    undefinedReadback: number;
    errors: readonly { class: ErrorClass; code: string; count: number }[];
  }[];
  restore: () => void;
} {
  const originalPutRecord = store.putRecord;
  const originalGetRecord = store.getRecord;
  const kindsByDigest = new Map<string, Kind>();
  const counts = new Map<string, MutableCount>();
  for (const kind of KINDS) {
    for (const operation of OPERATIONS) {
      counts.set(`${kind}:${operation}`, {
        kind,
        operation,
        returned: 0,
        threw: 0,
        nullReadback: 0,
        undefinedReadback: 0,
        errors: new Map(),
      });
    }
  }
  const row = (kind: Kind, operation: Operation) => counts.get(`${kind}:${operation}`)!;
  const failed = (count: MutableCount, error: unknown) => {
    count.threw += 1;
    const label = closedError(error);
    const key = `${label.class}:${label.code}`;
    count.errors.set(key, (count.errors.get(key) ?? 0) + 1);
  };

  store.putRecord = async function (this: ObservedRecordStore, digest, value) {
    const kind = kindOf(value);
    kindsByDigest.set(digest, kind);
    const count = row(kind, "putRecord");
    try {
      const result = await originalPutRecord.call(this, digest, value);
      count.returned += 1;
      return result;
    } catch (error) {
      failed(count, error);
      throw error;
    }
  };
  store.getRecord = async function (this: ObservedRecordStore, digest) {
    const kind = kindsByDigest.get(digest) ?? "unknown";
    const count = row(kind, "getRecord");
    try {
      const result = await originalGetRecord.call(this, digest);
      if (result === null) count.nullReadback += 1;
      else if (result === undefined) count.undefinedReadback += 1;
      else count.returned += 1;
      return result;
    } catch (error) {
      failed(count, error);
      throw error;
    }
  };

  return {
    summary: () =>
      [...counts.values()]
        .filter(
          (count) => count.returned || count.threw || count.nullReadback || count.undefinedReadback,
        )
        .map((count) => ({
          kind: count.kind,
          operation: count.operation,
          returned: count.returned,
          threw: count.threw,
          nullReadback: count.nullReadback,
          undefinedReadback: count.undefinedReadback,
          errors: [...count.errors.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => {
              const [errorClass, code] = key.split(":");
              return { class: errorClass as ErrorClass, code: code!, count: value };
            }),
        })),
    restore: () => {
      store.putRecord = originalPutRecord;
      store.getRecord = originalGetRecord;
    },
  };
}
