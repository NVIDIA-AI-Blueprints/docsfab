// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab auto --once` command wiring. Reuses the read-only assessment for the
 * bound request and decision, then runs the one-cycle orchestrator with
 * production host authorities. The decision already carries every write
 * binding, so one `--confirm-cycle` authorizes the whole bound cycle.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  projectAutoGatePresentation,
  projectAutoOncePresentation,
  renderAdvancedPresentation,
} from "../cli/advanced-presentation.js";

import type { RunRecord } from "../records/contracts.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { resolveDocsFabConfigurationRoot } from "../config/host-paths.js";
import { ensurePrivateRunDirectory } from "../records/file-store.js";
import type { RunArguments } from "../cli.js";
import { assessAutoDryRunHost } from "./dry-run-host.js";
import type { AutoDryRunCliArguments, AutoDryRunHostAssessmentV1 } from "./dry-run-cli.js";
import type { AutoValidationResultV1 } from "./contracts.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import {
  createHostAuthorityCycleMint,
  createHostAuthorityLineageMint,
  runAutoCycleOnce,
  type AutoCycleOnceConfirmationV1,
  type AutoCycleOnceExecuteInputV1,
  type AutoCycleOnceRecordV1,
} from "./once.js";

export interface AutoOnceCliArguments {
  repositoryPath: string;
  revision: string;
  targetBranch?: string;
  confirmCycle: boolean;
  authorityId: string;
  json: boolean;
}

export interface AutoOnceCliDependencies {
  cwd: string;
  log(message: string): void;
  now?(): Date;
  assess?(args: AutoDryRunCliArguments): Promise<AutoDryRunHostAssessmentV1>;
  runWorkflow?(request: RunArguments): Promise<RunRecord | undefined>;
  save?(record: AutoCycleOnceRecordV1): Promise<void>;
}

const SAFE_AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

export function parseAutoOnceCliArguments(
  args: readonly string[],
  cwd: string,
): AutoOnceCliArguments {
  if (args[0] !== "--once") {
    throw new Error(
      "The auto --once command requires the --once mode selector as its first argument.",
    );
  }
  const values = new Map<string, string>();
  let json = false;
  let confirmCycle = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      if (json)
        throw new Error(
          "The auto --once command received a duplicated --json option flag argument.",
        );
      json = true;
      continue;
    }
    if (argument === "--confirm-cycle") {
      if (confirmCycle)
        throw new Error(
          "The auto --once command received a duplicated --confirm-cycle option flag argument.",
        );
      confirmCycle = true;
      continue;
    }
    if (!["--repo", "--revision", "--target-branch", "--authority-id"].includes(argument)) {
      throw new Error(
        "The auto --once command received an unrecognized command line option named " +
          argument +
          ".",
      );
    }
    if (values.has(argument))
      throw new Error(
        "The auto --once command received a duplicated command line option named " + argument + ".",
      );
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(
        "The auto --once option " + argument + " requires an adjacent non-option value argument.",
      );
    values.set(argument, value);
    index += 1;
  }
  const revision = values.get("--revision") ?? "HEAD";
  if (
    revision.includes("\\0") ||
    revision.length === 0 ||
    revision.length > 512 ||
    revision.startsWith("-")
  )
    throw new Error(
      "The auto --once command received an invalid or unsafe --revision value argument.",
    );
  const authorityId =
    values.get("--authority-id") ?? process.env.DOCSFAB_OPERATOR_AUTHORITY_ID ?? "local-operator";
  if (!SAFE_AUTHORITY.test(authorityId)) {
    throw new Error("auto --once received an unsafe operator --authority-id value.");
  }
  const targetBranch = values.get("--target-branch");
  return {
    repositoryPath: resolve(cwd, values.get("--repo") ?? "."),
    revision,
    ...(targetBranch === undefined ? {} : { targetBranch }),
    confirmCycle,
    authorityId,
    json,
  };
}

