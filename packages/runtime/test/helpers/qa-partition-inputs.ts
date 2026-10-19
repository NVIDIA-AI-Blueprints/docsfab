// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface QaPartitionInputs {
  readonly fixtureRoot: string;
  readonly repositoryDirectory: string;
  readonly cliSourcePath: string;
  readonly sourceDigestKey: string;
  readonly exportDigestKey: string;
  readonly currentName: string;
  readonly oldName: string;
  readonly exampleName: string;
  readonly command: string;
  readonly continuationPage: string;
  readonly messageDeclaration: string;
  readonly exampleMessage: string;
  readonly changedExampleMessage: string;
  readonly presentationEndLine: number;
  readonly serializerLines: string;
  readonly conflictingServicePort: string;
  readonly portFiles: Readonly<Record<string, string>>;
  readonly portDeclaration: string;
  readonly portSource: string;
  readonly suiteLabel: string;
  readonly exportLineEnd: number;
  readonly exportFunction: string;
  readonly exportDocumentation: string;
  readonly exportUsage: string;
  readonly exportDeclaration: string;
  readonly exportImplementation: string;
  readonly exportError: string;
}

export const PUBLIC_QA_INPUTS: Omit<QaPartitionInputs, "fixtureRoot"> = {
  repositoryDirectory: "receipt",
  cliSourcePath: "src/report.mjs",
  sourceDigestKey: "sourceSha256",
  exportDigestKey: "exportSourceSha256",
  currentName: "reader",
  oldName: "visitor",
  exampleName: "Receipt Tool",
  command: "report",
  continuationPage: "docs/receipt.md",
  messageDeclaration: "const message = `Report for ${name}.`;",
  exampleMessage: "Report for Ada.",
  changedExampleMessage: "Report for Kai.",
  presentationEndLine: 8,
  serializerLines: "13-14",
  conflictingServicePort:
    "Revise the deployment guide and the operations guide to state the listening port and show a health check. Review the repository evidence and resolve conflicts before choosing a value. Ask one focused question if the evidence cannot settle it, and retain the deployment procedure meanwhile.",
  portFiles: {
    "docs/deployment.md": "# Local deployment\n\nStart the example report service.\n",
    "docs/operations.md":
      "# Service operations\n\nUse systemctl restart api to restart this example.\n",
    "deploy.yaml": "service:\n  name: report\n  replicas: 2\n  port: 9090\n",
    "src/server.ts":
      "// Port selected by the report listener.\nexport const listenerPort = 8088;\n",
  },
  portDeclaration: "export const listenerPort = 8088;",
  portSource: "// Port selected by the report listener.\nexport const listenerPort = 8088;",
  suiteLabel: "independently authored public support records",
  exportLineEnd: 11,
  exportFunction: "renderReceipt",
  exportDocumentation: "Receipt helper: persists a receipt on disk.",
  exportUsage: "Usage: receipt-export PATH [text|json]",
  exportDeclaration:
    "export function renderReceipt(path: string, mode: 'text' | 'json' = 'text'): string {",
  exportImplementation:
    "return mode === 'json' ? JSON.stringify({ destination: path }) : `destination=${path}`;",
  exportError: "A receipt path is required.",
};
