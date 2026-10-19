// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// @ts-nocheck
/**
 * Host-safe repository-event routing surface. Host must not import values from
 * `./index.ts`, which re-exports CLI `.js` specifiers that Node type-stripping
 * cannot load. NodeNext tsc forbids the `.ts` specifier here without this
 * file's type-check exemption.
 */
export {
  routeRepositoryEventDelivery,
  type RepositoryEventRouteDecisionV1,
} from "./repository-event-routing.ts";
