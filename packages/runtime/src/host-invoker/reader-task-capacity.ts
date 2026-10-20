// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Wire capacity for full Slack reader intent; provider/context admission is separate. */
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";

const metadata = LIMIT_DEFINITION_BY_NAME["hostInvoker.frozenInputMaxBytes"];
const transport = LIMIT_DEFINITION_BY_NAME["host.slack.transportTextChars"];
const request = LIMIT_DEFINITION_BY_NAME["hostInvoker.requestMaxBytes"];
if (!metadata || !transport || !request)
  throw new Error("Hosted reader capacities are absent from the generated catalog.");

// JSON's longest encoding of one UTF-16 text unit is a six-byte escape, which
// covers CJK, supplementary text, quotes, and controls without truncation. The
// catalog's character count already counts a supplementary character as two.
const maximumJsonBytesPerTextUnit =
  Buffer.byteLength(JSON.stringify("\u0001")) - Buffer.byteLength(JSON.stringify(""));
// The reader copy and the separately retained verbatim operator copy each
// fit the already admitted Slack text ceiling. Neither is silently clipped.
const requestTextGrowth = ["requestText", "operatorInput"].reduce(
  (bytes, field) =>
    bytes +
    transport.max * maximumJsonBytesPerTextUnit +
    Buffer.byteLength(JSON.stringify({ [field]: "" })),
  0,
);

export const HOST_RUNTIME_READER_TASK_METADATA_MAXIMUM_BYTES = metadata.max;
// Exact target paths repeat the validated change scope. Budget their copy from
// the existing metadata ceiling instead of reducing metadata headroom.
const operatorTargetGrowth = metadata.max;
export const HOST_RUNTIME_READER_TASK_MAXIMUM_BYTES =
  metadata.max + requestTextGrowth + operatorTargetGrowth;
// The reader task is an object inside the request, not a JSON-encoded string.
// Preserve the complete existing non-intent envelope and add only this growth.
export const HOST_RUNTIME_READER_REQUEST_MAXIMUM_BYTES =
  request.max + requestTextGrowth + operatorTargetGrowth;
