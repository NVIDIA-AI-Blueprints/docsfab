// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { registerContentIrScenarios } from "./content-ir.scenarios.js";

// These small examples were authored independently for portable parser behavior.
registerContentIrScenarios({
  poisonRelativePath: "examples/fixtures/repeated-labels",
  directiveHeading: "Report details",
  directiveAnchor: "report-details",
  standaloneAnchor: "unattached-advice",
  fixtures: resolve(import.meta.dirname, "fixtures/public-runtime/content-ir"),
  contentDigest: "1aebaaa362b04a225fb32bf24a8edee8407e75a00b1f03de78caa9cf8cba69fb",
  indexDigest: "78db1323e37dcbffd74fcd273ffd1c90ac1206224b9cbe8eeef8c86a14b8ec29",
  changeHeading: "Example changes",
  changeAnchor: "example-changes",
  changeBody: "A small report begins here.",
  excludedText: [
    "PUBLIC_BODY_SENTINEL",
    "Example catalog title",
    "illustrativeValue",
    "https://example.test/manual",
    "Example start label",
    "Example guide label",
    "non-document-target",
  ],
});
