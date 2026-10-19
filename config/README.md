# DocsFab Configuration Sources

This directory contains the source catalogs and generated mirrors for rules DocsFab enforces. To configure your local model or output location, start with [Configure DocsFab](../docs/configure/index.md).

## Find a Configuration Source

| To… | Start here |
| --- | --- |
| Understand model output rules and response contracts | [Runtime model output rule reference](../packages/runtime/docs/reference/contracts/model-output-rules.md) |
| Edit the model output catalog | [Model output catalog guide](model-output/README.md) and its [format reference](model-output/REFERENCE.md) |
| Find an operational limit | [`limits/`](limits/) and the [`limits.yaml` registry](limits.yaml) |
| Review effective local limits | [Manage DocsFab](../docs/manage/index.md) |

## Source and Generated Files

Edit the catalog or owner fragment, then regenerate its mirrors from `packages/runtime`. Do not edit generated mirrors directly.

For model output rules, run these commands from `packages/runtime`:

```bash
npm run generate:model-output
npm run check:model-output
```

For operational limits, edit the owning fragment under `config/limits/` and the registry in `config/limits.yaml`, then run these commands from `packages/runtime`:

```bash
npm run generate:limits
npm run check:limits
```

The generated `limits.json` and `limits.catalog.json` files are consumer mirrors.
For the fragment rules, mirror distinctions, environment variables, recovery
and deployment fields, and checks in the public tree, refer to the
[operational limits reference](limits-reference.md).
