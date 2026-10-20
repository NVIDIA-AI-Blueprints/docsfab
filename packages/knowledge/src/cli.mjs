#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { KnowledgeBackend } from "./backend.mjs";
import {
  documentationBriefMarkdown,
  emitAttributedSnapshot,
  sharedModelMarkdown,
  workflowRecordMarkdown,
} from "./exports.mjs";
import { gatherRepositoryFirstPass } from "./first-pass.mjs";
import { createKnowledgeServer } from "./server.mjs";
import { KnowledgeStore } from "./store.mjs";

function parseOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid option sequence near ${String(flag)}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

async function loadBackend(dataDirectory) {
  const store = new KnowledgeStore(dataDirectory);
  await store.initialize();
  return new KnowledgeBackend(store);
}

function help() {
  return `DocsFab knowledge-gathering control plane

Commands:
  serve   --data PATH [--port 4310]
  state   --data PATH
  events  --data PATH
  command --data PATH --name NAME --expected-version N --actor NAME --input JSON
  export  --data PATH --kind shared-model|documentation-brief|workflow --id ID [--version ID]
  gather  --data PATH --repo PATH --output PATH [--revision REF] [--instruction TEXT]
  apply-answer --snapshot PATH --answer PATH --output PATH

Every mutation requires the current stream version. The server binds only to
127.0.0.1 and is not an authenticated or production service. apply-answer writes
a new snapshot file and refuses to overwrite the prior snapshot path.
`;
}

async function main(arguments_) {
  const [subcommand = "help", ...rest] = arguments_;
  if (["help", "--help", "-h"].includes(subcommand)) {
    process.stdout.write(help());
    return;
  }
  const options = parseOptions(rest);
  if (subcommand === "gather") {
    const outputPath = requireOption(options, "output");
    const result = await gatherRepositoryFirstPass({
      repositoryPath: requireOption(options, "repo"),
      dataDirectory: requireOption(options, "data"),
      ...(options.revision ? { revision: options.revision } : {}),
      ...(options.instruction ? { instruction: options.instruction } : {}),
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(result.snapshot, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          projectId: result.projectId,
          modelVersionId: result.modelVersionId,
          sourceCount: result.sourceCount,
          snapshotSha256: result.snapshot.snapshotSha256,
          output: outputPath,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (subcommand === "apply-answer") {
    const snapshotPath = requireOption(options, "snapshot");
    const outputPath = requireOption(options, "output");
    if (resolve(snapshotPath) === resolve(outputPath)) {
      throw new Error(
        "Refusing to overwrite the prior snapshot; write a new --output path",
      );
    }
    const priorBytes = await readFile(snapshotPath);
    const result = emitAttributedSnapshot(
      priorBytes,
      await readFile(requireOption(options, "answer")),
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(result.snapshot, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          projectId: result.snapshot.projectId,
          priorSnapshotSha256: result.priorSnapshotSha256,
          modelVersionId: result.snapshot.modelVersionId,
          snapshotSha256: result.snapshot.snapshotSha256,
          answeredClaimId: result.answeredClaimId,
          output: outputPath,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const backend = await loadBackend(requireOption(options, "data"));
  if (subcommand === "state") {
    process.stdout.write(`${JSON.stringify(backend.getState(), null, 2)}\n`);
    return;
  }
  if (subcommand === "events") {
    process.stdout.write(`${JSON.stringify(backend.getEvents(), null, 2)}\n`);
    return;
  }
  if (subcommand === "command") {
    const expectedVersion = Number.parseInt(
      requireOption(options, "expected-version"),
      10,
    );
    const input = JSON.parse(requireOption(options, "input"));
    const result = await backend.dispatch(requireOption(options, "name"), {
      expectedVersion,
      actor: requireOption(options, "actor"),
      input,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (subcommand === "export") {
    const kind = requireOption(options, "kind");
    const id = requireOption(options, "id");
    const state = backend.getState();
    const output =
      kind === "shared-model"
        ? sharedModelMarkdown(state, id, options.version)
        : kind === "documentation-brief"
          ? documentationBriefMarkdown(state, id, options.version)
          : kind === "workflow"
            ? workflowRecordMarkdown(state, id)
            : null;
    if (output === null) {
      throw new Error(`Unknown export kind: ${kind}`);
    }
    process.stdout.write(output);
    return;
  }
  if (subcommand === "serve") {
    const port = options.port ? Number.parseInt(options.port, 10) : 4310;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("--port must be an integer from 0 through 65535");
    }
    const service = createKnowledgeServer({ backend, port });
    const address = await service.listen();
    process.stdout.write(
      `DocsFab knowledge control plane listening at http://${address.host}:${address.port}\n`,
    );
    return;
  }
  throw new Error(`Unknown subcommand: ${subcommand}`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
