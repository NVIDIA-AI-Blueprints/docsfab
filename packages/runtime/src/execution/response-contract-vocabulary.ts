// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The response-contract key vocabulary: every JSON key some host-owned model
 * response contract declares.
 *
 * A rejected reply's shape fingerprint names a key only when it is in this
 * vocabulary. Any other key, however identifier-like (a digest, a token, a
 * sentence in snake case), is counted as undeclared and never written or
 * printed.
 *
 * Derived, never a hand list: `response-contract-keys.js` builds it from the
 * decoders' key sets and the property names of the frozen host schemas those
 * contracts bind. The three judgment-row sets are prompt-declared rather than
 * enforced; `judgment-row-key-audit.ts` counts their extra keys.
 */

import { readFileSync } from "node:fs";

import {
  buildResponseContractKeyVocabulary,
  RESPONSE_CONTRACT_KEY_SETS,
  RESPONSE_CONTRACT_SCHEMAS,
} from "./response-contract-keys.js";

export { RESPONSE_CONTRACT_SCHEMAS };

export const RESPONSE_CONTRACT_DECODER_KEY_SETS = RESPONSE_CONTRACT_KEY_SETS;

/** Parse one frozen schema from the installed quality staging. */
export function readResponseContractSchema(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../quality/schemas/${name}`, import.meta.url), "utf8"),
  );
}

let vocabulary: ReadonlySet<string> | undefined;

/** Built once per process. */
export function responseContractKeyVocabulary(): ReadonlySet<string> {
  vocabulary ??= buildResponseContractKeyVocabulary(readResponseContractSchema);
  return vocabulary;
}

export function isDeclaredResponseContractKey(key: string): boolean {
  return responseContractKeyVocabulary().has(key);
}
