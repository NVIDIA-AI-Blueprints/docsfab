---
title: About Configuring DocsFab
description: Choose a guide for changing the model, selecting an installed composition, or connecting a local NIM.
status: draft
content.type: explanation
---

DocsFab model configuration binds the provider, model ID, API, endpoint, and credential used by model-backed commands. Complete [installation and setup](../get-started/installation.md#set-up-docsfab) before choosing a configuration task.

## Models and Routes

Choose the task that matches the change you need:

| Task | Guide |
| --- | --- |
| Change the provider, model, API, or endpoint. | [Configure the Model](model.md) |
| Select a model and endpoint from the installed registry. | [Select an Installed Composition](installed-compositions.md) |
| Change model settings for one run or future runs. | [Override Model Settings](override-model-settings.md) |
| Connect a local NVIDIA NIM container. | [Use a Local NIM](local-nim.md) |
| Measure an exact serving route before drafting a record. | [Probe a Model Route](probe-model-route.md) |
| Prepare a registry change from a measured verdict. | [Draft a Composition Record](draft-composition.md) |

Setup validates local configuration without making a model request. A live probe sends requests only with `--live`.

## Output and Private Storage

To declare host paths that can appear in output, follow [Configure Public Output Roots](public-output-roots.md). To locate saved configuration or replace a key, follow [Manage Local Configuration and Credentials](../manage/local-configuration.md).

## Related

- [Check Readiness](../manage/check-readiness.md)
- [Installed Execution Compositions](../reference/status-and-configuration/execution-compositions.md)
- [Model Profile Fields](../reference/status-and-configuration/model-profile-fields.md)
