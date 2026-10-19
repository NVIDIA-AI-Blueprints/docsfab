---
title: Human Output and JSON in DocsFab
description: Choose human-readable or `--json` output for a DocsFab command and read its shape.
status: draft
---

This page explains when to choose human-readable output or `--json` output for a DocsFab command and how to read each shape. Refer to [Runtime CLI and Configuration in DocsFab](runtime-cli-and-configuration.md) for command groups, project configuration, and the rest of the CLI reference. For more information, refer to [DocsFab Status and Configuration Reference](index.md).

## Human Output and `--json`

`--json` is the agent and machine surface. Agents and scripts must consume
that object; they must not scrape the human footer. Human `--quiet` /
default / `--verbose` shapes do not apply to the JSON object.

Unknown commands, duplicated flags, and doctor, test, profile, or init
option errors use operator envelope code `cli-usage`. The next action is
`docsfab --help` (or `docsfab init --help` for init-only option errors).
For the envelope fields, refer to
[DocsFab Operator Error Envelope](operator-error-envelope.md).

`docsfab live-agent` is a terminal conversation rather than a JSON or
subprocess interface. It requires an interactive terminal and does not accept
`--json`.

On `docsfab do` and `docsfab run`, a live `--json` run writes one
`RunResultV1` object to stdout. The sealed kind is `docsfab-run-result`
(not a predecessor product name). `docsfab do --json --route-only`
writes a `docsfab-outcome-route` envelope instead. Lookup commands such as
`doctor`, `composition list`, and `runs show` emit that command's own
canonical record under `--json`; that record is still the machine surface
for that command.

## Advanced Command Results

Advanced commands use the same human result layout for outcomes, proposed effects, retained evidence, and recovery. Their existing machine records remain authoritative. Do not parse the human text in a script.

The following table describes the current disposition of each advanced command.

| Command | Disposition | Human result and machine surface |
| --- | --- | --- |
| `docsfab evaluate` | Development-only, human result | Shows structural assertions and the advisory judge separately. It does not add a `--json` mode. |
| `docsfab auto --dry-run` | Migrated read-only preview | Shows proposed operations, missing input, validation, and the next action. `--json` retains the dry-run record. |
| `docsfab auto --once` | Migrated result | An unconfirmed proposal performs no write. A confirmed cycle shows its saved disposition, run, validation, and publication eligibility. The confirmed `--json` path retains the saved cycle record. |
| `docsfab auto --publish` | Migrated result | An unconfirmed proposal performs no write. A confirmed cycle shows the publication outcome, retained patch evidence, and recovery when deferred. The confirmed `--json` path retains its publication envelope. |
| `docsfab multi-unit-campaign` | Migrated dry-run result | Shows the stop reason, processed units, retained progress digest, and unchanged source checkout. Write mode remains unavailable. `--json` retains the campaign record. |
| `docsfab roadmap-issues preflight` and `apply` | Migrated result | Preflight shows proposed effects without authorizing a write. Apply shows the receipt, remaining operation keys, and next safe action. `--json` retains each command's canonical record. |
| `docsfab ia` and `docsfab roadmap-plan` | Reserved | The router keeps these commands unavailable. This output change does not enable them. |

`auto --once` and `auto --publish` preserve their existing proposal and missing-input text when you request `--json` before confirmation. They do not invent a machine record for a cycle that has not run. You must still provide the existing confirmation and authority inputs before either command can write.

For `docsfab runs show`, `execution.exitCode` projects the saved run under the
current CLI policy. It is not a stored copy of the original process exit code.
A saved, step-free `needs-input` run with a verified request-intent question
projects exit code `2` in both human and JSON output. The command also exits
with code `2` for that record.
A saved planner `needs-input` stop with an admitted diagnostic for missing
governed input also projects and exits with code `2`. A saved `needs-input`
execution with a validated current workflow outcome also projects and exits
with code `2`, including verification-stage input stops. A successful execution
with a `needs-input` product disposition keeps the interactive exit code `0`.
Legacy records without admitted input-stop evidence retain their existing
projection. Inspection preserves the saved record. An execution, checkout, or
quality report failure takes precedence and projects exit code `1`.

