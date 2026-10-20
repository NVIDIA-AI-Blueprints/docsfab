---
title: GitLab Host Mailbox in DocsFab
description: Look up the current GitLab mailbox contracts and provider-neutral merge-request change-event intake.
status: draft
---

The DocsFab GitLab mailbox is `packages/host` talking on an **existing** merge
request. It is not the path that opens a new draft merge request. For that
split, refer to [Delivering
Results](../../../about/core-concepts/documentation-jobs.md#delivering-results).
For more information, refer to [Delivery Contracts in DocsFab](index.md).

Chat text or merge-request text never grants write, publish, or merge
authority.

## Distinguish the GitLab Paths

| Path | Current role | Included here? |
| --- | --- | --- |
| Outbound note | Project one terminal or needs-decision result onto an existing merge request. | Yes, Phase A. |
| Inbound mention submit | Verify and classify `@docsfab run <workflow>` on an existing merge request. | Yes, Phase B. |
| Inbound merge-request lifecycle | Verify a Merge Request hook and normalize its lifecycle into a provider-neutral change event. | Yes, as repository-tested. Live deployment remains gated. |
| Merge-triggered reconciliation | Resolve a pending forge outbox record's content-addressed payload and run one bounded comparison. | Yes, as repository-tested. A clean result is silent; an eligible conflict can start governed owner adjudication. |
| Slack acknowledgement and queued observation | Acknowledge a durably staged Socket Mode envelope, then asynchronously submit and report the job's current queued state. | No. This is the Slack mailbox adapter, not a GitLab phase. |
| Slack terminal-result projection | Observe a later durable host-job settlement and post one safe result into the request's bound response thread. | Yes, as repository-tested for `succeeded`, `failed`, and `cancelled`. Live delivery remains subject to deployment acceptance. |
| Hosted GitLab review-summary projection | Verify a succeeded review packet and its retained evidence, then reconcile one bot-owned note on the frozen existing MR. | Yes. The projector binds the verified review packet and retained evidence to a frozen merge-request head. This does not establish webhook intake or universal coverage. |
| Structured adjudication | Ask one policy-selected accountable owner a bounded question and continue from a valid answer in that question thread. | No. This is a governed reconciliation continuation, not ordinary mailbox status. |
| Create or reuse draft merge request | Deliver a successful local patch through a separately authorized host projection. | No. It can follow a write-capable workflow in the same CLI invocation, but it is not a mailbox phase or workflow step. Refer to [Delivering Results](../../../about/core-concepts/documentation-jobs.md#delivering-results). |
| Update existing MR source branch | Apply a validated patch to an existing MR source branch under an explicit standing `Contribute` grant. | No. This is a separate higher-capability delivery action. Refer to [Delivering Results](../../../about/core-concepts/documentation-jobs.md#delivering-results). |
| Fern Review App or publication | Render or publish the documentation site. | No. Refer to [Fern Site Delivery](documentation-delivery.md). |

## Distinguish Channel Responses

An acknowledgement confirms transport receipt. For Slack Socket Mode, it
occurs after durable replay custody and before mapping, submission,
observation, or outbound notification. The later queued-status message is one
observation taken during asynchronous intake. It opens the response thread,
but it does not monitor the job through settlement.

A terminal-result projector is a different component. The Slack projector
discovers a durably settled `succeeded`, `failed`, or `cancelled` host job and
creates one content-safe effect for the request's already-bound project,
epoch, principal, conversation, thread, and workflow. It persists that effect
before posting and records completion only after Slack returns a message ID.
The closed message contains the safe status. A successful result requires its
receipt digest and bounded `cas:` receipt locator. A failed result contains
that exact pair when one exists, or safely reports that no artifact was
produced. Cancellation does not invent a result artifact.

The durable lifecycle moves through `pending`, `claimed`, and `attempting`
before Slack I/O. Delivery requires an owner, expiration, and monotonic fence.
Invalid routing or receipt evidence is durably `suppressed` so later effects
continue. An uncertain or expired `attempting` record becomes `ambiguous` and
is never automatically posted again.

The deterministic effect key becomes Slack `client_msg_id` during the one
bounded delivery attempt. It supplies an identity for operator or provider
reconciliation, but it does not claim that Slack retains that idempotency
identity indefinitely. The durable host effect remains the replay record.
Paused `needs-input` and
`needs-human-decision` packets do not enter this projector. They stay in the
governed resume or structured adjudication path.

The GitLab terminal projector accepts only a succeeded `review-documentation`
packet with immutable `comment-existing-mr` intent. It verifies the original
run, dispatcher receipt, registered canon, optional continuation plan, project,
epoch, principal, request, and frozen head before projection. It evaluates the
standing Review grant and protected note-policy expiry after all CAS, head, and
note reads, immediately before the HTTP adapter can mutate the note. A
successful response must carry that bot identity and the exact requested body;
an update must also return the requested note id. The job packet keeps its own
write and publish grants false.

An exact pre-existing bot note is a read-only reconciliation. The host rechecks
authority after the provider reads and settles the unexpired claim directly as
delivered and `reconciled`, with no `attempting` state and no POST or PUT.
When an uncertain POST or PUT is confirmed by exact readback, `reconciled`
instead settles from `attempting` and retains the write-attempt history.
Unconfirmed uncertainty remains `ambiguous`.

For a write, the dedicated PostgreSQL ledger moves through `pending`, fenced
`claimed`, and `attempting` before GitLab I/O. Read-only reconciliation moves
from the unexpired claim directly to `delivered`. Delivered, refused, and
ambiguous rows are terminal. An expired attempting lease or unreconciled
uncertain mutation never causes a blind second write. Logical recovery exports
only content-free history and imports it under the fresh epoch as inert evidence.

Merge-triggered reconciliation is also separate. A confirmed result without an
open inconsistency completes without resolving a Slack destination or posting a
message. Execution failure, a missing or corrupt result, quarantine, retry, and
a superseded merge do not become conflict messages.

Structured adjudication begins only when protected owner, severity, and
measurement policies permit a question. The request mentions the one Slack user
resolved for the accountable principal. It includes the project, merge revision,
open-conflict count and classifications, selected safe summary, governed detail
and evidence locators, reply shape, and authority limit. A valid attributable
reply in that thread supplies evidence for a fresh fenced continuation. It
grants no write, publish, merge, deployment, tool, credential, or whole-model
approval authority.

## Phase A: Outbound Note

After a catalogued job finishes or needs a human decision, host posts
**one** merge-request note. The note contains:

- a `safe-label` disposition; and
- a credential-free run-record locator in the form
  `docsfab-run-record:<runId>`.

The note is a terminal or needs-decision projector. It is not a draft
patch merge request and not a check-run.

For the hosted automatic review procedure and onboarding prerequisites, refer
to [Review Merge Request Impact in DocsFab](../../../workflows/review-merge-request-impact.md#use-hosted-automatic-review).

## Phase B: Inbound Mention Submit

A GitLab Note Hook on a merge request is verified with the Standard
Webhooks HMAC-SHA256 signing token, then parsed for
`@docsfab run <workflow>` plus bounded digest params. The host identity
map translates the GitLab user id to a mapped operator. The mailbox
calls the host submit/observe spine; it does not reimplement the journal.

Unknown workflow names are refused. The mention cannot mint
`--allow-write`. The default identity map is empty (fail closed). Tests
use a fixture map. Do not commit a production identity matrix or a live
signing token.

For hook configuration, follow [Configure GitLab Event Intake](../../../configure/gitlab-event-intake.md).

## Existing MR Branch Updates

`update-existing-mr` is not a mailbox note and is not the Review-tier
`comment-existing-mr` action. It requires a separate standing `Contribute`
grant and a typed request bound to the exact GitLab project, merge request,
source and target branches, expected source head, policy version (`A+1`),
requester identity, patch digest, and logical request.

The host updates only a non-default, non-protected source branch in the same
approved project. Forks, cross-project sources, other-owner branches, and
force pushes are refused. The host reobserves the merge request immediately
before the update, so a stale head, missing authority or grant, or any policy
or identity mismatch fails closed without a branch write. The persistent,
host-owned `HostGrantLedger` evaluates the standing grant and its fixed
activator policy. Current `same-author` behavior compares the fresh
GitLab-observed MR author with the requested owner and requester digest; it is
not formal branch ownership and remains pending human selection.

The current GitLab REST transport does not perform a direct source-branch
update. The repository-commit API does not provide an atomic expected-head
compare-and-swap for the branch ref, and `last_commit_id` applies only to
individual file actions. Its update operation is deliberately non-mutating and
fails closed before redeeming a write credential or sending a commit request.
The publisher can then follow its visible fallback path; that fallback note
does not change the source branch. A direct transport requires an atomic
expected-old-SHA ref mutation, equivalent to force-with-lease.

After the update, the publisher invokes its injected evaluator with the
returned new head and accepts the result only when its reviewed head equals
that new head. The injected review-summary projector receives the typed
evaluation and returns a typed receipt for request, MR, reviewed head, and
binding reconciliation; the update publisher does not issue a raw note POST.
The typed report locator includes a report digest, request digest, reviewed
head, and binding digest, binding the report to the request and new head. A
known denial before mutation is persisted and replays comment-only evaluation
with patch and report locators. Fallback publication also returns a typed
receipt bound to the request, mutation state, locators, and body, so an
accepted response loss reconciles without a duplicate note. A journal-backed
`pending` → `publishing` → `posted` lease permits one fallback mutation;
concurrent publishers only reconcile or return `in-progress`. If the publisher
exits and lookup finds no remote receipt, the host leaves the lease in
`publishing` rather than risking a duplicate through automatic takeover. If
the mutation is uncertain, the host records that uncertainty, attempts a
visible fallback note, and never claims that no branch write occurred. If the
branch update succeeded but evaluation or
summary posting failed, the applied head remains journaled and a retry
completes evaluation or summary posting without reapplying the patch. The
fallback result in either post-mutation state is not proof that the branch was
untouched. The required journal uses atomic reserve and compare-and-set
transitions with immutable entries. A concurrent reservation returns a
non-visible `in-progress` result. Journal persistence across host processes
belongs to the supplied journal implementation. Credentials
reach the transport only through the broker-bound use callback and do not enter
the request, result, journal, or projected note. A replacement draft requires
the separately authorized `create-draft-mr` action. This action does not merge,
approve, or mark the merge request ready.

## Merge-Request Change-Event Intake

The forge-event adapter normalizes GitLab merge-request open, update,
source-head update, merge, and close observations into provider-neutral change
events. Projects receive observations through polling or webhooks. This event
path is separate from mention-submit and from the existing
push and pipeline event adapter.

Each receiver configuration requires an explicit `deploymentId`, project ID,
deployment epoch, provider, provider host, and provider project ID. These
values bind aggregate identity, event replay, outbox effects, and stored
payloads to one deployment project and epoch.

Choose one explicit `forge.sourceMode` per project: `poll` or `webhook`.
Activation also requires `forgeSourcePolicy`, bound to the same deployment,
project, epoch, provider, and provider project. The protected
`forge.sourcePolicyFile` points to the installed `forge-source-policy.json`.
Missing, invalid, and mixed modes fail closed. Neither source mode falls back
to the other.

Poll mode requires `pollCredentialFile`, an expiring read-only handle, bounded
poll settings, and a numeric `pollObserverProviderIdentity`. The observer must
already map to a principal allowed to run `review-documentation`. Supply a
GitLab credential restricted to `read_api` in the protected
`gitlab-read-api-credential` file. Its value stays in the host transport
closure; configuration and downstream records contain only the handle and
binding metadata. Poll mode rejects webhook verification and secret fields.

An approved operator places the token and authorizes its scope through the
root-sealed policy. Host checks establish protected custody, handle expiry, and
the approved-project `GET` boundary. They do not introspect or prove the token's
provider-side scope.

The host runs at most one scheduler per poll project. Its cadence is 30–60
seconds, with bounded pagination, overlap, request deadlines, leases, and
backoff. Accepted candidates, source progress, normalized events, and outbox
effects commit in one PostgreSQL transaction. Retries, overlap, restart, and
duplicate observations preserve logical event identity. Open, update, and
head-update events can request review of the exact current head. Only a merge
with an exact integration revision can start knowledge reconciliation.

Webhook mode excludes the polling credential, observer, and poll settings.
Choose exactly one verification mode in its protected host configuration:

- Use `gitlab-17-token` for NVIDIA GitLab 17.x token verification.
- Use `standard-webhooks-hmac` for the GitLab 19+ Standard Webhooks envelope.

The receiver rejects mixed envelopes. It does not infer a mode from incoming
headers or fall back to another mode after verification fails.

For a merge event, a supplied `merge_commit_sha` is the canonical target-branch
integration revision. If GitLab also reports a distinct `squash_commit_sha`,
the event retains it as source-side provenance. A close-without-merge event is
not eligible to update semantic truth.

In poll mode, GitLab can report a squash merge with no separate
`merge_commit_sha` when the project uses fast-forward merge. In this case, the
host uses the validated `squash_commit_sha` as the target-branch integration
revision and also retains it as squash provenance. The source head remains a
separate revision. The host still requires a merged lifecycle, a merge
timestamp, matching list and detail responses, and at least one supplied
integration revision. It does not substitute the source head when both commit
fields are absent. Refer to [GitLab merge methods](https://docs.gitlab.com/user/project/merge_requests/methods/)
and the [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/)
for the provider behavior and response fields.

Self-loop suppression requires both configured evidence fields: the MR author
must match a DocsFab projection author ID, and the source branch must match a
DocsFab projection prefix. The receiver does not suppress an event only
because a bot actor initiated it.

The production composition injects a durable adapter that commits the
delivery inbox record, aggregate compare-and-swap transition, event, and
outbox effects in one transaction. It also injects project-and-epoch-bound
content-addressed payload storage. The package's in-memory factories are test
fakes, not production storage.

Fresh bootstrap installs the schema after service persistence and the forge event ledger. For an existing installation, follow [Upgrade the Forge Source Schema](../../../manage/upgrade-forge-source.md). Runtime verifies the canonical catalog fingerprint before accessing a poll credential.

Per-project health reports the selected mode, bounded source state, last
completed run, next attempt, and non-secret failure class. Shutdown stops and
drains each scheduler before closing project database pools.

Repository tests cover the poll path. Complete live polling remains
unverified. Webhook mode requires inbound network configuration and separate
live verification. The example configuration, local tests, and upgrade receipt
alone do not prove a live listener or a Slack exchange.

## Merge-Triggered Reconciliation

A tested host runner accepts one actual pending coordination outbox record for
`enqueue-merge-reconciliation`. The record points to the event envelope through
a digest-bound content-addressed storage (CAS) locator. It does not carry an
inline payload. A project- and epoch-bound forge payload store resolves the
canonical bytes.

The runner validates the resolved event against both the outer outbox record
and the payload store binding. It rejects open, updated, close-without-merge,
and mismatched deployment, project, epoch, provider, host, or provider-project
events. A generic effect object or caller-provided event payload is not
sufficient.

DocsFab canonicalizes the forge authority before it evaluates a grant, binds a
project, creates an event or identifier, or persists the event. The authority
must be a DNS host, not a URL. DNS case, a terminal dot, and the default TLS
port `443` normalize to one value. A leading-zero spelling of that port is not
equivalent and fails.

The authority must be an ASCII DNS name. Unicode, Internationalized Domain Name
(IDN), and Punycode forms; IP addresses; numeric, hexadecimal, or octal address
forms; schemes; user information; paths; invalid DNS names; and nondefault ports
fail before those operations. For repository URLs, DocsFab
inspects the raw HTTPS authority before platform URL parsing can normalize it.
The parsed hostname must match the resulting canonical authority.

Repository grant records and evaluation, forge bindings and stored identifiers,
credential leases, publisher network origins, and legacy push or pipeline work
packets all use this same canonical host identity. An alias cannot pass one
boundary and select a different authority at another.

Command, URL, and sealing intake can normalize an accepted authority spelling.
Persisted and replayed records cannot. A stored grant, provider descriptor,
credential lease, scratch checkout, review target, forge payload binding, or
forge event must already contain the exact canonical host. Replay rejects even
a single noncanonical record instead of silently repairing it.

Legacy push and pipeline request identities bind a digest of the canonical host
and provider project ID. Equivalent authority spellings share one request
origin. The same numeric provider project on another host does not.

DocsFab derives a stable repository source-thread identity from the DocsFab
project, forge provider, canonical provider-authority digest, and provider
project. The merge item and source identity also bind the deployment, epoch,
aggregate, change, source revision, merge revision, and event digest.
Equivalent authority spellings produce one thread identity. Different
providers or canonical authorities cannot flatten into that thread.

Before attempt admission, the caller resolves and validates the event and
context. It creates an attempt-independent job anchor and context-binding
digest. The anchor covers the work ID, forge event, full canonical Product
Reference Model parent, complete evidence set, and context binding. It excludes
the later attempt ID and all executor output.

The caller submits both digests when it begins the fenced coordination attempt.
The coordination attempt persists them before the executor can produce output.
The runner then resolves the context again. It validates the deployment,
project, epoch, request key, merge revision, full canonical model parent,
evidence set, and binding digest before the executor uses those inputs.

Coherently resealing changed model or evidence inputs does not update an
admitted attempt. The runner fails it before execution. A caller must prepare
fresh anchors and use an explicit retry generation to admit the changed inputs.

The knowledge boundary registers those sources, compares atomic claims,
classifies inconsistencies, and returns a content-addressed candidate delta and
receipt. Results use a composite deployment, project, epoch, and attempt
identity. The host reconstructs the attempt-independent anchor from the result
and compares it with the coordination record. It derives the packet digest from
the canonical job and validates the full result digest. A completed replay must
also match the result digest stored on the coordination attempt. Internally
consistent executor output cannot replace the independently persisted anchors.

The host does not project a generic success report. It routes the validated
result to the continuation coordinator after the attempt succeeds. A clean
result stays silent. An eligible open conflict produces at most one governed
owner question. Credential-shaped project or channel identities are rejected
before destination resolution or notification. Error
messages do not repeat the detected credential material. The knowledge adapter
applies the complete shared host credential catalog before `resultStore.put()`.
The coordination provider applies it before every journal persistence path.
Logical exports cannot acquire a rejected value.

The knowledge path stops at a report-only candidate. The governed continuation
can turn an attributable answer into candidate evidence, but it cannot approve
or update the Product Reference Model, merge a PRD, SRD, or POR projection, or
acquire repository authority. The production coordination, payload, context,
result, and notification adapters and the dispatcher implement delivery of
these outbox records. Protected route configuration and complete live service
qualification remain separate deployment requirements.
[DocsFab Implementation Status](../../status-and-configuration/implementation-status.md)
records the implementation and verification boundaries. Local tests alone do
not establish an always-on consumer or complete service deployment.

## Draft Merge-Request Projection

The fixed documentation workflows do not perform SCM operations. After a
successful write, the CLI opens one draft merge request unless you pass
`--patch-only`. That host delivery projection is not an outbound mailbox
note, an inbound mention, or a workflow skill. It cannot merge the
result or grant publication or release authority.

## Implemented Boundary

The package provides fake-testable notes and webhook transports and
focused tests. Standing-grant publisher HTTP mutators, including the
update-existing-mr transport, are fixture-tested with recorded JSON. The
update-existing-mr contract is a host-side contract only, not a fixed CLI
workflow or a package-exported mailbox module. The package does not currently
provide:

- live GitLab or GitHub HTTP calls in CI;
- live webhook receiver evidence or a live GitHub integration;
- inline merge-request discussions;
- check-run integration; or
- GitHub mention mailbox.

Live tokens remain in the platform credential store. Standing repository
grants and publisher leases exist as repository-tested paths. Verification of
the hosted existing-MR review-note path does not establish webhook intake,
GitHub integration, or broad project coverage. Hosted review quality remains
under follow-up.

## Authoritative Sources

- [Knowledge reconciliation runtime adapter](../../../../packages/knowledge/src/runtime-adapter.mjs)

## Related Topics

- [Delivering Results](../../../about/core-concepts/documentation-jobs.md#delivering-results)
- [DocsFab Implementation Status](../../status-and-configuration/implementation-status.md)
- [Fern Site Delivery](documentation-delivery.md)
