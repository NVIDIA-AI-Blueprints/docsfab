#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
const received = [];
console.log("Session abcdefab-1234-5678-9012-abcdefabcdef");
process.stdout.write("You: ");
input.on("line", (line) => {
  received.push(line);
  if (line === "/exit") {
    writeFileSync(process.argv[process.argv.indexOf("--repo") + 1], JSON.stringify(received));
    input.close();
  } else {
    console.log("DocsFab: Synthetic answer.");
    process.stdout.write("You: ");
  }
});
