// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  ExternalInputContractError,
  type ExternalInputDisclosurePolicy,
  type ExternalInputHostCapability,
  type ExternalInputIntendedRole,
  type ExternalInputVisibility,
} from "./contracts.js";
import {
  advanceExternalInputLifecycle,
  getExternalInputAccessBinding,
  getExternalInputLifecycleState,
  getRegisteredExternalInput,
  recordExternalInputAccess,
  registerFakeExternalInput,
  type ExternalInputAccessObservationV1,
} from "./access.js";
import { createInputsDialect, deepFreeze } from "./dialect.js";

function fail(code: ExternalInputContractError["code"]): never {
  throw new ExternalInputContractError(code);
}

const {
  canonicalDigest,
  assertInert,
  rejectCredentials,
  string,
  identifier,
  hash,
  enumeration,
  compare,
} = createInputsDialect(fail);

/** Default bounded upload size for local PDF / extract evidence. */
export const LOCAL_UPLOAD_DEFAULT_MAX_BYTES = 512_000;

export const LOCAL_UPLOAD_MEDIA_KINDS = ["pdf", "pdf-extract-text", "unsupported"] as const;
export type LocalUploadMediaKind = (typeof LOCAL_UPLOAD_MEDIA_KINDS)[number];

export const LOCAL_UPLOAD_DISPOSITIONS = [
  "registered",
  "unsupported",
  "encrypted",
  "oversized",
  "malformed",
  "digest-mismatch",
  "changed",
  "revoked",
  "inaccessible",
] as const;
export type LocalUploadDisposition = (typeof LOCAL_UPLOAD_DISPOSITIONS)[number];

export interface LocalUploadBytesOfferV1 {
  inputId: string;
  safeTitle: string;
  /**
   * Logical upload name only (repo-relative or fixture-relative). Absolute host
   * paths are rejected so the model cannot bypass registration via path reads.
   */
  logicalName: string;
  mediaKind: LocalUploadMediaKind;
  /** Host-supplied bytes — never loaded from arbitrary caller paths. */
  bytes: Uint8Array | string;
  expectedContentDigestSha256?: string;
  visibility: ExternalInputVisibility;
  disclosurePolicy: ExternalInputDisclosurePolicy;
  intendedRoles: ExternalInputIntendedRole[];
  maxBytes?: number;
}

export interface LocalUploadDispositionV1 {
  schemaVersion: 1;
  kind: "docsfab-local-upload-disposition";
  disposition: LocalUploadDisposition;
  reasonCode: string;
  inputId: string | null;
  contentDigestSha256: string | null;
  mediaKind: LocalUploadMediaKind | null;
  parserId: string | null;
  parserVersion: string | null;
  limitations: string[];
  dispositionSha256: string;
}

interface LocalUploadBody {
  bytes: Uint8Array;
  contentDigestSha256: string;
  mediaKind: LocalUploadMediaKind;
  logicalName: string;
}

interface LocalUploadSurfaceState {
  bodies: Map<string, LocalUploadBody>;
}

const uploadSurfaces = new WeakMap<object, LocalUploadSurfaceState>();

export const LOCAL_UPLOAD_PARSER_ID = "docsfab-local-upload-v1";
export const LOCAL_UPLOAD_PARSER_VERSION = "1.0.0";

/**
 * Attach a disposable local-upload surface to an access-capture capability.
 * Bodies stay in the private WeakMap; durable records keep digests only.
 */
export function openLocalUploadSurface(capability: ExternalInputHostCapability): void {
  // Access-capture binding is required; bare registries cannot hold uploads.
  getExternalInputAccessBinding(capability);
  if (uploadSurfaces.has(capability as object)) return;
  uploadSurfaces.set(capability as object, { bodies: new Map() });
}

function requireUpload(capability: ExternalInputHostCapability): LocalUploadSurfaceState {
  openLocalUploadSurface(capability);
  const state = uploadSurfaces.get(capability as object);
  if (!state) fail("authority-required");
  return state;
}

