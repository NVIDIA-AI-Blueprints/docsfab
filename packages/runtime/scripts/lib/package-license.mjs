// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";

/**
 * Repository-root license files copied into the npm package. Both contain
 * the approved dual-license template: Apache-2.0 for source code and
 * CC-BY-4.0 for skill instructions, documentation, and assets.
 */
export const PACKAGE_LICENSE_FILES = Object.freeze(["LICENSE", "LICENSE-CC-BY-4.0"]);

/** Materialize the accepted repository license in the package before npm pack. */
export async function materializePackageLicense(sourcePath, packageLicensePath) {
  const acceptedLicense = await readFile(sourcePath);
  await writeFile(packageLicensePath, acceptedLicense);
}

/** Materialize the accepted repository NOTICE in the package before npm pack. */
export async function materializePackageNotice(sourcePath, packageNoticePath) {
  await writeFile(packageNoticePath, await readFile(sourcePath));
}
