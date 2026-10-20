// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Vitest only: the cases use `it.each`, which `node --test` does not provide.
import { afterEach, describe, expect, it } from "vitest";

import {
  CODES,
  NAMED_EXCEPTIONS,
  main,
  scanCredentialSenders,
} from "./check-credential-senders.mjs";
import { loadLimitDefinitions } from "./check-limits.mjs";

// The real-tree case reads every runtime source file.
const FULL_SCAN_CASE = Object.freeze({
  timeout: loadLimitDefinitions().find((entry) => entry.name === "test.ciTimeoutMs").value,
});

const scriptPath = fileURLToPath(new URL("./check-credential-senders.mjs", import.meta.url));
const metadataException = NAMED_EXCEPTIONS.find(
  ({ path }) => path === "src/model/inference-hub-metadata.ts",
);
const exec = promisify(execFile);
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A package root whose `src/` holds the given files. */
async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-credential-senders-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const lines = (...text) => [...text, ""].join("\n");

const RAW_BEARER = lines(
  "export async function lookup(config: { apiKey: string }, url: string) {",
  "  return fetch(url, { headers: { authorization: `Bearer ${config.apiKey}` } });",
  "}",
);

/** The excepted Metadata API sender, as `inference-hub-metadata.ts` writes it. */
const METADATA_SENDER = lines(
  "export async function boundedPageRequest(url, input) {",
  "  const headers = {};",
  '  headers["x-api-key"] = input.credential;',
  "  return headers;",
  "}",
);

function unreleased(path, line, sender, within) {
  return `${CODES.unreleased}: ${path}:${line} ${sender} in ${within} puts a model key on a request without credentialForRequest(); release it with releaseModelCredential() for the configured endpoint.`;
}

