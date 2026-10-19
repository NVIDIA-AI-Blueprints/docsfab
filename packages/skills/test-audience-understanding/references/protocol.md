# Audience-Understanding Protocol

## Contents

- Protocol boundary
- Scenario construction
- Participant preparation
- Measured phase
- Scoring and debrief
- Human and agent variants
- Question and attempt limits

## Protocol Boundary

Use a product-model interview to gather intent from creators. Use an
audience-understanding evaluation only after the intended model, target
audience, and documentation revision are explicit enough to test.

The evaluator may explain logistics, task boundaries, safety constraints, and
available tools. The evaluator must not explain the product model, identify
the answer location, confirm a substantive answer, or supply corrective hints
during measurement.

## Scenario Construction

Construct each scenario from the versioned product reference model before any
participant sees the target documentation. Record:

- A stable scenario ID and version.
- The audience and declared prerequisites.
- The quality dimensions and model claims being tested.
- A neutral prompt and realistic starting point.
- An oracle locator and acceptance criteria.
- Acceptable variants and disqualifying misconceptions.
- The allowed documents, tools, time boundary, and safety boundary.
- Whether the scenario measures teach-back, relationships, boundaries,
  prediction, counterfactual reasoning, transfer, findability, or task use.

An oracle should describe required meaning, not demand one exact phrasing.
When sources disagree or the reference model lacks the answer, route an oracle
finding before testing the scenario.

## Participant Preparation

Match participants to the declared audience rather than choosing whoever is
available and relabeling the result. Record prerequisite evidence and material
deviations.

For a human, use a pseudonymous participant ID in the evaluation artifact and
store any identity mapping only in an approved research location. Record a
consent locator, attribution choice, recording mode, and retention boundary.

For an agent, create a new context. Do not include the authoring transcript,
source threads, private reference model, expected answers, earlier reviewer
findings, or prior evaluation results unless the intended audience would
receive that information. Record the exact model and harness configuration.

## Measured Phase

Use this sequence:

1. Confirm logistics and begin recording.
2. Expose only the realistic entry point and allowed corpus.
3. Present one neutral prompt.
4. Let the participant search, navigate, reason, or act without substantive
   help.
5. Ask where the evidence came from and how confident the participant is.
6. Preserve the raw response and observable actions.
7. Continue only through the frozen scenario and attempt limit.
8. Mark the measured phase complete before opening the oracle.

Record silence, abandonment, inability to locate evidence, and unsafe action
as observable outcomes. Do not reinterpret them as missing data.

If a participant asks for clarification, restate task mechanics without adding
product meaning. Record the clarification. If the prompt itself is ambiguous,
classify it as an evaluation defect and do not score the participant against
the hidden interpretation.

## Scoring and Debrief

Score after measurement against explicit criteria. Record at least:

- Factual correctness within the tested scope.
- Required relationships and causal structure.
- Boundary, invariant, and exception recognition.
- Prediction or transfer result.
- Evidence location and authority use.
- Confidence calibration.
- Misconceptions and their severity.
- Assistance or safety interventions.

Do not use one opaque comprehension percentage. Preserve item-level results
and population-level measures with their sample sizes.

After scoring, debrief the participant. Reveal the intended model, ask what
was confusing or missing, and capture suggested improvements. Debrief evidence
can explain a finding but cannot change the original attempt.

## Human and Agent Variants

Human results support claims about the sampled human audience. They can expose
language, conceptual, accessibility, confidence, and workflow problems that a
clean agent cannot establish.

Agent results support claims about the recorded model and configuration. Use
multiple runs for material stochastic outcomes. Preserve queries, retrieval,
tools, actions, and responses so a failure can be attributed to documentation,
retrieval, model behavior, tool behavior, or the evaluator.

Never combine the two populations into one pass rate. Compare them to identify
representation or consumer-specific differences.

## Question and Attempt Limits

Freeze these limits before the first measured attempt:

- Scenario IDs in scope.
- Maximum prompts and follow-up probes per scenario.
- Maximum attempts per participant.
- Human sample target and agent repeats per configuration.
- Time or cost budget.
- Early-stop conditions for safety, contamination, or systemic failure.

The evaluation ends when the planned corpus is exhausted or a stop condition
is reached. New questions belong in a versioned later corpus rather than an
unbounded extension of the current interview.
