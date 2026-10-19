// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The request-intent binding of the shared contract kit, and the two error
 * kinds this module raises.
 *
 * A `RequestIntentFault` is a model-output defect found while decoding or
 * admitting a proposal; the public functions turn it into a result arm and
 * never let it escape. A `RequestIntentContractError` is a host fault: a
 * malformed host input, or a sealed artifact that fails verification.
 */
import { limitDefinition } from "../config/limits.js";
import {
  createContractKit,
  type ContractBoundExceeded,
  type ContractFail,
} from "../contract-kit/index.js";
import type { LocationOf } from "../contracts/model-output.js";
import type {
  RequestIntentAuthorityCode,
  RequestIntentBoundary,
  RequestIntentBoundExceeded,
  RequestIntentCode,
  RequestIntentLocation,
} from "./contract.js";

export class RequestIntentFault extends Error {
  public constructor(
    public readonly code: RequestIntentCode,
    public readonly location: RequestIntentLocation | null,
    public readonly at: string | null,
    public readonly bound?: RequestIntentBoundExceeded,
    public readonly boundary?: RequestIntentBoundary,
  ) {
    super(`Request-intent proposal refused with ${code} at ${at ?? "an unplaced location"}.`);
    this.name = "RequestIntentFault";
  }

  /** The same fault placed at a declared location and its concrete path. */
  public placed(location: RequestIntentLocation, at: string): RequestIntentFault {
    return new RequestIntentFault(this.code, location, at, this.bound, this.boundary);
  }
}

export type RequestIntentHostFaultCode =
  | "host-input-invalid"
  | "sealed-shape"
  | "sealed-digest-mismatch"
  | "sealed-instruction-mismatch"
  | "sealed-quote-mismatch"
  | "sealed-credential"
  | "sealed-duplicate-target"
  | "sealed-excluded-target"
  | "sealed-internal-path";

export class RequestIntentContractError extends Error {
  public constructor(
    public readonly code: RequestIntentHostFaultCode,
    detail: string,
  ) {
    super(`Request-intent host contract refused (${code}): ${detail}`);
    this.name = "RequestIntentContractError";
  }
}

const SHAPE = "request-intent-shape" as const;
const SIZE = "request-intent-size" as const;

// Kit bounds are the shared `runtime.contract.*` decode ceilings. The strict
// walk runs over the whole proposal first, so a kit bound is placed at `$`.
const failProposal: ContractFail<RequestIntentCode> = (code, boundExceeded) => {
  throw new RequestIntentFault(code, null, null, kitBound(boundExceeded));
};

function kitBound(
  details: ContractBoundExceeded | undefined,
): RequestIntentBoundExceeded | undefined {
  if (!details) return undefined;
  return {
    name: details.axis,
    limit: details.limit,
    observed: details.observed,
    scope: limitDefinition(details.axis).scope,
  };
}

/** Decodes model proposals; every kit refusal is a model-output fault. */
export const proposalKit = createContractKit<RequestIntentCode>({
  fail: failProposal,
  inertMode: "strict",
  codes: {
    invalidShape: SHAPE,
    invalidValue: SHAPE,
    credentialMaterial: "request-intent-disclosure",
    // The proposal kit never seals or verifies; these cannot fire from it.
    digestMismatch: SHAPE,
    schemaMismatch: SHAPE,
    boundExceeded: SIZE,
  },
});

type SealedCode = Extract<
  RequestIntentHostFaultCode,
  "sealed-shape" | "sealed-digest-mismatch" | "sealed-credential"
>;

const failSealed: ContractFail<SealedCode> = (code, boundExceeded) => {
  const bound = boundExceeded ? ` (${boundExceeded.axis} ${boundExceeded.observed})` : "";
  throw new RequestIntentContractError(code, `the sealed request intent does not verify${bound}.`);
};

/** Seals and verifies the host artifact; every kit refusal is a host integrity fault. */
export const sealedKit = createContractKit<SealedCode>({
  fail: failSealed,
  inertMode: "strict",
  codes: {
    invalidShape: "sealed-shape",
    invalidValue: "sealed-shape",
    credentialMaterial: "sealed-credential",
    digestMismatch: "sealed-digest-mismatch",
    schemaMismatch: "sealed-shape",
  },
});

/**
 * Run one kit read at a declared field location. Handles only an unplaced
 * shape fault (a kit refusal of this field); a fault already placed deeper,
 * any other code, and any other error pass through unchanged.
 */
export function at<T>(location: LocationOf<typeof SHAPE>, path: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof RequestIntentFault && error.location === null && error.code === SHAPE) {
      throw error.placed(location, path);
    }
    throw error;
  }
}

/** Raise a model-output fault at a location the catalog declares for its code. */
export function reject<C extends RequestIntentCode>(
  code: C,
  location: LocationOf<C>,
  path: string,
  bound?: RequestIntentBoundExceeded,
): never {
  throw new RequestIntentFault(code, location, path, bound);
}

/** Raise an authority refusal at a declared location, naming the boundary it crossed. */
export function refuse<C extends RequestIntentAuthorityCode>(
  code: C,
  location: LocationOf<C>,
  path: string,
  boundary: RequestIntentBoundary,
): never {
  throw new RequestIntentFault(code, location, path, undefined, boundary);
}
