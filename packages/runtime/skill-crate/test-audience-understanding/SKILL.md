---
name: test-audience-understanding
description: Conduct a controlled audience-understanding evaluation with representative humans or clean agents to test whether versioned documentation transfers the intended mental model. Use for teach-back, relationship, boundary, prediction, counterfactual, or unfamiliar in-scope transfer tests when DocsFab needs direct Layer 2 outcome evidence without leaking authoring context or expected answers.
license: Apache-2.0 AND CC-BY-4.0
---

# Test Audience Understanding

Test what the documentation communicates. Do not use this protocol to gather
product intent or teach the participant during the measured phase.

## Required Inputs

- Immutable documentation revision, paths, delivery surface, product version,
  and realistic entry point.
- Versioned product reference model and approved evidence revision.
- Declared audience profile, prerequisite knowledge, allowed tools, and risk
  boundary.
- Versioned scenario corpus with prompts, oracles, acceptance criteria, and
  misconception probes created before participant exposure.
- Evaluator identity and evidence of independence from documentation
  authorship.
- Human consent and retention boundary, or clean-agent execution
  configuration and run authority.
- Applicable quality profile and evidence location.

Return `insufficient-evidence` without an authoritative model, declared
audience, immutable documentation target, or usable scenario oracle. Do not
invent expected answers from the documentation under test.

## Prerequisite Check

Before loading the full protocol or starting a participant, check the required
inputs already supplied to the run. Inspect an explicit evidence locator only
when needed to establish its identity, applicability, or validity. Do not
repeat repository discovery, search for participants, create a missing corpus
or oracle, or run yourself as a substitute participant.

When a required input is missing or invalid, stop this step with
`insufficient-evidence`. Name the missing prerequisites and preserve any known
candidate mismatch, invalid evidence, or failed prior attempt separately. State
that no new participant attempt ran. Do not fabricate a complete evaluation
artifact by inventing required identities or observations. A completed
prerequisite check is not audience evidence or a quality pass.

When prerequisites are present, use the frozen scenario corpus and sampling
policy to bound the protocol. Return a concise result and evidence locators;
retain the full required artifact, all attempts, findings, and limitations.

In a runtime step, the host-supplied response contract in the step prompt
decides the outer response shape and overrides any output described in this
skill. For example, the update workflow's independent editorial assessment
requires `{summary, editorialAssessmentProposal}`. Put the result where that
contract places it; do not return the evaluation artifact as the top-level
object unless the contract asks for it.

## Workflow

1. After the prerequisite check succeeds, read
   [references/protocol.md](references/protocol.md),
   [references/evidence-contract.md](references/evidence-contract.md), and
   [references/experience-methods.md](references/experience-methods.md) when
   the scenario includes finding, applying, or recovering with information.
2. Freeze the target, reference model, audience profile, scenario corpus,
   evaluator, evaluation version, and retention boundary.
3. Confirm each scenario tests a relationship, boundary, prediction,
   counterfactual, or unfamiliar in-scope application. Treat verbatim recall
   as retrieval evidence, not understanding evidence.
4. Confirm every participant matches the declared audience well enough for
   the result to be interpretable.
5. For a human, record consent without placing unnecessary personal data in
   the result. For an agent, start a fresh context and preserve provider,
   model, system-instruction hash, retrieval configuration, tools, context
   budget, and run ID.
6. Exclude participants that authored, synthesized, or reviewed the target
   from clean direct-outcome evidence. Also exclude agent contexts exposed to
   expected answers, private authoring rationale, or prior evaluation results.
7. Begin at the declared realistic entry point. Let the participant locate
   the applicable information rather than supplying an answer page unless a
   direct link is the normal experience.
8. Present neutral prompts one at a time. Record the prompt, participant
   response, evidence they relied on, confidence, actions, timing, and any
   safety intervention.
9. Do not correct, coach, reveal the oracle, or reflect the intended model
   during measurement. If safety requires intervention, stop the affected
   attempt, record it, and do not count that attempt as an unassisted success.
10. End the measured phase before scoring or debriefing. Compare responses
    with the frozen oracle and acceptance criteria; record correctness,
    relationships, boundaries, predictions, transfer, confidence calibration,
    evidence use, and misconceptions.
11. Debrief only after the measured attempt is immutable. Record corrections
    and participant reflections as follow-up evidence without rewriting the
    attempt.
12. Preserve human and agent attempts separately. Repeat material clean-agent
    scenarios under the declared sampling policy rather than generalizing from
    one stochastic run.
13. Produce an artifact conforming to
    `../../quality/schemas/audience-understanding-evaluation.schema.json` and
    validate it with
    `../../quality/checks/validate_audience_understanding_evaluation.py`.
14. Pass the validated evidence to `review-documentation` as direct
    outcome context and to `evaluate-document-quality` as a separately
    identifiable audience-evidence artifact.

## Question Design

Prefer prompts such as:

- Explain how two components, states, or concepts relate.
- Identify a boundary, invariant, exception, or non-goal.
- Predict what happens when a named condition changes.
- Explain why a design or workflow behaves as documented.
- Apply the model to an unfamiliar but explicitly in-scope situation.
- Locate and cite the documentation evidence used to reach the answer.

Avoid wording copied from the answer, leading yes-or-no questions, trivia that
only tests recall, and scenarios whose correctness depends on unpublished
assumptions.

## Evidence Rules

- Label a clean observed attempt as direct outcome evidence only after the
  artifact passes structural and semantic validation.
- Label expert prediction, same-session self-review, or synthetic scoring
  without an observed attempt as proxy or grounded-judgment evidence.
- Mark answer leakage, non-safety coaching, prior authoring context, or an
  unknown independence state as contamination. Preserve the attempt, but do
  not use it to support a pass.
- Keep human and agent population summaries separate. Do not calculate a mixed
  average that hides a failure in either population.
- Compare confidence with correctness; fluent or confident responses are not
  evidence of understanding by themselves.
- Create findings for documentation, reference-model, product, retrieval,
  delivery, tool, or evaluation defects and route them to the owning loop.
- Preserve `insufficient-evidence` and `not-assessed` as distinct from failure.
- Do not edit, publish, commit, push, or merge the documentation under test.

## Stop Conditions

Stop the affected evaluation and report the boundary when:

- Consent, run authority, or the retention boundary is missing.
- The target or oracle changes after exposure begins.
- The participant receives expected answers or non-safety coaching during the
  measured phase.
- A safety intervention invalidates continued unassisted measurement.
- The environment cannot expose the declared documentation revision.
- Two consecutive attempts fail because of the same evaluator, harness, or
  environment defect.

Do not turn an open-ended evaluation interview into an indefinite discovery
conversation. The frozen scenario corpus and sampling policy define the
question and attempt limits.
