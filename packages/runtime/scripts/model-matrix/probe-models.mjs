#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-model capability probe. Run this before the matrix.
 *
 * A model that returns its text in `reasoning_content` with `content` empty
 * cannot be consumed by the Pi harness, and fails with errors that do not name
 * the cause (`Provider turn failed: blank`). This probe costs one small request
 * per model and predicts that outcome before a matrix run.
 *
 * It also records whether `chat_template_kwargs: {thinking:false}` moves a
 * model's text back into `content`, which varies by route and model.
 *
 * Usage:
 *   node probe-models.mjs [--config path] [--out path] [--json]
 *
 * `docsfab profile probe` wraps this same stack (`probe-core.mjs`). Do not add
 * a second HTTP probe. Its bounds come from `config/limits/endpointProbe.yaml`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  endpointProbeLimits,
  loadConfig,
  providerForModel,
  releasedProvider,
  validateProvider,
} from "./lib.mjs";
import { DEFAULT_PROMPTS, decideVerdict, probeOne } from "./probe-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const config = await loadConfig(arg("config", join(HERE, "matrix.config.json")));
  const options = endpointProbeLimits();
  const outPath = arg("out", join(config.output.root, "probe.json"));
  await mkdir(dirname(outPath), { recursive: true });

  const prompts = config.probe?.prompts ?? DEFAULT_PROMPTS;
  const rows = [];
  for (const model of config.models) {
    const providerConfig = validateProvider(providerForModel(config, model), model.id);
    const provider = releasedProvider(providerConfig.baseUrl, providerConfig.credentialEnv);
    let plain;
    let noThink;
    let verdict;
    try {
      plain = await probeOne(model.id, provider, {}, prompts, options);
      noThink = plain.reasoningSplit
        ? await probeOne(
            model.id,
            provider,
            { chat_template_kwargs: { thinking: false } },
            prompts,
            options,
          )
        : null;
      verdict = decideVerdict(plain, noThink);
    } catch (error) {
      plain = null;
      noThink = null;
      verdict = "probe-error";
      rows.push({
        model: model.id,
        family: model.family,
        providerId: providerConfig.providerId,
        baseUrl: providerConfig.baseUrl,
        error: { code: error.code ?? "model-matrix-probe-failed", message: error.message },
        verdict,
      });
      if (!process.argv.includes("--json")) console.log(`  ${verdict.padEnd(30)} ${model.id}`);
      continue;
    }
    rows.push({
      model: model.id,
      family: model.family,
      providerId: providerConfig.providerId,
      baseUrl: providerConfig.baseUrl,
      plain,
      noThink,
      verdict,
    });
    if (!process.argv.includes("--json")) {
      console.log(`  ${verdict.padEnd(30)} ${model.id}`);
    }
  }

  await writeFile(outPath, JSON.stringify({ config: config.name, rows }, null, 2));
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else {
    const blocked = rows.filter((row) => row.verdict === "reasoning-split-uncontrolled");
    console.log(`\nwrote ${outPath}`);
    console.log(
      `${rows.filter((row) => row.verdict === "harness-compatible").length}/${rows.length} harness-compatible; ` +
        `${blocked.length} blocked by uncontrolled reasoning split`,
    );
    if (blocked.length > 0) {
      console.log("Blocked models will fail the matrix for transport reasons, not quality:");
      for (const row of blocked) console.log(`  - ${row.model}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
