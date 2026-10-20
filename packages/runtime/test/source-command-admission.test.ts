// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab_search_sources` admission and confinement.
 *
 * Every expectation here is derived from a shipped artefact: the tool's own
 * definition list, the payload the shipped projection actually writes, and the
 * digest `createSourceStepPolicy` actually computes over a divergent fixture.
 * No digest, tool name or result shape is pasted from a prior run.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import {
  SOURCE_READ_TOOL_NAMES,
  PRESERVATION_SOURCE_READ_TOOL_NAMES,
  SOURCE_SEARCH_PAYLOAD_CEILING_BYTES,
  SOURCE_SEARCH_TOOL_NAMES,
  SOURCE_TOOL_NAMES,
  createSourceToolDefinitions,
} from "../src/harness/source-tools.js";
import { textSourceExtractorAdapter } from "../src/inputs/adapters/structured.js";
import {
  SOURCE_DISCOVERY_REFUSALS,
  SOURCE_SEARCH_MAX_DESCRIPTORS,
  createSourceArtifactReference,
  createSourceBinding,
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  createSourceObservation,
  createSourceStepPolicy,
  createSourceStepSearcher,
  digestSourceProducerScopes,
  extractSourceRepresentation,
  gitlabMrSourceRepositoryPath,
  openExternalInputAccessCapture,
  projectSourceRequestContext,
  recordExternalInputAccess,
  registerFakeExternalInput,
  resolveGitLabAcquisitionScope,
  resolveMergedMrDateWindow,
  stepAdmitsSourceRead,
  stepAdmitsSourceSearch,
  type GitLabAcquisitionScopeV1,
  type MergedMrPageV1,
  type MergedMrRecordV1,
  type SourceDiscoveryResultV1,
  type SourceEvidenceHostVerifier,
  type SourceStepReaderV1,
  type SourceStepSearcherV1,
} from "../src/inputs/index.js";
import { hostRootSet } from "../src/security/egress.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

const HOST = "gitlab.example.com";
const PROJECT_PATH = "tech-docs/agents/docsfab";
const PROJECT_ID = 437040;
const TARGET_BRANCH = "main";
const RUN_ID = "run-799-t2-search";
const REVISION = "c".repeat(40);
const REPOSITORY_IDENTITY = createHash("sha256").update("/workspace/docsfab").digest("hex");
const WORKSPACE_IDENTITY = createHash("sha256").update("workspace-identity").digest("hex");
const CONTENT_DIGEST = createHash("sha256").update("content").digest("hex");
const PRODUCER_ID = "gitlab-merged-mr";
const PRODUCER_SCOPE = createHash("sha256").update("gitlab-merged-mr-scope").digest("hex");
const PRODUCER_SCOPES = [{ producerId: PRODUCER_ID, scopeSha256: PRODUCER_SCOPE }];
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const READ_SKILLS = ["verify-technical-accuracy", "write-documentation"];
/** Admits both tool families. The binding below is sealed under this digest. */
const POLICY = createSourceStepPolicy({
  sourceReadSkills: READ_SKILLS,
  sourceSearchSkills: ["write-documentation"],
  perStepBudgetBytes: 8 * 1024,
});

/**
 * The bound observation's merge request. Deliberately one of the four the port
 * returns, so narrowing to it is a real filter and not a vacuous pass-through.
 */
const BOUND_MR_IID = 4101;
const BOUND_OBSERVATION_ID = "obs-gitlab-mr-4101";

/**
 * Sentinel bytes that live only in the fixture's merge-request *bodies*.
 *
 * A descriptor is a handle, not a copy of the evidence, so none of these may
 * appear anywhere in a search payload. They are deliberately unlike anything
 * the descriptor shape can legitimately carry.
 */
const ROW_TITLE_SENTINEL = "ZZQTITLE-merge-request-headline-must-not-reach-a-descriptor";
const ROW_BODY_SENTINEL = "ZZQBODY-merge-request-description-must-not-reach-a-descriptor";
const BOUND_SPAN_SENTINEL = "ZZQSPAN-sealed-evidence-text-must-not-reach-a-search-result";

/**
 * Credential-shaped fixture, made one of DocsFab's own configured credentials
 * by each test that plants the value (#1807). It exists only in this file and
 * is never written to any artefact, fixture directory, or shipped module.
 */
const CREDENTIAL_FIXTURE = ["glpat", plantedCredentialValue(68, 24)].join("-");

const WINDOW = resolveMergedMrDateWindow({
  timeZone: "UTC",
  startDate: "2026-09-01",
  endDate: "2026-09-30",
});

const workspaces: string[] = [];
afterAll(async () => {
  for (const path of workspaces) await rm(path, { recursive: true, force: true });
});

function row(iid: number, mergedAt: string, overrides: Partial<MergedMrRecordV1> = {}) {
  return {
    iid,
    state: "merged",
    mergedAt,
    targetBranch: TARGET_BRANCH,
    mergeCommitSha: sha(`merge-${iid}`).slice(0, 40),
    squashCommitSha: null,
    sourceBranch: `agent/${iid}`,
    url: `https://${HOST}/${PROJECT_PATH}/-/merge_requests/${iid}`,
    title: `${ROW_TITLE_SENTINEL} ${iid}`,
    description: `${ROW_BODY_SENTINEL} ${iid}`,
    ...overrides,
  } satisfies MergedMrRecordV1;
}

/** Page 1 and page 2 carry disjoint merge-request numbers on purpose. */
const PAGE_ONE_ROWS = [
  row(BOUND_MR_IID, "2026-09-20T12:00:00.000Z"),
  row(4102, "2026-09-18T12:00:00.000Z"),
];
const PAGE_TWO_ROWS = [
  row(4207, "2026-09-10T12:00:00.000Z"),
  row(4208, "2026-09-05T12:00:00.000Z"),
];

