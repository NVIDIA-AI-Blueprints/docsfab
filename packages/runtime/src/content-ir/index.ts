// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  buildContentIndex,
  buildContentIndexV2,
  buildScopedContentIndex,
  contentIndexAssetWarnings,
  contentIndexLimitations,
  contentIndexNameWarnings,
  describeContentIndexLimitation,
  isNavigationLimitation,
  resolveContentIndexLimits,
} from "./indexer.js";
export type { ContentIndexLimitation, ContentIndexLimits } from "./indexer.js";
export { canonicalDigest, canonicalJson } from "./canonical.js";
export { diffContentIndexes, diffContentIndexesV2 } from "./diff.js";
export {
  CONTENT_INDEX_ASSET_WARNING_CODE,
  CONTENT_INDEX_NAME_WARNING_CODE,
  ContentIndexError,
  PAGE_ANCHOR_NEXT_ACTIONS,
} from "./contracts.js";
export {
  ContentIndexDecodeError,
  decodeContentIndex,
  decodeContentIndexV1,
  decodeContentIndexV2,
  migrateContentIndexV1ToV2,
} from "./decoder.js";
export type * from "./contracts.js";
