// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Opaque host-authority factory.
 *
 * Private object identity is the capability; serializable `kind` strings are
 * not authoritative and lookalike objects never resolve a verifier.
 */

export interface HostAuthorityFactoryOptions<TKind extends string> {
  kind: TKind;
  /** Thrown when create() receives a verifier without verifyCurrent. */
  invalidMessage: string;
}

export interface HostAuthorityFactory<TAuthority extends { readonly kind: string }, TVerifier> {
  create(verifier: TVerifier): TAuthority;
  lookup(authority: TAuthority): TVerifier | undefined;
}

export function createHostAuthorityFactory<TKind extends string, TVerifier>(
  options: HostAuthorityFactoryOptions<TKind>,
): HostAuthorityFactory<{ readonly kind: TKind }, TVerifier> {
  const authorities = new WeakMap<object, TVerifier>();
  type Authority = { readonly kind: TKind };

  return {
    create(verifier: TVerifier): Authority {
      if (
        !verifier ||
        typeof verifier !== "object" ||
        typeof (verifier as { verifyCurrent?: unknown }).verifyCurrent !== "function"
      ) {
        throw new Error(options.invalidMessage);
      }
      const authority = Object.freeze({ kind: options.kind });
      authorities.set(authority, verifier);
      return authority;
    },
    lookup(authority: Authority): TVerifier | undefined {
      return authority && typeof authority === "object"
        ? authorities.get(authority as object)
        : undefined;
    },
  };
}
