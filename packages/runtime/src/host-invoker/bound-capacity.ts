// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalogued representation capacities for the hosted worker wire.
 *
 * The host writes these shapes and the worker reads them back, so both sides
 * must agree on one declared number. They are `sealed` in `config/limits.yaml`:
 * an environment override crossing into the clean child would desynchronise
 * the pair.
 *
 * Unlike `limit()`, this reads the generated definition directly: the request,
 * terminal and grant parsers must not touch the filesystem or the environment
 * to learn their own shape bounds.
 */
import { catalogCapacity as hostedBoundCapacity } from "../config/catalog-capacity.js";

export { catalogCapacity as hostedBoundCapacity } from "../config/catalog-capacity.js";

/** One-shot model-credential handle the worker reads, then zeroes. */
export const HOST_RUNTIME_CREDENTIAL_MAXIMUM_BYTES = hostedBoundCapacity(
  "hostInvoker.credentialMaxBytes",
);

/** Largest inherited descriptor number admitted on the worker command line. */
export const HOST_RUNTIME_DESCRIPTOR_NUMBER_MAXIMUM = hostedBoundCapacity(
  "hostInvoker.descriptorNumberMax",
);

export const HOST_RUNTIME_REQUEST_STEP_IDS_MAXIMUM = hostedBoundCapacity(
  "hostInvoker.requestStepIdsMax",
);

export const HOST_RUNTIME_CAPSULE_EVIDENCE_MAXIMUM_ITEMS = hostedBoundCapacity(
  "hostInvoker.capsuleEvidenceMaxItems",
);

export const HOST_RUNTIME_CAPSULE_EVIDENCE_ITEM_MAXIMUM_BYTES = hostedBoundCapacity(
  "hostInvoker.capsuleEvidenceItemMaxBytes",
);

/** Serialized size of the whole projected selected-evidence collection. */
export const HOST_RUNTIME_CAPSULE_EVIDENCE_JSON_MAXIMUM_BYTES = hostedBoundCapacity(
  "hostInvoker.capsuleEvidenceJsonMaxBytes",
);

/** Listed pages in one focused review scope, and its anchor list. */
export const REVIEW_SCOPE_MAXIMUM_TARGETS = hostedBoundCapacity("reviewScope.maxTargets");

export const REVIEW_SCOPE_CONTINUATION_TEXT_MAXIMUM_CHARS = hostedBoundCapacity(
  "reviewScope.continuationTextMaxChars",
);

export const REVIEW_SCOPE_PATH_MAXIMUM_CHARS = hostedBoundCapacity("reviewScope.pathMaxChars");

export const HOST_RUNTIME_EDITORIAL_EVIDENCE_REFS_MAXIMUM = hostedBoundCapacity(
  "hostInvoker.editorialEvidenceRefsMax",
);

export const HOST_RUNTIME_EDITORIAL_LIMITATIONS_MAXIMUM = hostedBoundCapacity(
  "hostInvoker.editorialLimitationsMax",
);

export const HOST_RUNTIME_EDITORIAL_LIMITATION_MAXIMUM_CHARS = hostedBoundCapacity(
  "hostInvoker.editorialLimitationMaxChars",
);
