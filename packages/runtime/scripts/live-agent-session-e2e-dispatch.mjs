// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function classifyInstalledSessionRequest(
  payload,
  { installedTaskPrompt, savedRunPrompt, liveWorkflowPublicationPrompt },
) {
  const serializedMessages = JSON.stringify(payload.messages ?? []);
  if (serializedMessages.includes(installedTaskPrompt)) return "installed-bounded-task";
  if (serializedMessages.includes(savedRunPrompt)) return "saved-run-recovery";
  if (
    serializedMessages.includes(liveWorkflowPublicationPrompt) &&
    payload.tools?.some((tool) => tool?.function?.name === "docsfab_publish_workflow")
  )
    return "live-workflow-publication-session";
  return undefined;
}
