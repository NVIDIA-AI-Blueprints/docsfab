# Model-profile approval operations

This runbook covers evidence collection, qualification, approval, apply,
refresh, and rollback for policy and judge profiles. The
[model-catalog reference](model-catalog.md) defines the normative authority and
artifact boundary. The provider-specific approval decision record defines
how model, serving route, and harness compose.

## Check adapter support first

Do not begin by requesting an Inference Hub credential. First bind the exact
model, serving route, execution harness, interface/profile kind, and DocsFab
purpose. Then select every evidence adapter applicable to that composition.

| Binding class | Variant | Adapter surface | Current status |
| --- | --- | --- | --- |
| Serving route | NVIDIA Inference API | NVIDIA `/v1/models` plus host-pinned authenticated Inference Hub Metadata evidence; separate Pi composition-execution connection | Technical catalog approval and composition-execution connection implemented |
| Serving route | NVIDIA API Catalog | Exact `integrate.api.nvidia.com/v1/chat/completions` route, `DOCSFAB_NVIDIA_API_KEY`-only authentication, and Pi OpenAI-compatible connection | P0 connection and six-stage workflow execution validated; clean audit rejected the output patch; technical approval adapter not implemented |
| Serving route | Direct OpenAI API | Pi Responses connection; OpenAI Models retrieve catalog adapter (`GET https://api.openai.com/v1/models/{id}`, OpenAI credential only; no Inference Hub Metadata). Retrieve observes identity (`id`, `object`, `created`, `owned_by`) and does not observe token limits. | Composition-execution connection and identity catalog retrieve implemented; inspect/approve cannot complete a technical-approval bundle from this adapter alone |
| Serving route | Direct Anthropic API | Pi Messages connection; Anthropic Models retrieve catalog-approval adapter (`GET https://api.anthropic.com/v1/models/{id}`, Anthropic credential only; no Inference Hub Metadata). Retrieve maps `max_input_tokens` and `max_tokens`. | Composition-execution connection and technical catalog-approval adapter implemented |
| Serving route | Hosted or local NIM | NIM deployment adapter | Not implemented |
| Execution harness | Codex | Installed-CLI, ChatGPT-auth, and model-catalog preflight. The current record (0.155.1 pin) makes one authenticated account-catalog read; the retired 0.147.0 pin read only the bundled catalog, provider-offline | Preflight-only; no model request or workflow egress |
| Execution harness | Claude Code | Provider-offline installed-CLI and first-party Claude.ai-auth preflight | Preflight-only; no model or workflow egress |
| Interface/profile kind | Embedding | Embedding contract and retrieval-evidence adapter | Not implemented |

A composition can require more than one adapter—for example, direct OpenAI
serving plus Codex harness attestation. If any required adapter is not
implemented, stop and record the capability gap. Do not run the NVIDIA adapter
against another provider, substitute marketing content for authenticated
evidence, or claim that a model-only evaluation created an approvable bundle.

Composition execution and technical approval are different state machines. An
implemented provider connection can run only under the explicit composition
execution ceiling without making the route technically approvable. A successful native
preflight establishes only bounded CLI readiness. Both retain
`technicalApproval: not-established`, `roleQualification: not-established`,
and `releaseEligible: false`.

## Inspect the installed composition package

List the digest-locked, credential-free composition summaries:

```bash
docsfab composition list
docsfab composition list --json
```

