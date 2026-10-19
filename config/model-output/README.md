# Model Output Rule Catalog

This catalog defines the rules DocsFab uses to validate model replies, tool-call arguments, and staged artifacts. The runtime and knowledge packages generate their rule tables from these sources.

For rule codes and operator guidance, start with the [runtime model output rule reference](../../packages/runtime/docs/reference/contracts/model-output-rules.md). For catalog fields, contracts, generated outputs, and validation details, use the [catalog format reference](REFERENCE.md).

## Catalog Files

| File | Purpose |
| --- | --- |
| `rules/<family>.yaml` | Rule definitions raised by a validator family |
| `contracts/<id>.yaml` | Reply shape, declared rules, and host-provided content for a workflow step |
| `grammars.yaml` | Shared value grammars used by rules and contracts |
| `retry-policy.yaml` | Retry and replay modes and their model-facing guidance |
| `recorded-codes.yaml` | Append-only record of codes persisted in run records |
| `../model-output-allowlist.json` | Reviewed exceptions to catalog checks |

Edit canonical catalog sources. Do not edit generated runtime or knowledge files directly.

## Generate and Check

Run these commands from `packages/runtime`:

```bash
npm run generate:model-output
npm run check:model-output
```

The generator updates the runtime and knowledge tables and the public runtime rule reference. The check detects generated drift and validates rule, contract, and fixture coverage.
