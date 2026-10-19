---
title: Evaluating DocsFab
---

DocsFab helps documentation teams turn product evidence into reviewable
documentation. A model works inside a defined workflow with task instructions,
tools, and checks. **Skills** are reusable instructions for work such as
creating or checking documentation. The command-line interface (CLI) starts a
job; the live agent keeps a conversation open against a repository. The
**runtime harness** connects the model to tools and enforces workflow contracts.
It records steps and produces a patch when writing is authorized. Refer to
[DocsFab Architecture](../../reference/architecture.md) for the product boundaries.

Evaluation asks whether DocsFab completed useful work and what its workflow
added compared with the same agent and model under simpler conditions. These
questions need different evidence.

## Begin With the Claim

Name the claim before choosing a check. A focused test can establish a narrow
contract; a complete workflow case can show that a selected task worked through
an entry point. Neither alone proves broad quality or reader success.

The following table compares what an isolated check can show with what needs
broader evidence.

| Surface | What an isolated check can show | What needs broader evidence |
| --- | --- | --- |
| Skills | Required instructions and response guidance appear in the skill. | An agent follows those instructions on a task. |
| CLI | Help, argument parsing, and command boundaries behave as expected. | An installed command completes a documentation job. |
| Runtime harness | Controlled model and tool events satisfy response and record contracts. | A workflow completes and leaves the intended repository artifacts. |

For example, a test can confirm that a skill instructs the agent to cite source
evidence. It cannot establish that the agent finds the right source or preserves
correct content on a new task. Choose an oracle that observes the behavior named
in the claim.

## Check a Complete Workflow

A complete case follows one task through an entry point and inspects the
result. In the illustrative Sprout fixture, the program's default is `friend`
and its JSON property is `message`. The quickstart incorrectly says `world`
and `greeting`.

The quickstart prints these incorrect examples:

```text
Hello, world!
{"greeting":"Hello, Ada!"}
```

The source instead produces:

```text
Hello, friend!
{"message":"Hello, Ada!"}
```

A review task should report both conflicts and leave every file unchanged. An
update should correct both examples and preserve the working commands,
links, and unrelated correct guidance. A patch that fixes the facts but
removes the working greeting command is not a correct artifact.

The local workflow protocol applies four tasks, create, review, update, and
restructure, through `docsfab run` and `docsfab live-agent`. This defines eight
task-entry combinations. It is a fixture protocol, not a pass rate or evidence
that every combination succeeded. The matrix answers whether these tasks work
on this fixture through these entry points. It does not establish performance
across arbitrary repositories, models, or routes.

Execution success and artifact correctness are separate. A useful partial edit
after a failed workflow step remains a failed workflow case. Conversely, a
workflow can finish while its artifact contradicts source evidence or loses
correct content. A green component suite can coexist with a failed integrated
case because the checks observe different boundaries.

## Keep Four Results Separate

Record execution, artifact correctness, quality, and reader success as separate
results. One cannot substitute for another. The following table lists the
four results.

| Result | Question | Observable evidence |
| --- | --- | --- |
| Execution | Did each required workflow step finish? | Run and step status. |
| Artifact correctness | Does the result meet the task's factual, preservation, and format requirements? | Source comparison and artifact checks. |
| Quality | Does an independent evaluation find the result accurate, complete, and clear against stated criteria? | Evaluation and its criteria. |
| Reader success | Can a representative reader use the result to complete a task? | A defined reader task and its observable outcome. |

The following illustrative combination shows how the outcomes can coexist; it
is not a literal run record.

| Check | Result | Meaning |
| --- | --- | --- |
| Execution | Succeeded | The workflow steps completed. |
| `qualityArtifactValidation` | `passed` | The report satisfies its artifact contract. |
| Model-authored quality finding | `quality-evaluation.fail`; `material-omission` | The advisory evaluation flags a possible quality problem. |
| Product disposition | `inconclusive` | The evidence does not establish release acceptance. |

Report validity, the advisory quality judgment, and release acceptance are
separate conclusions. A valid report does not turn an advisory model finding
into an independent product verdict.

For full-artifact evaluation routes, the retained run record seals
`qualityArtifactValidation.hostDerivationCounts` with counts for host metadata
changes, rule-derived changes, removed duplicate limitations, and coherence
labels. The record includes zero counts and does not retain the raw candidate.

Reader success needs a concrete task. For example, ask a new user to run the
documented command and parse the documented JSON `message` property. Observe
whether the user can complete both actions. Fluent prose or a high quality score
cannot predict that outcome. For distinctions among product quality, approval,
and audience evidence, refer to
[Reading a Result](../../about/core-concepts/documentation-quality.md#reading-a-result).

To inspect a saved run, list and show it with the local state directory:

```bash
docsfab runs list --state-dir /absolute/path/to/run-state
docsfab runs show RUN_ID --state-dir /absolute/path/to/run-state --json
```

Choose `RUN_ID` from the `runs list` output. The JSON result is a summary
envelope, not a raw record or full chat transcript. Use saved fields to support
claims about recorded statuses and events. If a value was not retained, report
it as unavailable. The summary cannot establish what an omitted transcript,
tool result, or raw output contained.

Expected `needs-input` and `verified-no-change` outcomes also need evidence.
Use `needs-input` only when required information is missing. A generic stop or
operational error does not qualify. Count no change as correct only when the
task expects it and the evidence supports leaving the documentation unchanged.
An empty patch alone proves neither outcome. Refer to
[Stop Classes in DocsFab](../../reference/status-and-configuration/stop-classes.md)
for how DocsFab names and handles stops.

## Diagnose Structured Responses in Layers

When a workflow rejects a structured response, inspect each encoding layer.
For example, this outer JSON is syntactically valid:

```json
{"evaluation":"{\"decision\":\"pass\"}"}
```

Its `evaluation` value is a string containing another JSON document. The
consumer must decode that value, check the required fields, and compare the
result with the intended content. Outer parsing can pass while nested decoding
fails; both can pass while required content is changed. Record the failing
layer: outer JSON parsing, contract validation, nested JSON decoding, or
content comparison.

This diagnosis identifies the seam to reproduce. It does not, by itself,
explain why a provider produced the response or establish a general model
limitation.

## Save a Small Evidence Bundle

Keep the question, method, result, and limits beside the run summary and the
patch or report that you inspected. Record the model and route, settings,
repository and DocsFab revisions, task or stimulus, repetitions, and scoring
method. Mark missing records or reader observations as unavailable. Treat this
as an organizing practice, not a built-in export format.

## Compare Models and Runtime Conditions Carefully

A result belongs to one task, model and route, execution mode, set of
instructions, and budget. To compare models, hold the task and harness
conditions steady. To compare workflow value, hold the model and task steady
while changing the workflow condition. Record these conditions with each
result.

A runtime-value comparison can use three conditions: a basic agent, the same
agent with standalone documentation skills, and DocsFab's normal workflow.
Give each condition the same task and repository, comparable budgets, and the
same independent scoring criteria. Keep failed attempts in the denominator;
record time, model use, and human intervention. Repeat tasks before
interpreting small differences. One run can expose a failure mode, but it
cannot establish that DocsFab is better or worse in general.

For methods and evidence limits, refer to the
[quality reference](../../reference/quality/index.md). State the question, the
conditions being compared, the evidence that decides success, and the limits
on the conclusion.
