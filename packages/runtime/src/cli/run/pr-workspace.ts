// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../../contract-kit/index.js";
import {
  assertGithubPrReviewBasis,
  withGithubPrReviewBasis,
  type GithubPrReviewBasis,
} from "../../inputs/adapters/github-pr-provider.js";
import { withRepositoryWorkspace } from "../../repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import type { RunRequestWithPublishProjection, CliRunOptions } from "./request.js";
import { failGithubPrReviewCli } from "./pr-input.js";

export interface SelectedPrWorkspaceV1 {
  readonly workspace: RepositoryWorkspace;
  readonly basis?: GithubPrReviewBasis;
}

/** Select the private authenticated H workspace before the local resolver can run. */
export async function withSelectedRunWorkspace<T>(input: {
  readonly request: RunRequestWithPublishProjection;
  readonly workspaceRevision: string;
  readonly workspaceRoot: string;
  readonly options: CliRunOptions;
  readonly consume: (selected: SelectedPrWorkspaceV1) => Promise<T>;
}): Promise<T> {
  const { request, options } = input;
  if (!request.githubPrReview) {
    return withRepositoryWorkspace(request.repositoryPath, input.workspaceRevision, (workspace) =>
      input.consume({ workspace }),
    );
  }
  if (
    request.workflow !== "review-documentation" ||
    request.changeSource ||
    request.resumeFrom ||
    options.preparedReviewChange !== undefined ||
    request.reviewDelivery !== undefined
  ) {
    failGithubPrReviewCli("checkout-conflict");
  }
  return withGithubPrReviewBasis(
    request.githubPrReview.url,
    {
      workspaceRoot: input.workspaceRoot,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.githubPrFixturePorts ?? {}),
    },
    async (basis) => {
      assertGithubPrReviewBasis(basis);
      const ref = basis.acquisition.ref;
      if (
        ref.provider !== "github" ||
        ref.objectKind !== "pull-request" ||
        ref.nativeChangeId !== String(request.githubPrReview!.selector.number) ||
        basis.headWorkspace.revision !== basis.acquisition.graph.H ||
        basis.headWorkspace.manifestSha256 !== canonicalDigest(basis.acquisition.manifest) ||
        basis.headInventory.repositoryRevision !== basis.headWorkspace.revision ||
        basis.baseDocumentation.B !== basis.acquisition.graph.B
      ) {
        failGithubPrReviewCli("basis-mismatch");
      }
      return input.consume({ workspace: basis.headWorkspace, basis });
    },
  );
}
