// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OperatorOutputCoordinator,
  PresentationProgressHandle,
  PresentationProgressUpdate,
} from "../../operator/index.js";
import { createPrintProgressHandler, type PrintProgressHandler } from "../progress.js";
import type { ProgressEvent } from "../../records/contracts.js";
import type { WorkflowDefinition } from "../../workflow-contracts/contracts.js";

export type RunOutputStream = "stdout" | "stderr";
type ProgressHandlerFactory = (
  verbose: boolean,
  workflow: WorkflowDefinition,
) => PrintProgressHandler;

interface PendingProgressEvent {
  readonly event: ProgressEvent;
  readonly workflow: WorkflowDefinition;
}

/**
 * CLI adapter for the invocation output contract. Complete messages interrupt
 * an open progress line before they are written, and the host-owned progress
 * renderer is disposed when the invocation settles or throws.
 */
export class RunInvocationOutputCoordinator implements OperatorOutputCoordinator {
  private activeProgress: PresentationProgressHandle | undefined;
  private progressHandler: PrintProgressHandler | undefined;
  private pendingProgress: PendingProgressEvent | undefined;

  public constructor(
    private readonly writeOutput: (stream: RunOutputStream, message: string) => void,
    private readonly verbose: boolean,
    private readonly createProgressHandler: ProgressHandlerFactory = (verbose, workflow) =>
      createPrintProgressHandler(verbose, { workflow }),
  ) {}

  public writeMessage(stream: RunOutputStream, completeMessage: string): void {
    this.progressHandler?.dispose();
    this.progressHandler = undefined;
    this.writeOutput(stream, completeMessage);
  }

  public startProgress(_initial: PresentationProgressUpdate): PresentationProgressHandle {
    const handle = { id: Symbol("run-progress") };
    this.activeProgress = handle;
    return handle;
  }

  public updateProgress(
    handle: PresentationProgressHandle,
    _update: PresentationProgressUpdate,
  ): void {
    if (this.activeProgress?.id !== handle.id || this.pendingProgress === undefined) return;
    const { event, workflow } = this.pendingProgress;
    this.pendingProgress = undefined;
    this.progressHandler ??= this.createProgressHandler(this.verbose, workflow);
    this.progressHandler(event);
  }

  public finalizeProgress(handle: PresentationProgressHandle): void {
    if (this.activeProgress?.id !== handle.id) return;
    this.progressHandler?.dispose();
    this.progressHandler = undefined;
    this.activeProgress = undefined;
    this.pendingProgress = undefined;
  }

  public dispose(): void {
    if (this.activeProgress !== undefined) this.finalizeProgress(this.activeProgress);
    else this.progressHandler?.dispose();
    this.progressHandler = undefined;
    this.pendingProgress = undefined;
  }

  public forwardProgressEvent(
    handle: PresentationProgressHandle | undefined,
    event: ProgressEvent,
    workflow: WorkflowDefinition,
  ): void {
    if (handle === undefined || this.activeProgress?.id !== handle.id) return;
    this.pendingProgress = { event, workflow };
    this.updateProgress(handle, { message: progressUpdateMessage(event) });
  }
}

function progressUpdateMessage(event: ProgressEvent): string {
  switch (event.type) {
    case "run-status":
      return `run ${event.status}`;
    case "step-status":
      return `step ${event.stepId} ${event.status}`;
    case "artifact-reference":
      return "artifact reference";
    case "text":
      return "step progress text";
  }
}
