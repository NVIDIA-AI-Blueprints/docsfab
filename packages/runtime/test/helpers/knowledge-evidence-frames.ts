// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FirstPassEvidenceFrameParser } from "../../src/cli/first-pass-support.js";

/**
 * The knowledge provider's own evidence frame parser, loaded from the source
 * checkout the way production loads the installed provider. Scripted model
 * fakes read spans with it instead of a local copy of the frame grammar.
 */
const knowledgeSupport = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../knowledge/src/first-pass-support.mjs"),
).href;

export const { parseEvidenceFrames } = (await import(knowledgeSupport)) as {
  parseEvidenceFrames: FirstPassEvidenceFrameParser;
};

export const loadEvidenceFrameParser = async (): Promise<FirstPassEvidenceFrameParser> =>
  parseEvidenceFrames;

const frameModule = pathToFileURL(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../knowledge/src/first-pass/evidence-frame.mjs",
  ),
).href;
export const { renderEvidenceFrames } = (await import(frameModule)) as {
  renderEvidenceFrames: (
    spans: readonly {
      id: string;
      path: string;
      lineStart: number;
      lineEnd: number;
      fileSha256: string;
      spanSha256: string;
      text: string;
    }[],
    hostTexts: readonly string[],
  ) => readonly string[];
};
