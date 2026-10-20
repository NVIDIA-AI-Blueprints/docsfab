# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Public replacement for tests/_distribution.py, with portable tests only."""

DISTRIBUTION = "public"
PUBLIC_TEST_MODULES = (
    "test_collect_doc_quality_signals",
    "test_documentation_partial",
    "test_package_distribution",
    "test_public_smoke",
    "test_repo_root",
    "test_review_live_evaluation_regressions",
    "test_skill_invocation_schema",
    "test_template_set_scripts",
    "test_validate_audience_understanding_evaluation",
    "test_validate_documentation_quality_evaluation",
)
INTERNAL_TEST_MODULES = ()
