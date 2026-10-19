---
title: DocsFab Live Agent Quickstart
description: Start a persistent DocsFab conversation for a local repository.
status: draft
content.type: tutorial
---

Use the DocsFab live agent to ask questions about a repository, get focused
documentation help, or start a bounded workflow in a conversation. Describe
the outcome you want in ordinary language. You do not need to name a skill or
workflow. For more information, refer to [Overview of DocsFab](../about/index.md).

<a id="before-you-start"></a>

## Prerequisites

Open a terminal at the root of a local Git repository so DocsFab can recognize
documentation directories such as `docs/` or `fern/`.

<Warning title="Documentation writes are on by default">
Use `--read-only` when you want inspection without file changes or host
commands.
</Warning>

## Quickstart Steps

Start a session, choose what you want the agent to do, and attach sources only
when a workflow needs specific files or a merged change.

### Start the Live Agent

Run the command from the root of the repository that you want DocsFab to inspect:

```bash
cd /absolute/path/to/target-repository
docsfab live-agent
```

The live agent uses your current directory. To target another local repository,
add `--repo /absolute/path/to/repository`.

DocsFab loads the configured model, skills, quality pack, and workflow catalog.
If setup is incomplete, guided setup runs before the conversation opens. When
the readiness banner appears, enter your request at the `You:` prompt.

<AccordionGroup>
<Accordion title="Model setup and configuration details" id="model-setup-details">
Guided setup uses the same flow as `docsfab setup`; you do not need a separate
startup script. At startup, `live-agent` prints a `Configuration:` line that
names the configuration root and secrets file. Startup only reads saved
credentials, does not write `secrets.env`, and leaves an existing configuration
root unchanged. Several sessions can share one configuration root.

When the root is incomplete, guided setup handles keys as follows:

- A stored or exported key does not choose a model. If the root names no
  model, for example, a `.env` that holds only `MODEL_API_KEY`, guided setup
  asks for the model settings because DocsFab has no default model. A key you
  export in the shell does not replace a stored key, although the current
  session still uses the exported key.
- If no key is stored, guided setup asks before saving an exported key. It
  offers only the key name that the root's model profile uses and never saves
  an exported key for a different provider. If you decline, guided setup asks
  for the model settings instead.

A key that you export only in the shell works for that session but is not
saved unless you agree. To save or replace a key, run `docsfab setup`.
</Accordion>
<Accordion title="Automatic Task Branch" id="automatic-task-branch">

When documentation writes are enabled, DocsFab prepares a unique task
branch in the selected checkout before the first file change if you are
on `main`, the repository default branch, or detached HEAD. Later writes
in the same session reuse that branch. Reading files and loading skill
instructions do not create a branch.

Automatic branching does not grant commit, push, merge-request, or merge
authority. It does not stash, reset, or discard your staged, unstaged, or
untracked files. Local `live-agent` uses the `--repo` checkout you
started; a task branch is not worktree or process isolation. It does not
resolve saved-patch conflicts by overwriting files.

If branch setup fails, DocsFab reports the reason and does not change
documentation files.

</Accordion>
</AccordionGroup>

### Try the Main Request Types

At the `You:` prompt, state the result you want. These examples show the
difference between a direct answer and a bounded workflow.

