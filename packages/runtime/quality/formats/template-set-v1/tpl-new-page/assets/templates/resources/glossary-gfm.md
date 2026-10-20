---
title: "Glossary for [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# Glossary for [Product Name]
<!-- @tpl:naming
Use title casing and start with "Glossary for" followed by [Product Name], such as Glossary for AI Enterprise. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the Glossary template. Use it for a lookup-oriented glossary page that defines domain terms, acronyms, and product language users will encounter elsewhere in the documentation. -->

<!-- @tpl:example
To get started, refer to [Glossary for NNVIDIA AI Enterprise](https://docs.nvidia.com/ai-enterprise/release-8/latest/reference/glossary.html).
-->

<!-- @tpl:naming
Do not rename the file.
-->

<!-- @tpl:formatting
- Use alphabetical H2 sections (`## A`, `## B`, …) so that users can jump by letter.
- Use H3 headings for terms and standard paragraphs for definitions.
- Use short first sentences for most definitions.
- Add code blocks, tables, or lists only when they add lookup value.
- Add an HTML `id` before an entry when other pages must link to that definition.
- Use related links when users should continue to a deeper concept, guide, or reference page.
-->

Use this glossary to better understand key terms used throughout the [Product Name] documentation.

<!-- @tpl:example
"Quick reference for key terms used throughout the NeMo Curator documentation."
-->

<!-- @tpl:example
"Inference Endpoint"
-->

<!-- @tpl:example
"Related: [Overview](/path/to/overview-gfm.md)"
-->

---

<!-- @tpl:formatting
- Add **alphabetical H2 headings** (`## A` through `## Z`, plus numerals/symbols if needed).
- Under each heading, use an H3 heading for each term followed by a concise definition.
- Add an HTML `id` on a term when other pages must link to that definition.
- Add code blocks or tables only when they make the definition meaningfully clearer.
-->

## A

<a id="glossary-example-term"></a>

### [Term]

[Define the term in one to three sentences. Start with the plain-language meaning, and then add the product-specific nuance if needed.]

```text
[Optional example output, syntax, or usage snippet]
```

**Related**: [Overview](../about/overview-gfm.md)

### [Acronym or Alias]

[If this term is an acronym, expand it on first mention and explain how readers encounter it in the product or documentation.]

<!-- @tpl:example
### RAG (Retrieval-Augmented Generation)

A pattern in which a system retrieves external content before a model generates a response grounded in that evidence. Readers encounter this term in workflows that combine search with generation.

### Pipeline

A sequence of stages such as reader, filter, modifier, and writer that processes data or content end to end.
-->

## B

### [Broader Term]

[Define the term and, if helpful, reference another glossary term.]

Refer to [[Example Term]](#glossary-example-term).

| Attribute | Meaning |
| --- | --- |
| [Field or variant] | [Optional detail that is easier to scan in a table] |

## Numerals and Symbols
<!-- @tpl:optional
Include this section only if you need entries that do not fit cleanly under A-Z.
-->

<!-- @tpl:example
### CUDA 12

A major release family of the CUDA platform required by supported GPU-accelerated stages. Record the minimum compatible driver with the requirement.
-->

<!-- @tpl:formatting
Use this section for entries such as `3D`, `A/B`, `CUDA 12`, or versioned environment names that readers are likely to search for directly. Use this section if you need entries that do not fit cleanly under A-Z. Replace the following example with your own example.
-->

### [Term Starting with a Number or Symbol]

[Definition.]

## Related Documentation
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:example
- [Overview](/path/to/overview-gfm.md)
- [Architecture](/path/to/architecture-overview-gfm.md)
- [Quickstart](/path/to/quickstart-gfm.md)
-->

<!-- @tpl:formatting
Link only to the pages users most often need after looking up a term, such as the overview, architecture, quickstart, or workflow guide. Link to the most useful pages. Keep this short and practical. Replace the following example with your own text.
-->

- [Overview](../about/overview-gfm.md)
- [Get Started](../get-started/get-started-overview-gfm.md)
