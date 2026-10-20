// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  readPresentationEnvironmentFacts,
  resolvePresentationCapabilities,
} from "./presentation/capabilities.js";
import { paintTerminalText } from "./presentation/render.js";

/** Shared accents for the live agent and interactive host setup. */
export function styleTerminalText(
  text: string,
  environment: NodeJS.ProcessEnv,
  style: { bold?: boolean; dim?: boolean; nvidiaGreen?: boolean; warning?: boolean },
): string {
  const capabilities = resolvePresentationCapabilities({
    stdout: { isTTY: true },
    stderr: { isTTY: true },
    environment: readPresentationEnvironmentFacts(environment),
  });
  return paintTerminalText(
    text,
    {
      ...(style.bold === undefined ? {} : { bold: style.bold }),
      ...(style.dim === undefined ? {} : { dim: style.dim }),
      ...(style.nvidiaGreen
        ? { color: "nvidiaGreen" as const }
        : style.warning
          ? { color: "yellow" as const }
          : {}),
    },
    capabilities.stdout,
  );
}
