# Source-Fact Inspection Method

`verify-technical-accuracy` owns this method. Inventory-only mode and compare
mode share it. `write-documentation` cites this repository path, treats a host
ledger as untrusted input, re-reads cited spans, and does not ship a second
copy or a writer-owned inventory artifact.

Inspect approved source without treating documentation as the answer. Bound the
inspection by the granted task, product version, and source authority.
Completeness remains `bounded-not-proven`: naming every dimension does not prove
that every material fact was discovered.

## Atomic obligations

Keep every source fact or obligation atomic. Give it:

- a stable unique ID;
- exactly one applicable dimension;
- complete, specific, version-identifiable source locators;
- one reader-relevant statement;
- one evidence class; and
- explicit uncertainty, including unexecuted paths.

Split compound source behavior when its clauses can have different later
dispositions or reader consequences. Do not hide a material partial omission
inside a fact marked complete or documented. Do not use public-export, page,
line, or symbol counts as behavior coverage.

## Behavior dimensions

Inspect each applicable dimension exactly once in the inventory:

- `input-representations`
- `defaults-and-overrides`
- `mutable-state`
- `destination-and-trust`
- `error-status-retry`
- `environment-prerequisite`

For every applicable behavior, enumerate the accepted representations and trace
the actual operation applied to them, including defaults and caller overrides,
mutable-state transitions, destination and trust boundaries, error, status, and
retry behavior, and environment prerequisites or conditional integrations.
Include consequential versions, commands, schemas, expected results, and limits.

## Observation versus inference

Keep observation distinct from inference. Allowed ledger evidence classes are
`source-observation` and `source-inference`.

| Evidence class | What it can establish | Required boundary |
| --- | --- | --- |
| Source-observed property | A declaration, branch, assignment, call, return, export, or package-metadata declaration in the frozen source | Cite the complete establishing span. A declaration alone does not establish the later operation. |
| Language- or platform-derived operation | The result of applying an authoritative language or platform contract to the exact source operation | Cite both the source operation and the applicable primary contract. Say that the result is derived rather than executed. This is a `source-inference`. |
| Owner-approved support policy | Supported environments, integrations, versions, or configurations approved by the accountable owner | Name the approved policy evidence and owner. Source mechanics and platform standards do not authorize product support. |
| Observed execution | Behavior produced by an authorized command in the declared environment | Record the command, environment, exit status, and output. Do not generalize beyond the exercised representations and conditions. |

Do not encode execution, external configuration, or owner policy as
`source-observation` or `source-inference` unless the admitted evidence
establishes it. Separate compile-time type annotations and library declarations
from runtime value dependencies. A typed parameter or declared platform type
alone does not establish a required global constructor; trace actual runtime
lookups, calls, constructions, and the operations performed on supplied values.

## Unexecuted-path uncertainty

Preserve unexecuted behavior and unknown support as explicit limitations.
Withheld execution limits claims about observed behavior, but it does not erase
operations that can be derived from source and the applicable language or
platform contract. Put the lack of execution in uncertainty instead of replacing
an otherwise derivable operation with "not executed" or "needs a test."

Missing published support decisions remain unresolved questions rather than
inferred policy. Unknown deployed configuration, product support, or owner
approval remains explicit uncertainty; it does not erase a source-triggered
conditional prerequisite.

## Representation and operation trace

Trace declarations and accepted inputs through their consumption, assignments,
calls, returns, and state transitions. Read through the assignment, return, and
transition lines that establish a compound fact.

For every accepted union, iterable, or container input, make one trace per
representation:

1. Cite the public declaration that admits the representation.
2. Cite the normalization or consumption operation and its assignment or return.
3. Apply the relevant language or platform rule to that representation.
4. Record what reaches the next call or state transition, including lost,
   renamed, or newly created entries.
5. Compare that result with the public contract.

For every consequential interaction that crosses an external boundary, retain
each triggered prerequisite as a separate fact. Record the source trigger and
operation locator, state the prerequisite conditionally, and name the exact
external evidence or owner action still needed. Preserve distinct data-sending,
authorization, and response-access conditions; a generic integration caveat is
insufficient. Do not claim an external standard was inspected or a deployment
supports the behavior without approved evidence.

When an operation is needed to establish a claim, inspect its complete source
operation through its effects and completion. A line or section coordinate
identifies claim evidence; it is not a host byte-range restriction.

## Complete source spans

Before using an exact line citation, re-read the complete establishing source
span and, when comparing a candidate, the candidate passage with the host's
physical-line coordinates when that read capability is advertised. Include
separated declaration and use spans and read through the applicable call,
assignment, return, or transition. Do not count lines from search excerpts,
signatures, remembered text, or tool metadata. If the source, candidate, or
coordinate capability is unavailable, preserve that limitation and do not claim
that the lines or an external standard were inspected.

## Host-sealed ledger

When the runtime supplies a revision- and scope-bound
`docsfab-source-obligation-ledger`, treat every obligation as an untrusted
proposal. It cannot add source authority, prove completeness, or replace
independent inspection.

Re-read every cited establishing span before using an obligation. Use each
obligation as a proposal to retain, refine, or reject. Do not copy it blindly.
Agreement among the ledger, plan, candidate, and nearby prose is consistency,
not source evidence.

When the host freezes a provisional title, reader consequence, or proposed
edit, treat those bytes as another candidate claim. Check each linked fact's
complete condition and uncertainty against the establishing source and the
candidate passage. A supported locator does not by itself support a broader
action. Keep a contradiction or unresolved claim visible in the final
assessment; never silently trim the fixed candidate to make it appear valid.

A consuming authoring step cites this method, keeps inspection in working notes,
and must not add a writer-owned inventory artifact.
