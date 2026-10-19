# Evidence And Comparison Contract

## Input Authority

The host supplies a verified approved-baseline reference, exact atomic claim
records, and a content-addressed evidence inventory. Baseline generation,
approval receipt, canon digest, source-version digests, and the genuine merge or
source-case identity bind the comparison. Repository content cannot provide its
own execution authority.

For a merge, before evidence is the genuine first parent and after evidence is
the exact merged revision. An issue-only source case has its own source identity;
it does not receive invented Git revisions or merge facts.

## Citations

Every material relationship cites an affected atomic claim and relevant source
evidence. Citations identify an admitted evidence record and an exact UTF-8 byte
span with its SHA-256 digest. Quoted text must exist in that record at those
offsets. A citation to a filename or a digest without a supporting span does not
establish semantic contradiction.

Nominate a unique verbatim quote when returning model output. The host resolves
its exact UTF-8 offsets and computes the digest; do not guess a hash. An ambiguous
or missing quote is refused. The retained result carries the resolved span and
digest rather than relying on the model's claim that its citation is valid.

Use the smallest span that preserves the relevant condition, negation, default,
scope, or version. Do not omit a guard or qualifier that changes the statement.
Tests and examples can illustrate expected behavior but cannot be labeled
successfully executed without a separately verified execution receipt.

## Supported Conclusions

| Conclusion | Required basis |
| --- | --- |
| Compatible | Complete declared coverage and supported behavior consistent with the affected approved claims. |
| Conflict | A specific approved claim and contradictory scoped source claims, with the consequential owner decision explained. |
| Uncertain | Missing, ambiguous, unsupported, incomplete, or unverified evidence that prevents a stronger conclusion. |

Proposed intent and implementation can disagree without either source being
discarded. Preserve both claims and their different evidentiary roles. An issue
closure, passing filename pattern, or unchanged API name does not settle that
disagreement.

## Continuations And Publication

Chunk results retain their input, baseline and execution receipt identities.
Progress for one baseline cannot satisfy another. Resume reads the same exact
source versions; a changed source requires a new comparison admission.

Only the host validates final coverage and result shape. A complete comparison
remains a candidate analysis. Currentness must be rechecked before any later
owner-case, candidate, or publication action that requires the current baseline.


## Repository Evidence Gather Requests

The optional `gatherRequests` field nominates agent evidence work. It is a
nonempty array of closed records, each bound to this exact requesting
`inputSha256` and an existing `unknown` assessment's `evidenceId` and `claimId`:

```json
{
  "inputSha256": "the exact input digest supplied by the host",
  "evidenceId": "the admitted evidence ID that needs context",
  "claimId": "the affected admitted atomic claim ID",
  "question": {"kind": "exact-path", "path": "src/adapters/secondary.ts"}
}
```

Alternatively `question` is exactly
`{"kind":"literal-text","value":"requiresMention"}`. This is a literal-text
probe, never a pattern or command. Exact paths use the existing inventory
relative-path bound (1024 characters); literal text uses the existing 2–128
character bound. The existing 32-request batch bound applies to one proposal,
not an operation's lifetime or a fixed number of collection rounds. Keep every
outstanding gap explicit for subsequent immutable inputs. Duplicate requests,
ambiguous selector shapes and foreign input/evidence/claim bindings are refused.

Keep the concrete missing context in `missingEvidence` and omit `proposedClaim`
for a requesting unknown assessment. The absence of `gatherRequests` preserves
historical proposal bytes; explanatory missing evidence alone remains inert.
Unavailable execution receipts or genuinely owner-held intent stay explicit and
cannot be replaced by a guessed repository query or a request for credentials.

The host resolves nominations against its existing project grant, exact W,
tracked inventory and currentness. It records admitted request/search/result
provenance and newly gathered bytes, then issues a new immutable comparison
input. A nomination grants no access and selects no source role, project,
provider, endpoint, credential, mutable ref or executable command. Required
unread, unavailable or unsupported evidence remains pending, even when all
metadata has been enumerated. Repeating a request without new evidence does not
establish progress or justify a clean result. Outstanding requests prevent
adjudication and publication readiness.

Source role comes from the host's protected layout declaration and exact admitted
bytes, never from a model field or filename extension. Contextual planning,
issues and the operation's own projection cannot prove runtime implementation.
An eligible implementation source still needs supporting content and citations;
it is not evidence that execution succeeded. Own-projection exclusion requires
both the declared path and exact generated bytes at W; edited or missing bytes
cannot inherit it. Preserve these distinctions when requesting further evidence.

### Manifest-backed source scope

Fresh manifest-backed chunks carry `repositoryObservationVersion: 3`. The host
retains the complete source graph separately and supplies exact admitted source
fragments. Metadata enumeration and raw binary custody are not semantic analysis.
Required unread or unsupported content stays pending. A model cannot drop the
protocol version, supply a role, or turn contextual/unclassified primary evidence
into an observed implementation assertion.

