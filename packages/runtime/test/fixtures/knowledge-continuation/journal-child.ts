// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { access, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { inspectProcessBirth, requireProcessBirthIdentity } from "../../../src/init/storage.js";
import { canonicalDigest } from "../../../src/contract-kit/index.js";
import {
  KnowledgeContinuationAttemptStore,
  type KnowledgeContinuationClaimResult,
  type KnowledgeContinuationProcessIdentityV1,
} from "../../../src/records/knowledge-continuation-store.js";

const root = required("DOCSFAB_JOURNAL_ROOT");
const originalRunId = required("DOCSFAB_JOURNAL_ORIGINAL");
const snapshotSha256 = required("DOCSFAB_JOURNAL_SNAPSHOT");
const deliveryIntentSha256 = process.env.DOCSFAB_JOURNAL_DELIVERY ?? "c".repeat(64);
const childRunId = required("DOCSFAB_JOURNAL_CHILD");
const ready = required("DOCSFAB_JOURNAL_READY");
const go = required("DOCSFAB_JOURNAL_GO");
const release = process.env.DOCSFAB_JOURNAL_RELEASE;
const staleObserved = process.env.DOCSFAB_JOURNAL_STALE_OBSERVED;
const staleRelease = process.env.DOCSFAB_JOURNAL_STALE_RELEASE;
const action = process.env.DOCSFAB_JOURNAL_ACTION ?? "claim";
// Deadline for each wait below on a file the parent test writes. The parent
// (knowledge-continuation-store.test.ts) derives it from its enclosing case
// budget through nestedDeadlineMs() and always passes it, so this fixture
// holds no budget of its own. A value that is not a positive integer would
// make the deadline never fire, so it is refused here by name.
const waitTimeoutSetting = required("DOCSFAB_JOURNAL_WAIT_TIMEOUT_MS");
const waitTimeoutMilliseconds = Number(waitTimeoutSetting);
if (!Number.isSafeInteger(waitTimeoutMilliseconds) || waitTimeoutMilliseconds <= 0) {
  throw new Error(
    `DOCSFAB_JOURNAL_WAIT_TIMEOUT_MS must be a positive integer millisecond budget, received ${waitTimeoutSetting}`,
  );
}

const owner: KnowledgeContinuationProcessIdentityV1 = {
  pid: process.pid,
  processBirthIdentity: processIdentity(process.pid),
};
const store = new KnowledgeContinuationAttemptStore(root, { inspect: inspectJournalProcess });
if (staleObserved && staleRelease) {
  const originalRead = store.read.bind(store);
  let firstRead = true;
  store.read = async (id: string) => {
    const result = await originalRead(id);
    if (firstRead) {
      firstRead = false;
      await writeFile(staleObserved, "read-complete\n", { mode: 0o600 });
      await waitFor(staleRelease);
    }
    return result;
  };
}

await writeFile(
  ready,
  `${JSON.stringify({ pid: owner.pid, identity: owner.processBirthIdentity })}\n`,
  {
    mode: 0o600,
  },
);
await waitFor(go);

if (action === "crash-before-publication") {
  await writeFile(join(root, `.${originalRunId}.${randomUUID()}.tmp`), "partial-attempt\n", {
    mode: 0o600,
  });
  process.kill(process.pid, "SIGKILL");
}
if (action === "restrictive-umask") process.umask(0o777);

try {
  const claim = await store.claim({
    originalRunId,
    snapshotSha256,
    deliveryIntentSha256,
    childRunId,
    owner,
    attemptId: process.env.DOCSFAB_JOURNAL_ATTEMPT,
  });
  const result: {
    kind: "result";
    claim: KnowledgeContinuationClaimResult;
    transitions?: string[];
    descendantPid?: number;
  } = { kind: "result", claim };

  if (claim.disposition === "claimed" && action !== "claim") {
    const transitions: string[] = [];
    if (action === "restrictive-umask") {
      const failed = await store.transition({
        originalRunId,
        attemptId: claim.attempt.attemptId,
        owner,
        phase: "failed-before-execution",
      });
      transitions.push(failed.phase);
    }
    if (action === "executing" || action === "descendant" || action === "writer-completed") {
      const executing = await store.transition({
        originalRunId,
        attemptId: claim.attempt.attemptId,
        owner,
        phase: "executing",
      });
      transitions.push(executing.phase);
    }
    if (action === "writer-completed") {
      const completed = await store.transition({
        originalRunId,
        attemptId: claim.attempt.attemptId,
        owner,
        phase: "writer-completed",
        childRecordSha256: "b".repeat(64),
      });
      transitions.push(completed.phase);
    }
    if (action === "settled") {
      const executing = await store.transition({
        originalRunId,
        attemptId: claim.attempt.attemptId,
        owner,
        phase: "executing",
      });
      const completed = await store.transition({
        originalRunId,
        attemptId: executing.attemptId,
        owner,
        phase: "writer-completed",
        childRecordSha256: "b".repeat(64),
      });
      const settled = await store.transition({
        originalRunId,
        attemptId: completed.attemptId,
        owner,
        phase: "delivery-settled",
        childRecordSha256: completed.childRecordSha256 ?? undefined,
        deliveryResult: (() => {
          const body = {
            status: "settled" as const,
            intentSha256: deliveryIntentSha256,
            locator: null,
            publisherResultArtifactSha256: null,
            publisherIdempotencyKey: null,
          };
          return { ...body, resultSha256: canonicalDigest(body) };
        })(),
      });
      transitions.push(executing.phase, completed.phase, settled.phase);
    }
    if (action === "descendant") {
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      descendant.unref();
      result.descendantPid = descendant.pid;
    }
    result.transitions = transitions;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (release && claim.disposition === "claimed") await waitFor(release);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

/**
 * Polls every 5 ms for a file the parent test writes. Without the deadline, a
 * parent that never wrote `go` or `release` (a test bug, or a parent that died
 * without cleanup) left this child polling forever.
 */
async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + waitTimeoutMilliseconds;
  for (;;) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `journal-child timed out after ${waitTimeoutMilliseconds}ms waiting for ${path}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function processIdentity(pid: number): string {
  try {
    return requireProcessBirthIdentity(pid);
  } catch {
    // Darwin's restricted test runner may expose liveness but not ps output.
    return createHash("sha256").update(`docsfab-journal-child:${pid}`).digest("hex");
  }
}

function inspectJournalProcess(pid: number): { alive: boolean; identity?: string } {
  const observed = inspectProcessBirth(pid);
  return observed.alive && !observed.identity
    ? { alive: true, identity: processIdentity(pid) }
    : observed;
}
