// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { continuationChainOriginalInput } from "../../inputs/operator-input-fill.js";
import {
  NO_OPERATOR_NAMED_PATHS,
  operatorNamedPaths,
  type OperatorNamedPaths,
} from "../../repository/operator-named-paths.js";
import type { RunRequestWithPublishProjection } from "./request.js";

/**
 * The paths a local run's own request names, for plan admission: its request
 * text and its `--context-path` and `--context-parent-path` pages. An InputAsk
 * continuation carries the request text and explicit target inputs of the
 * run that began its chain, read again from its record; a chain that cannot be
 * walked back, or whose first run's text differs from the carried one, names
 * nothing. `instructionContext`, an InputAsk reply, and a model's reading of
 * the request never name a path.
 */
export async function planOperatorNamedPaths(input: {
  readonly request: Pick<
    RunRequestWithPublishProjection,
    "instruction" | "contextTarget" | "operatorInputResume"
  >;
  readonly stateDirectory: string;
  readonly trackedPaths: readonly string[];
}): Promise<OperatorNamedPaths> {
  const original = await resolvePlanOperatorInput(input.request, input.stateDirectory);
  if (!original) return NO_OPERATOR_NAMED_PATHS;
  return operatorNamedPaths({
    texts: original.instruction === undefined ? [] : [original.instruction],
    explicitPaths: original.explicitPaths,
    trackedPaths: input.trackedPaths,
  });
}

/** The same verified original input is retained for later operator-approved NEXT. */
export async function resolvePlanOperatorInput(
  request: Pick<
    RunRequestWithPublishProjection,
    "instruction" | "contextTarget" | "operatorInputResume"
  >,
  stateDirectory: string,
): Promise<
  { readonly instruction?: string; readonly explicitPaths: readonly string[] } | undefined
> {
  if (request.operatorInputResume) {
    const original = await continuationChainOriginalInput(
      stateDirectory,
      request.operatorInputResume.originalRunId,
    );
    return original?.instruction === request.instruction ? original : undefined;
  }
  const target = request.contextTarget;
  return {
    instruction: request.instruction,
    explicitPaths: [
      ...new Set(
        [target?.sourcePath, target?.candidateParentPath].filter(
          (path): path is string => path !== undefined,
        ),
      ),
    ],
  };
}
