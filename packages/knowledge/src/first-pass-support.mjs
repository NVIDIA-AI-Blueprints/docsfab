// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Public first-pass support entry point: the stable import path for gather,
 * tests, and runtime wrappers. Implementation lives in the first-pass/ modules.
 */
export { FirstPassSupportError } from "./first-pass/error.mjs";
export {
  FirstPassEvidenceFrameError,
  parseEvidenceFrames,
} from "./first-pass/evidence-frame.mjs";
export {
  IGNORED_DIRECTORIES,
  IGNORED_ROOT_DIRECTORIES,
  ignoredScanAncestor,
  isIgnoredScanDirectory,
} from "./first-pass/scan.mjs";
export {
  UNCLEAR_CHANGE_WORDS,
  containsFirstPassCredentialMaterial,
  isFirstPassWriteRoot,
  isInsideAuthorizedWriteRoots,
  isLocalDocumentationRoot,
  normalizeAuthorizedWriteRoots,
  nonActionableNamedTargets,
  normalizeBoundSourcePaths,
  parseOrdinaryDocumentationRequest,
} from "./first-pass/parse.mjs";
export {
  FIRST_PASS_CORRECTIONS,
  FIRST_PASS_SUPPORT_KIND,
  FIRST_PASS_SUPPORT_LIMITS,
  assessOrdinaryDocumentationSupport,
  decodeFirstPassRequestIntent,
} from "./first-pass/assess.mjs";
export {
  DOCUMENTATION_PARTIAL_APPLICABILITIES,
  DOCUMENTATION_PARTIAL_KIND,
  applyDocumentationPartialAnswer,
  classifyDocumentationPartialFallback,
} from "./first-pass/partial.mjs";
