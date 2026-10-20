// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Writable, type Readable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, type Key } from "node:readline";

import { resolveSetupExecutionProfile } from "../config/execution-profile.js";
import {
  assertProviderTransport,
  MODEL_PROVIDERS,
  parseModelProviderOption,
  parseProviderTransport,
  type ModelProviderOption,
} from "../config/model-providers.js";
import { loadConfig } from "../config/runtime-loader.js";
import { styleTerminalText } from "../operator/terminal-style.js";
import { runSetupBootstrap, type SetupBootstrapResult } from "./bootstrap.js";
import { normalizeSetupEndpointUrl, resolveSetupPreset } from "./split-layout-presets.js";

export interface InteractiveSetupPrompter {
  readChoice(label: string, choices: readonly SetupChoice[], defaultValue: string): Promise<string>;
  readValue(label: string, defaultValue: string): Promise<string>;
  readSecret(label: string): Promise<string>;
}

interface SetupChoice {
  value: string;
  label: string;
}

export interface InteractiveSetupInput {
  preset?: string;
  profile?: string;
  migrate?: boolean;
  provider?: string;
  modelId?: string;
  baseUrl?: string;
  api?: string;
  environment?: NodeJS.ProcessEnv;
  prompter: InteractiveSetupPrompter;
}

type RawTerminalInput = Readable & {
  isRaw?: boolean;
  setRawMode?: (enabled: boolean) => void;
};

/** Reuse the normal setup bootstrap, adding only the TTY questions it cannot answer itself. */
export async function runInteractiveSetup(
  input: InteractiveSetupInput,
): Promise<SetupBootstrapResult> {
  const environment = input.environment ?? process.env;
  if (
    (input.provider || input.modelId || (input.baseUrl && !input.profile) || input.api) &&
    (input.migrate || input.preset || input.profile)
  ) {
    throw new Error("Provider options cannot be combined with --profile, --preset, or --migrate.");
  }
  if (input.migrate && (input.preset || input.profile)) {
    throw new Error("DocsFab setup migration cannot also select an installed preset.");
  }
  if (input.preset && input.profile) {
    throw new Error("DocsFab setup accepts either --profile or --preset, not both.");
  }
  if (input.migrate) {
    const migrated = await runSetupBootstrap({ migrate: true, environment });
    if (migrated.status !== "blocked-missing-credential") return migrated;
    environment.MODEL_API_KEY = await readRequiredApiKey(input.prompter);
    return runSetupBootstrap({ environment });
  }

  const requestedProfile = resolveSetupExecutionProfile(input.profile);
  if (requestedProfile) {
    environment.MODEL_API_KEY = await readRequiredApiKey(input.prompter);
    return runSetupBootstrap({ profile: requestedProfile, baseUrl: input.baseUrl, environment });
  }

  const requestedPreset = resolveSetupPreset(input.preset);
  if (requestedPreset) {
    environment.MODEL_API_KEY = await readRequiredApiKey(input.prompter);
    return runSetupBootstrap({ preset: requestedPreset, environment });
  }
  const defaults = interactiveModelDefaults(environment);
  const provider = parseModelProviderOption(
    input.provider ??
      (await input.prompter.readChoice(
        "Provider",
        Object.entries(MODEL_PROVIDERS).map(([value, option]) => ({ value, label: option.label })),
        defaults.provider,
      )),
  );
  const selected = MODEL_PROVIDERS[provider];
  const sameProvider = provider === defaults.provider;
  const modelId = requireModelName(
    input.modelId ??
      (await input.prompter.readValue("Model name", sameProvider ? defaults.modelId : "")),
  );
  const baseUrl = normalizeSetupEndpointUrl(
    input.baseUrl ??
      (selected.baseUrl ||
        (await input.prompter.readValue("Endpoint URL", sameProvider ? defaults.baseUrl : ""))),
  );
  const api =
    input.api ??
    (provider.startsWith("openai")
      ? await input.prompter.readChoice(
          "API",
          [
            { value: "openai-responses", label: "Responses" },
            { value: "openai-chat-completions", label: "Chat Completions" },
          ],
          sameProvider ? (defaults.transport ?? selected.transport) : selected.transport,
        )
      : selected.transport);
  const transport = parseProviderTransport(api);
  assertProviderTransport(provider, transport);
  environment[selected.credentialEnv] = await readRequiredApiKey(input.prompter);
  return runSetupBootstrap({ model: { provider, modelId, baseUrl, transport }, environment });
}

async function readRequiredApiKey(prompter: InteractiveSetupPrompter): Promise<string> {
  const apiKey = (await prompter.readSecret("Model API key")).trim();
  if (!apiKey) throw new Error("DocsFab setup requires a non-empty model API key.");
  return apiKey;
}

