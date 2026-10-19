# Agent harness

This directory contains the Pi adapter and its confined model-execution tools.
A harness executes one workflow step with one host-selected model profile. It
turns the step's instruction and admitted evidence into a bounded Pi session,
then returns structured step results to the workflow scheduler.

The [local live agent](../live-agent/README.md) also reuses this directory's
resource loader and confined-tool builders. Its persistent conversation creates
a Pi session directly; ordinary chat does not call `PiHarness.runStep` or inherit
the workflow step lifecycle described here.

Here, a _harness_ is the adapter between portable workflow execution and a
specific agent/model runtime. It does not select a workflow or decide which
step should run. Start with the [runtime source map](../README.md). The
[workflow execution guide](../workflow-execution/README.md) covers scheduling;
the [host-invoker guide](../host-invoker/README.md) covers hosted boundaries.
The [model guide](../model/README.md) covers provider connections, profiles,
and request accounting used by this adapter.

## Read order

1. [`pi.ts`](pi.ts) implements `AgentHarness`: skill inspection, one selected
   step attempt, model calls, lease settlement, result decoding, and evidence.
2. [`pi-session.ts`](pi-session.ts) builds the step prompt and Pi session, and
   loads the permitted product, repository, skill, and quality resources.
3. [`pi-tool-confine.ts`](pi-tool-confine.ts) derives the closed tool grant from
   step mode and kind and enforces the bounded tool-call hook.
4. [`confined-tools.ts`](confined-tools.ts) implements workspace-confined
   filesystem tools and records tool failure categories.
5. [`pi-lease.ts`](pi-lease.ts) and [`pi-offline.ts`](pi-offline.ts) account for
   turns, tool calls, tokens, continuation, and terminal settlement.
6. [`tool-output-cap.ts`](tool-output-cap.ts) bounds model-visible output from
   read, grep, find, and list operations.

`canon-tools.ts`, `observation-tools.ts`, and `study-observer.ts` are narrower
surfaces for canon access, scheduled search observation, and opt-in study data.
Read them only when changing those behaviors.

## Inputs and outputs

`PiHarness.runStep` receives a `HarnessStepInput` from `WorkflowRunner`. The
input identifies the workflow and selected step, repository path, instruction,
context and search evidence, and any bound documentation plan. The plan supplies
the allowed write paths where applicable. The harness creates the execution
lease that tracks the attempt's remaining budget. The hosted construction uses
a bound model execution profile, a provider connection factory, a credential
capability, and skill-crate configuration; selected skill bytes are verified
before use.

The result is a `HarnessStepResult`: a bounded summary plus model and skill
identity, token usage, tool activity and failure categories, terminal lease
evidence, and any step-specific structured results or artifact references.
The scheduler validates and aggregates those fields into the run record.

## Session and tool boundaries

For a workflow step, `createDocsFabResourceLoader` supplies Pi with product
instructions and applicable repository instructions, named by their
repository-relative path. Quality evaluator contracts are loaded from locked,
digest-checked files when that step requires them. These resources shape one
admitted step; they do not grant workflow, write, tracker, publication, or
host authority.

A workflow or delegated step receives the root instruction file (`AGENTS.md`
or `CLAUDE.md`) verbatim between two host notes. They frame the file as the
repository's content and style conventions, not messages to the model: the
step has no conversation and no command tool, and running the repository's
checks is DocsFab's job. For a write step of the `write-documentation` skill,
which a lint step follows, the closing note also names the checks the file
requires before a change is proposed, from the parse the required-check gate
uses. Only the planned writer, `write-documentation`, the one step the
runtime stops for the operator, is told to change nothing and reply with the
instruction and one question when it needs the operator. A live-agent
conversation, which has an operator to address, receives the file unframed.

The model never receives a host absolute path. Pi's session working directory
is the virtual `/workspace`, not the checkout, and a persisted live-agent
session uses a per-repository `/workspace/<digest>`. Pi does not load or list
the step's skill from disk, because its listing names a skill by absolute
location.

The step prompt begins with `/skill:<name> `. Before the prompt reaches Pi, the
harness replaces that command with a `<skill name=… location=…>` block built
from the skill bytes it verified against the governed lock, then a blank line
and the host step text. The block names the skill only by its virtual root,
`.docsfab-governed-assets/skills/<name>/SKILL.md`, and says that references are
relative to that root. The model therefore receives its skill instructions in
the first user message and does not have to read `SKILL.md` itself. Before the
first provider request leaves the host, the harness checks that this message
begins with that block. A missing or different block stops the step as a
non-retryable `invalid-request` named `skill-expansion-missing`, with no
provider traffic.

Tool grants come from runtime policy. Read-only and evaluate steps receive the
confined read tools; a write step can also receive `edit` and `write` when the
host request and exact allowed paths authorize them. Declared observation search
can add its dedicated tool. All filesystem paths remain within the selected
workspace, and tool output and call counts remain bounded.

The verified skill and quality directories are mounted read-only under
`.docsfab-governed-assets/`, which the confined read tools serve. Every
absolute path, and every write to a governed or absolute path, is denied.
A source search payload passes through the egress projection before the
model sees it, so a path under the run's checkout, HOME, or the tmpdir reads
as a repository-relative path, `~`, or `$TMPDIR`.

A refused call is recorded as a closed tool failure category and does not by
itself end the step. On a write step with a bound documentation plan, only a
refused `edit` or `write` (reported to the scheduler as
`mutationBoundaryDenials`) stops the step as `needs-input` for a new plan; the
step loop records that stop as the coded step field `planScopeStop`
(`workflow-contracts/plan-scope-stop.ts`), which the authoring outcome
projector seals as a governed-input outcome. A refused read changes nothing, so
it stays in the step's tool evidence without changing the outcome.

