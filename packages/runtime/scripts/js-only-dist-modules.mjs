// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * JavaScript-only modules that `tsc` does not emit. Package build and every
 * isolation fixture that copies `tsc` output must copy this same set so
 * compiled `limits.js` can import `./limit-resolution.js`.
 */
export const JS_ONLY_DIST_MODULES = Object.freeze([
  ["quality-pack", "resource-roles.js"],
  ["quality-pack", "resource-roles.d.ts"],
  // Unstamped here; `build-package.mjs` then overwrites the dist copy.
  ["build-identity.js"],
  ["build-identity.d.ts"],
  ["reader-task-transport.js"],
  ["reader-task-transport.d.ts"],
  ["candidate-source-manifest.js"],
  ["candidate-source-manifest.d.ts"],
  ["repository", "probe-selectors.js"],
  ["repository", "probe-selectors.d.ts"],
  ["security", "credential-material-core.js"],
  ["security", "credential-material-core.d.ts"],
  // The model-credential release path; probe-core loads it under plain `node`.
  ["security", "model-credential-release.js"],
  ["security", "model-credential-release.d.ts"],
  // Shared credential shapes; scripts/docsfab-preflight.mjs loads it under plain `node`.
  ["security", "text-credential-shapes.js"],
  ["security", "text-credential-shapes.d.ts"],
  ["config", "limit-resolution.js"],
  ["config", "limit-resolution.d.ts"],
  ["config", "executable-route-urls.js"],
  ["config", "executable-route-urls.d.ts"],
  ["config", "private-route-urls.js"],
  ["config", "private-route-urls.d.ts"],
  ["config", "private-content-paths.js"],
  ["config", "private-content-paths.d.ts"],
  ["config", "internal-content.js"],
  ["config", "internal-content.d.ts"],
  ["model-composition", "installed-manifest-pin.js"],
  ["model-composition", "installed-manifest-pin.d.ts"],
  ["operator", "display-sanitize.js"],
  ["operator", "display-sanitize.d.ts"],
  // Dependency-free response-contract key sets, shared with the
  // derived-product generator that runs before `npm ci`.
  ["execution", "response-contract-keys.js"],
  ["execution", "response-contract-keys.d.ts"],
  // The serving-route probe stack; the model-matrix scripts load it under plain `node`.
  ["profile", "probe-core.js"],
  ["profile", "probe-core.d.ts"],
]);

export async function copyJsOnlyDistModules(projectRoot, outputDirectory) {
  await Promise.all(
    JS_ONLY_DIST_MODULES.map(async (parts) => {
      const destination = join(outputDirectory, ...parts);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(projectRoot, "src", ...parts), destination);
    }),
  );
}
