// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read one representation capacity straight from the generated catalog.
 *
 * Unlike `limit()`, this applies no host or project override and needs no I/O,
 * because producer and consumer must share the declared shape and per-request
 * contract parsers use it. An absent name throws: `undefined` would silently
 * disable the comparison that uses it.
 */
import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";

export function catalogCapacity(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
  }
  return definition.max;
}
