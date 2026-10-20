// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerSourceProvenanceSuite } from "./source-provenance.scenarios.js";

registerSourceProvenanceSuite({
  portable: true,
  locks: ["skill-crate/lock.json", "quality/lock.json"],
});
