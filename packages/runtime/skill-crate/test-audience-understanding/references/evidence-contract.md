# Audience-Understanding Evidence Contract

## Contents

- Output artifact
- Evidence status
- Contamination
- Measures
- Finding ownership
- Integration

## Output Artifact

Write one JSON artifact per bounded evaluation run using
`docsfab.quality.audience-understanding-evaluation/v1`. Store raw transcripts,
responses, navigation traces, tool logs, and recordings separately under the
approved evidence boundary. Use immutable locators from the JSON rather than
embedding sensitive or voluminous content.

The artifact must bind:

- Documentation, repository, product, reference-model, and scenario-corpus
  versions.
- Audience, prerequisites, realistic entry point, allowed corpus, and tools.
- Evaluator independence.
- Participant population and contamination state.
- Attempts, prompts, responses, evidence use, scoring, misconceptions,
  interventions, and limitations.
- Separate human and agent population summaries.
- Findings and their owning improvement loop.

## Evidence Status

Use these statuses:

- `direct-outcome-evidence`: a clean observed attempt with a valid oracle and
  inspectable evidence.
- `proxy-evidence`: an observed synthetic or otherwise indirect result that
  does not represent the declared population.
- `contaminated`: authoring context, expected answers, non-safety coaching, or
  another substantive leak can affect the result.
- `insufficient-evidence`: required target, oracle, audience, attempt, or
  evidence is missing.
- `failed-protocol`: the evaluator, harness, environment, or retention
  contract invalidated the run.

Only `direct-outcome-evidence` can directly support mental-model-transfer or
task-effectiveness claims. The overall documentation-quality evaluator still
applies the selected profile and hard gates.

## Contamination

Record whether the participant:

- Authored the documentation.
- Participated in model synthesis.
- Reviewed the documentation before the test.
- Received expected answers.
- Received private authoring rationale.
- Saw prior evaluation results.
- Received non-safety coaching during measurement.

If any condition is true, set the participant evidence status to
`contaminated`. If the state cannot be established, use
`insufficient-evidence`. Never delete the attempt to improve the reported
result.

## Measures

Keep measures tied to scenario, participant, population, and attempt. Useful
measures include:

- Required relationship accuracy.
- Boundary and invariant recognition.
- Prediction accuracy.
- Novel-scenario transfer success.
- Misconception count and critical misconception count.
- Evidence-location success and authority selection.
- Confidence minus correctness calibration error.
- Find time, completion time, navigation steps, tool calls, and retries when
  the scenario includes an experience journey.

Avoid a universal comprehension score. A profile can later define a decision
rule after calibration, but the underlying measures and failures remain
visible.

## Finding Ownership

Classify each finding as owned by one of:

- `documentation`
- `product-reference-model`
- `product`
- `delivery-or-retrieval`
- `tool-or-agent`
- `evaluation`

State the defect, evidence, severity, acceptance condition, and owner. A
finding closes only after verification or an authorized dismissal with
rationale.

## Integration

Use the validated artifact as `outcome-evaluation` evidence in the layered
documentation-quality evaluation. Map:

- Teach-back, relationship, boundary, prediction, and transfer results to
  `transferable_understanding`.
- Findability, navigation, completion, efficiency, recovery, and workflow
  results to `effective_experience`.
- Factual defects encountered during use to `trustworthy_information`
  findings; do not treat one participant response as proof of product truth.

Reference the audience-understanding artifact from the layered result rather
than copying or flattening its attempts.
