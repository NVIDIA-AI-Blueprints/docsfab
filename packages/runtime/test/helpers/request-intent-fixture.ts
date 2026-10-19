// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Independently authored request-intent proposals and the host inputs the
 * interpretation step will pass: the
 * operator's instruction, the tracked documentation inventory, the declared
 * operation, documentation roots, write scope and navigation set, existence
 * answers, and limits resolved through limit().
 */
import {
  admitRequestIntent,
  decodeRequestIntentProposal,
  requestIntentExistencePaths,
  resolveRequestIntentLimits,
  type RequestIntentAdmissionInput,
  type RequestIntentAdmissionResult,
  type RequestIntentExistenceAnswer,
  type RequestIntentExistenceKind,
  type RequestIntentLimits,
  type RequestIntentOperation,
  type RequestIntentPathScope,
} from "../../src/request-intent/index.js";

/** New parser examples; full original requests remain in internal qualifications. */
export const CREATE_INSTRUCTION =
  "Add an operator configuration guide for telemetryctl. Describe the configure command and its " +
  "saved settings for someone preparing a local report. Ground every technical detail in the repository sources.";

export const UPDATE_INSTRUCTION =
  "Refresh the configuration page so it is up to date with the current implementation, " +
  "retaining the existing troubleshooting advice and its stable anchor. " +
  "Keep unrelated documentation unchanged.";

export const INVENTORY = [
  "docs/cli.md",
  "docs/configuration.md",
  "docs/index.md",
  "docs/troubleshooting.md",
] as const;

export type Proposal = Record<string, unknown>;

export function createProposal(): Proposal {
  return {
    operation: "create",
    targets: [
      {
        path: "docs/telemetryctl-configuration.md",
        role: "write",
        chosenFrom: "proposed-new",
        quote: "Add an operator configuration guide for telemetryctl",
      },
    ],
    sources: [{ path: "src/cli/configure.ts", quote: "the configure command" }],
    preserve: [],
    exclusions: [],
    constraints: [
      {
        kind: "evidence-only",
        quote: "Ground every technical detail in the repository sources",
      },
    ],
    authorityPreference: {
      preference: "implementation",
      quote: "Ground every technical detail in the repository sources",
    },
  };
}

export function updateProposal(): Proposal {
  return {
    operation: "update",
    targets: [
      {
        path: "docs/configuration.md",
        role: "write",
        chosenFrom: "inventory",
        quote: "Refresh the configuration page",
      },
    ],
    sources: [],
    preserve: [
      {
        quote: "retaining the existing troubleshooting advice and its stable anchor",
      },
      { quote: "Keep unrelated documentation unchanged" },
    ],
    exclusions: [],
    constraints: [],
    authorityPreference: {
      preference: "implementation",
      quote: "up to date with the current implementation",
    },
  };
}

export function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: "Which page should link to the new configuration guide?",
    options: ["docs/cli.md", "docs/index.md"],
    recommendedDefault: "docs/cli.md",
    consequence: "DocsFab adds one link to the CLI page and changes nothing else there.",
    ...overrides,
  };
}

export function limits(): RequestIntentLimits {
  return resolveRequestIntentLimits();
}

/** The shipped producer's documentation roots, `docs/` and `fern/`, as typed root entries. */
export const DEFAULT_ROOTS: readonly RequestIntentPathScope[] = [
  { kind: "root", path: "docs" },
  { kind: "root", path: "fern" },
];

/**
 * A repository at the run's revision, as the collision oracle sees it:
 * tracked files, exact case, and the tracked files the run's update grant
 * does not cover.
 */
export interface RepositoryFixture {
  readonly tracked: readonly string[];
  readonly notGranted?: readonly string[];
}

/** The pilot repository: the inventory plus the pages and sources the shared rows name. */
export const PILOT_REPOSITORY: RepositoryFixture = {
  tracked: [...INVENTORY, "docs/x.md", "nav.json", "src/cli/configure.ts"],
};

