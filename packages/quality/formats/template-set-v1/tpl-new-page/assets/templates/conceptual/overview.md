---
title: "[Product Name] Core Concepts"
sidebar-title: "TODO: Add a short version of the page title for the Table of Contents sidebar"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

(concepts-overview)=
# [Product Name] Concepts
<!-- @tpl:naming
Use title casing and noun phrasing. Start the page title with the full product name and end with "Concepts." Use "Concepts" as the navigation label when the parent navigation already identifies the product; otherwise, use the full page title. Avoid titles such as "Concepts Overview" or "Introduction to Concepts."
-->

<!-- @tpl:example
- Page title: NeMo Curator Core Concepts
- Navigation label with product context: Core Concepts
-->

<!-- @tpl:formatting
This is the Concepts overview template. Use it for a product-wide or topic-wide collection that defines a shared mental model and routes readers into major conceptual areas. The authored page can live under About > Core Concepts or anywhere else the information architecture needs a concepts collection. Use this template when concepts span multiple subpages. For a compact set of core concepts that fit on a single About page, use the `templates/about/core-concepts-overview` template instead.
-->

<!-- @tpl:example
To get started, refer to [Text Curation Concepts](https://docs.nvidia.com/nemo/curator/about/concepts/text).
-->

<!-- @tpl:formatting
- Include foundational or cross-cutting concepts that help readers understand the product across features, workflows, and topical sections.
- Include a domain or modality as a card only when it serves as an entry point to a substantial conceptual area.
- Link to the canonical concept page wherever it lives. Do not duplicate topical concept content under About solely to populate this collection.
- Do not use this template to explain one concept in depth or to document concepts that matter only within one topical area. Use the standalone `templates/conceptual/conceptual` template for those pages.
- Keep this page navigational. Summarize each destination and let the linked page provide the full explanation.
-->

<!-- @tpl:example
- About Concepts entry: Resource Allocation, because it applies across product workflows.
- About Concepts entry: Text Curation Concepts, because it routes readers into a major conceptual area.
- Topical conceptual page: Fuzzy Deduplication, because it explains one technique within text curation.
-->

<!-- @tpl:formatting
Write a one- or two-sentence introduction that names the product and explains why readers should understand its concepts. Do not list every concept page in the introduction because the cards provide that navigation.
-->

<!-- @tpl:example
"This section explains the core ideas behind NeMo Curator, including pipelines, stages, tasks, and execution models. Use these concepts to make informed decisions when building curation workflows."
-->

Use this page as the central map of concepts that define [Product Name] across features, workflows, and topical sections. Choose a concept area to understand the terminology, design decisions, and behaviors that apply throughout the product.

<!-- @tpl:example
An environment is the world an agent interacts with. The agent takes actions, the environment returns observations and a reward, and the cycle repeats. Although the term comes from reinforcement learning, environments also support model evaluation, agent evaluation, harness optimization, and synthetic data generation.

An environment contains:

- **Dataset**: Tasks, metadata, and privileged scoring information.
- **Agent harness**: The loop that routes tools, manages context, and decides when the task is complete.
- **Verifier**: The scorer or grader that measures an attempt against expected answers, tests, ground truth, or rubrics.
- **State**: Per-task files, databases, repositories, or other data that changes as the agent acts. A runtime hosts the environment; a sandbox adds execution isolation.

The model is external to the environment. It produces actions, while the environment updates state, returns observations, and calculates the reward.
-->

<!-- @tpl:example
Evaluation is the process of running an agent on tasks, scoring the results, and measuring performance to guide improvements. It can measure accuracy, tool use, confidence in a specific environment, latency, and token usage.

For example, evaluating a coding agent requires a model, an agent harness with tools, a dataset of real bugs, a sandbox containing each repository, and a test-suite verifier that checks whether each fix works.
-->

<!-- @tpl:formatting
- Use in-page cards to present brief summaries to help navigate users to other content.
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:naming
- Keep the `overview.md` filename for this collection landing page.
- Name child concept files with concise, lowercase, hyphenated noun phrases that remain accurate as the content evolves.
- Omit the product name and generic words such as `concept`, `overview`, or `introduction` from child filenames unless they prevent ambiguity.
-->

<!-- @tpl:example
- `deduplication.md`
- `resource-allocation.md`
- `text-curation/overview.md`
-->

## [Concept Group Name]
<!-- @tpl:naming
Use title casing and a short, reader-facing noun phrase. Name the shared subject of the cards in terms readers recognize. Avoid vague headings such as "More Concepts," "Other," or "Additional Information."
-->

<!-- @tpl:example
- Modality Concepts
- Universal Concepts
- Text Curation Concepts
- Scaling and Performance
-->

<!-- @tpl:formatting
- Group cards by the way readers look for information. For example, separate domain- or modality-specific concepts from foundational or cross-cutting concepts.
- Introduce each group with one sentence that explains what the concepts have in common.
- Use two to six cards per group. Describe each concept's scope and value in 15–30 words.
- Order cards from foundational to specialized. Use parallel titles and descriptions so readers can compare destinations quickly.
- Link each card directly to a concept page or a lower-level concept index. Add every destination to the hidden toctree at the end of this page.
- If all concepts belong to one group, use a descriptive heading such as "Explore the Concepts" and delete the second example group.
-->

<!-- @tpl:example
"Learn about the concepts for working with each data modality in NeMo Curator."
-->

[Explain what unites this group and when a reader should choose one of these concept pages.]

<!-- @tpl:naming
Use the exact destination page title as the card title. Use title casing and noun phrasing, and keep peer titles grammatically parallel. Avoid action labels such as "Learn More" and generic labels such as "Overview." Keep each card title, destination page title, and visible toctree label identical.
-->

<!-- @tpl:example
- Text Curation Concepts: Covers how NeMo Curator loads, filters, classifies, and deduplicates text data as part of a scalable curation workflow.
- Image Curation Concepts: Covers how NeMo Curator loads, embeds, filters, and exports image datasets across scalable curation workflows.
-->

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} [Foundational Concept]
:link: foundational-concept
:link-type: doc

