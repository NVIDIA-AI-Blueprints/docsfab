---
title: "[Product Name] Documentation"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

(about-index)=
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

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` Support Matrix
:link: path/to/support-matrix
:link-type: doc

Reference the Support Matrix to understand what [Product Name] supports.
+++
{bdg-secondary}`get-started`
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` Get Started
:link: path/to/get-started
:link-type: doc

Get started with [Product Name].
+++
{bdg-secondary}`get-started`
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` Examples
:link: path/to/reference-overview
:link-type: doc

Explore common examples and use cases for [Product Name].
+++
{bdg-secondary}`examples`
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` Troubleshooting
:link: path/to/troubleshooting
:link-type: doc

Obtain solutions for resolving common troubleshooting issues when using [Product Name].
+++
{bdg-secondary}`troubleshooting`
:::
<!-- @tpl:optional
This card should always link to the Troubleshooting Guide. You should only include this in-page card if you have a Troubleshooting Guide. Otherwise, remove it.
-->

::::

## Use Cases
<!-- @tpl:formatting
List up to six common use cases here using imperatives and title casing (Align with the Product Manager on this section). Do not list a core concept or component here. Core concepts should be listed under the Core Concepts section below. Core components should be listed under the Core Components section below.
-->

Explore the common use cases for [Product Name].

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` [Name of the Use Case such as Customize and Evaluate Models]
:link: path/to/use-case-1
:link-type: doc

<!-- @tpl:formatting
Add a description for the use case phrased as user goals or jobs-to-be-done. Avoid feature claims or broad scenario lists. Replace the following example with your own text.
-->
Generate synthetic training data, fine-tune models, and measure quality.
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` [Name of the Use Case such as Build RAG and Search Applications]
:link: path/to/use-case-2
:link-type: doc

<!-- @tpl:formatting
Add a description for the use case phrased as user goals or jobs-to-be-done. Avoid feature claims or broad scenario lists. Replace the following example with your own text.
-->
Fine-tune embedding models for domain-specific retrieval and evaluate with RAG metrics.
:::

<!-- @tpl:formatting
Add more use cases here as needed.
-->

::::

## Core Concepts
<!-- @tpl:optional
List up to six core concepts here using noun phrasing and title casing (Align with the Product Manager on this section). Include this section only when the product has core concepts readers should understand at a high level before diving deeper. Do not list a use case or core component here. Do not list a use case or core component here. Use cases should be listed under the Use Cases section above. Core components should be listed under the Core Components section below.
-->

Explore the core concepts to understand [Product Name].

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` [Name of the Core Concept such as Deduplication]
:link: path/to/core-concept-1
:link-type: doc

<!-- @tpl:formatting
Add a description for the core concept. Replace the following example with your own text.
-->
Comprehensive overview of deduplication techniques across text, image, and video modalities including exact, fuzzy, and semantic approaches.
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` [Name of the Core Concept such as Resource Allocation]
:link: path/to/core-concept-2
:link-type: doc

<!-- @tpl:formatting
Add a description for the core concept. Replace the following example with your own text.
-->
How NeMo Curator allocates CPUs, GPUs, and memory across pipeline stages for optimal hardware utilization.
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` [Name of Core Concept such as Auto-Balancing]
:link: path/to/core-concept-3
:link-type: doc

<!-- @tpl:formatting
Add a description for the core concept. Replace the following example with your own text.
-->
How the executor automatically balances resources across pipeline stages to eliminate bottlenecks.
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` [Name of Core Concept such as Throughput]
:link: path/to/core-concept-4
:link-type: doc

<!-- @tpl:formatting
Add a description for the core concept. Replace the following example with your own text.
-->
Scale from a single GPU to multi-node clusters with near-linear scaling.
:::

<!-- @tpl:formatting
Add more core concepts here as needed.
-->

::::

## Core Components
<!-- @tpl:optional
List up to six core components here using noun phrasing and title casing (Align with the Product Manager on this section). Include this section only when the product has core components readers should understand at a high level before diving deeper. Do not list a use case or core concept here. Use cases should be listed under the Use Cases section above. Core concepts should be listed under the Core Concepts section above.
-->

Explore the core components to understand how [Product Name] was designed.

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` [Name of the Core Component such as OpenShell Gateway]
:link: path/to/core-component-1
:link-type: doc

<!-- @tpl:formatting
Add a description for the component. Replace the following example with your own text.
-->
Hosts the credential store, owns sandbox lifecycle coordination, and provides the L7 proxy.
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` [Name of the Core Component such as Docker Daemon]
:link: path/to/core-component-2
:link-type: doc

<!-- @tpl:formatting
Add a description for the component. Replace the following example with your own text.
-->
Runs the Docker-driver sandbox container and, on affected Linux hosts, the optional gateway compatibility container.
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` [Name of the Core Component such as Sandbox Container]
:link: path/to/core-component-3
:link-type: doc

<!-- @tpl:formatting
Add a description for the component. Replace the following example with your own text.
-->
Runs the selected compatible agent and NemoClaw integration under Landlock + seccomp + netns.
:::

<!-- @tpl:formatting
Add more core components here as needed.
-->

::::