When a run flags credential-like content, `docsfab run --json` and
`docsfab runs show <run-id> --json` include an optional `credentialFindings`
array. Each entry contains only `code`, `location`, and `rule`. The output
never includes matched text or surrounding snippets. Runs without findings
omit this field. The result digest covers the findings, including when
initial JSON also carries work-unit machine contracts.

Saved human and JSON views redact finding locations against the current
configured credentials and escape characters that could alter a terminal
line. Replay preserves the saved record and its original location bound.
The safe display representation can grow when characters are escaped; human
and JSON inspection preserve that representation without cutting it again.
These heuristic findings remain informational. Exact configured credentials
still fail closed; a metadata value that cannot be shown safely stops with
`credential-material` and an inspection action. Refer to
[Credential-Like Content](../security-and-trust.md#credential-like-content).

`docsfab profile inspect` defaults to a concise plain-language summary. It
reports the standing `host.yaml` configuration, not automatically the
new-host dogfood model. The summary includes the active model, provider
route, bound execution profile id when `host.yaml` selected one, readiness
and fallback status, effective limits, catalog-check status, and an
actionable next step. Use
`docsfab profile inspect --verbose` for field-level audit details, reasons,
remediation, and the evidence digest. Use `--json` when an agent, script, or
approval workflow needs the canonical inspection record.

`docsfab setup` also uses a concise default. It reports completion or needed
attention, model and endpoint selection, the bound execution profile id when
`setup --profile` selected one, the effective context limit, hidden
credential handling, configuration location, connection-check status, and the
next command. Use
`docsfab setup --verbose` for layout, profile-path, materialization, and
effective-limit diagnostics. Use `docsfab setup --json` for the canonical
machine-readable bootstrap result. The `--verbose` and `--json` options cannot
be combined.

`docsfab doctor` defaults to a compact selected-use result with the repository
scope, material attention, and one primary next action. Use `--quiet` to keep
that result without the detail pointer. Use `--verbose` to show supporting
repository, check, connectivity, model, retry, resource, and local-storage
evidence. The verbose view uses facts collected by the current invocation and
does not start another live probe. `--quiet --json` emits the same canonical
readiness record as `--json`; `--verbose --json` and `--quiet --verbose` are
option errors.

Use `docsfab config inspect` before setup or a live job when you need to know
which host paths DocsFab will use:

```bash
docsfab config inspect
docsfab config inspect --json
```

The command reports each effective path, its source and precedence, and its
existence, readability, and writability. Installed composition selections have
separate status and provenance for their model and policy presets. Operator
settings can override those presets; the report does not load override values
from credential files. A missing legacy
`profiles/` directory remains `missing` with `exists: false`, but is optional when
no selected YAML profile needs it.

The inspection checks profile selection only. It does not establish endpoint or
credential readiness. It reads the non-secret `host.yaml` manifest, the installed
composition registry, and selected legacy YAML profiles to validate their schemas
and policy or judge slots. Legacy reads require a canonical target inside `profiles/`
and a stable file and parent path. Escaping links or a substituted file are invalid.
It does not enumerate the environment, open `.env` or
`secrets.env`, create missing directories, contact a provider or SCM service, or
require a TTY. Required missing, malformed, or inaccessible paths and unresolved
composition selections include an exact `NEXT` action such as `docsfab setup` or
`docsfab doctor`.

Configuration, profile, composition, and source inspections use typed facts
projected by the shared terminal presentation layer. Default output keeps the
requested subject, status, material limitations, effects, and recovery action
together; profile `--verbose` adds audit detail without changing the inspection
or making another provider request. A live probe remains an explicit operation
and is not started by formatting its result. Source purge previews keep the
exact confirmation and withheld-row coverage visible, while receipts report
the custody record and retention statement. If a purge stops after deleting some
copies, its refusal names the deletion and custody record. Its unchanged
Selection row describes attachments, not copies that were removed. `docsfab sources refresh` records
current file versions only for files it can read; an unreadable source keeps
any previously recorded version and is reported separately. Immutable merged
changes require no new read.

These human projections do not replace command JSON. `--json` continues to use
each command's canonical machine record, with its existing schema and
authority semantics. Static usage text also stays in the command help surface.

For a new interactive configuration, setup offers `openai` first and asks
for a model ID. Use arrow keys and Enter to select the provider and OpenAI API.
Choose `openai-compatible` for a custom Chat Completions or
Responses server, or `anthropic-compatible` for a custom Messages server.
The direct `openai` and `anthropic` choices supply their official base URLs.
Anthropic endpoints accept a base URL with or without a trailing `/v1`.
Setup displays the final request URL, including the path for the selected API.
Refer to [Configure the Model](../../configure/model.md)
for defaults, credential variable names, and examples. The following table lists the setup options.

The following table describes each setup option.

| Setup option | Behavior |
| --- | --- |
| `--provider` | `openai`, `openai-compatible`, `anthropic`, or `anthropic-compatible`. |
| `--model` | The provider's model ID. Required without a terminal. |
| `--endpoint` | HTTPS base URL, or a plain `http://` URL whose host is `localhost`, `127.0.0.1` (or another `127.0.0.0/8` address), or `[::1]`. Required for compatible providers without a terminal. |
| `--api` | `openai-chat-completions`, `openai-responses`, or `anthropic-messages`; must match the provider family. |

The last three options require `--provider`. Provider options cannot be
combined with `--profile`, `--preset`, or `--migrate`. Non-interactive setup
with an explicit provider requires its named key in the invocation's
environment. DocsFab has no default model: bare non-interactive setup on a
host with no model selection stops with envelope code
`setup-model-choice-required` and writes nothing. A host that already has a
model selection keeps it.

New YAML model profiles include `transport` and `credentialEnv` alongside
`provider`, `baseUrl`, and `modelId`. Their environment equivalents are
`MODEL_TRANSPORT` and `MODEL_CREDENTIAL_ENV` (`JUDGE_TRANSPORT` and
`JUDGE_CREDENTIAL_ENV` for the judge). A credential reference stores only
the variable name. Its value stays in `secrets.env` or the host environment;
a missing selected key cannot fall back to another provider's key.
Legacy profiles without these fields retain their existing binding behavior.

When provider, endpoint, model ID, and selected API uniquely match an
installed composition, runtime commands bind that composition's request
policy and operational limits. Setup writes a 32,768-token context window
and a 16,384-token output allowance for an unmatched model, from
`modelProfile.conservativeFallbackContextWindow` and
`modelProfile.conservativeFallbackMaxOutputTokens`. The provider still
enforces its own window. When an installed composition measured a reasoning
control for the same model ID, an unmatched endpoint that serves that model
receives the control, and `docsfab doctor` prints it as
`Reasoning control:`. Configuring a protocol does not qualify a model for
documentation work.

Use `docsfab setup --profile <compositionId>` with an ID from
`docsfab composition list` to name an installed writing profile in `host.yaml`.
Host config can name independent `active.writing` and `active.judge`
composition IDs. Judge qualification stays `not-run` until a later campaign
and does not block ordinary writing. DocsFab does not swap compositions
during a run. Selecting a provider replaces the writing selection and leaves
the judge selection in place. `--preset` remains a YAML migration path.
If a saved model selection stops with `composition-retired`, follow
[Model Selection Is No Longer Supported](../../troubleshooting.md#model-selection-is-no-longer-supported).

```json
{
  "schemaVersion": 1,
  "kind": "docsfab-run-result",
  "execution": {
    "runId": "run-review-1",
    "workflow": "review-documentation",
    "status": "succeeded",
    "exitCode": 0,
    "repository": {
      "path": "/absolute/path/to/repository",
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "recordPath": "/private/run-record/path",
    "patchPath": null,
    "patchSha256": null,
    "docChangeDelta": null,
    "durationMs": 1200
  },
  "product": {
    "disposition": "inconclusive",
    "findings": ["review-required"],
    "limitations": [
      "review-findings-artifact-unavailable:evaluate-document-quality:no-binding",
      "review-method-static-read-only",
      "package-command-checks-not-executed",
      "human-audience-evidence-unavailable",
      "agent-audience-evidence-unavailable"
    ],
    "openDecisions": []
  },
  "quality": null,
  "reviewFindings": [
    {
      "id": "finding:verify-technical-accuracy:TECH-001:1",
      "severity": "error",
      "code": "TECH-001",
      "summary": "The command is incorrect.",
      "path": "docs/guide.md",
      "line": 12,
      "origin": "agent",
      "evidence": "source-1: docs/guide.md:12",
      "recommendation": "Update the affected documentation."
    }
  ],
  "reviewFindingsProjection": {
    "projector": "docsfab-review-findings-v2",
    "availability": "partial",
    "artifactLocator": null,
    "limitations": [
      "review-findings-artifact-unavailable:evaluate-document-quality:no-binding"
    ]
  },
  "htmlReport": null,
  "nextSteps": [
    "No admitted evaluation artifact was recorded. Inspect the readable report and run limitations; the evaluation producer owner must supply validated evidence before findings can be projected. Do not restore or rerun an artifact that never existed."
  ],
  "resultSha256": "0d4dc4b9853b57f45f957501f571ace7da440715e4f3b023fadaa70efda10c86"
}
```

An `update-documentation` result adds `keptUnchangedPages` when its admitted
plan kept at least one page unchanged (disposition `retain`). The field lists
the sorted repository-relative paths, and is absent when the plan kept no page.

Treat `product.findings` as workflow outcome codes. They do not contain the
detailed, path-bearing issues from review skills. For a review workflow,
`reviewFindings` contains admitted `ReviewFindingV1` objects and remains an
empty array when a verified projection finds no issues. Authoring JSON results
include `reviewFindings` when strict projection admits one or more technical or
editorial issues.

Each review finding always contains `id`, `severity`, `code`, `summary`, and
`path`. The `path` value can be `null` when the source does not provide a safe
relative path. A parsed source line adds `line`. The current sealed-skill
projector adds `origin: "agent"`, `evidence`, and `recommendation`; these fields
remain optional in the shared finding contract. Consume the fields that are
present instead of deriving findings from skill Markdown or the human footer.

The human result for review, create, update, and restructure workflows includes
a separate **REVIEW FINDINGS** section. It reports projection availability,
run-step provenance, the top admitted issues as sentences, and named
limitations. Issues are ranked by severity (`error`, then `warning`, then
`info`) and then by finding id. The catalog setting
`reviewFindings.summaryTopN` sets how many are printed, and
`docsfab doctor --limits` shows its value. When a run
admits more, the section prints `Findings shown: <shown> of <total>` and the
`docsfab runs show <run-id> --json` command that lists all of them. Limitations
that repeat once per finding, fact, or source locator are printed as one count
per family, for example `review-findings-duplicate: 17`, followed by the same
command. Every other limitation is printed once, in full. `--quiet` omits the
section; the **QUALITY** section, when present, then shows the finding count
and the limitations. The JSON result always carries every finding and every
limitation code. The section does not change an inconclusive
**PRODUCT** disposition and does not convert an unvalidated evaluator summary
into a quality artifact or decision.

Inspect `reviewFindingsProjection` before interpreting the array. Its
`availability` is `complete`, `partial`, `unavailable`, or `invalid`. It also
identifies the deterministic projector, the content-addressed evaluation
artifact when available, and the limitations that explain incomplete output.
An empty array establishes zero findings only when availability is `complete`.
Use `docsfab runs show <run-id> --json` to replay retained findings without
another model run.

The human `QUALITY` section and JSON `product.limitations` expose the same
retained review evidence. A `review-method-static-read-only` limitation records
that the admitted review steps used read-only tools.
`package-command-checks-not-executed` means no package command evidence exists;
host artifact validation does not substitute for those checks. A native
host-operation summary without typed command evidence yields
`review-method-not-established` and `package-command-checks-not-established`;
the summary is retained without being parsed into authority. Typed native-check
projection is not yet available. Audience
outcomes with `verified: true` remain `model-claimed-only` unless independent
host evidence exists. Missing human or agent audience outcomes are reported as
`*-audience-evidence-unavailable`.
An admitted `human-review` verdict appears as
`review-findings-human-review:<skill>`. Each safely named target with explicit
unverified technical coverage appears as
`review-findings-coverage-unverified:<skill>:<path>`. These limitations make an
otherwise empty projection partial; they do not become synthetic findings.

Recovery follows the recorded state. A known locator with a missing object can
be restored only as part of its matching known-good record and artifact set. A
missing installed schema requires runtime repair followed by local replay. An
invalid integrity or binding result requires a known-good set or a producer
fix; do not edit sealed evidence. When the record has no admitted evaluation
artifact, the producer owner must supply validated evidence because no artifact
exists to restore. A valid negative finding directs the operator to inspect the
evidence and obtain a separate write grant before repair, not to retry the
provider.

A run that has a retained record keeps the `schemaVersion: 1` and
`kind: "docsfab-run-result"` envelope even when an individual projected string
is truncated to 512 characters. The quality projection records a
`truncated-projection-field` limitation. If the retained quality report is
missing or malformed, the result remains a `docsfab-run-result`, sets `quality`
to `null`, and adds `quality-projection-unavailable` to `product.limitations`.
The actionable diagnostic is also added to `nextSteps`.

When first pass found no repository support for a mandatory obligation and
the run continued with the evidence it gathered, `product.limitations`
includes `first-pass-evidence-gaps`. `limitOverflow` lists its recorded lines,
which name each such obligation, how first pass ended, each bound it reached
with its host override, and each source the request named that a bound left
unread. Refer to
[Operational Limits in DocsFab](operational-limits.md).

When a write run kept its patch although a repository-required check could not
run, `product.limitations` includes `required-check-not-run`. Each recorded
limitation line, which names the command to run, is also added to `nextSteps`.
Refer to
[When a Required Check Cannot Run](../../workflows/update-documentation-beside-a-change.md#when-a-required-check-cannot-run).

`plannerDiagnostic` is another optional root field. It appears only when
DocsFab can strictly admit the planner's content-free diagnostic envelope.
`invalid-model-output` means the planner
response did not satisfy its structured contract; it does not establish that
the user omitted an answer. `missing-governed-input` means the instruction must
be amended with governed input before rerunning. The diagnostic includes only
its admitted code, response shape, and digest. It never includes rejected model
text, credentials, instructions, or private paths. Without a sealed outcome,
the code stays out of `product.findings`, and `product.limitations` includes
`structured-product-outcome-unavailable`. A sealed planner governed-input stop
reports `product.disposition: "needs-input"` and lists the same code once in
`product.findings`, beside `plannerDiagnostic.code`, for example
`ambiguous-scope` in both. Treat the two as one missing input: count
`product.findings`, and read `plannerDiagnostic` as the planner evidence behind
the finding.

The writer can stop an authoring run the same way. When DocsFab refuses an
`edit` or `write` call outside the approved documentation plan, the write step
stops for a new plan. A sealed stop reports `product.disposition:
"needs-input"` with the finding and open decision
`documentation-plan:writer-mutation-outside-plan`. The human summary adds a
`Plan scope stop` line with the step and the number of refused calls. The
`nextSteps` entry is a rerun template: amend the instruction so the plan
includes every path the change needs, or narrow the request so it no longer
needs that path. A tool call whose arguments do not match the tool's
parameters is recorded as `malformed-arguments`, not as a refused path, and
does not stop the step. When a later call to the same tool succeeds, the call
is recorded as `malformed-arguments-corrected` instead. The outcome checks do
not treat a corrected call as a material tool failure.

A model's tool call can also miss its target: an edit whose text does not
match the file, a read past the end of a file, or a directory where a file was
expected. The tool refuses the call before anything changes, and the run
records it as `recoverable-miss`. These misses, and any uncorrected
`malformed-arguments`, `unsupported-pattern`, or `citation-refused` calls, do
not fail a `not-ready` run. The run keeps its patch and product outcome, and
`product.limitations` and the `Product limitations` line include
`tool-misses-recorded`. A read-only step, such as the planner or a reviewer,
holds no edit or write tool, so the paths `read`, `grep`, `find`, `ls`, or
`get_section` refused for it, its calls to a tool it was not offered, and its
tool calls that failed inside the host, such as a `grep` over a file the host
cannot read, are recorded the same way. A `grep` pattern or glob that ripgrep
cannot parse is `unsupported-pattern` on any step, and the model is told how
to correct the call. On a write step, a tool defect, a refused path, or a call
to a tool the step was not offered still fails the product outcome. The run
summary and the JSON `failures` entry then name the refusal code, such as
`workflow-outcome-admission-execution-product-mismatch`, and keep the retained
patch path. NEXT names the step, the category it recorded, and the tools whose
calls failed, and asks you to review the retained patch before you use it.

The writer also stops the run when it changes no file while it holds the
repository's `AGENTS.md` or `CLAUDE.md` and its plan has a page to write. A
plan that retains every page never gets this stop. The write step stops with
`needs-input` instead of running the remaining steps, and the writer's prompt
asks it to reply in that case with the instruction it could not satisfy and
one question. A sealed stop
reports `product.disposition: "needs-input"` with the finding and open
decision `documentation-plan:writer-made-no-change`. The human summary prints
the writer's reply under PRODUCT and adds a `Writer no-change stop` line with
the step and the instruction file. The `nextSteps` entry is the same rerun
template: add the answer the writer asked for to the instruction, or amend
the instruction file. A writer that used its whole tool-call or provider-turn
allowance keeps its execution-limit failure. Without an instruction file, a
writer that changes no file still fails the run with `empty-write-result`.

A failed record without a sealed workflow outcome or an admitted planner
diagnostic reports the product disposition and planner diagnostic as
`unavailable`. Missing evidence does not prove that a failed schema-v2 record
predates structured outcomes. Successful historical records without structured
outcome evidence remain readable with the
`legacy-no-product-disposition` compatibility label.

The human footer and JSON `nextSteps` use the same diagnosis. A retryable
model-format failure first directs the operator to inspect attempt evidence and
correct the producer or response contract. A non-retryable schema failure
directs the operator to restore the installed schema or decoder capability.
Provider timeout or throttling suggests another run only after that condition
clears. Invalid requests and terminal provider failures require a capability or
configuration fix before another run. These actions do not loop back to the
same information-free `docsfab runs show` output.

Channel split: stderr is progress; stdout is the grouped human footer or
the `--json` object. `--json` wins over `--quiet`. `docsfab run --quiet
--verbose` and `docsfab run --json --verbose` are errors. `docsfab doctor
--live` combines with `--json` and emits the same canonical record as the
offline mode, with the observed GitLab target facts populated.

The following table lists the shipped human shapes for `do` / `run` / `test`.

| Shape | Who accepts it | What it prints |
| --- | --- | --- |
| `--quiet` | `do`, `run`, `test` | No progress wall. `do` also drops the compact `ROUTE` preamble. `do` and `run` print only nested `VERDICT`; conditional `NEXT` and `PATCH`; and `RECORD`. They do not reprint `EXECUTION`, `PRODUCT`, or `PUBLICATION`. `test --quiet` prints nested `VERDICT` and `RECORD`. |
| default | `do`, `run`, `test` | Live current step on a TTY, or one append-only hang-indented step line on a pipe or in CI, plus the grouped footer. `do` prints a compact `ROUTE` block before the run. Default hides `DocChangeDelta` and the documentation gap-ledger dump. `test` uses grouped `STEPS` / `SIMULATION` / `PUBLICATION` / `RESULT` sections. |
| `--verbose` | `run` only | Default progress plus model prose on stderr. Same footer; duration in raw milliseconds; `DocChangeDelta` when a patch is present; the documentation gap-ledger dump when a gap ledger is present. |

Compact `ROUTE` on `docsfab do` is the workflow name, then hang-indented
catalog write-ness and `classifier grants none`:

```text
ROUTE
  review-documentation
    catalog read-only
    classifier grants none
ROUTE
  create-documentation
    catalog write
    classifier grants none
```

`review-documentation` stays `read-only`. `create-documentation` and
`update-documentation` show `write` because those catalogs include a
write step. That token is catalog write-ness, not a grant.
A route the admission model chose adds `admitted by model`, and JSON
`decision.classifiedBy` is `admission-model` instead of `fixed-table`. On an
eligible table miss, `docsfab do --route-only` asks no model. Like `docsfab do`
and `docsfab do --dry-run`, it first verifies the installed quality pack, and a
tampered, stale, or unsafe pack stops it with its own code, such as
`checksum-mismatch`. Otherwise it prints `needs-input`,
then an `Admission:` line that names the workflows the run would offer the
admission model, and its JSON envelope adds `admission.workflows` with
`admission.decidedBy` set to `admission-model`.
`docsfab do --json --route-only` still reports
`decision.readWriteScope` as `"read-only"` because classification never
grants writes:

```json
{
  "schemaVersion": 1,
  "kind": "docsfab-outcome-route",
  "decision": {
    "status": "selected",
    "workflow": "create-documentation",
    "readWriteScope": "read-only"
  }
}
```

The footer is a nested VERDICT block. Plane rows are always labeled.
Body lines hang-indent two spaces under the section title:

```text
VERDICT
  create-documentation a1b2c3d4
    execution succeeded
    product inconclusive
    publication failed
```

`NEXT` appears only when the result contains a next step. `PATCH` appears
only when the result contains a patch, or when an `update-documentation` plan
kept a page unchanged. Its `Kept unchanged:` line names every page the plan
kept, including a page the request named. A read-only `review-documentation`
run does not imply either group.

For a run that requests a draft merge request or a review comment, DocsFab
waits for that operation before printing the final result. A publication
failure leaves the saved run and patch available for the `NEXT` recovery
command. With `--json`, standard output contains one run-result object;
preflight status and other diagnostic messages use standard error.

For a fresh `--draft-mr` run, DocsFab fast-forwards a clean target-branch
checkout onto GitLab HEAD before the write, or writes from GitLab HEAD
without moving tracked local files. Publication was not
attempted (`publication-not-attempted`) only when the patch did not
change documentation files; `NEXT` is `docsfab runs show <run-id>`, not
`docsfab publish`. An `update-documentation` run whose editorial outcome is
`verified-no-change` has nothing to publish. DocsFab does not attempt a
draft merge request, `PUBLICATION` reads `Status: not needed`, and the run
exits 0 with the no-change `NEXT`, unless `--release-gate` fails its
`inconclusive` product disposition. A run base that GitLab's target branch
does not contain (`stale-revision`) carries the phase it refused in, and the
two phases take different next steps.
Before the write, the `--draft-mr` freshness prelude refuses and no run
record is created; the next action is `docsfab doctor --repo <path>`,
after which you retry, or fetch the merge-request target branch and pin
its new head commit with `--revision`. After the write, the succeeded
run is preserved on disk and only publication refused; `NEXT` is
`docsfab ship <run-id> --repo <path>`, which republishes that saved run
against GitLab's current target and does not re-run the workflow. Its reason
says to merge the run base into the target branch first, or to start a new
run from a commit on the target branch. A run base that GitLab does not have
at all is `run-revision-unpushed`; its reason says to push that commit to
the target branch before `ship`. Both phases print the same command and
reason in the footer, under `--quiet`, and in the `nextSteps` pair of the
`--json` result. A durable resume is
different: it pins the retained source SHA and exact delivery target, so it
cannot silently switch to an advanced target-branch HEAD. If the current
target or grant no longer matches, resume returns `delivery-recovery-required`
before writing. Other publication
attempts that failed still use
`docsfab publish <run-id>`.

On the default `PRODUCT` section, findings, limitations, and open
decisions that share one code collapse to a single `Product findings:`
line. Empty `none` lists are omitted.

Refer to the [Runner Quickstart](../../get-started/runner-quickstart.md)
for a first named workflow using this interface.