The harness reports the instruction files it supplied as
`repositoryInstructions`. When the planned writer held one and completed no
`edit` or `write` call, the step loop stops it as `needs-input` with its reply
as the operator's question, and records the coded step field
`writerNoChangeStop` (`workflow-contracts/writer-no-change-stop.ts`), which the
authoring outcome projector seals the same way.

A call whose arguments do not match the tool's parameters is
`malformed-arguments`, and its refusal names the tool's own parameter shape so
the model can resend it. It is not a mutation-boundary refusal, but only when
the path it names is a string the confinement admits for that tool; a missing,
non-string, or refused path stays `denied-path`. When a later call to the
same tool in the attempt succeeds, the model has corrected the call, and it is
recorded as `malformed-arguments-corrected`, which is not material to a `ready`
or `not-ready` outcome, or to the audit outcome.

A call whose target does not match what it asked for is `recoverable-miss`: an
edit whose `oldText` is absent, ambiguous, empty, overlapping, or unchanged, an
edit of a missing file, a read past the end of a file, or a directory where a
file was expected or the reverse. Pi refuses each before anything changes. The
model gets a content-free sentence naming the mismatch, not Pi's message, which
can name a host path. A Pi message the harness does not recognize stays
`tool-defect`. A `recoverable-miss` stays material to a `ready` outcome; a
`not-ready` outcome records it as the `tool-misses-recorded` limitation.

A `grep` call ripgrep refuses is classified from the stderr text Pi rejects
with (`classifyGrepFailure`). A regular expression ripgrep cannot parse, a line
break in the pattern, or a glob ripgrep cannot parse is `unsupported-pattern`.
An unreadable file or directory under the searched path, or a host without
ripgrep, stays `tool-defect`. Each gets a content-free sentence that names the
fix (`GREP_FAILURE_MESSAGES`). Pi returns ripgrep's exit 1, no match, as the
result "No matches found", so it is never a failed call.

The confinement judges the
path in the form Pi's file tools normalize it to: Unicode spaces become spaces,
one leading `@` is dropped, and a `~` or `file://` form is denied. When that
judged form differs from the path the model sent, Pi is handed `./<judged
form>`, which Pi's normalization leaves unchanged, so Pi opens exactly the path
that was judged. A path under the session's advertised working directory
(`/workspace`, `VIRTUAL_WORKSPACE_CWD`) names the workspace and takes the same
confinement checks as the relative path; every other absolute path is denied.

Under `source-coordinates` rendering, the tool set also keeps a read ledger: the
lines each `read` showed the model, counted only where a `[source-line N]`
prefix starts a whole line that matches the file. Reads of a file stop counting
once an edit or write of it is about to change its bytes. Marks and reads key
the file itself (its canonical path and its device and inode), so a case
variant of the path cannot escape the mark, and a read through an alias never
counts. A hard-linked file cannot be marked at all, because `edit` and `write`
refuse any file with more than one link. The harness passes the ledger to the step as
`observedSourceLines`, host-internal and never persisted. Source readiness and
repository bootstrap cite by path and line range, and the host mints the quote
only from lines in that ledger (`src/repository/source-citation.ts`). The same
rendering refuses `edit` and `write` text that starts a line with a coordinate
prefix.

The execution lease limits cumulative turns, tool calls, and token use. The
harness can continue the same attempt within that lease or request a final
tool-free summary at the ceiling. Cancellation, local policy stops, provider
failures, invalid structured responses, and unsettled tool batches return or
raise explicit terminal evidence instead of disappearing into a successful
summary.

Provider-owned context admission also applies to workflow leases. For an
unattested model, the lease uses its existing cumulative input budget for
context accounting instead of imposing the placeholder model window. Token,
output, turn, tool, and elapsed-time budgets still apply. Attested host-window
profiles continue to use their post-reserve context allowance.

Response contracts follow the scheduled phase. In particular, an update
source-inventory step uses the source-obligation ledger contract even though
it shares the technical-verification skill with a later editorial assessment.
The later assessment retains its independent editorial envelope validation.

Credentials are host-held inputs used to create the provider connection. They
must not enter prompts, model output, tool output, run records, study events, or
artifact payloads. Response and persisted evidence pass credential isolation
and redaction checks.

## Common changes

| Task                                          | Source                                                                               | Focused evidence                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Change Pi step execution or result decoding   | [`pi.ts`](pi.ts)                                                                     | [`pi-harness.test.ts`](../../test/pi-harness.test.ts)                 |
| Change prompt, resources, or session creation | [`pi-session.ts`](pi-session.ts)                                                     | [`pi-harness-session.test.ts`](../../test/pi-harness-session.test.ts) |
| Change tool grants or workspace confinement   | [`pi-tool-confine.ts`](pi-tool-confine.ts), [`confined-tools.ts`](confined-tools.ts) | [`pi-harness.test.ts`](../../test/pi-harness.test.ts)                 |
| Change lease or offline behavior              | [`pi-lease.ts`](pi-lease.ts), [`pi-offline.ts`](pi-offline.ts)                       | [`pi-offline.test.ts`](../../test/pi-offline.test.ts)                 |
| Change model-visible output caps              | [`tool-output-cap.ts`](tool-output-cap.ts)                                           | [`tool-output-cap.test.ts`](../../test/tool-output-cap.test.ts)       |

Keep Pi-specific session mechanics here. Portable workflow definitions,
sequencing, records, and authority decisions belong to their owning layers.
