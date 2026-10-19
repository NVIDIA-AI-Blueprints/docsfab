#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate and verify DocsFab environment-admission mirrors from
 * config/env-admission.yaml.
 *
 * Usage:
 *   node scripts/check-env-admission.mjs
 *   node scripts/check-env-admission.mjs --check
 *   node scripts/check-env-admission.mjs --check --committed-only
 *   node scripts/check-env-admission.mjs --print-mirror-paths   (lists every mirror it writes)
 *
 * `--committed-only` checks the mirrors that stay committed and names the
 * build-generated code mirrors it leaves to the shared generation step
 * (`scripts/ensure-derived.mjs`), which runs after this check.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));

/**
 * Prefer the npm `yaml` parser. `runtime:derived:preflight` runs this checker
 * before `npm ci`, so a missing module falls back to the constrained subset
 * parser below instead of failing the job closed.
 */
export function loadYamlParse() {
  try {
    return require("yaml").parse;
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

/**
 * Parse the constrained `config/env-admission.yaml` shape without the npm
 * `yaml` package: comments, plain scalars, block lists, nested mappings, and
 * folded `>-` descriptions. Used by `runtime:derived:preflight` before
 * `npm ci`. Quoted, literal, and flow syntax are refused.
 */
export function parseEnvAdmissionYamlSubset(text) {
  if (text.includes("\t")) {
    throw new Error("config/env-admission.yaml: tabs are not in the preflight subset");
  }
  const lines = text.split(/\r?\n/u);
  const parsed = parseMapping(lines, 0, 0);
  if (parsed.next < lines.length && nextSignificant(lines, parsed.next) !== null) {
    throw new Error(
      `config/env-admission.yaml: unsupported trailing syntax at line ${parsed.next + 1}`,
    );
  }
  return parsed.value;
}

function nextSignificant(lines, index) {
  for (let cursor = index; cursor < lines.length; cursor += 1) {
    const trimmed = lines[cursor].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return cursor;
  }
  return null;
}

function lineIndent(raw) {
  return raw.length - raw.trimStart().length;
}

function splitKeyValue(trimmed, line) {
  const match = /^([A-Za-z][A-Za-z0-9_]*):(?:\s+(.*))?$/u.exec(trimmed);
  if (!match) {
    throw new Error(`config/env-admission.yaml: expected key: value at line ${line}`);
  }
  const value = match[2] ?? "";
  return { key: match[1], value, hasValue: value.length > 0 };
}

function decodeScalar(raw, line) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/u.test(raw)) return Number(raw);
  if (
    raw.startsWith("|") ||
    raw.startsWith(">") ||
    raw.startsWith("'") ||
    raw.startsWith('"') ||
    raw.startsWith("[") ||
    raw.startsWith("{") ||
    raw.startsWith("&") ||
    raw.startsWith("*") ||
    raw.startsWith("!")
  ) {
    throw new Error(`config/env-admission.yaml: unsupported scalar at line ${line}`);
  }
  return raw;
}

function parseMapping(lines, start, indent) {
  const mapping = {};
  let index = start;
  while (index < lines.length) {
    const significant = nextSignificant(lines, index);
    if (significant === null) return { value: mapping, next: lines.length };
    const raw = lines[significant];
    const currentIndent = lineIndent(raw);
    if (currentIndent < indent) return { value: mapping, next: significant };
    if (currentIndent !== indent) {
      throw new Error(`config/env-admission.yaml: unexpected indent at line ${significant + 1}`);
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith("- ")) {
      throw new Error(`config/env-admission.yaml: unexpected list item at line ${significant + 1}`);
    }
    const { key, value, hasValue } = splitKeyValue(trimmed, significant + 1);
    if (hasValue && (value === ">" || value === ">-" || value === "|" || value === "|-")) {
      const block = parseBlockScalar(lines, significant + 1, indent, value);
      mapping[key] = block.value;
      index = block.next;
      continue;
    }
    if (!hasValue) {
      const nestedAt = nextSignificant(lines, significant + 1);
      if (nestedAt === null) {
        throw new Error(
          `config/env-admission.yaml: missing value for ${key} at line ${significant + 1}`,
        );
      }
      const nested = lines[nestedAt];
      const nestedIndent = lineIndent(nested);
      if (nestedIndent <= indent) {
        throw new Error(
          `config/env-admission.yaml: missing value for ${key} at line ${significant + 1}`,
        );
      }
      if (nested.trim().startsWith("- ")) {
        const list = parseList(lines, nestedAt, nestedIndent);
        mapping[key] = list.value;
        index = list.next;
      } else {
        const child = parseMapping(lines, nestedAt, nestedIndent);
        mapping[key] = child.value;
        index = child.next;
      }
      continue;
    }
    mapping[key] = decodeScalar(value, significant + 1);
    index = significant + 1;
  }
  return { value: mapping, next: index };
}

