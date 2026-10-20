#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Shim: canonical validator lives under packages/quality/checks."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_CANONICAL_NAME = "validate_quality_report.py"


def _canonical_path() -> Path:
    """Locate quality checks from the skill tree or generated crate.

    ``packages/skills/.../scripts`` resolves ``parents[3]/quality`` to
    ``packages/quality``. ``packages/runtime/skill-crate/.../scripts`` resolves
    the same layout to ``packages/runtime/quality``.
    """
    here = Path(__file__).resolve()
    candidate = here.parents[3] / "quality" / "checks" / _CANONICAL_NAME
    if not candidate.is_file():
        raise FileNotFoundError(
            "canonical quality report validator not found at "
            f"{candidate}"
        )
    return candidate


def _load_canonical():
    path = _canonical_path()
    spec = importlib.util.spec_from_file_location(
        "validate_quality_report", path
    )
    if spec is None or spec.loader is None:
        raise ImportError(
            "unable to load canonical quality report validator: "
            f"{path}"
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_MODULE = _load_canonical()
extract_report_limitations = _MODULE.extract_report_limitations
extract_report_summary = _MODULE.extract_report_summary
main = _MODULE.main
validate_quality_report = _MODULE.validate_quality_report


if __name__ == "__main__":
    raise SystemExit(main())
