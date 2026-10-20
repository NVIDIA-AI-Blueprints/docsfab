// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  projectModelBaseUrl,
  sanitizeDisplaySpans,
  sanitizeDisplayText,
} from "../src/operator/display-sanitize.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
const HUB_ORIGIN = new URL(HUB_BASE_URL).origin;

const HOSTILE =
  "https://fixture-user:fixture-secret@evil.example.test/v1/hidden?api_key=nvapi-abcdefghijklmnopqrstuvwxyz012345#leak-fragment";

describe("display sanitizer", () => {
  it("projects MODEL_BASE_URL to origin-only executable-route HTTPS", () => {
    expect(projectModelBaseUrl(HOSTILE)).toBeNull();
    expect(
      projectModelBaseUrl(
        "https://fixture-user:fixture-secret@api.openai.com/v1/hidden?api_key=nvapi-abcdefghijklmnopqrstuvwxyz012345#frag",
      ),
    ).toBe("https://api.openai.com");
    expect(projectModelBaseUrl(HUB_BASE_URL)).toBe(HUB_ORIGIN);
  });

  it("redacts userinfo, path, query, fragment, and secret-shaped diagnostics", () => {
    const text = sanitizeDisplayText(`child stderr ${HOSTILE}`);
    expect(text).not.toContain("fixture-user");
    expect(text).not.toContain("fixture-secret");
    expect(text).not.toContain("evil.example.test");
    expect(text).not.toContain("/v1/hidden");
    expect(text).not.toContain("nvapi-abcdefghijklmnopqrstuvwxyz012345");
    expect(text).not.toContain("leak-fragment");
    expect(text).toContain("[REDACTED]");
  });

  it("redacts URL userinfo split across a newline", () => {
    const text = sanitizeDisplayText(
      "child stderr https://fixture-user:fixture-\nsecret@evil.example.test/v1",
    );
    expect(text).not.toContain("fixture-user");
    expect(text).not.toContain("secret@");
    expect(text).not.toContain("evil.example.test");
    expect(text).toContain("[REDACTED]");
    expect(
      sanitizeDisplayText('DocsFab recorded the origin "https://api.openai.com"\nNext sentence'),
    ).toBe('DocsFab recorded the origin "https://api.openai.com"\nNext sentence');
  });

  it("redacts wrap-class URL userinfo split mid-token", () => {
    const text = sanitizeDisplayText(
      "child stderr https://fixture-user:secret\nword@evil.example.test/v1",
    );
    expect(text).not.toContain("fixture-user");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("word@");
    expect(text).not.toContain("evil.example.test");
    expect(text).not.toContain("/v1");
    expect(text).toContain("[REDACTED]");
  });

  it("marks as spans everything sanitizeDisplayText redacts, in place", () => {
    const inputs = [
      `child stderr ${HOSTILE}`,
      "child stderr https://fixture-user:fixture-\nsecret@evil.example.test/v1 after",
      "child stderr https://fixture-user:secret\nword@evil.example.test/v1",
      'DocsFab recorded the origin "https://api.openai.com"\nNext sentence',
      "API_KEY: fixture-value-0123 and SECRET=other-fixture-value then prose",
      "ihub_api_abcdefghijklmnopqrstuvwxyz012345 nvapi-abcdefghijklmnopqrstuvwxyz012345",
      "plain prose with no secrets at all",
    ];
    for (const input of inputs) {
      const spans = sanitizeDisplaySpans(input);
      const mask = new Uint8Array(input.length);
      for (const [start, end] of spans) mask.fill(1, start, end);
      let masked = "";
      for (let index = 0; index < input.length; index += 1) {
        if (!mask[index]) masked += input[index];
        else if (index === 0 || !mask[index - 1]) masked += "[REDACTED]";
      }
      const count = (text: string | null | undefined) =>
        (text ?? "").split("[REDACTED]").length - 1;
      // Nothing sanitizeDisplayText would still redact is left outside the spans.
      expect(count(sanitizeDisplayText(masked)), input).toBe(count(masked));
      expect(count(masked), input).toBeGreaterThanOrEqual(count(sanitizeDisplayText(input)));
      expect(spans.length === 0, input).toBe(sanitizeDisplayText(input) === input);
    }
  });

  it("redacts an nvapi or ihub key after a hyphen or underscore, not a prefix inside a word", () => {
    // Built at run time, so this file holds no credential-shaped literal for a secret scanner.
    const body = "Fixture0123456789abcdefghijKLMN";
    for (const text of [
      "model x-" + "nva" + "pi-" + body + " end",
      "model x_" + "nva" + "pi-" + body + " end",
      "hub x-" + "ihub" + "_api_" + body + " end",
      // Case-insensitive: an uppercase key after a hyphen is still one.
      "HUB X-" + "IHUB" + "_API_" + body.toUpperCase() + " END",
      "key-" + "nva" + "pi-" + body,
    ]) {
      const sanitized = sanitizeDisplayText(text) ?? "";
      expect(sanitized, text).not.toContain(body);
      expect(sanitized, text).toContain("[REDACTED]");
      expect(sanitizeDisplaySpans(text).length, text).toBeGreaterThan(0);
    }
    for (const text of [
      "linvapi-" + body,
      // A digit before a prefix is inside a word too.
      "v2" + "nva" + "pi-" + body,
      "x-" + "nva" + "pi-short tail",
      "first-pass support",
      // An underscore before ihub_api_ is part of a name, as credential-material-core.js decides.
      "X_IHUB_API_KEY_FILE_PATH_FOR_TESTS",
      "hub x_" + "ihub" + "_api_" + body + " end",
    ]) {
      expect(sanitizeDisplayText(text), text).toBe(text);
      expect(sanitizeDisplaySpans(text), text).toEqual([]);
    }
  });

  it("leaves host paths to the caller's root projection; spans still mark home paths", () => {
    const input =
      "see /Users/fixture/project/file.txt and C:\\Users\\fixture\\x and /home/fixture/y";
    expect(sanitizeDisplayText(input)).toBe(input);
    expect(sanitizeDisplayText(input, (text) => text.replaceAll("/Users/fixture", "~"))).toBe(
      "see ~/project/file.txt and C:\\Users\\fixture\\x and /home/fixture/y",
    );
    const marked = sanitizeDisplaySpans(input).map(([start, end]) => input.slice(start, end));
    expect(marked).toEqual([
      "/Users/fixture/project/file.txt",
      "C:\\Users\\fixture\\x",
      "/home/fixture/y",
    ]);
  });
});
