---
title: "Model Setting Precedence in DocsFab"
description: "Look up model setting names, configuration precedence, reasoning behavior, and recorded provenance. For the procedure, follow Override Model Settings."
status: draft
content.type: reference
---

Look up model setting names, configuration precedence, reasoning behavior, and recorded provenance. For the procedure, follow [Override Model Settings](../../configure/override-model-settings.md).

## Settings You Can Change

The following table lists each setting and the environment variable that
carries it. For the judge model, the variables start with `JUDGE_` instead of
`MODEL_`, and the model ID variable is `JUDGE_MODEL_ID`.

| Setting | Environment variable | Value |
| --- | --- | --- |
| `baseUrl` | `MODEL_BASE_URL` | The endpoint that requests go to: an HTTPS URL, or plain HTTP to `localhost`, an address in `127.0.0.0/8`, or `[::1]`. It cannot carry a user name, a password, a query string, or a fragment. |
| `modelId` | `MODEL_ID` | The model ID sent in each request. It cannot contain spaces or `:`. |
| `transport` | `MODEL_TRANSPORT` | `openai-chat-completions`, `openai-responses`, or `anthropic-messages`. |
| `contextWindow` | `MODEL_CONTEXT_WINDOW` | The model's total token budget. |
| `maxInputTokens` | `MODEL_MAX_INPUT_TOKENS` | The input token limit. |
| `maxOutputTokens` | `MODEL_MAX_OUTPUT_TOKENS` | The output token limit each request allows. |
| `contextReserveTokens` | `MODEL_CONTEXT_RESERVE_TOKENS` | The tokens reserved before each request. |
| `apiMinOutputTokens` | `MODEL_API_MIN_OUTPUT_TOKENS` | The smallest output allowance the API accepts. |
| `reasoning` | `MODEL_REASONING` | `true` or `false`. |
| `reasoningEffort` | `MODEL_REASONING_EFFORT` | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, in any letter case. DocsFab records it in lower case. |
| `credentialEnv` | `MODEL_CREDENTIAL_ENV` | The variable that holds the key. It must be a variable the preset reads. |

Set a value in any of these places:

- In `host.yaml`, under the slot's `settings`:

  ```yaml
  active:
    writing:
      compositionId: nvidia-inference-claude-sonnet-5-pi
      settings:
        baseUrl: https://llm-gateway.example.com/v1
        maxOutputTokens: 65536
  ```

  The judge slot takes the same keys under `active.judge.settings`. They apply
  whenever a judge model is configured, including a judge that only the
  `JUDGE_*` variables configure. An unknown key or a value of the wrong type
  stops the load and names the key.
- In `secrets.env`, the configuration root's `.env`, or the environment, with
  the variable from the table.
- On the command line of `docsfab run` or `docsfab do`, with one
  `--set <key>=<value>` per setting, such as `--set reasoningEffort=high`.
  `--set` changes the writing model only. These commands never call the judge
  model, so `--set judge.<key>=<value>` stops the command and names the key;
  set judge values in `host.yaml` or with the `JUDGE_*` variables. `--set`
  takes its pair as the next argument; DocsFab never reads a `--set` written
  inside the request text.

The same endpoint rule applies to `MODEL_BASE_URL`, `JUDGE_BASE_URL`, the
`host.yaml` setting, and `--set baseUrl`, whether the slot selects a preset or
a model profile file. An endpoint that breaks it stops the load, and the
message names the problem but never repeats the user name, password, or
query.

## Which Value Wins

For each setting, DocsFab uses the first of these sources that sets it:

1. `--set` on the command line.
2. The environment.
3. `secrets.env`, or the configuration root's `.env`.
4. The slot's `settings` in `host.yaml`.
5. The model profile file that `host.yaml` names, or the preset.

<Note title="Behavior change">
An exported variable for a setting in the table, such as
`MODEL_MAX_OUTPUT_TOKENS` or `JUDGE_MODEL_ID`, now overrides `host.yaml`.
Earlier releases replaced it with the value from the preset or profile that
`host.yaml` named. The preset or profile still sets its other fields, and an
exported variable does not change them: `MODEL_PROVIDER`, `MODEL_API_FORMAT`,
`MODEL_COMPATIBLE_API_FORMATS`, `MODEL_SUPPORTS_DEVELOPER_ROLE`,
`MODEL_SUPPORTS_REASONING_EFFORT`, `MODEL_INPUT_TYPES`, the four
`MODEL_*_COST_PER_MILLION` fields, and the three `MODEL_PROFILE_*` fields, with
the matching `JUDGE_*` fields for the judge model. A `MODEL_PROVIDER` that
names another route is shown as a warning.
</Note>

Reasoning is on when `reasoning` is `true` or when you set `reasoningEffort`,
whatever the preset or profile file says. Each of the model's agent turns then
asks for reasoning at that effort. Request interpretation, the first-pass
checks, and the judges make short calls with small output limits: they keep
thinking off, as before, unless you set `reasoning` or `reasoningEffort` for
the model they use. Per transport, a request carries reasoning as follows:

