---
title: Update or Uninstall DocsFab
description: Update or reinstall your DocsFab source checkout, repair a packaged installation, or remove the global command.
status: draft
content.type: how-to
---

For internal testing, update the source checkout linked to your global DocsFab
command. Development builds follow `main` and can be unstable.

## Before Changing Versions

Stop DocsFab processes and back up the configuration and run state. Follow
[Recover a Local CLI Installation](recover-local-state.md#recover-a-local-cli-installation)
for backup and restore checks.

## Reinstall or Change the Version

To update an existing checkout on `main`, run these commands from its root:

```bash
git pull --ff-only origin main
npm --prefix packages/runtime ci
npm install --global ./packages/runtime
docsfab --version
```

The pull command fetches `main` from `origin` and fast-forwards your local
branch; it stops if the histories diverge. `npm ci` installs the updated
runtime dependencies from the lockfile. The global install links the CLI to
that checkout.

To reinstall without pulling new changes, repeat the npm commands in
[Install DocsFab](../get-started/installation.md#install-docsfab).
Run `docsfab setup` again when you want to change the model configuration.

After installation, `docsfab --version` confirms the installed version and
checks that the CLI starts on the current Node.js version. Use
[Check DocsFab Readiness](check-readiness.md) to inspect the configuration and
connection for your intended operation.

## Repair an Installed Package

If doctor reports damaged packaged assets, stop DocsFab processes and follow
its printed reinstall command. Replace `<tarball URL>` with the exact release
artifact URL from your installation record or authenticated package metadata.
Do not substitute an unpinned registry package.

The repair command uses `npm i -g` to reinstall the global CLI from that
artifact. `--ignore-scripts` disables package lifecycle scripts because the
release already contains compiled assets. `--engine-strict` makes npm reject
an unsupported Node.js version before reinstalling. Then rerun the command
that reported the integrity error.

For source checkouts, follow doctor's pack-regeneration command instead.
Refer to [Runtime Readiness and Doctor Checks](check-readiness.md)
for the integrity diagnostics.

## Uninstall

To remove the global command, run:

```bash
npm uninstall --global docsfab
```

Uninstalling leaves your DocsFab configuration, run records, and patches in
place.

## Related Topics

Use these topics for the supporting contracts and next actions.

- [Install DocsFab](../get-started/installation.md)
- [Manage Local Configuration and Credentials](local-configuration.md)
- [Install a Development Build](development-installation.md)
