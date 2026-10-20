// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Init planning / orchestration seam.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { resolveDocsFabConfigurationRoot } from "../config/host-paths.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  allocateDocsFabPrivateRoots,
  applyInitialization,
  projectConfigBytes,
  readExistingConfig,
} from "./apply.js";
import {
  applySuccessNextActions,
  checkSharedDoctor,
  checkSharedProductDoctor,
  inspectHostProvider,
  nextActions,
  normalizeDoctorStatus,
} from "./doctor-bridge.js";
import {
  applyPrivateGitignorePlan,
  assertPrivateGitignorePlanCurrent,
  inspectPrivateGitignorePlan,
  type GitignoreAppendResult,
} from "./gitignore.js";
import {
  captureRepositoryApprovalIdentity,
  discoverRepository,
  inspectGitLab,
  selectCanonicalRemote,
} from "./gitlab-probe.js";
import { assertDocsFabProjectConfig, resolveDocsFabPrivateRoots } from "./project-config.js";
import { formatInitResult, formatDocsFabInitPlan, serializeDocsFabInitPlan } from "./render.js";
import { captureConfigurationRoot } from "./storage.js";
import {
  ExecInitCommandRunner,
  assertSafeRemoteName,
  logSafe,
  assertCredentialFree,
} from "./shared.js";
import {
  SHA256,
  type InitDoctorStatus,
  type DocsFabInitArguments,
  type DocsFabInitDependencies,
  type DocsFabInitPlan,
  type DocsFabInitPrompt,
  type DocsFabProjectConfigV1,
} from "./types.js";

export function parseDocsFabInitArguments(
  args: readonly string[],
  cwd: string,
): DocsFabInitArguments {
  const flags = new Set(["--non-interactive", "--apply", "--json"]);
  const valueOptions = new Set(["--repo", "--remote", "--approve-plan-sha256"]);
  const seenFlags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (flags.has(argument)) {
      if (seenFlags.has(argument))
        throw new Error(`init option "${argument}" must not be duplicated.`);
      seenFlags.add(argument);
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error("Unknown init option.");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (values.has(argument)) throw new Error(`init option "${argument}" must not be duplicated.`);
    values.set(argument, value);
    index += 1;
  }
  const remote = values.get("--remote");
  if (remote !== undefined)
    assertSafeRemoteName(remote, "--remote requires one safe Git remote name.");
  const approvePlanSha256 = values.get("--approve-plan-sha256");
  if (approvePlanSha256 !== undefined && !SHA256.test(approvePlanSha256)) {
    throw new Error("--approve-plan-sha256 requires one lowercase SHA-256 digest.");
  }
  const apply = seenFlags.has("--apply");
  if (apply !== Boolean(approvePlanSha256)) {
    throw new Error(
      "Prompt-free init mutation requires --apply and --approve-plan-sha256 together.",
    );
  }
  if (seenFlags.has("--json") && !seenFlags.has("--non-interactive")) {
    throw new Error(
      "init --json requires --non-interactive so prompts cannot corrupt JSON output.",
    );
  }
  return {
    repositoryPath: resolve(cwd, values.get("--repo") ?? "."),
    ...(remote ? { remote } : {}),
    nonInteractive: seenFlags.has("--non-interactive"),
    apply,
    ...(approvePlanSha256 ? { approvePlanSha256 } : {}),
    json: seenFlags.has("--json"),
  };
}

