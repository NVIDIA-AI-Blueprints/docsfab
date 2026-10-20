// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator journey the bench pilot runs: `docsfab run update-documentation
 * --change <base>..<head>` through `executeRunRequest` with no injected harness
 * or skill resolver, so the run builds its own `PiHarness`, grant, and read
 * budget from a 32K-token model profile. A scripted provider plays the model:
 * it lists the bound sources and reads each by its short handle alone, and
 * again in the shape a live model sent on every call: all eight arguments,
 * exact ids and span ids, and the unused selection arguments filled in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { decodeTools } from "../src/execution/inference-evidence.js";
import { parseChangeSourceSelector } from "../src/inputs/change-source.js";
import { changeSourceRepositoryPath } from "../src/inputs/change-source/acquisition.js";
import type { ModelEndpointConfig } from "../src/model/configuration.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { commitFiles } from "./support/change-source-fixture.js";
import { textTurn, toolTurn } from "./support/pi-harness-session-fixtures.js";
import { createSourceFixture, runRequest } from "./support/source-acquisition-cli.js";
import { listedInventory, type SourceListing } from "./support/source-listing.js";

const roots = temporaryRoots();

afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

/** The placeholder window a model of unknown metadata runs at. */
const CONTEXT_WINDOW = 32_768;
const SMALL_MODEL: ModelEndpointConfig = {
  ...validModelConfig,
  profile: {
    ...validModelConfig.profile!,
    configuredLimits: {
      contextWindow: CONTEXT_WINDOW,
      maxInputTokens: CONTEXT_WINDOW,
      maxOutputTokens: 4_096,
    },
    contextWindow: CONTEXT_WINDOW,
    maxInputTokens: CONTEXT_WINDOW,
    maxOutputTokens: 4_096,
  },
};

type ProviderRequest = {
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>;
};

function messageText(content: unknown): string {
  return typeof content === "string"
    ? content
    : (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
}

/** Lists, reads every source and one diff file by handle, then answers. */
class HandleReader {
  public readonly results = new Map<string, string>();
  public listing: SourceListing | undefined;

  public readonly fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).startsWith(validModelConfig.baseUrl)) {
      throw new Error(`Unexpected request to ${String(url)}.`);
    }
    const body = JSON.parse(String(init?.body)) as ProviderRequest;
    const tools = body.messages.filter((message) => message.role === "tool");
    for (const message of tools)
      this.results.set(message.tool_call_id!, messageText(message.content));
    if (tools.length === 0) {
      return toolTurn([{ id: "list", name: "docsfab_list_sources", arguments: {} }]);
    }
    if (tools.length === 1) {
      this.listing = JSON.parse(this.results.get("list")!) as SourceListing;
      const diff = this.listing.sources.find((source) => source.mediaType === "text/x-diff")!;
      return toolTurn(
        [
          ...this.listing.sources.map((source) => ({
            id: `read-${source.handle}`,
            name: "docsfab_read_source",
            arguments: { source: source.handle, maxBytes: 2_048 },
          })),
          {
            id: "diff-file",
            name: "docsfab_read_source",
            arguments: { source: diff.handle, diffFile: 1 },
          },
          ...this.listing.sources.map((source) => ({
            id: `observed-${source.handle}`,
            name: "docsfab_read_source",
            arguments: {
              source: source.handle,
              observationId: source.observationId,
              representationId: source.representationId,
              spanIds: [this.listing!.spans.find((span) => span.source === source.handle)!.spanId],
              diffFile: null,
              diffHunk: 0,
              fromByte: 0,
              maxBytes: 0,
            },
          })),
        ],
        2,
      );
    }
    return textTurn(JSON.stringify({ summary: "Nothing in the bound change needs a page." }));
  }) as unknown as typeof globalThis.fetch;

  public payload(id: string): { kind: string; source?: string; spans: Array<{ text: string }> } {
    const text = this.results.get(id);
    if (text === undefined) throw new Error(`No tool result for ${id}.`);
    if (!text.startsWith("{")) throw new Error(`${id} was refused: ${text}`);
    return JSON.parse(text) as { kind: string; source?: string; spans: Array<{ text: string }> };
  }
}

describe("the operator update-documentation journey at a 32K window", () => {
  it(
    "reads the bound diff and manifest by handle through the run's own harness",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      // Six changed files, the shape of a small merged change.
      const files = Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [
          `src/module-${index + 1}.ts`,
          `export const setting${index + 1} = ${index + 1};\nexport const label${index + 1} = "module ${index + 1}";\n`,
        ]),
      );
      const head = await commitFiles(fixture.repository, files, "Add six modules");
      const model = new HandleReader();
      vi.stubGlobal("fetch", model.fetch);

      const record = await executeRunRequest(
        {
          ...runRequest(fixture),
          workflow: "update-documentation",
          instruction: "Update the documentation for the merged change.",
          allowWrite: false,
          changeSource: parseChangeSourceSelector("HEAD~1..HEAD"),
        },
        { ...runtimeConfig(fixture.stateDirectory), model: SMALL_MODEL },
        { silent: true },
      );

      const listing = model.listing!;
      // Handles follow the binding's order, so each is found by its path.
      const handleOf = (path: string) =>
        listing.sources.find((source) => source.repositoryPath === path)?.handle;
      const diff = handleOf(changeSourceRepositoryPath(head, "diff"))!;
      const manifest = handleOf(changeSourceRepositoryPath(head, "manifest"))!;
      expect([diff, manifest].sort()).toEqual(["s1", "s2"]);
      // Each source's long ids appear once, on its row, never per span.
      const raw = model.results.get("list")!;
      for (const source of listing.sources) {
        expect(raw.split(source.observationId)).toHaveLength(2);
        expect(raw.split(source.representationId)).toHaveLength(2);
      }
      // The listing a model reads before any source text: smaller than the
      // same inventory with every span row carrying its source's identity.
      const repeated = JSON.stringify({ ...listing, spans: listedInventory(listing) });
      expect(Buffer.byteLength(raw)).toBeLessThan(Buffer.byteLength(repeated) * 0.6);

      expect(model.payload(`read-${diff}`)).toMatchObject({
        kind: "docsfab-source-window-read",
        source: diff,
      });
      expect(model.payload(`read-${diff}`).spans[0]!.text).toMatch(/^diff manifest: 6 files/u);
      expect(model.payload(`read-${manifest}`)).toMatchObject({
        kind: "docsfab-source-window-read",
        source: manifest,
      });
      expect(model.payload("diff-file")).toMatchObject({
        kind: "docsfab-source-diff-read",
        source: diff,
        diffFile: 1,
      });
      expect(model.payload("diff-file").spans[0]!.text.startsWith("diff --git ")).toBe(true);
      // The observed shape reads the named span of each source.
      for (const handle of [diff, manifest]) {
        expect(model.payload(`observed-${handle}`), handle).toMatchObject({
          kind: "docsfab-source-span-read",
          source: handle,
        });
      }

      // Whatever the plan's fate, the planner step's record shows every read served.
      const plan = record!.steps.find((step) => step.id === "plan-documentation")!;
      const tools = decodeTools(plan.tools);
      expect(tools.byTool.find((entry) => entry.name === "docsfab_read_source")).toEqual({
        name: "docsfab_read_source",
        calls: 5,
        failures: 0,
      });
      expect(tools.toolRefusals).toBeUndefined();
      expect(tools.toolArgumentFiller).toEqual(
        (
          [
            ["diffFile", "null"],
            ["diffHunk", "zero"],
            ["fromByte", "zero"],
            ["maxBytes", "zero"],
          ] as const
        ).map(([argument, kind]) => ({
          tool: "docsfab_read_source",
          argument,
          kind,
          count: 2,
        })),
      );
    },
    testTimeoutMs(120_000),
  );
});
