// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  parseGitLabRemote,
  snapshotHostGitLabConfiguration,
} from "../src/maturity/cascade/tracker.js";
import { GitLabRoadmapReader } from "../src/roadmap/gitlab-readonly.js";
import { dnsHostnamePattern, isDnsHostname } from "../src/shared/dns-hostname.js";

const LONGEST_LABEL = "a".repeat(63);
const LONGEST_NAME = `${"a".repeat(63)}.`.repeat(3) + "b".repeat(61);
const OVERLONG_NAME = `${"a".repeat(63)}.`.repeat(3) + "b".repeat(62);

// Refused by every grammar variant.
const NEVER: readonly unknown[] = [
  undefined,
  null,
  42,
  "",
  OVERLONG_NAME,
  `${"a".repeat(64)}.example.com`,
  `gitlab.${"b".repeat(64)}`,
  "gitlab.example.com.",
  ".gitlab.example.com",
  "gitlab..example.com",
  "-gitlab.example.com",
  "gitlab-.example.com",
  "gitlab.example.com:8443",
  "user@gitlab.example.com",
  "gitlab.example.com/group",
  " gitlab.example.com",
  "gitlab.example.com\n",
  "gitlab_ci.example.com",
  "https://gitlab.example.com",
  // Non-ASCII letters that fold to ASCII under a case-insensitive expression.
  "Kelvin.example.com",
  "gitlab.example.ſh",
  "bücher.example.com",
];

describe("DNS hostname grammar", () => {
  it("admits lowercase names of two or more labels up to the DNS length bounds by default", () => {
    expect([LONGEST_NAME.length, OVERLONG_NAME.length]).toEqual([253, 254]);
    for (const host of [
      "gitlab.example.com",
      "a.b",
      "0.example",
      "x-1.example-2.com",
      `${LONGEST_LABEL}.example.com`,
      `gitlab.${LONGEST_LABEL}`,
      LONGEST_NAME,
    ]) {
      expect(isDnsHostname(host), host).toBe(true);
    }
    for (const host of [...NEVER, "localhost", "GitLab.Example.com", "gitlab.EXAMPLE.com"]) {
      expect(isDnsHostname(host), String(host)).toBe(false);
    }
  });

  it("admits ASCII uppercase only when a caller asks for any case", () => {
    expect(isDnsHostname("GitLab.Example.com", { anyCase: true })).toBe(true);
    expect(isDnsHostname(LONGEST_NAME.toUpperCase(), { anyCase: true })).toBe(true);
    for (const host of [...NEVER, "LOCALHOST"]) {
      expect(isDnsHostname(host, { anyCase: true }), String(host)).toBe(false);
    }
  });

  it("admits a single label only when a caller asks for it", () => {
    for (const host of ["localhost", LONGEST_LABEL, "gitlab.example.com", LONGEST_NAME]) {
      expect(isDnsHostname(host, { singleLabel: true }), host).toBe(true);
    }
    for (const host of [...NEVER, "Localhost", "a".repeat(64)]) {
      expect(isDnsHostname(host, { singleLabel: true }), String(host)).toBe(false);
    }
    expect(isDnsHostname("Localhost", { anyCase: true, singleLabel: true })).toBe(true);
    for (const host of NEVER) {
      expect(isDnsHostname(host, { anyCase: true, singleLabel: true }), String(host)).toBe(false);
    }
  });

  it("returns one anchored pattern per grammar variant", () => {
    expect(dnsHostnamePattern()).toBe(dnsHostnamePattern({}));
    expect(dnsHostnamePattern({ anyCase: false, singleLabel: false })).toBe(dnsHostnamePattern());
    expect(dnsHostnamePattern({ anyCase: true })).not.toBe(dnsHostnamePattern());
    expect(dnsHostnamePattern({ singleLabel: true })).not.toBe(dnsHostnamePattern());
    const pattern = dnsHostnamePattern();
    expect(pattern.flags).toBe("u");
    expect(pattern.test("prefix gitlab.example.com")).toBe(false);
    expect(pattern.test("gitlab.example.com suffix")).toBe(false);
  });
});

describe("DNS hostname grammar at GitLab call sites", () => {
  it("admits a dotted IPv4 host and refuses a mixed-case or single-label host in a cascade remote", () => {
    expect(parseGitLabRemote("git@gitlab.example.com:group/project.git")).toMatchObject({
      host: "gitlab.example.com",
      fullPath: "group/project",
    });
    expect(parseGitLabRemote("git@10.0.0.5:group/project.git")).toMatchObject({
      host: "10.0.0.5",
      fullPath: "group/project",
    });
    expect(parseGitLabRemote("git@GitLab.Example.com:group/project.git")).toBeNull();
    expect(parseGitLabRemote("git@gitlab..example.com:group/project.git")).toBeNull();
    expect(parseGitLabRemote("git@gitlab:group/project.git")).toBeNull();
  });

  it("refuses a mixed-case or single-label host in the operator's cascade GitLab configuration", () => {
    const environment = {
      DOCSFAB_ROADMAP_GITLAB_HOST: "gitlab.example.com",
      DOCSFAB_ROADMAP_GITLAB_FULL_PATH: "group/project",
      DOCSFAB_ROADMAP_GITLAB_PROJECT_ID: "42",
      DOCSFAB_ROADMAP_GITLAB_SSH_PORT: "22",
    };
    expect(snapshotHostGitLabConfiguration(environment)).toMatchObject({
      host: "gitlab.example.com",
    });
    expect(
      snapshotHostGitLabConfiguration({
        ...environment,
        DOCSFAB_ROADMAP_GITLAB_HOST: "GitLab.Example.com",
      }),
    ).toBeNull();
    expect(
      snapshotHostGitLabConfiguration({ ...environment, DOCSFAB_ROADMAP_GITLAB_HOST: "gitlab" }),
    ).toBeNull();
  });

  it("refuses a mixed-case or single-label roadmap reader project host", () => {
    const project = {
      provider: "gitlab",
      host: "gitlab.example.com",
      fullPath: "group/project",
      projectId: 42,
    };
    expect(() => new GitLabRoadmapReader({ project })).not.toThrow();
    expect(
      () => new GitLabRoadmapReader({ project: { ...project, host: "GitLab.Example.com" } }),
    ).toThrow("GitLab project identity is invalid.");
    expect(() => new GitLabRoadmapReader({ project: { ...project, host: "gitlab" } })).toThrow(
      "GitLab project identity is invalid.",
    );
  });
});
