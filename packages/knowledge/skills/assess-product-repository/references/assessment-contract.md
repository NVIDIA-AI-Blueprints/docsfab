# Repository Assessment Contract

Create one commit-bound assessment in the authorized project-record location.
Use a path such as `evaluations/YYYY-MM-DD-<product>-repository-assessment.md`
when the repository contract does not prescribe another location.

## Required header

```yaml
assessment_id: <stable ID>
product: <name>
repository: <canonical URL or local identity>
repository_commit: <full SHA or explicit non-Git version>
assessed_at: <UTC timestamp>
assessor: <agent or person>
target_release: <value or unknown>
documentation_ia_profile: <name and version or undecided>
record_location: <path>
inspection_scope: []
excluded_scope: []
```

## Required sections

1. **Executive boundary** — what was assessed and what was not.
2. **Product surface inventory** — entry points, components, interfaces,
   build/test/release surfaces, and repository anchors.
3. **Current documentation system** — pages, navigation, publishing stack,
   templates, validators, ownership, and gaps.
4. **Evidence map** — observed facts, bounded inferences, unknowns, and
   contradictions, each with exact anchors.
5. **Source-thread seeds** — proposed stable origins and candidate items;
   proposal does not register them.
6. **Documentation readiness board** — one row per bounded page target.
7. **Acquisition plan** — source checks, artifacts, interviews, decisions, or
   independent evaluations needed next.
8. **Receipt** — commands and files inspected, failures, limitations, and
   verification status.

Use this readiness shape:

```yaml
target_id: <stable ID>
path_or_page_set: <exact target>
family: <IA family>
documentation_type: <tutorial | how-to | explanation | reference | troubleshooting | release-notes>
audience: <named audience or unknown>
reader_outcome: <outcome or unknown>
publication_boundary: <draft | internal | restricted | public>
required_claim_kinds: []
supporting_evidence: []
contradicting_evidence: []
missing_evidence: []
behavior_verification: <not-checked | supported | contradicted | inconclusive | not-applicable>
representation_state: <unreviewed | confirmed | corrected | disputed | not-applicable>
intent_approval: <not-requested | approved | rejected | participant-not-authorized | not-applicable>
evidence_independence: <self-check | source-review | behavior-check | independent-reader | accountable-approval | external-pilot | none>
accepted_gaps: []
reopen_conditions: []
readiness: <not-ready | ready-to-draft | drafted | locally-verified | independently-reviewed | release-approved | published>
```

Do not collapse `evidence_independence` into a generic review status. A source
participant reviewing representation is not an independent reader or an
accountable release approver.

## Multi-Page First-Use Support

When the assessment can admit an ordinary multi-page create or update request,
retain a closed companion record outside the customer patch. Bind it to the
unchanged instruction digest, workflow, exact repository revision, exact sorted
target set, candidate snapshot digest, and actual governed assessment identity.

Include the finite limits and actual file, byte, span, round, model-turn, and
token costs. Keep one row per mandatory obligation with its origin, applicable
targets, condition, status, and cited span IDs. Keep each cited span's safe
repository-relative path, inclusive line range, full-file digest, and span
digest. Do not retain source bytes, prompts, credentials, endpoint URLs, or
private run records.

Use `supported` only when all mandatory rows and every page-specific row have
substantive source support. Use `no-progress`, `budget-exhausted`, or the exact
unresolved conditions for a bounded stop. This record supports drafting at the
bound revision. It does not approve content, expand write scope, grant
publication authority, or replace an accepted knowledge snapshot.
