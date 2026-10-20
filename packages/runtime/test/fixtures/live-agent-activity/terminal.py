# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Drive the installed CLI through a real PTY without third-party dependencies."""
import errno
import fcntl
import os
import re
import select
import signal
import struct
import sys
import time
import termios


def session(executable, repository, resume=False):
    pid, fd = os.forkpty()
    if pid == 0:
        os.execv(executable, [executable, "live-agent", "--repo", repository, "--read-only"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
    output = ""
    cursor = 0
    rich = os.environ.get("DOCSFAB_TEST_RICH") == "1"

    def transcript():
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)

    def wait_for(text, timeout=90):
        nonlocal output, cursor
        deadline = time.monotonic() + timeout
        while text not in transcript()[cursor:]:
            if time.monotonic() > deadline:
                raise AssertionError("Timed out waiting for " + text + "\n" + output)
            if select.select([fd], [], [], 0.1)[0]:
                try:
                    data = os.read(fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        data = b""
                    else:
                        raise
                if not data:
                    raise AssertionError("Unexpected CLI exit\n" + output)
                output += data.decode("utf-8", errors="replace")
        cursor = transcript().index(text, cursor) + len(text)

    def answer(text):
        if rich:
            wait_for("DOCSFAB")
            wait_for(text)
        else:
            wait_for("DocsFab: " + text)

    def send(value):
        os.write(fd, value.encode())

    try:
        wait_for("You: ")
        if resume:
            send("ACTIVITY resume\n")
            wait_for("[Working] Contacting model (0s)")
            answer("Resumed.")
        else:
            send("ACTIVITY direct\n")
            wait_for("[Working] Contacting model (0s)")
            wait_for("Contacting model (1s)")
            answer("Direct answer.")
            if rich:
                wait_for("node cli.mjs export --output report.txt")
            wait_for("You: ")
            send("ACTIVITY skill\n")
            wait_for("[Done] Loading skill: review-documentation")
            answer("Skill loaded.")
            wait_for("You: ")
            send("ACTIVITY workflow\n")
            wait_for("[Working] Running workflow: review-documentation")
            wait_for("[Done] Running workflow: review-documentation")
            answer("Workflow result received.")
            wait_for("You: ")
            send("ACTIVITY error\n")
            wait_for("Authentication failed (HTTP 401).")
            wait_for("You: ")
            send("ACTIVITY blank\n")
            wait_for("Model returned no answer.")
            wait_for("You: ")
            send("ACTIVITY context\n")
            wait_for("Context budget exceeded.")
            wait_for("You: ")
            send("ACTIVITY interrupt\n")
            wait_for("[Working] Contacting model (0s)")
            send("\x03")
            wait_for("[Interrupted]")
        wait_for("You: ")
        send("/exit\n")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            exited, status = os.waitpid(pid, os.WNOHANG)
            if exited:
                assert os.waitstatus_to_exitcode(status) == 0, output
                pid = None
                break
            if select.select([fd], [], [], 0.05)[0]:
                try:
                    output += os.read(fd, 65536).decode("utf-8", errors="replace")
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
        assert pid is None, "CLI did not exit after /exit\n" + output
        assert "PRIVATE_PROVIDER_PAYLOAD" not in output, "Private error payload leaked"
        if rich:
            assert "\x1b[38;5;" in output, "Colored message sections missing"
            assert "read-only" in transcript(), "Host mode missing from startup"
            assert "READ-ONLY" not in transcript(), "Host mode repeated above the prompt"
            assert "WORKFLOW WRITES ENABLED" not in transcript(), "Write mode repeated above the prompt"
            assert "/exit to quit" not in transcript(), "Help repeated above the prompt"
            assert "## Direct answer." not in transcript(), "Markdown heading was not rendered"
            assert "**Bluebird**" not in transcript(), "Markdown emphasis was not rendered"
        print(output)
        return re.search(r"Session\s+([^\r\n]+)", output).group(1)
    finally:
        os.close(fd)
        if pid is not None:
            os.killpg(pid, signal.SIGTERM)
            os.waitpid(pid, 0)


first_session = session(sys.argv[1], sys.argv[2])
resumed_session = session(sys.argv[1], sys.argv[2], resume=True)
assert first_session == resumed_session, "The second conversation did not resume the same session"
