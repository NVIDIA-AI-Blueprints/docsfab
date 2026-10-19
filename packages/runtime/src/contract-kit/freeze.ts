// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Deep-freeze plain JSON-like values for sealed contract envelopes. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor) deepFreeze(descriptor.value);
    }
  }
  return value;
}

/** Traverse every data descriptor, including descendants of already-frozen containers. */
export function deepFreezeGraph<T>(value: T): T {
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) return;
    visited.add(candidate);
    Object.freeze(candidate);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
      if ("value" in descriptor) visit(descriptor.value);
    }
  };
  visit(value);
  return value;
}
