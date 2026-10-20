// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyGlabCommandFailure,
  publicationCodeForGlabAuthClass,
  tokenProbeFromExitCode,
} from "../src/delivery/glab-auth-diagnosis.js";

describe("hostname-scoped glab diagnosis", () => {
  it("treats connection reset as unreachable even when a token probe is present", () => {
    expect(
      classifyGlabCommandFailure({
        kind: "auth-status",
        exitCode: 1,
        stderr:
          'Error using API: Get "https://gitlab.example.test/api/v4/user": connection reset by peer',
        tokenProbe: "present",
      }),
    ).toBe("unreachable");
    expect(publicationCodeForGlabAuthClass("unreachable")).toBe("gitlab-unreachable");
  });

  it("treats 401 as unauthenticated", () => {
    expect(
      classifyGlabCommandFailure({
        kind: "auth-status",
        exitCode: 1,
        stderr: "401 Unauthorized",
        tokenProbe: "present",
      }),
    ).toBe("unauthenticated");
    expect(publicationCodeForGlabAuthClass("unauthenticated")).toBe("gitlab-unauthenticated");
  });

  it("uses the token probe when auth-status stderr is empty", () => {
    expect(
      classifyGlabCommandFailure({
        kind: "auth-status",
        exitCode: 1,
        tokenProbe: "missing",
      }),
    ).toBe("unauthenticated");
    expect(
      classifyGlabCommandFailure({
        kind: "auth-status",
        exitCode: 1,
        tokenProbe: "present",
      }),
    ).toBe("unreachable");
  });

  it("keeps connection-reset class after credential-shaped stderr is redacted", () => {
    expect(
      classifyGlabCommandFailure({
        kind: "auth-status",
        exitCode: 1,
        stderr: "connection reset by peer GITLAB_TOKEN=nvapi-abcdefghijklmnopqrstuvwxyz",
        tokenProbe: "present",
      }),
    ).toBe("unreachable");
  });

  it("keeps inconclusive API failures invalid instead of a login class", () => {
    expect(
      classifyGlabCommandFailure({
        kind: "api",
        exitCode: 1,
        stdout: "not json",
        tokenProbe: "missing",
      }),
    ).toBe("invalid");
    expect(publicationCodeForGlabAuthClass("invalid")).toBe("gitlab-response-invalid");
  });

  it("maps token-probe exit codes without reading stdout", () => {
    expect(tokenProbeFromExitCode(0)).toBe("present");
    expect(tokenProbeFromExitCode(1)).toBe("missing");
    expect(tokenProbeFromExitCode(2)).toBe("unverified");
  });
});
