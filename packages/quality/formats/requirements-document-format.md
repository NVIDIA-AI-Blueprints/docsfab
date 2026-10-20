# Requirements Document Format

Use this compact structure when a software requirements document (SRD) is
needed and no suitable document was supplied. An SRD is conditional source
evidence, not a universal gate. Preserve a supplied SRD read-only; do not
reformat it to match this guide.

## Purpose and scope

State the problem, intended outcome, included behavior, and explicit
exclusions. Separate sourced facts from assumptions and unresolved decisions.

## Users and scenarios

Name supported user groups and their primary scenarios. Include only details
supported by approved sources or explicit answers.

## Requirements and acceptance checks

Write each requirement as one stable, atomic, observable behavior. Keep IDs
stable across revisions. Link each row to its evidence source and a concrete
acceptance or verification check.

| ID | Required behavior | Source | Acceptance or verification check |
| --- | --- | --- | --- |
| REQ-1 | A single observable behavior | Source identifier and location | Check identifier or measurable result |

## Constraints and interfaces

Record supported interfaces, dependencies, compatibility, security, and other
constraints. Do not infer applicability or add requirements from silence.

## Open decisions and evidence gaps

List unknown facts, the decision or evidence needed, and the responsible owner
when known. Use `TBD — <decision or evidence needed>; owner: <role or person>`
when ownership is known; otherwise use `TBD — <decision or evidence needed>; owner: TBD`.
Do not invent approvals, evidence, or a `Not applicable` disposition.

## Document ownership, revision, and source references

Identify author, reviewers, approver, revision, and state only when supplied or
approved. Unknown metadata remains `TBD` with the needed owner or decision.
List the source documents with identifiers, revisions when available, and
locations. A draft does not imply review or approval.
