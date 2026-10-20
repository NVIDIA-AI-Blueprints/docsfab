#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model comparison matrix driver: models x corpus tasks x reps.
 *
 * The config names models, the provider route, the judge, and one or more
 * sealed corpora. Each corpus owns one task per workflow, with its
 * instruction and the paths it may change, so a config cannot quietly change
 * what a model is asked to do. Filter any axis from the CLI:
 *
 *   node run-matrix.mjs --config matrix.config.json
 *   node run-matrix.mjs --models "nvidia/nvidia/nemotron-3-super-v3"
 *   node run-matrix.mjs --workflows create-documentation,readiness --reps 3
 *   node run-matrix.mjs --dry-run          # print the cells, run nothing
 *
 * Results append to <output.root>/results.jsonl, one object per cell. The file
 * is the interface for judge.mjs and report.mjs; re-running resumes, skipping
 * cells already recorded there.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadCorpus, materializeCorpus } from "./corpus.mjs";
import { deliveryArgs } from "./delivery.mjs";
import {
  cellId,
  credential,
  credentialVariableName,
  endpointProbeLimits,
  loadConfig,
  providerForModel,
  releasedProvider,
  resolveIn,
  slug,
  validateProvider,
  writeProfile,
} from "./lib.mjs";
import { MatrixLimitRefusal, matrixLimit, resolvedMatrixLimits } from "./limits.mjs";
import { DEFAULT_PROMPTS, decideVerdict, probeOne } from "./probe-core.mjs";
import { createHash } from "node:crypto";
import { collectCellEvidence } from "./evidence.mjs";
import {
  isSourceCheckout,
  refreshCompiledLauncherIfStale,
} from "../../bin/source-checkout-refresh.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);
const list = (value) =>
  value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : null;

/**
 * The cell wall must outlast every single step attempt, so the runtime's own
 * coded attempt stop always lands before the harness kills the child.
 */
export function cellWallClock(environment = process.env) {
  const cell = matrixLimit("modelMatrix.cellTimeoutMs", environment);
  const attempt = Math.max(
    matrixLimit("compositionExecution.timeoutMs", environment).value,
    matrixLimit("execution.normalModeMaxElapsedMs", environment).value,
  );
  if (cell.value <= attempt) {
    throw new Error(
      `${cell.name} = ${cell.value} ms must exceed the longest step-attempt ceiling (${attempt} ms), ` +
        "or the harness would kill a run before the runtime records its own stop.",
    );
  }
  return cell;
}

/**
 * Run the CLI for one cell with `--json`. stdout is the run-result document
 * and goes to its own file; stderr is the human log. Neither is buffered in
 * memory, so no output size can truncate a result.
 */
const activeChildren = new Set();
const activeProcessGroups = new Set();
let interruptionSignal = null;

function signalCellProcess(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function signalProcessGroups(signal) {
  if (process.platform === "win32") {
    for (const child of activeChildren) signalCellProcess(child, signal);
    return;
  }
  for (const pid of activeProcessGroups) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

/** Stop children as a group and let active cells retain their terminal evidence. */
export function stopChildrenOnInterrupt() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (interruptionSignal) {
        signalProcessGroups("SIGKILL");
        return;
      }
      interruptionSignal = signal;
      signalProcessGroups("SIGKILL");
    });
  }
}

