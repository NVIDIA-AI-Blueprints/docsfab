---
title: Discover DocsFab Workflows
description: Find an available workflow, understand its outcome and effects, and choose your next documentation task.
status: draft
---

Use `docsfab list` to find workflows in your installed CLI. Choose one outcome,
then run `docsfab plan <workflow>` to understand its intended effects. Both
commands work offline without a configured model or API key. Install the CLI
first by following [Install DocsFab](installation.md).

## Find Available Workflows

Run the following command to list workflow names and titles:

```bash
docsfab list
```

Each workflow appears with its installed name and title. The output includes a
copyable `Plan` action for each workflow. Use the name to run or inspect that
workflow. The list reflects your installed version, so confirm availability
before copying a name from documentation for another version.

If the catalog has no workflows, the command explains that state and points to
installation help. Do not infer workflow availability from files on disk.

Choose a workflow based on the outcome you need:

| Workflow | When to Choose It |
| --- | --- |
| [`create-documentation`](../reference/workflow-contracts/create-documentation.md) | Create a new page or documentation set for a specific audience and scope. |
| [`update-documentation`](../reference/workflow-contracts/update-documentation.md) | Update existing documentation for a change, or verify that no update is needed. |
| [`restructure-documentation`](../reference/workflow-contracts/restructure-documentation.md) | Reorganize documentation while preserving content, routes, and navigation. |
| [`review-documentation`](../reference/workflow-contracts/review-documentation.md) | Review existing documentation for structure, technical accuracy, clarity, audience understanding, and quality. |
| [`audit-documentation`](../reference/workflow-contracts/audit-documentation.md) | Check pages against their templates without model calls. |
| `readiness` | Assess whether agents can reliably use a repository as input. |
| `release-documentation-readiness` | Assess release-documentation readiness and identify follow-up work. |
| `bootstrap` | Propose minimal repository guidance in `README.md` and `AGENTS.md`. |

To discover CLI commands and their options, use help:

```bash
docsfab help
docsfab run --help
```

## Understand a Workflow Plan

Pass a workflow name from the list to `docsfab plan`. For example, inspect the
workflow used in the runner quickstart:

```bash
docsfab plan create-documentation
```

The plan states the intended outcome and lists each step with its access mode.
It also provides a copyable command to run the selected workflow.

Read the output as follows:

- `Outcome:` describes the result the workflow is designed to produce.
- Each numbered step describes the work and access mode in execution order.
- `read-only` means the step cannot change repository files. `write` marks a
  step that can change files within the run's authorized scope.
- The plan omits internal skill identifiers. Refer to the workflow contract for
  inputs, conditional paths, output artifacts, and workflow-specific requirements.

Compare workflows by inspecting another plan:

```bash
docsfab plan review-documentation
```

The review workflow uses read-only steps. The create workflow combines planning,
writing, and checks. For inputs, conditional paths, output artifacts, and
workflow-specific requirements, refer to
[Workflow Contracts in DocsFab](../reference/workflow-contracts/index.md).

`docsfab plan` reads the installed workflow definition. It does not inspect
your target repository, call a model, execute steps, or plan a documentation
change for your request.

## Run Your First Task

To run a model-backed task, configure your model through
[Install DocsFab](installation.md#set-up-docsfab), then continue with a quickstart:

- [Workflow Quickstart](runner-quickstart.md): run `create-documentation` with a
  concrete instruction and `--patch-only` to retain a local patch for review.
- [Live Agent Quickstart](live-agent-quickstart.md): describe your outcome in a
  conversation and let DocsFab select the appropriate skills or workflow.

For the concepts behind tasks, workflows, and steps, refer to
[Documentation Jobs in DocsFab](../about/core-concepts/documentation-jobs.md).
