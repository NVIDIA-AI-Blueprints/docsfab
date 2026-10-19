// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { publicReviewTargetScope } from "./fixtures/review-cli-correction/public-review-target-scope.js";
import { registerJudgmentCoverageLimitationBound } from "./scenarios/judgment-coverage-limitation-bound.scenario.js";

registerJudgmentCoverageLimitationBound(publicReviewTargetScope());
