// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  codeFence,
  escapeMdxText,
  inlineCodeSpan,
  type TextMode,
  type TextPosition,
} from "./escape.js";
export {
  FERN_EMITTED_INTENTS,
  FERN_INTENT_EMITTERS,
  type FernEmitContext,
  type FernIntentEmitter,
  type FernIntentEmitterTable,
} from "./emitters.js";
export {
  checkFernMdx,
  jsxFragmentParses,
  type MdxSafetyIssue,
  type MdxSafetyIssueCode,
} from "./mdx-check.js";
export { emitFernPage, joinFernBlocks } from "./page.js";
export {
  FERN_BUILT_IN_COMPONENTS,
  FERN_EMIT_REFUSAL_NEXT_ACTIONS,
  type FernBuiltInComponent,
  type FernEmitNotice,
  type FernEmitNoticeCode,
  type FernEmitRefusal,
  type FernEmitRefusalCode,
  type FernEmitSources,
  type FernPageFrontmatter,
  type FernPageInput,
  type FernPageResult,
  type FernSourceRequest,
} from "./types.js";
