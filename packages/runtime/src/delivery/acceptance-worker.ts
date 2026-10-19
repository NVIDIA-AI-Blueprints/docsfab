#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import { runOfflineDeliveryAcceptanceWorker } from "./acceptance.js";

const path = process.argv[2];
if (!path) throw new Error("Delivery acceptance worker requires a private configuration path.");
await runOfflineDeliveryAcceptanceWorker(resolve(path));
