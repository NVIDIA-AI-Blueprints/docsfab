# Technical Verification Methods

| Dimension | Prefer | Useful measures | Do not overclaim |
| --- | --- | --- | --- |
| Factual accuracy | Compare critical claims and a risk-weighted sample with authoritative evidence or observed behavior | Verified claims / sampled claims; critical error count; confidence | Claim coverage does not prove unexamined claims |
| Functional validity | Execute commands, examples, API calls, schemas, and procedures in the declared environment | Pass rate; critical failure rate; environment coverage | Syntax checks do not prove execution |
| Scoped sufficiency | Compare audience outcomes and required claims with the documentation set | Required-claim coverage; material omission count; irrelevant-content findings | Heading presence is not completeness |
| Currency and version fidelity | Compare release, configuration, API, and support evidence | Version-bound claim coverage; stale claim count; drift age | File age alone is not staleness |
| Consistency | Compare terminology, values, defaults, examples, and support statements across surfaces | Contradiction count; contract mismatch count | Repeated wording can be consistently wrong |
| Boundary clarity | Probe conditions, exceptions, non-goals, limits, and uncertainty | Explicit-boundary coverage; ambiguity findings | Longer content is not more precise |
| Grounding and authority | Trace consequential claims to approved sources with authority and supersession | Provenance coverage; unresolved authority conflicts | A link is not proof of authority |
| Delivery integrity | Compare source, render, publication, indexing, and retrieval representations | Broken routes; source-to-render differences; retrieval parity failures | Correct source does not prove correct delivery |

## Source-derived required-fact inventory

Atomic source-fact inspection, dimensions, observation versus inference, and
unexecuted-path uncertainty are owned by
[source-fact-method.md](source-fact-method.md). Inventory-only and compare modes
share that method. This reference covers documentation dispositions, candidate
coverage, and verification-specific evidence handling.

Create the inventory from the approved product evidence before treating the
documentation as a candidate answer. Bound it by the requested task, product
version, and source authority. For every applicable behavior, record a stable
fact ID, the statement to verify, an exact version-identifiable source locator,
applicability, uncertainty, and one documentation disposition:

- `documented`: the documentation states the fact without losing material
  conditions;
- `unassessed`: the documentation comparison has not yet run; this is never a
  final successful disposition;
- `omitted`: an applicable required fact is absent;
- `conflicting`: the documentation materially disagrees with approved source
  evidence;
- `unverified-policy`: the documentation claims support or policy that the
  supplied product evidence cannot authorize;
- `product-defect`: an implementation operation, established from approved
  source semantics or observed execution, conflicts with its authoritative
  public contract; or
- `not-applicable`: approved evidence establishes why the fact is outside the
  frozen scope.

The disposition vocabulary is a review method and belongs in the runtime's
open technical wrapper when that contract is supplied. It is not permission to
add properties to the closed review-result schema. In ordinary and non-runtime
output, encode related defects in the existing finding, evidence locator,
required change, rationale, or limitation fields and preserve the
fact-to-finding cross-reference in the wrapper. For a `product-defect`,
name the product evidence conflict and route it to an owner only when approved
evidence identifies that owner; otherwise request the missing owner decision.
Do not recast the finding as missing documentation. For `unverified-policy`,
request the missing owner decision and report the affected scope as
unverified.

In provisional verification and the current canonical correction mode,
preserve the source-backed conflict in the fact statement, disposition,
locators, and genuine source uncertainty, then return only the finite judgment
metadata. Do not author an independent
finding, evidence, required change, rationale, limitation, or product-owner
field in the proposal. Do not add to or rewrite uncertainty to carry judgment
rationale or an invented owner. The host derives the existing review fields
from admitted facts and fixed templates.

### Evidence classes

Keep these evidence classes distinct in each fact statement, uncertainty, and
finding. A fact can cite more than one class, but one class does not silently
substitute for another.

