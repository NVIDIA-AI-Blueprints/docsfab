# Knowledge API and adapter reference

This reference preserves the detailed contracts for the knowledge package's
feedback selectors, local control plane, and runtime adapters. Start with the
[package overview](../README.md) for purpose, boundaries, and the normal local
validation route.

## Product feedback input contracts

The feedback seam exposes source versions and approved-model admission
for the issue observer, semantic comparison and owner-adjudication consumers.
It does not yet implement those consumers or publication/baseline promotion.

Produce a candidate snapshot from exact Git-bound model and source-thread bytes:

```sh
python3 packages/knowledge/skills/converge-documentation/scripts/project_model_feedback.py \
  --root /path/to/checkout --project-id project-id --model-id MODEL-ID \
  --version v0.28 --revision FULL_COMMIT_SHA
```

Install the existing convergence `requirements.txt` parser dependencies. The
reader validates source threads and canonical CommonMark/YAML records, flattens
the selected model's declared ancestry, retains exact file/Git object hashes,
and emits only open conflict records. It checks the selected files against the
specified revision before/after reading, rejects symlinks and ignores Git
replacement objects. Binary source artifacts are hashed without decoding them
as text. Validators come from the installed knowledge package, not the input
repository. All output remains `state: "candidate"`, even if repository
frontmatter claims approval. Failed reads emit a fixed refusal rather than
private parser/source diagnostics.

The supported module ports are:

| Module/export | Purpose |
| --- | --- |
| `product-feedback-contracts`: `sealSourceVersion`, `parseSourceVersion` | Bind observed source identity, content, authorship/editor attribution, times and evidence references. |
| `reference-model-snapshot`: `parseReferenceModelSnapshot` | Check a canonical candidate projection and its digest/record/file closure. This is shape/integrity validation, not source authenticity or approval. |
| `createApprovedModelReader({loadCurrent, verifyApproval}).readCurrent()` | Admit one coherent current model/canon/generation through a trusted host authority backend. |
| `createApprovedModelAdmission({verifyApproval}).admit(envelope)` | Re-verify an exact persisted original snapshot for resumed work; historical approval does not establish currentness. |
| `createFeedbackComparisonInput({baseline, sources, expectedSourceVersions})` | Bind the admitted baseline and exact observed/missing source-version coverage. |
| `verifyApprovedModelContent(baseline, {content, sourcePath, gitObjectId})` | Check approved-model text supplied by the host's existing Git/frozen-input adapter against the admitted canon. |
| `createFeedbackChangeSetReference(...)` | Link a candidate to that comparison; never confer model approval or advance the baseline. |

`loadCurrent` supplies project, generation, stream version, candidate snapshot,
canon hash/path/Git object, and the approval-evidence hash. Trusted host
composition supplies `verifyApproval`; it must verify snapshot custody and the
actual accountable approval evidence/scope against its authority backend. It
returns the exact project/model/version/stream/content/snapshot binding,
principal, authority receipt and approval-evidence hashes, with `scope:
"model-version"`. Missing backend verification, a mismatched binding, raw
`verified: true`, frontmatter, Git authorship and publication receipts cannot
approve a model. This package does not provide a production approval backend.
The host's baseline authority Task supplies that implementation.

Approved admission is process-local and opaque to JSON: persisted output must
be re-admitted through the trusted verifier after restart. For a resumed old
attempt, supply its persisted original model-authority envelope to
`createApprovedModelAdmission`; do not make `loadCurrent` return a historical
generation. The current reader delegates to the same admission validator.
For a historical envelope the trusted verifier also authenticates its stored
generation/model/canon association; approval of bytes alone does not authorize
a caller-chosen generation.
Compare a fresh current read separately before any current publication or
owner-case settlement. Historical admission never advances the current pointer.
A snapshot keeps its
candidate representation beside the separate verified approval record. A new
analysis binds the admitted `baselineSha256`, generation, model stream version
and model/canon digests; publication alone leaves that baseline unchanged.

Source observations preserve a nullable/unknown editor rather than attributing
an edited body to its original author. Unclassified metadata may use
`source-observation`; proposed product intent uses `proposed-intent`. Issue
observations cannot assert implemented or verified behavior. Code observations
and verified-behavior records remain distinct, and evidence hashes are only
references: the consuming analyzer must verify their contents and meaning.
No source record or digest is a credential, owner decision or write grant.

