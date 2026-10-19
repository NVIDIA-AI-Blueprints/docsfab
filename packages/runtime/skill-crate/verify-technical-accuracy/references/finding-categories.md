# Technical Finding Categories and Severity

## Categories

<!-- BEGIN GENERATED FINDING CATEGORIES from review-result.schema.json -->
- `technical_accuracy`: A claim, API name, value, behavior, or version conflicts with an approved source.
- `source_grounding`: A consequential claim lacks approved evidence.
- `completeness`: Required information or a required format region is missing.
- `task_success`: A user cannot complete the documented procedure as written.
- `example_validity`: Required code or commands are invalid, inconsistent, or not reproducible.
- `information_architecture`: Structure prevents readers from finding or understanding required information.
- `style_compliance`: The document violates an explicit style or terminology rule.
- `security_compliance`: Content violates an explicit security, confidentiality, legal, or publication rule.
<!-- END GENERATED FINDING CATEGORIES -->

Use `completeness` for an omitted applicable fact, `technical_accuracy` for a
conflicting claim, and `source_grounding` for a support or policy statement
whose authority is unavailable. In ordinary and non-runtime findings, if an
implementation operation established from approved source semantics or
observed execution conflicts with its authoritative public contract, identify
it as a target-product defect in the finding. Route it to the product owner
only when approved evidence names that owner; otherwise request the missing
owner decision. A documentation edit is not the minimum correction. Preserve
the required-fact ID and source locator in the existing finding text and
evidence fields. When execution was unavailable, preserve that uncertainty
without discarding the source-derived defect.

In the current canonical correction mode, apply these categories only as the
finite `category` judgment linked to fact IDs. Do not author finding, evidence,
action, or impact prose in the proposal. The host derives those existing review
fields from the linked facts and fixed templates. Provisional verification
applies the categories only as its host contract specifies. Ordinary and
non-runtime findings keep their existing response instructions. Do not add or
infer a product owner in the current proposal. Preserve an owner only when it
already appears in an admitted fact statement or its genuine source
uncertainty.

## Severity

<!-- BEGIN GENERATED FINDING SEVERITIES from review-result.schema.json -->
- `critical`: Unsafe to publish; causes incorrect operation, disclosure, security/compliance risk, or failure of the primary task.
- `major`: Materially incomplete or misleading but not immediately dangerous.
- `minor`: Localized issue with limited impact on task success.
<!-- END GENERATED FINDING SEVERITIES -->

For ordinary and non-runtime findings, when uncertain between two severities,
choose the lower severity and explain the uncertainty in the applicable
response fields. In provisional verification and the current canonical
correction mode, choose the lower finite `severity` judgment without adding a
severity rationale. Do not add to or rewrite fact uncertainty to carry that
rationale. Never increase severity to force a revision.
