# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Distribution checks fail closed on incomplete or misclassified QA suites."""

from __future__ import annotations

from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


QUALITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUALITY / "checks"))
import run_tests  # noqa: E402
import validate_package  # noqa: E402


def catalog(distribution: str = "internal") -> SimpleNamespace:
    return SimpleNamespace(
        DISTRIBUTION=distribution,
        PUBLIC_TEST_MODULES=("test_portable",),
        INTERNAL_TEST_MODULES=("test_retained",) if distribution == "internal" else (),
    )


class PackageDistributionTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "test_portable.py").write_text("", encoding="utf-8")

    def test_public_selection_does_not_require_or_import_internal_modules(self) -> None:
        self.assertEqual(
            run_tests.select_modules(self.root, "public", catalog()), ("test_portable",)
        )
        (self.root / "test_retained.py").write_text(
            "raise RuntimeError('must not be imported during public selection')\n",
            encoding="utf-8",
        )
        self.assertEqual(
            run_tests.select_modules(self.root, "public", catalog()), ("test_portable",)
        )

    def test_internal_suite_requires_all_internal_modules(self) -> None:
        with self.assertRaisesRegex(ValueError, "Missing internal quality test modules"):
            run_tests.select_modules(self.root, "internal", catalog())
        (self.root / "test_retained.py").write_text("", encoding="utf-8")
        self.assertEqual(
            run_tests.select_modules(self.root, "internal", catalog()),
            ("test_portable", "test_retained"),
        )

    def test_public_suite_requires_all_portable_modules(self) -> None:
        (self.root / "test_portable.py").unlink()
        with self.assertRaisesRegex(ValueError, "Missing public quality test modules"):
            run_tests.select_modules(self.root, "public", catalog())

    def test_new_unclassified_module_refuses_both_distributions(self) -> None:
        (self.root / "test_unclassified.py").write_text("", encoding="utf-8")
        for distribution in ("internal", "public"):
            with self.subTest(distribution=distribution):
                with self.assertRaisesRegex(ValueError, "Unclassified quality test modules"):
                    run_tests.select_modules(self.root, distribution, catalog())

    def test_catalog_rejects_duplicates_overlap_and_invalid_names(self) -> None:
        for modules in (("test_portable", "test_portable"), ("test_retained",), ("../test_escape",)):
            with self.subTest(modules=modules):
                invalid = catalog()
                invalid.PUBLIC_TEST_MODULES = modules
                with self.assertRaises(ValueError):
                    run_tests.select_modules(self.root, "public", invalid)

    def test_public_test_catalog_refuses_internal_request(self) -> None:
        with self.assertRaisesRegex(ValueError, "Internal quality tests require"):
            run_tests.select_modules(self.root, "internal", catalog("public"))
        self.assertEqual(
            run_tests.select_modules(self.root, "public", catalog("public")),
            ("test_portable",),
        )

    def test_public_package_inputs_refuse_internal_validation(self) -> None:
        with mock.patch.multiple(
            validate_package.package_inputs,
            DISTRIBUTION="public",
            INTERNAL_REQUIRED_FILES=frozenset(),
            EXPECTED_QUALITY_SCORE=None,
        ):
            self.assertEqual(validate_package.distribution_errors("public"), [])
            self.assertIn(
                "Internal package validation requires",
                " ".join(validate_package.distribution_errors("internal")),
            )


if __name__ == "__main__":
    unittest.main()
