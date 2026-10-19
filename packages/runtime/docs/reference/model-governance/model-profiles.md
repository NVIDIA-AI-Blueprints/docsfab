# Model profile governance

DocsFab registers an operator-provisioned model endpoint. It never discovers
limits or prices during ordinary model registration or workflow execution and
does not treat successful connectivity as evidence for context length, output
length, reasoning behavior, or economics. Explicit `--catalog` inspection can
collect normalized read-only evidence for operator review.

The provider-neutral discovery, reconciliation, and approval vocabulary is
defined in [Provider-neutral model catalog contracts](model-catalog-contracts.md).
Discovery artifacts are read-only and never change this runtime profile; only a
verified operator-approved proposal can be projected into `ModelProfile`.
The end-to-end operator sequence, outage behavior, credential rotation, and
acceptance commands are collected in [Model catalog operations](model-catalog-operations.md).

## Bind the route before requesting credentials

The target composite profile binds a model identity, serving route, optional
execution harness, and DocsFab role. The current signed bundle (schema version 1)
is narrower: it binds a `policy` or `judge` purpose, model/provider/origin catalog evidence,
operator, and dates. It does not bind harness identity or writing, review,
audit, or retrieval qualification.

The applicable serving-route, harness, and interface bindings select an
evidence-adapter set. Each adapter may read only its credential family. No
credential is universal:

- Inference Hub Metadata credentials apply only to the implemented NVIDIA
  Inference API serving route plus authenticated Inference Hub Metadata
  evidence.
- Direct OpenAI and Anthropic deployments require their own provider evidence
  adapters and host-managed authentication.
- Codex and Claude Code require harness-attestation adapters that bind harness
  version, authentication/provider class, model selection, configuration, and
  tool/sandbox policy.
- NIM and embedding deployments require deployment- and interface-specific
  evidence.

Only the NVIDIA Inference API plus authenticated Inference Hub Metadata
adapter set, and the direct OpenAI and Anthropic Models retrieve adapters, are
implemented today. Separate composition-execution provider connections exist for those
routes behind Pi. Codex and Claude Code have preflight adapters that make no
model request. The Claude Code preflight is provider-offline; the Codex
preflight makes one authenticated read of the ChatGPT account's model catalog. NVIDIA API Catalog, NIM, embedding, and live native-harness
approval adapters remain unimplemented. Composition-execution surfaces establish neither
technical approval nor role qualification. See the provider-specific
model-profile approval decision record and
[Model-profile approval operations](model-catalog-operations.md).

## Generative endpoint metadata contract

Each `MODEL_*` profile, and each enabled `JUDGE_*` profile, supplies the same
fields. Replace `MODEL` with `JUDGE` for the optional judge:

| Field | Meaning |
| --- | --- |
| `*_PROVIDER` | Local provider-registration name. |
| `*_BASE_URL` | HTTP(S) endpoint URL. |
| `MODEL_ID` / `JUDGE_MODEL_ID` | Provider model identifier. |
| `*_API_FORMAT` | Selected format; currently `chat_completions`. |
| `*_API_KEY` | Runtime credential; never printed by diagnostics. |
| `*_CONTEXT_WINDOW` | Configured positive context limit. |
| `*_MAX_INPUT_TOKENS` | Optional independent positive input limit, no larger than context; legacy profiles use a compatibility default equal to context. The request estimate plus reserved framing must fit. |
| `*_MAX_OUTPUT_TOKENS` | Configured positive output limit, no larger than context. |
| `*_API_MIN_OUTPUT_TOKENS` | Positive downstream API minimum; 16 for Responses-compatible translation. |
| `*_CONTEXT_RESERVE_TOKENS` | Positive request headroom reserved before output budgeting. |
| `*_REASONING` | Whether the approved profile supports reasoning. |
| `*_INPUT_TYPES` | Comma-separated `text` and optional `image`; text is required. |
| `*_SUPPORTS_DEVELOPER_ROLE` | Developer-role compatibility flag. |
| `*_SUPPORTS_REASONING_EFFORT` | Reasoning-effort compatibility flag. |
| `*_COMPATIBLE_API_FORMATS` | Comma-separated formats supported by the profile. |
| `*_INPUT_COST_PER_MILLION` | Approved input rate or `unknown`. |
| `*_OUTPUT_COST_PER_MILLION` | Approved output rate or `unknown`. |
| `*_CACHE_READ_COST_PER_MILLION` | Approved cache-read rate or `unknown`. |
| `*_CACHE_WRITE_COST_PER_MILLION` | Approved cache-write rate or `unknown`. |
| `*_PROFILE_APPROVED_SOURCE` | Approved HTTPS reference or `unknown`. |
| `*_PROFILE_EFFECTIVE_DATE` | Approval effective date or `unknown`. |
| `*_PROFILE_REVIEW_AFTER` | Approval review deadline or `unknown`. |

