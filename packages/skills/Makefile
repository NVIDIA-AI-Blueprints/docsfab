# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

PYTHON ?= python3
DOCSFAB_ROOT := ../..

.PHONY: validate test

validate:
	$(PYTHON) ../quality/checks/validate_package.py $(DOCSFAB_ROOT)

test:
	$(PYTHON) -m unittest discover -s tests -v
