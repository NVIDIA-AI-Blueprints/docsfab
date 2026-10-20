# Dependency exceptions

Dependency exceptions are temporary containment records, not claims that an
advisory is resolved. `npm run security:dependencies` verifies that each
accepted dependency chain still matches the reviewed evidence. Any drift fails
`npm run check` and requires the exception to be removed or reviewed again. The
check also fails when a review becomes due and keeps a production-tree scan in
place after remediation so an affected version cannot be reintroduced silently.
The machine-readable scorecard disposition lives in
`packages/quality/benchmarks/runtime/evaluation/scorecard/mvp-scorecard-policy.json`;
the dependency check imports
that exact record, so changing `contained` to `resolved` while an affected
production path remains makes the check fail rather than lifting the readiness
ceiling.

## GHSA-mh99-v99m-4gvg: brace-expansion denial of service — Resolved

| Field | Value |
| --- | --- |
| Status | **Resolved** (2026-08-31) |
| Owner | Content Engineering / DocsFab maintainers |
| Tracking issue | Sibling-product docsfab #7; remediated via DocsFab #624 |
| Contained | 2026-08-03 |
| Registry and upstream checked | 2026-08-18 |
| Review was due | 2026-08-31 |
| Resolved | 2026-08-31 |
| Decision reviewed by | Maintainer review |
| Decision review date | August 31, 2026 |
| Decision evidence | DocsFab #624 |
| Technical-analysis receipt | Conductor session `667f15dc-f5c3-48c1-a6fb-70e8e3a2591a`, Claude Opus 5 message `05758926-b4fe-40d5-8717-4ad6377705a0` |
| Decision receipt | User message `b4310c98-0265-49e1-8319-abf7bbbd9516` |
| Remediation target reviewed | `@earendil-works/pi-coding-agent@0.84.4` |
| Implementation evidence | DocsFab MR !375 at `47d239e214afa956d1e1212b550fb2e341fb9248` |
| Remediation | Bumped `@earendil-works/pi-coding-agent` `0.83.0` -> `0.84.4` |
| Formerly affected chain | `@earendil-works/pi-coding-agent@0.83.0` -> `minimatch@10.2.5` -> `brace-expansion@5.0.7` |
| Current chain | `@earendil-works/pi-coding-agent@0.84.4` -> `minimatch@10.2.5` -> `brace-expansion@5.0.9` |
| Patched version | `brace-expansion@5.0.8` |

### Resolution (2026-08-31)

On August 31, 2026, Claude Opus 5 analyzed two dispositions for the due
exception: renew containment after re-testing applicability, or remediate by
adopting a fixed Pi tree. The reviewing maintainer reviewed those dispositions
and selected remediation: “If Path B is cleaner, then let's do that now. No use
in doing the bandaid instead of the actual fix.” Pi 0.84.4 (the newest published
release observed on August 31, 2026) still depends on minimatch 10.2.5. Its
shrinkwrap pins `brace-expansion@5.0.9`, past the 5.0.8 patch. DocsFab bumped
the pin in
`packages/runtime/package.json` to `0.84.4`, ran a real `npm install`, and
regenerated both
`package-lock.json` and `npm-shrinkwrap.json` (npm treats the shrinkwrap file
as authoritative when both are present, so `npm install` updates
`npm-shrinkwrap.json`; `package-lock.json` was then re-synced from it so the
two remain byte-identical, which `scripts/verify-packed-cli.mjs` enforces).

Verification was against the actually installed tree, not just the published
shrinkwrap. `npm explain brace-expansion` on the installed 0.84.4 tree shows:

```text
brace-expansion@5.0.9
node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion
  brace-expansion@"^5.0.5" from minimatch@10.2.5
  node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch
    minimatch@"10.2.5" from @earendil-works/pi-coding-agent@0.84.4
    node_modules/@earendil-works/pi-coding-agent
      @earendil-works/pi-coding-agent@"0.84.4" from the root project
```

`brace-expansion@5.0.9` is past the `5.0.8` patch, so the previously affected
production path no longer exists. It is also now the *only*
`brace-expansion` copy anywhere in the installed tree (the dev-only copies
noted below, from Vitest coverage and glob 10, are gone as of 0.84.4's
dependency set).

