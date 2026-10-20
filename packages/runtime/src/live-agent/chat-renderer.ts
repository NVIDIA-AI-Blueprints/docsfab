// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";

/** Append-only chat presentation. Pi renders Markdown; terminal state stays host-owned. */
export class LiveAgentChatRenderer {
  private pending = "";
  private block = "";
  private fence?: string;
  private opened = false;

  constructor(
    private readonly options: {
      write: (text: string) => void;
      columns?: () => number;
      tty: boolean;
      environment?: NodeJS.ProcessEnv;
    },
  ) {
    if (this.rich) initTheme(undefined, false);
  }

  get rich(): boolean {
    const env = this.options.environment ?? {};
    return (
      this.options.tty &&
      !Object.hasOwn(env, "NO_COLOR") &&
      env.FORCE_COLOR !== "0" &&
      env.TERM !== "dumb"
    );
  }

  prompt(): string {
    if (!this.rich) return "You: ";
    this.options.write(`\n${this.rule("YOU", 81)}\n`);
    return `${this.paint("You:", 81)} `;
  }

  append(delta: string): void {
    if (!this.opened) {
      this.options.write(this.rich ? `\n${this.rule("DOCSFAB", 113)}\n` : "DocsFab: ");
      this.opened = true;
    }
    if (!this.rich) {
      this.options.write(delta);
      return;
    }
    // Keep unfinished Markdown together across provider chunks, including fences.
    this.pending += delta;
    let end: number;
    while ((end = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, end + 1);
      this.pending = this.pending.slice(end + 1);
      this.block += line;
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line.trimEnd());
      if (marker) {
        if (!this.fence) this.fence = marker[1];
        else if (
          marker[1]?.[0] === this.fence[0] &&
          (marker[1]?.length ?? 0) >= this.fence.length &&
          !marker[2]?.trim()
        ) {
          this.fence = undefined;
          this.flush();
        }
      } else if (!this.fence && !line.trim()) this.flush();
    }
  }

  close(): void {
    if (!this.opened) return;
    if (this.rich) {
      this.block += this.pending;
      this.pending = "";
      this.flush();
      this.options.write(`${this.paint("─".repeat(this.width), 238)}\n`);
    } else this.options.write("\n");
    this.fence = undefined;
    this.opened = false;
  }

  paint(text: string, color: number): string {
    return this.rich ? `\u001b[38;5;${color}m${text}\u001b[0m` : text;
  }

  private get width(): number {
    return Math.max(12, Math.min(100, (this.options.columns?.() || 80) - 1));
  }

  private rule(label: string, color: number): string {
    return this.paint(
      `── ${label} ${"─".repeat(Math.max(0, this.width - label.length - 4))}`,
      color,
    );
  }

  private flush(): void {
    let text = stripVTControlCharacters(this.block)
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "")
      .replace(/^\n+|\n+$/gu, "");
    this.block = "";
    if (!text.trim()) return;
    // Pi trims message edges. Protect indented code from becoming inline Markdown.
    if (/^(?: {4}|\t)/u.test(text)) {
      const fence = "`".repeat(
        Array.from(text.matchAll(/`+/gu)).reduce(
          (length, match) => Math.max(length, match[0].length + 1),
          3,
        ),
      );
      text = `${fence}text\n${text}\n${fence}`;
    }
    // Presentation-only message: never put fabricated usage into session evidence.
    const component = new AssistantMessageComponent(
      {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: "presentation",
        model: "presentation",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
      true,
      // Quote styling stays visible without putting decorative bars in copied text.
      { ...getMarkdownTheme(), quoteBorder: () => "" },
      "",
      0,
    );
    const lines = component.render(this.width);
    // Pi's shell-integration OSC markers do not belong in our readline transcript.
    const rendered = lines.map((line) => line.replace(/\u001b\]133;[ABC]\u0007/gu, ""));
    while (rendered[0] === "") rendered.shift();
    while (rendered.at(-1) === "") rendered.pop();
    for (const line of rendered) this.options.write(`${line}\n`);
    this.options.write("\n");
  }
}
