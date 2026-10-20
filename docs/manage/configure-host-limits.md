---
title: "Configure Host Limits in DocsFab"
description: "Set supported operational overrides in the host limits file and inspect their effective values."
status: draft
content.type: how-to
---

Set supported operational overrides in the host limits file and inspect their effective values.

## Host Limits File

A host can set limit overrides in a host limits file. DocsFab reads the file
that `DOCSFAB_SERVICE_ENV_FILE` names. When that variable is unset, DocsFab
reads the installed service file, `/etc/docsfab/service.env`. A missing file
sets nothing. DocsFab ignores blank lines and lines that start with `#`, and
every other line must be a `KEY=value` assignment. A key can name a limit, such
as `artifacts.maxObjectBytes`, or its override variable, such as
`DOCSFAB_ARTIFACTS_MAX_OBJECT_BYTES`. DocsFab ignores keys that name no limit.
An override variable set in the environment takes precedence over the file.

The installed service file belongs to the DocsFab service, and other users
cannot read it. When you run DocsFab as such a user, DocsFab skips the file,
and the limit overrides it sets do not apply to your commands. Each DocsFab
process that reads limits, including every CLI command and the
configured-credential screens, prints this line to standard error once:

```text
WARNING host-limits-file-unreadable: DocsFab cannot read the host limits file /etc/docsfab/service.env (EACCES), so it skips that file and the limit overrides it sets do not apply. Set DOCSFAB_SERVICE_ENV_FILE to a limits file you can read; the service's own limit overrides then do not apply to your runs.
```

On a host where the DocsFab service is installed, every user who cannot read
the service's file sees this warning on every command. `docsfab doctor`
reports the same condition in a `Host limits file: skipped` line, and
`docsfab doctor --limits` prints that line above the limits table. With
`--json`, both commands add a `hostLimitsFile` object with the `code`, `path`,
`reason`, and `remediation`. The object is absent when DocsFab reads the file
or the file does not exist.

To stop the warning, set `DOCSFAB_SERVICE_ENV_FILE` to a limits file that you
can read, such as an empty file that you own. The service's own limit
overrides then do not apply to your runs, so set any override that you need in
that file or in the environment. Do not widen access to the service's files to
clear the warning.

DocsFab never skips a file that `DOCSFAB_SERVICE_ENV_FILE` names. When it
cannot read that file, DocsFab stops before it runs the command, with code
`host-limits-file-unreadable` and a message that names the file and the read
error. The installed file stops DocsFab the same way when it fails for another
reason, such as a directory at that path. Refer to
[Error Messages](../troubleshooting.md#error-messages).

## Related

Use these topics for the supporting contracts and next actions.

- [Inspect Operational Limits](inspect-operational-limits.md)
- [Operational Limit Definitions](../reference/status-and-configuration/operational-limits.md)
