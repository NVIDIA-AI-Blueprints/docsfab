---
title: Configure the Model in DocsFab
description: Change the DocsFab provider, model, API, or endpoint interactively or with setup flags.
status: draft
content.type: how-to
---

Run `docsfab setup` again to change the model configuration that DocsFab uses.
This procedure configures a provider directly. To use a recorded model and
endpoint instead, follow [Select an Installed Composition](installed-compositions.md).

## Prerequisites

- Install the CLI by following [Install DocsFab](../get-started/installation.md).
- Obtain the provider's model ID and API key. Direct OpenAI and Anthropic
  selections use keys from their product consoles. Compatible selections use
  the hosting service's key and base endpoint URL, including models hosted on
  AWS, Azure, or another service.
- Confirm that the endpoint supports streaming, native tool calling, and the
  API you select. An OpenAI Chat Completions server does not necessarily support
  OpenAI Responses.

Refer to [Set Up DocsFab](../get-started/installation.md#set-up-docsfab) for the
four provider choices, and to [Provider Selection Defaults](../reference/status-and-configuration/model-profile-fields.md#provider-selection-defaults)
for the default APIs and credential variable names. DocsFab has no default model.

## Steps

1. Run `docsfab setup` in a terminal, or supply the provider and model as flags.

   Use one of the following commands, replacing `MODEL_ID` and the example
   URL with values from your provider:

   ```bash
   docsfab setup --provider openai --model MODEL_ID
   docsfab setup --provider openai-compatible --model MODEL_ID \
     --endpoint https://models.example.com/v1
   docsfab setup --provider anthropic --model MODEL_ID
   docsfab setup --provider anthropic-compatible --model MODEL_ID \
     --endpoint https://models.example.com
   ```

2. For either OpenAI option, select the API that the endpoint supports.

   Interactive setup offers **Responses** and **Chat Completions**. To supply
   the choice as a flag, use `--api openai-responses` or
   `--api openai-chat-completions`. Both Anthropic options use Messages.

3. Enter the required key at the hidden **Model API key** prompt.

   Setup rejects blank input and stores the key in the owner-private
   `secrets.env` file. Interactive setup asks for the key each time, even if
   one is already saved. When you keep the same provider, applicable prompts
   offer the saved model, endpoint, and API as defaults. Never put a key in a
   command-line argument. Refer to
   [Manage Local Configuration and Credentials](../manage/local-configuration.md)
   for the storage location and permissions.

## Choose an Endpoint

Compatible options require an endpoint that implements the selected API and
accepts an API key. They do not configure native AWS or Azure SDK protocols or
cloud-specific authentication.

Provide a base URL, not the full request path. OpenAI protocols append
`/chat/completions` or `/responses`. If you paste the full request URL for the
selected API, setup removes that path so it is not sent twice. An endpoint saved
with a request path before this behavior existed keeps failing until you rerun
`docsfab setup` and accept the shown endpoint. Anthropic accepts a base URL with
or without a trailing `/v1` and sends requests to `/v1/messages` without
duplicating the version segment. Its Pi adapter adds the exact `?beta=true`
query required by that SDK version. Gateway prefixes are preserved. Setup shows
the final `Request URL` for your selected API. Supplied base URLs cannot contain
credentials, query strings, or fragments. An Anthropic-compatible gateway must
accept the displayed beta query.

Endpoint URLs use HTTPS. The one exception is a model server on the same
machine: DocsFab accepts plain `http://` only when the host is `localhost`, an
IPv4 address in `127.0.0.0/8` such as `127.0.0.1`, or `[::1]`. Any other plain
HTTP host, including a name such as `localhost.example.com`, stops with
envelope code `model-endpoint-insecure-transport` before setup writes
anything. A hand-edited `MODEL_BASE_URL` with such a host stops with the same
code when DocsFab loads the configuration. For a local model server, refer to
[Use a Local NIM](local-nim.md).

## Set Up Without a Terminal

Without an attached terminal, supply the choices as flags and provide the
corresponding credential variable through your host's secret facility.
`--json` also disables prompts. Without a terminal, `docsfab setup` with no
`--provider`, `--profile`, `--preset`, or `--migrate` option stops with
envelope code `setup-model-choice-required` before it writes anything. Its
`Next action` lists the choices: run setup in a terminal, pass `--provider`
and `--model`, or pass `--profile` with a composition id. A stored or exported
API key does not choose a model. A host that already has a live model
selection keeps it. If a saved selection stops with `composition-retired`,
follow [Model Selection Is No Longer Supported](../troubleshooting.md#model-selection-is-no-longer-supported).
An explicit provider selection requires its
key in the environment for that invocation; setup does not reuse a saved key
when selecting another endpoint. Never put a key in a command-line argument.

## Check the Result

A successful setup summary reports `DocsFab setup complete` and
`Status: Ready`. It also shows the selected model, provider, API, endpoint,
final request URL, effective context limit, configuration location, and next
command. The `Connection check: Not run` line confirms that setup validated
only the local configuration.

In a terminal, setup highlights the selected option and groups the summary
into model, configuration, and next-step sections. Set `NO_COLOR=1` to disable
colors. Redirected output remains plain text, and `--json` returns structured data.

To inspect the saved selection, run `docsfab profile inspect`. To test the
connection, use `docsfab doctor --live`, as described in
[Check DocsFab Readiness](../manage/check-readiness.md).

## Related Topics

- [Select an Installed Composition](installed-compositions.md)
- [Model Profile Field Reference](../reference/status-and-configuration/model-profile-fields.md)
- [Model Calls Fail or the Model Key Is Rejected](../troubleshooting.md#model-calls-fail-or-the-model-key-is-rejected)
