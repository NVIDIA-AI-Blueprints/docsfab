---
title: "[Product Name] Core Concepts"
sidebar-title: "TODO: Add a short version of the page title for the Table of Contents sidebar"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

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
- Include a domain or modality as a link only when it serves as an entry point to a substantial conceptual area.
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
Write a one- or two-sentence introduction that names the product and explains why readers should understand its concepts. Do not list every concept page in the introduction because the links provide that navigation.
-->

<!-- @tpl:example
"This section explains the core ideas behind NeMo Curator, including pipelines, stages, tasks, and execution models. Use these concepts to make informed decisions when building curation workflows."
-->

Use this page as the central map of concepts that define [Product Name] across features, workflows, and topical sections. Choose a concept area to understand the terminology, design decisions, and behaviors that apply throughout the product.

<!-- @tpl:formatting
- Use a bulleted list of links to present brief summaries to help navigate users to other content.
- Use tables to organize complex information.
- Use headings, tables, or details blocks to present command variants.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:naming
- Keep the format-specific `overview-gfm.md` filename for this collection landing page.
- Name child concept files with concise, lowercase, hyphenated noun phrases that remain accurate as the content evolves.
- Omit the product name and generic words such as `concept`, `overview`, or `introduction` from child filenames unless they prevent ambiguity.
-->

<!-- @tpl:example
- `deduplication-gfm.md`
- `resource-allocation-gfm.md`
- `text-curation/overview-gfm.md`
-->

## [Concept Group Name]
<!-- @tpl:naming
Use title casing and a short, reader-facing noun phrase. Name the shared subject of the links in terms readers recognize. Avoid vague headings such as "More Concepts," "Other," or "Additional Information."
-->

<!-- @tpl:example
- Modality Concepts
- Universal Concepts
- Text Curation Concepts
- Scaling and Performance
-->

<!-- @tpl:formatting
- Group links by the way readers look for information. For example, separate domain- or modality-specific concepts from foundational or cross-cutting concepts.
- Introduce each group with one sentence that explains what the concepts have in common.
- Represent each card as a bold linked title followed by a colon and a 15–30 word description because GFM does not support the card components used by MyST, RST, and MDX.
- Use two to six links per group. Order them from foundational to specialized, and use parallel titles and descriptions so readers can compare destinations quickly.
- Link directly to a concept page or a lower-level concept index.
- If all concepts belong to one group, use a descriptive heading such as "Explore the Concepts" and delete the second example group.
-->

<!-- @tpl:example
"Learn about the concepts for working with each data modality in NeMo Curator."
-->

[Explain what unites this group and when a reader should choose one of these concept pages.]

<!-- @tpl:naming
Use the exact destination page title as the linked title. Use title casing and noun phrasing, and keep peer titles grammatically parallel. Avoid action labels such as "Learn More" and generic labels such as "Overview." Keep each linked title and destination page title identical.
-->

<!-- @tpl:example
- Text Curation Concepts: Covers how NeMo Curator loads, filters, classifies, and deduplicates text data as part of a scalable curation workflow.
- Image Curation Concepts: Covers how NeMo Curator loads, embeds, filters, and exports image datasets across scalable curation workflows.

- **Environments**: Explains the dataset, agent harness, verifier, and per-task state that define the world in which an agent acts.
- **Evaluation**: Explains how tasks, scoring, accuracy, tool use, latency, and token usage combine to measure agent performance.
-->

- **[Foundational Concept](foundational-concept-gfm.md)**: Understand [foundational idea] and how it shapes [Product Name] components and workflows.
- **[Workflow or Data Flow Concept](workflow-concept-gfm.md)**: Learn how [inputs, components, or stages] interact from [starting point] to [outcome].
- **[Component Concept](component-concept-gfm.md)**: Explore the role of [component], when it is used, and how it relates to the rest of [Product Name].
- **[Domain-Specific Concept](domain-concept-gfm.md)**: Learn the concepts and terminology that apply specifically to [domain, modality, or use case].

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
Use this second group when readers need a distinct set of foundational, cross-cutting, domain-specific, or advanced concepts. Otherwise, delete the heading, introduction, and list.
-->

<!-- @tpl:example
"These concepts apply across every NeMo Curator modality and workflow."
-->

[Explain how this group differs from the preceding group and what readers will learn.]

<!-- @tpl:example
- Resource Allocation: Explains how NeMo Curator assigns CPUs, GPUs, and memory across pipeline stages to use available hardware efficiently.
- Streaming: Describes how batched execution controls memory use and keeps GPU work moving throughout long-running curation pipelines.
-->

- **[Cross-Cutting Concept](cross-cutting-concept-gfm.md)**: Understand how [shared behavior] applies across [components, domains, or workflows].
- **[Scaling or Performance Concept](scaling-concept-gfm.md)**: Learn how [Product Name] behaves as [data volume, workload complexity, or deployment size] increases.
