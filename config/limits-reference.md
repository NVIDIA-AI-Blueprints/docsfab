# Operational Limits Reference

This page describes the limits catalogs and their consumers. Return to the
[configuration source map](README.md) for a shorter route into this directory.

Operational limits are declared in per-owner fragments under
[`limits/`](limits/), one file per name prefix: `host.*` limits live in
`limits/host.yaml`, `sources.*` limits in `limits/sources.yaml`, and so on.
[`limits.yaml`](limits.yaml) is the root registry: it lists every fragment and
its owner prefix, in the order the generator composes them. The generator
refuses, by name, a limit declared in two fragments, a limit whose first name
segment is not its fragment's owner, a `*.yaml`/`*.yml` file or subdirectory
under `limits/` that the registry does not list, and a registered fragment
that is missing. Run `npm run generate:limits` from `packages/runtime` after
changing the catalog.
The generator updates the committed shell and CI mirrors, including the
[`limits.json`](limits.json) recovery configuration consumed by both languages.
There is one TypeScript mirror, `packages/runtime/src/config/limits.generated.ts`;
the host package imports it directly rather than carrying its own copy. It and
the knowledge mirror `packages/knowledge/src/first-pass-limits.generated.mjs`
are not committed: git ignores both, and the build, typecheck and test commands
generate them first (`packages/runtime/scripts/ensure-derived.mjs`). Commit the
other mirrors the generator rewrites. `npm run check:limits` checks the
committed ones only (`--committed-only`) and names the two it skips.
Do not edit the generated mirrors directly.

[`limits.catalog.json`](limits.catalog.json) is a separate generated mirror:
every catalog entry, keyed by name, for consumers that are neither
TypeScript/JavaScript (the `LIMIT_DEFINITIONS` mirror) nor the fixed
`recovery` shape above. Its first consumer is the Python independent checker at
`packages/quality/benchmarks/runtime/evaluation/context-v1-source-acquisition/checker.py`.
`limits.json` remains recovery-only: non-recovery entries do not get a second
table in that file.

`DOCSFAB_LIMITS_CATALOG_FILE` names `limits.catalog.json` explicitly, the same
way `DOCSFAB_LIMITS_FILE` names `limits.json` below. Unset or empty, the Python
checker resolves the in-repo mirror from its own location, so no caller has to
set it; it exists so a test can point the loader at a fixture and exercise the
four fail-closed refusals (absent file, invalid JSON, unregistered entry,
non-integer value) without rewriting the repository's own generated catalog.
It selects which file the bounds are read from and never supplies a
bound: every bound remains a limits catalog entry, and a catalog that cannot be
read is an error, never a default.

`DOCSFAB_LIMITS_FILE` names the file explicitly. When the host package is
present, its TypeScript loader (`packages/host/src/limits.ts`) resolves this
file from the package tree. Internal deployments that include the host and
deployment packages also export this variable from recovery entry points after
selecting a verified release configuration. The GitLab storage recovery
adapter falls back to a path beside its own directory and then to
`/etc/docsfab/limits.json`. Bootstrap does not install either path, so callers
must export the variable; the adapter fails closed if none is available.

The following deployment behavior applies only when the internal deployment
tree and host package are present; these paths are not part of the public CLI
export. The recovery tools are refreshed by `upgrade-core-tooling`, independently of
`/srv/docsfab/current`. The backup gate and recovery entry points select the
newest eligible verified configuration from the incoming, current, and previous
releases. A candidate with invalid configuration refuses the operation. The
legacy bound applies only when no eligible release carries the file, with a
warning on stderr. Runtime rollback still requires compatible code and data.

## `recovery`

| Name | Meaning |
| --- | --- |
| `logicalObjectMaxBytes` | Largest logical project object a verifier reads into memory before parsing it. The bundle arrives from a remote store, so this bound is a defense: an oversized or hostile object must fail before parse, not during it. |
| `legacyLogicalObjectMaxBytes` | The bound producers assumed before a bundle manifest recorded its own. It applies to every manifest whose backend does not state `logicalObjectMaxBytes`, which includes every bundle sealed before that field existed. |
| `minimumLogicalObjectMaxBytes` | Floor for any bound, configured here or recorded in a manifest. A lower value would refuse objects a verifier must be able to read. |
| `manifestMaxBytes` | Largest bundle manifest, object inventory, or restore receipt a verifier reads before parsing. These grow with the project count, not with job history, so they keep their own much smaller bound. |
| `logicalCiphertextOverheadBytes` | Ciphertext allowance added to the logical bound by the storage adapter. |
| `headroomWarnRatio` | Share of the bound at which a headroom report warns. |
| `headroomDegradedRatio` | Share of the bound at which a headroom report is degraded and its reader exits 3. |

`logicalObjectMaxBytes` defaults to 536,870,887 bytes, 25 bytes below 512 MiB.
This is the largest value the current whole-string loader accepts on qualified
64-bit Node versions. Node's `MAX_STRING_LENGTH` is 536,870,888 UTF-16 code
units. Worst-case ASCII JSON needs one code unit per input byte, and the loader
requires a bound strictly below that ceiling.

