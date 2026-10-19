// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listTemplates } from "./catalog.js";
import { previewSite } from "./preview.js";
import { scaffoldPage, scaffoldSite } from "./scaffold.js";
import { validatePage } from "./validate.js";

/** Stable harness-facing operation names for the template set surface. */
export const template = Object.freeze({
  list: listTemplates,
  previewSite,
  scaffoldSite,
  scaffoldPage,
  validatePage,
});

export { listTemplates, previewSite, scaffoldSite, scaffoldPage, validatePage };
