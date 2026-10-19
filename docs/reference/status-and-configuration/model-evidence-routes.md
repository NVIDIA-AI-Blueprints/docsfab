---
title: "Model Evidence Routes in DocsFab"
description: "Look up the evidence and approval boundaries of model serving routes and execution harnesses."
status: draft
content.type: reference
---

Look up the evidence and approval boundaries of model serving routes and execution harnesses.

## Model-Profile Evidence Routes

Profile approval is not synonymous with Inference Hub approval. Bind the model,
serving route, execution harness, and DocsFab purpose before selecting an
evidence-adapter set or requesting authentication.

The [composition execution adapters](execution-compositions.md) are separate from the technical
profile-approval path. The current `profile inspect --catalog` and `profile
approve` path establishes technical evidence only for the NVIDIA Inference API
plus authenticated Inference Hub Metadata catalog route. The direct OpenAI and
Anthropic Pi connections do not yet make those routes technically approvable.
Codex and Claude Code remain preflight-only. NIM and embedding approval
adapters remain planned.

The separate `docsfab composition pilot-campaign` surface is an explicitly
acknowledged, live, uncontained development pilot. It uses owner-private state
outside forbidden roots. Its host-derived proxy evaluation is unattested and
cannot establish a ranking, technical approval, role qualification, release
authority, or merge authority.

`INFERENCE_HUB_METADATA_API_KEY` belongs only to the NVIDIA metadata-evidence
adapter. It is never a prerequisite for ordinary NVIDIA inference, direct
OpenAI or Anthropic execution, or Codex or Claude Code preflight.
