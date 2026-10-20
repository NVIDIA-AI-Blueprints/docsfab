// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** A deliberately narrow, anonymous Git smart-HTTP v2 upload-pack receiver. */
import {
  limit,
  refuseLimit,
  type ResolveLimitsOptions,
  type ResolvedLimit,
} from "../../config/limits.js";

const GITHUB_ORIGIN = "https://github.com";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Git protocol-common §pkt-line: at most 65,516 payload bytes plus four length bytes.
// https://git-scm.com/docs/protocol-common#_pkt_line_format
const PKT_LINE_PROTOCOL_SIZE = 65520;
const SHA1 = /^[0-9a-f]{40}$/u;
const REPO_PART = /^(?!\.)(?!.*\.\.)(?!.*\.git$)[A-Za-z0-9_.-]+$/u;

export class GithubPrTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GithubPrTransportError";
  }
}

function invalid(code: string): never {
  throw new GithubPrTransportError(code);
}

export interface GithubPrLimits {
  readonly acquisitionBytes: ResolvedLimit;
  readonly packInflatedBytes: ResolvedLimit;
  readonly objectMaterializedBytes: ResolvedLimit;
  readonly objects: ResolvedLimit;
  readonly historyCommits: ResolvedLimit;
  readonly acquisitionTimeoutMs: ResolvedLimit;
  readonly requestTimeoutMs: ResolvedLimit;
  readonly redirects: ResolvedLimit;
  readonly changedFiles: ResolvedLimit;
  readonly proposalCommits: ResolvedLimit;
}

export function githubPrLimits(options?: ResolveLimitsOptions): GithubPrLimits {
  return {
    acquisitionBytes: limit("changeSourcesGithub.acquisitionMaxBytes", options),
    packInflatedBytes: limit("changeSourcesGithub.packInflatedMaxBytes", options),
    objectMaterializedBytes: limit("changeSourcesGithub.objectMaterializedMaxBytes", options),
    objects: limit("changeSourcesGithub.objectsMax", options),
    historyCommits: limit("changeSourcesGithub.historyCommitsMax", options),
    acquisitionTimeoutMs: limit("changeSourcesGithub.acquisitionTimeoutMs", options),
    requestTimeoutMs: limit("changeSourcesGithub.requestTimeoutMs", options),
    redirects: limit("changeSourcesGithub.redirectsMax", options),
    changedFiles: limit("changeSources.changedFilesMax", options),
    proposalCommits: limit("changeSources.commitsMax", options),
  };
}

export interface GithubPrRepositoryScope {
  readonly owner: string;
  readonly repo: string;
}

/** Mutable only within the host-owned acquisition; shared by target and fork transports. */
export interface GithubPrTransportBudget {
  admittedBytes: number;
}

export interface GithubPrFetchRequest {
  readonly wants: readonly string[];
  readonly filter: "tree:0" | "blob:none" | null;
  readonly deepen?: number;
  readonly shallow?: readonly string[];
}

export interface GithubPrFetchResult {
  readonly pack: Buffer;
  readonly shallow: readonly string[];
  readonly unshallow: readonly string[];
}

export type GithubPrFetchPort = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubPrTransport {
  readonly discover: () => Promise<void>;
  readonly fetch: (request: GithubPrFetchRequest) => Promise<GithubPrFetchResult>;
  readonly responseBytes: () => number;
}

function pkt(value: string): Buffer {
  const body = Buffer.from(value, "ascii");
  const length = body.length + 4;
  if (length > PKT_LINE_PROTOCOL_SIZE) invalid("github-pr-request-packet-invalid");
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, "0"), "ascii"), body]);
}

export function encodeGithubPrFetch(request: GithubPrFetchRequest, objectFormat: boolean): Buffer {
  if (request.wants.length === 0 || !request.wants.every((id) => SHA1.test(id))) {
    invalid("github-pr-want-invalid");
  }
  if (request.shallow?.some((id) => !SHA1.test(id))) invalid("github-pr-shallow-invalid");
  if (
    request.deepen !== undefined &&
    (!Number.isSafeInteger(request.deepen) || request.deepen < 1)
  ) {
    invalid("github-pr-depth-invalid");
  }
  const args = [pkt("command=fetch\n")];
  if (objectFormat) args.push(pkt("object-format=sha1\n"));
  args.push(Buffer.from("0001", "ascii"));
  for (const id of new Set(request.wants)) args.push(pkt(`want ${id}\n`));
  for (const id of new Set(request.shallow ?? [])) args.push(pkt(`shallow ${id}\n`));
  args.push(pkt("ofs-delta\n"), pkt("no-progress\n"));
  if (request.filter !== null) args.push(pkt(`filter ${request.filter}\n`));
  if (request.deepen !== undefined) args.push(pkt(`deepen ${request.deepen}\n`));
  args.push(pkt("done\n"), Buffer.from("0000", "ascii"));
  return Buffer.concat(args);
}

type Packet =
  | { readonly kind: "data"; readonly payload: Buffer }
  | { readonly kind: "flush" | "delim" | "end" };

