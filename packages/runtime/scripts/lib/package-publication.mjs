// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const governedLimits = JSON.parse(
  readFileSync(new URL("../../../../config/limits.catalog.json", import.meta.url), "utf8"),
).limits;
const archiveLimit = governedLimits?.["publishPackage.registryArchiveBytes"];
const downloadTimeout = governedLimits?.["publishPackage.registryArchiveDownloadTimeoutMs"];
const redirectLimit = governedLimits?.["publishPackage.registryArchiveRedirects"];
const channelTimeout = governedLimits?.["publishPackage.channelReadbackTimeoutMs"];
const metadataOutputLimit = governedLimits?.["publishPackage.commandOutputBytes"];
if (
  !Number.isSafeInteger(archiveLimit?.value) ||
  archiveLimit.value <= 0 ||
  archiveLimit.unit !== "bytes" ||
  archiveLimit.override !== null ||
  archiveLimit.refusal !== "publish-package-registry-archive-bound"
) {
  throw new Error("invalid governed exact-version archive bound");
}
if (
  !Number.isSafeInteger(downloadTimeout?.value) ||
  downloadTimeout.value <= 0 ||
  downloadTimeout.unit !== "milliseconds" ||
  downloadTimeout.override !== null ||
  downloadTimeout.refusal !== "publish-package-registry-archive-download-timeout"
) {
  throw new Error("invalid governed exact-version archive download timeout");
}
if (
  !Number.isSafeInteger(redirectLimit?.value) ||
  redirectLimit.value < 0 ||
  redirectLimit.unit !== "redirects" ||
  redirectLimit.override !== null ||
  redirectLimit.refusal !== "publish-package-registry-archive-redirect-bound"
) {
  throw new Error("invalid governed exact-version archive redirect bound");
}
if (
  !Number.isSafeInteger(channelTimeout?.value) ||
  channelTimeout.value <= 0 ||
  channelTimeout.unit !== "milliseconds" ||
  channelTimeout.override !== null ||
  channelTimeout.refusal !== "publish-package-channel-readback-timeout-bound" ||
  !Number.isSafeInteger(metadataOutputLimit?.value) ||
  metadataOutputLimit.value <= 0 ||
  metadataOutputLimit.unit !== "bytes" ||
  metadataOutputLimit.override !== null ||
  metadataOutputLimit.refusal !== "publish-package-command-output-bytes-bound"
) {
  throw new Error("invalid governed channel metadata readback bounds");
}

const GITLAB_PROJECT_NPM_PATH = /^\/api\/v4\/projects\/\d+\/packages\/npm\/$/u;
const PACKAGE_VERSION_PATH = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function projectRegistryUrl(registry) {
  let url;
  try {
    url = new URL(registry);
  } catch {
    return null;
  }
  return url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    GITLAB_PROJECT_NPM_PATH.test(url.pathname)
    ? url
    : null;
}

function directArchiveUrl({ name, version, registry }) {
  const base = projectRegistryUrl(registry);
  if (!base || name !== "docsfab" || !PACKAGE_VERSION_PATH.test(version)) return null;
  return new URL(
    `${encodeURIComponent(name)}/-/${encodeURIComponent(name)}-${encodeURIComponent(version)}.tgz`,
    base,
  ).href;
}

const READBACK_FAILURE_CLASSES = new Set([
  "authorization",
  "download",
  "malformed",
  "network",
  "output_bound",
  "size_bound",
  "timeout",
  "unknown",
]);
const ownedArchiveBoundErrors = new WeakSet();

function failureClass(error) {
  if (READBACK_FAILURE_CLASSES.has(error?.reasonClass)) return error.reasonClass;
  if (error instanceof SyntaxError || error?.reasonClass === "malformed") return "malformed";
  if (typeof error?.code === "string" && /output-bytes-bound$/u.test(error.code))
    return "output_bound";
  const diagnostic = `${error?.code ?? ""} ${error?.stderr ?? ""}`;
  if (/E401|E403|unauthorized|forbidden/iu.test(diagnostic)) return "authorization";
  if (/ETIMEDOUT|timed? out/iu.test(diagnostic)) return "timeout";
  if (/ECONN|ENOTFOUND|EAI_AGAIN|network/iu.test(diagnostic)) return "network";
  return "unknown";
}

