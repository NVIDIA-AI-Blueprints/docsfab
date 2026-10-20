# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Behavior of the template set's bundled helper scripts."""

from __future__ import annotations

import importlib.util
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SITE_SCAFFOLD = Path(__file__).resolve().parents[1].joinpath(
    "formats/template-set-v1/tpl-new-site/scripts/site-scaffold.py"
)


def _load_site_scaffold(path: Path = SITE_SCAFFOLD):
    spec = importlib.util.spec_from_file_location("site_scaffold_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SkillsSubdirsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.site_scaffold = _load_site_scaffold()

    def test_searches_only_the_template_set_layout_by_default(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.site_scaffold.skills_subdirs(), ["skills"])

    def test_adds_installer_layouts_from_the_environment(self) -> None:
        value = os.pathsep.join([".packs/skills", "vendor/skills"])
        with mock.patch.dict(os.environ, {"TPL_SKILLS_SUBDIRS": value}, clear=True):
            self.assertEqual(
                self.site_scaffold.skills_subdirs(), ["skills", ".packs/skills", "vendor/skills"]
            )

    def test_ignores_empty_entries_instead_of_searching_the_ancestor(self) -> None:
        value = os.pathsep.join(["", ".packs/skills", ""])
        with mock.patch.dict(os.environ, {"TPL_SKILLS_SUBDIRS": value}, clear=True):
            self.assertEqual(self.site_scaffold.skills_subdirs(), ["skills", ".packs/skills"])


class InstallerLayoutLookupTests(unittest.TestCase):
    """The finders search the installer layouts that TPL_SKILLS_SUBDIRS names."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        script = self.root / "install" / "tpl-new-site" / "scripts" / "site-scaffold.py"
        script.parent.mkdir(parents=True)
        shutil.copyfile(SITE_SCAFFOLD, script)
        packs = self.root / ".packs" / "skills"
        self.site_map = packs / "tpl-new-site" / "assets" / "site-map.yaml"
        self.scaffold = packs / "tpl-new-page" / "scripts" / "scaffold.py"
        for path in (self.site_map, self.scaffold):
            path.parent.mkdir(parents=True)
            path.write_text("", encoding="utf-8")
        self.site_scaffold = _load_site_scaffold(script)

    def test_finds_nothing_in_an_unnamed_layout(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(self.site_scaffold.find_site_map())
            self.assertIsNone(self.site_scaffold.find_scaffold_script())

    def test_finds_the_site_map_and_scaffold_in_a_named_layout(self) -> None:
        with mock.patch.dict(os.environ, {"TPL_SKILLS_SUBDIRS": ".packs/skills"}, clear=True):
            self.assertEqual(self.site_scaffold.find_site_map(), self.site_map.resolve())
            self.assertEqual(self.site_scaffold.find_scaffold_script(), self.scaffold.resolve())

if __name__ == "__main__":
    unittest.main()