/** Digest upload bytes without retaining the body in the returned value. */
export function digestLocalUploadBytes(bytes: Uint8Array | string): string {
  const normalized = normalizeUploadBytes(bytes);
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Host-only registration of a local upload. Caller- or model-supplied absolute
 * paths are rejected; only host-passed bytes enter the disposable surface.
 */
export function registerLocalUpload(
  capability: ExternalInputHostCapability,
  offer: LocalUploadBytesOfferV1,
): LocalUploadDispositionV1 {
  const state = requireUpload(capability);
  assertInert({
    inputId: offer.inputId,
    safeTitle: offer.safeTitle,
    logicalName: offer.logicalName,
    mediaKind: offer.mediaKind,
    expectedContentDigestSha256: offer.expectedContentDigestSha256,
    visibility: offer.visibility,
    disclosurePolicy: offer.disclosurePolicy,
    intendedRoles: offer.intendedRoles,
    maxBytes: offer.maxBytes,
  });
  rejectCredentials({
    inputId: offer.inputId,
    safeTitle: offer.safeTitle,
    logicalName: offer.logicalName,
  });

  const inputId = identifier(offer.inputId);
  const logicalName = safeLogicalName(offer.logicalName);
  const mediaKind = enumeration(offer.mediaKind, LOCAL_UPLOAD_MEDIA_KINDS);
  const maxBytes = normalizeMaxBytes(offer.maxBytes);

  let bytes: Uint8Array;
  try {
    bytes = normalizeUploadBytes(offer.bytes);
  } catch (error) {
    if (error instanceof ExternalInputContractError) {
      return sealDisposition({
        disposition: "malformed",
        reasonCode: "upload-bytes-malformed",
        inputId,
        contentDigestSha256: null,
        mediaKind,
        parserId: LOCAL_UPLOAD_PARSER_ID,
        parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
        limitations: ["bytes-not-normalizable"],
      });
    }
    throw error;
  }

  if (bytes.byteLength > maxBytes) {
    return sealDisposition({
      disposition: "oversized",
      reasonCode: "upload-exceeds-max-bytes",
      inputId,
      contentDigestSha256: null,
      mediaKind,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: [`max-bytes:${maxBytes}`],
    });
  }

  if (mediaKind === "unsupported") {
    return sealDisposition({
      disposition: "unsupported",
      reasonCode: "media-kind-unsupported",
      inputId,
      contentDigestSha256: null,
      mediaKind,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: ["supported:pdf,pdf-extract-text"],
    });
  }

  const probe = probeUploadMedia(bytes, mediaKind);
  if (probe.disposition !== "ok") {
    return sealDisposition({
      disposition: probe.disposition,
      reasonCode: probe.reasonCode,
      inputId,
      contentDigestSha256: null,
      mediaKind,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: probe.limitations,
    });
  }

  const contentDigestSha256 = digestLocalUploadBytes(bytes);
  if (offer.expectedContentDigestSha256 !== undefined) {
    const expected = hash(offer.expectedContentDigestSha256);
    if (expected !== contentDigestSha256) {
      return sealDisposition({
        disposition: "digest-mismatch",
        reasonCode: "upload-content-digest-mismatch",
        inputId,
        contentDigestSha256,
        mediaKind,
        parserId: LOCAL_UPLOAD_PARSER_ID,
        parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
        limitations: ["expected-digest-did-not-match"],
      });
    }
  }

  const existing = state.bodies.get(inputId);
  if (existing && existing.contentDigestSha256 !== contentDigestSha256) {
    try {
      const lifecycle = getExternalInputLifecycleState(capability, inputId);
      if (lifecycle !== "revoked" && lifecycle !== "excluded" && lifecycle !== "changed") {
        advanceExternalInputLifecycle(capability, {
          inputId,
          to: "changed",
          reasonCode: "upload-bytes-changed",
          evidenceSha256s: [contentDigestSha256],
        });
      }
    } catch (error) {
      if (!(error instanceof ExternalInputContractError)) throw error;
    }
    return sealDisposition({
      disposition: "changed",
      reasonCode: "upload-content-changed-after-registration",
      inputId,
      contentDigestSha256,
      mediaKind,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: ["re-register-required"],
    });
  }

  if (existing && existing.contentDigestSha256 === contentDigestSha256) {
    return sealDisposition({
      disposition: "registered",
      reasonCode: "upload-already-registered",
      inputId,
      contentDigestSha256,
      mediaKind,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: probe.limitations,
    });
  }

  const bodyText = utf8DecodeLossy(bytes);
  try {
    registerFakeExternalInput(capability, inputId, {
      adapterKind: "upload",
      canonicalLocator: `docsfab-upload://${logicalName}`,
      safeTitle: string(offer.safeTitle),
      body: bodyText,
      version: { kind: "content-digest", contentDigestSha256 },
      visibility: enumeration(offer.visibility, [
        "public",
        "internal",
        "restricted",
        "private",
      ] as const),
      disclosurePolicy: enumeration(offer.disclosurePolicy, [
        "cite-and-quote",
        "cite-only",
        "identity-only",
        "redacted",
        "forbidden",
      ] as const),
      intendedRoles: [...offer.intendedRoles].sort(compare) as ExternalInputIntendedRole[],
    });
  } catch (error) {
    if (error instanceof ExternalInputContractError) {
      return sealDisposition({
        disposition: "malformed",
        reasonCode: `upload-register-${error.code}`,
        inputId,
        contentDigestSha256,
        mediaKind,
        parserId: LOCAL_UPLOAD_PARSER_ID,
        parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
        limitations: [error.code],
      });
    }
    throw error;
  }

  state.bodies.set(inputId, {
    bytes,
    contentDigestSha256,
    mediaKind,
    logicalName,
  });

  return sealDisposition({
    disposition: "registered",
    reasonCode: "upload-registered",
    inputId,
    contentDigestSha256,
    mediaKind,
    parserId: LOCAL_UPLOAD_PARSER_ID,
    parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
    limitations: probe.limitations,
  });
}

/**
 * Host-only revoke of a previously registered upload. Subsequent reads and
 * citations fail closed with an explicit revoked disposition.
 */
export function revokeLocalUpload(
  capability: ExternalInputHostCapability,
  inputId: string,
  evidenceSha256s: string[] = [],
): LocalUploadDispositionV1 {
  const state = requireUpload(capability);
  const id = identifier(inputId);
  const registration = getRegisteredExternalInput(capability, id);
  const lifecycle = getExternalInputLifecycleState(capability, id);
  if (lifecycle === "revoked") {
    return sealDisposition({
      disposition: "revoked",
      reasonCode: "upload-already-revoked",
      inputId: id,
      contentDigestSha256: registration.contentDigestSha256,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: [],
    });
  }
  if (lifecycle === "excluded") {
    return sealDisposition({
      disposition: "inaccessible",
      reasonCode: "upload-excluded-terminal",
      inputId: id,
      contentDigestSha256: registration.contentDigestSha256,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: ["excluded-cannot-revoke"],
    });
  }
  advanceExternalInputLifecycle(capability, {
    inputId: id,
    to: "revoked",
    reasonCode: "upload-revoked",
    evidenceSha256s:
      evidenceSha256s.length === 0
        ? [canonicalDigest({ kind: "docsfab-local-upload-revoke", inputId: id })]
        : evidenceSha256s.map((value) => hash(value)),
  });
  state.bodies.delete(id);
  return sealDisposition({
    disposition: "revoked",
    reasonCode: "upload-revoked",
    inputId: id,
    contentDigestSha256: registration.contentDigestSha256,
    mediaKind: null,
    parserId: LOCAL_UPLOAD_PARSER_ID,
    parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
    limitations: ["body-discarded"],
  });
}

/**
 * Open a registered upload for a step. Returns an access observation on success
 * or a safe disposition when lifecycle / digests block access.
 */
export function accessLocalUpload(
  capability: ExternalInputHostCapability,
  input: {
    inputId: string;
    stepId: string;
    accessorId?: string;
  },
): ExternalInputAccessObservationV1 | LocalUploadDispositionV1 {
  const state = requireUpload(capability);
  const inputId = identifier(input.inputId);
  const registration = getRegisteredExternalInput(capability, inputId);
  const lifecycle = getExternalInputLifecycleState(capability, inputId);
  if (lifecycle === "revoked") {
    return sealDisposition({
      disposition: "revoked",
      reasonCode: "upload-revoked",
      inputId,
      contentDigestSha256: registration.contentDigestSha256,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: [],
    });
  }
  if (lifecycle === "changed") {
    return sealDisposition({
      disposition: "changed",
      reasonCode: "upload-changed",
      inputId,
      contentDigestSha256: registration.contentDigestSha256,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: [],
    });
  }
  if (lifecycle === "inaccessible" || registration.locator.permissionClass === "inaccessible") {
    return sealDisposition({
      disposition: "inaccessible",
      reasonCode: "upload-inaccessible",
      inputId,
      contentDigestSha256: null,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: [],
    });
  }
  const body = state.bodies.get(inputId);
  if (!body) {
    return sealDisposition({
      disposition: "inaccessible",
      reasonCode: "upload-body-not-in-surface",
      inputId,
      contentDigestSha256: registration.contentDigestSha256,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: ["disposable-body-absent"],
    });
  }

  const live = digestLocalUploadBytes(body.bytes);
  if (live !== body.contentDigestSha256) {
    return sealDisposition({
      disposition: "changed",
      reasonCode: "upload-live-digest-drift",
      inputId,
      contentDigestSha256: live,
      mediaKind: body.mediaKind,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: [],
    });
  }

  const opened =
    registration.contentDigestSha256 !== null &&
    registration.locator.permissionClass === "readable";
  return recordExternalInputAccess(capability, {
    inputId,
    stepId: identifier(input.stepId),
    outcome: opened ? "opened" : "metadata-only",
    observedContentDigestSha256: opened ? registration.contentDigestSha256 : null,
    accessorId: identifier(input.accessorId ?? "docsfab-local-upload-adapter"),
    evidenceSha256s: [body.contentDigestSha256],
  });
}

/** Read disposable upload bytes only when registration and lifecycle permit. */
export function readLocalUploadBytes(
  capability: ExternalInputHostCapability,
  inputId: string,
):
  | { contentDigestSha256: string; bytes: Uint8Array; mediaKind: LocalUploadMediaKind }
  | LocalUploadDispositionV1 {
  const state = requireUpload(capability);
  const id = identifier(inputId);
  const registration = getRegisteredExternalInput(capability, id);
  const lifecycle = getExternalInputLifecycleState(capability, id);
  if (lifecycle === "revoked") {
    return sealDisposition({
      disposition: "revoked",
      reasonCode: "upload-revoked",
      inputId: id,
      contentDigestSha256: registration.contentDigestSha256,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: [],
    });
  }
  if (lifecycle === "changed") {
    return sealDisposition({
      disposition: "changed",
      reasonCode: "upload-changed",
      inputId: id,
      contentDigestSha256: registration.contentDigestSha256,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: [],
    });
  }
  if (
    registration.locator.permissionClass !== "readable" ||
    registration.disclosurePolicy === "forbidden" ||
    registration.disclosurePolicy === "redacted"
  ) {
    return sealDisposition({
      disposition: "inaccessible",
      reasonCode: "upload-not-readable-under-policy",
      inputId: id,
      contentDigestSha256: registration.contentDigestSha256,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: [`disclosure:${registration.disclosurePolicy}`],
    });
  }
  const body = state.bodies.get(id);
  if (!body) {
    return sealDisposition({
      disposition: "inaccessible",
      reasonCode: "upload-body-not-in-surface",
      inputId: id,
      contentDigestSha256: registration.contentDigestSha256,
      mediaKind: null,
      parserId: LOCAL_UPLOAD_PARSER_ID,
      parserVersion: LOCAL_UPLOAD_PARSER_VERSION,
      limitations: ["disposable-body-absent"],
    });
  }
  return {
    contentDigestSha256: body.contentDigestSha256,
    bytes: body.bytes,
    mediaKind: body.mediaKind,
  };
}

export function isLocalUploadDisposition(value: unknown): value is LocalUploadDispositionV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: string }).kind === "docsfab-local-upload-disposition"
  );
}

