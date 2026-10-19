# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from _repo_root import (
    find_repo_root,
    git_checkout_absent_reason,
    owner_absent_reason,
    repo_root,
)


RELATIVE = Path("packages", "quality", "tests", "anchor.py")


class FindRepoRootTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()

    def _anchor_under(self, root: Path) -> Path:
        anchor = root / RELATIVE
        anchor.parent.mkdir(parents=True)
        anchor.write_text("", encoding="utf-8")
        return anchor

    def test_returns_the_ancestor_holding_the_anchor(self) -> None:
        root = self.base / "checkout"
        anchor = self._anchor_under(root)
        self.assertEqual(find_repo_root(anchor, RELATIVE), root)

    def test_a_different_file_at_the_relative_path_is_not_a_match(self) -> None:
        root = self.base / "checkout"
        anchor = self._anchor_under(root)
        # A nearer ancestor, the tests directory itself, also holds a file at
        # the relative path; it is not the anchor, so the walk goes past it.
        self._anchor_under(anchor.parent)
        self.assertEqual(find_repo_root(anchor, RELATIVE), root)

    def test_symlinked_invocation_resolves_to_the_real_root(self) -> None:
        root = self.base / "checkout"
        self._anchor_under(root)
        link = self.base / "linked"
        os.symlink(root, link, target_is_directory=True)
        self.assertEqual(find_repo_root(link / RELATIVE, RELATIVE), root)

    def test_anchor_outside_its_layout_is_refused(self) -> None:
        stray = self.base / "stray" / "anchor.py"
        stray.parent.mkdir()
        stray.write_text("", encoding="utf-8")
        with self.assertRaisesRegex(
            RuntimeError,
            "unable to locate the DocsFab repository root: no ancestor of .* "
            "holds it at packages/quality/tests/anchor.py",
        ):
            find_repo_root(stray, RELATIVE)

    def test_repo_root_holds_this_package(self) -> None:
        root = repo_root()
        self.assertEqual(
            (root / "packages" / "quality" / "tests" / Path(__file__).name).resolve(),
            Path(__file__).resolve(),
        )
        self.assertTrue((root / "config" / "limits.yaml").is_file())


class SkipReasonTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)

    def test_root_without_git_entry_is_named(self) -> None:
        self.assertEqual(
            git_checkout_absent_reason(self.base, "the collector"),
            f"the collector needs a git checkout, and {self.base} has no .git",
        )

    def test_git_directory_is_a_checkout(self) -> None:
        (self.base / ".git").mkdir()
        self.assertIsNone(git_checkout_absent_reason(self.base, "the collector"))

    def test_linked_worktree_git_file_is_a_checkout(self) -> None:
        (self.base / ".git").write_text("gitdir: elsewhere\n", encoding="utf-8")
        self.assertIsNone(git_checkout_absent_reason(self.base, "the collector"))

    def test_absent_owner_is_named(self) -> None:
        owner = self.base / ".docsfab"
        path = owner / "evaluation.json"
        self.assertEqual(
            owner_absent_reason(path, owner),
            f"{path} is unavailable: its owner {owner} is absent from this tree",
        )

    def test_present_owner_with_missing_file_is_not_handled(self) -> None:
        owner = self.base / ".docsfab"
        owner.mkdir()
        self.assertIsNone(owner_absent_reason(owner / "evaluation.json", owner))
