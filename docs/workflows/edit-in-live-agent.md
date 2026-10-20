---
title: "Edit Documentation in the DocsFab Live Agent"
description: "Request documentation edits and approve scoped host commands in an attached terminal conversation."
status: draft
content.type: how-to
---

Request documentation edits and approve scoped host commands in an attached terminal conversation.

## Edit Files and Run Commands

Direct checkout edits and write workflows are enabled by default.
Host commands still require terminal approval. File changes are
limited to the following paths:

- `docs/`, `doc/`, `documentation/`, and `fern/`, including nested
  documentation directories
- Common root documentation files: `README`, `CHANGELOG`,
  `CONTRIBUTING`, `AUTHORS`, `CODE_OF_CONDUCT`, and `SUPPORT`, with
  optional `.md`, `.mdx`, `.rst`, or `.txt` extensions
- Documentation reference-model records under
  `.docsfab/reference-model/`
- Additional directories passed with `--docs-dir`
- Markdown and MDX pages under the directories that `documentationRoots`
  lists in the committed `.docsfab.json`, the same directories a local
  workflow run writes, and each tracked page it lists as a file, such as
  `RELEASE.md`, as that one file. Code directories such as `src/`, and
  source, CI, hidden, third-party, and agent instruction files, are dropped,
  and the session start names each dropped entry.

Only `--docs-dir`, committed `documentationRoots`, and your answer at a
directory-grant confirmation widen this scope. The model, repository
instructions such as `AGENTS.md`, and command approval cannot. Asking for a
change to a page is not permission to edit its directory.

When you ask for a change to a page outside the scope, the agent asks the host
to grant the page's directory, and the terminal asks you:

```text
Allow DocsFab to edit Markdown and MDX pages under get-started/ for this session? Other files there stay read-only. [y/N]
```

Enter `y` to grant Markdown and MDX pages in that directory for the rest of
the session. When the repository has a `.docsfab.json`, a second confirmation
offers to add the directory to its `documentationRoots`. When the file has no
`documentationRoots` yet, the new list starts with `docs` and `fern`, so
workflow runs keep their default roots. The saved file is uncommitted: later
sessions and workflow runs use it after you commit it. Code, hidden, and
third-party directories, such as `src/` or `.github/`, cannot be granted. Source code, tests, CI configuration, and unrelated trees stay
read-only. The same bound applies to direct edits, workflow patch
application, saved-run publication, and command filesystem writes.

