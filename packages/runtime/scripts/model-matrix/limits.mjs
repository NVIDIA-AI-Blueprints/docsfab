// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operational limits for the plain-node matrix scripts.
 *
 * The scripts cannot load `src/config/limits.ts` (its imports are not
 * strip-types loadable), so they read the generated catalog mirror and resolve
 * it through the same dependency-free resolver the runtime uses. Host
 * environment overrides therefore apply exactly as they do for `limit()`, and
 * `docsfab doctor --limits` shows the same entries.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveLimitDefinitions } from "../../src/config/limit-resolution.js";
import { harnessRepositoryRoot } from "./repository-root.mjs";

let cachedDefinitions;

function catalogDefinitions() {
  if (cachedDefinitions) return cachedDefinitions;
  const path = join(harnessRepositoryRoot(), "config", "limits.catalog.json");
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} is missing or unreadable (${error.message}); run \`npm run generate:limits\` from packages/runtime.`,
    );
  }
  cachedDefinitions = Object.entries(catalog.limits ?? {}).map(([name, entry]) => ({
    name,
    ...entry,
  }));
  return cachedDefinitions;
}

/** One resolved catalog entry: `{name, value, unit, refusal, remediation, source}`. */
export function matrixLimit(name, environment = process.env) {
  const definitions = catalogDefinitions();
  if (!definitions.some((definition) => definition.name === name)) {
    throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
  }
  return resolveLimitDefinitions(definitions, { environment }).find((entry) => entry.name === name);
}

/** Effective numeric settings and their source, for a credential-free run manifest. */
export function resolvedMatrixLimits(environment = process.env) {
  return resolveLimitDefinitions(catalogDefinitions(), { environment }).map(
    ({ name, value, source }) => ({
      name,
      value,
      source,
    }),
  );
}

/** A bound refusal names its code, the observed value, the scope it applied to, and the remediation. */
export class MatrixLimitRefusal extends Error {
  constructor(limit, observed, scope) {
    super(
      `${limit.refusal}: ${observed} exceeds ${limit.name} = ${limit.value} ${limit.unit} ` +
        `(scope: ${scope}). ${limit.remediation}`,
    );
    this.name = "MatrixLimitRefusal";
    this.code = limit.refusal;
    this.limit = limit.name;
    this.bound = limit.value;
    this.observed = observed;
    this.scope = scope;
  }

  toJSON() {
    return {
      code: this.code,
      limit: this.limit,
      bound: this.bound,
      observed: this.observed,
      scope: this.scope,
      message: this.message,
    };
  }
}

/** Throw a coded refusal when `observed` is past the bound. */
export function enforceMatrixLimit(limit, observed, scope) {
  if (observed > limit.value) throw new MatrixLimitRefusal(limit, observed, scope);
}
