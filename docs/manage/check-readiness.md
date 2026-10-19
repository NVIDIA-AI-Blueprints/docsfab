---
title: "Check DocsFab Readiness"
description: "Check readiness for the operation you want to run. Offline checks read local configuration. Add `--live` to check model connectivity and, for draft delivery, GitLab access."
status: draft
content.type: how-to
---

Check readiness for the operation you want to run. Offline checks read local configuration. Add `--live` to check model connectivity and, for draft delivery, GitLab access.

## Prerequisites

Install the CLI by following [Install DocsFab](../get-started/installation.md).
Configure the model before checking a model-backed operation.
For platform coverage, tested models, and detailed environment requirements,
refer to [Support Matrix](../reference/support-matrix.md).

## Requirements by Operation

Requirements depend on the operation you want to run:

- Discovery and preview commands need no model key. Examples include
  `--help`, `docsfab list`, `docsfab test`, `docsfab composition list`,
  `--dry-run`, and `--route-only`.
- `docsfab doctor` needs the model key. Without it, doctor reports
  `provider-credentials-missing` and exits non-zero. Doctor can also report
  its `gitlab`, configuration, and private-state areas as `blocked`.
  GitLab or project-configuration blockers do not stop `docsfab list`.
  Local review and local patch remain available when their own checks pass,
  and a local review does not need `docsfab init`. Refer to [Check Installation and Configuration](#choose-a-check).

The following table lists what each entry point needs.

| Entry point | Needs a model profile and key | Needs an `origin` remote and `glab` auth | Notes |
| --- | --- | --- | --- |
| Local review (`docsfab run review-documentation`) | Yes, to call the model | No | Read-only; does not write to the repository or publish. |
| Local patch (`--patch-only` on a write workflow) | Yes | No. A local patch needs no GitLab remote, `glab` auth, or push permission, with or without a tracked `.docsfab.json`. | Runs in a disposable workspace; retains a reviewable patch without touching the source checkout. Without a tracked `.docsfab.json`, it uses the default `docs/` and `fern/` roots and proposes no project configuration. A request that asks DocsFab to add `.docsfab.json` still needs a supported GitLab remote. |
| Draft merge request (default write-workflow delivery) | Yes | Yes, both required, plus push/MR permission | DocsFab proposes tracked project configuration (`.docsfab.json`) automatically when the target repository does not already have it. |
| Live agent (`docsfab live-agent`, write mode is the default) | Yes | Only when write mode attempts delivery (a draft merge request, `ship`, or `publish`); creating the automatic task branch and `--read-only` need neither. | Delivery follows the same draft-merge-request prerequisites as the runner. |

## Steps

Use the commands below for the selected operation.

<a id="check-installation-and-configuration"></a>

## Choose a Check

Use the following table to choose a check.

| Need | Command | Boundary |
| --- | --- | --- |
| Inspect local review readiness without model egress. | `docsfab doctor --repo <path>` | Compact default, read-only check with material attention and a primary next action. |
| Keep the selected-use result, material attention, and primary action. | `docsfab doctor --repo <path> --quiet` | Suppresses the detail pointer. |
| Inspect the supporting diagnostic inventory. | `docsfab doctor --repo <path> --verbose` | Shows details collected during this invocation; it does not add a probe. |
| Inspect local patch readiness. | `docsfab doctor --repo <path> --use local-patch` | Reports local patch prerequisites. |
| Inspect draft-MR publication readiness. | `docsfab doctor --repo <path> --use draft-mr --live` | Observes the GitLab target and publication access. |
| Consume the offline result in automation. | `docsfab doctor --repo <path> --json` | Emits the canonical offline record. |
| Request an explicit live check. | `docsfab doctor --repo <path> --live` | Requires separately configured credentials. Adds the live model check and the GitLab target-branch observation behind draft-MR readiness. |
| Consume the observed live result in automation. | `docsfab doctor --repo <path> --live --json` | Emits the same canonical record with the observed GitLab target facts. |
| Inspect staged catalog or judge-profile readiness. | `docsfab doctor --repo <path> --live --catalog [--judge]` | Does not bypass repository or delivery checks. |

## Offline Readiness

Run `doctor` against the target repository:

```bash
docsfab doctor --repo /absolute/path/to/target-repo
docsfab doctor --repo /absolute/path/to/target-repo --json
```

The read-only report covers installed assets and the exact Git `HEAD` commit.
Its `selectedUse` defaults to `local-review`. The headline verdict and exit
code follow that use. `useReadiness` provides separate `local-review`,
`local-patch`, and `draft-mr` results. Each use lists its `blockers`. The
default human report leads with the selected use and repository, then shows
material attention and the primary next action. An unavailable optional
draft-MR setup is called out without blocking a usable local review.
Diagnostics also retain advice that does not block the selected use. Each
blocked check has an explanation and a next command. Project setup, GitLab
access, and init-created private roots can block draft-MR delivery without
blocking a usable local review.
The draft-MR publication observation describes its GitLab subcheck; the
`draft-mr` use result is the aggregate readiness verdict.
The report also shows host-managed provider credentials and that validation is deferred. Delivery selects
the sealed built-in validator from the workflow, changed paths, and trusted
host policy. Doctor does not inspect repository npm scripts or execute a
repository supplied validation command.
Offline GitLab readiness is proven when a token is present for that
remote host. It does not require `glab config get host` to equal the
remote. Do not export `GITLAB_HOST` as a product fix. Offline doctor
does not run inference or mutate the repository, configuration,
credentials, provider, or GitLab.

The human-readable report also names the resources that every run binds from
the verified quality pack. Each `Resolved` line gives the resource kind, its
id and version, the layer that supplied it, and its digest. The product layer
supplies the style profile `profile:nvidia-technical-documentation` and the
evaluation profile `profile:docsfab-documentation-quality`. The organization,
target, and request layers are not built, so the report lists them as
unresolved. The writer, reviewer, and evaluator steps receive the same style
profile, and the run record carries the set under
`qualityPack.resolvedResources`. A run resolves the style profile once, before
its first model call. A style profile larger than
`execution.styleResourceMaxBytes` refuses the run at that point with code
`style-resource-max-bytes-bound`. A quality lock that predates the
product-default declaration stops doctor and every run with code
`migration-required` and the command that regenerates the lock.

When the installed quality pack fails verification, doctor blocks the
`installation` check with the same code that `docsfab run` reports for the
same pack. A changed file reports `checksum-mismatch`, an added or removed
file `file-set-mismatch`, a file replaced by a symbolic link `unsafe-path`,
and a manifest digest that no longer matches its locks `stale`. The other pack
codes are `tampered`, `lock-unavailable`, `invalid-lock`, and
`invalid-manifest`. The explanation names the failed check, not a path.
`docsfab run` reports each of these failures with the failure class
`infrastructure`, regardless of the code. Other checks reuse several of these
codes for other causes, so the class follows the failed quality pack, not the
code. Doctor and `docsfab run` print the same next action. For an installed
package, the next action is to reinstall its release from the exact release
tarball with `--ignore-scripts`; follow the printed command. For backup and
restore checks, refer to
[Recover a Local CLI Installation](recover-local-state.md#recover-a-local-cli-installation).
The repair command never names a registry package. For a source checkout, the next
action is to regenerate the pack with `npm --prefix packages/runtime run build`
from the repository root.

Each blocking condition has one closed diagnostic code, explanation, and
next command. No raw command output, credential value, or host path is
retained. Use `--quiet` for the selected-use result, material attention, and
primary next action without the detail pointer. The default report also points
to `docsfab doctor --verbose`, which shows supporting repository, check,
connectivity, model, retry, resource, and local-storage evidence from this
invocation. Verbose output does not start another live probe. When readiness
succeeds, the human-readable report prints `NEXT docsfab list`. Run from the
target repository so the subsequent printed `docsfab run review-documentation`
command selects the same checkout.
`--json` emits the canonical offline record without human-readable footer text;
`--quiet --json` emits the same JSON record.

The human-readable retry envelope reports the configured retry counts. An
ordinary model-profile run has no per-attempt composition timer, so doctor
reports `attempt-timeout=not configured` and an unarmed judgment answer-now
point. It does not derive a finite step worst case from retry counts alone.
Workflow deadlines still apply. The transport retry budget remains a separate
line with its own wait and elapsed limits.

Doctor reports `project-config-missing` for draft-MR delivery on an
uninitialized target. Local review and local patch can run without
`.docsfab.json` when the shipped workflow admits local unconfigured mode.
Both local uses still read a tracked `.docsfab.json` from `HEAD`; an invalid
committed file blocks them until it is corrected and committed. Malformed
working-copy edits do not replace valid committed authority for local work.
`projectConfiguration` names that authority, its effective revision and
documentation roots, and the working file's checkout state. If no project file
is committed, local work uses the default `docs/` and `fern/` roots. Staged,
modified, ignored, and untracked working files are visible as advice, but they
do not grant local authority before commit.
If no supported GitLab remote exists, doctor names
`no-supported-gitlab-remote` and does not suggest `docsfab init`, which would
refuse. The target can be DocsFab itself.

On macOS, the review workflow can continue if its repository-native lint step
cannot run. Doctor names `native-lint-platform-unavailable` as a limitation:
required native checks need Linux with working Bubblewrap user namespaces.
To execute those checks, rerun the review on a suitable Linux host.

## Draft-MR Publication Readiness

Whether `--use draft-mr` would publish depends on live GitLab facts: the
target branch, its current revision, and the operator's access on the
project. Offline doctor cannot know them, so it never guesses. Every
report carries `checkoutBranch`, `checkoutRevision`, `gitlabTargetBranch`,
`gitlabTargetRevision`, `draftMrReadiness`, and `remediationArgv`, and
offline the publication readiness state is `not-observed` with a reason naming
`--live`. Selecting `--use draft-mr` offline exits nonzero because publication
readiness is unknown. Local review remains available when its own checks pass.

```bash
docsfab doctor --repo /absolute/path/to/target-repo --live
```

With `--live`, doctor resolves the GitLab target through the same
read-only observation the publication path uses, then reports whether the
default run base would publish. It reports `blocked` with
`insufficient-push-access` when the account is below the Developer level
publication requires, so a Guest or Reporter learns before a write rather
than after one. A feature-branch checkout behind the target is `ready`:
the default run base is the target-branch revision, and the checkout is
never moved. Doctor issues no write and fetches nothing; a run base it
reports as fetchable is described, not fetched.

Initialization uses an owner-private, 5-minute lease. Lease expiry alone does
not override a live owner or uncertain process evidence. Lock owners created by
current Linux and macOS versions bind to the operating system process start.
Older lock receipts remain active while their process is live or cannot be
verified. If initialization is blocked, let the owning process finish or stop,
then retry. Malformed or unverifiable ownership requires recovery; do not
delete a lock that can belong to a live process.

## Live and Catalog Checks

Verified help:

```text
docsfab doctor [--repo <path>] [--live] [--quiet | --verbose] [--json]
docsfab doctor [--repo <path>] [--live] --catalog [--judge] [--json]
docsfab doctor [--repo <path>] --live --answer-submission [--answer-submission-typed-contingency] [--json]
docsfab doctor [--repo <path>] --live --answer-records --answer-record-corpus <path> [--answer-record-small-groups | --answer-record-typed] [--json]
docsfab profile inspect [--judge] [--catalog] [--verbose | --json]
```

`--live` combines with `--json`: the live record is the same canonical
schema-v1 envelope as the offline one, with the same top-level fields, and
it is the only machine-readable mode in which `gitlabTargetBranch`,
`gitlabTargetRevision`, and a `ready` `draftMrReadiness` state carry
observed values. Offline doctor
does not call a model unless you add `--live`. The GitLab connectivity verdict
comes from the same target observation used for draft-MR readiness. A valid
local credential alone does not make an unreachable GitLab API ready.
Connection reset, timeout, or TLS failure prints a network retry action.
An authentication refusal prints `glab auth login --hostname <host from the selected remote>`.
`--catalog` inspects staged profile readiness rather than bypassing
repository or delivery checks.

The configuration summary that follows a ready report states the same live
result as the `Live connectivity` line. After a passed check it prints
`Live inference: passed (checked by --live)`, and without `--live` it prints
`Live inference: not requested (use --live)`. A failed or skipped live check
blocks readiness, so the report ends before that summary. Doctor makes one
live check per invocation and does not repeat it for the summary.

The live model check first probes endpoint compatibility: availability,
streaming, native tool calls, the structured-output contract, and the
effective output limit. This adds two small streamed model requests to every
`--live` run, sent before the connectivity turn and bounded by your
effective output limit and `endpointProbe.requestTimeoutMs`. They use the
bound composition's request policy and the same network boundary as run
requests. A
failed check blocks readiness with diagnostic `endpoint-incompatible`, or
`provider-live-unavailable` for provider capacity. The diagnostic quotes the
provider's own message, such as an HTTP 410 end-of-life notice, and names an
owner and the check's next action. The `endpointCompatibility` field carries
the full report. Refer to
[Read the Endpoint Compatibility Verdict](../reference/status-and-configuration/endpoint-compatibility.md#read-the-endpoint-compatibility-verdict).

When an HTTP proxy carries the live check and the proxy fails the request,
doctor reports the proxy's own code in the `provider` area instead of
`endpoint-incompatible` or `provider-live-unavailable`. This holds on both API
formats: the endpoint probe runs first for `chat_completions`, and the
connectivity turn alone runs for `messages`. The following table lists the proxy codes.

The following table lists each code and its meaning.

| Code | Meaning |
| --- | --- |
| `outbound-proxy-unreachable` | The proxy refused the connection or its host name did not resolve. |
| `outbound-proxy-denied` | The proxy answered the tunnel request with HTTP 403. |
| `outbound-proxy-auth-required` | The proxy answered the tunnel request with HTTP 407. |

The diagnostic names the proxy variable, never its value, and its next
command is the code's own next action. An unreachable proxy is a network
fault. The connectivity turn retries it with the default in-turn backoff, so
on the `messages` format the code appears after about 51 seconds. Offline
`doctor` never connects to the proxy.

A proxy setting that DocsFab refuses outright produces a `configuration`
diagnostic with `--live`: `outbound-proxy-invalid` names every refused
variable, and `outbound-proxy-not-enabled` reports a Node.js release without
built-in proxy support. The failed live check also emits a separate, safe
`provider` diagnostic, so both blocked areas have a next action. Refer to
[Proxy Failures](../reference/security-and-trust.md#proxy-failures) for every code.

## Related

Use these topics for the supporting contracts and next actions.

- [Inspect Operational Limits](inspect-operational-limits.md)
- [Support Matrix](../reference/support-matrix.md)
- [Probe a Model Route](../configure/probe-model-route.md)

## Configuration Directory Refusal

`configuration-root-not-private` means the effective configuration root does not have the required `0700` mode. Follow [Configuration Storage and Permissions](local-configuration.md#configuration-storage-and-permissions) before retrying doctor. An unreadable host limits file is advisory: `host-limits-file-unreadable` reports that the file was skipped. Refer to [Configure Host Limits](configure-host-limits.md).

## Earlier Section Links

<a id="generator-capability-matrix"></a>

Refer to [Generator Capability Matrix](../reference/status-and-configuration/generator-capabilities.md#generator-capability-matrix).

<a id="answer-submission"></a>

Refer to [Answer Submission](qualify-answer-submission.md#answer-submission).

<a id="answer-records"></a>

Refer to [Answer Records](qualify-answer-records.md#answer-records).

<a id="small-groups"></a>

Refer to [Small Groups](qualify-answer-records.md#small-groups).

<a id="typed-slice-1b"></a>

Refer to [Typed Slice 1B](qualify-answer-records.md#typed-slice-1b).

<a id="configuration-roots"></a>

Refer to [Configuration Roots](local-configuration.md#configuration-roots).
