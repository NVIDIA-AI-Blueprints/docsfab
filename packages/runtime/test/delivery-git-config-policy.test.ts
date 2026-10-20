// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one Git configuration policy that the host publisher and delivery
 * preflight both apply (#2363). Each row names the decision the owner made on
 * 2026-10-13: signing turned off is accepted anywhere; `core.sshCommand` and
 * `core.askPass` are accepted from the operator's own global or system files;
 * everything else in the refused set stays refused.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import {
  GIT_CONFIGURATION_LIST_ARGS,
  GIT_CONFIGURATION_LISTING_LIMIT,
  HOST_GIT_CONFIG_FLAGS,
  assessGitConfigurationList,
  displayGitConfigurationKey,
  displayGitConfigurationOrigin,
  evaluateGitConfigurationEntry,
  operatorConfigurationOrigin,
  resolveGitConfigurationPaths,
  trustedConfigurationOrigin,
} from "../src/delivery/git-config-policy.js";

const exec = promisify(execFile);
const HOME = "/home/operator";
const HOST = "gitlab.example.test";
const CONTEXT = { home: HOME, host: HOST } as const;
/** The checkout's own configuration, as Git prints its origin in the checkout root. */
const LOCAL = "file:.git/config";
const GLOBAL = `file:${HOME}/.gitconfig`;
const XDG_GLOBAL = `file:${HOME}/.config/git/config`;
const SYSTEM = "file:/etc/gitconfig";
/** A file the operator's global configuration includes: not one of the trusted paths. */
const INCLUDED = `file:${HOME}/.gitconfig.d/work`;
const COMMAND_LINE = "command line:";
/** The userinfo of a URL subsection, built so that no credential-shaped text is committed. */
const USERNAME = "someone";
const USERINFO_MARKER = "subsection-marker-7f3a";
const USERINFO = `${USERNAME}:${USERINFO_MARKER}`;

type Verdict = "accepted" | "refused";

function verdict(key: string, value: string, origin: string): Verdict {
  return evaluateGitConfigurationEntry({ origin, key, value }, CONTEXT).accepted
    ? "accepted"
    : "refused";
}

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Git configuration policy: signing turned off", () => {
  it.each([
    ["commit.gpgsign", "false", LOCAL],
    ["commit.gpgsign", "False", LOCAL],
    ["commit.gpgsign", "FALSE", INCLUDED],
    ["commit.gpgsign", "no", LOCAL],
    ["commit.gpgsign", "off", LOCAL],
    ["commit.gpgsign", "0", LOCAL],
    ["commit.gpgsign", "false", GLOBAL],
    ["commit.gpgsign", "false", COMMAND_LINE],
    ["tag.gpgsign", "false", LOCAL],
    ["tag.gpgsign", "off", LOCAL],
    ["tag.gpgsign", "No", INCLUDED],
    ["tag.gpgsign", "0", LOCAL],
  ] as const)("accepts %s=%s from %s", (key, value, origin) => {
    expect(verdict(key, value, origin)).toBe("accepted");
  });

  it.each([
    ["commit.gpgsign", "true", LOCAL],
    ["commit.gpgsign", "yes", LOCAL],
    ["commit.gpgsign", "on", INCLUDED],
    ["commit.gpgsign", "1", LOCAL],
    ["commit.gpgsign", "", LOCAL],
    ["commit.gpgsign", "false ", LOCAL],
    ["commit.gpgsign", "nope", LOCAL],
    ["tag.gpgsign", "true", LOCAL],
    ["tag.gpgsign", "1", INCLUDED],
    ["gpg.program", "false", LOCAL],
    ["user.signingkey", "off", LOCAL],
  ] as const)("refuses %s=%s from %s, which does not turn signing off", (key, value, origin) => {
    expect(verdict(key, value, origin)).toBe("refused");
  });

  it.each([
    ["commit.gpgsign", "true", GLOBAL],
    ["commit.gpgsign", "true", XDG_GLOBAL],
    ["commit.gpgsign", "true", SYSTEM],
    ["tag.gpgsign", "true", GLOBAL],
    ["gpg.program", "/usr/bin/gpg", GLOBAL],
    ["gpg.ssh.program", "ssh-keygen", SYSTEM],
    ["user.signingkey", "ABCD", GLOBAL],
  ] as const)(
    "accepts %s=%s from the trusted file %s, as before, because the host forces signing off",
    (key, value, origin) => {
      expect(verdict(key, value, origin)).toBe("accepted");
    },
  );
});

