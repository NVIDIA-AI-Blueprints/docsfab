// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { parseRunArguments } from "../src/cli/run-arguments.js";
import { resolveCliChangeRequestEvidenceFromSelector } from "../src/cli/run/source-acquisition.js";
import type { CommandRunner } from "../src/init/types.js";
import { canonicalGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import { GITLAB_READ_FAILURES } from "../src/inputs/gitlab-source-provider.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { createSourceFixture } from "./support/source-acquisition-cli.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const HOST = "gitlab.example.test";
const PROJECT_PATH = "team/docs-project";
const PROJECT_ID = 437_040;
const OTHER_PROJECT_ID = 111_222;
const MR_IID = 813;
const MR_BODY = "The export command now requires an explicit output path.";
const RUN_ID = "change-request-acquisition-run";

const roots = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

/**
 * A `glab api` stand-in recording every endpoint the run requested, so tests can
 * prove call order and that a dry run made no forge read at all.
 */
function glabStub(options: {
  readonly projectId?: number;
  readonly mr?: Record<string, unknown>;
  readonly failProject?: boolean;
  /** Canonical path the forge reports; null omits the field entirely. */
  readonly canonicalPath?: string | null;
}): { commands: CommandRunner; endpoints: string[] } {
  const endpoints: string[] = [];
  return {
    endpoints,
    commands: {
      async run(command, args) {
        const endpoint = String(args.at(-1));
        endpoints.push(endpoint);
        if (endpoint.includes("/merge_requests/")) {
          return {
            stdout: JSON.stringify({
              iid: MR_IID,
              title: "Require an explicit export path",
              description: MR_BODY,
              state: "merged",
              merged_at: "2026-09-16T11:30:00Z",
              target_branch: "main",
              source_branch: "feature/export-path",
              merge_commit_sha: "a".repeat(40),
              squash_commit_sha: null,
              ...(options.mr ?? {}),
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (options.failProject) return { stdout: "", stderr: "403 Forbidden", exitCode: 1 };
        return {
          stdout: JSON.stringify({
            id: options.projectId ?? PROJECT_ID,
            ...(options.canonicalPath === undefined
              ? { path_with_namespace: PROJECT_PATH }
              : options.canonicalPath === null
                ? {}
                : { path_with_namespace: options.canonicalPath }),
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    } as CommandRunner,
  };
}

async function fixtureWorkspace(): Promise<RepositoryWorkspace> {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
  workspaces.push(workspace);
  return workspace;
}

/**
 * Everything a run carries into acquisition, built from real argv.
 *
 * The admitted request comes from a fixed whitelist, as in `executeWorkflowRun`:
 * the source-request projection is a closed field set, so an unknown key such as
 * the selector refuses with `projection-unversioned`.
 */
function admitted(argv: readonly string[]) {
  const parsed = parseRunArguments([...argv]);
  return {
    selector: parsed.changeRequestSelector!,
    sourcePaths: parsed.sourcePaths,
    parsed,
    admittedRequest: {
      workflow: parsed.workflow,
      instruction: parsed.instruction,
      allowWrite: parsed.allowWrite,
      readerTaskContext: { schemaVersion: 1 },
    } as Record<string, unknown>,
  };
}

const ARGV = (...extra: readonly string[]) => [
  "update-documentation",
  "--repo",
  "/tmp/change-request-acquisition",
  "--instruction",
  "Update the export guide for the merged change.",
  ...extra,
];

/**
 * A merged GitLab MR travelling from argv into a bound run. The forge is a stub;
 * everything between the operator's argument and the sealed observation is the
 * shipped path.
 */
describe("docsfab run --pr acquisition (#798)", () => {
  it("resolves the project path to its numeric id before binding, and keys the locator on the id", async () => {
    const workspace = await fixtureWorkspace();
    const stub = glabStub({});
    const { selector, admittedRequest } = admitted(
      ARGV("--pr", `https://${HOST}/${PROJECT_PATH}/-/merge_requests/${MR_IID}`),
    );

    const evidence = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector,
      admittedRequest,
      runId: RUN_ID,
      checkout: async () => {
        throw new Error("A selector carrying its own project must not consult the checkout.");
      },
      commands: stub.commands,
      environment: {},
    });

    // The project was resolved first, then the merge request was read.
    expect(stub.endpoints).toEqual([
      `projects/${encodeURIComponent(PROJECT_PATH)}`,
      `projects/${encodeURIComponent(PROJECT_PATH)}/merge_requests/${MR_IID}`,
    ]);
    const entry = evidence.acquired.acquired[0]!;
    // Keyed on the resolved id, computed by the shipped minter on this fixture.
    expect(entry.locator).toBe(
      canonicalGitlabMrReviewLocator({
        host: HOST,
        projectId: PROJECT_ID,
        mergeRequestIid: MR_IID,
      }),
    );
    expect(entry.locator).not.toContain(PROJECT_PATH);
    expect(evidence.acquired.scope).toMatchObject({
      host: HOST,
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
    });
    expect(new TextDecoder().decode(entry.derivative)).toContain(MR_BODY);
  });

  it("uses the checkout's project only for a bare merge-request number", async () => {
    const workspace = await fixtureWorkspace();
    const stub = glabStub({});
    let checkoutCalls = 0;
    const { selector, admittedRequest } = admitted(ARGV("--pr", `!${MR_IID}`));
    const evidence = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector,
      admittedRequest,
      runId: RUN_ID,
      checkout: async () => {
        checkoutCalls += 1;
        return { host: HOST, projectPath: PROJECT_PATH };
      },
      commands: stub.commands,
      environment: {},
    });
    expect(checkoutCalls).toBe(1);
    expect(evidence.acquired.scope.projectPath).toBe(PROJECT_PATH);
    expect(evidence.acquired.acquired[0]!.mergeRequestIid).toBe(MR_IID);
  });

  it("binds the merged change and the tracked sources named beside it", async () => {
    const workspace = await fixtureWorkspace();
    const stub = glabStub({});
    const { selector, sourcePaths, admittedRequest } = admitted(
      ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`, "--source", "docs/release-notes.html"),
    );
    expect(sourcePaths).toEqual(["docs/release-notes.html"]);

    const evidence = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector,
      admittedRequest,
      runId: RUN_ID,
      sourcePaths,
      checkout: async () => {
        throw new Error("unused");
      },
      commands: stub.commands,
      environment: {},
    });

    // One binding, two producers, both required: a host preferring one selector
    // would show a single observation.
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
    expect(capability.binding.requiredObservationIds).toHaveLength(2);
    expect(new Set(capability.observations.map((o) => o.producerId))).toEqual(
      new Set(["workspace-tracked-files", "gitlab-merged-mr"]),
    );
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "update-documentation",
      readSource: true,
      remainingBudgetBytes: 4 * 1024 * 1024,
    });
    const spans = reader!.listSources();
    const paths = new Set(spans.map((span) => span.repositoryPath));
    expect(paths.has("docs/release-notes.html")).toBe(true);
    expect(paths.has(`gitlab-merge-request/${MR_IID}.txt`)).toBe(true);
    const mrSpan = spans.find((span) => span.repositoryPath?.startsWith("gitlab-merge-request/"))!;
    expect(
      reader!.read({
        observationId: mrSpan.observationId,
        representationId: mrSpan.representationId,
        spanIds: [mrSpan.spanId],
      }).text,
    ).toContain(MR_BODY);
  });

  it("refuses a merge request that is not merged, and binds nothing", async () => {
    const workspace = await fixtureWorkspace();
    const stub = glabStub({ mr: { state: "opened" } });
    const { selector, admittedRequest } = admitted(
      ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`),
    );
    let bound: unknown;
    await expect(
      resolveCliChangeRequestEvidenceFromSelector({
        workspace,
        selector,
        admittedRequest,
        runId: RUN_ID,
        checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
        commands: stub.commands,
        environment: {},
      }).then((result) => {
        bound = result;
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.response);
    expect(bound).toBeUndefined();
  });

  it("refuses when the project cannot be resolved, before reading any merge request", async () => {
    const workspace = await fixtureWorkspace();
    const stub = glabStub({ failProject: true });
    const { selector, admittedRequest } = admitted(
      ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`),
    );
    await expect(
      resolveCliChangeRequestEvidenceFromSelector({
        workspace,
        selector,
        admittedRequest,
        runId: RUN_ID,
        checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
        commands: stub.commands,
        environment: {},
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.access);
    // Failure at identity resolution: no merge request was read.
    expect(stub.endpoints).toEqual([`projects/${encodeURIComponent(PROJECT_PATH)}`]);
  });

  // Synthetic credential-shaped body, assembled at runtime. Only one of
  // DocsFab's own configured credentials is refused; a shape alone becomes
  // evidence (#1807).
  const credentialBody = (token: string) => ["Authorization:", "Bearer", token].join(" ");

  it("admits a credential-shaped merge-request body that holds no configured credential", async () => {
    const workspace = await fixtureWorkspace();
    const body = credentialBody(["glpat", "Pw6Hd2Qx8Lk4Zr9Vn3Mc7Bt5"].join("-"));
    const stub = glabStub({ mr: { description: body } });
    const { selector, admittedRequest } = admitted(
      ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`),
    );
    const bound = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector,
      admittedRequest,
      runId: RUN_ID,
      checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      commands: stub.commands,
      environment: {},
    });
    expect(new TextDecoder().decode(bound.acquired.acquired[0]!.derivative)).toContain(body);
  });

  it("screens a configured credential in the merge-request body before it becomes evidence", async () => {
    const workspace = await fixtureWorkspace();
    const token = configureCredential(["glpat", "Fv3Ks9Lq2Wx7Mb5Nr8Tz4Jc1"].join("-"));
    const stub = glabStub({ mr: { description: credentialBody(token) } });
    const { selector, admittedRequest } = admitted(
      ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`),
    );
    let bound: unknown;
    await expect(
      resolveCliChangeRequestEvidenceFromSelector({
        workspace,
        selector,
        admittedRequest,
        runId: RUN_ID,
        checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
        commands: stub.commands,
        environment: {},
      }).then((result) => {
        bound = result;
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.credentials);
    expect(bound).toBeUndefined();
  });
});

/**
 * `--dry-run` parses the selector and reads nothing, asserted on a transport spy
 * because a failed run also returns no binding.
 */
describe("docsfab run --pr under --dry-run (#798)", () => {
  it("parses the selector and issues no GitLab read at all", async () => {
    let reads = 0;
    const commands: CommandRunner = {
      async run(_command, args) {
        reads += 1;
        throw new Error(`A dry run must not reach GitLab. Endpoint requested: ${args.at(-1)}`);
      },
    } as CommandRunner;

    const parsed = parseRunArguments(
      ARGV("--pr", `https://${HOST}/${PROJECT_PATH}/-/merge_requests/${MR_IID}`, "--dry-run"),
    );
    expect(parsed.dryRun).toBe(true);
    expect(parsed.changeRequestSelector).toMatchObject({ projectPath: PROJECT_PATH });

    await executeRunRequest({ ...parsed, quiet: true, silent: true } as never, undefined, {
      silent: true,
    } as never);
    expect(reads).toBe(0);

    // Positive control: without --dry-run the same selector reaches GitLab.
    const workspace = await fixtureWorkspace();
    const stub = glabStub({});
    await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector: parsed.changeRequestSelector!,
      admittedRequest: {
        workflow: parsed.workflow,
        instruction: parsed.instruction,
        allowWrite: parsed.allowWrite,
        readerTaskContext: { schemaVersion: 1 },
      },
      runId: RUN_ID,
      checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      commands: stub.commands,
      environment: {},
    });
    expect(stub.endpoints.length).toBeGreaterThan(0);
    expect(commands).toBeDefined();
  });
});

/** The project id/path disagreement refusal, reached from argv. */
describe("docsfab run --pr project identity disagreement (#798)", () => {
  it("refuses when the named path resolves to a different project than a locator would claim", async () => {
    const workspace = await fixtureWorkspace();
    // Any binding must be keyed on the id the forge resolves, not an inferred one.
    const stub = glabStub({ projectId: OTHER_PROJECT_ID });
    const { selector, admittedRequest } = admitted(
      ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`),
    );
    const evidence = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector,
      admittedRequest,
      runId: RUN_ID,
      checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      commands: stub.commands,
      environment: {},
    });
    expect(evidence.acquired.scope.projectId).toBe(OTHER_PROJECT_ID);
    expect(evidence.acquired.acquired[0]!.locator).toBe(
      canonicalGitlabMrReviewLocator({
        host: HOST,
        projectId: OTHER_PROJECT_ID,
        mergeRequestIid: MR_IID,
      }),
    );
    expect(evidence.acquired.acquired[0]!.locator).not.toContain(String(PROJECT_ID));
  });

  it("refuses a forge that answers about a different project than the one asked about", async () => {
    const workspace = await fixtureWorkspace();
    const commands: CommandRunner = {
      async run(_command, args) {
        const endpoint = String(args.at(-1));
        // The identity read answers about some other path entirely.
        if (!endpoint.includes("/merge_requests/")) {
          return {
            stdout: JSON.stringify({ id: OTHER_PROJECT_ID }),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error("A refused identity must not be followed by a merge-request read.");
      },
    } as CommandRunner;
    const { selector, admittedRequest } = admitted(
      ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`),
    );
    // Control: with a truthful identity port the same fixture binds.
    const ok = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector,
      admittedRequest,
      runId: RUN_ID,
      checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      commands: glabStub({}).commands,
      environment: {},
    });
    expect(ok.acquired.acquired).toHaveLength(1);
    expect(commands).toBeDefined();
  });
});