An unclassified source can be outside the current claims' scope based on its
actual content. To establish that limited conclusion, return `irrelevant` with
assertion `unknown`, null claim/model citation, and a source citation covering the
complete supplied fragment. Every fragment and every claim batch must receive
that content-backed conclusion. A partial quote, unfinished chunk, relevant
assessment or missing read leaves the role/impact obligation unresolved. This is
not a fixture-path exclusion or an implementation role; keep the original bytes
and their unknown role in custody. Required binary content cannot be dismissed
using only its name, extension or inventory metadata.

## Explicit Owner Information Requests

The optional proposal field `ownerInformationRequests` contains closed records:

```json
{
  "evidenceId": "the admitted source evidence ID",
  "claimId": "the affected approved claim ID",
  "requestKind": "scope",
  "question": "Which channels are included in the approved pilot?",
  "whyOwnerNeeded": "The supplied sources describe the proposed change but omit the accountable owner's pilot boundary.",
  "modelCitation": {"evidenceId": "the claim ID", "quote": "a unique exact claim substring"},
  "sourceCitations": [{"evidenceId": "the source evidence ID", "quote": "a unique exact source substring"}]
}
```

The request must bind an existing conflict assessment with no proposed
replacement claim. Citations use the same exact byte-span validation as all
other findings. It cannot contain an approval target, permission or publication
field. The host derives the request digest and source-version bindings.

`missingEvidence` remains separate agent work. Any unfinished chunk, unavailable
source or ordinary evidence gap prevents owner-information readiness. A complete
current request still has `decisionReady: false`; an owner's evidence reply must
be compared before a new bounded model delta can be offered.


## Accepted-Effect Revalidation Purpose

The optional `acceptedEffectRevalidation` input is distinct from ordinary
comparison and a new owner offer. It binds baseline A, the original comparison
and selected finding, the real decision-source registration and selected option,
the offered target/delta identities, exact before/offered-after/expected cores,
and a separate current repository observation. Original origin Z stays separate
from the previous analyzed R and observed W; an issue-only origin remains null.
Changing any purpose field requires a new input and genuine governed execution.

Version 2 also permits a first snapshot whose `previousRevision` and
`previousTree` are both null and whose origin is null. All repository fragments
come from observed W; there is no before evidence and no invented R-to-W change.
The host verifies the complete earlier issue-only job inventory before admitting
this form. Later V2 deltas use the actual completed prior observation, retaining
all required paths and absence obligations. V1 historical records keep their
original bytes and interpretation.

Each admitted V2 repository fragment carries a closed `repositoryRole` record:
`sourceKind`, `classification`, and `coveragePlanSha256`. These fields are inputs,
not model output. The producer, dispatcher and authority independently bind them
to protected configuration, actual Git bytes and the exact immutable operation.
`implementation` requires `sourceKind: repository-source`. `context` retains its
nonimplementation protected source kind. `unclassified` has no established
source role. `own-projection` requires both an immutable generated path and its
exact generated-byte SHA at W; path membership alone never excludes edited or
missing evidence. The host retains full coverage and tree metadata separately
from selected semantic content, and unknown required coverage cannot be omitted.

For V2 observed-implementation facets and every corrective implementation
finding, the cited current-W evidence must have the implementation role above.
Planning, decisions, documentation, issue intent, unknown roles and the
operation's own projection cannot prove implementation or an implementation gap.
An absence marker qualifies only with the same admitted implementation role and
whole-marker citation. Existing desired-intent and current-W citation rules are
unchanged; no model may renew approval, widen scope or select a weaker subject.

The subject is derived by the host from the original selected finding:
`proposed-intent` becomes `desired-intent`; `observed-implementation` stays
`observed-implementation`; unknown classification is refused. Model output cannot
choose a weaker subject. Desired-intent support must keep its proposed-intent
assertion and cannot satisfy an implementation gate. Implementation support is
source analysis, not a claim that a test executed successfully.

For each host-declared facet return one record:

```json
{
  "facetId": "the exact declared facet ID",
  "relationship": "supports-part-of-facet",
  "assertion": "observed-implementation",
  "explanation": "This supplied adapter shows the guard, but the other configured adapter is not established by this chunk.",
  "intentCitation": {"evidenceId": "the exact declared facet ID", "quote": "the complete exact facet text"},
  "sourceCitations": [{"evidenceId": "an admitted evidence ID", "quote": "a unique supporting source span"}]
}
```

Citations use the ordinary quote resolution and UTF-8/hash checks. The intent
citation must cover the complete facet, including its scope value. Positive or
contradictory assessments require appropriate current-W repository evidence;
a whole host-admitted `docsfab-observed-repository-absence` marker also records
genuine current absence. Its canonical record binds path, W revision/tree and
the exact observation digest; partial marker JSON is not sufficient. Before-R
bytes, even marked deleted, remain context only. Old-R bytes alone, owner prose, issue closure, generated proposals and test source
cannot establish implemented behavior. A missing file proven absent by the exact
tree is different from a failed or withheld read.