describe("Git configuration policy: operator-owned transport settings", () => {
  it.each([
    ["core.sshcommand", "ssh -i /home/operator/.ssh/work", GLOBAL],
    ["core.sshcommand", "ssh -F /dev/null", XDG_GLOBAL],
    ["core.sshcommand", "ssh", SYSTEM],
    ["core.askpass", "/usr/bin/ssh-askpass", GLOBAL],
    ["core.askpass", "ksshaskpass", SYSTEM],
  ] as const)("accepts %s from the trusted file %s", (key, value, origin) => {
    expect(verdict(key, value, origin)).toBe("accepted");
  });

  it.each([
    ["core.sshcommand", "ssh -i /tmp/key", LOCAL],
    ["core.sshcommand", "ssh -i /tmp/key", INCLUDED],
    ["core.sshcommand", "ssh", "file:/opt/homebrew/etc/gitconfig"],
    ["core.sshcommand", "ssh", "standard input:"],
    ["core.askpass", "/tmp/askpass", LOCAL],
    ["core.askpass", "/tmp/askpass", INCLUDED],
    ["core.sshcommand", "ssh", COMMAND_LINE],
  ] as const)("refuses %s from %s, which the operator does not own", (key, value, origin) => {
    expect(verdict(key, value, origin)).toBe("refused");
  });

  it("is case insensitive about the key, as Git is", () => {
    expect(verdict("core.sshCommand", "ssh", GLOBAL)).toBe("accepted");
    expect(verdict("core.sshCommand", "ssh", LOCAL)).toBe("refused");
    expect(verdict("COMMIT.GPGSIGN", "false", LOCAL)).toBe("accepted");
  });
});

