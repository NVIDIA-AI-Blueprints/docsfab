// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EXECUTABLE_ROUTE_BASE_URLS } from "../config/executable-route-urls.js";
import { limit } from "../config/limits.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { assertLocalhostEndpointResolvesToLoopback } from "../model/endpoint-transport.js";
import {
  captureProxyRefusal,
  chatCompletionsProbeShape,
  createProbeFetch,
  formatEndpointCompatibility,
  probeEndpointCompatibility,
  refusedEndpointReport,
  type EndpointCompatibilityReport,
} from "../profile/endpoint-compatibility.js";
import * as probeCore from "../profile/probe-core.js";
import { releaseModelCredential } from "../security/model-credential-release.js";
import type { ProfileProbeArguments, ProfileProbeVerdict } from "./profile-arguments.js";

export const PREFIX_MATCHER_ERROR =
  "profile probe rejects prefix matchers; use an exact Hub or OpenAI model id.";

export const PROFILE_PROBE_KIND = "docsfab-profile-probe-observation";

const PREFIX_MATCHER_SEGMENTS = new Set(["gpt-5", "o1", "gpt-4", "o3"]);

const inferenceBaseUrl = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
export const ROUTE_PROBE_TARGETS = {
  ...(inferenceBaseUrl === undefined
    ? {}
    : {
        "nvidia-inference-api": {
          baseUrl: inferenceBaseUrl,
          credentialEnvNames: ["MODEL_API_KEY"],
        },
      }),
  "nvidia-api-catalog": {
    baseUrl: EXECUTABLE_ROUTE_BASE_URLS["nvidia-api-catalog"],
    credentialEnvNames: ["DOCSFAB_NVIDIA_API_KEY"],
  },
  "openai-api": {
    baseUrl: EXECUTABLE_ROUTE_BASE_URLS["openai-api"],
    credentialEnvNames: ["MODEL_API_KEY", "OPENAI_API_KEY"],
  },
} as const;

export type ProbeableRouteId = keyof typeof ROUTE_PROBE_TARGETS;

export type MatrixProbeSample = probeCore.ReasoningProbeSample;

export type MatrixProbeOne = typeof probeCore.probeOne;

export type MatrixDecideVerdict = (
  plain: MatrixProbeSample,
  noThink: MatrixProbeSample | null,
) => ProfileProbeVerdict;

export interface ProfileProbeDependencies {
  readonly probeOne?: MatrixProbeOne;
  readonly decideVerdict?: MatrixDecideVerdict;
  readonly probeCompatibility?: typeof probeCore.probeCompatibility;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ProfileProbeObservation {
  readonly schemaVersion: 1;
  readonly kind: typeof PROFILE_PROBE_KIND;
  readonly live: boolean;
  readonly locator: string;
  readonly verdict: ProfileProbeVerdict | "not-requested";
  /** Null when live inference was not requested. */
  readonly compatibility: EndpointCompatibilityReport | null;
}

export function isPrefixMatcher(modelId: string): boolean {
  if (modelId.includes("*")) return true;
  const last = modelId.split("/").pop() ?? modelId;
  return PREFIX_MATCHER_SEGMENTS.has(last) || /^(?:gpt-\d+|o\d+)$/u.test(last);
}

export function assertExactModelId(modelId: string): void {
  if (isPrefixMatcher(modelId)) throw new Error(PREFIX_MATCHER_ERROR);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?:\/[A-Za-z0-9._:-]+)*$/u.test(modelId)) {
    throw new Error("profile probe requires an exact Hub or OpenAI model id.");
  }
}

export function probeLocator(routeId: string, modelId: string): string {
  return `${routeId}:${modelId}`;
}

export function isProbeableRouteId(routeId: string): routeId is ProbeableRouteId {
  return Object.hasOwn(ROUTE_PROBE_TARGETS, routeId);
}

export function formatProfileProbeObservation(observation: ProfileProbeObservation): string {
  if (!observation.live) {
    return [
      "Probe: not requested (use --live)",
      `Locator: ${observation.locator}`,
      "Default/offline profile probe does not spend.",
    ].join("\n");
  }
  return [
    `Probe verdict: ${observation.verdict}`,
    `Locator: ${observation.locator}`,
    ...(observation.compatibility ? formatEndpointCompatibility(observation.compatibility) : []),
  ].join("\n");
}