/** A port that records every page it was asked for, so "zero reads" is provable. */
function countingPort(pages: readonly MergedMrPageV1[]) {
  const requested: number[] = [];
  return {
    requested,
    port: {
      orderedDescendingByMergedAt: true,
      async fetchPage(page: number): Promise<MergedMrPageV1> {
        requested.push(page);
        const fetched = pages[page - 1];
        if (!fetched) throw Object.assign(new Error("no such page"), { code: "response" });
        return fetched;
      },
    },
  };
}

function pagedPort() {
  return countingPort([
    { items: PAGE_ONE_ROWS, nextPage: 2 },
    { items: PAGE_TWO_ROWS, nextPage: null },
  ]);
}

const identityPort = {
  async resolveProjectIdentity(input: { host: string; projectPath: string }) {
    return { host: input.host, projectPath: input.projectPath, projectId: PROJECT_ID };
  },
};

async function provedScope(): Promise<GitLabAcquisitionScopeV1> {
  return resolveGitLabAcquisitionScope({
    reference: { host: HOST, projectPath: PROJECT_PATH },
    identityPort,
  });
}

/**
 * Seal one GitLab merge request as a bound observation under `verifierPolicy`.
 *
 * `verifierPolicy` is separated from the policy the binding was minted under so
 * the resolver's own digest comparison can be exercised.
 */
async function buildCapability(verifierPolicySha256: string = POLICY.policySha256) {
  const requestSha256 = projectSourceRequestContext(
    {
      workflow: "update-documentation",
      workspacePath: "/workspace/docsfab",
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
      allowWrite: true,
    },
    {
      runId: RUN_ID,
      workspaceIdentitySha256: WORKSPACE_IDENTITY,
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    },
  );
  const bytes = new TextEncoder().encode(`${BOUND_SPAN_SENTINEL}\n`);
  const { representation, derivative } = await extractSourceRepresentation({
    adapter: textSourceExtractorAdapter,
    bytes,
    mediaType: "text/plain",
  });
  const observation = createSourceObservation({
    observationId: BOUND_OBSERVATION_ID,
    originIdSha256: sha("origin"),
    inputId: "input-gitlab-mr-4101",
    registrationSha256: sha("registration"),
    runIdSha256: sha(RUN_ID),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    requestSha256,
    producerId: PRODUCER_ID,
    producerVersion: "1",
    producerScopeSha256: PRODUCER_SCOPE,
    acquisitionReceiptSha256: sha("receipt"),
    observedAt: "2026-09-16T10:00:00.000Z",
    original: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType: "text/plain",
      locatorSha256: sha(gitlabMrSourceRepositoryPath(BOUND_MR_IID)),
      version: { kind: "repository-revision", revision: REVISION },
      repositoryPath: gitlabMrSourceRepositoryPath(BOUND_MR_IID),
    },
    representations: [representation],
  });
  const binding = createSourceBinding({
    runIdSha256: sha(RUN_ID),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    requestSha256,
    hostPolicySha256: POLICY.policySha256,
    producerScopeSha256: digestSourceProducerScopes(PRODUCER_SCOPES),
    parentBindingSha256: null,
    observations: [
      { observationId: BOUND_OBSERVATION_ID, observationSha256: observation.observationSha256 },
    ],
    requiredObservationIds: [BOUND_OBSERVATION_ID],
  });
  const capture = openExternalInputAccessCapture({
    runIdSha256: sha(RUN_ID),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
  });
  const { contentDigestSha256 } = registerFakeExternalInput(capture, observation.inputId, {
    adapterKind: "repository-document",
    canonicalLocator: `repository-document:${gitlabMrSourceRepositoryPath(BOUND_MR_IID)}`,
    safeTitle: "Merged merge request",
    body: Buffer.from(derivative).toString("utf8"),
    version: { kind: "repository-revision", revision: REVISION },
    visibility: "internal",
    disclosurePolicy: "cite-and-quote",
    intendedRoles: ["evidence"],
  });
  const verifier: SourceEvidenceHostVerifier = {
    verifyCurrent: () => undefined,
    hostPolicySha256: verifierPolicySha256,
    producerScopes: PRODUCER_SCOPES,
    resolveBinding: (digest) => (digest === binding.bindingSha256 ? binding : undefined),
    resolveObservation: (id) => (id === observation.observationId ? observation : undefined),
    resolveDerivative: ({ representationId }) =>
      representationId === representation.representationId ? derivative : undefined,
    recordAccess: ({ stepId, spanIds }) =>
      recordExternalInputAccess(capture, {
        inputId: observation.inputId,
        stepId,
        outcome: "opened",
        observedContentDigestSha256: contentDigestSha256!,
        accessorId: "docsfab-read-source",
        evidenceSha256s: [sha(spanIds.join(","))],
      }).observationSha256,
    now: () => new Date("2026-09-16T10:05:00.000Z"),
  };
  const service = createSourceEvidenceService(createSourceEvidenceHostAuthority(verifier));
  return service.bindRun(
    createSourceArtifactReference({
      kind: "source-binding",
      digest: binding.bindingSha256,
      repositoryRevision: REVISION,
      repositoryContentDigest: CONTENT_DIGEST,
    }),
    {
      runId: RUN_ID,
      requestSha256,
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
      workspaceIdentitySha256: WORKSPACE_IDENTITY,
      repositoryContentDigest: CONTENT_DIGEST,
    },
  );
}

async function stepReader(): Promise<SourceStepReaderV1> {
  const capability = await buildCapability();
  return capability.forStep({
    stepId: "write-documentation",
    workflow: "update-documentation",
    readSource: true,
    remainingBudgetBytes: POLICY.perStepBudgetBytes,
  })!;
}

