---
title: "Override Model Settings in DocsFab"
description: "Change an installed composition's defaults for one run or for future runs. DocsFab records the effective values and their sources."
status: draft
content.type: how-to
---

Change an installed composition's defaults for one run or for future runs. DocsFab records the effective values and their sources.

## Prerequisites

Configure a model or [select an installed composition](installed-compositions.md). Choose supported keys from [Model Setting Precedence](../reference/status-and-configuration/model-settings.md).

## Steps

Complete the following steps for the selected task.

1. For one run, pass one `--set <key>=<value>` per change on `docsfab run` or `docsfab do`:

   ```bash
   docsfab run review-documentation --repo /absolute/path/to/repository \
     --set reasoningEffort=high
   ```

2. For future runs, put the settings under `active.writing.settings` in `host.yaml`. Use `active.judge.settings` for the judge model. Environment variables and configuration env files can also supply supported keys.
3. Inspect the effective configuration with `docsfab profile inspect` and check readiness with `docsfab doctor --repo /absolute/path/to/repository`. Review the reported sources and warnings before running the workflow.

The precedence is command-line settings, environment, configuration env files, host settings, and then the profile or preset. `--set` changes only the writing model. Refer to [Model Setting Precedence](../reference/status-and-configuration/model-settings.md) for exact keys, reasoning rules, and refusal conditions.

## Related

Use these topics for the supporting contracts and next actions.

- [Manage Local Configuration and Credentials](../manage/local-configuration.md)
- [Inspect Operational Limits](../manage/inspect-operational-limits.md)
