# Model catalog provenance and retention

DocsFab turns the normalized catalog contracts into credential-free evidence
without treating ordinary content hashes as operator approval. The provenance
layer in `src/model/catalog-provenance.ts` remains provider- and harness-neutral.

For a direct model endpoint, approval provenance binds the provider deployment.
For a harness-managed route, a future approval must additionally bind the
harness identity and version, authentication/provider class, selected model or
alias, configuration digest, and sandbox/tool policy. The current provenance
projection does not carry those harness fields and therefore cannot authorize a
Codex or Claude Code profile today.

## Evidence boundaries

Observation provenance binds the authentic normalized observation to its
provider and model identity, safe HTTPS origin, retrieval and provider-update
times, adapter identity/version, and exact normalized field set. The provider
request path is retained only as a SHA-256 digest. The path, query, raw provider
payload, descriptions, marketing text, snippets, and unrelated catalog entries
are not durable fields.

Proposal provenance binds the authentic observation-set and observation
provenance leaves, the exact reconciled fields, and the closed reconciliation
policy ID/version. Approval evidence is a separate artifact that binds the
authentic proposal and proposal provenance to the exact approved fields,
provider, model, origin, operator, approval time, effective date, and review
date. Any change to a normalized value, source identity, request-path digest,
adapter version, or reconciliation policy changes the applicable digest.

Generic proposals created before the authenticated-source reconciler retain
policy version `1`. Proposals using the qualified-label, runtime-source,
mixed-no-authority propagation, or combined-context clamp rules require policy
version `2`. Reconciliation
decisions bind version `2` directly, including blocked decisions that have no
proposal digest. See
[Deterministic model catalog reconciliation](model-catalog-reconciliation.md).

Hashes prove consistency, not authority. Before an approval may produce runtime
or run-record evidence, a trusted host authority must sign the exact approval
evidence with Ed25519. Verification uses a host-supplied authority ID and SPKI
public key and binds the approval, proposal, provider, model, origin, purpose,
and effective/review dates. A self-consistent replacement chain signed by a
different key is rejected.

## Local retention

`src/model/catalog-artifact-store.ts` exposes only finalized allowlisted
artifacts. It has no raw-payload retention option. The selected evidence
directory must already be a real, owner-controlled `0700` directory. It is
identity-pinned with no-follow directory handles, and each JSON leaf is created
exclusively as `0600`, synced, and revalidated against its still-open descriptor
and parent chain. Symlinks, permissive roots, sparse/accessor-backed values, and
directory or leaf substitution fail closed with content-free errors.
The same boundary can retain the verified signed authorization; its private key
is ephemeral host input and is never part of any durable artifact.

Discovery credentials remain ephemeral. Repository scanning covers standalone
inference and metadata credential families, credential assignments, common
authorization/header names, cookies, and prefixed environment names. Structured
metadata scanning associates keys with values through a bounded descriptor-only
walker and never invokes getters. Error redaction removes both a credential
metadata name and its assigned value.

These additions publish scanner rule set `docsfab-local-v2`. Newly recognized
metadata tokens and metadata-key assignments have distinct, non-overridable rule
IDs, so an older generic-assignment override cannot silently authorize the wider
surface. Override evaluation accepts only the current rule set; older run-record
reports remain readable but cannot authorize a current run.

## Run records and compatibility

`createApprovedCatalogModelEvidence` verifies the complete normalized,
provenance, approval, and trusted-signature chain and checks that it projects to
the exact runtime profile and the host-selected policy or judge slot. It then delegates to the existing
`ModelProfileEvidence` projection. Consequently a run record retains only the
credential-free provider/model profile and its digest; it does not retain the
source origin or path digest, observation/proposal artifacts, operator identity,
authorization, endpoint URL, or either credential class.

The durable run-record schema is unchanged. Existing schema-v1 model-profile
evidence and its strict decoders remain backward compatible.
