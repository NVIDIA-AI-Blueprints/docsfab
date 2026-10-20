# Live agent

This directory implements DocsFab's conversational runtime. The local live
agent keeps a Pi conversation for one repository and can inspect or edit the
current checkout. It can also launch a bounded documentation workflow when the
user's task matches one, but ordinary conversation and direct actions do not
pass through `WorkflowRunner`.

Unqualified PR and MR review requests default to documentation review.
`buildLiveAgentSystemPrompt` establishes that scope before skill and workflow
selection: source changes are evidence for documentation accuracy and missing
coverage, including source-only diffs. The agent chooses a review skill,
additional skills, or the matching workflow rather than treating the request
as a general code review. The `pull-request` case in
[`live-agent-behavior-proof.mjs`](../../scripts/live-agent-behavior-proof.mjs)
checks actual review-tool use, evidence reads, and a documentation finding.

For a workflow request naming one public GitHub PR URL, `review-target.ts`
resolves its diff through the shared change-source adapter and pins the PR head.
The agent fetches the PR through the existing approved command tool first.
The bounded runner supplies the selected revision and the already acquired
change to the shared local workflow, which checks that the PR and snapshot
match before inference. Parent conversation context cannot select the target.
The workflow uses a tracked export of that commit and does not switch the
current checkout. Missing objects refuse with an approved-fetch next action.

For usage, start with the
[live-agent quickstart](../../../../docs/get-started/live-agent-quickstart.md).
The [runtime source map](../README.md), the
[harness guide](../harness/README.md), and the
[host-invoker guide](../host-invoker/README.md) describe the surrounding code.

## Local conversation lifecycle

[`host.ts`](host.ts) is the main local entry point. `runLiveAgent` checks the
interactive terminal and repository, loads verified capabilities, opens the
provider connection, confines tools to the repository, and calls Pi's
`createAgentSession` directly. [`runTerminalConversation`](host.ts) then sends
each user message to that session.

By default, `SessionManager.continueRecent` resumes the most recent transcript
for the same repository path from the external private session directory.
`--new` uses `SessionManager.create` to start another transcript; it does not
delete earlier sessions. Local session memory helps conversation continuity,
but it is not canonical evidence about the current repository.

### Stored sessions and deletion

The session directory is `<configuration root>/.docsfab/live-agent/sessions`
(`resolveDocsFabLiveAgentSessionDirectory`), owner-only `0700` with `0600`
files. It holds two kinds of file:

- Pi transcripts, `<timestamp>_<id>.jsonl`: every user message, model reply,
  and tool call and result, which can include repository file contents. The
  header records the repository as `repositoryVirtualCwd`, a digest, not the
  path; transcripts written before virtual cwds record the absolute path.
- Task-branch state, `task-branches/<digest>.json`, written by
  [`branch-preparation.ts`](branch-preparation.ts): one repository's absolute
  path, its task branch, and its default branch.

[`local-sessions.ts`](local-sessions.ts) owns listing and deletion, and
`docsfab sessions` ([`../cli/commands/sessions.ts`](../cli/commands/sessions.ts))
is its CLI. `list` prints id, age since the last write, size, and a
`repo-<digest prefix>` label, never the path. `delete <id>`, `delete --all`, and
`delete --older-than <days>` preview first. A deletion needs the `--confirm`
token the preview printed, which is minted over each file's identity, as
`sources purge` does. A repository's task-branch state goes with its last
session, and `--all` removes all regular task-branch state files. Deletion
touches only regular files directly in the session directory or
`task-branches/`. It refuses an id that is not a `SAFE_RECORD_ID`, a session
directory that is a link, and a selected file that becomes a link or another
entry. A `task-branches/` link is left in place. The preview and completion
name that residual, including for `--all`; DocsFab never traverses its target.
Before deletion, it checks the root and selected task-branch directory identity.
It re-checks each file's device and inode before `unlink`, so a file swapped
after inventory is refused. A later failure reports the number of files already
removed.

