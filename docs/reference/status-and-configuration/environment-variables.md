---
title: "DocsFab Runtime Environment Variables"
description: "Look up environment variables that select private storage, retry behavior, and host configuration. Keep credential values outside the repository."
status: draft
content.type: reference
---

Look up environment variables that select private storage, retry behavior, and host configuration. Keep credential values outside the repository.

## Host and Private Configuration

The following table lists settings read by the CLI runtime and its private
configuration. Installing the CLI does not install a hosted project-admission
service. Deployment-specific service settings are not CLI runtime overrides.

Use [Configure Host Limits](../../manage/configure-host-limits.md) for supported
limit overrides, then inspect their effective values with
`docsfab doctor --limits`.

| Setting | Purpose |
| --- | --- |
| `DOCSFAB_CONFIG_ROOT` | Select one normalized absolute directory for writable host configuration, profiles, and default state. |
| `DOCSFAB_STATE_DIR` | Override the run-record state directory used to locate durable stops and continuation records. It does not relocate live-agent sessions. |
| `DOCSFAB_SKILL_CRATE_DIR` | Override the skill crate directory. Unset uses `paths.skillCrateDir` from `host.yaml`, then the packaged `skill-crate` directory. |
| `DOCSFAB_PUBLIC_ROOTS` | Declare host directories that DocsFab may publish as written. Unset declares none. Refer to [Host Paths in Published Output](../../configure/public-output-roots.md#host-paths-in-published-output). |
| `DOCSFAB_READ_ONLY_MAX_RETRIES` | Set retries for configured read-only inference failures. Despite its name, it also bounds the `create-documentation` revision writer, which retries a retryable malformed reply after DocsFab restores candidate 0. Unset uses `3`; `0` turns off contract-correction retries only. Throttled and transport-fault attempts use `DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES` instead. The maximum is `3`. |
| `DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES` | Lower the separate transport retry budget, from 0 through 6. Throttled and provider transport-fault attempts spend it instead of the read-only retry count; `0` turns off transport retries. With both at their defaults, a read-only step makes at most 10 attempts. |
| `DOCSFAB_RETRY_BASE_DELAY_MS` | Set the initial retry delay. |
| `DOCSFAB_RETRY_MAX_DELAY_MS` | Set the maximum retry delay. |
| `DOCSFAB_RETRYABLE_CATEGORIES` | Select from the runtime's closed retry-category set. |
| `DOCSFAB_ANSWER_SUBMISSION` | Choose how the final quality evaluator in `review-documentation` answers. Unset, or `recorded`, uses the `submit_quality_evaluation` tool call on a route whose composition recorded that capability, and the text answer elsewhere. `text-final` keeps the text answer on every route. Any other value stops the command with `answer-submission-option-invalid`. Every evaluator attempt records the path it took and why. |
| `DOCSFAB_INFERENCE_REJECTED_REPLY_SHAPE_MAX_DEPTH` | Set how deep a rejected reply's shape fingerprint describes nesting. Unset uses `8`; the range is `1` through `32`. |
| `DOCSFAB_INFERENCE_REJECTED_REPLY_SHAPE_MAX_ENTRIES` | Set how many key paths and top-level keys a rejected reply's shape fingerprint lists. Unset uses `128`; the range is `8` through `1024`. |
| `DOCSFAB_INFERENCE_REJECTED_REPLY_EXCERPT_CHARS` | Set how many reply characters each segment of a rejected reply's redacted excerpt keeps in the private run record. Unset uses `512`; the range is `0` through `4096`, and `0` keeps no reply text. |
| `DOCSFAB_NATIVE_PREFLIGHT_TIMEOUT_MS` | Shrink the native preflight child timeout. Unset uses `10000`. |
| `DOCSFAB_NATIVE_PREFLIGHT_VERSION_STDOUT_BYTES` | Shrink the native preflight `--version` capture ceiling. Unset uses `4096`. |
| `DOCSFAB_NATIVE_PREFLIGHT_AUTHENTICATION_STDOUT_BYTES` | Shrink the native preflight authentication capture ceiling. Unset uses `16384`. |
| `DOCSFAB_NATIVE_PREFLIGHT_CATALOG_STDOUT_BYTES` | Shrink the Codex bundled-model catalog capture ceiling. Unset uses `2097152`. |
| `DOCSFAB_NATIVE_PREFLIGHT_MAX_STDERR_BYTES` | Shrink the native preflight stderr capture ceiling. Unset uses `16384`. |
| `DOCSFAB_NATIVE_PREFLIGHT_RECORDED_DURATION_MS` | Shrink the recorded native preflight duration notice threshold. Unset uses `600000`. Measured duration stays the actual value. |
| `DOCSFAB_NATIVE_PREFLIGHT_RECORDED_STDOUT_BYTES` | Shrink the recorded native preflight stdout notice threshold. Unset uses `4194304`. Measured stdout stays the actual value. |
| `DOCSFAB_NATIVE_PREFLIGHT_RECORDED_STDERR_BYTES` | Shrink the recorded native preflight stderr notice threshold. Unset uses `1048576`. Measured stderr stays the actual value. |
| `DOCSFAB_AUTONOMY_AUTHORIZATION_WINDOW_MS` | Shrink the maximum `docsfab auto --once` authorization window. Unset uses `3600000`. |
| `DOCSFAB_AUTONOMY_AUTHORIZATION_WINDOW_DEFAULT_MS` | Shrink the default `docsfab auto --once` authorization window. Unset uses `900000`. Must stay at or under the effective maximum. |

Keep private configuration outside the project checkout. The runtime rejects
an empty, relative, non-normalized, or null-containing `DOCSFAB_CONFIG_ROOT`.
Live-agent sessions are stored under
`<DOCSFAB_CONFIG_ROOT>/.docsfab/live-agent/sessions`. DocsFab protects that
directory with owner-only `0700` permissions and each session file with
owner-only `0600` permissions. `docsfab sessions list` and
`docsfab sessions delete` list and delete them, and
`DOCSFAB_LIVE_AGENT_SESSION_MAX_AGE_DAYS` removes sessions older than that many
days when `docsfab live-agent` starts. For details, refer to
[Stored Sessions and Deletion](../../manage/live-sessions.md#stored-sessions-and-deletion).
Refer to the installed command and checked-in source for exact value ranges.

For the installed model, serving-route, transport, and credential compositions, refer to [Execution Compositions in DocsFab](execution-compositions.md).
