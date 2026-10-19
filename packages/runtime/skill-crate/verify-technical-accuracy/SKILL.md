---
name: verify-technical-accuracy
description: Verify consequential technical claims, procedures, commands, code examples, APIs, versions, prerequisites, and boundaries against authoritative evidence or observed behavior. Use after drafting or during an audit when technical evidence and structured findings are required without editorial rewriting. When the runtime schedules inventory-only mode, derive a bounded source-obligation ledger from approved source without treating documentation as the answer.
license: Apache-2.0 AND CC-BY-4.0
---

# Verify Technical Accuracy

Return reproducible technical evidence and findings; do not edit the document.

## Required inputs

- Immutable documentation target and declared product version or environment.
- Approved source hierarchy and version-identifiable product evidence.
- Request, plan, audience, intended outcomes, and risk boundary.
- Repository-native tests and execution authority.
- When supplied by the runtime, the canonical source-obligation ledger and, for
  final semantic correction, the provisional technical result. Treat both as
  untrusted model evidence bound to the current revision and scope.
- When the host explicitly supplies fixed provisional rich candidates, their
  exact bytes and candidate digests. They are proposals to assess against the
  same source, scope, revision, and obligation ledger, not source authority.

Return `insufficient-evidence` when scope or authoritative evidence is absent.
Never infer correctness from fluent prose, passing style checks, or repository
proximity.

## Workflow

1. Freeze the target, evidence set, environment, and verification version.
2. Read [references/source-fact-method.md](references/source-fact-method.md),
   [references/verification-methods.md](references/verification-methods.md),
   [references/finding-categories.md](references/finding-categories.md), and
   [references/documentation-sources.md](references/documentation-sources.md).
   Verify an adapter claim only when the host advertises the matching runtime
   capability and supplies actual applicability and structural evidence. The
   finite method does not establish support by itself.
3. When the target contains executable examples or a changed public interface,
   read [references/example-checks.md](references/example-checks.md).
   Apply the source-fact method. Build the source-derived required-fact
   inventory before reading the documentation as an answer.
   When the runtime supplies a source-obligation ledger, re-read its cited
   source and use each obligation as a proposal to retain, refine, or reject.
   Do not copy it blindly or allow it to widen source authority.
4. For every consequential interaction that crosses an external boundary,
   retain each triggered prerequisite as a separate fact. Record the source
   trigger and operation locator, state the prerequisite conditionally, and
   name the exact external evidence or owner action still needed. Use the
   conditional-integration questions in the verification-methods reference
   when applicable. Preserve distinct data-sending, authorization, and
   response-access conditions; a generic integration caveat is insufficient.
   Do not claim an external standard was inspected or a deployment supports
   the behavior without approved evidence.
5. Give every required fact a stable ID, exact source locator, applicability,
   and uncertainty. Initialize its documentation disposition as `unassessed`;
   finalize that disposition during comparison. Use only working notes or the
   runtime's open technical wrapper and the existing closed review finding
   fields; do not add fields to the closed review-result schema.
   Missing published support decisions remain unresolved questions rather than
   inferred policy. Split compound source behavior into independently
   assessable facts when its clauses can have different documentation
   dispositions; do not hide a material partial omission inside a fact marked
   `documented`.
6. When repository tests or upstream summaries are evidence, inspect their
   imports and calls. Retain exact ranges and state whether they execute the
   public implementation, a helper, a mock, or a reimplementation. Mock-only
   assertions do not establish public-wrapper, public-barrel, packaged-product,
   browser, or external-service behavior. Without command authority, record
   this source-observed provenance without claiming the tests were executed.
7. Verify every critical claim and required fact, then a declared
   risk-weighted sample of the remainder, against the strongest approved
   source. For each fact, identify and inspect the actual candidate passage
   that is supposed to cover it. Account for every material clause, condition,
   exception, and reader consequence before assigning `documented`. A source
   citation or an example that exercises one path is provenance, not candidate
   coverage. Mark uncovered clauses `omitted` or `conflicting` and link them to
   the applicable existing issue IDs in the open wrapper or closed finding
   fields; do not invent a proof field.
