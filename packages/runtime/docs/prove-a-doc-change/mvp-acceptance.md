# MVP acceptance harness

The MVP acceptance harness proves DocsFab's offline control plane and, only
when explicitly enabled, its live policy-model and judge paths. It never runs
inside the source checkout: it exports the exact tested commit to a disposable
directory and verifies that the checkout's status is unchanged afterward.

## Offline acceptance

Choose state and evidence roots outside the DocsFab repository. Each invocation
creates a new timestamp-, commit-, and UUID-bound child directory, so repeated
runs never overwrite records or manifests.

```bash
npm run acceptance -- \
  --state-dir /absolute/operator/docsfab-state \
  --evidence-dir /absolute/operator/docsfab-evidence
```

The offline phases are fail-closed and sequential. The exact commit is first
exported with `git archive`. DocsFab then initializes a history-free Git
repository only inside that disposable export, force-adds the extracted tracked
files, and requires its Git tree identity to equal the tested commit's tree.
The synthetic export contains no source remotes, configuration, prior commits,
or deleted history and is removed during terminal cleanup.

Run the command from the runtime package. In the DocsFab monorepo, that directory
is `packages/runtime`. The harness exports and authenticates the complete Git
checkout, including root configuration and sibling packages. Package commands
then run from `packages/runtime` inside that export. A standalone runtime
checkout uses its root for both operations. State and raw evidence directories
must stay outside the complete checkout, including its sibling directories.

The export-aware doctor checks the tree of the export's commit and the
ordinary doctor's default verdict on that export, the `local-review` use. It
reads the commit's tree, not the export's working tree, so it does not notice a
tracked file that changes in the export after the export is committed. An
export that tracks `.docsfab.json`, as this repository does, must report that
use ready: exactly its installation, configuration, repository, provider, and
validation checks, each ready, no diagnostic, no validation command, the
`dry-run` and `patch-only` auto modes ready, and no live connectivity
requested. A source that does not track `.docsfab.json` reports the same
readiness, because project configuration gates only publication. The doctor
does not claim GitLab or private-state readiness. The export has no GitLab
remote, so readiness probes no GitLab credential, and the offline phase needs
none in the sandbox.

