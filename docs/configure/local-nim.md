---
title: Use a Local NIM With DocsFab
description: Connect DocsFab to the OpenAI-compatible endpoint of an NVIDIA NIM container on the same machine.
status: draft
content.type: how-to
---

Connect DocsFab to an NVIDIA NIM container running on your GPU host.
The endpoint can use plain HTTP when it stays on this machine's loopback
interface.

## Prerequisites

- Install DocsFab and prepare the GPU host required by the NIM you use.
- Obtain the container startup instructions and model ID from that NIM's
  documentation. The model must support streaming and native tool calling.

## Steps

1. Start the NIM container as its documentation describes and publish its
   OpenAI-compatible API port on the loopback interface only, for example with
   `-p 127.0.0.1:8000:8000`. A bare `-p 8000:8000` publishes the API, which does
   not require authorization, on every network interface of the host. The API is
   then available at `http://localhost:8000/v1`.

2. Select the OpenAI-compatible provider with the Chat Completions API and the
   local endpoint. Replace `MODEL_ID` with the model name that the container
   serves, which `curl http://localhost:8000/v1/models` lists:

   ```bash
   docsfab setup --provider openai-compatible --api openai-chat-completions \
     --model MODEL_ID --endpoint http://localhost:8000/v1
   ```

   Setup still requires `COMPATIBLE_API_KEY`. If your local server does not check
   authorization, enter a long random value at the hidden prompt, for example the
   output of `openssl rand -hex 32`. Do not use a short word such as `none`.
   DocsFab refuses any model request whose content contains the key, so a common
   word can stop ordinary prompts. DocsFab sends the key and model requests over
   plain HTTP only to a loopback host.

3. Run `docsfab doctor` to validate the configuration without a model request.
   Run `docsfab doctor --live` to send one connectivity request to the local
   server. These commands check readiness and connectivity; they do not prove
   that a documentation workflow succeeds.

## Local Connection Behavior

DocsFab sends plain HTTP model requests over a direct connection to this
machine. It ignores `HTTP_PROXY`, `NODE_USE_ENV_PROXY`, and other proxy
settings for them, so the key and prompts never pass through a proxy in
cleartext. Requests stay on the exact configured origin, and a response that
redirects to any other origin, including another local port, stops the
request. For `localhost`, DocsFab accepts only loopback addresses, both when it
opens the model connection and on every network connection. If your host
resolves `localhost` anywhere else, `docsfab doctor` and model commands stop
with `model-endpoint-insecure-transport`; use `http://127.0.0.1:8000/v1`
instead.

## Related Topics

- [Configure the Model](model.md)
- [Check DocsFab Readiness](../manage/check-readiness.md)
