---
title: Install a DocsFab Development Build
description: Install and update DocsFab from an exported source checkout.
status: draft
content.type: how-to
---

<span id="install-from-a-source-checkout"></span>
<span id="update-a-development-checkout"></span>

Install the exported source checkout as described in
[Install DocsFab](../get-started/installation.md). Development builds can be unstable.

## Prerequisites

Prepare the [installation prerequisites](../get-started/installation.md#prerequisites).
Keep the checkout in place after installation because npm can link the global
CLI to that directory.

## Install the Development Package

From the repository root, run these commands:

```bash
npm --prefix packages/runtime ci
npm install --global ./packages/runtime
docsfab --version
```

`npm ci` installs the locked runtime dependencies. The global installation
makes `docsfab` available on your shell path.

## Update the Checkout

Fetch the next curated export, then repeat the installation commands. Refer to
[Update or Uninstall](update-or-uninstall.md) before changing versions.

## Related Topics

- [Check DocsFab Readiness](check-readiness.md)
- [Installation Fails](../troubleshooting.md#installation-fails)
