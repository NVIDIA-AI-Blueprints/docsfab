{/* GENERATED:artifact-and-run-record-settings start - run `npm run generate:limits` from packages/runtime to refresh; do not hand-edit between these markers */}
| Setting | Default | Behavior |
| --- | --- | --- |
| `DOCSFAB_ARTIFACTS_MAX_OBJECT_BYTES` | 134,217,728 bytes (128 MiB) | Largest single object the durable artifact store writes or reads, locally and in hosted editorial evidence retention. A larger content index is stored in parts instead of being refused. |
| `DOCSFAB_RUNS_RECORD_MAX_BYTES` | 67,108,864 bytes (64 MiB) | Largest saved run record any DocsFab reader loads, such as `docsfab runs list`, `docsfab why`, publication preflight, and the live agent's saved-run tool. |
| `DOCSFAB_ARTIFACTS_HOSTED_RETENTION_MAX_OBJECTS` | 16,384 objects | Objects one hosted editorial attempt may retain in project CAS. |
| `DOCSFAB_ARTIFACTS_HOSTED_RETENTION_MAX_TOTAL_BYTES` | 1,073,741,824 bytes (1 GiB) | Bytes one hosted editorial attempt may retain in project CAS, summed over its objects. |
| `DOCSFAB_ARTIFACTS_HOSTED_RETENTION_MANIFEST_MAX_BYTES` | 8,388,608 bytes (8 MiB) | Manifest that lists one hosted editorial attempt's retained objects. |
{/* GENERATED:artifact-and-run-record-settings end */}