When the export doctor refuses, its output lists each difference from that
expected readiness as an observed and an expected code or status: the selected
use, the overall status, each area check, the diagnostic codes, the validation
command, the ready auto modes, live connectivity, the repository revision, and
whether the export tree matches. A value outside DocsFab's vocabulary is shown
as `(unrecognized)`. The list names no diagnostic explanation, path, or
environment value, so when the offline doctor refuses, the list stays intact in
`phase-output.json`. The live doctor's output is never collected; when it
fails, `networked-phase-failure.json` names only its code, failure class, next
action, and docs reference, as described under
[Evidence boundary](#evidence-boundary).

The phases are:

1. `npm ci --offline --ignore-scripts` in a clean tracked export, using an
   empty npm user configuration and an allowlisted environment;
2. `npm run check` and `npm run build`. `npm run check` runs without the
   placeholder model profile and the acceptance state directory, as ordinary
   CI test jobs do, and receives `CI` when the harness runs under CI, so its
   Vitest budgets and worker count match the other CI test jobs;
3. workflow listing and planning for every workflow in the registered catalog
   (currently the four public jobs plus parked internals such as readiness,
   bootstrap, IA planning, and site bootstrap);
4. authenticated export-aware offline doctor with an unapproved, non-secret
   placeholder model profile;
5. source-checkout integrity verification of the exact HEAD, Git tree, object
   format, and empty status; and
6. owner-only sanitized manifest generation with exclusive creation.

The npm cache must already contain the versions in `package-lock.json`. A cold
cache fails instead of permitting network access.

Every offline command runs inside a probed OS-level deny-network boundary:
macOS `sandbox-exec`, or Linux `bwrap`/`unshare`. DocsFab fails before running
the phases when none is active; it never silently downgrades to ordinary socket
access. Authentication and credential variables are not copied into the
offline environment; its home, temporary, npm configuration, and log
directories are disposable. Source export, archive extraction, and fixture Git
setup use the same network-denied, credential-free local command boundary.

The check phase leaves out the few test files that its network-denied boundary
defeats, names each one, and applies an exclusion only where its cause holds:

- `test/packed-profile-probe.test.ts` installs the packed package with
  `npm install --global`, which fetches npm registry metadata that no
  network-denied check can reach. Every check phase leaves it out.
- Before the phases run, DocsFab compares the owner of `/` inside the boundary
  with its owner outside. An unprivileged Linux `bwrap` sandbox is a user
  namespace that shows root-owned host paths as another uid, so root-or-self
  ownership checks cannot pass inside it. When the two owners differ, the check
  phase also leaves out `test/roadmap-issue-cli-security.test.ts`,
  `test/doc-improvement-cli.test.ts`,
  `test/native-composition-preflight.test.ts`,
  `test/live-agent-task-export.test.ts`, and
  `test/live-agent-task-runner.test.ts`. A boundary that shows the host
  owner, such as macOS `sandbox-exec`, runs them.

The harness prints both measured owners and one
`Acceptance check limitation:` line per excluded file with its reason, and the
manifest records the same under `checkLimitations`. Every excluded file still
runs in the same commit's CI test jobs.

## Live policy-model acceptance

Live acceptance requires all normal `MODEL_*` configuration plus two
independent operator actions:

1. set `DOCSFAB_ACCEPTANCE_LIVE=true`;
2. pass `--live` and `--approve-model-url` exactly matching `MODEL_BASE_URL`.

The whole-repository credential scan is advisory only (epic #91, task #110):
repository secret enforcement is CI's responsibility, so no scanner exemption or
self-scan authorization is required to run readiness against DocsFab's own exact
revision even though it tracks deliberate credential-shaped fixtures. Both the
fixture and self readiness records carry the `advisory` scan disposition and no
override authorization.

DocsFab runs the live doctor, creates a disposable Git repository from the small
readiness fixture, runs readiness there, and runs readiness against DocsFab
itself. The live doctor first revalidates the tree of the export's commit and
the same local-review readiness, then performs only the separately
approved policy-provider connectivity probe; it does not claim GitLab
connectivity for the history-free export. Approved endpoint URLs must be HTTPS and contain no embedded
credentials, query string, or fragment. DocsFab's provider boundary rejects
foreign origins and every redirect instead of forwarding a request body or
authorization header to an unapproved destination.

```bash
DOCSFAB_ACCEPTANCE_LIVE=true npm run acceptance -- \
  --state-dir /absolute/operator/docsfab-state \
  --evidence-dir /absolute/operator/docsfab-evidence \
  --live \
  --approve-model-url "$MODEL_BASE_URL"
```

## Optional judge

The judge is never enabled by the policy-model gate. It additionally requires
`JUDGE_ENABLED=true`, `DOCSFAB_ACCEPTANCE_JUDGE=true`, `--judge`, and an
`--approve-judge-url` value exactly matching `JUDGE_BASE_URL`. The judge receives
the two actual live readiness records only after structural validation. Its
stored result contains fixture, rubric, model identity, disposition, and score;
it omits evidence, rationale, endpoints, and raw output. The result carries the
acceptance ID, tested commit, validated judge-profile status, and SHA-256 digest
of each input record; the main manifest verifies those bindings and records the
judge artifact's own digest.

Policy-only phases receive no judge configuration or judge credential even when
it is present in the parent environment. The judge configuration crosses the
subprocess boundary only for the separately gated judge phase.

```bash
JUDGE_ENABLED=true \
DOCSFAB_ACCEPTANCE_LIVE=true \
DOCSFAB_ACCEPTANCE_JUDGE=true \
npm run acceptance -- \
  --state-dir /absolute/operator/docsfab-state \
  --evidence-dir /absolute/operator/docsfab-evidence \
  --live \
  --approve-model-url "$MODEL_BASE_URL" \
  --judge \
  --approve-judge-url "$JUDGE_BASE_URL"
```

## Evidence boundary

Raw run records stay under the unique invocation directory beneath
`--state-dir`. The acceptance harness and ordinary CLI use the same enforced
private-state policy: the raw-record directory is `0700`, temporary and final
record files are `0600`, an owned permissive root is tightened before use, and
unsafe or unverifiable roots fail closed. State and evidence directory identities
are pinned for the invocation; JSON leaves are read and written through
owner-only, no-follow descriptors and root/leaf substitution fails closed. The
manifest binds the exact fixture commit, tested self revision, and exact
input-record digests. It contains only phase
status and duration, tested commit, profile status, record IDs and SHA-256
digests, workflow/run status, model identity, scanner disposition, stable rule
IDs, and gate state. It omits repository paths, finding paths, prompts, step
summaries, model text, endpoint URLs, credentials, environment values, and the
host paths of the selected output roots. The sanitized manifest—not the raw
record directory—is the supported sharing boundary. See the canonical
[raw-record storage policy](../reference/contracts/run-record.md#private-storage-and-sharing-boundary).

When a command in an offline phase (installation, check, build, catalog, or
offline doctor) exits nonzero, the harness also writes `phase-output.json` beside
the manifest. It names the phase, the command, and its exit code, and carries the
command's combined standard output and error. Before it is written, terminal
control sequences are removed, the values of credential-named environment
variables and the private root paths are replaced, and the credential shapes
DocsFab's screens recognize are redacted. A line that the collection screen
would still flag in serialized JSON form is replaced by
`[line withheld from collection]`, so the rest of the output can still be
collected. The manifest's failure reason stays
`command exited nonzero`. Output from networked phases is never written there,
because it can carry provider detail.

Each networked DocsFab command (the live doctor, both live readiness runs, and
the judge) runs with `--json`, so it reports a failure as structured JSON. The
judge has one exception: when its structural check or its judge model fails, it
exits 1 and prints no JSON. When a networked command exits nonzero, the harness
prints one line that names the phase, its exit status, and the reported code and
failure class:

```text
Networked phase failure: live-doctor exited 1, code live-model-check-failed, failure class infrastructure (layer cli).
```

It also writes `networked-phase-failure.json` beside the manifest. That summary
names the phase and exit status, and its `report` field names where its other
fields came from:

- `operator-error`: the operator failure envelope on standard error. The summary
  keeps its `code`, its `failure` class, layer, and classified code, and its
  `nextAction` and `docsAnchor` when present.
- `run-result`: the run-scope failure in the run result on standard output,
  for a readiness run that failed. The summary keeps its `code` and `failure`.
- `none`: the command printed neither, so the summary names no code. This is the
  case for a failed Git command in the fixture setup and for the judge's
  structural or judge-error failure, which exits 1 without JSON.

The summary never carries the command's output or the envelope's message,
because the model credential is in that command's environment. Each kept string
passes through the same sanitizing as `phase-output.json`, so a credential value
or recognized credential shape is redacted or withheld, never echoed. Writing
the summary never changes the phase result or the manifest.

The live doctor gives its provider, model, installed-skill, and export-readiness
failures a stable `code` each. The summary then tells a provider check that did
not succeed from a configured model that is not available. A failure with no
code of its own reports `operator-error`.

Three failures write no summary and no trace line, because none of them is a
networked command that exits nonzero:

- The judge's record-binding pre-check refuses to start the judge when it cannot
  read the two live readiness records, or when they are not the exact fixture
  and self records.
- The harness's read of the fixture commit's revision fails, or prints no commit
  identity, after the fixture commit succeeds. The readiness run that follows
  does not start.
- A networked command fails to spawn. The manifest reports it as the `setup`
  phase.

The manifest still records each of these failures, and the acceptance fails.

For a failed canonical `npm run check`, the minimized manifest may also identify
whether the command exited, was signaled, or could not spawn. It may include an
allowlisted npm lifecycle script and, for the `test` script, a path that exists
under the runtime package's test directory. These fields are parsed from
standard output only; arbitrary lifecycle text, paths, and all standard error
are excluded. The diagnostic fields do not contain process output or alter the
check command's exit status.

## Collectable evidence for CI

`--state-dir` and `--evidence-dir` must stay outside the source repository.
Some CI platforms, such as GitLab, collect artifacts only from paths inside the
project checkout. To publish the sanitized manifest where such a platform can
collect it, name a collectable destination with `--collect-dir`:

```bash
DOCSFAB_ACCEPTANCE_LIVE=true npm run acceptance -- \
  --state-dir /absolute/operator/docsfab-state \
  --evidence-dir /absolute/operator/docsfab-evidence \
  --collect-dir "$CI_PROJECT_DIR/packages/runtime/ci-results/live-model" \
  --live \
  --approve-model-url "$MODEL_BASE_URL"
```

After the private manifest is published, the harness writes a byte-identical
copy to `<collect-dir>/<acceptance-id>/manifest.json` and prints its path as
`Collectable manifest:`. The collectable destination follows these rules:

- It can be inside the checkout. The outside-repository rule for
  `--state-dir` and `--evidence-dir` does not change, so raw run records and
  private state never enter the checkout.
- It must not contain, equal, or sit inside either private root, and no
  existing path component can be a symbolic link. The harness checks this
  before it runs any command.
- Only the sanitized manifest and, after a failed offline phase, the sanitized
  `phase-output.json` or, after a failed networked phase, the sanitized
  `networked-phase-failure.json` are written there, each byte-identical to its
  private copy. The harness prints the phase output's path after
  `Collectable failed phase output:` and the networked summary's path after
  `Collectable networked phase failure summary:`. Raw run records, judge
  results, and other private state are never copied. If the phase output or the
  summary cannot be kept or collected, the harness prints why and the
  acceptance result is unchanged.
- The harness refuses to write the copy when the manifest would contain the
  value of any credential-named environment variable (names ending in
  `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSPHRASE`, `CREDENTIAL`,
  `CREDENTIALS`, or `PRIVATE_KEY`), a recognized credential shape, or a private
  root path. A credential refusal names the variable, never its value. The
  command exits nonzero, and the private manifest remains under
  `--evidence-dir`.
- Each invocation creates a new owner-only `<acceptance-id>` directory and
  writes the manifest exclusively, so an earlier collection is never
  overwritten.

The option needs no terminal and prompts for nothing, so unattended callers can
use it.
