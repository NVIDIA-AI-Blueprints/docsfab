# Quality evaluation

This directory is runtime acceptance and corpus evaluation of workflow run
records. It is not Pin C document-quality evaluation.

The harness corpus here grades saved runs with structural assertions and
advisory semantic scoring (`SEMANTIC_RUBRIC_V1`). It does not own
documentation-quality policy, quality-pack Pin C bar ids, or operator-facing
document-quality reports.

Those live elsewhere:

- [`evaluation-report/`](../evaluation-report/) projects and stages
  document-quality reports from runs.
- [`packages/quality`](../../../quality/README.md) owns production quality
  policy, rubrics, schemas, and Pin C bar ids.

Do not merge this module with `evaluation-report`. Keep the directory name and
existing wire IDs unchanged.

Start with the [runtime source map](../README.md).
