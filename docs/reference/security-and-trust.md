---
title: DocsFab Security Reference
description: Look up DocsFab command isolation, data retention, proxy, credential, refusal, and evidence-projection contracts.
status: draft
content.type: reference
---

Use this reference for exact controls, storage locations, error codes, and
platform-specific limits. For the trust model and its reader-facing
consequences, start with [Security and Trust](../about/security.md).

Security boundaries control which files, tools, credentials, and delivery
actions a model can access in [DocsFab](../about/index.md). Repositories, model output,
provider responses, and command output supply data; they do not grant
authority.

Use these boundaries to understand what a local session can change and which
artifacts you can share. The runtime controls model messages, tools, provider
adapters, retained evidence, and host-only delivery. Organizational CI remains
responsible for enforcing secrets committed to repository history.

<Warning title="Current versus released">
This page summarizes the current local runtime. It is not a released
multi-tenant security model. The mechanically checked threat-model JSON
lives under `packages/runtime/security/` (`threat-model.v1.json` and
`threat-model-reviews.v1.json`).
</Warning>

## Boundaries at a Glance

The following table summarizes each runtime boundary and its control.

| Boundary | Control |
| --- | --- |
| Repository to workspace | Immutable, tracked-only export omits `.git`, ignored and untracked files, and common credential paths. |
| Workspace to model | Fixed workflow tools and revision-bound context limit what the model can observe and do. |
| Live-agent to checkout | File tools can change documentation paths in the current checkout. Approved host commands use a filesystem sandbox that also hides DocsFab's own credential files, but they share the host network. |
| Host credentials to providers | Fixed-purpose adapters retain credentials outside prompts and durable evidence. A model key is released only for the configured endpoint and read back only for a request to its origin. |
| Patch to GitLab | A separate host-only delivery phase in `packages/host` requires exact-plan authorization and isolated validation. The mailbox talks on an existing merge request; opening a new draft MR is a later publisher mutation. |
| Skills to job | The catalog lock and quality pack bind hashed bytes; files on disk do not activate a workflow. |

