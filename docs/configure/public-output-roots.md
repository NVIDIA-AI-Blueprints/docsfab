---
title: "Configure Public Output Roots in DocsFab"
description: "Declare which host directories can appear in published documentation output."
status: draft
content.type: how-to
---

Declare which host directories can appear in published documentation output.

## Prerequisites

Use the owner-managed host configuration. The command uses explicitly configured paths; follow the constraints below.

## Host Paths in Published Output

DocsFab does not reveal the layout of the machine it runs on. The model works
in a repository-relative workspace and never receives a host absolute path.
DocsFab does not refuse model content because it contains, or looks like, a
path. Instead, before DocsFab sends text to a merge-request note, a draft or
updated merge request, an issue, a Slack post, or a hosted report, one egress
function replaces this host's own directories, called roots, with a
placeholder. The same function refuses text that contains one of DocsFab's own
configured credentials. Text that only looks like a credential is published.
Refer to [Credential-Like Content](../reference/security-and-trust.md#credential-like-content).
One exception remains: the runtime's own Slack webhook notification refuses a
status block that names a common host root instead of replacing it.

The following table lists the replacement for each kind of root.

| Root | Published as |
| --- | --- |
| The run's repository checkout | A repository-relative path, or `.` for the checkout itself |
| Your home directory (`HOME`, and on Windows also `USERPROFILE`) | `~` |
| The temporary directory (`TMPDIR`, and on Windows also `TEMP` and `TMP`) | `$TMPDIR` |
| The DocsFab state directory and its delivery and receipt roots | `$DOCSFAB_STATE_DIR` |
| The DocsFab configuration root | `$DOCSFAB_CONFIG_ROOT` |
| Any other root DocsFab knows, such as its installation directory | `$HOST_PATH` |

The placeholders are plain text so that GitLab Markdown and Slack show them as
written. DocsFab also replaces the `file://` form of each root and the
`~user` form of your home directory. When roots nest, the longest match wins,
so an undeclared state directory under a declared home directory is still
replaced. `/tmp` and `/var/tmp`, and their `/private` forms on macOS, are the
same on every host and are never roots. A bare `~` names no host and stays as
written. On Windows, when `USERPROFILE`, `TEMP`, or `TMP` names a different
directory than `HOME` or `TMPDIR`, each directory is a root.

### Egress Refusal Codes

When egress cannot publish text, it sends nothing and refuses with one of the
following codes, none of which carries the refused text.

| Code | Cause |
| --- | --- |
| `credential-material` | The text contains one of DocsFab's own configured credentials. |
| `egress-key-collision` | Two keys in a structured value, such as a hosted report, become identical after their roots are replaced. |
| `egress-unwalkable-value` | The credential screen cannot walk a structured value: a cycle, an accessor, a symbol key, a sparse array, a non-plain object such as a `Map` or `Date`, or a value over the screen's size cap. |

Some callers report these refusals under their own codes, as the following
list describes:

- A withheld review HTML report does not stop the run's output. DocsFab adds
  the `hosted-report-withheld:<code>` limitation to the review findings that
  the run reports.
- A source search refuses a configured credential as `credentials`, a key
  collision as `host-path`, and an unwalkable value as
  `egress-unwalkable-value`.
- A review result refuses a configured credential as `credential-material`,
  and an unwalkable value or a key collision as `invalid-shape`.

### Declare Public Roots

Set `DOCSFAB_PUBLIC_ROOTS` when your deployment's layout is already documented,
so that published text that cites it is not rewritten. For example, a
deployment may declare its documented layout, such as a container image whose
documentation names `/home/node` as its home directory and `/workspace` as its
checkout:

```bash
export DOCSFAB_PUBLIC_ROOTS=/home/node:/workspace
```

Declaring a root is your statement that the path is public. DocsFab publishes
a declared root as written and does not infer public roots from repository
content. The following rules apply to the value:

- Separate entries with the platform path delimiter: `:` on Linux and macOS,
  `;` on Windows.
- Write each entry as a normalized absolute path. An empty entry, a relative
  path, a path such as `/home/node/../x`, a trailing separator, surrounding
  whitespace, and the filesystem root are refused.
- A declared entry must match a root exactly. Declaring a parent directory
  does not make the roots under it public.
- An unset or empty value declares no public roots.

The `docsfab` CLI validates the value at startup, before any command runs,
and each publisher validates it again when it starts, before it sends any
text. An invalid entry stops the command with `public-roots-invalid`. The
message names the entry's position, counting from 0, and never its value. To
fix it, correct that entry, or unset `DOCSFAB_PUBLIC_ROOTS` to declare none,
and then retry.