The former 256 MiB value was a heap-headroom choice, not a value derived from
Node's ceiling. The current default removes that extra margin while preserving
the existing representation check. Literal 512 MiB requires a different
representation throughout export, verification, canonical serialization, and
restore; changing only this scalar cannot make that object readable.

The allowance does not reserve memory. A restore also needs buffers, the parsed
object graph, and canonical serialization. Qualify the complete restore against
its destination resources before claiming capacity for near-limit objects.

`minimumLogicalObjectMaxBytes` is the floor every other bound answers to, so
setting it very low defeats the protection it exists to provide. Keep it at or
above 1 MiB outside a test fixture: below that, a producer could record a bound
that makes every later restore decline to read its own bundle.

The effective bound for one bundle is the smaller of what its manifest records
and what the verifier is configured to read. A manifest that records more is
accepted and clamped, so lowering the configured value cannot retroactively
make already-sealed bundles unreadable. A manifest that records less than
`minimumLogicalObjectMaxBytes` is refused at seal and at parse. The TypeScript
verifier and the GitLab storage adapter apply those two rules identically: a
bundle one of them declines to read is a bundle no restore can reach.

Add operational limits to the owning capability's fragment under
[`limits/`](limits/), then regenerate the mirrors. Keep warning ratios and
retry delays separate from capacity allowances.

This is the recovery subset of the repository-wide limits convention. Add
operational limits in their owner's fragment under [`limits/`](limits/) via
`limit()` / `refuseLimit()`, not as a second table in this JSON file.

## `deploy`

These fields describe internal service deployment limits. They are relevant
only when `config/limits-deploy.json` registers a deployment scan root and the
deployment package is present.

| Name | Meaning |
| --- | --- |
| `diskFreeMinBytes` | First backup staging disk-free precondition. Available bytes at this floor pass; one byte less is a Recover-class refuse. Sized to `recovery.logicalObjectMaxBytes` so one logical object can be staged. Catalog min is that floor. A host can restate it in `recovery.env` as `DOCSFAB_DEPLOY_DISK_FREE_MIN_BYTES`; install, systemd, the `env -i` backup transition, and backup start parse that override fail-fast. A value below one logical object refuses. |
| `diskHeadroomOverBytes` | Absolute available-bytes floor at which `docsfab-status` reports disk headroom over (exit 3, never 1). Catalog default is 1.25 GiB. A host may only lower it through `DOCSFAB_DEPLOY_DISK_HEADROOM_OVER_BYTES` in `service.env`. Install and startup parse that generated-known override. Effective warn must exceed over. |
| `diskHeadroomWarnBytes` | Absolute available-bytes floor at which `docsfab-status` reports disk headroom warn (exit 3). Catalog default is 3 GiB. A host may only lower it through `DOCSFAB_DEPLOY_DISK_HEADROOM_WARN_BYTES` in `service.env`. Must exceed `diskHeadroomOverBytes`. |
| `hostTimeoutStopSeconds` | Sealed release invariant equal to `TimeoutStopSec` on `docsfab-host.service`. T2 audits that unit and the unset timeouts on `docsfab-recovery.service` without changing those defaults. Host configuration cannot override it. |

## The deploy scan root

`check:limits` scans one host deployment directory under `deploy/` besides the
product packages. `limits-deploy.json` names it (`{ "scanRoot":
"deploy/<name>" }`), so no exported code or registry names a host's
deployment. That file also registers the root's allowlist shard,
`limits-allowlist/deploy.<name>.json`, which `limits-allowlist.json` does not
list, and places the shell mirror at `deploy/<name>/limits.generated.sh`.

## Checks in a tree without internal paths

The public export leaves out the CI definition, the deploy tree and its
configuration, and the host package with its allowlist shards, so some
generated mirrors and scanned roots have no owner there.
`npm run check:limits` and `npm run check:env-admission` (from
`packages/runtime`) then check everything that is present and print one line on
stdout for each part they skipped:

- `<mirror>: skipped, its owner <owner> is absent from this tree`, for a mirror
  whose consumer is absent.
- `<file> limits projection: skipped, its owner <file> is absent from this tree`
  (`check:limits` only), for a CI file whose bounds it cannot compare.
- `<root> literal scan: skipped, the scan root is absent from this tree`
  (`check:limits` only). Allowlist entries under that root are not compared,
  and a registered shard for it may be missing.
- `deploy shell mirror: skipped, ...` and `deploy literal scan: skipped, ...`
  (`check:limits` only), when `limits-deploy.json` is absent, so no deploy
  root is configured.

A present owner or root keeps every drift, stale-entry, and missing-shard
refusal. `check-limits.mjs --write-allowlist` refuses while a scanned root is
absent, because rewriting would drop that root's shard, and while the deploy
root is unconfigured. `--scope deploy` refuses without a configured deploy
root rather than scanning nothing.