function parseList(lines, start, indent) {
  const list = [];
  let index = start;
  while (index < lines.length) {
    const significant = nextSignificant(lines, index);
    if (significant === null) return { value: list, next: lines.length };
    const raw = lines[significant];
    const currentIndent = lineIndent(raw);
    if (currentIndent < indent) return { value: list, next: significant };
    if (currentIndent !== indent) {
      throw new Error(`config/env-admission.yaml: unexpected indent at line ${significant + 1}`);
    }
    const trimmed = raw.trim();
    if (!trimmed.startsWith("- ")) {
      throw new Error(`config/env-admission.yaml: expected a list item at line ${significant + 1}`);
    }
    const rest = trimmed.slice(2).trim();
    if (rest.includes(": ")) {
      const item = {};
      const { key, value, hasValue } = splitKeyValue(rest, significant + 1);
      if (!hasValue) {
        throw new Error(
          `config/env-admission.yaml: missing value for ${key} at line ${significant + 1}`,
        );
      }
      item[key] = decodeScalar(value, significant + 1);
      const fields = parseMapping(lines, significant + 1, indent + 2);
      Object.assign(item, fields.value);
      list.push(item);
      index = fields.next;
      continue;
    }
    list.push(decodeScalar(rest, significant + 1));
    index = significant + 1;
  }
  return { value: list, next: index };
}

function parseBlockScalar(lines, start, parentIndent, style) {
  const contentAt = nextSignificant(lines, start);
  if (contentAt === null) {
    throw new Error("config/env-admission.yaml: empty block scalar");
  }
  const contentIndent = lineIndent(lines[contentAt]);
  if (contentIndent <= parentIndent) {
    throw new Error(`config/env-admission.yaml: empty block scalar at line ${contentAt + 1}`);
  }
  const chunks = [];
  let index = contentAt;
  while (index < lines.length) {
    const raw = lines[index];
    if (raw.trim() === "") {
      let look = index + 1;
      while (look < lines.length && lines[look].trim() === "") look += 1;
      if (look >= lines.length) break;
      if (lineIndent(lines[look]) < contentIndent) break;
      chunks.push("");
      index += 1;
      continue;
    }
    if (raw.trim().startsWith("#") && lineIndent(raw) < contentIndent) break;
    const indent = lineIndent(raw);
    if (indent < contentIndent) break;
    chunks.push(raw.slice(contentIndent).trimEnd());
    index += 1;
  }
  let text;
  if (style.startsWith(">")) {
    const paragraphs = [];
    let current = [];
    for (const chunk of chunks) {
      if (chunk === "") {
        if (current.length > 0) paragraphs.push(current.join(" "));
        current = [];
      } else {
        current.push(chunk);
      }
    }
    if (current.length > 0) paragraphs.push(current.join(" "));
    text = paragraphs.join("\n");
  } else {
    text = chunks.join("\n");
  }
  if (!style.endsWith("-")) text += "\n";
  return { value: text, next: index };
}

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "../..");
const YAML_PATH = "config/env-admission.yaml";
const TS_GENERATED = "packages/runtime/src/config/env-admission.generated.ts";
const JS_GENERATED = "packages/runtime/scripts/offline-test-env.generated.mjs";
const SHELL_GENERATED = ".gitlab/ci/runtime-run-env.generated.sh";
// Mirrors kept only for a consumer outside the product packages, keyed to
// that consumer. A tree without it (the public export) skips the mirror by
// name; with it present, a missing or stale mirror still refuses.
const MIRROR_OWNERS = Object.freeze({ [SHELL_GENERATED]: ".gitlab/ci/runtime-run.sh" });
/** Code mirrors the build generates; `--committed-only` does not check them. */
export const BUILD_GENERATED_MIRRORS = Object.freeze([TS_GENERATED, JS_GENERATED]);

