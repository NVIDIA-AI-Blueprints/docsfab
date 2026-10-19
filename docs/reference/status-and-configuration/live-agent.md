---
title: "DocsFab Live Agent Reference"
description: "Look up session invocation, flags, workflow-request binding, and activity labels. Start with the Live Agent Quickstart."
status: draft
content.type: reference
---

Look up session invocation, flags, workflow-request binding, and activity labels. Start with the [Live Agent Quickstart](../../get-started/live-agent-quickstart.md).

## Invocation

The following commands start or resume a live-agent session.

| Command | Purpose |
| --- | --- |
| `docsfab live-agent` | Start or resume a conversation for the current repository |
| `docsfab live-agent --new` | Start a separate conversation instead of resuming |
| `docsfab live-agent --read-only` | Inspect without writing files or running host commands |
| `docsfab live-agent --repo <path>` | Target a repository other than the current directory |
| `docsfab live-agent --docs-dir <path>` | Add one extra documentation directory; repeatable |
| `docsfab live-agent --source <path>` | Attach one tracked file as bound evidence for the session; repeatable |
| `docsfab live-agent --pr <url-or-reference>` (or `--mr`) | Attach one already-merged merge request as bound evidence for the session |

`live-agent` requires a configured model. If the first request fails
with a model or credential error, run `docsfab setup` and retry.

## Session Flags

The following flags apply to one `live-agent` process.