`supports-full-facet` supports the entire condition, not one convenient fragment.
`supports-part-of-facet` records useful incomplete support. `not-informative`
records why a chunk has no bearing on the facet and does not count as support.
`insufficient` names a concrete unresolved gap or ambiguity. Every facet needs
explicit full support, all declared input coverage must complete, and current
baseline and other-claim gates remain intact. Any contradiction prevents support;
partial-only and all-irrelevant results stay insufficient. No vote, confidence
average, or host union of partial statements can synthesize a complete result.

Ordinary findings remain visible. An expected conflict between baseline A and
its exact accepted replacement is not deleted; its exact offered core must
match the retained owner scope. Any unmatched selected-claim effect or other
claim's conflict blocks the aggregate. Keep-approved never adopts the rejected
after core. The aggregate carries its subject, purpose/observation identities,
facet evidence references, blocking findings and digest; it is analysis only and
keeps `decisionReady: false`.


## Optional Corrective-Proposal Adjunct

`correctiveProposalRevalidation` is a separate, closed input beside the existing
accepted-effect purpose. It names that purpose's digest and the exact E candidate
manifest, recipe, route policy and projection targets. It exists only for the
actual keep-approved choice; expected requirement remains the original before
core. The original finding/assertion and implementation assessment do not change.
Absent adjunct fields retain their old serialized form.

Return one `correctiveProposalAssessments` row per existing before-facet:

```json
{
  "facetId": "the declared before-facet ID",
  "applicability": "within-approved-scope",
  "implementation": "retained-deviation-present",
  "explanation": "The exact current adapter still has the retained deviation; the proposal preserves the approved scope and makes no implementation-success claim.",
  "intentCitation": {"evidenceId": "the declared before-facet ID", "quote": "the complete exact facet text"},
  "sourceCitations": [{"evidenceId": "actual current evidence ID", "quote": "an exact supplied span"}],
  "gapFindings": [{"evidenceId": "actual ordinary conflict evidence ID", "claimId": "the selected claim ID"}]
}
```

Applicability values: `within-approved-scope`, `partially-established`,
`scope-change-required`, `insufficient`, `not-informative`. Implementation values:
`retained-deviation-present`, `aligned`, `partially-established`,
`not-established`, `not-informative`. Full scope support concerns the entire
condition and its qualifiers, not a convenient fragment. The complete facet
citation and all source byte spans receive the ordinary membership/hash checks.

Positive scope claims, a gap or alignment need current-W repository evidence or
an applicable whole replayed absence marker. A gap additionally references actual
ordinary observed-implementation findings in this chunk, bound to the selected
claim and the exact retained offered-after core. Changing that core requires new
evidence/adjudication rather than an implicit owner choice. Empty/missing gap
references cannot support `retained-deviation-present`; non-gap states cannot
carry them. A purely proposed-intent finding never becomes an implementation gap.

Evidence is judged against the claim within its host-admitted role, not by
filename or authorship. In V2, contextual documentation and exact own-projection
bytes cannot establish an implementation state, even when they describe a
documentation requirement. Their wording alone does not establish different
runtime behavior. Implementation source analysis does not
claim successful runtime tests. Preserve the actual original classification even
when new current evidence independently establishes an implementation fact.

The host emits a separate sealed `correctiveProposalAssessment`. It retains
per-facet input states, addressed implementation finding hashes, retained rejected
intent finding hashes and blocking finding hashes. It never erases ordinary
conflicts or changes `acceptedEffectAssessment`.

- `needed-within-approved-scope`: complete/current coverage, full scope support
  for every facet, a fully accounted current implementation gap, complete
  implementation assessment and no unaccounted conflict. The existing effect may
  remain contradicted. This result permits no external action by itself.
- `current-implementation-aligned`: full actual current implementation support
  for every facet, with no conflicting or unknown input. Do not newly claim a
  stale correction is needed; this is not a verified execution receipt.
- `implementation-gap-not-established`: a proposed-intent origin was rejected
  while A was kept, but no implementation gap has been established. This cannot
  justify an implementation-correction claim. A planning/no-change disposition
  requires separate verification.
- `scope-change-required`: an explicit cited changed/expanded scope requires the
  ordinary evidenced adjudication path, not a new choice in this result.
- `insufficient`: missing/partial/ambiguous support, supersession, unavailable
  material, contradictory full-facet states or unaccounted selected/other-claim
  findings. Do not union partial statements or vote on repetitions.

Every adjunct outcome keeps `decisionReady: false`. Root/F still verify actual
owner, source frontier, baseline, E bytes, candidate review and Git/publication
state. Unknown effects retain the same operation/journal. Neither alignment nor
pure rejected intent silently completes delivery; changed materialization scope
cannot be substituted into an unchanged candidate.
