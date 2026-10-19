// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  degradedLocatorToken,
  readCitedLocator,
  type LocatorDegradation,
} from ".././source-obligation/locator-degradation.js";
import { limit } from "../../config/limits.js";
import {
  rejectTechnicalCorrection,
  normalizeRepositoryLocator,
  type VerificationResult,
} from ".././review-response.js";
import { sourcePathRejectionSubject } from "../../execution/rejection-subject.js";
import {
  FACT_ID,
  MAX_OBLIGATIONS_LIMIT,
  MAX_LOCATORS_LIMIT,
  SHA256,
  SOURCE_OBLIGATION_FAILURES,
  at,
  catalogLocationOf,
  fail,
  kit,
  reject,
} from "./validation-kernel.js";
import type { SourceObligationRejectionLocation } from "./validation-kernel.js";
import type { SourceLocatorAuthority } from "./ledger-codec.js";

/**
 * `location` and `memberLocation` are optional: technical-correction callers
 * validate a contract whose positions are not in this module's vocabulary, so
 * they pass neither and keep the uncoded message. `degradation` replaces the
 * `invalid-locator` refusal with the removal described on
 * {@link LocatorDegradation}.
 */
export function validateLocators(
  value: unknown,
  requireNonEmpty: boolean,
  authority?: SourceLocatorAuthority,
  preserveOrder = false,
  location?: SourceObligationRejectionLocation,
  memberLocation?: SourceObligationRejectionLocation,
  degradation?: LocatorDegradation,
): string[] {
  const locators = boundedTextArray(
    value,
    limit(MAX_LOCATORS_LIMIT).value,
    location,
    memberLocation,
  );
  // A model that cited NO locator where the contract requires one is a missing
  // answer, not an unreadable one: it keeps its own reason, degraded or not.
  if (requireNonEmpty && locators.length === 0) {
    return location
      ? reject("empty-required-field", location)
      : fail(SOURCE_OBLIGATION_FAILURES.sourceLocator);
  }
  const admitted: string[] = [];
  for (const locator of locators) {
    if (degradation) {
      const reading = readCitedLocator(locator, degradation.runRevision);
      if (reading.kind === "span-missing") {
        // A path outside the admitted sources keeps its authority refusal
        // below rather than being re-asked for a line span.
        if (authority && !authority.paths.has(reading.path)) {
          if (!admitted.includes(reading.path)) admitted.push(reading.path);
          continue;
        }
        if (!degradation.finalAttempt && memberLocation !== undefined) {
          if (catalogLocationOf("source-locator-span-missing", memberLocation)) {
            return reject("source-locator-span-missing", memberLocation);
          }
        }
        degradation.removed.push({
          token: degradedLocatorToken(locator, degradation.runRevision),
          reason: "span-missing",
        });
        continue;
      }
      if (reading.kind === "removed") {
        degradation.removed.push({
          token: degradedLocatorToken(locator, degradation.runRevision),
          reason: reading.reason,
        });
        continue;
      }
      // Stripping a revision suffix can make two cited locators one.
      if (!admitted.includes(reading.locator)) admitted.push(reading.locator);
      continue;
    }
    if (locator.includes("@")) {
      return memberLocation
        ? reject("invalid-locator", memberLocation)
        : fail(SOURCE_OBLIGATION_FAILURES.revisionSuffix);
    }
    const normalized = normalizeRepositoryLocator(locator);
    if (!normalized.specific || !normalized.path) {
      return memberLocation
        ? reject("invalid-locator", memberLocation)
        : fail(SOURCE_OBLIGATION_FAILURES.nonspecificLocator);
    }
    admitted.push(locator);
  }
  for (const locator of admitted) {
    const path = normalizeRepositoryLocator(locator).path;
    if (authority && (!path || !authority.paths.has(path))) {
      // The record names the path only when the host knows it.
      const subject = authority.knownPath
        ? sourcePathRejectionSubject(path, authority.knownPath)
        : undefined;
      // A page the run writes is the update's base, never its source: a rule
      // the model can follow on a retry, not an authority claim.
      if (
        path &&
        authority.writePaths?.has(path) &&
        memberLocation !== undefined &&
        catalogLocationOf("write-target-source", memberLocation)
      ) {
        return reject("write-target-source", memberLocation, subject);
      }
      if (path && authority.requiresProposal && memberLocation !== undefined) {
        return reject("source-proposal-required", memberLocation, subject);
      }
      return memberLocation
        ? reject("unauthorized-source", memberLocation, subject)
        : fail(SOURCE_OBLIGATION_FAILURES.sourceAuthority, false);
    }
  }
  return preserveOrder ? admitted : admitted.sort();
}

export function validateFactIds(
  value: unknown,
  facts: ReadonlyMap<
    string,
    VerificationResult["factInventory"]["dimensions"][number]["facts"][number]
  >,
  preserveOrder = false,
): string[] {
  const factIds = boundedTextArray(value, limit(MAX_OBLIGATIONS_LIMIT).value);
  if (new Set(factIds).size !== factIds.length) {
    return rejectTechnicalCorrection("invalid-fact-link", undefined, {
      code: "fact-link-duplicate-fact-id",
      location: "$.obligationAccounting[].factIds[]",
    });
  }
  for (const factId of factIds) {
    if (!FACT_ID.test(factId) || !facts.has(factId)) {
      return rejectTechnicalCorrection("invalid-fact-link", undefined, {
        code: FACT_ID.test(factId) ? "fact-link-unknown-fact" : "fact-link-malformed-fact-id",
        location: "$.obligationAccounting[].factIds[]",
      });
    }
  }
  return preserveOrder ? factIds : factIds.sort();
}

/** See {@link validateLocators} for why the locations are optional. */
export function boundedTextArray(
  value: unknown,
  maxItems: number,
  location?: SourceObligationRejectionLocation,
  memberLocation?: SourceObligationRejectionLocation,
): string[] {
  const values = location ? at(location, () => kit.array(value)) : kit.array(value);
  if (values.length > maxItems) {
    return location
      ? reject("bounds-exceeded", location)
      : fail(SOURCE_OBLIGATION_FAILURES.itemBound);
  }
  const normalized = values.map((item) => boundedText(item, 4_096, memberLocation));
  if (new Set(normalized).size !== normalized.length) {
    return location
      ? reject("duplicate-entry", location)
      : fail(SOURCE_OBLIGATION_FAILURES.duplicateText);
  }
  return normalized;
}

/** See {@link validateLocators} for why the location is optional. */
export function boundedText(
  value: unknown,
  maxLength: number,
  location?: SourceObligationRejectionLocation,
  minLength = 1,
): string {
  const text = location ? at(location, () => kit.string(value)) : kit.string(value);
  if (text !== text.trim() || text.length > maxLength) {
    return location
      ? reject("invalid-value", location)
      : fail(SOURCE_OBLIGATION_FAILURES.boundedText);
  }
  if (text.length < minLength) {
    // `empty-required-field` means empty; a short non-empty value is an
    // inadequate answer, not a missing one.
    return location
      ? reject(text.length === 0 ? "empty-required-field" : "invalid-value", location)
      : fail(SOURCE_OBLIGATION_FAILURES.boundedText);
  }
  return text;
}

export function boundedDigest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    return fail("Source-obligation evidence contains an invalid digest.");
  }
  return value;
}
