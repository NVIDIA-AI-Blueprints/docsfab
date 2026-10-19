// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for the model comparison matrix.
 *
 * Rules this file enforces:
 *  - Every path, model, limit, and credential name comes from the config.
 *    Credential values are read from the environment by name and never
 *    written to config, profiles, logs, or reports; run-matrix passes the
 *    credential to each cell's process environment only.
 *  - A run's cwd is the runtime package directory, because the host profile
 *    declares DOCSFAB_QUALITY_PACK_DIR and similar as relative paths.
 *  - Every run gets its own pristine source tree (see corpus.mjs), or run N
 *    would see run N-1's output and silently change the task.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { EXECUTABLE_ROUTE_BASE_URLS } from "../../src/config/executable-route-urls.js";
import { postChatCompletion } from "../../src/profile/probe-core.js";
import { releaseModelCredential } from "../../src/security/model-credential-release.js";
import { matrixLimit } from "./limits.mjs";
import { harnessRepositoryRoot } from "./repository-root.mjs";

/**
 * Expand ${route:<id>} to the route registry's base URL, so a checked-in
 * config names a route, never a gateway origin. Only an id the registry
 * names expands; any other id refuses rather than passing the text through.
 */
function expandRoutes(value) {
  return value.replace(/\$\{route:([^}]*)\}/gu, (whole, id) => {
    if (!Object.hasOwn(EXECUTABLE_ROUTE_BASE_URLS, id)) {
      throw new Error(
        `${whole} names no route in the executable route registry. Use one of: ${Object.keys(EXECUTABLE_ROUTE_BASE_URLS).join(", ")}.`,
      );
    }
    return EXECUTABLE_ROUTE_BASE_URLS[id];
  });
}

/** Expand ${route:<id>}, then ${VAR} against the environment plus caller-supplied extras. */
export function expand(value, extra = {}) {
  if (typeof value !== "string") return value;
  return expandRoutes(value).replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gu, (whole, name) => {
    const replacement = extra[name] ?? process.env[name];
    if (replacement === undefined) {
      throw new Error(`${whole} is not defined in the environment or overrides.`);
    }
    return replacement;
  });
}

function expandDeep(value, extra) {
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, extra));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandDeep(item, extra)]),
    );
  }
  return expand(value, extra);
}

/**
 * Load and expand a matrix config. `${REPO}` is the repository holding these
 * scripts, wherever the config itself lives, so a config can be checked in or
 * kept in a scratch directory without absolute paths.
 */
export async function loadConfig(configPath, overrides = {}) {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  assertConfigContract(raw, configPath);
  return expandDeep(raw, { REPO: overrides.REPO ?? harnessRepositoryRoot(), ...overrides });
}

/**
 * Keys a config may no longer carry, each with where its value lives now.
 * Instructions and delivery belong to the corpus, and bounds to the limits
 * catalog, so a config cannot quietly override either.
 */
