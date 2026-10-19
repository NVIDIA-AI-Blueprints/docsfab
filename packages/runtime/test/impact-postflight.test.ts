// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerImpactPostflightScenarios } from "./impact-postflight.scenarios.js";

registerImpactPostflightScenarios({
  poisonRelativePath: "unselected/examples/duplicate-labels",
  poisonMarkdown:
    "# Skipped example\n\n(unselected-anchor)=\n:::note\nA deliberately invalid page.\n:::\n\n(unselected-anchor)=\n:::tip\nRepeated anchor.\n:::\n",
});