| Evidence class | What it can establish | Required boundary |
| --- | --- | --- |
| Source-observed property | A declaration, branch, assignment, call, return, export, or package-metadata declaration in the frozen source | Cite the complete establishing span. A declaration alone does not establish the later operation. |
| Language- or platform-derived operation | The result of applying an authoritative language or platform contract to the exact source operation | Cite both the source operation and the applicable primary contract. Say that the result is derived rather than executed. |
| Owner-approved support policy | Supported environments, integrations, versions, or configurations approved by the accountable owner | Name the approved policy evidence and owner. Source mechanics and platform standards do not authorize product support. |
| Observed execution | Behavior produced by an authorized command in the declared environment | Record the command, environment, exit status, and output. Do not generalize beyond the exercised representations and conditions. |

If commands are unavailable, retain source-observed and language- or
platform-derived facts. Put the lack of execution in uncertainty instead of
replacing an otherwise derivable operation with “not executed” or “needs a
test.” When a public declaration accepts an input that the implementation's
operation loses, changes, or rejects, record the source-derived product defect
and separately state that runtime impact was not executed. Outside the current
canonical correction mode, route it to an owner only when approved evidence
identifies that owner; otherwise request the missing owner decision. In the
current proposal, do not add or infer an owner.

### Representation and operation trace

For every accepted union, iterable, or container input, make one trace per
representation:

1. Cite the public declaration that admits the representation.
2. Cite the normalization or consumption operation and its assignment or
   return.
3. Apply the relevant language or platform rule to that representation.
4. Record what reaches the next call or state transition, including lost,
   renamed, or newly created entries.
5. Compare that result with the public contract and assign the disposition.

Do not describe object spread as a universal header or container normalizer.
In ECMAScript, object spread copies own enumerable properties through
`CopyDataProperties`; iterable entries are not converted into named object
properties by that operation. A record-shaped object, a platform container,
and an array of entry tuples can therefore produce materially different
results. Use the
[ECMAScript CopyDataProperties contract](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-copydataproperties)
as language evidence when it applies, while keeping any unexecuted runtime
effect explicit.

### Conditional browser integrations

Keep a conditional platform prerequisite in the inventory even when the
repository does not prove product support or deployed server configuration.
For a browser cross-origin request that includes credentials, adds a
non-safelisted request header, and reads a non-safelisted response header from
script, assess these conditions separately:

- whether the response permits the requesting origin and credentialed sharing;
- whether preflight permits the request method and request header; and
- whether the response exposes the response header to script.

