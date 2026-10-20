// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  renderPresentation,
  resolveProcessPresentationCapabilities,
  type PresentationCapabilities,
  type PresentationDocument,
  type RenderedPresentation,
} from "../operator/index.js";

export interface CliPresentationWriters {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Render a projected document with the current process's independent stream capabilities. */
export function renderCliPresentation(
  document: PresentationDocument,
  capabilities: PresentationCapabilities = resolveProcessPresentationCapabilities(),
): RenderedPresentation {
  const rendered = renderPresentation(document, capabilities);
  if (document.title === "" && rendered.stdout === "\n") {
    return { ...rendered, stdout: "" };
  }
  return rendered;
}

/** Write an already-projected document, preserving the renderer's stream assignment. */
export function writeCliPresentation(
  document: PresentationDocument,
  writers: CliPresentationWriters = { stdout: console.log, stderr: console.error },
  capabilities?: PresentationCapabilities,
): RenderedPresentation {
  const rendered = renderCliPresentation(document, capabilities);
  if (rendered.stdout.length > 0) writers.stdout(rendered.stdout.trimEnd());
  if (rendered.stderr.length > 0) writers.stderr(rendered.stderr.trimEnd());
  return rendered;
}
