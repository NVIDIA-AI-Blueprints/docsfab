// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const supportedVersion = "4.1.11";
const installed = Symbol.for("docsfab.vitest.coverage-module-offset");

/**
 * Backport the eager execution metadata initialization from Vitest #10643.
 * This uses private Vitest evaluator/debug APIs and must not patch other
 * versions without review. Remove it after upgrading to a release containing
 * that fix and passing the pending-import coverage regression.
 *
 * https://github.com/vitest-dev/vitest/pull/10643
 */
export function installCoverageModuleOffset({ coverage, version, Evaluator }) {
  if (!coverage?.enabled || coverage.provider !== "v8") return false;
  if (version !== supportedVersion) {
    throw new Error(
      `DocsFab V8 coverage compatibility hook requires Vitest ${supportedVersion}; found ${version}. ` +
        "Review the upstream #10643 fix and remove or explicitly update this hook before collecting coverage.",
    );
  }
  const proto = Evaluator === undefined || Evaluator === null ? undefined : Evaluator.prototype;
  if (typeof proto?._runInlinedModule !== "function") {
    throw new Error("DocsFab V8 coverage compatibility hook: unsupported Vitest evaluator API.");
  }
  if (Object.hasOwn(proto, installed)) return false;

  const runInlinedModule = proto._runInlinedModule;
  const initialized = new WeakSet();
  proto._runInlinedModule = function (...args) {
    if (!initialized.has(this)) {
      const evaluator = this;
      const start = this.debug?.startCalculateModuleExecutionInfo;
      if (
        typeof start !== "function" ||
        typeof this.options?.moduleExecutionInfo?.set !== "function"
      ) {
        throw new Error("DocsFab V8 coverage compatibility hook: unsupported Vitest metadata API.");
      }
      this.debug.startCalculateModuleExecutionInfo = function (filename, options) {
        // The evaluator supplies the actual wrapper length. Record it before
        // evaluation can suspend in an import; normal completion replaces the
        // zero durations with Vitest's measured execution information.
        if (options.external !== true) {
          evaluator.options.moduleExecutionInfo.set(filename, {
            duration: 0,
            selfTime: 0,
            startOffset: options.startOffset,
            importer: options.importer,
          });
        }
        return start.call(this, filename, options);
      };
      initialized.add(this);
    }
    return runInlinedModule.apply(this, args);
  };
  Object.defineProperty(proto, installed, { value: true });
  return true;
}
