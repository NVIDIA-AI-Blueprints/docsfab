# Slack Communication Channel

The public runtime source provides a host-owned outbound notification port.
An integration supplies delivery after a run reaches a durable status.
Installing the CLI does not configure a Slack connection or an inbound service.
The source integration surface is `src/channels/slack/index.ts` in the runtime
package; it is not a documented npm subpath export.

## Trust Boundary

The integration must preserve these boundaries:

- Keep credentials and destination selection inside the host-owned posting
  function. Do not pass them to the model, notification input, or run record.
- Create an opaque transport with `createHostSlackNotificationTransport`.
  The runtime stores its posting function in a private WeakMap. A lookalike
  object cannot post through that transport contract.
- Supply safe workflow labels and a content-free run-record locator. The
  notification contract validates its closed input and disclosure fields.
  Do not use labels to carry private source text, prompts, or credentials.
- Treat a Slack message as input, not as a write, publish, or merge grant.
  The notification port does not expose a model-facing Slack tool.

The default notification text uses the safe-label disclosure ceiling from
[External Input Disclosure](../contracts/external-input-manifest.md).
An optional projected status block is validated by the notification contract.
The integration still owns authorized network delivery and credential custody.

## Event Mapping

Call `notifySlackRunCompletion` after the run record is durable. The contract
maps run statuses as follows:

| Run Status | Slack Event | Notifiable? |
| --- | --- | --- |
| `succeeded` | `terminal-disposition` | Yes |
| `failed` | `terminal-disposition` | Yes |
| `needs-human-decision` | `needs-human-decision` | Yes |
| `queued`, `running`, `needs-input` | None | No, skipped |

The posting callback receives `{ "text": "…" }`. The default text has this
shape:

```text
DocsFab run succeeded
run: <run-id>
record: docsfab-run-record:<run-id>
workflow: <safe-label>
```

Use `contentFreeRunRecordLocator(runId)` for the record locator. It identifies
the record without naming its filesystem location. A missing transport returns
`skipped` with reason `no-transport`; a non-notifiable status returns
`skipped` with reason `not-notifiable`.

## GitLab Link Disclosure

`DOCSFAB_SLACK_GITLAB_ORIGIN` is an optional disclosure boundary, not a
credential or transport destination. Leave it unset or empty to reject all
URLs in projected Slack text. To permit links to a GitLab instance, select
one HTTPS origin, for example `https://gitlab.example.com`.

The value must use HTTPS with no user information, non-root path, query, or
fragment. Use only your GitLab origin; do not configure a Slack webhook origin.
The parser rejects the normalized origin `https://hooks.slack.com`, and payload
screening refuses `hooks.slack.com` references.

A link is admitted only when its normalized protocol, hostname, and optional
port match the configured origin. Hostname case and one trailing dot are
normalized. Other origins, HTTP links, and embedded credentials fail closed.
Message text cannot change this environment value.

## Protected Configuration

The runtime notification port accepts a posting function rather than loading
an app ID, token file, route map, or webhook URL from deployment configuration.
Provision any credentials through the integration's protected host or platform
secret store. Never commit them or copy them into prompts, fixtures, run
records, or issue bodies.

The separately operated host owns its network client and destination policy.
The public CLI does not provide an environment-driven webhook loader or a
command to configure Slack tokens. Do not infer such a command from the
notification contract or from a reserved identifier in source.

## Live Webhook Path

For a source integration that already owns an authorized posting function,
use the actual notification port as follows:

1. Keep the destination and its credentials inside that posting function.
   The function accepts the notification body and returns a promise.
2. Pass it to `createHostSlackNotificationTransport` to obtain the opaque
   runtime transport.
3. After a run record is durable, call
   `notifySlackRunCompletion(input, transport)`. Set `input.runId`,
   `input.recordLocator` to `contentFreeRunRecordLocator(runId)`,
   `input.runStatus`, and the optional `input.workflowSafeLabel`. Pass the
   opaque object created in step 2 as the separate `transport` argument.
4. Inspect the returned `posted` or `skipped` result. Handle delivery errors
   in the host integration; a notification is not evidence of publication or
   a grant to perform another action.

`createFakeSlackNotificationTransport` captures bodies for local integration
checks without contacting Slack. Use synthetic inputs and keep live
credentials out of fixtures. A passing notification-contract check does not
prove live delivery.

## Hosted Socket Mode Path

A separately operated host can use Socket Mode for inbound events and the
Slack Web API for replies. That host owns admission, route selection, replay
receipts, and the authorization lifecycle. The deployable service,
configuration, and operator smoke procedure are outside the public CLI
distribution and are not configured by the outbound port above.

Use the instructions provided for that deployment. Installing the CLI or
checking a local notification contract does not establish a working inbound
service, restore a model session, or supply project authority.

## What This Is Not

The notification port does not grant project, tool, credential, write,
publish, or merge authority. It does not install a hosted Slack service or
authorize unattended work. Keep the supported outbound source contract
separate from a deployment's inbound integration and operational evidence.
