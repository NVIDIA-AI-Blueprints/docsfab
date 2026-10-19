# Autonomous roadmap integration

DocsFab auto mode may plan tracker work, but planning never grants tracker write authority.
The integration keeps three boundaries separate:

1. The documentation-maturity cascade supplies repository-bound findings and work units.
2. The read-only roadmap planner reconciles those units against a bounded tracker observation.
3. The issue-lifecycle executor applies an exact v2 mutation plan only after a local user grants
   `RoadmapMutationAuthorizationV2` for specific operation keys.

The auto-cycle tracker binding remains `observe-only`. It is provenance for the plan, not a
credential or a substitute for tracker authorization.

## Dry-run artifact

`planAutoRoadmapCycleV1` first revalidates the authentic maturity cascade selection. That check
also proves the assessment and bounded tracker observation are the original host-owned objects;
a structurally valid copy is insufficient. The integration projects only the finding and work
unit selected by both the auto decision and cascade selection, then invokes the read-only #46
planner. Non-execute or unrelated outcomes produce an exact, provenance-bound zero-operation
preview.

Managed tracker observation is a separate content-minimized host boundary. It retains only issue
IID/state/update identity, the validated managed marker, labels, material-evidence digests, and
typed issue links. Titles, descriptive prose, credentials, and raw provider responses are never
part of the observation. The planner resolves candidates in this order:

1. exact managed marker/fingerprint;
2. exact material evidence or an existing explicit issue link;
3. managed label reconciliation;
4. terminal duplicate or superseded state; and
5. new managed issue creation.

An already-observed explicit link to an exact managed identity reconciles that managed issue
instead of creating another. Mere material overlap with an unmarked human issue is non-actionable. Untrusted
markers, ambiguous active matches, and manually detached issues also yield no mutation. A
managed issue with a prior revision binding produces an authorization-gated verification comment;
its state can advance only from the receipt returned by the real lifecycle execution boundary.

`AutoRoadmapExecutionPlanV1` is the preview contract for auto dry-run. It
binds the auto request, assessment, decision, tracker observation, read-only planning artifact,
roadmap ledger, exact v2 mutation plan, and exact lifecycle material bundle. Its
`authorization` field is always `null`.

`runAutoRoadmapDryRunV1` is the exact read-only harness entry seam. It accepts the closed envelope
`{ mode: "dry-run", planningInput }`; extra fields are rejected, and it has no adapter,
authorization, or lifecycle-apply dependency. `docsfab auto --dry-run` routes its production
roadmap projection through this seam.

The preview records all selected operation keys, a total operation cap, and fingerprints for
work deferred beyond that cap. Replanning unchanged inputs therefore preserves the v2
operation keys; deferred units remain explicit rather than disappearing from the run record.

The #46 mutation plan remains review evidence only because its rendered-draft digest is not an
executable provider material digest. Auto mode constructs a new v2 plan from exact managed issue
templates and exact lifecycle materials. Label repair uses dependency-bound remove/add operations
so the second write observes the verified effect of the first rather than the stale ledger state.

Serialized previews are inert. Resume restores one only by reproducing it from the exact
validated ledger, plan, materials, and provenance digests.

## Execution and resume

`applyAutoRoadmapExecutionPlanV1` accepts the preview plus a separate v2 authorization. It
rejects authorization keys outside the preview and rejects any authorization or confirmed
receipt progress beyond the cycle's operation cap. It then delegates to
`applyIssueLifecyclePlan`, which owns:

- local-user identity and access preflight;
- exact material verification;
- repository and tracker drift checks;
- write-ahead ambiguous receipts;
- effect reconciliation and idempotent resume; and
- durable remaining-operation accounting.

A partial or ambiguous receipt must be persisted before returning. On resume, both the loaded
receipt and every newly persisted receipt are checked against the same preview and cap.

## Managed issue state

The public `docsfab-managed-issue` marker is stable semantic identity only. Revision, ledger,
plan, authorization, and receipt evidence stay in host-owned state.

`ManagedIssueStateAdvanceV1` records a new revision-bound state only when the exact receipt object
was issued at the real lifecycle execution boundary and contains a successful or reused issue or
migration-note effect for an authorized operation that names the finding. That private execution
capability is bound to the project, local operator, plan, authorization, receipt, and effect.
Caller-constructed, copied, or merely rehashed receipts are inert. An opaque lookup can then attach
the state to a host-observed issue IID during read-only reconciliation.

Unmarked issues remain human-owned. A managed marker without authenticated host state is a
conflict, never permission to update the issue.
