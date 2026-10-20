---
title: DocsFab Model Profile Field Reference
description: Look up every field DocsFab requires for a loadable model profile, whether docsfab setup materializes it, and how to check this table against source.
status: draft
content.type: reference
---

DocsFab loads a policy model profile from `MODEL_*` environment variables
(and an optional judge profile from `JUDGE_*`) before any workflow can
execute. `collectModelProfileIssues` in
`packages/runtime/src/model/configuration.ts` validates every field on this
page, and DocsFab refuses to load a profile that fails any of them. Neither
the interactive setup prompts nor `.env.example` explain why each field
exists; this page is that field-by-field reference. For more information,
refer to [DocsFab Status and Configuration Reference](index.md).

A key and a base URL are not enough. The natural assumption that they are
fails with a generic profile-migration refusal that lists every missing or
invalid field by name but does not explain what each one means or where its
value should come from. This page closes that gap.

## Check This Table Against Source

`profileFieldNames` in `packages/runtime/src/model/configuration.ts` is the
single function that decides which fields are required. As of commit
`9510b94ed`, it names 21 fields per profile. Run this command against your
own checkout to confirm the table below still matches:

```bash
node -e '
const fs = require("fs");
const src = fs.readFileSync("packages/runtime/src/model/configuration.ts", "utf8");
const m = src.match(/function profileFieldNames\(prefix: "MODEL" \| "JUDGE"\): string\[\] \{\n  return \[([\s\S]*?)\];\n\}/);
const fields = m[1].trim().split("\n").filter(Boolean);
console.log(fields.length, "fields");
fields.forEach((f) => console.log(f.trim()));
'
```

If the count or the names differ from this page, the source file is
authoritative. File a documentation issue naming the exact diff instead of
hand-editing the table from memory; a hand-copied table that silently drifts
from `profileFieldNames` is worse than no table at all.

## The 21 Required Fields

