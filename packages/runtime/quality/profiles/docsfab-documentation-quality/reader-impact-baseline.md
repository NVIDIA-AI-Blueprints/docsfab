# Reader Impact Baseline

Use this baseline only when the selected workflow requests a reader-impact
assessment or a documentation update that carries `ReaderContextV1`. Historical
briefs and ordinary documentation jobs keep their existing inputs and behavior.

## Evidence Basis

- Assess a public-behavior change or an evidenced documentation defect against
  the admitted source comparison, current public contract, current
  documentation, and repository instructions.
- Treat source changes as evidence to inspect. A source change by itself does
  not require new documentation prose.
- State missing, conflicting, or uncertain evidence. An unusable reader
  context produces `insufficient-evidence`. So does an unknown comparison,
  unless the kept-page basis under Candidate Outcomes applies.
- Treat `impact_basis` as a candidate basis. Its digest proves identity, not
  evidence adequacy or editorial acceptance.

## Reader-Preserving Change

- Revise authoritative existing guidance proportionately to the supported
  reader impact.
- Retain setup, examples, stable anchors, validation steps, and observable
  consequences that the reader needs to complete the declared job.
- Preserve unrelated correct content and the target repository's terminology,
  structure, and formatting conventions.
- Do not restructure a long or mixed-purpose page unless the operation grants
  that scope explicitly.

## Candidate Outcomes

- Return `update-candidate` only with a concrete patch bounded to the granted
  documentation paths and evidence for the affected public behavior or defect.
- Return `no-change-candidate` only with a substantive evidence-backed adequacy
  rationale and one of these evidence bases:
  - An exact comparison with the current public contract, changed source, and
    documentation.
  - The kept-page basis, unless a base and head commit comparison declares the
    change: a plan that keeps every planned page unchanged (`retain`), each
    kept page admitted as current documentation, and the request it was
    assessed against. The rationale explains why no kept page needs a change,
    for example because the page already describes the behavior or because
    the change is internal.
- A no-change candidate is never a quality pass. Independent read-only checks
  must confirm it before it becomes a verified no-change result.
- Return `insufficient-evidence` for missing material source, conflicting
  evidence, invalid context, an unsupported conclusion, or a missing comparison
  that the kept-page basis does not cover.

A focused read-only Markdown assessment does not require an SRD, an HTML
format, `document.html`, `base.css`, or writer metadata. It never writes the
target repository, publishes content, or grants a later writer authority.
