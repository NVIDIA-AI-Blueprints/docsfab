// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { access } from "node:fs/promises";

await access(new URL("docs/get-started.md", import.meta.url));
