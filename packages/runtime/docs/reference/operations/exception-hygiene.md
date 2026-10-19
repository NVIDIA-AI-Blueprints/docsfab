# Exception hygiene ratchet

DocsFab mirrors the intent of Chirp's exception-hygiene gate for TypeScript:
new public throws must carry a human-quality static message, while existing debt
stays baselined so CI can reject new problems without a full rewrite.

## What the gate checks

`node scripts/lint-exception-hygiene.mjs` scans `src/**/*.ts` for public-scope
`throw new …("…")` (and `throw Error("…")`) whose statically visible message:

- has fewer than eight words, or
- lacks final `.` / `?` punctuation

CLI-reachable files (`src/cli.ts` and `src/cli/**`, excluding tests) have a
second rule: a public `throw new Error("…")` without an envelope helper,
`*ContractError` / `*OperatorError` constructor, or `// hygiene: envelope` /
`// hygiene: ok` justification fails even when the message already meets the
word and punctuation bar. Map the throw through the operator envelope or a
frozen stem rather than expanding the baseline for a new CLI path.

Private helpers whose innermost function name starts with `_` (but is not a
dunder) are ignored. Throws that already use operator envelope helpers
(`toOperatorErrorEnvelope`, `mapDoctorFailure`, `mapInitFailure`,
`wrapKnowledgeAdapterFailure`, and related formatters), `*ContractError`
constructors, or an explicit `// hygiene: envelope` / `// hygiene: ok`
justification are allowed.

Fingerprints are `rule|path|scope|evidence` and intentionally omit line numbers,
so moving a throw within a file does not create baseline churn.

## CI wiring

`npm run check` runs `npm run lint:exception-hygiene` before typecheck and tests.
New findings or stale baseline entries fail the check.

## Refresh the baseline deliberately

Only refresh after reviewing each added or removed finding:

```bash
node scripts/lint-exception-hygiene.mjs --write-baseline
```

Commit the updated `scripts/exception-hygiene-baseline.json` in the same change
that introduces the deliberate debt change or cleanup. Prefer fixing the message
(or routing the failure through the operator error envelope) over expanding the
baseline. Do not grow the baseline to admit a new CLI-reachable `throw new
Error("…")`.
