#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { refreshCompiledLauncherIfStale } from "./source-checkout-refresh.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
await refreshCompiledLauncherIfStale(packageRoot);

const { launch } = await import(pathToFileURL(join(packageRoot, "dist", "launcher.js")).href);
launch().catch(async (error) => {
  const { reportLocalCliFailure } = await import(
    pathToFileURL(join(packageRoot, "dist", "operator", "local-cli-failure.js")).href
  );
  reportLocalCliFailure(error);
  process.exitCode = 1;
});
