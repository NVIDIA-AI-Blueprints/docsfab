// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PresentationStream } from "./types.js";

export interface PresentationProgressHandle {
  readonly id: symbol;
}

export interface PresentationProgressUpdate {
  readonly message: string;
  readonly phase?: "started" | "running" | "waiting" | "completed" | "failed";
}

/** Host-owned output seam. Implementations must write each message atomically. */
export interface OperatorOutputCoordinator {
  writeMessage(stream: PresentationStream, completeMessage: string): void | Promise<void>;
  startProgress(initial: PresentationProgressUpdate): PresentationProgressHandle;
  updateProgress(handle: PresentationProgressHandle, update: PresentationProgressUpdate): void;
  finalizeProgress(
    handle: PresentationProgressHandle,
    finalUpdate?: PresentationProgressUpdate,
  ): void;
  dispose(): void | Promise<void>;
}

export async function writeRenderedPresentation(
  coordinator: OperatorOutputCoordinator,
  output: { readonly stdout: string; readonly stderr: string },
): Promise<void> {
  if (output.stdout.length > 0) await coordinator.writeMessage("stdout", output.stdout);
  if (output.stderr.length > 0) await coordinator.writeMessage("stderr", output.stderr);
}

/** Dispose the host coordinator on both success and failure; machine serializers bypass this helper. */
export async function withOutputCoordinator<T>(
  coordinator: OperatorOutputCoordinator,
  operation: (
    coordinator: OperatorOutputCoordinator,
    progress?: PresentationProgressHandle,
  ) => T | Promise<T>,
  initialProgress?: PresentationProgressUpdate,
): Promise<T> {
  let progress: PresentationProgressHandle | undefined;
  let result!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    if (initialProgress !== undefined) progress = coordinator.startProgress(initialProgress);
    result = await operation(coordinator, progress);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  if (progress !== undefined) {
    try {
      coordinator.finalizeProgress(
        progress,
        operationFailed
          ? { phase: "failed", message: "Activity ended after an error." }
          : undefined,
      );
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }
  try {
    await coordinator.dispose();
  } catch (error) {
    if (!cleanupFailed) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }

  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
  return result;
}