/** Decode only a complete admitted body. Packet framing may have arrived in any network chunks. */
export function decodeGithubPackets(body: Buffer): readonly Packet[] {
  const packets: Packet[] = [];
  let at = 0;
  while (at < body.length) {
    if (at + 4 > body.length) invalid("github-pr-packet-truncated");
    const hex = body.toString("ascii", at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/u.test(hex)) invalid("github-pr-packet-length-invalid");
    const length = Number.parseInt(hex, 16);
    at += 4;
    if (length < 4) {
      const kind = length === 0 ? "flush" : length === 1 ? "delim" : length === 2 ? "end" : null;
      if (kind === null) invalid("github-pr-packet-length-invalid");
      packets.push({ kind });
      continue;
    }
    if (length > PKT_LINE_PROTOCOL_SIZE || at + length - 4 > body.length) {
      invalid("github-pr-packet-length-invalid");
    }
    packets.push({ kind: "data", payload: body.subarray(at, at + length - 4) });
    at += length - 4;
  }
  return packets;
}

function asciiLine(packet: Packet): string {
  if (packet.kind !== "data") invalid("github-pr-response-section-invalid");
  const bytes = packet.payload;
  const end = bytes[bytes.length - 1] === 10 ? bytes.length - 1 : bytes.length;
  if (end < 1 || bytes.subarray(0, end).some((byte) => byte < 32 || byte > 126)) {
    invalid("github-pr-response-line-invalid");
  }
  return bytes.toString("ascii", 0, end);
}

export function parseGithubPrAdvertisement(body: Buffer): { readonly objectFormat: boolean } {
  const packets = decodeGithubPackets(body);
  let at = 0;
  // Some HTTP backends prepend the v1 service banner; it must be exact if present.
  if (packets[at]?.kind === "data" && asciiLine(packets[at]!) === "# service=git-upload-pack") {
    if (packets[++at]?.kind !== "flush") invalid("github-pr-advertisement-invalid");
    at += 1;
  }
  if (packets[at]?.kind !== "data" || asciiLine(packets[at]!) !== "version 2") {
    invalid("github-pr-protocol-v2-required");
  }
  at += 1;
  let fetchFeatures: Set<string> | undefined;
  let objectFormat = false;
  for (; at < packets.length && packets[at]?.kind === "data"; at += 1) {
    const line = asciiLine(packets[at]!);
    if (line.startsWith("fetch=")) fetchFeatures = new Set(line.slice(6).split(" "));
    if (line.startsWith("object-format=")) {
      if (line !== "object-format=sha1") invalid("github-pr-object-format-unsupported");
      objectFormat = true;
    }
  }
  if (packets[at]?.kind !== "flush" || at !== packets.length - 1) {
    invalid("github-pr-advertisement-invalid");
  }
  if (!fetchFeatures?.has("filter") || !fetchFeatures.has("shallow")) {
    invalid("github-pr-fetch-features-required");
  }
  return { objectFormat };
}

/** Only the supported sections of a single done-terminated fetch are accepted. */
export function parseGithubPrFetchResponse(body: Buffer): GithubPrFetchResult {
  const packets = decodeGithubPackets(body);
  let at = 0;
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (packets[at]?.kind === "data" && asciiLine(packets[at]!) === "shallow-info") {
    at += 1;
    while (packets[at]?.kind === "data") {
      const payload = (packets[at] as { payload: Buffer }).payload;
      // Native upload-pack omits LF on shallow IDs, while the protocol text describes LF.
      const lineBytes = payload[payload.length - 1] === 10 ? payload.subarray(0, -1) : payload;
      if (lineBytes.some((byte) => byte < 32 || byte > 126))
        invalid("github-pr-shallow-response-invalid");
      const match = /^(shallow|unshallow) ([0-9a-f]{40})$/u.exec(lineBytes.toString("ascii"));
      if (!match) invalid("github-pr-shallow-response-invalid");
      (match[1] === "shallow" ? shallow : unshallow).push(match[2]!);
      at += 1;
    }
    if (packets[at]?.kind !== "delim") invalid("github-pr-response-section-invalid");
    at += 1;
  }
  if (packets[at]?.kind !== "data" || asciiLine(packets[at]!) !== "packfile") {
    invalid("github-pr-packfile-section-required");
  }
  at += 1;
  const chunks: Buffer[] = [];
  let packLength = 0;
  while (packets[at]?.kind === "data") {
    const payload = (packets[at] as { payload: Buffer }).payload;
    const channel = payload[0];
    if (channel === 3) invalid("github-pr-sideband-error");
    if (channel !== 1 && channel !== 2) invalid("github-pr-sideband-invalid");
    if (channel === 1) {
      if (payload.length < 2) invalid("github-pr-sideband-invalid");
      chunks.push(payload.subarray(1));
      packLength += payload.length - 1;
    }
    at += 1;
  }
  if (packLength === 0 || packets[at]?.kind !== "flush" || at !== packets.length - 1) {
    invalid("github-pr-packfile-incomplete");
  }
  return { pack: Buffer.concat(chunks, packLength), shallow, unshallow };
}