export function runCell({
  packageDir,
  cliEntry,
  env,
  args,
  resultPath,
  logPath,
  wallClock,
  scope,
}) {
  return new Promise((resolvePromise) => {
    const stdout = openSync(resultPath, "w");
    const stderr = openSync(logPath, "w");
    const started = Date.now();
    let timedOut = false;
    let settled = false;
    const child = spawn(process.execPath, [join(packageDir, cliEntry), ...args, "--json"], {
      cwd: packageDir,
      env,
      stdio: ["ignore", stdout, stderr],
      detached: process.platform !== "win32",
    });
    activeChildren.add(child);
    if (process.platform !== "win32" && child.pid) activeProcessGroups.add(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      signalCellProcess(child, "SIGKILL");
    }, wallClock.value);
    let spawnError = null;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      closeSync(stdout);
      closeSync(stderr);
      const durationMs = Date.now() - started;
      resolvePromise({
        exitCode,
        signal,
        durationMs,
        harnessFault: spawnError
          ? { code: "model-matrix-cell-spawn-failed", message: spawnError.message }
          : interruptionSignal
            ? {
                code: "model-matrix-interrupted",
                signal: interruptionSignal,
                message: `Matrix interrupted by ${interruptionSignal}; this active cell was stopped and retained.`,
              }
            : timedOut
              ? new MatrixLimitRefusal(wallClock, durationMs, scope).toJSON()
              : null,
      });
    };
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** The facts a cell row needs from the CLI's `docsfab-run-result` document. */
export function summarizeRunResult(result) {
  if (result?.kind !== "docsfab-run-result") return null;
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const failure =
    failures.find((entry) => entry.scope === "step") ??
    failures.find((entry) => entry.scope === "run") ??
    null;
  return {
    runId: result.execution?.runId ?? null,
    status: result.execution?.status ?? null,
    patchPath: result.execution?.patchPath ?? null,
    recordPath: result.execution?.recordPath ?? null,
    disposition: result.product?.disposition ?? null,
    failure: failure
      ? { stepId: failure.stepId ?? null, code: failure.code ?? null, class: failure.class ?? null }
      : null,
  };
}

async function readRawRunResult(path) {
  try {
    const result = JSON.parse(await readFile(path, "utf8"));
    return result?.kind === "docsfab-run-result" ? result : null;
  } catch {
    return null;
  }
}

async function readStoredRecord(run) {
  if (!run?.execution?.recordPath) return run;
  try {
    return JSON.parse(await readFile(run.execution.recordPath, "utf8"));
  } catch {
    return run;
  }
}

async function runtimeIdentity(packageDir) {
  let revision;
  let status;
  let diff;
  try {
    [revision, status, diff] = await Promise.all([
      git(packageDir, ["rev-parse", "HEAD"]),
      git(packageDir, ["status", "--porcelain=v1"]),
      git(packageDir, ["diff", "HEAD", "--binary"]),
    ]);
  } catch {
    return { revision: null, dirty: true, dirtySha256: null, identityUnavailable: true };
  }
  const [repoRoot, untrackedOutput] = await Promise.all([
    git(packageDir, ["rev-parse", "--show-toplevel"]),
    git(packageDir, ["ls-files", "--others", "--exclude-standard", "--full-name"]),
  ]);
  const untracked = untrackedOutput.split("\n").filter(Boolean);
  const untrackedHashes = await Promise.all(
    untracked.map(async (path) => {
      try {
        return [
          path,
          createHash("sha256")
            .update(await readFile(join(repoRoot.trim(), path)))
            .digest("hex"),
        ];
      } catch {
        return [path, "unreadable"];
      }
    }),
  );
  return {
    revision: revision.trim(),
    dirty: status.trim() !== "",
    dirtySha256:
      status.trim() === ""
        ? null
        : createHash("sha256").update(diff).update(JSON.stringify(untrackedHashes)).digest("hex"),
  };
}

function laneIdentity(cell) {
  return `${slug(cell.model)}__${slug(cell.providerId)}-${createHash("sha256")
    .update(
      JSON.stringify([
        cell.model,
        cell.providerId,
        cell.baseUrl,
        cell.apiFormat,
        cell.credentialEnv,
      ]),
    )
    .digest("hex")
    .slice(0, 12)}`;
}

async function acquireMatrixLock(root) {
  const lockPath = join(root, ".matrix.lock");
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        throw new Error(
          `Matrix output ${root} is locked by an unreadable .matrix.lock. Inspect it and remove it only if no matrix process is using this output.`,
        );
      }
      try {
        process.kill(owner.pid, 0);
        throw new Error(
          `Matrix output ${root} is already active under process ${owner.pid}; wait for it to finish or choose another output.root.`,
        );
      } catch (probeError) {
        if (probeError.code !== "ESRCH") throw probeError;
      }
      await rm(lockPath, { force: true });
    }
  }
}