describe("Git configuration policy: a HOME that is not the operator's own (#2363)", () => {
  const REPOSITORY = "/work/repo";
  const TRANSPORT = ["core.sshcommand", "core.askpass"] as const;
  /** What a trusted global file may still hold, as it could before #2363: none of it runs a command. */
  const INERT = [
    ["commit.gpgsign", "true"],
    ["gpg.program", "/usr/bin/gpg"],
    ["user.signingkey", "ABCD"],
    ["url.https://example.test/.insteadof", "https://gitlab.example.test/"],
    ["include.path", "~/.gitconfig.d/work"],
    ["credential.helper", "osxkeychain"],
  ] as const;

  type HomeContext = { home: string | undefined; repositoryRoots?: readonly string[] };
  const decide = (context: HomeContext, key: string, value: string, origin: string) =>
    evaluateGitConfigurationEntry({ origin, key, value }, { host: HOST, ...context });
  const accepted = (context: HomeContext, key: string, value: string, origin: string): boolean =>
    decide(context, key, value, origin).accepted;
  const globalFiles = (home: string) => [
    `file:${home}/.gitconfig`,
    `file:${home}/.config/git/config`,
  ];

  it.each(["~", ".", "home", "./home", "../home", "~/home"])(
    "refuses the transport settings from the global files of the relative HOME %s, and still accepts the inert ones",
    (home) => {
      for (const origin of globalFiles(home)) {
        for (const key of TRANSPORT) {
          expect(decide({ home }, key, "ssh", origin), `${key} from ${origin}`).toEqual({
            accepted: false,
            setting: key,
            origin,
            reason: "home-not-operator-owned",
          });
        }
        for (const [key, value] of INERT) {
          expect(accepted({ home }, key, value, origin), `${key} from ${origin}`).toBe(true);
        }
      }
    },
  );

  it.each([
    "/work/repo",
    "/work/repo/home",
    "/work/repo/a/b/home",
    "/work/repo/home/",
    "/work/other/../repo/home",
    "/work/repo/./home",
  ])(
    "refuses the transport settings from the global files of HOME %s, which is the checkout or lies inside it",
    (home) => {
      const context = { home, repositoryRoots: [REPOSITORY] };
      for (const origin of globalFiles(home)) {
        for (const key of TRANSPORT) {
          expect(decide(context, key, "ssh", origin), `${key} from ${origin}`).toMatchObject({
            accepted: false,
            reason: "home-not-operator-owned",
          });
        }
        for (const [key, value] of INERT) {
          expect(accepted(context, key, value, origin), `${key} from ${origin}`).toBe(true);
        }
      }
    },
  );

  it.each([
    "/home/operator",
    "/work",
    "/work/repo-other",
    "/work/repository",
    "/work/repo/../elsewhere",
    "/",
  ])(
    "accepts the transport settings from the global files of HOME %s, outside the checkout",
    (home) => {
      const context = { home, repositoryRoots: [REPOSITORY] };
      for (const origin of globalFiles(home)) {
        for (const key of TRANSPORT) {
          expect(accepted(context, key, "ssh", origin), `${key} from ${origin}`).toBe(true);
        }
      }
    },
  );

  it("looks at every repository root, and ignores an empty one", () => {
    const home = "/work/source/home";
    const origin = `file:${home}/.gitconfig`;
    expect(
      accepted(
        { home, repositoryRoots: ["/work/delivery", "/work/source"] },
        "core.sshcommand",
        "ssh",
        origin,
      ),
    ).toBe(false);
    expect(
      accepted({ home, repositoryRoots: ["/work/delivery"] }, "core.sshcommand", "ssh", origin),
    ).toBe(true);
    expect(accepted({ home, repositoryRoots: [""] }, "core.sshcommand", "ssh", origin)).toBe(true);
    // An empty root is not the working directory: a HOME under that directory is still the operator's.
    const underCwd = join(process.cwd(), "operator-home");
    expect(
      accepted(
        { home: underCwd, repositoryRoots: [""] },
        "core.sshcommand",
        "ssh",
        `file:${underCwd}/.gitconfig`,
      ),
    ).toBe(true);
    expect(accepted({ home }, "core.sshcommand", "ssh", origin)).toBe(true);
  });

  it("keeps the system files trusted for the transport settings whatever HOME is", () => {
    for (const home of [undefined, "~", ".", REPOSITORY, `${REPOSITORY}/home`]) {
      const context = { home, repositoryRoots: [REPOSITORY] };
      for (const key of TRANSPORT) {
        expect(accepted(context, key, "ssh", SYSTEM), `${key} with HOME ${home}`).toBe(true);
      }
    }
  });

  it("gives a reason only for a global file under a HOME that is not the operator's", () => {
    expect(decide({ home: HOME }, "core.sshcommand", "ssh", LOCAL)).toEqual({
      accepted: false,
      setting: "core.sshcommand",
      origin: LOCAL,
    });
    expect(decide({ home: HOME }, "core.sshcommand", "ssh", INCLUDED)).not.toHaveProperty("reason");
    expect(decide({ home: HOME }, "core.hookspath", ".githooks", GLOBAL)).not.toHaveProperty(
      "reason",
    );
    // Positive control: the same setting from the operator's own global file is accepted.
    expect(decide({ home: HOME }, "core.sshcommand", "ssh", GLOBAL)).toEqual({ accepted: true });
  });

  it("carries the reason into the assessment of a listing, and reads the roots it is given", () => {
    const home = `${REPOSITORY}/home`;
    const origin = `file:${home}/.gitconfig`;
    const listing = `${origin}\0core.sshcommand\nssh\0`;
    expect(
      assessGitConfigurationList(listing, { home, host: HOST, repositoryRoots: [REPOSITORY] }),
    ).toEqual({
      status: "refused",
      setting: "core.sshcommand",
      origin,
      reason: "home-not-operator-owned",
    });
    // Positive control: without the roots, and with no way to tell, the same listing is accepted.
    expect(assessGitConfigurationList(listing, { home, host: HOST })).toEqual({ status: "ok" });
  });

  it.each([
    [`file:${HOME}/.gitconfig`, HOME, [], true],
    [`file:${HOME}/.gitconfig`, HOME, [`${HOME}/repo`], true],
    [`file:${HOME}/.gitconfig`, HOME, [HOME], false],
    [`file:${HOME}/.gitconfig`, "~", [], false],
    [`file:${HOME}/.gitconfig`, undefined, [], false],
    ["file:/etc/gitconfig", undefined, [], true],
    ["file:/etc/gitconfig", "~", [HOME], true],
    ["file:/opt/homebrew/etc/gitconfig", HOME, [], false],
    [`blob:${HOME}/.gitconfig`, HOME, [], false],
  ] as const)(
    "says whether %s is the operator's own with HOME %s and roots %j: %s",
    (origin, home, roots, own) => {
      expect(operatorConfigurationOrigin(origin, { home, repositoryRoots: roots })).toBe(own);
    },
  );
});

