---
title: "Installed Execution Compositions in DocsFab"
description: "Look up the installed DocsFab model and serving-route records. To select one, follow Select an Installed Composition. To change its defaults, follow Override Model Settings."
status: draft
content.type: reference
---

Look up the installed DocsFab model and serving-route records. To select one, follow [Select an Installed Composition](../../configure/installed-compositions.md). To change its defaults, follow [Override Model Settings](../../configure/override-model-settings.md).

## Installed Compositions

An execution composition binds a model, serving route, authentication route,
transport, harness, and exact adapter versions. List the package-installed
records before selecting one:

```bash
docsfab composition list
docsfab composition list --json
```

The executable compositions use Pi as a common harness. The following table is the current installed registry, not a release catalog.

| Composition ID | Serving route | Transport | Accepted credential sources |
| --- | --- | --- | --- |
| `nvidia-llama-3.3-nemotron-super-49b-v1.5-pi` | NVIDIA API Catalog | OpenAI-compatible chat completions | `DOCSFAB_NVIDIA_API_KEY` only; **retired** (provider end-of-life 2026-08-26; listed for provenance, refused for new runs) |
| `nvidia-nemotron-3.5-lightning-30b-a3b-pi` | NVIDIA API Catalog | OpenAI-compatible chat completions | `DOCSFAB_NVIDIA_API_KEY` only |
| `nvidia-nemotron-3-super-120b-a12b-pi` | NVIDIA API Catalog | OpenAI-compatible chat completions | `DOCSFAB_NVIDIA_API_KEY` only |
| `nvidia-nemotron-3-ultra-550b-a55b-pi` | NVIDIA API Catalog | OpenAI-compatible chat completions | `DOCSFAB_NVIDIA_API_KEY` only |
| `nvidia-inference-claude-sonnet-5-pi` | NVIDIA Inference Hub | OpenAI-compatible chat completions | `MODEL_API_KEY` only; no installed request policy (model is not reasoning-split) |
| `nvidia-inference-claude-opus-5-pi` | NVIDIA Inference Hub | OpenAI-compatible chat completions | `MODEL_API_KEY` only; no installed request policy (model is not reasoning-split) |
| `nvidia-inference-gpt-6-sol-pi` | NVIDIA Inference Hub | OpenAI-compatible chat completions | `MODEL_API_KEY` only; no installed request policy (probe verdict `harness-compatible`) |
| `openai-gpt-5.6-sol-pi` | Direct OpenAI API | OpenAI Responses | Exactly one of `MODEL_API_KEY` or `OPENAI_API_KEY`; **retired** (superseded by operator decision 2026-09-28; listed for provenance, refused for new runs) |
| `anthropic-claude-opus-4.7-pi` | Direct Anthropic API | Anthropic Messages | Exactly one of `MODEL_API_KEY` or `ANTHROPIC_API_KEY` |

The supported first-use path configures a model and endpoint that you choose
through [Install DocsFab](../../get-started/installation.md). DocsFab has no
default model. No composition in this table is eligible for release, and
each is an explicit execution path with its own
credential contract.

`nvidia-inference-gpt-6-sol-pi` is the composition that DocsFab's own
live-model CI jobs bind. Its recorded evidence is diagnostic only: a bounded
probe on September 25, 2026 returned the `harness-compatible` verdict, and
diagnostic matrix runs on an operator route, not this sealed composition,
scored 24 of 24. No acceptance, cost, or release qualification has run for
this sealed composition. Select it with
`docsfab setup --profile nvidia-inference-gpt-6-sol-pi`.

Public installations omit private Inference Hub endpoint defaults. Set the
provider's actual endpoint through `MODEL_BASE_URL` or
`host.yaml active.writing.settings.baseUrl` before selecting one of these
compositions. Keep an environment-supplied endpoint exported for later commands;
`setup --profile` does not save it. Refer to
[Select an Installed Composition](../../configure/installed-compositions.md)
for the persistent configuration procedure. No profile YAML copy is required.

`nvidia-inference-claude-sonnet-5-pi` remains installed as a
secondary option on the same route and credential. It has known workflow gaps,
tracked in issue #1428: provider stops during first-pass decomposition,
evaluation steps that do not finish within the acceptance time window, and
output truncation at its default 32,768-token output limit.

