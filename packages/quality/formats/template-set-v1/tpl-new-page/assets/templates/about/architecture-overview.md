---
title: "Architecture Overview for [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

<!-- @tpl:naming
Keep this `architecture-label` target. Other about/ pages link here with `{ref}` using this exact label, so renaming or deleting it silently breaks those inbound cross-references.
-->

(architecture-label)=
# Architecture Overview for [Product Name]
<!-- @tpl:naming
Use title casing: Start with the "Architecture Overview for" followed by [Product Name], such as Architecture Overview for NeMo Guardrails Library. Only page titles get denoted with a single hashtag (#).
-->

<!-- @tpl:formatting
This is the Architecture Overview template. Use it to explain how a product's components work together at a high level along with a diagram that shows how those components connect and interact. Do not include all the configuration and specifications for the product here. From the Related Topics section, you can cross-reference the Architecture page and other reference pages for granular details about how the product works.
-->

<!-- @tpl:example
To get started, refer to [Architecture Overview for NeMo Guardrails Library](https://docs.nvidia.com/nemo/guardrails/latest/about-nemo-guardrails-library/how-it-works.html).
-->

<!-- @tpl:naming
Do not rename `architecture-overview.md`.
-->

<!-- @tpl:formatting
- Use in-page cards to present brief summaries to help navigate users to other content.
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introduction here that summarizes the design goal and how the product has been designed and built at a high level. Include an architecture diagram. Replace the following example with your own text.
-->

NVIDIA Speech NIM microservices are designed so that application developers, framework integrators, plugin authors, and observability consumers all reason about the same runtime semantics. One conceptual model should remain stable even when the binding or integration style changes.

NVIDIA Speech NIM microservices are released and versioned together as a collection. Each NIM microservice containerizes one or more NVIDIA NeMo models and exposes them through a unified API. You interact with the models through the NIM microservice’s gRPC and HTTP APIs, not directly with the models. Every NIM container packages the full inference stack.

The following diagram shows JSONL input moving through readers, quality filters, semantic dedup stages, Ray workers, and writers that emit curated shards.

<!-- @tpl:visual-representation
Write alt text that names the components and the relationship the diagram shows (data flow, layering) instead of a generic label like "architecture diagram." If the diagram conveys anything not in the surrounding prose, restate it in text so that non-sighted users do not lose it.
-->
![High-level overview of [Product Name] services, servers, and layers and their [data flow/interactions].](../path/to/architecture-diagram.png)

## Components
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Use this section to present descriptions for each component in a table or unordered list. Add subsections to provide more details about the components if necessary. Replace the following example with your own text.
-->

The following table lists each NIM microservice and the model families it serves.

| NIM Microservice | Nemotron Model Family | Models | Function |
| --- | --- | --- | --- |
| NVIDIA ASR NIM | Nemotron ASR | Parakeet, Canary, Conformer, Whisper | Converts audio to text. Interact with Nemotron ASR models through the ASR NIM API. |
| NVIDIA TTS NIM | Nemotron TTS | Magpie, FastPitch HifiGAN | Synthesizes speech from text. Interact with Nemotron TTS models through the TTS NIM API. |
| NVIDIA NMT NIM | Nemotron NMT | Megatron-based translation | Translates text between languages. Interact with Nemotron NMT models through the NMT NIM API. |

Each NIM microservice is a standalone Docker container. You deploy only the microservices your application needs. For example, a transcription service only requires the ASR NIM, while a real-time translation pipeline chains the ASR NIM, NMT NIM, and TTS NIM together.

## Data Flow
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Use this section only if your product has a data flow. Otherwise, omit it. Summarize the process for how data flows using an ordered list. Include details about concurrency, parallelism, or performance characteristics.
-->

Data moves through [Product Name] in the following sequence.

1. [Step 1 in the data flow process]
2. [Step 2]
3. [Step 3]

```{mermaid}
graph LR
    A[Service A] --> B[Service B]
    B --> C[Service C]
    C -.->|Feedback| A
```

<!-- @tpl:example
Every outbound connection from the agent code passes through the same decision path:

1. The agent process opens an outbound connection (API call, package install, git clone, and so on).
2. The proxy inside the sandbox intercepts the connection and identifies which binary opened it.
3. If the target is `https://inference.local`, the proxy handles it as managed inference before policy evaluation.
4. OpenShell strips sandbox-supplied credentials, injects the configured backend credentials, and forwards the request to the managed model endpoint.
5. For every other destination, the proxy queries the policy engine with the destination, port, and calling binary.
6. The policy engine returns one of two decisions:
   - **Allow**: The destination and binary match a policy block; traffic flows directly to the external service.
   - **Deny**: No policy block matched; the connection is blocked and logged.

For REST endpoints with TLS termination enabled, the proxy also decrypts TLS and checks each HTTP request against per-method, per-path rules before allowing it.
-->

## Deployment Topologies
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Include this section only if the product offers deployment topologies. Describe each deployment topology using a table.
-->

[Product Name] supports the following deployment patterns.

:::{list-table}
:header-rows: 1
:widths: 20 40 40

* -
  - **[Deployment Pattern 1]**
  - **[Deployment Pattern 2]**
* - **What It Is**
  - Describe the deployment model, runtime environment, and packaging (for example: single-node Docker container with local storage).
  - Describe the deployment model, runtime environment, and packaging (for example: multi-node Kubernetes cluster with distributed storage).
* - **Best For**
  - List the primary use cases and team profiles this pattern serves (for example: local development, single-user evaluation).<br/>List secondary use cases.
  - List the primary use cases and team profiles this pattern serves (for example: production workloads, multi-tenant environments).<br/>List secondary use cases.
* - **Architecture**
  - Describe the components, network topology, and resource allocation for this pattern.
  - Describe the components, network topology, and resource allocation for this pattern.
* - **Deployment Guide**
  - {doc}`[Link Text] <../path/to/guide>`
  - {doc}`[Link Text] <../path/to/guide>`
:::

<!-- @tpl:example
OpenShell can run locally, on a remote host, or behind a cloud proxy. The architecture is identical in all cases. Only the Docker container location and authentication mode change.

| Mode | Description | Command |
| --- | --- | --- |
| Local | The gateway runs inside Docker on your workstation. The CLI provisions it automatically on first use. | `openshell gateway start` |
| Remote | The gateway runs on a remote host using SSH. Only Docker is required on the remote machine. | `openshell gateway start --remote user@host` |
| Cloud | A gateway already running behind a reverse proxy (for example, Cloudflare Access). Register and authenticate using browser. | `openshell gateway add https://gateway.example.com` |

You can register multiple gateways and switch between them with `openshell gateway select`.
-->

## Service Interactions
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Include this section only if the service interactions for the product are complex or critical. Include a diagram.
-->

The following diagram illustrates how services communicate during a typical workflow.

```{mermaid}
sequenceDiagram
    participant Client
    participant ServiceA
    participant ServiceB
    participant Backend

    Client->>ServiceA: 1. Request
    ServiceA->>ServiceB: 2. Validate
    ServiceB->>Backend: 3. Execute
    Backend->>ServiceA: 4. Result
    ServiceA->>Client: 5. Response
```

**Key interactions**:
* **[Service A] → [Service B]**: [What happens in this service interaction]
<!-- @tpl:example
When a run starts, the pipeline definition is handed to the executor, workers pull batches from the queue, each stage emits transformed records, and the writer commits curated shards at the end.
-->
* **[Service B] → [Service C]**: [What happens in this service interaction]
<!-- @tpl:example
The proxy inside the sandbox intercepts outbound connections, identifies the calling binary, and either routes managed inference (`https://inference.local`) or queries the Policy Engine for allow/deny decisions before traffic reaches external services.
-->

**Protocol**: [Communication protocol details such as HTTP/REST and gRPC]

## External Integration Points
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Include this section only if there are important external integrations. Write one or two sentences about external systems and integration patterns.
-->

[Product Name] integrates with the following external systems.

:::{list-table}
:header-rows: 1
:widths: 25 75

* - Integration
  - Details
* - **[Integration 1]**
  - Describe the integration protocol, authentication method, and configuration steps (for example: S3-compatible object storage via environment variables for input/output data).
<!-- @tpl:example
NeMo Curator integrates with S3-compatible object storage for input/output, Ray clusters for distributed execution, and container registries for reproducible runtime environments.
-->
* - **[Integration 2]**
  - Describe the integration protocol, authentication method, and configuration steps (for example: Prometheus metrics endpoint exposed on port 9090 for monitoring).

:::

<!-- @tpl:formatting
Add more sections or subsections as needed.
-->

## Related Topics
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Provide a list of links to related topics. Be sure to include correct page titles and file names for the links. Generally, DO NOT include pages in the Related Topics section that are already referenced on the page.
-->

- [Architecture](architecture-overview.md)
- [API Reference](api-reference.md)
- [Related Topic](link.md)
- [Related Topic](link.md)