The [Fetch CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol)
and its
[credentials rules](https://fetch.spec.whatwg.org/#cors-protocol-and-credentials)
establish conditional browser requirements. They do not prove that a specific
server is configured correctly or that the product supports every cross-origin
deployment. Without approved external configuration evidence or an owner
decision, preserve each applicable condition with explicit uncertainty rather
than collapsing them into a generic CORS caveat. If the documentation omits
the condition, its documentation disposition is `omitted`; reserve
`unverified-policy` for a support or policy claim the documentation actually
makes without authority.

### Test provenance and issue consistency

When source tests inform a fact, inspect their imports, fixtures, and invoked
functions. A test of a local mock or reimplementation is source evidence about
that mock only. It is not execution evidence for a public wrapper, barrel
export, packaged artifact, browser path, or external integration. Cite the
imports, mock definition, and assertions needed to establish the boundary. If
commands were withheld, say that the test source was inspected and the test was
not executed.

After drafting findings, compare every issue with its linked facts. Keep
conditional state transitions, no-change branches, error propagation, and
returned-value identity exact. An issue must not turn a conditional update into
an unconditional prerequisite for a return, or imply that missing and empty
values take an update branch that the fact excludes.

When source declarations enumerate members or alternatives, compare every
quantity in the issue with the actual declaration and the linked facts. Do not
derive cardinality from comments, prose summaries, line counts, or one
representative example. A fact that says a function returns a value of a given
type does not preserve source-observed identity when the implementation returns
the exact object held by an earlier binding.

### Complete source spans and claims

- Extend a locator through the assignment, return, call, or state transition
  that establishes the fact; include multiple spans when a declaration and its
  use are separated.
- Inventory public clear or reset transitions, including empty-value resets,
  when the source admits them.
- Derive boundary-value consequences from admitted values and the actual
  assignment or operation even when no comment names the consequence. Classify
  a consequence that applies language semantics beyond the literal operation
  as derived evidence and retain execution uncertainty.
- Describe `package.json` or equivalent fields as declared entry points and
  file allowlists. Claim actual packed or published contents only after an
  inspected pack or registry artifact.
- Preserve exact public barrel exports and separately identify internal symbols
  that are not exported through that boundary.

Before finalizing an exact line locator, re-read the complete source span with
the host's physical-line coordinate rendering when the host advertises that
capability. Include the declaration and every separated consumption, call,
assignment, return, or transition needed to establish the fact. Re-read the
candidate passage the same way before recording its locator. Display prefixes
are coordinates, not file content. Search excerpts, signatures, remembered
text, and tool metadata are not establishing spans. If the source, candidate,
or coordinate capability is unavailable, retain that limitation and do not
claim exact lines or an external standard were inspected.

### Candidate-passage coverage

Compare each source-derived fact with the actual candidate passages that are
supposed to document it. Decompose the comparison into every material clause,
condition, exception, alternate representation, and reader consequence. The
passages collectively earn `documented` only when they preserve all of those
parts. A source link proves neither that the linked source was inspected nor
that the candidate states the behavior. An example exercising one successful
path does not cover alternate input representations, an empty or missing
no-change branch, an explicit reset, destination or trust restrictions, error
or retry outcomes, or conditional environment prerequisites.

When a compound fact is only partly covered, split it into independently
assessable facts so the covered clauses can remain `documented` and each
material absence or conflict receives `omitted` or `conflicting`. Link every
omitted or conflicting fact to the applicable existing issue ID. Consolidate
issues only when one correction can accurately preserve all linked facts.
Retain candidate passage locators and clause notes in the open coverage
evidence or working notes, or in existing closed finding fields. Do not extend
the closed review-result schema or invent a proof artifact.

Inspect at least these behavior dimensions when applicable:

1. accepted input representations and their normalization;
2. defaults, precedence, and caller overrides;
3. mutable state, transition conditions, and no-change conditions;
4. destinations, data movement, and trust boundaries;
5. errors, returned status, retry eligibility, exhaustion, and idempotency;
6. environment prerequisites and conditional integrations.

Preserve exact conditions. For example, evidence that state changes only for a
nonempty response header does not support the broader statement that receiving
the header always changes state. Count applicable required facts and checked
facts by dimension. An export or page count is an inventory aid, not a measure
of behavior coverage.

An inventory that names all six dimensions is structurally complete only. It
cannot prove that every material fact in the approved source was discovered.
Retain that limitation, and use an independent source comparison before making
a factual-completeness claim.

### Runtime source-obligation evidence

When the runtime supplies a revision- and scope-bound
`docsfab-source-obligation-ledger`, treat every obligation as an untrusted
proposal. It cannot add source authority or prove completeness. Re-read its
complete source spans before using it.

During provisional comparison, preserve, refine, or reject proposals according
to source and candidate evidence, and return exactly what the host provisional
contract specifies. During a separately requested fresh semantic correction, account for
every obligation exactly once through the host-owned retained, refined, or
rejected rows. Retained facts preserve the proposal exactly. Refinements and
rejections cite the original source boundary and explain the source-backed
change. Total accounting proves provenance only; it does not make the
model-produced ledger or correction an oracle.

If the host explicitly asks for a final rich assessment of fixed provisional
advice, check each title, reader consequence, complete action, alternative,
and qualification against all linked obligations and establishing source
spans. Report supported, contradicted, or unresolved grounds for each linked
obligation without altering the fixed advice. Unsupported rich advice may be
unavailable while the host's ordinary derived finding remains valid. The rich
assessment is neither new source authority nor a substitute for ordinary
judgment and exact obligation accounting.

Use deterministic signals from
`../../quality/checks/collect_doc_quality_signals.py` to prioritize review.
The collector identifies structural risks and readability proxies; it does not
establish accuracy, completeness, comprehension, or task success.
