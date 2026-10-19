# Coverage lane evidence

Ready MR and other full runtime CI runs each test file once. The four
`runtime:test` fast lanes and the three `runtime:isolation:*` lanes run through
`coverage-shards.mjs lane`, collecting V8 coverage from supported files and
running coverage exclusions separately. Those runs are both the test gate and
the lane's coverage input. `runtime:coverage` then uses `coverage-shards.mjs
merge` and Vitest's native blob merger to enforce the thresholds in
`vitest.config.ts` once. Lanes disable thresholds only while collecting their
partial V8 data. The merge resolves the canonical Vitest configuration and
rejects missing or disabled thresholds before processing lane evidence. It
also rejects the lane-only collection flag.

Draft or WIP detached and merged-result MR pipelines still run every fast-lane
file, using `vitest-ci.mjs fast --shard=N/total` and the same duration-weighted
assignment. They write JUnit reports and fail on test failures, but omit V8
instrumentation because the Draft hold omits `runtime:coverage` and the three
isolation lanes. Once the MR is ready, `runtime:test` returns to the
instrumented lane command and the complete coverage merge is required. When
selected in push, schedule, tag, or other non-Draft contexts, `runtime:test`
also retains that instrumented command.

`scripts/ci-heavy/<domain>.txt` is the only source of lane membership, and each
lane in the package checks it against `scripts/ci-heavy-tests.txt` first. Each
isolation lane runs its list. The fast lanes run every other discovered file,
split by recorded duration (see [Fast-lane split](#fast-lane-split)).
`scripts/vitest-ci.mjs` derives its local modes from the same lists, and its
`fast --shard=N/total` runs the same split, so the public export's runtime test
shards match `runtime:test`.
A valid fast shard with no assigned files reports that no tests ran and exits
successfully before invoking Vitest. It emits no test or coverage evidence;
coverage lanes still collect their complete manifests, including empty lanes.
Files in `coverageExclusions` fail under V8 coverage. They still run in their
own lane, in a second Vitest run without coverage. That run writes its own
blob and a `-plain-junit.xml` report.

Every lane records its exact revision, absolute package root, full Vitest file
inventory, planned instrumented and uninstrumented files, unique task IDs and
completion states, blob digests, source/test/config/lock/toolchain
fingerprints, elapsed time, and GNU `time` peak RSS for each Vitest command.
The merge recomputes every lane's plan from the checkout, then fails if:

- a lane is missing, extra, duplicated, incompatible, incomplete, or tampered
  with;
- a lane ran anything other than its planned files; or
- the lanes together did not run the full test plan exactly once.

Only verified instrumented blobs reach Vitest. The merge reads the number of
fast lanes from their manifests, so `runtime:test`'s `parallel` value is its
only declaration.

Blob reports contain absolute paths. CI therefore requires every lane and the
merge job to use the same checkout root. Cross-root blob normalization is not
supported because rewriting Vitest's native coverage payload would weaken the
evidence that the merger consumes.

Run the focused regression suite with:

```bash
node --test scripts/coverage-shards.test.mjs
```

## Fast-lane split

The fast lanes wait for their slowest shard, so they are split by how long each
file takes, not by how many files each shard gets. `scripts/ci-test-timings.json`
records each fast-lane file's duration in milliseconds, taken from the
`<testsuite time>` of the lanes' JUnit reports. Every shard job computes the
whole split on its own, and the merge recomputes it, in the following way:

- Files are placed longest first, each into the shard with the least recorded
  time, then the fewest files, then the lowest index. Ties between files break
  by path, so the result does not depend on discovery order.
- A file the timings file does not record, such as a new test, weighs the
  median recorded duration of the files in the split. Without a timings file,
  every file weighs the same and the shards get equal file counts.
- The split only places files. Every discovered file still runs in exactly one
  lane, and the merge still rejects lanes that do not partition the full plan.

The timings file is part of the lanes' configuration fingerprint, so changing it
while lanes run fails the merge instead of mixing two splits.

Regenerate it from the `ci-test-*-junit.xml` and `ci-test-*-plain-junit.xml`
artifacts of a recent green full `runtime:test` run. Several pipelines' reports can
be passed at once; a file in more than one report records the mean. Files that
are no longer discovered or that run in an isolation lane drop out, and so do
internal-only `*.internal.test.*` suites, because the public export ships the
timings file without them. The command prints the estimated time of each shard:

```bash
node scripts/coverage-shards.mjs timings --total=4 ci-results/*-junit.xml
```

Stale timings never drop or repeat a test; they only make the shards less even.

## Pending-import coverage compatibility

Vitest 4.1.11 records a module's execution-wrapper offset only after its
evaluation finishes. An import that is still pending when coverage is collected
can therefore corrupt merged V8 source positions, producing both false zero
counts and hits attributed to the wrong statements. The coverage setup hook
backports the eager metadata initialization from
[Vitest #10643](https://github.com/vitest-dev/vitest/pull/10643).

The hook acts only when the V8 coverage provider is enabled. It records the
wrapper offset supplied by the evaluator before evaluation suspends; Vitest
still collects, converts, and merges the native counters and enforces the same
thresholds. Both the hook and its setup entrypoint are bound into the shard's
configuration fingerprint. This is a temporary dependency on private Vitest
evaluator/debug APIs, guarded to exactly 4.1.11. An unknown version or incompatible API fails
explicitly. Remove the hook when upgrading to a version containing the upstream
fix, after proving the pending-import regression against that version.

Run the evaluator-boundary regression without a nested Vitest process:

```bash
node --test scripts/vitest-coverage-module-offset.test.mjs
```

The shard regression compares a standalone run of the existing contract-kit
tests with a hooked run of the same tests alongside an intentionally pending
import. Both runs must pass their tests, with exactly one additional passing
pending-import test in the second run. Its `hash` and `seal` function counts must match the
positive standalone counts. An unpatched aggregate can report correct counts
on some runtimes, so this check does not require false zeros. The separate
evaluator-boundary regression directly checks the pending metadata that the
hook repairs. These focused runs keep the canonical whole-suite thresholds and
therefore still exit with a coverage failure; they are an attribution regression,
not whole-suite coverage qualification.
