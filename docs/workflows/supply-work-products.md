---
title: "Supply Requested Work Products in DocsFab"
description: "Fill named file or text inputs for the exact editorial job that stopped with needs-input."
status: draft
content.type: how-to
---

Fill named file or text inputs for the exact editorial job that stopped with needs-input.

## Prerequisites

Keep the repository, state directory, and run ID of the stopped job. Identify the named file or text slot in PRODUCT.

## Steps

Complete the following steps for the selected task.

1. Read PRODUCT and copy the printed NEXT command for the retained run.
2. Use `docsfab do --continue <run-id> --attach <path>` to supply a tracked repository path or an accepted operator file. Repeat `--attach` for each file. Supply a reply sentence when the open slot accepts text.
3. Inspect the continued result. `--continue` is required when more than one editorial needs-input run is open. When exactly one is open, a reply or attachment can select it implicitly.

Continuation keeps the original instruction digest. An unchanged workspace snapshot and plan binding skip replanning; a changed snapshot is revalidated. CREATE source-support recovery separately replans with the added tracked source. A text fill cannot certify verified no-change.

## Supply Work Products After a Job Starts

`docsfab do` and `docsfab run` share one after-the-job-starts
`needs-input` loop. It is not the routing-time `do` stop that prints
`Outcome route: needs-input` before any catalog job starts. Refer to
[A Run Stops With needs-input](../troubleshooting.md#a-run-stops-with-needs-input)
for that classification miss.

After a catalog job has started, DocsFab can ask for named work products.
Read the PRODUCT shopping list, process exit 2, and the printed NEXT
command. `docsfab doctor` is not that editorial continuation.
`docsfab do` does not grow `--reader-source` or comparison flags.

`docsfab run` remains the explicit CI evidence-flag surface. Keep
`--reader-source`, `--comparison-base`, and `--comparison-workspace` on
named `update-documentation` runs when a script must bind evidence without
waiting for an ask.

First-pass knowledge stops remain a different door. Resume those with
`--resume-from` and an attributed snapshot as described in
[Answer and Resume a Stopped Job in DocsFab](answer-and-resume.md). For the update
editorial gate, refer to
[Update Documentation Workflow in DocsFab](../reference/workflow-contracts/update-documentation.md).

## Forge-Bound Continuation

A run grounded on a GitLab merge request or a GitHub URL cannot be continued yet. DocsFab returns `continue-binding-forge-unsupported` and leaves the run open. Start a new run naming the same `--pr` or `--change` selection. A continued local commit-range run instead rebinds the original stopped range; reply without supplying a new `--change`.

## Reply in a Live Session

A slot that asks for a file, such as the source slot a create workflow
opens when its bound sources do not support a page, takes a reply that
is exactly the repository-relative path of a file in the checkout, for
example `README.md`. That reply continues the same job with the file
named as an approved source. A sentence cannot fill a file slot, so it
reaches the agent as an ordinary message instead. During that turn DocsFab
refuses direct `edit`, `write`, and host commands, so the open input is never
bypassed by an unverified edit, and the turn ends with a reminder that the
stopped run still needs its named input.
