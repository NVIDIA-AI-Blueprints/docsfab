---
title: "Update a Documentation Set in DocsFab"
description: "Request coordinated changes across existing pages and inspect the page-set and navigation evidence."
status: draft
content.type: how-to
---

Request coordinated changes across existing pages and inspect the page-set and navigation evidence.

## Update a Multi-Page Set

Describe the approved change once and identify the related pages it affects:

```text
Update the authentication change across the overview, setup procedure, and
troubleshooting page. Keep existing routes and align each example with the
approved API.
```

The plan freezes three `update` dispositions and binds each page to the
approved change evidence. The writer may read source material outside the
set, but it cannot mutate an unplanned page. The result should contain the
three coordinated page updates while unrelated documentation stays untouched.
If the change needs another page, the workflow returns a typed scope or input
result before writing a patch.

## Steps

Complete the following steps for the selected task.

1. Commit the source evidence and identify the existing pages affected by the approved change.
2. Run `docsfab run update-documentation --repo /absolute/path/to/repository --instruction "Update the authentication change across docs/overview.md, docs/setup.md, and docs/troubleshooting.md. Preserve existing routes." --patch-only`. Replace the example paths and change with your actual scope.
3. Inspect `docsfab runs show <run-id>`, the retained patch, and the page-set quality findings. Check each planned page and any reported navigation limitation.

For the observed site configuration and adapter limits, refer to [Documentation Generator Capabilities](../reference/status-and-configuration/generator-capabilities.md#navigation-evidence).
