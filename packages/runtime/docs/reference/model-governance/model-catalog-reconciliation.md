# Deterministic model catalog reconciliation

> **Applicability:** The v2 two-source policy on this page is specific to an
> NVIDIA Inference API runtime observation plus authenticated Inference Hub
> Metadata. It is not the universal reconciliation policy for direct OpenAI,
> direct Anthropic, Codex, Claude Code, NIM, or embedding profiles.

DocsFab reconciles normalized model-catalog observations without performing I/O,
reading credentials, or changing the current runtime configuration. The pure
implementation in `src/model/catalog-reconciliation.ts` accepts finalized
observations and their credential-free provenance leaves, closes an observation
set, and returns either a proposal plus proposal provenance or a blocked
decision. Every result retains both source observations.

## Qualified source boundary

The v2 policy accepts exactly one observation from each of these source tuples:

- authenticated Metadata: source
  `source:ihub-metadata:authenticated`, adapter
  `adapter:nvidia-inference-hub-metadata:authenticated`, version `1.0.0`; and
- runtime catalog: source `nvidia-inference-api-model-catalog`, adapter
  `adapter:nvidia-inference-api-model-catalog`, version `1.0.0`.

Public-preview Metadata, unknown adapters, wrong versions, substituted source
IDs, missing roles, and duplicate roles block with
`irreconcilable-source-role`. The runtime origin must be exactly the
`nvidia-inference-api` origin in the route registry
(`src/config/executable-route-urls.js`); a different origin blocks with
`irreconcilable-endpoint`. Normal Metadata and runtime origins are different by
design and are not treated as a conflict.

A different serving route requires its own closed qualified-source policy and
adapter identities. Operators must not satisfy this policy with synthetic
Inference Hub observations for a model that is actually served by OpenAI,
Anthropic, a harness, or a NIM deployment.

The effective provider ID and origin come from the qualified runtime source.
The effective model ID remains the runtime model ID so an approved profile is
compatible with the configured endpoint. The authenticated Metadata label is
accepted as alias evidence only when it is either that exact runtime model ID or
the exact slash-free Metadata provider prefix followed by `/` and the runtime
model ID. Prefix, suffix, case, or multi-segment-provider variants block. The
proposal binds every identity rule to both observations and all required
identity fields, so retaining the runtime ID does not discard the Metadata
label.

## Conservative field rules

Reconciliation never treats a larger or newer number as safer. Numeric
disagreements select the minimum and remain conflicting; boolean disagreements
use conjunction; compatible arrays use their intersection. Unknown capability
booleans remain unknown. Unknown pricing remains unknown rather than zero or
free. A mixture of unknown and source-unsupported evidence has no authoritative
value and propagates as unknown under a distinct v2 rule; affirmative
model-unsupported evidence still blocks. Incompatible API formats,
affirmative model-unsupported evidence,
unreconcilable identities, limit semantics, prices, currencies, or units block
with closed machine-readable reasons.

Source retrieval and provider-update timestamps remain in the observation and
provenance leaves. Reconciliation does not invent a freshness threshold: a
stale-but-authentic smaller limit still wins over a newer larger value. The host
refresh policy may separately decide that evidence is too old to approve.

Combined-context limits are reconciled across fields, not independently. For
the GPT-5.4 evidence, Metadata supplies a 1,000,000-token combined context and
the runtime catalog supplies a 1,050,000 maximum input and 128,000 maximum
output. The safe input is recomputed as:

```text
min(1,050,000, 1,000,000 - 128,000) = 872,000
```

The `combined-context-input-clamp@1` derivation binds the context, semantics,
maximum-input, and maximum-output field from every observation. Approval also
checks `maxInputTokens + maxOutputTokens <= contextWindow` using safe
subtraction, so a proposal cannot bypass the combined budget.

## Decision and provenance artifacts

Every reconciliation emits a canonical, SHA-256-addressed decision with one of
`ready`, `review-required`, or `blocked`. It binds the purpose, observation-set
digest, every observation and provenance digest, closed reasons, and the
`docsfab-model-catalog-reconciliation` policy version `2`. A blocked decision
has `proposal: null` but remains policy- and provenance-bound.

Proposal results also include finalized proposal provenance from the supplied
observation provenance leaves, and the decision binds that proposal-provenance
digest. Proposals that use the v2 identity or combined context rules require
reconciliation policy v2; existing proposals that use only the original generic
rules continue to validate under policy v1. This binding supplies exact input to
the later approval-service gate; it does not replace #64 authorization.

The v2 decision/proposal-provenance chain is the authoritative evidence for the
approved maximum-input cap. The legacy `ModelProfileEvidence` v1 run-record
projection remains readable and byte-compatible. New run records use
`ModelProfileEvidence` v2 and context-budget evidence v2 so configured,
effective, and available input limits are digest-bound. #64 must validate the
v2 reconciliation binding, require those v2 runtime evidence projections, and
preserve the separately enforced maximum-input cap when it applies a profile;
provenance-only or generic-v1 evidence is insufficient for that application
gate.

Canonical sorting makes the two-source input invariant across all four
independent observation/provenance order combinations. Strict decoding rejects
duplicate or omitted leaves,
sparse/accessor-backed arrays, extra or accessor-backed top-level input,
non-plain objects, wrong purpose, future observation-set times, tampered
digests, policy downgrades, and credential-shaped artifact IDs. The complete
closed input and completed output artifacts are scanned with DocsFab's
credential rules; failures use one generic content-free diagnostic.
