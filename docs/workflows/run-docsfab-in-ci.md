---
title: Run DocsFab in CI
description: Provision credentials, bind an installed composition, stage evidence, and assess documentation impact after each merge in a DocsFab job that runs unattended in a CI/CD pipeline.
status: draft
content.type: how_to
---

<Note title="Scope">
This page explains how to run DocsFab from a CI/CD pipeline you define. It
also describes the live-model jobs in this repository's GitLab configuration;
those jobs are examples, not a general feature that watches another
pipeline. For documentation proposals after CI, refer to
[Propose Documentation After CI in DocsFab](automatic-ci-proposals.md).
</Note>

Running DocsFab in a CI/CD pipeline differs from an interactive terminal in
five ways. Each one produces a confusing failure if you miss it, because the
error looks like a bad credential or a broken installation rather than a
missing piece of pipeline configuration. For more information, refer to
[About DocsFab Workflows](index.md).

The five differences are the following:

1. Setup has to run non-interactively, and it needs its credential in the
   environment before you call it.
2. The installed composition you bind determines which credential variable
   name (or names) DocsFab reads. Some compositions accept more than one
   name; none accept an arbitrary one.
3. The endpoint you configure has to match the exact origin DocsFab recorded
   for that composition, or the run refuses closed.
4. Some private output roots must resolve outside the checkout, while most
   CI platforms only collect artifacts from inside it.
5. A credential stored as a protected CI/CD variable is not injected on an
   unprotected branch or merge request pipeline, so a job that only runs on
   protected refs fails everywhere else with what looks like a missing key.

This page walks through the general setup and evidence pattern for a job you
define. The repository's own live-model jobs use a supported setup helper and
provide a current example; their presence does not mean every pipeline runs
them or that a separate real-provider acceptance is complete.

## Before You Start

Complete the steps in [Install DocsFab](../get-started/installation.md) once, interactively,
so you have a known-good local baseline. Confirm the credential-free checks
pass before you add a live step to a pipeline:

```bash
docsfab doctor
docsfab list
```

Identify the installed composition your job should bind, and confirm you can
provision its credential as a masked, protected CI/CD variable. The rest of
this page assumes both are ready.

## Choose an Installed Composition

An installed composition binds a model, serving route, transport, and
credential contract. List the compositions your DocsFab package ships:

```bash
docsfab composition list
docsfab composition list --json
```

The registry backing that command is
`packages/runtime/model-compositions/composition-registry.json`. It lists
every installed composition, including some `docsfab setup --profile`
refuses to select: a `retired` record (a model the provider has withdrawn)
and a `preflight-only` record (an opaque, CLI-managed credential such as a
Codex or Claude Code subscription login, not a route DocsFab can call
directly). Setup only accepts a record whose `status` is `active` and
whose `executionClass` is `pi-provider`; check both fields, or run
`docsfab composition list --json` and filter on them, before picking an id.

Each eligible record's `compositionId` is the value you pass to
`docsfab setup --profile`. For example, the registry's
`nvidia-inference-gpt-6-sol-pi` record, which DocsFab's own CI
binds, declares serving route `nvidia-inference-api` and a single accepted credential
name, `MODEL_API_KEY`. The secondary
`nvidia-inference-claude-sonnet-5-pi` record uses the same route
and credential but has known workflow gaps. Refer to
[Execution Compositions in DocsFab](../reference/status-and-configuration/execution-compositions.md)
for the current installed table.

## Provide the Credential the Route Requires

Do not assume every route accepts exactly one credential variable name.
Each installed composition declares its own accepted names in
`authentication.sourceNames`, and DocsFab reads that array, not a
per-route rule, when it resolves the credential. Check the
`sourceNames` array of the composition you bind. From
`packages/runtime/model-compositions/composition-registry.json` and
`packages/runtime/src/model-composition/contracts.ts`, the currently
installed executable compositions group into the following serving routes.

| Serving route | Accepted `sourceNames` | Aliases accepted |
| --- | --- | --- |
| `nvidia-api-catalog` | `DOCSFAB_NVIDIA_API_KEY` | None. `MODEL_API_KEY`, `NVIDIA_API_KEY`, and `NGC_API_KEY` do not substitute. |
| `nvidia-inference-api` | `MODEL_API_KEY` | None. |
| `openai-api` | `MODEL_API_KEY`, `OPENAI_API_KEY` | Either name works; do not set both. |
| `anthropic-api` | `MODEL_API_KEY`, `ANTHROPIC_API_KEY` | Either name works; do not set both. |