Tests include real repository v0.28/v0.29 source projections and the actual
registered v0.28 statement, with an explicitly labeled offline authority
fixture. The connected host fixture spans source, comparison, owner case,
candidate, publication, promotion and next analysis; downstream adapters remain
fixtures and missing production stages are explicitly incomplete. These tests
do not establish live Slack, approval-store, semantic-model or publication proof.

## Exact Markdown source coordinates

`src/product-feedback-markdown.mjs` provides pure selectors for existing source
text. Each selector returns offsets for JavaScript `content.slice(start, end)`;
it does not change files or grant authority to apply a change.

| Export | Selection |
| --- | --- |
| `assertProductFeedbackParagraph(text)` | Validate one complete LF paragraph without blank lines or block syntax. |
| `selectProductFeedbackMarkdownSection(content, heading)` | Select the document lead when `heading` is `null`, or one exact H2 when it is a string. A document lead needs a unique H1 or supported frontmatter `title`. |
| `productFeedbackParagraphRange(content, heading, beforeText)` | Locate one exact, unique paragraph, including its final newline when present. |
| `productFeedbackControlledRange(content, heading, claimId)` | Locate one unique pair of `docsfab:claim:<id>:start/end` markers and their plain-prose contents. |
| `productFeedbackClaimSpanRange(content, heading, paragraph, selection, claimId?)` | Locate complete claim sentences within the exact paragraph; return the untouched paragraph prefix and suffix as well as source offsets. |

A claim-span selection has exactly
`{kind: "claim-span", startByte, endByte, beforeText}`. Its input offsets are
UTF-8 byte offsets within the paragraph; returned source offsets are JavaScript
string offsets. `beforeText` must match those bytes exactly. Select the adjacent
separator whitespace at each internal sentence boundary so surrounding sentences
remain unchanged. U+FEFF characters at span boundaries remain exact source text
and must be included when they belong to the selected separator whitespace.
The selector refuses partial UTF-8 characters, split Markdown
constructs, ambiguous paragraphs/headings, and a claim that already has the named
controlled region. Use the controlled-region selector for that existing claim.

These selectors support a closed Markdown subset. Targets inside code, lists or
HTML, malformed regions, and ambiguous selections fail instead of guessing
another location. String headings retain their exact H2 meaning, including literal
leading `#` characters. The selectors do not render Markdown, judge a proposed
claim, approve a model, or publish content.

## Verify the package

Node.js 24.21.0 or later and Python 3 are required. The Node.js minimum changes
only between DocsFab releases. The package has no third-party runtime
dependencies.

```bash
cd packages/knowledge
npm test
node src/cli.mjs help
```

Start the local control plane with an explicit runtime-data directory:

```bash
node src/cli.mjs serve --data /absolute/path/to/runtime-data --port 4310
```

The server binds only to loopback. Every mutation must name the exact event
stream version observed by the caller.

The knowledge package provides an adapter that invokes the installed `docsfab`
CLI as the product executor. Initialization binds an immutable executable,
**workflow name**, repository, and revision. The adapter then runs
`docsfab run … --json`. It does not let the child process choose a different
job. A composition point may call `docsfab do` to admit a named job from a
bounded sentence; `--allow-write` remains an operator flag, not something the
adapter or sentence can mint. A composition point must still select and
configure that adapter; source presence does not activate it.
`docsfab-knowledge serve` is the local knowledge control plane, not a second
operator CLI or alternate agent runtime. Hermes remains a deterministic
adapter double and is not how DocsFab runs product jobs.

The exported runtime adapter also provides
`createMergeReconciliationRuntimeAdapter` for a bounded merged-change job. The
caller supplies a replaceable executor and a durable result store. The adapter
binds the exact merge and source revisions, source registrations, Product
Reference Model parent, context-binding digest, work packet, candidate delta,
and receipt. The context binding covers the full canonical model-parent record
and complete evidence set, not only the model content digest.

Repeated or concurrent deliveries reuse one stored logical result only when
their composite deployment, project, deployment epoch, and attempt identity
matches. The adapter rejects a stored record whose identity, canonical job
digest, or full result digest does not match the requested job. The host derives
the packet digest from the canonical job and separately compares the result's
attempt-independent job and context anchors with digests persisted by
coordination before executor output existed. The executor cannot establish
those anchors through self-attestation.

The result retains classified inconsistencies and a candidate delta, but it
cannot adjudicate findings, approve a model, or merge PRD, SRD, or POR
projections. Importing the adapter does not start a worker or grant those
authorities.