Close every running `docsfab live-agent` before deleting its session. Deletion
does not detect a conversation that still holds the transcript open. Its next
turn can recreate the deleted transcript without the original header. This also
applies when another process keeps a conversation open during the startup age
sweep.

`liveAgent.sessionMaxAgeDays` (override
`DOCSFAB_LIVE_AGENT_SESSION_MAX_AGE_DAYS`) is an opt-in age bound. When it is
positive, `runLiveAgent` calls `enforceLocalSessionRetention` before it opens
or resumes a session. That call removes sessions last written before the bound,
plus task-branch state left without a session, and prints one line saying what
it removed. The default `0` removes nothing, because deleting conversation
history is a destructive action the user has to configure. `docsfab doctor`
reports the session count, total size, oldest age, and the bound.

Saved run records are separate: they live in the run-record directory, keep the
verbatim instruction, and `docsfab sessions` does not remove them.

The local conversation operates on the current checkout. Its direct read tools
therefore see uncommitted changes. With `--read-only` it receives confined read
tools, installed-skill access, saved-run inspection, and GitLab read access.
Direct repository mutation and commands are unavailable.

Each terminal turn keeps ordinary questions in the conversation path. Before
repository work, the live agent selects a verified skill or bounded workflow
through its existing skill and workflow tools. Repository reads and edits are
then admitted only for that selected objective; a skill must be loaded before
repository access, and a workflow must be selected before its review evidence
tools run. The host rechecks the current session and attached-source binding at
each admission. After a workflow failure, the objective remains closed until
the existing retry, cancel, or edit-anyway recovery path starts a new turn.
These selections describe work and do not grant permissions.

A selected PR or MR can be attached as evidence for existing local authoring
workflows, but the current local workflow materializer still opens the local
checkout at its selected revision. For that reason, the live host refuses a
`review-documentation` run with a PR or MR selected until the revision-correct
workspace supplier is available. A local documentation review remains
available after the operator detaches that source.

By default, the session can use direct `edit` and `write` operations
within the configured documentation scope. Before those writes, and before
approved host commands or workflow persist apply to the checkout, the host
prepares a unique task branch when the checkout is on `main`, the
repository default branch, or detached HEAD, and reuses that branch for
later writes in the session. Reading and skill-instruction loading do not
require a branch. Branch preparation does not stash, reset, discard,
commit, push, or merge, and it is not worktree isolation.

`docsfab_run_workflow` takes the user's request verbatim in `instruction`: the
user's consecutive messages ending at the current one, unchanged, none skipped.
That is the only text DocsFab parses for targets, sources, and restrictions, as
with `docsfab run --instruction`. Everything the agent adds goes in `context`,
which is never parsed, is cut at `liveAgent.workflowContextMaxChars` with a
coded marker, is recorded on the run and kept on InputAsk continuation, and
reaches workflow steps only inside a digest-fenced block whose lines are all
marked as data. `bindLiveWorkflowRequest` in [`host.ts`](host.ts) enforces this
and never substitutes text: anything else is refused with
`live-workflow-request-not-verbatim`.

Only `update-documentation` takes the reader fields `readerContext`,
`readerSources`, and `readerComparison`. The single declaration is
`LIVE_READER_INTAKE_WORKFLOWS` in
[`invocation-bindings.ts`](invocation-bindings.ts), and it drives admission,
the tool schema, and prompt guidance. When the agent sends reader fields to
another workflow, the host still starts that governed run. It does not decode,
observe, or pass the fields to the run; the tool result lists them as
`unadmittedReaderFields` and adds a fixed note.

