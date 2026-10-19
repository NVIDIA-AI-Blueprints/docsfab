// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";

import { createContractKit } from "../contract-kit/index.js";
import { limit, limitDefinition, OperationalLimitError, refuseLimit } from "../config/limits.js";
import { untrustedChildEnvironment } from "../security/child-process-environment.js";
import { isGrepFailureKind, type GrepFailureKind } from "./grep-failure.js";

export interface CredentialSafeGrepGrants {
  readonly workspaceRoot: string;
  readonly governedSkill?: { readonly id: string; readonly root: string };
  readonly governedQualityRoot?: string;
}

export type CredentialSafeGrepTransportFailure =
  | { readonly kind: "grep"; readonly grepFailureKind: GrepFailureKind }
  | { readonly kind: "denied-path" }
  | { readonly kind: "recoverable-miss" }
  | {
      readonly kind: "cleanup-timeout";
      readonly groupId: number;
      readonly scope: string;
      readonly limitRefusal: OperationalLimitError;
    }
  | { readonly kind: "tool-defect" };

export class CredentialSafeGrepTransportError extends Error {
  public constructor(
    public readonly failure: CredentialSafeGrepTransportFailure,
    public readonly phase?:
      | "abort"
      | "framing"
      | "worker-result"
      | "worker-exit"
      | "transport"
      | "cleanup",
  ) {
    super("Credential-safe grep worker reported a classified failure.");
    this.name = "CredentialSafeGrepTransportError";
  }
}

const kit = createContractKit({
  fail(code: "invalid-shape" | "invalid-value"): never {
    throw new Error(
      "Credential-safe grep transport refused because its framing or content is invalid.",
    );
  },
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "invalid-shape",
    credentialMaterial: "invalid-shape",
    schemaMismatch: "invalid-shape",
  },
  inertMode: "strict",
});

type PiGrepResult = Awaited<ReturnType<ReturnType<typeof createGrepToolDefinition>["execute"]>>;

type GrepWorkerResult =
  | {
      readonly kind: "success";
      readonly result: PiGrepResult;
    }
  | { readonly kind: "failure"; readonly failure: CredentialSafeGrepTransportFailure };

