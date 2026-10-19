---
title: "Ask a Documentation Question From Slack in DocsFab"
description: "Ask one read-only question against a connected project's tracked documentation."
status: draft
content.type: how-to
---

Ask one read-only question against a connected project's tracked documentation.

## Prerequisites

Use a project channel that activates `live-agent-turn`.

## Steps

A project that activates `live-agent-turn` also supports one read-only
question:

```text
/docsfab ask How can I inspect saved runs?
```

Any non-empty text after `ask` is the question; wrapping straight or curly
quotes are optional and stripped if present. Without a `target=`, the question
covers the project's tracked documentation. At the revision it answers from,
DocsFab indexes every tracked Markdown page except test data and benchmark
inputs, ranks them against the question, and approves only the best matches,
so the model reads those pages and never the whole set. Pages under the
project's declared `documentationRoots` in `.docsfab.json`, the repository's
top-level pages such as `README.md` and `AGENTS.md`, and the `README.md` in
`.gitlab/` or `.github/` rank ahead of equally relevant pages elsewhere. In a
thread, a follow-up too vague to match a page well stays on the previous
question's topic. A page the question names by its exact path is always
approved first. The answer ends with the pages DocsFab selected,
names any it could pass to the model only in part, and, when more pages
matched than it approved, says how many matched. When no page matches,
DocsFab answers from the project's `README.md` and says so. Add
`target=<repo-relative-path>` as the first or last word to answer from one page
instead, for example
`/docsfab ask target=docs/reference/status-and-configuration/runtime-cli-and-configuration.md What does this page say about saved runs?`.
Each ask creates one focused job and does not resume conversation state. The
opening response and answer use the same Slack thread. An empty ask is the
only refusal; a named target that is untracked gets a clear, specific reply.
Source support does not establish that a project route, mapped user, or live
Slack exchange is active.
