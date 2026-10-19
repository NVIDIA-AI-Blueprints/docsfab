---
title: "Check Native CLI Readiness in DocsFab"
description: "Inspect an explicitly configured native CLI and its authentication without running a documentation workflow."
status: draft
content.type: how-to
---

Inspect an explicitly configured native CLI and its authentication without running a documentation workflow.

## Prerequisites

Use the owner-managed host configuration. The command uses explicitly configured paths; follow the constraints below.

## Native-Harness Preflight

Two installed compositions inspect native CLI readiness without model or
workflow egress:

```bash
export DOCSFAB_CODEX_EXECUTABLE=/absolute/path/to/codex
docsfab composition preflight \
  --composition openai-gpt-6-sol-codex-preflight

export DOCSFAB_CLAUDE_EXECUTABLE=/absolute/path/to/claude
docsfab composition preflight \
  --composition anthropic-claude-opus-4.7-claude-code-preflight
```

Codex preflight checks the installed CLI, ChatGPT-managed authentication, and
the model catalog of the authenticated ChatGPT account. That catalog read is
the only provider contact; no model request, prompt, repository content, or
credential is sent to Codex. The read makes Codex write `models_cache.json`
and `cloud-config-bundle-cache.json` in its own home (`~/.codex/`); DocsFab
writes nothing to its own state for it. Claude Code preflight checks the installed CLI and
first-party Claude.ai authentication. These commands do not execute a
documentation workflow and cannot be supplied to `docsfab run` as executable
compositions. The executable must come from the explicit host setting; ambient
`PATH` is not an authority source.
