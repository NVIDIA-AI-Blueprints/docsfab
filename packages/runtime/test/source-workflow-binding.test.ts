// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CLI_SOURCE_READ_SCOPE,
  CLI_SOURCE_READ_SKILLS,
  resolveCliChangeRequestEvidenceFromSelector,
  resolveCliChangeRequestSourceEvidence,
  resolveCliGitLabMrSourceEvidence,
} from "../src/cli/run/source-acquisition.js";
import { handleDoCommand, parseDoArguments } from "../src/cli/commands/do.js";
import { parseLiveAgentArguments } from "../src/cli/commands/live-agent.js";
import { liveAgentWorkflowRunRequest, runBoundedWorkflow } from "../src/live-agent/host.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import type { ChangeRequestSelectorV1 } from "../src/inputs/change-request-selector.js";
import { SOURCE_REQUEST_PROJECTED_FIELDS } from "../src/inputs/source-evidence.js";
import { openExternalInputAccessCapture } from "../src/inputs/access.js";
import {
  canonicalGitlabMrReviewLocator,
  digestGitlabMrReviewLocator,
} from "../src/inputs/gitlab-mr-locator.js";
import {
  createGitLabMrPageSourceReader,
  createGitLabMrReadSourceReader,
  GITLAB_READ_FAILURES,
  GITLAB_READ_TEXT_LIMIT,
  GitLabSourceProviderError,
  resolveGitLabAcquisitionScope,
  resolveGitLabSourceScope,
  type GitLabAcquisitionScopeV1,
  type GitLabMrProjectionV1,
  type GitLabMrSourceReaderV1,
  type GitLabProjectIdentityPortV1,
} from "../src/inputs/gitlab-source-provider.js";
import { gitlabMergedMrDiffExtractorAdapter } from "../src/inputs/merged-mr-evidence.js";
import type { MergedMrPagePortV1, MergedMrPageV1 } from "../src/inputs/merged-mr-discovery.js";
import {
  acquireGitLabMrSourceBinding,
  digestGitLabMrProducerScope,
  GitLabSourceAcquisitionError,
  GITLAB_MR_SOURCE_PRODUCER_ID,
  GITLAB_SOURCE_ACQUISITION_REFUSAL_CODES,
  GITLAB_SOURCE_ACQUISITION_REFUSALS,
  type AcquiredGitLabMrSourceBindingV1,
} from "../src/inputs/source-acquisition-gitlab.js";
import type { CommandRunner } from "../src/init/types.js";
import { SOURCE_DISCOVERY_REFUSALS } from "../src/inputs/source-discovery.js";
import { DEFAULT_SOURCE_EXTRACTOR_ADAPTERS } from "../src/inputs/source-extractor-registry.js";
import {
  digestSourceProducerScopes,
  projectSourceRequestContext,
  selectSourceRequestProjectionVersion,
  SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS,
  type SourceBindingV1,
} from "../src/inputs/source-evidence.js";
import { createSourceArtifactReference } from "../src/inputs/source-evidence-artifacts.js";
import {
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  SourceEvidenceServiceError,
  type SourceEvidenceServiceErrorCode,
} from "../src/inputs/source-resolver.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { RunRecord } from "../src/records/contracts.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const fixtureRoots = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

/**
 * Date-scoped UPDATE source-workflow binding.
 *
 * GitLab MR diffs are not a `--source` media type. They are acquired as
 * process-local observations and handed to plan, write, and verify through
 * the existing `sourceBinding` + `docsfab_read_source` tools. UPDATE fields
 * (`readerTaskContext`, `editorialEvidenceRefs`) are versioned in
 * `projectSourceRequestContext`, so an UPDATE request selects projection
 * version 2 instead of failing closed as `projection-unversioned`.
 */
