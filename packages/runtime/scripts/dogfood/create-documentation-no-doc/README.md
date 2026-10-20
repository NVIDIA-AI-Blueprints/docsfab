# create-documentation no-doc dogfood

Non-product helper for #154.
It copies the `no-doc` maturity-cascade fixture to a throwaway Git repo, runs
`docsfab init --non-interactive --apply` **on that copy only**, then
`docsfab run create-documentation --allow-write` with a fixed instruction.

This factory checkout is never the `--repo` target. Run records stay in a
temporary state directory. Do not commit `.env`, `dist/`, or run records.

## Prerequisites

From `packages/runtime`:

```bash
cp .env.example .env   # gitignored; set MODEL_PROVIDER, MODEL_BASE_URL, MODEL_ID, MODEL_API_KEY
npm run build
node dist/launcher.js list   # must print create-documentation
```

The template picks no model. Set the three selection fields to your route
(see "Model profile choices" in `.env.example`); until you do, a live run stops
and lists them as missing.

## Commands

Dry-run (default; no model, no init apply):

```bash
node scripts/dogfood/create-documentation-no-doc/cli.mjs
```

Live write (Inference Hub via gitignored `.env`):

```bash
node scripts/dogfood/create-documentation-no-doc/cli.mjs --live
```

`--keep` leaves the throwaway directory for inspection. There is no
`--canon-snapshot` on this Task.

## Remote

`docsfab init` needs a GitLab remote on the throwaway repository. The helper
gives it `--remote-url <url>` when passed, otherwise this checkout's `origin`
remote. A `--remote-url` with credentials is refused; credentials in an
HTTPS `origin` URL are dropped before the copy gets it.

A checkout without an `origin` remote, such as the public export or a fresh
clone of it, still dry-runs; the printed `remote` reports `source: "none"`.
`--live` there refuses with `dogfood-no-doc-remote-required` until you pass
`--remote-url`:

```bash
node scripts/dogfood/create-documentation-no-doc/cli.mjs --live --remote-url https://gitlab.example.com/group/project.git
```

## Output bound

Each launcher command's stdout and stderr are captured up to
`dogfood.noDocLauncherMaxBufferBytes` (`config/limits/dogfood.yaml`), read from
the generated `config/limits.catalog.json`. Output past it stops the run with
`dogfood-no-doc-launcher-max-buffer-bytes-bound`; the truncated output is never
parsed or reported as a success. A checkout without that mirror refuses before
it copies anything; run `npm run generate:limits` from `packages/runtime`.

## Result

A live run must exit 0. The throwaway run record must include these crate
steps:

- `plan-documentation`
- `write-documentation`
- `lint-documentation`
- `verify-technical-accuracy`
- `review-documentation`
- `evaluate-document-quality`

Init and write apply only to the throwaway copy. `git status` on this
factory checkout must stay clean (no new `.docsfab.json` from the run).
Do not commit `.env`, `dist/`, run records, patches, or generated docs.
