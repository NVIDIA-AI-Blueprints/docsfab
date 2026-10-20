# Governed template operations

DocsFab exposes template mechanics as typed operations that remain independent
of Pi:

```text
template.list
template.previewSite
template.scaffoldSite
template.scaffoldPage
template.validatePage
```

The host verifies `template-set-v1` and seals its private bytes in an
opaque capability before a write operation begins. The IA plan binds the exact
catalog digest, so a caller cannot substitute another self-consistent lock or
project root. The adapter supports only GFM and MyST. Every catalog and
scaffold result records the exact source repository, immutable revision,
source path, version, license, and SHA-256 for both the template and its lint
schema. Imported Python scripts are provenance evidence and are never executed
by these operations.

`template.previewSite` is pure and accepts only paths present in an effective,
explicitly approved IA plan. It renders all outputs in memory, reports
unsupported placeholders as structured evidence gaps and TODOs, and returns
`writesPerformed: false`. The authentic adapter ports the upstream default
author-note stripping and product/package placeholder replacements.

The write operations require the IA plan's versioned policy bindings to contain
the exact digest of every selected page shape, then revalidate the durable plan
and recompute its complete diagnostic, scoring, and navigation evaluation
immediately before preflight. Site selections must equal the approved output
scope; a page scaffold requires a one-page grant. Evidence node IDs must resolve
in the same Content IR. The opaque active workspace capability and its revision
must match that Content IR; callers cannot authorize an arbitrary directory by
supplying a revision string. The exact host-prepared repository-check policy is
also plan-bound; executable arguments and the allowlist remain private inside
that capability. Authorization time comes from the write operation's
trusted clock and expiry is checked again immediately before exclusive creation.
Every output is then checked for traversal, absolute or NUL paths, portable
name collisions, existing targets, parent-file collisions, and symlink
components before any write occurs. Topic filenames come from approved topic
slugs rather than generic template descriptors.

Creation uses exclusive, no-follow files and a sealed workspace/path plan. It
never overwrites an existing path. Before creation, all pages run a versioned
MVP structural policy against the exact governed schema: required headings and
duplicate H1s are blocking, while section order and unresolved placeholders are
reported. Upstream optional-heading, orphan-heading, and long-file advisory
rules are intentionally not claimed by this policy. Trusted versioned repository checks run
without a shell or inherited credential environment after creation. DocsFab
then hashes the complete workspace again and requires the only changes to be
the approved outputs with their previewed bytes; a passing check that changes a
source file or creates a build artifact still fails the operation. A partial
write, race, or failed repository check rolls back only the transaction-owned
files and empty directories.

The disposable export is private to the harness and held under one exclusive
in-process lease for the operation. File and directory identities are rechecked
at each write/check seam, and replacement identities are never removed during
rollback. Concurrent out-of-process mutation by the same operating-system
account is outside the cooperative workspace contract; callers must not share
the temporary export with another writer.

The returned scaffold summary is suitable for a structured run record: it
contains relative paths, hashes, byte counts, provenance, validation findings,
and command-output hashes, but no rendered page bodies, command output, host
paths, or credentials. The existing repository evidence collector can capture
the disposable workspace as a Git patch while the source checkout remains
unchanged.

The canonical template-set revision does not contain `tpl-design-ia`.
DocsFab therefore keeps the existing local IA draft separate and reports
that upstream gap instead of relabeling the draft as an imported asset.
