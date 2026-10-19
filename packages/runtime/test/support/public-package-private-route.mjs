// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Qualify an actual public installation using an operator-supplied private endpoint.
// This helper owns a fresh child environment and never calls a real model or catalog.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { findPackageJSON, syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const PROFILE = "nvidia-inference-gpt-6-sol-pi";
const COMPOSITION_SHA256 = "57058a1095d955a7e20e3fc1a759b94cf81b228188b2e964e408a8551a7ee44a";
const DEPLOYMENT_SHA256 = "0918664a7485ec0cac594e00ee03ddff80ae340213d859135e348ae3119369f9";

async function probe(packageDirectory, endpoint, scratch) {
  assert.equal(process.env.DOCSFAB_TEST_PRIVATE_ROUTE_BASE_URL, undefined);
  assert.equal(process.permission.has("child"), false);
  assert.equal(process.permission.has("worker"), false);
  let networkPermission = "unsupported";
  try {
    networkPermission = process.permission.has("net");
  } catch {
    // Older supported Node releases still have the transport observers below.
  }
  const attempts = [];
  const deny = (name) => () => {
    attempts.push(name);
    throw new Error(`Offline package qualification denied ${name}`);
  };
  globalThis.fetch = deny("fetch");
  for (const [name, methods] of [
    ["http", ["request", "get"]],
    ["https", ["request", "get"]],
    ["http2", ["connect"]],
    ["net", ["connect", "createConnection"]],
    ["tls", ["connect"]],
  ]) {
    const module = (await import(`node:${name}`)).default;
    for (const method of methods) module[method] = deny(`${name}.${method}`);
  }
  const net = (await import("node:net")).default;
  net.Socket.prototype.connect = deny("net.Socket.connect");
  (await import("node:dgram")).default.Socket.prototype.send = deny("dgram.Socket.send");
  (await import("node:dns")).default.lookup = deny("dns.lookup");
  syncBuiltinESMExports();
  assert.throws(
    () => globalThis.fetch("https://network-control.invalid"),
    /Offline package qualification denied/u,
  );
  assert.throws(
    () => net.connect({ host: "network-control.invalid" }),
    /Offline package qualification denied/u,
  );
  assert.deepEqual(attempts, ["fetch", "net.connect"]);
  attempts.length = 0;

  const load = (path) => import(pathToFileURL(join(packageDirectory, "dist", path)).href);
  const routes = await load("config/executable-route-urls.js");
  assert.equal(Object.hasOwn(routes.EXECUTABLE_ROUTE_BASE_URLS, "nvidia-inference-api"), false);
  assert(routes.isExecutableRouteOrigin("nvidia-inference-api", new URL(endpoint).origin));
  assert.equal(
    routes.isExecutableRouteOrigin("nvidia-inference-api", "https://elsewhere.example.test"),
    false,
  );
  const { defaultExecutionHostConfig } = await load("config/profile-projection.js");
  const { loadConfig } = await load("config/runtime-loader.js");
  const { resolveOperatorExecutionBinding } = await load("model/operator-execution-binding.js");
  const { loadInstalledModelCompositionAuthority, assertInstalledDeploymentBaseUrl } = await load(
    "model-composition/installed.js",
  );
  const { releaseModelCredential, credentialForRequest } = await load(
    "security/model-credential-release.js",
  );
  const { createProviderConnectionFactory } = await load("model/provider.js");
  const { discoverNvidiaInferenceModelCatalog } = await load("model/nvidia-inference-catalog.js");
  const { createDocsFabResourceLoader, repositoryVirtualCwd } = await load("harness/pi-session.js");
  const { createLiveAgentPiSession } = await load("live-agent/host.js");
  const { persistLocalContinuation, restoreLocalContinuation } = await load(
    "live-agent/local-continuation.js",
  );
  const piManifest = findPackageJSON(
    "@earendil-works/pi-coding-agent",
    pathToFileURL(join(packageDirectory, "package.json")),
  );
  assert(piManifest);
  const { SessionManager } = await import(
    pathToFileURL(join(dirname(piManifest), "dist/index.js")).href
  );

  const configurationRoot = join(scratch, "configuration");
  const repositoryPath = join(scratch, "repository");
  const sessionDirectory = join(scratch, "sessions");
  const agentDir = join(scratch, "agent");
  for (const directory of [configurationRoot, repositoryPath, sessionDirectory, agentDir])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const host = defaultExecutionHostConfig(PROFILE);
  writeFileSync(
    join(configurationRoot, "host.yaml"),
    JSON.stringify({
      ...host,
      active: {
        ...host.active,
        writing: { ...host.active.writing, settings: { baseUrl: endpoint } },
      },
    }),
  );
  const environment = {
    DOCSFAB_CONFIG_ROOT: configurationRoot,
    MODEL_API_KEY: `nvapi-${"Q".repeat(24)}`,
  };
  const config = loadConfig({ ...environment });
  const binding = await resolveOperatorExecutionBinding({ model: config.model, environment });
  assert.equal(binding.match, "installed-composition");
  assert.equal(binding.bound.composition.compositionId, PROFILE);
  assert.equal(binding.bound.composition.compositionSha256, COMPOSITION_SHA256);
  assert.equal(binding.bound.composition.deployment.identitySha256, DEPLOYMENT_SHA256);
  assert.equal(config.model.modelId, "azure/openai/gpt-6-sol");
  assert.equal(config.model.baseUrl, endpoint);
  const { authority } = await loadInstalledModelCompositionAuthority();
  assertInstalledDeploymentBaseUrl({ authority, compositionId: PROFILE, baseUrl: endpoint });
  assert.throws(
    () =>
      assertInstalledDeploymentBaseUrl({
        authority,
        compositionId: PROFILE,
        baseUrl: "https://elsewhere.example.test/v1",
      }),
    { code: "deployment-binding-mismatch" },
  );
  assert.throws(
    () =>
      releaseModelCredential(
        { endpoint, endpointSource: "untrusted:repository", apiKey: environment.MODEL_API_KEY },
        "model-connection",
      ),
    { code: "credential-endpoint-untrusted" },
  );
  const released = releaseModelCredential(
    { endpoint, endpointSource: config.model.endpointSource, apiKey: environment.MODEL_API_KEY },
    "model-connection",
  );
  assert.throws(
    () => credentialForRequest(released, "https://elsewhere.example.test/v1/chat/completions"),
    { code: "credential-endpoint-untrusted" },
  );

  let catalogRequests = 0;
  await discoverNvidiaInferenceModelCatalog({
    config: config.model,
    purpose: "policy",
    fetch: async (url) => {
      assert.equal(String(url), `${endpoint}/models`);
      catalogRequests += 1;
      const response = new Response(
        JSON.stringify({ object: "list", data: [{ id: config.model.modelId }] }),
        {
          headers: { "content-type": "application/json" },
        },
      );
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    },
  });
  assert.equal(catalogRequests, 1);

  let providerRequests = 0;
  const factory = createProviderConnectionFactory({
    routeId: binding.profile.routeId,
    transport: binding.profile.transport,
    fetch: async (url, options) => {
      assert.equal(String(url), `${endpoint}/chat/completions`);
      assert.equal(JSON.parse(options.body).model, config.model.modelId);
      providerRequests += 1;
      const chunk = (delta, finish_reason) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: config.model.modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk({ role: "assistant", content: "Synthetic continuation response." }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const loader = createDocsFabResourceLoader({ repositoryPath, agentDir, mode: "live-agent" });
  await loader.reload();
  const open = async (sessionManager, selectedBinding) => {
    const connection = await factory.create({
      profile: selectedBinding.profile,
      credential: selectedBinding.credential,
    });
    return createLiveAgentPiSession({
      repositoryPath,
      modelRuntime: connection.runtime,
      model: connection.model,
      resourceLoader: loader,
      sessionManager,
      host: { tools: [], excludeTools: ["bash"], customTools: [] },
    });
  };
  const manager = SessionManager.create(repositoryVirtualCwd(repositoryPath), sessionDirectory);
  const first = await open(manager, binding);
  try {
    await first.prompt("Return the synthetic fixture response.");
    persistLocalContinuation(
      manager,
      repositoryPath,
      { operatorMessages: ["Continue the saved fixture workflow."] },
      { schema_version: 1, entries: [] },
      "synthetic-saved-run",
    );
  } finally {
    first.dispose();
  }
  const file = manager.getSessionFile();
  assert(file);
  const restoredManager = SessionManager.open(file);
  const continuation = restoreLocalContinuation(restoredManager, repositoryPath);
  assert.equal(continuation.pending_first_pass_run_id, "synthetic-saved-run");
  assert.deepEqual(continuation.continuation.operatorMessages, [
    "Continue the saved fixture workflow.",
  ]);
  const reloaded = await resolveOperatorExecutionBinding({
    model: loadConfig({ ...environment }).model,
    environment,
  });
  assert.equal(
    reloaded.bound.composition.compositionSha256,
    binding.bound.composition.compositionSha256,
  );
  assert.equal(
    reloaded.bound.composition.deployment.identitySha256,
    binding.bound.composition.deployment.identitySha256,
  );
  const second = await open(restoredManager, reloaded);
  try {
    await second.prompt("Continue using the synthetic fixture response.");
  } finally {
    second.dispose();
  }
  assert.equal(providerRequests, 2);
  assert.equal(attempts.length, 0);
  const metadata = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  return {
    status: "PASS",
    packageVersion: metadata.version,
    privateDefaultPresent: false,
    testFixtureEnvironmentPresent: false,
    compositionId: PROFILE,
    compositionSha256: COMPOSITION_SHA256,
    deploymentIdentitySha256: DEPLOYMENT_SHA256,
    persistedOperatorConfiguration: true,
    syntheticCatalogRequests: catalogRequests,
    syntheticProviderRequests: providerRequests,
    restoredLocalContinuation: true,
    networkPermission,
    subprocessPermission: false,
    workerPermission: false,
    outboundAttempts: attempts,
    continuationScope:
      "DocsFab local continuation locator and persisted Pi session; workflow checkpoint suites remain separate",
  };
}

if (process.argv[2] === "--probe") {
  console.log(
    JSON.stringify(
      await probe(resolve(process.argv[3]), process.argv[4], resolve(process.argv[5])),
    ),
  );
} else {
  const argumentsByName = new Map();
  for (let index = 2; index < process.argv.length; index += 2)
    argumentsByName.set(process.argv[index], process.argv[index + 1]);
  for (const name of ["--package-dir", "--endpoint", "--scratch"])
    assert(argumentsByName.get(name), `Required: ${name}`);
  const packageDirectory = resolve(argumentsByName.get("--package-dir"));
  const dependencyManifest = findPackageJSON(
    "@earendil-works/pi-coding-agent",
    pathToFileURL(join(packageDirectory, "package.json")),
  );
  assert(dependencyManifest);
  const dependencyRoot = dirname(dirname(dirname(realpathSync(dependencyManifest))));
  const scratchParent = resolve(argumentsByName.get("--scratch"));
  mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(scratchParent, "qualification-"));
  for (const directory of [scratch, join(scratch, "home"), join(scratch, "tmp")])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const serviceEnvironment = join(scratch, "service.env");
  writeFileSync(serviceEnvironment, "");
  const child = spawnSync(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${dirname(dirname(packageDirectory))}`,
      `--allow-fs-read=${dependencyRoot}`,
      `--allow-fs-read=${script}`,
      `--allow-fs-read=${scratch}`,
      `--allow-fs-write=${scratch}`,
      script,
      "--probe",
      packageDirectory,
      argumentsByName.get("--endpoint"),
      scratch,
    ],
    {
      cwd: scratch,
      encoding: "utf8",
      env: {
        PATH: dirname(process.execPath),
        HOME: join(scratch, "home"),
        TMPDIR: join(scratch, "tmp"),
        DOCSFAB_SERVICE_ENV_FILE: serviceEnvironment,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  console.log(child.stdout.trim());
}
