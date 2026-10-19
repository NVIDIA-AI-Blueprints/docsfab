---
title: "Manage Local DocsFab Configuration and Credentials"
description: "Locate the host configuration used by DocsFab and check its private storage boundaries. To change a model selection, follow Configure the Model."
status: draft
content.type: how-to
---

Locate the host configuration used by DocsFab and check its private storage boundaries. To change a model selection, follow [Configure the Model](../configure/model.md).

## Inspect Configuration Locations

Run the read-only path inspection:

```bash
docsfab config inspect
```

It reports the effective paths, their sources, and whether they exist and are
readable or writable. It does not read secret files, contact a model or SCM
service, or create missing directories. For machine-readable output, add
`--json`. Refer to [Human Output and JSON](../reference/status-and-configuration/human-output-and-json.md).

## Update a Model Key

Run `docsfab setup` and enter the new key at the hidden prompt for the selected
provider. To retain an installed composition, run
`docsfab setup --profile COMPOSITION_ID` with its ID instead. Follow
[Configure the Model](../configure/model.md) or
[Select an Installed Composition](../configure/installed-compositions.md).

Setup preserves saved keys unless you provide a replacement. It updates the
model profile, `host.yaml`, and `secrets.env` one file at a time and attempts
to restore the previous configuration if a write fails. A crash or killed
process can leave these files inconsistent. For recovery or a lock error, refer to
[Setup Cannot Update the Secrets File](../troubleshooting.md#setup-cannot-update-the-secrets-file).

## Configuration Storage and Permissions

Enter the API key at the hidden setup prompt. Setup rejects blank input and stores the key in the owner-private `secrets.env` file with mode `0600`. Keep keys out of `.docsfab.json` and the repository.

## Configuration Roots

Set `DOCSFAB_CONFIG_ROOT` to one normalized absolute directory outside the
project checkout for writable host configuration, profiles, and default
state. Do not point it at the global npm package or copy packaged skills
into it. Immutable skills stay package-bound.

When `DOCSFAB_CONFIG_ROOT` is not set, the default root is
`~/.config/docsfab`, or `docsfab` under `XDG_CONFIG_HOME` when that variable
names a normalized absolute path. `docsfab setup` and `docsfab profile seed`
create a missing default root with mode `0700`, and they require an existing
one to have that mode. If the root has another mode, such as `0755`, or its
mode cannot be read, the command stops before it writes anything. The message
names the root as `~/.config/docsfab` or `$XDG_CONFIG_HOME/docsfab`, and the
`Next action` gives the `chmod 700` command that fixes it.

An explicit `DOCSFAB_CONFIG_ROOT` must also have mode `0700` before DocsFab
reads or stores configuration. Setup, doctor, run, and init stop before
reading an existing root with another mode. The refusal reports
`configuration-root-not-private`, the observed mode, and a `chmod 700`
command for the selected root. DocsFab does not change an existing directory's
mode for you. Read-only commands do not create a missing root.

Draft-MR delivery uses the effective state directory from `--state-dir`,
`DOCSFAB_STATE_DIR`, or `paths.stateDir` in `host.yaml`. When delivery and
receipt roots are omitted, they are private `delivery` and `receipts`
siblings of that state directory. Offline doctor remains read-only and does
not create these roots; a one-shot draft-MR preflight checks their ownership,
permissions, and writability before model execution. If that check fails,
retry with the exact roots reported by the recovery command, or configure
`DOCSFAB_DELIVERY_ROOT` and `DOCSFAB_RECEIPT_ROOT` as normalized absolute
directories outside the repository.

Doctor and `docsfab config inspect` reject a configuration root reached through a symlink or another noncanonical path. Use the canonical path printed by the next action.

## Related Topics

Use these topics for the supporting contracts and next actions.

- [The Configuration Directory Is Rejected](../troubleshooting.md#the-configuration-directory-is-rejected)
- [Recover a Local CLI Installation](recover-local-state.md#recover-a-local-cli-installation)
- [Update or Uninstall DocsFab](update-or-uninstall.md)
