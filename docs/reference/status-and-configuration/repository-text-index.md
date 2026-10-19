---
title: "Repository Text Index Limits in DocsFab"
description: "Look up text-index inclusion rules, byte budgets, and incomplete-index reporting."
status: draft
content.type: reference
---

Look up text-index inclusion rules, byte budgets, and incomplete-index reporting.

## Repository Text Index

The repository inventory that governed workflow search builds reads tracked
text files into a text index, which literal-text probes match. It reads every
regular tracked file except images, PDF files, web fonts, ZIP archives, and
video and audio files, which it excludes by extension. It also excludes any
other file whose first 8,000 bytes hold a NUL byte, which is how Git recognizes
binary content. Two settings bound the
index, and a host can raise or lower each one through its environment variable
or by name in the host limits file. The following table lists both settings.

<Markdown src="operational-limits-tables/repository-text-index-settings.md" />

The inventory does not read a whole text file that is larger than
`repository.inventoryTextMaxFileBytes`, or one that would take the index past
`repository.inventoryTextMaxTotalBytes`. It reads only the first 8,000 bytes,
to exclude binary content, and records a text file by path as
`text-index-limit-exceeded`, with the limit and the observed value. Search
continues. The run's LIMITATIONS then carry one line for each limit that left
files out. The line names the limit's code, the observed value, the setting to
raise, and the number of files left out, as in this example:

```text
repository-inventory-text-max-total-bytes-bound: 89808719 exceeds repository.inventoryTextMaxTotalBytes = 16777216 bytes. Raise DOCSFAB_REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES, ... Follow the named remediation. 8561 tracked files were left out of the repository text index; the inventory records each by path.
```

For the total, the observed value is the number of bytes the index needed, so
raising the setting to that value admits every file it left out. For a single
file, the observed value is the size of the largest file left out.

A file that is text in an encoding other than UTF-8 is left out too. The run's
LIMITATIONS then carry a `repository-inventory-invalid-text-input` line that
counts those files and names up to three of them. A file that starts with a
UTF-16 byte order mark counts as such text, not as binary content, so the line
names it too. Convert a file to UTF-8 to make it searchable.

The defaults index all of the text in a repository of about 10,000 tracked
files: vLLM Semantic Router holds about 90 MB of text in 10,308 files. They
leave twice the room a 30,000-file repository of the same density needs. The
index keeps its text in host memory while search runs. Text from small files
costs about 1.1 bytes of JavaScript heap for each byte, and Node.js holds the
text of a file over about 1 MiB outside the heap. A byte of text costs at most
2 bytes of memory, so a raised total costs host memory in proportion. A hosted
attempt runs in a sandbox that does not read the host limits file, so inside
it both settings keep their catalog defaults.

When the inventory cannot build its content index, governed search continues
without it, and the probes that need the index report `local-index-incomplete`.
The run's LIMITATIONS then carry a `content-index-incomplete` line that names
the page and the reason, for example a page that holds a NUL byte:

```text
content-index-incomplete: Content index document source "docs/install/operator.md" is not strict UTF-8 text: it holds a NUL byte at byte offset 6079. Governed search continues without the content index, ...
```

Fix the page that the line names, then rerun the same command.