<Tabs>
  <Tab title="Ask a Question">
    Ask a direct repository question:

    ```text
    Explain what this repository does.
    ```

    The result lands in the chat reply only. A direct answer does not create
    a run record.
  </Tab>
  <Tab title="Ask for Documentation Help">
    Ask for a suggestion without changing files:

    ```text
    Suggest a clearer way to explain the installation prerequisites in this page. Do not change files.
    ```

    To disable edits and host commands for the whole conversation, start it
    with `docsfab live-agent --read-only`.
  </Tab>
  <Tab title="Start a Workflow">
    Ask for a bounded review:

    ```text
    Review the getting-started pages for clarity and summarize the findings.
    ```

    When the agent starts the matching workflow, the result lands in a
    named-workflow run record of the same kind that
    `docsfab run review-documentation` writes. Refer to
    [Runner Quickstart](runner-quickstart.md#check-the-result).
  </Tab>
</Tabs>

### Attach Sources to the Session

Attach sources when the conversation must use a specific tracked file or an
already-merged change. Source selection is optional for ordinary questions and
focused help.

Use a repository-relative path for each tracked file. Attaching a merge request
requires local `glab` authentication, and the request must already be merged.

Attach the documents and the merged change the conversation should work from,
at the moment you start it:

```bash
docsfab live-agent \
  --source docs/release-notes.pdf \
  --pr https://gitlab.example.com/team/docs-project/-/merge_requests/813
```

Repeat `--source` for each tracked file. `--pr` and `--mr` each take one
already-merged merge request. Pass its URL, a `host/group/project!number`
reference, or the number for the project this checkout points at.

Attached sources are a host selection, not a conversation topic. The following
rules apply:

- Every bounded workflow the conversation runs binds exactly these sources, and
  it binds them the way `docsfab run` binds the same selection. The writer and
  the verifier read the same immutable observations.
- The agent cannot add, replace, or drop one. You can, with the `/sources`
  commands below: the terminal answers them itself, before the line reaches the
  agent, so nothing the agent writes can change what a run binds.
- `create-documentation` and `update-documentation` accept bound sources. If the
  conversation asks for another workflow while sources are attached, that run
  stops and names the workflow rather than dropping your evidence.
- `--source` reads the file at the selected revision, never your working tree,
  and a run whose source cannot be read stops before writing and tells you what
  to change.

### Manage Sources During the Conversation

Use these terminal commands at the conversation prompt to inspect or change the
selection. Expand the reference for command behavior and limits.

<AccordionGroup>
<Accordion title="Source commands and limits" id="source-management-details">

Type these at the conversation prompt. The terminal reads them itself, so they
never become a request to the agent.

| Command | What it does |
| --- | --- |
| `/sources` | Lists every attached source with its format, status, version, limitations, and how this conversation has used it. |
| `/sources add <path>` | Attaches a tracked file by its repository-relative path. |
| `/sources add <merge request>` | Attaches one already-merged change, by URL, `host/group/project!number`, or number. |
| `/sources show <label>` | Shows one source, with a bounded preview of a tracked file. |
| `/sources refresh [label]` | Re-reads the attached files, reports whether a version drifted, and adopts the version each file has now. |
| `/sources revalidate [label]` | Re-checks each attached source against the repository or the forge and reports one coded state: `fresh`, `stale`, `missing`, `unreadable`, or `identity-changed`. It adopts nothing and detaches nothing. |
| `/sources remove <label>` | Detaches exactly one source. It deletes nothing anywhere and writes no custody record. |
| `/sources search [count]` | Not available in this release; it refuses without searching. The `context-v1-source-acquisition` corpus records the refusal in a deterministic cell, which is not live-provider evidence. An installed proof must not treat the refusal as a successful search. |
| `/sources purge <session>` | Previews which owned local copies of a session's source state would be deleted, which runs referenced them, and what stays retained. It deletes only when you run it again with the confirmation that preview printed, and it appends a custody record of what was removed. No host in this release wires a custody store, so it refuses and says plainly that it has nothing to delete rather than claiming a deletion. |

A label is exactly what `/sources` printed, matched byte for byte.

`/sources show` and `/sources refresh` read the file at the revision the session
selected, not your working tree, so an uncommitted edit does not change a
version. A merge-request reference reaches GitLab through the same local `glab`
authentication `docsfab run --pr` uses; no credential is read from, or written
to, the conversation.

What these commands will not do:

- They are read literally. A path is stored exactly as you typed it: there is no
  shell expansion, no command substitution, no quoting, and no glob, so a file
  whose name contains `$(...)` or a backtick attaches as itself.
- They attach nothing outside the selected repository. An absolute path, a
  parent-directory path, a `~/` path, a bare URL, and any reference whose own
  text reads as a host location or holds one of DocsFab's own configured
  credentials are refused by name.
  A refused command changes nothing: no source is attached, detached, or
  counted as refreshed.
- A pasted merge-request link is resolved to its project's numeric id and
  checked against the project path in the same link. A link naming another
  project is refused; no cross-project scope is ever inferred.
- `/sources remove` is refused while a bounded workflow run holds that source as
  required evidence, and the refusal names the step that requires it.
- Detaching an attachment, invalidating a cache and purging a session are three
  different operations, and `/sources purge` prints all three side by side
  before it deletes anything. Only a purge deletes bytes, only a purge is
  confirmed, and only a purge is recorded. A purge detaches nothing: the
  attached sources stay attached, their process-local derivatives are dropped,
  and each is marked as having had its owned local copy purged, so a later
  reference resolves to an explicit "unavailable" rather than to silence or to a
  reference quietly pointed somewhere else. Your own files and independently
  retained run evidence are outside the deletion, and DocsFab claims no erasure
  by any external model provider. A second purge of the same session says it has
  nothing to do rather than acting again. An ambiguous session reference, a
  session held by another principal or bound to another repository, and a
  session a writer still holds are each refused by name, with nothing deleted.
- The model cannot invoke `/sources purge`. The `/sources` family is parsed off
  the terminal's own input stream before a message reaches the session, and no
  tool definition or capability list a model can read names the verb or the
  command.
- `/sources refresh` reports a changed file as *drift* on the same entry. It
  never quietly attaches a second copy. Drift means "changed since the last
  `/sources refresh` in this conversation". Nothing is read when a source is
  attached, so the first refresh establishes the baseline rather than reporting
  against one.
- `/sources revalidate` checks where `/sources refresh` adopts. It re-reads each
  attached file and re-resolves each attached merged change, compares what it
  finds against what was admitted, and records the verdict without moving the
  version. A source it reports as `stale` stays stale in the listing until you
  refresh or detach it, so a run never binds a version the conversation was told
  had moved. Every verdict prints its *basis*, because `fresh` after comparing a
  recorded version and `fresh` on a file this conversation never read are
  different claims: the first says the file has not moved, the second says only
  that it reads cleanly now. A verdict older than the revalidation window is
  still shown, marked as beyond it rather than dropped. A bounded run refuses
  a last verdict of `stale`, `missing`, `unreadable`, or `identity-changed`,
  and it also refuses a `fresh` verdict that has aged past that window: the
  window is a gate, not only a listing mark. Revalidate again, or refresh or
  detach, before asking the conversation to run.
- `/sources revalidate` never detaches anything and never leaves a source out of
  its report. A source that vanished from the selected revision is reported as
  `missing` and stays attached; a condition that would let it check some sources
  and not others (more attached sources than one command re-checks, no wired
  reader, or a forge that cannot answer) refuses the whole command and records
  nothing, rather than reporting on a subset by silence.
- `missing` and `unreadable` are different answers and are never merged. A file
  the repository no longer tracks at that revision is `missing`. A file that is
  still there and whose bytes did not arrive, for example over the version
  ceiling or because of an I/O failure, is `unreadable`, and the other attached sources are still
  re-checked, so one oversized file does not cost you every other verdict.
  Telling you to restore a file that never left would be advice you cannot act
  on.
- A forge that cannot answer is never reported as an answer. Only "this project
  path is a different project now" is `identity-changed`; an unreachable forge,
  or one that answers without a usable project id, stops the command and says
  so. If the project is permanently gone, revalidate the rest by naming each
  label, or detach the merged change.
- `fresh (recorded-project-identity)` on a merged change means its *project* is
  still the same project. The change number, the merge commit, and the
  merge-request state are not re-read.
- A preview is bounded, and it is withheld entirely if it matches the runtime
  credential screen. A path under this host's checkout, home directory, or
  temporary directory is shown as a repository-relative path, `~`, or
  `$TMPDIR`. The agent's answers are never refused for naming a path.
- The agent is not told when you change the selection mid-conversation. Run a
  bounded workflow to bind the new selection, or ask the agent to restate what
  it is working from.
- The changes do not survive the conversation. Resuming a session restores the
  transcript, and rebuilds the attached selection from the `--source` and `--pr`
  options you started it with, so re-attach anything you added mid-conversation.

#### What Is Not Available Yet

This release does not support `/sources search`. Attach tracked files or a
known merged merge request with `--source` or `--pr` instead. A bounded workflow
can then gather evidence from those selected sources.

</Accordion>
</AccordionGroup>

For work that needs more than one kind of expertise, describe the complete
outcome. The agent can load an additional installed skill as the work develops,
in an order that respects skill dependencies. Loading a skill does not add
tools or permissions.

The agent uses a workflow only when its defined use case matches the outcome.
Ordinary questions receive a direct answer, and missing task details produce a
focused follow-up question. That follow-up is routing-time clarification. It
is not the after-the-job-starts work-product loop. Direct answers and
documentation edits stay interactive-operation evidence. They do not create a
named-workflow run record. When the agent starts a matching bounded workflow,
that child run keeps its own grant and settlement. The conversation refers to
the child result without inventing a second workflow success.

<AccordionGroup>
<Accordion title="Reader-impact updates" id="reader-impact-updates">
For a reader-impact update, DocsFab validates a bounded reader context and uses
the same locked reader-impact baseline for the applicable skill and workflow
steps. You can still describe an ordinary update in natural language. DocsFab
creates a conservative planning context from that request when no structured
reader context is supplied. This fallback can support a bounded update. It can
also support a verified no-change result when the plan keeps every page
unchanged and each kept page is admitted as current documentation; independent
read-only checks must confirm it. Host-bind of an operator-directed
update is closing admission, not default authoring. The write grant and the
admitted plan decide it, not the wording of the request. Text cannot certify
no-change.

Your request reaches the workflow in your own words, unchanged. MR evidence and
other details the agent retrieves travel beside it as non-authoritative context.
DocsFab keeps its internal reader-task summary short without discarding those
details. You do not need to shorten your request to fit that summary.

If the agent names an evidence file that is absent from the selected revision,
the update workflow continues with the available files. The missing file stays
in the workflow context and returned evidence limitations. Conclusions still
require supporting evidence; an omitted file does not count as reviewed.
Create, update, and restructure workflows share planning and writing guidance
that continues supported work and reports missing references. Focused writing
uses the same guidance. Work that depends on missing evidence remains deferred.

For a reliable no-change conclusion, provide an explicit base/head or current
workspace comparison. The focused reader-impact assessment runs read-only and
requires a clean selected checkout. If the comparison is unavailable or the
workspace changes, DocsFab reports the evidence limitation before it generates
a patch. The [update workflow contract](../reference/workflow-contracts/update-documentation.md)
explains how DocsFab binds the comparison, sources, and checkout snapshot.
Other documentation work continues to use the session mode and file boundaries
shown at startup, and loading a reader-aware skill grants no additional tools
or permissions.

Loading skill instructions in write mode does not start a reader-impact assessment.
If the agent includes optional reader evidence with that request, DocsFab loads
the instructions and reports that the evidence was not admitted or verified.
</Accordion>
</AccordionGroup>

The readiness banner shows the session ID and active model. A successful first
response also confirms that the configured model endpoint and credential work.

## Follow Work in Progress

After you submit a request, a compact status line shows the current activity
and elapsed seconds. Wait for the next `You:` prompt before typing another
request. Press **Ctrl+C** during a turn to request cancellation. Enter
`/exit` at an idle prompt to leave the conversation.

Activity labels, workflow stages, cancellation, and failure diagnostics are
in [Live Agent Reference in DocsFab](../reference/status-and-configuration/live-agent.md#follow-work-in-progress).

When a documentation workflow stops because the knowledge it gathered cannot
carry the request, the terminal names the category and what you can do next.
DocsFab normally saves that stop as a resumable run, so the usual rendering is:

```text
[Needs input] Running workflow: create-documentation (12s)
Workflow knowledge stop (insufficient-evidence). The knowledge snapshot cannot
support the requested page. Capture an attributed answer and resume the
original Task; do not invent intent. The stopped run
0199a0b6-11ea-7053-a764-53802ec5276a retains this stop. Validate an attributed
snapshot and print the exact resume command with
docsfab runs show 0199a0b6-11ea-7053-a764-53802ec5276a --canon-snapshot '<attributed-snapshot.json>' --accept-candidate-snapshot --authority-id '<accountable-authority-id>'
```

The command occupies its own line and ends with no punctuation, so you can
paste it verbatim. Capture the attributed answer as a snapshot file and run that
read-only command, substituting your snapshot path and authority id. It validates the
snapshot and prints the exact resume command; do not hand-type a
`--resume-from` command. [Answer and Resume](../workflows/answer-and-resume.md)
covers the full loop.

When the stop could not be saved as a resumable run, the terminal says so
instead of naming a run id, because there is nothing to resume. A later answer
from the conversation's own skills never removes the stopped workflow's
milestone.

## Resume or Start a New Session

Enter `/exit` to leave the conversation:

```text
You: /exit
```

Run the same command again to resume the most recent session for that
repository:

```bash
docsfab live-agent
```

Use `--new` to start a separate conversation:

```bash
docsfab live-agent --new
```

## What's Next

To explore available workflows and their steps before running a task, refer to
[Discover DocsFab Workflows](discover-workflows.md).

For flags, activity labels, GitLab evidence screening, and write bounds,
refer to [Live Agent Reference in DocsFab](../reference/status-and-configuration/live-agent.md).

To run a named workflow without a persistent conversation, continue to the
[Runner Quickstart](runner-quickstart.md) outcome chooser. That chooser covers
create, update with `--reader-source`, and review.

Continue with the matching journey when you already know the outcome.

<CardGroup cols={2}>
  <Card
    title="Update Documentation Beside a Change in DocsFab"
    href="/workflows/update-documentation-beside-a-change"
  >
    [Update Documentation Beside a Change in DocsFab](../workflows/update-documentation-beside-a-change.md)
  </Card>
  <Card
    title="Review Merge Request Impact in DocsFab"
    href="/workflows/review-merge-request-impact"
  >
    [Review Merge Request Impact in DocsFab](../workflows/review-merge-request-impact.md)
  </Card>
  <Card
    title="Baseline Documentation Health in DocsFab"
    href="/workflows/baseline-documentation-health"
  >
    [Baseline Documentation Health in DocsFab](../workflows/baseline-documentation-health.md)
  </Card>
  <Card
    title="Answer and Resume a Stopped Job in DocsFab"
    href="/workflows/answer-and-resume"
  >
    [Answer and Resume a Stopped Job in DocsFab](../workflows/answer-and-resume.md)
  </Card>
  <Card
    title="Propose Documentation After CI in DocsFab"
    href="/workflows/automatic-ci-proposals"
  >
    [Propose Documentation After CI in DocsFab](../workflows/automatic-ci-proposals.md)
  </Card>
  <Card title="About DocsFab Workflows" href="/workflows">
    [About DocsFab Workflows](../workflows/index.md)
  </Card>
</CardGroup>