export async function runDocsFabInit(
  args: readonly string[],
  dependencies: DocsFabInitDependencies,
): Promise<DocsFabInitPlan> {
  const parsed = parseDocsFabInitArguments(args, dependencies.cwd);
  const environment = dependencies.environment ?? process.env;
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  // Preview refuses the same configuration roots apply refuses, before any
  // digest exists to approve: the same read-only storage check apply runs
  // (realpath, lstat, and pins only). Apply captures the root again, fresh.
  const configRoot = resolveDocsFabConfigurationRoot(environment);
  await captureConfigurationRoot(configRoot, homeDirectory, environment);
  const commands = dependencies.commands ?? new ExecInitCommandRunner();
  const interactive =
    dependencies.interactive ??
    (!parsed.nonInteractive && Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const prompt = dependencies.prompt ?? new TerminalInitPrompt();
  const repository = await discoverRepository(parsed.repositoryPath, commands);
  const selected = await selectCanonicalRemote(repository, parsed.remote, interactive, prompt);
  const gitlab = await inspectGitLab(repository.path, selected, commands, environment);
  const provider = await (dependencies.inspectProvider ?? inspectHostProvider)();
  const doctorCheck = dependencies.checkDoctor ?? checkSharedDoctor;
  const doctorStatus =
    provider.status === "ready"
      ? normalizeDoctorStatus(await doctorCheck())
      : "profile-diagnostics-required";
  const existing = await readExistingConfig(repository.path);
  const projectConfig: DocsFabProjectConfigV1 = {
    schemaVersion: 1,
    gitlab: { remote: selected.name, defaultBranch: gitlab.defaultBranch },
    provider: { configuration: "host" },
    storage: { scope: "user-private" },
    ...(existing.value?.documentationRoots
      ? { documentationRoots: existing.value.documentationRoots }
      : {}),
  };
  assertDocsFabProjectConfig(projectConfig);
  const repositoryIdentity = await captureRepositoryApprovalIdentity(
    repository.path,
    selected,
    gitlab.defaultBranch,
    commands,
  );
  const change =
    existing.state === "absent"
      ? "create"
      : projectConfigBytes(existing.value!).equals(projectConfigBytes(projectConfig))
        ? "none"
        : "update";
  const gitignore = await inspectPrivateGitignorePlan(repository.path, environment);
  const changedPaths = [
    ...(change === "none" ? [] : [".docsfab.json"]),
    ...(gitignore.action === "create" || gitignore.action === "append" ? [gitignore.path] : []),
  ];
  const withoutDigest = {
    schemaVersion: 1,
    kind: "docsfab-init-plan",
    projectConfig,
    change,
    repository: "detected",
    repositoryBindingSha256: repositoryIdentity.sha256,
    configPreimageSha256: existing.preimageSha256,
    gitignore,
    changedPaths,
    gitlabAuthentication: gitlab.authentication,
    gitlabProject: gitlab.project,
    gitlabBindingSha256: gitlab.bindingSha256,
    providerConfiguration: provider.status,
    profileStatus: provider.profileStatus,
    privateRoots: ["runs", "evidence", "delivery", "receipts"],
    doctor: doctorStatus,
    nextActions: nextActions(gitlab.authentication, gitlab.project, doctorStatus),
  } as const;
  assertCredentialFree(
    withoutDigest,
    "Initialization plan contained credential material and was withheld.",
  );
  const plan: DocsFabInitPlan = {
    ...withoutDigest,
    sha256: createHash("sha256")
      .update(canonicalizeJsonEvidence(withoutDigest as unknown as JsonEvidenceValue))
      .digest("hex"),
  };
  const inspectReadiness =
    dependencies.inspectReadiness ??
    (async (input) => {
      const { inspectDoctorReadiness } = await import("../doctor-readiness.js");
      const result = await inspectDoctorReadiness(input);
      return result.checks;
    });
  const readinessChecks = await inspectReadiness({
    cwd: repository.path,
    environment,
    homeDirectory,
  });
  logSafe(
    dependencies,
    parsed.json ? serializeDocsFabInitPlan(plan) : formatDocsFabInitPlan(plan, { readinessChecks }),
  );

  let approved = false;
  if (parsed.apply) {
    if (parsed.approvePlanSha256 !== plan.sha256) {
      throw new Error(
        "Approved initialization plan digest does not match the fresh preview; nothing was changed.",
      );
    }
    approved = true;
  } else if (interactive) {
    approved = await prompt.confirm(plan);
  }
  if (!approved) return plan;

  const roots = resolveDocsFabPrivateRoots(repository.path, environment, homeDirectory);
  const revalidateRepositoryApproval = async (): Promise<void> => {
    const freshRepository = await discoverRepository(repository.path, commands);
    const freshSelected = await selectCanonicalRemote(
      freshRepository,
      selected.name,
      false,
      prompt,
    );
    const freshIdentity = await captureRepositoryApprovalIdentity(
      freshRepository.path,
      freshSelected,
      gitlab.defaultBranch,
      commands,
    );
    if (freshIdentity.sha256 !== repositoryIdentity.sha256) {
      throw new Error(
        "Repository identity changed after approval; the approved project file was not written.",
      );
    }
    await assertPrivateGitignorePlanCurrent(repository.path, gitignore, environment);
  };
  const applied = await applyInitialization({
    repositoryPath: repository.path,
    configRoot,
    homeDirectory,
    environment,
    roots,
    projectConfig,
    expectedConfig: existing,
    repositoryBindingSha256: repositoryIdentity.sha256,
    revalidateApproval: async () => {
      await revalidateRepositoryApproval();
      const freshConfig = await readExistingConfig(repository.path);
      if (freshConfig.preimageSha256 !== existing.preimageSha256) {
        throw new Error(
          "DocsFab project configuration changed after approval; the approved project file was not written.",
        );
      }
    },
    revalidateRepositoryApproval,
    hooks: dependencies.mutationHooks,
  });
  let finalDoctorStatus: InitDoctorStatus;
  try {
    finalDoctorStatus =
      provider.status === "ready"
        ? normalizeDoctorStatus(
            await (dependencies.checkDoctor
              ? doctorCheck()
              : checkSharedProductDoctor(repository.path)),
          )
        : "profile-diagnostics-required";
  } catch {
    finalDoctorStatus = "diagnostics-required";
  }
  let gitignoreResult: GitignoreAppendResult;
  try {
    gitignoreResult = await applyPrivateGitignorePlan(repository.path, gitignore, environment);
  } catch {
    // Project configuration may already be durable. Do not claim that the
    // ignore file was unchanged or retry a possibly partial write.
    gitignoreResult = { status: "unknown", added: [], reason: "readback-unavailable" };
  }
  const gitignoreChanged =
    gitignoreResult.status === "created" || gitignoreResult.status === "appended";
  const gitignoreIncomplete =
    (gitignore.action === "create" || gitignore.action === "append") && !gitignoreChanged;
  const actualChangedPaths = [
    ...(applied.configChanged ? [".docsfab.json"] : []),
    ...(gitignoreChanged ? [gitignore.path] : []),
  ];
  const finalActions = applySuccessNextActions(
    gitlab.authentication,
    gitlab.project,
    finalDoctorStatus,
  );
  const result = {
    schemaVersion: 1,
    kind: "docsfab-init-result",
    planSha256: plan.sha256,
    status:
      applied.cleanupRequired || gitignoreIncomplete
        ? "applied-cleanup-required"
        : finalDoctorStatus === "ready" && gitlab.project === "ready"
          ? "ready"
          : "needs-attention",
    mutation: applied.configChanged ? "applied" : "none",
    changedPaths: actualChangedPaths,
    uncertainPaths: gitignoreResult.status === "unknown" ? [gitignore.path] : [],
    nextActions: finalActions,
    gitignore: gitignoreResult,
  } as const;
  assertCredentialFree(
    result,
    "Initialization result contained credential material and was withheld.",
  );
  logSafe(
    dependencies,
    parsed.json
      ? canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue).trimEnd()
      : formatInitResult(result, { readinessChecks }),
  );
  return plan;
}

class TerminalInitPrompt implements DocsFabInitPrompt {
  async chooseRemote(candidates: readonly string[]): Promise<string> {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (
        await terminal.question(`Choose GitLab remote (${candidates.join(", ")}): `)
      ).trim();
      if (!candidates.includes(answer))
        throw new Error("Choose one of the discovered GitLab remote names.");
      return answer;
    } finally {
      terminal.close();
    }
  }

  async confirm(plan: DocsFabInitPlan): Promise<boolean> {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (
        await terminal.question(`Apply initialization plan ${plan.sha256}? [y/N] `)
      ).trim();
      return /^(?:y|yes)$/iu.test(answer);
    } finally {
      terminal.close();
    }
  }
}

export {
  assertDocsFabProjectConfig,
  resolveDocsFabPrivateRoots,
} from "./project-config.js";

export { allocateDocsFabPrivateRoots } from "./apply.js";
