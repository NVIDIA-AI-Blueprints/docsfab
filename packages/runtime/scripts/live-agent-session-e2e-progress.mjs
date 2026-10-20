// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The installed session E2E receives terminal redraws as raw PTY chunks. Elapsed
// time in an active spinner is a heartbeat, not evidence that a workflow advanced.
export function terminalOutputWithoutElapsedProgress(output) {
  return output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001B(?:\[[0-?]*[ -/]*)?$/u, "")
    .split(/\r\n|\r|\n/gu)
    .map((frame) => frame.trim())
    .map((frame) => {
      if (frame === "" || "[Working]".startsWith(frame)) return "";
      if (!frame.startsWith("[Working]")) return frame;
      const complete = /^(\[Working\] .+) \(\d+s\)$/u.exec(frame);
      // A truncated label changes width at 10s and 100s; it cannot prove a new step.
      return complete && !complete[1].endsWith("~") ? complete[1] : "";
    })
    .filter(Boolean)
    .reduce((frames, frame) => {
      // PTY output is cumulative: each redraw appends another frame of the same label.
      if (frame.startsWith("[Working]") && frames.at(-1) === frame) return frames;
      frames.push(frame);
      return frames;
    }, [])
    .join("\n");
}