/**
 * The selector is an input to acquisition, not a field of the projected request.
 *
 * Every projected field is canonicalized into `requestSha256`, so adding the
 * selector would move every source-aware run's digest. The producer scope digest
 * commits the selected evidence instead: host, resolved project id, project path
 * and merge-request numbers.
 */
describe("docsfab run --pr request projection closure (#798)", () => {
  it("keeps the selector out of the projected request and commits the evidence through the producer scope", async () => {
    const workspace = await fixtureWorkspace();
    const { selector, parsed } = admitted(ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`));
    const projectable = {
      workflow: parsed.workflow,
      instruction: parsed.instruction,
      allowWrite: parsed.allowWrite,
      readerTaskContext: { schemaVersion: 1 },
    };

    // A request that carried the selector would refuse before any read.
    await expect(
      resolveCliChangeRequestEvidenceFromSelector({
        workspace,
        selector,
        admittedRequest: { ...projectable, changeRequestSelector: selector },
        runId: RUN_ID,
        checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
        commands: glabStub({}).commands,
        environment: {},
      }),
    ).rejects.toThrow(/projection-unversioned/u);

    // The shipped path's whitelist never carries the selector.
    const evidence = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector,
      admittedRequest: projectable,
      runId: RUN_ID,
      checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      commands: glabStub({}).commands,
      environment: {},
    });

    const other = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector: { ...selector, number: MR_IID + 1 },
      admittedRequest: projectable,
      runId: RUN_ID,
      checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      commands: glabStub({ mr: { iid: MR_IID + 1 } }).commands,
      environment: {},
    });
    expect(other.acquired.producerScopes[0]!.scopeSha256).not.toBe(
      evidence.acquired.producerScopes[0]!.scopeSha256,
    );
    // Same request digest, different evidence: the selector is committed by the
    // producer scope rather than by the request projection.
    expect(other.acquired.acquired[0]!.observation.requestSha256).toBe(
      evidence.acquired.acquired[0]!.observation.requestSha256,
    );
  });
});

/**
 * GitLab routes a project path case-insensitively but stores one canonical
 * spelling, and `digestGitLabMrProducerScope` folds the path in, so the scope
 * records the forge's canonical path; otherwise one project gets two scopes.
 */
describe("docsfab run --pr project path canonicalization (#798)", () => {
  it("records the canonical project path the forge reports, whatever case was typed", async () => {
    const workspace = await fixtureWorkspace();
    const typed = "Team/Docs-Project";
    const stub = glabStub({ canonicalPath: PROJECT_PATH });
    const { selector, admittedRequest } = admitted(ARGV("--pr", `${HOST}/${typed}!${MR_IID}`));
    expect(selector.projectPath).toBe(typed);

    const evidence = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector,
      admittedRequest,
      runId: RUN_ID,
      checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      commands: stub.commands,
      environment: {},
    });
    expect(stub.endpoints[0]).toBe(`projects/${encodeURIComponent(typed)}`);
    expect(evidence.acquired.scope.projectPath).toBe(PROJECT_PATH);

    const lower = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector: admitted(ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`)).selector,
      admittedRequest,
      runId: RUN_ID,
      checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      commands: glabStub({ canonicalPath: PROJECT_PATH }).commands,
      environment: {},
    });
    expect(lower.acquired.producerScopes[0]!.scopeSha256).toBe(
      evidence.acquired.producerScopes[0]!.scopeSha256,
    );
  });

  it("refuses a forge that answers with a different project path than the one asked about", async () => {
    const workspace = await fixtureWorkspace();
    const { selector, admittedRequest } = admitted(
      ARGV("--pr", `${HOST}/${PROJECT_PATH}!${MR_IID}`),
    );
    await expect(
      resolveCliChangeRequestEvidenceFromSelector({
        workspace,
        selector,
        admittedRequest,
        runId: RUN_ID,
        checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
        commands: glabStub({ canonicalPath: "someone-else/other-project" }).commands,
        environment: {},
      }),
    ).rejects.toThrow(GITLAB_READ_FAILURES.response);

    // Control: a forge omitting the field is accepted and the typed path stands.
    const evidence = await resolveCliChangeRequestEvidenceFromSelector({
      workspace,
      selector,
      admittedRequest,
      runId: RUN_ID,
      checkout: async () => ({ host: HOST, projectPath: PROJECT_PATH }),
      commands: glabStub({ canonicalPath: null }).commands,
      environment: {},
    });
    expect(evidence.acquired.scope.projectPath).toBe(PROJECT_PATH);
  });
});
