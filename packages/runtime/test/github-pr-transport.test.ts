// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createGithubPrTransport,
  decodeGithubPackets,
  GithubPrTransportError,
  githubPrLimits,
  parseGithubPrAdvertisement,
  parseGithubPrFetchResponse,
  type GithubPrFetchPort,
} from "../src/inputs/adapters/github-pr-transport.js";

function pkt(value: Buffer | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value, "ascii") : value;
  return Buffer.concat([
    Buffer.from((data.length + 4).toString(16).padStart(4, "0"), "ascii"),
    data,
  ]);
}

const flush = Buffer.from("0000", "ascii");
const delim = Buffer.from("0001", "ascii");
const advertisement = Buffer.concat([
  pkt("version 2\n"),
  pkt("fetch=shallow filter wait-for-done\n"),
  pkt("object-format=sha1\n"),
  flush,
]);
const SHA = "a".repeat(40);

function chunks(body: Buffer, width: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= body.length) return controller.close();
      controller.enqueue(body.subarray(at, Math.min(body.length, at + width)));
      at += width;
    },
  });
}

function answer(body: Buffer, contentType: string, width = 1): Response {
  return new Response(chunks(body, width), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function sideband(pack: Buffer): Buffer {
  return Buffer.concat([
    pkt("shallow-info\n"),
    pkt(`shallow ${SHA}\n`),
    delim,
    pkt("packfile\n"),
    pkt(Buffer.concat([Buffer.from([1]), pack])),
    flush,
  ]);
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof GithubPrTransportError) return error.code;
    throw error;
  }
  return undefined;
}

describe("GitHub PR smart-HTTP v2 transport", () => {
  it("parses fragmented packet framing and preserves exact pack bytes", async () => {
    const pack = Buffer.from("PACK\0fragmented\0", "latin1");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchPort: GithubPrFetchPort = async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? answer(advertisement, "application/x-git-upload-pack-advertisement")
        : answer(sideband(pack), "application/x-git-upload-pack-result", 3);
    };
    const budget = { admittedBytes: 0 };
    const transport = createGithubPrTransport(
      { owner: "verified", repo: "docs" },
      {
        limits: githubPrLimits(),
        budget,
        deadlineAt: performance.now() + 10000,
        fetchPort,
      },
    );
    await transport.discover();
    const result = await transport.fetch({ wants: [SHA], filter: "tree:0", deepen: 2 });
    expect(result.pack).toEqual(pack);
    expect(result.shallow).toEqual([SHA]);
    expect(budget.admittedBytes).toBe(advertisement.length + sideband(pack).length);
    expect(calls.map((call) => call.url)).toEqual([
      "https://github.com/verified/docs.git/info/refs?service=git-upload-pack",
      "https://github.com/verified/docs.git/git-upload-pack",
    ]);
    expect(calls[0]?.init.credentials).toBe("omit");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(Buffer.from(calls[1]!.init.body as ArrayBuffer).toString("ascii")).toContain(
      `want ${SHA}\n`,
    );
    expect(Buffer.from(calls[1]!.init.body as ArrayBuffer).toString("ascii")).not.toContain(
      "thin-pack",
    );
  });

  it("refuses before retaining the byte that crosses the aggregate budget", async () => {
    const wire = sideband(Buffer.from("PACK"));
    const exact = advertisement.length + wire.length;
    const normal = githubPrLimits();
    const make = (max: number) =>
      createGithubPrTransport(
        { owner: "verified", repo: "docs" },
        {
          limits: { ...normal, acquisitionBytes: { ...normal.acquisitionBytes, value: max } },
          budget: { admittedBytes: 0 },
          deadlineAt: performance.now() + 10000,
          fetchPort: async (_url, init) =>
            answer(
              init.method === "GET" ? advertisement : wire,
              init.method === "GET"
                ? "application/x-git-upload-pack-advertisement"
                : "application/x-git-upload-pack-result",
            ),
        },
      );
    const at = make(exact);
    await at.discover();
    await expect(at.fetch({ wants: [SHA], filter: "tree:0" })).resolves.toMatchObject({
      pack: Buffer.from("PACK"),
    });
    const over = make(exact - 1);
    await over.discover();
    await expect(over.fetch({ wants: [SHA], filter: "tree:0" })).rejects.toMatchObject({
      code: normal.acquisitionBytes.refusal,
    });
  });

  it("accepts protocol-permitted non-binary pkt-lines without terminal LF", () => {
    expect(
      parseGithubPrAdvertisement(
        Buffer.concat([pkt("version 2"), pkt("fetch=shallow filter"), flush]),
      ),
    ).toMatchObject({ objectFormat: false });
    const response = parseGithubPrFetchResponse(
      Buffer.concat([pkt("packfile"), pkt(Buffer.from([1, 80, 65, 67, 75])), flush]),
    );
    expect(response.pack).toEqual(Buffer.from("PACK"));
  });

  it("rejects unsupported capabilities and SHA-256 without a request", () => {
    expect(
      errorCode(() =>
        parseGithubPrAdvertisement(
          Buffer.concat([pkt("version 2\n"), pkt("fetch=shallow\n"), flush]),
        ),
      ),
    ).toBe("github-pr-fetch-features-required");
    expect(
      errorCode(() =>
        parseGithubPrAdvertisement(
          Buffer.concat([
            pkt("version 2\n"),
            pkt("fetch=shallow filter\n"),
            pkt("object-format=sha256\n"),
            flush,
          ]),
        ),
      ),
    ).toBe("github-pr-object-format-unsupported");
  });

  it("rejects malformed, truncated and surplus protocol data", () => {
    expect(errorCode(() => decodeGithubPackets(Buffer.from("ffffx", "ascii")))).toBe(
      "github-pr-packet-length-invalid",
    );
    expect(errorCode(() => decodeGithubPackets(Buffer.from("000", "ascii")))).toBe(
      "github-pr-packet-truncated",
    );
    expect(errorCode(() => decodeGithubPackets(Buffer.from("0008ab", "ascii")))).toBe(
      "github-pr-packet-length-invalid",
    );
    expect(
      errorCode(() =>
        parseGithubPrFetchResponse(Buffer.concat([sideband(Buffer.from("PACK")), pkt("extra\n")])),
      ),
    ).toBe("github-pr-packfile-incomplete");
    expect(
      errorCode(() =>
        parseGithubPrFetchResponse(
          Buffer.concat([pkt("packfile\n"), pkt(Buffer.from([3, 88])), flush]),
        ),
      ),
    ).toBe("github-pr-sideband-error");
    expect(
      errorCode(() => parseGithubPrFetchResponse(Buffer.concat([pkt("packfile-uris\n"), flush]))),
    ).toBe("github-pr-packfile-section-required");
    expect(
      errorCode(() =>
        parseGithubPrFetchResponse(Buffer.concat([pkt("packfile\n"), pkt(Buffer.from([1, 80]))])),
      ),
    ).toBe("github-pr-packfile-incomplete");
  });

  it("refuses a redirect outside the fixed repository path", async () => {
    const transport = createGithubPrTransport(
      { owner: "verified", repo: "docs" },
      {
        limits: githubPrLimits(),
        budget: { admittedBytes: 0 },
        deadlineAt: performance.now() + 10000,
        fetchPort: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: "https://github.com/other/repo.git/info/refs?service=git-upload-pack",
            },
          }),
      },
    );
    await expect(transport.discover()).rejects.toMatchObject({
      code: "github-pr-redirect-out-of-scope",
    });
  });
});