async function toolSet(input: { reader?: SourceStepReaderV1; searcher?: SourceStepSearcherV1 }) {
  const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-source-search-"));
  workspaces.push(workspacePath);
  const set = await createConfinedToolSet({
    workspacePath,
    allowWrite: false,
    ...(input.reader ? { sourceReader: input.reader } : {}),
    ...(input.searcher ? { sourceSearcher: input.searcher } : {}),
  });
  return { workspacePath, ...set };
}

function searchTool(definitions: Array<{ name: string }>) {
  return definitions.find((definition) => definition.name === "docsfab_search_sources") as
    | { execute: (...args: any[]) => Promise<any>; parameters: any }
    | undefined;
}

interface SearchPayload {
  kind: string;
  truncated: boolean;
  windowCovered: boolean;
  scope: { providerId: string; host: string; projectId: number; projectPath: string | null };
  descriptorCount: number;
  descriptors: Array<{ locator: string; mergeRequestIid: number; projectId: number }>;
  inapplicable: unknown[];
  cursor: { resumable: boolean; nextPage: number | null; lastGoodPage: number };
  coverage: {
    pagesRead: number;
    windowCovered: boolean;
    descriptorLimitReached: boolean;
    excluded: Array<{
      iid: number;
      reason: string;
      mergedAt: string | null;
      targetBranch: string | null;
    }>;
  };
}

async function searched(
  tool: { execute: (...args: any[]) => Promise<any> },
  params: Record<string, unknown> = {},
) {
  const result = await tool.execute("call-1", params);
  return {
    raw: result.content[0].text as string,
    details: result.details as { descriptorCount: number; windowCovered: boolean },
    payload: JSON.parse(result.content[0].text) as SearchPayload,
  };
}

/** A granted step with a live reader, a proved scope, and a counting page port. */
async function grantedSearch(options: { pages?: ReturnType<typeof pagedPort> } = {}) {
  const reader = await stepReader();
  const scope = await provedScope();
  const paged = options.pages ?? pagedPort();
  const searcher = createSourceStepSearcher({
    scope,
    reader,
    port: paged.port,
    window: WINDOW,
    targetBranch: TARGET_BRANCH,
  });
  const set = await toolSet({ reader, searcher });
  return { reader, scope, paged, searcher, set, tool: searchTool(set.definitions)! };
}

