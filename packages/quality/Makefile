# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

PYTHON ?= python3
DOCSFAB_ROOT := ../..

.PHONY: validate test smoke validate-public test-public smoke-public
validate: validate-public
test: test-public
smoke: smoke-public
validate-public:
	$(PYTHON) checks/validate_package.py $(DOCSFAB_ROOT) --distribution public
test-public:
	$(PYTHON) checks/run_tests.py --distribution public
smoke-public:
	$(PYTHON) checks/smoke_public.py