function probeUploadMedia(
  bytes: Uint8Array,
  mediaKind: LocalUploadMediaKind,
): {
  disposition: "ok" | "encrypted" | "malformed" | "unsupported";
  reasonCode: string;
  limitations: string[];
} {
  if (mediaKind === "pdf") {
    const head = utf8DecodeLossy(bytes.subarray(0, Math.min(bytes.byteLength, 1024)));
    if (head.startsWith("%PDF-")) {
      const sample = utf8DecodeLossy(bytes.subarray(0, Math.min(bytes.byteLength, 65_536)));
      if (/\/Encrypt\b/u.test(sample)) {
        return {
          disposition: "encrypted",
          reasonCode: "pdf-encrypted",
          limitations: ["encrypted-pdf-not-readable"],
        };
      }
      // Binary PDF without a text extract is unsupported for evidence spans;
      // this adapter has no OCR or PDF pipeline.
      return {
        disposition: "unsupported",
        reasonCode: "binary-pdf-requires-extract",
        limitations: ["binary-pdf-without-text-layer", "use-pdf-extract-text"],
      };
    }
    // Synthetic PDF extract bytes offered under mediaKind pdf are allowed when
    // they carry the golden corpus header.
    if (/^SYNTHETIC PDF EXTRACT\b/u.test(utf8DecodeLossy(bytes).trimStart())) {
      return {
        disposition: "ok",
        reasonCode: "synthetic-pdf-extract",
        limitations: ["synthetic-pdf-text-extract"],
      };
    }
    return {
      disposition: "malformed",
      reasonCode: "pdf-magic-missing",
      limitations: ["expected-%PDF-or-synthetic-header"],
    };
  }

  const text = utf8DecodeLossy(bytes);
  if (text.includes("\0")) {
    return {
      disposition: "malformed",
      reasonCode: "extract-contains-nul",
      limitations: ["text-extract-must-be-utf8"],
    };
  }
  const trimmed = text.trimStart();
  if (
    !(
      /^SYNTHETIC PDF EXTRACT\b/u.test(trimmed) ||
      /^SYNTHETIC EXTRACT\b/u.test(trimmed) ||
      /^SYNTHETIC WEAK SOURCE\b/u.test(trimmed)
    )
  ) {
    return {
      disposition: "malformed",
      reasonCode: "extract-header-missing",
      limitations: ["expected-synthetic-extract-header"],
    };
  }
  return {
    disposition: "ok",
    reasonCode: "synthetic-extract-ok",
    limitations: ["synthetic-extract-text"],
  };
}

function normalizeUploadBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value === "string") {
    if (value.includes("\0")) fail("invalid-value");
    return new TextEncoder().encode(value.normalize("NFC"));
  }
  if (!(value instanceof Uint8Array)) fail("invalid-value");
  return value;
}

function normalizeMaxBytes(value: number | undefined): number {
  if (value === undefined) return LOCAL_UPLOAD_DEFAULT_MAX_BYTES;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8_000_000) {
    fail("invalid-value");
  }
  return value;
}

function safeLogicalName(value: unknown): string {
  const name = string(value);
  if (name.length === 0 || name.length > 512) fail("invalid-value");
  if (name.includes("\0") || name.includes("\\")) fail("invalid-value");
  if (name.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(name) || /(^|\/)\.\.(\/|$)/u.test(name)) {
    fail("invalid-value");
  }
  rejectCredentials({ logicalName: name });
  return name;
}

function utf8DecodeLossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function sealDisposition(
  body: Omit<LocalUploadDispositionV1, "schemaVersion" | "kind" | "dispositionSha256">,
): LocalUploadDispositionV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-local-upload-disposition" as const,
    ...body,
  };
  return deepFreeze({
    ...envelope,
    dispositionSha256: canonicalDigest(envelope),
  });
}
