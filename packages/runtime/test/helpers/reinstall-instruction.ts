// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

/**
 * What every reinstall instruction a packed install prints must hold. The
 * documented install is the exact release tarball with lifecycle scripts off,
 * and the management guide's repair section shows it. A registry name would
 * resolve on the public registry, where DocsFab is not published, and would run
 * the install scripts of whoever registered it.
 */
export function expectTarballReinstall(instruction: string): void {
  expect(instruction).not.toContain("npm install --global docsfab@");
  expect(instruction).not.toMatch(/docsfab@/u);
  expect(instruction).not.toMatch(/npm (?:i|install|add)\b[^`]*\bdocsfab\b(?![-\w])/u);
  expect(instruction).toContain("--ignore-scripts");
  expect(instruction).toContain("tarball");
  expect(instruction).toContain("Repair an Installed Package");
  expect(instruction).toContain("docs/manage/update-or-uninstall.md");
  for (const [, command] of instruction.matchAll(/`([^`]+)`/gu)) {
    expect(command, "every command the instruction prints").toMatch(
      /^npm i -g --ignore-scripts --engine-strict '<[^'>]+>'$/u,
    );
  }
}
