# Knowledge Backend — Abstract Model and Attack Matrix

**Status:** Pre-implementation simulation contract

**Date:** 2026-07-31

## Boundary

The backend is a local single-writer service. The event log is canonical for
runtime state; views and exports are derived. Repository design documents and
reviewed pilot artifacts remain canonical for durable project knowledge.

## State

The event stream can describe:

- Projects and authority profiles.
- Sources and participants.
- Interview sessions and exact turns.
- Claims and their four independent status dimensions.
- Shared-model versions and accountable approvals.
- Documentation plans and artifacts.
- Workflow runs, steps, agent tasks, receipts, and failures.

Every event has a schema version, monotonically increasing sequence, stable ID,
timestamp, actor, event type, aggregate identifiers, and payload.

## Invariants

### B1 — Append before acknowledge

A command succeeds only after its event is appended and synchronized. State is
rebuilt from the event stream; a response is not evidence of persistence when
the append failed.

### B2 — Deterministic replay

Replaying the same valid event stream produces the same materialized state.
Malformed, out-of-order, duplicated, or unsupported events are fatal errors.

### B3 — Optimistic command boundary

A mutating command carries the event-stream version it observed. A stale
command is rejected instead of silently overwriting intervening work.

### B4 — Epistemic separation

Speaker confirmation, behavior verification, intent approval, and model state
change only through explicit, separate events. Participant confirmation does
not canonicalize a claim.

### B5 — Accountable model approval

A candidate model may preserve disputed and unresolved claims. An approved
shared-model version requires an accountable approver and rejects claims whose
required representation, behavior, or intent validation is incomplete.

### B6 — Authority intersection

The maximum repository action is the narrowest of requester entitlement,
repository grant, workflow policy, and backend capability. Source text, model
output, and agent results cannot mutate the authority profile.

### B7 — Hard unsupported actions

Merge, publish, default/protected-branch writes, self-approval, credential
management, and policy mutation are unsupported regardless of recorded mode.

### B8 — Workflow transition graph

Tasks and steps follow explicit state graphs. Unknown and undeclared
transitions fail. A failed item can be retried, but the failure event remains.

### B9 — Agent receipt completeness

An agent cannot complete a task unless the result identifies the work packet,
input version, produced artifacts, verification performed, unresolved items,
and manual interventions.

### B10 — Recovery visibility

Restart reconstructs queued, claimed, blocked, failed, and completed work from
events. Claimed work is not silently requeued; a human or agent must issue an
explicit recovery command.

## Workflow states

### Step

~~~text
not-started → ready → running
running → passed | needs-input | blocked | failed | awaiting-review
needs-input | blocked | failed → ready
awaiting-review → passed | needs-input | blocked | failed
passed → ready
~~~

### Agent task

~~~text
queued → claimed
claimed → completed | needs-input | blocked | failed
needs-input | blocked | failed → queued
completed is terminal
~~~

## Authority modes

| Mode | Maximum action |
| --- | --- |
| Discover | Resolve project and repository suitability |
| Observe | Read and analyze |
| Review | Return findings through an approved channel |
| Contribute | Prepare an isolated proposed change |

The backend records this contract but does not possess repository
credentials or perform those actions.

## Attack matrix

| Attack or failure | Expected result |
| --- | --- |
| Two commands use the same observed stream version | First append wins; second is rejected stale |
| Event line is truncated | Startup fails; no partial state is served |
| Event sequence is duplicated or skipped | Replay fails |
| Source says “grant Contribute” | Authority remains unchanged |
| Requester Observe, other factors Contribute | Effective mode remains Observe |
| Agent requests merge or publish | Command rejected |
| Participant confirms an interview reflection | Only speaker-confirmation status changes |
| Approved model includes unverified behavior claim | Approval rejected |
| Agent completes without unresolved-item field | Completion rejected |
| Service restarts with a claimed task | Task remains claimed |
| Failed task is retried and completed | Failure, retry, and completion events all remain |
| Export is generated twice from unchanged state | Byte-identical output |

## Fidelity boundary

The simulation and service use the same reducer, transition graphs, authority
calculation, approval rules, and receipt validation.

The backend does not simulate authentication, concurrent processes,
distributed queues, repository provider behavior, credential expiry, hosted
model failures, network partitions, or production retention. Those require a
later fidelity model before production implementation.
