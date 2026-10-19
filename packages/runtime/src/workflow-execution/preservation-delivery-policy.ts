// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV =
  "DOCSFAB_EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE" as const;
export const EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE_ENV =
  "DOCSFAB_EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE" as const;

function enabled(environment: NodeJS.ProcessEnv, name: string): boolean {
  const raw = environment[name];
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`${name} must be 0 or 1 when set.`);
}

export function experimentalStageSpecificPreservationBaseEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return enabled(environment, EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV);
}

export function experimentalPreservationObservationReuseEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return enabled(environment, EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE_ENV);
}

export function preservationBaseDeliveryForHostWorkflow(input: {
  readonly workflow: string;
  readonly environment: NodeJS.ProcessEnv;
}): "eager" | "stage-specific" {
  return input.workflow === "restructure-documentation" &&
    experimentalStageSpecificPreservationBaseEnabled(input.environment)
    ? "stage-specific"
    : "eager";
}

export function resolvePreservationDeliveryPolicy(input: {
  readonly workflow: string;
  readonly environment: NodeJS.ProcessEnv;
}): {
  readonly preservationBaseDelivery: "eager" | "stage-specific";
  readonly preservationObservationReuse: boolean;
} {
  const preservationBaseDelivery = preservationBaseDeliveryForHostWorkflow(input);
  return {
    preservationBaseDelivery,
    preservationObservationReuse:
      preservationBaseDelivery === "stage-specific" &&
      experimentalPreservationObservationReuseEnabled(input.environment),
  };
}

export type PreservationDeliveryPolicy = ReturnType<typeof resolvePreservationDeliveryPolicy>;
