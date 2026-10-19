// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which repository paths the operator's own input names. It reads only what
 * the operator supplied: the request text as typed, and explicit target inputs
 * such as `--context-path`. A model's reading of the request, agent-added
 * context, and repository content never name a path here.
 */
import { pathTokenText, textNamesPath } from "../request-intent/quote.js";

export interface OperatorNamedPaths {
  /** Whether the operator's input names exactly `path`. */
  readonly names: (path: string) => boolean;
}

/** Input that names nothing: the fail-closed answer when the request cannot be read. */
export const NO_OPERATOR_NAMED_PATHS: OperatorNamedPaths = Object.freeze({ names: () => false });

/**
 * A path is named when:
 * - an explicit target input is exactly that path; or
 * - a request text holds the exact path, letter case included, as a whole
 *   token: `docs/AGENTS.md`, never `./docs/AGENTS.md`, `docs/agents.md`,
 *   `docs/x/../AGENTS.md`, or a Unicode lookalike. The text is matched as
 *   typed, without normalization; or
 * - a request text holds the path's bare file name, such as `AGENTS.md`, as a
 *   whole token, and `trackedPaths` holds exactly one path with that file name
 *   in that letter case, anywhere in the repository, and it is this path. A
 *   bare file name therefore never names a page a create would add.
 */
export function operatorNamedPaths(input: {
  readonly texts: readonly string[];
  readonly explicitPaths?: readonly string[];
  /** Every path the run's revision tracks. Omitted, a bare file name names nothing. */
  readonly trackedPaths?: readonly string[];
}): OperatorNamedPaths {
  const tokens = input.texts.filter((text) => text !== "").map(pathTokenText);
  const explicit = new Set(input.explicitPaths ?? []);
  const tracked = input.trackedPaths ?? [];
  const mentioned = (candidate: string) => tokens.some((text) => textNamesPath(text, candidate));
  return Object.freeze({
    names(path: string): boolean {
      if (path === "") return false;
      if (explicit.has(path) || mentioned(path)) return true;
      const slash = path.lastIndexOf("/");
      if (slash === -1) return false;
      const name = path.slice(slash + 1);
      if (!mentioned(name)) return false;
      const owners = tracked.filter((candidate) => fileName(candidate) === name);
      return owners.length === 1 && owners[0] === path;
    },
  });
}

/**
 * Hosted naming comes only from the ingress-captured verbatim operator input.
 * Normalized reader text, interpreted change scope, and legacy tasks carry no
 * naming provenance. A bare file name names nothing: the host and runner both
 * decide from this same input without a complete tracked-path inventory.
 */
export function hostedOperatorNamedPaths(
  readerTask:
    | {
        readonly operatorInput?: {
          readonly requestText: string;
          readonly targetPaths: readonly string[];
        };
      }
    | null
    | undefined,
): OperatorNamedPaths {
  const operatorInput = readerTask?.operatorInput;
  if (!operatorInput) return NO_OPERATOR_NAMED_PATHS;
  return operatorNamedPaths({
    texts: [operatorInput.requestText],
    explicitPaths: operatorInput.targetPaths,
  });
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