| Flag | Effect |
| --- | --- |
| `--read-only` | Disable documentation edits, workflow writes, and host commands. |
| `--new` | Create a new session without deleting earlier sessions for this repository. To delete sessions, refer to [Stored Sessions and Deletion](../../manage/live-sessions.md#stored-sessions-and-deletion). |
| `--repo <path>` | Run against another local checkout. |
| `--docs-dir <path>` | Add a repository-relative documentation directory. Repeat the flag to add more than one. |
| `--allow-write` | Compatibility flag. Writes are already the default. Do not combine it with `--read-only`. |
| `--source <path>` | Attach one tracked, repository-relative file as bound evidence. Repeat the flag to attach more than one. |
| `--pr`, `--mr` `<url-or-reference>` | Attach one already-merged merge request as bound evidence. Two spellings of one option. Accepts its URL, a `host/group/project!number` reference, or the number alone for this checkout's project. Pass it at most once, under either spelling. |

## Workflow Requests

An unqualified request such as `review this PR` or `review this MR` asks
DocsFab to review documentation. The agent reviews changed pages and checks
whether implementation changes require documentation updates, including when
the change contains no documentation files. It reads code, configuration, and
tests to ground documentation findings. It selects a suitable skill, a sequence
of skills, or the matching review workflow. A broader review requires an
explicit request.

When the agent selects the review workflow for a request naming one public
GitHub pull request URL, or a GitHub PR selected with `--pr`, the host binds the
PR diff and selects the PR head
as the workflow's file snapshot.
The live agent first fetches the head through a terminal-approved host command.
The workflow prints the selected PR number and commit before its steps begin.
Your current branch and working files stay in place. A read-only session can
use a PR head already present in the checkout's Git objects; a missing head
requires an approved fetch in a write-enabled session.
Retries keep the saved revision, review scope, and PR evidence. The host
reacquires the PR and checks its identity, commit, and diff before starting
the workflow. If the original request does not name the PR and its source
is detached, select it again with `/sources review <PR URL>`, then retry.
If the PR evidence has changed, start a new review request. An offline
request cannot retry a saved review that requires PR evidence.
For an offline review using local evidence, omit `--pr` and say that network
access is disabled in your request. Detach an existing PR source with
`/sources remove <label>` first. `/sources list` shows the selected PR's label.

The final workflow activity distinguishes execution from the review conclusion.
`Evidence limited` means that execution finished with insufficient evidence for
an overall quality conclusion. `Findings` means that the report calls for
corrections or human review. Read the findings and unverified scope in the reply.

A bounded workflow receives an instruction, not the conversation history. The
live agent passes your request in your own words, unchanged: your current
message, or your consecutive messages that end with the current one, with none
skipped. DocsFab reads that text for the pages to change, the sources to use,
and any restrictions, exactly as `docsfab run --instruction` does.

Anything the agent adds, such as retrieved evidence, merge request details,
earlier context for a follow-up, or its own restatement, travels separately as
context. DocsFab never reads context for pages, sources, or restrictions. The
workflow sees it only as a fenced, non-authoritative block after your
instruction, and every line inside is marked as data, so context cannot pose as
your instruction. Context longer than `liveAgent.workflowContextMaxChars`
(default 16,384 characters) is cut at that limit with a coded
`live-agent-workflow-context-max-chars-bound` marker. The cut is recorded on the
run, and the turn ends with a `Context clipped` line that names the limit and
how many characters were left out. Your instruction is never cut. The run keeps its context when it continues after a request for input.

DocsFab never picks or rewrites your words. If the agent passes anything other
than your consecutive messages, the request stops with
`live-workflow-request-not-verbatim`. Context that contains one of DocsFab's
own configured credentials stops with `live-workflow-context-credential-material`.
Text that only looks like a credential does not stop it. Refer to
[Credential-Like Content](../security-and-trust.md#credential-like-content).

Repository observations, such as whether a target file exists, are established
by the workflow's reads. This handoff guidance does not replace source checks
or the attached-source rules above.

## Follow Work in Progress

After you submit a request, the status line shows `[Working]`, the
current activity, and elapsed seconds. Wait for the next `You:`
prompt before typing another request. Text typed during active work
is ignored, except when a command approval is asking for input.

In a color terminal, replies use Markdown formatting without vertical message
or quote borders. You can copy suggested requests and code without including
decorative bars. Quoted text retains its color and italics.

The following table lists activity labels the renderer prints.

| Activity | Meaning |
| --- | --- |
| `Contacting model` | The runtime is waiting on the model. |
| `Retrying model request: <cause>, attempt <n> of <max>` | The model request failed and DocsFab is waiting to send it again. The cause is the HTTP status, such as `HTTP 429` or `HTTP 503`, or, with no status, `connection or server error`, `rate limited`, `timed out`, or `empty answer`. Press **Ctrl+C** to stop waiting. |
| `Running workflow: <id>` | A catalog workflow is in progress. |
| `<workflow> · step n/m: <stepId>` | One workflow step is running on a known path. |
| `<workflow> · <stepId>` | One workflow step is running before the path ordinal is known. |
| `Editing repository files` | An `edit` or `write` tool call is running. |
| `Running approved host command` | A terminal-approved command is running, including checkout `glab` or `gh` publication. |
| `Creating draft merge request` | Saved-workflow-patch publication is running or waiting for confirmation. |
| `Listing merged GitLab MRs (page n)` | The runtime is listing merged merge requests. |
| `Reading GitLab MR !<iid> details` | The runtime is fetching one merge request. |
| `Reading GitLab MR !<iid> diffs (page n)` | The runtime is fetching one merge request's diffs. |
| `Reading GitLab evidence (invalid request)` | A GitLab read was requested with invalid arguments. |
| `Loading skill: <id>` | An installed skill is loading. |
| `Reading saved run: <id>` | A saved workflow run is loading. |
| `Reading repository evidence` | A repository read, search, or listing is running. |
| `Consulting quality guidance` | The runtime is reading the quality pack. |
| `Receiving response` | The model is writing the operator-facing reply. |
| `Running tool` | A tool is running without a more specific safe label. |
| `Cancellation requested; waiting for active work` | **Ctrl+C** was pressed during a turn. |

A completed activity is prefixed with `[Done]`, `[Failed]`,
`[Cancelled]`, or `[Needs input]`. `[Done]` means that stage
executed; it does not mean quality findings passed. `[Needs input]`
means named InputAsk slots are open. Enter the requested value in the
next message. Do not run `docsfab doctor` to continue editorial work.
The `live-agent` command has no `--continue` or `--attach` flag.
For the accepted reply syntax and file-slot behavior, follow [Reply in a Live Session](../../workflows/supply-work-products.md#reply-in-a-live-session).

For the update never-author-by-default gate, refer to the
[update workflow contract](../workflow-contracts/update-documentation.md).

A mutating host command pauses for `[y]` or `[n]` approval. The
default is cancel.

Press **Ctrl+C** during a turn to request cancellation. Cancellation
is a stop request, not a rollback. For workflows, it stops retries
and later stages and prevents checkout patch application from
starting. Completed work is not undone. If Git has already started
applying a patch, DocsFab lets that apply settle and checks the
result. Active file-write tools finish the current filesystem
operation before cancellation settles. Inspect the retained patch and
checkout before resuming. Do not interpret cancellation as "no files
changed."

Cancelled workflows with a saved run use status `failed` and the
diagnostic "Workflow cancelled by user." Any captured draft patch is
a recovery artifact, not proof that checkout files changed.

If you cancel during first-pass source checking, before a run record exists,
DocsFab reports "Workflow cancelled by user." When private cancellation
evidence persistence succeeds, DocsFab retains that evidence. This stop does
not imply a model connection failure or a completed workflow. The cancellation
notice does not offer `retry` or `edit anyway`.
Send a new request when you are ready to continue.

Enter `/exit` or `/quit` at an idle prompt to leave. The runtime
keeps the session ID, so the next `docsfab live-agent` in the same
repository resumes that conversation.

If a turn fails, the renderer prints a compact, credential-safe
summary. When the model provider answered the request with an error, the
summary names the HTTP status and what to check, and says how many times
DocsFab sent that model request. It never prints the provider's response body.
The following table lists what to check for each status.

The following table lists each status and what to check.

| Status | What to check |
| --- | --- |
| 401 or 403 | The API key, and whether it may use the configured model. |
| 404 or 405 | The model name, the selected API, and the endpoint. Rerun `docsfab setup` with the base URL, not a full request URL. |
| 407 | The proxy settings and credentials between DocsFab and the provider. |
| 429 | The key's rate limit, quota, or spend budget at the provider. A key with no remaining budget fails the same way on every retry. |
| 5xx | The provider's availability. Retry later. |

When a failure has no safe detail, refer to
[An Unexpected Failure Does Not Explain the Cause](../../troubleshooting.md#an-unexpected-failure-does-not-explain-the-cause).

## Saved Runs

Ask "Summarize saved run RUN-ID without rerunning it." The agent uses
`docsfab_read_run` in both read-only and write-enabled sessions. It
returns stage statuses, quality results, and the final stage summary.
It does not require shell approval, edit files, or publish anything.
Historical results do not establish the current checkout. A saved run larger
than `runs.recordMaxBytes` is refused with a message that names its size, the
limit, and the setting that raises it.

## Session Startup and Mode

Use `docsfab live-agent` as the single entry point for an interactive DocsFab
session. There is no `start_docsfab.sh` wrapper and no hidden background
startup process. The CLI performs startup in its own process:

1. It checks the active host model configuration and runs the existing setup
   flow if required values are missing.
2. It verifies the package-bound skill crate, quality pack, and workflow
   catalog.
3. It starts or resumes an owner-private Pi session.
4. It opens the terminal conversation and stays attached until you exit.

Within the conversation, Pi selects the smallest suitable route. It can answer
in natural language, use one focused skill, or invoke one bounded runtime
workflow. A skill or workflow result returns to the same conversation so you
can continue with a follow-up message.

Bounded workflows from `docsfab run` and `docsfab live-agent` use the same
local workspace, revision, preflight, first-pass knowledge, and execution
admission. The caller still owns its presentation. The CLI renders human or
JSON output and selects an exit code, while the live agent returns the saved run
record to the active conversation without changing the process exit code.
Both surfaces dispose the temporary workspace after their result consumer
finishes, including when that consumer fails.

By default, the command resumes the most recent live session. Create a separate
session without deleting earlier state when you need a new conversation:

```bash
docsfab live-agent --new
```

The command uses the current directory as the repository by default. Select a
different local repository with `--repo <path>`. Documentation edits and workflow
writes are enabled by default, within the documentation-path scope. Host commands
still require terminal approval. To inspect without writes or host commands:

```bash
docsfab live-agent --repo /absolute/path/to/repository --read-only
```

The mode applies to the current process, including resumed conversations.
`--allow-write` remains accepted for compatibility and cannot be combined with
`--read-only`. These live-agent flags do not change other commands' defaults.

The current live-agent transport is an attached interactive terminal. The
command does not start a background process or a Slack connection.

At process startup, the interactive terminal shows the DocsFab wordmark in
NVIDIA Green. After configuration, capability verification, and Pi session
loading complete, a compact **READY** summary reports the session, model,
available skills, quality pack, available workflows, execution mode, and
terminal transport. Set `NO_COLOR`, set `FORCE_COLOR=0`, or set `TERM=dumb`
to keep the banner and summary free of ANSI color and text styling.

`docsfab setup` remains available as an optional configuration-only command.
Use `docsfab run <workflow>` for one-off continuous integration jobs. Each
`run` invocation creates an ephemeral Pi session, produces its bounded result,
and exits. It does not start or resume the live-agent session.

## Moved Topic Links

Earlier section bookmarks lead to the canonical topic below.

<a id="after-a-workflow-does-not-succeed"></a>

Refer to [Edit Documentation in the DocsFab Live Agent](../../workflows/edit-in-live-agent.md#after-a-workflow-does-not-succeed).

<a id="attached-sources"></a>

Refer to [Attach Evidence to a Live Session in DocsFab](../../workflows/attach-live-sources.md#attached-sources).

<a id="create-a-draft-merge-request"></a>

Refer to [Deliver a Live-Agent Patch in DocsFab](../../workflows/deliver-live-patch.md#create-a-draft-merge-request).

<a id="edit-files-and-run-commands"></a>

Refer to [Edit Documentation in the DocsFab Live Agent](../../workflows/edit-in-live-agent.md#edit-files-and-run-commands).

<a id="publish-an-exact-saved-workflow-patch"></a>

Refer to [Deliver a Live-Agent Patch in DocsFab](../../workflows/deliver-live-patch.md#publish-an-exact-saved-workflow-patch).

<a id="remove-old-sessions-automatically"></a>

Refer to [Manage DocsFab Live Sessions](../../manage/live-sessions.md#remove-old-sessions-automatically).

<a id="resume-sessions"></a>

Refer to [Manage DocsFab Live Sessions](../../manage/live-sessions.md#resume-sessions).

<a id="saved-run-records"></a>

Refer to [Manage DocsFab Live Sessions](../../manage/live-sessions.md#saved-run-records).

<a id="stored-sessions-and-deletion"></a>

Refer to [Manage DocsFab Live Sessions](../../manage/live-sessions.md#stored-sessions-and-deletion).

<a id="use-gitlab-merge-requests-as-evidence"></a>

Refer to [Attach Evidence to a Live Session in DocsFab](../../workflows/attach-live-sources.md#use-gitlab-merge-requests-as-evidence).

<a id="what-an-approved-command-can-read"></a>

Refer to [Edit Documentation in the DocsFab Live Agent](../../workflows/edit-in-live-agent.md#what-an-approved-command-can-read).

<a id="when-credential-screening-withholds-evidence"></a>

Refer to [Attach Evidence to a Live Session in DocsFab](../../workflows/attach-live-sources.md#when-credential-screening-withholds-evidence).

<a id="workflow-patches-and-checkout"></a>

Refer to [Deliver a Live-Agent Patch in DocsFab](../../workflows/deliver-live-patch.md#workflow-patches-and-checkout).
