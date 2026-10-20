# Canonical catalog scorecard harness

<!-- Diataxis: how-to. Additive operator recipe for #285. -->

## Goal

Re-run the canonical workflow catalog against a pinned repository revision
and write a machine-readable scorecard without chat orchestration. This is
a sequential dogfood helper, not a product job queue (see #279).

## Default: offline / fixture-first

Evidence lands **outside** the DocsFab source checkout. The default command
does not call a live model and is **not** part of CI or `npm run check`.

```bash
node scripts/catalog-scorecard.mjs
node scripts/catalog-scorecard.mjs --evidence-dir /absolute/private/dir
```

The scorecard always includes rows for:

- the 10 catalog workflows (`docsfab list` / `docsfab plan <name>`)
- `docsfab auto --dry-run --json`
- `docsfab multi-unit-campaign --dry-run --json`
- `docsfab do --route-only --json`

Polish is **regression-only** in the matrix (not the primary dogfood).

Artifacts (owner-only files, no credentials or host paths):

```text
scorecard.json
scorecard.md
```

`package.json` is not edited for this helper. Invoke `node scripts/…`
directly. Optional Vitest smoke:

```bash
npx vitest run test/catalog-scorecard-harness.test.ts
```

## Offline execute (still no live model)

Sequential CLI against a pinned repo. Sets `PI_OFFLINE=1`. Not required
for merge or CI.

```bash
PI_OFFLINE=1 node scripts/catalog-scorecard.mjs --execute \
  --repo /absolute/target/checkout \
  --revision <full-commit> \
  --evidence-dir /absolute/private/dir
```

Catalog rows use `docsfab plan` (no inference). Operator-mode rows invoke
`auto --dry-run`, `multi-unit-campaign --dry-run`, and `do --route-only`.
A missing private campaign directory fail-closes and is recorded as a
disposition; supply a real campaign dir only when you already have one
from the [multi-unit procedure](multi-unit-doc-improvement.md).

## Live model (opt-in, not CI)

Live catalog runs require an explicit environment gate. They are **not**
part of `npm run check`.

```bash
DOCSFAB_CATALOG_SCORECARD_LIVE=1 node scripts/catalog-scorecard.mjs --live \
  --repo /absolute/target/checkout \
  --revision <full-commit> \
  --evidence-dir /absolute/private/dir
```

Read-only `docsfab run` rows execute sequentially. Polish stays skipped
(regression-only). Write workflows (`bootstrap`, `site-bootstrap`) stay
skipped unless you use the existing write-gated `docsfab run` commands
outside this helper. Keep transcripts and credentials out of the repo.

## Related topics

- [Foundation-to-patch offline dogfood](foundation-to-patch-dogfood.md)
- [Multi-unit dry-run](multi-unit-doc-improvement.md)
- [MVP scorecard](mvp-scorecard.md)