Every row uses the `MODEL_` prefix. The optional judge profile uses the same
21 fields under `JUDGE_` (`JUDGE_MODEL_ID` instead of `MODEL_ID`); refer to
[The Judge Profile](#the-judge-profile) below.

**Setup-materialized** means this field's value becomes available without
you setting it directly, because DocsFab's config loader derives it at load
time from the installed composition record that matches the `compositionId`
`docsfab setup --profile <compositionId>` persists in `host.yaml`
(`packages/runtime/src/config/execution-profile.ts`,
`assignmentsForExecutionProfile` and `projectExecutionProfileIntoEnvironment`).
Setup itself does not write these 20 field values into `host.yaml` or any
other file as literal assignments; it writes only `compositionId` and
`activeExecutionProfile`, and the loader recomputes the fields from the
registry every time DocsFab loads configuration. If the registry record for
that composition ID changes or disappears, the derived value changes or the
load fails, on the next load, without rerunning setup. A value you set in
the environment, `secrets.env`, the `host.yaml` slot's `settings`, or with
`--set` replaces the derived value; refer to
[Change a Preset's Settings](../../configure/override-model-settings.md).
**Operator-supplied**
means you provide the value yourself, whether through a CI/CD secret, an
interactive setup prompt, or a hand-edited `.env`. The following table lists the fields.

The following table describes each field.

| Field | Meaning | Setup-materialized via `--profile`? | Validation |
| --- | --- | --- | --- |
| `MODEL_PROVIDER` | The serving route id DocsFab binds this profile to, for example `nvidia-inference-api`. | Yes | Must be present. |
| `MODEL_BASE_URL` | The origin (and path) DocsFab sends requests to: HTTPS, or plain HTTP to a model server on this machine. | Yes | Must be a valid `https:` URL, or an `http:` URL whose host is `localhost`, an IPv4 address in `127.0.0.0/8`, or `[::1]`. It cannot carry a user name, a password, a query string, or a fragment. Any other `http:` host stops with `model-endpoint-insecure-transport`. A URL other than a bound composition's recorded origin runs with a warning; refer to [Run DocsFab in CI](../../workflows/run-docsfab-in-ci.md#a-different-base-url-runs-as-an-override). |
| `MODEL_ID` | The model identifier sent to the provider. | Yes | Must be present. |
| `MODEL_API_FORMAT` | The request shape DocsFab sends: `chat_completions` or `messages`. | Yes | Must be exactly `chat_completions` or `messages`. |
| `MODEL_API_KEY` | The credential value, or read via the name in `MODEL_CREDENTIAL_ENV` when that is set. | No | Must be present. The message names `MODEL_CREDENTIAL_ENV`'s target when that redirection is configured and the target is missing. |
| `MODEL_CONTEXT_WINDOW` | The model's total token budget. | Yes | Positive integer. |
| `MODEL_MAX_OUTPUT_TOKENS` | The maximum generation tokens DocsFab requests. | Yes | Positive integer. Must not exceed `MODEL_CONTEXT_WINDOW`. Must be at least `MODEL_API_MIN_OUTPUT_TOKENS`. |
| `MODEL_API_MIN_OUTPUT_TOKENS` | The output-token floor some downstream Responses-compatible APIs require. | Yes (fixed `16`) | Positive integer. |
| `MODEL_CONTEXT_RESERVE_TOKENS` | Tokens reserved before each request for provider framing and context headroom. | Yes | Positive integer. |
| `MODEL_REASONING` | Whether the model's own reasoning behavior is in use. | Yes | `true` or `false`. |
| `MODEL_INPUT_TYPES` | Comma-separated supported input modalities. | Yes (fixed `text`) | Only `text` and `image` values; must include `text`. |
| `MODEL_SUPPORTS_DEVELOPER_ROLE` | Compatibility flag for the OpenAI `developer` role. | Yes (fixed `false`) | `true` or `false`. |
| `MODEL_SUPPORTS_REASONING_EFFORT` | Compatibility flag for a reasoning-effort request parameter. | Yes (fixed `false`) | `true` or `false`. Cannot be `true` when the profile's own `MODEL_REASONING` is `false`. When you set reasoning to `false` in a setting, DocsFab turns this flag off with a warning instead. |
| `MODEL_COMPATIBLE_API_FORMATS` | Comma-separated API formats this profile is compatible with. | Yes | Only `chat_completions` and `messages` values. When `MODEL_API_FORMAT` is `chat_completions`, must include `chat_completions`. |
| `MODEL_INPUT_COST_PER_MILLION` | Pricing metadata: cost per million input tokens. | Yes (fixed `unknown`) | A non-negative number, or `unknown`. |
| `MODEL_OUTPUT_COST_PER_MILLION` | Pricing metadata: cost per million output tokens. | Yes (fixed `unknown`) | A non-negative number, or `unknown`. |
| `MODEL_CACHE_READ_COST_PER_MILLION` | Pricing metadata: cost per million cached-read tokens. | Yes (fixed `unknown`) | A non-negative number, or `unknown`. |
| `MODEL_CACHE_WRITE_COST_PER_MILLION` | Pricing metadata: cost per million cached-write tokens. | Yes (fixed `unknown`) | A non-negative number, or `unknown`. |
| `MODEL_PROFILE_APPROVED_SOURCE` | Operator-attested HTTPS documentation URL for this model's metadata. | Yes (fixed `unknown`) | Must be `unknown`, or (together with the two fields below) all three set: an HTTPS URL without embedded credentials. |
| `MODEL_PROFILE_EFFECTIVE_DATE` | The date the attested metadata became effective. | Yes (fixed `unknown`) | Must be `unknown`, or a `YYYY-MM-DD` date not in the future. |
| `MODEL_PROFILE_REVIEW_AFTER` | The date after which the attestation is due for review. Advisory only: after it passes, `profile inspect`, `doctor`, and the run summary print `Review overdue`, and the profile keeps its configured limits, capabilities, and prices. | Yes (fixed `unknown`) | Must be `unknown`, or a `YYYY-MM-DD` date not before `MODEL_PROFILE_EFFECTIVE_DATE`. |

The three `MODEL_PROFILE_*` fields are validated as one group: supply all
three or leave all three as the literal string `unknown`. Mixing `unknown`
with a real value on only one or two of them is rejected.

## Fields Adjacent to This List

Three related fields are not in `profileFieldNames` and are therefore not
required, but they interact directly with the table above.

`MODEL_CREDENTIAL_ENV` is optional. When set, it redirects DocsFab to read
the credential from the variable it names instead of from `MODEL_API_KEY`
directly, and DocsFab validates that name is an uppercase environment
variable identifier. `docsfab setup --profile <compositionId>` does not set
this field; it writes the composition's required secret name into
`secrets.env` instead, together with that secret's value when the value is
already present in the environment.

`MODEL_REASONING_EFFORT` is optional. When set to `minimal`, `low`, `medium`,
`high`, `xhigh`, or `max`, in any letter case, it turns reasoning on. DocsFab
sends it as `reasoning_effort` on chat completions, as `reasoning.effort` on
the Responses API, or as adaptive thinking with `output_config.effort` on
Anthropic Messages; refer to
[Which Value Wins](model-settings.md#which-value-wins). With
`MODEL_REASONING=false` set explicitly, DocsFab does not send it and records a
warning.

`MODEL_MAX_INPUT_TOKENS` is optional. When absent, DocsFab defaults it to
`MODEL_CONTEXT_WINDOW`. When present, it must not exceed
`MODEL_CONTEXT_WINDOW`. `docsfab setup --profile <compositionId>` does set
this field from the installed composition's `maxInputTokens` limit, even
though `collectModelProfileIssues` does not require it.

## Setup-Materialized vs. Operator-Supplied at a Glance

Running `docsfab setup --profile <compositionId>` against an installed
composition makes 20 of the 21 required fields available to you: the
config loader derives them at load time from the composition record
matching the `compositionId` setup persisted, as described above. The one
exception is `MODEL_API_KEY`: DocsFab never invents a credential value.
DocsFab does, however, persist an operator-supplied value: if the required
credential is already present in the environment when you run setup, setup
writes that value into `secrets.env` under the configuration root (an
owner-private, mode `0600` file that is not part of the checkout). Setup
does not invent a value when none is present, and it never places a
credential value in `host.yaml`, a policy profile file, or a committed
`.env`, but "operator-supplied" does not mean "never persisted to disk."
Refer to
[Which Credential a Route Requires](../../workflows/run-docsfab-in-ci.md#provide-the-credential-the-route-requires)
for how to find the exact variable name a given composition's route reads,
and to
[Bind the Host Policy Profile Non-Interactively](../../workflows/run-docsfab-in-ci.md#bind-the-host-policy-profile-non-interactively)
for the full persistence and configuration-root lifecycle.

Configuring a bespoke endpoint instead, with `docsfab setup --provider` or a
hand-edited `.env`, does not get this derivation. Every field is yours to
set. Setup prompts for the identity fields (provider, model, endpoint,
credential) interactively; the remaining fields fall back to the
conservative unmatched-model defaults documented in
[Provider Selection Defaults](#provider-selection-defaults) unless
you set them explicitly. An unmatched, unattested model does not receive an
invented DocsFab context ceiling.

## Provider Selection Defaults

The following table
lists the defaults for each provider.

| Provider | Default API | Endpoint | Credential variable |
| --- | --- | --- | --- |
| `openai` | OpenAI Responses | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `openai-compatible` | OpenAI Chat Completions | Your HTTPS base URL, or a loopback `http://` URL | `COMPATIBLE_API_KEY` |
| `anthropic` | Anthropic Messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `anthropic-compatible` | Anthropic Messages | Your HTTPS base URL, or a loopback `http://` URL | `COMPATIBLE_ANTHROPIC_API_KEY` |

OpenAI Chat Completions and Responses are distinct OpenAI APIs with different
request and streaming formats. A server that supports Chat Completions does
not necessarily support Responses. For either OpenAI option, use
`--api openai-chat-completions` or `--api openai-responses` to select the API
your model endpoint supports. Interactive setup offers this choice as a menu
for both OpenAI options. DocsFab workflows require streaming and native tool calling.

The setup choice records the protocol and credential variable name in the
model profile. It does not qualify an arbitrary model. When provider,
endpoint, model ID, and selected API uniquely match an installed
composition, runtime commands bind that composition's window. Unmatched
selections do not receive an invented DocsFab context ceiling; the
provider enforces the window. For an unmatched selection, setup writes an
output allowance of 16,384 tokens per model turn. If your endpoint serves a
smaller output limit, set `maxOutputTokens` in the profile YAML that setup
names. Workflow execution still enforces its cumulative
input and output token budgets, elapsed-time limit, tool-call limit, and
provider-turn limit. Provider-owned context admission does not increase those
budgets. Run `docsfab composition list` to inspect installed compositions.

Some reasoning models spend their whole output allowance on reasoning unless
the request turns reasoning off. When an installed composition measured the
control that turns reasoning off for a model ID, DocsFab sends that control
to any OpenAI Chat Completions endpoint that serves the same model ID. For
example, a hosted or self-hosted NIM for `nvidia/nemotron-3-super-120b-a12b`
receives `chat_template_kwargs` with `thinking` set to `false`. Run
`docsfab doctor` to confirm: the `Reasoning control:` line names the control
and the composition that measured it. A profile with attested metadata that
declares `reasoning: true` does not receive the control, and neither does a run
whose reasoning you turn on: `MODEL_REASONING=true` or a
`MODEL_REASONING_EFFORT` in `secrets.env`, `.env`, or the environment, a
`settings` value in `host.yaml`, or `--set`. Each of these now takes effect,
including a `*_REASONING=true` line copied from `.env.example`.

## Composition Transport and API Format

The table from `docsfab composition list` does not show a transport or
API-format column. The JSON list does include `transport`, for example
`openai-chat-completions`. That composition transport is not a valid
`MODEL_API_FORMAT` value.

Use the following table to derive `MODEL_API_FORMAT` from a composition transport.

| Composition transport | MODEL_API_FORMAT |
| --- | --- |
| `openai-chat-completions` | `chat_completions` |
| `openai-responses` | `chat_completions` |
| `anthropic-messages` | `messages` |

Set `MODEL_API_FORMAT` to `chat_completions` or `messages`. If you copy a
composition transport into `MODEL_API_FORMAT`, `docsfab setup` derives the
matching profile value. An unrecognized value is rejected. The rejection
names those accepted profile values and the composition transports they
correspond to. Codex and Claude Code preflight compositions use
`opaque-cli-managed` and do not read `MODEL_API_FORMAT`.

## Legacy Configuration Aliases

`activePolicyProfile` remains an alias for `activeExecutionProfile` during
migration, so existing YAML hosts keep working until the next setup. The
`--preset` option remains as a YAML migration path; prefer `--profile`. The
`--profile` option skips the model and endpoint prompts. It still asks for
the required API key.

For a legacy `.env` host, the `profile-seed` next action can request
`docsfab profile seed --preset <id>`. Seed has no
default model: without `--preset`, it stops with `profile-seed-choice-required`
before writing anything and lists the preset choices in its `Next action`.

## The Judge Profile

`JUDGE_*` mirrors the same 21 fields as `MODEL_*` (`JUDGE_MODEL_ID` takes the
place of `MODEL_ID`), and `collectModelProfileIssues` validates them the same
way. DocsFab only loads the judge profile when `JUDGE_ENABLED=true`.
Ordinary write and review workflows do not read it. It backs the separate
`evaluate --judge` semantic-evaluation path; deterministic structural checks
remain authoritative for ordinary quality evidence.

## Related

<CardGroup cols={2}>
  <Card
    title="Run DocsFab in CI"
    href="/workflows/run-docsfab-in-ci"
  >
    [Run DocsFab in CI](../../workflows/run-docsfab-in-ci.md)
  </Card>
  <Card
    title="Runtime CLI and Configuration in DocsFab"
    href="/reference/status-and-configuration/runtime-cli-and-configuration"
  >
    [Runtime CLI and Configuration in DocsFab](runtime-cli-and-configuration.md)
  </Card>
  <Card
    title="Install DocsFab"
    href="/get-started/installation"
  >
    [Install DocsFab](../../get-started/installation.md)
  </Card>
  <Card
    title="Troubleshooting DocsFab"
    href="/troubleshooting"
  >
    [No Model Profile or Model Key Is Configured](../../troubleshooting.md#no-model-profile-or-model-key-is-configured)
  </Card>
</CardGroup>
