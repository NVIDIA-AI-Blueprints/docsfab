// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/index.js";
import type { TemplatePreviewTopic } from "./contracts.js";

export const TEMPLATE_SELECTION_POLICY = Object.freeze({
  id: "docsfab:template-selection",
  version: "1",
});

/** Digest of the complete page-shape selection approved in the IA plan. */
export function templateSelectionDigest(topics: readonly TemplatePreviewTopic[]): string {
  return canonicalDigest(
    [...topics]
      .map((topic) => ({
        id: topic.id,
        slug: topic.slug,
        title: topic.title,
        templateId: topic.templateId,
        outputPath: topic.outputPath,
        ...(topic.productName === undefined ? {} : { productName: topic.productName }),
        ...(topic.summary === undefined ? {} : { summary: topic.summary }),
        evidenceNodeIds: [...topic.evidenceNodeIds].sort(compareText),
      }))
      .sort((left, right) => compareText(left.outputPath, right.outputPath)),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
