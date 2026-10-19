---
title: "[Product Name] Documentation"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# [Product Name] Documentation
<!-- @tpl:naming
Use title casing: Start with [Product Name] followed by "Documentation", such as NeMo Curator Documentation. Only page titles get denoted with a single hashtag (#).
-->

<!-- @tpl:formatting
This is the Overview template. Use it to introduce the product and explain what it is, why it matters, and how it works at a high level.
-->

<!-- @tpl:example
To get started, refer to [NVIDIA NeMo Guardrails Documentation](https://docs.nvidia.com/nemo/guardrails/latest/about-nemo-guardrails-library/overview).
-->

<!-- @tpl:naming
Rename the file "_index" and save it in the appropriate project repository using the correct format extension such as -gfm.md, .md, .rst, or .mdx.
-->

<!-- @tpl:formatting
- Use in-page cards to present brief summaries to help navigate users to other content.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introductory paragraph that includes two to three sentences explaining what the product helps users do. Link the product name to its project marketing page on first mention. Conclude the introductory paragraph with the following: For more information about the benefits and features, refer to [Benefits and Features for <Product Name>](Link to the product marketing page). Most NVIDIA product marketing pages are hosted at [https://www.nvidia.com/en-us/](https://www.nvidia.com/en-us/) and [developer.nvidia.com](https://developer.nvidia.com).
-->

<!-- @tpl:optional
Optionally, follow with a paragraph that describes the key capabilities and how the product fits within the overall ecosystem.
-->

[NVIDIA Speech NIM microservices](https://developer.nvidia.com/topics/ai/generative-ai/riva?sortBy=developer_learning_library%2Fsort%2Ffeatured_in.riva%3Adesc%2Ctitle%3Aasc) are GPU-accelerated Docker containers that provide speech AI capabilities as building blocks for your applications. Each NIM microservice packages a Nemotron model, the full NVIDIA inference stack (CUDA, TensorRT, Triton), and a unified API into a single container that you deploy, scale, and interact with through standard gRPC and HTTP interfaces. You do not interact with models directly. Instead, each NIM microservice provides the API layer that your application calls to run inference on the containerized models.

For more information about the benefits and features, refer to [Benefits and Features for NVIDIA Nemotron Speech](https://developer.nvidia.com/topics/ai/generative-ai/riva?sortBy=developer_learning_library%2Fsort%2Ffeatured_in.riva%3Adesc%2Ctitle%3Aasc).

## Skip Ahead
<!-- @tpl:formatting
Include the following in-page cards to help users navigate to other information related to getting started, API examples or use cases, and troubleshooting guides.
-->

- **[Support Matrix](path/to/support-matrix)** — Reference the Support Matrix to understand what [Product Name] supports.
- **[Get Started](path/to/get-started)** — Get started with [Product Name].
- **[Examples](path/to/reference-overview)** — Explore common examples and use cases for [Product Name].
- **[Troubleshooting](path/to/troubleshooting)** — Obtain solutions for resolving common troubleshooting issues when using [Product Name].
<!-- @tpl:optional
This card should always link to the Troubleshooting Guide. You should only include this in-page card if you have a Troubleshooting Guide. Otherwise, remove it.
-->

## Use Cases
<!-- @tpl:formatting
List up to six common use cases here using imperatives and title casing (Align with the Product Manager on this section). Do not list a core concept or component here. Core concepts should be listed under the Core Concepts section below. Core components should be listed under the Core Components section below.
-->

Explore the common use cases for [Product Name].

- **[Name of the Use Case such as Customize and Evaluate Models](path/to/use-case-1)** — Generate synthetic training data, fine-tune models, and measure quality.
- **[Name of the Use Case such as Build RAG and Search Applications](path/to/use-case-2)** — Fine-tune embedding models for domain-specific retrieval and evaluate with RAG metrics.

<!-- @tpl:formatting
Add more use cases here as needed.
-->

## Core Concepts
<!-- @tpl:optional
List up to six core concepts here using noun phrasing and title casing (Align with the Product Manager on this section). Include this section only when the product has core concepts readers should understand at a high level before diving deeper. Do not list a use case or core component here. Do not list a use case or core component here. Use cases should be listed under the Use Cases section above. Core components should be listed under the Core Components section below.
-->

Explore the core concepts to understand [Product Name].

- **[Name of the Core Concept such as Deduplication](path/to/core-concept-1)** — Comprehensive overview of deduplication techniques across text, image, and video modalities including exact, fuzzy, and semantic approaches.
- **[Name of the Core Concept such as Resource Allocation](path/to/core-concept-2)** — How NeMo Curator allocates CPUs, GPUs, and memory across pipeline stages for optimal hardware utilization.
- **[Name of Core Concept such as Auto-Balancing](path/to/core-concept-3)** — How the executor automatically balances resources across pipeline stages to eliminate bottlenecks.
- **[Name of Core Concept such as Throughput](path/to/core-concept-4)** — Scale from a single GPU to multi-node clusters with near-linear scaling.

<!-- @tpl:formatting
Add more core concepts here as needed.
-->

## Core Components
<!-- @tpl:optional
List up to six core components here using noun phrasing and title casing (Align with the Product Manager on this section). Include this section only when the product has core components readers should understand at a high level before diving deeper. Do not list a use case or core concept here. Use cases should be listed under the Use Cases section above. Core concepts should be listed under the Core Concepts section above.
-->

Explore the core components to understand how [Product Name] was designed.

- **[Name of the Core Component such as OpenShell Gateway](path/to/core-component-1)** — Hosts the credential store, owns sandbox lifecycle coordination, and provides the L7 proxy.
- **[Name of the Core Component such as Docker Daemon](path/to/core-component-2)** — Runs the Docker-driver sandbox container and, on affected Linux hosts, the optional gateway compatibility container.
- **[Name of the Core Component such as Sandbox Container](path/to/core-component-3)** — Runs the selected compatible agent and NemoClaw integration under Landlock + seccomp + netns.

<!-- @tpl:formatting
Add more core components here as needed.
-->
