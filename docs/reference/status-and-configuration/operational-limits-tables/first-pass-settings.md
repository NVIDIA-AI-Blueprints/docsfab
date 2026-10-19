{/* GENERATED:first-pass-settings start - run `npm run generate:limits` from packages/runtime to refresh; do not hand-edit between these markers */}
| Setting | Default | Behavior |
| --- | --- | --- |
| `DOCSFAB_FIRST_PASS_MAX_SCANNED_FILES` | 100,000 files | Tracked files first pass lists, ranks, and matches against the paths a request names. Listing a file reads none of its bytes. |
| `DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES` | 448 files | Repository files whose evidence first pass offers the model, across all rounds. Sources the request names are read first. |
| `DOCSFAB_FIRST_PASS_MAX_FILE_BYTES` | 4,194,304 bytes (4 MiB) | Largest single file first pass reads unless the request names it. A larger unnamed file is not read, and the record names the bound. |
| `DOCSFAB_FIRST_PASS_MAX_TOTAL_READ_BYTES` | 67,108,864 bytes (64 MiB) | Repository bytes one first pass reads across all rounds. |
| `DOCSFAB_FIRST_PASS_MAX_SPANS` | 2,048 spans | Evidence spans one first pass offers the model. |
| `DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE` | 0.75 (three quarters of the input window) | Share of the model's input window, after its context reserve, that one first-pass assessment prompt may fill at three bytes per token. |
| `DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES` | 4,194,304 bytes (4 MiB) | Ceiling on the bytes of one first-pass assessment prompt, every evidence frame included. The model's input window sets the prompt below it. |
| `DOCSFAB_FIRST_PASS_EVIDENCE_EXPANSION_MODEL_TURNS` | 6 rounds | Evidence-expansion assessments after the first one. Each reads more sources for the obligations still unresolved, and runs only while the previous round left fewer of them open or an open one names a file not yet read. |
| `DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN` | 1,050,000 tokens | Cumulative first-pass input budget per budgeted model turn, and a cap on one assessment prompt. The model profile's input limit caps each turn's share. |
| `DOCSFAB_FIRST_PASS_MODEL_OUTPUT_TOKENS_PER_TURN` | 4,096 tokens | The first-pass response bound for one model answer, and the cumulative output budget per budgeted model turn. |
| `DOCSFAB_FIRST_PASS_READ_DEADLINE_MS` | 120,000 ms (2 minutes) | Wall clock first pass may spend listing, reading, and screening repository files, apart from model time. |
| `DOCSFAB_FIRST_PASS_MODEL_DEADLINE_MS` | 1,800,000 ms (30 minutes) | Wall clock for all first-pass model calls. A composition with a shorter attempt timer still applies it. |
{/* GENERATED:first-pass-settings end */}
