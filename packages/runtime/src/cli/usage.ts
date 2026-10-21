// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MODEL_SETTING_KEYS } from "../config/model-settings.js";
import { supportedSourceExtensions } from "../inputs/source-extractor-registry.js";
import { PUBLIC_WORKFLOW_NAMES, type PublicWorkflowName } from "../workflow-registry/manifest.js";
import { generalHelpPresentation, renderCliPresentation } from "./discovery-presentation.js";
import { SOURCE_AWARE_WORKFLOWS } from "./run-arguments.js";

const PUBLIC_WORKFLOW_HELP = {
  bootstrap: "Prepare repository guidance; requires --allow-write; local patch only.",
  "review-documentation": "Read-only review of existing documentation.",
  "create-documentation": "Create documentation for a specific audience and scope.",
  "update-documentation": "Update existing documentation for a specific outcome.",
  "restructure-documentation": "Restructure documentation for a specific outcome.",
  readiness: "Assess repository sources for documentation work; read-only.",
  "release-documentation-readiness": "Assess public release documentation; read-only.",
  "audit-documentation": "Check every page against its template; no model call.",
} satisfies Readonly<Record<PublicWorkflowName, string>>;

function publicWorkflowHelpLines(): string {
  const nameWidth = Math.max(...PUBLIC_WORKFLOW_NAMES.map((name) => name.length)) + "  ".length;
  return PUBLIC_WORKFLOW_NAMES.map(
    (name) => `  ${name.padEnd(nameWidth)}${PUBLIC_WORKFLOW_HELP[name]}`,
  ).join("\n");
}

/** The description column of option help. */
const HELP_COLUMN = " ".repeat(40);

/**
 * A comma-separated list wrapped under the description column. The first line
 * carries no indent, so it can follow an option's text.
 */
function wrapHelpList(items: readonly string[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const last = lines.length - 1;
    if (lines.length > 0 && `${lines[last]!}, ${item}`.length <= 54) {
      lines[last] = `${lines[last]!}, ${item}`;
      continue;
    }
    // The separator belongs to the item that wraps, so a wrapped list never
    // reads as two lists.
    if (lines.length > 0) lines[last] = `${lines[last]!},`;
    lines.push(item);
  }
  return lines.join(`\n${HELP_COLUMN}`);
}

/** The `--set` keys on their own lines under the description column. */
function settingKeysHelp(): string {
  return `${HELP_COLUMN}${wrapHelpList(MODEL_SETTING_KEYS)}.`;
}

/**
 * The `--source` extension list, rendered from the shipped registry so help,
 * the classifier, and the refusal cannot drift apart.
 */
function sourceExtensionHelpList(): string {
  return wrapHelpList(supportedSourceExtensions().map((value) => `.${value}`));
}

export function generalHelp(): string {
  return renderCliPresentation(generalHelpPresentation());
}

export function initHelp(): string {
  return `Initialize DocsFab for one selected input repository

Usage:
  docsfab init [--repo <path>] [--remote <name>]
    [--non-interactive] [--json]
  docsfab init [--repo <path>] [--remote <name>] --non-interactive --apply
    --approve-plan-sha256 <digest> [--json]

Options:
  --repo <path>                         Select a local Git repository (default: current directory).
  --remote <name>                       Select one safe Git remote name (default: origin when present).
  --non-interactive                     Print a plan without prompting or applying it.
  --json                                Print structured output; requires --non-interactive.
  --apply                               Apply the exact approved plan; requires --non-interactive.
  --approve-plan-sha256 <digest>        Bind --apply to the reviewed plan digest.
  --help, -h                            Print this help and exit successfully.

Without --non-interactive, init prints a plan and can prompt you to approve and
apply it. With --non-interactive and no --apply, init only prints the plan.
Review its digest before running the second form. Applying an approved plan can
write project configuration and user-private state. This help command performs
no repository, configuration, credential, or network operations.

Next commands after successful initialization:
  docsfab doctor --repo /absolute/path/to/input-repository
  docsfab list
  docsfab run review-documentation --repo /absolute/path/to/input-repository`;
}

