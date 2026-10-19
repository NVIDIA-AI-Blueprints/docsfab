---
title: Update Documentation Beside a Change in DocsFab
description: Run a bounded documentation update against an approved product change.
status: draft
content.type: how_to
---

As an engineer, you can use DocsFab to keep documentation current with an
approved product change. DocsFab assesses the smallest documentation set that
change affects and returns a reviewable patch. You inspect that patch locally,
then you can open one draft merge request when delivery prerequisites pass.
The host does not open a merge request after every merge. For more
information, refer to [About DocsFab Workflows](index.md).

Use `docsfab run update-documentation` when you must bind reader evidence.
Use `docsfab do` for a one-shot English request. Use `docsfab live-agent`
when the task needs a conversation. Refer to the
[update-documentation contract](../reference/workflow-contracts/update-documentation.md)
for the fixed paths and editorial outcomes.

## Before You Start

Complete the steps in [Install DocsFab](../get-started/installation.md). Prepare a local Git
repository that contains the product and documentation DocsFab should use as
evidence.

Run the offline readiness check and inspect the catalog:

```bash
cd /absolute/path/to/input-repository

docsfab doctor
docsfab list
```

Expected result: Doctor reports ready conditions. `docsfab list` includes
`update-documentation`.

Confirm the following inputs:

- An approved product, API, configuration, or behavior change.
- The current documentation pages that change can affect.
- Tracked repository-relative paths when you bind `--reader-source`.

`--reader-source` is valid only on `docsfab run update-documentation`.
`docsfab do` does not grow that flag. Do not combine `--reader-source` with a
date-scoped merged-merge-request instruction. That discovery path is on the
[Runner Quickstart](../get-started/runner-quickstart.md).

Only the default draft merge request flow requires all of the following delivery conditions:

- The target repository has an `origin` remote (or `--remote <name>`).
- `glab` is authenticated for the GitLab host used by `origin`.
- You have permission to push a branch and create a merge request.

Tracked local changes stay in place; delivery writes from GitLab's
target-branch revision, so a dirty checkout does not block `--draft-mr`.

## Steps

Complete the following steps for the selected task.

