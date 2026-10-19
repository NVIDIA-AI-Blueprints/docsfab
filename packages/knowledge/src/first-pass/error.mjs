// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Typed refusal for ordinary first-pass support and partial classification.
 *
 * A refusal of a model phase's answer also carries `corrections`: how many
 * hinted correction rounds that phase spent before this refusal.
 */
export class FirstPassSupportError extends Error {
  constructor(code, message, details = [], diagnostic) {
    super(message);
    this.name = "FirstPassSupportError";
    this.code = code;
    this.details = Object.freeze(details.map((item) => Object.freeze({ ...item })));
    if (diagnostic) {
      this.phase = diagnostic.phase;
      this.rule = diagnostic.rule;
      this.location = diagnostic.location;
    }
  }
}