describe("Git configuration policy: paths that reach the checkout through a link (#2363)", () => {
  async function layout() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-git-config-links-")));
    temporary.push(root);
    const checkout = join(root, "checkout");
    const elsewhere = join(root, "elsewhere");
    await mkdir(join(checkout, "home"), { recursive: true });
    await mkdir(elsewhere);
    // A link that names the checkout, and one that names a directory inside it.
    await symlink(checkout, join(root, "checkout-link"));
    await symlink(join(checkout, "home"), join(root, "home-link"));
    return { root, checkout, elsewhere };
  }

  const refusedFor = async (home: string, roots: readonly string[]) => {
    const context = await resolveGitConfigurationPaths({
      home,
      host: HOST,
      repositoryRoots: roots,
    });
    return !evaluateGitConfigurationEntry(
      { origin: `file:${home}/.gitconfig`, key: "core.sshcommand", value: "ssh" },
      context,
    ).accepted;
  };

  it("treats a HOME that is a link into the checkout as inside it", async () => {
    const { root, checkout, elsewhere } = await layout();
    expect(await refusedFor(join(root, "home-link"), [checkout])).toBe(true);
    expect(await refusedFor(join(root, "checkout-link", "home"), [checkout])).toBe(true);
    // Positive controls: a HOME that resolves outside the checkout is the operator's own.
    expect(await refusedFor(elsewhere, [checkout])).toBe(false);
    await symlink(elsewhere, join(root, "elsewhere-link"));
    expect(await refusedFor(join(root, "elsewhere-link"), [checkout])).toBe(false);
  });

  it("treats a checkout named through a link as the checkout", async () => {
    const { root, checkout } = await layout();
    expect(await refusedFor(join(checkout, "home"), [join(root, "checkout-link")])).toBe(true);
    expect(
      await refusedFor(join(checkout, "home"), [join(root, "checkout-link"), "/nowhere"]),
    ).toBe(true);
  });

  it("keeps a path that does not resolve as it is, and ignores an empty root", async () => {
    const context = await resolveGitConfigurationPaths({
      home: "/does/not/exist/home",
      host: HOST,
      repositoryRoots: ["/does/not/exist/checkout", ""],
    });
    expect(context.repositoryRoots).toEqual(["/does/not/exist/checkout"]);
    expect(context).not.toHaveProperty("homeResolved");
    // A relative HOME is never resolved against the working directory.
    const relativeHome = await resolveGitConfigurationPaths({ home: ".", host: HOST });
    expect(relativeHome).not.toHaveProperty("homeResolved");
    expect(await resolveGitConfigurationPaths({ home: undefined, host: HOST })).toEqual({
      home: undefined,
      host: HOST,
      repositoryRoots: [],
    });
  });
});

