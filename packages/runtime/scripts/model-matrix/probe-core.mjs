// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The serving-route probe stack lives in `src/profile/probe-core.js`, which the
 * installed package ships. This path keeps the matrix scripts' import stable.
 */
export * from "../../src/profile/probe-core.js";
