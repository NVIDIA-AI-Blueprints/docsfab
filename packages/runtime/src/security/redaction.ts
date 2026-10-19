// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactCredentialMaterial } from "./credential-material.js";

export function redactSecrets(value: unknown, secrets: readonly string[]): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return redactCredentialMaterial(message);
}
