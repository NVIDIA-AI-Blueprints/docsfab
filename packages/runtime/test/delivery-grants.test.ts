// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLICATION_REMOTE,
  DEFAULT_REPOSITORY_PATH,
  DELIVERY_FLAG_CONFLICT_NEXT_ACTIONS,
  DeliveryFlagOperatorError,
  publicationProhibitionConflict,
  resolveInteractiveDeliveryGrants,
  resolvePublicationRemoteName,
  type DeliveryFlagConflict,
  type InteractiveDeliveryGrantInput,
} from "../src/cli/delivery-grants.js";
import { workflowDeliveryCapabilities } from "../src/workflow-contracts/delivery.js";
import { getWorkflow, RUNNABLE_WORKFLOW_NAMES } from "../src/workflow-registry/catalog.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";

const NO_FLAGS = {
  dryRun: false,
  patchOnly: false,
  draftMrFlag: false,
  allowWriteFlag: false,
  commentMr: false,
  routeOnly: false,
  explicitComposition: false,
} as const;

function refusalOf(input: InteractiveDeliveryGrantInput): DeliveryFlagOperatorError {
  try {
    resolveInteractiveDeliveryGrants(input);
  } catch (error) {
    if (error instanceof DeliveryFlagOperatorError) return error;
    throw error;
  }
  throw new Error(`expected a coded delivery refusal for ${JSON.stringify(input)}`);
}

