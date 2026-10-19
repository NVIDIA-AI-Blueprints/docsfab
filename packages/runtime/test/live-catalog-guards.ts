// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { ModelEndpointConfig } from "../src/model/configuration.js";
import {
  containsInferenceCredential,
  containsMetadataCredential,
} from "../src/security/credential-material.js";
import { detectCredentialRuleIds } from "../src/security/repository-scanner.js";

const METADATA_CREDENTIAL = /^ihub_api_[A-Za-z0-9_-]{20,}$/u;
const METADATA_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u;
const METADATA_PATH = /^\/(?!\/)[^\u0000-\u001f\u007f?#]*$/u;

export interface MetadataLiveConfiguration {
  credential: string;
  origin: string;
  path: string;
  label: string;
}

export function resolveInferenceLiveConfiguration(
  environment: NodeJS.ProcessEnv,
  load: () => DocsFabConfig,
): ModelEndpointConfig | null {
  if (environment.DOCSFAB_LIVE_NVIDIA_INFERENCE_CATALOG_SMOKE !== "authorized") return null;
  try {
    return load().model;
  } catch {
    // Live-test configuration errors are a clean skip, never a network attempt.
    return null;
  }
}

export function resolveMetadataLiveConfiguration(
  environment: NodeJS.ProcessEnv,
): MetadataLiveConfiguration | null {
  if (environment.DOCSFAB_RUN_INFERENCE_HUB_METADATA_LIVE !== "1") return null;
  const credential = environment.INFERENCE_HUB_METADATA_API_KEY;
  const origin = environment.INFERENCE_HUB_METADATA_ORIGIN;
  const path = environment.INFERENCE_HUB_METADATA_PATH;
  const label = environment.INFERENCE_HUB_METADATA_LABEL;
  if (
    !credential ||
    !origin ||
    !path ||
    !label ||
    credential.length > 512 ||
    !METADATA_CREDENTIAL.test(credential) ||
    containsInferenceCredential(credential) ||
    !containsMetadataCredential(credential) ||
    !validMetadataOrigin(origin) ||
    !validMetadataPath(origin, path) ||
    Buffer.byteLength(label, "utf8") > 200 ||
    !METADATA_LABEL.test(label) ||
    label.includes("..") ||
    label.includes("//") ||
    detectCredentialRuleIds(label).length > 0
  ) {
    return null;
  }
  return { credential, origin, path, label };
}

export function containsExactSecret(value: unknown, secret: string): boolean {
  if (!secret) return true;
  const secretBytes = Buffer.from(secret, "utf8");
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) return true;
    if (typeof candidate === "string") return candidate.includes(secret);
    if (
      candidate === null ||
      candidate === undefined ||
      typeof candidate === "boolean" ||
      typeof candidate === "number" ||
      typeof candidate === "bigint"
    )
      return false;
    if (typeof candidate === "symbol") return String(candidate).includes(secret);
    if (
      (typeof candidate !== "object" && typeof candidate !== "function") ||
      seen.has(candidate as object)
    )
      return false;
    seen.add(candidate as object);
    try {
      if (candidate instanceof ArrayBuffer) {
        return Buffer.from(candidate).includes(secretBytes);
      }
      if (ArrayBuffer.isView(candidate)) {
        return Buffer.from(candidate.buffer, candidate.byteOffset, candidate.byteLength).includes(
          secretBytes,
        );
      }
      const proto = Object.getPrototypeOf(candidate);
      if (
        !Array.isArray(candidate) &&
        !(candidate instanceof Error) &&
        proto !== Object.prototype &&
        proto !== null
      )
        return true;
      for (const key of Reflect.ownKeys(candidate as object)) {
        if (typeof key === "string" && key.includes(secret)) return true;
        const descriptor = Object.getOwnPropertyDescriptor(candidate as object, key);
        // Accessors can conceal secret-bearing values from a safe, side-effect-free inspection.
        if (!descriptor) return true;
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          // Recent Node releases expose Error.stack through a lazy own accessor. Reading that
          // one platform accessor is necessary because test reporters render it on failure.
          if (candidate instanceof Error && key === "stack") {
            try {
              if (visit(candidate.stack, depth + 1)) return true;
              continue;
            } catch {
              return true;
            }
          }
          return true;
        }
        if (visit(descriptor.value, depth + 1)) return true;
      }
      return false;
    } catch {
      return true;
    }
  };
  return visit(value, 0);
}

export function assertCredentialFree(value: unknown, secret: string, surface: string): void {
  if (containsExactSecret(value, secret)) {
    throw new Error(`${surface} live smoke rejected secret-bearing diagnostic material.`);
  }
}

export function liveFailure(surface: string): Error {
  return new Error(`${surface} live smoke failed after credential-safe inspection.`);
}

function validMetadataOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function validMetadataPath(origin: string, path: string): boolean {
  if (
    !METADATA_PATH.test(path) ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === ".." || segment.includes("%"))
  )
    return false;
  try {
    const endpoint = new URL(path, origin);
    return endpoint.origin === origin && endpoint.pathname === path;
  } catch {
    return false;
  }
}