export function assertConfigContract(config, configPath = "config") {
  if (config?.schemaVersion === 1 && config?.contentAvailability === "internal-only") {
    const error = new Error(
      "internal-content-unavailable: the benchmark configuration and inputs are retained internally. Use the authorized internal checkout or supply an independently owned corpus configuration.",
    );
    error.code = "internal-content-unavailable";
    throw error;
  }
  const problems = [];
  for (const fixture of config.fixtures ?? []) {
    for (const key of ["path", "revision", "targetDoc"]) {
      if (Object.hasOwn(fixture, key)) {
        problems.push(
          `fixtures[${fixture.id}].${key}: a fixture is now a sealed corpus; set "corpus" to its directory (an operator-owned corpus directory).`,
        );
      }
    }
    if (typeof fixture.corpus !== "string")
      problems.push(`fixtures[${fixture.id}].corpus is required.`);
  }
  for (const [index, model] of (config.models ?? []).entries()) {
    if (typeof model?.family !== "string" || model.family.trim() === "") {
      problems.push(
        `models[${model?.id ?? index}].family is required, so a model in the judge's family cannot escape same-family exclusion.`,
      );
    }
  }
  for (const workflow of config.workflows ?? []) {
    for (const key of ["instruction", "allowWrite"]) {
      if (Object.hasOwn(workflow, key)) {
        problems.push(
          `workflows[${workflow.id}].${key}: instructions come from the corpus tasks and delivery from the product; version the corpus to change an instruction.`,
        );
      }
    }
  }
  if (Object.hasOwn(config.execution ?? {}, "timeoutMs")) {
    problems.push(
      "execution.timeoutMs: the cell wall clock is modelMatrix.cellTimeoutMs in config/limits/modelMatrix.yaml.",
    );
  }
  if (config.judge?.enabled) {
    if (Object.hasOwn(config.judge, "maxTokens")) {
      problems.push(
        "judge.maxTokens: the judge output allowance is modelMatrix.judgeMaxOutputTokens in config/limits/modelMatrix.yaml.",
      );
    }
    if (Object.hasOwn(config.judge, "contextWindowTokens")) {
      problems.push(
        "judge.contextWindowTokens: the judge's window is modelMatrix.judgeContextWindowTokens in config/limits/modelMatrix.yaml; override it with DOCSFAB_MODEL_MATRIX_JUDGE_CONTEXT_WINDOW_TOKENS.",
      );
    }
    if (Object.hasOwn(config.judge, "rubric")) {
      problems.push(
        'judge.rubric: declare one rubric per output kind under judge.rubrics ("document", "report").',
      );
    }
    for (const key of ["model", "family", "baseUrl", "credentialEnv", "rubrics"]) {
      if (config.judge[key] === undefined)
        problems.push(`judge.${key} is required when the judge is enabled.`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${configPath} does not match the matrix config contract:\n  - ${problems.join("\n  - ")}`,
    );
  }
}

/** Read a credential by NAME. Never logs, never returns it in structured output. */
export function credential(envName, environment = process.env) {
  const value = environment[envName];
  if (!value) {
    throw new Error(
      `${envName} is not set. Export the credential; the matrix config stores only its NAME.`,
    );
  }
  return value;
}

/**
 * A probe provider for the operator's matrix configuration: the credential
 * named by `envName`, released for `baseUrl` only.
 */
export function releasedProvider(baseUrl, envName, environment = process.env) {
  return {
    baseUrl,
    credential: releaseModelCredential(
      { endpoint: baseUrl, apiKey: credential(envName, environment) },
      "model-matrix",
    ),
  };
}

export function slug(text) {
  return text.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

/** Resolve a model's complete provider route, retaining top-level defaults. */
export function providerForModel(config, model) {
  return { ...config.provider, ...(model.provider ?? {}) };
}

export function validateProvider(provider, modelId) {
  if (
    !/^[A-Z_][A-Z0-9_]*$/u.test(provider.credentialEnv) ||
    !/^[A-Z_][A-Z0-9_]*$/u.test(provider.credentialTarget)
  ) {
    throw new Error(
      `Model ${modelId} provider credentialEnv and credentialTarget must be environment variable names.`,
    );
  }
  let endpoint;
  try {
    endpoint = new URL(provider.baseUrl);
  } catch {
    throw new Error(`Model ${modelId} provider.baseUrl must be an absolute HTTP(S) URL.`);
  }
  if (
    !/^https?:$/u.test(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      `Model ${modelId} provider.baseUrl must use HTTP(S) without userinfo, query, or fragment; provide credentials through credentialEnv.`,
    );
  }
  return provider;
}

export function credentialVariableName(name) {
  return /(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|(?:^|_)TOKEN(?:_|$))/iu.test(
    name,
  );
}

/** Stable id for a matrix cell, so resume can detect completed work. */
export function cellId(cell) {
  const route =
    cell.providerId && cell.baseUrl
      ? `__${slug(cell.providerId)}-${createHash("sha256")
          .update(
            JSON.stringify([
              cell.model,
              cell.providerId,
              cell.baseUrl,
              cell.apiFormat ?? null,
              cell.credentialEnv ?? null,
            ]),
          )
          .digest("hex")
          .slice(0, 12)}`
      : "";
  return `${slug(cell.model)}${route}__${cell.task}__${cell.fixture}__r${cell.rep}`;
}

export function cellDigest(cell) {
  return createHash("sha256").update(cellId(cell)).digest("hex").slice(0, 12);
}

/**
 * Materialise a host profile for one model by overlaying values onto the
 * shipped template. The profile holds no credential.
 */
export async function writeProfile({ templatePath, targetDir, provider, limits, model, extraEnv }) {
  // `limits` is null for a composition cell: the composition owns its windows,
  // and a smaller profile window would cap it (min of the two) and turn a
  // capacity result into a harness artefact.
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const template = await readFile(templatePath, "utf8");
  const sensitiveNames = Object.keys(extraEnv).filter(credentialVariableName);
  if (sensitiveNames.length > 0)
    throw new Error(
      `modelOverrides.extraEnv cannot set credential-like variables: ${sensitiveNames.join(", ")}. Use provider.credentialEnv for credentials.`,
    );
  const routeNames = new Set([
    "MODEL_PROVIDER",
    "MODEL_BASE_URL",
    "MODEL_API_FORMAT",
    "MODEL_COMPATIBLE_API_FORMATS",
    "MODEL_ID",
  ]);
  const routeOverrides = Object.keys(extraEnv).filter((name) => routeNames.has(name));
  if (routeOverrides.length > 0)
    throw new Error(
      `modelOverrides.extraEnv cannot change model routing (${routeOverrides.join(", ")}); configure models[].provider instead.`,
    );
  const validEnvName = (name) => /^[A-Z_][A-Z0-9_]*$/u.test(name);
  const invalidNames = Object.keys(extraEnv).filter((name) => !validEnvName(name));
  if (invalidNames.length > 0)
    throw new Error(
      `modelOverrides.extraEnv has invalid environment names: ${invalidNames.join(", ")}.`,
    );
  const multilineValues = Object.entries(extraEnv)
    .filter(([, value]) => /[\r\n]/u.test(String(value)))
    .map(([name]) => name);
  if (multilineValues.length > 0)
    throw new Error(
      `modelOverrides.extraEnv values must be single-line: ${multilineValues.join(", ")}.`,
    );
  const allowedLimits = new Set([
    "MODEL_CONTEXT_WINDOW",
    "MODEL_MAX_INPUT_TOKENS",
    "MODEL_MAX_OUTPUT_TOKENS",
  ]);
  const invalidLimits = Object.keys(limits ?? {}).filter((name) => !allowedLimits.has(name));
  if (invalidLimits.length > 0)
    throw new Error(
      `Matrix profile limits may only set documented token fields: ${invalidLimits.join(", ")}.`,
    );
  const invalidLimitValues = Object.entries(limits ?? {})
    .filter(([, value]) => !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
    .map(([name]) => name);
  if (invalidLimitValues.length > 0)
    throw new Error(
      `Matrix profile token limits must be positive integers: ${invalidLimitValues.join(", ")}.`,
    );
  const overrides = {
    MODEL_PROVIDER: provider.providerId,
    MODEL_BASE_URL: provider.baseUrl,
    MODEL_API_FORMAT: provider.apiFormat,
    MODEL_COMPATIBLE_API_FORMATS: provider.apiFormat,
    MODEL_ID: model,
    ...(limits ?? {}),
    ...extraEnv,
    [provider.credentialTarget]: "",
  };

  const applied = new Set();
  const lines = [];
  for (const line of template.split("\n")) {
    const match = /^([A-Z0-9_]+)=/u.exec(line);
    if (match && credentialVariableName(match[1]) && !/^#|=$/u.test(line)) {
      throw new Error(
        `Profile template ${templatePath} contains a credential-like value in ${match[1]}; keep credential values in the environment only.`,
      );
    }
    if (match && Object.hasOwn(overrides, match[1])) {
      lines.push(`${match[1]}=${overrides[match[1]]}`);
      applied.add(match[1]);
      continue;
    }
    // The template pins the pilot corpus response cap. An ordinary run must not
    // inherit it, or the lane is silently capped far below the shipped default.
    if (/^DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES=/u.test(line)) {
      lines.push(`# ${line}   # unset by the matrix harness: pilot-corpus pin, not a run setting`);
      continue;
    }
    lines.push(line);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!applied.has(key)) lines.push(`${key}=${value}`);
  }

  const envPath = join(targetDir, ".env");
  await writeFile(envPath, lines.join("\n"), { mode: 0o600 });
  return envPath;
}

/** The `endpointProbe.*` bounds from the limits catalog, for plain-node matrix scripts. */
export function endpointProbeLimits(environment = process.env) {
  const value = (name) => matrixLimit(name, environment).value;
  return {
    timeoutMs: value("endpointProbe.requestTimeoutMs"),
    errorBodyMaxChars: value("endpointProbe.providerMessageMaxChars"),
    credentialEchoMinChars: value("endpointProbe.credentialEchoMinChars"),
    sampleMaxTokens: value("endpointProbe.reasoningSampleMaxTokens"),
  };
}

/**
 * POST to an OpenAI-compatible chat completions endpoint through the shared
 * probe client. Callers pass the timeout from their own limits entry.
 */
export async function chatCompletion({ baseUrl, envName, body, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("chatCompletion needs a timeoutMs from the limits catalog.");
  }
  const { errorBodyMaxChars, credentialEchoMinChars } = endpointProbeLimits();
  return postChatCompletion({
    baseUrl,
    credential: releasedProvider(baseUrl, envName).credential,
    body,
    timeoutMs,
    errorBodyMaxChars,
    credentialEchoMinChars,
  });
}

export function resolveIn(root, ...parts) {
  return resolve(join(root, ...parts));
}
