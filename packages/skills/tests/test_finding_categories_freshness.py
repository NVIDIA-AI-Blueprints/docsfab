# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "packages" / "skills" / "scripts" / "render_finding_categories.py"

_spec = importlib.util.spec_from_file_location("render_finding_categories", SCRIPT)
assert _spec is not None and _spec.loader is not None
renderer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(renderer)


def run(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = renderer.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class FindingCategoriesFreshnessTests(unittest.TestCase):
    def test_committed_reference_matches_the_schema(self) -> None:
        code, out, err = run("--root", str(ROOT), "--check")
        self.assertEqual(code, 0, err)
        self.assertIn("matches", out)

    def test_every_schema_value_appears_once_in_the_reference(self) -> None:
        schema = json.loads((ROOT / renderer.SCHEMA).read_text(encoding="utf-8"))
        reference = (ROOT / renderer.TARGET).read_text(encoding="utf-8")
        for name, _label in renderer.REGIONS:
            for value, text in renderer.described_values(schema, name):
                self.assertEqual(reference.count(f"- `{value}`: {text}\n"), 1, value)


class FindingCategoriesDriftTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for relative in (renderer.SCHEMA, renderer.TARGET):
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)

    def schema(self) -> dict:
        return json.loads((self.root / renderer.SCHEMA).read_text(encoding="utf-8"))

    def write_schema(self, schema: dict) -> None:
        (self.root / renderer.SCHEMA).write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")

    def issue_property(self, schema: dict, name: str) -> dict:
        return schema["properties"]["issues"]["items"]["properties"][name]

    def reference(self) -> str:
        return (self.root / renderer.TARGET).read_text(encoding="utf-8")

    def test_enum_change_without_regeneration_fails_the_check(self) -> None:
        schema = self.schema()
        category = self.issue_property(schema, "category")
        category["enum"].append("accessibility")
        category[renderer.DESCRIPTIONS_KEY]["accessibility"] = "Content blocks an assistive technology user."
        self.write_schema(schema)
        before = self.reference()

        code, _out, err = run("--root", str(self.root), "--check")

        self.assertEqual(code, 1)
        self.assertIn("is stale against", err)
        self.assertIn("render_finding_categories.py", err)
        self.assertEqual(self.reference(), before, "--check must not write")

    def test_regeneration_repairs_drift_and_keeps_hand_written_prose(self) -> None:
        schema = self.schema()
        severity = self.issue_property(schema, "severity")
        severity[renderer.DESCRIPTIONS_KEY]["minor"] = "Small issue."
        category = self.issue_property(schema, "category")
        category["enum"].remove("task_success")
        del category[renderer.DESCRIPTIONS_KEY]["task_success"]
        self.write_schema(schema)
        before = self.reference()
        outside = [line for line in before.splitlines() if not line.startswith("- `")]

        code, out, err = run("--root", str(self.root))

        self.assertEqual(code, 0, err)
        self.assertIn("rewrote", out)
        after = self.reference()
        self.assertIn("- `minor`: Small issue.\n", after)
        self.assertNotIn("`task_success`", after)
        self.assertEqual([line for line in after.splitlines() if not line.startswith("- `")], outside)
        self.assertEqual(run("--root", str(self.root), "--check")[0], 0)

    def test_hand_edit_inside_a_generated_region_fails_the_check(self) -> None:
        path = self.root / renderer.TARGET
        text = self.reference()
        path.write_text(
            text.replace("lacks approved evidence.", "lacks evidence.", 1), encoding="utf-8"
        )

        code, _out, err = run("--root", str(self.root), "--check")

        self.assertEqual(code, 1)
        self.assertIn("is stale against", err)

    def test_enum_value_without_a_description_refuses(self) -> None:
        schema = self.schema()
        self.issue_property(schema, "category")["enum"].append("accessibility")
        self.write_schema(schema)

        for argv in (("--check",), ()):
            code, _out, err = run("--root", str(self.root), *argv)
            self.assertEqual(code, 1)
            self.assertIn("missing=['accessibility']", err)

    def test_description_without_an_enum_value_refuses(self) -> None:
        schema = self.schema()
        self.issue_property(schema, "severity")[renderer.DESCRIPTIONS_KEY]["blocker"] = "Stops the run."
        self.write_schema(schema)

        code, _out, err = run("--root", str(self.root))

        self.assertEqual(code, 1)
        self.assertIn("extra=['blocker']", err)

    def test_multiline_or_empty_description_refuses(self) -> None:
        for text in ("", "First line.\nSecond line.", " Padded."):
            with self.subTest(text=text):
                schema = self.schema()
                self.issue_property(schema, "severity")[renderer.DESCRIPTIONS_KEY]["major"] = text
                self.write_schema(schema)
                code, _out, err = run("--root", str(self.root), "--check")
                self.assertEqual(code, 1)
                self.assertIn("must be one non-empty line", err)

    def test_missing_or_repeated_marker_refuses_without_writing(self) -> None:
        path = self.root / renderer.TARGET
        original = self.reference()
        end = renderer.end_marker("FINDING SEVERITIES") + "\n"
        for text in (original.replace(end, ""), original + "\n" + end):
            with self.subTest(markers=text.count(end)):
                path.write_text(text, encoding="utf-8")
                code, _out, err = run("--root", str(self.root))
                self.assertEqual(code, 1)
                self.assertIn("expected one line", err)
                self.assertEqual(self.reference(), text)

    def test_out_of_order_markers_refuse(self) -> None:
        path = self.root / renderer.TARGET
        begin = renderer.begin_marker("FINDING CATEGORIES") + "\n"
        end = renderer.end_marker("FINDING CATEGORIES") + "\n"
        text = self.reference().replace(begin, "\0").replace(end, begin).replace("\0", end)
        path.write_text(text, encoding="utf-8")

        code, _out, err = run("--root", str(self.root), "--check")

        self.assertEqual(code, 1)
        self.assertIn("out of order", err)


if __name__ == "__main__":
    unittest.main()