describe("Git configuration policy: what stays refused", () => {
  const SCOPED_URL = "https://gitlab.example.test/";
  it.each([
    ["core.hookspath", ".githooks"],
    ["core.fsmonitor", "true"],
    ["core.fsmonitor", ".git/hooks/query-watchman"],
    ["core.gitproxy", "ssh-proxy"],
    ["remote.origin.receivepack", "/tmp/receive"],
    ["remote.origin.uploadpack", "/tmp/upload"],
    ["remote.origin.proxy", "http://proxy.example.test"],
    ["remote.origin.mirror", "true"],
    ["remote.origin.pushoption", "ci.skip"],
    [`http.${SCOPED_URL}.extraheader`, "X-Extra: 1"],
    [`http.${SCOPED_URL}.proxy`, "http://proxy.example.test"],
    ["push.pushoption", "ci.skip"],
  ] as const)(
    "refuses %s=%s from the checkout, a trusted global file, and an included file",
    (key, value) => {
      for (const origin of [LOCAL, GLOBAL, SYSTEM, INCLUDED]) {
        expect(verdict(key, value, origin), `${key} from ${origin}`).toBe("refused");
      }
    },
  );

  it.each([
    ["url.https://example.test/.insteadof", "https://gitlab.example.test/"],
    ["url.https://example.test/.pushinsteadof", "https://gitlab.example.test/"],
  ] as const)(
    "refuses the URL rewrite %s from the checkout and an included file, not from a trusted one",
    (key, value) => {
      expect(verdict(key, value, LOCAL)).toBe("refused");
      expect(verdict(key, value, INCLUDED)).toBe("refused");
      expect(verdict(key, value, GLOBAL)).toBe("accepted");
      expect(verdict(key, value, SYSTEM)).toBe("accepted");
    },
  );

  it.each([
    ["gpg.program", "/tmp/gpg"],
    ["gpg.format", "ssh"],
    ["gpg.ssh.program", "/tmp/sign"],
    ["user.signingkey", "ABCD"],
  ] as const)(
    "refuses %s from the checkout and an included file, not from a trusted one",
    (key, value) => {
      expect(verdict(key, value, LOCAL)).toBe("refused");
      expect(verdict(key, value, INCLUDED)).toBe("refused");
      expect(verdict(key, value, GLOBAL)).toBe("accepted");
    },
  );

  it.each([
    ["core.hookspath", "/dev/null", COMMAND_LINE, "accepted"],
    ["core.hookspath", "/tmp/hooks", COMMAND_LINE, "refused"],
    ["core.hookspath", "/dev/null", LOCAL, "refused"],
    ["core.hookspath", "/dev/null", GLOBAL, "refused"],
    ["core.fsmonitor", "false", COMMAND_LINE, "accepted"],
    ["core.fsmonitor", "true", COMMAND_LINE, "refused"],
    ["core.fsmonitor", "false", LOCAL, "refused"],
    ["core.fsmonitor", "false", GLOBAL, "refused"],
  ] as const)(
    "treats %s=%s from %s as %s: only the host's own -c overrides pass",
    (key, value, origin, expected) => {
      expect(verdict(key, value, origin)).toBe(expected);
    },
  );

  it.each([
    ["include.path", "/tmp/extra", LOCAL, "refused"],
    ["include.path", "/tmp/extra", INCLUDED, "refused"],
    ["include.path", "~/.gitconfig.d/work", GLOBAL, "accepted"],
    ["include.path", "/etc/extra", SYSTEM, "accepted"],
    ["includeif.gitdir:~/work/.path", "/tmp/extra", LOCAL, "refused"],
    ["includeif.gitdir:~/work/.path", "~/.gitconfig.d/work", GLOBAL, "accepted"],
    ["includeif.onbranch:main.path", "/tmp/extra", INCLUDED, "refused"],
  ] as const)("treats %s=%s from %s as %s", (key, value, origin, expected) => {
    expect(verdict(key, value, origin)).toBe(expected);
  });

  it.each([
    ["credential.helper", "!/tmp/steal", LOCAL, "refused"],
    ["credential.helper", "!/tmp/steal", GLOBAL, "refused"],
    ["credential.helper", " !/tmp/steal", GLOBAL, "refused"],
    ["credential.helper", "osxkeychain", LOCAL, "refused"],
    ["credential.helper", "osxkeychain", INCLUDED, "refused"],
    ["credential.helper", "osxkeychain", GLOBAL, "accepted"],
    ["credential.helper", "", LOCAL, "refused"],
    ["credential.https://gitlab.example.test.helper", "!/tmp/steal", GLOBAL, "refused"],
    ["credential.https://gitlab.example.test.helper", "store", LOCAL, "refused"],
    ["credential.https://gitlab.example.test.helper", "store", GLOBAL, "accepted"],
    ["credential.https://other.example.test.helper", "!/tmp/steal", LOCAL, "accepted"],
    ["credential.https://other.example.test.helper", "store", LOCAL, "accepted"],
    ["credential.not a url.helper", "!/tmp/steal", GLOBAL, "refused"],
  ] as const)(
    "treats the include or credential setting %s=%s from %s as %s",
    (key, value, origin, expected) => {
      expect(verdict(key, value, origin)).toBe(expected);
    },
  );

  it("accepts a setting that no rule names", () => {
    for (const [key, value] of [
      ["user.name", "Operator"],
      ["core.editor", "vim"],
      ["http.sslverify", "true"],
      ["alias.co", "checkout"],
      ["protocol.allow", "never"],
      ["diff.trustexitcode", "false"],
    ] as const) {
      expect(verdict(key, value, LOCAL), key).toBe("accepted");
    }
  });
});