Understand [foundational idea] and how it shapes [Product Name] components and workflows.
:::

:::{grid-item-card} [Workflow or Data Flow Concept]
:link: workflow-concept
:link-type: doc

Learn how [inputs, components, or stages] interact from [starting point] to [outcome].
:::

:::{grid-item-card} [Component Concept]
:link: component-concept
:link-type: doc

Explore the role of [component], when it is used, and how it relates to the rest of [Product Name].
:::

:::{grid-item-card} [Domain-Specific Concept]
:link: domain-concept
:link-type: doc

Learn the concepts and terminology that apply specifically to [domain, modality, or use case].
:::

::::

## [Another Concept Group]
<!-- @tpl:naming
Use title casing and a short noun phrase that distinguishes this group from the preceding group.
-->

<!-- @tpl:example
- Foundational Concepts
- Universal Concepts
- Deployment Concepts
-->

<!-- @tpl:optional
Use this second group when readers need a distinct set of foundational, cross-cutting, domain-specific, or advanced concepts. Otherwise, delete the heading, introduction, and grid.
-->

<!-- @tpl:example
"These concepts apply across every NeMo Curator modality and workflow."
-->

[Explain how this group differs from the preceding group and what readers will learn.]

<!-- @tpl:example
- Resource Allocation: Explains how NeMo Curator assigns CPUs, GPUs, and memory across pipeline stages to use available hardware efficiently.
- Streaming: Describes how batched execution controls memory use and keeps GPU work moving throughout long-running curation pipelines.
-->

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} [Cross-Cutting Concept]
:link: cross-cutting-concept
:link-type: doc

Understand how [shared behavior] applies across [components, domains, or workflows].
:::

:::{grid-item-card} [Scaling or Performance Concept]
:link: scaling-concept
:link-type: doc

Learn how [Product Name] behaves as [data volume, workload complexity, or deployment size] increases.
:::

::::

:::{toctree}
:maxdepth: 2
:hidden:
:caption: Concepts

[Foundational Concept] <foundational-concept>
[Workflow or Data Flow Concept] <workflow-concept>
[Component Concept] <component-concept>
[Domain-Specific Concept] <domain-concept>
[Cross-Cutting Concept] <cross-cutting-concept>
[Scaling or Performance Concept] <scaling-concept>
:::