describe("docsfab_search_sources admission (#799 T2)", () => {
  it("names the search tool beside the two reading tools", () => {
    expect([...SOURCE_READ_TOOL_NAMES]).toEqual(["docsfab_list_sources", "docsfab_read_source"]);
    expect([...SOURCE_SEARCH_TOOL_NAMES]).toEqual(["docsfab_search_sources"]);
    expect([...PRESERVATION_SOURCE_READ_TOOL_NAMES]).toEqual(["docsfab_read_preservation_source"]);
    expect([...SOURCE_TOOL_NAMES]).toEqual([
      "docsfab_list_sources",
      "docsfab_read_source",
      "docsfab_read_preservation_source",
      "docsfab_search_sources",
      // A third grant composes onto the same vocabulary; the grant is still
      // assembled from the read/search/cite lists, never from this one.
      "docsfab_cite_source",
    ]);
  });

  it("exposes docsfab_search_sources only when the host handed this step a live reader", async () => {
    const reader = await stepReader();
    const scope = await provedScope();
    const searcher = createSourceStepSearcher({
      scope,
      reader,
      port: pagedPort().port,
      window: WINDOW,
      targetBranch: TARGET_BRANCH,
    });

    // Absence is asserted on the definition list, never on a thrown error: a
    // tool that threw at call time would still be advertised to the model.
    const withoutEither = await toolSet({});
    expect(searchTool(withoutEither.definitions)).toBeUndefined();

    // A reader alone registers the read tools and no search tool.
    const readerOnly = await toolSet({ reader });
    expect(searchTool(readerOnly.definitions)).toBeUndefined();
    expect(readerOnly.definitions.map((definition) => definition.name)).toContain(
      "docsfab_read_source",
    );

    // A searcher without a reader registers nothing at all: the two grants are
    // never separated, because a descriptor is only useful to a step that can
    // go on to read the evidence it names.
    const searcherOnly = await toolSet({ searcher });
    expect(searcherOnly.definitions.map((definition) => definition.name)).not.toContain(
      "docsfab_search_sources",
    );

    // Positive control: the same tool set with both halves present.
    const granted = await toolSet({ reader, searcher });
    expect(searchTool(granted.definitions)).toBeDefined();
  });

  it("adds the search tool to the model grant set only under a live searcher", () => {
    expect(grantedTools("write", "inference", undefined, true, false)).not.toContain(
      "docsfab_search_sources",
    );
    expect(grantedTools("write", "inference", undefined, true, false)).toContain(
      "docsfab_read_source",
    );
    expect(grantedTools("write", "inference", undefined, true, true)).toContain(
      "docsfab_search_sources",
    );
    expect(grantedTools("read-only", "inference", undefined, false, false)).not.toContain(
      "docsfab_search_sources",
    );
  });

  it("gives the model no way to name a project, a path, a branch, or a window", async () => {
    const { tool } = await grantedSearch();
    expect(Object.keys(tool.parameters.properties).sort()).toEqual([
      "maxDescriptors",
      "observationId",
    ]);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.required).toEqual([]);
  });

  it("returns bounded descriptors, a cursor, and a coverage verdict", async () => {
    const { tool, paged } = await grantedSearch();
    const { payload, details } = await searched(tool);
    expect(payload.kind).toBe("docsfab-source-search");
    expect(payload.scope).toEqual({
      providerId: "gitlab-merged-mr",
      host: HOST,
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
    });
    expect(payload.descriptorCount).toBe(payload.descriptors.length);
    expect(details).toEqual({ descriptorCount: payload.descriptors.length, windowCovered: true });
    expect(payload.cursor).toEqual({ resumable: false, nextPage: null, lastGoodPage: 2 });
    expect(paged.requested).toEqual([1, 2]);
  });

  it("searches past the first page and returns the later page's merge requests", async () => {
    // Page 2's merge-request numbers are disjoint from page 1's, so a walk that
    // stopped after the first page cannot accidentally satisfy this.
    const { tool, paged } = await grantedSearch();
    const { payload } = await searched(tool);
    const iids = payload.descriptors.map((descriptor) => descriptor.mergeRequestIid).sort();
    expect(iids).toEqual([4101, 4102, 4207, 4208]);
    expect(payload.descriptors.map((descriptor) => descriptor.locator)).toContain(
      `gitlab-mr:v1:host=${HOST}:project=${PROJECT_ID}:mr=4207`,
    );
    expect(paged.requested).toEqual([1, 2]);
    expect(payload.coverage.pagesRead).toBe(2);
    expect(payload.windowCovered).toBe(true);
  });

  it("bounds a search result to the configured descriptor cap and flags truncation", async () => {
    // Boundary fixture: the same port shape at the cap and at the cap plus one.
    const atCap = await grantedSearch({
      pages: countingPort([{ items: PAGE_ONE_ROWS, nextPage: null }]) as ReturnType<
        typeof pagedPort
      >,
    });
    const exact = await searched(atCap.tool, { maxDescriptors: PAGE_ONE_ROWS.length });
    expect(exact.payload.descriptorCount).toBe(PAGE_ONE_ROWS.length);
    expect(exact.payload.truncated).toBe(false);
    expect(exact.payload.coverage.descriptorLimitReached).toBe(false);
    expect(exact.payload.windowCovered).toBe(true);

    const overCap = await grantedSearch({
      pages: countingPort([
        { items: [...PAGE_ONE_ROWS, PAGE_TWO_ROWS[0]!], nextPage: null },
      ]) as ReturnType<typeof pagedPort>,
    });
    const over = await searched(overCap.tool, { maxDescriptors: PAGE_ONE_ROWS.length });
    expect(over.payload.descriptorCount).toBe(PAGE_ONE_ROWS.length);
    expect(over.payload.truncated).toBe(true);
    expect(over.payload.coverage.descriptorLimitReached).toBe(true);
    // A capped walk never claims the window was covered.
    expect(over.payload.windowCovered).toBe(false);
  });

  it("returns no source text from a search result", async () => {
    const { tool } = await grantedSearch();
    const { raw, payload } = await searched(tool);
    // Guard against a vacuous pass: the payload really does carry descriptors,
    // one per fixture row, so "contains none of the body bytes" is a statement
    // about a populated result rather than about an empty list.
    expect(payload.descriptors).toHaveLength(PAGE_ONE_ROWS.length + PAGE_TWO_ROWS.length);
    // The fixture bodies exist and are non-empty; the payload contains none of
    // them, nor any byte of the sealed observation's derivative.
    expect(ROW_TITLE_SENTINEL.length).toBeGreaterThan(0);
    expect(raw).not.toContain(ROW_TITLE_SENTINEL);
    expect(raw).not.toContain(ROW_BODY_SENTINEL);
    expect(raw).not.toContain(BOUND_SPAN_SENTINEL);
    // A benign-fixture tripwire only. It asserts the absence of something this
    // fixture never introduces, so it proves nothing on its own; the
    // load-bearing host-root proofs are the projection tests below, which inject
    // a real host root into a field that does reach the payload.
    expect(raw).not.toMatch(/(?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\)/u);
    expect(raw).not.toContain(tmpdir());
  });

  it("replaces this host's roots in excluded rows the search relays and keeps a documentation path", async () => {
    // Driven through the real discovery walk, not a stub searcher:
    // `coverage.excluded[].targetBranch` relays row text verbatim, and only a
    // real walk produces an exclusion row.
    const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-source-root-"));
    workspaces.push(workspacePath);
    const scratch = "/scratch/docsfab-tmp";
    const reader = await stepReader();
    const paged = countingPort([
      {
        items: [
          ...PAGE_ONE_ROWS,
          row(4301, "2026-09-08T12:00:00.000Z", { targetBranch: `${workspacePath}/docs/guide.md` }),
          row(4302, "2026-09-07T12:00:00.000Z", { targetBranch: "/usr/bin/env" }),
          row(4303, "2026-09-06T12:00:00.000Z", { targetBranch: `${scratch}/secret-notes.txt` }),
        ],
        nextPage: null,
      },
    ]);
    const failures: string[] = [];
    const definitions = createSourceToolDefinitions({
      reader,
      searcher: createSourceStepSearcher({
        scope: await provedScope(),
        reader,
        port: paged.port,
        window: WINDOW,
        targetBranch: TARGET_BRANCH,
      }),
      recordFailure: (category) => failures.push(category),
      hostRoots: hostRootSet(
        [
          { kind: "workspace", path: workspacePath },
          { kind: "tmp", path: scratch },
        ],
        { platform: "linux" },
      ),
    });
    const { raw, payload } = await searched(searchTool(definitions)!);
    expect(raw).not.toContain(workspacePath);
    expect(raw).not.toContain(scratch);
    const branches = new Map(
      payload.coverage.excluded.map((entry) => [entry.iid, entry.targetBranch]),
    );
    expect(branches.get(4301)).toBe("docs/guide.md");
    expect(branches.get(4302)).toBe("/usr/bin/env");
    expect(branches.get(4303)).toBe("$TMPDIR/secret-notes.txt");
    expect(failures).toEqual([]);
  });

  it("leaves a declared public HOME in a search payload and replaces it when undeclared", async () => {
    const reader = await stepReader();
    const scope = await provedScope();
    const search = async () => {
      const paged = countingPort([
        {
          items: [
            ...PAGE_ONE_ROWS,
            row(4301, "2026-09-08T12:00:00.000Z", { targetBranch: "/home/node/docs" }),
          ],
          nextPage: null,
        },
      ]);
      const definitions = createSourceToolDefinitions({
        reader,
        searcher: createSourceStepSearcher({
          scope,
          reader,
          port: paged.port,
          window: WINDOW,
          targetBranch: TARGET_BRANCH,
        }),
        recordFailure: () => undefined,
      });
      const { payload } = await searched(searchTool(definitions)!);
      return payload.coverage.excluded.find((entry) => entry.iid === 4301)?.targetBranch;
    };
    vi.stubEnv("HOME", "/home/node");
    try {
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "/home/node");
      expect(await search()).toBe("/home/node/docs");
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "");
      expect(await search()).toBe("~/docs");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("names a path under the run's workspace or checkout repository-relative in a confined search", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-source-workspace-"));
    workspaces.push(workspacePath);
    const checkout = "/srv/checkouts/docs-project";
    const reader = await stepReader();
    const paged = countingPort([
      {
        items: [
          ...PAGE_ONE_ROWS,
          row(4301, "2026-09-08T12:00:00.000Z", { targetBranch: `${workspacePath}/docs/guide.md` }),
          row(4302, "2026-09-07T12:00:00.000Z", { targetBranch: `${checkout}/docs/other.md` }),
        ],
        nextPage: null,
      },
    ]);
    const set = await createConfinedToolSet({
      workspacePath,
      allowWrite: false,
      repositoryWorkspace: {
        path: workspacePath,
        sourcePath: checkout,
        requestedRevision: "HEAD",
        revision: "a".repeat(40),
        dispose: async () => undefined,
      },
      sourceReader: reader,
      sourceSearcher: createSourceStepSearcher({
        scope: await provedScope(),
        reader,
        port: paged.port,
        window: WINDOW,
        targetBranch: TARGET_BRANCH,
      }),
    });
    const { raw, payload } = await searched(searchTool(set.definitions)!);
    expect(raw).not.toContain(workspacePath);
    expect(raw).not.toContain(checkout);
    const branches = new Map(
      payload.coverage.excluded.map((entry) => [entry.iid, entry.targetBranch]),
    );
    expect(branches.get(4301)).toBe("docs/guide.md");
    expect(branches.get(4302)).toBe("docs/other.md");
  });

  it("replaces the process tmpdir in a search payload when no roots are supplied", async () => {
    const scratch = "/scratch/docsfab-default-tmp";
    const reader = await stepReader();
    const scope = await provedScope();
    const paged = countingPort([
      {
        items: [
          ...PAGE_ONE_ROWS,
          row(4301, "2026-09-08T12:00:00.000Z", { targetBranch: `${scratch}/notes.txt` }),
        ],
        nextPage: null,
      },
    ]);
    vi.stubEnv("TMPDIR", scratch);
    try {
      expect(tmpdir()).toBe(scratch);
      const definitions = createSourceToolDefinitions({
        reader,
        searcher: createSourceStepSearcher({
          scope,
          reader,
          port: paged.port,
          window: WINDOW,
          targetBranch: TARGET_BRANCH,
        }),
        recordFailure: () => undefined,
      });
      const { raw, payload } = await searched(searchTool(definitions)!);
      expect(raw).not.toContain(scratch);
      expect(payload.coverage.excluded.find((entry) => entry.iid === 4301)?.targetBranch).toBe(
        "$TMPDIR/notes.txt",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses an invalid public-roots declaration when the search tool is built", async () => {
    const reader = await stepReader();
    const searcher = createSourceStepSearcher({
      scope: await provedScope(),
      reader,
      port: countingPort([{ items: PAGE_ONE_ROWS, nextPage: null }]).port,
      window: WINDOW,
      targetBranch: TARGET_BRANCH,
    });
    vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "relative/root");
    try {
      expect(() =>
        createSourceToolDefinitions({ reader, searcher, recordFailure: () => undefined }),
      ).toThrow(/public-roots-invalid/u);
      // Without a searcher nothing projects host roots, so nothing reads the declaration.
      expect(() =>
        createSourceToolDefinitions({ reader, recordFailure: () => undefined }),
      ).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("narrows a search to a merge request bound to this run", async () => {
    // Positive control for the refusal below: a bound observation resolves to
    // exactly one of the four merge requests the port returned.
    const { tool, paged } = await grantedSearch();
    const { payload } = await searched(tool, { observationId: BOUND_OBSERVATION_ID });
    expect(payload.descriptors.map((descriptor) => descriptor.mergeRequestIid)).toEqual([
      BOUND_MR_IID,
    ]);
    expect(paged.requested).toEqual([1, 2]);
  });

  it("refuses a search naming an observation outside the sealed binding", async () => {
    const { tool, paged } = await grantedSearch();
    await expect(
      tool.execute("call-1", { observationId: "obs-from-some-other-run" }),
    ).rejects.toThrowError(
      "DocsFab refused this source read because the host reported observation-unavailable.",
    );
    // Fails closed before a page is read.
    expect(paged.requested).toEqual([]);
  });

  it("refuses a search issued with an unproved scope before any page is read", async () => {
    const reader = await stepReader();
    const proved = await provedScope();
    const paged = pagedPort();
    // Structurally identical to the proved scope, down to every own field, but
    // it is a different object and was never minted by the provider. This is
    // exactly the reconstructed scope a serialization round trip produces.
    const reconstructed = { ...proved } as GitLabAcquisitionScopeV1;
    expect(reconstructed).toEqual({ ...proved });

    expect(() =>
      createSourceStepSearcher({
        scope: reconstructed,
        reader,
        port: paged.port,
        window: WINDOW,
        targetBranch: TARGET_BRANCH,
      }),
    ).toThrowError(/no longer proved/u);
    expect(paged.requested).toEqual([]);

    // And through the confined tool, for a searcher whose scope lost its proof
    // after construction: still zero reads, and a content-free refusal that
    // names both the condition and the remediation.
    let live = proved;
    const searcher = createSourceStepSearcher({
      get scope() {
        return live;
      },
      reader,
      port: paged.port,
      window: WINDOW,
      targetBranch: TARGET_BRANCH,
    } as never);
    live = reconstructed;
    const set = await toolSet({ reader, searcher });
    await expect(searchTool(set.definitions)!.execute("call-1", {})).rejects.toThrowError(
      /DocsFab refused this source search because the host reported scope-identity\..*without reconstructing it\./su,
    );
    expect(paged.requested).toEqual([]);
    expect(set.getFailureCategories()).toContainEqual({ category: "denied-path", count: 1 });
  });

  it("withholds a configured credential in a search result before it reaches the model", async () => {
    configureCredential(CREDENTIAL_FIXTURE);
    const reader = await stepReader();
    const scope = await provedScope();
    const realSearcher = createSourceStepSearcher({
      scope,
      reader,
      port: pagedPort().port,
      window: WINDOW,
      targetBranch: TARGET_BRANCH,
    });
    const clean = await realSearcher.search({});

    // A searcher that returned a result the discovery screen never saw. The
    // search payload's egress screen refuses it with the discovery credential
    // code, ahead of the confinement boundary every confined tool goes through.
    const tainted: SourceDiscoveryResultV1 = {
      ...clean,
      descriptors: clean.descriptors.map((descriptor, index) =>
        index === 0 ? { ...descriptor, targetBranch: `release/${CREDENTIAL_FIXTURE}` } : descriptor,
      ),
    };
    const taintedSet = await toolSet({
      reader,
      searcher: {
        async search() {
          return tainted;
        },
      },
    });
    const refusal = await searchTool(taintedSet.definitions)!
      .execute("call-1", {})
      .then(() => undefined)
      .catch((error: unknown) => error as Error);
    expect(refusal?.message).toMatch(
      /^DocsFab refused this source search because the host reported credentials\./u,
    );
    expect(refusal?.message).not.toContain(CREDENTIAL_FIXTURE);

    // Positive control: the identical stub with an ordinary branch name passes
    // the same boundary, so the rejection above is the credential and not the
    // stub.
    const benignSet = await toolSet({
      reader,
      searcher: {
        async search() {
          return clean;
        },
      },
    });
    const { payload } = await searched(searchTool(benignSet.definitions)!);
    expect(payload.descriptorCount).toBeGreaterThan(0);

    // A branch name with a credential shape that is not configured is not a
    // credential: the same stub passes the boundary (#1807).
    const shaped = ["glpat", plantedCredentialValue(69, 24)].join("-");
    const shapedSet = await toolSet({
      reader,
      searcher: {
        async search() {
          return {
            ...clean,
            descriptors: clean.descriptors.map((descriptor, index) =>
              index === 0 ? { ...descriptor, targetBranch: `release/${shaped}` } : descriptor,
            ),
          };
        },
      },
    });
    const shapedSearch = await searched(searchTool(shapedSet.definitions)!);
    expect(shapedSearch.payload.descriptorCount).toBe(payload.descriptorCount);
    expect(shapedSearch.raw).toContain(shaped);
  });

  it("withholds a search result egress cannot walk under its own code, not as credentials", async () => {
    const reader = await stepReader();
    const clean = await createSourceStepSearcher({
      scope: await provedScope(),
      reader,
      port: pagedPort().port,
      window: WINDOW,
      targetBranch: TARGET_BRANCH,
    }).search({});
    const unwalkable = {
      ...clean,
      descriptors: clean.descriptors.map((descriptor, index) =>
        index === 0 ? { ...descriptor, targetBranch: new Date(0) } : descriptor,
      ),
    } as unknown as SourceDiscoveryResultV1;
    const set = await toolSet({
      reader,
      searcher: {
        async search() {
          return unwalkable;
        },
      },
    });
    await expect(searchTool(set.definitions)!.execute("call-1", {})).rejects.toThrowError(
      `DocsFab refused this source search because the host reported egress-unwalkable-value. ${SOURCE_DISCOVERY_REFUSALS["egress-unwalkable-value"]}`,
    );
  });

  it("pins the model-visible descriptor ceiling to its exact value", async () => {
    // Every other cap assertion in this file refers to the symbol, so all of
    // them survive widening the constant. This one fixes the number a model
    // actually sees, and drives a literal ceiling-plus-one fixture through the
    // real tool so the pin is executing rather than decorative.
    expect(SOURCE_SEARCH_MAX_DESCRIPTORS).toBe(50);

    const reader = await stepReader();
    const scope = await provedScope();
    const clean = await createSourceStepSearcher({
      scope,
      reader,
      port: pagedPort().port,
      window: WINDOW,
      targetBranch: TARGET_BRANCH,
    }).search({});
    const fiftyOne: SourceDiscoveryResultV1 = {
      ...clean,
      descriptors: Array.from({ length: 51 }, (_unused, index) => ({
        ...clean.descriptors[0]!,
        mergeRequestIid: 9000 + index,
      })),
      inapplicable: [],
      coverage: {
        ...clean.coverage,
        descriptorLimitReached: false,
        duplicateRows: [],
        truncatedPages: [],
        notRequested: [],
        excluded: [],
      },
    };
    const set = await toolSet({
      reader,
      searcher: {
        async search() {
          return fiftyOne;
        },
      },
    });
    const { payload, raw } = await searched(searchTool(set.definitions)!);
    expect(payload.descriptors).toHaveLength(50);
    expect(payload.truncated).toBe(true);
    // Guard the guard: this fixture must be clipped by the row ceiling, not by
    // the byte ceiling, or widening the constant would still be caught for the
    // wrong reason.
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(SOURCE_SEARCH_PAYLOAD_CEILING_BYTES);
    expect(searchTool(set.definitions)!.parameters.properties.maxDescriptors.maximum).toBe(50);
  });

  it("clamps a rendered payload to the sealed per-step byte ceiling", async () => {
    // Rows are not bytes. The row caps bound how many entries a payload holds;
    // this bounds how large it is, which is what actually enters the prompt.
    const reader = await stepReader();
    const scope = await provedScope();
    const clean = await createSourceStepSearcher({
      scope,
      reader,
      port: pagedPort().port,
      window: WINDOW,
      targetBranch: TARGET_BRANCH,
    }).search({});

    // One descriptor with one padded ASCII field, so payload bytes grow one for
    // one with the pad and the boundary can be hit exactly rather than guessed.
    const padded = async (padLength: number) => {
      const result: SourceDiscoveryResultV1 = {
        ...clean,
        descriptors: [{ ...clean.descriptors[0]!, targetBranch: "b".repeat(padLength) }],
        inapplicable: [],
        coverage: {
          ...clean.coverage,
          descriptorLimitReached: false,
          duplicateRows: [],
          truncatedPages: [],
          notRequested: [],
          excluded: [],
        },
      };
      const set = await toolSet({
        reader,
        searcher: {
          async search() {
            return result;
          },
        },
      });
      const { raw, payload } = await searched(searchTool(set.definitions)!);
      return { bytes: Buffer.byteLength(raw, "utf8"), payload };
    };

    // Measure the envelope from the shipped renderer, then compute the pad that
    // lands exactly on the ceiling. Nothing here is a pasted byte count.
    const base = await padded(0);
    const exactPad = SOURCE_SEARCH_PAYLOAD_CEILING_BYTES - base.bytes;
    expect(exactPad).toBeGreaterThan(0);

    const atCeiling = await padded(exactPad);
    expect(atCeiling.bytes).toBe(SOURCE_SEARCH_PAYLOAD_CEILING_BYTES);
    expect(atCeiling.payload.truncated).toBe(false);
    expect(atCeiling.payload.descriptors).toHaveLength(1);

    const overCeiling = await padded(exactPad + 1);
    expect(overCeiling.bytes).toBeLessThanOrEqual(SOURCE_SEARCH_PAYLOAD_CEILING_BYTES);
    expect(overCeiling.payload.truncated).toBe(true);
  });

  it("keeps the module ceiling above every per-call ceiling a model may ask for", async () => {
    const { tool } = await grantedSearch();
    expect(tool.parameters.properties.maxDescriptors.maximum).toBe(SOURCE_SEARCH_MAX_DESCRIPTORS);
    // A wider per-call ask is clamped, not honoured.
    const { payload } = await searched(tool, { maxDescriptors: SOURCE_SEARCH_MAX_DESCRIPTORS });
    expect(payload.descriptors.length).toBeLessThanOrEqual(SOURCE_SEARCH_MAX_DESCRIPTORS);
  });

  it("caps an over-returning searcher at the tool's own ceiling and flags truncation", async () => {
    // The shipped searcher already clamps, so this exercises the tool's own
    // last-resort bound against a host wiring mistake: the one thing a model
    // must never obtain from one is an unbounded descriptor list.
    const reader = await stepReader();
    const scope = await provedScope();
    const clean = await createSourceStepSearcher({
      scope,
      reader,
      port: pagedPort().port,
      window: WINDOW,
      targetBranch: TARGET_BRANCH,
    }).search({});
    const overReturning: SourceDiscoveryResultV1 = {
      ...clean,
      descriptors: Array.from({ length: SOURCE_SEARCH_MAX_DESCRIPTORS + 1 }, (_unused, index) => ({
        ...clean.descriptors[0]!,
        mergeRequestIid: 5000 + index,
      })),
      coverage: { ...clean.coverage, descriptorLimitReached: false },
    };
    const set = await toolSet({
      reader,
      searcher: {
        async search() {
          return overReturning;
        },
      },
    });
    const { payload } = await searched(searchTool(set.definitions)!);
    expect(payload.descriptors).toHaveLength(SOURCE_SEARCH_MAX_DESCRIPTORS);
    expect(payload.descriptorCount).toBe(SOURCE_SEARCH_MAX_DESCRIPTORS);
    // The searcher claimed the walk was complete; the tool still reports the
    // trim rather than passing off a shortened list as a full answer.
    expect(payload.truncated).toBe(true);
  });

  it("bounds the coverage report's row-derived lists, not only the descriptors", async () => {
    // A walk may legitimately read a thousand rows inside its window. The
    // descriptor cap alone would still let one exclusion entry per skipped row
    // reach the prompt under the heading of a bounded search.
    const reader = await stepReader();
    const scope = await provedScope();
    const clean = await createSourceStepSearcher({
      scope,
      reader,
      port: pagedPort().port,
      window: WINDOW,
      targetBranch: TARGET_BRANCH,
    }).search({});
    const rowCount = SOURCE_SEARCH_MAX_DESCRIPTORS * 4;
    const chatty: SourceDiscoveryResultV1 = {
      ...clean,
      coverage: {
        ...clean.coverage,
        descriptorLimitReached: false,
        duplicateRows: Array.from({ length: rowCount }, (_unused, index) => 6000 + index),
        truncatedPages: Array.from({ length: rowCount }, (_unused, index) => index + 1),
        notRequested: Array.from({ length: rowCount }, (_unused, index) => 7000 + index),
        excluded: Array.from({ length: rowCount }, (_unused, index) => ({
          iid: 8000 + index,
          reason: "other-target-branch" as const,
          mergedAt: "2026-09-12T12:00:00.000Z",
          targetBranch: "release/24.09",
        })),
      },
    };
    const set = await toolSet({
      reader,
      searcher: {
        async search() {
          return chatty;
        },
      },
    });
    const { payload } = await searched(searchTool(set.definitions)!);
    const coverage = payload.coverage as unknown as Record<string, unknown[]>;
    for (const field of ["duplicateRows", "truncatedPages", "notRequested", "excluded"]) {
      expect(coverage[field]).toHaveLength(SOURCE_SEARCH_MAX_DESCRIPTORS);
    }
    expect(payload.truncated).toBe(true);
    // Positive control: an ordinary result is relayed whole and is not flagged.
    const honestSet = await toolSet({
      reader,
      searcher: {
        async search() {
          return clean;
        },
      },
    });
    const honest = await searched(searchTool(honestSet.definitions)!);
    expect(honest.payload.truncated).toBe(false);
  });
});

describe("source-step policy admission for search (#799 T2)", () => {
  it("changes the source-step policy digest when the tool set changes", () => {
    // Both policies are computed by the shipped function over fixtures that
    // differ in exactly one field. Nothing here is a pasted digest.
    const readOnly = createSourceStepPolicy({
      sourceReadSkills: READ_SKILLS,
      perStepBudgetBytes: 8 * 1024,
    });
    const withSearch = createSourceStepPolicy({
      sourceReadSkills: READ_SKILLS,
      sourceSearchSkills: ["write-documentation"],
      perStepBudgetBytes: 8 * 1024,
    });

    expect([...readOnly.admittedTools]).toEqual(["docsfab_list_sources", "docsfab_read_source"]);
    expect([...withSearch.admittedTools]).toEqual([
      "docsfab_list_sources",
      "docsfab_read_source",
      "docsfab_search_sources",
    ]);
    expect(withSearch.policySha256).not.toBe(readOnly.policySha256);

    // Positive control: the digest is a function of the inputs, so identical
    // inputs still agree. Without this the assertion above would also pass for
    // a digest that was simply random.
    expect(
      createSourceStepPolicy({ sourceReadSkills: READ_SKILLS, perStepBudgetBytes: 8 * 1024 })
        .policySha256,
    ).toBe(readOnly.policySha256);
    expect(readOnly.policySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("makes the moved digest load-bearing in the resolver", async () => {
    // The binding is sealed under the search-admitting policy. A host still
    // running the read-only policy refuses it rather than silently binding a
    // run under a tool set it never admitted.
    const readOnly = createSourceStepPolicy({
      sourceReadSkills: READ_SKILLS,
      perStepBudgetBytes: 8 * 1024,
    });
    await expect(buildCapability(readOnly.policySha256)).rejects.toThrowError(
      "Source evidence service refused: policy-mismatch.",
    );
    // Positive control: the same binding under the policy it was sealed with.
    await expect(buildCapability(POLICY.policySha256)).resolves.toBeDefined();
  });

  it("admits search only to a skill the same policy admits to reads", () => {
    expect(() =>
      createSourceStepPolicy({
        sourceReadSkills: ["write-documentation"],
        sourceSearchSkills: ["lint-documentation"],
      }),
    ).toThrowError(/Add lint-documentation to sourceReadSkills/u);

    expect(stepAdmitsSourceSearch(POLICY, { skill: "write-documentation" })).toBe(true);
    expect(stepAdmitsSourceSearch(POLICY, { skill: "verify-technical-accuracy" })).toBe(false);
    expect(stepAdmitsSourceSearch(undefined, { skill: "write-documentation" })).toBe(false);
    // The read grant is unchanged by the search opt-in.
    expect(stepAdmitsSourceRead(POLICY, { skill: "verify-technical-accuracy" })).toBe(true);
  });

  it("refuses a search grant to a hand-built policy that admits no read for the skill", () => {
    // The minter refuses this shape, so it can only reach `stepAdmitsSourceSearch`
    // from a boundary that did not mint it — which is exactly the case the
    // function's read-grant conjunct exists for, and the case the subset-rule
    // test above does not cover, because that one exercises the minter.
    const handBuilt = {
      schemaVersion: 1,
      kind: "docsfab-source-step-policy",
      sourceReadSkills: ["write-documentation"],
      sourceSearchSkills: ["lint-documentation"],
      admittedTools: ["docsfab_list_sources", "docsfab_read_source", "docsfab_search_sources"],
      perStepBudgetBytes: 8 * 1024,
      policySha256: "0".repeat(64),
    } as unknown as Parameters<typeof stepAdmitsSourceSearch>[0];

    // In `sourceSearchSkills`, absent from `sourceReadSkills`. The grant must be
    // the narrower of the two.
    expect(stepAdmitsSourceSearch(handBuilt, { skill: "lint-documentation" })).toBe(false);
    expect(stepAdmitsSourceRead(handBuilt, { skill: "lint-documentation" })).toBe(false);

    // Positive control on the same hand-built object: a skill listed in both is
    // still granted, so the refusal above is the conjunct and not a blanket
    // rejection of unminted policies.
    const consistent = {
      ...(handBuilt as unknown as Record<string, unknown>),
      sourceSearchSkills: ["write-documentation"],
    } as unknown as Parameters<typeof stepAdmitsSourceSearch>[0];
    expect(stepAdmitsSourceSearch(consistent, { skill: "write-documentation" })).toBe(true);

    // And the minter would never have produced the first shape.
    expect(() =>
      createSourceStepPolicy({
        sourceReadSkills: ["write-documentation"],
        sourceSearchSkills: ["lint-documentation"],
      }),
    ).toThrowError(/Add lint-documentation to sourceReadSkills/u);
  });

  it("leaves a policy that names no search skill with the shipped tool set", () => {
    const unamended = createSourceStepPolicy({ sourceReadSkills: READ_SKILLS });
    expect([...unamended.sourceSearchSkills]).toEqual([]);
    expect([...unamended.admittedTools]).not.toContain("docsfab_search_sources");
    for (const skill of READ_SKILLS) {
      expect(stepAdmitsSourceSearch(unamended, { skill })).toBe(false);
      expect(stepAdmitsSourceRead(unamended, { skill })).toBe(true);
    }
  });
});
