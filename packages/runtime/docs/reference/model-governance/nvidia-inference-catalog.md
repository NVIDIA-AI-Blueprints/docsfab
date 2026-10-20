# NVIDIA Inference model-catalog discovery

`src/model/nvidia-inference-catalog.ts` provides an explicit, read-only adapter
for `GET <nvidia-inference-api base URL>/models`. It is not part of model
registration or ordinary workflow execution. A caller must invoke discovery
separately and decide what to do with the normalized evidence.

The adapter accepts the configured NVIDIA runtime endpoint only when its base
is exactly the `nvidia-inference-api` base URL in the route registry
(`src/config/executable-route-urls.js`). It accepts a canonical
`nvapi-...` inference credential and rejects the distinct `ihub_api_...`
Metadata API credential before network I/O. The request URL, method, headers,
HTTPS origin, and manual redirect policy are fixed by the adapter; caller data
cannot redirect the credential to another origin.

## Normalized evidence

The selected entry must match the configured model ID exactly and uniquely.
Catalog membership records `activity=active`. The adapter allowlists only the
entry's `id`, `max_input_tokens`, and `max_output_tokens`:

- `max_input_tokens` maps only to `maxInputTokens`;
- `max_output_tokens` maps only to `maxOutputTokens`;
- a missing or null limit remains `unknown` with reason `missing`;
- `contextWindow`, capabilities, pricing, and other facts remain
  `not-authoritative` for later reconciliation.

The result contains a finalized provider-neutral catalog observation and its
credential-free provenance. Provenance retains the exact HTTPS origin,
retrieval time, adapter version, normalized fields, and a digest of
`/v1/models`. Raw response fields, unrelated models, response prose, request
headers, and credentials are never returned or retained.

## Failure and resource bounds

Discovery uses a five-second end-to-end deadline, a one-MiB streamed response
limit, at most 10,000 catalog entries, strict duplicate-key JSON parsing, and
bounded JSON depth, nodes, strings, and object fields. Redirected,
cross-origin, non-JSON, non-success, malformed, oversized, absent, and
duplicate-model responses fail closed with stable content-free codes. Rejected
and late response bodies are safely canceled without surfacing cleanup detail.

Discovery failure is independent of an already approved current profile. It
does not mutate, stale, replace, or otherwise invalidate runtime configuration.

The mocked contract suite runs normally. The live smoke is skipped unless
`DOCSFAB_LIVE_NVIDIA_INFERENCE_CATALOG_SMOKE=authorized` is set deliberately
and `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_ID` are present; it then uses
the configured runtime model and inference credential. Missing credentials or
incomplete or invalid configuration therefore skips cleanly. A live result and
any thrown adapter failure are checked to ensure the credential is absent.