describe("check-credential-senders", () => {
  it(
    "passes the checked-in runtime and sees each model-key sender as released",
    FULL_SCAN_CASE,
    () => {
      const { senders, findings } = scanCredentialSenders();

      expect(findings).toEqual([]);
      expect(
        senders.filter((entry) => entry.released).map((entry) => `${entry.path} ${entry.sender}`),
      ).toEqual(
        expect.arrayContaining([
          "src/model/provider.ts pi-runtime-key",
          "src/profile/probe-core.js bearer-header",
          "src/model/nvidia-inference-catalog.ts bearer-header",
          "src/model/openai-api-catalog.ts bearer-header",
          "src/model/anthropic-api-catalog.ts x-api-key-header",
        ]),
      );
      const excepted = senders.filter((entry) => !entry.released);
      expect(excepted).toHaveLength(NAMED_EXCEPTIONS.length);
      expect(excepted).toEqual(
        expect.arrayContaining(
          NAMED_EXCEPTIONS.map((exception) =>
            expect.objectContaining({
              path: exception.path,
              sender: exception.sender,
              within: exception.within,
              key: exception.key,
            }),
          ),
        ),
      );
    },
  );

  it.each([
    ["a raw Bearer header", "src/model/lookup.ts", RAW_BEARER, 2, "bearer-header", "lookup"],
    [
      "a raw Pi runtime key",
      "src/model/connect.ts",
      lines(
        "export async function connect(runtime, apiKey) {",
        "  await runtime.setRuntimeApiKey(",
        '    "provider",',
        "    apiKey,",
        "  );",
        "}",
      ),
      2,
      "pi-runtime-key",
      "connect",
    ],
    [
      "a raw x-api-key header",
      "src/profile/catalog.js",
      lines(
        "export function headers(key) {",
        "  const headers = {};",
        '  headers["x-api-key"] = key;',
        "  return headers;",
        "}",
      ),
      3,
      "x-api-key-header",
      "headers",
    ],
    [
      "a constant that is not a released key",
      "src/profile/probe.js",
      lines(
        "export function post(config) {",
        "  const apiKey = config.apiKey;",
        "  return { Authorization: `Bearer ${apiKey}` };",
        "}",
      ),
      3,
      "bearer-header",
      "post",
    ],
    [
      "a raw constant in the sender's function, though another function releases the name",
      "src/profile/shadow.js",
      lines(
        "export function a(credential, url) {",
        "  const apiKey = credentialForRequest(credential, url);",
        "  return apiKey;",
        "}",
        "export function b(config) {",
        "  const apiKey = config.apiKey;",
        "  return { Authorization: `Bearer ${apiKey}` };",
        "}",
      ),
      7,
      "bearer-header",
      "b",
    ],
    [
      "a raw parameter, though a helper earlier in the file releases the same name",
      "src/profile/helper.js",
      lines(
        "export function helper(credential, url) {",
        "  const apiKey = credentialForRequest(credential, url);",
        "  return apiKey;",
        "}",
        "export function send(apiKey, url) {",
        "  return fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });",
        "}",
      ),
      6,
      "bearer-header",
      "send",
    ],
    [
      "a callback parameter that shadows a released constant",
      "src/profile/callback.js",
      lines(
        "export function send(credential, url) {",
        "  const apiKey = credentialForRequest(credential, url);",
        "  return [url].map((apiKey) => ({ Authorization: `Bearer ${apiKey}` }));",
        "}",
      ),
      3,
      "bearer-header",
      "send",
    ],
    [
      "a released constant from an outer function",
      "src/profile/closure.js",
      lines(
        "export function outer(credential, url) {",
        "  const apiKey = credentialForRequest(credential, url);",
        "  return function inner() {",
        "    return { Authorization: `Bearer ${apiKey}` };",
        "  };",
        "}",
      ),
      4,
      "bearer-header",
      "inner",
    ],
    [
      "a released constant in a sibling block",
      "src/profile/block.js",
      lines(
        "export function send(credential, url) {",
        "  {",
        "    const apiKey = credentialForRequest(credential, url);",
        "    void apiKey;",
        "  }",
        "  return { Authorization: `Bearer ${apiKey}` };",
        "}",
      ),
      6,
      "bearer-header",
      "send",
    ],
    [
      "a released value in a let, which can be reassigned",
      "src/profile/reassigned.js",
      lines(
        "export function send(credential, url) {",
        "  let apiKey = credentialForRequest(credential, url);",
        "  return { Authorization: `Bearer ${apiKey}` };",
        "}",
      ),
      3,
      "bearer-header",
      "send",
    ],
    [
      "a released constant declared after the sender",
      "src/profile/later.js",
      lines(
        "export function send(credential, url) {",
        "  const headers = { Authorization: `Bearer ${apiKey}` };",
        "  const apiKey = credentialForRequest(credential, url);",
        "  return headers;",
        "}",
      ),
      2,
      "bearer-header",
      "send",
    ],
    [
      "a raw bearer header in another letter case",
      "src/profile/lowercase.js",
      lines(
        "export function lookup(config, url) {",
        "  return fetch(url, { headers: { authorization: `bearer ${config.apiKey}` } });",
        "}",
      ),
      2,
      "bearer-header",
      "lookup",
    ],
    [
      "a key from a call other than credentialForRequest()",
      "src/profile/reader.js",
      lines(
        "export function lookup(url) {",
        "  return fetch(url, { headers: { Authorization: `Bearer ${readKey()}` } });",
        "}",
      ),
      2,
      "bearer-header",
      "lookup",
    ],
    [
      "a raw x-api-key header named in another letter case",
      "src/profile/mixed.js",
      lines("export function headers(config) {", '  return { "X-Api-Key": config.apiKey };', "}"),
      2,
      "x-api-key-header",
      "headers",
    ],
    [
      "a raw sender after an inline block comment",
      "src/profile/commented.js",
      lines(
        "export function lookup(config, url) {",
        "  /* x */ return fetch(url, { headers: { authorization: `Bearer ${config.apiKey}` } });",
        "}",
      ),
      2,
      "bearer-header",
      "lookup",
    ],
  ])(
    "refuses %s, naming the file, line, and function",
    async (_label, path, text, line, sender, within) => {
      const root = await fixture({ [path]: text });

      const { findings } = scanCredentialSenders({ packageRoot: root, exceptions: [] });

      expect(findings).toEqual([unreleased(path, line, sender, within)]);
    },
  );

  it("admits a key read inline, or through a released constant in the sender's own function", async () => {
    const root = await fixture({
      "src/inline.ts": lines(
        "export const h = (c, u) => ({",
        "  authorization: `Bearer ${credentialForRequest(c, u)}`,",
        '  "x-api-key": (credentialForRequest(c, u) as string),',
        "});",
      ),
      "src/constant.js": lines(
        "export function post(config, credential, url) {",
        "  const apiKey = config.apiKey;",
        "  void apiKey;",
        "}",
        "export function send(credential, url) {",
        "  const apiKey = credentialForRequest(credential, url);",
        "  return { Authorization: `Bearer ${apiKey}` };",
        "}",
      ),
      "src/enclosing.js": lines(
        "export async function post(credential, url, send) {",
        "  const apiKey = credentialForRequest(credential, url);",
        "  try {",
        "    return await send(url, { headers: { Authorization: `Bearer ${apiKey}` } });",
        "  } catch {",
        "    return undefined;",
        "  }",
        "}",
      ),
      "src/pi.ts": lines(
        "await runtime.setRuntimeApiKey(",
        "  id,",
        "  credentialForRequest(released, providerRequestUrl(base, transport)),",
        ");",
      ),
      "src/notes.ts": lines(
        "// A comment that shows `Bearer ${apiKey}` sends nothing.",
        "/**",
        " * runtime.setRuntimeApiKey(id, apiKey) in a doc comment sends nothing.",
        " */",
        'export const text = "Bearer ${apiKey} in a plain string sends nothing";',
      ),
      "src/sender.test.ts": RAW_BEARER,
      "src/sender.d.ts": RAW_BEARER,
    });

    const { senders, findings } = scanCredentialSenders({ packageRoot: root, exceptions: [] });

    expect(findings).toEqual([]);
    expect(senders.map((entry) => `${entry.path}:${entry.line} ${entry.sender}`)).toEqual([
      "src/constant.js:7 bearer-header",
      "src/enclosing.js:4 bearer-header",
      "src/inline.ts:2 bearer-header",
      "src/inline.ts:3 x-api-key-header",
      "src/pi.ts:1 pi-runtime-key",
    ]);
  });

  it("keeps a named exception only while it matches its one unreleased sender", async () => {
    const exception = {
      path: "src/model/lookup.ts",
      sender: "bearer-header",
      within: "lookup",
      key: "config.apiKey",
      reason: "fixture",
    };
    const raw = await fixture({ "src/model/lookup.ts": RAW_BEARER });
    expect(scanCredentialSenders({ packageRoot: raw, exceptions: [exception] }).findings).toEqual(
      [],
    );

    const released = await fixture({
      "src/model/lookup.ts":
        "export const lookup = (c, u) => ({ authorization: `Bearer ${credentialForRequest(c, u)}` });\n",
    });
    expect(
      scanCredentialSenders({ packageRoot: released, exceptions: [exception] }).findings,
    ).toEqual([
      `${CODES.staleException}: src/model/lookup.ts has no unreleased bearer-header in lookup sending config.apiKey; remove its exception.`,
    ]);
  });

  it("matches an exception by its key expression with whitespace normalized", async () => {
    const exception = {
      path: "src/model/metadata.ts",
      sender: "x-api-key-header",
      within: "boundedPageRequest",
      key: "metadataKey( input, )",
      reason: "fixture",
    };
    const root = await fixture({
      "src/model/metadata.ts": lines(
        "export async function boundedPageRequest(url, input) {",
        "  const headers = {};",
        '  headers["x-api-key"] = metadataKey(',
        "    input,",
        "  );",
        "  return headers;",
        "}",
      ),
    });

    expect(scanCredentialSenders({ packageRoot: root, exceptions: [exception] }).findings).toEqual(
      [],
    );
  });

  it("refuses a second raw sender in an excepted file", async () => {
    const root = await fixture({
      "src/model/inference-hub-metadata.ts": lines(
        METADATA_SENDER,
        "export function modelHeaders(model) {",
        '  return { "x-api-key": model.apiKey };',
        "}",
      ),
    });

    const { findings } = scanCredentialSenders({
      packageRoot: root,
      exceptions: [metadataException],
    });

    expect(findings).toEqual([
      unreleased("src/model/inference-hub-metadata.ts", 8, "x-api-key-header", "modelHeaders"),
    ]);
  });

  it("refuses an exception that matches more than one sender", async () => {
    const root = await fixture({
      "src/model/inference-hub-metadata.ts": lines(
        "export async function boundedPageRequest(url, input) {",
        "  const first = {};",
        '  first["x-api-key"] = input.credential;',
        "  const second = {};",
        '  second["x-api-key"] = input.credential;',
        "  return [first, second];",
        "}",
      ),
    });

    const { findings } = scanCredentialSenders({
      packageRoot: root,
      exceptions: [metadataException],
    });

    expect(findings).toEqual([
      unreleased(
        "src/model/inference-hub-metadata.ts",
        3,
        "x-api-key-header",
        "boundedPageRequest",
      ),
      unreleased(
        "src/model/inference-hub-metadata.ts",
        5,
        "x-api-key-header",
        "boundedPageRequest",
      ),
      `${CODES.ambiguousException}: the exception for src/model/inference-hub-metadata.ts x-api-key-header in boundedPageRequest sending input.credential matches 2 senders; each exception names exactly one.`,
    ]);
  });

  it("refuses a run that names no --check or an unknown argument", () => {
    expect(main([])).toMatchObject({ status: 2 });
    expect(main([]).stderr).toContain("nothing was checked");
    expect(main(["--check", "--bogus"]).stderr).toContain(CODES.usage);
    expect(main(["--check", "--root"])).toMatchObject({ status: 2 });
  });

  it("exits 0, 1, and 2 from the shipped CLI, directly and through a symlink", async () => {
    const failing = await fixture({ "src/model/lookup.ts": RAW_BEARER });
    const passing = await fixture({
      "src/cli/review-delivery-auth.ts": await readFile(
        new URL("../src/cli/review-delivery-auth.ts", import.meta.url),
        "utf8",
      ),
      "src/model/inference-hub-metadata.ts": METADATA_SENDER,
    });
    const linked = join(failing, "check-linked.mjs");
    await symlink(scriptPath, linked);
    for (const entry of [scriptPath, linked]) {
      const failed = await exec(process.execPath, [entry, "--check", "--root", failing]).then(
        () => ({ code: 0, stderr: "" }),
        (error) => ({ code: error.code, stderr: error.stderr }),
      );
      expect({ entry, code: failed.code }).toEqual({ entry, code: 1 });
      expect(failed.stderr).toContain(
        `${CODES.unreleased}: src/model/lookup.ts:2 bearer-header in lookup`,
      );

      const { stdout } = await exec(process.execPath, [entry, "--check", "--root", passing]);
      expect(stdout).toBe(
        "OK: 0 model-key senders read a released key; 3 named exception sender(s).\n",
      );

      const refused = await exec(process.execPath, [entry]).then(
        () => ({ code: 0, stderr: "" }),
        (error) => ({ code: error.code, stderr: error.stderr }),
      );
      expect({ entry, code: refused.code }).toEqual({ entry, code: 2 });
      expect(refused.stderr).toContain(CODES.usage);
    }
    // Importing through the symlink with another entry point stays inert.
    const { stdout } = await exec(process.execPath, [
      "--input-type=module",
      "-e",
      `process.argv[1] = ${JSON.stringify(join(failing, "other.mjs"))}; await import(${JSON.stringify(pathToFileURL(linked).href)}); console.log("imported");`,
    ]);
    expect(stdout.trim()).toBe("imported");
  });
});
