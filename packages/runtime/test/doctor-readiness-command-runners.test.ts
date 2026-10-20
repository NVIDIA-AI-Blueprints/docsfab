// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExecDoctorPublicationCommandRunner,
  ExecDoctorReadinessCommandRunner,
} from "../src/doctor-readiness/command-runners.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doctor-command-runners-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "command-fixture");
  await writeFile(
    executable,
    `#!/bin/sh
printf 'cwd=%s\\n' "$PWD"
printf 'args='
for arg do printf '[%s]' "$arg"; done
printf '\\nGLAB_TOKEN=%s\\nGITLAB_TOKEN=%s\\n' \\
  "\${GLAB_TOKEN-unset}" "\${GITLAB_TOKEN-unset}"
printf 'GLAB_CONFIG_DIR=%s\\nGITLAB_HOST=%s\\n' \\
  "\${GLAB_CONFIG_DIR-unset}" "\${GITLAB_HOST-unset}"
printf 'GIT_TERMINAL_PROMPT=%s\\nGIT_ASKPASS=%s\\nSSH_ASKPASS=%s\\n' \\
  "\${GIT_TERMINAL_PROMPT-unset}" "\${GIT_ASKPASS-unset}" "\${SSH_ASKPASS-unset}"
printf 'GIT_PAGER=%s\\nGLAB_CHECK_UPDATE=%s\\nNO_COLOR=%s\\n' \\
  "\${GIT_PAGER-unset}" "\${GLAB_CHECK_UPDATE-unset}" "\${NO_COLOR-unset}"
case "$1" in
  nonzero) printf 'fixture-out\\n'; printf 'fixture-err\\n' >&2; exit 7 ;;
  credential-missing) exit 1 ;;
  credential-unverified) exit 2 ;;
  credential-signal) kill -TERM "$$" ;;
  credential-token)
    [ "\${GLAB_TOKEN-}" = 'glab-sentinel' ] &&
      [ "\${GITLAB_TOKEN-}" = 'gitlab-sentinel' ] && exit 0 || exit 2 ;;
esac
exit 0
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  for (const command of ["git", "glab", "npm"]) {
    await symlink(executable, join(bin, command));
  }
  const environment: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    LANG: "C",
    LC_ALL: "C",
    GLAB_CONFIG_DIR: join(root, "glab-config"),
    GITLAB_HOST: "gitlab.example.test",
    GLAB_TOKEN: "glab-sentinel",
    GITLAB_TOKEN: "gitlab-sentinel",
  };
  return { root, bin, environment };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("doctor readiness command runners", () => {
  it("passes argv literally and preserves successful output in the fixture cwd", async () => {
    const { root, environment } = await fixture();
    const runner = new ExecDoctorReadinessCommandRunner(environment);
    const cwd = join(root, "working directory");
    await mkdir(cwd);
    const physicalCwd = await realpath(cwd);
    const marker = join(root, "must-not-exist");
    const literal = `; touch ${marker}; $(echo unsafe)`;

    const result = await runner.run("git", ["literal", literal], cwd);

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: [
        `cwd=${physicalCwd}`,
        `args=[literal][${literal}]`,
        "GLAB_TOKEN=unset",
        "GITLAB_TOKEN=unset",
        "GLAB_CONFIG_DIR=unset",
        "GITLAB_HOST=unset",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_ASKPASS=/usr/bin/false",
        "SSH_ASKPASS=/usr/bin/false",
        "GIT_PAGER=cat",
        "GLAB_CHECK_UPDATE=false",
        "NO_COLOR=1",
        "",
      ].join("\n"),
      stderr: "",
    });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes a failed command while retaining its output", async () => {
    const { root, environment } = await fixture();
    const result = await new ExecDoctorReadinessCommandRunner(environment).run(
      "npm",
      ["nonzero"],
      root,
    );

    expect(result).toMatchObject({ exitCode: 1, stdout: expect.stringContaining("fixture-out\n") });
    expect(result.stderr).toContain("fixture-err\n");
    expect(result.stdout).toContain("GLAB_TOKEN=unset\nGITLAB_TOKEN=unset\n");
  });

  it("refuses gh for doctor and GitLab publication probes without executing it", async () => {
    const { root, environment } = await fixture();
    const readiness = await new ExecDoctorReadinessCommandRunner(environment).run(
      "gh",
      ["auth", "status"],
      root,
    );
    const publication = await new ExecDoctorPublicationCommandRunner(environment).run(
      "gh",
      ["api", "user"],
      root,
    );

    expect(readiness).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Doctor does not support gh.",
    });
    expect(publication).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Doctor GitLab observation does not support gh.",
    });
  });

  it("keeps glab tokens only for auth status, API, and the credential probe", async () => {
    const { root, environment } = await fixture();
    const runner = new ExecDoctorReadinessCommandRunner(environment);
    const ordinary = await runner.run("glab", ["config", "get", "host"], root);
    const auth = await runner.run("glab", ["auth", "status"], root);
    const api = await runner.run("glab", ["api", "user"], root);

    expect(ordinary.stdout).toContain("GLAB_TOKEN=unset\nGITLAB_TOKEN=unset\n");
    expect(ordinary.stdout).toContain(
      `GLAB_CONFIG_DIR=${environment.GLAB_CONFIG_DIR}\nGITLAB_HOST=gitlab.example.test\n`,
    );
    for (const response of [auth, api]) {
      expect(response.stdout).toContain("GLAB_TOKEN=glab-sentinel\nGITLAB_TOKEN=gitlab-sentinel\n");
      expect(response.stdout).toContain(
        `GLAB_CONFIG_DIR=${environment.GLAB_CONFIG_DIR}\nGITLAB_HOST=gitlab.example.test\n`,
      );
    }
    await expect(runner.probeCredential("glab", ["credential-token"], root)).resolves.toBe(
      "present",
    );
  });

  it("maps credential probe exits, signals, and missing executables", async () => {
    const { root, environment } = await fixture();
    const runner = new ExecDoctorReadinessCommandRunner(environment);

    await expect(runner.probeCredential("glab", ["credential-missing"], root)).resolves.toBe(
      "missing",
    );
    await expect(runner.probeCredential("glab", ["credential-unverified"], root)).resolves.toBe(
      "unverified",
    );
    await expect(runner.probeCredential("glab", ["credential-signal"], root)).resolves.toBe(
      "unverified",
    );
    await expect(
      new ExecDoctorReadinessCommandRunner({
        ...environment,
        PATH: join(root, "empty"),
      }).probeCredential("glab", ["credential-token"], root),
    ).resolves.toBe("unverified");
  });

  it("uses the publication caller's environment verbatim when supplied", async () => {
    const { root, environment } = await fixture();
    const callerEnvironment: NodeJS.ProcessEnv = {
      PATH: environment.PATH,
      HOME: join(root, "caller-home"),
      GLAB_TOKEN: "caller-sentinel",
      GIT_TERMINAL_PROMPT: "caller-value",
    };
    const result = await new ExecDoctorPublicationCommandRunner(environment).run(
      "glab",
      ["api", "user"],
      root,
      { env: callerEnvironment },
    );

    expect(result.stdout).toContain("GLAB_TOKEN=caller-sentinel\n");
    expect(result.stdout).toContain("GIT_TERMINAL_PROMPT=caller-value\n");
    expect(result.stdout).toContain("GIT_ASKPASS=unset\nSSH_ASKPASS=unset\n");
  });
});