/** `scope` is constructed by trusted host code from independently verified repository facts. */
export function createGithubPrTransport(
  scope: GithubPrRepositoryScope,
  options: {
    readonly limits: GithubPrLimits;
    readonly budget: GithubPrTransportBudget;
    readonly signal?: AbortSignal;
    readonly deadlineAt: number;
    /** Test-only host injection. The URL remains fixed to github.com in production. */
    readonly fetchPort?: GithubPrFetchPort;
  },
): GithubPrTransport {
  if (!REPO_PART.test(scope.owner) || !REPO_PART.test(scope.repo)) {
    invalid("github-pr-repository-scope-invalid");
  }
  const base = `${GITHUB_ORIGIN}/${scope.owner}/${scope.repo}.git`;
  const fetchPort =
    options.fetchPort ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
  let advertisement: { readonly objectFormat: boolean } | undefined;

  async function request(path: string, method: "GET" | "POST", data?: Buffer): Promise<Buffer> {
    const endpoint = `${base}/${path}`;
    let target = endpoint;
    for (let redirects = 0; ; redirects += 1) {
      const remaining = options.deadlineAt - performance.now();
      if (options.signal?.aborted) invalid("github-pr-cancelled");
      if (remaining <= 0)
        refuseLimit(
          options.limits.acquisitionTimeoutMs,
          Math.ceil(options.limits.acquisitionTimeoutMs.value - remaining),
        );
      const timeout = AbortSignal.timeout(
        Math.max(1, Math.floor(Math.min(remaining, options.limits.requestTimeoutMs.value))),
      );
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      let response: Response;
      try {
        response = await fetchPort(target, {
          method,
          headers: {
            Accept:
              method === "GET"
                ? "application/x-git-upload-pack-advertisement"
                : "application/x-git-upload-pack-result",
            "Content-Type":
              method === "POST"
                ? "application/x-git-upload-pack-request"
                : "application/x-git-upload-pack-advertisement",
            "Git-Protocol": "version=2",
            "User-Agent": "docsfab-github-pr-object-reader",
            "Accept-Encoding": "identity",
          },
          body: data === undefined ? undefined : Uint8Array.from(data).buffer,
          credentials: "omit",
          redirect: "manual",
          signal,
        });
      } catch {
        if (options.signal?.aborted) invalid("github-pr-cancelled");
        if (timeout.aborted && options.deadlineAt <= performance.now()) {
          refuseLimit(
            options.limits.acquisitionTimeoutMs,
            Math.ceil(
              performance.now() - (options.deadlineAt - options.limits.acquisitionTimeoutMs.value),
            ),
          );
        }
        if (timeout.aborted)
          refuseLimit(options.limits.requestTimeoutMs, options.limits.requestTimeoutMs.value + 1);
        invalid("github-pr-unreachable");
      }
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (location === null || !URL.canParse(location, target))
          invalid("github-pr-redirect-invalid");
        const next = new URL(location, target);
        if (next.origin !== GITHUB_ORIGIN || next.href !== endpoint) {
          invalid("github-pr-redirect-out-of-scope");
        }
        if (redirects >= options.limits.redirects.value) {
          refuseLimit(options.limits.redirects, redirects + 1);
        }
        target = next.href;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        invalid("github-pr-http-refused");
      }
      const expected =
        method === "GET"
          ? "application/x-git-upload-pack-advertisement"
          : "application/x-git-upload-pack-result";
      if (response.headers.get("content-type")?.split(";")[0]?.trim() !== expected) {
        await response.body?.cancel();
        invalid("github-pr-content-type-invalid");
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && /^\d+$/u.test(declared)) {
        const count = Number(declared);
        if (
          !Number.isSafeInteger(count) ||
          options.budget.admittedBytes + count > options.limits.acquisitionBytes.value
        ) {
          await response.body?.cancel();
          refuseLimit(options.limits.acquisitionBytes, options.budget.admittedBytes + count);
        }
      }
      if (response.body === null) invalid("github-pr-response-incomplete");
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const next = options.budget.admittedBytes + value.byteLength;
          if (!Number.isSafeInteger(next) || next > options.limits.acquisitionBytes.value) {
            await reader.cancel();
            refuseLimit(options.limits.acquisitionBytes, next);
          }
          options.budget.admittedBytes = next;
          size += value.byteLength;
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        if (signal.aborted) {
          if (options.signal?.aborted) invalid("github-pr-cancelled");
          if (options.deadlineAt <= performance.now())
            refuseLimit(
              options.limits.acquisitionTimeoutMs,
              options.limits.acquisitionTimeoutMs.value + 1,
            );
          refuseLimit(options.limits.requestTimeoutMs, options.limits.requestTimeoutMs.value + 1);
        }
        throw error;
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    }
  }

  return {
    async discover() {
      advertisement = parseGithubPrAdvertisement(
        await request("info/refs?service=git-upload-pack", "GET"),
      );
    },
    async fetch(fetchRequest) {
      if (advertisement === undefined) invalid("github-pr-discovery-required");
      const payload = encodeGithubPrFetch(fetchRequest, advertisement.objectFormat);
      return parseGithubPrFetchResponse(await request("git-upload-pack", "POST", payload));
    },
    responseBytes: () => options.budget.admittedBytes,
  };
}
