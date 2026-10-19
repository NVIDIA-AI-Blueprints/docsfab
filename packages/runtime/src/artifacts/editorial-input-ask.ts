// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type EditorialInputAskFillKindV1 = "path" | "text" | "comparison" | "request";

export interface EditorialInputAskPresentationV1 {
  readonly label: string;
  readonly why: string;
  readonly fillKind: EditorialInputAskFillKindV1;
}

const EDITORIAL_INPUT_ASK_PRESENTATION: Readonly<Record<string, EditorialInputAskPresentationV1>> =
  {
    "current-documentation": {
      label: "Current documentation",
      why: "Named documentation pages must be admitted as current documentation.",
      fillKind: "path",
    },
    "public-contract": {
      label: "Public contract",
      why: "A public contract is still required before this editorial stop can close.",
      fillKind: "path",
    },
    prd: {
      label: "Product requirements",
      why: "A product requirements document is still required.",
      fillKind: "text",
    },
    "accepted-decision": {
      label: "Accepted decision",
      why: "An accepted decision is still required.",
      fillKind: "text",
    },
    comparison: {
      label: "Revision comparison",
      why: "An exact base and head or workspace comparison was not supplied.",
      fillKind: "comparison",
    },
    request: {
      label: "Operator request",
      why: "The original instruction must be admitted as request evidence.",
      fillKind: "request",
    },
    "editorial-identity": {
      label: "Host-owned editorial identity",
      why: "The planner minted identity the host could not admit. Supply the named inputs.",
      fillKind: "text",
    },
  };

/**
 * A CREATE source-support slot, `source-support:<dimension>:<page>`.
 *
 * One slot names one target page and the technical dimension that the bound
 * sources could not establish for it. `documented-behavior` stands for a page
 * whose coverage stayed unverified with no host-owned dimension gap. Only a
 * tracked repository file can fill it: technical verification cites source
 * locations, and a paragraph cannot certify a fact.
 */
export const SOURCE_SUPPORT_INPUT_PREFIX = "source-support";
export const SOURCE_SUPPORT_UNSPECIFIED_DIMENSION = "documented-behavior";

const SOURCE_SUPPORT_DIMENSION = /^[a-z]+(?:-[a-z]+)*$/u;
/** Repository-relative; no segment starts with a dot, so `.` and `..` cannot occur. */
const SOURCE_SUPPORT_PAGE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/u;

export interface SourceSupportInputV1 {
  readonly dimension: string;
  readonly pagePath: string;
}

/** The slot id for one page and dimension, or `undefined` outside the grammar. */
export function sourceSupportInputIdV1(input: SourceSupportInputV1): string | undefined {
  if (!validSourceSupport(input)) return undefined;
  return `${SOURCE_SUPPORT_INPUT_PREFIX}:${input.dimension}:${input.pagePath}`;
}

/** Read a source-support slot id strictly; anything else is `undefined`. */
export function parseSourceSupportInputIdV1(inputId: string): SourceSupportInputV1 | undefined {
  const parts = inputId.split(":");
  if (parts.length !== 3 || parts[0] !== SOURCE_SUPPORT_INPUT_PREFIX) return undefined;
  const [, dimension, pagePath] = parts as [string, string, string];
  return validSourceSupport({ dimension, pagePath }) ? { dimension, pagePath } : undefined;
}

function validSourceSupport(input: SourceSupportInputV1): boolean {
  return SOURCE_SUPPORT_DIMENSION.test(input.dimension) && SOURCE_SUPPORT_PAGE.test(input.pagePath);
}

/**
 * English InputAsk presentation. Never includes host paths, hashes, or
 * credentials; a source-support slot names its repository-relative page.
 */
export function editorialInputAskPresentationV1(
  inputId: string,
): EditorialInputAskPresentationV1 | undefined {
  if (Object.hasOwn(EDITORIAL_INPUT_ASK_PRESENTATION, inputId)) {
    return EDITORIAL_INPUT_ASK_PRESENTATION[inputId];
  }
  const sourceSupport = parseSourceSupportInputIdV1(inputId);
  if (!sourceSupport) return undefined;
  const subject = sourceSupport.dimension.replaceAll("-", " ");
  return {
    label: `Source for ${subject} on ${sourceSupport.pagePath}`,
    why: `Technical verification could not establish ${subject} for ${sourceSupport.pagePath} from the bound sources. Supply a tracked repository file that establishes it; a paragraph cannot certify source support.`,
    fillKind: "path",
  };
}