The scorecard policy's `dependency.status` field was changed from
`contained` to `resolved` in
`packages/quality/benchmarks/runtime/evaluation/scorecard/mvp-scorecard-policy.json`.
In `scripts/check-dependency-exceptions.mjs`, `activeException` is derived as
`null` whenever `dependencyPolicy.status !== "contained"`, so this retires the
exception; the script's own production-tree scan then runs in its
no-exception mode, which fails closed if *any* affected `brace-expansion`
(version <= 5.0.7) is found in the production tree, regardless of path. This
mode was verified directly: temporarily editing the installed lockfile to
reintroduce `brace-expansion@5.0.7` at the Pi-nested path caused
`node scripts/check-dependency-exceptions.mjs` to fail with `GHSA-mh99-v99m-4gvg
was reintroduced at node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion@5.0.7.`
and exit non-zero; the real, remediated lockfile was restored immediately
after. `test/dependency-exceptions.test.ts` now covers this reintroduction
path directly (and keeps regression coverage for the "active exception"
branches of `validateDependencyState` via a synthetic historical fixture, in
case a future advisory needs the same containment mechanism).

Closure evidence: the installed-tree inspection above, plus the disappearance
of the formerly-affected path, is treated as sufficient because it inspects
the exact artifact that ships (the installed tree), not only registry
metadata. This closes the "Removal and escalation triggers" condition from
the original containment review below (npm publishing a release whose
installed tree no longer contains an affected `brace-expansion`).

---

## History: containment (2026-08-03 through 2026-08-31)

The sections below are preserved as the record of the original containment
decision and its evidence. They describe why the still-vulnerable dependency
was judged acceptable to ship temporarily, not the current state — see
**Resolution** above for that.

The live npm registry reports Pi 0.84.2 as the newest published release as of
2026-08-18. DocsFab remains pinned to 0.83.0. Pi 0.84.2 still depends on
minimatch 10.2.5; its published npm shrinkwrap lists `brace-expansion@5.0.9`
(past patched 5.0.8). Adopting that tree would require bumping the Pi pin and
lockfile, which this review does not do. `npm explain brace-expansion` on the
installed 0.83.0 tree confirms that Pi depends directly on minimatch and also
reaches the same minimatch through glob, and that the production path is still
affected:

```text
@earendil-works/pi-coding-agent@0.83.0
|- minimatch@10.2.5
|  `- brace-expansion@5.0.7
`- glob@13.0.6
   `- minimatch@10.2.5 (deduped)
```

Dev-only copies (`brace-expansion@5.0.9` via Vitest coverage, and
`brace-expansion@2.1.4` via glob 10) are outside the production-tree guard.

The advisory affects brace-expansion through 5.0.7 and describes an uncatchable
out-of-memory denial of service from a crafted brace pattern. Pi invokes
minimatch in its model resolver and package manager. DocsFab loads Pi's SDK but
does not route requester- or model-controlled patterns into either call site,
so the vulnerable code is present but the advisory input is not exposed by the
current local, single-requester deployment. Both a root override and a Pi-scoped
override leave the shrinkwrapped brace-expansion 5.0.7 installation unchanged;
DocsFab therefore does not carry an override that would imply protection it does
not provide.

### Containment (historical)

- Keep Pi pinned exactly to 0.83.0 while this exception is active.
- Do not expose DocsFab as a shared or multi-tenant service.
- Do not pass requester- or model-controlled patterns to Pi's `minimatch` or
  `brace-expansion` dependency. DocsFab's repository export patterns are fixed
  in source and executed by Git; its confined `find` dialect is matched by
  DocsFab's non-expanding in-process implementation and rejects brace
  expansion.
- Run `npm run check` for every change. Its dependency-exception check fails if
  the reviewed Pi, minimatch, shrinkwrap, or brace-expansion facts drift, if a
  second affected production path appears, or when the review date arrives.

### Removal and escalation triggers (historical)

Remove the active exception record when Pi publishes a release whose installed
tree no longer contains an affected `brace-expansion`, then confirm with `npm
explain brace-expansion` and an online `npm audit --omit=dev`. Keep the machine
check enabled in its no-exception mode to detect reintroduction. Pi 0.84.2's
published shrinkwrap is a candidate for that removal, but only after DocsFab
pins and installs that release.

Stop local deployment and reassess immediately if any of these occur:

- DocsFab begins routing requester- or model-controlled expressions through
  `minimatch`, `brace-expansion`, shell execution, or another expansion engine.
- DocsFab is proposed for shared, multi-tenant, or untrusted-requester use.
- The machine check reports dependency-tree drift.
- The exception passes its next-review date without fresh registry and audit
  evidence.

`npm audit --offline --omit=dev` reported zero vulnerabilities on 2026-08-18,
but that result is explicitly rejected as closure evidence because the local
advisory cache does not contain this advisory. A fresh online audit could not
be attached during this review because transmitting this private project's
dependency metadata to the public npm audit endpoint was not authorized.
Closure requires explicit authorization for that online audit plus inspection
of an installed, remediated tree. (The 2026-08-31 resolution above satisfies
the installed-tree inspection requirement; an online audit remains
unauthorized and was not required once the affected path was gone from the
installed tree.)
