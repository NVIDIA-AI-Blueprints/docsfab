---
title: Documentation Constraint Evidence in DocsFab
description: Check which cross-layer quality constraints apply to the current DocsFab Fern documentation and what evidence is still missing.
status: draft
---

The DocsFab documentation quality model treats applicable cross-layer
constraints as hard gates. Declaring a constraint does not establish that
the documentation passes it. This page records the current evidence boundary
for the private, in-development English-language Fern source set. For more
information, refer to [DocsFab Quality Reference](index.md).

Use the matrix by target and evidence, not by aspiration. A constraint applies
until an accountable decision establishes that it does not. A partial result
or unretained run is not a pass.

## Status Definitions

The following table defines each evidence status.

| Status | Meaning |
| --- | --- |
| Partially evidenced | Relevant source evidence exists, but the complete outcome or required approval has not been established. |
| Not assessed | The constraint applies, but no sufficient target-specific result has been retained. |
| Not applicable | An accountable decision with rationale establishes that the constraint does not apply. No current row uses this state. |

## Current Constraint Matrix

The following table lists the current result for each constraint.

| Constraint | Applicability and target | Current result | Evidence | Owner and next evidence |
| --- | --- | --- | --- | --- |
| Accessibility and inclusion | Applies to the rendered Fern site and its intended human readers, including applicable keyboard and assistive-technology use. | Not assessed | The [Documentation Quality in DocsFab](../../about/core-concepts/documentation-quality.md) page defines the gate, but no target-specific accessibility run is retained. | Documentation experience owner: run automated semantic checks, keyboard testing, assistive-technology review, and representative participant testing. |
| Global and localization readiness | Applies before DocsFab claims support for a locale, language, culture, regional format, or multilingual retrieval behavior. The current source target is English. | Not assessed | No supported-locale decision, localization test, or multilingual retrieval result is retained. | Product and localization owners: declare supported locales and test terminology, formats, layout expansion, translation, and retrieval. |
| Safety, security, privacy, and data protection | Applies to source retention, credentials, repository operations, generated instructions, previews, and publication. | Partially evidenced | [Architecture](../architecture.md) defines authority and secret boundaries. The quickstarts label preview limitations and protect disposable state. No product-security approval or complete adversarial execution result is retained. | Security, privacy, and product owners: review threat boundaries, secret handling, retention, generated instructions, dependencies, and deployed surfaces. |
| Legal, policy, and support compliance | Applies before external distribution, supported-product claims, or a production release. | Not assessed | The [implementation status](../status-and-configuration/implementation-status.md) says public release is blocked. No target-specific licensing, open-source, product-support, or release approval is retained. | Legal, open-source, product-security, and support owners: record applicable approvals and support commitments for the release target. |
| Human-agent representation parity | Applies wherever humans render Fern pages and agents retrieve source or indexed representations of the same documentation. | Not assessed | Source pages have stable titles and no broken relative links, but no source-to-render or human-to-agent semantic parity assessment is retained. | Documentation and retrieval owners: compare authoritative claims, scope, warnings, link targets, and version metadata across rendered and retrieved forms. |

## Interpretation

A `Partially evidenced` result is not a pass. A `Not assessed` result preserves
an evidence gap instead of converting silence into success. Before a release
uses any constraint as a gate, its profile must name the applicable target,
required methods, threshold or acceptance rule, evidence locator, and decision
owner.

## Related Topics

See the following related topics:

- [Documentation Quality in DocsFab](../../about/core-concepts/documentation-quality.md)
- [DocsFab Implementation Status](../status-and-configuration/implementation-status.md)
- [Documentation Convergence and Freshness in DocsFab](../knowledge-and-delivery/delivery/documentation-convergence.md)

## Evidence Sources

The matrix draws on the following evidence sources:

- [Quality policy](../../../packages/quality/README.md)
- [NVIDIA technical-documentation profile](../../../packages/quality/profiles/nvidia-technical-documentation/profile.json)
- [DocsFab implementation status](../status-and-configuration/implementation-status.md)
