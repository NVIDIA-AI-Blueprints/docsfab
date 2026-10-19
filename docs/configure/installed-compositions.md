---
title: Select an Installed Composition in DocsFab
description: Choose an installed model and endpoint with setup --profile and inspect the saved selection.
status: draft
content.type: how-to
---

An installed composition supplies a recorded model, serving route, transport,
and credential family. A public installation omits private endpoint defaults.
Select a composition with `docsfab setup --profile` instead of copying its YAML
`MODEL_*` fields.

## Prerequisites

- Install DocsFab and obtain the key required by the composition's provider.
- Refer to [Execution Compositions](../reference/status-and-configuration/execution-compositions.md)
  for the installed records and their qualification status. Selecting an
  installed composition does not establish technical approval.
- Obtain the provider's base endpoint URL when your installation omits that
  route's default. Public installations require this for NVIDIA Inference Hub
  compositions. The API key alone does not configure an endpoint.

## Steps

1. List the installed compositions and choose an active ID.

   ```bash
   docsfab composition list
   ```

2. If the route has no installed endpoint default, export the provider's base
   endpoint URL before selecting the composition:

   ```bash
   export MODEL_BASE_URL="https://models.example.com/v1"
   ```

   Replace the example URL with your provider's actual endpoint. Keep this
   variable exported for later commands, or save the endpoint in `host.yaml`
   as described below. Do not put an API key in the URL.

3. Select that ID and provide the key that setup requests.

   ```bash
   docsfab setup --profile COMPOSITION_ID
   ```

   Replace `COMPOSITION_ID` with the ID from the list. Setup skips the model
   and endpoint prompts; it does not discover a missing private endpoint.
   It writes `activeExecutionProfile` and `compositionId`
   in `host.yaml` and names the required secret keys in `secrets.env`. It does
   not copy a YAML field block or save an exported endpoint in `host.yaml`.

4. To keep the endpoint after closing your shell, add `baseUrl` under
   `active.writing.settings` in your configuration root's `host.yaml`:

   ```yaml
   active:
     writing:
       compositionId: COMPOSITION_ID
       settings:
         baseUrl: https://models.example.com/v1
   ```

   Merge these fields into the existing file, preserving its other settings.
   Replace the composition ID and example URL with your selected values.
   Keep credentials in `secrets.env`. Environment variables override host
   settings; refer to [Model Setting Precedence](../reference/status-and-configuration/model-settings.md).

5. Inspect the saved selection without calling the model:

   ```bash
   docsfab profile inspect
   ```

   `profile inspect` reports the standing `host.yaml` configuration. Confirm that
   the summary names your selected model, provider, and configured
   limits. After `docsfab setup --profile <compositionId>`, it also reports
   `Bound execution profile:` with that ID. By default, `profile inspect` does
   not contact the provider. Add `--catalog` only when you want read-only
   provider catalog discovery. A ready local configuration does not verify that
   a remote endpoint accepts the key or supports the selected model.

## Related Topics

- [Check DocsFab Readiness](../manage/check-readiness.md)
- [A Composition Does Not Match the Host Configuration](../troubleshooting.md#a-composition-does-not-match-the-host-configuration)
- [Model Profile Field Reference](../reference/status-and-configuration/model-profile-fields.md)
