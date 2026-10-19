// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The limits literal allowlist, sharded by path owner.
 *
 * `config/limits-allowlist.json` is the root registry: it declares
 * `unknownRationaleBudget` and the shards, one `{ file, owner }` row each.
 * Every literal lives in exactly one shard under `config/limits-allowlist/`:
 * the shard whose `owner` is the longest registered path prefix of the
 * literal's `path`, matched at a `/` segment boundary. One remainder shard
 * per scanned root owns everything no narrower shard claims, so a literal in
 * a directory with no shard of its own still has a home.
 *
 * A scanned root that configuration declares outside the root registry, the
 * deploy root of limits-deploy-root.mjs, is a configured shard: the checker
 * passes its `{ file, owner }` row in, the composed allowlist includes it,
 * and the root registry never lists it, so the exported registry does not
 * name a host's deployment directory.
 *
 * `check-limits.mjs` composes the shards for its gate and partitions fresh
 * findings back into them for `--write-allowlist`. This module reads only
 * `node:` built-ins: `check-limits.mjs` also runs before `npm ci`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { DEPLOY_ROOT_CONFIG_PATH } from "./limits-deploy-root.mjs";

export const ALLOWLIST_ROOT_PATH = "config/limits-allowlist.json";
export const ALLOWLIST_SHARD_DIR = "config/limits-allowlist";
// A directory entry that could be mistaken for a shard, mirroring
// check-limits.mjs FRAGMENT_FILE_RE. Anything else (.DS_Store, README.md, an
// editor's `runtime.json~` or `.runtime.json.swp`) is not read and not refused.
const SHARD_FILE_RE = /\.json$/iu;
// One owner path segment. No `.`, so the derived shard file name (segments
// joined with `.`) maps back to exactly one owner.
const OWNER_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const ROOT_KEYS = Object.freeze(["unknownRationaleBudget", "shards"]);
// The legacy single-file root a branch rebased across the split brings
// back. --write-allowlist reads it (loadAllowlistForRewrite), so this one
// command is the whole remedy.
const LEGACY_ROOT_REMEDY =
  "run `node scripts/check-limits.mjs --write-allowlist` from packages/runtime; it files each root literal, rationale included, in its owning shard and rewrites the root as the shards registry";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shardPath(file) {
  return `${ALLOWLIST_SHARD_DIR}/${file}`;
}

// The refusal for an unregistered shard file. Handles exactly a `deploy.*`
// name, whose owner is a deploy root that only the deploy configuration
// registers: when that configuration names another root, the message names
// it; when there is none, it asks for the file. Any other name is for the
// root registry. `shards` carries the configured rows with their `source`.
function unregisteredShardMessage(name, shards) {
  if (name.startsWith("deploy.")) {
    const configured = shards.find(({ source }) => source !== undefined);
    if (configured !== undefined) {
      return `${ALLOWLIST_SHARD_DIR}/${name} is not registered: ${configured.source} declares deploy root ${configured.owner}, whose shard is ${configured.file}; correct that root or remove the shard`;
    }
    return `${ALLOWLIST_SHARD_DIR}/${name} is not registered: no ${DEPLOY_ROOT_CONFIG_PATH} declares its deploy root; restore that file or remove the shard`;
  }
  return `${ALLOWLIST_SHARD_DIR}/${name} is not registered in ${ALLOWLIST_ROOT_PATH}; add it to the shards registry or remove it`;
}

/**
 * The one file-name rule: drop a leading `packages/<name>/src` down to
 * `<name>`, then join the owner's segments with `.`.
 * `packages/runtime/src/model` -> `runtime.model.json`;
 * `packages/host/src` -> `host.json`; `deploy/example-host` ->
 * `deploy.example-host.json`.
 */
export function shardFileForOwner(owner) {
  const segments = owner.split("/");
  const named =
    segments[0] === "packages" && segments[2] === "src"
      ? [segments[1], ...segments.slice(3)]
      : segments;
  return `${named.join(".")}.json`;
}

