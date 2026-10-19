---
title: "About [Procedural Task Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# About [Procedural Task Name]
<!-- @tpl:naming
Use title casing: Start with "About" followed by [Procedural Task Name], such as About Fine-Tuning. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the About Procedural Task template. Use it for high-level procedural tasks or workflows that users need to understand conceptually before diving into step-by-step instructions. For detailed how-to guides, use the beginner tutorial or task templates instead. For more information refer to the Template for Creating Beginner Tutorials, Template for Creating Procedure Topics with One Procedure, and Template for Creating Procedure Topics with Multiple Procedures.-->

<!-- @tpl:example
To get started, refer to [About Fine-Tuning](https://docs.nvidia.com/nemo/microservices/latest/customizer/index.html).
-->

<!-- @tpl:naming
Rename the file and save it in the appropriate project repository. The filename gets included in the URL. Try to name your file in a way that the content can change without having to change the filename (and the URL). For better SEO, use hyphens instead of underscores. Avoid putting product names in file names whenever possible. For example, instead of nemoretriever-parse, a product-agnostic name could be "advanced-ocr-parsing".
-->

<!-- @tpl:example
- about-fine-tuning-gfm.md
- about-building-workflows-gfm.md
-->

<!-- @tpl:formatting
- Use a bulleted list of links to present brief summaries to help navigate users to other content.
- Use tables to organize complex information.
- Use headings, tables, or details blocks to present command variants.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introductory paragraph. Include two to three sentences that provides an overview of the task and its outcome. If possible, follow with a paragraph on when to use this workflow and why. Replace the following example with your own text.
-->

Learn how to fine-tune models by making requests to NVIDIA NeMo Customizer through the API. Fine-tuned models you have created can be deployed using NVIDIA NIMs.

## Related Concepts
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Include this section only if users need to understand certain concepts that are related to the procedure before starting. Use a bulleted list of links to help users navigate to each conceptual topic. Use noun phrasing and title casing (Align with the Product Manager on this section).
-->

<!-- @tpl:example
"This page explains the end-to-end data curation workflow and its key decision points. Use this as a reference before diving into step-by-step how-to guides."
-->

<!-- @tpl:example
A NeMo Curator workflow connects readers, processing stages, and writers in an ordered pipeline. The workflow definition records the stage sequence, resource needs, and output destination before execution begins.
-->

Understanding these concepts will help you complete this task:

- **[Name of the Related Concept such as Deduplication](path/to/related-concept-1)** — Comprehensive overview of deduplication techniques across text, image, and video modalities including exact, fuzzy, and semantic approaches.
- **[Name of the Related Concept such as Resource Allocation](path/to/related-concept-2)** — How NeMo Curator allocates CPUs, GPUs, and memory across pipeline stages for optimal hardware utilization.
- **[Name of Related Concept such as Auto-Balancing](path/to/related-concept-3)** — How the executor automatically balances resources across pipeline stages to eliminate bottlenecks.
- **[Name of Related Concept such as Throughput](path/to/related-concept-4)** — Scale from a single GPU to multi-node clusters with near-linear scaling.

<!-- @tpl:formatting
Add more related concepts here as needed.
-->

## Workflow Overview
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Summarize or provide the actual steps that are included in the procedure at a high level. Replace the following example with your own text.
-->

At a high level, the fine-tuning workflow consists of the following steps:

1. Create a Model Entity pointing to your base model checkpoint (stored as a FileSet).
2. Format a compatible dataset.
3. Create a customization job referencing the Model Entity.
4. Monitor the job until it completes.

   The customization job automatically creates either:

   - **LoRA jobs**: An adapter attached to the original Model Entity.
   - **Full fine-tuning jobs**: A new Model Entity with the customized weights.

5. Deploy the model using the Deployment Management Service.

<!-- @tpl:visual-representation
Optionally, you can include a mermaid diagram. Since alt text is not allowed, you should add a caption and a one-sentence lead-in to describe the diagram for screen-reader and text-only contexts. Use short phase names for the node labels.
-->

```mermaid
---
caption: [Task Name] Workflow
---
flowchart LR
    A["Start:<br/>[Initial State]"] --> B["Step 1:<br/>[Action]"]
    B --> C["Step 2:<br/>[Action]"]
    C --> D["Result:<br/>[Outcome]"]

    classDef startEnd fill:#e1f5e1,stroke:#4caf50,stroke-width:2px
    classDef process fill:#e3f2fd,stroke:#2196f3,stroke-width:2px

    class A,D startEnd
    class B,C process
```

### [Phase Name]
<!-- @tpl:example
"Create sample input data and define the pipeline stages before running on a larger corpus. This phase keeps the first run fast and makes failures easier to debug."
-->

1. **[Step or action]**: [Description of what happens in this step and why]
2. **[Step or action]**: [Description]

## Key Concepts
<!-- @tpl:optional
Include this section only if users need conceptual understanding before
choosing an approach.
-->

<!-- @tpl:example
Understanding these concepts will help you build effective curation pipelines.
The three core ideas are Pipeline (the workflow), Stage (one operation), and
Task (a data batch moving between stages).
-->

Understanding these concepts will help you [perform the task] effectively.

### [Concept Name]
<!-- @tpl:example
Pipeline → Stages → Tasks. The pipeline defines the workflow, each stage
performs one operation, and tasks carry batches of data or content between
stages.
-->

[Explain why this concept matters and how it relates to the task.]

## Common Methods for Completing the Procedure
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Include this section if there are multiple methods for completing the procedure. Write one or two sentences introducing the available approaches. Add a subsection for each approach. Replace the following example with your own text.
-->

You can complete this procedure using either a local quickstart for fast iteration, a containerized run for reproducibility, or a distributed cluster for production-scale datasets.

Choose the approach that best fits your needs.

<!-- @tpl:formatting
- Add one subsection per approach.
Repeat the pattern below as needed.
-->

### [Approach Name]
<!-- @tpl:example
"Local quickstart. Choose this approach when you want a first successful run on one machine before scaling out with distributed workers, containers, or larger datasets."
-->

**Best for**: [Scenario or use case 1], [Scenario or use case 2]

**Considerations**: [Important consideration], [Trade-offs or limitations]

## Decision Factors

Use the following comparison to select the right approach.

<!-- @tpl:example
"Teams often compare a local quickstart, a containerized run, and a distributed cluster deployment by setup time, runtime scale, hardware requirements, and how much control they need over the environment."
-->

<!-- @tpl:example
| Factor | Local run | Distributed run |
| --- | --- | --- |
| Setup | One workstation and a Python environment. | Shared storage, workers, and cluster configuration. |
| Scale | Samples and small datasets. | Large datasets and parallel stages. |
| Best use | Development and validation. | Repeatable production processing. |
-->

<!-- @tpl:formatting
- Use this table for quick comparison when you have two or three distinct approaches.
-->

| Factor | [Approach Name 1] | [Approach Name 2] |
| --- | --- | --- |
| **[Key Decision Factor 1]** | [How this approach handles it] | [How this approach handles it] |
| **[Key Decision Factor 2]** | [Description] | [Description] |
| **Best For** | [Use case description] | [Use case description] |

## Related Task Guides
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Use a bulleted list of links to help users navigate to related task guides. Each step referenced in the Workflow Overview section should have a corresponding task guide (procedural topic).
-->

- **[Name of the Related Task Guide such as Create a Model Entity](path/to/related-task-1)** — Create a model entity that references your FileSet and enables customization.
- **[Name of the Related Task Guide such as Manage Datasets](path/to/related-task-2)** — Upload and manage datasets for training.
- **[Name of Related Task Guide such as Manage Customization Jobs](path/to/related-task-3)** — Create, list, view, and cancel customization jobs.

<!-- @tpl:formatting
Add more related task guides here as needed.
-->

## Related Tutorials
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Use a bulleted list of links to help users navigate to related tutorials.
-->

- **[Name of the Related Tutorial such as Format Training Datasets](path/to/related-tutorial-1)** — Learn how to format datasets for different model types.
- **[Name of the Related Tutorial such as Start a LoRA Customization Job](path/to/related-tutorial-2)** — Learn how to start a LoRA customization job using a custom dataset.

<!-- @tpl:formatting
Add more related tutorials here as needed.
-->

## Related References
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Use a bulleted list of links to help users navigate to related reference topics.
-->

- **[Name of the Related Reference Topic such as API Reference](path/to/related-reference-1)** — Learn more about the API reference specifications.
- **[Name of the Related Reference Topic such as SDK Reference](path/to/related-reference-2)** — Learn more about the SDK reference specifications.

<!-- @tpl:formatting
Add more related references here as needed.
-->
