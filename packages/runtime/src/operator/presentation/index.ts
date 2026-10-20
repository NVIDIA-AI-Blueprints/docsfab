// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  resolvePresentationCapabilities,
  resolveProcessPresentationCapabilities,
  readPresentationEnvironmentFacts,
  unicodeCellWidth,
  type PresentationCapabilities,
  type PresentationCapabilityInput,
  type ProcessPresentationCapabilityOptions,
  type PresentationStreamCapabilities,
  type TerminalEnvironmentFacts,
  type TerminalStreamFacts,
} from "./capabilities.js";
export type {
  OperatorOutputCoordinator,
  PresentationProgressHandle,
  PresentationProgressUpdate,
} from "./coordinator.js";
export {
  presentActivity,
  presentCollection,
  presentDecision,
  presentInspection,
  presentResult,
  type PresentationOptions,
} from "./project.js";
export {
  paintTerminalText,
  renderPresentation,
  renderTerminal,
  type PresentationContext,
  type PresentationTerminalColor,
  type PresentationTerminalStyle,
  type RenderedPresentation,
} from "./render.js";
export { withOutputCoordinator, writeRenderedPresentation } from "./coordinator.js";
export type {
  ActivityPresentationFacts,
  CollectionPresentationFacts,
  DecisionPresentationFacts,
  InspectionPresentationFacts,
  PresentationAction,
  PresentationDetail,
  PresentationDocument,
  PresentationEvidence,
  PresentationField,
  PresentationImportance,
  PresentationAttention,
  PresentationRow,
  PresentationSection,
  PresentationStream,
  ResultPresentationFacts,
} from "./types.js";
