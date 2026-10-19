---
title: "Key Features of [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# Key Features of [Product Name]
<!-- @tpl:naming
Use a stable product-specific page and heading slug for inbound links, such as `nemo-curator-key-features`.
-->

<!-- @tpl:naming
Use title casing: Start with "Key Features of" followed by [Product Name], such as Key Features of NeMo Curator. Only page titles get denoted with a single hashtag (#).
-->

<!-- @tpl:formatting
This is the Key Features template. Use this template to present a comprehensive list of a product's features. Use the [About Feature Template](about-feature-gfm.md) to provide detailed information for one specific feature.
-->

<!-- @tpl:example
To get started, refer to [Key Features of NeMo Curator](https://docs.nvidia.com/nemo/curator/latest/about/key-features).
-->

<!-- @tpl:naming
Do not rename the file.
-->

<!-- @tpl:formatting
Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introductory sentence followed by a bullet list of key features. Be careful not to confuse key features with benefits. Replace the following example with your own text.
-->

[Product Name] offers the following key features:

- **Framework Agnostic:** NeMo Agent Toolkit works side-by-side and around existing agentic frameworks, such as LangChain, LlamaIndex, CrewAI, Microsoft Semantic Kernel, Google ADK, as well as customer enterprise frameworks and simple Python agents. This allows you to use your current technology stack without replatforming. NeMo Agent Toolkit complements any existing agentic framework or memory tool you are using and is not tied to any specific agentic framework, long-term memory, or data source.
- **Reusability:** Every agent, tool, and agentic workflow in this library exists as a function call that works together in complex software applications. The composability between these agents, tools, and workflows allows you to build once and reuse in different scenarios.
- **Profiling:** Use the profiler to profile entire workflows down to the tool and agent level, track input/output tokens and timings, and identify bottlenecks.
- **Observability:** Monitor and debug your workflows with dedicated integrations for popular observability platforms such as Phoenix, Weave, and Langfuse, plus compatibility with OpenTelemetry-based systems. Track performance, trace execution flows, and gain insights into your agent behaviors.
- **Evaluation System:** Validate and maintain accuracy of agentic workflows with built-in evaluation tools.
- **User Interface:** Use the NeMo Agent Toolkit UI chat interface to interact with your agents, visualize output, and debug workflows.
- **Full MCP Support:** Compatible with Model Context Protocol (MCP). You can use NeMo Agent Toolkit as an MCP client to connect to and use tools served by remote MCP servers. You can also publish tools with the MCP server runtime or an MCP server using the FastMCP server runtime.
- **A2A Protocol Support:** Compatible with Agent-to-Agent (A2A) Protocol. You can use NeMo Agent Toolkit as an A2A client to connect to and delegate tasks to remote A2A agents. You can also use NeMo Agent Toolkit as an A2A server to publish workflows as discoverable A2A agents.

To obtain an understanding of how these features work together, refer to the [Architecture Overview](architecture-overview-gfm.md).

## [Developer Tools]
<!-- @tpl:optional
Include this section only for developer-facing products with CLI tools or APIs.
-->

[Product Name] provides the following tools for developers.

**CLI Tools** — [Number] command-line tools for [purpose]:

* `command_name` - [Brief description]
* `command_name` - [Brief description]

**APIs and SDKs**:

| | |
| --- | --- |
| **[API/SDK Feature]** | [Description of this developer-facing feature or tool.] |
| **[API/SDK Feature]** | [Description with technical details and usage scenarios.] |

For hands-on experience with these features, see [Getting Started](../path/to/getting-started) and [Tutorials](../path/to/tutorials).
