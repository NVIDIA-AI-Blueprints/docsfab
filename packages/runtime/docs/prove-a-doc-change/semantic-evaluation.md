# Semantic evaluation

DocsFab evaluates run records in two layers. Versioned structural assertions
remain the deterministic result and always run first. Semantic grading is an
opt-in advisory result; judge disagreement and judge errors are recorded but do
not replace or erase the structural result.

The rubric identity is `docsfab.semantic-evidence-quality@1`. Every judge result
records that identity plus the separately configured judge provider and model.
When structural assertions fail, DocsFab records `skipped` and never invokes the
judge.

## Evidence boundary

The judge receives only fixture identity, immutable revision, workflow and step
status, step/skill identity, minimized step summaries, tool names, governed skill
hashes, content-free scan rule IDs, and change-status metadata. It does not
receive source paths, requested revisions, requester instructions, policy-model
identity, tool arguments/results, finding paths, changed-file paths, patch
locations/content, credentials, or raw model transcripts.

Credential-like summary text is replaced as a whole. Host-looking paths and
control characters are removed, and free text is bounded before inference.
Judge failures collapse to a stable reason; provider error details are not
retained. Judge rationale is bounded and passes through the same controls.

## Opt-in live smoke

Normal tests use a deterministic fake judge and make no network call. A live
smoke requires all three operator actions:

1. Configure the independent `JUDGE_*` endpoint and set `JUDGE_ENABLED=true`.
2. Set `DOCSFAB_LIVE_JUDGE_SMOKE=true`.
3. Set `DOCSFAB_LIVE_JUDGE_RESULT` to a new result path, then run
   `npm run smoke:judge`.

The test refuses to overwrite an existing result and creates the result with
owner-only permissions. The stored JSON contains only fixture identity,
structural disposition/count, rubric and judge-model identity, semantic status,
score, and minimized rationale. It contains neither the prompt nor the model's
raw response.
