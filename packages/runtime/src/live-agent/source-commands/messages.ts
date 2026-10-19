// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SOURCE_VERSION_MAX_BYTES, type SourceRevalidationStateV1 } from "./contracts.js";

/**
 * Operator-facing sentence for each coded state. Content-free like
 * `SOURCE_COMMAND_REFUSALS`; the renderer appends digests, never splices them in.
 */
export const SOURCE_REVALIDATION_STATE_MESSAGES: Readonly<
  Record<SourceRevalidationStateV1, string>
> = Object.freeze({
  fresh:
    "Re-checked against the selected revision now, and nothing this conversation recorded about it is contradicted. It stays attached and a bounded run binds it as it is.",
  stale:
    "Still reachable and still the same source, and what the repository holds is no longer the version this conversation recorded. Nothing was adopted: refresh this source to take the current version, or detach it, before a bounded run binds it.",
  missing:
    "Not present at the selected revision: the host reports it is not a tracked regular file there, so no version could be taken. It stays attached and is reported here rather than dropped; restore it at that revision, or detach it.",
  unreadable: `Present at the selected revision and its bytes could not be read, so no version could be taken and nothing recorded about it could be confirmed. This is not the same as the source being gone, and it is not a claim that it drifted. A tracked file over the ${SOURCE_VERSION_MAX_BYTES}-byte version ceiling reads this way, as does a file the host failed to read; the other attached sources were still re-checked. It stays attached; shrink or split the file, or detach it.`,
  "identity-changed":
    "The reference this source was admitted under no longer resolves to the identity that was admitted, so this is a different source rather than a newer version of the same one. No version was taken and nothing was adopted; detach it and attach the source you mean.",
});
