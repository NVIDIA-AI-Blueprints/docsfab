---
title: "Operational Limit Definitions in DocsFab"
description: "Look up catalog defaults, startup validation, and the limit family relevant to a refusal. To inspect effective values, follow Inspect Operational Limits."
status: draft
content.type: reference
---

Look up catalog defaults, startup validation, and the limit family relevant to a refusal. To inspect effective values, follow [Inspect Operational Limits](../../manage/inspect-operational-limits.md).

Use `docsfab doctor --limits` to inspect the effective operational limits for
the current host and project. The defaults come from the generated view of
`config/limits.yaml`. Contract-kit decode bounds
(`runtime.contract.maxNodes`, `runtime.contract.maxDepth`,
`runtime.contract.maxArrayLength`, and `runtime.contract.maxStringChars`)
load from that catalog. A host override can only shrink those four
ceilings, and a raise refuses at startup. Startup publishes that
validated snapshot to the contract-kit decoders, so a configured shrink
is the bound those decoders enforce. Exceeding a decode bound refuses
with `bound-exceeded`; the kit does not clamp. A record whose size another
declared limit bounds where it is built has no node or array ceiling when it
is decoded; the depth and string ceilings still apply. The repository
inventory is such a record, and so is any record that embeds one, such as the
release readiness search result and its batch authority: the inventory grows
with the tracked tree, and `repository.inventoryMaxEntries` bounds it only
where it is built. When governed workflow search stops at a decode bound, the
step records that bound's refusal code with class `bound`. Canonical technical
correction also loads `technicalCorrection.maxIssueJudgments`,
`technicalCorrection.maxJudgmentFactIds`,
`technicalCorrection.identifierMaxChars`,
`technicalCorrection.fieldMaxChars`,
`technicalCorrection.proseMaxChars`,
`technicalCorrection.maxDemotionEvidenceLocators`, and
`factInventory.maxLimitations` from the same catalog. Crossing one
refuses with `bounds-exceeded` and names the limit, the observed size,
and the remediation. The decoder does not truncate the field. A validated host override
can otherwise narrow or adjust an allowed value within its configured
range. An unknown project limit key refuses during startup, and sealed
composition references reject every override.

The technical-correction record also has three sealed canonical JSON byte
bounds: `technicalCorrection.proposalMaxBytes`,
`technicalCorrection.evidenceMaxBytes`, and
`technicalCorrection.derivedResultMaxBytes`. No override applies to them,
because every reader of a saved run checks the record against them again. A
`review-documentation` run writes one coverage entry for every target page. When
that host-written coverage alone exceeds `technicalCorrection.proposalMaxBytes`,
the run stops before its first model call with
`technical-correction-proposal-max-bytes-bound`. The message names the observed
bytes, the bound, the number of target pages, and the remediation. At a
judgment step, a record that the host built, or whose host-filled coverage
alone crosses a byte bound, stops with the same kind of code and is not
retried. A record that the model's own reply text pushes over a bound stays a
retried `bounds-exceeded` rejection. Narrow the review to fewer pages, for
example one directory. A retry of the same scope stops at the same bound.

The following defaults use the largest allowances already admitted by the
catalog. These are operator-selected allowances, not measured completion
guarantees. Existing explicit host overrides still apply. Warning thresholds
and retry delays retain their configured values. The following table lists
each default and what it applies to.

The following table lists the defaults.

<Markdown src="operational-limits-tables/operational-limits-defaults.md" />

A host can raise each `checks.*` setting through its `DOCSFAB_CHECKS_*`
override, for example `DOCSFAB_CHECKS_COMMAND_TIMEOUT_MS`, up to the catalog
maximum. Every repository-required check runs; `checks.nativeCommandMax`
limits only the documentation checks that DocsFab discovers. A required check
that reaches `checks.commandTimeoutMs` becomes a recorded limitation, and the
patch is still delivered. Refer to
[When a Required Check Cannot Run](../../workflows/update-documentation-beside-a-change.md#when-a-required-check-cannot-run).

Each operation must satisfy all its bounds. For example, the recovery job
allowance does not bypass the logical-object byte limit. The route allowances
do not change Slack message lengths or the separate deployment-manifest limits.
Inspect the installed composition and effective host settings before relying on
the 1-hour step ceiling. Many installed compositions still allow only 5 minutes.

## Limit Families

- [Source Acquisition Limits](source-acquisition-limits.md)
- [Repository Text Index](repository-text-index.md)
- [Artifact and Run-Record Sizes](artifact-limits.md)
- [Context Packet Budgets](context-packet-budgets.md)
- [Configured-Credential Matching](credential-matching-limits.md)
- [Slack Output Limits](slack-output-limits.md)
- [Composition Execution Budgets](execution-budgets.md)

## Moved Topic Links

Earlier section bookmarks lead to the canonical topic below.

<a id="artifact-and-run-record-sizes"></a>

Refer to [Artifact and Run-Record Size Limits in DocsFab](artifact-limits.md#artifact-and-run-record-sizes).

<a id="configured-credential-matching"></a>

Refer to [Configured-Credential Matching Limits in DocsFab](credential-matching-limits.md#configured-credential-matching).

<a id="context-packet-budgets"></a>

Refer to [Context Packet Budgets in DocsFab](context-packet-budgets.md#context-packet-budgets).

<a id="host-limits-file"></a>

Refer to [Configure Host Limits in DocsFab](../../manage/configure-host-limits.md#host-limits-file).

<a id="repository-text-index"></a>

Refer to [Repository Text Index Limits in DocsFab](repository-text-index.md#repository-text-index).