export function serializeProfileProbeObservation(observation: ProfileProbeObservation): string {
  return canonicalizeJsonEvidence(observation as unknown as JsonEvidenceValue);
}

function resolveLiveCredentialEnv(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): string {
  const present = names.find((name) => (environment[name] ?? "").length > 0);
  if (!present) {
    throw new Error(
      `${names[0]} is not set. Export the credential; observation fields stay credential-free.`,
    );
  }
  return environment[present]!;
}

/** The request control a drafted policy installs for a controllable split. */
const THINKING_DISABLED = Object.freeze({ chat_template_kwargs: { thinking: false } });

export async function runProfileProbe(
  args: ProfileProbeArguments,
  dependencies: ProfileProbeDependencies = {},
): Promise<ProfileProbeObservation> {
  assertExactModelId(args.modelId);
  const target = isProbeableRouteId(args.routeId) ? ROUTE_PROBE_TARGETS[args.routeId] : undefined;
  if (target === undefined) {
    throw new Error("profile probe received an unknown serving route and cannot continue.");
  }
  const locator = probeLocator(args.routeId, args.modelId);
  if (!args.live) {
    return {
      schemaVersion: 1,
      kind: PROFILE_PROBE_KIND,
      live: false,
      locator,
      verdict: "not-requested",
      compatibility: null,
    };
  }

  const environment = dependencies.environment ?? process.env;
  const apiKey = resolveLiveCredentialEnv(target.credentialEnvNames, environment);
  // The probe always targets the route's own default endpoint.
  const provider = {
    baseUrl: target.baseUrl,
    credential: releaseModelCredential(
      { endpoint: target.baseUrl, endpointSource: "preset", apiKey },
      "profile-probe",
    ),
  };
  const probeOne = dependencies.probeOne ?? probeCore.probeOne;
  const decideVerdict = dependencies.decideVerdict ?? probeCore.decideVerdict;
  // No installed policy is bound yet, so the route decides the request shape.
  const shape = chatCompletionsProbeShape({
    providerId: args.routeId,
    baseUrl: target.baseUrl,
    requestPolicy: false,
    reasoning: false,
    supportsDeveloperRole: false,
  });
  await assertLocalhostEndpointResolvesToLoopback(target.baseUrl);
  // A proxy refusal would otherwise read as an unreachable route; both sample
  // passes share one capture, so the first refusal on either is thrown.
  const capture = captureProxyRefusal(createProbeFetch(target.baseUrl));
  const sampleOptions = {
    fetch: capture.fetch,
    tokenField: shape.tokenField,
    timeoutMs: limit("endpointProbe.requestTimeoutMs").value,
    errorBodyMaxChars: limit("endpointProbe.providerMessageMaxChars").value,
    credentialEchoMinChars: limit("endpointProbe.credentialEchoMinChars").value,
    sampleMaxTokens: limit("endpointProbe.reasoningSampleMaxTokens").value,
  };
  const prompts = probeCore.DEFAULT_PROMPTS;
  const plain = await probeOne(args.modelId, provider, {}, prompts, sampleOptions);
  capture.throwIfRefused();
  const noThink = plain.reasoningSplit
    ? await probeOne(args.modelId, provider, THINKING_DISABLED, prompts, sampleOptions)
    : null;
  capture.throwIfRefused();
  const verdict = decideVerdict(plain, noThink);
  const maxOutputTokens = limit("endpointProbe.maxOutputTokens").value;
  const classify = {
    maxOutputTokens,
    outputLimitSource: "probe-default",
    credential: apiKey,
  } as const;
  const compatibility = plain.reachable
    ? await probeEndpointCompatibility(
        {
          modelId: args.modelId,
          baseUrl: target.baseUrl,
          endpointSource: "preset",
          apiKey,
          maxOutputTokens,
          outputLimitSource: "probe-default",
          shape,
          ...(verdict === "reasoning-split-controllable" ? { extraBody: THINKING_DISABLED } : {}),
        },
        dependencies.probeCompatibility,
      )
    : refusedEndpointReport(
        {
          status: plain.status ?? 0,
          body: plain.error ?? "",
          bodyTruncated: plain.errorTruncated === true,
        },
        classify,
      );
  return {
    schemaVersion: 1,
    kind: PROFILE_PROBE_KIND,
    live: true,
    locator,
    verdict,
    compatibility,
  };
}