A workflow that does not succeed closes direct `edit`, `write`, and `bash` for
the rest of that turn. This applies whether it was refused before its run
record (a proposal-scope, first-pass, invocation-contract, or reader-handoff
stop) or failed after it. The prompt also tells the agent not to replace a
failed workflow with its own direct review.
[`workflow-failure-gate.ts`](workflow-failure-gate.ts) holds that state, and
the operator's next message reopens it. After a refusal the agent caused, the
tool returns a fixed resubmission prompt instead of a failure, and the agent
may resubmit the user's exact words once (`liveAgent.agentCausedRefusalRetries`).
A failure that ends the turn gets a host-rendered notice: a plain sentence, one
`Details:` line, and the replies `retry` and, in write mode, `edit anyway`. A
first-pass refusal the model can correct reaches this notice only after the
first pass has re-asked the model with a host-written hint, within
`retry.maxRetries` and its model-turn budget, so `edit anyway` is never offered
before those retries are spent. The host recognizes those replies. A direct edit made after a failure is labelled
unverified, with no authorizing run. Workflow retries and checked patch
delivery are never gated.

`retry` replays the complete bound request unchanged. During that turn, the host
refuses a shortened or rephrased workflow instruction, including a suffix that
would be valid for a new request. It remains available
across an intervening conversation turn until another workflow result replaces
it or a workflow succeeds. The `edit anyway` choice expires after the next
turn. A planner or first-pass input stop without named editorial InputAsk slots
usually needs a new run: send the complete request with the requested details,
or retry the original request unchanged. A new first-pass contradiction stop
that explicitly records repository-only evidence can accept one offered source
option in the current live-agent session. Reply with its exact option, or use
`Use the implementation` when one verified executable implementation span is
unambiguous. DocsFab binds that choice to the stopped run and revision and
records it as attributed, unverified evidence. Reopening the same saved session
retains its pending offer; `--new` and sessions without a retained offer need a
new request. Conversation text does not grant choice authority.
Successful choice patches can apply to the authorized checkout while keeping
their attribution; those runs remain ineligible for publication. Earlier stops
and runs with attached sources, changes, reader evidence, or live context require a new run;
the choice reply does not add authority. If DocsFab cannot identify the exact
section to withhold, it asks for a new request naming that section.
When a details-only attempt stops with `request-intent-target-missing`, the host
keeps an earlier same-workflow input request as the retry target. The notice
identifies that earlier request explicitly. A retry replays it unchanged; it
does not add the details from the targetless attempt. The latest refusal remains
visible, and its direct-edit choice expires with that turn. Send a complete
amended request to change the retained task or include your answer.

For a named editorial InputAsk, give a text answer as `<inputId>: <answer>`,
for example `prd: The default name is friend.` or
`accepted-decision: Use the implementation default.` A file answer is its exact
tracked repository path. Questions and ordinary chat leave the named inputs
open and block direct edits. A bare `retry` also leaves them open; use
`prd: retry` when that word is the intended answer. Explicit CLI `--reply`
continues to accept a reply sentence.
 [`assembleLiveAgentHost`](host.ts) wires all of this
for `runLiveAgent`.

It can also propose a `bash` command;
each exact command requires terminal approval and runs through the
documentation-scoped command sandbox. `--allow-write` remains a compatibility
flag and cannot be combined with `--read-only`. The process write mode does not
authorize merging, destructive Git operations, or
publication by itself.

## Skills, workflows, and saved evidence

The conversation exposes a small set of DocsFab tools:

- `docsfab_use_skill` reads a verified installed skill and its locked supporting
  references into the conversation. Loading instructions is not evidence that
  the skill was applied, completed, or checked.
- `docsfab_run_workflow` launches one installed bounded workflow through
  `runBoundedWorkflow`, which delegates to `withLocalWorkflowRun` and the normal
  workflow execution stack.
- `docsfab_read_run` reads a saved run belonging to this repository as
  historical evidence. It does not prove the present checkout has the same
  contents.
- `docsfab_read_gitlab` reads bounded merge-request evidence using the selected
  repository and the host's existing GitLab login. Returned text is untrusted
  evidence.
- `docsfab_publish_workflow` publishes one exact successful saved workflow patch
  only after separate terminal confirmation.