/**
 * Everything the run passes besides the proposal, instruction and limits.
 * Existence answers come from `repository` through the same mapping the
 * interpretation step applies to the collision oracle, unless a row passes
 * `existence` itself to exercise a malformed answer list.
 */
export interface HostFixture {
  readonly declaredOperation: RequestIntentOperation;
  readonly repository: RepositoryFixture;
  readonly inventory: readonly string[];
  readonly docsRoot: readonly RequestIntentPathScope[];
  readonly grantedWriteScope: readonly RequestIntentPathScope[];
  readonly navigationSet: readonly string[];
  readonly existence?: readonly unknown[];
}

/** The pilot host for a declared operation; every field is stated, none defaulted by admission. */
export function pilotHost(
  declaredOperation: RequestIntentOperation,
  overrides: Partial<HostFixture> = {},
): HostFixture {
  return {
    declaredOperation,
    repository: PILOT_REPOSITORY,
    inventory: INVENTORY,
    docsRoot: DEFAULT_ROOTS,
    grantedWriteScope: DEFAULT_ROOTS,
    navigationSet: ["docs/index.md"],
    ...overrides,
  };
}

export const CREATE_HOST = pilotHost("create");
export const UPDATE_HOST = pilotHost("update");
export const REVIEW_HOST = pilotHost("review");

/**
 * The existence answer for `path`, mapped as the interpretation step maps a
 * `PlannedTargetCollisionV1`: the oracle folds with `toLowerCase`, a unique
 * exact-case tracked file is a `file` (or `file-not-granted` outside the
 * update grant), any other fold match is `case-fold`, then `directory`,
 * `parent-file`, and `absent`.
 */
export function existenceOf(
  path: string,
  repository: RepositoryFixture,
): RequestIntentExistenceKind {
  const fold = (value: string) => value.toLowerCase();
  const folded = fold(path);
  const matches = repository.tracked.filter((entry) => fold(entry) === folded);
  if (matches.length > 0) {
    if (matches.length === 1 && matches[0] === path) {
      return repository.notGranted?.includes(path) ? "file-not-granted" : "file";
    }
    return "case-fold";
  }
  if (repository.tracked.some((entry) => fold(entry).startsWith(`${folded}/`))) return "directory";
  const segments = folded.split("/");
  for (let end = segments.length - 1; end > 0; end -= 1) {
    const parent = segments.slice(0, end).join("/");
    if (repository.tracked.some((entry) => fold(entry) === parent)) return "parent-file";
  }
  return "absent";
}

export function existenceAnswers(
  paths: readonly string[],
  repository: RepositoryFixture,
): RequestIntentExistenceAnswer[] {
  return paths.map((path) => ({ path, existing: existenceOf(path, repository) }));
}

/** The full admission input for a host, with existence asked for the decoded proposal. */
export function admissionInput(
  instruction: string,
  host: HostFixture,
  asked: readonly string[],
  resolved: RequestIntentLimits = limits(),
): RequestIntentAdmissionInput {
  return {
    instruction,
    inventory: host.inventory,
    limits: resolved,
    declaredOperation: host.declaredOperation,
    docsRoot: host.docsRoot,
    grantedWriteScope: host.grantedWriteScope,
    navigationSet: host.navigationSet,
    existence: (host.existence ?? existenceAnswers(asked, host.repository)) as never,
  };
}

/** Decode, ask the repository about the write targets, then admit, as the interpretation step will. */
export function interpret(
  proposal: unknown,
  instruction: string,
  host: HostFixture,
  resolved: RequestIntentLimits = limits(),
): RequestIntentAdmissionResult {
  const decoded = decodeRequestIntentProposal(proposal, {
    instruction,
    limits: resolved,
  });
  if (decoded.outcome !== "decoded") return decoded;
  return admitRequestIntent(
    decoded,
    admissionInput(instruction, host, requestIntentExistencePaths(decoded), resolved),
  );
}

/** A copy with `edit` applied, so each case starts from the valid pilot shape. */
export function edited(base: Proposal, edit: (proposal: Proposal) => void): Proposal {
  const copy = structuredClone(base);
  edit(copy);
  return copy;
}