/**
 * Why the CLI refused before a run existed. With `--json` the CLI prints a
 * `docsfab-operator-error` document on stderr; keep its code and message.
 */
export async function cliRefusal(path) {
  const text = await readFile(path, "utf8");
  const start = text.search(/^\{/mu);
  if (start >= 0) {
    try {
      const error = JSON.parse(text.slice(start));
      if (error?.kind === "docsfab-operator-error") {
        return {
          code: error.code ?? null,
          class: error.failure?.class ?? null,
          message: error.message ?? null,
        };
      }
    } catch {
      // Not a lone JSON document; fall through to the last line.
    }
  }
  const lines = text.split("\n").filter((line) => line.trim());
  return { code: null, class: null, message: lines.at(-1)?.trim() ?? null };
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

/**
 * Paths a patch changes, read with `git apply --numstat` (which applies
 * nothing). A run that changed nothing retains an empty patch.
 */
export async function patchPaths(sourceTree, patchPath) {
  if ((await readFile(patchPath, "utf8")).trim() === "") return [];
  const out = await git(sourceTree, ["apply", "--numstat", "-z", patchPath]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.split("\t").at(-1))
    .filter(Boolean)
    .sort();
}

/** The run must leave its input tree exactly as materialized. */
async function sourceTreeIntact(sourceTree, revision) {
  const [status, head] = await Promise.all([
    git(sourceTree, ["status", "--porcelain=v1"]),
    git(sourceTree, ["rev-parse", "HEAD"]),
  ]);
  return status.trim() === "" && head.trim() === revision;
}

export function buildCells(config, corpora, filters) {
  const selected = config.workflows ? config.workflows.map((workflow) => workflow.id) : null;
  const cells = [];
  for (const [modelIndex, model] of config.models.entries()) {
    if (filters.models && !filters.models.includes(model.id)) continue;
    for (const fixture of config.fixtures) {
      if (filters.fixtures && !filters.fixtures.includes(fixture.id)) continue;
      const corpus = corpora.get(fixture.id);
      for (const workflow of selected ?? []) {
        if (!corpus.tasks.tasks.some((task) => task.workflow === workflow)) {
          throw new Error(
            `Corpus ${corpus.manifest.id} has no task for configured workflow ${workflow}.`,
          );
        }
      }
      for (const task of corpus.tasks.tasks) {
        if (selected && !selected.includes(task.workflow)) continue;
        if (filters.workflows && !filters.workflows.includes(task.workflow)) continue;
        for (let rep = 1; rep <= (filters.reps ?? config.reps); rep += 1) {
          cells.push({
            model: model.id,
            modelIndex,
            family: model.family ?? null,
            composition: model.composition ?? null,
            workflow: task.workflow,
            task: task.id,
            fixture: fixture.id,
            corpusId: corpus.manifest.id,
            rep,
          });
        }
      }
    }
  }
  return cells;
}

export async function completedCells(resultsPath) {
  if (!existsSync(resultsPath)) return new Set();
  const text = await readFile(resultsPath, "utf8");
  const done = new Set();
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      done.add(cellId(JSON.parse(line)));
    } catch (error) {
      throw new Error(
        `${resultsPath} has malformed JSONL row ${index + 1} (${error.message}). The harness will not append past partial evidence; preserve this file and choose a fresh output.root or repair the row from its cell log.`,
      );
    }
  }
  return done;
}

/**
 * Run (or, with `dryRun`, list) the pending cells of one matrix config.
 * `environment` supplies the credential, limit overrides, and each cell's
 * inherited environment; `log` receives progress lines.
 */
