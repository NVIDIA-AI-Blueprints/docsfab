# Autonomous dry-run

`docsfab auto --dry-run` is DocsFab's mutation-free autonomous assessment and
decision preview. It inspects one immutable repository revision, observes the
current DocsFab-managed tracker state read-only, selects at most one registered
workflow, and explains what a later authorized cycle would do.

```text
docsfab auto --dry-run [--repo <path>] [--revision <ref>]
  [--target-branch <branch>] [--json]
```

The repository defaults to the current directory and the revision defaults to
`HEAD`. The target branch defaults to the repository's governed DocsFab project
configuration. An explicit `--target-branch` only narrows the preview; it grants
no SCM or tracker authority.

The project configuration is read from the immutable selected revision, not
from a dirty or newer source checkout. Fetch and push remotes must resolve to
one exact project, the provider's default branch must match the governed
configuration, and the selected commit must exist in that project before
tracker observation begins.

## Read-only boundary

The command exports the selected commit to a disposable workspace and loads:

1. the deterministic repository inventory;
2. the G0–G5 documentation-maturity assessment and selected work unit;
3. one current content-minimized GitLab issue snapshot shared by both maturity
   selection and managed-issue reconciliation;
4. the selected registered workflow's exact steps, governed task binding, and
   prerequisite states; and
5. the read-only roadmap reconciliation produced by the autonomous-roadmap
   planner.

The GitLab credential comes only from host-specific `glab` configuration after
the remote host matches the host-owned trust binding. Generic ambient GitLab
tokens are removed from the credential lookup environment and are never sent
to a repository-selected host.

The CLI dependency surface contains no issue writer, branch writer, repository
writer, publisher, authorization, or apply callback. Roadmap results must state
`readOnly: true` and `authorization: null`. The previewed issue operations and
any delivery-eligible draft-MR destination carry `performsMutation: false`;
`deliveryMode: none` never invents a draft MR. Execution still needs the
separate `docsfab auto --once` authorization path.

Every proposed operation cites the exact inventory, maturity finding, tracker
observation, workflow-prerequisite, or roadmap-plan digest that produced it.
Paths are repository-relative. Credentials, raw issue prose, prompts, and
absolute evidence paths are excluded from the result.

## Determinism and output

The request, assessment, decision, maturity selection, and roadmap plan remain
bound to their exact time-limited observation. Operation keys and a draft
source branch instead use stable semantic identity: repository revision,
project, target branch, selected work unit, and workflow. Observation time is
excluded, so repeating the command against unchanged repository and tracker
content produces the same major assessment and operation keys.

Human output is concise and always ends with the exact next
`docsfab auto --once` command. `--json` emits one strict canonical object with
the same command in `nextAction` for automation.

If the repository type is unknown, the documentation-product policy is absent,
the default GitLab target cannot be detected, tracker evidence is unavailable,
or a selected structured workflow lacks its governed task input, the command
returns `needs-input`. It lists stable input IDs and does not invent a workflow,
task, target, evidence, or authority.

Managed issue markers are stable identity, not current-state authority. If the
host cannot restore receipt-backed state for every observed managed marker, the
command returns `managed-state-receipts-required` instead of guessing whether
the issue is reusable or updateable.
