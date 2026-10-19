---
title: "Manage DocsFab Live Sessions"
description: "Resume, list, or delete the owner-private transcripts for live-agent conversations."
status: draft
content.type: how-to
---

Resume, list, or delete the owner-private transcripts for live-agent conversations.

## Resume Sessions

The same command without `--new` resumes the most recent session for
that repository:

```bash
docsfab live-agent
```

After a workflow asks for more information, you can exit and reopen the same
session in the same repository, then supply the requested details or reply
`retry`. A retry uses the original request unchanged. The session retains its
attached `--source` and `--pr` selections, subject to the existing evidence and
revalidation checks before a workflow can use them. A restart does not restore
write permission, so `--read-only` still applies. For InputAsk replies, follow [Reply in a Live Session](../workflows/supply-work-products.md#reply-in-a-live-session).

`--new` starts an empty session. For requests begun before this continuation
state was supported, or sessions without valid continuation state, restate the
original request and reselect its sources. If DocsFab cannot validate the
latest continuation state, it warns and refuses to infer pending workflow
state. Start a new session with `--new`, then restate the request and reselect
its sources.

## Stored Sessions and Deletion

DocsFab keeps each local live-agent conversation on your machine so that the
next `docsfab live-agent` in the same repository can resume it. Nothing in
this section applies to hosted conversations.

DocsFab stores the following data in the session directory.

| Data | Location | Contents |
| --- | --- | --- |
| Session transcript | `<configuration root>/.docsfab/live-agent/sessions/<timestamp>_<id>.jsonl` | Every message you type, every model reply, and each tool call and result in the conversation. Tool results can include repository file contents and merge request evidence. The transcript names the repository by a digest, not by its path. |
| Workflow continuation | A versioned host-only entry in the session transcript | The operator messages, pending workflow request, and source selections with their validation history. It does not restore write permission. |
| Task-branch state | `<configuration root>/.docsfab/live-agent/sessions/task-branches/<digest>.json` | The absolute path of one repository, the task branch prepared for it, and its default branch. |

The configuration root is `DOCSFAB_CONFIG_ROOT` when set. Otherwise, DocsFab
uses `$XDG_CONFIG_HOME/docsfab` when `XDG_CONFIG_HOME` is a normalized absolute
path, or `~/.config/docsfab` when it is unset or invalid. `docsfab config inspect`
prints the session directory in effect. The directory is owner-only (`0700`),
and each session file is owner-only (`0600`). `--new` starts another transcript
and keeps the earlier ones.

List the sessions on this machine with their ID, age, size, and repository
label:

```bash
docsfab sessions list
docsfab sessions list --repo /path/to/repository
```

Age counts from the last write to the transcript. The repository label is
`repo-` followed by the start of a digest of the repository path, so the listing
never prints the path. `--repo` shows only the sessions for one checkout.
`docsfab doctor` also reports the session count, total size, and oldest age.

Delete one session, every session, or the sessions older than a number of
days:

```bash
docsfab sessions delete <session-id>
docsfab sessions delete --all
docsfab sessions delete --older-than 30
```

Without `--confirm`, each form is a preview: it lists exactly what would be
deleted, deletes nothing, and prints the command to run, including a
`--confirm <token>` value. That token covers that exact set of files. If the
sessions change before you confirm, DocsFab refuses with
`live-agent-session-confirmation-mismatch` and deletes nothing, so preview
again. Add `--json` to any `sessions` command for machine-readable output.

Deleting a session removes its transcript. A repository's task-branch state is
removed together with the last session for that repository, and `--all`
removes all regular task-branch state files. Close every running
`docsfab live-agent` before deleting its session. If a process still has that
session open, its next turn can recreate the deleted transcript without its
original header. The startup age sweep has the same limitation when another
process keeps a session open. Deletion stays inside the session directory:
DocsFab refuses a session ID that contains a path, and it never follows or deletes a symbolic
link. If `task-branches/` itself is a symbolic link, preview and completion
name it as state left in place, including with `--all`. DocsFab does not inspect
or remove data behind that link. Other entries that are not session files stay
in place and are counted in the listing.

Deletion does not change your repository or its branches, and it does not
delete saved run records. DocsFab makes no claim about data that a model
provider retains.

### Remove Old Sessions Automatically

DocsFab does not remove sessions on its own unless you configure an age limit.
Set `DOCSFAB_LIVE_AGENT_SESSION_MAX_AGE_DAYS` to a whole number of days, either
in your environment or in the configuration root's `secrets.env` file:

```bash
DOCSFAB_LIVE_AGENT_SESSION_MAX_AGE_DAYS=30
```

Each `docsfab live-agent` start then removes, before it resumes a conversation,
every session last written more than that many days ago, and the task-branch
state of a repository left with no session. The terminal prints a line naming
how many sessions it removed. The setting is the
`liveAgent.sessionMaxAgeDays` limit, from 0 through 3,650 days. The default
`0` turns automatic removal off. An out-of-range value stops `live-agent`
before it deletes anything.

### Saved Run Records

A workflow that the live agent runs saves a run record, as `docsfab run` does.
Run records are kept in the run-record directory that `docsfab config inspect`
shows, which is `<configuration root>/.docsfab/runs` by default. A run record
contains your request verbatim. Run records and the workflow output beside them
are separate from sessions, and `docsfab sessions delete` does not remove them.
Workflow output for those runs, such as artifacts, patches, and delivery
receipts, is kept in directories beside the run-record directory. This release
has no command that deletes run records. To remove them, delete the run-record
directory and those directories beside it.