A bounded workflow runs in a disposable workspace exported from committed
`HEAD`. It does not see unrelated uncommitted checkout edits. If a successful
write workflow produces changes, [`LiveWorkflowDelivery`](workflow-delivery.ts)
verifies the saved run, revision, changed paths, and patch before applying it
back to the current checkout. Its result distinguishes `applied`,
`already-applied`, `not-needed`, and `failed`; a successful workflow alone is
not a claim that checkout files changed.

The live host saves that checkout result on the same run as
`checkoutPersistence` after the apply attempt. The workflow's `status` and step
statuses continue to describe execution in the disposable workspace; an
`outcome: failed` makes the overall live result and saved-run status `failed`
without rewriting the successful workflow evidence. The saved outcome carries
only a closed error code, including `run-record-contract-gap` when strict saved
run validation rejects the patch before application. An older run with no
`checkoutPersistence` has unknown checkout outcome. Use
`docsfab runs show <runId> --state-dir <path>` or `docsfab_read_run` to inspect
the historical outcome and the retained patch. Those reads do not prove the
checkout's current contents.

Publication is a separate optional path. The publication tool verifies and
ships the saved patch in its own delivery worktree after confirmation. Direct
checkout edits can instead be committed or proposed through an individually
approved command. These paths intentionally preserve whether the published
content came from a saved workflow or from later local work.

The [repository guide](../repository/README.md) compares these workspace types.
The [records guide](../records/README.md) explains saved evidence, and the
[delivery guide](../delivery/README.md) traces saved-patch publication.

## Noninteractive task activity

`live-agent --task-file` writes a public `<requestSha256>.activity.jsonl`
companion beside its versioned JSON result. The result's
`trace.activitySha256` binds the exact companion bytes. The JSONL header binds
the task, session, prompt digest, request digest, installed tool names, and
provider routes. Ordered events record native Pi tool calls and physical
provider sends/responses with typed action metadata, result byte counts, and
SHA-256 digests. The footer names coverage for `provider`, `tools`, `source`,
`web`, `workspace`, and `child`, plus explicit missing reasons. It
contains no prompt, model response, source body, or tool result body.

`trace.status: complete` requires every admitted direct observer to finish and
all coverage categories to be complete. In activity schema v2, an admitted
child workflow links its parent tool call to the actual child sessions, physical
provider sends, source and skill reads, and patch settlement. It names the saved
record and digest when the saved snapshot is available; otherwise, the pair is
null and child coverage stays partial. A redacted field, unsupported tool
argument, unpaired native event, byte bound, or failed companion write cannot
produce a complete trace. A prerequisite refusal may still publish an
unavailable companion, making the absence of a session explicit.

## Local and hosted conversations

| Concern | Local terminal live agent | Hosted live-agent turn |
| --- | --- | --- |
| Model session | Persistent Pi transcript managed by `SessionManager` | A new bounded child execution for each turn |
| Continuity | Resumes by repository path unless `--new` is used | Host supplies a verified bounded prior exchange window |
| Repository view | Current checkout, including uncommitted files | Host-selected frozen revision and scope |
| Mutation | Documentation edits and approved commands by default; `--read-only` disables them | Read-only |
| Durable state | External Pi session file plus saved workflow records | Canonical `LiveAgentSessionStateV1` retained by the host |

[`session-state.ts`](session-state.ts) defines the portable hosted-turn state.
It is not the persistent local Pi transcript. The host passes the prior bounded
window and its binding into each new `live-agent-turn`; the runtime verifies the
project, principal, deployment epoch, thread, revision, scope, composition, tool
policy, shape, and digest before replay. The returned state contains the bounded
delivered exchange for the host to retain. No child Pi session is expected to
linger between hosted turns.

This distinction is load-bearing: never use `SessionManager.continueRecent` as
hosted continuity, and never describe the bounded hosted state as the local
terminal transcript.

## File map

1. [`host.ts`](host.ts) assembles the local session, tool set, workflow callback,
   terminal loop, and readiness output.