When a repository keeps its pages outside every recognized documentation
directory, for example in top-level `get-started/` and `guides/`
directories, the session start prints a `Documentation layout:` notice. It
lists the directories that hold read-only pages and the ways to grant them:
move the pages under `docs/` (recommended), list the directories in
`documentationRoots`, ask the agent for the change and approve the
directory grant, or restart with `--docs-dir` for each directory. A refused
edit, write, or command names the scope, and the agent asks for the grant
before it starts the work.
`docsfab doctor` reports the same layout as the advisory
`documentation-layout-unrecognized` diagnostic, which does not block
readiness. For recovery steps, refer to
[Live Agent Cannot Change a Page](../troubleshooting.md#live-agent-cannot-change-a-page).

Host commands require terminal approval. Enter `y` to approve or `n`
to cancel. Pressing Enter also cancels. Commands run through
`sandbox-exec` on macOS or `bwrap` on Linux. If isolation is
unavailable, commands do not run; direct documentation tools remain
available. Git metadata and private temporary files are additionally
writable so repository operations can function. In a linked worktree, only
shared objects and refs plus that worktree's own Git state are writable. The
files that point Git elsewhere or configure it, submodule Git data, and Git
repositories under documentation paths stay protected. For details, refer to
[Security and Trust](../reference/security-and-trust.md). The sandbox limits what a
command can write and hides DocsFab's own credential files. It is not a
network sandbox. For what a command can read, refer to
[What an Approved Command Can Read](#what-an-approved-command-can-read).

The default timeout is 120 seconds, and the ceiling is 1,800 seconds.
Combined standard output and standard error is limited by
`liveAgent.commandOutputBytes`. Cancellation, timeout, or excess output stops
the command but does not roll back completed changes.
Command output shows a checkout path repository-relative (`.` for the
checkout itself), the command's private temporary directory as `$TMPDIR`, and
your home directory as `~`. Run servers and watchers outside
`live-agent`: when a command ends for any reason, DocsFab stops the
background processes still in its process group before it returns the
result. Until then, a background process can keep running for a moment
and run its next steps. If one of them cannot be stopped within
`liveAgent.commandProcessStopMs`, the command fails with a refusal that
names that limit; end the process yourself before you retry.

On Linux, DocsFab also stops a background process that starts its own
session. On macOS, a process that leaves the command's process group on
purpose, for example through shell job control, a new session, or a
detached child process, can keep running after the command, and so can
one that runs as another user. It can still write documentation paths
and Git metadata after DocsFab checks the result. For details, refer to [Security and Trust](../reference/security-and-trust.md).

`--read-only` disables file writes and host commands for that
session.

### What an Approved Command Can Read

An approved command runs as you. It keeps your normal read access to files,
including your SSH keys and cloud credentials, with the following exceptions:

- It cannot read DocsFab's own credential files: `secrets.env`, the legacy
  `.env`, the `.env.legacy` copy that migration keeps, and the temporary and
  backup copies that `docsfab setup` makes of them, in the configuration root
  that `docsfab live-agent` names at startup. When one of these files is a
  symbolic link, the file that it points to is hidden. When the installed
  package's `.env` supplies DocsFab's credentials, that file is hidden too.
  Other files in the configuration root, such as `host.yaml`, stay readable.
- It receives an allowlist of environment variables, including `PATH`,
  `HOME`, and `SSH_AUTH_SOCK` for host Git access. DocsFab filters model keys,
  other configured credential values, and proxy credentials from the command
  environment. The shell and its child commands inherit this projected
  environment; configuration files loaded privately by DocsFab are not copied
  into it. The approved command can still use credentials available through
  your normal file access or SSH agent, and can inspect ambient values from
  DocsFab's process on macOS as described below.
- On Linux, it runs in its own process namespace, so it cannot see DocsFab's
  process or read its environment or command line. On macOS, it can see your
  other processes, including DocsFab, and can read their command lines and,
  for many programs, the environment that they started with. This can expose
  credentials that you exported before starting DocsFab; loading a credential
  from a DocsFab configuration file does not place it in that process
  environment.

DocsFab hides these files when each command starts. A credential file that
`docsfab setup` creates or replaces while a command runs can be readable to
that command, so run `docsfab setup` when no approved command is running.

The command keeps your network access. It can send any file that it can read
to any host that you can reach, so review each command before you approve it.

If an approved command fails at this boundary, use the following table.

| Output | Cause | Next step |
| --- | --- | --- |
| `Permission denied` (Linux) or `Operation not permitted` (macOS) for `secrets.env`, `.env`, or a copy of them in the configuration root | DocsFab hides its own credential files from approved commands. | Do not read these files from a command. To check the model configuration, run `docsfab profile inspect` or `docsfab doctor` outside `live-agent`. |
| `DocsFab refused the command (live-command-configuration-unreadable)` | DocsFab could not resolve or list its configuration root, so no command ran. | Run `ls -lLa` on the `Configuration:` path that `docsfab live-agent` prints at startup, fix the permission or broken link that it reports, and then retry. |

### After a Workflow Does Not Succeed

A workflow can stop before it creates a run record, for example with a
`proposal-scope-*` or first-pass refusal. It can also fail, stop for input, or
be cancelled after its run record exists. In either case, DocsFab refuses
direct `edit`, `write`, and host commands for the rest of that turn. The agent
cannot do the work outside the governed workflow, and you are not asked to
approve a command that would be refused.

When the agent caused the refusal, the agent can resubmit once, without showing
you a failure. That covers a request that was not your exact words, and a
request that joined several of your messages that the page check then refused.
The agent first decides whether your words ask for the workflow at all. It does
not resubmit a question or a "not yet" message. You see the failure only if the
resubmission also fails. The `liveAgent.agentCausedRefusalRetries` limit sets
the number of resubmissions (default 1, override
`DOCSFAB_LIVE_AGENT_AGENT_CAUSED_REFUSAL_RETRIES`, minimum 0).

When the turn ends on a failure, DocsFab prints a short notice. It starts with
what happened and whether anything was edited, then gives one `Details:` line
and your choices:

```text
I couldn't verify this change: the source facts didn't line up. Nothing was edited.
Details: run ec4a3803-a763-4b96-a8e5-e17f69c8aead, step provisional-technical-verification, code invalid-review, status failed.
Reply "retry" to try again, or "edit anyway" to make an unverified edit (skips source-fact checking and review).
```

Reply `retry` to run the workflow again for your original request. Reply
`edit anyway` to have the agent edit the files directly. A `--read-only`
session offers only `retry`, because it cannot edit files. That edit is
unverified: it has no authorizing run, and no workflow checked source facts,
reviewed it, or recorded evidence. After the turn, DocsFab prints:

```text
Unverified: this turn changed files directly after a workflow did not succeed, with no authorizing run. No workflow verified, reviewed, or recorded evidence for these changes.
```

Any other reply starts an ordinary turn with direct edits available again.
Those edits are also labelled unverified until a later workflow succeeds.

A workflow that stops on named InputAsk slots offers neither choice. Supplying
the named input is the only way forward, so the notice ends with:

```text
Reply with the named input above, such as the repository path of a source file, to continue this run.
```

For example, when a create workflow cannot establish a page's environment
prerequisites from its bound sources, reply with the path of the file that
states them.
