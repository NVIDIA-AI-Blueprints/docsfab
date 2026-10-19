---
title: Run a Live-Agent Task Noninteractively
---

Use task mode to run one scoped documentation request without a terminal. The host supplies an isolated Git checkout, a private model configuration, and a versioned task file. The task file narrows the host's write grant. It cannot authorize additional files, shell commands, or publication.

## Prepare the Host

Check out the task's exact baseline revision on a writable task branch. The checkout needs its own writable `.git` directory. Provide private `DOCSFAB_CONFIG_ROOT` and `DOCSFAB_STATE_DIR` locations. If the task names prepared local sources, mount a host-selected input directory and set `DOCSFAB_TASK_INPUT_DIR` to it. That directory contains `prepared-sources.json` and the immutable files under `prepared-sources/<sourceId>/`.

Keep the task file, result directory, private configuration, state, and prepared sources outside the workspace. Keep `DOCSFAB_STATE_DIR` separate from the result directory. DocsFab creates a fresh private session and agent directory beneath the host's state directory for each attempt; `--result-dir` holds only the public task export. The prepared workspace must contain regular files only; symbolic links and special entries are refused. Its baseline digest covers every regular file, including hidden and untracked files, and excludes only the root `.git` entry. To calculate it, sort relative POSIX paths by UTF-8 bytes, make one `{path,byteLength,sha256}` entry per file using bare SHA-256 hex, then hash the canonical JSON object `{schemaVersion:1,kind:"docsfab-repository-baseline",files:[...]}`. The task's revision and byte digest must both match before model work begins.

The task request uses the `docsfab-live-agent-task-request` version 1 schema. It contains a byte-bound prompt, baseline identity, exact requested paths, documentation roots, source references, required evidence IDs, and effective configuration identity. Prepare and validate these values outside the agent. The request does not create a host grant.

The effective configuration records the loaded profile and model, plus `values.taskProviderTurns`. DocsFab resolves this whole-task physical provider-request allowance from `liveAgent.taskProviderTurns` (default 32,768) and the operator's supported override before it compares the request digest. Parent turns and bounded workflow calls share it. The default comes from a synthetic two-workflow capacity calculation, not a measured cost or token budget; usage fields stay unavailable when complete usage is not observed.

## Run the Task

Run the command from an installed DocsFab package:

```bash
docsfab live-agent \
  --repo /workspace \
  --task-file /inputs/task.json \
  --result-dir /outputs/attempt \
  --docs-dir docs \
  --docs-file README.md \
  --allow-write \
  --json
```

Omit `--allow-write` for a read-only task. Repeat `--docs-dir` for host-granted directories and `--docs-file` for individually granted, tracked documentation files. Every requested path needs one of these grants, even when it sits under the default `docs/` directory. A requested subdirectory includes its descendants when the host grants a containing directory; a requested file remains exact. A request for documentation writes also needs `--allow-write`. Task mode starts a fresh session and does not ask setup or approval questions. If configuration, source data, scope, or checkout prerequisites are missing, it writes a typed `needs-input` or refusal result before a provider turn. An unsafe result directory is rejected before any export is written there.

## Inspect the Result

The command prints one JSON summary with `exportPath`, `exportSha256`, `executionStatus`, and `agentDecision`. The export at `exportPath` binds the original request to the result and retains partial artifacts when execution stops. Inspect `executionStatus`, the typed agent decision, evidence availability, checks, diff, usage, and trace separately. The diff compares all regular workspace files with the admitted baseline, including ignored pages; an unreadable or unsupported entry leaves the diff unavailable and retains proven partial artifacts. A verified prepared source receives an available evidence row under its exact source ID and content digest. If a source ID collides with a generated diff or child result ID, DocsFab assigns a distinct ID to the generated evidence. Other requested evidence remains missing until DocsFab can substantiate it. `unavailable` trace or usage means DocsFab did not collect complete evidence. A no-change decision needs an explicit agent declaration and supporting evidence; an empty diff alone is insufficient.

The public activity JSON Lines file beside the export uses `schemaVersion: 2`. Its header inventories the actual parent and delegated sessions, provider routes, and child workflow scopes. Events bind native tool calls, physical provider requests, source reads, skill loads, and checkout patch outcomes to those scopes. A completed child scope names the saved run record and its SHA-256 digest only when the saved snapshot is available. Otherwise, the pair is null and child coverage stays partial. `nativeChildRecords` in the export uses the same saved snapshot. The activity includes hashes and byte counts, not prompts, source text, tool results, or provider response bodies. Inspect the footer's per-category coverage and missing reasons before treating a trace as complete. A stopped or unsupported child can retain a decodable partial trace without proving its inner actions.

On SIGINT or SIGTERM, the command cancels the active session, waits for its effects to drain, and exports retained partial artifacts before exiting. A host that forcibly terminates the process may have no export. A whole-task provider-request limit refusal names the bound and observed count in the result.

Review workspace changes before committing or publishing. Task mode does not commit or publish them.
