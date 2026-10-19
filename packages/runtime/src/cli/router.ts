// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runAutoDryRunCli } from "../autonomy/dry-run-cli.js";
import {
  assessAutoDryRunHost,
  productionAutoDryRunRoadmapPlanner,
} from "../autonomy/dry-run-host.js";
import { runAutoOnceCli } from "../autonomy/once-cli.js";
import { runAutoPublishCli } from "../autonomy/managed-publish-cli.js";
import { resolveDocsFabStateDirectory } from "../config/host-paths.js";
import { runLocalUserPublishCli } from "../delivery/cli.js";
import { formatInitFailure, serializeInitFailure, runDocsFabInit } from "../init.js";
import {
  formatOfflineProductTest,
  runOfflineProductTest,
  serializeOfflineProductTest,
} from "../product-test.js";
import { runIssueLifecycleCli } from "../roadmap/issue-cli.js";
import { renderStartupOnboarding } from "../onboarding/startup.js";
import { validateStartupPublicRoots } from "../security/host-roots.js";
import { handleCompositionCommand } from "../native-compositions/cli.js";
import { reportOperatorFailure, wantsJsonFailureOutput } from "../operator/error-envelope.js";
import { handleConfigCommand } from "./commands/config.js";
import { getWorkflow, parkedWorkflowError } from "../workflow-registry/catalog.js";
import { handleDoctorCommand } from "./commands/doctor.js";
import { handleSetupCommand } from "./commands/setup.js";
import { handleShipCommand } from "./commands/ship.js";
import { publishInvocationDecodeOptions } from "./run/editorial-replay.js";
import { handleLiveAgentCommand } from "./commands/live-agent.js";
import { handleSourcesCommand } from "./commands/sources.js";
import { handleSessionsCommand } from "./commands/sessions.js";
import { handleDoCommand } from "./commands/do.js";
import { liveAdmitCatalogWorkflow } from "./admission-model.js";
import { handleEvaluateCommand } from "./commands/evaluate.js";
import { handleMultiUnitCampaignCommand } from "./commands/multi-unit-campaign.js";
import { handleProfileCommand } from "./commands/profile.js";
import { handleReportsCommand } from "./commands/reports.js";
import { handleRunsCommand } from "./commands/runs.js";
import { handleWhyCommand } from "./commands/why.js";
import { renderCommandHelp, resolveHelpRequest } from "./help.js";
import { parseWorkflow } from "./options.js";
import { parseRunArguments } from "./run-arguments.js";
import { PUBLIC_COMMAND_REGISTRY } from "./command-registry.js";
import {
  renderCliPresentation,
  workflowListPresentation,
  workflowPlanPresentation,
} from "./discovery-presentation.js";
import { setCliModelSettings } from "../config/cli-model-settings.js";
import { parseSetOptions, withoutSetOptions } from "./model-setting-options.js";
import { executeRunRequest } from "./run-request.js";
import { generalHelp, initHelp, runHelp } from "./usage.js";