The provenance fields have additional governance rules:

- `*_PROFILE_APPROVED_SOURCE`: an HTTPS reference approved by the service owner;
- `*_PROFILE_EFFECTIVE_DATE`: the `YYYY-MM-DD` date on which that reference was
  known to apply to the configured provider and model;
- `*_PROFILE_REVIEW_AFTER`: the `YYYY-MM-DD` date after which the profile is due
  for review. It is advisory: a passed date prints `Review overdue` and changes
  no limit, capability, price, or command outcome; and
- `*_COMPATIBLE_API_FORMATS`: the formats the referenced model profile supports.

The three provenance values must either be supplied together or all be
`unknown`. DocsFab rejects partial provenance, credential-bearing or non-HTTPS
source URLs, invalid dates, future effective dates, review dates before the
effective date, and a selected API format absent from the model profile.
DocsFab currently selects `chat_completions`, which Pi names
`openai-completions` internally. The runtime repeats the compatibility check so
programmatic configuration cannot bypass environment validation.

Before every provider call, including calls after tool results, DocsFab computes
a conservative upper bound over the assembled system and skill instructions,
selected repository context, conversation, tool calls, tool results, and tool
schemas. The supported chat-completions boundary counts at least one token per
UTF-8 byte; the configured reserve covers provider framing that is not present in
that canonical projection. DocsFab requires the request estimate plus that
reserve to fit the independent effective input limit. It also subtracts both
from the effective context limit and computes the available output budget. A
requested output below the API minimum is raised only when that minimum still
fits.

If a later turn no longer fits, DocsFab may replace complete older
assistant/tool-result groups with one deterministic local evidence ledger. The
ledger retains the repository revision, context-packet digest, consulted node
IDs, tool/result digests, outcomes, and repository-relative citations, while the
most recent tool turn remains verbatim. If that evidence cannot be preserved, or
the bounded compaction/turn/tool policy is exhausted, DocsFab stops locally
before provider I/O. It never asks a model to compact its own context. The
non-retryable diagnostic contains only closed reasons, numeric budgets and
counts, and digests—not prompts, tool output, repository content, credentials, or
host paths.

`doctor` is offline unless `--live` is requested. Its profile output exposes no
secret and reports configured and effective limits, the reduction reason,
source, effective date, review date, and computed state. Policy and enabled
judge profiles appear in separate sections:

For a closed, versioned diagnostic use:

```bash
docsfab profile inspect [--judge] [--json]
docsfab profile inspect --catalog [--judge] [--json]
docsfab doctor --catalog [--judge] [--json]
```

The first command is purely local and does not instantiate either discovery
adapter. `--catalog` is the only catalog network gate. Its current
implementation is NVIDIA-specific: Inference API catalog and authenticated
Inference Hub Metadata discovery run as independent read-only attempts. For
that route only, a missing `INFERENCE_HUB_METADATA_API_KEY` or Metadata outage
cannot suppress inference-catalog evidence. The host must explicitly provide
`INFERENCE_HUB_METADATA_ORIGIN`, `INFERENCE_HUB_METADATA_PATH`,
`INFERENCE_HUB_METADATA_MODE`, optional `INFERENCE_HUB_METADATA_LABEL_PARAMETER`
(`label`, `q`, `query`, or `search`; search mode defaults to `search`),
and the slot-specific `MODEL_INFERENCE_HUB_METADATA_LABEL` or
`JUDGE_INFERENCE_HUB_METADATA_LABEL`; DocsFab never guesses these values or
follows a provider-supplied URL. Missing or invalid host configuration is
reported with a content-free source disposition. Direct-provider and harness
configurations must not populate these variables; their catalog-approval
adapters remain unimplemented.