function isWithin(path, owner) {
  return path === owner || path.startsWith(`${owner}/`);
}

/**
 * The shard that owns `path`: the longest registered owner that is `path`
 * itself or a `/`-bounded prefix of it. Registry order never decides, and
 * `packages/runtime/src/model` does not own `packages/runtime/src/model-composition/x.ts`.
 */
export function owningShard(path, shards) {
  let best;
  for (const shard of shards) {
    if (!isWithin(path, shard.owner)) continue;
    if (best === undefined || shard.owner.length > best.owner.length) best = shard;
  }
  return best;
}

function parseJson(text, source) {
  // Handles exactly JSON.parse rejecting the text. The caller reads the file
  // outside this try, so an I/O error keeps its own message, and valid JSON
  // of the wrong shape reaches the shape refusals instead.
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
}

/**
 * Validate the root registry document. `scanRoots` are the directories the
 * checker scans; every owner must lie inside one, and every scan root must be
 * registered as its own remainder owner, in the registry or as one of the
 * `configuredShards` rows (`{ file, owner, source }`, `source` naming the
 * configuration that declares it).
 */
export function parseAllowlistRegistry(document, scanRoots, configuredShards = []) {
  if (!isPlainObject(document)) {
    throw new Error(
      `${ALLOWLIST_ROOT_PATH} must be an object declaring ${ROOT_KEYS.join(" and ")}`,
    );
  }
  if (Object.hasOwn(document, "literals")) {
    throw new Error(
      `${ALLOWLIST_ROOT_PATH} must not declare a literals list; each literal lives in its owning shard under ${ALLOWLIST_SHARD_DIR}/. To carry root literals forward, ${LEGACY_ROOT_REMEDY}`,
    );
  }
  const unknownKeys = Object.keys(document).filter((key) => !ROOT_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${ALLOWLIST_ROOT_PATH} may declare only ${ROOT_KEYS.join(" and ")}; found ${unknownKeys.join(", ")}`,
    );
  }
  const budget = document.unknownRationaleBudget;
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new Error(`${ALLOWLIST_ROOT_PATH} unknownRationaleBudget must be a non-negative integer`);
  }
  return {
    unknownRationaleBudget: budget,
    shards: parseShardRegistry(document.shards, scanRoots, configuredShards),
  };
}

/**
 * Validate the `shards` rows: one file per owner, each named by the one rule.
 * Returns the registry rows, then the configured rows.
 */
function parseShardRegistry(rows, scanRoots, configuredShards = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${ALLOWLIST_ROOT_PATH} must declare a non-empty shards registry`);
  }
  const configuredByOwner = new Map(configuredShards.map((row) => [row.owner, row]));
  const owners = new Set();
  const filesByLowerCase = new Map();
  const shards = rows.map((entry) => {
    if (
      !isPlainObject(entry) ||
      Object.keys(entry).sort().join(",") !== "file,owner" ||
      typeof entry.file !== "string" ||
      typeof entry.owner !== "string"
    ) {
      throw new Error(
        `each ${ALLOWLIST_ROOT_PATH} shards entry must be exactly { file, owner } strings`,
      );
    }
    const { file, owner } = entry;
    if (!owner.split("/").every((segment) => OWNER_SEGMENT_RE.test(segment))) {
      throw new Error(
        `${ALLOWLIST_ROOT_PATH} shard owner ${owner} must be a repository path of plain segments (no '.', no empty segment)`,
      );
    }
    if (!scanRoots.some((root) => isWithin(owner, root))) {
      throw new Error(
        `${ALLOWLIST_ROOT_PATH} registers owner ${owner} outside every scanned root (${scanRoots.join(", ")})`,
      );
    }
    const expected = shardFileForOwner(owner);
    if (file !== expected) {
      throw new Error(
        `${ALLOWLIST_ROOT_PATH} registers shard ${file} for owner ${owner}; the file must be named ${expected}`,
      );
    }
    if (owners.has(owner)) {
      throw new Error(`${ALLOWLIST_ROOT_PATH} registers owner ${owner} more than once`);
    }
    const configured = configuredByOwner.get(owner);
    if (configured !== undefined) {
      throw new Error(
        `${ALLOWLIST_ROOT_PATH} registers owner ${owner}, which ${configured.source} already declares; remove the row from ${ALLOWLIST_ROOT_PATH}`,
      );
    }
    owners.add(owner);
    // Two registered names that differ only in case are one file on APFS.
    const twin = filesByLowerCase.get(file.toLowerCase());
    if (twin !== undefined) {
      throw new Error(
        `${ALLOWLIST_ROOT_PATH} registers shards ${twin} and ${file}, whose names differ only in case`,
      );
    }
    filesByLowerCase.set(file.toLowerCase(), file);
    return Object.freeze({ file, owner });
  });
  // The checker derives a configured row from a validated scan root, so its
  // file follows the naming rule and no registry row can reuse its owner.
  for (const { file, owner, source } of configuredShards) {
    owners.add(owner);
    shards.push(Object.freeze({ file, owner, source }));
  }
  for (const root of scanRoots) {
    if (!owners.has(root)) {
      throw new Error(
        `${ALLOWLIST_ROOT_PATH} has no shard owning scanned root ${root}; register { file: ${shardFileForOwner(root)}, owner: ${root} } as its remainder shard`,
      );
    }
  }
  return shards;
}