export function createTerminalSetupPrompter(
  input: RawTerminalInput = process.stdin,
  output: Writable & { isTTY?: boolean } = process.stdout,
  environment: NodeJS.ProcessEnv = process.env,
): InteractiveSetupPrompter {
  const terminal = output.isTTY === true;
  const paint = (text: string, style: Parameters<typeof styleTerminalText>[2]) =>
    terminal ? styleTerminalText(text, environment, style) : text;
  let started = false;
  const begin = () => {
    if (started || !terminal) return;
    started = true;
    output.write(
      [
        "",
        paint("── DOCSFAB SETUP ──", { nvidiaGreen: true, bold: true }),
        "",
        "  Connect your documentation model.",
        paint("  Used by the live agent and workflows.", { dim: true }),
        "",
      ].join("\n"),
    );
  };
  return {
    readChoice(label, choices, defaultValue) {
      begin();
      return selectChoice(input, output, label, choices, defaultValue, terminal, paint);
    },
    async readValue(label, defaultValue) {
      begin();
      if (terminal) output.write(`\n  ${paint(label, { bold: true })}\n`);
      const prompt = terminal
        ? `  ${defaultValue ? `${paint(`[${defaultValue}]`, { dim: true })} ` : ""}${paint("›", { nvidiaGreen: true })} `
        : `${label} [${defaultValue}]: `;
      const answer = await question(input, output, prompt);
      return answer.trim() || defaultValue;
    },
    async readSecret(label) {
      begin();
      output.write(
        terminal
          ? `\n  ${paint(label, { bold: true })} ${paint("(input hidden)", { dim: true })}\n  ${paint("›", { nvidiaGreen: true })} `
          : `${label}: `,
      );
      return readHiddenSecret(input, output);
    },
  };
}

async function selectChoice(
  input: RawTerminalInput,
  output: Writable,
  label: string,
  choices: readonly SetupChoice[],
  defaultValue: string,
  terminal: boolean,
  paint: (text: string, style: Parameters<typeof styleTerminalText>[2]) => string,
): Promise<string> {
  if (typeof input.setRawMode !== "function" || choices.length === 0) {
    throw new Error("DocsFab setup requires a terminal and at least one selectable option.");
  }
  let selected = choices.findIndex((choice) => choice.value === defaultValue);
  if (selected < 0) selected = 0;
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing;
  // Keep navigation guidance outside the redrawn rows so it can wrap safely.
  if (terminal) {
    output.write(`\n  ${paint("↑/↓ choose · Enter confirm", { dim: true })}\n`);
  }
  const rewind = `\u001b[${choices.length + 1}A\r`;
  const render = () => {
    output.write(
      `\u001b[2K${terminal ? `  ${paint(label, { bold: true })}` : `${label} (↑/↓ to choose, Enter to confirm)`}\n`,
    );
    choices.forEach((choice, index) => {
      const text = `${index === selected ? "❯" : " "} ${choice.label}`;
      output.write(
        `\u001b[2K${terminal ? `  ${paint(text, index === selected ? { bold: true, nvidiaGreen: true } : {})}` : text}\n`,
      );
    });
  };
  emitKeypressEvents(input);
  input.setRawMode(true);
  render();
  return new Promise((resolve, reject) => {
    const restore = () => {
      input.off("keypress", onKeypress);
      input.off("end", onEnd);
      input.off("error", onError);
      input.setRawMode?.(wasRaw);
      if (wasFlowing !== true) input.pause();
    };
    const onError = (error: Error) => {
      restore();
      reject(error);
    };
    const onEnd = () => onError(new Error("DocsFab setup selection was cancelled."));
    const onKeypress = (_text: string, key: Key) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        onEnd();
      } else if (key.name === "return" || key.name === "enter") {
        const choice = choices[selected]!;
        restore();
        output.write(
          `${rewind}\u001b[0J${terminal ? `  ${paint("✓", { nvidiaGreen: true })} ${paint(`${label}:`, { dim: true })} ${paint(choice.label, { bold: true })}` : `${label}: ${choice.label}`}\n`,
        );
        resolve(choice.value);
      } else if (key.name === "up" || key.name === "down") {
        selected = (selected + (key.name === "up" ? -1 : 1) + choices.length) % choices.length;
        output.write(rewind);
        render();
      }
    };
    input.on("keypress", onKeypress);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}

function interactiveModelDefaults(environment: NodeJS.ProcessEnv): {
  modelId: string;
  baseUrl: string;
  provider: ModelProviderOption;
  transport?: string;
} {
  try {
    const current = loadConfig(environment).model;
    const provider = Object.entries(MODEL_PROVIDERS).find(
      ([, option]) => option.providerId === current.providerId,
    )?.[0] as ModelProviderOption | undefined;
    return {
      modelId: current.modelId,
      baseUrl: current.baseUrl,
      provider: provider ?? "openai-compatible",
      transport: current.transport,
    };
  } catch {
    return { modelId: "", baseUrl: MODEL_PROVIDERS.openai.baseUrl, provider: "openai" };
  }
}

function requireModelName(value: string): string {
  const modelId = value.trim();
  if (!modelId) throw new Error("DocsFab setup requires you to provide a non-empty model name.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(modelId)) {
    throw new Error(
      "DocsFab setup model names may contain only letters, numbers, periods, underscores, colons, slashes, and hyphens.",
    );
  }
  return modelId;
}

async function question(input: Readable, output: Writable, prompt: string): Promise<string> {
  const terminal = createInterface({ input, output, terminal: true });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}

async function readHiddenSecret(input: RawTerminalInput, output: Writable): Promise<string> {
  if (typeof input.setRawMode !== "function") {
    throw new Error("DocsFab setup requires a terminal that supports hidden credential input.");
  }
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const restore = () => {
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      if (wasFlowing !== true) input.pause();
      output.write("\n");
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          restore();
          resolve(value);
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          restore();
          reject(new Error("DocsFab setup credential entry was cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
  });
}