describe("Git configuration policy: a subsection that holds a line separator (#2363)", () => {
  // Git reads U+2028, U+2029, and a carriage return in a subsection as ordinary characters, so
  // a key pattern that stops at them would let such a subsection past the rule that names it.
  const SEPARATORS = ["\u2028", "\u2029", "\r"] as const;
  const ASCII = "x";

  it.each(SEPARATORS)(
    "keeps every subsection rule in force with %j in the subsection",
    (separator) => {
      for (const [fill, label] of [
        [separator, "separator"],
        [ASCII, "ASCII control"],
      ] as const) {
        const sub = `a${fill}b`;
        const where = `with the ${label}`;
        // An include or includeIf is refused from an untrusted file and accepted from a trusted one.
        expect(verdict(`includeif.gitdir:/${sub}/.path`, "/tmp/extra", LOCAL), where).toBe(
          "refused",
        );
        expect(verdict(`includeif.gitdir:/${sub}/.path`, "/tmp/extra", INCLUDED), where).toBe(
          "refused",
        );
        expect(verdict(`includeif.gitdir:/${sub}/.path`, "~/extra", GLOBAL), where).toBe(
          "accepted",
        );
        // A URL rewrite is refused from an untrusted file and accepted from a trusted one.
        expect(
          verdict(`url.https://${sub}.test/.insteadof`, "https://gitlab.example.test/", LOCAL),
          where,
        ).toBe("refused");
        expect(
          verdict(`url.https://${sub}.test/.pushinsteadof`, "https://gitlab.example.test/", GLOBAL),
          where,
        ).toBe("accepted");
        // A header or proxy for a URL, and the settings of a remote, are refused from every file.
        for (const origin of [LOCAL, GLOBAL, SYSTEM, INCLUDED]) {
          expect(
            verdict(`http.https://${sub}.test/.extraheader`, "X-Extra: 1", origin),
            where,
          ).toBe("refused");
          expect(
            verdict(`http.https://${sub}.test/.proxy`, "http://proxy.example.test", origin),
            where,
          ).toBe("refused");
          expect(verdict(`remote.${sub}.proxy`, "http://proxy.example.test", origin), where).toBe(
            "refused",
          );
          expect(verdict(`remote.${sub}.pushoption`, "ci.skip", origin), where).toBe("refused");
        }
        // A GPG setting is refused from an untrusted file and accepted from a trusted one.
        expect(verdict(`gpg.${sub}.program`, "/tmp/gpg", LOCAL), where).toBe("refused");
        expect(verdict(`gpg.${sub}.program`, "/tmp/gpg", GLOBAL), where).toBe("accepted");
        // A credential helper for the project's host is refused from an untrusted file, and an
        // executable one from any file. The separator sits in the path, so the scope still names
        // the project's host.
        const scoped = `credential.https://${HOST}/${sub}.helper`;
        expect(verdict(scoped, "osxkeychain", LOCAL), where).toBe("refused");
        expect(verdict(scoped, "osxkeychain", GLOBAL), where).toBe("accepted");
        expect(verdict(scoped, "!/tmp/steal", GLOBAL), where).toBe("refused");
      }
    },
  );

  it("reads the key of a listing entry whose subsection holds a separator as the rule names it", () => {
    const listing = `${LOCAL}\0includeif.gitdir:/a\u2028b/.path\n/tmp/extra\0`;
    expect(assessGitConfigurationList(listing, CONTEXT)).toEqual({
      status: "refused",
      setting: "includeif.*.path",
      origin: LOCAL,
    });
  });

  it.each([
    "includeif.gitdir:/home/operator/a.b/.path",
    "includeif.gitdir:/home/operator/dev.projects.v2/.path",
    "includeif.hasconfig:remote.*.url:https://gitlab.example.test/**.path",
    "includeif.onbranch:release/v1.2.path",
  ])("treats the includeIf rule as covering the dotted condition in %s", (key) => {
    expect(verdict(key, "/tmp/extra", LOCAL), key).toBe("refused");
    expect(verdict(key, "/tmp/extra", INCLUDED), key).toBe("refused");
    expect(verdict(key, "~/.gitconfig.d/work", GLOBAL), key).toBe("accepted");
    expect(verdict(key, "/etc/extra", SYSTEM), key).toBe("accepted");
  });
});

describe("Git configuration policy: the listing bound", () => {
  it("names a declared operational limit that both readers apply", () => {
    // delivery.gitConfigurationListingMaxBytes replaces preflight's 2 MiB command buffer and the
    // publisher's 1,000,000-byte output cap; one catalog entry holds the value for both.
    expect(GIT_CONFIGURATION_LISTING_LIMIT).toBe("delivery.gitConfigurationListingMaxBytes");
    expect(limitDefinition(GIT_CONFIGURATION_LISTING_LIMIT)).toMatchObject({
      value: 2 * 1024 * 1024,
      unit: "bytes",
      scope: "per-host",
      override: "DOCSFAB_DELIVERY_GIT_CONFIGURATION_LISTING_MAX_BYTES",
      refusal: "delivery-git-configuration-listing-max-bytes-bound",
    });
  });
});

describe("Git configuration policy: the origin of a setting", () => {
  it.each([
    [`file:${HOME}/.gitconfig`, true],
    [`file:${HOME}/.config/git/config`, true],
    ["file:/etc/gitconfig", true],
    ["file:/usr/local/etc/gitconfig", true],
    ["file:/usr/share/git-core/gitconfig", true],
    ["file:/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig", true],
    ["file:/Applications/Xcode.app/Contents/Developer/usr/share/git-core/gitconfig", true],
    ["file:C:/Program Files/Git/etc/gitconfig", true],
    ["file:C:/Program Files (x86)/Git/etc/gitconfig", true],
    ["file:/opt/homebrew/etc/gitconfig", false],
    [`file:${HOME}/.gitconfig.d/work`, false],
    [`file:${HOME}/repo/.git/config`, false],
    ["file:.git/config", false],
    ["file:/etc/gitconfig.d/extra", false],
    ["command line:", false],
    ["standard input:", false],
    ["blob:0123456789abcdef", false],
    // Only a file is trusted: a non-file origin whose text ends in a trusted path is not.
    ["blob:/etc/gitconfig", false],
    ["standard input:/etc/gitconfig", false],
    [`${HOME}/.gitconfig`, false],
  ] as const)("trusts %s: %s", (origin, trusted) => {
    expect(trustedConfigurationOrigin(origin, HOME)).toBe(trusted);
  });

  it("trusts a global file only when HOME names it", () => {
    // An unknown HOME trusts no global file, not even one named after the missing value.
    expect(trustedConfigurationOrigin("file:undefined/.gitconfig", undefined)).toBe(false);
    expect(trustedConfigurationOrigin(`file:${HOME}/.gitconfig`, undefined)).toBe(false);
    expect(trustedConfigurationOrigin(`file:${HOME}/.gitconfig`, "/home/someone-else")).toBe(false);
    expect(trustedConfigurationOrigin("file:/etc/gitconfig", undefined)).toBe(true);
  });
});