export function runHelp(): string {
  return `Run one bound documentation workflow against a selected input repository

Usage:
  docsfab run <workflow> [--repo <path>] [--revision <ref>]
    [--instruction <text>] [--patch-only | --dry-run]
    [--remote <name>] [--quiet | --verbose] [--json]
    [--composition <installed-composition-id>] [--set <key>=<value>]...

Common invocations:
  docsfab list
  docsfab plan review-documentation
  docsfab run review-documentation --repo <path>

Delivery choices for documentation writes:
  --patch-only                          Retain a local patch without applying or publishing it.
                                        Bootstrap also requires --allow-write.
  --dry-run                             Preview CLI selection without inspecting or validating the target.
  default                               Authoring workflows create a branch and open one draft
                                        merge request after delivery prerequisites pass. Requires
                                        an origin remote (or --remote <name>), authenticated glab,
                                        and permission to push and create a merge request. Tracked
                                        local changes stay in place; delivery writes from GitLab's
                                        target-branch revision.

Model settings:
  --composition <id>                    Run this installed preset; settings override its values.
  --set <key>=<value>                   Override one model setting for this run, above the
                                        environment and host.yaml. Repeat per setting.
                                        Keys:
${settingKeysHelp()}

Workflows:
${publicWorkflowHelpLines()}

Source-aware execution:
  --source <repository-relative-path>   Bind one tracked file at the selected revision as evidence.
                                        Repeat the flag per file. Supported today by
                                        ${SOURCE_AWARE_WORKFLOWS.join(" and ")}.
                                        The host reads the exact revision bytes, extracts a
                                        digest-bound derivative, and blocks the write while a
                                        selected source is unread. --dry-run parses the selection
                                        without opening a body. Accepted extensions:
                                        ${sourceExtensionHelpList()}
  --pr, --mr <url-or-reference>         Ground the run on one GitLab merge request. Two spellings of
                                        one option; pass either, once. Accepts the merge request's
                                        URL, host/group/project!number, or just the number for
                                        this checkout's project. Supported today by
                                        ${SOURCE_AWARE_WORKFLOWS.join(" and ")}.
                                        Before any model call the host reads the merge request
                                        once through your glab login to pin its commits, then binds
                                        its diff from this checkout's own objects, as --change does,
                                        or, when the checkout lacks them, from GitLab's own diff.
                                        A merged merge request also binds its text, and records an
                                        evidence gap when the body is clipped or absent; an open one
                                        binds its diff alone, labelled merge-request-unmerged, and
                                        the status output says why its text was not bound. A closed
                                        one refuses. When the checkout lacks a commit the diff reads,
                                        or in a partial clone a tree or file version, and GitLab's
                                        diff cannot be read either, the run refuses
                                        change-source-mr-objects-unavailable before any model call.
                                        DocsFab never fetches git objects. The binding records the
                                        host, the project's canonical path, its numeric id and the
                                        merge request number.
                                        Nothing is rehosted. Combine with --source to bind
                                        tracked files alongside it. --dry-run parses the
                                        reference without reading GitLab.
  --change <range-or-change-request>    Ground the run on one change: a local commit range, written
                                        <base>..<head>, <base>...<head> (diffed from their merge
                                        base), or one commit, diffed against its first parent; or a
                                        GitLab merge request by URL, host/group/project!number, or
                                        !number, bound exactly as --mr binds it; a GitHub pull request
                                        URL; or a release range,
                                        written release:<base>..<head> with the earlier and the later
                                        release's tag or commit, which binds a units index and each
                                        first-parent unit's diff and manifest, one page per run, and
                                        names the --change value that binds the next page.
                                        Supported by ${SOURCE_AWARE_WORKFLOWS.join(" and ")}, and by
                                        read-only review-documentation.
                                        Before any model call the host resolves each endpoint to a
                                        full id, re-hashes every commit and both root trees, and
                                        checks the range's bounds; it then binds the unified diff and
                                        a change manifest as required evidence. A commit range is
                                        read from this checkout's objects only; nothing is fetched.
                                        Write workflows may combine it with --source; review cannot.
                                        Do not combine with --pr or --mr. --dry-run
                                        parses the value without reading git or GitLab.

--patch-only and --dry-run are separate modes and cannot be combined.
Public GitHub PR review:
  docsfab run review-documentation --pr https://github.com/OWNER/REPO/pull/N
  This read-only route authenticates a public PR's merge base (M), target base
  (B), and fork head (H), then reviews a private H export. --dry-run displays
  an unresolved selection without network, source, or model work. Normal runs
  save a private run record and local Markdown/JSON review report. Repository
  checks are inventoried but not executed; an unavailable check never passes.
  Do not combine this route with --repo, --revision, --remote, --draft-mr,
  --comment-mr, --change, --resume-from, --review-target, --rescope-from,
  --patch-only, or --allow-write.

Write workflows require a concrete --instruction. Review uses repository
content as static evidence but can call the configured model.
An instruction that says not to publish, such as "Do not publish." or
"Keep the result local; do not commit, push, or open an MR.", stops every
delivery that publishes: the default draft merge request, --draft-mr,
--comment-mr, and a write workflow's --dry-run. The code is
publication-prohibition-conflict, and nothing reaches GitLab or the model.
Pass --patch-only to retain the patch without publishing.

Examples:
  docsfab run review-documentation --repo /absolute/path/to/input-repository
  docsfab run create-documentation --repo /absolute/path/to/input-repository \\
    --instruction "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers." --patch-only
  docsfab run create-documentation --repo /absolute/path/to/input-repository \\
    --instruction "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers." --dry-run
  docsfab run update-documentation --repo /absolute/path/to/input-repository --patch-only \\
    --instruction "Review the MRs merged into main on September 14, 2026, using America/Los_Angeles time. Collect the related code changes and existing documentation. Identify changes affecting end users, including commands, configuration, defaults, installation, workflows, and observable behavior. Update only the affected user documentation, preserving unrelated content. Skip internal changes with no user impact. Report which MRs require documentation changes, what you updated, and any evidence gaps. If merge records or diffs are unavailable, report that limitation rather than claiming complete coverage."

After reviewing a dry-run preview, generate a local patch by replacing
--dry-run with --patch-only, or open the default draft merge request by omitting
both flags after satisfying the listed delivery prerequisites.`;
}

