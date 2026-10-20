---
title: "Configured-Credential Matching Limits in DocsFab"
description: "Look up exact configured-credential matching budgets and refusal behavior."
status: draft
content.type: reference
---

Look up exact configured-credential matching budgets and refusal behavior.

## Configured-Credential Matching

DocsFab matches its own configured credentials exactly, as
[Security and Trust](../security-and-trust.md) describes. You can set each
setting through its environment variable or by name in the host limits file,
within its catalog range. Startup refuses a value outside that range, and
`docsfab doctor --limits` reports the effective values. The following settings
control which configured values, and which pieces of them, the exact-match
screens compare.

<Markdown src="operational-limits-tables/configured-credential-settings.md" />

Lowering a minimum compares more configured values, such as a short password or
one built from a repeated word. Such a value also appears in ordinary text by
chance more often, so more runs refuse content that holds no credential.
Raising a minimum compares fewer configured values.

`docsfab doctor` prints a `Configured credential not compared` line when a
configured value is shorter than `secrets.configuredCredentialMinChars` or has
fewer distinct characters than `secrets.configuredCredentialMinDistinctChars`.
The line names where the value is configured, such as an environment variable
or a credential file, the rule that the value fails, and the setting that
compares such values. It never shows the value or its length.

DocsFab reads the files that variables such as `*_TOKEN_FILE` name, and lists
systemd's `$CREDENTIALS_DIRECTORY`, when it loads its configuration and each
time it reloads it. A value that DocsFab read from such a file earlier, such as
a token that you rotated out, still matches until the process exits. A hosted
attempt runs without the host's environment and limits file, so these settings
keep their catalog defaults inside it.