describe("Git configuration policy: reading the listing", () => {
  const entry = (origin: string, key: string, value: string): string =>
    `${origin}\0${key}\n${value}\0`;

  it("accepts an empty listing and one made only of accepted settings", () => {
    expect(assessGitConfigurationList("", CONTEXT)).toEqual({ status: "ok" });
    expect(
      assessGitConfigurationList(
        [
          entry(GLOBAL, "user.name", "Operator"),
          entry(GLOBAL, "core.sshcommand", "ssh -i /home/operator/.ssh/work"),
          entry(LOCAL, "commit.gpgsign", "false"),
        ].join(""),
        CONTEXT,
      ),
    ).toEqual({ status: "ok" });
  });

  it("names the first refused setting and where it is set, in listing order", () => {
    const assessment = assessGitConfigurationList(
      [
        entry(GLOBAL, "core.sshcommand", "ssh"),
        entry(LOCAL, "core.sshcommand", "ssh -i /tmp/key"),
        entry(LOCAL, "core.fsmonitor", "true"),
      ].join(""),
      CONTEXT,
    );
    expect(assessment).toEqual({ status: "refused", setting: "core.sshcommand", origin: LOCAL });
  });

  it("reads a Buffer as the publisher's runner returns it", () => {
    expect(
      assessGitConfigurationList(
        Buffer.from(entry(LOCAL, "core.sshcommand", "ssh"), "utf8"),
        CONTEXT,
      ),
    ).toEqual({ status: "refused", setting: "core.sshcommand", origin: LOCAL });
  });

  it.each([
    ["an origin with no key", `${GLOBAL}\0`],
    ["a key with no value, which Git reads as true", `${LOCAL}\0core.foo\0`],
    ["an entry with an empty origin", `\0core.foo\nbar\0`],
    ["an origin that spans two lines", `file:one\ntwo\0core.foo\nbar\0`],
    ["a key that starts with the separator", `${LOCAL}\0\nbar\0`],
  ] as const)("does not read %s, so it is unreadable", (_label, listing) => {
    expect(assessGitConfigurationList(listing, CONTEXT)).toEqual({ status: "unreadable" });
  });

  it("stops at the first entry that does not parse, as it did before the policy moved", () => {
    expect(
      assessGitConfigurationList(
        `${entry(LOCAL, "core.sshcommand", "ssh")}${LOCAL}\0core.foo\0`,
        CONTEXT,
      ),
    ).toEqual({ status: "refused", setting: "core.sshcommand", origin: LOCAL });
    expect(
      assessGitConfigurationList(
        `${LOCAL}\0core.foo\0${entry(LOCAL, "core.sshcommand", "ssh")}`,
        CONTEXT,
      ),
    ).toEqual({ status: "unreadable" });
  });
});

describe("Git configuration policy: what a message may show", () => {
  it.each([
    ["core.sshcommand", "core.sshcommand"],
    ["commit.gpgsign", "commit.gpgsign"],
    ["gpg.program", "gpg.program"],
    ["http.https://gitlab.example.test/.extraheader", "http.*.extraheader"],
    [`url.https://${USERINFO}@gitlab.example.test/.insteadof`, "url.*.insteadof"],
    ["remote.origin.pushoption", "remote.*.pushoption"],
    ["includeif.gitdir:/home/operator/a.b/.path", "includeif.*.path"],
    [`credential.https://${USERINFO}@gitlab.example.test.helper`, "credential.*.helper"],
  ] as const)("shows the key %s as %s, never a subsection", (key, shown) => {
    expect(displayGitConfigurationKey(key)).toBe(shown);
  });

  it("never carries a credential in a URL subsection into the refusal", () => {
    const secret = USERINFO_MARKER;
    const assessment = assessGitConfigurationList(
      `${LOCAL}\0url.https://${USERNAME}:${secret}@gitlab.example.test/.insteadof\nhttps://gitlab.example.test/\0`,
      CONTEXT,
    );
    expect(assessment).toEqual({ status: "refused", setting: "url.*.insteadof", origin: LOCAL });
    expect(JSON.stringify(assessment)).not.toContain(secret);
  });

  it.each([
    [`file:${HOME}/.gitconfig`, "file:~/.gitconfig"],
    [`file:${HOME}/.config/git/config`, "file:~/.config/git/config"],
    [`file:${HOME}`, "file:~"],
    ["file:.git/config", "file:.git/config"],
    ["file:/etc/gitconfig", "file:/etc/gitconfig"],
    [`file:${HOME}x/.gitconfig`, `file:${HOME}x/.gitconfig`],
    ["command line:", "command line:"],
    // Only a file path is shortened: a non-file origin that ends in the home directory is not.
    [`blob:${HOME}/.gitconfig`, `blob:${HOME}/.gitconfig`],
  ] as const)("shows the origin %s as %s", (origin, shown) => {
    expect(displayGitConfigurationOrigin(origin, HOME)).toBe(shown);
  });

  it("shows an origin as it is when HOME is unknown or empty", () => {
    expect(displayGitConfigurationOrigin(`file:${HOME}/.gitconfig`, undefined)).toBe(
      `file:${HOME}/.gitconfig`,
    );
    expect(displayGitConfigurationOrigin("file:/etc/gitconfig", "")).toBe("file:/etc/gitconfig");
  });
});