The report includes configured, effective, observed, proposed, and approved
cells for every closed catalog field, plus reconciliation bindings and drift
reasons. An approved cell remains `unknown` unless an exact governed approval
artifact chain is verified. Existing `*_PROFILE_*` environment values are not
such a chain. Endpoint URLs, base paths, host paths, credentials, raw provider
prose, and unrelated models are excluded. Unknown profiles, and legacy stale
profiles in saved records, continue to use their configured windows or, when
unmatched, skip DocsFab context admission; inspection never changes files or
runtime configuration.

The inspection/report SHA-256 values are integrity bindings, not authentication
or operator authority. Catalog-aware reports retain the complete normalized
observation, provenance, observation-set, proposal, proposal-provenance, and
decision artifacts so their existing strict decoders can recompute the chain.
Only the separately verified #63 signed approval grant can authorize a runtime
profile change; a self-consistent inspection report cannot.

### Governed approval, apply, and rollback

`profile approve` is a two-invocation host operation. The first invocation
signs the exact catalog proposal, writes an owner-only credential-free bundle,
and renders the complete allowlisted `.env` change without modifying `.env`:

```bash
docsfab profile approve \
  --inspection /private/inspection.json \
  --proposal-sha256 <proposal-digest> \
  --effective-date 2026-08-04 \
  --review-after 2026-09-01 \
  --authority-id <operator-id> \
  --public-key /private/operator-public.pem \
  --private-key /private/operator-private.pem \
  --bundle /private/profile-approval.json
```

The inspection, key, bundle, and receipt files must be regular, nonsymlink,
owner-owned `0600` files. Every parent directory must be exact and
owner-private `0700`. Add `--resolve-conflict <field>` once for
every conflict named by the proposal, and `--judge` to operate on the isolated
judge slot.

An in-configuration-root receipt target must not be `.env`, any fixed or
dynamic profile-transaction name, or any path inside Git's administrative
directory. DocsFab reserves the exact absent final target and deterministic
stage before `.env` mutation. A later unrelated no-clobber target creation is
never overwritten; it leaves the durable transaction recoverable but
ambiguous for owner review.

DocsFab's installed, module-relative project root remains the immutable source
of skills and governed runtime assets. Profile commands, runtime configuration,
and offline diagnostics instead share a writable configuration root. By
default the configuration root is the module-relative project root; a packaged
or test host may set `DOCSFAB_CONFIG_ROOT` to one normalized absolute path.
DocsFab then reads and mutates only that root's `.env`, and places the default
run-record directory below that root, without redirecting skills or other
installed assets.

After reviewing the displayed field-level patch, run a second command using the
saved bundle. The apply invocation deliberately accepts no private key,
proposal, date, or conflict inputs and requires both exact digests:

```bash
docsfab profile approve \
  --inspection /private/inspection.json \
  --authority-id <operator-id> \
  --public-key /private/operator-public.pem \
  --bundle /private/profile-approval.json \
  --apply \
  --confirm-bundle-sha256 <bundle-digest> \
  --confirm-patch-sha256 <patch-digest> \
  --receipt /private/profile-apply-receipt.json
```

Apply changes only the selected profile allowlist. It preserves comments,
ordering, line endings, unrelated values, and credentials byte-for-byte.
Unknown rates remain the literal `unknown`; an approved numeric zero remains
zero. The policy and judge prefixes cannot cross. `.env` must be an owner-only,
untracked, nonsymlink regular file with one link, and no selected profile field
may come from the ambient environment. Git index aliases such as `.ENV`,
canonical-path aliases, and inode aliases are rejected.
An exact retry with the same bundle, confirmations, and receipt path strictly
revalidates the receipt and current postimage and returns the original receipt
without rewriting `.env`. Rollback offers the same exact-receipt replay; any
binding, root, identity, or digest mismatch is rejected.
A bundle has no review-date expiry: a passed `approval.reviewAfter` is an
advisory reminder and does not reject preparation or apply. DocsFab
authenticates a saved bundle at its signed creation instant only to recover a
transaction already durably in progress or replay its exact existing receipt.
If recovery reports no transaction or safely abandons a pre-rename transaction,
DocsFab revalidates the bundle at the trusted current time before any new
mutation; that check rejects an invalid clock or one earlier than the bundle's
creation time.