export function doHelp(): string {
  return `Continue or start a documentation run from one quoted sentence

Usage:
  docsfab do "<outcome request>" [--repo <path>] [--revision <ref>]
    [--instruction <text>] [--patch-only | --dry-run]
    [--continue <run-id>] [--attach <path>]...
    [--source <repository-relative-path>]... [--pr | --mr <url-or-reference> | --change <range>]
    [--quiet] [--json]
  docsfab do --delegate "<outcome request>" [--repo <path>]
    [--check <npm-script>]... [--allow-write] [--json] [--quiet] [--no-input]
  docsfab do --resume <task-id> --answers <json-file> [--repo <path>]
    [--check <npm-script>]... [--allow-write] [--json] [--quiet] [--no-input]

Delegated pilot:
  --delegate is a named opt-in. Bare do keeps catalog workflow routing and
  is not a staging switch toward a new default. A fresh finite task starts
  unless you pass --resume <task-id> --answers <json-file> for that exact
  task. --resume records those answers and re-enters the delegated driver
  for that same task. There is no most-recent lookup, TTY prompt, silent
  catalog fallback, or inherited grant. --no-input never prints a You: prompt.
  Local documentation writes require --allow-write and still consume #758.
  Remote publication is unsupported. --route-only and --dry-run stay on
  the catalog path and cannot combine with --delegate.
  --check <npm-script> runs npm run <npm-script> in the repository after
  the driver; the script must be declared in its root package.json. The
  request text never chooses a check. A paused task keeps its checks, so
  pass the same --check flags again with --resume.

Ask for a patch or a draft merge request:
  --patch-only is available to workflows with a write step, including bootstrap.
  Bootstrap still requires --allow-write, which grants its write step; --patch-only
  selects local patch delivery. --draft-mr is available to create-documentation,
  update-documentation, and restructure-documentation. When the table cannot
  classify the sentence, the configured model may name only workflows that
  support the requested delivery; if it names none, do stops with needs-input.
  A review the table picks runs as update-documentation, which can end in a
  patch or a verified no-change. --allow-write grants writes and does not change
  the route. --route-only accepts --patch-only and --draft-mr, asks no model,
  and names the workflows the run would offer the model.

Continue a stopped editorial needs-input run:
  --continue <run-id>                   Resume that exact open run. Required when
                                        more than one editorial needs-input run is open.
  --attach <path>                       Admit one tracked repository path or operator
                                        file as a named InputAsk fill. Repeat per file.
  "<reply sentence>"                    NFC, credential-free text fill bound to an open
                                        text or request InputAsk slot.

When exactly one editorial needs-input run is open for this repository, a reply
sentence and/or --attach continues that run without --continue. Resume keeps the
original instruction digest. Unchanged workspace snapshot and planBinding skip
re-plan and search observe; a changed snapshot revalidates. Text fills cannot
certify verified no-change.

Ground the run on explicit sources:
  --source <repository-relative-path>   Bind one tracked file as run evidence. Repeat per file.
  --pr, --mr <url-or-reference>         Ground the run on one merged merge request. Two spellings of
                                        one option; pass either, once. Accepts its
                                        URL, host/group/project!number, or the number for this
                                        checkout's project. Combine with --source.
  --change <range-or-merge-request>     Ground the run on one change, any value docsfab run
                                        --change accepts: a local commit range such as
                                        HEAD~1..HEAD, a GitLab merge request, a GitHub pull
                                        request or commit URL, or a release range written
                                        release:<base>..<head>. Combine with --source; not with
                                        --pr or --mr.

Each is acquired before the first workflow model call. --source and --change
bind what docsfab run binds for the same value, so --change with a merge request
binds its diff, and its text once merged. --pr and --mr bind the merged merge
request's text only: unlike docsfab run, do does not bind its diff through them.
They are supported only once the request routes to ${SOURCE_AWARE_WORKFLOWS.join(" or ")};
any other route stops and names the workflow. --change never changes the route.
--route-only and --dry-run parse the selection without opening a source body or
reading git, GitLab, or GitHub. Selection previews do not check repository
readiness. None combines with --continue or --attach, or
with a reply to an open run: a continued run binds exactly the --source files
and change the stopped run bound. Delegated do accepts none of them.

Do not pass --reader-source on do; that catalog evidence flag stays on
docsfab run. Caps: 1 MiB per source, 8 MiB retained, 128 nominations.

${usageDoFlags()}
`;
}

