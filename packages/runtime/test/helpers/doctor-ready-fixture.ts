// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A checkout `docsfab doctor` reads as ready for local review, with every git
 * and glab answer faked. It has no project configuration, so doctor reports
 * only publication setup, which does not gate local review, and never reaches
 * GitLab.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DocsFabConfig } from "../../src/config/runtime-loader.js";
import type {
  DoctorReadinessCommandRunner,
  DoctorReadinessOptions,
} from "../../src/doctor-readiness.js";
import { validModelConfig } from "../helpers.js";
import type { TemporaryRoots } from "./temp.js";

const REVISION = "a".repeat(40);

const ANSWERS: Readonly<Record<string, { exitCode: number; stdout: string }>> = {
  "git --version": { exitCode: 0, stdout: "git version 2.50.0\n" },
  "git symbolic-ref --quiet --short HEAD": { exitCode: 0, stdout: "main\n" },
  "git rev-parse --verify HEAD^{commit}": { exitCode: 0, stdout: `${REVISION}\n` },
  [`git cat-file -e ${REVISION}^{commit}`]: { exitCode: 0, stdout: "" },
  "git config --get user.name": { exitCode: 0, stdout: "Operator\n" },
  "git config --get user.email": { exitCode: 0, stdout: "operator@example.test\n" },
  "git status --porcelain=v1 --untracked-files=all": { exitCode: 0, stdout: "" },
};

export class ReadyCheckoutCommands implements DoctorReadinessCommandRunner {
  readonly calls: string[] = [];

  constructor(private readonly repository: string) {}

  async run(
    command: "git" | "glab" | "npm",
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string }> {
    const key = `${command} ${args.join(" ")}`;
    this.calls.push(key);
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: `${this.repository}\n` };
    }
    return ANSWERS[key] ?? { exitCode: 1, stdout: "" };
  }

  async probeCredential(): Promise<"present" | "missing" | "unverified"> {
    return "missing";
  }
}

export interface ReadyDoctorFixture {
  readonly root: string;
  readonly repository: string;
  readonly commands: ReadyCheckoutCommands;
  /** The policy model and the package's own installed assets. */
  readonly config: DocsFabConfig;
  /** Readiness seams; a test adds its configuration and provider seams. */
  readonly options: DoctorReadinessOptions;
}

export async function readyDoctorFixture(roots: TemporaryRoots): Promise<ReadyDoctorFixture> {
  const root = await roots.create("docsfab-doctor-ready-", { realpath: true });
  const repository = resolve(root, "repository");
  const home = resolve(root, "home");
  const configuration = resolve(root, "configuration");
  const state = resolve(root, "state");
  await Promise.all([
    mkdir(repository),
    mkdir(home),
    mkdir(configuration, { mode: 0o700 }),
    mkdir(state, { mode: 0o700 }),
  ]);
  const commands = new ReadyCheckoutCommands(repository);
  const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));
  return {
    root,
    repository,
    commands,
    config: {
      projectRoot: repository,
      skillCrateDirectory: resolve(runtimeRoot, "skill-crate"),
      qualityDirectory: resolve(runtimeRoot, "quality"),
      qualityPackDirectory: resolve(runtimeRoot, "quality-pack"),
      stateDirectory: resolve(state, "runs"),
      retryPolicy: {
        maxRetries: 0,
        baseDelayMs: 1_000,
        maxDelayMs: 2_000,
        retryableCategories: ["timeout"],
      },
      model: validModelConfig,
    },
    options: {
      cwd: repository,
      environment: { DOCSFAB_CONFIG_ROOT: configuration, XDG_STATE_HOME: state },
      homeDirectory: home,
      platform: "linux",
      commands,
    },
  };
}