The same-directory lock coordinates DocsFab writers; it is not a claim that an
uncooperative process cannot write `.env`. Exact file identities and SHA-256
postimages therefore gate every rename and final receipt. Before rename,
DocsFab stages and fsyncs the complete receipt in its owner-private target
directory, then fsyncs an owner-only, credential-free transaction intent. The
intent binds the root, lock, exact preimage, planned postimage and temporary
inode, approval or apply receipt, preview and patch, final receipt-path digest,
and exact deterministic receipt-stage name and inode. After rename and
directory sync DocsFab publishes the receipt by a no-clobber hard link, removes
and syncs the receipt stage, removes and syncs the lock, then removes and syncs
the intent.

An exact retry claims a dead transaction without overwriting any recovery
claim. An exact preimage abandons the bound temporary and safely reruns; an
exact postimage completes or verifies the bound receipt link, including the
linked-but-stage-present crash state. Recovery itself is restartable from a
partially linked lock claim, a lock claim, or either one- or two-link
post-commit intent claim; marker and temporary cleanup retains the JSON intent
until last. Every recovery boundary reasserts the exact configuration-root
inode. The recovery namespace admits only the intent-bound environment
temporary and fixed markers, and Git must still report `.env`, every marker,
the bound temporary, and any in-root receipt stage or final receipt as
untracked and non-aliased immediately before publication or deletion. A mismatched file,
receipt, stage, marker, competing claim, live owner process, or state matching
neither image is reported as ambiguous and left for owner review. Temporary
postimages match the narrowly ignored `.env.docsfab-new-*` or
`.env.docsfab-rollback-*` patterns; the fixed lock, intent, and claim markers
are ignored as well. DocsFab never treats an orphan or crash duplicate as
ordinary evidence.

Atomicity covers whole-file replacement by cooperative DocsFab writers. The
fsynced intent and pre-staged receipt make abrupt termination recoverable even
when `.env` and the receipt directory are on different filesystems: an exact
retry classifies the bound preimage or postimage and completes only the
corresponding cleanup or receipt publication. Power-loss durability still
depends on the host filesystem honoring file and directory `fsync`. Do not
delete transaction markers blindly; a state that does not exactly match the
bound identities and digests remains ambiguous for owner review.

Rollback is also preview-first and separately authorized:

```bash
docsfab profile rollback --receipt /private/profile-apply-receipt.json
docsfab profile rollback \
  --receipt /private/profile-apply-receipt.json \
  --apply \
  --confirm-rollback-sha256 <rollback-preview-digest> \
  --rollback-receipt /private/profile-rollback-receipt.json
```

The receipt retains only credential-free targeted reverse spans, never a raw
`.env` preimage. Rollback runs only while `.env` is the exact inode and
postimage installed by that receipt. Any later owner edit, replacement, mode
change, hardlink, Git alias, or digest mismatch returns a safe refusal and
preserves the current owner file. If a post-rename recovery boundary cannot
prove one exact outcome, DocsFab reports an ambiguous rollback requiring owner
review rather than claiming success.

Standalone `profile inspect` loads and validates only the selected policy or
judge endpoint. An invalid unselected slot cannot block inspection and no dummy
cross-slot endpoint is constructed. Catalog-aware doctor continues to validate
the complete doctor configuration.

If the selected `*_API_FORMAT` is unsupported, strict runtime configuration
still fails closed. The inspection command converts that specific migration
failure into a versioned, content-free
`docsfab-model-profile-inspection-preflight` report with an
`unsupported-api-format` disposition; it does not instantiate discovery
adapters. Approved field cells remain `unknown` until a complete #63 proposal,
provenance, and operator-approval chain is supplied and verified.

Both ordinary and catalog-aware doctor output withhold endpoint and approved
source URLs. Doctor failures use closed diagnostics and never echo provider
responses, URL userinfo/query values, credential material, or absolute skill
and repository paths. `doctor --live --catalog --json` is accepted, and the
live result carries a versioned JSON evidence envelope exactly as the offline
mode does.

- `current`: complete provenance, before or after its review date;
- `stale`: recorded only by runs and reports saved before review dates became
  advisory; the loader no longer produces it; or
- `unknown`: no approved source or date is configured.

An API format absent from `*_COMPATIBLE_API_FORMATS` is `incompatible` with the
configured profile. DocsFab rejects it rather than registering or silently
rewriting it, and the migration report identifies the incompatible fields.

## Migrating an older configuration