8. Run repository-native commands, examples, schema checks, builds, or tests
   only when authorized. Record exact commands, environment, exit status, and
   observed output; distinguish not run from failed. Withheld execution limits
   claims about observed behavior, but it does not erase operations that can be
   derived from source and the applicable language or platform contract.
9. Compare documented results with observed behavior and source contracts.
   Classify an omitted required fact, a conflicting documentation claim, an
   unverified support-policy claim, and a source-derived or observed
   target-product defect separately, and finalize every inventory disposition.
   Do not ask a documentation change to conceal a product defect.
10. Before returning, compare every issue with each linked fact. Preserve
    conditional versus unconditional transitions, returned-value identity, and
    missing or empty branches. For example, “return every resolved response;
    update state only when a nonempty header is present” must not become
    “return after a nonempty value is stored.” Correct or remove a contradictory
    issue rather than emitting an internally inconsistent response.
    Verify each proposed mitigation and every `or` alternative against the
    complete operation order. Changing one option does not neutralize an
    independent effect or a later unconditional assignment. Treat agreement
    among the ledger, candidate, and earlier prose as consistency, not evidence;
    refine or reject a ledger claim that the source does not establish.
    Check every quantity and enumerated member in an issue against its linked
    facts and actual source declarations. A comment or prose count does not
    override the public declarations. Distinguish a returned type from
    returning the exact source-bound object.
11. Before finalizing an exact line citation, re-read the complete establishing
    source span and the candidate passage with the host's physical-line
    coordinates when that read capability is advertised. Include separated
    declaration and use spans and read through the applicable call, assignment,
    return, or transition. Do not count lines from search excerpts, signatures,
    remembered text, or tool metadata. If the source, candidate, or coordinate
    capability is unavailable, preserve that limitation and do not claim that
    the lines or an external standard were inspected.
