// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerPublicationProhibitionScenarios } from "./publication-prohibition-delivery.scenarios.js";
import { PUBLIC_PUBLICATION_REQUESTS } from "./helpers/runtime-scenario-inputs.js";

registerPublicationProhibitionScenarios(PUBLIC_PUBLICATION_REQUESTS);
