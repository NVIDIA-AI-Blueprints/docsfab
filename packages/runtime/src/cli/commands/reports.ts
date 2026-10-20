// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { isAbsolute, resolve } from "node:path";

import { resolveDocsFabStateDirectory } from "../../config/host-paths.js";
import {
  HOSTED_REPORT_DEFAULT_BIND,
  HOSTED_REPORT_DEFAULT_PORT,
  dispatchHostedReportRequest,
  hostedReportsRoot,
} from "../../evaluation-report/hosted-report.js";

const SAFE_BIND = /^(?:127\.0\.0\.1|0\.0\.0\.0)$/u;

export interface ReportsServeArguments {
  readonly bind: string;
  readonly port: number;
  readonly stateDirectory: string;
}

export async function handleReportsCommand(
  args: string[],
  dependencies: {
    listen?: (options: ReportsServeArguments) => Promise<void>;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  const parsed = parseReportsArguments(args);
  const listen = dependencies.listen ?? listenHostedReports;
  const log = dependencies.log ?? ((message) => console.log(message));
  log(
    `DocsFab hosted reports listening on http://${displayHost(parsed.bind)}:${parsed.port}/reports/`,
  );
  await listen(parsed);
}

export function parseReportsArguments(args: string[]): ReportsServeArguments {
  if (args[0] !== "serve") {
    throw new Error("The docsfab reports command supports only the serve subcommand.");
  }
  const rest = args.slice(1);
  const consumed = new Set<number>();
  let bind = HOSTED_REPORT_DEFAULT_BIND;
  let port = HOSTED_REPORT_DEFAULT_PORT;
  let stateDirectory: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--bind") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--") || !SAFE_BIND.test(value)) {
        throw new Error("docsfab reports serve --bind must be 127.0.0.1 or 0.0.0.0.");
      }
      consumed.add(index);
      consumed.add(index + 1);
      bind = value;
      index += 1;
      continue;
    }
    if (argument === "--port") {
      const value = rest[index + 1];
      if (!value || !/^[1-9][0-9]{0,4}$/u.test(value)) {
        throw new Error("docsfab reports serve --port requires a TCP port.");
      }
      const parsedPort = Number(value);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error("docsfab reports serve --port requires a TCP port.");
      }
      consumed.add(index);
      consumed.add(index + 1);
      port = parsedPort;
      index += 1;
      continue;
    }
    if (argument === "--state-dir") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--") || !isAbsolute(value) || resolve(value) !== value) {
        throw new Error("docsfab reports serve --state-dir requires an absolute directory.");
      }
      consumed.add(index);
      consumed.add(index + 1);
      stateDirectory = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`Unknown docsfab reports serve option "${argument}" is not supported.`);
    }
  }
  if (rest.some((_, index) => !consumed.has(index))) {
    throw new Error("docsfab reports serve does not accept positional arguments.");
  }
  return {
    bind,
    port,
    stateDirectory: stateDirectory ?? resolveDocsFabStateDirectory(),
  };
}

async function listenHostedReports(options: ReportsServeArguments): Promise<void> {
  const reportsRoot = hostedReportsRoot(options.stateDirectory);
  const server = createServer((request, response) => {
    void dispatchHostedReportRequest({
      method: request.method ?? "GET",
      urlPath: request.url ?? "/",
      reportsRoot,
    }).then((result) => {
      response.writeHead(result.status, { "content-type": result.contentType });
      response.end(result.body);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bind, () => resolveListen());
  });
  await new Promise<void>(() => {
    /* Stay up until the operator stops the process. */
  });
}

function displayHost(bind: string): string {
  return bind === "0.0.0.0" ? "127.0.0.1" : bind;
}
