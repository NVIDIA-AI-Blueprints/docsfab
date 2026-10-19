// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type PrivateContentId =
  | "qualityBenchmarkRuntime"
  | "livingDocumentationDataset"
  | "mvpScorecardPolicy"
  | "governedAssetsQualificationTest"
  | "foundationDogfoodTest"
  | "foundationDogfoodScorecard"
  | "modelComparisonSource"
  | "modelComparisonInstalled"
  | "nativePilotSource"
  | "harnessRoleQualificationSource"
  | "harnessRoleQualificationGovernedInputs"
  | "sourceCoverageTools"
  | "documentationSupervision";
export const PRIVATE_CONTENT_PATHS: Readonly<Partial<Record<PrivateContentId, string>>>;