Copy the complete `MODEL_*` block from `.env.example`, preserve the endpoint
values already provisioned by the operator, and review every capability and
limit field. The template picks no model: `MODEL_PROVIDER`, `MODEL_BASE_URL`,
and `MODEL_ID` are commented out, and until you set all three to your model's
route, DocsFab stops with a migration report that lists them as missing.
Instead of editing the fields by hand, you can run `docsfab setup` with a
provider, model, or `--profile` choice. On an internal NVIDIA host with a
legacy monolithic `.env`, `docsfab profile seed --preset azure/openai/gpt-6-sol`
writes the GPT-6 Sol selection, which uniquely matches the installed
composition `nvidia-inference-gpt-6-sol-pi`; setup selects that
composition with
`docsfab setup --profile nvidia-inference-gpt-6-sol-pi`. GPT-5.x ids are retired (#1512), and a profile naming
`switchyard/openai/gpt-5.6-sol` is refused with `composition-retired`.
Commented alternatives cover other candidates from the
Aug 2026 internal Inference Hub model evaluation.
Until an operator has approved a model-specific source, use this
provenance block:

```dotenv
MODEL_PROFILE_APPROVED_SOURCE=unknown
MODEL_PROFILE_EFFECTIVE_DATE=unknown
MODEL_PROFILE_REVIEW_AFTER=unknown
```

Keep the request-policy defaults explicit as well:

```dotenv
MODEL_API_MIN_OUTPUT_TOKENS=16
MODEL_CONTEXT_RESERVE_TOKENS=4096
```

The minimum represents the downstream API contract, not a model capability.
Change it only when the endpoint adapter's documented contract changes.

This example records absence of approval; it is not an approved metadata
source. Do not replace `unknown` with a guessed URL or date. If the judge is
enabled, migrate its `JUDGE_*` block independently. Running `docsfab doctor`
then reports all remaining fields in one credential-free diagnostic.

## Context windows and cost semantics

Unknown metadata, and legacy stale metadata in saved records, do not invent an
8,192-token DocsFab context ceiling. Unique installed-composition matches use
that composition's window. Unmatched selections leave the provider as the
ceiling. DocsFab still limits unattested input to text, disables reasoning,
developer-role, and reasoning-effort claims, and treats every price as unknown.

Pi's model registry requires numeric prices, so DocsFab supplies zero for an
unknown rate only inside that library boundary. DocsFab persists `usage.cost`
only when the profile is current and all four token rates are known. Thus an
absent cost means unknown economics, while a recorded zero requires a current
profile that explicitly records zero for every applicable rate. Provider
chargeback remains authoritative; DocsFab's derived cost is not an invoice.

## Approval and refresh

The profile owner should obtain one model-specific reference covering limits,
accepted inputs, API compatibility, reasoning behavior, and price or chargeback
rates. The service owner must approve that reference, its effective date, a
review deadline, and whether any documented zero means free service. Update all
profile fields together, run `docsfab doctor`, and use `doctor --live` only when
an authorized connectivity request is appropriate. By the review date, repeat
the approval and update the dates and values. A passed review date is advisory:
`docsfab doctor`, `docsfab profile inspect`, and the run summary print
`Review overdue`, and the profile stays current with its configured limits,
capabilities, and prices.

This repository contains no approved NVIDIA Inference Hub metadata reference,
price schedule, quota, or chargeback authority. Its example profiles therefore
use `unknown`. Closing that external governance dependency requires the NVIDIA
service owner to approve a model-specific authoritative URL, effective date,
review deadline, supported API/capability values, and pricing or chargeback
interpretation. DocsFab must not infer those facts from marketing pages or a
successful request.

## Hosted inference and local compute

With hosted inference, DocsFab runs the workflow control plane locally and
sends the bounded prompt to the configured remote endpoint. The operator must
provision endpoint access, credentials, network routing, quota, data-handling
approval, and any provider billing or internal chargeback. DocsFab does not
create an Inference Hub account or allocate hosted capacity.

For local compute, the operator must separately provision a compatible serving
runtime, model artifacts, accelerators or CPU capacity, drivers, storage, and
capacity controls, then expose the configured chat-completions endpoint to
DocsFab. DocsFab does not download weights, schedule GPUs, size hardware, or
convert hosted-provider pricing into local-compute cost. Local deployment also
does not remove the requirement for a dated profile source; the source can be
an approved internal service record published at an HTTPS location.