describe("interactive delivery grants", () => {
  it("defaults write workflows to write and one draft merge request", () => {
    expect(DEFAULT_REPOSITORY_PATH).toBe(".");
    expect(DEFAULT_PUBLICATION_REMOTE).toBe("origin");
    expect(
      resolveInteractiveDeliveryGrants({
        workflow: "create-documentation",
        dryRun: false,
        patchOnly: false,
        draftMrFlag: false,
        allowWriteFlag: false,
        commentMr: false,
        routeOnly: false,
        explicitComposition: false,
      }),
    ).toEqual({ allowWrite: true, draftMr: true });
    expect(resolvePublicationRemoteName(undefined, true)).toBe("origin");
  });

  it("opts out of publication with --patch-only and of write with --dry-run", () => {
    expect(
      resolveInteractiveDeliveryGrants({
        workflow: "update-documentation",
        dryRun: false,
        patchOnly: true,
        draftMrFlag: false,
        allowWriteFlag: false,
        commentMr: false,
        routeOnly: false,
        explicitComposition: false,
      }),
    ).toEqual({ allowWrite: true, draftMr: false });
    expect(
      resolveInteractiveDeliveryGrants({
        workflow: "restructure-documentation",
        dryRun: true,
        patchOnly: false,
        draftMrFlag: false,
        allowWriteFlag: false,
        commentMr: false,
        routeOnly: false,
        explicitComposition: false,
      }),
    ).toEqual({ allowWrite: false, draftMr: false });
    expect(resolvePublicationRemoteName(undefined, false)).toBeUndefined();
  });

  it("does not default a read-only workflow to a draft merge request", () => {
    expect(
      resolveInteractiveDeliveryGrants({
        workflow: "review-documentation",
        dryRun: false,
        patchOnly: false,
        draftMrFlag: false,
        allowWriteFlag: false,
        commentMr: false,
        routeOnly: false,
        explicitComposition: false,
      }),
    ).toEqual({ allowWrite: false, draftMr: false });
    expect(() =>
      resolveInteractiveDeliveryGrants({
        workflow: "review-documentation",
        dryRun: false,
        patchOnly: false,
        draftMrFlag: true,
        allowWriteFlag: true,
        commentMr: false,
        routeOnly: false,
        explicitComposition: false,
      }),
    ).toThrow(/has no write step to deliver/u);
    expect(() => resolvePublicationRemoteName("origin", false)).toThrow(
      /only used when opening a draft merge request/u,
    );
  });

  it("matches every runnable workflow's flags to its write and delivery adapters", () => {
    const expectedCapabilities = {
      bootstrap: { patchOnly: true, draftMr: false, requiresExplicitWriteGrant: true },
      "review-documentation": {
        patchOnly: false,
        draftMr: false,
        requiresExplicitWriteGrant: false,
      },
      "create-documentation": { patchOnly: true, draftMr: true, requiresExplicitWriteGrant: false },
      "update-documentation": { patchOnly: true, draftMr: true, requiresExplicitWriteGrant: false },
      "restructure-documentation": {
        patchOnly: true,
        draftMr: true,
        requiresExplicitWriteGrant: false,
      },
      readiness: { patchOnly: false, draftMr: false, requiresExplicitWriteGrant: false },
      "release-documentation-readiness": {
        patchOnly: false,
        draftMr: false,
        requiresExplicitWriteGrant: false,
      },
      "audit-documentation": {
        patchOnly: false,
        draftMr: false,
        requiresExplicitWriteGrant: false,
      },
    } as const;
    expect(RUNNABLE_WORKFLOW_NAMES).toEqual(Object.keys(expectedCapabilities));

    for (const workflow of RUNNABLE_WORKFLOW_NAMES) {
      const capability = workflowDeliveryCapabilities(getWorkflow(workflow));
      expect(capability, workflow).toEqual(expectedCapabilities[workflow]);
      expect(
        resolveInteractiveDeliveryGrants({ workflow, ...NO_FLAGS }),
        `${workflow} default`,
      ).toEqual(
        expectedCapabilities[workflow].requiresExplicitWriteGrant
          ? { allowWrite: false, draftMr: false }
          : expectedCapabilities[workflow].draftMr
            ? { allowWrite: true, draftMr: true }
            : { allowWrite: false, draftMr: false },
      );
      const allowWrite = resolveInteractiveDeliveryGrants({
        workflow,
        ...NO_FLAGS,
        allowWriteFlag: true,
      });
      expect(allowWrite).toEqual({
        allowWrite: true,
        draftMr: capability.draftMr,
      });

      if (capability.patchOnly) {
        if (capability.requiresExplicitWriteGrant) {
          expect(
            refusalOf({ workflow, ...NO_FLAGS, patchOnly: true }).code,
            `${workflow} requires explicit write authority`,
          ).toBe("delivery-flag-conflict");
        } else {
          expect(
            resolveInteractiveDeliveryGrants({ workflow, ...NO_FLAGS, patchOnly: true }),
            `${workflow} patch-only default`,
          ).toEqual({ allowWrite: true, draftMr: false });
        }
        expect(
          resolveInteractiveDeliveryGrants({
            workflow,
            ...NO_FLAGS,
            patchOnly: true,
            allowWriteFlag: true,
          }),
          workflow,
        ).toEqual({ allowWrite: true, draftMr: false });
      } else {
        const refusal = refusalOf({ workflow, ...NO_FLAGS, patchOnly: true });
        expect(refusal.code, workflow).toBe("workflow-delivery-flag-unsupported");
        expect(refusal.message, workflow).toContain("has no write step to produce a local patch");
      }

      if (capability.draftMr) {
        expect(
          resolveInteractiveDeliveryGrants({ workflow, ...NO_FLAGS, draftMrFlag: true }),
          workflow,
        ).toEqual({ allowWrite: true, draftMr: true });
      } else {
        const refusal = refusalOf({ workflow, ...NO_FLAGS, draftMrFlag: true });
        expect(refusal.code, workflow).toBe("workflow-delivery-flag-unsupported");
        expect(refusal.message, workflow).toContain(
          capability.patchOnly
            ? "has no draft-MR delivery adapter"
            : "has no write step to deliver",
        );
      }
    }
  });

  it("keeps bootstrap patch delivery separate from its explicit write grant", () => {
    const refusal = refusalOf({ workflow: "bootstrap", ...NO_FLAGS, patchOnly: true });
    expect(refusal).toMatchObject({
      code: "delivery-flag-conflict",
      message:
        "bootstrap requires --allow-write to authorize its write step; --patch-only selects delivery but does not grant writes.",
      nextAction: DELIVERY_FLAG_CONFLICT_NEXT_ACTIONS["patch-only/allow-write"],
    });
    expect(
      resolveInteractiveDeliveryGrants({
        workflow: "bootstrap",
        ...NO_FLAGS,
        patchOnly: true,
        allowWriteFlag: true,
      }),
    ).toEqual({ allowWrite: true, draftMr: false });
  });

  it("keeps explicit-composition writes patch-only unless --draft-mr is explicit", () => {
    expect(
      resolveInteractiveDeliveryGrants({
        workflow: "create-documentation",
        dryRun: false,
        patchOnly: false,
        draftMrFlag: false,
        allowWriteFlag: false,
        commentMr: false,
        routeOnly: false,
        explicitComposition: true,
      }),
    ).toEqual({ allowWrite: true, draftMr: false });
    expect(
      resolveInteractiveDeliveryGrants({
        workflow: "create-documentation",
        dryRun: false,
        patchOnly: false,
        draftMrFlag: true,
        allowWriteFlag: false,
        commentMr: false,
        routeOnly: false,
        explicitComposition: true,
      }),
    ).toEqual({ allowWrite: true, draftMr: true });
  });

  it("codes every delivery-flag pair refusal with its one next action", () => {
    const pairs: ReadonlyArray<
      readonly [Partial<InteractiveDeliveryGrantInput>, DeliveryFlagConflict, string]
    > = [
      [
        { dryRun: true, patchOnly: true },
        "dry-run/patch-only",
        "--dry-run option cannot be combined with --patch-only",
      ],
      [
        { dryRun: true, draftMrFlag: true },
        "dry-run/draft-mr",
        "--dry-run option cannot be combined with --draft-mr",
      ],
      [
        { patchOnly: true, draftMrFlag: true },
        "patch-only/draft-mr",
        "--patch-only option cannot be combined with --draft-mr",
      ],
      [
        { dryRun: true, allowWriteFlag: true },
        "dry-run/allow-write",
        "--dry-run option cannot be combined with --allow-write",
      ],
      [
        { commentMr: true, draftMrFlag: true },
        "comment-mr/draft-mr",
        "--comment-mr option cannot be combined with --draft-mr",
      ],
      [
        { commentMr: true, patchOnly: true },
        "comment-mr/patch-only",
        "--comment-mr option cannot be combined with --patch-only",
      ],
      [
        { dryRun: true, commentMr: true },
        "dry-run/comment-mr",
        "--dry-run option cannot be combined with --comment-mr",
      ],
    ];
    for (const [flags, conflict, message] of pairs) {
      const refusal = refusalOf({ workflow: "update-documentation", ...NO_FLAGS, ...flags });
      expect(refusal.code, conflict).toBe("delivery-flag-conflict");
      expect(refusal.message, conflict).toContain(message);
      expect(refusal.nextAction, conflict).toBe(DELIVERY_FLAG_CONFLICT_NEXT_ACTIONS[conflict]);
    }
    expect(() => resolvePublicationRemoteName("upstream", false)).toThrow(
      expect.objectContaining({
        code: "delivery-flag-conflict",
        nextAction: DELIVERY_FLAG_CONFLICT_NEXT_ACTIONS["remote/no-draft-mr"],
      }),
    );
  });

  it("refuses a write flag the workflow cannot take with a code and one next action", () => {
    const patch = refusalOf({ workflow: "review-documentation", ...NO_FLAGS, patchOnly: true });
    expect(patch).toMatchObject({
      code: "workflow-delivery-flag-unsupported",
      message:
        "review-documentation has no write step to produce a local patch, so it cannot take --patch-only.",
      nextAction:
        "Omit --patch-only to run review-documentation, or select bootstrap, create-documentation, update-documentation, or restructure-documentation to retain a local patch.",
    });
    const draft = refusalOf({ workflow: "readiness", ...NO_FLAGS, draftMrFlag: true });
    expect(draft).toMatchObject({
      code: "workflow-delivery-flag-unsupported",
      message: "readiness has no write step to deliver, so it cannot take --draft-mr.",
      nextAction:
        "Omit --draft-mr to run readiness, or select create-documentation, update-documentation, or restructure-documentation to open a draft merge request.",
    });
    const bootstrapDraft = refusalOf({ workflow: "bootstrap", ...NO_FLAGS, draftMrFlag: true });
    expect(bootstrapDraft.message).toContain("has no draft-MR delivery adapter");
    expect(
      resolveInteractiveDeliveryGrants({
        workflow: "bootstrap",
        ...NO_FLAGS,
        allowWriteFlag: true,
      }),
    ).toEqual({ allowWrite: true, draftMr: false });
    // A read-only workflow takes --allow-write unchanged: it never writes.
    expect(
      resolveInteractiveDeliveryGrants({
        workflow: "review-documentation",
        ...NO_FLAGS,
        allowWriteFlag: true,
      }),
    ).toEqual({ allowWrite: true, draftMr: false });
  });

  it("codes the publication prohibition conflict with one next action", () => {
    expect(publicationProhibitionConflict()).toMatchObject({
      code: "publication-prohibition-conflict",
      message:
        "The request or effective instruction says not to publish, but this delivery plan would publish. Pass --patch-only to retain a local patch without publishing.",
      nextAction: "Pass --patch-only to retain a local patch without publishing.",
    });
    expect(toOperatorErrorEnvelope(publicationProhibitionConflict()).failure).toEqual({
      class: "operator-input",
      layer: "cli",
      code: "publication-prohibition-conflict",
    });
  });

  it("projects the coded refusal and its next action into the operator envelope", () => {
    const envelope = toOperatorErrorEnvelope(
      refusalOf({ workflow: "review-documentation", ...NO_FLAGS, patchOnly: true }),
    );
    expect(envelope).toMatchObject({
      code: "workflow-delivery-flag-unsupported",
      nextAction:
        "Omit --patch-only to run review-documentation, or select bootstrap, create-documentation, update-documentation, or restructure-documentation to retain a local patch.",
      failure: {
        class: "operator-input",
        layer: "cli",
        code: "workflow-delivery-flag-unsupported",
      },
    });
    const human = formatOperatorErrorEnvelope(envelope);
    expect(human).toContain("code: workflow-delivery-flag-unsupported");
    expect(human).toContain("Next action: Omit --patch-only to run review-documentation");
    expect(human).not.toContain("This workflow does not write a local patch. Omit --patch-only.");
  });
});