function readbackError(reasonClass, message) {
  const error = new Error(message);
  error.reasonClass = READBACK_FAILURE_CLASSES.has(reasonClass) ? reasonClass : "unknown";
  return error;
}

function archiveSizeBoundError(observedBytes, maxBytes) {
  const error = readbackError(
    "size_bound",
    `${archiveLimit.refusal}: exact-version registry archive byte limit exceeded; observed ${observedBytes} bytes, maximum ${maxBytes} bytes; scope=registry archive. Inspect the exact registry version before retrying and keep candidate archives within the governed limit.`,
  );
  error.diagnosticCode = archiveLimit.refusal;
  ownedArchiveBoundErrors.add(error);
  return error;
}

function channelOutputBoundError(observedBytes) {
  const error = readbackError(
    "output_bound",
    `${metadataOutputLimit.refusal}: dist-tag response exceeds governed byte bound; observed=${observedBytes}, maximum=${metadataOutputLimit.value}, scope=project dist-tag response. Inspect the registry response before retrying or raise publishPackage.commandOutputBytes through a reviewed limits change.`,
  );
  error.diagnosticCode = metadataOutputLimit.refusal;
  return error;
}

/** Read the archive bytes for one exact immutable package version. */
export async function readVersionArchive({
  name,
  version,
  registry,
  env,
  run,
  destination,
  runWithOutputBound,
  fetchImpl = globalThis.fetch,
  freshOnline = false,
  metadataTimeoutMs,
  allowDirectArchiveFallback = false,
}) {
  let result;
  let tarballUrl;
  let readbackSource;
  try {
    result = await runWithOutputBound(
      run,
      "npm",
      [
        "view",
        `${name}@${version}`,
        "dist.tarball",
        "--json",
        "--registry",
        registry,
        ...(freshOnline ? ["--prefer-online"] : []),
      ],
      { env, ...(metadataTimeoutMs ? { timeout: metadataTimeoutMs } : {}) },
      "npm exact-version tarball metadata readback",
    );
  } catch (error) {
    const reasonClass = failureClass(error);
    if (
      reasonClass === "unknown" &&
      typeof error?.stderr === "string" &&
      /E404|404 Not Found/u.test(error.stderr)
    ) {
      tarballUrl = allowDirectArchiveFallback
        ? directArchiveUrl({ name, version, registry })
        : null;
      if (!tarballUrl) return null;
      readbackSource = "direct-archive-after-metadata-404";
    } else {
      throw readbackError(
        reasonClass,
        `version-bytes-unknown: registry archive metadata readback failed for exact version ${name}@${version}; inspect the registry before retrying.`,
      );
    }
  }
  if (!readbackSource) {
    try {
      tarballUrl = JSON.parse(result.stdout);
      if (typeof tarballUrl !== "string") throw new Error("invalid tarball URL");
    } catch {
      throw readbackError(
        "malformed",
        `version-bytes-unknown: registry archive URL was malformed for exact version ${name}@${version}.`,
      );
    }
  }
  const filename = `docsfab-${version}.tgz`;
  const archivePath = join(destination, filename);
  let downloaded;
  try {
    downloaded = await downloadBoundedArchive({
      url: tarballUrl,
      registry,
      token: env.DOCSFAB_NPM_PUBLISH_TOKEN || env.CI_JOB_TOKEN,
      destination: archivePath,
      fetchImpl,
    });
  } catch (error) {
    if (ownedArchiveBoundErrors.has(error)) throw error;
    throw readbackError(
      error?.reasonClass ?? "download",
      `version-bytes-unknown: registry archive download failed for exact version ${name}@${version}; inspect the registry before retrying.`,
    );
  }
  if (downloaded === null) return null;
  const fileInfo = await stat(archivePath);
  if (!fileInfo.isFile()) {
    await rm(archivePath, { force: true });
    throw readbackError(
      "download",
      `version-bytes-unknown: registry archive was not a regular file for exact version ${name}@${version}.`,
    );
  }
  if (fileInfo.size > archiveLimit.value) {
    await rm(archivePath, { force: true });
    throw archiveSizeBoundError(fileInfo.size, archiveLimit.value);
  }
  let bytes;
  try {
    bytes = await readFile(archivePath);
  } catch {
    throw readbackError(
      "download",
      `version-bytes-unknown: registry archive bytes are unavailable for exact version ${name}@${version}.`,
    );
  }
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return {
    bytes,
    integrity,
    size: bytes.byteLength,
    path: join(destination, filename),
    ...(readbackSource ? { readbackSource } : {}),
  };
}

