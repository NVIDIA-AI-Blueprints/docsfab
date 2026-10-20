# Governed repository discovery inventory

DocsFab produces repository discovery evidence on the host before a workflow asks a model to inspect a repository. The inventory is bound to one immutable Git revision and a workspace snapshot digest. It is built only from the active disposable workspace capability. It cannot enumerate the requester's checkout directly. Do not mint a fake Git id for a dirty export. After an authorized in-run write, authenticated patch paths are recaptured into snapshot N+1 so later search can read them. Unexpected dirty paths still quarantine as `tracked-file-changed`.

## Boundary

The host admits the full tracked tree from the selected revision. Ignored and untracked files are absent from the export. Credential-bearing tracked paths excluded by workspace policy are counted but their names do not enter evidence. Tracked symlinks and submodules are indexed as structure but never followed. After all content and metadata indexing, the host revalidates every tracked entry—including binaries and files skipped by content policy—against the captured export identity. Regular files must retain type, direct real path, device, inode, link count, size, mode, and timestamps; deliberately non-materialized entries must remain absent. Deletion, replacement, mode/type changes, and other final structural races quarantine the changed path from file, document, literal-text, metadata, instruction, and navigation evidence, and mark all affected coverage incomplete. A probe aimed at a quarantined path therefore returns typed incompleteness with no positive evidence; an earlier snapshot match never takes precedence. Any exclusion, symlink, submodule, entry or byte ceiling, unreadable file, race, unsupported document format, invalid package manifest, invalid UTF-8 input, or incomplete Content IR build marks every affected coverage domain incomplete.

Coverage is not one ambiguous Boolean. The artifact declares four independent, content-addressed domains: `tracked-tree-v1`, `tracked-regular-utf8-v1`, `content-ir-graph-v2`, and `repository-metadata-v1`. Each records indexed, policy-excluded, and omitted counts. Filename, exact-path, and path-segment probes use the tracked-tree index, not the documentation subset. Literal search covers every tracked regular file admitted as UTF-8, subject to the declared `repository.inventoryTextMaxFileBytes` (8 MiB) per-file and `repository.inventoryTextMaxTotalBytes` (512 MiB) aggregate limits, which a host can raise. A file past either limit is never read whole; only its first 8,000 bytes are read, to tell binary content from text. The inventory records a text file past a limit by path as `text-index-limit-exceeded` with the limit and the observed value, and governed search records one LIMITATIONS line per limit with the number of files left out, plus one line that counts and samples files left out because they are not UTF-8 text, including any file that starts with a UTF-16 byte order mark. Known binary extensions, including video and audio, and any file with a NUL byte in its first 8,000 bytes (Git's binary heuristic) are explicit policy exclusions and make text coverage incomplete, preventing claims about absent text. Any coverage gap can yield a positive match, but it can never authorize absence in its affected domain.

The durable inventory contains structure and identities, not repository text:

- every disclosed tracked path, entry kind, size, and stable evidence identity;
- documentation paths, hierarchy, format, and public/internal candidate classification;
- a separate Content IR navigation artifact with graph and navigation-edge counts and source paths;
- site-generator, CI, dependency, and configuration signals;
- canonical package-manager invocations such as `npm run docs:build`, derived from safe script names without retaining script bodies;
- instruction-file paths and their repository-relative scopes;
- closed failure categories and content-addressed evidence identities.

Host paths, repository contents, secret values, arbitrary commands, unrestricted globs, and unrestricted paths are not valid inventory fields.

Fern navigation evidence supports both inline `navigation:` in `fern/docs.yml`
and a `versions:` index that references separate navigation files. Each route
binds the exact tracked navigation source and target bytes at the selected Git
revision. Inline navigation is recorded as `fern-yaml-v1`; version indexes retain
`fern-versioned-yaml-v1`. Missing or changed targets, symlinks, path traversal,
YAML aliases, and conflicting routes produce incomplete evidence. A file that
combines `navigation:` and `versions:` is rejected as ambiguous.

## Bounded batch probes

A batch contains at most 32 typed questions. Supported questions cover exact filenames, exact repository-relative paths, path segments, bounded literal-text matches over admitted text inputs, and closed metadata fields. Literal questions are compared as text and are never evaluated as regular expressions, globs, or shell. Requests and questions have exact closed shapes; extra command, shell, absolute-path, glob, or control-character fields are rejected. A mixed batch retains supported answers and returns a typed `unsupported` result for each declared unsupported operation.

Each result binds the full question kind and parameters by request digest. The outer artifact binds the exact ordered request set. The public shape decoder checks inert data, closed fields, and internal hashes only and is explicitly not authority. Authoritative validation independently replays the expected ordered requests against the authentic in-process host inventory, compares exact result bytes, and verifies evidence-ID-to-path mappings. Rehashing a substituted request, path, result, inventory, or order therefore does not create valid evidence.

`not-found-after-bounded-search` is valid only when the relevant coverage domain is complete. An absent match against incomplete structure, text, navigation, or metadata is `incomplete` with the corresponding typed failure. Documentation existence and navigation are separate questions: navigation evidence comes only from actual Content IR graph edges, so documentation files alone cannot support a navigation match. Semantic rubric assessment remains explicitly unsupported.

The production local workflow search coordinator receives the active repository workspace from the CLI and delivery acceptance harness. It creates one inventory for a search step and batches the step's supported discovery probes against it. Existing #71 progress and #74 gap-ledger evidence retain the batch evidence identity without retaining inventory contents.

## Evaluation

The known-answer runner loads a versioned fixture source pinned in trusted harness code; callers cannot provide its requests, expected paths, ordering, or recall denominator. The loader binds that source to the exact inventory revision and search target, and the runner independently reconstructs the pinned fixture before execution. Removing, reordering, or substituting requests or answers remains invalid even if every public digest is recomputed. The runner executes the real authenticated inventory path once per request for the unbatched baseline and once for the batched arm. Tool calls, evidence digests, unique evidence, recall, serialized-byte token estimates, and monotonic latency are observed by the runner; callers cannot supply success metrics. The durable experiment record retains fixture-source, fixture, revision, target, request-set, and evidence digests rather than repository contents. Success requires fewer calls and recall of every pinned known answer in both arms.
