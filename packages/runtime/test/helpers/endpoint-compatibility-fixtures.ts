// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

export const ENDPOINT_FIXTURE_NAMES = [
  "ultra-tool-call-ok",
  "tool-call-missing",
  "json-contract-fail",
  "nano-end-of-life-410",
  "nano-not-found-404",
  "lightning-length-cut",
  "super-stream-error-503",
] as const;

export type EndpointFixtureName = (typeof ENDPOINT_FIXTURE_NAMES)[number];

interface FixtureResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body?: string;
  readonly events?: readonly unknown[];
}

export interface EndpointFixture {
  readonly route: string;
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly responses: readonly FixtureResponse[];
}

export function loadEndpointFixture(name: EndpointFixtureName): EndpointFixture {
  const url = new URL(`../fixtures/endpoint-compatibility/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as EndpointFixture;
}

function renderBody(response: FixtureResponse): string {
  if (response.events) {
    return response.events
      .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
      .join("");
  }
  return response.body ?? "";
}

export interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

/**
 * A `fetch` replacement that answers from a fixture in request order and
 * records what the probe sent. After the last response, the last one repeats.
 */
export function fixtureFetch(fixture: EndpointFixture): {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const replay = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const response = fixture.responses[Math.min(requests.length, fixture.responses.length) - 1]!;
    return new Response(renderBody(response), {
      status: response.status,
      headers: { "content-type": response.contentType },
    });
  };
  return { fetch: replay as typeof fetch, requests };
}
