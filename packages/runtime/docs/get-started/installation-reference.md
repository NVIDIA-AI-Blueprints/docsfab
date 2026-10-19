# Install and configure DocsFab

Install from a local DocsFab source checkout, which should already be available
to you. The package requires Node.js 24.21.0 or later and runs on macOS and
Linux. A target project must be an existing local Git checkout.

## Install from a DocsFab checkout

From the DocsFab repository root, install dependencies and install the runtime
CLI globally:

```bash
npm --prefix packages/runtime ci
npm install --global ./packages/runtime
```

Then verify the command and configure a model when you are ready for model-backed
work:

```bash
docsfab --version
docsfab help
docsfab list
docsfab test
docsfab setup
```

`docsfab test` is a deterministic offline smoke check. It does not require a
model key, network access, or GitLab credentials. `docsfab setup` asks for a
provider, model, applicable endpoint, and API key, then stores the model profile
and key outside the project checkout. By default the configuration root is
`~/.config/docsfab/`, with `host.yaml`, `secrets.env`, and `profiles/`; set
`DOCSFAB_CONFIG_ROOT` to use another normalized absolute directory.
`secrets.env` is private user configuration, not a project file.

A globally installed checkout may link to the source tree. Reinstall after
changing checkout versions if the global command uses a copied snapshot.
Contributor build and validation commands are in
`packages/runtime/CONTRIBUTING.md` in a source checkout.

<details>
<summary>How source-checkout installs refresh compiled files</summary>

The global executable uses `bin/docsfab.mjs`. When its sources or workflow
manifests are newer than the compiled launcher, or generated inputs such as
`config/limits/` or `packages/skills/` are newer, the wrapper regenerates stale
derived files and rebuilds `dist/`. It also rebuilds when the compiled catalog
and `workflows/` name different workflow sets. It prints an
`ensure-derived: regenerated ...` line for each file it rewrites. Packed
installs omit source files and do not rebuild.

Set `DOCSFAB_SKIP_AUTO_BUILD=1` to prevent automatic rebuilds; a stale checkout
then runs the existing compiled files with a note. If the global command still
targets `dist/launcher.js`, run the global install command again to retarget it
to `bin/docsfab.mjs`. A failed rebuild leaves the previous `dist/` in place and
suggests reinstalling dependencies with `npm --prefix packages/runtime ci`.
If a generator or a configuration file it loads is malformed, the wrapper
cannot establish freshness: with automatic rebuilding enabled it reports the
load error during the rebuild; with rebuilding skipped, it launches the
existing compiled files and reports the uncertainty. After pulling source
changes, rerun the global install command if npm installed a snapshot instead
of a link.

</details>

## Choose a target repository

Pass the path of an existing local Git checkout with `--repo` (or run the
command from that checkout). DocsFab does not clone Git URLs. Local review and
patch work can use GitHub repositories or other Git repositories; GitLab is
needed only for the current merge-request delivery path.

Run a read-only review:

```bash
docsfab run review-documentation --repo /path/to/repository
```

The local live agent keeps a conversation associated with the checkout. It can
edit documentation by default; `--read-only` disables edits and host commands.

```bash
docsfab live-agent --repo /path/to/repository
# Use this option when the conversation should not edit or run commands:
docsfab live-agent --repo /path/to/repository --read-only
```

The live agent limits edits to documentation paths and asks for terminal
approval before running host commands. It does not grant commit, push, merge
request, or merge authority.

## Retain a patch or open a merge request

Write workflows require an instruction and default to creating a branch and one
draft GitLab merge request. This delivery needs a GitLab remote, authenticated
`glab`, and permission to push and create a merge request. The
`create-documentation` and `update-documentation` workflows can bind a public
GitHub pull request as immutable change input, but the CLI does not create
GitHub pull requests.

Use `--patch-only` to retain an unapplied local patch. This path needs neither
a configured remote nor `glab`:

```bash
docsfab run update-documentation \
  --repo /path/to/repository \
  --instruction "Update the installation guide for the new setup command" \
  --patch-only
```

Use `--dry-run` to preview the selected workflow and delivery mode without
inspecting the target or calling a model. `bootstrap` is a special case: it
prepares repository guidance as a local patch and requires `--allow-write`:

```bash
docsfab run bootstrap --repo /path/to/repository --allow-write --patch-only
```

For the full command contract, run `docsfab run --help`. For the workflow model
and result boundaries, see `docs/reference/runtime-contracts.md` in a source
checkout.

## Repository setup for GitLab delivery

The local review and `--patch-only` paths do not require GitLab setup. To use
default draft merge-request delivery, install `glab`, authenticate to the
GitLab host used by the repository, and ensure your account can push a branch
and create a merge request. Then run a write workflow with its required
instruction. DocsFab verifies the selected remote and delivery prerequisites
before delivery. `create-documentation` and `update-documentation` can use
public GitHub pull requests as change input; the current CLI does not create
GitHub pull requests.

## Private configuration and run data

`docsfab setup` stores the model profile and secret outside the project. DocsFab
also keeps conversation state, run records, and retained patches in
user-private locations; they are not committed to the target repository.
The model key is stored in the private DocsFab `secrets.env`; SCM credentials
stay in the Git credential helper or `glab` login. Do not put credentials in a
command, prompt, project configuration file, or repository.

Check configured operational limits and their headroom with:

```bash
docsfab doctor --limits
```

See `docs/reference/runtime-contracts.md#limits-and-configuration` in a source
checkout for how limit failures are reported.

## Required validation checks

Some workflows run repository validation commands inside a Linux isolation
sandbox. Those checks require working `/usr/bin/bwrap`. The macOS CLI supports
other operations, but its live-agent command sandbox cannot run these required
checks. Ubuntu 24.04 and Windows 11 WSL2 with Linux Node.js and Linux filesystem
storage are supported environments for this validation path. For host setup
and isolation limits, refer to
`packages/runtime/docs/get-started/docker-dogfood.md` in a source checkout.

## Initialize a GitLab repository

`docsfab init` is the GitLab project setup path. In a GitLab repository with
`git` and `glab` available, it discovers the selected GitLab remote, default
branch, existing login, and model-profile configuration, then previews the
changes before writing. For prompt-free use, preview first and then apply only
with the exact digest from that preview:

```bash
docsfab init --repo /path/to/repository --remote origin --non-interactive
docsfab init --repo /path/to/repository --remote origin --non-interactive \
  --apply --approve-plan-sha256 <exact-preview-digest>
```

The project file `.docsfab.json` contains the schema version, selected GitLab
remote and default branch, a declaration that provider configuration remains
host-managed, and a declaration that storage remains user-private. It can also
declare documentation roots. It contains no credentials, user identity, model
identity, or host path. Commit it after applying initialization so
revision-bound workflows can read the tracked configuration. Do not ignore the
project file. Local review and `--patch-only` work do not need this GitLab setup.

## Update or uninstall

To update a checkout-based install, pull the desired DocsFab revision, then
from its root run:

```bash
npm --prefix packages/runtime ci
npm install --global ./packages/runtime
docsfab --version
```

This install builds from the checkout. Keep generated files from one package
version together; do not copy `dist/`, `skill-crate/`, or `governed-assets/`
between versions. To remove the CLI:

```bash
npm uninstall --global docsfab
```

Uninstalling the command leaves model configuration, conversations, run
records, and retained patches in their separate user-private locations.
