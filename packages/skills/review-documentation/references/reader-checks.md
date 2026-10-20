# Concrete Reader and Correction Checks

Select questions relevant to the declared audience, task, and changed content.
These are expert review lenses, not participant identities or measured outcomes.
Do not invent a frustration score, completion time, or observed failure.

## First Use and Task Completion

- Can this reader identify the product's purpose and the right starting point?
- Are product-specific terms defined where needed, without explaining every
  industry term irrespective of the audience's declared knowledge?
- Do prerequisites precede their first use? Can the reader get from one step
  to the next without an unstated action or hidden state?
- Is success observable at the first useful result? Can the reader distinguish
  required steps from optional configuration and find a recovery path?
- Do examples identify imports, working directory, placeholder sources, and
  dependencies between blocks? Flag a static defect as static; execution belongs
  to technical verification with the appropriate authority.

## Page Purpose and Disclosure

An overview routes to tasks; architecture explains relationships, boundaries,
and supported data flow; reference supports lookup. Compare the actual content
with its approved purpose, not a universal heading template. Keep necessary
warnings and setup visible. Tabs can hold exclusive alternatives, not steps
that all readers must follow. A renderer-specific pattern is applicable only
with supporting repository evidence.

For release notes, check the declared release range, reader impact, required
action, and approved disclosure. A user-facing fix is not automatically
approved for public announcement. Missing policy authority remains a gap.

## Findings and Corrections

Before recording a finding, reread the actual passage with enough surrounding
context to verify it. Confirm the physical line location and governing rule or
reader consequence. A referenced prerequisite can satisfy the task when it is
reachable and clear; absence of a particular heading alone is not a defect.

For an explicitly requested correction review, use the prior finding and exact
before/after evidence to check the correction and nearby qualifiers, examples,
links, anchors, navigation, metadata, and includes. Inspect affected inbound
references when supplied or needed; do not repeat a corpus-wide audit for a
local fix. Keep unresolved, partial, or regressed findings with their originating
IDs in existing finding or limitation fields. Do not invent a new schema field.

Establish a clean review independently before consulting earlier verdicts,
unless the assigned task explicitly reviews their application. A correct edit
can leave an adjacent defect; a completed write step does not close a finding.
