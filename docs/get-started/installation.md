---
title: Install DocsFab
description: Install DocsFab from a source checkout and configure a model.
status: draft
---

Install the DocsFab command-line interface (CLI) from this repository, explore workflows offline, then configure a model when you are ready to run a model-backed task.

## Prerequisites

You need Node.js 24.21.0 or later, npm, Git, and access to the DocsFab source repository. DocsFab supports macOS and Linux, including Ubuntu on Windows Subsystem for Linux 2 (WSL2). Native Windows Node.js is unsupported. On WSL2, use Linux tools and keep your checkout and DocsFab state in the Linux filesystem.

Some required workflow checks need Linux, `/usr/bin/bwrap` (Bubblewrap), and working unprivileged user namespaces. macOS supports setup and model-backed workflows, but this release has no admitted required-check backend for macOS. Refer to the [Support Matrix](../reference/support-matrix.md) for platform details.

<span id="what-you-need-per-entry-point"></span>
<span id="verification"></span>
<span id="upgrade-roll-back-or-uninstall"></span>
<span id="development-installation"></span>

## Install From a Source Checkout

<span id="install-docsfab"></span>
<span id="install-the-cli"></span>
<span id="clone-docsfab"></span>

This alpha is installed from a source checkout. Open the repository page and copy its HTTPS or SSH clone URL, then run:

```bash
git clone <clone-url-from-the-repository-page> docsfab
cd docsfab
npm --prefix packages/runtime ci
npm install --global ./packages/runtime
docsfab --version
```

`npm ci` installs the runtime dependencies from the lockfile. The global install makes the `docsfab` command available from your shell and links it to this checkout, so keep the checkout in place. The CLI can rebuild missing or stale compiled output when it starts.

<span id="discover-the-cli-without-configuration"></span>

## Explore Without a Model

Installation and local discovery do not require a model key. List workflows and inspect a plan:

```bash
docsfab list
docsfab plan review-documentation
```

The `plan` command shows a workflow's steps without running them. For a first review of a repository, configure a model, enter the target checkout, and start a read-only session:

<span id="set-up-docsfab"></span>

```bash
docsfab setup
cd /path/to/your-repository
docsfab live-agent --read-only
```

Setup asks for a provider, model ID, and API key. The live agent uses the configured model. It allows documentation edits by default; `--read-only` disables edits, workflow writes, and host commands.

## Platform Notes

<span id="windows-11-with-wsl2"></span>
<span id="install-ubuntu-on-wsl2"></span>

On WSL2, prepare Ubuntu 24.04 and use its terminal for every command after installation. Install Linux versions of Node.js, npm, Git, and any tools required by your task. Keep the checkout, configuration, and run records under the Linux filesystem, for example `~/work`, rather than `/mnt/c/`.

<span id="prepare-linux-tools"></span>

If a required check needs Bubblewrap, install it with your Linux distribution's package manager and confirm that unprivileged user namespaces work. Do not disable host security policy to make a check pass. The [Support Matrix](../reference/support-matrix.md) lists requirements by operation.

<span id="move-off-a-retired-gpt-5-selection"></span>

## What's Next

Choose the guide that matches your next task:

- [Discover workflows](discover-workflows.md) to inspect available workflows.
- [Live Agent Quickstart](live-agent-quickstart.md) to review or edit documentation in a conversation.
- [Runner Quickstart](runner-quickstart.md) to run a named workflow and retain a local patch.
- [Configure DocsFab](../configure/index.md) to change the model or output location.
- [Manage DocsFab](../manage/index.md) to check local readiness or change an installation.
- [Troubleshooting](../troubleshooting.md) for installation and configuration errors.

<span id="configure-the-model"></span>
<span id="select-an-installed-composition"></span>
<span id="inspect-the-active-profile"></span>
<span id="use-a-self-hosted-nim-on-this-machine"></span>
<span id="advanced-composition-transport-lock-files-and-migration-aliases"></span>
<span id="map-composition-transport-to-the-profile-api-format"></span>
<span id="migration-aliases"></span>
<span id="resolve-common-install-errors"></span>
<span id="secrets-file-lock-semantics"></span>
