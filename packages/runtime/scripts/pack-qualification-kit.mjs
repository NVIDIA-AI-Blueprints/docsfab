#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pack a relocatable harness-role qualification kit. The ordinary runtime
 * quality pack stays scorer-free; this kit is a separately locked payload
 * that runs after clean installation outside a DocsFab Git checkout.
 *
 * Usage:
 *   node scripts/pack-qualification-kit.mjs
 *   node scripts/pack-qualification-kit.mjs --check
 */
import { internalContentPath } from "../src/config/internal-content.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const kitId = "harness-role-qualification-v1";
const kitRelative = `qualification-kits/${kitId}`;
const kitRoot = resolve(runtimeRoot, kitRelative);
// The public repository: the internal and exported trees stamp the same
// identity, and each revision is a content digest rather than a commit.
const sourceRepo = "https://github.com/NVIDIA-AI-Blueprints/docsfab.git";
const corpusSourceRelative = internalContentPath("harnessRoleQualificationSource");
const scorerSourceRelative = "packages/quality/checks/score_harness_role_qualification.py";
const scorerLicenseSourceRelative = `${scorerSourceRelative}.license`;
const validatorSourceRelative = "packages/quality/checks/validate_json_artifact.py";
const schemaSourceRelative = "packages/quality/schemas/model-role-qualification-record.schema.json";
const frozenGovernedInputRoot = internalContentPath("harnessRoleQualificationGovernedInputs");
const frozenGovernedInputs = [
  "packages/skills/verify-technical-accuracy/SKILL.md",
  "packages/skills/verify-technical-accuracy/references/verification-methods.md",
  "packages/skills/verify-technical-accuracy/references/finding-categories.md",
].map((payloadPath) => ({
  payloadPath,
  sourcePath: `${frozenGovernedInputRoot}/${payloadPath}`,
}));
const frozenGovernedInputRelatives = frozenGovernedInputs.map(({ sourcePath }) => sourcePath);
const sourceRelatives = [
  corpusSourceRelative,
  scorerSourceRelative,
  scorerLicenseSourceRelative,
  validatorSourceRelative,
  schemaSourceRelative,
  ...frozenGovernedInputRelatives,
];

