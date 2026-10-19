# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "mine_session.py"
SPEC = importlib.util.spec_from_file_location("mine_session", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load mining script: {SCRIPT}")
mine_session = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mine_session)


def user_event(session_id: str, event_id: str, timestamp: str, text: str) -> dict:
    return {
        "type": "user",
        "sessionId": session_id,
        "uuid": event_id,
        "timestamp": timestamp,
        "message": {"role": "user", "content": text},
    }


def codex_session_meta(session_id: str, timestamp: str) -> dict:
    return {
        "timestamp": timestamp,
        "type": "session_meta",
        "payload": {"id": session_id, "session_id": session_id},
    }


def codex_message(role: str, timestamp: str, text: str) -> dict:
    return {
        "timestamp": timestamp,
        "type": "response_item",
        "payload": {
            "type": "message",
            "role": role,
            "content": [{"type": "input_text", "text": text}],
        },
    }


class MineSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.session = self.root / "session.jsonl"
        events = [
            user_event(
                "session-1",
                "event-1",
                "2026-08-07T00:00:00Z",
                "<system_instruction>injected</system_instruction>Describe the shared work graph.",
            ),
            user_event(
                "session-1",
                "event-2",
                "2026-08-07T00:01:00Z",
                "Continue from where you left off.",
            ),
            user_event(
                "session-1",
                "event-3",
                "2026-08-07T00:02:00Z",
                "API_KEY=1234567890abcdef",
            ),
            user_event(
                "session-1",
                "event-1",
                "2026-08-07T00:00:00Z",
                "<system_instruction>injected</system_instruction>Describe the shared work graph.",
            ),
        ]
        self.session.write_text(
            "".join(json.dumps(event) + "\n" for event in events),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_extract_preserves_classification_lineage_and_secret_boundary(self) -> None:
        records = list(mine_session.iter_candidates(self.session, None, None))
        assert len(records) == 4
        assert records[0]["text"] == "Describe the shared work graph."
        assert records[0]["text_transform"] == "stripped-leading-system-instruction"
        assert records[0]["authorship"]["origin_class"] == "likely-human"
        assert records[1]["authorship"]["origin_class"] == "synthetic"
        assert records[2]["text"] is None
        assert records[2]["sensitive_flags"] == ["assigned-secret"]
        assert records[3]["duplicate_of"] == records[0]["candidate_id"]

    def test_render_preserves_selected_text_and_anchors(self) -> None:
        candidates_path = self.root / "candidates.jsonl"
        mine_session.write_jsonl(
            candidates_path,
            mine_session.iter_candidates(self.session, None, None),
        )
        candidates, source = mine_session.load_candidates(candidates_path)
        selected_id = next(iter(candidates))
        selection_path = self.root / "selection.json"
        selection_path.write_text(
            json.dumps(
                {
                    "schema_version": mine_session.SCHEMA_SELECTION,
                    "title": "Evidence",
                    "source_sha256": source["sha256"],
                    "selection_scope": {
                        "participant": "Andrew",
                        "time_range": "2026-08-07",
                        "model_regions": ["UI"],
                    },
                    "selections": [
                        {
                            "candidate_id": selected_id,
                            "evidence_id": "A-001",
                            "heading": "Graph",
                            "model_regions": ["UI"],
                            "topics": ["graph"],
                            "selection_note": "Direct description.",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        output_path = self.root / "evidence.md"
        mine_session.render_artifact(candidates_path, selection_path, output_path)
        rendered = output_path.read_text(encoding="utf-8")
        assert "Source line: `1`" in rendered
        assert "> Describe the shared work graph." in rendered

    def test_render_rejects_synthetic_and_duplicate_candidates(self) -> None:
        candidates_path = self.root / "candidates.jsonl"
        mine_session.write_jsonl(
            candidates_path,
            mine_session.iter_candidates(self.session, None, None),
        )
        candidates, source = mine_session.load_candidates(candidates_path)
        rejected = [
            candidate
            for candidate in candidates.values()
            if candidate["authorship"]["origin_class"] == "synthetic"
            or candidate["duplicate_of"] is not None
        ]
        assert len(rejected) == 2
        for index, candidate in enumerate(rejected, start=1):
            selection_path = self.root / f"selection-{index}.json"
            selection_path.write_text(
                json.dumps(
                    {
                        "schema_version": mine_session.SCHEMA_SELECTION,
                        "title": "Invalid evidence",
                        "source_sha256": source["sha256"],
                        "selection_scope": {},
                        "selections": [
                            {
                                "candidate_id": candidate["candidate_id"],
                                "evidence_id": f"A-{index:03d}",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            caught_error = None
            try:
                mine_session.render_artifact(
                    candidates_path,
                    selection_path,
                    self.root / f"invalid-{index}.md",
                )
            except mine_session.MiningError as exc:
                caught_error = exc
            assert caught_error is not None

    def test_codex_adapter_extracts_only_user_response_items(self) -> None:
        codex_session = self.root / "codex-session.jsonl"
        events = [
            codex_session_meta("codex-session-1", "2026-08-10T00:00:00Z"),
            codex_message(
                "developer",
                "2026-08-10T00:00:01Z",
                "Developer instructions are not human evidence.",
            ),
            codex_message(
                "user",
                "2026-08-10T00:01:00Z",
                "Describe the sustained-session execution model.",
            ),
            {
                "timestamp": "2026-08-10T00:01:00Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "Describe the sustained-session execution model.",
                },
            },
            codex_message(
                "user",
                "2026-08-10T00:02:00Z",
                "<recommended_plugins>synthetic bootstrap</recommended_plugins>",
            ),
            codex_message(
                "user",
                "2026-08-10T00:02:30Z",
                '<codex_internal_context source="goal">synthetic continuation</codex_internal_context>',
            ),
            codex_message(
                "user",
                "2026-08-10T00:03:00Z",
                "API_KEY=1234567890abcdef",
            ),
        ]
        codex_session.write_text(
            "".join(json.dumps(event) + "\n" for event in events),
            encoding="utf-8",
        )

        assert mine_session.detect_adapter(codex_session) == mine_session.CODEX_ADAPTER_NAME
        records = list(mine_session.iter_candidates(codex_session, None, None))
        assert len(records) == 4
        assert records[0]["candidate_id"] == "codex:codex-session-1:line:3"
        assert records[0]["text"] == "Describe the sustained-session execution model."
        assert records[0]["source"]["format"] == mine_session.CODEX_ADAPTER_NAME
        assert records[1]["authorship"]["origin_class"] == "synthetic"
        assert records[2]["authorship"]["origin_class"] == "synthetic"
        assert records[3]["text"] is None
        assert records[3]["sensitive_flags"] == ["assigned-secret"]

    def test_explicit_adapter_mismatch_fails_closed(self) -> None:
        caught_error = None
        try:
            list(
                mine_session.iter_candidates(
                    self.session,
                    None,
                    None,
                    mine_session.CODEX_ADAPTER_NAME,
                )
            )
        except mine_session.MiningError as exc:
            caught_error = exc
        assert caught_error is not None

    def test_operator_marker_classifies_an_injected_message_as_synthetic(self) -> None:
        marked = self.root / "marked.jsonl"
        marked.write_text(
            json.dumps(
                user_event("session-2", "event-1", "2026-08-07T00:00:00Z", "[ops dispatch] run it")
            )
            + "\n",
            encoding="utf-8",
        )
        unmarked = list(mine_session.iter_candidates(marked, None, None))
        assert unmarked[0]["authorship"]["origin_class"] == "likely-human"
        records = list(
            mine_session.iter_candidates(marked, None, None, None, ["[ops dispatch]"])
        )
        assert records[0]["authorship"]["origin_class"] == "synthetic"
        assert records[0]["authorship"]["classification_reasons"] == ["synthetic-prefix:[ops dispatch]"]

    def test_operator_marker_with_leading_whitespace_refuses_and_trailing_space_matches(self) -> None:
        refused = None
        try:
            mine_session.synthetic_prefixes([" [ops dispatch]"])
        except mine_session.MiningError as exc:
            refused = exc
        assert refused is not None
        assert "starts with whitespace, which no message can match" in str(refused)
        marked = self.root / "spaced.jsonl"
        marked.write_text(
            json.dumps(
                user_event("session-3", "event-1", "2026-08-07T00:00:00Z", "  [ops dispatch] run it")
            )
            + "\n",
            encoding="utf-8",
        )
        records = list(mine_session.iter_candidates(marked, None, None, None, ["[ops dispatch] "]))
        assert records[0]["authorship"]["origin_class"] == "synthetic"

    def test_extract_refuses_a_blank_operator_marker_before_writing(self) -> None:
        import subprocess
        import sys

        output = self.root / "candidates.jsonl"
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "extract",
                str(self.session),
                "--synthetic-prefix",
                "  ",
                "--output",
                str(output),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 2
        assert "--synthetic-prefix must name a non-blank marker" in result.stderr
        assert not output.exists()
        assert not output.with_name(f".{output.name}.partial").exists()


if __name__ == "__main__":
    unittest.main()