The adjudication adapter accepts only a digest-bound question, bound answer,
original reconciliation result, and registered decision source. It verifies
the principal, authority, conflict snapshot, offered claim, disposition,
source, model parent, attempt, and context identities. Scope decisions register
with the `intent` evidence role and record applicability decisions.
Representation and authority decisions retain their corresponding evidence
roles.

Each accepted answer creates one immutable root source lineage for its exact
question. Raw channel text remains in protected host custody. The knowledge
record contains only the stable source identity, answer and content digests,
authority receipt, and lineage anchors. A changed principal, authority,
conflict, source, or answer fails before candidate generation.

The adapter applies `accept-variant`, `supersede-variant`, `rescope`,
`retain-variants`, or `defer` only to the question's offered claims. It leaves
the original result and model unchanged and emits a candidate model, candidate
projection set, and adjudication receipt. A deferred conflict remains
load-bearing. The result explicitly records exact-claim authority while model
approval, projection publication, and projection merge remain false.

The adapter validates proposed and recovered results before result-store
persistence or return. It applies the complete shared host credential catalog
before `resultStore.put()`, and it does not include a detected value in the
error. The host coordination boundary applies the same catalog before every
journal persistence path, so its logical exports cannot acquire a rejected
value.

`materializeGovernedConvergence` accepts only a closed, provider-neutral
knowledge job. The host creates that job after it verifies that a completed
reconciliation has no open load-bearing conflict. The adapter treats the
Product Reference Model as semantic truth and creates one new immutable
candidate. It does not approve or activate that candidate.

The job binds the exact merged change, source-thread frontier, parent model,
semantic delta, ordered decision-source registrations, reconciliation attempt,
canonical claim records, accountable decision dispositions and selected claims,
affected targets, and exact merge-revision Markdown projection bases. Each claim
and decision carries bounded semantic statement bytes and their digest. The
model candidate retains those semantic records in its `semanticContent`, while
projection bases remain formatting inputs rather than semantic authority. A
no-conflict job contains an explicit empty decision-source set instead of
invented adjudication authority. An adjudicated job contains at least one
registered decision source.

Before materialization, the host maps adjudication targets to a closed set of
exact identifiers: `product-reference-model`, `product-requirements`,
`software-requirements`, and `plan-of-record`. Matching is case-sensitive. The
host does not trim values or accept containing, path-like, or lookalike
strings. The `product-reference-model` identifier marks a semantic
source-of-truth change and expands to all three governed projections: Product
Requirements Document (PRD), Software Requirements Document (SRD), and Plan of
Record (POR). The other identifiers select their named projection. Unknown-only
and mixed known-and-unknown target sets fail closed.

For each selected changed or deleted path, the deterministic host worker
derives a merge claim statement from the change status, a SHA-256 path
identifier, and the bounded classification. It also emits explicit no-change
and bounded-overflow statements without copying file contents. The adapter
verifies each statement against its exact digest and rejects unsafe content. It
never reconstructs semantic truth from the PRD, SRD, or POR projection bases.

For adjudicated input, the host derives the ordered decision statements from
registered question and answer turns. A `rescope` decision carries the
accountable owner's bounded normalized scope and rationale, digests of those
exact bytes, and the exact registered decision-source binding. The adapter
places that readable meaning in the candidate model and affected projections.
It marks only claims cited by the original conflict as `rescoped`; it does not
select a variant or grant broader model authority.

Each affected Product Requirements Document (PRD), Software Requirements
Document (SRD), or Plan of Record (POR) candidate is a typed `replace` change.
It binds the exact base bytes and returns complete Markdown bytes plus their
digest. The adapter replaces or appends one bounded model-provenance block and
preserves the rest of the base document. The block renders the converged claim
actions and accountable decision outcomes, so changing either changes the
candidate model and projection bytes. Each candidate identifies its source
model and has `semanticEvidence=false` and `selfTriggerEligible=false`.

The adapter has no publication port. It returns the model candidate,
projection candidate set, and a digest-bound knowledge receipt. The output
contains no credential, private prompt, host path, persona memory, unrestricted
patch, provider-specific repository request, or merge instruction. The host
separately applies project policy, required gates, an integration-owner lease,
and a protected provider-neutral proposal publisher.

The same canonical job produces the same candidate bytes and digests. A
changed frontier, model parent, decision source, attempt, target set, or base
content changes the job identity. A knowledge failure cannot change the prior
model or repository projections.

## Source receipt

The initial package import is recorded at source revision
`52f30252db117a417f0f48164e80d853049bcf9d`. Persisted records from that source
require an explicit migration before this package can load them. The current
schema namespace is `docsfab.knowledge.*`.
