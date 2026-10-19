# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Locate the DocsFab repository root from this file, without git.

The public export ships these tests in a tree that need not be a git
checkout and that leaves out internal-only paths, so `git rev-parse
--show-toplevel` cannot be the source of truth, and a test reading an
internal-only path names why it skips when that path's owner is absent.
"""

from __future__ import annotations

from pathlib import Path


def find_repo_root(anchor: Path, relative: Path) -> Path:
    """Return the nearest ancestor of `anchor` that holds it at `relative`.

    A candidate matches only when `candidate / relative` is the anchor file
    itself after realpathing both sides; a different file at the same relative
    path (a nested fixture tree, say) is not a match.
    """
    anchor = anchor.resolve()
    for candidate in anchor.parents:
        if (candidate / relative).resolve() == anchor:
            return candidate
    raise RuntimeError(
        f"unable to locate the DocsFab repository root: no ancestor of {anchor} "
        f"holds it at {relative.as_posix()}"
    )


def repo_root() -> Path:
    here = Path(__file__)
    return find_repo_root(here, Path("packages", "quality", "tests", here.name))


def git_checkout_absent_reason(root: Path, subject: str) -> str | None:
    """Name why `subject` cannot run when `root` has no `.git` entry.

    Only a missing `.git` is handled; a `.git` directory or a linked
    worktree's `.git` file counts as a checkout, and any git failure there
    still surfaces as an error.
    """
    if (root / ".git").exists():
        return None
    return f"{subject} needs a git checkout, and {root} has no .git"


def owner_absent_reason(path: Path, owner: Path) -> str | None:
    """Name why `path` is unavailable when its owning path is absent.

    Only a missing owner is handled. With the owner present, `path` is read
    as usual and its absence fails the test.
    """
    if owner.exists():
        return None
    return f"{path} is unavailable: its owner {owner} is absent from this tree"