describe("Git configuration policy against the Git that the host runs", () => {
  async function scratch(): Promise<{ home: string; repository: string }> {
    const root = await mkdtemp(join(tmpdir(), "docsfab-git-config-policy-"));
    temporary.push(root);
    const home = join(root, "home");
    const repository = join(root, "repository");
    await mkdir(home);
    await mkdir(repository);
    return { home, repository };
  }

  async function listing(
    home: string,
    repository: string,
    withHostFlags: boolean,
  ): Promise<string> {
    const { stdout } = await exec(
      "git",
      [...(withHostFlags ? HOST_GIT_CONFIG_FLAGS : []), ...GIT_CONFIGURATION_LIST_ARGS],
      {
        cwd: repository,
        // The publisher's environment: the operator's HOME and nothing that
        // switches global or system configuration off or on.
        env: { PATH: process.env.PATH, HOME: home, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" },
        encoding: "utf8",
      },
    );
    return stdout;
  }

  it("shows the host's own -c overrides as command-line entries, which the policy accepts", async () => {
    const { home, repository } = await scratch();
    await exec("git", ["init", "--quiet"], {
      cwd: repository,
      env: { PATH: process.env.PATH, HOME: home },
    });
    const flagged = await listing(home, repository, true);
    // The hook and fsmonitor overrides are in the refused set; they must reach the policy as
    // the command-line entries it accepts, or every publication would be refused.
    expect(flagged).toContain("command line:\0core.hookspath\n/dev/null\0");
    expect(flagged).toContain("command line:\0core.fsmonitor\nfalse\0");
    expect(assessGitConfigurationList(flagged, { home, host: HOST })).toEqual({ status: "ok" });
    // Positive control: without the overrides, the same listing carries neither entry.
    const bare = await listing(home, repository, false);
    expect(bare).not.toContain("command line:");
    expect(assessGitConfigurationList(bare, { home, host: HOST })).toEqual({ status: "ok" });
  });

  it("reads the origins Git prints for the checkout, a global file, and an included file", async () => {
    const { home, repository } = await scratch();
    const env = { PATH: process.env.PATH, HOME: home };
    await exec("git", ["init", "--quiet"], { cwd: repository, env });
    await writeFile(
      join(home, ".gitconfig"),
      "[user]\n\tname = Operator\n[core]\n\tsshCommand = ssh -i ~/.ssh/work\n[include]\n\tpath = work.gitconfig\n",
    );
    await writeFile(join(home, "work.gitconfig"), "[commit]\n\tgpgSign = false\n");
    // A global core.sshCommand and an included signing switch set to false pass.
    const clean = await listing(home, repository, true);
    expect(clean).toContain(`file:${home}/.gitconfig\0core.sshcommand\nssh -i ~/.ssh/work\0`);
    expect(clean).toContain(`file:${home}/work.gitconfig\0commit.gpgsign\nfalse\0`);
    expect(assessGitConfigurationList(clean, { home, host: HOST })).toEqual({ status: "ok" });

    // The same key in the checkout's own configuration is refused, with that origin.
    await exec("git", ["config", "core.sshCommand", "ssh -i /tmp/key"], { cwd: repository, env });
    const refused = assessGitConfigurationList(await listing(home, repository, true), {
      home,
      host: HOST,
    });
    expect(refused).toEqual({
      status: "refused",
      setting: "core.sshcommand",
      origin: "file:.git/config",
    });
  });
});