/** Download into a private temporary file, stopping before a response can exceed its byte cap. */
export async function downloadBoundedArchive({
  url,
  registry,
  token,
  destination,
  fetchImpl = globalThis.fetch,
  maxBytes = archiveLimit.value,
  timeoutMs = downloadTimeout.value,
  maxRedirects = redirectLimit.value,
}) {
  const registryUrl = new URL(registry);
  let currentUrl;
  try {
    currentUrl = new URL(url);
  } catch {
    throw readbackError("malformed", "version-bytes-unknown: registry tarball URL was malformed.");
  }
  if (registryUrl.protocol !== "https:" || !isRegistryScoped(currentUrl, registryUrl)) {
    throw readbackError(
      "malformed",
      "version-bytes-unknown: registry tarball URL is outside the configured project registry.",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let handle;
  let response;
  let completed = false;
  try {
    handle = await open(destination, "wx", 0o600);
    ({ response, url: currentUrl } = await fetchArchiveResponse({
      url: currentUrl,
      registryUrl,
      token,
      fetchImpl,
      signal: controller.signal,
      maxRedirects,
    }));
    if (response.status === 404) {
      await cancelResponseBody(response);
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      await cancelResponseBody(response);
      throw readbackError("authorization", "registry archive download authorization failed");
    }
    if (!response.ok || !response.body) {
      await cancelResponseBody(response);
      throw readbackError("download", "registry archive download returned no usable body");
    }
    const size = await writeBoundedResponseBody(response, handle, maxBytes);
    completed = true;
    return { size };
  } catch (error) {
    if (controller.signal.aborted)
      throw readbackError("timeout", "registry archive download timed out");
    if (error?.reasonClass) throw error;
    throw readbackError("download", "registry archive download failed");
  } finally {
    if (!completed) {
      controller.abort();
      await cancelResponseBody(response);
    }
    clearTimeout(timeout);
    await handle?.close();
    if (!completed) await rm(destination, { force: true });
  }
}

/** Read project dist-tags independently of GitLab's asynchronously rebuilt npm packument. */
export async function readDedicatedChannelTags({
  name,
  registry,
  env,
  fetchImpl = globalThis.fetch,
  timeoutMs = channelTimeout.value,
}) {
  const base = projectRegistryUrl(registry);
  if (!base || name !== "docsfab") {
    throw readbackError("malformed", "channel-readback-unknown: project npm registry is invalid");
  }
  const token = env.DOCSFAB_NPM_PUBLISH_TOKEN || env.CI_JOB_TOKEN;
  if (!token)
    throw readbackError("authorization", "channel-readback-unknown: registry token is unavailable");
  const url = new URL(`-/package/${encodeURIComponent(name)}/dist-tags`, base);
  const controller = new AbortController();
  let timer;
  let response;
  let bodyComplete = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(readbackError("timeout", "channel-readback-unknown: dist-tag request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        try {
          response = await fetchImpl(url, {
            method: "GET",
            headers: { authorization: `Bearer ${token}`, "accept-encoding": "identity" },
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted)
            throw readbackError("timeout", "channel-readback-unknown: dist-tag request timed out");
          if (READBACK_FAILURE_CLASSES.has(error?.reasonClass)) throw error;
          throw readbackError("network", "channel-readback-unknown: dist-tag request failed");
        }
        if (response.status === 401 || response.status === 403)
          throw readbackError("authorization", "channel-readback-unknown: dist-tag request denied");
        if (response.status >= 300 && response.status < 400)
          throw readbackError("malformed", "channel-readback-unknown: dist-tag redirect refused");
        if (!response.ok || !response.body)
          throw readbackError("network", "channel-readback-unknown: dist-tag response unavailable");
        const declaredLength = response.headers.get("content-length");
        if (declaredLength !== null && !/^\d+$/u.test(declaredLength))
          throw readbackError("malformed", "channel-readback-unknown: dist-tag length malformed");
        if (declaredLength !== null && Number(declaredLength) > metadataOutputLimit.value)
          throw channelOutputBoundError(declaredLength);
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > metadataOutputLimit.value) throw channelOutputBoundError(size);
            chunks.push(value);
          }
          bodyComplete = true;
        } catch (error) {
          if (error?.reasonClass) throw error;
          if (controller.signal.aborted)
            throw readbackError("timeout", "channel-readback-unknown: dist-tag response timed out");
          throw readbackError("network", "channel-readback-unknown: dist-tag response failed");
        } finally {
          if (size > metadataOutputLimit.value) await reader.cancel();
          reader.releaseLock();
        }
        let tags;
        try {
          tags = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
        } catch {
          throw readbackError("malformed", "channel-readback-unknown: dist-tag JSON malformed");
        }
        if (!tags || typeof tags !== "object" || Array.isArray(tags))
          throw readbackError("malformed", "channel-readback-unknown: dist-tag map malformed");
        return tags;
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    if (!bodyComplete) await cancelResponseBody(response);
  }
}

