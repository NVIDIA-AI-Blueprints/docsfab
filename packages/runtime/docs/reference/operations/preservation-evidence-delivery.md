# Experimental preservation evidence delivery

The restructure workflow normally includes the complete immutable preservation
base in every applicable step prompt. To exercise exact original-source access
at the audience assessment stage, set
`DOCSFAB_EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE=1` in the host runtime
environment. The local CLI reads the same setting when assembling a workflow
run. The setting is read once when either workflow starts. It only
changes `restructure-documentation`; unset or `0` keeps eager delivery, and any
other value fails before the workflow starts. Unset the variable or set it to
`0` to roll back.

With the setting enabled, the audience step omits the full preservation base
from its prompt and receives a step-bound inventory of plan-selected original
sources. It can call `docsfab_read_preservation_source` with a listed source ID
and byte offset to read exact original UTF-8 ranges. `nextFromByte` continues a
read across response pages. The host binds each reader to the run, step,
revision, workspace snapshot, authority digest, and admitted source IDs; it
revalidates the immutable source digest and credential boundary before
returning a range, and revokes the reader when the step completes. Candidate
workspace files do not grant original-source authority.

To let a later audience assessment reuse exact ranges read by an earlier
verification step, also set
`DOCSFAB_EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE=1` in the runtime
environment. This second experiment only applies to
`restructure-documentation` when stage-specific preservation delivery is
enabled. Unset or `0` leaves reuse off; any other value is refused on that
eligible path. The fresh step reauthorizes and rechecks each original range
before it receives the earlier passage. It receives no earlier assessment,
the observations remain explicitly incomplete, and its own source inventory
and read tool stay available. The cache stays within one run. Unset the reuse
variable or set it to `0` to roll back just this experiment.

The hosted catalog check declares `docsfab_read_preservation_source` for
`restructure-documentation` only when
`DOCSFAB_EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE` is `1`. With it unset
or `0`, the catalog is unchanged, so an installed dispatcher policy sealed
before the experiment keeps validating. A run with the toggle on needs a
request whose sealed `declaredTools` include the reader (derive it with
`inspectHostedWorkflowCatalog("restructure-documentation", { preservationSourceRead: true })`);
a policy sealed without it refuses that run at the catalog check.

The complete preservation base remains available to the preservation review
stage, and host-side preservation checks remain unchanged. This mode is an
experimental delivery path; exact retrieval proves access and byte identity,
not audience comprehension or lossless coverage. Keep it opt-in until paired
configured-model acceptance demonstrates those properties. The toggle does
not authorize live campaign spend or qualify a model.

For a local diagnostic run, set the variables in the process environment before
starting `docsfab`; hosted and local runner assembly select the same
preservation policy. `DOCSFAB_EXPERIMENTAL_COMPACT_EVIDENCE_INPUT=1` separately
compacts structured model-facing evidence while retained evidence stays
canonical. Each flag accepts only unset, `0`, or `1`. Set all three to `0` to
restore the control treatment. The maintained runtime-contribution live runner
records a closed evidence treatment during qualification and passes its exact
flag values to every isolated cell, including explicit zeros for control.