<Steps>
  <Step title="Choose local delivery">
    Choose the local delivery that matches the authority you have. Keep the
    result as an inspectable patch unless you intend to open one draft merge
    request.

    ```bash
    docsfab run update-documentation --help
    ```

    Expected result: Help lists `--patch-only`, `--dry-run`, `--source`,
    `--reader-source`, `--comparison-base`, and `--comparison-workspace` on this
    workflow.
  </Step>
  <Step title="Bind reader evidence">
    Bind reader evidence on a named run. Repeat `--reader-source` for each
    tracked path. Supported roles are `public-contract`, `changed-source`,
    `current-documentation`, `repository-instruction`, `accepted-knowledge`,
    and `request`.

    ```bash
    cd /absolute/path/to/input-repository

    docsfab run update-documentation \
      --patch-only \
      --instruction "Update the authentication guide for the approved API change. Keep unrelated pages unchanged." \
      --reader-source current-documentation=docs/authentication.md \
      --reader-source changed-source=src/auth.ts \
      --reader-source public-contract=docs/api/auth.md
    ```

    Replace the instruction and paths with your approved change. Do not pass
    placeholder tokens as the instruction.

    Expected result: The run plans from the bound sources, then either retains
    a local patch or reports an evidence-backed limitation. `--patch-only`
    does not apply the patch to your checkout or open a merge request.

    You can add `--comparison-base` or `--comparison-workspace` to the same
    named run when you need an exact comparison. To request a commit
    comparison, provide two full Git object IDs:

    ```bash
    docsfab run update-documentation \
      --patch-only \
      --instruction "Assess the documentation for this change" \
      --revision <head-object-id> \
      --comparison-base <base-object-id>
    ```

    Use `--comparison-workspace` instead when you need comparison against the
    current workspace snapshot. The two comparison forms are mutually
    exclusive. If neither is present, comparison scope remains unknown. A
    run without a comparison can still end `verified-no-change` when its plan
    keeps every page unchanged with admitted evidence, as
    [Reach a Verified No-Change Result](verify-no-change.md#reach-a-verified-no-change-result)
    describes.
  </Step>
  <Step title="Bind the change as a diff">
    A comparison records which revisions you mean, but the planner does not
    read a diff from it. To give the planner and writer the change itself,
    bind it with `--change`, which reads a local range, a GitLab merge
    request, or a GitHub pull request or commit; refer to
    [Bind a Local Commit Range](bind-commit-range.md#bind-a-local-commit-range).
    A diff you already have works too: commit it as a unified diff and bind
    it with `--source`. Both read through the same diff extractor. DocsFab
    accepts `git diff` output, `git format-patch` patches and series, and
    plain `diff -u` output in a `.diff` or `.patch` file. The file must be
    committed at the revision the run reads, so pass the commit that adds it
    as `--revision`.

    ```bash
    git diff <base-object-id> <head-object-id> > changes/auth-change.diff
    git add changes/auth-change.diff
    git commit -m "Record the authentication change for documentation"

    docsfab run update-documentation \
      --patch-only \
      --instruction "Update the authentication guide for the change in changes/auth-change.diff." \
      --source changes/auth-change.diff \
      --revision "$(git rev-parse HEAD)" \
      --comparison-base <base-object-id>
    ```

    Expected result: Source acquisition reads the diff at the selected
    revision. Its first spans are a manifest that lists every file with its
    change kind, paths, added and removed line counts, hunk count, and labels
    such as `binary`, `lockfile`, `vendored`, and `generated`. Each patch's
    message, each file header, and each hunk follow as spans that hold the
    diff's exact bytes, line endings included. The planner reads the
    manifest, then reads one file or hunk by its number in the manifest, and
    the writer cites the hunks it used. A line longer than 16,384 bytes, such
    as a minified bundle or a lockfile entry, stays readable as consecutive
    spans of the same hunk.

    DocsFab refuses a diff that it cannot bind whole before any model call,
    with `input-over-limit` and the bound that stopped it:

    - The file is larger than `sources.extractionMaxOriginalBytes` (4 MiB). Raise
      `DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES`, or bind a narrower
      range.
    - Its extracted text is larger than `sources.extractionMaxDerivativeBytes`
      (1 MiB). Raise `DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES`, or bind
      a narrower range.
    - It needs more spans than `sources.extractionMaxSpans` (2,048), even after
      the files with the most hunks are read as one span each. Bind a narrower
      range, or split the diff into several files.

    A file that DocsFab reads as one span answers a hunk request with the
    whole file. DocsFab does not extract the encoded payload of a Git binary
    patch or other text that is not UTF-8, such as a hunk body, a combined
    diff body, or a patch message. It labels the file `binary` or `non-utf8`,
    counts what it left out in the manifest, and records
    `non-text-content-excluded`. The diff still binds, and the run's source
    evidence reports a read of it as `partial`, not `considered`. A file
    header line, such as `diff --git` or `+++`, that is not UTF-8 refuses the
    diff with `extractor-limitation`.

    The manual post-merge CI assessment binds each changed file whose
    extension `--source` accepts, so a change set that adds or edits a
    `.diff` or `.patch` file now binds that file as evidence too.
  </Step>
  <Step title="Run a one-shot English request">
    For a one-shot English request without `--reader-source`, use `docsfab do`.
    Preserve an explicit publication prohibition in the instruction, and still
    pass `--patch-only` to select local delivery.

    ```bash
    docsfab do \
      "Update the authentication guide for the approved API change. Keep the result local; do not publish." \
      --patch-only
    ```

    Expected result: DocsFab classifies the sentence to `update-documentation`
    and runs that job. If the sentence says not to publish while flags select
    default merge request delivery, DocsFab stops before workflow execution.
  </Step>
  <Step title="Start a conversation">
    For a conversation, start the live agent from the same repository and
    describe the approved change in ordinary language.

    ```bash
    docsfab live-agent
    ```

    Expected result: The agent can start `update-documentation` when the
    request matches that workflow. It does not add `--reader-source`.
  </Step>
  <Step title="Inspect the run record">
    Inspect the terminal `VERDICT` and the private run record. Use the paths
    printed under `PATCH` and `RECORD`.

    ```bash
    docsfab runs show <run-id>
    ```

    Expected result: The record names `update-documentation`, the target
    revision, and an editorial outcome such as `executed-update`,
    `update-recommended`, `verified-no-change`, `insufficient-evidence`, or
    `unavailable`. Text or paraphrase cannot certify no-change.
  </Step>
  <Step title="Optional: open a draft merge request">
    After a successful write, open one draft merge request through the
    default delivery path. First satisfy the delivery prerequisites, remove
    any publication prohibition from the instruction, and omit `--patch-only`.

    ```bash
    docsfab run update-documentation \
      --instruction "Update the authentication guide for the approved API change."
    ```

    Expected result: DocsFab creates a branch and opens one draft merge
    request. That projection cannot merge the result. To recover a succeeded
    write without another model call, run:

    ```bash
    docsfab ship <run-id> --repo /absolute/path/to/target-repo
    ```
  </Step>
</Steps>

## Read the Change's History

A `docsfab run update-documentation` run reads the local checkout's git
history behind the target revision. The planner and the writer can list the
commits that changed a path, diff an earlier commit against the target
revision, read a file as it was before the change to learn the behavior it
replaced, blame a range of lines to find the commit that last changed
each one, and search for the commits that added or removed a symbol or
message. Only the target revision and its ancestors can be read, and the
run record cites every history page a step read. `--comparison-base` still
records only the comparison you requested; it does not name a revision for
these tools.

A shallow clone, such as a CI checkout fetched with a depth limit, holds no
history older than its cut. The planner reports that as a `history-shallow`
limitation, a blamed line older than the cut is attributed to the cut commit
and labelled the same way, a search charges the cut commit with every older
addition of the string, and a read of an older commit returns
`history-object-missing`.
Deepen the checkout with `git fetch --deepen` or `git fetch --unshallow`
before the run when the change reaches past the cut. Refer to
[Git History Tools in DocsFab](../reference/knowledge-and-delivery/git-history-tools.md).

## GitHub Change Sources

Follow [GitHub Change Sources](bind-github-change.md) for the supported selections, evidence binding, and refusals.

## Repository-Required Checks

A repository instruction file, such as `AGENTS.md`, can require a check before
you propose a change. For example, the instruction "Run
`python3 -m unittest discover -s tests` before proposing a documentation
change." makes that command a requirement of every update proposal.

DocsFab handles the requirement in the following way:

- Every workflow step receives the instruction file as the repository's
  contributor conventions, between two DocsFab notes. The notes say that the
  file governs the documentation content and style, that the step has no
  conversation and no command tool, and that DocsFab runs the repository's
  checks itself. The writer's notes also name each required check and say
  that DocsFab runs or reports it after the writer changes the documentation.
- The planner records the check as validation for the proposal. Planning does
  not stop only because a read-only planner cannot run the check.
- After the writer changes the documentation, the `lint-documentation` step
  runs the check in the read-only, offline check executor. It accepts only
  `python3 -m unittest`, `python3 -m pytest`, `npm`, `pnpm`, or `yarn` with
  `run <script>` or `test`, and `make <target>`. No shell runs instruction
  text. The executor's `PATH` includes `/usr/local/bin`.
- The checked copy of the repository has no Git metadata of its own, so the
  executor presents read-only Git metadata for it: a throwaway repository with
  one commit of the checked tree, and no remote, configuration, or hooks. A
  check that calls Git, such as `git ls-files`, runs against the checked tree.
  Files that the executor hides because they can hold credentials, such as
  `.netrc` or `.config`, are left out of that commit and ignored, so a check
  such as `git status --porcelain` sees a clean tree.
- Before a check runs, DocsFab confirms that the check can start in the
  executor:
  - The command's program is installed.
  - For an `npm`, `pnpm`, or `yarn` script, the first program the script
    starts is installed in a `node_modules/.bin` directory or on the
    executor's `PATH`. DocsFab checks this only when that program's failure
    would end the script: the script is that one command, or that command
    followed by `&&`, with no `||`, `;`, `&`, `if`, or `!`. A Yarn Plug'n'Play
    project finds its own programs, so DocsFab skips this step for it.
  - For `python3 -m pytest`, the module is installed.
  - For `make <target>`, the one program that the target's recipe starts is
    installed on the executor's `PATH`, or its path exists. DocsFab checks
    this only for a simple recipe:
    - The `Makefile` is the repository's own, unchanged by the run.
    - It has none of the constructs that make a dry run differ from the real
      run, or that hide which command decides the result. These include
      `include`, `define`, `$(shell)`, `$(info)`, `$(eval)`, `$(MAKE)`,
      `MAKEFLAGS` or `MAKECMDGOALS`, a `-` or `+` recipe prefix, a
      target-specific variable, `.ONESHELL`, and a change to `PATH`.
    - GNU make's dry run (`make --dry-run --trace <target>`), which DocsFab
      runs inside the executor, lists exactly one recipe line for the target.
    - That line is one simple command, with no `&&`, `||`, `;`, pipe,
      subshell, or `cd`.

    Make reads the `Makefile` inside the executor during the dry run. For any
    other `make` check, or when the dry run fails, the check runs as usual,
    so a check that fails is still refused.

  DocsFab reads the command, the repository's `package.json` and `Makefile`,
  and make's dry-run listing. It never reads the output of the check itself.
- Every required check runs. Each check command can run for 10 minutes by
  default (`checks.commandTimeoutMs`). The run record keeps the first and last
  8 KiB of each command's output (`checks.outputRetainedBytes`) and names the
  bytes in between that it omitted. Output volume never stops a check. When no
  required check can run, DocsFab prepares no executor.
- If DocsFab cannot remove the executor's scratch directory or Git metadata
  afterward, the `lint-documentation` evidence records the error code under
  `sandboxCleanup`, and the run continues. Docker Desktop checks require proof
  that their container stopped and was removed. A failed Docker teardown
  cannot establish passing check evidence.
- When every required check passes on the exact tree that DocsFab proposes,
  the run succeeds. On macOS, the evidence names the Docker Desktop backend
  and digest of its private, credential-hidden view. A test result that a model
  reports is not check evidence.

When the writer changes no file while it holds the instruction file and the
plan has a page to write, the run stops with `needs-input` after the write
step instead of running the remaining steps to an empty result. The writer's notes ask it to change
nothing only when the file requires something that only you can provide, and
then to reply with the instruction and one question. PRODUCT shows the
writer's reply, and NEXT prints a rerun template. Add the answer to the
instruction, or amend the instruction file, and start a new run. The notes
also tell the writer that a check, an acknowledgement, or a canary line never
needs your answer.

### When a Required Check Cannot Run

When DocsFab cannot run a required check, or the check does not finish within
its time limit, the run still succeeds and keeps the patch for delivery,
including `--draft-mr` and `docsfab ship`. The run records one limitation for
each such check, as in the following example:

```text
required check could not run: `ruff format .` (unsupported check form). Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change.
```

The limitation appears in the following places:

- The run record, and the **LIMITATIONS** section of the run output and of
  `docsfab runs show <run-id>`.
- The `--json` result, where `product.limitations` includes
  `required-check-not-run` and `nextSteps` includes each limitation line.
- The **Notes** section of the draft merge request that DocsFab opens, and its
  **Limitations** field. The lines come first in the section, before any
  credential-like content that DocsFab flags. If the lines do not fit the
  description, a note after them gives the number left out and the
  `docsfab runs show <run-id>` command that lists them all. If not even that
  note fits, the section leaves the lines out, and the **Limitations** field
  still names `required-check-not-run`. A line that holds a credential
  DocsFab is configured with, a host path, a line break, or an issue
  reference is not shown. One note counts those lines and gives the same
  command. An issue reference is `#` followed by a digit, an issue or work
  item URL, or a key such as `KEY-123`. The command and the instruction file
  come from the repository, and GitLab reads a closing keyword such as
  `Closes` beside an issue reference, even in code formatting, and closes the
  issue when the merge request merges. A line that only looks like it holds a
  credential is shown, and the section flags it at
  `publication:requiredCheckLimitations`.
- The Slack reply to a hosted update request. If the lines do not fit the
  reply, it gives their number instead.

The run records no failure class, so `docsfab why` does not attribute the check
to the model.

The following table lists the reasons a limitation can name.

| Reason | Cause |
| --- | --- |
| `unsupported check form` | The command is outside the supported forms, for example `mise run pre-commit`, `uv run pre-commit run --all-files`, or `ruff format .`. The check does not run. |
| `no check isolation on this host` | Linux uses bubblewrap with working user namespaces. macOS uses the pinned Docker Desktop image. If the selected backend, image, or readiness probe is unavailable, DocsFab starts no repository check command and records a platform remedy. Other platforms have no admitted backend. |
| `dependency unavailable` | Before the check runs, DocsFab finds that a program or module it needs is not installed in the executor: the command's own program, the first program an `npm`, `pnpm`, or `yarn` script starts, the module that `python3 -m pytest` runs, or the one program that a simple `make` target's recipe starts. The check does not run. |
| `git metadata unavailable in the check sandbox` | DocsFab could not present Git metadata for the checked copy. No check runs. |
| `network unavailable in the check sandbox` | The command, the first command of the package script it runs, or the one command of a simple `make` target's recipe needs the network, and the executor is offline. DocsFab recognizes link checkers (`lychee` without `--offline`, `markdown-link-check`, and `linkchecker` with `--check-extern` or a URL), Sphinx's `linkcheck` builder, `mkdocs gh-deploy`, and package installs such as `pip install`, `npm ci`, `npm install`, `pnpm install`, `yarn install`, and `uv sync`. The check does not run. |
| `the check executor could not start the command` | The executor could not launch the command. |
| `it did not finish within the check time limit` | The check ran longer than `checks.commandTimeoutMs`, 10 minutes by default. The limitation names the limit, the time the check ran, and how to raise the limit with `DOCSFAB_CHECKS_COMMAND_TIMEOUT_MS`. |
| `the checkout exceeds the check credential scan limit` | The repository has more directory entries than the executor's credential scan covers, `checks.credentialScanMaxEntries`. No check runs. The limitation names the limit and how to raise it with `DOCSFAB_CHECKS_CREDENTIAL_SCAN_MAX_ENTRIES`. |
| `the checked tree changed while checks ran` | The checked tree differed after the checks from the tree they started on. If the tree is still different when DocsFab assesses the checks, the run fails with `required-check-evidence-stale` instead. |
| `the checks were cancelled` | The run was cancelled before the check finished. |

Run the named command yourself, from the named directory, before you merge the
change. DocsFab never offers a command from an instruction file that the change
itself edits.

### When a Required Check Fails

When a required check runs and fails, or when DocsFab cannot establish the
check evidence, the run fails with one of the following codes. DocsFab retains
the patch for inspection but does not apply or publish it. Each of the following codes records its own failure class.

| Code | Class | Meaning | Next action |
| --- | --- | --- | --- |
| `required-check-failed` | `unknown` | A repository-required check ran and failed on the proposed change. This result alone does not establish whether the baseline, candidate, or environment caused the failure, even if the output mentions a missing program, module, Git repository, or host. | Use `docsfab runs show <run-id>` to inspect the recorded check status, exit code, and retained patch. It shows the command when safe to display and withholds unsupported or credential-bearing command detail. Compare a separately validated baseline check if available, correct the candidate or repository, run the check again, then start a new run. `docsfab why <run-id>` reports `repository-check` without recommending another model. |
| `required-check-instructions-altered` | `model-content` | The change edits a repository instruction file, such as `AGENTS.md`. DocsFab does not derive check commands from an instruction file that the change edits. | Keep repository instruction files out of the change, or edit them in a separate change, then start a new run. |
| `required-check-evidence-missing` or `required-check-evidence-stale` | `contract-shape` | The recorded check evidence does not cover the exact proposed tree. | Report a runtime defect with the run ID. Do not retry the unchanged request. |
| `required-check-snapshot-unavailable` | `infrastructure` | DocsFab could not observe the proposed tree. That includes a missing workspace, a descendant that could not be read, and a tree that exceeds the workspace bounds. | Run from a readable checkout within the bounds, then start a new run. |

## Ground the Update on a Local Commit Range

Follow [Ground the Update on a Local Commit Range](bind-commit-range.md) for the supported selections, evidence binding, and refusals.

## Troubleshooting

If `docsfab do` prints `Outcome route: needs-input` and lists named `run`
jobs, no workflow started. Restate the sentence. Refer to
[A Run Stops With needs-input](../troubleshooting.md#a-run-stops-with-needs-input).

If a catalog job already started and then stopped with `needs-input`, read
the PRODUCT shopping list and the printed NEXT command. Supply the named
work products. Use `--continue <run-id>` and repeat `--attach <path>` for the named file slots. Do not add `--reader-source` to `do`. Follow
[Supply Requested Work Products](supply-work-products.md).

If first-pass knowledge admission stops for an attributed snapshot, resume
the original task as described in
[Answer and Resume a Stopped Job in DocsFab](answer-and-resume.md).

If doctor reports a blocked readiness code, follow the printed next command.
Refer to
[Doctor Reports Blocked Readiness](../troubleshooting.md#doctor-reports-blocked-readiness).

If default delivery fails, inspect the retained run. Do not retry the same
request with broader authority.

## Related

Use these topics for the supporting contracts and next actions.

<CardGroup cols={2}>
  <Card
    title="Update Documentation Contract"
    href="/reference/workflow-contracts/update-documentation"
  >
    [Update Documentation Contract](../reference/workflow-contracts/update-documentation.md)
  </Card>
  <Card
    title="Runner Quickstart"
    href="/get-started/runner-quickstart"
  >
    [Runner Quickstart](../get-started/runner-quickstart.md)
  </Card>
  <Card
    title="Live Agent Quickstart"
    href="/get-started/live-agent-quickstart"
  >
    [Live Agent Quickstart](../get-started/live-agent-quickstart.md)
  </Card>
  <Card
    title="Review Merge Request Impact in DocsFab"
    href="/workflows/review-merge-request-impact"
  >
    [Review Merge Request Impact in DocsFab](review-merge-request-impact.md)
  </Card>
  <Card
    title="Propose Documentation After CI in DocsFab"
    href="/workflows/automatic-ci-proposals"
  >
    [Propose Documentation After CI in DocsFab](automatic-ci-proposals.md)
  </Card>
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
</CardGroup>