function isRegistryScoped(url, registryUrl) {
  return (
    url.protocol === "https:" &&
    url.origin === registryUrl.origin &&
    url.pathname.startsWith(registryUrl.pathname) &&
    !url.username &&
    !url.password
  );
}

async function fetchArchiveResponse({ url, registryUrl, token, fetchImpl, signal, maxRedirects }) {
  let currentUrl = url;
  for (let redirects = 0; ; redirects += 1) {
    const headers = { "accept-encoding": "identity" };
    if (isRegistryScoped(currentUrl, registryUrl)) headers.authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
      });
    } catch {
      if (signal.aborted) throw readbackError("timeout", "registry archive download timed out");
      throw readbackError("network", "registry archive download failed");
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: currentUrl };
    const location = response.headers.get("location");
    await cancelResponseBody(response);
    if (!location || redirects >= maxRedirects) {
      throw readbackError(
        "malformed",
        "registry archive redirect was malformed or exceeded its governed bound",
      );
    }
    try {
      currentUrl = new URL(location, currentUrl);
    } catch {
      throw readbackError("malformed", "registry archive redirect was malformed");
    }
    if (currentUrl.protocol !== "https:" || currentUrl.username || currentUrl.password) {
      throw readbackError("malformed", "registry archive redirect was not an HTTPS URL");
    }
  }
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // The outer download owns cleanup; an already-closed response needs no retry.
  }
}

async function writeBoundedResponseBody(response, handle, maxBytes) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && !/^\d+$/u.test(declaredLength)) {
    await cancelResponseBody(response);
    throw readbackError("malformed", "registry archive content length was malformed");
  }
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    await cancelResponseBody(response);
    throw archiveSizeBoundError(Number(declaredLength), maxBytes);
  }
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return size;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw archiveSizeBoundError(size, maxBytes);
      }
      for (let offset = 0; offset < value.byteLength; ) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        offset += bytesWritten;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Read one unambiguous registry dist-tag map; auth, malformed, and unknown stay errors. */
export async function readChannelMap({ name, registry, env, fetchImpl, context }) {
  try {
    return await readDedicatedChannelTags({ name, registry, env, fetchImpl });
  } catch (error) {
    if (error?.reasonClass === "output_bound") throw error;
    throw readbackError(
      failureClass(error),
      `channel-readback-unknown: ${context}; release owner must inspect ${name} dist-tags before retrying or changing tags.`,
    );
  }
}

/** Persist a secret-free receipt binding source, final package bytes, upload, and promotion state. */
export async function writePublicationReceipt(artifactRoot, receipt) {
  await writeFile(
    join(artifactRoot, "publication-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

export async function readPublicationReceipt(artifactRoot) {
  try {
    return JSON.parse(await readFile(join(artifactRoot, "publication-receipt.json"), "utf8"));
  } catch {
    return undefined;
  }
}
