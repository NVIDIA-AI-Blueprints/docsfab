// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";

/** The package root: this module sits under `src/quality-pack/` or `dist/quality-pack/`. */
const PACKAGE_ROOT = new URL("../../", import.meta.url);

/** The documented install, with the tarball URL left for the operator's own install record. */
const REINSTALL_COMMAND = "npm i -g --ignore-scripts --engine-strict '<tarball URL>'";

/** Where the installation guide shows how to reinstall an exact release. */
const REINSTALL_GUIDE =
  'the "Repair an Installed Package" section of docs/manage/update-or-uninstall.md';

/**
 * Name the installed release, so the step reinstalls the same one rather than
 * a literal that drifts from `package.json`.
 */
function installedVersion(packageRoot: URL): string | undefined {
  try {
    const { version } = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")) as {
      version?: unknown;
    };
    return typeof version === "string" ? version : undefined;
  } catch {
    // An unreadable manifest is itself the broken installation being reported.
    return undefined;
  }
}

/**
 * How to reinstall the installed release. DocsFab installs from its exact
 * release tarball with lifecycle scripts off, so the step names that command
 * and never a registry package such as `docsfab@<version>`. DocsFab is not
 * published to the public registry: that command fails today, and once someone
 * registers the name it would run their install scripts. The tarball URL stays
 * a placeholder because only the operator's install record, or the package's
 * registry metadata, names it exactly.
 */
export function reinstallAction(packageRoot: URL = PACKAGE_ROOT): string {
  const version = installedVersion(packageRoot);
  return `Reinstall DocsFab${version === undefined ? "" : ` ${version}`} from its exact release tarball: run \`${REINSTALL_COMMAND}\`, as ${REINSTALL_GUIDE} describes.`;
}

/**
 * How to restore the packaged quality files after an integrity refusal. A
 * source checkout regenerates them from its canonical sources; a packed
 * install has none, so it reinstalls the same release.
 */
export function qualityPackRestoreAction(packageRoot: URL = PACKAGE_ROOT): string {
  const sourceCheckout =
    existsSync(new URL("src/launcher.ts", packageRoot)) &&
    existsSync(new URL("scripts/build-package.mjs", packageRoot));
  return sourceCheckout
    ? "Regenerate the quality pack from this checkout's sources: from the repository root, run `npm --prefix packages/runtime run build`, then run the command again."
    : `${reinstallAction(packageRoot)} Then run the command again.`;
}
