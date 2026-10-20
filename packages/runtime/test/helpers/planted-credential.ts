// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A deterministic, random-looking value for credential tests, built at run time
 * so no source line holds a credential-shaped literal for repository secret
 * scanners to match. Different seeds give different values.
 */
export function plantedCredentialValue(seed: number, length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let state = seed;
  let value = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    value += alphabet[state % alphabet.length];
  }
  return value;
}
