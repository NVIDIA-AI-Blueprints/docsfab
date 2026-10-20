# Assurance-System Measures

These measures describe the process that preserves documentation quality. They
are operational evidence, not a document-quality layer or score. Return
`insufficient-evidence` rather than inferring a healthy system from one green
pipeline or one high-quality artifact.

| Measure | Reproducible definition | Interpretation boundary |
| --- | --- | --- |
| Required-gate coverage | Completed applicable required gates / applicable required gates | Requires a versioned applicability policy |
| Independent-review coverage | Artifacts with qualifying non-author review / artifacts requiring it | Same-session self-review does not qualify |
| Defect detection distribution | Verified findings first detected at each lifecycle gate | Movement earlier can indicate better prevention |
| Escaped-defect rate | Confirmed post-delivery defects / delivered units in the observation window | Requires active post-delivery observation |
| Verified closure rate | Findings addressed and verified / findings due for closure | Dismissals remain separate unless policy says otherwise |
| Recurrence rate | Repeated verified defect class / previously closed verified defect classes | Requires stable defect taxonomy |
| False-positive rate | Adjudicated incorrect findings / adjudicated findings | Dismissal alone is not ground truth |
| False-negative rate | Confirmed missed defects / defects observable through the defined discovery method | Usually unknowable without controlled injection or later discovery |
| Gate latency | Time from eligibility to completed gate | Report median, tail, and sample size |
| Check reliability | Successful valid executions / attempted valid executions | Separate infrastructure failure from detected documentation failure |
| Evaluation cost | Human time, compute, tokens, and service cost per evaluated unit | Compare only equivalent scope and rigor |
| Feedback routing | Signals assigned to the correct owning loop / actionable signals | Requires product, model, docs, delivery, and evaluation ownership labels |

Record the numerator, denominator, population, window, version, and evidence
locator for every ratio. Report missing or biased data explicitly.