describe("merged-MR UPDATE source-workflow binding (#896)", () => {
  it("keeps GitLab MR diffs off the --source extractor registry", () => {
    expect(gitlabMergedMrDiffExtractorAdapter.mediaTypes).toEqual(["text/plain"]);
    expect(
      DEFAULT_SOURCE_EXTRACTOR_ADAPTERS.some(
        (adapter) => adapter.id === gitlabMergedMrDiffExtractorAdapter.id,
      ),
    ).toBe(false);
  });

  it("admits audit, plan, review, write, and verify skills to read bound changes", () => {
    expect(CLI_SOURCE_READ_SKILLS).toEqual([
      "audit-documentation",
      "plan-documentation",
      "review-documentation",
      "verify-technical-accuracy",
      "write-documentation",
    ]);
  });

  it("selects source-request projection version 2 for an UPDATE request carrying reader fields", () => {
    expect(SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS).toEqual([
      "readerContextInput",
      "readerTaskContext",
      "readerContext",
      "readerContextProvenance",
      "editorialEvidenceRefs",
    ]);
    expect(
      selectSourceRequestProjectionVersion({
        workflow: "update-documentation",
        allowWrite: true,
        readerTaskContext: { schemaVersion: 1 },
      }),
    ).toBe(2);
    expect(
      selectSourceRequestProjectionVersion({
        workflow: "create-documentation",
        allowWrite: true,
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Merged GitLab MR acquisition through the shared producer.
//
// Every fixture below diverges on identity: the two selected merge requests
// carry different numbers, different commit shas, different branches and
// different bodies, and they arrive on different pages. An identity collision
// therefore cannot make a passing assertion, which is the failure mode these
// tests exist to rule out.
// ---------------------------------------------------------------------------

const HOST = "gitlab.example.test";
const PROJECT_ID = 437_040;
const PROJECT_PATH = "tech-docs/agents/docsfab";
const REPOSITORY_SOURCE_PATH = "/tmp/gitlab-mr-acquisition-fixture";
const REVISION = "c".repeat(40);
const REPOSITORY = Object.freeze({
  identitySha256: createHash("sha256").update(REPOSITORY_SOURCE_PATH).digest("hex"),
  revision: REVISION,
});
const RUN_ID = "gitlab-mr-acquisition-run";
const RUN_ID_SHA = createHash("sha256").update(RUN_ID, "utf8").digest("hex");
const REQUEST_SHA = createHash("sha256").update("gitlab-mr-request", "utf8").digest("hex");
const POLICY_SHA = createHash("sha256").update("gitlab-mr-policy", "utf8").digest("hex");
const OBSERVED_AT = "2026-09-17T09:00:00.000Z";

/**
 * The acquisition scope every case below uses.
 *
 * Minted through the shipped resolver rather than written as an object
 * literal, because an acquisition scope is branded: only
 * `resolveGitLabAcquisitionScope` can produce one, and a literal — however
 * correctly shaped — is refused.
 */
let SCOPE: GitLabAcquisitionScopeV1;

beforeAll(async () => {
  SCOPE = await resolveGitLabAcquisitionScope({
    reference: { host: HOST, projectId: PROJECT_ID, projectPath: PROJECT_PATH },
    identityPort: {
      async resolveProjectIdentity(reference) {
        return { host: reference.host, projectId: PROJECT_ID, projectPath: reference.projectPath };
      },
    },
  });
});

/** Page one's merge request. Distinct number, branch, sha and body from page two's. */
const MR_PAGE_ONE: GitLabMrProjectionV1 = Object.freeze({
  iid: 804,
  url: `https://${HOST}/${PROJECT_PATH}/-/merge_requests/804`,
  title: "Complete instruction-only merged-MR UPDATE live proof",
  description: "Page-one body: the reader budget is now bounded per file.",
  state: "merged",
  mergedAt: "2026-09-16T11:30:00Z",
  targetBranch: "main",
  sourceBranch: "swarm/896-live-proof",
  mergeCommitSha: "1".repeat(40),
  squashCommitSha: null,
  textTruncated: false,
});

/** Page two's merge request. Everything identifying differs from page one's. */
const MR_PAGE_TWO: GitLabMrProjectionV1 = Object.freeze({
  iid: 742,
  url: `https://${HOST}/${PROJECT_PATH}/-/merge_requests/742`,
  title: "Version the source request projection",
  description: "Page-two body: v2 adds the five reader and editorial fields.",
  state: "merged",
  mergedAt: "2026-09-15T08:05:00Z",
  targetBranch: "release/v1",
  sourceBranch: "codex/798-a-projection",
  mergeCommitSha: null,
  squashCommitSha: "2".repeat(40),
  textTruncated: false,
});

/**
 * A credential-shaped merge-request body.
 *
 * This literal never leaves this file. Writing a value of this shape into a
 * GitLab description, note or MR field wedges the forge poller permanently,
 * so the fixture is assembled from fragments and asserted on here only.
 *
 * Only one of DocsFab's own configured credentials is refused (#1807): tests
 * configure CONFIGURED_TOKEN before they plant it, and SHAPED_TOKEN, of the
 * same shape but never configured, binds like any other body.
 */
const credentialDescription = (token: string) => ["Authorization:", "Bearer", token].join(" ");
const CONFIGURED_TOKEN = ["glpat", plantedCredentialValue(75, 24)].join("-");
const SHAPED_TOKEN = ["glpat", plantedCredentialValue(76, 24)].join("-");

function projection(overrides: Partial<GitLabMrProjectionV1> = {}): GitLabMrProjectionV1 {
  return Object.freeze({ ...MR_PAGE_ONE, ...overrides });
}

/**
 * A `glab api` stand-in for driving the shipped `get` reader.
 *
 * It answers with a raw GitLab body, exactly as the real command would, so
 * everything between the endpoint and the projection — the clip, the
 * truncation flag, the credential screen — is the shipped code under test
 * rather than something the fixture pre-computed.
 */
function glabStub(body: unknown): { commands: CommandRunner; endpoints: string[] } {
  const endpoints: string[] = [];
  return {
    endpoints,
    commands: {
      async run(_command, args) {
        endpoints.push(String(args.at(-1)));
        return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
      },
    } as CommandRunner,
  };
}

/** The shipped `get`-backed reader over a stubbed transport. */
function shippedGetReader(body: unknown): {
  reader: GitLabMrSourceReaderV1;
  endpoints: string[];
} {
  const stub = glabStub(body);
  return {
    endpoints: stub.endpoints,
    reader: createGitLabMrReadSourceReader({
      host: HOST,
      projectPath: PROJECT_PATH,
      repositoryPath: "/tmp/gitlab-mr-acquisition-fixture",
      commands: stub.commands,
      environment: {},
    }),
  };
}

/** The raw GitLab body for one merged merge request, before any projection. */
function rawMergedMr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: MR_PAGE_ONE.iid,
    title: MR_PAGE_ONE.title,
    description: MR_PAGE_ONE.description,
    state: "merged",
    merged_at: MR_PAGE_ONE.mergedAt,
    target_branch: MR_PAGE_ONE.targetBranch,
    source_branch: MR_PAGE_ONE.sourceBranch,
    merge_commit_sha: MR_PAGE_ONE.mergeCommitSha,
    squash_commit_sha: MR_PAGE_ONE.squashCommitSha,
    ...overrides,
  };
}

/** A reader answering from a fixed table; the producer's only I/O seam. */
function tableReader(rows: readonly GitLabMrProjectionV1[]): GitLabMrSourceReaderV1 {
  return {
    async readMergeRequest(mergeRequestIid) {
      return rows.find((row) => row.iid === mergeRequestIid);
    },
  };
}

/** A reader that always fails with one shared provider code. */
function failingReader(code: "authentication" | "access" | "response"): GitLabMrSourceReaderV1 {
  return {
    async readMergeRequest() {
      throw new GitLabSourceProviderError(code);
    },
  };
}

/**
 * A reader that answers the first merge request and then denies every later
 * one.
 *
 * The producer reads in normalized ascending order, so this hands it one
 * sound projection before the failure. A producer that returned what it had
 * already read would produce a one-observation binding here and a refusal
 * nowhere — which is exactly the partial binding the fail-closed rule forbids.
 */
function readerDeniedAfterFirst(
  code: "authentication" | "access" | "response",
): GitLabMrSourceReaderV1 {
  let answered = false;
  return {
    async readMergeRequest(mergeRequestIid) {
      if (answered) throw new GitLabSourceProviderError(code);
      answered = true;
      return [MR_PAGE_ONE, MR_PAGE_TWO].find((row) => row.iid === mergeRequestIid);
    },
  };
}

/** Pages carrying the `list_merged` projection, with a divergent row per page. */
function pagePort(
  pages: readonly MergedMrPageV1[],
  failOn?: { page: number; code: "authentication" | "access" },
): MergedMrPagePortV1 {
  return {
    orderedDescendingByMergedAt: true,
    async fetchPage(page: number): Promise<MergedMrPageV1> {
      if (failOn && failOn.page === page) {
        throw Object.assign(new Error("upstream text that must never be retained"), {
          code: failOn.code,
        });
      }
      const fetched = pages[page - 1];
      if (!fetched) throw Object.assign(new Error("no such page"), { code: "response" });
      return fetched;
    },
  };
}

function pageOf(row: GitLabMrProjectionV1, nextPage: number | null): MergedMrPageV1 {
  return {
    items: [
      {
        iid: row.iid,
        state: row.state,
        mergedAt: row.mergedAt,
        targetBranch: row.targetBranch,
        sourceBranch: row.sourceBranch,
        mergeCommitSha: row.mergeCommitSha,
        squashCommitSha: row.squashCommitSha,
        title: row.title,
        description: row.description,
        url: row.url,
      },
    ],
    nextPage,
  };
}

function acquire(overrides: {
  reader?: GitLabMrSourceReaderV1;
  selection?: readonly number[];
  scope?: GitLabAcquisitionScopeV1;
  requestSha256?: string;
}): Promise<AcquiredGitLabMrSourceBindingV1> {
  return acquireGitLabMrSourceBinding({
    reader: overrides.reader ?? tableReader([MR_PAGE_ONE, MR_PAGE_TWO]),
    externalInputs: openExternalInputAccessCapture({
      runIdSha256: RUN_ID_SHA,
      repository: REPOSITORY,
    }),
    scope: overrides.scope ?? SCOPE,
    selection: overrides.selection ?? [MR_PAGE_ONE.iid],
    readScope: CLI_SOURCE_READ_SCOPE,
    runIdSha256: RUN_ID_SHA,
    repository: REPOSITORY,
    requestSha256: overrides.requestSha256 ?? REQUEST_SHA,
    hostPolicySha256: POLICY_SHA,
    observedAt: OBSERVED_AT,
  });
}

/** Bind an acquisition through the real source-evidence service. */
function bindRun(
  acquired: AcquiredGitLabMrSourceBindingV1,
  overrides: {
    binding?: SourceBindingV1;
    producerScopes?: ReadonlyArray<{ producerId: string; scopeSha256: string }>;
    resolveObservation?: (observationId: string) => unknown;
    requestSha256?: string;
  } = {},
) {
  const binding = overrides.binding ?? acquired.binding;
  const entries = new Map(
    acquired.acquired.map((entry) => [entry.observation.observationId, entry]),
  );
  const repositoryContentDigest = createHash("sha256").update("tree-digest").digest("hex");
  const service = createSourceEvidenceService(
    createSourceEvidenceHostAuthority({
      verifyCurrent: () => undefined,
      hostPolicySha256: POLICY_SHA,
      producerScopes: overrides.producerScopes ?? acquired.producerScopes,
      resolveBinding: (digest) => (digest === binding.bindingSha256 ? binding : undefined),
      resolveObservation:
        overrides.resolveObservation ??
        ((observationId) => entries.get(observationId)?.observation),
      resolveDerivative: ({ observationId }) => entries.get(observationId)?.derivative,
      recordAccess: () => createHash("sha256").update("access").digest("hex"),
      now: () => new Date(OBSERVED_AT),
    }),
  );
  return service.bindRun(
    createSourceArtifactReference({
      kind: "source-binding",
      digest: binding.bindingSha256,
      repositoryRevision: REVISION,
      repositoryContentDigest,
    }),
    {
      runId: RUN_ID,
      requestSha256: overrides.requestSha256 ?? REQUEST_SHA,
      repository: REPOSITORY,
      workspaceIdentitySha256: createHash("sha256").update("workspace").digest("hex"),
      repositoryContentDigest,
    },
  );
}

function expectServiceCode(run: () => unknown, code: SourceEvidenceServiceErrorCode): void {
  let raised: unknown;
  try {
    run();
  } catch (error) {
    raised = error;
  }
  expect(raised).toBeInstanceOf(SourceEvidenceServiceError);
  expect((raised as SourceEvidenceServiceError).code).toBe(code);
}

describe("merged GitLab MR acquisition producer (#798)", () => {
  it("binds one merged MR's projected evidence as a source observation with a gitlab-mr canonical locator", async () => {
    const acquired = await acquire({ selection: [MR_PAGE_TWO.iid] });
    const entry = acquired.acquired[0]!;
    // Computed by the shipped minter on this fixture, never pasted: a minter
    // that keyed on the project path instead of the numeric id would disagree.
    expect(entry.locator).toBe(
      canonicalGitlabMrReviewLocator({
        host: HOST,
        projectId: PROJECT_ID,
        mergeRequestIid: MR_PAGE_TWO.iid,
      }),
    );
    expect(entry.observation.original.locatorSha256).toBe(
      digestGitlabMrReviewLocator({
        host: HOST,
        projectId: PROJECT_ID,
        mergeRequestIid: MR_PAGE_TWO.iid,
      }),
    );
    expect(entry.locator).not.toContain(PROJECT_PATH);
    expect(entry.observation.producerId).toBe(GITLAB_MR_SOURCE_PRODUCER_ID);
    expect(entry.observation.producerScopeSha256).toBe(
      digestGitLabMrProducerScope({
        scope: SCOPE,
        repository: REPOSITORY,
        readScope: CLI_SOURCE_READ_SCOPE,
        mergeRequestIids: [MR_PAGE_TWO.iid],
      }),
    );
    expect(acquired.binding.requiredObservationIds).toEqual([entry.observation.observationId]);
    expect(acquired.binding.producerScopeSha256).toBe(
      digestSourceProducerScopes(acquired.producerScopes),
    );
    // The bound derivative really carries this merge request's body, not the
    // other fixture's: a producer that bound the wrong row would pass every
    // digest assertion above and fail here.
    const text = new TextDecoder().decode(entry.derivative);
    expect(text).toContain(MR_PAGE_TWO.description);
    expect(text).not.toContain(MR_PAGE_ONE.description);
    expect(text).toContain(MR_PAGE_TWO.squashCommitSha);
    expect(text).toContain("release/v1");
    expect(entry.evidenceGaps).toEqual([]);
    // Positive control for the divergent-identity fixture: the other merge
    // request binds to a different observation id and a different locator.
    const other = await acquire({ selection: [MR_PAGE_ONE.iid] });
    expect(other.acquired[0]!.locator).not.toBe(entry.locator);
    expect(other.acquired[0]!.observation.observationId).not.toBe(entry.observation.observationId);
  });

  it("refuses to mint a binding when the provider returns a row whose state is not merged", async () => {
    let binding: SourceBindingV1 | undefined;
    await expect(
      acquire({
        reader: tableReader([projection({ state: "opened" })]),
      }).then((result) => {
        binding = result.binding;
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.response);
    expect(binding).toBeUndefined();
    // Positive control: the identical fixture with state "merged" binds, so the
    // refusal is the state re-check and not some unrelated fixture defect.
    const merged = await acquire({ reader: tableReader([projection({ state: "merged" })]) });
    expect(merged.acquired).toHaveLength(1);
    expect(merged.binding.requiredObservationIds).toHaveLength(1);
  });

  it("retains the GitLab authentication failure string without partially binding", async () => {
    // The acquisition order is the normalized ascending selection, so
    // MR_PAGE_TWO (!742) is read and bound before MR_PAGE_ONE (!804) is
    // denied. A producer that kept what it already had would therefore return
    // one observation instead of refusing; a reader that failed on the very
    // first read could not tell the two behaviours apart.
    let binding: SourceBindingV1 | undefined;
    let acquiredCount: number | undefined;
    await expect(
      acquire({
        reader: readerDeniedAfterFirst("authentication"),
        selection: [MR_PAGE_ONE.iid, MR_PAGE_TWO.iid],
      }).then((result) => {
        binding = result.binding;
        acquiredCount = result.acquired.length;
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.authentication);
    expect(binding).toBeUndefined();
    expect(acquiredCount).toBeUndefined();
    // A first-read failure carries the same string, so the message is the
    // shared table's and not an artefact of how far the walk had got.
    await expect(
      acquire({ reader: failingReader("authentication"), selection: [MR_PAGE_ONE.iid] }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.authentication);
    // Positive control: both merge requests bind when nothing is denied.
    const clean = await acquire({ selection: [MR_PAGE_ONE.iid, MR_PAGE_TWO.iid] });
    expect(clean.acquired).toHaveLength(2);
  });

  it("retains the GitLab access failure string and binds nothing", async () => {
    let binding: SourceBindingV1 | undefined;
    let acquiredCount: number | undefined;
    await expect(
      acquire({
        reader: readerDeniedAfterFirst("access"),
        selection: [MR_PAGE_ONE.iid, MR_PAGE_TWO.iid],
      }).then((result) => {
        binding = result.binding;
        acquiredCount = result.acquired.length;
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.access);
    expect(binding).toBeUndefined();
    expect(acquiredCount).toBeUndefined();
    await expect(
      acquire({ reader: failingReader("access"), selection: [MR_PAGE_TWO.iid] }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.access);
  });

  it("binds an MR that appears only on page two of the provider", async () => {
    const port = pagePort([pageOf(MR_PAGE_ONE, 2), pageOf(MR_PAGE_TWO, null)]);
    const acquired = await acquire({
      reader: createGitLabMrPageSourceReader({ port }),
      selection: [MR_PAGE_TWO.iid],
    });
    const entry = acquired.acquired[0]!;
    expect(entry.mergeRequestIid).toBe(MR_PAGE_TWO.iid);
    expect(entry.locator).toBe(
      canonicalGitlabMrReviewLocator({
        host: HOST,
        projectId: PROJECT_ID,
        mergeRequestIid: MR_PAGE_TWO.iid,
      }),
    );
    const text = new TextDecoder().decode(entry.derivative);
    expect(text).toContain(MR_PAGE_TWO.squashCommitSha);
    expect(text).toContain(MR_PAGE_TWO.description);
    // Page one's divergent row is genuinely different evidence and was not
    // substituted for the requested one.
    expect(text).not.toContain(MR_PAGE_ONE.mergeCommitSha);
    expect(text).not.toContain(MR_PAGE_ONE.description);
    // A page-two failure is a refusal, not an empty answer that would let the
    // producer report "this merge request does not exist".
    let binding: SourceBindingV1 | undefined;
    await expect(
      acquire({
        reader: createGitLabMrPageSourceReader({
          port: pagePort([pageOf(MR_PAGE_ONE, 2), pageOf(MR_PAGE_TWO, null)], {
            page: 2,
            code: "access",
          }),
        }),
        selection: [MR_PAGE_TWO.iid],
      }).then((result) => {
        binding = result.binding;
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.access);
    expect(binding).toBeUndefined();
  });

  /**
   * Both truncation cases drive a shipped reader over a raw fixture whose
   * description really is longer than the limit. Both shipped readers clip
   * first, so no shipped reader produces an over-limit projection; these
   * fixtures cross the boundary where it is actually crossed — inside the
   * reader.
   */
  it("records a truncated MR description as an evidence gap rather than dropping the observation", async () => {
    const overLimit = "z".repeat(GITLAB_READ_TEXT_LIMIT + 1);
    const { reader, endpoints } = shippedGetReader(rawMergedMr({ description: overLimit }));
    const acquired = await acquire({ reader });
    // The raw body really was over the limit and the shipped reader really did
    // clip it, so the gap below cannot have come from an un-clipped fixture.
    expect(endpoints).toEqual([
      `projects/${encodeURIComponent(PROJECT_PATH)}/merge_requests/${MR_PAGE_ONE.iid}`,
    ]);
    const projected = await reader.readMergeRequest(MR_PAGE_ONE.iid);
    expect(projected?.description).toHaveLength(GITLAB_READ_TEXT_LIMIT);
    expect(projected?.textTruncated).toBe(true);

    const entry = acquired.acquired[0]!;
    expect(entry.evidenceGaps).toEqual(["truncated-merge-request-text"]);
    expect(acquired.binding.requiredObservationIds).toEqual([entry.observation.observationId]);
    const text = new TextDecoder().decode(entry.derivative);
    expect(text).toContain("# evidence_gaps: truncated-merge-request-text");
    expect(text).toContain("z".repeat(GITLAB_READ_TEXT_LIMIT));
    expect(text).not.toContain(overLimit);
    // One-over boundary control through the same shipped reader: a description
    // of exactly the limit is not clipped, raises no flag, and records no gap.
    const atLimit = await acquire({
      reader: shippedGetReader(rawMergedMr({ description: "z".repeat(GITLAB_READ_TEXT_LIMIT) }))
        .reader,
    });
    expect(atLimit.acquired[0]!.evidenceGaps).toEqual([]);
    expect(new TextDecoder().decode(atLimit.acquired[0]!.derivative)).toContain(
      "z".repeat(GITLAB_READ_TEXT_LIMIT),
    );
  });

  it("records a truncated MR description read through the page reader as an evidence gap", async () => {
    // The shipped page port clips text itself and reports the loss only as a
    // page-level flag, so this fixture is exactly what `projectListItems`
    // emits for an over-limit description: text already at the limit, and
    // `truncated: true` beside it.
    const clipped = "y".repeat(GITLAB_READ_TEXT_LIMIT);
    const truncatedPage: MergedMrPageV1 = {
      ...pageOf(projection({ description: clipped }), null),
      truncated: true,
    };
    const acquired = await acquire({
      reader: createGitLabMrPageSourceReader({ port: pagePort([truncatedPage]) }),
    });
    const entry = acquired.acquired[0]!;
    expect(entry.evidenceGaps).toEqual(["truncated-merge-request-text"]);
    expect(new TextDecoder().decode(entry.derivative)).toContain(
      "# evidence_gaps: truncated-merge-request-text",
    );
    // Control on the same reader: an untruncated page carrying the identical
    // text records no gap, so the gap tracks the page flag and nothing else.
    const clean = await acquire({
      reader: createGitLabMrPageSourceReader({
        port: pagePort([pageOf(projection({ description: clipped }), null)]),
      }),
    });
    expect(clean.acquired[0]!.evidenceGaps).toEqual([]);
    expect(new TextDecoder().decode(clean.acquired[0]!.derivative)).not.toContain(
      "# evidence_gaps:",
    );
  });

  it("refuses a deserialized source binding that names an observation this run did not acquire", async () => {
    const acquired = await acquire({});
    // Positive control first: the honest binding opens.
    expect(bindRun(acquired).observations).toHaveLength(1);
    expectServiceCode(
      () => bindRun(acquired, { resolveObservation: () => undefined }),
      "observation-unavailable",
    );
  });

  it("refuses a forged producer scope digest", async () => {
    const acquired = await acquire({});
    expectServiceCode(
      () =>
        bindRun(acquired, {
          producerScopes: [
            {
              producerId: GITLAB_MR_SOURCE_PRODUCER_ID,
              // The same producer, but a scope digest computed over a wider
              // merge-request selection than the one actually acquired.
              scopeSha256: digestGitLabMrProducerScope({
                scope: SCOPE,
                repository: REPOSITORY,
                readScope: CLI_SOURCE_READ_SCOPE,
                mergeRequestIids: [MR_PAGE_ONE.iid, MR_PAGE_TWO.iid],
              }),
            },
          ],
        }),
      "producer-scope-mismatch",
    );
  });

  it("refuses a binding minted against a different request projection", async () => {
    const admitted = {
      workflow: "update-documentation",
      allowWrite: true,
      readerTaskContext: { schemaVersion: 1 },
    };
    const workspaceIdentitySha256 = createHash("sha256").update("workspace").digest("hex");
    const requestSha256 = projectSourceRequestContext(admitted, {
      runId: RUN_ID,
      workspaceIdentitySha256,
      repository: REPOSITORY,
    });
    const acquired = await acquire({ requestSha256 });
    // Positive control: the run that recomputes the same projection binds.
    expect(bindRun(acquired, { requestSha256 }).observations).toHaveLength(1);
    const widened = projectSourceRequestContext(
      { ...admitted, editorialEvidenceRefs: ["extra-evidence"] },
      { runId: RUN_ID, workspaceIdentitySha256, repository: REPOSITORY },
    );
    expect(widened).not.toBe(requestSha256);
    expectServiceCode(() => bindRun(acquired, { requestSha256: widened }), "request-mismatch");
  });

  it("records that an explicitly undefined request key is a different request across the producer to verifier hop", async () => {
    // Projection version selection keys on key presence, so `{readerTaskContext:
    // undefined}` and an absent key are two different requests with two
    // different digests. This branch never re-shapes the admitted request — it
    // projects the exact object the runner will later receive and hands the
    // producer the resulting digest — so the hop cannot introduce the
    // divergence. A future caller that spread conditional fields on one side
    // only would, and this test is what would catch it.
    const admitted = { workflow: "update-documentation", allowWrite: true };
    const context = {
      runId: RUN_ID,
      workspaceIdentitySha256: createHash("sha256").update("workspace").digest("hex"),
      repository: REPOSITORY,
    };
    const absent = projectSourceRequestContext(admitted, context);
    const explicitlyUndefined = projectSourceRequestContext(
      { ...admitted, readerTaskContext: undefined },
      context,
    );
    expect(explicitlyUndefined).not.toBe(absent);
    expect(selectSourceRequestProjectionVersion(admitted)).toBe(1);
    expect(
      selectSourceRequestProjectionVersion({ ...admitted, readerTaskContext: undefined }),
    ).toBe(2);
    const acquired = await acquire({ requestSha256: absent });
    expect(acquired.acquired[0]!.observation.requestSha256).toBe(absent);
    expectServiceCode(
      () => bindRun(acquired, { requestSha256: explicitlyUndefined }),
      "request-mismatch",
    );
  });

  it("screens a configured credential in an MR description before it reaches the model", async () => {
    configureCredential(CONFIGURED_TOKEN);
    let binding: SourceBindingV1 | undefined;
    await expect(
      acquire({
        reader: tableReader([projection({ description: credentialDescription(CONFIGURED_TOKEN) })]),
      }).then((result) => {
        binding = result.binding;
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.credentials);
    expect(binding).toBeUndefined();
    // Positive control: the same merge request with an ordinary body binds, so
    // the refusal is the credential screen and not the fixture shape.
    const clean = await acquire({
      reader: tableReader([projection({ description: "An ordinary body." })]),
    });
    expect(clean.acquired).toHaveLength(1);
    // A body with a credential shape that is not configured binds too.
    const shaped = await acquire({
      reader: tableReader([projection({ description: credentialDescription(SHAPED_TOKEN) })]),
    });
    expect(shaped.acquired).toHaveLength(1);
  });

  it("refuses a selection the producer cannot bind soundly before it reads anything", async () => {
    // Asserted by structured code rather than by retyped message text: the
    // message is the producer's to word, the code is the contract.
    const refusal = async (selection: readonly number[]) => {
      const caught = await acquire({ selection }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(GitLabSourceAcquisitionError);
      return caught as GitLabSourceAcquisitionError;
    };
    expect((await refusal([])).code).toBe("empty-selection");
    expect((await refusal([0])).code).toBe("invalid-merge-request");
    const duplicate = await refusal([804, 804]);
    expect(duplicate.code).toBe("duplicate-merge-request");
    expect(duplicate.mergeRequestIid).toBe(804);
    const unavailable = await refusal([999_999]);
    expect(unavailable.code).toBe("merge-request-unavailable");
    expect(unavailable.mergeRequestIid).toBe(999_999);
    // A scope carrying a project path but no numeric id cannot key a locator,
    // and the refusal lands before the reader is ever called.
    let read = 0;
    await expect(
      acquire({
        scope: { ...SCOPE, projectId: undefined } as unknown as GitLabAcquisitionScopeV1,
        reader: {
          async readMergeRequest() {
            read += 1;
            return MR_PAGE_ONE;
          },
        },
      }),
      // Asserted through the shared table rather than a retyped fragment, so
      // the refusal text has exactly one declaration.
    ).rejects.toMatchObject({
      code: "scope-identity",
      message: SOURCE_DISCOVERY_REFUSALS["scope-identity"],
    });
    expect(read).toBe(0);
  });

  it("refuses a project id that disagrees with the project path it was supplied with", async () => {
    // The read dereferences the path and the locator is keyed on the id, so an
    // unproved pair binds one project's evidence under another project's
    // identity — and both halves of the sealed record stay internally
    // consistent, so nothing downstream can detect it afterwards.
    const OTHER_PROJECT_ID = 111_222;
    const port: GitLabProjectIdentityPortV1 = {
      async resolveProjectIdentity(reference) {
        return { host: reference.host, projectId: OTHER_PROJECT_ID, projectPath: PROJECT_PATH };
      },
    };
    await expect(
      resolveGitLabAcquisitionScope({
        reference: { host: HOST, projectId: PROJECT_ID, projectPath: PROJECT_PATH },
        identityPort: port,
      }),
    ).rejects.toMatchObject({ code: "out-of-scope-locator" });

    // Positive control: the same path, resolved to the id that was supplied.
    const agreed = await resolveGitLabAcquisitionScope({
      reference: { host: HOST, projectId: PROJECT_ID, projectPath: PROJECT_PATH },
      identityPort: {
        async resolveProjectIdentity(reference) {
          return { host: reference.host, projectId: PROJECT_ID, projectPath: PROJECT_PATH };
        },
      },
    });
    // Both identities recorded: the id keys the locator, the path is read from.
    expect(agreed.projectId).toBe(PROJECT_ID);
    expect(agreed.projectPath).toBe(PROJECT_PATH);
    const bound = await acquire({ scope: agreed, selection: [MR_PAGE_ONE.iid] });
    expect(bound.acquired[0]!.locator).toBe(
      canonicalGitlabMrReviewLocator({
        host: HOST,
        projectId: PROJECT_ID,
        mergeRequestIid: MR_PAGE_ONE.iid,
      }),
    );

    // A pair that cannot be proved at all is refused rather than assumed, and
    // an id with no path is refused because there is nothing to read from.
    await expect(
      resolveGitLabAcquisitionScope({
        reference: { host: HOST, projectId: PROJECT_ID, projectPath: PROJECT_PATH },
      }),
    ).rejects.toMatchObject({ code: "scope-identity" });
    await expect(
      resolveGitLabAcquisitionScope({ reference: { host: HOST, projectId: PROJECT_ID } }),
    ).rejects.toMatchObject({ code: "scope-identity" });

    // And a path-less scope is refused by the producer itself, so it can never
    // reach a reader factory that would have to invent a project to read from.
    let binding: SourceBindingV1 | undefined;
    await expect(
      acquire({
        scope: { ...SCOPE, projectPath: null } as unknown as GitLabAcquisitionScopeV1,
        reader: tableReader([MR_PAGE_ONE]),
      }).then((result) => {
        binding = result.binding;
      }),
    ).rejects.toMatchObject({ code: "scope-identity" });
    expect(binding).toBeUndefined();
  });

  it("refuses an acquisition scope that was never proved by the acquisition resolver", async () => {
    // A caller holding an ordinary discovery scope — what
    // `resolveGitLabSourceScope` returns, and the natural thing for a CLI
    // surface to hold — must not launder it into the acquisition type: the
    // read would follow the path while the locator followed the id, and both
    // halves of the sealed record would stay internally consistent.
    const unproved = await resolveGitLabSourceScope({
      reference: { host: HOST, projectId: PROJECT_ID, projectPath: "attacker/other-project" },
    });
    // No identity port was offered and none was called: the discovery boundary
    // deliberately treats a supplied id as canonical and reads nothing, so this
    // scope's two identities were never checked against each other.
    expect(unproved.projectId).toBe(PROJECT_ID);
    expect(unproved.projectPath).toBe("attacker/other-project");

    // The compile-time half: a discovery scope does not carry the proof field,
    // so the accidental path does not type-check at all.
    // @ts-expect-error a discovery scope is not an acquisition scope
    const doesNotCompile: GitLabAcquisitionScopeV1 = unproved;
    expect(doesNotCompile).toBeDefined();

    // The runtime half: a deliberate cast compiles, and is refused, because the
    // proof is a module-private symbol no caller can attach.
    let binding: SourceBindingV1 | undefined;
    let reads = 0;
    await expect(
      acquire({
        scope: { ...unproved, provedAcquisitionScope: true } as GitLabAcquisitionScopeV1,
        reader: {
          async readMergeRequest() {
            reads += 1;
            return MR_PAGE_ONE;
          },
        },
      }).then((result) => {
        binding = result.binding;
      }),
    ).rejects.toMatchObject({ code: "scope-identity" });
    expect(binding).toBeUndefined();
    // Refused before any merge request was read, so the other project was
    // never even contacted.
    expect(reads).toBe(0);

    // Positive control: the proved scope for the same project binds.
    const bound = await acquire({ selection: [MR_PAGE_ONE.iid] });
    expect(bound.acquired).toHaveLength(1);
  });

  it("records an absent merge-request body as an evidence gap of its own", async () => {
    // The merged-result shape: the shipped `list_merged` projection carries no
    // description key at all, so the page reader yields a null body. Without a
    // gap of its own the producer would seal an observation whose rendered
    // description section is empty, record no gap, emit no evidence_gaps line,
    // and mark it required — a sealed record asserting complete evidence for a
    // body that is 100% absent.
    const bodyless: MergedMrPageV1 = {
      items: [
        {
          iid: MR_PAGE_ONE.iid,
          state: "merged",
          mergedAt: MR_PAGE_ONE.mergedAt,
          targetBranch: MR_PAGE_ONE.targetBranch,
          sourceBranch: MR_PAGE_ONE.sourceBranch,
          mergeCommitSha: MR_PAGE_ONE.mergeCommitSha,
          squashCommitSha: MR_PAGE_ONE.squashCommitSha,
          title: MR_PAGE_ONE.title,
        },
      ],
      nextPage: null,
    };
    expect(Object.hasOwn(bodyless.items[0]!, "description")).toBe(false);
    const acquired = await acquire({
      reader: createGitLabMrPageSourceReader({ port: pagePort([bodyless]) }),
    });
    const entry = acquired.acquired[0]!;
    expect(entry.evidenceGaps).toEqual(["missing-merge-request-text"]);
    const text = new TextDecoder().decode(entry.derivative);
    expect(text).toContain("# evidence_gaps: missing-merge-request-text");
    expect(text).toContain("(no merge-request body was retained)");
    // Still bound and still required: an absent body is a gap, not a refusal.
    expect(acquired.binding.requiredObservationIds).toEqual([entry.observation.observationId]);

    // Control: the identical page carrying a body records no gap at all, so the
    // gap tracks the absent body and nothing else about this fixture.
    const withBody = await acquire({
      reader: createGitLabMrPageSourceReader({
        port: pagePort([pageOf(MR_PAGE_ONE, null)]),
      }),
    });
    expect(withBody.acquired[0]!.evidenceGaps).toEqual([]);
    expect(new TextDecoder().decode(withBody.acquired[0]!.derivative)).not.toContain(
      "# evidence_gaps:",
    );
    // A truncated body and an absent body are different gaps, not one flag.
    expect(entry.evidenceGaps).not.toContain("truncated-merge-request-text");

    // The empty-string branch, through the shipped `get` reader. This is not a
    // hypothetical shape: `readGitLabMrEvidence`'s text helper returns "" —
    // not null — for a merge request whose GitLab description is genuinely
    // empty, so narrowing the guard to `description === null` would leave a
    // real, reachable body-less acquisition recording no gap at all.
    const emptyBodied = shippedGetReader(rawMergedMr({ description: "" }));
    const projected = await emptyBodied.reader.readMergeRequest(MR_PAGE_ONE.iid);
    expect(projected?.description).toBe("");
    expect(projected?.description).not.toBeNull();
    const empty = await acquire({
      reader: shippedGetReader(rawMergedMr({ description: "" })).reader,
    });
    expect(empty.acquired[0]!.evidenceGaps).toEqual(["missing-merge-request-text"]);
    expect(new TextDecoder().decode(empty.acquired[0]!.derivative)).toContain(
      "# evidence_gaps: missing-merge-request-text",
    );
    // An explicit null body through the same reader records the same gap, and
    // a one-character body records none — so the guard tracks "no body text
    // was retained" across every shape the shipped readers can produce.
    const nulled = await acquire({
      reader: shippedGetReader(rawMergedMr({ description: null })).reader,
    });
    expect(nulled.acquired[0]!.evidenceGaps).toEqual(["missing-merge-request-text"]);
    const oneChar = await acquire({
      reader: shippedGetReader(rawMergedMr({ description: "x" })).reader,
    });
    expect(oneChar.acquired[0]!.evidenceGaps).toEqual([]);
  });

  it("refuses a projection whose merge-request number is not the one that was asked for", async () => {
    // A reader is external code: the type is the contract and this guard is
    // the enforcement. Without it a reader could answer about a neighbouring
    // merge request and its evidence would be sealed under the requested
    // number's locator.
    let binding: SourceBindingV1 | undefined;
    const substituting: GitLabMrSourceReaderV1 = {
      async readMergeRequest() {
        return MR_PAGE_TWO;
      },
    };
    await expect(
      acquire({ reader: substituting, selection: [MR_PAGE_ONE.iid] }).then((result) => {
        binding = result.binding;
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.response);
    expect(binding).toBeUndefined();
    // Positive control: the same reader answering about the number it was
    // asked for binds, so the refusal is the identity check.
    const honest = await acquire({ reader: substituting, selection: [MR_PAGE_TWO.iid] });
    expect(honest.acquired[0]!.mergeRequestIid).toBe(MR_PAGE_TWO.iid);
  });

  it("refuses a page port whose nextPage does not advance past the page it returned", async () => {
    // A port that keeps pointing at the same page would otherwise be walked up
    // to the page ceiling and then report the merge request simply absent,
    // turning a broken provider into a missing-evidence answer.
    let binding: SourceBindingV1 | undefined;
    const stuck: MergedMrPagePortV1 = {
      orderedDescendingByMergedAt: true,
      async fetchPage(page: number): Promise<MergedMrPageV1> {
        return { ...pageOf(MR_PAGE_ONE, page), nextPage: page };
      },
    };
    await expect(
      acquire({
        reader: createGitLabMrPageSourceReader({ port: stuck }),
        selection: [MR_PAGE_TWO.iid],
      }).then((result) => {
        binding = result.binding;
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.response);
    expect(binding).toBeUndefined();
    // Positive control: the identical fixture advancing correctly walks to the
    // end and reports the merge request unavailable instead of refusing.
    const advancing: MergedMrPagePortV1 = {
      orderedDescendingByMergedAt: true,
      async fetchPage(page: number): Promise<MergedMrPageV1> {
        return { ...pageOf(MR_PAGE_ONE, page), nextPage: page >= 2 ? null : page + 1 };
      },
    };
    const caught = await acquire({
      reader: createGitLabMrPageSourceReader({ port: advancing }),
      selection: [MR_PAGE_TWO.iid],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((caught as GitLabSourceAcquisitionError).code).toBe("merge-request-unavailable");
  });

  /**
   * Every acquisition stop must name the failing condition *and* the change
   * that clears it.
   *
   * Driven from the shipped code list rather than a list retyped here, so a
   * stop added later without operator text fails this case instead of
   * shipping as a bare code. The remediation check is a clause test, not a
   * length test: a message can be long and still tell an operator nothing.
   */
  it.each([...GITLAB_SOURCE_ACQUISITION_REFUSAL_CODES])(
    "renders the %s acquisition stop as a condition and the change that clears it",
    (code) => {
      const message = GITLAB_SOURCE_ACQUISITION_REFUSALS[code];
      expect(typeof message).toBe("string");
      // Names the condition rather than the code.
      expect(message).not.toContain(code);
      expect(message.startsWith("GitLab source acquisition")).toBe(true);
      // At least two sentences: the condition, then the action.
      const sentences = message.split(". ").filter((part) => part.trim().length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      // The last sentence is an instruction the operator can act on.
      const remediation = sentences.at(-1) ?? "";
      expect(remediation).toMatch(/^(?:Name|Use|Remove|Check|Supply|Run|Correct|Replace)\b/u);
      expect(message.endsWith(".")).toBe(true);
      // The thrown error carries that same text, so nothing renders a bare
      // code at the boundary an operator actually sees.
      expect(new GitLabSourceAcquisitionError(code).message).toBe(message);
      expect(new GitLabSourceAcquisitionError(code, 804).message).toContain(message);
      expect(new GitLabSourceAcquisitionError(code, 804).message).toContain("!804");
    },
  );

  it("renders the scope-identity refusal as a condition and the change that clears it", () => {
    const message = SOURCE_DISCOVERY_REFUSALS["scope-identity"];
    const sentences = message.split(". ").filter((part) => part.trim().length > 0);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.at(-1)).toMatch(/^(?:Name|Use|Remove|Check|Supply|Run|Correct|Replace)\b/u);
    expect(message).not.toContain("scope-identity");
  });

  it("refuses a scope rebuilt from a proved one, including every own symbol", async () => {
    // A symbol brand is private as a binding, not as a property key: a proved
    // scope escapes on the acquisition result, so any in-process caller could
    // read its own symbols and re-attach them to a scope naming another
    // project. Membership of a module-private WeakSet has no key to steal.
    const proved = SCOPE;
    const forged = { ...proved, projectPath: "attacker/other-project" } as Record<
      PropertyKey,
      unknown
    >;
    for (const symbol of Object.getOwnPropertySymbols(proved)) {
      forged[symbol] = (proved as unknown as Record<symbol, unknown>)[symbol];
    }
    // There is nothing to steal, and copying anyway does not help.
    expect(Object.getOwnPropertySymbols(proved)).toEqual([]);
    expect(forged.provedAcquisitionScope).toBe(true);

    let binding: SourceBindingV1 | undefined;
    let reads = 0;
    await expect(
      acquire({
        scope: forged as unknown as GitLabAcquisitionScopeV1,
        reader: {
          async readMergeRequest() {
            reads += 1;
            return MR_PAGE_ONE;
          },
        },
      }).then((result) => {
        binding = result.binding;
      }),
    ).rejects.toMatchObject({ code: "scope-identity" });
    expect(binding).toBeUndefined();
    expect(reads).toBe(0);

    // A serialized round trip loses the proof for the same reason, and the
    // untouched original still binds — so the refusal is membership, not shape.
    await expect(
      acquire({ scope: JSON.parse(JSON.stringify(proved)) as GitLabAcquisitionScopeV1 }),
    ).rejects.toMatchObject({ code: "scope-identity" });
    expect((await acquire({ selection: [MR_PAGE_ONE.iid] })).acquired).toHaveLength(1);
  });

  it("issues a CLI source-evidence service whose locked skills read the bound merge request and no other step does", async () => {
    // The shipped CLI host path over a real tracked export and a real
    // workspace: the producer, the request projection, the host authority and
    // the step reader are all the ones a `run` would use. Only the provider
    // read seam is a fixture.
    const fixture = await createSourceFixture();
    fixtureRoots.track(fixture.root);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    workspaces.push(workspace);

    // The host builds the reader from the scope it was given, so the factory
    // is where a project substitution would have to show up.
    const factoryScopes: GitLabAcquisitionScopeV1[] = [];
    const evidence = await resolveCliGitLabMrSourceEvidence({
      workspace,
      readerFor: (scope) => {
        factoryScopes.push(scope);
        return tableReader([MR_PAGE_ONE, MR_PAGE_TWO]);
      },
      scope: SCOPE,
      // Deliberately descending, so the ascending normalization below is a real
      // observation.
      mergeRequestIids: [MR_PAGE_ONE.iid, MR_PAGE_TWO.iid],
      admittedRequest: {
        workflow: "update-documentation",
        instruction: "Update the page from the bound merge requests.",
        allowWrite: true,
      },
      runId: RUN_ID,
    });
    expect(factoryScopes).toEqual([SCOPE]);
    expect(MR_PAGE_ONE.iid).toBeGreaterThan(MR_PAGE_TWO.iid);
    expect(evidence.acquired.acquired.map((entry) => entry.mergeRequestIid)).toEqual([
      MR_PAGE_TWO.iid,
      MR_PAGE_ONE.iid,
    ]);
    expect(evidence.acquired.producerScopes).toEqual([
      {
        producerId: GITLAB_MR_SOURCE_PRODUCER_ID,
        scopeSha256: digestGitLabMrProducerScope({
          scope: SCOPE,
          repository: {
            identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
            revision: workspace.revision,
          },
          readScope: CLI_SOURCE_READ_SCOPE,
          mergeRequestIids: [MR_PAGE_ONE.iid, MR_PAGE_TWO.iid],
        }),
      },
    ]);

    const capability = evidence.runnerBinding.service.bindRun(evidence.reference, {
      runId: RUN_ID,
      requestSha256: evidence.acquired.acquired[0]!.observation.requestSha256,
      repository: {
        identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
        revision: workspace.revision,
      },
      workspaceIdentitySha256: evidence.runnerBinding.workspaceIdentitySha256,
      repositoryContentDigest: evidence.runnerBinding.repositoryContentDigest,
    });
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "update-documentation",
      readSource: true,
      remainingBudgetBytes: 1024 * 1024,
    });
    expect(reader).toBeDefined();
    const spans = reader!.listSources();
    expect(spans).toHaveLength(2);
    const first = spans.find(
      (span) => span.repositoryPath === `gitlab-merge-request/${MR_PAGE_TWO.iid}.txt`,
    );
    expect(first).toBeDefined();
    const text = reader!.read({
      observationId: first!.observationId,
      representationId: first!.representationId,
      spanIds: [first!.spanId],
    }).text;
    expect(text).toContain(MR_PAGE_TWO.description);
    expect(text).not.toContain(MR_PAGE_ONE.description);
    // A step outside the locked source-read skills gets no reader at all, so
    // the GitLab branch narrows exactly as the tracked branch does.
    expect(
      capability.forStep({
        stepId: "deliver-documentation",
        workflow: "update-documentation",
        readSource: false,
        remainingBudgetBytes: 1024 * 1024,
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The same attached sources through `do` and `live-agent`.
//
// The claim under test is an identity claim, not a plumbing one: for one set of
// operator inputs, `docsfab run`, `docsfab do`, and `docsfab live-agent` must
// reach the *same* admitted request and mint the *same* source binding. So the
// assertions below are byte equalities between digests produced by the shipped
// acquisition, each driven from the request its own entrypoint actually built,
// with divergent-identity controls beside them so an equality cannot pass by
// two things being empty.
// ---------------------------------------------------------------------------

const HANDOFF_HOST = "gitlab.handoff.test";
const HANDOFF_PROJECT = "team/handoff-project";
const HANDOFF_PROJECT_ID = 654_321;
const HANDOFF_MR_IID = 798;
const HANDOFF_MR_BODY = "The export command now requires an explicit output path.";
const HANDOFF_PR = `https://${HANDOFF_HOST}/${HANDOFF_PROJECT}/-/merge_requests/${HANDOFF_MR_IID}`;
const HANDOFF_SOURCE = "docs/release-notes.html";
const HANDOFF_INSTRUCTION = "Create docs/whats-new.md describing the release notes for developers.";
/** Routes to create-documentation; the instruction above is what actually runs. */
const HANDOFF_SENTENCE = "Create a documentation page for the new export behavior.";
const HANDOFF_RUN_ID = "slice-e-handoff-run";

/** A `glab api` stand-in that records every endpoint a run actually requested. */
function handoffForge(options: { readonly description?: string; readonly iid?: number } = {}): {
  readonly commands: CommandRunner;
  readonly endpoints: string[];
} {
  const endpoints: string[] = [];
  return {
    endpoints,
    commands: {
      async run(_command: string, args: readonly string[]) {
        const endpoint = String(args.at(-1));
        endpoints.push(endpoint);
        if (endpoint.includes("/merge_requests/")) {
          return {
            stdout: JSON.stringify({
              iid: options.iid ?? HANDOFF_MR_IID,
              title: "Require an explicit export path",
              description: options.description ?? HANDOFF_MR_BODY,
              state: "merged",
              merged_at: "2026-09-16T11:30:00Z",
              target_branch: "main",
              source_branch: "feature/export-path",
              merge_commit_sha: "b".repeat(40),
              squash_commit_sha: null,
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            id: HANDOFF_PROJECT_ID,
            path_with_namespace: HANDOFF_PROJECT,
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    } as unknown as CommandRunner,
  };
}

/**
 * The closed field set the source-request projection reads, taken from the
 * shipped constant rather than retyped here.
 *
 * `executeWorkflowRun` assembles the admitted request from a whitelist; what a
 * CLI entrypoint contributes to it is exactly the subset below. Deriving the
 * list from `SOURCE_REQUEST_PROJECTED_FIELDS` means a future projected field
 * joins this comparison automatically instead of silently escaping it.
 */
function projectableRequest(request: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    workflow: request.workflow,
    allowWrite: request.allowWrite,
  };
  for (const field of SOURCE_REQUEST_PROJECTED_FIELDS) {
    if (request[field] !== undefined) body[field] = request[field];
  }
  return body;
}

/** Everything one entrypoint hands the shared execution assembly. */
interface HandoffRequest {
  readonly sourcePaths?: readonly string[];
  readonly changeRequestSelector?: ChangeRequestSelectorV1;
  readonly projectable: Record<string, unknown>;
}

function handoffFrom(request: Record<string, unknown>): HandoffRequest {
  return {
    ...(request.sourcePaths ? { sourcePaths: request.sourcePaths as readonly string[] } : {}),
    ...(request.changeRequestSelector
      ? { changeRequestSelector: request.changeRequestSelector as ChangeRequestSelectorV1 }
      : {}),
    projectable: projectableRequest(request),
  };
}

/** The exact request `docsfab run` builds from argv. */
function runHandoff(extra: readonly string[] = []): HandoffRequest {
  return handoffFrom(
    parseRunArguments([
      "create-documentation",
      "--repo",
      "/tmp/slice-e-handoff",
      "--instruction",
      HANDOFF_INSTRUCTION,
      "--patch-only",
      "--source",
      HANDOFF_SOURCE,
      "--pr",
      HANDOFF_PR,
      ...extra,
    ]) as unknown as Record<string, unknown>,
  );
}

/** The exact request `docsfab do` builds from argv, captured at its run seam. */
async function doHandoff(extra: readonly string[] = []): Promise<HandoffRequest> {
  let captured: Record<string, unknown> | undefined;
  await handleDoCommand(
    [
      HANDOFF_SENTENCE,
      "--repo",
      "/tmp/slice-e-handoff",
      "--instruction",
      HANDOFF_INSTRUCTION,
      "--patch-only",
      "--quiet",
      "--source",
      HANDOFF_SOURCE,
      "--pr",
      HANDOFF_PR,
      ...extra,
    ],
    {
      runWorkflow: async (request) => {
        captured = request as unknown as Record<string, unknown>;
        return undefined;
      },
    },
  );
  if (!captured) throw new Error("docsfab do never reached the shared execution assembly.");
  return handoffFrom(captured);
}

/** The exact request a `docsfab live-agent` turn builds from its attached sources. */
function liveAgentHandoff(extra: readonly string[] = []): HandoffRequest {
  const attached = parseLiveAgentArguments([
    "--repo",
    "/tmp/slice-e-handoff",
    "--source",
    HANDOFF_SOURCE,
    "--pr",
    HANDOFF_PR,
    ...extra,
  ]);
  return handoffFrom(
    liveAgentWorkflowRunRequest({
      workflow: "create-documentation",
      instruction: HANDOFF_INSTRUCTION,
      repositoryPath: attached.repositoryPath,
      allowWrite: attached.allowWrite,
      ...(attached.sourcePaths ? { sourcePaths: attached.sourcePaths } : {}),
      ...(attached.changeRequestSelector
        ? { changeRequestSelector: attached.changeRequestSelector }
        : {}),
    }) as unknown as Record<string, unknown>,
  );
}

/**
 * Acquire through the shipped CLI run path, with a recorded forge.
 *
 * `now` is pinned because an observation records when it was taken, so two
 * acquisitions a millisecond apart are legitimately different observations. The
 * question this suite asks is whether three entrypoints agree about *what* they
 * bound, and a wall clock would answer a different question.
 */
async function acquireHandoff(
  workspace: RepositoryWorkspace,
  handoff: HandoffRequest,
  forge = handoffForge(),
) {
  return resolveCliChangeRequestEvidenceFromSelector({
    workspace,
    selector: handoff.changeRequestSelector!,
    admittedRequest: handoff.projectable,
    runId: HANDOFF_RUN_ID,
    ...(handoff.sourcePaths ? { sourcePaths: handoff.sourcePaths } : {}),
    checkout: async () => {
      throw new Error("A fully qualified selector must not consult the checkout.");
    },
    commands: forge.commands,
    environment: {},
    now: () => new Date("2026-09-17T09:00:00.000Z"),
  });
}

describe("attached sources travel identically through run, do and live-agent (#798 slice E)", () => {
  it("mints one request digest and one binding digest for the same PDF-class file and merge request", async () => {
    const fixture = await createSourceFixture();
    fixtureRoots.track(fixture.root);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    workspaces.push(workspace);

    const surfaces = {
      run: runHandoff(),
      do: await doHandoff(),
      "live-agent": liveAgentHandoff(),
    } as const;

    // Each entrypoint really carried the operator's selection; an equality
    // between three empty selections would otherwise pass.
    for (const [name, handoff] of Object.entries(surfaces)) {
      expect(handoff.sourcePaths, name).toEqual([HANDOFF_SOURCE]);
      expect(handoff.changeRequestSelector?.number, name).toBe(HANDOFF_MR_IID);
      expect(handoff.changeRequestSelector?.projectPath, name).toBe(HANDOFF_PROJECT);
    }

    const acquired = {
      run: await acquireHandoff(workspace, surfaces.run),
      do: await acquireHandoff(workspace, surfaces.do),
      "live-agent": await acquireHandoff(workspace, surfaces["live-agent"]),
    };

    const requestDigests = new Set(
      Object.values(acquired).map((one) => one.acquired.acquired[0]!.observation.requestSha256),
    );
    const bindingDigests = new Set(
      Object.values(acquired).map((one) => one.acquired.binding.bindingSha256),
    );
    expect(requestDigests.size).toBe(1);
    expect(bindingDigests.size).toBe(1);
    expect([...requestDigests][0]).toMatch(/^[a-f0-9]{64}$/u);

    // Both producers are present in the one binding every surface minted, so an
    // entrypoint that dropped the merge request or the tracked file would not
    // have reached the same digest by carrying less.
    const repository = {
      identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
      revision: workspace.revision,
    };
    for (const [name, one] of Object.entries(acquired)) {
      expect(one.acquired.binding.requiredObservationIds, name).toHaveLength(2);
      const capability = one.runnerBinding.service.bindRun(one.reference, {
        runId: HANDOFF_RUN_ID,
        requestSha256: one.acquired.acquired[0]!.observation.requestSha256,
        repository,
        workspaceIdentitySha256: one.runnerBinding.workspaceIdentitySha256,
        repositoryContentDigest: one.runnerBinding.repositoryContentDigest,
      });
      expect(
        new Set(capability.observations.map((observation) => observation.producerId)),
        name,
      ).toEqual(new Set(["workspace-tracked-files", "gitlab-merged-mr"]));
      // The writer really reads both, and so does the verifier: two separate
      // step reads over the *same* immutable observations, asserted as two
      // distinct access rows over one observation rather than as two
      // successful calls.
      for (const stepId of ["write-documentation", "verify-technical-accuracy"]) {
        const reader = capability.forStep({
          stepId,
          workflow: "create-documentation",
          readSource: true,
          remainingBudgetBytes: 4 * 1024 * 1024,
        });
        const spans = reader!.listSources();
        const paths = new Set(spans.map((span) => span.repositoryPath));
        expect(paths.has(HANDOFF_SOURCE), `${name}/${stepId}`).toBe(true);
        expect(paths.has(`gitlab-merge-request/${HANDOFF_MR_IID}.txt`), `${name}/${stepId}`).toBe(
          true,
        );
        const mrSpan = spans.find((span) =>
          span.repositoryPath?.startsWith("gitlab-merge-request/"),
        )!;
        expect(
          reader!.read({
            observationId: mrSpan.observationId,
            representationId: mrSpan.representationId,
            spanIds: [mrSpan.spanId],
          }).text,
          `${name}/${stepId}`,
        ).toContain(HANDOFF_MR_BODY);
      }
      const accesses = capability
        .spanAccesses()
        .filter((access) => access.stepId !== "plan-documentation");
      const mrAccesses = accesses.filter(
        (access) =>
          access.observationId ===
          capability.observations.find(
            (observation) => observation.producerId === "gitlab-merged-mr",
          )!.observationId,
      );
      // Same observation, two step identities, two access rows: the reads are
      // distinct evidence, and neither step reused the other's receipt.
      expect(mrAccesses.map((access) => access.stepId).sort(), name).toEqual([
        "verify-technical-accuracy",
        "write-documentation",
      ]);
      expect(new Set(mrAccesses.map((access) => access.spanAccessSha256)).size, name).toBe(2);
      expect(new Set(mrAccesses.map((access) => access.observationId)).size, name).toBe(1);
    }

    // Divergent-identity controls. The digests above are sensitive to the
    // request and to the evidence, so equality is a statement about agreement
    // and not about a constant.
    const otherInstruction = handoffFrom({
      ...surfaces.run,
      ...surfaces.run.projectable,
      instruction: `${HANDOFF_INSTRUCTION} And mention the deprecation window.`,
      sourcePaths: surfaces.run.sourcePaths,
      changeRequestSelector: surfaces.run.changeRequestSelector,
    });
    const divergentRequest = await acquireHandoff(workspace, otherInstruction);
    expect(divergentRequest.acquired.acquired[0]!.observation.requestSha256).not.toBe(
      [...requestDigests][0],
    );

    const otherMr = handoffFrom({
      ...surfaces.run.projectable,
      sourcePaths: surfaces.run.sourcePaths,
      changeRequestSelector: {
        ...surfaces.run.changeRequestSelector!,
        number: HANDOFF_MR_IID + 1,
      },
    });
    const divergentEvidence = await acquireHandoff(
      workspace,
      otherMr,
      handoffForge({ iid: HANDOFF_MR_IID + 1 }),
    );
    expect(divergentEvidence.acquired.acquired[0]!.observation.requestSha256).toBe(
      [...requestDigests][0],
    );
    expect(divergentEvidence.acquired.binding.bindingSha256).not.toBe([...bindingDigests][0]);
  }, 60_000);

  it("refuses an acquisition scope a live-agent session could only have rehydrated", async () => {
    const fixture = await createSourceFixture();
    fixtureRoots.track(fixture.root);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    workspaces.push(workspace);

    const attached = liveAgentHandoff();
    const proved = (await acquireHandoff(workspace, attached)).acquired.scope;

    // A live-agent session is durable: everything it holds between turns can be
    // written to a session file and read back. The selector survives that,
    // because it is inert — and it must produce the identical binding, or the
    // session would quietly become a second source of truth.
    const rehydratedSelector = JSON.parse(
      JSON.stringify(attached.changeRequestSelector),
    ) as ChangeRequestSelectorV1;
    const fromRehydrated = await acquireHandoff(workspace, {
      ...attached,
      changeRequestSelector: rehydratedSelector,
    });
    expect(fromRehydrated.acquired.binding.bindingSha256).toBe(
      (await acquireHandoff(workspace, attached)).acquired.binding.bindingSha256,
    );

    // A proved scope does not survive it. Its proof is membership of a
    // module-private set, so the rehydrated copy is refused before any read.
    let reads = 0;
    await expect(
      resolveCliChangeRequestSourceEvidence({
        workspace,
        scope: JSON.parse(JSON.stringify(proved)) as GitLabAcquisitionScopeV1,
        readerFor: () => {
          reads += 1;
          return {
            async readMergeRequest() {
              throw new Error("A refused scope must not reach a reader.");
            },
          } as unknown as GitLabMrSourceReaderV1;
        },
        mergeRequestIids: [HANDOFF_MR_IID],
        admittedRequest: attached.projectable,
        runId: HANDOFF_RUN_ID,
      }),
    ).rejects.toMatchObject({ code: "scope-identity" });
    expect(reads).toBe(0);

    // And the live-agent request builder refuses it one step earlier, by shape,
    // so a rehydrated scope cannot even become this session's selection.
    expect(() =>
      liveAgentWorkflowRunRequest({
        workflow: "create-documentation",
        instruction: HANDOFF_INSTRUCTION,
        repositoryPath: fixture.repository,
        allowWrite: true,
        changeRequestSelector: JSON.parse(
          JSON.stringify(proved),
        ) as unknown as ChangeRequestSelectorV1,
      }),
    ).toThrow(/validated change-request selector/u);
    // Control: the inert selector from the same session is accepted.
    expect(
      liveAgentWorkflowRunRequest({
        workflow: "create-documentation",
        instruction: HANDOFF_INSTRUCTION,
        repositoryPath: fixture.repository,
        allowWrite: true,
        changeRequestSelector: rehydratedSelector,
      }).changeRequestSelector,
    ).toEqual(attached.changeRequestSelector);
  }, 60_000);

  it("screens a configured credential in a merge-request body on the do and live-agent handoff too", async () => {
    const fixture = await createSourceFixture();
    fixtureRoots.track(fixture.root);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    workspaces.push(workspace);

    // The credential-shaped fixture exists only in this file.
    configureCredential(CONFIGURED_TOKEN);
    const description = credentialDescription(CONFIGURED_TOKEN);
    for (const handoff of [await doHandoff(), liveAgentHandoff()]) {
      let bound: unknown;
      await expect(
        acquireHandoff(workspace, handoff, handoffForge({ description })).then((result) => {
          bound = result;
        }),
      ).rejects.toThrow(GITLAB_READ_FAILURES.credentials);
      expect(bound).toBeUndefined();
    }

    // Control: the same two handoffs bind when the body is ordinary, so the
    // refusal above is the screen and not a broken fixture.
    for (const handoff of [await doHandoff(), liveAgentHandoff()]) {
      const evidence = await acquireHandoff(workspace, handoff);
      expect(evidence.acquired.binding.requiredObservationIds).toHaveLength(2);
      expect(evidence.acquired.acquired[0]!.mergeRequestIid).toBe(HANDOFF_MR_IID);
    }
    // They bind as well when the body has a credential shape that is not
    // configured.
    for (const handoff of [await doHandoff(), liveAgentHandoff()]) {
      const evidence = await acquireHandoff(
        workspace,
        handoff,
        handoffForge({ description: credentialDescription(SHAPED_TOKEN) }),
      );
      expect(evidence.acquired.acquired[0]!.mergeRequestIid).toBe(HANDOFF_MR_IID);
    }
  }, 60_000);
});

describe("docsfab do source admission (#798 slice E)", () => {
  const doArgv = (...extra: string[]) => [
    HANDOFF_SENTENCE,
    "--repo",
    "/tmp/slice-e-handoff",
    ...extra,
  ];

  it("keeps a do invocation with no source byte-identical to today", async () => {
    const before = await doHandoff([]);
    let captured: Record<string, unknown> | undefined;
    await handleDoCommand(
      [
        HANDOFF_SENTENCE,
        "--repo",
        "/tmp/slice-e-handoff",
        "--instruction",
        HANDOFF_INSTRUCTION,
        "--patch-only",
        "--quiet",
      ],
      {
        runWorkflow: async (request) => {
          captured = request as unknown as Record<string, unknown>;
          return undefined;
        },
      },
    );
    expect(captured).toBeDefined();
    expect(Object.hasOwn(captured!, "sourcePaths")).toBe(false);
    expect(Object.hasOwn(captured!, "changeRequestSelector")).toBe(false);
    // Positive control: the same argv plus a selection does carry both keys.
    expect(before.sourcePaths).toEqual([HANDOFF_SOURCE]);
    expect(before.changeRequestSelector).toBeDefined();
  });

  it("refuses bound sources on the delegated pilot, naming the surface that binds them", () => {
    for (const flag of [
      ["--source", HANDOFF_SOURCE],
      ["--pr", HANDOFF_PR],
    ]) {
      expect(() => parseDoArguments(doArgv("--delegate", ...flag))).toThrow(
        /Delegated do does not accept --source, --pr or --change\..*catalog workflow runner/su,
      );
    }
    // Control: catalog do admits exactly the same flags.
    expect(parseDoArguments(doArgv("--source", HANDOFF_SOURCE)).sourcePaths).toEqual([
      HANDOFF_SOURCE,
    ]);
    expect(parseDoArguments(doArgv("--pr", HANDOFF_PR)).changeRequestSelector?.number).toBe(
      HANDOFF_MR_IID,
    );
  });

  it("stops a selection that routes outside the source-aware workflows, naming the route", async () => {
    let ran = false;
    await expect(
      handleDoCommand(
        [
          "Review the documentation for the export behavior.",
          "--repo",
          "/tmp/slice-e-handoff",
          "--quiet",
          "--pr",
          HANDOFF_PR,
        ],
        {
          runWorkflow: async () => {
            ran = true;
            return undefined;
          },
        },
      ),
    ).rejects.toThrow(
      /--pr or --mr is supported only for .*This quoted request routed to review-documentation instead/su,
    );
    expect(ran).toBe(false);
  });

  it("parses the selection under --dry-run without opening a source body or reading the forge", async () => {
    // The probes are wired to the code under test, not stood beside it: the
    // injected run seam performs the shipped acquisition, so the only way the
    // forge endpoints or the tracked reads below can stay empty is for `do` to
    // have stopped before reaching a run. The positive control drives the same
    // seam with the same argv minus `--dry-run`, and both probes fire.
    const fixture = await createSourceFixture();
    fixtureRoots.track(fixture.root);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    workspaces.push(workspace);

    const argv = (...extra: string[]) => [
      HANDOFF_SENTENCE,
      "--repo",
      "/tmp/slice-e-handoff",
      "--quiet",
      "--source",
      HANDOFF_SOURCE,
      "--pr",
      HANDOFF_PR,
      ...extra,
    ];
    const acquiringRun = () => {
      const forge = handoffForge();
      const trackedReads: string[] = [];
      let runs = 0;
      return {
        forge,
        trackedReads,
        runs: () => runs,
        runWorkflow: async (request: Record<string, unknown>) => {
          runs += 1;
          const evidence = await acquireHandoff(workspace, handoffFrom(request), forge);
          const capability = evidence.runnerBinding.service.bindRun(evidence.reference, {
            runId: HANDOFF_RUN_ID,
            requestSha256: evidence.acquired.acquired[0]!.observation.requestSha256,
            repository: {
              identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
              revision: workspace.revision,
            },
            workspaceIdentitySha256: evidence.runnerBinding.workspaceIdentitySha256,
            repositoryContentDigest: evidence.runnerBinding.repositoryContentDigest,
          });
          for (const span of capability
            .forStep({
              stepId: "write-documentation",
              workflow: "create-documentation",
              readSource: true,
              remainingBudgetBytes: 4 * 1024 * 1024,
            })!
            .listSources()) {
            if (span.repositoryPath) trackedReads.push(span.repositoryPath);
          }
          return undefined;
        },
      };
    };

    const dry = acquiringRun();
    const logged: string[] = [];
    const log = console.log;
    console.log = (value: unknown) => {
      logged.push(String(value));
    };
    try {
      await handleDoCommand(argv("--dry-run"), { runWorkflow: dry.runWorkflow });
    } finally {
      console.log = log;
    }
    expect(logged.join("\n")).toContain("Dry run:");
    expect(dry.runs()).toBe(0);
    expect(dry.forge.endpoints).toEqual([]);
    expect(dry.trackedReads).toEqual([]);

    // Positive control on the identical seam: without --dry-run the same argv
    // reaches the run, the forge is consulted and the tracked body is opened.
    const wet = acquiringRun();
    const quiet = console.log;
    console.log = (): void => undefined;
    try {
      await handleDoCommand(argv(), { runWorkflow: wet.runWorkflow });
    } finally {
      console.log = quiet;
    }
    expect(wet.runs()).toBe(1);
    expect(wet.forge.endpoints.length).toBeGreaterThan(0);
    expect(wet.trackedReads).toEqual(
      expect.arrayContaining([HANDOFF_SOURCE, `gitlab-merge-request/${HANDOFF_MR_IID}.txt`]),
    );
  }, 60_000);
});

/**
 * The whole journey through `docsfab do` and `docsfab live-agent`.
 *
 * The identity claim above is proven at the acquisition boundary because that
 * is where digests live. This is the other half: a
 * real attached PDF and a merged merge request reaching a real bounded run
 * through `docsfab do` and through `docsfab live-agent`, with the composition
 * root, the producers, the binding, the host authority and the step readers all
 * the shipped ones. Only the model turn and the forge read are substituted.
 */
describe("an attached PDF and a merged MR travel through do and live-agent (#798 slice E)", () => {
  const PDF_PATH = "docs/release-notes.pdf";
  const PDF_PAGE_ONE = "The quick brown fox jumps over the lazy dog.";

  async function pdfFixture() {
    const fixture = await createSourceFixture({
      [PDF_PATH]: new Uint8Array(
        readFileSync(
          new URL("./fixtures/source-evidence/pdf/simple-two-page.pdf", import.meta.url),
        ),
      ),
    });
    fixtureRoots.track(fixture.root);
    return fixture;
  }

  function journeyHarness() {
    return new SourceToolHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: [PDF_PATH],
    });
  }

  function assertReadBothSources(model: SourceToolHarness): void {
    expect(model.sawReaderOn).toContain("plan-documentation");
    expect(model.sawReferenceOn).toContain("write-documentation");
    expect(model.listedPaths).toEqual(
      expect.arrayContaining([PDF_PATH, `gitlab-merge-request/${HANDOFF_MR_IID}.txt`]),
    );
    const read = model.toolReads.join("\n");
    expect(read).toContain(PDF_PAGE_ONE);
    expect(read).toContain(HANDOFF_MR_BODY);
  }

  it("runs a docsfab do request grounded on both, through catalog routing", async () => {
    const fixture = await pdfFixture();
    const model = journeyHarness();
    const forge = handoffForge();
    let record: RunRecord | undefined;
    const log = console.log;
    console.log = (): void => undefined;
    try {
      await handleDoCommand(
        [
          HANDOFF_SENTENCE,
          "--repo",
          fixture.repository,
          "--instruction",
          HANDOFF_INSTRUCTION,
          "--patch-only",
          "--quiet",
          "--source",
          PDF_PATH,
          "--pr",
          HANDOFF_PR,
        ],
        {
          runWorkflow: async (request) => {
            record = (await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
              silent: true,
              executionHarness: model,
              skillResolver,
              changeRequestCommands: forge.commands,
              changeRequestEnvironment: {},
            })) as RunRecord | undefined;
            return record;
          },
        },
      );
    } finally {
      console.log = log;
    }
    expect(record?.status).toBe("succeeded");
    expect(record?.workflow).toBe("create-documentation");
    assertReadBothSources(model);
    // The forge was really consulted: project identity first, then the MR.
    expect(forge.endpoints).toHaveLength(2);
    expect(forge.endpoints.at(-1)).toContain(`/merge_requests/${HANDOFF_MR_IID}`);
  }, 120_000);

  it("runs a live-agent bounded workflow grounded on both, through runBoundedWorkflow", async () => {
    const fixture = await pdfFixture();
    const model = journeyHarness();
    const forge = handoffForge();
    const attached = parseLiveAgentArguments([
      "--repo",
      fixture.repository,
      "--source",
      PDF_PATH,
      "--pr",
      HANDOFF_PR,
    ]);

    const record = await runBoundedWorkflow({
      workflow: "create-documentation",
      instruction: HANDOFF_INSTRUCTION,
      repositoryPath: attached.repositoryPath,
      allowWrite: attached.allowWrite,
      config: runtimeConfig(fixture.stateDirectory),
      executionHarness: model,
      skillResolver,
      ...(attached.sourcePaths ? { sourcePaths: attached.sourcePaths } : {}),
      ...(attached.changeRequestSelector
        ? { changeRequestSelector: attached.changeRequestSelector }
        : {}),
      changeRequestCommands: forge.commands,
      changeRequestEnvironment: {},
    });

    expect(record.status).toBe("succeeded");
    assertReadBothSources(model);
    expect(forge.endpoints.at(-1)).toContain(`/merge_requests/${HANDOFF_MR_IID}`);
  }, 120_000);

  it("stops a live-agent turn that asks for a workflow the attached sources cannot bind", async () => {
    const attached = parseLiveAgentArguments([
      "--repo",
      "/tmp/slice-e-handoff",
      "--source",
      HANDOFF_SOURCE,
      "--pr",
      HANDOFF_PR,
    ]);
    await expect(
      runBoundedWorkflow({
        workflow: "review-documentation",
        instruction: HANDOFF_INSTRUCTION,
        repositoryPath: attached.repositoryPath,
        allowWrite: attached.allowWrite,
        config: runtimeConfig("/tmp/slice-e-handoff-state"),
        ...(attached.sourcePaths ? { sourcePaths: attached.sourcePaths } : {}),
        ...(attached.changeRequestSelector
          ? { changeRequestSelector: attached.changeRequestSelector }
          : {}),
      }),
    ).rejects.toThrow(
      /attached bound sources and asked for review-documentation\. --pr or --mr is supported only for/u,
    );
    // Control: the same attachment on a source-aware workflow builds a request
    // rather than stopping, so the refusal is the workflow and not the flag.
    expect(
      liveAgentWorkflowRunRequest({
        workflow: "update-documentation",
        instruction: HANDOFF_INSTRUCTION,
        repositoryPath: attached.repositoryPath,
        allowWrite: attached.allowWrite,
        ...(attached.sourcePaths ? { sourcePaths: attached.sourcePaths } : {}),
        ...(attached.changeRequestSelector
          ? { changeRequestSelector: attached.changeRequestSelector }
          : {}),
      }).sourcePaths,
    ).toEqual([HANDOFF_SOURCE]);
  });
});

/**
 * One refusal, three entrypoints.
 *
 * A date-scoped `update-documentation` instruction already names the merge
 * requests the run binds. `docsfab run` refuses a selector beside one, because
 * a run binds exactly one source binding and the host would otherwise reason
 * over the discovered set while committing to the selected one — the writer
 * and the verifier then gated on evidence the run was not assembled from.
 *
 * The same words are refused by the same sentence wherever they are typed.
 * The expected text is derived by executing the shipped `run` refusal, never
 * restated, so a reworded message cannot leave two surfaces agreeing with each
 * other and disagreeing with `run`.
 */
describe("a date-scoped instruction refuses a selection on every entrypoint (#798 slice E)", () => {
  const WINDOW =
    "Update the user documentation for the merge requests merged into main on September 14, 2026, using America/Los_Angeles time.";

  /** The literal `docsfab run` refusal, taken from the shipped parser. */
  function runRefusal(flag: "--source" | "--pr"): string {
    const argv = [
      "update-documentation",
      "--repo",
      "/tmp/slice-e-handoff",
      "--instruction",
      WINDOW,
      ...(flag === "--pr" ? ["--pr", HANDOFF_PR] : ["--source", HANDOFF_SOURCE]),
    ];
    try {
      parseRunArguments(argv);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("docsfab run admitted a date-scoped instruction beside a selection.");
  }

  it("refuses the combination on run, do and live-agent with one identical message", async () => {
    for (const flag of ["--source", "--pr"] as const) {
      const expected = runRefusal(flag);
      // Not a tautology: the message really is the purpose-written one.
      expect(expected).toContain("date-scoped merged-MR update");
      expect(expected).toContain(flag);

      // `do` routes the sentence to update-documentation and then reaches the
      // same refusal. A spy proves it never handed the run to the assembly.
      let ran = false;
      const quiet = console.log;
      console.log = (): void => undefined;
      try {
        await expect(
          handleDoCommand(
            [
              WINDOW,
              "--repo",
              "/tmp/slice-e-handoff",
              "--quiet",
              ...(flag === "--pr" ? ["--pr", HANDOFF_PR] : ["--source", HANDOFF_SOURCE]),
            ],
            {
              runWorkflow: async () => {
                ran = true;
                return undefined;
              },
            },
          ),
        ).rejects.toThrow(expected);
      } finally {
        console.log = quiet;
      }
      expect(ran, flag).toBe(false);

      // A live-agent turn is refused when it builds its request, before any
      // acquisition and without depending on a reader handoff being present.
      expect(() =>
        liveAgentWorkflowRunRequest({
          workflow: "update-documentation",
          instruction: WINDOW,
          repositoryPath: "/tmp/slice-e-handoff",
          allowWrite: true,
          ...(flag === "--pr"
            ? { changeRequestSelector: liveAgentHandoff().changeRequestSelector! }
            : { sourcePaths: [HANDOFF_SOURCE] }),
        }),
      ).toThrow(expected);
    }
  });

  it("stops do before the merged-MR discovery the instruction would have triggered", async () => {
    // The harm this refusal prevents is specific: the run walks the forge for
    // the window's merge requests and then binds only the selected one. The
    // forge probe is wired to the run seam, so reaching a run at all would
    // record an endpoint here.
    const forge = handoffForge();
    let ran = false;
    const quiet = console.log;
    console.log = (): void => undefined;
    try {
      await expect(
        handleDoCommand([WINDOW, "--repo", "/tmp/slice-e-handoff", "--quiet", "--pr", HANDOFF_PR], {
          runWorkflow: async () => {
            ran = true;
            return undefined;
          },
        }),
      ).rejects.toThrow(/cannot also take --pr/u);
    } finally {
      console.log = quiet;
    }
    expect(ran).toBe(false);
    expect(forge.endpoints).toEqual([]);
  });

  it("leaves the same instruction and the same selection admitted apart", async () => {
    // Controls on both halves, so the refusal is the combination and not either
    // input. The date window alone routes and runs; the selection alone runs
    // under an ordinary instruction.
    let windowOnly: Record<string, unknown> | undefined;
    let selectionOnly: Record<string, unknown> | undefined;
    const quiet = console.log;
    console.log = (): void => undefined;
    try {
      await handleDoCommand([WINDOW, "--repo", "/tmp/slice-e-handoff", "--quiet"], {
        runWorkflow: async (request) => {
          windowOnly = request as unknown as Record<string, unknown>;
          return undefined;
        },
      });
      await handleDoCommand(
        [
          HANDOFF_SENTENCE,
          "--repo",
          "/tmp/slice-e-handoff",
          "--quiet",
          "--pr",
          HANDOFF_PR,
          "--source",
          HANDOFF_SOURCE,
        ],
        {
          runWorkflow: async (request) => {
            selectionOnly = request as unknown as Record<string, unknown>;
            return undefined;
          },
        },
      );
    } finally {
      console.log = quiet;
    }
    expect(windowOnly?.workflow).toBe("update-documentation");
    expect(Object.hasOwn(windowOnly!, "changeRequestSelector")).toBe(false);
    expect(selectionOnly?.changeRequestSelector).toBeDefined();
    expect(selectionOnly?.sourcePaths).toEqual([HANDOFF_SOURCE]);
    // And live-agent admits the date window when nothing is attached.
    expect(
      liveAgentWorkflowRunRequest({
        workflow: "update-documentation",
        instruction: WINDOW,
        repositoryPath: "/tmp/slice-e-handoff",
        allowWrite: true,
      }).instruction,
    ).toBe(WINDOW);
  });

  it("refuses an unbindable selection under --route-only, where the operator previews", async () => {
    let ran = false;
    const quiet = console.log;
    console.log = (): void => undefined;
    try {
      await expect(
        handleDoCommand(
          [
            "Review the documentation for the export behavior.",
            "--repo",
            "/tmp/slice-e-handoff",
            "--route-only",
            "--pr",
            HANDOFF_PR,
          ],
          {
            runWorkflow: async () => {
              ran = true;
              return undefined;
            },
          },
        ),
      ).rejects.toThrow(/routed to review-documentation instead/u);
    } finally {
      console.log = quiet;
    }
    expect(ran).toBe(false);
    // Control: --route-only still classifies a selection the route can bind.
    const logged: string[] = [];
    const log = console.log;
    console.log = (value: unknown) => {
      logged.push(String(value));
    };
    try {
      await handleDoCommand(
        [HANDOFF_SENTENCE, "--repo", "/tmp/slice-e-handoff", "--route-only", "--pr", HANDOFF_PR],
        {
          runWorkflow: async () => {
            ran = true;
            return undefined;
          },
        },
      );
    } finally {
      console.log = log;
    }
    expect(logged.join("\n")).toContain("create-documentation");
    expect(ran).toBe(false);
  });
});
