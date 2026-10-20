# Provider-neutral model catalog contracts

DocsFab separates read-only discovery from runtime trust. A provider adapter may
produce a normalized observation, reconciliation may produce a proposal, and an
operator may approve that exact proposal. Only the verified approval can be
projected into the existing runtime `ModelProfile`; neither an observation nor a
proposal changes effective model limits.

Provider-neutral does not mean provider-blind. Before discovery, the host
selects the model identity, serving route, and DocsFab `policy` or `judge`
purpose. The applicable serving-route, harness, and interface bindings select
an evidence-adapter set; each adapter may read only its credential family. The
v1 artifacts bind the model/provider/origin and purpose fields but do not carry
an execution-harness identity or workflow-role qualification. An Inference Hub
adapter cannot attest a direct OpenAI or Anthropic deployment; a model-only
observation cannot attest Codex or Claude Code harness behavior.

The v1 contracts live in `src/model/catalog-contracts.ts` and are independent of
NVIDIA, Pi, environment files, credentials, and HTTP response shapes. Policy and
judge models use the same artifacts and validators. Their `purpose` binding
prevents an approval for one slot from being replayed for the other.

## Artifact sequence

1. `docsfab-model-catalog-observation` records one adapter's allowlisted facts,
   adapter identity/version, and retrieval time.
2. `docsfab-model-catalog-observation-set` closes one host discovery boundary
   over the complete ordered set of observation IDs and digests.
3. `docsfab-model-profile-proposal` binds that exact discovery-set digest and
   its authentic leaves, then records how every field was selected or
   reconciled.
4. `docsfab-operator-approved-model-profile` binds one proposal, operator,
   effective date, review deadline, and the exact approved fields.

All four artifacts are closed, schema-versioned, canonically serialized, and
SHA-256 addressed. Decoding bytes uses the strict JSON evidence parser, which
rejects duplicate keys, invalid UTF-8, unsafe numbers, and ambiguous JSON.
Validation also rejects extra nested keys, sparse or accessor-backed arrays,
duplicate set members, invalid timestamps, credential-bearing origins, and
future schema or rule versions.

Proposal validation requires the host-selected discovery-set artifact and the
actual observation objects. Digest strings and field references declared inside
a proposal are never accepted as standalone evidence. Every discovery-set
observation must contribute to every reconciled field, and each closed rule is
recomputed before the proposal is accepted. Credential-free provenance and
signatures can trust the set digest as the discovery completeness boundary; a
proposal cannot substitute a smaller caller-selected array. This prevents an
inconvenient source from disappearing or a larger limit from winning merely
because it is newer.

## Normalized fields and states

Every observation and proposal contains every field in the v1 allowlist:

- identity and boundary: model ID, provider ID, and exact HTTPS origin;
- lifecycle: activity;
- limits: context window, maximum input, maximum output, and limit semantics;
- compatibility: input modalities, API formats, reasoning, tool use, system and
  developer roles, and reasoning effort;
- economics: input, output, cache-read, and cache-write prices plus billing
  interpretation; and
- provider creation and update timestamps. Retrieval time belongs to the source
  envelope rather than being confused with provider time.

Each field has exactly one state:

- `observed` carries a typed value;
- `unknown` carries only a closed reason (`missing`, `not-authoritative`, or
  `source-unavailable`);
- `conflicting` retains at least two canonically distinct candidates; or
- `unsupported` records either an affirmative model capability disposition or
  that a particular source does not expose the field; it is not silent
  omission.

Unknown never has a value. It is not serialized as `false`, zero, `null`, an
empty list, unsupported, or free. Price amounts use non-negative integer
microunits with an explicit currency and `per-million-tokens` unit. Therefore an
observed zero rate remains distinguishable from missing economics and avoids
floating-point ambiguity.

## Reconciliation and approval

Proposals may use only the closed, versioned rules exported as
`MODEL_CATALOG_RECONCILIATION_RULES`: exact selection/consensus, minimum numeric
value, boolean conjunction, array intersection, preference for one consistent
observed value across complementary missing/source-unsupported evidence,
propagation of unknown or unsupported, and unresolved conflict. A
`model-unsupported` disposition cannot be ignored by the complementary-source
rule. Policy v2 adds propagation of mixed unknown/source-unsupported evidence
as unknown, exact qualified-label validation, the authenticated runtime
boundary selection, and a combined-context input clamp whose derivation includes
context, input, output, and semantics from every observation. The proposal
retains both the result and the exact observation/field
inputs. Rules and inputs are sorted before hashing, so pagination and response
order do not change artifact bytes.

A conflicting proposal remains visibly conflicting even when a rule calculates
a conservative candidate. Approval may explicitly select that exact candidate;
it cannot introduce a value the proposal did not derive. Approval rejects an
inactive or ambiguous identity, unresolved conflicts, non-combined limit
semantics, missing text or generative API-format compatibility, an input plus output
budget larger than the combined context, incoherent limits, or a
price without an observed billing interpretation. Signature, credential-free
provenance, local retention, revocation, and configuration apply remain separate
governed layers. The next layer is described in
[Model catalog provenance and retention](model-catalog-provenance.md).

The pure v2 selection rules and decision artifact are described in
[Deterministic model catalog reconciliation](model-catalog-reconciliation.md).

Provider adapters remain explicit read-only producers of these contracts. The
[NVIDIA Inference model-catalog adapter](nvidia-inference-catalog.md) documents
the fixed-origin `/v1/models` boundary, allowlisted limit mapping, resource
bounds, and opt-in live smoke gate.

The currently implemented catalog-aware CLI composes NVIDIA Inference API
discovery with authenticated Inference Hub Metadata, or a single-source
direct OpenAI or Anthropic Models retrieve adapter, from the bound serving
route. Codex, Claude Code, NIM, NVIDIA API Catalog, and embedding
**catalog-approval** adapters remain planned. The separate direct-provider
composition-execution connections and native-harness preflights (no model request; the
Codex preflight makes one authenticated account-catalog read) do not emit
technical catalog authority. Each approval adapter must emit the same
normalized evidence without borrowing another route's credentials or
authority.

## Runtime projection

`projectApprovedModelProfile` preserves the current `ModelProfile` boundary.
Current approvals project supported inputs, API formats, limits, capabilities,
and USD rates. Unknown capabilities project only conservative runtime behavior;
they do not become evidence that a capability is false. Unknown or non-USD
prices project to `null`, preserving unknown economics. After `reviewAfter`, the
projection is unchanged and stays `current`: the review date is an advisory
reminder, and the projection never invents an 8,192-token host context
ceiling.

The selected DocsFab runtime API is `chat_completions` or `messages`. A
responses-only proposal is retained as normalized catalog information but
cannot be silently mapped into the existing runtime profile.