/**
 * Refuse, by name, anything under config/limits-allowlist/ the registry does
 * not account for, and any registered shard that is absent while its scanned
 * root is present. Presence comes from the exact directory listing, not
 * existsSync: on a case-insensitive filesystem (APFS) existsSync("runtime.json")
 * is true for Runtime.json, which Linux CI would then fail to find. Returns
 * the listed names.
 */
function assertShardDirectoryMatchesRegistry(root, shards, absentRoots) {
  const directory = join(root, ALLOWLIST_SHARD_DIR);
  if (!existsSync(directory)) {
    throw new Error(
      `${ALLOWLIST_SHARD_DIR}/ is missing; ${ALLOWLIST_ROOT_PATH} registers its shards there`,
    );
  }
  const names = readdirSync(directory).sort();
  const registered = new Set(shards.map(({ file }) => file));
  const byLowerCase = new Map(shards.map(({ file }) => [file.toLowerCase(), file]));
  for (const name of names) {
    // A shard name starts with an owner segment, never '.', so a dot name
    // (.DS_Store, Emacs's `.#runtime.json` lock symlink) is not a shard.
    if (name.startsWith(".")) continue;
    // statSync follows a symlink, so a linked directory is refused as one; a
    // dangling one is no directory and meets the name checks below.
    if (statSync(join(directory, name), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(
        `${ALLOWLIST_SHARD_DIR}/${name} is a directory; allowlist shards are flat files registered in ${ALLOWLIST_ROOT_PATH}`,
      );
    }
    // Only a *.json name (any case) can be mistaken for a shard.
    if (!SHARD_FILE_RE.test(name) || registered.has(name)) continue;
    const caseTwin = byLowerCase.get(name.toLowerCase());
    if (caseTwin !== undefined) {
      throw new Error(
        `${ALLOWLIST_SHARD_DIR}/${name} differs only in case from the registered shard ${caseTwin}; rename it to match ${ALLOWLIST_ROOT_PATH} exactly`,
      );
    }
    throw new Error(unregisteredShardMessage(name, shards));
  }
  const present = new Set(names);
  for (const { file, owner, source } of shards) {
    // Handles exactly: the shard's scanned root is absent from the tree. A
    // missing shard under a present root is refused below.
    if (!present.has(file) && absentRoots.some((absent) => isWithin(owner, absent))) continue;
    if (!present.has(file)) {
      throw new Error(
        source === undefined
          ? `registered shard ${shardPath(file)} is missing; restore it or remove it from ${ALLOWLIST_ROOT_PATH}`
          : `shard ${shardPath(file)}, which ${source} registers, is missing; restore it`,
      );
    }
  }
  return present;
}

function checkedLiterals(literals, source) {
  if (!Array.isArray(literals)) throw new Error(`${source} must declare a literals list`);
  for (const literal of literals) {
    if (!isPlainObject(literal) || typeof literal.path !== "string") {
      throw new Error(`${source} holds a literal without a string path`);
    }
  }
  return literals;
}

function parseShard(text, shard, shards) {
  const source = shardPath(shard.file);
  const document = parseJson(text, source);
  if (!isPlainObject(document) || !Array.isArray(document.literals)) {
    throw new Error(`${source} must declare a literals list`);
  }
  const extra = Object.keys(document).filter((key) => key !== "literals");
  if (extra.length > 0) {
    throw new Error(`${source} may declare only a literals list; found ${extra.join(", ")}`);
  }
  for (const literal of checkedLiterals(document.literals, source)) {
    const owner = owningShard(literal.path, shards);
    // Handles exactly: an owner exists and it is a different shard. A path no
    // shard owns (outside every scanned root) is the adjacent case below.
    if (owner !== undefined && owner.file !== shard.file) {
      throw new Error(
        `${source} holds literal ${literal.path}, owned by shard ${shardPath(owner.file)}; move it there`,
      );
    }
    if (owner === undefined) {
      throw new Error(
        `${source} holds literal ${literal.path}, which no registered shard owns; the checker never scans it, so remove it`,
      );
    }
  }
  // An empty literals list loads: it is the drained state of an area whose
  // last allowlisted literal moved to the catalog, and --write-allowlist
  // writes it that way.
  return document.literals;
}

/**
 * Compose the allowlist from the root registry and its shards.
 * Returns `{ unknownRationaleBudget, shards: [{ file, owner, literals }], literals }`,
 * shards in registry order. An absent root is an empty allowlist (the
 * gate then fails loudly on every literal); a present root is validated in
 * full. `absentRoots` are scanned roots missing from the tree, such as the
 * public export; a registered shard under one may be absent and loads empty.
 * `configuredShards` are the `{ file, owner, source }` rows configuration
 * declares outside the root registry.
 *
 * @param {{ repoRoot: string, scanRoots: string[], absentRoots?: string[], configuredShards?: { file: string, owner: string, source: string }[] }} options
 */
export function loadAllowlistShards({
  repoRoot,
  scanRoots,
  absentRoots = [],
  configuredShards = [],
}) {
  const rootFile = join(repoRoot, ALLOWLIST_ROOT_PATH);
  if (!existsSync(rootFile)) {
    return { unknownRationaleBudget: 0, shards: [], literals: [] };
  }
  const registry = parseAllowlistRegistry(
    parseJson(readFileSync(rootFile, "utf8"), ALLOWLIST_ROOT_PATH),
    scanRoots,
    configuredShards,
  );
  const present = assertShardDirectoryMatchesRegistry(repoRoot, registry.shards, absentRoots);
  const shards = registry.shards.map((shard) =>
    Object.freeze({
      ...shard,
      literals: present.has(shard.file)
        ? parseShard(
            readFileSync(join(repoRoot, ALLOWLIST_SHARD_DIR, shard.file), "utf8"),
            shard,
            registry.shards,
          )
        : [],
    }),
  );
  return {
    unknownRationaleBudget: registry.unknownRationaleBudget,
    shards,
    literals: shards.flatMap(({ literals }) => literals),
  };
}

/**
 * The repository path of the shard holding a composed literal, for gate
 * messages. Only called with literals `loadAllowlistShards` returned, each
 * already verified to sit in its owning shard.
 */
export function shardPathForLiteral(path, shards) {
  return shardPath(owningShard(path, shards).file);
}

function canonicalKey(finding) {
  return `${finding.path}\t${finding.kind}\t${finding.lexeme}`;
}

/**
 * Split findings into the registered shards, each sorted by the canonical
 * `path\tkind\tlexeme` key. Shards come back in registry order; a shard that
 * owns no finding comes back with an empty list.
 */
export function partitionAllowlist(findings, shards) {
  const byFile = new Map(shards.map((shard) => [shard.file, []]));
  for (const finding of findings) {
    const owner = owningShard(finding.path, shards);
    if (owner === undefined) {
      throw new Error(
        `no shard registered in ${ALLOWLIST_ROOT_PATH} owns ${finding.path}; register one for its scanned root`,
      );
    }
    byFile.get(owner.file).push(finding);
  }
  return shards.map((shard) => ({
    file: shard.file,
    owner: shard.owner,
    literals: byFile.get(shard.file).sort((left, right) => {
      const a = canonicalKey(left);
      const b = canonicalKey(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  }));
}

/**
 * Everything `--write-allowlist` writes, keyed by repository path: the root
 * registry (budget and shards only) and every registered shard. `findings`
 * are fresh scan results (`{ path, kind, lexeme, count }`); each keeps the
 * rationale its entry carried in `previous` (loadAllowlistForRewrite, or
 * loadAllowlistShards) when path, kind, lexeme, and count all still match.
 */
export function renderAllowlistFiles({ findings, previous, unknownRationaleBudget }) {
  if (previous.shards.length === 0) {
    throw new Error(
      `${ALLOWLIST_ROOT_PATH} is missing; restore its shards registry before running --write-allowlist`,
    );
  }
  const findingKey = (entry) => `${canonicalKey(entry)}\t${entry.count}`;
  const previousByKey = new Map(previous.literals.map((entry) => [findingKey(entry), entry]));
  const merged = findings.map((finding) => {
    const rationale = previousByKey.get(findingKey(finding))?.rationale;
    return typeof rationale === "string" && rationale.trim().length > 0
      ? { ...finding, rationale: rationale.trim() }
      : finding;
  });
  const shards = previous.shards.map(({ file, owner }) => ({ file, owner }));
  // A configured shard is written, but its row stays with its configuration.
  const registry = previous.shards
    .filter(({ source }) => source === undefined)
    .map(({ file, owner }) => ({ file, owner }));
  const render = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const files = {
    [ALLOWLIST_ROOT_PATH]: render({ unknownRationaleBudget, shards: registry }),
  };
  for (const shard of partitionAllowlist(merged, shards)) {
    files[shardPath(shard.file)] = render({ literals: shard.literals });
  }
  return { files, count: merged.length, shards: shards.length };
}

/**
 * The registry a legacy root (no `shards` list) implies: the owner each
 * shard file under ALLOWLIST_SHARD_DIR is named for, inverting
 * shardFileForOwner within the scanned roots, sorted by owner as the
 * committed registry is.
 */
function recoverShardRegistry(names, scanRoots) {
  if (names.length === 0) {
    throw new Error(
      `${ALLOWLIST_ROOT_PATH} declares no shards registry and ${ALLOWLIST_SHARD_DIR}/ holds no shard to recover it from; restore that directory from main (from the repository root: \`git checkout origin/main -- ${ALLOWLIST_SHARD_DIR}\`), then rerun --write-allowlist`,
    );
  }
  const rows = names.map((file) => {
    const segments = file.replace(SHARD_FILE_RE, "").split(".");
    const owners = [
      ["packages", segments[0], "src", ...segments.slice(1)].join("/"),
      segments.join("/"),
    ].filter(
      (owner) =>
        shardFileForOwner(owner) === file && scanRoots.some((root) => isWithin(owner, root)),
    );
    if (owners.length !== 1) {
      throw new Error(
        `${shardPath(file)} does not name exactly one owner under a scanned root, so ${ALLOWLIST_ROOT_PATH}'s shards registry cannot be recovered from it; rename or remove it`,
      );
    }
    return { file, owner: owners[0] };
  });
  return rows.sort((left, right) => (left.owner < right.owner ? -1 : 1));
}

/**
 * The allowlist as --write-allowlist reads it: the shards registry to write
 * into, and the rationale of every literal already written down. The writer
 * re-partitions every finding, so unlike loadAllowlistShards it does not
 * require a valid layout:
 * - a root still carrying the legacy `literals` list (a branch rebased
 *   across the split) contributes those literals, and without a `shards`
 *   list the registry is recovered from the shard file names;
 * - a registered shard that is absent is empty (a newly registered owner);
 * - a literal outside its owning shard, or in a `*.json` file the registry
 *   no longer lists, still contributes its rationale.
 * Two sources giving one finding different rationales are refused by name;
 * neither silently wins.
 *
 * `configuredShards` are as for loadAllowlistShards; their rows are never
 * recovered from file names.
 *
 * @param {{ repoRoot: string, scanRoots: string[], configuredShards?: { file: string, owner: string, source: string }[] }} options
 * @returns {{ shards: { file: string, owner: string, source?: string }[], literals: object[] }}
 */
export function loadAllowlistForRewrite({ repoRoot, scanRoots, configuredShards = [] }) {
  const rootFile = join(repoRoot, ALLOWLIST_ROOT_PATH);
  if (!existsSync(rootFile)) {
    throw new Error(
      `${ALLOWLIST_ROOT_PATH} is missing; restore its shards registry before running --write-allowlist`,
    );
  }
  const document = parseJson(readFileSync(rootFile, "utf8"), ALLOWLIST_ROOT_PATH);
  if (!isPlainObject(document)) {
    throw new Error(
      `${ALLOWLIST_ROOT_PATH} must be an object declaring ${ROOT_KEYS.join(" and ")}`,
    );
  }
  const unknownKeys = Object.keys(document).filter(
    (key) => !ROOT_KEYS.includes(key) && key !== "literals",
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `${ALLOWLIST_ROOT_PATH} may declare only ${ROOT_KEYS.join(" and ")}; found ${unknownKeys.join(", ")}`,
    );
  }
  const directory = join(repoRoot, ALLOWLIST_SHARD_DIR);
  const names = existsSync(directory)
    ? readdirSync(directory)
        .filter(
          (name) =>
            !name.startsWith(".") &&
            SHARD_FILE_RE.test(name) &&
            statSync(join(directory, name), { throwIfNoEntry: false })?.isFile(),
        )
        .sort()
    : [];
  const configuredFiles = new Set(configuredShards.map(({ file }) => file));
  const shards = parseShardRegistry(
    Object.hasOwn(document, "shards")
      ? document.shards
      : recoverShardRegistry(
          names.filter((name) => !configuredFiles.has(name)),
          scanRoots,
        ),
    scanRoots,
    configuredShards,
  );
  const sources = names.map((name) => {
    const source = shardPath(name);
    const shard = parseJson(readFileSync(join(directory, name), "utf8"), source);
    return [source, checkedLiterals(isPlainObject(shard) ? shard.literals : undefined, source)];
  });
  if (Object.hasOwn(document, "literals")) {
    sources.unshift([ALLOWLIST_ROOT_PATH, checkedLiterals(document.literals, ALLOWLIST_ROOT_PATH)]);
  }
  const byKey = new Map();
  for (const [source, literals] of sources) {
    for (const literal of literals) {
      const rationale = typeof literal.rationale === "string" ? literal.rationale.trim() : "";
      if (rationale.length === 0) continue;
      const key = `${canonicalKey(literal)}\t${literal.count}`;
      const held = byKey.get(key);
      if (held !== undefined && held.literal.rationale.trim() !== rationale) {
        throw new Error(
          `${literal.path} ${literal.kind} ${literal.lexeme} x${literal.count} carries different rationales in ${held.source} and ${source}; make them agree, then rerun --write-allowlist`,
        );
      }
      byKey.set(key, held ?? { source, literal });
    }
  }
  return { shards, literals: [...byKey.values()].map(({ literal }) => literal) };
}