DocsFab sends `thinking: {"type": "disabled"}` on every Claude Sonnet 5
request whose reasoning is off, through the
`nvidia-inference-claude-sonnet-5-pi` composition's own route or any other
endpoint. It sends `reasoning_effort` only when you set `reasoningEffort`,
which turns reasoning on and removes the `thinking` field. With `reasoning`
set to `true` and no effort, it sends neither field, so the model's default
thinking applies; refer to
[Change a Preset's Settings](../../configure/override-model-settings.md). On this route,
Claude Sonnet 5 thinks by default when
a request has no `thinking` field. That thinking counts against the
per-request output limit but is not streamed, so one turn can spend its whole
limit and return no text. The composition's model profile declares
`reasoning: false`, and the field makes each request match that declaration.
A probe of the route on September 28, 2026 measured the following behavior:

- Without a `thinking` field, a request for a bare integer used all 16,384
  output tokens it allowed and returned no visible text.
- With `thinking` disabled, the same request used 371 output tokens and
  returned its answer.
- `reasoning_effort: "none"` was accepted and had no effect.
  `reasoning_effort: "low"` and a request for 64,000 output tokens were refused
  at once with HTTP 408.

No request that allowed more than 32,768 output tokens reached its limit, so
the composition's default output limit stays at 32,768 tokens. A
`maxOutputTokens` setting replaces it. Inference Hub Metadata reports
a 128,000-token output limit for this model, but the route measurement takes
precedence. The
`nvidia-inference-claude-opus-5-pi` composition does not send the
field, because its route behavior has not been measured.

### Inference Hub Token Limits

The NVIDIA Inference Hub records seal the context, input, and output limits
from each model's Inference Hub Metadata record, read on September 28, 2026.
A route measurement that contradicts Metadata takes precedence. The following
table lists the sealed limits.

| Composition ID | Context and input tokens | Output tokens | Output source |
| --- | --- | --- | --- |
| `nvidia-inference-gpt-6-sol-pi` | 1,050,000 | 128,000 | Metadata; the route accepted 128,000 |
| `nvidia-inference-claude-sonnet-5-pi` | 1,000,000 | 32,768 | Route measurement; Metadata reports 128,000 |
| `nvidia-inference-claude-opus-5-pi` | 1,000,000 | 32,768 | Sonnet 5 route measurement on the same gateway; Metadata reports 128,000 |
| `nvidia-inference-nemotron-3-super-v3-pi` | 1,048,576 | 32,768 | Metadata; not confirmed on the route |
| `nvidia-inference-nemotron-3-ultra-pi` | 1,048,576 | 32,768 | Metadata; not confirmed on the route |
| `nvidia-inference-qwen3-5-397b-a17b-pi` | 262,144 | 131,072 | Metadata; not confirmed on the route |
| `nvidia-inference-deepseek-v4-pro-pi` | 1,048,576 | 384,000 | Metadata; not confirmed on the route |

The package ceiling is the largest value across all records: 1,050,000 context
and input tokens and 384,000 output tokens. These limits are each composition's
defaults. A `contextWindow`, `maxInputTokens`, or `maxOutputTokens` setting
replaces the composition's value, above or below it, and DocsFab records and
warns about the difference.

`nvidia-inference-deepseek-v4-pro-pi` binds the model ID
`nvidia/deepseek-ai/deepseek-v4-pro` and carries no installed request policy.
On September 28, 2026, a probe sent that model ID 2 prompts with a 128-token
output limit and no tool prompt; both returned content without a reasoning
split. The model ID has not been checked with a tool prompt or a longer
answer. The former model ID, `azure/deepseek-ai/deepseek-v4-pro`, split its
reasoning without a control on August 26, 2026 and returned HTTP 403 on
September 28, 2026.

The NVIDIA API Catalog records do not take their limits from Inference Hub
Metadata, so their sealed limits are unchanged.

Select one explicitly on `run` or `do` with `--composition`. Without it, the
run takes the model-profile path:

```bash
docsfab run review-documentation --repo /absolute/path/to/target-repo \
  --composition nvidia-inference-gpt-6-sol-pi
```

A retired composition stays listed so that completed run records keep
rebinding to it, but selecting it for a new run stops with
`composition-retired` and names its successor. A retirement cites one of two
reasons. `provider-end-of-life` quotes the provider's notice.
`superseded-by-operator-decision` names the person, date, statement, and
record of the decision; DocsFab uses it when the provider still serves the
model. The direct OpenAI GPT-5.6 Sol composition is retired for the second
reason: the provider notice that retired GPT-5.6 in NVIDIA's Codex
environment does not cover the OpenAI API. The `composition-retired` refusal
names only the reason code and the effective date. The rest of the retirement
record stays in the installed registry as internal audit metadata.
`docsfab composition list --json` shows only the retirement `reason`,
`effectiveAt`, and optional `successorCompositionId`.

The selected model ID, endpoint identity, transport, and credential family must
match the installed composition. DocsFab rejects missing or ambiguous
credential sources and does not fall back to another composition.
Composition-execution writes stay local unless you pass `--draft-mr`.

Composition-execution results permanently report `technicalApproval: not-established`,
`roleQualification: not-established`, and `releaseEligible: false`. A run that
names `--composition` can also use `--release-gate`, `--comment-mr`, and
`--resume-from`. Without `--composition`, a run uses the composition that
`host.yaml` names, or the configured model profile; it does not make a new
approval or release claim.

## Moved Topic Links

Earlier section bookmarks lead to the canonical topic below.

<a id="change-a-presets-settings"></a>

Refer to [Override Model Settings in DocsFab](../../configure/override-model-settings.md).

<a id="read-loop-supervision"></a>

Refer to [Read-Loop Supervision in DocsFab](read-loop-supervision.md#read-loop-supervision).

<a id="settings-you-can-change"></a>

Refer to [Model Setting Precedence in DocsFab](model-settings.md#settings-you-can-change).

<a id="what-docsfab-records-and-shows"></a>

Refer to [Model Setting Precedence in DocsFab](model-settings.md#what-docsfab-records-and-shows).

<a id="what-still-stops-a-run"></a>

Refer to [Model Setting Precedence in DocsFab](model-settings.md#what-still-stops-a-run).

<a id="which-value-wins"></a>

Refer to [Model Setting Precedence in DocsFab](model-settings.md#which-value-wins).
