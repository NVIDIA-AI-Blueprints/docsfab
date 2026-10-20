// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactReference } from "../artifacts/index.js";
import type { ProgressEvent } from "../records/contracts.js";
import type { WorkflowDefinition } from "../workflow-contracts/contracts.js";
import type { SiteBootstrapApplicationBundle } from "../site-bootstrap/index.js";
import {
  formatCliDuration,
  formatSectionHeader,
  indentCliBody,
  resolveCliFormatOptions,
} from "../operator/cli-format.js";

/**
 * Progress stream context. `workflow` is the already-resolved workflow the
 * runner executes, not a name to look up again: re-resolving would let an
 * unknown name throw at handler construction, before the run starts.
 */
export interface ProgressStreamContext {
  /** Enables the `<n>/<N>` segment of the in-flight TTY line when known. */
  workflow?: Pick<WorkflowDefinition, "steps">;
  /** Defaults to `process.stderr.isTTY`. */
  tty?: boolean;
  /** Defaults to `process.stderr.write`. */
  write?: (text: string) => void;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Milliseconds; defaults to 1000. */
  tickIntervalMs?: number;
}

export type PrintProgressHandler = ((event: ProgressEvent) => void) & {
  /**
   * Stops the tick timer and closes any open TTY in-flight line with a
   * newline, so later writes never land mid-line. Idempotent; call once the
   * run settles, including when it throws.
   */
  dispose: () => void;
};

const DEFAULT_TICK_INTERVAL_MS = 1000;

/**
 * `docsfab do` / `docsfab run` progress printer.
 *
 * Without ornaments (pipes, CI, `NO_COLOR`), it appends plain step lines with
 * no carriage return or tick. On a TTY it rewrites only the in-flight
 * "running" line with an elapsed tick; any other output first breaks that line
 * with a newline so it is never carriage-returned over, and completed history
 * is never rewritten. A blank line follows the last progress line.
 */
export function createPrintProgressHandler(
  verbose: boolean,
  context: ProgressStreamContext = {},
): PrintProgressHandler {
  const sink = context.write ?? ((text: string): void => void process.stderr.write(text));
  const now = context.now ?? (() => Date.now());
  const tickIntervalMs = context.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const formatOptions = {
    tty: context.tty ?? Boolean(process.stderr.isTTY),
  };
  const { ornaments } = resolveCliFormatOptions(formatOptions);

  const stepIndexById = new Map<string, number>();
  const steps = context.workflow?.steps;
  if (steps) {
    steps.forEach((step, index) => stepIndexById.set(step.id, index));
  }
  const totalSteps = steps?.length;

  let inFlightStepId: string | undefined;
  let inFlightStartedAt: number | undefined;
  let inFlightLineOpen = false;
  let inFlightLineWidth = 0;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let emittedHeader = false;
  let wroteFooterGap = false;

  const ensureHeader = (): void => {
    if (emittedHeader) return;
    sink(`\n${formatSectionHeader("PROGRESS", formatOptions)}\n`);
    emittedHeader = true;
  };

  const writeFooterGap = (): void => {
    if (wroteFooterGap) return;
    sink("\n");
    wroteFooterGap = true;
  };

  const clearTick = (): void => {
    if (tickTimer !== undefined) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };

  const idSegment = (stepId: string): string => {
    const index = stepIndexById.get(stepId);
    if (index !== undefined && totalSteps !== undefined) {
      return `${index + 1}/${totalSteps}  ${stepId}`;
    }
    return stepId;
  };

  const runningLineText = (stepId: string, elapsedMs: number): string =>
    indentCliBody(`step ${idSegment(stepId)}  running  ${formatCliDuration(elapsedMs)}`);

  const redraw = (text: string): void => {
    const pad = inFlightLineWidth > text.length ? " ".repeat(inFlightLineWidth - text.length) : "";
    sink(`\r${text}${pad}`);
    inFlightLineWidth = text.length;
  };

  const breakInFlightLine = (): void => {
    clearTick();
    if (!inFlightLineOpen) return;
    sink("\n");
    inFlightLineOpen = false;
    inFlightStepId = undefined;
    inFlightStartedAt = undefined;
    inFlightLineWidth = 0;
  };

  const handler = ((event: ProgressEvent): void => {
    if (!ornaments) {
      if (event.type === "text") {
        if (!verbose) return;
        sink(event.text);
        return;
      }
      ensureHeader();
      if (event.type === "run-status") {
        sink(`${indentCliBody(`run ${event.runId}: ${event.status}`)}\n`);
        if (event.status !== "running") writeFooterGap();
        return;
      }
      if (event.type === "artifact-reference") {
        sink(
          `${indentCliBody(`artifact ${event.artifact.reference.kind}:${event.artifact.reference.digest} (${event.artifact.role})`)}\n`,
        );
        return;
      }
      sink(`${indentCliBody(`step ${event.stepId}: ${event.status}`)}\n`);
      return;
    }

    if (event.type === "text") {
      if (!verbose) return;
      breakInFlightLine();
      sink(event.text);
      return;
    }
    ensureHeader();
    if (event.type === "run-status") {
      breakInFlightLine();
      sink(`${indentCliBody(`run ${event.runId}: ${event.status}`)}\n`);
      if (event.status !== "running") writeFooterGap();
      return;
    }
    if (event.type === "artifact-reference") {
      breakInFlightLine();
      sink(
        `${indentCliBody(`artifact ${event.artifact.reference.kind}:${event.artifact.reference.digest} (${event.artifact.role})`)}\n`,
      );
      return;
    }

    // event.type === "step-status"
    if (event.status === "running") {
      breakInFlightLine();
      inFlightStepId = event.stepId;
      inFlightStartedAt = now();
      inFlightLineWidth = 0;
      const text = runningLineText(event.stepId, 0);
      sink(`\r${text}`);
      inFlightLineWidth = text.length;
      inFlightLineOpen = true;
      tickTimer = setInterval(() => {
        if (!inFlightLineOpen || inFlightStepId === undefined || inFlightStartedAt === undefined) {
          return;
        }
        redraw(runningLineText(inFlightStepId, now() - inFlightStartedAt));
      }, tickIntervalMs);
      tickTimer.unref?.();
      return;
    }

    // Rewrite in place only if the line is still open for this step; if
    // something already broke it into history, append instead.
    if (inFlightLineOpen && inFlightStepId === event.stepId) {
      const elapsedMs = inFlightStartedAt !== undefined ? now() - inFlightStartedAt : 0;
      clearTick();
      redraw(
        indentCliBody(
          `step ${idSegment(event.stepId)}  ${event.status}  ${formatCliDuration(elapsedMs)}`,
        ),
      );
      sink("\n");
      inFlightLineOpen = false;
      inFlightStepId = undefined;
      inFlightStartedAt = undefined;
      inFlightLineWidth = 0;
      return;
    }
    sink(`${indentCliBody(`step ${idSegment(event.stepId)}  ${event.status}`)}\n`);
  }) as PrintProgressHandler;

  handler.dispose = (): void => {
    breakInFlightLine();
    if (ornaments && emittedHeader) writeFooterGap();
  };

  return handler;
}

export function artifactReference(
  plan: SiteBootstrapApplicationBundle["plan"],
): ArtifactReference<"ia-plan"> {
  return {
    kind: "ia-plan",
    schemaVersion: plan.schemaVersion,
    digest: plan.digest,
    repositoryRevision: plan.repository.revision,
    repositoryContentDigest: plan.repository.contentDigest,
  };
}