Records whose status is `active` and whose class is `pi-provider` are
executable behind the common Pi harness: the direct-provider record
`anthropic-claude-opus-4.7-pi`,
the three NVIDIA API Catalog Nemotron 3 lanes
(`nvidia-nemotron-3.5-lightning-30b-a3b-pi`,
`nvidia-nemotron-3-super-120b-a12b-pi`,
`nvidia-nemotron-3-ultra-550b-a55b-pi`), and the
`nvidia-inference-*` Inference API lanes. The Nemotron, Qwen, and DeepSeek
lanes are reasoning-split SKUs carrying the measured `chat-template-kwarg`
request policy. `nvidia-inference-claude-sonnet-5-pi` (a secondary
record since #1460; its gaps are tracked in #1428) and
`nvidia-inference-claude-opus-5-pi` are Anthropic Claude via Bedrock
through the Inference Hub (the sanctioned programmatic Claude path at NVIDIA)
and carry no installed request policy, because they are not reasoning-split and
the policy's Nemotron control and fixed sampling are alien to them.
`nvidia-inference-gpt-6-sol-pi` is OpenAI GPT-6 Sol through the
Inference Hub, and the live-model CI jobs bind it through
`LIVE_MODEL_CI_COMPOSITION_ID`. It is not a setup default; setup has none. Its probe verdict is
`harness-compatible`, so it also carries no installed request policy. The list
is the installed registry, not an approval statement.

The NVIDIA API Catalog records bind one exact model each, disable reasoning
with the installed request policy measured for that SKU, and accept only
`DOCSFAB_NVIDIA_API_KEY`. They do not inspect `MODEL_API_KEY`,
`NVIDIA_API_KEY`, or `NGC_API_KEY`, and they remain technically unapproved.

## Probe, then draft, then reseal

Adding a Hub or OpenAI SKU is an explicit live-gated probe, a composition-shaped
draft, a digest reseal, and an operator select. It is not six parallel files
and not an automatic registry merge. Prefix matchers such as `gpt-5` and `o1`
are rejected. Observation fields stay at verdict plus locator. Hub Metadata is
not a universal credential. Replace `MODEL_ID` with the exact model ID that
the route serves:

```bash
docsfab profile probe --route nvidia-inference-api --model MODEL_ID
docsfab profile probe --route nvidia-inference-api --model MODEL_ID --live --json
docsfab profile draft --route nvidia-inference-api --model MODEL_ID \
  --verdict harness-compatible --json
```

The default probe does not spend. `--live` wraps
`scripts/model-matrix/probe-core.mjs`, the same stack as `probe-models.mjs`.
Draft does not write `composition-registry.json`. After an authorized paste:

```bash
node --import tsx scripts/reseal-composition-digests.mts
npm run check:composition-digests
```

GPT Astra and extra Nemotron SKUs are later instances of this recipe. Do not
check them in from the probe or draft command.

### Retired records

A retired record stays in the registry so completed run records keep
rebinding to its exact digests; selecting it for a new run, preflight, or
native pilot fails closed with `composition-retired`. Its `retirement` block
names one of two reasons, and each reason carries exactly its own evidence:

| Reason | Use when | Required evidence |
| --- | --- | --- |
| `provider-end-of-life` | The provider stopped, or announced it will stop, serving the model on this route. | `providerNotice`: the provider's own statement, bounded and single-line. |
| `superseded-by-operator-decision` | The provider still serves the route, but an accountable operator withdrew it. | `decision`: `decidedBy`, `decidedAt`, `statement`, and `record` (where the decision is written down). |

Never record `provider-end-of-life` for a route the provider notice does not
cover, and never use a decision record to stand in for a provider notice.
Both reasons carry `effectiveAt` and may name `successorCompositionId`; the
refusal's `Next action` then names that successor. The record also adds its
reason to `limitations`, and `scripts/check-model-compositions.mjs` pins each
retired id to its reason and successor.

| Retired record | Reason | Effective | Successor |
| --- | --- | --- | --- |
| `nvidia-llama-3.3-nemotron-super-49b-v1.5-pi` | `provider-end-of-life` | 2026-08-26 | None |
| `openai-gpt-5.6-sol-codex-preflight` | `provider-end-of-life` | 2026-09-30 | `openai-gpt-6-sol-codex-preflight` |
| `openai-gpt-5.6-sol-pi` | `superseded-by-operator-decision` | 2026-09-28 | `nvidia-inference-gpt-6-sol-pi` |

The Codex retirement quotes NVIDIA's notice, forwarded by Lawrence Lane on
2026-09-28: GPT-5.6 Sol, Terra, and Luna are disabled in NVIDIA's Codex and
ChatGPT Work environment effective September 30. The notice records a
date without a time zone, so `effectiveAt` is 2026-09-30T00:00:00.000Z. It
does not cover the OpenAI API or Inference Hub, so the direct OpenAI record
cites Lawrence Lane's decision of 2026-09-28 ("literally everything should
switch to gpt-6", #1512) instead. The same decision retired the
`switchyard/openai/gpt-5.6-sol` shortcut, its raw profile model id, and the
GPT-5.x presets, which were never registry records; they refuse with the same
code through `src/setup/retired-selections.ts`.

`nvidia-llama-3.3-nemotron-super-49b-v1.5-pi` has status `retired`.
NVIDIA ended `nvidia/llama-3.3-nemotron-super-49b-v1.5` on the API Catalog
route at 2026-08-26T09:00:00Z; the route answers HTTP 410 Gone for it
(observed 2026-09-10). The record stays in the registry, with a `retirement`
block carrying the reason, the instant, and the provider notice, so completed
run records keep rebinding to its exact digests. `docsfab composition list`
shows `retired (provider-end-of-life 2026-08-26)`, and selecting the record
for a new run fails closed with `composition-retired` and the same reason in
the message.

Retiring a record is a registry edit followed by a digest re-seal:

```bash
npm run check:composition-digests          # before: proves the digest rule on committed data
# edit composition-registry.json: status -> retired, add the retirement block
# and the reason to limitations; move the id to EXPECTED_RETIRED
node --import tsx scripts/reseal-composition-digests.mts
npm run check:composition-digests          # after: proves the re-sealed chain is consistent
npm run check:model-compositions           # pins each retired id's reason and successor
```

The decoder refuses a half-applied retirement: `status: retired` without a
`retirement` block, or a `retirement` block on a live record, is a contract
error. A retired record is never removed while any retained evidence names it.

A sealed host activation policy is not gated by the registry: the hosted
invoker executes the execution profile sealed into the policy, so a project
activated on the retired composition fails at its first provider request with
the provider's 410 until it is re-activated on a different composition.

The package also contains two native-harness preflights. Neither makes a
model request or runs a workflow. The Claude Code preflight is
provider-offline. The current Codex preflight is not: it makes one
authenticated read of the ChatGPT account's model catalog. No model request, prompt, repository content, or credential is sent to Codex; the only provider contact is one authenticated catalog read.


```bash
docsfab composition preflight \
  --composition openai-gpt-6-sol-codex-preflight

docsfab composition preflight \
  --composition anthropic-claude-opus-4.7-claude-code-preflight
```

Each Codex record pins its Codex CLI version through its adapter record
version. `openai-gpt-6-sol-codex-preflight` binds the 1.1.0 Codex adapters,
which pin `codex-cli 0.155.1`. The retired GPT-5.6 record and the frozen
cross-harness pilot keep the 1.0.0 adapters and `codex-cli 0.147.0`. Moving a
pin adds adapter records at a new version with policy digests derived from
checked-in policy bodies in `src/native-compositions/cli.ts`, then reseals
with `scripts/reseal-composition-digests.mts`, which also reseals the adapter
registry. A Codex that reports any other version stops with
`executable-drift`.

Each pin also names the catalog that decides model availability. The 0.147.0
pin reads the catalog bundled in the CLI (`codex debug models --bundled`,
observation source `codex-bundled`), which is provider-offline. The 0.155.1 bundled catalog is stale and
lacks `gpt-6-sol`, so that pin reads the authenticated account catalog
(`codex debug models`, source `codex-account`), which is what NVIDIA's Codex
environment serves. That read contacts the provider with the operator's
ChatGPT session, so the 0.155.1 preflight is not provider-offline; it is
still preflight-only. No model request, prompt, repository content, or credential is sent to Codex; the only provider contact is one authenticated catalog read. That read
makes Codex write `models_cache.json` and `cloud-config-bundle-cache.json`
in its own home (`~/.codex/`); DocsFab writes nothing to its own state for
it. The account catalog is read only after authentication is
`ready`; an unready login stops with `authentication-mismatch` and never falls
back to the bundled catalog. A catalog that does not list the requested slug
stops with `model-unavailable`. Both catalogs share the
`nativePreflight.catalogStdoutBytes` capture ceiling.

The preflight commands inspect only bounded executable, version,
authentication, and catalog observations. They cannot invoke a model, read a
target repository, run a workflow, or create profile-approval evidence.

Completed composition-execution write runs can be compared provider-offline with
`docsfab composition compare --record <absolute-run-record> --record
<absolute-run-record>`. The comparison first rebinds every record to this
installed composition package, then requires identical workflow, repository,
task, quality, skill, context, and budget inputs. It exposes performance
metrics but does not invent a quality-efficacy winner when the admitted records
lack a comparable quality projection.

## Run the acknowledged cross-harness development pilot

The cross-harness pilot compares complete execution compositions, not models in
one common harness. It uses authenticated Codex and Claude Code sessions plus a
fresh, already-completed Nemotron Pi run against the packaged routing fixture.
Its evidence is permanently `development-only-uncontained` on Darwin.

Configure canonical absolute executable paths in the host-owned `.env`:

```dotenv
DOCSFAB_CODEX_EXECUTABLE=/absolute/path/to/codex
DOCSFAB_CLAUDE_EXECUTABLE=/absolute/path/to/claude
DOCSFAB_PYTHON_EXECUTABLE=/absolute/path/to/python3
DOCSFAB_STATE_DIR=/absolute/owner-private/state/runs
```

The pilot loads `.env` from `DOCSFAB_CONFIG_ROOT` through the standard DocsFab
environment loader before resolving these executables. Values already present
in the process environment take precedence over the file.

Keep `DOCSFAB_STATE_DIR` outside both the installed DocsFab package and the
target/source repository. DocsFab creates a sibling replay registry there and
atomically consumes each admitted Nemotron evidence identity. Reusing the same
Nemotron evidence in another campaign fails before native model egress.

Create an empty `0700` campaign directory. The two `--forbidden-root` values
are not caller-selected decoys: they must resolve exactly to the installed
DocsFab package root and the source root recorded in the strict Nemotron run.
The Nemotron record must bind this fixture's source tree, 65,536-token envelope,
context packet, six ordered skills, bundle identities, and tool policies.
The corpus `contextSha256` binds the frozen context-source descriptor; it is not
a runtime packet digest. Before provider egress, DocsFab independently
recomputes each executed step's `LocalContextPreflightService` packet in an
owner-private temporary cache and requires the ordered record digests to match.
For a changed-document run, supply both `--nemotron-patch` and
`--nemotron-document`; the document must match the nonempty patch. For a failed
run, pass only the artifacts that the unmodified terminal record actually
retained. Trailing pending steps remain in that record. For an observed
successful no-op, supply the retained zero-byte patch or omit the patch, and
omit the document. DocsFab records `no-document-change` as a terminal campaign
failure, ignores a supplied document path for that no-op, and does not retry it.

```bash
docsfab composition pilot-campaign \
  --corpus routing-task-guide-v1 \
  --campaign-root /absolute/private/campaign \
  --nemotron-record /absolute/private/nemotron-run.json \
  --nemotron-patch /absolute/private/nemotron.patch \
  --nemotron-document /absolute/private/docs/routing/guide.md \
  --forbidden-root /absolute/installed/docsfab \
  --forbidden-root /absolute/frozen/source \
  --acknowledge-development-only-uncontained \
  --json
```

DocsFab first validates the local Nemotron evidence and completes both
native preflights of the frozen campaign (the 0.147.0 Codex pin and Claude
Code, both provider-offline). Only after both preflights pass does it
durably claim the Nemotron evidence and launch either native attempt. A failed
second preflight therefore launches neither model and consumes no replay
identity. Native attempts still use zero automatic retries. A failed native
attempt remains in the terminal reliability report; it does not erase
successful attempts or abort report creation.

The post-run technical, editorial, audience, layered, and quality artifacts are
host-derived, unattested agent proxies over already-blinded deterministic
evidence. They are not independent human or agent sessions, cannot make an
output pass the comparison bar, and leave
`qualityComparisonStatus: proxy-evaluation-incomplete` and
`commonEvaluationEstablished: false`. The report never ranks compositions.

Preflight errors are content-free codes. Correct `environment-invalid` by
configuring all three executable paths; `forbidden-root-mismatch` by supplying
the two derived roots; `nemotron-freshness` by rerunning Nemotron on the frozen
fixture; and `replay-root-invalid` by moving owner-private state outside the
campaign and forbidden roots. Do not retry unchanged evidence after a replay or
freshness rejection.

## Prepare private configuration

1. Copy the complete `MODEL_*` block from `.env.example` into an owner-only,
   Git-ignored `.env`. The template picks no model, so set `MODEL_PROVIDER`,
   `MODEL_BASE_URL`, and `MODEL_ID` to the selected route; until all three are
   set, DocsFab stops and lists them as missing. Alternatively, run
   `docsfab setup` with a provider, model, or `--profile` choice, or, on an
   internal NVIDIA host with a legacy `.env`, run
   `docsfab profile seed --preset azure/openai/gpt-6-sol`. Set
   `JUDGE_ENABLED=true` and configure the complete `JUDGE_*` block only when
   the semantic judge is required.
2. Keep every `*_PROFILE_*` value and unverified price set to `unknown`.
3. Configure the inference or harness authentication required by the selected
   route in its host-managed location.
4. Configure discovery or attestation credentials only for the selected
   evidence adapter set.
5. Run the offline commands first:

   ```bash
   docsfab profile inspect --json
   docsfab doctor
   ```

The policy slot is the default. Add `--judge` to inspect the judge slot. An
offline inspection describes configured and effective values; it does not
invent provider authority.

## Collect route-specific evidence

### NVIDIA Inference API route with Inference Hub Metadata

This NVIDIA Inference API plus Hub Metadata tuple is the implemented
two-source technical-approval adapter. Direct OpenAI and Anthropic use
separate single-source catalog adapters, documented below. The separately
installed NVIDIA API Catalog route has composition execution but cannot supply
this two-source approval evidence. Configure the exact
host-owned Metadata origin, path, mode, label parameter, and slot-specific
label. Use a distinct `ihub_api_` Metadata credential. The NVIDIA inference
credential remains separate in `MODEL_API_KEY` or `JUDGE_API_KEY`. The NVIDIA
Inference Hub Metadata service uses the operator-provided origin, path
`/api/v1/models`, and mode `search`. Leave the label parameter unset, so
search mode sends `search`. The adapter sends the Metadata key as `x-api-key`;
the service answers 403 to the same key sent as `Authorization: Bearer`.

```bash
umask 077
docsfab profile inspect --catalog --json \
  > /owner-private/policy-inspection.json
docsfab profile inspect --catalog --judge --json \
  > /owner-private/judge-inspection.json
```

`INFERENCE_HUB_METADATA_API_KEY` belongs only to this adapter. It is not a
prerequisite for direct OpenAI, direct Anthropic, Codex, Claude Code, NIM, or
embedding profiles.

### Direct providers and agent harnesses

Direct OpenAI and Anthropic have composition-execution provider-connection adapters and
catalog retrieve adapters. Anthropic Models retrieve maps `max_input_tokens`
and `max_tokens`, so inspect and approve can complete. OpenAI Models retrieve
observes identity only and does not observe token limits, so approval stays
fail-closed on that adapter. Catalog inspection on those serving
routes reads the provider Models retrieve surface and the bound OpenAI or
Anthropic credential. It never reads `INFERENCE_HUB_METADATA_API_KEY` and
never runs the NVIDIA two-source reconciliation policy.

NVIDIA API Catalog (`integrate.api.nvidia.com`), hosted or local NIM, and
embedding/retrieval profiles remain unimplemented approval gaps. Do not treat
the new OpenAI or Anthropic adapters as substitutes for those routes.

Codex and Claude Code have preflight adapters (no model request) that bind
the installed harness and safe authentication or catalog observations. Live
harness execution still needs a separately contained adapter that binds the
harness version, authentication/provider class, selected model or alias,
configuration digest, and sandbox/tool policy. A harness login is not an
Inference Hub login. Preflight observations still cannot produce a verified
harness approval bundle.

## Reconcile technical evidence

Review every configured, effective, observed, and proposed field. Resolve drift
using the reconciliation policy for the selected adapter set. The current
two-source v2 policy applies only to the NVIDIA Inference API plus authenticated
Inference Hub Metadata tuple.

Technical approval and role qualification are separate:

- technical approval verifies identity, route, compatibility, limits,
  deployment policy, provenance, authority, and review dates;
- qualification measures whether the model/route/harness combination passes a
  named writing, review, judge, audit, or retrieval workflow.

The v1 bundle carries only the `policy` or `judge` purpose and technical catalog
approval. It does not bind harness identity or a writing, review, audit, or
retrieval qualification. Do not delay technical approval merely to imply that
the bundle certifies workflow quality; full qualification may require the
approved limits to run representative workloads.

## Preview, sign, and apply

The first invocation signs the exact proposal, writes an owner-only,
credential-free bundle, and renders the allowlisted `.env` change without
modifying `.env`:

```bash
docsfab profile approve \
  --inspection /owner-private/policy-inspection.json \
  --proposal-sha256 <proposal-digest> \
  --effective-date <YYYY-MM-DD> \
  --review-after <YYYY-MM-DD> \
  --authority-id <operator-id> \
  --public-key /owner-private/operator-public.pem \
  --private-key /owner-private/operator-private.pem \
  --bundle /owner-private/profile-approval.json
```

Add `--resolve-conflict <field>` once for every conflict named by the proposal,
and `--judge` for the isolated judge slot. Review the field-level patch, then
apply the exact saved bundle:

```bash
docsfab profile approve \
  --inspection /owner-private/policy-inspection.json \
  --authority-id <operator-id> \
  --public-key /owner-private/operator-public.pem \
  --bundle /owner-private/profile-approval.json \
  --apply \
  --confirm-bundle-sha256 <bundle-digest> \
  --confirm-patch-sha256 <patch-digest> \
  --receipt /owner-private/profile-apply-receipt.json
```

Inspection, keys, bundle, and receipt must be regular nonsymlink files under
owner-private `0700` directories with file mode `0600`. Keep private keys,
credentials, endpoints, private bundles, and host paths out of repositories,
prompts, and run records.

## Verify the applied profile

```bash
docsfab doctor
docsfab profile inspect --json
```

`doctor --live` sends an authorized connectivity request and remains a separate
decision.

## Qualify the intended role

After technical apply and verification, run frozen repositories, tasks, skills,
quality packs, and score thresholds for each intended role. Record exact model,
serving route, harness, and revision-bound run evidence. Do not generalize one
passing role to every workflow.

External coding-agent harnesses use the separate internal harness
qualification contract.
Strict qualification remains blocked while descendant containment is
unavailable. The acknowledged development pilot above is a distinct,
permanently uncontained evidence class; its exact tool-denial preflight and
terminal observations do not convert it into qualification evidence. The
deterministic scorer can produce only `qualification-candidate`, pending a
separately authorized finalizer. None of these artifacts is a provider metadata
observation or a v1 approval bundle.

A technically current profile must be recorded as unavailable to a role until
its role qualification passes. Qualification evidence remains separate from
the v1 private bundle. Automated purpose-scoped selection and a composite
credential-free lock remain planned.

The relocatable v1 qualification kit verifies the historical v1 governed
inputs from its frozen repository snapshot. Current skill bytes are excluded
from that approval and require separately versioned requalification before they
can establish role availability. The kit lock binds its revision to the actual
snapshot source coordinates and the generated runner input; payload paths alone
are not source provenance.

## Retain a safe repository lock

The owner-private approval bundle and receipt are not repository artifacts. A
tracked approved lock may retain only credential-free bindings such as the
candidate ID, model/route/harness identity, qualification status, bundle and
receipt digests, authority ID, effective date, and review date. The approved
lock projection is planned; candidate files remain `not-approved` until that
separate mechanism exists.

## Refresh and rotate credentials

By the review date, produce new route-appropriate observations and a new
approval bundle. The review date is an advisory reminder, not an expiry: after
it passes, `docsfab doctor`, `docsfab profile inspect`, and the run summary
print `Review overdue`, and the applied profile and its bundle stay valid.
Requalify when the model, serving route, harness, relevant capability, workflow,
skill, or quality threshold changes.

Rotate inference and harness credentials in their host secret stores. A
credential rotation alone does not authorize new limits, capabilities, dates,
or roles.

## Roll back

Preview rollback from the exact apply receipt, then confirm its digest:

```bash
docsfab profile rollback --receipt /owner-private/profile-apply-receipt.json
docsfab profile rollback \
  --receipt /owner-private/profile-apply-receipt.json \
  --apply \
  --confirm-rollback-sha256 <digest> \
  --rollback-receipt /owner-private/profile-rollback-receipt.json
```

Run offline doctor after rollback.

## Verify the implemented NVIDIA lifecycle

The deterministic, credential-free campaign covers the currently implemented
NVIDIA policy and judge lifecycle:

```bash
npm run acceptance:catalog
```

The two NVIDIA live checks remain skipped unless their explicit opt-in gates
and host configurations are present:

```bash
DOCSFAB_LIVE_NVIDIA_INFERENCE_CATALOG_SMOKE=authorized npm test -- \
  test/nvidia-inference-catalog.test.ts

DOCSFAB_RUN_INFERENCE_HUB_METADATA_LIVE=1 npm test -- \
  test/inference-hub-metadata-live.test.ts
```

Those live checks prove only the NVIDIA adapters. Direct OpenAI and Anthropic
catalog-approval adapters have separate provider-offline tests. Future
harness adapters still need their own offline acceptance and opt-in live
gates.

The installed direct-provider, native-preflight, and cross-harness pilot
contracts have focused provider-offline tests. This runbook documents how to
produce a live development pilot; it does not claim that one has run, that its
proxy evaluation is complete, or that it creates approval or release evidence.