export async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.log(renderStartupOnboarding());
    return;
  }

  // Help reads only the registry and static text, so it runs before startup
  // validation and never reaches a command's parser.
  const helpPath = resolveHelpRequest([command, ...args]);
  if (helpPath) {
    console.log(renderCommandHelp(helpPath));
    return;
  }

  if (command !== "run" && !PUBLIC_COMMAND_REGISTRY.some((entry) => entry.name === command)) {
    throw new CliUsageError(
      `Unknown command "${command}". Run docsfab --help for the command list.`,
    );
  }

  // Refuse an invalid declaration at startup, before any command can reach egress.
  validateStartupPublicRoots();

  // These views use only installed registries and deterministic fixtures.
  // They do not invoke setup, a provider, or repository mutation.
  if (command === "list") {
    if (args.length > 0)
      throw new CliUsageError("`docsfab list` accepts no arguments. Run `docsfab list --help`.");
    console.log(renderCliPresentation(workflowListPresentation()));
    return;
  }

  if (command === "plan") {
    if (args.length !== 1) {
      throw new CliUsageError(
        "`docsfab plan` requires exactly one workflow name. Run `docsfab plan --help`.",
      );
    }
    let workflowName;
    try {
      workflowName = parseWorkflow(args[0]);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown workflow ")) {
        throw new CliUsageError(`${error.message} Run \`docsfab plan --help\` for plan syntax.`);
      }
      throw error;
    }
    console.log(renderCliPresentation(workflowPlanPresentation(getWorkflow(workflowName))));
    return;
  }

  if (command === "test") {
    const knownTestArgs = new Set(["--json", "--quiet"]);
    if (
      args.some((argument) => !knownTestArgs.has(argument)) ||
      args.filter((argument) => argument === "--json").length > 1 ||
      args.filter((argument) => argument === "--quiet").length > 1
    ) {
      throw new CliUsageError("Unknown or duplicated test option. Run `docsfab test --help`.");
    }
    const result = runOfflineProductTest();
    console.log(
      args.includes("--json")
        ? serializeOfflineProductTest(result)
        : formatOfflineProductTest(result, { quiet: args.includes("--quiet") }),
    );
    return;
  }

  if (command === "init") {
    if (args.includes("--help") || args.includes("-h")) {
      console.log(initHelp());
      return;
    }
    try {
      await runDocsFabInit(args, {
        cwd: process.cwd(),
        log: (message) => console.log(message),
      });
    } catch (error) {
      console.error(
        args.includes("--json") ? serializeInitFailure(error).trimEnd() : formatInitFailure(error),
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command === "setup") {
    try {
      await handleSetupCommand(args);
    } catch (error) {
      reportCommandFailure(error);
    }
    return;
  }

  if (command === "config") {
    await handleConfigCommand(args);
    return;
  }

  if (command === "live-agent") {
    try {
      await handleLiveAgentCommand(args);
    } catch (error) {
      reportCommandFailure(error);
    }
    return;
  }

  if (command === "sessions") {
    try {
      await handleSessionsCommand(args);
    } catch (error) {
      reportCommandFailure(error);
    }
    return;
  }

  if (command === "sources") {
    // Refusals are operator sentences written by the command itself, with an
    // exit code; nothing is rethrown here, so no stack trace can reach a
    // terminal in place of a coded stop.
    await handleSourcesCommand(args);
    return;
  }

  if (command === "roadmap-plan") {
    throw new Error(parkedWorkflowError("roadmap-plan"));
  }

  if (command === "auto") {
    if (args[0] === "--once") {
      await runAutoOnceCli(args, {
        cwd: process.cwd(),
        log: (message) => console.log(message),
        runWorkflow: (request) => executeRunRequest(request),
      });
      return;
    }
    if (args[0] === "--publish") {
      await runAutoPublishCli(args, {
        cwd: process.cwd(),
        stateDirectory: resolveDocsFabStateDirectory(),
        log: (message) => console.log(message),
        runWorkflow: (request) => executeRunRequest(request),
      });
      return;
    }
    await runAutoDryRunCli(args, {
      assess: assessAutoDryRunHost,
      roadmapPlanner: productionAutoDryRunRoadmapPlanner,
      log: (message) => console.log(message),
    });
    return;
  }

  if (command === "doctor") {
    await handleDoctorCommand(args);
    return;
  }

  if (command === "profile") {
    await handleProfileCommand(args);
    return;
  }

  if (command === "composition") {
    await handleCompositionCommand(args);
    return;
  }

  if (command === "ia") {
    throw new Error(parkedWorkflowError("ia"));
  }

  if (command === "evaluate") {
    await handleEvaluateCommand(args);
    return;
  }

  if (command === "do") {
    await handleDoCommand(args, { admitCatalogWorkflow: liveAdmitCatalogWorkflow });
    return;
  }

  if (command === "multi-unit-campaign") {
    await handleMultiUnitCampaignCommand(args);
    return;
  }

  if (command === "publish") {
    const stateDirectory = resolveDocsFabStateDirectory();
    // The saved run's record decodes only with the options `runs show` uses (#2366).
    const editorialDecodeOptions = await publishInvocationDecodeOptions(args, stateDirectory);
    await runLocalUserPublishCli(args, {
      cwd: process.cwd(),
      stateDirectory,
      log: console.log,
      ...(editorialDecodeOptions ? { editorialDecodeOptions } : {}),
    });
    return;
  }

  if (command === "ship") {
    await handleShipCommand(args, {
      cwd: process.cwd(),
      stateDirectory: resolveDocsFabStateDirectory(),
      log: console.log,
    });
    return;
  }

  if (command === "roadmap-issues") {
    await runIssueLifecycleCli(args, { cwd: process.cwd(), log: console.log });
    return;
  }

  if (command === "runs") {
    await handleRunsCommand(args);
    return;
  }

  if (command === "why") {
    await handleWhyCommand(args);
    return;
  }

  if (command === "reports") {
    await handleReportsCommand(args);
    return;
  }

  if (command !== "run")
    throw new CliUsageError(`Unknown command "${command}". Run docsfab --help.`);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(runHelp());
    return;
  }

  // `--set key=value` pairs are this invocation's highest-precedence model settings.
  setCliModelSettings(parseSetOptions(args));
  const request = parseRunArguments(withoutSetOptions(args));
  await executeRunRequest(request);
}

class CliUsageError extends Error {
  readonly code = "cli-usage" as const;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function reportCommandFailure(error: unknown): void {
  reportOperatorFailure(error, { json: wantsJsonFailureOutput() });
  process.exitCode = 1;
}
