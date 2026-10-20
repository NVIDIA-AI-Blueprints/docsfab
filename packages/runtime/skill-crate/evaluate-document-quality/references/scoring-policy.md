# Scoring policy

Select exactly one versioned YAML file under `packages/quality/rubrics/` from
the target's evidenced content type and approved profile. The selected file is
authoritative for the rubric id, dimension weights and criteria, pass
threshold, conditional-pass policy, required sections, and hard gates. Do not
copy those values into the report template, infer them from another content
type, or reuse task-guide weights as a default.

Apply the selected file's hard gates before totaling scores. If selection is
missing or ambiguous, return `insufficient-evidence` and an unavailable score.
Do not create `quality-score.json` until a rubric is selected.

Use benchmark examples to calibrate deductions. Scores are evidence-backed measurements, not expressions of preference.

Meeting the numeric threshold makes `pass` eligible; it does not force the
Evaluator to pass the document. The Evaluator can retain an evidence-backed
`fail` or `human-review` when unresolved quality risk remains. The deterministic
validator checks eligibility and explicit contradictions without deriving the
final decision from the total alone.

Interpret a valid 0-100 total as Green for 80-100, Yellow for 60-79, or Red for
under 60. This display band does not replace the selected rubric's pass
threshold or decision rules.

When evidence supports them, add separate editorial diagnostics for
Correctness, Clarity, Consistency, Terminology, Tone of Voice, Inclusive
Language, and Scannability. Add Flesch Reading Ease, Informality Index, and
Liveliness Index only with their method, inputs, result, and evidence locator.
Map these diagnostics to existing rubric or layered dimensions where useful,
but do not roll them into a second overall score. Mark unsupported diagnostics
unavailable.