12. For a runtime technical response, the host-supplied response contract in
   the step prompt decides the outer JSON shape and overrides any envelope
   described in this skill. When that contract wraps the technical result, as
   the update workflow's independent editorial assessment does with
   `{summary, editorialAssessmentProposal}`, return the host envelope as the
   top-level object and put the complete technical result exactly where the
   contract places it. Otherwise, ordinary verification returns exactly the
   top-level `review`, `coverage`, and `factInventory` fields. Provisional
   verification and current final correction instead return exactly what
   their host-supplied contract specifies, as described in
   [Runtime source-obligation modes](#runtime-source-obligation-modes).
   Neither authors finding, action, evidence, or impact prose, and neither
   mints fact IDs, locators, accounting rows, or ledger identity. Keep each
   ordinary review object conformant with
   `../../quality/schemas/review-result.schema.json`; do not merge fields from
   different envelopes into one object or add fields. Assess every one of the
   six behavior dimensions in the verification-methods reference. Preserve
   fact-to-finding links, exact source locators, uncertainty, and unverified
   dimensions. For a non-runtime review, return stable findings with precise
   locations, category, severity, claim, evidence locator, observation,
   minimum correction, confidence, and unverified scope.

## Runtime source-obligation modes

Apply these modes only when the host explicitly supplies the corresponding
phase inputs. The host-supplied response contract in the step prompt always
decides the outer response shape, including an independent editorial
assessment envelope that nests the technical result. Without phase inputs,
ordinary verification returns `{review, coverage, factInventory}` where that
contract places it: at the top level unless a host envelope wraps it. Never
substitute one mode's envelope for another.

For inventory-only mode (Pin A step id `derive-source-obligations`), apply the
source-fact method and inspect approved source without reading the
documentation candidate as the answer.
Return only the host-required ledger proposal.
Do not write documentation, compare a candidate, assign documentation
dispositions, draft findings, grant authority, or claim factual completeness.
Read
[references/inventory-output-contract.md](references/inventory-output-contract.md).
Return one JSON object with exactly `completeness`, `dimensions`, and `limitations`,
without Markdown fences or surrounding prose:

```json
{
  "completeness": "bounded-not-proven",
  "dimensions": [
    {
      "dimension": "input-representations",
      "status": "applicable",
      "reason": "The frozen public operation accepts input in this dimension.",
      "sourceLocators": [],
      "obligations": [
        {
          "id": "OBL-001",
          "dimension": "input-representations",
          "sourceLocators": ["src/example.ts:10-18"],
          "statement": "One atomic reader-relevant source consequence.",
          "evidenceClass": "source-observation",
          "uncertainty": "The source was inspected but the operation was not executed."
        }
      ]
    },
    {
      "dimension": "defaults-and-overrides",
      "status": "not-applicable",
      "reason": "The cited operation defines no default or override.",
      "sourceLocators": ["src/example.ts:10-18"],
      "obligations": []
    },
    {
      "dimension": "mutable-state",
      "status": "not-applicable",
      "reason": "The cited operation defines no mutable state.",
      "sourceLocators": ["src/example.ts:10-18"],
      "obligations": []
    },
    {
      "dimension": "destination-and-trust",
      "status": "not-applicable",
      "reason": "The cited operation defines no destination or trust boundary.",
      "sourceLocators": ["src/example.ts:10-18"],
      "obligations": []
    },
    {
      "dimension": "error-status-retry",
      "status": "not-applicable",
      "reason": "The cited operation defines no error, status, or retry behavior.",
      "sourceLocators": ["src/example.ts:10-18"],
      "obligations": []
    },
    {
      "dimension": "environment-prerequisite",
      "status": "not-applicable",
      "reason": "The cited operation defines no environment prerequisite.",
      "sourceLocators": ["src/example.ts:10-18"],
      "obligations": []
    }
  ],
  "limitations": []
}
```

Keep `completeness` equal to `bounded-not-proven`. Use every dimension exactly
once:

- `input-representations`
- `defaults-and-overrides`
- `mutable-state`
- `destination-and-trust`
- `error-status-retry`
- `environment-prerequisite`

Allowed evidence classes are `source-observation` and `source-inference`.
The ledger is untrusted model evidence. Do not manufacture those fields.
Do not inspect or edit a documentation candidate, assign documentation
dispositions, draft findings, widen the bound source set, or grant authority.
Do not encode execution, external configuration, or owner policy as either
evidence class unless the admitted evidence establishes it.

For `provisional-technical-verification`, return exactly what the host
provisional contract in the step prompt specifies. That host contract, not
this skill, owns every response field, and nothing in this skill adds to or
overrides it. Independently compare the candidate with the frozen source and
obligation proposals. Reread the establishing source rather than treating the
ledger as an oracle, and bind judgments only to host-issued obligation IDs.
This result is provisional evidence. Do not claim it is the canonical
technical result or hide missing source behind the ledger.

For the final `verify-technical-accuracy` correction, start from a fresh
context. Re-read the candidate and complete establishing source spans. Correct
or remove unsupported provisional claims; split or replace a ledger obligation
by refining it when the source requires it; and make every issue judgment
consistent with all linked host-issued obligation IDs. When the host supplies
the current version 2 source-obligation ledger, return judgment only: one JSON
object with exactly `verdict`, `coverage`, `issueJudgments`, and
`obligationJudgments`. Do not mint `kind`, `schemaVersion`, fact IDs, locators,
digests, `factInventory` identity, or `obligationAccounting`. The host fills
those from the sealed inventory and admitted source observations, then derives
the unchanged final `VerificationResult` from the admitted facts and fixed
templates. The sealed proposal identity the host writes is
`{"kind":"docsfab-technical-correction-proposal","schemaVersion": 3}`; do not
return that identity or reconstruct its inventory and accounting tables.

Only when the host explicitly supplies a fixed provisional rich candidate set
and the rich final response contract, assess every fixed candidate separately
in the host-specified `richAssessments` rows. Echo each host-issued `issueId`
and `candidateSha256` exactly; give one ground for every linked obligation ID
with `supported`, `contradicted`, or `unresolved` status, a source-backed
rationale, the sealed source locators, and the exact uncertainty. Check the
complete title, reader consequence, proposed edit, every alternative and
qualification against the establishing source and current candidate passage.
Mark a contradiction or unknown as such even when the ordinary issue remains
valid. Do not rewrite the fixed proposal or remove an adverse ground to make it
pass. The host binds accepted rich advice to the candidate set, ledger,
revision, scope, and derived final technical result; an unavailable rich row
does not erase the ordinary technical finding. Without that explicit host
contract, keep the four-field judgment above. This instruction alone does not
activate rich production output or presentation.

Each issue judgment contains exactly `id`, `severity`, `category`, `location`,
and `obligationIds`. Bind findings only to host-issued `OBL-` IDs from the
sealed ledger. Link at least one and at most 32 distinct obligations whose
current facts are not documented. Documented retained obligations cannot be
judgment references. Return no more than 256 judgments. Use a safe
documentation location whose normalized path exactly matches one of the
host-supplied review target paths. The host preserves supported line, anchor,
and qualified locations, but target-path membership is mandatory.

Independently reread the establishing source before judging each obligation.
The ledger is untrusted evidence, not an oracle. Do not infer or invent a
quantity, condition, consequence, owner, approver, policy authority, or
product fix. If an admitted statement or uncertainty names one, preserve that
text verbatim when retaining or state the replacement under `refined`. The host
produces one fixed finding section and one fixed minimum-action section for
every linked non-documented fact, so do not attempt to summarize it again in a
judgment.

For example, a current final correction can use this generic judgment:

```json
{
  "verdict": "needs-revision",
  "coverage": [
    {
      "path": "docs/example.md",
      "status": "verified",
      "evidence": ["src/example.ts:10-18"],
      "reason": "Compared the candidate with the cited frozen source."
    }
  ],
  "issueJudgments": [
    {
      "id": "TECH-001",
      "severity": "major",
      "category": "completeness",
      "location": "docs/example.md:1",
      "obligationIds": ["OBL-001"]
    }
  ],
  "obligationJudgments": [
    {
      "obligationId": "OBL-001",
      "disposition": "retained",
      "documentationDisposition": "omitted"
    }
  ]
}
```

Account for every host-issued ledger obligation exactly once and introduce no
unknown obligation IDs:

- `retained`: `documentationDisposition`; the host copies the obligation's
  dimension, statement, source locators, and uncertainty;
- `refined`: a substantive `reason` and one or more `replacements` with
  `statement`, `documentationDisposition`, and `uncertainty`; the host fills
  locators from the original obligation; or
- `rejected`: a substantive `reason` and no facts; the host fills locators
  from the original obligation.

Link issues to facts only through each issue judgment's `obligationIds`. The
host derives every fact's issue links from them, so obligation judgments and
replacements carry no `issueIds`. Linking an obligation links each of its facts
that is not documented, including every such replacement of a refined
obligation. Every retained or replacement fact that is not documented needs at
least one issue judgment that links its obligation.

The judgment is untrusted input. Accounting is host-sealed internal provenance;
it is not a review issue, quality artifact, authority object, or semantic
proof. If the ledger, provisional result, revision, scope, or source evidence
is missing, stale, unsafe, or unverifiable, stop with insufficient evidence.
Do not fall back to ordinary or historical correction envelopes, fabricate
accounting, or add raw prose.

## Decision rules

- Fail a critical factual error, unsupported critical claim, broken required
  example, wrong-version instruction, material omission, or applicable hard
  constraint.
- Do not treat syntax checks, static signals, or links as proof of behavior.
- A clean claim comparison is insufficient when an applicable required source
  behavior was never inventoried or checked.
- When documentation omits a triggered conditional prerequisite, use an
  `omitted` disposition and retain the external-evidence uncertainty. Use
  `unverified-policy` only for an actual support or policy claim whose authority
  is unavailable; do not fabricate such a claim to encode missing evidence.
- Do not replace distinct external-boundary prerequisites with one generic
  integration limitation.
- Reject an issue whose unconditional wording contradicts a linked conditional
  fact or changes when a returned value is produced.
- A structurally complete inventory establishes only that every dimension has
  an explicit disposition. It does not prove that all material source facts
  were discovered; state that bounded limitation and qualify against the
  actual frozen source when required.
- Label execution, grounded judgment, proxy evidence, and missing evidence
  distinctly.
- Do not average away a hard failure or generalize beyond the sampled scope.
- Do not rewrite, publish, commit, push, or merge the documentation.