function usageDoFlags(): string {
  return `Other options:
  --repo <path>                         Select a local Git repository (default: current directory).
  --delegate                            Opt in to the bounded delegated-task pilot.
  --no-input                            Delegated: never prompt; persist needs-input.
  --resume <task-id>                    Record answers for that exact delegated task, then continue the driver for that task id.
  --answers <json-file>                 Answer file for --resume.
  --check <npm-script>                  Delegated: run that package.json script as a check. Repeat per script.
  --composition <id>                    Run this installed preset; settings override its values.
  --set <key>=<value>                   Override one model setting for this run, above the
                                        environment and host.yaml. Repeat per setting.
                                        Keys:
${settingKeysHelp()}
  --patch-only                          Retain a local patch without applying or publishing it.
  --dry-run                             Classify and stop before target inspection or writes.
  --quiet                               Print the short human shape.
  --json                                Print structured output.
  --help, -h                            Print this help and exit successfully.`;
}

export function usage(): string {
  return `DocsFab — governed documentation workflows on Pi

Usage:
  docsfab help [<command> [<subcommand>]]
    (docsfab <command> [<subcommand>] --help and -h print the same usage)
  docsfab list
  docsfab init [--repo <path>] [--remote <name>]
    [--non-interactive] [--json]
  docsfab init [--repo <path>] [--remote <name>] --non-interactive --apply
    --approve-plan-sha256 <digest> [--json]
  docsfab test [--quiet] [--json]
  docsfab setup [--profile <compositionId>] [--preset <id>] [--migrate] [--verbose | --json]
    (interactive setup asks for the model name, OpenAI-compatible endpoint URL, and a hidden API key)
  docsfab config inspect [--json]
  docsfab live-agent [--repo <path>] [--new] [--read-only | --allow-write]
    (single interactive entry; runs setup in-process when needed, then starts or resumes Pi)
    (documentation writes enabled by default; --read-only disables edits and host commands)
  docsfab sessions list [--repo <path>] [--json]
    (local live-agent sessions with id, age since last write, size, and repository label)
  docsfab sessions delete <session-id> | --all | --older-than <days> [--confirm <token>] [--json]
    (previews without --confirm; deletes only the set that preview's token names)
  docsfab sources [list|add|show|refresh|revalidate|remove|search|purge|review] [<argument>] [--repo <path>]
    [--source <repository-relative-path>]... [--pr | --mr <url-or-reference>]
    (the same verbs, listing, and coded refusals the live terminal's source command answers with)
    (the selection is held for this one invocation; no other process, saved run, or conversation reads it)
    (an argument is read literally: no shell expansion, command substitution, or globbing)
    (purge is the one destructive verb: it previews first and deletes only against that preview's confirmation)
  docsfab doctor [--repo <path>] [--use local-review|local-patch|draft-mr] [--live]
                 [--quiet | --verbose] [--json]
    (--quiet keeps the selected-use result, material attention, and next action;
     --verbose adds supporting diagnostics from this invocation; neither adds probes)
  docsfab doctor [--repo <path>] [--limits] [--json]
  docsfab doctor [--repo <path>] [--live] --catalog [--judge] [--json]
  docsfab doctor [--repo <path>] --live --answer-submission [--answer-submission-typed-contingency] [--json]
    (qualification probe for the tool-call answer path: spends the probe's requests only,
     prints GO, NO-GO, INCONCLUSIVE, or CONTINGENCY REQUIRED, and keeps the content-free
     observation under the state root; the typed-shell contingency runs only with its flag)
  docsfab doctor [--repo <path>] --live --answer-records --answer-record-corpus <path>
    [--answer-record-small-groups | --answer-record-typed] [--json]
    (premise probe for the answer-record transport: prints its request and input-token plan,
     spends at most that, prints GO, NO-GO, or INCONCLUSIVE, and keeps the content-free
     observation under the state root; the record corpus is named, never shipped;
     --answer-record-small-groups sends only 2- and 3-record messages on what the approved
     probe spend has left after the retained observations, and prints MEASURED,
     INCONCLUSIVE, or NO-GO with cost projections)
     --answer-record-typed runs slice 1b A-t on the typed shell. Phase G stays
     locally not executed (zero requests) while the bound request policy blocks guided JSON.
  docsfab doctor --answer-record-qualification-plan --answer-record-corpus <path>
    [--answer-record-typed] --answer-record-observation-dir <ledger-dir> [--json]
    (provider-free exact A/B/C cell plan; reads retained budget from the named ledger and
     enumerates the same immutable cells later selected by --live --answer-records
     --answer-record-qualification-cells)
  docsfab doctor --answer-record-diagnostic-plan --answer-record-typed
    --answer-record-corpus <path> --answer-record-observation-dir <ledger-dir> [--json]
    (provider-free plan for only the production-built typed B/6,144/seed-1 nine-call cell;
     prints the diagnostic fingerprint, current ledger headroom and estimated input tokens;
     does not reserve, call the provider, or produce qualification evidence)
  docsfab doctor [--repo <path>] --live --answer-records --answer-record-corpus <path>
    --answer-record-typed --answer-record-qualification-cells
    --answer-record-qualification-fingerprint <sha256>
    --answer-record-observation-dir <ledger-dir> [--json]
    (runs only the exact typed qualification cells from the same planner; reads and reserves
     against the named ledger directory, then retains content-free observations there; refuses
     binding or cell-plan drift from the reviewed provider-free qualification fingerprint)
  docsfab doctor [--repo <path>] --live --answer-records --answer-record-corpus <path>
    --answer-record-typed --answer-record-diagnostic-cell
    --answer-record-diagnostic-fingerprint <sha256>
    --answer-record-observation-dir <ledger-dir> [--json]
    (runs only the fingerprint-bound B/6,144/seed-1 nine-call diagnostic cell, with zero retries;
     retains diagnostic-only evidence against the same typed request and combined input ledger;
     a result cannot replace a qualification cell or activate answer records)
  docsfab profile inspect [--judge] [--catalog] [--verbose | --json]
  docsfab profile seed --preset <id> [--json]
  docsfab profile approve --inspection <owner-only-json> --proposal-sha256 <digest>
    --effective-date <YYYY-MM-DD> --review-after <YYYY-MM-DD>
    --authority-id <id> --public-key <owner-only-pem> --private-key <owner-only-pem>
    --bundle <absolute-owner-only-json>
    [--resolve-conflict <field> ...] [--judge] [--json]
  docsfab profile approve --inspection <owner-only-json> --authority-id <id>
    --public-key <owner-only-pem> --bundle <absolute-owner-only-json>
    --apply --confirm-bundle-sha256 <digest> --confirm-patch-sha256 <digest>
    --receipt <absolute-path> [--judge] [--json]
  docsfab profile rollback --receipt <absolute-path> [--json]
    [--apply --confirm-rollback-sha256 <digest> --rollback-receipt <absolute-path>]
  docsfab profile probe --route <id> --model <id> [--live] [--json]
    (default/offline path does not spend; --live wraps the matrix request-policy probe)
  docsfab profile draft --route <id> --model <id> --verdict <verdict> [--json]
    (prints a composition-shaped record and reseal instructions; does not merge the registry)
  docsfab composition list [--json]
  docsfab composition preflight --composition <installed-composition-id> [--json]
    (native CLI version/auth/catalog preflight; no model or workflow egress; the Codex
     preflight makes one authenticated account-catalog read)
  docsfab composition compare --record <absolute-run-record.json>
    --record <absolute-run-record.json> [--record <absolute-run-record.json> ...] [--json]
    (provider-offline same-fixture comparison; 2 to 8 sealed composition run records)
  docsfab composition pilot-campaign --corpus routing-task-guide-v1
    --campaign-root <absolute-owner-private-directory>
    --nemotron-record <absolute-json> [--nemotron-patch <absolute-patch>]
    [--nemotron-document <absolute-markdown>]
    --forbidden-root <absolute-path> --forbidden-root <absolute-path>
    --acknowledge-development-only-uncontained [--json]
    (live cross-harness development pilot; uncontained evidence, unattested host-derived proxy evaluation,
    no ranking, technical approval, role qualification, release authority, or merge authority)
    (requires canonical DOCSFAB_CODEX_EXECUTABLE, DOCSFAB_CLAUDE_EXECUTABLE,
    DOCSFAB_PYTHON_EXECUTABLE, and owner-private durable state outside both forbidden roots)
  docsfab plan <workflow>
  docsfab do "<outcome request>" [--repo <path>] [--revision <ref>] [--instruction <text>] [--patch-only] [--dry-run] [--allow-write] [--draft-mr] [--remote <name>] [--comment-mr <iid-or-url>] [--route-only] [--quiet] [--json] [--study]
    [--continue <run-id>] [--attach <path>]...
    [--composition <installed-composition-id>] [--set <key>=<value>]...
    [--delegate] [--no-input] [--resume <task-id> --answers <json-file>] [--check <npm-script>]...
    (the quoted sentence is the work; --instruction is an optional override)
    (continue a stopped editorial needs-input run with a reply sentence and/or --attach files)
    (text fills are NFC and credential-free; attachments admit a tracked path or operator file bytes)
    (--continue is required when more than one editorial needs-input run is open)
    (do not pass --reader-source on do; that flag stays on docsfab run)
    (defaults: this checkout, origin, write and one draft MR for create/update/restructure)
    (--patch-only retains a generated patch without applying it to the source checkout or opening a merge request)
    (--dry-run classifies and stops before target inspection, workflow checks, writes, or publication; on an eligible table miss it verifies the installed quality pack, then makes its only model call, to the admission model)
    (--allow-write and --draft-mr remain accepted)
    (--remote selects a Git remote other than origin)
    (--comment-mr posts one review summary on that exact MR/head; creates no branch or MR; requires an injected host review-summary port)
    (live do may admit one catalog workflow with the configured model when the table cannot classify; --route-only stays table-only)
    (--patch-only and --draft-mr narrow that choice to create, update, and restructure, and run a review the table picks as update-documentation)
    (--delegate is a named opt-in pilot; bare do keeps catalog routing and is not a new default)
    (--resume records answers for one exact delegated task with --answers, then continues the driver for that task; there is no most-recent lookup or You: prompt)
  docsfab multi-unit-campaign --campaign-dir <private-directory> --repo <path>
    [--revision <ref>] [--dry-run] [--json]
    (dry-run default; --allow-write is fail-closed — no auto-merge/publish)
  docsfab ia input provision|create analysis --repo <path> --revision <full-commit>
    --scope site --mode create|reevaluate --expires-at <UTC timestamp> [--json]
  docsfab ia input provision|create analysis --repo <path> --revision <full-commit>
    --scope section|page --target <path[#anchor]> --expires-at <UTC timestamp> [--json]
  docsfab ia input provision planning --repo <path> --revision <full-commit>
    --scope site --mode create|reevaluate --analysis-run <run-id> [--json]
  docsfab ia input inspect|validate analysis|planning --repo <path>
    --revision <full-commit> --scope site --mode create|reevaluate
    [--input-digest <sha256>] [--json]
  docsfab ia input inspect|validate analysis|planning --repo <path>
    --revision <full-commit> --scope section|page --target <path[#anchor]> [--json]
  docsfab ia approve --repo <path> --revision <full-commit> --scope site --mode create
    --run-id <planning-run-id> --reviewer-policy <owner-only-json>
    --reviewer-id <id> --private-key <owner-only-pem> [--json]
  docsfab ia cycle --repo <path> --revision <full-commit> --expires-at <UTC timestamp>
    --reviewer-policy <owner-only-json> --reviewer-id <id> --private-key <owner-only-pem> [--json]
  docsfab roadmap-plan --mode release --since <tag-or-revision> --input <authenticated-json>
    [--repo <path>] [--revision <ref>] [--release-ref <ref>] [--limit <count>] [--json]
  docsfab roadmap-plan --mode health --input <authenticated-doc-audit-json>
    [--repo <path>] [--revision <ref>] [--scope <repository-relative-path>] [--limit <count>] [--json]
  docsfab roadmap-plan --sweep <ledger-json> --input <authenticated-sweep-json>
    [--repo <path>] [--revision <ref>] [--limit <count>] [--json]
  docsfab auto --dry-run [--repo <path>] [--revision <ref>]
    [--target-branch <branch>] [--json]
  docsfab auto --once --confirm-cycle [--repo <path>] [--revision <ref>]
    [--target-branch <branch>] [--authority-id <id>] [--json]
  docsfab auto --publish --confirm-cycle --repo <path> --candidates <manifest.json>
    [--revision <ref>] [--target-branch <branch>] [--authority-id <id>] [--resume] [--json]
  docsfab run <workflow> [--repo <path>] [--revision <ref>] [--instruction <text>] [--patch-only] [--dry-run] [--allow-write]
    [--draft-mr] [--remote <name>] [--comment-mr <iid-or-url>] [--canon-sha256 <sha256>] [--release-gate] [--quiet] [--verbose] [--show-scan] [--json] [--study]
    [--composition <installed-composition-id>] [--set <key>=<value>]...
    [--context-path <repository-relative-path>] [--context-anchor <anchor>]
    [--context-parent-path <repository-relative-path>] [--context-parent-anchor <anchor>]
    (--composition selects that preset for this run; its evidence is recorded as non-release evidence; omitted, the configured model runs)
    (--set key=value overrides one writing-model setting for this run, above the environment and host.yaml)
    (write workflows default to this checkout, origin, and one draft MR; --patch-only retains an unapplied patch and --dry-run only previews selection)
    (--canon-sha256 needs --comment-mr: the project's registered canon digest for a focused review's continue command; no effect until a focused --comment-mr producer exists)
  docsfab run bootstrap [--repo <path>] [--revision <ref>] --allow-write [--patch-only]
    (prepares repository guidance as a local patch; cannot open a draft MR)
  docsfab run review-documentation [--repo <path>] [--revision <ref>] [--review-target <repository-relative-page>]... [--rescope-from <stopped-run-id>] [--quiet] [--verbose] [--json]
    (--review-target selects an explicit page set; --rescope-from narrows a saved review after verifying its revision and original page set; do not combine --review-target with --context-path)
    [--change <GitLab-MR-URL> --review-delivery-target <same-GitLab-MR-URL> --review-delivery preview]
    (preview retains the original review and source, then shows a read-only delivery plan; publish is not yet supported on this route)
  docsfab run create-documentation [--repo <path>] [--revision <ref>] (--instruction <text> | --resume-from <stopped-run-id> --canon-snapshot <json>)
    [--patch-only] [--dry-run] [--canon-snapshot <json>] [--comment-mr <iid-or-url>]
    [--source <repository-relative-path>]... [--pr | --mr <url-or-reference>]
    [--change <range>]
    [--accept-candidate-snapshot --authority-id <id>] [--quiet] [--verbose] [--json]
  docsfab run update-documentation [--repo <path>] [--revision <ref>] (--instruction <text> | --resume-from <stopped-run-id> --canon-snapshot <json>)
    [--patch-only] [--dry-run] [--canon-snapshot <json>] [--comment-mr <iid-or-url>]
    [--comparison-base <full-object-id> | --comparison-workspace]
    [--reader-source <role>=<repository-relative-path>]...
    [--source <repository-relative-path>]... [--pr | --mr <url-or-reference>]
    [--change <range>]
    [--accept-candidate-snapshot --authority-id <id>] [--quiet] [--verbose] [--json]
    (a date-scoped instruction that names merge requests merged into a branch on a
    calendar day with an IANA time zone discovers those MRs; do not combine it with
    --source, --reader-source, --pr, or --comparison-base / --comparison-workspace;
    --pr names the same kind of evidence explicitly, so use one or the other)
  docsfab run restructure-documentation [--repo <path>] [--revision <ref>] --instruction <text>
    [--patch-only] [--dry-run] [--quiet] [--verbose] [--json]
  docsfab run readiness [--repo <path>] [--revision <ref>] [--json]
  docsfab run release-documentation-readiness [--repo <path>] [--revision <ref>] [--json]
    (release readiness requires a tracked .docsfab.json; assessment does not grant publication)
  docsfab run audit-documentation [--repo <path>] [--revision <ref>] [--context-path <path>]
    [--json] (structural template checks only; no model call and no writes)
  docsfab runs list [--json] [--state-dir <path>]
  docsfab runs show <run-id> [--json] [--show-scan] [--state-dir <path>]
    [--canon-snapshot <path> --accept-candidate-snapshot --authority-id <id>]
    (read-only projection; the three selectors validate and render one exact
    docsfab run --resume-from continuation command and reject with --json)
  docsfab runs query [--where <field>=<value>]... [--since <date>] [--until <date>]
    [--group-by <field>[,<field>]...] [--index-dir <path> | --state-dir <path>] [--json]
    (counts workflow execution attempts unless --where rowKind=run or step;
     runStatus excludes live checkout application; show the saved run for its outcome)
  docsfab runs import <harness-batch|state-dir|record>... [--docsfab-revision <sha>]
    [--index-dir <path> | --state-dir <path>] [--json]
    (adds saved run records to the run index; writes index rows only)
  docsfab runs delete <run-id> [--state-dir <path>]
    [--delivery-root <path>]... [--receipt-root <path>]... [--json]
    (preview local record, sidecar, artifact, receipt, attempt, delivery worktree,
    run branch, and index deletion)
  docsfab runs delete <run-id> [--state-dir <path>]
    [--delivery-root <path>]... [--receipt-root <path>]... --confirm <preview-token> [--json]
    (delete only the previewed identities, delivery worktrees, and run branch;
    incomplete output names residuals and recovery)
  docsfab why [<run-id> | <state-dir>] [--last | --all] [--batch <id>] [--model <id>]
    [--state-dir <path> | --index-dir <path>] [--json]
    (read-only diagnosis from the run index; docsfab why --help lists each option)
  docsfab reports serve [--bind 127.0.0.1|0.0.0.0] [--port <port>] [--state-dir <path>]
  docsfab publish <run-id> [--repo <path>] [--remote <name>]
    [--state-dir <path>] [--target-branch <branch>]
    [--source-branch <branch>] [--validation-command <command>]
    (defaults: this checkout and origin; one-shot host preflight then execute; do not paste a plan digest)
  docsfab publish <run-id> [--repo <path>] --preflight
    [--state-dir <path>] [--remote <name>] [--target-branch <branch>]
    [--source-branch <branch>] [--validation-command <command>]
    (inspect the publication plan only)
  docsfab publish <run-id> [--repo <path>] --execute
    --confirm-plan-sha256 <digest>
    [--delivery-root <absolute-path>] [--receipt-root <absolute-path>]
    [--state-dir <path>] [--remote <name>]
    [--target-branch <branch>] [--source-branch <branch>]
    [--validation-command <command>]
    (two-phase recovery after reviewing --preflight JSON; does not re-run the documentation run)
  docsfab ship <run-id> --repo <path> [--dry-run]
    (opens one draft merge request for an eligible succeeded documentation write; --dry-run reads and summarizes the plan without mutation)
  docsfab roadmap-issues preflight --ledger <json> --plan <json> --material <private-json> [--json]
  docsfab roadmap-issues apply --ledger <json> --plan <json> --material <private-json>
    --authorization <private-json> --receipt <private-json>
    --confirm-plan-sha256 <digest> --confirm-authorization-sha256 <digest> [--json]
  docsfab evaluate --fixture <path> --record <path> [--record <path> ...] [--judge]

Configuration:
  --repo is a local filesystem path. http(s):, git@, and ssh:// values fail closed.
  docsfab setup interactively configures the model name, endpoint URL, and API key.
  Noninteractive setup bootstraps the host policy profile when MODEL_API_KEY is available.
  When DOCSFAB_CONFIG_ROOT is unset, DocsFab uses ~/.config/docsfab. If that root
  has neither host.yaml nor .env, DocsFab reads the installed package .env instead.
  docsfab live-agent prints the configuration root and secrets file in use.
  docsfab doctor reports readiness without printing those paths.
  Only docsfab setup writes secrets.env; live-agent startup only reads it.
  DOCSFAB_CONFIG_ROOT=/absolute/path overrides that default and stores writable
  .env, profile, and state data outside the installed package.
  Immutable skills and governed assets stay package-bound.
  Inited --repo projects resolve omitted --delivery-root/--receipt-root from
  private XDG init roots. Omitted --validation-command selects a versioned
  built-in documentation-validation profile from the sealed workflow, exact
  changed paths, and trusted host policy. It never reads package.json or
  .docsfab.json to choose validation and never infers npm run check or true.
  Explicit --validation-command stays a trusted-host command. docsfab test is
  an offline product smoke, not a target-document validation profile.
  DocsFab itself is supported as a publication target with ordinary authorization.
  DOCSFAB_REPORT_BASE_URL is the public origin for hosted review HTML on Brev.
  DOCSFAB_REPORT_BIND and DOCSFAB_REPORT_PORT configure docsfab reports serve.
Study:
  --study writes a payload-free StudyEventV1 sibling log (opt-in; default is zero events).
  STUDY footer: STUDY scheduled=… extra=… then NEXT docsfab study show <runId>
`;
}
