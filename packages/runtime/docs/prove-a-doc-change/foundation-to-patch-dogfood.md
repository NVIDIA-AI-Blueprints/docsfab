# Foundation-to-patch offline dogfood

<!-- Diataxis: how-to. Additive operator note for #228. -->

## Goal

Prove the repo-plus-PDF foundation-to-patch journey offline and read the
sanitized proceed / iterate / stop scorecard without credentials.

## Commands

```bash
# Machine acceptance (frozen on #228)
PI_OFFLINE=1 npx vitest run \
  test/foundation-to-patch-workflow.test.ts \
  test/candidate-keep-discard.test.ts \
  test/cli-outcome-router.test.ts
PI_OFFLINE=1 npx vitest run test/foundation-to-patch-dogfood.test.ts

# Thin helper: offline suite + optional packed-CLI smoke
npm run dogfood:foundation-to-patch
```

Sanitized scorecard:

`docs/internal/evidence/foundation-to-patch-dogfood-2026-08-12/scorecard.md`

## Gated self-dogfood (non-blocking)

Live DocsFab self-dogfood against a private backlog is optional for merge when
the offline grade is green. Enable only with an operator-managed environment:

```bash
DOCSFAB_FOUNDATION_TO_PATCH_SELF_DOGFOOD=1 npm run dogfood:foundation-to-patch -- --self-dogfood
```

Do not commit credentials, host paths, or raw transcripts. Publication execute
dogfood remains #247; CI→Brev remains #278.
