# NVIDIA Inference Hub Metadata API discovery

DocsFab's Metadata API adapter performs an explicitly requested, read-only
catalog inspection and immediately projects the selected response record into
the provider-neutral model catalog observation and provenance contracts. Raw
responses, response prose, snippets, images, unrelated records, pagination
cursors, and credentials are not part of the return type and are never offered
to the catalog artifact store.

The adapter is exported from `src/model/inference-hub-metadata.ts` as
`inspectInferenceHubMetadata`. An ordinary process start or a call with
`requested: false` does not read model-catalog credentials and does not perform
network I/O.

## Credential and endpoint boundary

Authenticated inspection reads only `INFERENCE_HUB_METADATA_API_KEY` and only
after a caller requests inspection. The value must be a distinct
`ihub_api_...` credential. An inference `nvapi-...` credential, or any other
provider credential, is never used as a fallback. A missing key returns an
optional-capability diagnostic describing how to enable inspection; it does
not stop unrelated DocsFab workflows.

The host supplies an endpoint containing:

- an exact HTTPS origin with no userinfo, path, query, or fragment;
- one relative browse, search, slim, or public-label path; and
- the closed label parameter used by that endpoint (`label`, `q`, `query`, or
  `search`). Search mode defaults to `search`; browse and slim default to
  `label`.

The NVIDIA Inference Hub Metadata service uses the operator-provided origin,
path `/api/v1/models`, mode `search`, and the default label parameter.

DocsFab constructs every page from that pinned origin and path. The metadata
credential is attached only to authenticated requests to that origin, in the
`x-api-key` header; it is never sent as `Authorization: Bearer`, which the
service rejects with 403. Requests
force manual redirect handling; redirects and response-provided next-page URLs
are rejected. An opaque response cursor may only become the encoded `cursor`
query value on the same configured path. When the transport reports a final
URL, it must equal the requested URL exactly.

## Selection, normalization, and authority

Browse/search pages may expose records under `models`, `items`, or `data`; slim
and public-label endpoints may also return one direct record. The adapter scans
all bounded pages before accepting a result. It selects a byte-exact `label`, so
`azure/openai/gpt-5.4` cannot be confused with a prefix, suffix, case variant,
or route segment. No match and more than one exact match are both closed
failures.

Authenticated records may contribute only the normalized v1 catalog fields:
provider and model identity, lifecycle status, reasoning/chat/tool and role
capabilities, input modalities, context and input/output limits, limit
semantics, pricing rates and interpretation when explicit, and provider
timestamps. Missing facts remain `unknown`. In particular, `pricing: null`
never becomes zero or free economics. A zero rate without explicit billing
semantics remains non-authoritative.

The `inference-backend` record shape is normalized as follows:

- `context_length_tokens`, `max_input_tokens`, and `max_output_tokens` become
  the context window and input and output limits.
- `provider` becomes the provider identity.
- `supports_chat`, `supports_reasoning`, and `supports_tool_use` become the
  chat API format, reasoning, and tool-use capabilities. The descriptive
  `capabilities` tag list (for example `chat` or `tool-use`) can supply a
  missing `true`, and a tag that contradicts its flag rejects the record.
- `supports_chat` and `supports_vlm` become text and image input modalities.
  If `supports_audio` or `supports_video` is `true`, the modalities stay
  unknown, because those flags do not say whether they describe input or
  output.
- `is_draft: true` becomes `draft`; otherwise `is_active` becomes `active` or
  `inactive`.
- `created_at` and `updated_at` without a UTC offset name no instant and stay
  `unknown/not-authoritative`.
- `pricing.price_1m_input_tokens`, `price_1m_output_tokens`, and
  `price_1m_cache_read_input_tokens` are validated as non-negative numbers but
  stay `unknown/not-authoritative`, because the record names no currency.
- The record `id`, descriptions, code snippets, images, tags, and other keys
  are discarded. The record states no limit semantics, so that field stays
  unknown.

The public label endpoint is descriptive evidence only. It may identify the
exact model, provider, and configured HTTPS origin, but lifecycle, capabilities,
limits, economics, and provider timestamps are all normalized as
`unknown/not-authoritative`, regardless of numerical or boolean values in the
public payload. Consequently public preview content cannot become an approved
runtime profile.

## Bounds and failure behavior

The default inspection boundary is one five-second end-to-end deadline, at most
eight pages, 100 records per page and 256 total records, one MiB per response,
at most 4,096 nonempty response chunks, and bounded cursors, JSON depth, node
count, key count, and string bytes. The
strict JSON parser rejects duplicate keys, invalid UTF-8, malformed JSON, and
unsafe numbers. Response bodies are streamed under the byte limit rather than
allocated first. Late responses are canceled after a timeout, including when
an injected transport ignores the abort signal.

All exported failures are content-free codes and fixed messages. They do not
include the endpoint URL, HTTP body, status response text, cursor, configured
label, or credential.

## Verification

Mocked coverage lives in `test/inference-hub-metadata.test.ts`. The live smoke
test is gated and skipped by default. It performs network I/O only when
`DOCSFAB_RUN_INFERENCE_HUB_METADATA_LIVE=1` is explicitly set along with:

- `INFERENCE_HUB_METADATA_API_KEY`
- `INFERENCE_HUB_METADATA_ORIGIN`
- `INFERENCE_HUB_METADATA_PATH`
- `INFERENCE_HUB_METADATA_LABEL`

The smoke test is read-only and retains only normalized observation and
credential-free provenance objects in memory. The opt-in test also requires
all listed values to be present and valid; otherwise it skips cleanly. Both
live results and thrown adapter failures are checked to ensure the Metadata
credential is absent.