export function createCredentialSafeGrepDefinition(cwd: string, grants: CredentialSafeGrepGrants) {
  const definition = createGrepToolDefinition(cwd);
  const workerUrl = import.meta.resolve("./credential-safe-grep-worker.js");
  const args: string[] = [];
  if (import.meta.url.endsWith(".ts")) args.push("--import", import.meta.resolve("tsx"));
  args.push(
    "--input-type=module",
    "-e",
    "import(" + JSON.stringify(workerUrl) + ").then(m => m.runCredentialSafeGrepWorker())",
  );
  const isolated: typeof definition = {
    ...definition,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) throw new CredentialSafeGrepTransportError({ kind: "tool-defect" });
      const id = randomUUID();
      const request = {
        schemaVersion: 1,
        type: "request",
        id,
        cwd: grants.workspaceRoot,
        grants,
        params,
      };
      validateRequest(request);
      const child = spawn(process.execPath, args, {
        cwd,
        env: untrustedChildEnvironment(process.env),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      if (!child.pid || process.platform === "win32") {
        child.kill("SIGKILL");
        throw new CredentialSafeGrepTransportError({ kind: "tool-defect" });
      }
      const groupId = child.pid;
      const cleanupBound = limit("execution.grepGroupCleanupMs");
      const cleanupMs = cleanupBound.value;
      const cleanupScope = limitDefinition(cleanupBound.name).scope;
      const pollMs = limit("execution.grepGroupPollMs").value;
      let stdout = Buffer.alloc(0);
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      let groupAbsent = false;
      let responseReceived = false;
      let aborted = Boolean(signal?.aborted);
      let stopping: Promise<void> | undefined;
      let onSignalAbort: (() => void) | undefined;
      let cleanupStartedAt: number | undefined;
      let cleanupDeadline: number | undefined;
      const deadline = (): number => {
        if (cleanupDeadline === undefined) {
          cleanupStartedAt = Date.now();
          cleanupDeadline = cleanupStartedAt + cleanupMs;
        }
        return cleanupDeadline;
      };
      const cleanupTimeout = (): CredentialSafeGrepTransportError => {
        deadline();
        const observedMs = Date.now() - cleanupStartedAt!;
        try {
          refuseLimit(cleanupBound, observedMs);
        } catch (error) {
          if (!(error instanceof OperationalLimitError)) throw error;
          return new CredentialSafeGrepTransportError(
            { kind: "cleanup-timeout", groupId, scope: cleanupScope, limitRefusal: error },
            "cleanup",
          );
        }
      };
      const stopGroup = (allowCooperativeStop = false): Promise<void> => {
        if (stopping) return stopping;
        stopping = (async () => {
          const stopBy = deadline();
          if (groupAbsent) return;
          // Let the exact abort frame reach the isolated worker first. The
          // worker forwards the signal to Pi's grep process; a still-live
          // owned group then receives the hard stop below.
          if (allowCooperativeStop) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          if (!processGroupExists(groupId)) {
            groupAbsent = true;
            if (Date.now() > stopBy) throw cleanupTimeout();
            return;
          }
          try {
            process.kill(-groupId, "SIGKILL");
          } catch (error) {
            if (!isNoSuchProcess(error)) throw error;
            groupAbsent = true;
            return;
          }
          while (!groupAbsent) {
            if (!processGroupExists(groupId)) groupAbsent = true;
            else {
              const remaining = stopBy - Date.now();
              if (remaining <= 0) throw cleanupTimeout();
              await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
            }
          }
          const remaining = stopBy - Date.now();
          if (remaining <= 0) throw cleanupTimeout();
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              closed,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(cleanupTimeout()), remaining);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        })();
        return stopping;
      };
      const onAbort = (): void => {
        aborted = true;
        child.stdin?.write(JSON.stringify({ schemaVersion: 1, type: "abort", id }) + "\n");
        void stopGroup(true).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = new Promise<unknown>((resolve, reject) => {
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
            const newline = stdout.indexOf(0x0a);
            if (newline < 0) return;
            if (responseReceived) {
              reject(new Error("invalid grep worker framing"));
              return;
            }
            responseReceived = true;
            resolve(undefined);
          });
          child.once("close", () => {
            if (!responseReceived)
              reject(new CredentialSafeGrepTransportError({ kind: "tool-defect" }, "worker-exit"));
          });
        });
        await new Promise<void>((resolve, reject) => {
          child.stdin?.once("error", reject);
          child.stdin?.write(JSON.stringify(request) + "\n", (error) =>
            error ? reject(error) : resolve(),
          );
        });
        await Promise.race([
          response,
          new Promise<never>((_resolve, reject) => {
            onSignalAbort = () =>
              reject(new CredentialSafeGrepTransportError({ kind: "tool-defect" }, "abort"));
            signal?.addEventListener("abort", onSignalAbort, { once: true });
          }),
        ]);
        if (aborted || signal?.aborted)
          throw new CredentialSafeGrepTransportError({ kind: "tool-defect" }, "abort");
        const newline = stdout.indexOf(0x0a);
        if (
          newline < 0 ||
          stdout.lastIndexOf(0x0a) !== newline ||
          newline !== stdout.byteLength - 1
        ) {
          throw new CredentialSafeGrepTransportError({ kind: "tool-defect" }, "framing");
        }
        let workerResult: GrepWorkerResult;
        try {
          workerResult = parseResponse(
            JSON.parse(stdout.subarray(0, newline).toString("utf8")),
            id,
          );
        } catch {
          throw new CredentialSafeGrepTransportError({ kind: "tool-defect" }, "framing");
        }
        // A valid result is only the first half of normal completion. Closing
        // stdin lets the worker finish its control monitor and reap rg before
        // the parent checks for any remaining process-group descendants.
        const stopBy = deadline();
        child.stdin?.end();
        let timer: NodeJS.Timeout | undefined;
        let workerClose: { code: number | null; signal: NodeJS.Signals | null };
        try {
          workerClose = await Promise.race([
            closed,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(cleanupTimeout()), Math.max(0, stopBy - Date.now()));
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (Date.now() > stopBy) throw cleanupTimeout();
        await stopGroup();
        if (aborted || signal?.aborted)
          throw new CredentialSafeGrepTransportError({ kind: "tool-defect" }, "abort");
        if (workerClose.code !== 0 || workerClose.signal !== null)
          throw new CredentialSafeGrepTransportError({ kind: "tool-defect" }, "worker-exit");
        if (stdout.lastIndexOf(0x0a) !== newline || newline !== stdout.byteLength - 1)
          throw new CredentialSafeGrepTransportError({ kind: "tool-defect" }, "framing");
        if (workerResult.kind === "failure")
          throw new CredentialSafeGrepTransportError(workerResult.failure, "worker-result");
        return workerResult.result;
      } catch (error) {
        if (error instanceof CredentialSafeGrepTransportError) throw error;
        await stopGroup();
        throw new CredentialSafeGrepTransportError({ kind: "tool-defect" }, "transport");
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (onSignalAbort) signal?.removeEventListener("abort", onSignalAbort);
        if (!groupAbsent) await stopGroup();
        child.stdin?.removeAllListeners();
      }
    },
  };
  return isolated;
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    throw error;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}