function fail(message) {
  throw new Error(`Qualification kit packing failed: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

function canonicalSha256(value) {
  return sha256(JSON.stringify(sortValue(value)));
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fileMode(stat) {
  return (stat.mode & constants.S_IXUSR) === 0 ? "100644" : "100755";
}

function relativePath(root, path) {
  const candidate = relative(root, path).split("\\").join("/");
  if (!candidate || candidate === ".." || candidate.startsWith("../")) {
    fail("a generated path escaped its fixed root");
  }
  return candidate;
}

function gitOutput(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
  }).trimEnd();
}

function assertSourcesClean() {
  const status = gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...sourceRelatives,
  ]);
  if (status) fail("qualification kit sources are dirty");
}

async function discoveredFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
    if (entry.isSymbolicLink()) fail(`source contains a symbolic link: ${relativeName}`);
    if (entry.isDirectory()) {
      files.push(...(await discoveredFiles(path, relativeName)));
      continue;
    }
    if (!entry.isFile()) fail(`source contains an unsupported node: ${relativeName}`);
    const stat = await lstat(path);
    const bytes = await readFile(path);
    files.push({
      path: relativeName,
      bytes,
      sha256: sha256(bytes),
      mode: fileMode(stat),
    });
  }
  return files;
}

function trackedModes(sourceRelative) {
  const records = gitOutput(["ls-files", "--stage", "-z", "--", sourceRelative])
    .split("\0")
    .filter(Boolean);
  const tracked = new Map();
  const prefix =
    sourceRelative.endsWith(".py") ||
    sourceRelative.endsWith(".license") ||
    sourceRelative.endsWith(".json") ||
    sourceRelative.endsWith(".md")
      ? null
      : `${sourceRelative}/`;
  for (const record of records) {
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ");
    const path = separator === -1 ? "" : record.slice(separator + 1);
    if (
      metadata.length !== 3 ||
      !/^[0-7]{6}$/u.test(metadata[0] ?? "") ||
      !/^[a-f0-9]{40,64}$/u.test(metadata[1] ?? "") ||
      metadata[2] !== "0"
    ) {
      fail(`Git index entry is invalid or unmerged: ${sourceRelative}`);
    }
    const relativeName =
      prefix === null ? path : path.startsWith(prefix) ? path.slice(prefix.length) : "";
    if (
      !relativeName ||
      (prefix === null && path !== sourceRelative) ||
      tracked.has(relativeName)
    ) {
      fail(`Git index contains an invalid or duplicate path under ${sourceRelative}`);
    }
    const mode = metadata[0];
    if (mode !== "100644" && mode !== "100755") {
      fail(`Git index contains a non-regular file: ${path}`);
    }
    tracked.set(prefix === null ? path : relativeName, mode);
  }
  return tracked;
}

async function regularSourceFile(sourceRelative) {
  const path = resolve(repositoryRoot, sourceRelative);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail(`source is not one regular file: ${sourceRelative}`);
  }
  const tracked = trackedModes(sourceRelative);
  const mode = tracked.get(sourceRelative);
  if (!mode) fail(`source file is not Git-tracked: ${sourceRelative}`);
  if (tracked.size !== 1)
    fail(`source path did not resolve to one tracked file: ${sourceRelative}`);
  const bytes = await readFile(path);
  const actualMode = fileMode(stat);
  if (actualMode !== mode) fail(`source file mode differs from the Git index: ${sourceRelative}`);
  return {
    path: sourceRelative,
    bytes,
    sha256: sha256(bytes),
    mode,
  };
}

async function corpusFiles() {
  const files = await discoveredFiles(resolve(repositoryRoot, corpusSourceRelative));
  const tracked = trackedModes(corpusSourceRelative);
  for (const file of files) {
    const trackedMode = tracked.get(file.path);
    if (!trackedMode) fail(`source corpus file is not Git-tracked: ${file.path}`);
    if (file.mode !== trackedMode) {
      fail(`source corpus file mode differs from the Git index: ${file.path}`);
    }
    tracked.delete(file.path);
  }
  if (tracked.size !== 0) {
    fail(`source corpus tracked file is absent from the worktree: ${[...tracked.keys()][0]}`);
  }
  return files;
}

function runPySource() {
  return `${[
    "#!/usr/bin/env python3",
    '"""Execute the frozen harness-role qualification kit without a DocsFab checkout."""',
    "",
    "from __future__ import annotations",
    "",
    "import argparse",
    "import hashlib",
    "import json",
    "import os",
    "import shutil",
    "import subprocess",
    "import sys",
    "import tempfile",
    "from pathlib import Path",
    "",
    "",
    "def fail(message: str) -> None:",
    '    raise SystemExit(f"qualification kit: {message}")',
    "",
    "",
    "def sha256_file(path: Path) -> str:",
    "    return hashlib.sha256(path.read_bytes()).hexdigest()",
    "",
    "",
    "def kit_root() -> Path:",
    "    return Path(__file__).resolve().parent",
    "",
    "",
    "def load_lock(root: Path) -> dict:",
    '    lock_path = root / "lock.json"',
    "    try:",
    '        lock = json.loads(lock_path.read_text(encoding="utf-8"))',
    "    except (OSError, json.JSONDecodeError) as exc:",
    '        fail(f"lock.json is unreadable: {exc}")',
    '    if lock.get("kind") != "docsfab-harness-qualification-kit":',
    '        fail("lock.json is not a qualification kit lock")',
    '    files = lock.get("files")',
    "    if not isinstance(files, list) or not files:",
    '        fail("lock.json files are missing")',
    "    return lock",
    "",
    "",
    "def verify_lock(root: Path, lock: dict) -> None:",
    '    expected = lock.get("bundleSha256")',
    "    lines = []",
    "    seen: set[str] = set()",
    '    for entry in lock["files"]:',
    '        path = entry.get("path")',
    '        digest = entry.get("sha256")',
    "        if (",
    "            not isinstance(path, str)",
    "            or not path",
    "            or Path(path).is_absolute()",
    '            or ".." in Path(path).parts',
    "        ):",
    '            fail("lock.json contains an unsafe path")',
    "        if path in seen:",
    '            fail(f"lock.json duplicates {path}")',
    "        seen.add(path)",
    "        target = (root / path).resolve()",
    "        try:",
    "            target.relative_to(root.resolve())",
    "        except ValueError:",
    '            fail(f"{path} escapes the kit root")',
    "        if not target.is_file():",
    '            fail(f"locked file is missing: {path}")',
    "        actual = sha256_file(target)",
    "        if actual != digest:",
    '            fail(f"locked file was tampered: {path}")',
    '        lines.append(f"{digest}  {path}\\n")',
    '    bundle = hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()',
    "    if bundle != expected:",
    '        fail("bundle digest mismatch")',
    "",
    "",
    "def materialize(root: Path, lock: dict) -> Path:",
    '    destination = Path(tempfile.mkdtemp(prefix="docsfab-qualification-kit-"))',
    '    for entry in lock["files"]:',
    '        path = entry["path"]',
    "        target = destination / path",
    "        target.parent.mkdir(parents=True, exist_ok=True)",
    "        shutil.copyfile(root / path, target)",
    "    env = dict(os.environ)",
    '    env["GIT_CONFIG_NOSYSTEM"] = "1"',
    "    subprocess.run(",
    '        ["git", "-c", "init.defaultBranch=main", "init"],',
    "        cwd=destination,",
    "        check=True,",
    "        capture_output=True,",
    "        timeout=10,",
    "        env=env,",
    "    )",
    "    return destination",
    "",
    "",
    "def load_corpus(isolated: Path, lock: dict):",
    '    checks = isolated / "packages" / "quality" / "checks"',
    "    sys.path.insert(0, str(checks))",
    "    from score_harness_role_qualification import _load_frozen_corpus",
    "",
    "    return _load_frozen_corpus(",
    '        isolated / lock["corpusRoot"],',
    '        approved_private_manifest_sha256=lock["privateManifestSha256"],',
    '        scorer_path=isolated / lock["scorerPath"],',
    "    )",
    "",
    "",
    "def assert_python_scoring_never_mints_qualified(isolated: Path, lock: dict) -> None:",
    '    scorer = (isolated / lock["scorerPath"]).read_text(encoding="utf-8")',
    '    assignment = \'"decision": "qualification-candidate" if qualified else "not-qualified"\'',
    "    if assignment not in scorer:",
    '        fail("packed scorer no longer emits only qualification-candidate")',
    '    if \'"decision": "qualified"\' in scorer:',
    '        fail("packed scorer mints qualified")',
    '    schema = json.loads((isolated / lock["schemaPath"]).read_text(encoding="utf-8"))',
    '    enum = schema.get("properties", {}).get("decision", {}).get("enum")',
    '    if enum != ["qualification-candidate", "not-qualified"]:',
    '        fail("packed schema allows a qualified decision")',
    "",
    "",
    "def main() -> int:",
    "    parser = argparse.ArgumentParser(description=__doc__)",
    '    parser.add_argument("--verify", action="store_true")',
    "    args = parser.parse_args()",
    "    if not args.verify:",
    '        fail("pass --verify to execute the frozen kit")',
    "    root = kit_root()",
    "    lock = load_lock(root)",
    "    verify_lock(root, lock)",
    "    isolated = materialize(root, lock)",
    "    try:",
    "        load_corpus(isolated, lock)",
    "        assert_python_scoring_never_mints_qualified(isolated, lock)",
    "    finally:",
    "        shutil.rmtree(isolated, ignore_errors=True)",
    '    print("qualification kit verified")',
    "    return 0",
    "",
    "",
    'if __name__ == "__main__":',
    "    raise SystemExit(main())",
    "",
  ].join("\n")}`;
}

function bundleSha256(files) {
  return sha256(files.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
}

function sourceRevision(files) {
  const entries = files
    .map((file) => ({ path: file.path, sha256: file.sha256, mode: file.mode }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return canonicalSha256({
    kind: "docsfab-qualification-kit-source-content/v1",
    files: entries,
  });
}

async function expectedKit() {
  assertSourcesClean();
  const corpus = await corpusFiles();
  const scorer = await regularSourceFile(scorerSourceRelative);
  const scorerLicense = await regularSourceFile(scorerLicenseSourceRelative);
  const validator = await regularSourceFile(validatorSourceRelative);
  const schema = await regularSourceFile(schemaSourceRelative);
  const governedSources = await Promise.all(
    frozenGovernedInputs.map(({ sourcePath }) => regularSourceFile(sourcePath)),
  );
  const governed = governedSources.map((file, index) => ({
    ...file,
    path: frozenGovernedInputs[index].payloadPath,
  }));
  const privateManifestFile = corpus.find((file) => file.path === "oracles/private-manifest.json");
  if (!privateManifestFile) fail("private corpus manifest is absent");
  let privateManifest;
  try {
    privateManifest = JSON.parse(privateManifestFile.bytes.toString("utf8"));
  } catch {
    fail("private corpus manifest is not valid JSON");
  }
  const privateManifestSha256 = canonicalSha256(privateManifest);
  if (privateManifest?.scorer?.sha256 !== scorer.sha256) {
    fail("packed scorer digest does not match the frozen private manifest");
  }
  const expectedGoverned = new Map(
    (privateManifest.governed_inputs ?? []).map((entry) => [entry.source_path, entry.sha256]),
  );
  for (const file of governed) {
    if (expectedGoverned.get(file.path) !== file.sha256) {
      fail(`governed input digest does not match the frozen private manifest: ${file.path}`);
    }
  }
  if (expectedGoverned.size !== governed.length) {
    fail("frozen private manifest governed-input set is unsupported");
  }

  const payload = [
    ...corpus.map((file) => ({ ...file, path: `corpus/${file.path}` })),
    { ...scorer, path: scorerSourceRelative },
    { ...scorerLicense, path: scorerLicenseSourceRelative },
    { ...validator, path: validatorSourceRelative },
    { ...schema, path: schemaSourceRelative },
    ...governed,
  ];
  const runPy = Buffer.from(runPySource(), "utf8");
  const generatedRunPy = {
    path: "run.py",
    bytes: runPy,
    sha256: sha256(runPy),
    mode: "100644",
  };
  payload.push(generatedRunPy);
  const generatedRunLicense = { ...scorerLicense, path: "run.py.license" };
  payload.push(generatedRunLicense);
  payload.sort((left, right) => left.path.localeCompare(right.path));
  for (const file of payload) {
    if (file.path !== relativePath(kitRoot, resolve(kitRoot, file.path))) {
      fail(`payload path is unsafe: ${file.path}`);
    }
  }
  const lockedFiles = payload.map((file) => ({ path: file.path, sha256: file.sha256 }));
  const revisionInputs = [
    ...corpus.map((file) => ({ ...file, path: `${corpusSourceRelative}/${file.path}` })),
    scorer,
    scorerLicense,
    validator,
    schema,
    ...governedSources,
    { ...generatedRunPy, path: "generated/run.py" },
    { ...generatedRunLicense, path: "generated/run.py.license" },
  ];
  const lock = {
    schemaVersion: 1,
    kind: "docsfab-harness-qualification-kit",
    id: kitId,
    version: "1.0.0",
    bundleHashFormat: "sha256-lines-v1",
    corpusId: "docsfab-harness-role-qualification-v1",
    corpusRoot: "corpus",
    scorerPath: scorerSourceRelative,
    schemaPath: schemaSourceRelative,
    privateManifestPath: "corpus/oracles/private-manifest.json",
    privateManifestSha256,
    source: {
      repository: sourceRepo,
      revision: sourceRevision(revisionInputs),
      paths: [...sourceRelatives],
      generatedPaths: ["run.py", "run.py.license"],
    },
    files: lockedFiles,
    bundleSha256: bundleSha256(lockedFiles),
  };
  return { payload, lock, lockBytes: Buffer.from(serialized(lock), "utf8") };
}

async function stagedFiles() {
  async function list(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...(await list(resolve(directory, entry.name), path)));
      } else if (entry.isFile() && path !== "lock.json") {
        files.push(path);
      }
    }
    return files;
  }
  const names = (await list(kitRoot)).sort((left, right) => left.localeCompare(right));
  return Promise.all(
    names.map(async (path) => ({
      path,
      sha256: sha256(await readFile(resolve(kitRoot, path))),
    })),
  );
}

const checkOnly = process.argv.length === 3 && process.argv[2] === "--check";
if (process.argv.length > (checkOnly ? 3 : 2)) {
  fail("accepts only the optional --check flag");
}

const expected = await expectedKit();
if (checkOnly) {
  const actualLock = await readFile(resolve(kitRoot, "lock.json"));
  if (!actualLock.equals(expected.lockBytes)) {
    fail("lock.json is stale; run node scripts/pack-qualification-kit.mjs");
  }
  const staged = await stagedFiles();
  if (JSON.stringify(staged) !== JSON.stringify(expected.lock.files)) {
    fail("qualification kit payload differs from the lock");
  }
  for (const file of expected.payload) {
    const actual = await readFile(resolve(kitRoot, file.path));
    if (!actual.equals(file.bytes)) fail(`qualification kit file is stale: ${file.path}`);
  }
  console.log(`Qualification kit is current: ${expected.lock.files.length} files`);
} else {
  await rm(kitRoot, { recursive: true, force: true });
  await mkdir(kitRoot, { recursive: true });
  for (const file of expected.payload) {
    const path = resolve(kitRoot, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
  }
  await writeFile(resolve(kitRoot, "lock.json"), expected.lockBytes);
  console.log(`Updated qualification kit: ${expected.lock.files.length} files`);
}
