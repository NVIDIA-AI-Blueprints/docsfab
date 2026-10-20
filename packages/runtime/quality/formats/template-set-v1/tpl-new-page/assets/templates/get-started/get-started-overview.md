---
title: "About Getting Started with [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

(gs-overview)=
# About Getting Started with [Product Name]
<!-- @tpl:naming
Use title casing: Start with "About Getting Started with" followed by the [Product Name], such as About Getting Started with NIM for LLMs. Only page titles get denoted with a single hashtag (#).
-->

<!-- @tpl:formatting
This is the Get Started Overview template. Use it for the Get Started section landing page, which orients users and directs them to the appropriate starting point based on their experience level and goals.
-->

<!-- @tpl:example
To get started, refer to [About Getting Started with NIM for LLMs](https://docs.nvidia.com/nim/large-language-models/latest/get-started/index.html).
-->

<!-- @tpl:naming
Rename the file "_index" and save it in the appropriate project repository using the correct format extension such as -gfm.md, .md, .rst, or .mdx.
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Help users navigate to the [Prerequisites page](prerequisites.md) for additional prerequisite information.
-->
Before you get started, verify you meet the necessary prerequisites. For more information, refer to [Prerequisites](prerequisites.md).

## Choose Your Path
<!-- @tpl:formatting
Help users choose the right method for getting started based on their experience level and goals. Identify each audience's prerequisites and first task, then replace the following example with paths appropriate to those readers.
-->

Select the guide that matches your experience level and goals. For example:

<!-- @tpl:formatting
Use a list table to map each persona to the appropriate use cases.
-->

:::{list-table}
:header-rows: 1
:widths: 40 60

* - Audience
  - Use Cases
* - [AI/ML engineers and researchers]
  - [Quickly test model pipelines, evaluate performance, and try new workflows]
* - [Platform operators]
  - [Run an initial deployment with minimal setup and validate infrastructure compatibility]
* - [Technical evaluators]
  - [Explore capabilities before committing to production deployment]
:::

Navigate to the Quickstart Guide if you want a working pipeline fast. Navigate to the installation if you are planning a production deployment. Navigate to the beginner tutorial if you want to understand the pipeline model step by step.

<!-- @tpl:formatting
Use in-page cards to help the users navigate the appropriate guides.
-->

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`zap;1.5em;sd-mr-1` Quickstart
:link: quickstart.md
:link-type: doc

Get up and running with minimal setup. Best for users who want to see [Product Name] in action immediately.
+++
{bdg-secondary}`minimal setup`
:::

:::{grid-item-card} {octicon}`download;1.5em;sd-mr-1` Installation Guide
:link: installation.md
:link-type: doc

Step-by-step installation with multiple options (PyPI, source, and container). Includes verification and troubleshooting.
+++
{bdg-secondary}`detailed` {bdg-secondary}`multiple options`
:::

:::{grid-item-card} {octicon}`mortar-board;1.5em;sd-mr-1` Beginner Tutorial
:link: beginner-tutorial.md
:link-type: doc

Learn the fundamentals through a guided hands-on tutorial. Best for users who are new to [Product Name].
+++
{bdg-secondary}`tutorial`
:::

<!-- @tpl:formatting
Add more in-page cards here as needed.
-->

::::

New users should start with the quickstart for immediate results, and then complete the Installation Guide and beginner tutorial for a thorough understanding of the product:

```{mermaid}
flowchart LR
    subgraph fast["Fast Track"]
        Q[Quickstart]
    end

    subgraph comprehensive["Comprehensive"]
        A[Prerequisites] --> B[Installation]
        B --> C[Beginner Tutorial]
    end

    Q --> D[Tutorials and User Guides]
    C --> D

    classDef default fill:#f6f8fa,stroke:#d0d7de,color:#24292f
    classDef fast fill:#e3f2fd,stroke:#2196f3,stroke-width:2px
    classDef comp fill:#e1f5e1,stroke:#4caf50,stroke-width:2px

    class Q fast
    class A,B,C comp
```