2. [`documentation-work-state.ts`](documentation-work-state.ts) tracks the
   host-issued per-turn objective and rechecks it before repository tools run.
3. [`branch-preparation.ts`](branch-preparation.ts) prepares or reuses a unique
   task branch before live-agent file changes when the checkout is on `main`,
   the repository default branch, or detached HEAD.
4. [`capabilities.ts`](capabilities.ts) verifies installed skills, quality data,
   workflows, and implements the skill/workflow tool definitions.
5. [`documentation-work-completion.ts`](documentation-work-completion.ts)
   projects workflow execution and review evidence into a bounded completion
   record with explicit scope and evidence limitations.
6. [`workflow-delivery.ts`](workflow-delivery.ts) guards saved-patch application
   and separately confirmed publication.
7. [`command-tool.ts`](command-tool.ts) and
   [`command-sandbox.ts`](command-sandbox.ts) implement terminal-approved,
   documentation-scoped commands.
8. [`documentation-scope.ts`](documentation-scope.ts) owns the allowed direct
   write-path policy, and
   [`workflow-failure-gate.ts`](workflow-failure-gate.ts) closes direct changes
   for the rest of a turn after a workflow that did not succeed.
9. [`saved-run-tool.ts`](saved-run-tool.ts) and
   [`gitlab-read.ts`](gitlab-read.ts) expose bounded read-only evidence.
10. [`session-state.ts`](session-state.ts) validates and updates portable hosted
   conversation state.
11. [`local-sessions.ts`](local-sessions.ts) lists and deletes local transcripts
   and task-branch state, and applies the opt-in age bound at startup.

Rendering stays in `chat-renderer.ts`, `activity-renderer.ts`, and
`command-approval.ts`; change those only when the terminal presentation or
confirmation interaction changes.

## Common changes

| Task | Source | Focused evidence |
| --- | --- | --- |
| Change local startup, session resume, or tool assembly | [`host.ts`](host.ts) | [`live-agent-cli.test.ts`](../../test/live-agent-cli.test.ts) |
| Change skill or workflow tool behavior | [`capabilities.ts`](capabilities.ts) | [`live-agent-behavior.test.ts`](../../test/live-agent-behavior.test.ts) |
| Change local documentation objective admission | [`documentation-work-state.ts`](documentation-work-state.ts), [`host.ts`](host.ts) | [`live-agent-documentation-work.test.ts`](../../test/live-agent-documentation-work.test.ts) |
| Change direct command authority | [`command-tool.ts`](command-tool.ts), [`documentation-scope.ts`](documentation-scope.ts) | [`live-agent-command.test.ts`](../../test/live-agent-command.test.ts), [`live-agent-authorization.test.ts`](../../test/live-agent-authorization.test.ts) |
| Change direct changes after a failed workflow | [`workflow-failure-gate.ts`](workflow-failure-gate.ts), [`host.ts`](host.ts) | [`live-agent-workflow-failure-gate.test.ts`](../../test/live-agent-workflow-failure-gate.test.ts) |
| Change patch persistence or publication | [`workflow-delivery.ts`](workflow-delivery.ts) | [`live-agent-workflow-delivery.test.ts`](../../test/live-agent-workflow-delivery.test.ts) |
| Change hosted-turn continuity | [`session-state.ts`](session-state.ts) | [`live-agent-turn.test.ts`](../../test/live-agent-turn.test.ts) |
| Change local session listing, deletion, or the age bound | [`local-sessions.ts`](local-sessions.ts), [`../cli/commands/sessions.ts`](../cli/commands/sessions.ts) | [`live-agent-local-sessions.test.ts`](../../test/live-agent-local-sessions.test.ts) |
| Change terminal progress rendering | [`activity-renderer.ts`](activity-renderer.ts) | [`live-agent-activity.test.ts`](../../test/live-agent-activity.test.ts) |

Keep local conversation convenience separate from workflow proof and host
authority. Report which path ran, which repository view it used, whether checks
ran, and whether changes were merely saved, applied, or published.