For the details that affect your session, continue with
[Trust Principles](#trust-principles),
[Data Storage, Retention, and Requests](#data-storage-retention-and-requests),
or [Credential-Like Content](#credential-like-content).

## Trust Principles

The following principles apply across local sessions and named workflows.
Details for approved host commands follow in their own subsections.

### Authority and Session Permissions

The following rules govern tools and authorization in a local conversation.

- The local `live-agent` enables documentation-scoped edits by default. Use
  `--read-only` to remove edit, write, and host-command tools. Every host command
  still requires terminal approval. Bounded workflows retain their own write
  and delivery authorization checks.
- Host credentials never enter model prompts, run records, patches, or
  repository files. DocsFab enforces this by exact match against its own
  configured credentials. Text that only looks like a credential is a finding,
  not a refusal. Refer to [Credential-Like Content](#credential-like-content).
- The model has no unrestricted shell, network, Git, GitLab CLI, or
  credential capability. After terminal approval, a live-agent host command
  can use the host network and the invoking user's existing Git, `gh`, or
  `glab` authentication. It cannot read DocsFab's own credential files. For
  details, refer to
  [What an Approved Command Can Read](../workflows/edit-in-live-agent.md#what-an-approved-command-can-read).
- Raw records and patches are private operator artifacts; share only
  sanitized projections.
- Delivery rechecks the exact plan and patch immediately before mutation.
- Disk presence of skills, a second knowledge CLI, or a second agent
  preview is not sufficient authority to run a DocsFab job.
- Direct live-agent work uses interactive-operation evidence. It does not
  invent a named-workflow run record. A nested workflow child reserves from
  the parent remaining budget. Each physical provider or tool effect settles
  once, not as both parent and child.
- Session lifetime is not grant lifetime. A continued conversation cannot
  revive a revoked or widened grant. A resumed `live-agent` conversation uses
  the current process flags, so earlier edit, write, or command calls in its
  history grant nothing under `--read-only`.
- When documentation-only command isolation is unavailable, no host command
  runs and the checkout does not switch to a task branch. Direct documentation
  edits remain available.

### Command Lifetime

Approved commands have the following process-lifetime boundaries.

- When an approved host command exits, times out, or is cancelled, DocsFab
  stops the processes it left running in the background before it checks the
  result, so they cannot write after that check. On Linux, this includes a
  process that starts its own session. On macOS, DocsFab stops the command's
  process group only. A process that leaves that group on purpose, for example
  through shell job control, a new session, or a detached child process, can
  keep running after the command, and so can one that runs as another user. It
  can still write documentation paths and Git metadata after DocsFab checks the
  result. If a process in the group cannot be stopped within
  `liveAgent.commandProcessStopMs`, the command fails with a refusal that names
  that limit, and the process can keep running.

### Linked Worktrees and Git Metadata

Linked worktrees add the following shared-metadata boundaries.

- Linked worktrees share one Git metadata directory. An approved host command
  in a linked worktree can write only what worktrees share: `objects/`,
  `refs/`, the ref reflogs under `logs/refs/`, and its own admin directory
  under `worktrees/`, except the three files described next. It cannot write
  the main checkout's `HEAD`, `index`, `logs/HEAD`, `config`, `hooks/`, or
  `packed-refs`, another worktree's admin directory, or another worktree's
  files.
- Three files in a linked worktree's admin directory change what Git reads
  outside the sandbox, including your next `git status` and DocsFab's own
  delivery. `commondir` names the shared directory, `gitdir` names the
  checkout, and `config.worktree` holds per-worktree configuration when
  `extensions.worktreeConfig` is on. Approved commands cannot change,
  replace, or remove these files, or create `config.worktree`, so
  `git config --worktree` fails from a linked worktree. Run it outside
  `live-agent`.
- DocsFab also records these three files before each approved command and
  compares them after it, before the result returns. If one changed, for
  example through a process outside the sandbox, DocsFab restores it and
  refuses the command with an error that names the file. On Linux, DocsFab
  holds a missing `config.worktree` in place while the command runs with a
  placeholder that contains only a comment, and removes it afterward. A
  placeholder that another session, or an interrupted one, left behind counts
  as no file and is removed after the next command.
- Your next `git status` also runs Git inside every embedded repository (a
  gitlink in the index whose directory holds `.git`), with that repository's
  own configuration. Git that you start inside a documentation directory uses
  the repository it finds there first: a `.git` entry, or a bare repository
  layout (`HEAD` beside `objects` and `refs`, or beside `commondir`). In a
  linked worktree, approved commands cannot write the Git data of existing
  nested repositories, bare repositories, or submodules under documentation
  paths, or the submodule Git directories under `modules/` in the admin
  directory. On macOS, they also cannot create a `.git` entry or a `HEAD`
  file under a documentation path.
- After each approved command in a linked worktree, before the result returns,
  DocsFab removes what the command created toward a repository that Git would
  use: new `.git` entries under documentation paths, in any letter case, the
  new `HEAD` (or, beside an existing `HEAD`, the new entries) of a bare
  repository layout, new submodule Git directories, and new gitlinks in the
  index. It also restores a changed `.gitmodules` entry in the index. It then
  refuses the command with an error that says which kind of entry it removed
  or restored, without the path. It checks the
  index with its own Git, which runs no hooks, `fsmonitor`, or submodule
  recursion, after it removes those entries. Existing nested repositories and
  submodules keep working outside the sandbox. Run Git commands that write
  inside them, such as `git submodule update` or a commit in a nested
  repository, outside `live-agent`.
- When the admin directory no longer sits in `worktrees/` of the directory
  that `commondir` names, for example after a process outside the sandbox
  rewrites `commondir`, later commands in that worktree get no write access to
  Git metadata. Git commands that write objects or refs then fail until
  `commondir` names the original shared directory again.
- Other files in the admin directory stay writable. A command can leave
  in-progress operation state there, such as an interactive rebase todo list
  that runs commands when you continue the rebase. Before you continue an
  operation you did not start, inspect it with `git status`. In a linked
  worktree, `git status` only reads that state: approved commands cannot
  change the configuration it reads or leave an embedded repository for it
  to run Git in. On macOS, a process that left the command's process group
  and is still running can do both.
- DocsFab does not make a shared path writable when it is missing or is a
  symbolic link. If `logs/refs/` is missing and reflogs are enabled, ref
  updates from a linked worktree fail. Update one ref outside `live-agent` to
  recreate the directory.
- Refs stay shared. A command in a linked worktree can still move any ref,
  including the branch another worktree has checked out, which changes the
  commit that worktree's `HEAD` resolves to.
- From a linked worktree, commands that delete refs, such as
  `git branch -D` or `git fetch --prune`, fail because Git rewrites the
  shared `packed-refs`. Commands that record upstream tracking fail or skip
  that step because Git writes the shared `config`:
  `git branch --set-upstream-to` fails, and `git push -u` pushes without
  recording the upstream. Run these commands outside `live-agent`. A commit
  in a linked worktree can print an `Unable to create` error for
  `packed-refs.lock` and still succeed.
- An approved host command in the main checkout can still write the whole Git
  metadata directory, including its configuration, its hooks, and every linked
  worktree's admin directory. The pointer-file and embedded-repository
  protections above apply to linked worktrees only.

## Data Storage, Retention, and Requests

This page describes local live-agent storage and a separately gated private
pilot. DocsFab is not a released multi-tenant service. Storage and retention
depend on the surface you use, and no single deletion action removes every
copy.

### Local CLI Data

The local live agent stores conversation transcripts and state for task
branches on your machine under
`<configuration root>/.docsfab/live-agent/sessions/`.
Transcripts contain your messages, model replies, and tool calls and results.
Tool results can include repository contents or merge request evidence. Task
branch state contains the repository path and branch names. DocsFab uses
`DOCSFAB_CONFIG_ROOT` when set, then `$XDG_CONFIG_HOME/docsfab` when the XDG
value is a normalized absolute path, or `~/.config/docsfab` otherwise.

Use `docsfab config inspect` to locate the directory, `docsfab sessions list`
to review session age and size, and `docsfab doctor` to review aggregate
session storage. [Stored Sessions and Deletion](../manage/live-sessions.md#stored-sessions-and-deletion)
documents how to preview and confirm deletion. Automatic age removal is off
by default. Close running `docsfab live-agent` processes before deleting
sessions because an open process can recreate its transcript.

Workflow run records are separate. A run record contains your request verbatim
and is stored under the configured run-record directory, which defaults to
`<configuration root>/.docsfab/runs`. Workflow artifacts and local patches
use sibling `artifacts` and `patches` directories. Publication uses separate
private roots: by default, sibling `delivery` and `receipts` directories.
Hosts can override the publication roots with `DOCSFAB_DELIVERY_ROOT` and
`DOCSFAB_RECEIPT_ROOT`. The
`docsfab publish --execute` command also accepts `--delivery-root` and
`--receipt-root`. Refer to
[Draft-MR Private Roots and Recovery](../workflows/deliver-draft-mr.md#draft-mr-private-roots-and-recovery)
for those settings. `docsfab sessions delete` does not remove run records or
their output, and this release has no run-record deletion command.
[Stored Sessions and Deletion](../manage/live-sessions.md#saved-run-records)
describes session and run-record separation.

### Private Pilot Data

The private pilot stores Slack message text, live-agent questions and earlier
answers, reconciliation answers and rationales, feedback candidates derived
from answers, and principal and Slack identifiers. The service database is
PostgreSQL, and per-project stores are under
`/var/lib/docsfab/projects` on the pilot host. The pilot owner or a host
operator delegated by that owner can export or erase an individual's pilot
data after verifying the request and identity. There is no self-service
request command or published contact channel. Ask your pilot owner how to
submit a request.

An individual erase does not remove the source Slack or provider data, GitLab
identity records, or recovery copies. A pilot owner must check the deployed
recovery retention mode before giving a removal date. Backup packages and
local staging bundles are eligible for removal after 30 days only when the
expiry mode is deployed and a later backup verifies, publishes its external
copy, and reads it back successfully. The newest verified backup remains.
Failed or local-only backups do not trigger pruning. Recovery Git history,
including historical logical exports, has no expiry date. Refer to
[Interpret Current Status](status-and-configuration/recovery-and-migration.md#interpret-current-status)
for recovery implementation evidence and the pilot's recovery-drill status.

The pilot's 30-day target for raw Slack text applies only to locations covered
by the deployed redaction job. Some copies are not covered, and backups taken
before redaction can retain that text until they expire. Provider-side
retention and training, source Slack messages, and recovery Git history are
separate boundaries. No provider-side retention claim is made here. Ask the
pilot owner about the deployment's status and request process; do not assume a
universal retention period or that one erase removes every copy.

## Outbound Proxy

DocsFab sends model requests, model catalog lookups, and GitLab roadmap reads
through the standard proxy variables. You set them; DocsFab turns on Node's
built-in proxy support itself. No `NODE_OPTIONS` or `NODE_USE_ENV_PROXY`
setting is needed. The following table lists the proxy variables.

| Variable | Use |
| --- | --- |
| `HTTPS_PROXY`, `https_proxy` | Proxy for HTTPS requests. When neither is set, HTTPS requests use the HTTP proxy. |
| `HTTP_PROXY`, `http_proxy` | Proxy for plain-HTTP requests. |
| `NO_PROXY`, `no_proxy` | Hosts that bypass the proxy. |

The following points describe how DocsFab uses these variables:

- **How it is turned on.** When one of the proxy variables is non-empty, each
  `docsfab` command turns on Node's built-in proxy support in its own process
  with `http.setGlobalProxyFromEnv`. Only valid values are passed to Node. The
  runtime does not re-launch Node and does not change the environment that
  commands it starts inherit.
- **Precedence.** When both cases of a name are set, the lower-case one wins,
  and `docsfab doctor` notes that the two differ.
- **`NO_PROXY`.** Entries are separated by commas or whitespace. An entry
  matches its host and every subdomain, a leading `.` or `*.` is ignored, and
  `host:port` matches only that port. The single value `*` bypasses every host.
  There is no CIDR or IP-range matching. Node's own `node:http` client reads the
  list differently, but DocsFab's requests use the `fetch` rule described here.
- **Loopback.** Requests to `localhost`, `127.0.0.0/8`, and `[::1]` never use
  the proxy. They connect only when the name resolves to a loopback address.
- **Not supported.** `ALL_PROXY`, PAC files, and SOCKS proxies. `ALL_PROXY` is
  ignored, and `docsfab doctor` says so.
- **Opting out.** Unset the proxy variables, or list the host in `NO_PROXY`.
  `NODE_USE_ENV_PROXY=0` does not opt out.
- **Library import.** Importing `docsfab/roadmap` does not change the
  embedding process. With a proxy variable set, its GitLab reads refuse with
  `outbound-proxy-not-enabled` unless that process started Node with
  `--use-env-proxy` or with `NODE_USE_ENV_PROXY=1`.

### Credentials

A proxy URL can carry a user name and password, for example
`http://user:password@proxy.example.com:3128`. Node sends them to the proxy as
`Proxy-Authorization`. DocsFab never prints a proxy value. Doctor shows only
`scheme://host:port`, and refusals name the variable, not its value.

Percent-encode reserved characters in the user name and password, and write a
literal `%` as `%25`. A `%` that does not start a valid escape, such as
`pa%ss`, is refused with `outbound-proxy-invalid`.

### Doctor Output

`docsfab doctor` prints an `Outbound proxy` section without contacting the
proxy or any other host. The section shows the following:

- the effective proxy for `http` and `https` and the variable that supplies it
- the `NO_PROXY` value
- whether built-in proxy support is on, available, or unsupported by the
  installed Node.js release

An unusable setting fails the `configuration` check with
`outbound-proxy-invalid`.

### Refusal Codes

DocsFab refuses a request before it sends anything when a proxy setting would
decide where the request goes but cannot be used. Loopback and `NO_PROXY`
targets are never refused. The following table lists the refusal codes.

| Code | Cause | Next action |
| --- | --- | --- |
| `outbound-proxy-invalid` | The proxy variable for the request's scheme is not an `http://` or `https://` URL with a host. Examples are `socks5://host:1080`, a value with no scheme such as `proxy.example.com:3128`, a value with whitespace or a line break inside it, a user name or password with an invalid percent escape, or an empty lower-case name beside a set upper-case one. Surrounding whitespace is allowed. | Fix or unset the named variable, or add the host to `NO_PROXY`. Run `docsfab doctor`. |
| `outbound-proxy-not-enabled` | A proxy applies, but proxy support is off in this process: the Node.js release lacks it, or the code runs outside a `docsfab` command. | Run through `docsfab` on a supported Node.js release, or start Node with `--use-env-proxy`. Otherwise, unset the variable or add the host to `NO_PROXY`. |

An invalid `HTTP_PROXY` does not stop HTTPS requests when a valid HTTPS proxy is
set, but doctor still fails the line.

### Proxy Failures

A request that goes through a valid proxy can still fail at the proxy. DocsFab
names three such failures with a code. Nothing reaches the target host in any
of them. The following table lists these codes.

| Code | Cause | Next action |
| --- | --- | --- |
| `outbound-proxy-unreachable` | The proxy refused the TCP connection (`ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, or `ETIMEDOUT`), or the proxy host name did not resolve. | Start or fix the proxy, or correct the host and port in `HTTPS_PROXY` or `HTTP_PROXY`. Otherwise, add the target host to `NO_PROXY`. Run `docsfab doctor --live`. |
| `outbound-proxy-denied` | The proxy answered the HTTPS tunnel request (`CONNECT`) with HTTP 403. | Ask the proxy administrator to allow the target host, use a proxy that allows it, or add the host to `NO_PROXY`. |
| `outbound-proxy-auth-required` | The proxy answered the tunnel request with HTTP 407. | Add the proxy user name and password to the proxy URL, or use a proxy that needs no authentication. |

The following rules apply to these codes:

- **Where they appear.** Catalog discovery, Inference Hub metadata reads,
  `docsfab doctor --live`, `docsfab profile probe --live`, and GitLab roadmap
  reads report them. A refusal message names the proxy variable and the
  target host, never the proxy URL, its credential, or any text the proxy
  sent.
- **Commands that fail with the code.** These commands fail with the
  refusal's code and next action instead of reporting an unavailable or
  unreachable endpoint:
  - `docsfab profile inspect --catalog` and `docsfab doctor --catalog` fail
    when a proxy refuses the inference catalog request or the Inference Hub
    metadata request, even when the other catalog answered.
  - `docsfab profile probe --live` fails instead of reporting the
    `unreachable` verdict, even when another sample answered.
  - `docsfab doctor --live` fails even when a later probe request succeeded.
- **Workflow steps.** A workflow step fails with the refusal's code as its
  failure code when the proxy refuses its model request with
  `outbound-proxy-denied` or `outbound-proxy-auth-required`, or when the
  proxy setting is refused with `outbound-proxy-invalid` or
  `outbound-proxy-not-enabled`. `docsfab runs show` prints the code on the
  `Failure class` line. Its NEXT block names `docsfab doctor` for a refused
  setting, or `docsfab doctor --live` for a 403 or 407 reply, with the code's
  next action as the reason. A workflow step that fails with
  `outbound-proxy-unreachable` still ends as a retryable provider network
  failure after the in-turn backoff.
- **Retry.** `outbound-proxy-denied` and `outbound-proxy-auth-required` are
  not retried within a model turn, because the proxy answers the same way
  again, and a workflow step ends after that one attempt without a step
  retry. A step refused with `outbound-proxy-invalid` or
  `outbound-proxy-not-enabled` also ends after one attempt, because the
  setting refuses every request the same way. `outbound-proxy-unreachable`
  is a network fault and keeps the normal retry. With the default in-turn backoff (`providerAttempt.maxAttemptsPerTurn`,
  `providerAttempt.baseDelayMs`, and `providerAttempt.maxDelayMs`), a model
  turn spends about 51 seconds of backoff before it ends.
- **Uncoded failures.** Every other tunnel reply, for example HTTP 502 or 504,
  keeps the existing retryable network behavior. Two stalls also stay plain
  network failures:
  - A proxy that never accepts the TCP connection on its only address, or on
    the last address of a proxy host name with several addresses, ends on
    Node's 10-second connect timeout. A model server that stalls behind a
    healthy tunnel ends on the same timeout with the same error, so DocsFab
    cannot tell them apart. The proxy's `ETIMEDOUT` is coded only when it
    arrives first: when an earlier address of the proxy host name times out
    and a later one fails, or when the operating system abandons the
    connection before the 10 seconds pass.
  - A proxy that accepts the connection but never answers the tunnel request
    ends on Node's 300-second response-header timeout, unless a shorter bound
    applies first, for example `endpointProbe.requestTimeoutMs` for the doctor
    probe. When that shorter bound or a cancellation ends the request, Node
    keeps its connection to the proxy open until the proxy closes it or the
    300-second timeout ends it.
- **HTTPS only for 403 and 407.** A plain-HTTP request through a proxy gets
  the proxy's reply as an ordinary HTTP response, so DocsFab cannot tell it
  from the target's reply.

Node reports a non-200 tunnel reply only in the text of a fixed error
message, `Proxy response (403) !== 200 when HTTP Tunneling`. DocsFab otherwise
recognizes failures by error type, never by wording. This one match is the
exception. It reads only that exact undici sentence about the proxy's own
`CONNECT` reply, never a response body or text from the model provider.

<Note title="Behavior change">
Before proxy support, DocsFab ignored the proxy variables and connected
directly. Settings that were silently ignored now refuse with
`outbound-proxy-invalid`: stale or unparsable values, values with no scheme,
SOCKS URLs, a user name or password with an invalid percent escape, and an
empty lower-case name that hides an upper-case one.
</Note>

## Where a Model Key Is Sent

DocsFab sends a model key only to an endpoint you configured: your
configuration file, your environment, a command-line flag, or the default
endpoint of the composition you selected. It never takes the endpoint from
repository files, task or chat text, model output, or merge request or issue
text.

Every request that carries a model key goes through one release step: model
connections, the `docsfab doctor --live` and `docsfab profile probe --live`
probes, and the catalog lookups of `docsfab profile inspect --catalog`. The
key is released for the configured endpoint, and DocsFab reads it back only
for a request to that endpoint's origin. A request to any other origin stops
before it is sent.

If an endpoint comes from a source that is not your configuration, DocsFab
stops with `credential-endpoint-untrusted` before it sends anything. Set the
endpoint in your own configuration with `docsfab setup` or `MODEL_BASE_URL`,
then run the same command again.

On the private pilot, a hosted composition names its route and its credential
family together. A composition whose family does not match its route stops
with `credential-route-mismatch`, so a key installed for one provider family
never reaches another family's route.

### Check Scripts

`docsfab do --delegate --check <npm-script>` runs `npm run <npm-script>` in
your repository. The script does not receive DocsFab's keys and tokens
through its environment. DocsFab removes the following variables:

- every variable whose name marks a credential or a credential file, such as
  `MODEL_API_KEY`, `GITLAB_TOKEN`, `GLAB_TOKEN`, and
  `DOCSFAB_SLACK_BOT_TOKEN`;
- `GLAB_CONFIG_DIR` and `CREDENTIALS_DIRECTORY`;
- the variable your configuration names as holding the model or judge key,
  through a profile's `credentialEnv`, `MODEL_CREDENTIAL_ENV`, or
  `JUDGE_CREDENTIAL_ENV`, whatever that variable is called;
- any variable whose value holds one of DocsFab's own configured credentials,
  as [DocsFab's Own Credentials](#docsfabs-own-credentials) defines them,
  including the credential in a proxy URL.

The script keeps the rest of the environment, such as `PATH` and `HOME`, and
runs with `CI=1`. It still runs as your user, so it can read any file your
user can read, such as your `glab` configuration.

## Credential-Like Content

Any string can be a password, so no pattern can tell whether text in a
repository is a real credential. Policing the credentials committed to a
repository is the job of its maintainers and their CI secret scanning.
DocsFab therefore treats the two kinds of credential differently.

### Text That Looks Like a Credential

When DocsFab's credential detector matches repository content or your request
text, DocsFab records a `credential-like-content` finding and continues. A
local run reads the content, sends it to the model where the run needs it,
and edits a page that holds it. Its model request, response, tool, and record
screens refuse only DocsFab's own credentials, and so does the screen on the
patch that publication pushes.

The following screens still refuse a detector match, and are moving to the same rule:

- on the hosted service: review-scope paths, which the host and its worker
  refuse alike until both change together, and other host screens that #1937
  tracks, such as reconciliation intake and Slack job results;
- the host's GitLab publishers, its record custody, and its product-feedback
  intake;
- the task of an autonomous cycle, and the repository identity that
  `docsfab init` reads.

The merge-request metadata of local publication, the hosted wire between the
host and its worker, the hosted live-agent turn, Slack posts, questions, and
answers, and roadmap planning, including the `docsfab auto` planner, flag a
detector match and continue instead. Refer to
[Screens That Flag Instead of Refusing](#screens-that-flag-instead-of-refusing).

A finding names a location and a rule, never the text. The following items
describe each part:

- The location is a repository path and the first line where the rule
  matches, such as `docs/setup.md:12`, or `request:instruction` for your
  request text. A control, format, or line or paragraph separator character
  in a path, such as a tab or a bidi override, is written as `\uXXXX`. A
  location longer than 1,024 characters
  (`runs.credentialFindingLocationChars`) is cut at a marker that carries a
  digest of the whole location, so two long paths stay distinct.
- The rule is a scanner rule ID, such as `credential.assigned-secret` or
  `credential.gitlab-token`.

You find the findings in the following three places:

- the run record's `credentialFindings`;
- the run summary, which counts them under LIMITATIONS and names the command
  that lists them;
- `docsfab runs show <run-id>`, which lists every finding.

### DocsFab's Own Credentials

DocsFab's own credentials must never reach a model request, a run record, a
log, or published output. These include the model key, SCM tokens, and the
other secrets DocsFab is configured with. DocsFab enforces this by exact
match, not by shape. It knows its credentials from the following sources:

- environment variables whose names mark a credential, such as `*_API_KEY`,
  `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, and `*_WEBHOOK_URL`. These include
  every model key that DocsFab reads, `GITLAB_TOKEN`, `GLAB_TOKEN`,
  `CI_JOB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, and `DOCSFAB_SLACK_WEBHOOK_URL`;
- the credential in `HTTPS_PROXY` and `HTTP_PROXY`, in either case, but not
  the proxy address;
- files named by variables such as `*_TOKEN_FILE` and `*_CREDENTIAL_FILE`,
  including the hosted model credential map, and every file in systemd's
  `$CREDENTIALS_DIRECTORY`;
- on the host service, the credentials it reads from files that its project
  registry names: the Slack tokens, the GitLab review-note and
  product-feedback credentials, the forge read credential, the webhook
  secret, and the service binding key, which both the ingress and the
  dispatcher read;
- the model key in use, including the hosted model key that each run
  receives.

In a proxy URL, the password is the credential. When the URL has no password,
or a password too short or too repetitive to compare, such as `x`, the user
name is the credential instead, as in a token-only proxy URL. A longer
placeholder password, such as `x-oauth-basic` or a parameter string that some
proxy services take, is compared in place of the user name. Set such a token
in a credential variable as well, such as `PROXY_TOKEN`, so that it matches.

A match covers the value itself and its URL-encoded, JSON-escaped, and base64
forms. It also covers any piece of at least 16 characters
(`secrets.configuredCredentialFragmentChars`), so a truncated echo still
matches. To keep pieces from matching structure that other text shares,
pieces come only from the following secret material:

- a value that contains whitespace, such as a PEM block, gives no pieces;
- a URL gives none, but its password, or its user name when it has no
  password, is a value of its own with its own pieces, and so is the last path
  segment of a webhook URL, which is its secret;
- a JWT gives pieces of its signature only.

By default, the following configured values are not compared:

- a value shorter than 12 characters (`secrets.configuredCredentialMinChars`);
- a value, or a piece, with fewer than 5 distinct characters
  (`secrets.configuredCredentialMinDistinctChars`), such as a mask like
  `xxxxxxxxxxxx` left in a variable.

`docsfab doctor` names each configured source with a value that these rules
leave out. To change them, refer to
[Configured-Credential Matching](status-and-configuration/credential-matching-limits.md#configured-credential-matching).

When a configured credential appears where DocsFab would pass it on, DocsFab
refuses it with a code that names where the credential is configured, never
its value. The following entries name the code for each place:

- **The run request:** `docsfab run` stops with
  `credential-isolation-boundary` before it saves any record when the
  instruction, its context, or the task holds one.
- **A `--source` file, an operator input, or the first pass of `docsfab do`:**
  the run stops with `credential-material`.
- **A model request or a model reply:** the step stops with
  `credential-isolation-boundary`.
- **A tool result, such as a file a tool reads:** the tool fails without
  returning the content, with `credential-isolation-boundary`, and the run
  continues.
- **Local publication:** a patch that holds one stops publication with
  `patch-credential-material`. A changed file that holds one stops the
  delivery with `delivery-credential-material`, including a binary or UTF-16
  file whose content the patch text does not show. Hosted publication does not
  screen changed files yet. A commit message or merge-request text that holds
  one is refused with `credential-material`.

Remove the value from the content and rotate it.

### Redaction

Logs, error text, operator output, and the excerpt a run record keeps of a
rejected model reply still redact anything credential-shaped, as well as any
configured credential. Over-redaction costs nothing, so redaction keeps the
strict rule described below.

### What the Detector Flags

The detector decides which content gets a finding. For an assignment such as
`password: ...` or `api_key=...`, the strict rule counts any assigned value
that meets all of the following conditions:

- it is at least 12 characters long;
- it is not a `${...}` reference;
- it is not one of a few fixed placeholders, such as `changeme`.

Redaction uses the strict rule. The detector starts from the strict rule but
does not count a value that only names or builds a credential. It ignores
Markdown backticks around the value. The following values do not count:

- **References and names:**
  - `$NAME`, `$(NAME)`, and `{{ ... }}` templates;
  - an upper-case name joined by underscores, such as `NVIDIA_API_KEY`, alone
    or after a scheme, such as `openshell:resolve:env:GITHUB_TOKEN`;
  - a file path of lower-case names, such as `/var/run/secrets/otel/token`;
  - a `:secret:` segment of a colon-joined name, such as an AWS ARN.
- **Code:**
  - a type annotation such as `Optional[str]`, or a type name ending in `Str`,
    `String`, `Type`, `Secret`, `Token`, `Key`, `Config`, `Credential`,
    `Credentials`, `Field`, `Model`, or `Ref`, such as `SerializableSecretStr`;
  - a composite literal such as `&corev1.SecretVolumeSource{`;
  - a qualified call such as `os.environ.get(` or `std::env::var(`;
  - a dotted path whose last name is a credential field, such as
    `opts.Password`.
- **YAML structure:** a key whose value is a nested mapping on the next line.
- **Syntactic placeholders:**
  - an angle-bracket name, such as `<your-password>`;
  - a mask of `x`, `*`, `#`, `.`, `_`, or `-`, such as `xxxxxxxxxxxx`.

An exemption covers only the reference or the code shape. A quoted literal
beside it still counts, in the rest of the line or up to the brackets that
close it, as in the following examples:

- `os.environ.get("NAME", "<literal>")`;
- `process.env.NAME || "<literal>"`;
- `SecretStr("<literal>")`;
- `Field(default="<literal>")` across lines;
- `&Secret{Value: "<literal>"}`;
- `Optional[str] = "<literal>"`.

The following values also still count:

- realistic key-like values;
- bearer tokens;
- long random strings, with or without quotes;
- upper-case segments with digits, such as `X7K2_M9P3_Q8R5`;
- a pass phrase of plain words, such as `correct-horse-battery-staple`.

Values spelled only with placeholder words also count. Examples are
`mysecretpassword`, `changeme1234`, `your-openai-api-key`,
`encrypted_token_data`, and base64 of such a value. A finding never stops a
run, so the rule that would exempt them stays off.

Detection of vendor token formats, such as GitLab and GitHub tokens, does not
depend on these rules.

## Screens That Flag Instead of Refusing

DocsFab screens text in other places too: text passed between the host and a
hosted run, text sent to Slack, a merge request it opens, and its roadmap
records. Under the owner decision on #1807, any string can be a password, so
these screens no longer refuse text for looking like a credential. Each one
does the following two things:

- **Refuses DocsFab's own configured credentials.** A screen refuses a model
  key, an SCM token, or another credential DocsFab is configured with, matched
  exactly, with the same error code it used before. Examples are
  `credential-material` and `turn-answer-credential-material`. Refusal messages
  never contain the value.
- **Flags everything else and continues.** Text that only looks like a
  credential continues. The screen records a `credential-like-content` finding
  that names where the text is and which rule matched, never the text itself.

The screens are the following:

- **Hosted runs.** The host job spine screens a live-agent question. The host
  dispatcher and the hosted worker screen the request, its frozen inputs and
  review event, reader tasks, capsule evidence, the worker's output, run
  records, patches, and semantic comparison data. A candidate review screens
  the source changes it reads, both their paths and their contents, at
  `candidate-review:source-manifest`, `candidate-review:source-base`, and
  `candidate-review:source-head`. Review-scope paths are the exception: the
  host and the worker still refuse a path that looks like it carries a
  credential, with `credential-material`, until both sides change together.
- **Hosted live-agent answers.** The worker screens an answer before it
  records the turn.
- **Slack.** The post screen applies to every message and edit. The live-agent
  question check, the answer check, the progress line, and the incoming
  webhook use the same rule.
- **Draft merge requests.** These include the publication plan and its
  receipts, the merge request title and description, the commit message, and
  the Git and GitLab text DocsFab reads back.
- **Roadmap planning.** These include the `docsfab auto` planner, planning
  artifacts and drafts, managed issues and their labels, roadmap identifiers,
  and host operation requests.

A finding goes to one of the following three places:

- **The run record.** A hosted live-agent answer adds its findings to the run
  record's `credentialFindings` at location `live-agent:answer`.
- **The draft merge request.** The description gets a `## Notes` section after
  `## Result` when there is at least one finding. The section lists the run
  record's findings with what the description builder flags in the fields it
  publishes: `publication:workflowOutcome`, `publication:changedPaths`,
  `publication:instruction`, and `publication:requiredCheckLimitations`.
  Findings are sorted by location, then rule. The section also lists any
  [required check that could not run](../workflows/update-documentation-beside-a-change.md#when-a-required-check-cannot-run),
  before the findings, and the findings use the room those lines leave. When
  the full list would push the description past its size bound, the section
  names as many findings as fit and counts the rest. When not even one fits,
  the findings are a single line that counts every one, and standard error
  names them all. When even that line does not fit, the description names no
  finding, and only standard error names the findings.

  A location is never shown when it contains any of these:

  - a space or any other separator character;
  - a control character, such as a tab or a line break;
  - a format character, such as a bidi control;
  - a backtick, `<`, or `>`.

  A location that starts with `/` or has a `..` segment is not shown either.
  Such a file name could end the code formatting, start a GitLab quick
  action, or put a closing keyword such as `Closes` beside an issue
  reference, which GitLab reads even inside code. The section counts those
  findings on a line of their own, and the run record lists them.

  A required-check line is never shown when it holds an issue reference: `#`
  followed by a digit, an issue or work item URL, or a key such as
  `KEY-123`. Its command and instruction file come from the repository, so
  the reference could sit beside a closing keyword such as `Closes`. The
  section counts those lines on a line of their own, with the lines that hold
  a configured credential, a host path, or a line break, and
  `docsfab runs show <run-id>` lists them.
- **Standard error.** Any other screen writes one line, such as
  `docsfab: credential-like-content flagged for maintainers; DocsFab did not
  remove it: slack-post (credential.gitlab-token)`. A location that cannot be
  shown as written appears as a JSON string with every character outside
  printable ASCII escaped, so it cannot start a new line. The draft merge
  request also writes this line when its Notes section cannot list any
  finding. On a host, standard error goes to the service log.

A rule is a repository scanner rule, such as `credential.assigned-secret` or
`credential.gitlab-token`, or one of the following four rules.

| Rule | Text it flags |
| --- | --- |
| `credential.bearer-value` | A bearer value, such as `Bearer` followed by a long token. |
| `credential.url-userinfo` | A URL that carries a user name and password. |
| `credential.authorization-header` | Text shaped like an HTTP `Authorization:` header. |
| `credential.private-token-header` | The GitLab `PRIVATE-TOKEN` header name, in any case or separator. |

Redaction is unchanged: logs, records, and error text still remove anything
credential-shaped. Refer to [Redaction](#redaction).

## Related Documentation

<CardGroup cols={2}>
  <Card title="DocsFab Architecture" href="/reference/architecture">
    Refer to [DocsFab Architecture](architecture.md).
  </Card>
  <Card
    title="A Result Grants No Authority"
    href="/about/core-concepts/documentation-jobs"
  >
    Refer to
    [A Result Grants No Authority](../about/core-concepts/documentation-jobs.md#a-result-grants-no-authority).
  </Card>
  <Card
    title="Delivering Results"
    href="/about/core-concepts/documentation-jobs"
  >
    Refer to
    [Delivering Results](../about/core-concepts/documentation-jobs.md#delivering-results).
  </Card>
  <Card
    title="DocsFab Implementation Status"
    href="/reference/status-and-configuration/implementation-status"
  >
    Refer to
    [DocsFab Implementation Status](status-and-configuration/implementation-status.md).
  </Card>
  <Card
    title="Troubleshooting DocsFab"
    href="/troubleshooting"
  >
    Refer to
    [Troubleshooting DocsFab](../troubleshooting.md).
  </Card>
</CardGroup>
