---
title: Troubleshooting DocsFab
description: Resolve common DocsFab installation, model setup, workflow, live agent, and merge request delivery problems, and look up the fix for an error code.
template: troubleshooting
status: draft
---

The following issues might arise when you work with
[DocsFab](about/index.md). Most DocsFab failures print a `code:` line and a
`Next action:` line. Follow the printed next action first. If the code is
listed in [Error Messages](#error-messages), use that table for more detail.

## A Command Reports That Git Is Unavailable

When you run `docsfab init`, `docsfab run`, or `docsfab publish`, you might
see a message that Git is unavailable. These commands read an exact Git
revision, so they check for Git before they start.

To resolve this issue, install Git, make sure `git` is on `PATH`, and open a
new shell. Then confirm that `git --version` succeeds, and rerun the
command.

## A Draft Merge Request Is Not Created After a Successful Run

When a write workflow succeeds but delivery stops, the documentation change is
saved with the run. The output can show `stale-revision`, `publication-failed`,
or another delivery code, and `NEXT` prints a recovery command.

To resolve this issue, do not run the workflow again. Run the printed recovery
command, which includes the exact paths that the stopped attempt used. In most
cases, the command is one of the following:

```bash
docsfab ship <run-id> --repo <path>
docsfab publish <run-id>
```

To review the publication plan before DocsFab opens the merge request, run
the two-step form:

```bash
docsfab publish <run-id> --preflight
docsfab publish <run-id> --execute --confirm-plan-sha256 <digest-from-preflight>
```

If `stale-revision` appears before the write, no run is saved. Run
`docsfab doctor --repo <path>` to check the checkout and the GitLab target
branch, update the checkout, and start the run again. If it appears after the
write, the write is saved. Merge the run base into the target branch, and then
run `docsfab ship <run-id> --repo <path>`.

If delivery stops with `run-revision-unpushed`, the run started from a commit
that GitLab does not have, such as a local commit that was never pushed.
DocsFab does not push it for you. Push that commit to the target branch, for
example with `git push origin <run-base>:<target-branch>`, and then run
`docsfab ship <run-id> --repo <path>`. To publish without that commit, start a
new run from the target branch instead.

A failed delivery can retain local worktrees or branches. When that state is
verified, the output and `PUBLICATION` section list the preserved resources
and a cleanup preview command. You can inspect the current retained state
later with `docsfab runs show <run-id>`; pass
`--state-dir` if you selected a different run store. The JSON result has an
optional outer `retainedDelivery` field, independent of the saved merge-request
lookup in `publication` and the workflow result. A retry reuses a verified
retained attempt instead of adding another worktree. Changed attempts stay
available for inspection.

When you no longer need the run, copy the printed `cleanupPreviewCommand`
exactly. It includes the applicable state, delivery, and receipt directories,
including verified custom locations. Review the preview's removal and kept
resource lists, then run its returned confirmation command if you want to
delete that state. DocsFab does not perform this cleanup automatically or
treat the displayed command as confirmation. User branches, worktrees with
uncommitted changes, and resources outside the verified deletion scope stay
protected. Remote branches and merge requests remain on GitLab.

If `retainedDelivery.status` is `inspection-required`, some details could not
be verified or displayed safely. Inspect the original publication directories
and settings before requesting a fresh deletion preview. A
`cleanupPreviewCommand` of `null` means no safe command is available; do not
guess roots or run a command with redacted paths. For more information, refer
to [Delete a Saved Run](workflows/investigate-saved-runs.md#delete-a-saved-run).
For other delivery codes, refer to [Error Messages](#error-messages).

## The Saved Run Record Was Not Found

`docsfab ship` and `docsfab publish` report `saved-run-not-found` when the
selected saved record is absent, including after you delete it. This is an
operator-input refusal, not a diagnosis that the record is malformed. DocsFab
does not reconstruct the deleted run or start publication from its ID.

Run `docsfab runs list` in the same configuration context and select an
existing run. If you passed `--state-dir` to `publish`, pass the same directory
to `runs list`; `ship` uses the configured run store. Correct an unintended run
ID or state-directory selection before retrying. Existing unreadable, unsafe,
or malformed records retain their own refusal.

## A Request That Says Not to Publish Is Refused

When a `docsfab do` sentence or a `--instruction` value says not to publish,
push, or open a merge request, you might see the following message:
`publication-prohibition-conflict`. Create, update, and restructure workflows
open a draft merge request by default, so DocsFab stops instead of choosing
between your instruction and the default delivery.

To resolve this issue, pass `--patch-only` to keep the result as a local
patch, or remove the instruction not to publish.

## A Run Stops Because a Configured Credential Was Found

When a source file, a merge request, or your request text contains one of the
credentials that DocsFab itself uses, such as its model key, the run or the
read stops with `credential-material`. A live agent session reports
`Blocked by DocsFab runtime credential screening`. Text that only looks like a
credential, such as a sample key in an example, is reported as a
`credential-like-content` finding, and the run continues.

To resolve this issue, remove the credential from the source, commit the
change, and rotate the credential with your provider, because it was exposed.
Then start a new run. Do not paste credentials into requests, chat, or
issue reports.

## A Run Stops With needs-input

When DocsFab needs more information, the run stops with `needs-input` and
exit code 2, and `NEXT` tells you what to provide. This can happen at the
following two points:

- **Before a workflow starts:** `docsfab do` prints
  `Outcome route: needs-input` because the sentence matched no workflow or more
  than one. Restate the request in one sentence that names the task, the target
  page, and the outcome, or run a workflow directly with `docsfab run`.
- **After a workflow starts:** the run lists the missing items under
  `PRODUCT`, such as a source file for a fact that DocsFab cannot verify. Add
  the missing file to the repository, commit it, and run the printed
  `docsfab do --continue <run-id>` command, or start a new run that names the
  file with `--source`.

If the run stopped during planning, `docsfab do --continue` reports
`continue-planner-input-unsupported`, because a planning stop cannot continue.
Run `docsfab do --continue` again from the original repository, and pass
`--repo .`, the run ID, and a committed source file with `--attach`. DocsFab
prints a complete `docsfab run` command that keeps the original instruction,
adds the file as `--source`, and pins the current committed revision. You can
pass `--revision <ref>` to nominate a different committed revision. DocsFab
checks every selected source at that revision before offering the command.
Copy the command to start a new run. The stopped run stays unchanged.
A planning `needs-input` stop exits with code `2`. If no file changed before
the stop, DocsFab does not save an empty patch.

When a create, update, or restructure run ends with `writer-made-no-change`,
the writer could not satisfy an instruction and asks one question. Add the
answer to your instruction and start a new run.

For more information, refer to
[Answer and Resume](workflows/answer-and-resume.md).

## An Unexpected Failure Does Not Explain the Cause

When a run or a live agent action fails, you might see a message such as
`No safe failure detail is available` or a code that the run describes as a
DocsFab defect, such as `context-compile-failed`. These failures do not have a
fix that you can apply.

To resolve this issue, collect the details and report the problem to the
DocsFab maintainers:

1. Find the run ID in the output, and run `docsfab why <run-id> --json`.
2. If the failure happened in a live agent session, find the session
   transcript under `~/.config/docsfab/.docsfab/live-agent/sessions/`.
   Run records are under `~/.config/docsfab/.docsfab/runs/`. If you set
   `DOCSFAB_CONFIG_ROOT`, look under that directory instead.
3. Remove any credentials or private content, and include the output in your
   report.

Starting the same run again without changes usually fails the same way.

## An Update Run Fails Because a Cited Source Cannot Be Read

When you run `update-documentation`, the run might fail at the
`derive-source-obligations` step with `source-locator-unobservable`. Older
installations report `not-tracked` and `Tracked repository file read failed`
instead. The model cited a file that DocsFab cannot read as evidence, such as
a missing or untracked file, a symbolic link, or a file that is larger than the
source file limit. DocsFab asks the model to correct the citation within its
retry limit before the run fails.

To resolve this issue, run `docsfab runs show <run-id>` to see where the
rejected citation came from and, when DocsFab can name it, which file it cited.
Check that the file is committed, is a regular file, and is within the size
limit, and then start a new run. A saved patch does not mean that the update
succeeded. The update succeeded only when `derive-source-obligations` and the
later steps complete.

## Installation Fails

Use these steps to resolve common source installation errors:

- For `EBADENGINE`, check `node --version` and use Node.js 24.21.0 or later.
- For dependency or build failures, confirm the checkout is complete, then
  rerun `npm --prefix packages/runtime ci` and
  `npm --prefix packages/runtime run build` from the checkout root.
- For `EACCES` or a global-prefix permission error, configure a user-owned
  global prefix and add its `bin` directory to `PATH`:

  ```bash
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  ```

  Add the `PATH` line to your shell startup file before opening a new shell.
  Do not make `sudo npm` the default.
- If you cannot clone the source repository, ask its owner to grant repository
  access before following the installation steps.

### Registry Authentication or Download Fails

For an alternative registry installation, `E401`, `E403`, or `E404` can mean
that npm cannot authenticate. Confirm that your approved host credential
facility supplies `NPM_TOKEN`, that the token can read the package registry,
and that the user-level npm configuration includes the full project registry
path. A private package can return HTTP 404 when npm is unauthenticated.
Browser and `glab` authentication do not replace npm authentication.
Refer to [GitLab's npm registry authentication documentation](https://docs.gitlab.com/user/packages/npm_registry/#authenticate-to-the-package-registry).

Also confirm that the exact package version and tarball URL exist in GitLab.
For a network or download error, restore access to the internal GitLab host,
then retry the same exact URL.

## DocsFab Reports That Node.js Is Unsupported

When you run any `docsfab` command, you might see the following message:
`DocsFab requires Node.js >=24.21.0; found <version>`. This message appears
when the shell resolves an older Node.js, including a shell that was opened
before you installed or selected a newer version.

To resolve this issue, install Node.js 24.21.0 or later, or select it with
your version manager, such as `nvm use 24`. Then open a new shell and
confirm that `node --version` and `docsfab --version` both succeed. If you use
a version manager, install DocsFab again under the new Node.js version.

## DocsFab Reports That the Platform Is Unsupported

When you run DocsFab on Windows, you might see a message that the platform is
unsupported. DocsFab runs on Linux and macOS only.

To resolve this issue on Windows, install DocsFab inside a Linux distribution
on WSL 2, such as Ubuntu 24.04. Keep the DocsFab installation, the DocsFab
configuration directory, and the repositories that you document in the Linux
file system, such as your home directory. Windows drives that WSL mounts
under `/mnt/` do not keep the owner-only file permissions that DocsFab
requires for its configuration.

For more information, refer to [Install DocsFab](get-started/installation.md).

## Doctor Reports Blocked Readiness

When you run `docsfab doctor --repo <path>`, you might see
`DocsFab readiness: blocked` and one or more diagnostic codes, such as
`project-config-missing`, `provider-credentials-missing`, or
`private-state-missing`. Each diagnostic prints its own `Next action:` line.

To resolve this issue, follow each printed next action. For
`project-config-missing` or `private-state-missing`, preview
`docsfab init` first, and then apply the plan with the digest it prints. For
`provider-credentials-missing`, refer to
[No Model Profile or Model Key Is Configured](#no-model-profile-or-model-key-is-configured).
A blocked `gitlab` check affects only draft merge request delivery. Runs with
`--patch-only` do not need GitLab.

For more information, refer to
[Runtime Readiness and Doctor Checks in DocsFab](manage/check-readiness.md).

## GitLab Authentication or Connection Fails During Delivery

When DocsFab opens a draft merge request, you might see one of the following
codes:

- `glab-auth-login` or `gitlab-unauthenticated`: `glab` is not logged in to
  the GitLab host for the selected Git remote. Run
  `glab auth login --hostname <host>`, using the host from
  `git remote get-url origin`.
- `gitlab-unreachable`: the GitLab API for that host did not respond. Check
  your network or VPN connection, and confirm that
  `glab api --hostname <host> user` succeeds. Do not log in again unless
  `glab auth status --hostname <host>` reports that you are not logged in.
- `glab-unavailable`: the `glab` command is not installed or is not on
  `PATH`. Install the GitLab CLI, or pass `--patch-only` to skip merge
  request delivery.

DocsFab does not store GitLab credentials. After the fix, recover the saved run
as described in
[A Draft Merge Request Is Not Created After a Successful Run](#a-draft-merge-request-is-not-created-after-a-successful-run).

## A Draft Merge Request Is Stopped by a Git Setting

When you run a write workflow that opens a draft merge request, or when you
publish a saved run, you might see `git-configuration-refused`. The message
names the setting and the file that sets it, for example
`The setting core.sshcommand comes from file:.git/config.` DocsFab checks the
Git configuration before it starts the model, so a refusal at that point costs
no model call and creates no run. `docsfab doctor --live` runs the same check
and reports the refusal as a blocker for the draft merge request. DocsFab checks
again at publication, before it commits, before it pushes, and before it opens
the merge request. A publication that fails with this code saves the write. The
`state` in the publication result shows how far publication got. A `state` of
`planned`, `prepared`, or `validated` means that DocsFab had not committed. A
`state` of `committed` means that it had committed and pushed nothing. A `state`
of `pushed` means that it had pushed the branch and opened no merge request.

The checkout's Git configuration, or your global or system Git configuration,
holds a setting that can run a command, change how DocsFab pushes, or turn
signing on. The check before the model run and the check at publication apply
one policy. DocsFab refuses these settings in any Git configuration file:

- `core.hooksPath`, `core.fsmonitor`, and `core.gitProxy`
- `remote.<name>.receivepack`, `remote.<name>.uploadpack`,
  `remote.<name>.proxy`, `remote.<name>.mirror`, and
  `remote.<name>.pushOption`
- `http.<url>.extraHeader`, `http.<url>.proxy`, and `push.pushOption`
- a credential helper for the GitLab host that runs a shell command (a value
  that starts with `!`)

DocsFab refuses these settings unless they come from a Git configuration file
that it trusts:

- `core.sshCommand` and `core.askPass`
- `commit.gpgSign` and `tag.gpgSign` set to anything other than a false value,
  `gpg.*`, and `user.signingKey`
- `url.<base>.insteadOf` and `url.<base>.pushInsteadOf`
- `include.path` and `includeIf.<condition>.path`
- any credential helper for the GitLab host

DocsFab accepts `commit.gpgSign` and `tag.gpgSign` from any file when the value
is `false`, `no`, `off`, or `0`. The match is not case sensitive. DocsFab turns
signing off on its own Git commands, so a repository that turns it off asks for
nothing.

DocsFab trusts only these Git configuration files:

- your global files, `~/.gitconfig` and `~/.config/git/config`
- the system files `/etc/gitconfig`, `/usr/local/etc/gitconfig`, and
  `/usr/share/git-core/gitconfig`
- the same `usr/share/git-core/gitconfig` file under
  `/Library/Developer/CommandLineTools` and
  `/Applications/Xcode.app/Contents/Developer`
- the `etc/gitconfig` file of a Git for Windows installation under
  `Program Files` or `Program Files (x86)`

A setting from any other file is not trusted. That includes the checkout's own
configuration, a file that another configuration file includes, and a system
file at another path. For example, Homebrew Git on Apple silicon sets a
credential helper in `/opt/homebrew/etc/gitconfig`, and DocsFab refuses it.

For `core.sshCommand` and `core.askPass`, a global file counts only when the
`HOME` environment variable is an absolute path that is not inside the
checkout. Git reads a relative `HOME`, such as `~` or `.`, as a path in the
directory where it runs, and a file under a `HOME` inside the checkout can come
from the repository. DocsFab refuses both settings from such a file, and the
message says that `HOME` is the reason. The system files always count, and
every other setting that DocsFab accepts from a trusted file is accepted as
before.

To find the setting, list the configuration that Git applies in the checkout,
with the file that each setting comes from. If the setting is `core.sshCommand`
or `core.askPass` in a global file, check that `HOME` is an absolute path
outside the checkout:

```bash
git config --show-origin --list
echo "$HOME"
```

To resolve this issue, remove the refused setting from the file that sets it. A
`core.sshCommand` or `core.askPass` in the checkout's own configuration can move
to your global Git configuration, where DocsFab accepts it when `HOME` is an
absolute path outside the checkout. To use a different SSH key for one host, you
can set `IdentityFile` for that host in your SSH configuration instead. A
signing key, URL rewrite, include, or credential helper can also move to your
global Git configuration. Then run the same command again. If DocsFab had
already written the change, retry publication of the saved run instead. The
workflow does not run again:

```bash
docsfab publish <run-id>
```

A retry that still finds a refused setting fails with
`git-configuration-refused` again and keeps the publication retryable, even
after DocsFab committed. When the setting is gone, the retry publishes the
preserved write. A publication that an earlier failure had already recovered to
patch-only cannot publish again. It reports the refused setting with the next
action `review-preserved-patch`, so review the preserved patch instead.

After you remove the setting, the run starts the model, or the retry opens the
draft merge request, or either fails with a different typed code.

## Repository Access

When DocsFab reports `repository-ownership-mismatch`, Git refused to read the
selected repository because its ownership does not match the current process.
When DocsFab reports `repository-access-denied`, Git could not read the
selected repository with the current process permissions. These frozen
messages appear in the standard operator error envelope. Both errors have the
`operator-input` classification at the `host` failure layer. The repository
preflight runs before workspace materialization. An earlier intent-admission
step might already have made a model call.
These codes identify failures recognized during repository preflight. A later
tree or blob read can still report a materialization error.

Git ownership protection and filesystem permissions are separate checks. A
checkout can be readable but rejected by Git because another user owns it. A
checkout can also have the expected owner while denying the runtime user read
access to files or search access to a directory.

To resolve either error, run DocsFab as the checkout owner, or prepare a
dedicated CI or container checkout for the DocsFab user. If ownership already
matches, grant that user read access to repository files and Git metadata, and
search access to parent and repository directories. A read-only source mount
can work when those permissions are present. Keep writable runtime state and
exported run results in separate directories. In container or CI setups,
verify the user and mounts before retrying.

Do not recursively change ownership across a customer repository as a general
fix, and do not disable Git's ownership protection with `safe.directory=*`.
Repair only the checkout or private job copy that you own. A permission or
ownership failure is distinct from `git-configuration-refused` and
`git-checkout-unverified`; follow the printed next action for those Git
configuration errors.

For setup guidance, refer to
[Runner Quickstart](get-started/runner-quickstart.md#prerequisites).

## DocsFab Cannot Verify the Git Setup of a Checkout

When you run a write workflow that opens a draft merge request, or when you
publish a saved run, you might see `git-checkout-unverified`. DocsFab could not
verify the checkout's Git setup, and it stopped. A publication that fails with
this code saves the write.

Before the model starts, DocsFab raises this code when
`git config --show-origin --list` fails, prints more than
`delivery.gitConfigurationListingMaxBytes`, or prints something DocsFab cannot
read. At publication, DocsFab raises it for any of these conditions:

- Git is older than 2.9.5, or `git version` prints something DocsFab cannot
  read.
- The remote's URL no longer names the host, project, and transport that the
  publication plan names, or the remote has more than one URL.
- The configuration listing fails, for example because a configuration file is
  malformed, prints more than `delivery.gitConfigurationListingMaxBytes`, or
  does not parse.

The limit is 2 MiB by default, far above what a typical configuration prints.
The message that stops a run before the model starts names the limit when the
listing exceeds it. The check before the model starts and the publisher read the
listing under the same limit, so a listing that passes the first passes the
second.

DocsFab cannot verify a setting that has no value, such as a line that holds
only `foo` under `[core]`. Git reads such a setting as true. DocsFab refuses it
and reports `git-checkout-unverified`, not `git-configuration-refused`.

To find the cause, check each condition in the checkout:

```bash
git --version
git remote get-url --push --all origin
git config --show-origin --list
git config --includes --show-origin --null --list | wc -c
```

To resolve this issue, upgrade Git, restore the remote's URL, fix the
configuration file that `git config` reports as malformed, or give the setting a
value or remove it. If the listing is larger than the limit, remove what makes
it large, or raise `DOCSFAB_DELIVERY_GIT_CONFIGURATION_LISTING_MAX_BYTES`, up to
16 MiB. Then run the same command again. If DocsFab had already written the
change, retry publication of the saved run instead. The workflow does not run
again:

```bash
docsfab publish <run-id>
```

A retry that still cannot verify the checkout fails with
`git-checkout-unverified` again and keeps the publication retryable, even after
DocsFab committed. A publication that an earlier failure had already recovered
to patch-only cannot publish again. It reports this code with the next action
`review-preserved-patch`, so review the preserved patch instead.

After the fix, the run starts the model, or the retry opens the draft merge
request, or either fails with a different typed code.

## Live Agent Cannot Change a Page

When you ask the live agent to edit a page, you might see the following
message: `DocsFab denied the requested tool path. It is outside this session's documentation scope`.
A command can also fail with `Operation not permitted` on macOS or
`Read-only file system` on Linux. The live agent edits only documentation
paths: `docs/`, `doc/`, `documentation/`, and `fern/` directories, root
README files, and the directories listed in `documentationRoots` in
`.docsfab.json`.

To resolve this issue, do one of the following:

- Move the pages under `docs/`.
- Enter `y` when the live agent asks to allow edits in the page's
  directory, and enter `y` again to save the directory to
  `documentationRoots`. Then commit `.docsfab.json`.
- Add the directory to `documentationRoots` in `.docsfab.json`, and commit
  the change.

If the live agent reports that it is read-only, start the session without
`--read-only`. For more information, refer to
[Live Agent Reference in DocsFab](reference/status-and-configuration/live-agent.md).

## Live Agent Commands Fail Because Command Isolation Is Unavailable

When the live agent runs an approved command on Linux, you might see the
following message: `Documentation-only command isolation is unavailable. No command ran.`
Workflow runs that need a repository check can stop with
`required-check-unavailable` and the reason `linux-bubblewrap-unavailable`.
DocsFab runs commands only inside an isolated sandbox. On Linux, the sandbox
uses Bubblewrap, which needs unprivileged user namespaces.

To resolve this issue, install Bubblewrap from your distribution, such as
`sudo apt install bubblewrap`, and confirm that the following command
succeeds:

```bash
bwrap --unshare-all --dev-bind / / true
```

If Bubblewrap is installed but the command fails, the host does not allow
unprivileged user namespaces. On Ubuntu 24.04 and later, AppArmor restricts
them by default. Ask your system administrator to allow user namespaces for
Bubblewrap. Direct documentation edits keep working without command isolation.

## Model Calls Fail or the Model Key Is Rejected

When a run makes its first model call, it can stop with
`request-intent-model-unavailable`, or a provider error such as HTTP 401 can
appear. If the key is wrong, `docsfab why` can still describe the failure as a
provider capacity problem.

To resolve this issue, first confirm that the key works with your model
provider, for example with the provider's console or a request to its models
endpoint. A key can be rejected when it was copied incompletely or pasted twice.
Then run `docsfab setup` again and paste the key once at the hidden prompt. The
prompt does not display the key while you paste it.

If the provider accepts the key and calls still fail, the provider might be
unavailable or rate-limited. Wait, and then start the run again.

## Model Selection Is No Longer Supported

An older internal configuration can stop with `composition-retired` when its
model selection is no longer supported. The message names the reason and a
replacement. Follow the printed `Next action` to select that replacement, or
run `docsfab setup` in a terminal to choose another model.

DocsFab keeps the saved configuration until you explicitly choose a replacement.
For setup choices, refer to [Configure the Model](configure/model.md).

## A Composition Does Not Match the Host Configuration

If a live command fails with envelope code `deployment-binding-mismatch`,
the configured `MODEL_BASE_URL` or `baseUrl` setting cannot be parsed, or it
carries a user name, password, query, or fragment. Set it to a plain HTTPS URL,
then retry, and follow the printed `Next action` when it is more specific. An
endpoint other than the composition's recorded origin does not stop the run:
it runs with a warning. When a `docsfab run` names a composition with
`--composition <composition-id>`, that composition is the run's preset and the
host configuration's settings apply on top of it. A provider route that differs
from the preset's is replaced by the preset's route, and a model ID that
differs runs as configured; DocsFab warns about each. Refer to
[Change a Preset's Settings](configure/override-model-settings.md).

## No Model Profile or Model Key Is Configured

When you run `docsfab run`, `docsfab do`, or `docsfab doctor --live`, you
might see `DocsFab found no loadable model profile`,
`provider-credentials-missing`, or a message that names a missing key.
Commands that do not call a model, such as `docsfab list` and
`docsfab test`, work without a key.

The human `docsfab run` missing-profile error names the selected configuration
directory and its `host.yaml` and `secrets.env` paths. If you did not set
`DOCSFAB_CONFIG_ROOT`, the paths point to your default configuration directory.
The JSON error names the files without publishing host paths. DocsFab hides
credential-like text in local paths and does not print stored keys.

To resolve this issue, run `docsfab setup` in a terminal. Choose your model
provider and model, and enter the key at the hidden prompt. DocsFab stores the
key in the owner-only `secrets.env` file in its configuration directory. To
use a model profile that DocsFab installs, run
`docsfab setup --profile <profile-id>`, and use `docsfab composition list` to
see the available profile IDs. In a script, pass `--provider` and `--model`,
or `--profile`, and set the key in the environment variable that setup names.

Keep the following points in mind:

- DocsFab has no default model, so setup without a model choice stops with
  `setup-model-choice-required`.
- Each profile reads its key from one named variable. A key stored under
  another name, such as `NVIDIA_API_KEY` or `NGC_API_KEY`, is not used.
- If a profile accepts two variable names and both are set, the run stops
  because the key source is ambiguous. Keep one of them.
- Do not put keys in `.docsfab.json` or in the repository.

To check the result, run `docsfab profile inspect`. For more information,
refer to [Install DocsFab](get-started/installation.md).

## Setup Cannot Update the Secrets File

Setup replaces `secrets.env` in one step through a temporary file, so a
reader never sees a partial file. A `secrets.env.lock` file in the same
directory serializes concurrent setup runs. Rerunning setup keeps every saved
key unless you enter a new value, and it does not rewrite an unchanged file.

Setup updates the model profile under `profiles/`, `host.yaml`, and
`secrets.env` as one configuration change. It checks inputs and acquires the
secrets lock before writing. Refused input leaves the previous model selection
and its key in place. If a later write fails, setup attempts to restore the
original files. Setup replaces files one at a time, so a program that reads
the configuration during a change can briefly see the new `secrets.env` with
the old `host.yaml`.

Before setup replaces a file, it keeps the original: a hard link where the
filesystem supports one, or a copy with the same permissions and timestamps
where it does not, such as on a FAT volume. If setup cannot keep a copy, for
example because the disk is full, it stops with `setup-backup-failed`, names
the file and the configuration root, and puts back anything it already
replaced. If a later write fails, setup moves the originals back with their
permissions and symbolic links. Before it moves an original back, setup checks
that the file still holds the bytes it wrote, with the same inode and change
time. A file that another writer replaced or edited in the meantime stays as
that writer left it.

If setup cannot put an original back, or leaves a file that another writer
changed, it stops with `setup-commit-incomplete`.
The message names each such path and where setup kept its original, as
`<file>.setup-incomplete.<id>.bak`. Setup never removes those kept originals.
Copy each one back over its path, or delete it if you do not need it, then
rerun setup. `docsfab setup --migrate` follows the same rules and keeps `.env`
in place until the split layout is complete. Setup does not undo a change that
a crash or a killed process interrupts.

When setup saves a key, it replaces only that key's line and appends keys that
are new. Comments, other settings, and their formatting stay byte for byte.
Setup quotes a value when needed, so every saved value reads back exactly. A
value that does not fit on one line stops setup with
`secrets-env-value-unrepresentable`. Replacing a value that spans several
lines stops setup with `secrets-env-line-unsupported`. Both messages name the
key, never the value. In `secrets.env` and `.env`, a `#` starts a comment
only at the start of a value or after whitespace. Inside double quotes, `\\`
and `\"` are the only escapes.
If another setup holds the lock past the `secrets.lockWaitMs` bound, setup
stops with `secrets-lock-wait-ms-bound` and names the lock file. The
`DOCSFAB_SECRETS_LOCK_WAIT_MS`, `DOCSFAB_SECRETS_LOCK_STALE_MS`, and
`DOCSFAB_SECRETS_LOCK_RETRY_MS` variables can only lower those bounds.
The stale bound must stay below the wait bound so a waiter can recover an
abandoned lock. A lock whose owner still runs on this host is never taken
over, even when those variables are lowered. You can set these variables in
the environment, in the configuration root (`secrets.env`, or `.env` for the
legacy layout), or in the host limits file; `docsfab doctor --limits` reports
the same effective values the lock uses. In a configuration root file,
DocsFab reads only limit-override keys, with the same rules it uses to load
that file, so `export` lines, spaces around `=`, quoted values, and other
settings are accepted and ignored. Setup and `live-agent` check the lock
overrides before changing any file. An invalid value, or a stale bound at or
above the wait bound, stops with `secrets-lock-override-invalid`. The message
names each lock override and the file and line that set it, never its value.
`docsfab live-agent` prints the configuration root and secrets file in use.
`docsfab doctor` reports readiness without printing those paths.

Setup waits for a lock that a running process on the same host holds, however
long that process holds it. Setup checks that it still holds the lock before
it replaces each file. If another writer takes the lock first, setup stops with
`secrets-env-lock-lost` and moves back the files it already replaced. Setup
stops with `secrets-env-lock-invalid` when `secrets.env.lock` is not a regular
file, such as a broken symbolic link. Remove that path and rerun setup. On its
next write, setup removes the temporary copies and the kept originals that an
interrupted setup process left behind, except the `.setup-incomplete.` copies
described above. If `secrets.env`
is a symbolic link, setup replaces the link with a regular file and does not
write to the link target.

## The Configuration Directory Is Rejected

When you run `docsfab init`, you might see the following message:
`configuration-root-not-canonical`. DocsFab requires its configuration
directory to be one absolute, normalized path that is not reached through a
symbolic link, and that only you can write to. On macOS, `/tmp` is a symbolic
link to `/private/tmp`, so a directory under `/tmp` is refused.

To resolve this issue, run the command that the `Next action:` line prints.
It creates the directory with owner-only permissions and sets
`DOCSFAB_CONFIG_ROOT` to its resolved path. Then preview `docsfab init`
again.

## The Plan Writes Outside the Documentation Roots

When a create, update, or restructure run plans its changes, it can stop with
`plan-outside-write-roots` or `plan-target-not-writable` before anything is
written. The message names each path. A run writes only Markdown and MDX pages
inside the documentation write roots: the `documentationRoots` in
`.docsfab.json`, or `docs/` and `fern/` when none are set.

To resolve this issue, do one of the following:

- Name a target page inside the documentation roots.
- Add the directory to `documentationRoots` in `.docsfab.json`, commit the
  change, and start a new run.
- Change files that are not documentation pages, such as source code,
  OpenAPI specifications, or `AGENTS.md`, yourself.

If a create or update request names an output path that goes up a directory,
such as `../outside.md` or `docs/../src/x.md`, the run stops with
`proposal-scope-unsafe-target` before it writes anything. Name the page with a
repository-relative path inside a documentation root, such as `docs/guide.md`,
and start a new run. If you have not chosen a page, ask DocsFab to create one
without naming a path, and answer its question about where to put it.

## The Review Report Page Does Not Load

When `review-documentation` prints a `Report:` URL, such as
`http://127.0.0.1:8787/reports/<run-id>/`, the page might not load in your
browser. The report is served only while `docsfab reports serve` runs.

To resolve this issue, start the report server with the same state directory
as the run, and keep it running while you read the report:

```bash
docsfab reports serve --state-dir <state-dir>
```

The server listens on `127.0.0.1:8787` by default. Use `--bind 0.0.0.0`
only when you intend to share the port.

## WSL2 Storage or Command Isolation Fails

When you run DocsFab on Windows 11 with WSL2, an operation on DocsFab's
private files might report an ownership or permission failure. An approved
live agent command might report `live-command-wsl-interop-unavailable`, or
report that documentation-only command isolation is unavailable. These
failures usually mean that Node.js or another tool is a Windows executable,
that DocsFab files are on a Windows drive, or that Bubblewrap cannot create
user namespaces.

To find the cause, run the following commands in the Ubuntu terminal:

```bash
node -p process.platform
command -v node npm git bwrap
pwd -P
```

To resolve this issue, use the Linux versions of Git, Node.js, npm, and
`glab`. Windows `.exe` tools are unavailable inside an approved DocsFab
command. Keep the repository, `~/.config/docsfab/`, and DocsFab state in the
Linux file system, and keep their owner-only permissions when you move them.
Install Bubblewrap, and use a WSL2 host where unprivileged user namespaces
work. If `live-command-wsl-interop-unavailable` persists after you restart
your WSL session, remove any custom mounts or socket links for the Windows
bridge that you created outside DocsFab, and try again. Direct documentation
edits keep working without command isolation.

To confirm the fix, run `docsfab test --json`. For more information, refer to
[Windows Installation Instructions](get-started/installation.md#windows-11-with-wsl2).

## Error Messages

Each failure prints a `Docs:` line and its own `Next action:` line. The
following table lists the codes that link to this page from the DocsFab `Docs:`
line.

| Error Code | Description | Solution or Workaround |
| --- | --- | --- |
| `aggregate-timeout` | Copying the repository into the run's workspace made no progress for the whole no-progress window. | Check that Git and the disk respond, and start the run again. If the host is healthy but slow, raise `DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS`. |
| `ambiguous-remote` | The checkout has more than one Git remote and none is named `origin`. | Pass `--remote <name>` to `docsfab do`, `docsfab run`, or `docsfab publish`. |
| `artifacts-max-object-bytes-bound` | A run output is larger than the artifact size limit. | Raise `DOCSFAB_ARTIFACTS_MAX_OBJECT_BYTES` above the size in the message, and rerun the command. |
| `content-index-refused` | A page that the run indexes has a problem that the message names, such as two pages with the same frontmatter `id`. | Fix the named file, commit the change, and start a new run. |
| `content-index-unreadable` | DocsFab could not read a file or directory while indexing pages. | Check that the disk responds and that the named path is readable, then start a new run. |
| `context-compile-failed` | DocsFab could not prepare the context for a write step. This is a DocsFab defect. | Report the problem with the output of `docsfab why <run-id> --json`. For more information, refer to [An Unexpected Failure Does Not Explain the Cause](#an-unexpected-failure-does-not-explain-the-cause). |
| `deployment-binding-mismatch` | The configured model endpoint cannot be parsed, or carries a user name, password, query, or fragment. | Follow the printed next action. Refer to [A Composition Does Not Match the Host Configuration](#a-composition-does-not-match-the-host-configuration). |
| `duplicate-page-anchor` | Two anchors on a page that the run targets use the same name. | Rename the anchor on the named line, commit the change, and rerun the command. |
| `empty-page-anchor` | A heading or anchor on a page that the run targets has no letters or digits. A `---` line directly under text is read as a heading. | Edit the named line, or put a blank line before a `---` line that is meant as a divider. Commit the change, and rerun the command. |
| `first-pass-support-invalid` | The run's first-pass check of source support did not pass its own rules. | Follow the printed next action. If the failure repeats, report the problem. |
| `git-checkout-unverified` | DocsFab could not verify the checkout's Git setup, so it stopped before the model run or before it published. Git is older than 2.9.5, the remote no longer names the project that the plan names, or `git config --list` fails (for example, a configuration file is malformed), prints more than `delivery.gitConfigurationListingMaxBytes`, does not parse, or lists a setting with no value. If DocsFab had already written the change, the write is saved. | Upgrade Git, restore the remote's URL, fix the malformed configuration file, or give the setting a value or remove it. If the listing is larger than the limit, remove what makes it large, or raise `DOCSFAB_DELIVERY_GIT_CONFIGURATION_LISTING_MAX_BYTES`, up to 16 MiB. Then run the same command again, or run `docsfab publish <run-id>` if DocsFab had already written the change. For more information, refer to [DocsFab Cannot Verify the Git Setup of a Checkout](#docsfab-cannot-verify-the-git-setup-of-a-checkout). |
| `git-configuration-refused` | The checkout's Git configuration, or your global or system configuration, has a setting that can run a command, change how DocsFab pushes, or turn signing on. The message names the setting and its file. DocsFab checks before it starts the model, so a refusal at that point costs no model call. DocsFab accepts `commit.gpgSign` and `tag.gpgSign` set to a false value in any file, and `core.sshCommand` and `core.askPass` in your global or system files when `HOME` is an absolute path outside the checkout. If DocsFab had already written the change, the write is saved. | Remove the setting from the file that the message names, or move `core.sshCommand`, `core.askPass`, a signing key, a URL rewrite, an include, or a credential helper to your global Git configuration. Then run the same command again, or run `docsfab publish <run-id>` if DocsFab had already written the change. For the full list of accepted and refused settings, refer to [A Draft Merge Request Is Stopped by a Git Setting](#a-draft-merge-request-is-stopped-by-a-git-setting). |
| `git-identity-drift` | Your Git `user.name` or `user.email` changed after DocsFab planned the merge request. The write is saved. | Set `user.name` and `user.email` back to the values that the run planned with, and run `docsfab publish <run-id>`. To publish as the new identity, start a new run. |
| `glab-auth-login` | `glab` is not logged in to the GitLab host for the selected remote. | Run `glab auth login --hostname <host>`. For more information, refer to [GitLab Authentication or Connection Fails During Delivery](#gitlab-authentication-or-connection-fails-during-delivery). |
| `host-limits-file-unreadable` | The limits file that `DOCSFAB_SERVICE_ENV_FILE` names cannot be read. | Set `DOCSFAB_SERVICE_ENV_FILE` to a file that you can read, such as an empty file that you own, and rerun the command. |
| `navigation-alias-refused` | The run selected a symbolic link to a page. DocsFab does not follow symbolic links. | Select the page that the link points to, or replace the link with the page and commit the change. Then start a new run. |
| `no-supported-gitlab-remote` | DocsFab found no GitLab remote that it can use for a step that needs GitLab, such as opening a merge request or adding `.docsfab.json`. DocsFab does not use a remote whose URL contains credentials or does not identify a GitLab project. | Run the command from a checkout that is connected to the intended GitLab project. To create a local patch without a remote, use `--patch-only`. |
| `not-a-git-repository` | The `--repo` path is not a Git checkout. | Pass `--repo` with the path to a local Git checkout. |
| `not-repository-root` | The `--repo` path is a subdirectory of a Git checkout. | Pass `--repo` with the root directory of the checkout. |
| `per-blob-timeout` | Copying one file into the run's workspace made no progress, so Git or the disk stopped responding. | Check that Git and the disk respond, and start the run again. If the host is healthy but slow, raise `DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS`. |
| `plan-target-not-named` | The plan would change an agent instruction file, such as `AGENTS.md`, or a hidden file that the request did not name. | Name each file by its exact path in the request, and start a new run. |
| `preflight-budget-exceeded` | The context for a step is larger than its share of the model's input window. | Raise the `DOCSFAB_CONTEXT_*_INPUT_SHARE_BASIS_POINTS` setting that the message names, up to 10000, or use a model profile whose input window DocsFab knows. Then start a new run. |
| `repository-access-denied` | Git could not read the selected repository with the current process permissions. | Run DocsFab as the checkout owner, or prepare a dedicated CI or container checkout for the DocsFab user. If ownership already matches, grant that user read access to repository files and Git metadata. Refer to [Repository Access](#repository-access). |
| `repository-mismatch` | Publication used a different `--repo` path from the one the run recorded. | Run the publication command again with the `--repo` path that `docsfab runs show <run-id>` reports. |
| `repository-ownership-mismatch` | Git refused to read the selected repository because its ownership does not match the current process. | Run DocsFab as the checkout owner, or prepare a dedicated CI or container checkout for the DocsFab user. Refer to [Repository Access](#repository-access). |
| `required-source-unread` | The write step could not read all of the sources that the run requires within its read budget. | Raise `DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES` to at least the size in the message, or bind fewer or smaller sources. Then start a new run. |
| `saved-run-not-found` | The selected saved run record is absent, including after deletion. | Run `docsfab runs list` with the same state-directory selection and choose an existing run. Refer to [The Saved Run Record Was Not Found](#the-saved-run-record-was-not-found). |
| `source-authority-path-refused` | A tracked file path breaks a path rule that the message names, such as a colon in the file name. | Rename the file, or stop tracking it, commit the change, and rerun the command. |
| `tracked-source-dirty` | The checkout has uncommitted changes to tracked files, so DocsFab cannot publish from it. | Commit, stash, or discard the tracked and staged changes, and retry. Untracked files are allowed. |
| `unsafe-git-configuration` | The checkout's local Git configuration enables hooks, `fsmonitor`, includes, or content filters, which DocsFab does not run. The same hook and `fsmonitor` settings in your global or system Git configuration fail with `git-configuration-refused` instead. | Retry from a checkout whose local Git configuration does not enable these features. |

## Related Topics

The following pages provide related information:

- [Install DocsFab](get-started/installation.md)
- [Runner Quickstart](get-started/runner-quickstart.md)
- [Run a Documentation Workflow](workflows/run-a-documentation-workflow.md)
- [Runtime CLI and Configuration in DocsFab](reference/status-and-configuration/runtime-cli-and-configuration.md)
- [DocsFab Operator Error Envelope](reference/status-and-configuration/operator-error-envelope.md)
- [Stop Classes in DocsFab](reference/status-and-configuration/stop-classes.md)