function validateRequest(value: unknown): void {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "type", "id", "cwd", "grants", "params"]);
  if (
    root.schemaVersion !== 1 ||
    root.type !== "request" ||
    typeof root.id !== "string" ||
    !root.id ||
    typeof root.cwd !== "string"
  ) {
    throw new Error(
      "Credential-safe grep request could not be validated against its wire contract.",
    );
  }
  const grants = kit.object(root.grants);
  kit.exact(
    grants,
    ["workspaceRoot", "governedSkill", "governedQualityRoot"],
    ["governedSkill", "governedQualityRoot"],
  );
  if (grants.workspaceRoot !== root.cwd)
    throw new Error("Credential-safe grep grants do not match the approved workspace root.");
  if (grants.governedSkill !== undefined) {
    const skill = kit.object(grants.governedSkill);
    kit.exact(skill, ["id", "root"]);
    if (typeof skill.id !== "string" || typeof skill.root !== "string")
      throw new Error("Credential-safe grep governed skill grant could not be validated safely.");
  }
  if (grants.governedQualityRoot !== undefined && typeof grants.governedQualityRoot !== "string") {
    throw new Error("Credential-safe grep governed quality grant could not be validated safely.");
  }
  const params = kit.object(root.params);
  kit.exact(
    params,
    ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
    ["path", "glob", "ignoreCase", "literal", "context", "limit"],
  );
  if (typeof params.pattern !== "string")
    throw new Error(
      "Credential-safe grep pattern could not be validated against its request contract.",
    );
}

function parseResponse(value: unknown, id: string): GrepWorkerResult {
  const root = asJsonRecord(value);
  kit.exact(root, ["schemaVersion", "type", "id", "outcome"]);
  if (root.schemaVersion !== 1 || root.type !== "result" || root.id !== id)
    throw new Error(
      "Credential-safe grep response correlation could not be validated against its request.",
    );
  const outcome = asJsonRecord(root.outcome);
  if (outcome.kind === "success") {
    kit.exact(outcome, ["kind", "result"]);
    validateGrepResult(outcome.result);
    return {
      kind: "success",
      result: outcome.result as PiGrepResult,
    };
  }
  kit.exact(outcome, ["kind", "failure"]);
  if (outcome.kind !== "failure")
    throw new Error(
      "Credential-safe grep worker outcome could not be validated against its response contract.",
    );
  const failure = asJsonRecord(outcome.failure);
  if (failure.kind === "grep") {
    kit.exact(failure, ["kind", "grepFailureKind"]);
    if (!isGrepFailureKind(failure.grepFailureKind))
      throw new Error(
        "Credential-safe grep failure kind could not be validated against its typed response contract.",
      );
    return {
      kind: "failure",
      failure: { kind: "grep", grepFailureKind: failure.grepFailureKind },
    };
  }
  kit.exact(failure, ["kind"]);
  if (
    failure.kind === "denied-path" ||
    failure.kind === "recoverable-miss" ||
    failure.kind === "tool-defect"
  ) {
    return { kind: "failure", failure: { kind: failure.kind } };
  }
  throw new Error(
    "Credential-safe grep failure category could not be validated against its typed response contract.",
  );
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Credential-safe grep transport frame could not be validated as a JSON record.",
    );
  return value as Record<string, unknown>;
}

function validateGrepResult(value: unknown): void {
  const result = asJsonRecord(value);
  kit.exact(result, ["content", "details", "isError"], ["details", "isError"]);
  if (!Array.isArray(result.content))
    throw new Error(
      "Credential-safe grep result could not be validated against its response contract.",
    );
  for (const item of result.content) {
    const content = asJsonRecord(item);
    if (content.type !== "text" || typeof content.text !== "string")
      throw new Error(
        "Credential-safe grep content item could not be validated as plain text output.",
      );
    kit.exact(content, ["type", "text"]);
  }
  if (result.isError !== undefined && typeof result.isError !== "boolean")
    throw new Error("Credential-safe grep result flag could not be validated as a boolean value.");
}