The two NVIDIA policy routes accept exactly one name each, with no alias.
`openai-api` and `anthropic-api` accept `MODEL_API_KEY` as a common name or
their provider-specific name. This table reflects the compositions
installed today; verify a new or changed composition's own
`sourceNames` rather than assuming it follows this pattern.

Setting a variable name the composition does not accept fails closed:
DocsFab reports the composition's credential as unavailable even though a
different key is present in the environment. Setting more than one
accepted name for the same composition at once also fails closed: DocsFab
treats that as an ambiguous credential and refuses to pick one. If you hit
the single-name failure on an NVIDIA policy route, refer to
[No Model Profile or Model Key Is Configured](../troubleshooting.md#no-model-profile-or-model-key-is-configured).

Store the credential as a **masked and protected** CI/CD variable under the
name the route requires. Do not put it in `.docsfab.json`, a committed
`.env`, or a job log.

## Bind the Host Policy Profile Non-Interactively

`docsfab --help` states the supported recipe: noninteractive setup
bootstraps the host policy profile when the required credential is already
available. Run setup with `--profile` and the composition id once per job
(or once per persistent runner, if your host configuration root survives
between jobs):

```bash
docsfab setup --profile nvidia-inference-gpt-6-sol-pi
```

This writes `activeExecutionProfile` and `compositionId` into `host.yaml`,
and updates `secrets.env`. What it writes into `secrets.env` depends on
whether the required credential is already present in the environment when
you run setup. If it is, setup writes that supplied value into
`secrets.env` under the composition's required name, inside the DocsFab
configuration root; it does not just record the name. If it is not, and
`secrets.env` does not already exist, setup writes the required name with
an empty value, as a placeholder. Either way, setup does not copy the other
model fields by hand, and it does not start an agent. Setup validates the
local configuration only; it does not make a provider request.

DocsFab does not invent a credential value, but "operator-supplied" does
not mean "never persisted": the value you supply lands on disk, in a
`0600` (owner-only) file inside the configuration root, which by default is
`~/.config/docsfab` and persists between invocations. That is exactly why
the "once per persistent runner" guidance below works: a value setup wrote
on one run is still there, in that same `secrets.env`, on the next run
against the same configuration root. Do not put the value in
`.docsfab.json`, a committed `.env`, or a job log; `secrets.env` under the
configuration root is DocsFab's own supported place for it.

If the route's credential variable is not set at invocation time, setup
stops instead of writing a half-configured profile. On a split
(`host.yaml` / `secrets.env`) configuration root, the message names the
missing variable:

```text
Set MODEL_API_KEY in the environment or secrets.env, then rerun docsfab setup.
```

`nextCommand` in the JSON result is `docsfab setup`; the status is
`blocked-missing-credential`. This is the correct behavior when the
credential is legitimately absent, but it is also what you see when a
protected CI/CD variable silently did not inject. Refer to
[Protected Variables Are Not Injected on Unprotected Refs](#protected-variables-are-not-injected-on-unprotected-refs)
before assuming the secret itself is wrong.

For the field-by-field meaning of every value this step materializes, refer
to
[DocsFab Model Profile Field Reference](../reference/status-and-configuration/model-profile-fields.md).

### How This Repository Prepares Live-Model Configuration

The repository's `.gitlab/ci/runtime.yml` defines four jobs that prepare a
live-model configuration: `runtime:live-model`, `runtime:live-journey`,
`runtime:mr-assessment`, and `runtime:workflow-canary`. Each uses
`packages/runtime/scripts/prepare-live-model-ci-config.ts` when its
credential is available. The helper refuses a configuration root inside the
collected checkout, then calls the supported `runSetupBootstrap` flow with
the installed `nvidia-inference-gpt-6-sol-pi` composition and setup purpose.
It accepts only a `ready` result. It does not write host configuration by
calling lower-level file writers directly.

The three secret-store-backed jobs stop before their model command when
`MODEL_API_KEY` is missing. `runtime:mr-assessment` uses a copied protected
project variable; when that key is missing, it records an insufficient
evidence result instead of preparing configuration. The jobs have different
rules and purposes, so a pipeline does not necessarily run all four. Their
configuration does not establish that a real-provider acceptance has passed.

For a job you define, the `docsfab setup --profile` recipe above remains the
supported command-line setup path. The helper is an implementation detail of
this repository's CI jobs, not a general public CLI interface.

## A Different Base URL Runs as an Override

Every installed composition records `deployment.bindingKind: "exact-origin"`
and a digest over its exact origin, request path, and provider. The route
registry, `packages/runtime/src/config/executable-route-urls.js`, records one
exact origin per executable route. The public routes use the following origins.

| Route | Exact origin |
| --- | --- |
| `nvidia-api-catalog` | `https://integrate.api.nvidia.com/v1` |
| `openai-api` | `https://api.openai.com/v1` |
| `anthropic-api` | `https://api.anthropic.com/v1` |

`docsfab setup --profile <compositionId>` sets the composition's own origin, so
a job that sets nothing else runs against it. A job that sets `MODEL_BASE_URL`,
or a `baseUrl` setting, to another endpoint, such as a gateway in front of the
route, runs against that endpoint. DocsFab prints a warning that names the
endpoint's scheme and host and the composition's origin, and the run record
keeps the endpoint, its source, and the warning. Composition-execution evidence
records the deployment identity the run used beside the recorded one.

A base URL still stops the run before any request when it is plain HTTP to a
host other than this machine, or carries a user name, password, query, or
fragment. Refer to
[Change a Preset's Settings](../configure/override-model-settings.md).

## Emit Collectable Evidence From Outside the Checkout

DocsFab's acceptance CLI (`npm run acceptance`, inside `packages/runtime`,
with the `--live` flag for a real provider turn) writes its state and
evidence under explicit `--state-dir` and `--evidence-dir` roots. Those
roots are canonicalized by `canonicalizeAcceptanceOutputRoot` in
`packages/runtime/src/acceptance.ts`, which calls `assertOutsideRepository`
and refuses a root that resolves inside the source checkout:

```text
<label> must be outside the source repository.
```

Most CI platforms only collect artifacts from inside the project directory,
so a root outside the checkout is exactly what most CI configuration cannot
declare as an artifact path. Point `--state-dir` and `--evidence-dir` at a
runner-local path outside the checkout, then copy only the evidence file
your pipeline needs into a small directory inside the checkout afterward.
For example, on a self-hosted runner that already exposes a runner-local
root as an environment variable:

```bash
npm run acceptance -- \
  --state-dir "$RUNNER_LOCAL_ROOT/state" \
  --evidence-dir "$RUNNER_LOCAL_ROOT/evidence" \
  --live \
  --approve-model-url "$approve_url"

stage="$CI_PROJECT_DIR/packages/runtime/ci-results/your-job"
mkdir -p "$stage"
evidence="$RUNNER_LOCAL_ROOT/evidence"
if [ -d "$evidence" ]; then
  find "$evidence" -name manifest.json -type f -exec cp {} "$stage/manifest.json" \;
fi
```

`$RUNNER_LOCAL_ROOT` stands for whatever runner-local variable your job
configures. The repository's `runtime:live-model` job uses
`DOCSFAB_TEST_TRUSTED_ROOT` for the acceptance state and evidence roots, then
uses `--collect-dir` to stage the collectable manifest under the checkout.
Other live-model jobs also keep private run data outside the checkout and
stage their intended reports under `packages/runtime/ci-results/`. Declare
only the in-checkout staging directory in GitLab's `artifacts: paths:`. Apply
the same pattern to any DocsFab command that writes owner-private evidence:
write outside the checkout, then copy or stage only the files the pipeline
needs to inspect.

## Protected Variables Are Not Injected on Unprotected Refs

This is the single most confusing failure, because it presents as a
credential problem. GitLab does not inject a protected CI/CD variable into a
pipeline running on an unprotected branch or a merge request. A job that
reads `MODEL_API_KEY` on such a ref sees an empty value, not an error
naming the ref as the cause, and `docsfab setup` reports
`blocked-missing-credential` exactly as it would for a genuinely unset key.

Guard the job explicitly instead of letting `docsfab setup` produce
an ambiguous stop. Fail fast with a message that names the actual cause:

```bash
if [ -z "${MODEL_API_KEY:-}" ]; then
  echo "MODEL_API_KEY is not present in this pipeline." >&2
  echo "Protected variables are not injected on unprotected branches or MR" >&2
  echo "pipelines, so confirm this pipeline is running on a protected ref." >&2
  exit 1
fi
```

Scope the job's `rules:` to protected refs so it only ever runs where the
variable is actually available, for example a scheduled pipeline against
the default branch, or a manually triggered `web` or `api` pipeline against
the default branch, and never a merge request or a feature branch. Consider
also marking the job `allow_failure: true` and running it independently of
your required merge gate: a live provider is non-deterministic, and a job
that calls one should not block a merge before its flake rate is known.

## Verify the Binding Before You Spend a Run

Before running a workflow, confirm the profile DocsFab actually bound:

```bash
docsfab profile inspect --json
docsfab doctor --live
```

`docsfab profile inspect` reports the active model, provider route, bound
composition id, and readiness without making a provider request.
`docsfab doctor --live` adds a live-reachability check. Inspect both before
trusting a pipeline job that has not yet run a real workflow.

## Assess Documentation Impact After Each Merge

A job on the default branch can ask DocsFab whether the commits that a push
added need a documentation update. The job names those commits with
`--change`, runs `update-documentation` over them, and opens one draft merge
request when the run changes documentation. When the run verifies that no
documentation change is needed, DocsFab opens no merge request. Whether a
change needs documentation is the model's judgment; the job only decides
which commits the run reads.

```yaml
docsfab-docs-impact:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_COMMIT_REF_PROTECTED == "true"'
  variables:
    GIT_DEPTH: "0"
    DOCSFAB_DOCS_PATH: docs
    DOCSFAB_GIT_USER_NAME: DocsFab CI
    DOCSFAB_GIT_USER_EMAIL: docsfab-ci@example.com
  before_script:
    - docsfab setup --profile nvidia-inference-gpt-6-sol-pi
  script:
    - |
      case "$CI_COMMIT_BEFORE_SHA" in
        *[!0]*) ;;
        *)
          echo "CI_COMMIT_BEFORE_SHA is the null object ID: this push has no earlier commit to compare, so no documentation impact was assessed for $CI_COMMIT_SHA."
          exit 0
          ;;
      esac
      status=0
      git diff --quiet --no-ext-diff --no-textconv "$CI_COMMIT_BEFORE_SHA" "$CI_COMMIT_SHA" -- . ":(exclude)$DOCSFAB_DOCS_PATH" || status=$?
      if [ "$status" -eq 0 ]; then
        echo "Every path this push changed is under $DOCSFAB_DOCS_PATH, so no documentation impact was assessed."
        exit 0
      fi
      if [ "$status" -ne 1 ]; then
        exit "$status"
      fi
      git checkout -B "$CI_COMMIT_BRANCH" "$CI_COMMIT_SHA"
      git remote set-url origin "https://$CI_SERVER_HOST/$CI_PROJECT_PATH.git"
      git config user.name "$DOCSFAB_GIT_USER_NAME"
      git config user.email "$DOCSFAB_GIT_USER_EMAIL"
      docsfab run update-documentation \
        --repo "$CI_PROJECT_DIR" \
        --instruction "Check whether this change needs a documentation update, and update the affected pages if it does." \
        --change "$CI_COMMIT_BEFORE_SHA..$CI_COMMIT_SHA" \
        --draft-mr
```

Each of the following parts of the job guards a failure you would otherwise meet in a pipeline:

- **Protected default-branch pushes only.** The `rules:` entry runs the job
  after a push to the protected default branch, where protected CI/CD
  variables are injected, and never on a merge request, a schedule, or a
  feature branch. Refer to
  [Protected Variables Are Not Injected on Unprotected Refs](#protected-variables-are-not-injected-on-unprotected-refs).
- **Full history.** `GIT_DEPTH: "0"` makes the runner clone the full
  history, so `CI_COMMIT_BEFORE_SHA` and every commit after it are present.
  In a shallow clone, a `CI_COMMIT_BEFORE_SHA` outside the fetched history
  fails the job's `git diff`, and `docsfab run` refuses the same range with
  `change-source-history-unavailable` before any model call. A range that
  crosses the shallow boundary carries the `commit-list-incomplete-shallow`
  label. After a force-push, `CI_COMMIT_BEFORE_SHA` can name a commit the
  clone does not contain. The job's `git diff` then fails, and the job fails
  without assessing the push.
- **No earlier commit.** GitLab sets `CI_COMMIT_BEFORE_SHA` to the null
  object ID, every digit zero, when a push creates the branch. The `case`
  test matches a value made only of zeros at any length, so it recognizes the
  null ID of a SHA-1 repository and of a SHA-256 repository alike, and the job
  says why it assessed nothing instead of passing a range that cannot
  resolve.
- **No loop on DocsFab's own merge request.** When you merge the draft
  merge request that DocsFab opened, the merge is itself a push to the
  default branch. The `git diff --quiet` test ends the job when every path the
  push changed is under `DOCSFAB_DOCS_PATH`, so merging a documentation-only
  change does not start another run. The test reads paths, not the branch
  name or the commit message: a push pipeline does not expose the merged
  branch's name, and a commit message is text the author controls. Set
  `DOCSFAB_DOCS_PATH` to the directory your documentation lives in. A merge
  that also changes paths outside it starts one more assessment. GitLab's
  `rules: changes` cannot express "a path outside this directory changed",
  which is why the job tests it in the script.
- **A fixed instruction.** The `--instruction` text is the same on every
  run. Never build it from `$CI_COMMIT_TITLE`, `$CI_COMMIT_MESSAGE`,
  `$CI_COMMIT_DESCRIPTION`, or a merge request title or description: the
  person who wrote that text controls it, and it would reach the model as
  your request. The commits reach DocsFab only through `--change`.
- **A branch and an uncredentialed remote.** GitLab checks out the pushed
  commit with a detached `HEAD`, and its clone URL can carry the job token.
  Draft merge request delivery refuses both, with `detached-head` and
  `unsupported-remote`, so the job checks out the default branch at the pushed
  commit and points `origin` at the project URL without credentials.
- **A Git identity for the commit.** DocsFab commits as the Git identity that
  the checkout resolves: its own `user.name` and `user.email`, else the
  runner's global or system Git identity, else the GitLab account that the
  job's token belongs to. Planning and publication read the same identity. The
  job sets `user.name` and `user.email` in the checkout's own Git
  configuration, so the commit carries the identity that you choose.

Draft merge request delivery has the same conditions in CI as on a
workstation. Refer to the delivery conditions in
[Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md#before-you-start).
In the job, `glab` must be installed and authenticated for the GitLab host,
for example through a `GITLAB_TOKEN` stored as a masked, protected CI/CD
variable. `git` must be able to push a branch to `origin`. Set
`DOCSFAB_GIT_USER_NAME` and `DOCSFAB_GIT_USER_EMAIL` to the identity that
DocsFab's commit carries. If the
project's push rules check commit authors, use the name and email of the
account whose token publishes. The job sets
`origin` to an HTTPS URL, and git reads HTTPS push credentials only from a
credential helper, never from an SSH agent. Set that credential helper in the
runner user's global Git configuration (`~/.gitconfig` or
`~/.config/git/config`) or in the runner's system Git configuration
(`/etc/gitconfig`). Delivery refuses a credential helper that runs a shell
command (a value that starts with `!`), and one set in any other file,
including the repository's own configuration. The run checks the Git
configuration before it calls the model, so a refused setting stops the job
with `git-configuration-refused` and costs no model call. Refer to
[A Draft Merge Request Is Stopped by a Git Setting](../troubleshooting.md#a-draft-merge-request-is-stopped-by-a-git-setting)
for the settings that DocsFab accepts and refuses.

The job does not add a delivery path. It opens a merge request only through
the default draft merge request delivery of `docsfab run`, and a run whose
editorial outcome is `verified-no-change` opens none. It is also not the
intended automatic path described in
[Propose Documentation After CI in DocsFab](automatic-ci-proposals.md): the job runs only
because you defined it.

## Related

Use these topics for the supporting contracts and next actions.

<CardGroup cols={2}>
  <Card
    title="DocsFab Model Profile Field Reference"
    href="/reference/status-and-configuration/model-profile-fields"
  >
    [DocsFab Model Profile Field Reference](../reference/status-and-configuration/model-profile-fields.md)
  </Card>
  <Card
    title="Runtime CLI and Configuration in DocsFab"
    href="/reference/status-and-configuration/runtime-cli-and-configuration"
  >
    [Runtime CLI and Configuration in DocsFab](../reference/status-and-configuration/runtime-cli-and-configuration.md)
  </Card>
  <Card
    title="Troubleshooting DocsFab"
    href="/troubleshooting"
  >
    [No Model Profile or Model Key Is Configured](../troubleshooting.md#no-model-profile-or-model-key-is-configured)
  </Card>
  <Card
    title="Model-Profile Approval in DocsFab"
    href="/reference/status-and-configuration/model-profile-approval"
  >
    [Model-Profile Approval in DocsFab](../reference/status-and-configuration/model-profile-approval.md)
  </Card>
  <Card
    title="Install DocsFab"
    href="/get-started/installation"
  >
    [Install DocsFab](../get-started/installation.md)
  </Card>
  <Card
    title="Propose Documentation After CI in DocsFab"
    href="/workflows/automatic-ci-proposals"
  >
    [Propose Documentation After CI in DocsFab](automatic-ci-proposals.md)
  </Card>
</CardGroup>
