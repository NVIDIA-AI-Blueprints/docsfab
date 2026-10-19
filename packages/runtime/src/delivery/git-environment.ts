// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The environment the host Git publisher runs `git` with. It keeps the
 * operator's `HOME` and login names, so Git's system, global, and repository
 * configuration all apply, and turns off prompts, pagers, replace objects,
 * system attributes, and optional locks.
 *
 * Preflight reads the operator's Git identity (`user.name`, `user.email`)
 * with this environment, less the SSH agent socket and login names a
 * configuration read does not need, so the identity a publication plan binds
 * is the one the publisher commits as (#2362). Every other preflight Git read
 * keeps its isolated environment.
 */
export function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    TMPDIR: source.TMPDIR,
    SSH_AUTH_SOCK: source.SSH_AUTH_SOCK,
    LC_ALL: "C",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
  return Object.fromEntries(Object.entries(result).filter((entry) => entry[1] !== undefined));
}