async function defaultSaveOnceRecord(record: AutoCycleOnceRecordV1): Promise<void> {
  const directory = resolve(resolveDocsFabConfigurationRoot(), ".docsfab", "auto-cycles");
  await ensurePrivateRunDirectory(directory);
  const safeName = record.cycleId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 200);
  const destination = resolve(directory, `${safeName || "cycle"}.json`);
  const bytes = Buffer.from(
    `${canonicalizeJsonEvidence(record as unknown as JsonEvidenceValue)}\n`,
    "utf8",
  );
  const handle = await open(
    destination,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateRun(record: RunRecord, ids: readonly string[]): AutoValidationResultV1[] {
  return ids.map((id) =>
    record.status === "succeeded"
      ? {
          id,
          status: "passed" as const,
          evidenceSha256: canonicalDigest({
            kind: "docsfab-auto-once-validation",
            id,
            runId: record.id,
            workflow: record.workflow,
          }),
        }
      : { id, status: "not-run" as const, evidenceSha256: null },
  );
}

export async function runAutoOnceCli(
  args: readonly string[],
  dependencies: AutoOnceCliDependencies,
): Promise<void> {
  const arguments_ = parseAutoOnceCliArguments(args, dependencies.cwd);
  const assess = dependencies.assess ?? assessAutoDryRunHost;
  const runWorkflow = dependencies.runWorkflow;
  if (!runWorkflow) {
    throw new Error("auto --once requires an authorized workflow executor dependency.");
  }
  const now = dependencies.now ?? (() => new Date());
  const save = dependencies.save ?? defaultSaveOnceRecord;
  const assessment = await assess({
    mode: "dry-run",
    repositoryPath: arguments_.repositoryPath,
    revision: arguments_.revision,
    ...(arguments_.targetBranch === undefined ? {} : { targetBranch: arguments_.targetBranch }),
    json: arguments_.json,
  });
  try {
    if (assessment.status === "needs-input") {
      dependencies.log(
        arguments_.json
          ? `auto --once needs input: ${assessment.input.reasonCode}; no write performed.`
          : renderAdvancedPresentation(projectAutoGatePresentation("once", assessment)),
      );
      if (arguments_.json) {
        for (const id of assessment.input.openInputIds) dependencies.log(`  open-input: ${id}`);
      }
      return;
    }
    const source = assessment.source;
    if (!arguments_.confirmCycle) {
      dependencies.log(
        arguments_.json
          ? `auto --once proposal: ${source.decision.disposition}; ` +
              "re-run with --confirm-cycle to authorize one bounded documentation cycle."
          : renderAdvancedPresentation(projectAutoGatePresentation("once", assessment)),
      );
      return;
    }
    const confirmation: AutoCycleOnceConfirmationV1 = {
      authorityId: arguments_.authorityId,
      operatorIdentitySha256: createHash("sha256").update(arguments_.authorityId).digest("hex"),
      affirmed: true,
    };
    const outcome = await runAutoCycleOnce(
      {
        request: source.request,
        assessment: source.assessment,
        decision: source.decision,
        repository: {
          identitySha256: source.request.repository.identitySha256,
          revision: source.request.repository.revision,
        },
      },
      {
        now,
        confirmation,
        mintCycle: createHostAuthorityCycleMint(now),
        mintLineage: createHostAuthorityLineageMint(now),
        execute: (input: AutoCycleOnceExecuteInputV1) =>
          executeOne(input, arguments_, source.request.repository.revision, runWorkflow),
        validate: async (record, ids) => validateRun(record, ids),
        save,
      },
    );
    const rendered = arguments_.json
      ? canonicalizeJsonEvidence(outcome.record as unknown as JsonEvidenceValue)
      : renderAdvancedPresentation(projectAutoOncePresentation(outcome.record));
    dependencies.log(rendered);
  } finally {
    await assessment.dispose();
  }
}

async function executeOne(
  input: AutoCycleOnceExecuteInputV1,
  arguments_: AutoOnceCliArguments,
  revision: string,
  runWorkflow: NonNullable<AutoOnceCliDependencies["runWorkflow"]>,
): Promise<RunRecord> {
  const record = await runWorkflow({
    workflow: input.workflow,
    repositoryPath: arguments_.repositoryPath,
    revision,
    allowWrite: input.allowWrite,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    taskLineage: input.taskLineage,
  });
  if (!record) throw new Error("auto --once workflow execution produced no run record.");
  return record;
}
