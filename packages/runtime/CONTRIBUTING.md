# Validate the Runtime Export

This project is currently not accepting contributions. Pull requests are not
merged. Refer to [the contribution policy](../../CONTRIBUTING.md) to report a
bug or request a feature.

This reference describes how to inspect and validate the exported runtime.
Refer to [the runtime README](README.md) for CLI and package behavior.

## Build and Test

From `packages/runtime`, install the pinned dependencies and run the checks:

```sh
npm ci
npm run check:static
npm run check:pins
npm test
```

Required isolation checks need Linux, Bubblewrap, and working unprivileged
user namespaces. Refer to [the support matrix](../../docs/reference/support-matrix.md).

<span id="factory-machine-and-campaign-loop"></span>

## Export Verification

The export is checked as a separate repository before distribution. Its checks
cover source boundaries, secret fixtures, generated files, runtime tests,
package tests, and offline CLI installation. The export preserves evaluation
fixtures and their recorded hashes.

Report a failed check as an issue with the command, platform, and diagnostic.
Do not include model keys or other credentials.

## Select a Model

Run `docsfab setup --profile <composition-id>` or configure an explicit model endpoint.
Running setup without a selection refuses with `setup-model-choice-required`; choose a model and retry.