- Chat completions send `reasoning_effort`. With no effort set, a route whose
  profile supports an effort gets `medium`, the default level of the Pi agent
  library that DocsFab runs; any other route gets no reasoning field, so its
  default reasoning applies.
- The Responses API sends `reasoning.effort`. With no effort set, it sends
  `medium`.
- The `anthropic-messages` transport turns on adaptive thinking and sends the
  effort as `output_config.effort` for a model that the Pi model catalog
  lists with adaptive thinking, such as Claude Opus 4.7. A gateway's model ID,
  such as `aws/anthropic/bedrock-claude-sonnet-5`, matches by its last part.
  With no effort set, it sends `medium`. Anthropic has no `minimal` effort, so
  DocsFab sends `minimal` as `low` and warns. For any other model,
  such as Claude Sonnet 4.5, DocsFab keeps reasoning off, records it as off,
  and warns: a thinking budget would be added on top of each request's output
  limit. With reasoning off, a model that thinks unless a request turns
  thinking off, such as Claude Sonnet 5, gets
  `thinking: {"type": "disabled"}`. A model that cannot turn thinking off,
  such as Claude Opus 5.5, runs as configured, and DocsFab warns that it may
  think although reasoning is recorded as off.

With `reasoning` explicitly set to `false`, DocsFab keeps reasoning off, does
not send the effort, and warns. When the preset or profile declares
reasoning-effort support, that support is turned off too, with a warning,
rather than refusing your setting. A preset's request policy, such as a
`chat_template_kwargs` field that turns thinking off, applies only when the run
uses the preset's model and transport with reasoning off, including when
`reasoning: false` drops an effort. Otherwise DocsFab sends requests without it
and warns.

## What DocsFab Records and Shows

Each value carries the source that set it and its origin, such as
`host.yaml active.writing.settings.baseUrl`, `MODEL_BASE_URL`, or
`secrets.env:3`. The following table lists the source labels.

| Source | Where the value came from |
| --- | --- |
| `cli-flag` | `--set`, or the `--composition` that selected the preset. |
| `environment` | An exported variable. |
| `secrets-env` | `secrets.env` in the configuration root. |
| `legacy-env-file` | The configuration root's `.env`. |
| `host-config` | `host.yaml`. |
| `profile-file` | The model profile file that `host.yaml` names. |
| `preset` | The preset's own value. |

The run record's `modelSettings` field keeps, for each model slot, the preset
ID and how it was selected, and every setting's value, source, origin, and the
preset's own value. Its `notes` list each warning: a value that differs from
the preset, a `host.yaml` setting that a higher source overrides, a reasoning
setting that requests send in another form, an effort that is not sent, or a
request policy that does not apply. A warning or `docsfab doctor` line never
shows a value that holds credential material: it shows `[REDACTED]` in its
place, and a saved run record, the run summary, and its diagnosis replace
DocsFab's own configured credentials the same way. A provider that answers under another model name is shown as a warning
and recorded in the run's `evidenceWarnings`. A name with a control or format
character, such as a bidirectional override, or a line separator, or a warning
too long for the record, is shown with each such character escaped as
`\u{...}` and cut at `runs.indexFieldMaxChars`, and the record keeps a
placeholder. The run continues in each case.
Composition-execution evidence records the effective model, transport, and
deployment identity and a digest of `modelSettings`, never the endpoint URL.

`docsfab doctor` prints the endpoint's scheme and host only, with its source,
and a `Model settings` block for each slot. Configuration files appear relative
to the configuration root:

```text
  Endpoint: https://llm-gateway.example.com (path withheld; from host.yaml active.writing.settings.baseUrl)
  ...
  Model settings:
    Preset: nvidia-inference-claude-sonnet-5-pi (selected in host.yaml)
      maxOutputTokens: 65536 (host.yaml active.writing.settings.maxOutputTokens; preset 32768)
    Warning: maxOutputTokens = 65536 from host.yaml active.writing.settings.maxOutputTokens differs from preset nvidia-inference-claude-sonnet-5-pi (32768).
```

## What Still Stops a Run

These values stop the run before any request, each with its own message:

- A `baseUrl` that uses plain HTTP to any host other than `localhost`, an
  address in `127.0.0.0/8`, or `[::1]` stops with
  `model-endpoint-insecure-transport`.
- A `baseUrl` with a user name, password, query, or fragment stops.
- A `modelId` that contains `:` stops, because run records cannot hold it yet.
- A setting whose value holds one of DocsFab's own configured credentials, such
  as the model key given as the model ID, stops with `credential-material` while
  DocsFab loads the configuration, before any run record, summary, or request.
  The message names the setting and its source, never the value. This applies
  to every model slot and source, including a legacy configuration `.env`, and
  `docsfab doctor` names the same cause.
- A `credentialEnv` that names a variable the preset does not read stops with
  `invalid-model-profile-configuration`, and the next action names the variables
  the preset reads.
- An operational limit outside its catalog range stops as before; refer to
  [Operational Limits in DocsFab](operational-limits.md).