export async function runMatrix({
  configPath,
  filters = {},
  dryRun = false,
  environment = process.env,
  log = (line) => process.stdout.write(line),
  runCellFn = runCell,
  probeFn = async (model, provider, options, prompts) => {
    const plain = await probeOne(model, provider, {}, prompts, options);
    const noThink = plain.reasoningSplit
      ? await probeOne(
          model,
          provider,
          { chat_template_kwargs: { thinking: false } },
          prompts,
          options,
        )
      : null;
    return { verdict: decideVerdict(plain, noThink), plain, noThink };
  },
}) {
  const config = await loadConfig(configPath);
  const wallClock = cellWallClock(environment);

  const corpora = new Map();
  for (const fixture of config.fixtures) corpora.set(fixture.id, await loadCorpus(fixture.corpus));

  let launcherPrepared = false;
  if (
    !dryRun &&
    config.runtime.cliEntry === "bin/docsfab.mjs" &&
    isSourceCheckout(config.runtime.packageDir)
  ) {
    await refreshCompiledLauncherIfStale(config.runtime.packageDir, {
      env: { ...environment, DOCSFAB_SKIP_AUTO_BUILD: undefined },
    });
    launcherPrepared = true;
  }

  // Dry-run only needs a stable path for display; it leaves the output tree untouched.
  let root = existsSync(config.output.root)
    ? realpathSync(config.output.root)
    : resolveIn(config.output.root);
  let resultsPath = join(root, "results.jsonl");

  const cells = buildCells(config, corpora, filters);
  const runtime = await runtimeIdentity(config.runtime.packageDir);
  const profileTemplate = await readFile(config.runtime.profileTemplate, "utf8");
  const profileTemplateSha256 = createHash("sha256").update(profileTemplate).digest("hex");
  const profileEnvNames = new Set([
    "MODEL_PROVIDER",
    "MODEL_BASE_URL",
    "MODEL_API_FORMAT",
    "MODEL_COMPATIBLE_API_FORMATS",
    "MODEL_ID",
    "MODEL_CONTEXT_WINDOW",
    "MODEL_MAX_INPUT_TOKENS",
    "MODEL_MAX_OUTPUT_TOKENS",
    ...profileTemplate
      .split("\n")
      .map((line) => /^([A-Z0-9_]+)=/u.exec(line)?.[1])
      .filter((name) => name?.startsWith("MODEL_")),
    ...Object.keys(config.limits ?? {}),
    ...Object.values(config.modelOverrides ?? {}).flatMap((entry) =>
      Object.keys(entry.extraEnv ?? {}),
    ),
    ...config.models.map((model) => providerForModel(config, model).credentialTarget),
  ]);
  const effectiveLimits = resolvedMatrixLimits(environment);
  const routedCells = cells.map((cell) => {
    const model = config.models[cell.modelIndex];
    const provider = validateProvider(providerForModel(config, model), model.id);
    for (const key of ["providerId", "baseUrl", "apiFormat", "credentialEnv", "credentialTarget"]) {
      if (typeof provider[key] !== "string" || provider[key].length === 0)
        throw new Error(
          `Model ${model.id} provider.${key} is required after provider defaults are merged.`,
        );
    }
    if (!dryRun) credential(provider.credentialEnv, environment);
    return {
      ...cell,
      providerId: provider.providerId,
      baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat,
      credentialEnv: provider.credentialEnv,
    };
  });
  const identities = new Set();
  for (const cell of routedCells) {
    const id = cellId(cell);
    if (identities.has(id))
      throw new Error(
        `Duplicate model matrix cell identity ${id}; give duplicate model routes distinct providerId or baseUrl values.`,
      );
    identities.add(id);
  }
  const limit = matrixLimit("modelMatrix.maxConcurrentModels", environment);
  const concurrency = config.execution?.sequential === true ? 1 : limit.value;
  const corpusBindings = [...corpora.entries()].map(([id, corpus]) => [
    id,
    corpus.manifest.manifestSha256,
  ]);
  const manifestBody = {
    schemaVersion: 1,
    config: config.name,
    runtime,
    corpusBindings,
    effectiveSettings: {
      configSha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
      profileTemplate: { path: config.runtime.profileTemplate, sha256: profileTemplateSha256 },
      limits: effectiveLimits,
      execution: {
        sequential: config.execution?.sequential === true,
        maxConcurrentModels: concurrency,
      },
      probeEnabled: config.probe?.enabled === true,
      resume: config.execution?.resume === true,
      filters,
      providers: [
        ...new Map(
          routedCells.map((cell) => [
            `${cell.providerId}|${cell.baseUrl}`,
            { providerId: cell.providerId, baseUrl: cell.baseUrl },
          ]),
        ).values(),
      ],
    },
    plannedCells: routedCells.map((cell) => ({ ...cell, id: cellId(cell) })),
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(manifestBody)).digest("hex");
  const manifest = { ...manifestBody, fingerprint };
  let manifestPath = join(root, "manifest.json");
  let releaseLock = null;
  if (!dryRun) {
    await mkdir(root, { recursive: true });
    root = realpathSync(root);
    resultsPath = join(root, "results.jsonl");
    manifestPath = join(root, "manifest.json");
    releaseLock = await acquireMatrixLock(root);
  }
  try {
    if (config.execution?.resume && existsSync(resultsPath)) {
      if (runtime.identityUnavailable) {
        throw new Error(
          `Cannot safely resume ${resultsPath}: runtime revision is unavailable at ${config.runtime.packageDir}. Choose a fresh output.root or run from a Git checkout.`,
        );
      }
      if (!existsSync(manifestPath)) {
        throw new Error(
          `Cannot safely resume ${resultsPath}: manifest.json is missing. Choose a fresh output.root so existing partial evidence stays intact.`,
        );
      }
      const previous = JSON.parse(await readFile(manifestPath, "utf8"));
      if (previous.fingerprint !== fingerprint) {
        throw new Error(
          `Cannot resume ${resultsPath}: runtime, config, corpus, filters, provider routes, or effective settings changed. Choose a fresh output.root; existing partial evidence is preserved.`,
        );
      }
    }
    if (!config.execution?.resume && existsSync(resultsPath)) {
      throw new Error(
        `Cannot start a new matrix over existing evidence at ${resultsPath}. Choose a fresh output.root to preserve the prior run.`,
      );
    }
    const done = config.execution?.resume ? await completedCells(resultsPath) : new Set();
    const pending = routedCells.filter((cell) => !done.has(cellId(cell)));

    log(`matrix ${config.name}: ${cells.length} cells, ${pending.length} pending\n`);
    if (dryRun) {
      for (const cell of pending) {
        log(`  ${cellId(cell)}  ${deliveryArgs(cell.workflow).args.join(" ") || "(read-only)"}\n`);
      }
      return resultsPath;
    }

    for (const dir of ["logs", "sources", "profiles", "run-results"])
      await mkdir(join(root, dir), { recursive: true });

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const lanes = new Map();
    for (const cell of pending) {
      const key = laneIdentity(cell);
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(cell);
    }
    let appendQueue = Promise.resolve();
    const finished = new Set();
    const appendRow = (row) => {
      if (row.model && row.task && row.fixture && row.rep) finished.add(cellId(row));
      appendQueue = appendQueue.then(() => appendFile(resultsPath, `${JSON.stringify(row)}\n`));
      return appendQueue;
    };
    const credentialValues = new Set(
      routedCells.map((cell) =>
        credential(
          providerForModel(config, config.models[cell.modelIndex]).credentialEnv,
          environment,
        ),
      ),
    );
    const prepareCell = async (cell) => {
      const id = cellId(cell);
      const corpus = corpora.get(cell.fixture);
      const task = corpus.tasks.tasks.find((candidate) => candidate.id === cell.task);
      const model = config.models[cell.modelIndex];
      const provider = providerForModel(config, model);
      const profileLimits = model.composition ? null : config.limits;
      const base = {
        ...cell,
        cellId: id,
        laneId: laneIdentity(cell),
        corpusManifestSha256: corpus.manifest.manifestSha256,
        mode: model.composition ? "composition" : "model-profile",
        profileLimits,
        runtime,
        runManifest: fingerprint,
      };
      try {
        const dir = resolveIn(root, "profiles", id);
        const extraEnv = config.modelOverrides?.[cell.model]?.extraEnv ?? {};
        for (const [name, value] of Object.entries(extraEnv)) {
          const textValue = String(value);
          if ([...credentialValues].some((secret) => textValue.includes(secret))) {
            throw new Error(
              `modelOverrides.extraEnv.${name} contains provider credential material; pass credentials through provider.credentialEnv only.`,
            );
          }
        }
        await writeProfile({
          templatePath: config.runtime.profileTemplate,
          targetDir: dir,
          provider,
          limits: profileLimits,
          model: cell.model,
          extraEnv,
        });
        const configRoot = dir;
        const { destination: sourceTree, revision } = await materializeCorpus(
          corpus,
          resolveIn(root, "sources", id),
          { force: true },
        );
        const delivery = deliveryArgs(task.workflow);
        const args = [
          "run",
          task.workflow,
          "--repo",
          sourceTree,
          "--revision",
          revision,
          ...(task.instruction ? ["--instruction", task.instruction] : []),
          ...delivery.args,
          ...(model.composition ? ["--composition", model.composition] : []),
        ];
        return {
          cell,
          id,
          corpus,
          task,
          model,
          provider,
          profileLimits,
          base,
          configRoot,
          sourceTree,
          revision,
          delivery,
          args,
        };
      } catch (error) {
        return {
          cell,
          id,
          base,
          preparationFault: {
            code: error.code ?? "model-matrix-prepare-failed",
            message: error.message,
          },
        };
      }
    };
    const prepared = new Map();
    for (const cell of pending) prepared.set(cellId(cell), await prepareCell(cell));
    const credentialNames = new Set(
      routedCells.flatMap((cell) => {
        const provider = providerForModel(config, config.models[cell.modelIndex]);
        return [provider.credentialEnv, provider.credentialTarget];
      }),
    );
    const runLane = async (laneId, laneCells) => {
      const first = laneCells
        .map((cell) => prepared.get(cellId(cell)))
        .find((entry) => entry && !entry.preparationFault);
      let probe = { status: config.probe?.enabled === false ? "disabled" : "pending" };
      if (config.probe?.enabled === true && first?.provider) {
        try {
          const probeProvider = releasedProvider(
            first.provider.baseUrl,
            first.provider.credentialEnv,
            environment,
          );
          const probed = await probeFn(
            first.cell.model,
            probeProvider,
            endpointProbeLimits(environment),
            config.probe?.prompts ?? DEFAULT_PROMPTS,
          );
          probe = { status: "complete", ...probed };
        } catch (error) {
          probe = {
            status: "error",
            error: { code: error.code ?? "model-matrix-probe-failed", message: error.message },
          };
        }
      }
      for (const cell of laneCells) {
        if (interruptionSignal) break;
        const item = prepared.get(cellId(cell));
        const index = pending.findIndex((candidate) => cellId(candidate) === item.id) + 1;
        log(`[${index}/${pending.length}] ${item.id} started\n`);
        if (item.preparationFault) {
          await appendRow({ ...item.base, probe, harnessFault: item.preparationFault });
          log(
            `[${index}/${pending.length}] ${item.id} completed: harness fault ${item.preparationFault.code}\n`,
          );
          continue;
        }
        try {
          const resultPath = join(root, "run-results", `${item.id}.json`);
          const logPath = join(root, "logs", `${item.id}.log`);
          const childEnv = Object.fromEntries(
            Object.entries(environment).filter(
              ([name]) =>
                !credentialNames.has(name) &&
                !credentialVariableName(name) &&
                !profileEnvNames.has(name),
            ),
          );
          childEnv[item.provider.credentialTarget] = credential(
            item.provider.credentialEnv,
            environment,
          );
          childEnv.DOCSFAB_CONFIG_ROOT = item.configRoot;
          childEnv.DOCSFAB_STATE_DIR = join(item.configRoot, ".docsfab", "runs");
          if (launcherPrepared) childEnv.DOCSFAB_SKIP_AUTO_BUILD = "1";
          const outcome = await runCellFn({
            packageDir: config.runtime.packageDir,
            cliEntry: config.runtime.cliEntry,
            env: childEnv,
            args: item.args,
            resultPath,
            logPath,
            wallClock,
            scope: `cell ${item.id}`,
          });

          const record = await readRawRunResult(resultPath);
          const storedRecord = await readStoredRecord(record);
          const run = summarizeRunResult(record);
          const intact = await sourceTreeIntact(item.sourceTree, item.revision);
          let changedPaths = [];
          let patchFault = null;
          if (run?.patchPath && existsSync(run.patchPath)) {
            try {
              changedPaths = await patchPaths(item.sourceTree, run.patchPath);
            } catch (error) {
              // A patch the harness cannot read is a harness fault for this cell,
              // never a reason to stop the matrix.
              patchFault = { code: "model-matrix-patch-unreadable", message: error.message };
            }
          }
          const harnessFault =
            outcome.harnessFault ??
            patchFault ??
            (intact
              ? null
              : {
                  code: "model-matrix-source-tree-changed",
                  message: `the run changed its input tree ${item.sourceTree}`,
                });
          const result = {
            ...item.base,
            revision: item.revision,
            delivery: item.delivery.args,
            writeClass: item.delivery.writeClass,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            durationMs: outcome.durationMs,
            ...(run ?? {
              runId: null,
              status: null,
              patchPath: null,
              recordPath: null,
              disposition: null,
              failure: null,
            }),
            cliRefusal: run ? null : await cliRefusal(logPath),
            runResultPath: run ? resultPath : null,
            logPath,
            sourceTree: item.sourceTree,
            changedPaths,
            boundaryViolations: changedPaths.filter(
              (path) => !item.task.permittedPaths.includes(path),
            ),
            harnessFault,
            probe,
          };
          result.cellEvidence = await collectCellEvidence({
            cell: result,
            record: storedRecord,
            runResult: record,
            recordPath: result.recordPath ?? null,
            manifest,
            plannedCell: result,
          });
          await appendRow(result);
          const summary = harnessFault
            ? `harness fault ${harnessFault.code}`
            : `${result.status ?? `cli-refused ${result.cliRefusal?.code ?? ""}`} (${Math.round(result.durationMs / 1000)}s)` +
              (result.failure
                ? ` :: ${result.failure.stepId ?? "run"} ${result.failure.code}`
                : "");
          log(`[${index}/${pending.length}] ${item.id} completed: ${summary}\n`);
        } catch (error) {
          const fault = { code: error.code ?? "model-matrix-cell-failed", message: error.message };
          await appendRow({ ...item.base, probe, harnessFault: fault });
          log(`[${index}/${pending.length}] ${item.id} completed: harness fault ${fault.code}\n`);
        }
      }
    };
    const laneEntries = [...lanes.entries()];
    let nextLane = 0;
    const workers = Array.from({ length: Math.min(concurrency, laneEntries.length) }, async () => {
      while (!interruptionSignal && nextLane < laneEntries.length) {
        const current = laneEntries[nextLane++];
        try {
          await runLane(current[0], current[1]);
        } catch (error) {
          for (const cell of current[1]) {
            const id = cellId(cell);
            if (!done.has(id) && !finished.has(id))
              await appendRow({
                ...cell,
                laneId: current[0],
                harnessFault: {
                  code: error.code ?? "model-matrix-lane-failed",
                  message: error.message,
                },
              });
          }
          log(`lane ${current[0]} failed: ${error.message}\n`);
        }
      }
    });
    await Promise.all(workers);
    await appendQueue;

    log(`\nresults: ${resultsPath}\n`);
    if (interruptionSignal) {
      log(
        `matrix interrupted by ${interruptionSignal}; completed rows and manifest are retained. ` +
          (config.execution?.resume
            ? "Rerun the same config to resume pending cells.\n"
            : "Choose a fresh output.root for a new run.\n"),
      );
    }
    return resultsPath;
  } finally {
    await releaseLock?.();
  }
}

async function main() {
  stopChildrenOnInterrupt();
  await runMatrix({
    configPath: arg("config", join(HERE, "matrix.config.json")),
    filters: {
      models: list(arg("models", null)),
      workflows: list(arg("workflows", null)),
      fixtures: list(arg("fixtures", null)),
      reps: arg("reps", null) ? Number(arg("reps", null)) : null,
    },
    dryRun: flag("dry-run"),
  });
  if (interruptionSignal) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
