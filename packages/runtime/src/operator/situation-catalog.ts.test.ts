// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formatLimitExceeded, limit } from "../config/limits.js";
import { LocalUserPublicationPreflightError } from "../delivery/contracts.js";
import { LocalUserGitLabPublisherError } from "../delivery/publisher.js";
import {
  DEFAULT_DOCS_ANCHORS,
  DEFAULT_NEXT_ACTIONS,
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "./error-envelope.js";
import { inferRemediationId, remediationText } from "./remediation.js";
import {
  DELIVERY_ACTIONS,
  DOCTOR_DIAGNOSTIC_CODES,
  DOCTOR_DIAGNOSTIC_REMEDIATION,
  NO_SUPPORTED_GITLAB_REMOTE_NEXT_ACTION,
  OPERATOR_REMEDIATION_IDS,
  PUBLICATION_ACTIONS,
  rejectSituation,
  resolveSituationDocsAnchor,
  SituationRejection,
  SITUATION_CATALOG,
  situationRowsForId,
  type DoctorDiagnosticCode,
} from "./situation-catalog.js";

describe("operator situation catalog", () => {
  it("projects missing publication records as operator input with same-store guidance", () => {
    const error = new LocalUserPublicationPreflightError("saved-run-not-found");
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope).toMatchObject({
      code: "saved-run-not-found",
      failure: { class: "operator-input" },
      docsAnchor: "docs/troubleshooting.md",
    });
    expect(envelope.nextAction).toContain("docsfab runs list");
    expect(envelope.nextAction).toContain("same `--state-dir`");
    expect(envelope.message).not.toContain("intact");
  });

  it("is the single source for envelope nextAction, docsAnchor, remediation, and doctor ids", () => {
    expect(DEFAULT_NEXT_ACTIONS["gitlab-unauthenticated"]).toBe(remediationText("glab-auth-login"));
    expect(DEFAULT_NEXT_ACTIONS["schema-mismatch"]).toMatch(/sealed schema/u);
    expect(DEFAULT_DOCS_ANCHORS["glab-auth-login"]).toBe("docs/troubleshooting.md");
    expect(OPERATOR_REMEDIATION_IDS).toContain("glab-auth-login");
    // #1512: a retired model selection is its own doctor class, remediated by
    // the refusal's named successor.
    expect(DOCTOR_DIAGNOSTIC_CODES).toContain("composition-retired");
    expect(DOCTOR_DIAGNOSTIC_REMEDIATION["gitlab-login-missing"]).toBe("glab-auth-login");
    expect(PUBLICATION_ACTIONS["gitlab-unauthenticated"]).toMatch(/Authenticate glab/u);
    expect(DELIVERY_ACTIONS["validation-failed"]).toMatch(/new authorized delivery/u);
  });

  it("keeps doctor as the gold family with every diagnostic id present as a row", () => {
    const doctorIds = new Set(
      SITUATION_CATALOG.filter((row) => row.family === "doctor").map((row) => row.id),
    );
    expect([...doctorIds].sort()).toEqual([...DOCTOR_DIAGNOSTIC_CODES].sort());
    const _typeCheck: DoctorDiagnosticCode = "gitlab-login-missing";
    expect(_typeCheck).toBe("gitlab-login-missing");
  });

  it("uses the single canonical operator row for a missing GitLab remote", () => {
    expect(situationRowsForId("no-supported-gitlab-remote")).toEqual([
      expect.objectContaining({
        family: "operator",
        failureClass: "operator-input",
        inEnvelope: true,
        nextAction: NO_SUPPORTED_GITLAB_REMOTE_NEXT_ACTION,
      }),
    ]);
    expect(DOCTOR_DIAGNOSTIC_CODES).not.toContain("no-supported-gitlab-remote");
  });

  it("attaches Docs from the remediation catalog row when the public code has none", () => {
    expect(DEFAULT_DOCS_ANCHORS["gitlab-unauthenticated"]).toBeUndefined();
    expect(resolveSituationDocsAnchor("gitlab-unauthenticated", "glab-auth-login")).toBe(
      "docs/troubleshooting.md",
    );
    expect(
      inferRemediationId(
        Object.assign(new Error("unauthenticated"), { code: "gitlab-unauthenticated" }),
      ),
    ).toBe("glab-auth-login");
  });

  it("identity-passes rejectSituation into the existing envelope code", () => {
    expect(() => rejectSituation("gitlab-unauthenticated")).toThrow(SituationRejection);
    try {
      rejectSituation("not-a-git-repository", "Checkout is not a Git work tree.");
    } catch (error) {
      expect(error).toBeInstanceOf(SituationRejection);
      expect((error as SituationRejection).code).toBe("not-a-git-repository");
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.kind).toBe("docsfab-operator-error");
      expect(envelope.code).toBe("not-a-git-repository");
      expect(envelope.message).toBe("Checkout is not a Git work tree.");
      expect(formatOperatorErrorEnvelope(envelope)).toMatch(/^Docs:/mu);
    }
  });

  it("does not change publication ACTION bytes for gitlab-unauthenticated", () => {
    const error = new LocalUserPublicationPreflightError("gitlab-unauthenticated");
    expect(error.action).toBe(PUBLICATION_ACTIONS["gitlab-unauthenticated"]);
    expect(error.code).toBe("gitlab-unauthenticated");
  });

  it("names the run-store parent correction without using invalid-run-record", () => {
    expect(PUBLICATION_ACTIONS["state-directory-not-run-store"]).toBe(
      "Pass --state-dir at the run-store directory, not its parent.",
    );
    const error = new LocalUserPublicationPreflightError("state-directory-not-run-store", {
      selectedDirectory: "/tmp/selected-parent",
    });
    expect(error.code).toBe("state-directory-not-run-store");
    expect(error.message).toContain("/tmp/selected-parent");
    expect(error.message).toContain("run-store directory, not its parent");
    expect(error.message).not.toContain("Select an intact DocsFab schema-v2 run record");
  });

  it("gives the refused-Git-setting stop its own next action, not the doctor fallback (#2363)", () => {
    // Literals transcribed from the catalog's remediation row, so a changed or reverted
    // sentence fails here. A code's name holds "configuration", which sent the envelope to
    // `docsfab doctor` until the row carried a remediation id.
    const refused =
      "DocsFab refused a Git setting that can run a command, change how it pushes, or turn signing on. Remove it from the file that sets it; `git config --show-origin --list` shows each setting's file. Then run the same command again. core.sshCommand and core.askPass can move to your global Git config instead, when HOME is an absolute path outside the checkout. If DocsFab had already written the change, run `docsfab publish <run-id>` instead of the same command; the write is preserved.";
    for (const error of [
      new LocalUserGitLabPublisherError("git-configuration-refused"),
      new LocalUserPublicationPreflightError("git-configuration-refused", {
        configuration: { key: "core.sshcommand", origin: "file:.git/config" },
      }),
    ]) {
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.code).toBe("git-configuration-refused");
      expect(envelope.nextAction).toBe(refused);
      expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
      expect(formatOperatorErrorEnvelope(envelope)).not.toContain("docsfab doctor");
    }
    expect(PUBLICATION_ACTIONS["git-configuration-refused"]).toBe(refused);
    expect(DEFAULT_NEXT_ACTIONS["git-configuration-refused"]).toBe(refused);
    expect(remediationText("remove-refused-git-setting")).toBe(refused);
  });

  it("gives the unverifiable-Git-checkout stop its own next action (#2363)", () => {
    const unverified =
      "DocsFab could not verify the checkout's Git setup, and stopped. Check that `git --version` is 2.9.5 or newer, that `git remote get-url --push --all <remote>` prints the one project URL the plan names, that `git config --show-origin --list` prints without an error and gives every setting a value, and that `git config --includes --show-origin --null --list | wc -c` is no larger than delivery.gitConfigurationListingMaxBytes, 2097152 bytes by default (DOCSFAB_DELIVERY_GIT_CONFIGURATION_LISTING_MAX_BYTES raises it). Then run the same command again, or `docsfab publish <run-id>` if DocsFab had already written the change; the write is preserved.";
    for (const error of [
      new LocalUserGitLabPublisherError("git-checkout-unverified"),
      new LocalUserPublicationPreflightError("git-checkout-unverified"),
    ]) {
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.code).toBe("git-checkout-unverified");
      expect(envelope.nextAction).toBe(unverified);
      expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
    }
    expect(PUBLICATION_ACTIONS["git-checkout-unverified"]).toBe(unverified);
    expect(remediationText("repair-git-checkout")).toBe(unverified);
  });

  it("names the refused setting and its file in the preflight message, never a value (#2363)", () => {
    const error = new LocalUserPublicationPreflightError("git-configuration-refused", {
      configuration: { key: "core.sshcommand", origin: "file:~/work/.gitconfig" },
    });
    expect(error.message).toContain(
      "The setting core.sshcommand comes from file:~/work/.gitconfig.",
    );
    // A home directory outside the operator's own is redacted from the origin.
    const other = new LocalUserPublicationPreflightError("git-configuration-refused", {
      configuration: { key: "core.sshcommand", origin: "file:/Users/someone/.gitconfig" },
    });
    expect(other.message).toContain("file:[REDACTED]/.gitconfig");
    expect(other.message).not.toContain("someone");
    // Without a named setting, the message adds no setting sentence.
    expect(
      new LocalUserPublicationPreflightError("git-configuration-refused").message,
    ).not.toContain("The setting");
  });

  it("says when a global file is not trusted because HOME is not the operator's own (#2363)", () => {
    const home = new LocalUserPublicationPreflightError("git-configuration-refused", {
      configuration: {
        key: "core.sshcommand",
        origin: "file:~/.gitconfig",
        reason: "home-not-operator-owned",
      },
    });
    expect(home.message).toContain(
      "The setting core.sshcommand comes from file:~/.gitconfig. DocsFab does not trust that file for this setting because HOME is not an absolute path outside the checkout.",
    );
    // Positive control: a refusal with no reason adds no such sentence.
    const plain = new LocalUserPublicationPreflightError("git-configuration-refused", {
      configuration: { key: "core.sshcommand", origin: "file:.git/config" },
    });
    expect(plain.message).not.toContain("DocsFab does not trust that file");
    // A reason outside the closed vocabulary is not carried into the message.
    const forged = new LocalUserPublicationPreflightError("git-configuration-refused", {
      configuration: {
        key: "core.sshcommand",
        origin: "file:.git/config",
        reason: "anything" as "home-not-operator-owned",
      },
    });
    expect(forged.message).not.toContain("DocsFab does not trust that file");
  });

  it("names the crossed listing limit in the unverified-checkout message, as a limit refusal does (#2363)", () => {
    const listing = limit("delivery.gitConfigurationListingMaxBytes");
    const error = new LocalUserPublicationPreflightError("git-checkout-unverified", {
      limitRefusal: formatLimitExceeded(listing),
    });
    expect(error.message).toContain("delivery-git-configuration-listing-max-bytes-bound");
    expect(error.message).toContain("delivery.gitConfigurationListingMaxBytes = 2097152 bytes");
    expect(error.message).toContain(listing.remediation);
    // Positive control: without a crossed limit the message names none.
    expect(new LocalUserPublicationPreflightError("git-checkout-unverified").message).not.toContain(
      "delivery.gitConfigurationListingMaxBytes = ",
    );
  });

  it("stays an import-free leaf so host cannot reach it through catalog dependencies", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./situation-catalog.ts", import.meta.url)),
      "utf8",
    );
    // The one import is an erased type from the import-free failure-class leaf.
    expect(source.match(/^import\b[^;]*;/gmu) ?? []).toEqual([
      'import type { FailureClass } from "./failure-class.js";',
    ]);
    expect(source).not.toMatch(/^export\b[^;\n]*\bfrom\s+["']/mu);
    const vocabulary = readFileSync(
      fileURLToPath(new URL("./failure-class.ts", import.meta.url)),
      "utf8",
    );
    expect(vocabulary).not.toMatch(/^import\b/mu);
    expect(vocabulary).not.toMatch(/^export\b[^;\n]*\bfrom\s+["']/mu);
  });
});
