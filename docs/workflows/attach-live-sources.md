---
title: "Attach Evidence to a Live Session in DocsFab"
description: "Bind tracked files or one merged GitLab merge request as immutable evidence for a live session."
status: draft
content.type: how-to
---

Bind tracked files or one merged GitLab merge request as immutable evidence for a live session.

## Attached Sources

`--source` and `--pr` attach evidence to the whole session. They are a
host selection made at the terminal, not a conversation topic. The following
rules apply:

- Every bounded workflow the conversation runs binds exactly the
  attached files and merged change, acquired by the host at the
  selected revision. The writer and the verifier read the same
  immutable observations. If a revalidation has reported a source as
  `stale`, `missing`, `unreadable`, or `identity-changed`, or if a
  `fresh` verdict has aged past the revalidation window, that run is
  refused rather than binding those bytes.
- The agent has no tool parameter for them, and no message you type
  during the conversation can add, replace, or drop one. Restart the
  session to change the selection.
- `create-documentation` and `update-documentation` accept bound
  sources. Asking for another workflow while sources are attached
  stops that run and names the workflow, rather than dropping the
  evidence.
- An instruction that itself names merge requests by a merged-on date
  window already selects its own evidence, so it does not combine with
  an attached source. That run stops and names the conflict.
- The same selection binds the same evidence on `docsfab run` and
  `docsfab do`.

Use `docsfab do --continue <run-id> --attach <path>` for editorial continuation of a stopped catalog run. These are not `docsfab run` or live-agent startup flags. `docsfab run --resume-from` is the separate durable knowledge-stop surface. `docsfab do` does not accept `--reader-source`.

## Use GitLab Merge Requests as Evidence

Ask the live agent to inspect merge request history when the host is
GitLab and `glab` is authenticated. GitHub `gh` is not a substitute
for this evidence path.

This conversational path is read-only inspection: it retrieves records
for the agent to reason about, and it is distinct from attaching a
merge request with `--pr`. An attached merge request is *bound*
evidence that every workflow run in the session commits to, and it is
read inside that run rather than quoted into a conversation. Use this
section's path to explore, and `--pr` to ground a run.

```text
You: Review GitLab merge request 184 and tell me what
documentation I still need to update.
```

The runtime lists merged merge requests with `glab`, then fetches the
selected record. Listing and diff pages are capped at 20 records.
When you name a merge request number (IID), the runtime fetches that
record directly. GitLab 17.2 or later is required when results are
ordered by merge date.

On success, the evidence includes the merge request IID, title,
state, source and target branches, and a bounded snippet of the
description or diffs. The live agent can then use that evidence to
answer a documentation question.

### When Credential Screening Withholds Evidence

GitLab merge-request evidence is a `confined-tool-result`. Credential
screening withholds the entire payload when it holds one of DocsFab's
own configured credentials, such as its GitLab token or model key.
Text that only looks like a credential passes through. The activity
line can still name the operation and merge request number. The
runtime does not pass the description, file list, or diffs to the
model or the session log.

When that happens, inspect the merge request in GitLab yourself, and
remove and rotate the exposed credential. Refer to
[Credential-Like Content](../reference/security-and-trust.md#credential-like-content)
for what counts as a configured credential. For recovery steps, refer to
[A Run Stops Because a Configured Credential Was Found](../troubleshooting.md#a-run-stops-because-a-configured-credential-was-found).