const KNOWN_KINDS = new Set(["forwarded", "synthesized"]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function readRepo(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function writeRepo(path, contents) {
  const absolute = join(repoRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse and validate config/env-admission.yaml into a declaration object.
 * Every purpose's `admits` list is returned in file order; that order is
 * load-bearing, since the generated mirrors are compared byte-for-byte
 * against what is committed.
 */
export function loadEnvAdmission(yamlText = readRepo(YAML_PATH), options = {}) {
  const parseYaml = options.parseYaml ?? loadYamlParse() ?? parseEnvAdmissionYamlSubset;
  const parsed = parseYaml(yamlText);
  if (
    !isPlainObject(parsed) ||
    parsed.schemaVersion !== 1 ||
    parsed.kind !== "docsfab-env-admission"
  ) {
    throw new Error(
      "config/env-admission.yaml must declare schemaVersion 1 and kind docsfab-env-admission",
    );
  }
  if (!Array.isArray(parsed.purposes) || parsed.purposes.length === 0) {
    throw new Error("config/env-admission.yaml must declare a non-empty purposes list");
  }
  const purposeIds = new Set();
  const purposes = parsed.purposes.map((entry) => parsePurpose(entry, purposeIds));
  return { purposes };
}

function parsePurpose(entry, purposeIds) {
  if (!isPlainObject(entry)) throw new Error("each purposes entry must be a mapping");
  const id = requiredString(entry, "id", "purposes");
  if (purposeIds.has(id)) {
    throw new Error(`config/env-admission.yaml repeats purpose id ${id}`);
  }
  purposeIds.add(id);
  const description = requiredString(entry, "description", id);
  if (!Array.isArray(entry.admits) || entry.admits.length === 0) {
    throw new Error(`purpose ${id} must declare a non-empty admits list`);
  }
  const seenNames = new Set();
  const admits = entry.admits.map((admit) => parseAdmit(admit, id, seenNames));
  return { id, description, admits };
}

function parseAdmit(entry, purposeId, seenNames) {
  if (!isPlainObject(entry)) throw new Error(`${purposeId}: each admits entry must be a mapping`);
  const name = requiredString(entry, "name", purposeId);
  if (!NAME_RE.test(name)) {
    throw new Error(`${purposeId}: admits name "${name}" is not a shell-safe identifier`);
  }
  if (seenNames.has(name)) {
    throw new Error(`${purposeId}: repeats admits name ${name}`);
  }
  seenNames.add(name);
  const kind = requiredString(entry, "kind", `${purposeId}.${name}`);
  if (!KNOWN_KINDS.has(kind)) {
    throw new Error(`${purposeId}.${name}: kind must be forwarded or synthesized, got ${kind}`);
  }
  if (kind === "synthesized") {
    if (entry.when !== undefined) {
      throw new Error(`${purposeId}.${name}: synthesized entries cannot declare when`);
    }
    const value = requiredString(entry, "value", `${purposeId}.${name}`);
    return Object.freeze({ name, kind, value, when: null });
  }
  if (entry.value !== undefined) {
    throw new Error(`${purposeId}.${name}: forwarded entries cannot declare value`);
  }
  const when = entry.when === undefined ? null : parseWhen(entry.when, purposeId, name);
  return Object.freeze({ name, kind, value: null, when });
}

function parseWhen(when, purposeId, name) {
  if (!isPlainObject(when)) throw new Error(`${purposeId}.${name}: when must be a mapping`);
  if (!Array.isArray(when.jobNames) || when.jobNames.length === 0) {
    throw new Error(`${purposeId}.${name}: when.jobNames must be a non-empty list`);
  }
  const jobNames = when.jobNames.map((jobName, index) => {
    if (typeof jobName !== "string" || jobName.trim().length === 0) {
      throw new Error(`${purposeId}.${name}: when.jobNames[${index}] must be a non-empty string`);
    }
    return jobName;
  });
  const requiresConfigPrepArgv = when.requiresConfigPrepArgv === true;
  const extraKeys = Object.keys(when).filter(
    (key) => key !== "jobNames" && key !== "requiresConfigPrepArgv",
  );
  if (extraKeys.length > 0) {
    throw new Error(`${purposeId}.${name}: when has unknown keys ${extraKeys.join(", ")}`);
  }
  return Object.freeze({ jobNames: Object.freeze(jobNames), requiresConfigPrepArgv });
}

function requiredString(entry, key, context) {
  const value = entry[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: missing ${key}`);
  }
  return value;
}

function purposeById(declaration, id) {
  const purpose = declaration.purposes.find((entry) => entry.id === id);
  if (!purpose) throw new Error(`config/env-admission.yaml is missing purpose ${id}`);
  return purpose;
}

/** Forwarded names in file order. Throws if a purpose declares anything else. */
function forwardedNames(purpose) {
  return purpose.admits
    .filter((admit) => admit.when === null)
    .map((admit) => {
      if (admit.kind !== "forwarded") {
        throw new Error(
          `${purpose.id}.${admit.name}: renderer only supports forwarded entries today`,
        );
      }
      return admit.name;
    });
}

/**
 * Split the ci-runtime-run purpose into its unconditional names and its two
 * live-model gates. Every gated entry in this declaration shares one
 * job-name scope; a future declaration that needs more than one distinct
 * job-name scope is not supported by this renderer yet.
 */
function ciRuntimeRunGroups(declaration) {
  const purpose = purposeById(declaration, "ci-runtime-run");
  const unconditional = [];
  const jobGated = [];
  const argvGated = [];
  let jobNamesSignature;
  let jobNames;
  for (const admit of purpose.admits) {
    if (admit.kind !== "forwarded") {
      throw new Error(
        `${purpose.id}.${admit.name}: renderer only supports forwarded entries today`,
      );
    }
    if (admit.when === null) {
      unconditional.push(admit.name);
      continue;
    }
    const signature = JSON.stringify(admit.when.jobNames);
    if (jobNamesSignature === undefined) {
      jobNamesSignature = signature;
      jobNames = admit.when.jobNames;
    } else if (signature !== jobNamesSignature) {
      throw new Error(
        `${purpose.id}.${admit.name}: this renderer supports exactly one live-model job-name scope; ` +
          `found ${signature} alongside ${jobNamesSignature}`,
      );
    }
    if (admit.when.requiresConfigPrepArgv) {
      argvGated.push(admit.name);
    } else {
      jobGated.push(admit.name);
    }
  }
  return {
    unconditional,
    jobNames: jobNames ?? [],
    jobGated,
    argvGated,
  };
}

function tsArray(names) {
  return `Object.freeze([\n${names.map((name) => `  ${JSON.stringify(name)},`).join("\n")}\n])`;
}

export function renderTypeScript(declaration) {
  const local = forwardedNames(purposeById(declaration, "acceptance-local"));
  const offline = forwardedNames(purposeById(declaration, "acceptance-offline"));
  const groups = ciRuntimeRunGroups(declaration);
  return `// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generated by packages/runtime/scripts/check-env-admission.mjs. Do not hand-edit.
 * Source of truth: config/env-admission.yaml.
 */

/** packages/runtime/src/acceptance-cli.ts localAcceptanceEnvironment. */
export const ACCEPTANCE_LOCAL_NAMES: readonly string[] = ${tsArray(local)};

/** packages/runtime/src/acceptance.ts offlineAcceptanceEnvironment. */
export const ACCEPTANCE_OFFLINE_NAMES: readonly string[] = ${tsArray(offline)};

/** .gitlab/ci/runtime-run.sh unconditional env -i admissions. */
export const CI_RUNTIME_RUN_NAMES: readonly string[] = ${tsArray(groups.unconditional)};

/** .gitlab/ci/runtime-run.sh live-model job-name gate. */
export const CI_RUNTIME_RUN_LIVE_MODEL_JOB_NAMES: readonly string[] = ${tsArray(groups.jobNames)};

/** Admitted once CI_JOB_NAME is in CI_RUNTIME_RUN_LIVE_MODEL_JOB_NAMES. */
export const CI_RUNTIME_RUN_LIVE_MODEL_NAMES: readonly string[] = ${tsArray(groups.jobGated)};

/**
 * Admitted only when CI_JOB_NAME is in CI_RUNTIME_RUN_LIVE_MODEL_JOB_NAMES
 * AND the invoked child argv is exactly the live-model config-prep script
 * (see .gitlab/ci/runtime-run.sh is_live_model_config_prep).
 */
export const CI_RUNTIME_RUN_LIVE_MODEL_CONFIG_PREP_NAMES: readonly string[] = ${tsArray(groups.argvGated)};
`;
}

function shellArray(varName, names) {
  return `${varName}=(\n${names.map((name) => `  ${shellQuote(name)}`).join("\n")}\n)`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderShell(declaration) {
  const groups = ciRuntimeRunGroups(declaration);
  return `#!/usr/bin/env bash
# Generated by packages/runtime/scripts/check-env-admission.mjs. Do not hand-edit.
# Source of truth: config/env-admission.yaml (purpose: ci-runtime-run).
# Sourced by .gitlab/ci/runtime-run.sh.
if [[ "\${DOCSFAB_ENV_ADMISSION_GENERATED_LOADED:-}" == "1" ]]; then
  return 0
fi
DOCSFAB_ENV_ADMISSION_GENERATED_LOADED=1

${shellArray("DOCSFAB_ENV_ADMISSION_NAMES", groups.unconditional)}

${shellArray("DOCSFAB_ENV_ADMISSION_LIVE_MODEL_JOB_NAMES", groups.jobNames)}

${shellArray("DOCSFAB_ENV_ADMISSION_LIVE_MODEL_NAMES", groups.jobGated)}

${shellArray("DOCSFAB_ENV_ADMISSION_LIVE_MODEL_CONFIG_PREP_NAMES", groups.argvGated)}
`;
}

export function renderOfflineTestJavaScript(declaration) {
  const names = forwardedNames(purposeById(declaration, "offline-tests"));
  return `/** Generated by check-env-admission.mjs from config/env-admission.yaml. */
export const OFFLINE_TEST_NAMES = ${tsArray(names)};
`;
}

export function renderMirrors(declaration) {
  return {
    [TS_GENERATED]: renderTypeScript(declaration),
    [SHELL_GENERATED]: renderShell(declaration),
    [JS_GENERATED]: renderOfflineTestJavaScript(declaration),
  };
}

/**
 * `declaration` defaults to the tracked config/env-admission.yaml; a caller
 * that lists the mirrors and then checks them loads it once for both calls.
 */
export async function runEnvAdmissionTool(options, declaration = loadEnvAdmission()) {
  if (options.printMirrorPaths) {
    return { status: "mirror-paths", paths: Object.keys(renderMirrors(declaration)), skipped: [] };
  }
  const skipped = [];
  const mirrors = Object.entries(renderMirrors(declaration)).filter(([path]) => {
    const owner = MIRROR_OWNERS[path];
    if (owner === undefined || existsSync(join(repoRoot, owner))) return true;
    skipped.push(`${path}: skipped, its owner ${owner} is absent from this tree`);
    return false;
  });
  const paths = mirrors.map(([path]) => path);
  if (!options.checkOnly) {
    for (const [path, contents] of mirrors) writeRepo(path, contents);
    return { status: "generated", paths, skipped };
  }
  const checked = options.committedOnly
    ? mirrors.filter(([path]) => {
        if (!BUILD_GENERATED_MIRRORS.includes(path)) return true;
        skipped.push(
          `${path}: not checked here, the build generates it (scripts/ensure-derived.mjs)`,
        );
        return false;
      })
    : mirrors;
  const failures = [];
  for (const [path, contents] of checked) {
    if (!existsSync(join(repoRoot, path)) || readRepo(path) !== contents) {
      failures.push(`${path} drifted from ${YAML_PATH}; run npm run generate:env-admission`);
    }
  }
  if (failures.length > 0) {
    const error = new Error(failures.join("\n"));
    error.failures = failures;
    throw error;
  }
  return { status: "checked", paths: checked.map(([path]) => path), skipped };
}

/**
 * `--check`, optionally with `--committed-only`, or `--print-mirror-paths`
 * alone; any other argument refuses.
 */
export function parseEnvAdmissionArgs(argv) {
  const options = { checkOnly: false, committedOnly: false, printMirrorPaths: false };
  for (const argument of argv) {
    if (argument === "--check") options.checkOnly = true;
    else if (argument === "--committed-only") options.committedOnly = true;
    else if (argument === "--print-mirror-paths") options.printMirrorPaths = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.printMirrorPaths && argv.length > 1) {
    throw new Error("--print-mirror-paths takes no other argument");
  }
  if (options.committedOnly && !options.checkOnly) {
    throw new Error("--committed-only narrows --check and does not apply to generation");
  }
  return options;
}

function isMain() {
  // Realpath both sides: `import.meta.url` is symlink-resolved but argv[1] is
  // not, and a mismatch would exit 0 having checked nothing. Falls back to the
  // unresolved path only when the file cannot be stat'd.
  const real = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  const invoked = process.argv[1] ? real(resolve(process.argv[1])) : "";
  return invoked === real(fileURLToPath(import.meta.url));
}

if (isMain()) {
  try {
    const result = await runEnvAdmissionTool(parseEnvAdmissionArgs(process.argv.slice(2)));
    for (const line of result.skipped) console.log(line);
    if (result.status === "mirror-paths") {
      for (const path of result.paths) console.log(path);
    } else if (result.status === "generated") {
      console.log(`Updated env-admission mirrors: ${result.paths.join(", ")}`);
    } else {
      console.log(`Env-admission mirrors are current (${result.paths.join(", ")})`);
    }
  } catch (error) {
    console.error(`check:env-admission failed: ${error.message}`);
    process.exitCode = 1;
  }
}
