// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Display-only actions. Selecting or rendering one never authorizes execution. */
export type PresentationAction = (
  | {
      readonly kind: "argv";
      readonly label: string;
      readonly executable: string;
      readonly args: readonly string[];
    }
  | { readonly kind: "link"; readonly label: string; readonly href: string }
  | { readonly kind: "instruction"; readonly text: string }
  | { readonly kind: "decision"; readonly label: string; readonly reference: string }
) & { readonly stream?: PresentationStream };

export type PresentationEvidence<T> =
  | { readonly state: "known"; readonly value: T }
  | { readonly state: "unknown"; readonly explanation?: string };

export type PresentationDetail = "quiet" | "normal" | "verbose";
export type PresentationImportance = "ordinary" | "material";
export type PresentationStream = "stdout" | "stderr";

export interface PresentationField<T = string> {
  readonly label: string;
  readonly evidence: PresentationEvidence<T>;
  readonly detail?: PresentationDetail;
  readonly importance?: PresentationImportance;
  readonly stream?: PresentationStream;
}

export interface PresentationAttention {
  readonly message: string;
  readonly details?: readonly PresentationField[];
  readonly stream?: PresentationStream;
}

export interface PresentationSection {
  readonly title: string;
  readonly fields?: readonly PresentationField[];
  readonly text?: readonly string[];
  readonly actions?: readonly PresentationAction[];
  readonly detail?: PresentationDetail;
  readonly importance?: PresentationImportance;
  readonly stream?: PresentationStream;
}

export interface ResultPresentationFacts {
  readonly title: string;
  readonly outcome: PresentationField;
  readonly scope?: PresentationField;
  readonly statusPlanes?: readonly PresentationField[];
  readonly summary?: string;
  readonly effects?: readonly PresentationField[];
  readonly limitations?: readonly PresentationField[];
  readonly sections?: readonly PresentationSection[];
  readonly primaryAction?: PresentationAction;
  readonly artifacts?: readonly PresentationAction[];
  readonly nextActions?: readonly PresentationAction[];
  /** The domain producer decides whether attention is material. */
  readonly attention: PresentationAttention | null;
}

export interface InspectionPresentationFacts {
  readonly title: string;
  readonly subject: PresentationEvidence<string>;
  readonly findings: readonly PresentationField[];
  readonly sections?: readonly PresentationSection[];
  readonly actions?: readonly PresentationAction[];
  readonly attention: PresentationAttention | null;
}

export interface CollectionPresentationFacts {
  readonly title: string;
  readonly entries: readonly PresentationField[];
  readonly sections?: readonly PresentationSection[];
  readonly actions?: readonly PresentationAction[];
  readonly attention: PresentationAttention | null;
}

export interface DecisionPresentationFacts {
  readonly title: string;
  readonly question: string;
  readonly choices: readonly PresentationField[];
  readonly selected?: PresentationEvidence<string>;
  readonly actions?: readonly PresentationAction[];
  readonly attention: PresentationAttention | null;
}

export interface ActivityPresentationFacts {
  readonly title: string;
  readonly events: readonly {
    readonly identity: string;
    readonly phase: string;
    readonly message: string;
    readonly observedWait?: boolean;
    readonly occurredAt?: PresentationEvidence<string>;
    readonly importance?: PresentationImportance;
    readonly detail?: PresentationDetail;
    readonly stream?: PresentationStream;
  }[];
  readonly sections?: readonly PresentationSection[];
  readonly actions?: readonly PresentationAction[];
  readonly attention: PresentationAttention | null;
}

export type PresentationRow = (
  | { readonly kind: "attention"; readonly message: string }
  | { readonly kind: "summary"; readonly text: string }
  | { readonly kind: "section"; readonly title: string }
  | {
      readonly kind: "field";
      readonly label: string;
      readonly evidence: PresentationEvidence<string>;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "action"; readonly action: PresentationAction }
  | {
      readonly kind: "activity";
      readonly identity: string;
      readonly phase: string;
      readonly message: string;
      readonly observedWait: boolean;
      readonly occurredAt?: PresentationEvidence<string>;
    }
) & { readonly stream?: PresentationStream };

export interface PresentationDocument {
  readonly title: string;
  readonly attention: PresentationAttention | null;
  readonly rows: readonly PresentationRow[];
  readonly actions: readonly PresentationAction[];
}
