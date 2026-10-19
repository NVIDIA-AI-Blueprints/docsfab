// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SidebarsConfig } from "./plugin-content-docs-types.js";

const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    "intro",
    {
      type: "category",
      label: "Reference",
      items: ["reference/one", "reference/two"],
    },
  ],
};

export default sidebars;
