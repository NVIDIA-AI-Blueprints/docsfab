# Study events

`--study` writes a payload-free `StudyEventV1` sibling log next to the run
record. It is not a RunRecord field and does not reopen POR-D09: prompts, tool
JSON, file bytes, host paths, and credentials stay out of the event. Default
CLI emits zero study events and does not create a study directory.

Join key is the existing `runId`. The host records one event per confined tool
**settlement**, not per model token. `scheduled: true` is a catalog or required
observation probe; `scheduled: false` is an extra model-initiated read.

## Event body

Closed fields: `t`, `runId`, `workflow`, `stepId`, optional `probeId`, `tool`,
exactly one of `targetNodeId` or `pathClass`, `disposition`, `durationMs`,
`scheduled`. Path class is a closed enum from path rules
(`instruction-file`, `product-page`, `api-ref`, `working-note`, `other`), never
an LLM. A prompt-like string or forbidden payload key fails the run.

## Study run

Each study run also records `observationMode`
(`corpus` | `talk-tree` | `talk-tree+required-probes`) and `modelRef`
(`provider` plus the catalog id from the operator profile). `modelRef` is never
inferred from prose. Unpublished catalog ids are not announced as GA.

The study directory uses the same owner-only `0700` policy as raw run records.
Files are `0600`.

## CLI plane

`--study` is opt-in on `docsfab do` and `docsfab run`. `--json` still wins over
the human footer. When `--study` is on, the STUDY plane prints
`STUDY scheduled=… extra=…` then `NEXT docsfab study show <runId>`. The
`study show|diff|campaign` subcommands are a sibling Task.
