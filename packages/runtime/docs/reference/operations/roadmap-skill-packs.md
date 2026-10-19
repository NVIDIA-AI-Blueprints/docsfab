# Roadmap skill packs

DocsFab adapts four roadmap lifecycle capabilities from an NVIDIA documentation skill
collection without giving the model repository, shell, tracker, or credential access.
The source repository is pinned at
`cd137182a53a5e3b5cb0d01e1b224aa9bf1cf3c8`. A branch name is never an
acceptable substitute.

Each runtime directory contains two distinct layers:

- `SKILL.md` and `MAPPING.md` are DocsFab-authored, read-only adapters. The
  model auto-loads the adapter, not the upstream operational instructions.
- `upstream/` contains byte-for-byte source material from the immutable pin.
  It provides domain reasoning and evidence but its scripts are non-executable
  and its operational commands cannot override the adapter.

`governed-assets/lock.json` verifies the exact upstream file sets and source
identity. These adapters are parked and are not entries in the production
catalog skill crate. Their retained composite contract fixture binds source
paths, revisions, interfaces, policy, adaptation, and mapping.
Every `inputs[]` and `outputs[]` entry is a closed `{name, description}`
record. Command, argument, environment, tool, or other added keys fail before
contract hashing. All free strings in both locks and durable pack evidence,
including IDs, interface descriptions, and license declarations, pass the
same canonical detectors as DocsFab's repository scanner. That includes AWS,
Google, GitHub, GitLab, Slack, OpenAI, NVIDIA, OAuth, JWT, assigned-secret, and
private-key families; errors expose stable codes only and never echo a match.

Durable evidence is not accepted from shape alone. The decoder requires the
exact nonempty upstream-bundle set mapped to the named adapter, binds adaptation
version and digest to the skill, recomputes the canonical composite digest, and
compares it to the reviewed four-ID contract table. Empty bundles, substituted
IDs, changed mapping digests, and self-consistent but unreviewed contract hashes
fail closed. Historical non-roadmap evidence remains readable but cannot be
promoted into a roadmap pack.

## Selected source files

| Pack | Upstream version | Minimum complete source set |
| --- | --- | --- |
| `release-docs-epic` | `1.0.1` | `SKILL.md`, epic and subtask templates, four phase references, checklist, PR enumeration script, and disposition reconciler |
| `doc-fix-issues` | `2.0` | `SKILL.md`, checklist, and fetch/classify, report/select, and execute/report references |
| `doc-session-insights` | `2.0` | `SKILL.md`, checklist, open-issues and output/dedup references, and backlog issue script; only `--open-issues` is supported |
| `doc-pr-auto-sync` | `1.0` | `SKILL.md`; named operational scripts are in the shared-helper evidence bundles |

The shared helper evidence includes `checklist.py`, `path_normalize.py`,
`git_platform.py`, `resolve_release_range.py`, `skill_record.py`,
`set_mode.py`, `pr_sync_preflight.py`,
`sync_mr_checklist.py`, and `pr_sync_finalize.py`.

Benchmarks, evaluation corpora, package signatures, scripts README files, and
the session-insights report/improve paths are excluded because they do not
participate in the scoped runtime capability. `set_mode.py` has transitive
imports from another internal repository that are not included: all imported scripts are
evidence-only. Executing one later requires a separately reviewed, fully
provenance-locked host adapter and dependency closure.

`save_execute.py` was removed from this bundle and is no longer part of the
shipped evidence set or the npm tarball. It was evidence-only and never
executed by any DocsFab entry point; it was dropped rather than patched in
place because editing it would have made the lock's byte-for-byte provenance
claim for the pinned upstream revision false. The upstream repair remains a
tracked follow-up; re-import at a repaired revision will decide whether the
script ships again.

## License declarations

The upstream repository does not contain a root `LICENSE` file. Its root
`README.md` says the repository is provided under the NVIDIA Source Code
License, while each selected skill declares `Apache-2.0` in its own
frontmatter. At the pinned revision, two shared helpers (`checklist.py` and
`set_mode.py`) carry file-level Apache-2.0 SPDX declarations; the other
selected helpers carry no file-level license identifier.

The lock records declarations:

- each skill-local bundle uses its own `SKILL.md` frontmatter declaration;
- the two SPDX-tagged helpers are in the `roadmap-helpers-apache` bundle;
- the remaining helpers are in the `roadmap-helpers-repository-license`
  bundle. That bundle first recorded the upstream `NVIDIA Source Code License`
  wording. NVIDIA, which owns the helpers, relicensed them under Apache-2.0
  with the consent of their authors. Each helper now carries an
  `SPDX-License-Identifier: Apache-2.0` header, and the bundle is pinned as
  version `cd137182-scrubbed.2` with license `Apache-2.0`.

Both bundles now declare Apache-2.0. They stay separate because the
`release-docs-epic` contract digest and the pre-removal attestations of the
other three packs name each bundle by id. Merging them would change those
contracts without adding license evidence. The bundle id
`roadmap-helpers-repository-license` is historical.

## Behavior mapping

### Release roadmap

Reuse complete first-parent accounting, the four documentation dispositions,
ship-status separation, workstream clustering, adversarial review, cold-start
children, deduplication, and supplemental sweeps. Repository and tracker reads
become typed observations. Tracker effects become a #45 mutation plan and a
non-authorizing request. #46 owns planning, #47 owns apply, and #48 owns
burn-down.

### Issue burn-down

Reuse fixability, severity, effort, evidence, selection, dependency, collision,
and one-issue-per-delivery reasoning. An exact operator selection is required.
Replace checkout, pull, commit, push, and merge-request creation with a
`deliver-roadmap-child` request for #48 and the #37 publisher. The selected
source checkout is never modified.

### Open-issues lifecycle

Reuse deduplication and the observed-to-filed-to-fixed-to-verified-to-closed
lifecycle. The roadmap ledger replaces the upstream memory store and local reports. Report and
improve modes are unsupported. The upstream `--auto` convention is explicitly
rejected; every write batch requires exact authorization.

### Merge-request description synchronization

Reuse default-off activation, staleness, incremental scope reconciliation,
checklists, rebase handling, and ambiguity gates. Activation becomes exact
run-scoped authorization. Observation and update are typed host requests. The
#45 issue-operation contract does not authorize merge-request descriptions, so
execution remains deferred until a dedicated adapter exists.

## Host-operation requests

`RoadmapHostOperationRequest` is closed to five operations:

- `observe-repository-history`;
- `observe-tracker`;
- `apply-roadmap-mutation`;
- `deliver-roadmap-child`;
- `update-merge-request-description`.

Requests contain only content-free pack, repository, ledger, plan,
authorization, observation, and payload digests. Write variants always carry
`explicit-authorization-required`. The validator rejects unknown fields,
command arguments, environments, credentials, operation expansion,
confirmation bypass, and digest drift. A request is data, never authority or
proof that an effect occurred.

Request pack identity is closed to `release-docs-epic`, `doc-fix-issues`,
`doc-session-insights`, and `doc-pr-auto-sync`. A similarly shaped request for
another skill ID is invalid. The `contractSha256` must also equal the exact
reviewed contract registered for that pack; a different well-formed SHA-256 is
not an alternative pack identity.

## Updating the imports

1. Select and review a full immutable source revision.
2. Resolve license declarations without assuming a branch or repository-wide
   default overrides file-level evidence.
3. Copy selected upstream files byte-for-byte and keep scripts non-executable.
4. Update both asset provenance digests and skill composite digests.
5. Review every upstream behavior difference in `MAPPING.md`.
6. Run tamper, tool-boundary, run-record, full check, and build verification.
