---
title: "Answer and Resume a Stopped Job in DocsFab"
description: "Resume the original create or update job after an accountable participant supplies an attributed snapshot for its durable knowledge stop. For an editorial request for named files or text, follow Supply Requested Work Products."
status: draft
content.type: how-to
---

Resume the original create or update job after an accountable participant supplies an attributed snapshot for its durable knowledge stop. For an editorial request for named files or text, follow [Supply Requested Work Products](supply-work-products.md).

## Before You Start

Complete the steps in [Install DocsFab](../get-started/installation.md). Identify the
stopped run ID from the command that exited 2, or from `docsfab runs list`.

Confirm which stop you have before you resume. The following table lists the stops.

| Stop | How You Recognize It | What to Do |
| --- | --- | --- |
| Routing-time `do` miss | `Outcome route: needs-input`, no run ID | Restate the sentence. Refer to [A Run Stops With needs-input](../troubleshooting.md#a-run-stops-with-needs-input). |
| Editorial work products | A catalog job started. PRODUCT lists named slots. NEXT prints one command. Exit 2. | Supply the named work products from PRODUCT. Do not add `--reader-source` to `do`. Refer to [A Run Stops With needs-input](../troubleshooting.md#a-run-stops-with-needs-input). |
| Knowledge continuation | A create or update first-pass stop. `runs show` prints `Resumability:` | Continue with the snapshot steps on this page. |
| Sources disagree | A create or update first-pass stop with error `contradicted`. `runs show` prints a `FIRST PASS` section with one question. Exit 2. | Answer the question as [When the Sources Disagree](#when-the-sources-disagree) describes. No snapshot resumes this stop. |

You need an attributed snapshot file for the stopped candidate. You also
need the existing write grant for the original create or update workflow.
Keep `DOCSFAB_STATE_DIR` or `--state-dir` the same when the stopped record
is outside the default location.

`--resume-from` is valid only for `create-documentation` and
`update-documentation`. It does not support `review-documentation` or
`restructure-documentation`.

## Steps

Complete the following steps for the selected task.

<Steps>
  <Step title="Inspect the stopped run">
    Inspect the stopped run without inventing a candidate.

    ```bash
    docsfab runs show <run-id>
    ```

    Expected result: `Resumability: resumable (no-attempt-yet)` with no
    `NEXT` continuation command means the stop is eligible but has no
    accountable answer yet. `Resumability: blocked (...)` or
    `non-resumable (...)` means this is not a durable knowledge stop, is
    still active, or already completed.
  </Step>
  <Step title="Capture an attributed answer">
    Capture an attributed answer for the unresolved claim, missing support,
    or blocking conflict. Store it as a snapshot file. Do not fill the gap
    from conversational memory.

    Expected result: The snapshot is a file you can pass as
    `--canon-snapshot`. Slack is optional in the hosted product and is not
    required here.
  </Step>
  <Step title="Validate the snapshot">
    Validate the snapshot and render the exact continuation command. Supply
    the three read-only selectors together.

    ```bash
    docsfab runs show <run-id> \
      --canon-snapshot /absolute/path/to/attributed-snapshot.json \
      --accept-candidate-snapshot \
      --authority-id <accountable-authority-id>
    ```

    Expected result: DocsFab prints one parser-validated `NEXT` command, or
    it reports why the snapshot does not yet resolve the stop. Do not
    hand-type a `--resume-from` command from memory.
  </Step>
  <Step title="Copy the rendered command">
    Copy the rendered command exactly. A typical form is:

    ```bash
    docsfab run create-documentation \
      --repo /absolute/path/to/repository \
      --resume-from <stopped-run-id> \
      --canon-snapshot /absolute/path/to/attributed-snapshot.json \
      --accept-candidate-snapshot \
      --authority-id <accountable-authority-id> \
      --allow-write
    ```

    Use `update-documentation` in place of `create-documentation` when the
    stopped workflow was an update. When the stopped run selected a preset
    with `--composition` or changed a model setting with `--set`, the
    rendered command repeats them. `--instruction` is optional on a valid
    resume. If you supply it, DocsFab compares its normalized digest with the
    retained original. The default `--draft-mr` delivery supplies the write
    grant, so an explicit `--allow-write` flag is optional when that default
    is in effect. Keep `--patch-only` when the original child must stay
    publication-free.

    Expected result: Continuation starts a new child run ID. The stopped
    parent remains immutable. A completed writer is never rerun.
  </Step>
  <Step title="Inspect the child result">
    Inspect the child result.

    ```bash
    docsfab runs show <child-run-id>
    ```

    Expected result: The child uses the same repository, workflow, and
    retained instruction. Missing or mismatched current delivery authority
    returns `delivery-recovery-required`. Continuation does not widen write
    or publication authority.
  </Step>
</Steps>

## When the Sources Disagree

First pass can find repository sources that disagree on a fact a page
needs, such as a deployment file and the service source that name different
listening ports. DocsFab does not pick a side. When disagreement is the only
thing first pass could not resolve, the run stops before its first step. It
saves a `needs-input` record with error `contradicted` and exits 2. This
stop can happen on a create, or on an update of more than one page.

`docsfab runs show <run-id>` prints a `FIRST PASS` section with the following lines:

- Each disagreement and the pages it affects.
- Each source path and line range, with the value DocsFab found in that
  source.
- One question, its options, and the recommended default, which is to
  withhold the disputed section until the sources agree.

The question names a value only when DocsFab finds that exact text in its
source. Otherwise it names the paths and lines alone. The question also asks
whether anything outside the repository settles the disagreement, such as a
merge request, a release branch, a design document, or a ticket.

In the current live-agent session, a new stop with repository-only evidence
accepts one exact offered source option. You can also reply
`Use the implementation` when exactly one verified executable source span
identifies that option. DocsFab starts a successor run at the same revision
and records the choice as attributed, unverified evidence. The original stop
stays unchanged, and other disagreements still require answers.
If you reopen the same live-agent session, the saved pending offer survives.
If you start with `--new`, or if you reopen without a saved pending offer,
you must submit a new request. Conversation text alone cannot restore an offer.
An offered option that names only a path and line range also continues the
run. DocsFab records that source choice without adding a disputed value.
Successful successor patches use the authorized checkout's normal application
checks and retain their attribution. These runs remain ineligible for publication.
Failed checkout persistence or an invalid quality report keeps the attempt
failed, even when the workflow steps completed.
If you answer a saved pending offer that already has a successor, DocsFab
reports that run and any recorded checkout outcome.
If continuation is interrupted after the result is saved, inspect that run
and your checkout. DocsFab retains the saved result and reports its checkout
evidence without applying the patch again.
If that attempt fails, inspect its saved run and any retained patch, then send
your complete documentation task as a new request. The source-choice answer
does not become an ordinary retry task, including after you reopen the session.
If the attempt offers another source
question, you can answer that offered question in the same session.

Cancelling the successor stops that attempt. Inspect its saved run and any
retained patch before starting a new request. Cancellation does not remove
partial edits or start another successor from the same stopped run.

Stops with attached sources, changes, reader evidence, or conversation context
require a new request. Earlier stops without the admission record also require
a new request. If DocsFab cannot identify the exact section to withhold, name
that section in a new request. A changed checkout revision requires a new run.
An assessment that changes the original obligation's condition or target
paths also requires a new request.

No snapshot resumes this stop. To start a new run, correct the source that is
wrong in your checkout, or restate the request without the disputed value.

A stop that also lacks evidence for another requirement stays
`insufficient-evidence`, with the disagreement listed among its unresolved
obligations. So does a stop where first pass could not read a source the
request names, or reached a bound that may have left evidence unread. Its
message names that source or bound first. A stop at a first-pass bound stays
`budget-exhausted`.

## Continuation Boundaries

The stopped parent remains immutable. A continuation creates a child run and revalidates current write and delivery authority. A completed writer is never rerun. `busy` means another continuation is active. `recovery-required` means execution liveness or mutation settlement must be established before retrying. A patch-only child remains publication-free.

The three selectors passed to `runs show` validate evidence and render a command; they do not grant authority, reserve a continuation, or call a model. The selectors cannot combine with `--json`. Keep the original state directory. Refer to [Retry Evidence](../reference/status-and-configuration/retry-evidence.md) for saved attempt output.

Each continuation gets a new child run ID while the stopped parent and prior
attempts remain immutable. An active attempt reports `busy`. A demonstrably dead
owner before execution can be retried. Death or unknown liveness after
execution starts reports `recovery-required` until mutation quiescence is
established. A completed writer is never rerun. If delivery is unsettled,
continuation can call the existing publisher reconciliation only with a fresh
matching delivery grant and the exact retained delivery intent and target. It
reuses the existing publisher idempotency key, so it cannot create a second
physical publication for that key. A settled child returns its saved result as
already completed and reused in human, quiet, and JSON output. A patch-only
child remains publication-free and receives no publish suggestion. Missing or
mismatched current delivery authority or target returns
`delivery-recovery-required`; unsafe effect uncertainty returns a precise
bounded recovery result. Neither can be reported as `not-requested` or settled
success for an unsettled delivery. It does not widen write or publication
authority.

## Related

Use these topics for the supporting contracts and next actions.

<CardGroup cols={2}>
  <Card
    title="Run a Documentation Workflow in DocsFab"
    href="/workflows/run-a-documentation-workflow"
  >
    [Run a Documentation Workflow in DocsFab](run-a-documentation-workflow.md)
  </Card>
  <Card
    title="Troubleshooting DocsFab"
    href="/troubleshooting"
  >
    [Troubleshooting DocsFab](../troubleshooting.md)
  </Card>
  <Card
    title="Runtime CLI and Configuration in DocsFab"
    href="/reference/status-and-configuration/runtime-cli-and-configuration"
  >
    [Runtime CLI and Configuration in DocsFab](../reference/status-and-configuration/runtime-cli-and-configuration.md)
  </Card>
  <Card
    title="Update Documentation Beside a Change in DocsFab"
    href="/workflows/update-documentation-beside-a-change"
  >
    [Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md)
  </Card>
  <Card
    title="Gather Product Knowledge"
    href="/workflows#gather-product-knowledge"
  >
    [Gather Product Knowledge](index.md#gather-product-knowledge)
  </Card>
  <Card
    title="A Result Grants No Authority"
    href="/about/core-concepts/documentation-jobs"
  >
    [A Result Grants No Authority](../about/core-concepts/documentation-jobs.md#a-result-grants-no-authority)
  </Card>
</CardGroup>

## Earlier Section Links

<a id="continue-a-completed-quality-evaluator-refusal"></a>

Refer to [Continue A Completed Quality Evaluator Refusal](../reference/status-and-configuration/retry-evidence.md#continue-a-completed-quality-evaluator-refusal).
