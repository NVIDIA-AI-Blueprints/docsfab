// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { MODEL_PROVIDERS } from "../src/config/model-providers.js";
import { createTerminalSetupPrompter } from "../src/setup/interactive.js";

const choices = Object.entries(MODEL_PROVIDERS).map(([value, option]) => ({
  value,
  label: option.label,
}));

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(enabled: boolean) {
      this.isRaw = enabled;
    },
  });
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  return {
    input,
    output,
    rendered: () => rendered,
    prompt: createTerminalSetupPrompter(input, output),
  };
}

describe("setup selection menus", () => {
  it.each([
    ["down arrow", "openai", "\u001b[B\r", "openai-compatible"],
    ["up arrow wraps", "openai", "\u001b[A\r", "anthropic-compatible"],
    ["saved default", "anthropic", "\r", "anthropic"],
  ])(
    "selects a provider with %s and restores terminal input",
    async (_name, initial, keys, expected) => {
      const { input, prompt, rendered } = terminal();
      const answer = prompt.readChoice("Provider", choices, initial!);
      input.write(keys!);
      expect(await answer).toBe(expected);
      expect(rendered()).toContain("↑/↓ to choose, Enter to confirm");
      for (const choice of choices) expect(rendered()).toContain(choice.label);
      expect(input.isRaw).toBe(false);
      expect(input.isPaused()).toBe(true);
      expect(input.listenerCount("keypress")).toBe(0);
    },
  );

  it("keeps the API key hidden after a menu selection", async () => {
    const { input, prompt, rendered } = terminal();
    const choice = prompt.readChoice("Provider", choices, "openai");
    input.write("\r");
    await choice;
    const secret = prompt.readSecret("Model API key");
    input.write("fixture-secret\r");
    expect(await secret).toBe("fixture-secret");
    expect(rendered()).not.toContain("fixture-secret");
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
  });

  it.each(["\u0003", "\u0004"])(
    "cancels selection with %j and restores terminal input",
    async (key) => {
      const { input, prompt } = terminal();
      const answer = prompt.readChoice("Provider", choices, "openai");
      const rejection = expect(answer).rejects.toThrow("selection was cancelled");
      input.write(key);
      await rejection;
      expect(input.isRaw).toBe(false);
      expect(input.isPaused()).toBe(true);
      expect(input.listenerCount("keypress")).toBe(0);
    },
  );

  it("ends the prompt when terminal input closes", async () => {
    const { input, prompt } = terminal();
    const answer = prompt.readChoice("Provider", choices, "openai");
    const rejection = expect(answer).rejects.toThrow("selection was cancelled");
    input.end();
    await rejection;
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("keypress")).toBe(0);
  });
});
