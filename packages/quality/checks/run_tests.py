#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Run the declared quality test distribution and refuse unclassified tests."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys
from types import ModuleType
import unittest


TEST_ROOT = Path(__file__).resolve().parents[1] / "tests"
sys.path.insert(0, str(TEST_ROOT))
import _distribution  # noqa: E402


def select_modules(
    test_root: Path,
    distribution: str,
    catalog: ModuleType = _distribution,
) -> tuple[str, ...]:
    """Account for every present test and require every selected test to exist."""
    if distribution not in {"internal", "public"}:
        raise ValueError(f"Unknown test distribution: {distribution}")
    if catalog.DISTRIBUTION not in {"internal", "public"}:
        raise ValueError(f"Invalid test catalog distribution: {catalog.DISTRIBUTION}")
    if distribution == "internal" and catalog.DISTRIBUTION != "internal":
        raise ValueError(
            "Internal quality tests require the internal source checkout and retained "
            "QA inputs; use --distribution public for this distribution."
        )

    public = tuple(catalog.PUBLIC_TEST_MODULES)
    internal = tuple(catalog.INTERNAL_TEST_MODULES)
    all_modules = public + internal
    if not public or (catalog.DISTRIBUTION == "internal" and not internal):
        raise ValueError("Test catalog must declare its complete distribution.")
    if catalog.DISTRIBUTION == "public" and internal:
        raise ValueError("Public test catalog must contain only portable tests.")
    if any(not re.fullmatch(r"test_[a-zA-Z0-9_]+", name) for name in all_modules):
        raise ValueError("Test catalog contains an invalid module name.")
    if len(set(all_modules)) != len(all_modules):
        raise ValueError("Test catalog contains duplicate or overlapping modules.")

    present = {path.stem for path in test_root.glob("test_*.py")}
    unclassified = present - set(all_modules)
    if unclassified:
        raise ValueError(f"Unclassified quality test modules: {sorted(unclassified)}")
    selected = public if distribution == "public" else all_modules
    missing = set(selected) - present
    if missing:
        raise ValueError(f"Missing {distribution} quality test modules: {sorted(missing)}")
    return tuple(sorted(selected))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--distribution", choices=("internal", "public"), default=_distribution.DISTRIBUTION
    )
    args = parser.parse_args()
    try:
        modules = select_modules(TEST_ROOT, args.distribution)
    except ValueError as exc:
        parser.exit(1, f"Quality test partition refused: {exc}\n")
    print(f"Running {args.distribution} quality tests: {', '.join(modules)}", flush=True)
    suite = unittest.TestLoader().loadTestsFromNames(modules)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
