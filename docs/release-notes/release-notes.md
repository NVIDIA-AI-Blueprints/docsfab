---
title: Release Notes for DocsFab
description: Learn about the changes, features, and known issues in each DocsFab release.
template: release-notes
status: draft
---

Use these release notes to learn about the latest changes, features, fixed
issues, and known issues for DocsFab. For more information, refer to
[Overview of DocsFab](../about/index.md).

<span id="release-001"></span>

## Release v0.0.1

This is the initial release of the DocsFab project.

### Local Recovery Limitations

- Local CLI backups must include the complete configuration and saved-state roots, including populated artifact, index, and cache stores. Stop writers before backup or restore. Follow the [local recovery procedure](../manage/recover-local-state.md#recover-a-local-cli-installation).
- In the installed 0.0.1 candidate exercise, an abrupt stop left a run marked `running`. `runs show` read it, but `why` returned `why-run-not-found`. A separate fresh read-only review completed with a new run ID. It did not resume the interrupted run. Refer to the [observed interruption behavior](../manage/recover-local-state.md#recover-a-local-cli-installation).
- The exercise did not verify safe replay of write-capable workflows or remote publication after a crash. Review source and destination state before attempting either operation. Refer to the [recovery guidance](../manage/recover-local-state.md#recover-a-local-cli-installation).

### Model Settings and Presets

- An installed composition is now a preset whose model settings you can change in `host.yaml`, in the environment, or with `--set` on `docsfab run` and `docsfab do`. Each run records every setting's value and source. Refer to [Change a Preset's Settings](../configure/override-model-settings.md).
- Behavior change: an exported variable for one of the 11 model settings, such as `MODEL_MAX_OUTPUT_TOKENS`, now overrides `host.yaml`. Earlier builds replaced it with the value from the preset or profile that `host.yaml` named. The preset still sets its other fields, such as `MODEL_PROVIDER` and the cost fields. Before you upgrade, check the exported `MODEL_*` and `JUDGE_*` variables on the host, and remove any that you do not mean to apply.
- Behavior change: a `MODEL_REASONING=true` or `JUDGE_REASONING=true` line in `secrets.env` or `.env` now takes effect, as an exported variable does. It turns the model's reasoning on, and a preset's thinking-off request policy is then dropped with a warning. Earlier builds replaced it with the preset's value or stripped it from a profile without attested metadata. Agent turns carry it. Request interpretation, the first-pass checks, and the judges keep their own policy, thinking off, unless you set reasoning for the model they use. `.env.example` now sets `JUDGE_REASONING=false`. Refer to [Change a Preset's Settings](../configure/override-model-settings.md).
- A model setting whose value holds one of DocsFab's own configured credentials, such as the model key given as `MODEL_ID` or with `--set modelId=`, now stops with `credential-material` when DocsFab loads the configuration, before any run record, summary, or request. Earlier builds sent no request, but kept such a value from a legacy `.env` in the run record and its summary.
- Do not downgrade after you add `settings` to `host.yaml`. An older runtime refuses an `active.<slot>.settings` block, so every command stops, `docsfab doctor` included. Older runtimes also refuse run records that carry the new `modelSettings` field in their strict readers, such as a knowledge-continuation resume. Upgrade every runtime that shares the configuration root first. To roll back, remove the `settings` blocks from `host.yaml` before you start the older runtime, and resume runs that stopped under the newer runtime with the newer runtime.

## Related Topics

For more information, refer to the following topic:

- [Install DocsFab](../get-started/installation.md)
