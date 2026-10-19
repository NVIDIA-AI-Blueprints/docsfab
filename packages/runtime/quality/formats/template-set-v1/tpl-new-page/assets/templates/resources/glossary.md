---
title: "Glossary for [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

(reference-glossary)=
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
- Use definition lists under each letter heading: one term line, then `:` and the definition text (dictionary-style).
- Indent continuation lines (examples, **Related**, *See also*) so that they remain with the same entry.
- Use short first sentences for most definitions.
- Add code blocks, tables, or lists only when they add lookup value.
- Use related links when readers should continue to a deeper concept, guide, or reference page.
-->

<!-- @tpl:example
"Quick reference for key terms used throughout the NeMo Curator documentation."
-->

<!-- @tpl:example
"Inference Endpoint"
-->

<!-- @tpl:example
"Related: {doc}`Overview </path/to/overview>`"
-->

---

<!-- @tpl:formatting
- Add **alphabetical H2 headings** (`## A` through `## Z`, plus numerals/symbols if needed).
- Under each heading, use a **definition list**: write the **term** on its own line, then a colon and the definition text.
- Indent continuation lines (examples, **Related**, *See also*) so they stay part of the same entry.
- Add a `{ref}` target line above an entry when other pages must link to that definition.
- Use related links when users should continue to a deeper concept, guide, or reference page.
-->

Use this glossary to better understand key terms used throughout the [Product Name] documentation.

## A

(glossary-term)=
[Term]
: [Define the term in one to three sentences. Start with the plain-language meaning, and then add the product-specific nuance if needed.]

  ```text
  [Optional example output, syntax, or usage snippet]
  ```

  **Related**: {doc}`Overview <../about/overview>`

[Acronym or Alias]
: [If this term is an acronym, expand it on first mention and explain how readers encounter it in the product or documentation.]

<!-- @tpl:example
RAG (retrieval-augmented generation)
: A pattern in which a system retrieves external content before a model generates a response grounded in that evidence. Readers encounter this term in workflows that combine search with generation.

Pipeline
: A sequence of stages such as reader, filter, modifier, and writer that processes data or content end to end.
-->

## B

[Broader Term]
: [Define the term and, if helpful, reference another glossary term.]

  Refer to {ref}`[Example Term] <glossary-example-term>`.

  | Attribute | Meaning |
  |-----------|---------|
  | [Field or variant] | [Optional detail that is easier to scan in a table] |

## Numerals and Symbols
<!-- @tpl:optional
Include this section only if you need entries that do not fit cleanly under A-Z.
-->

<!-- @tpl:example
CUDA 12
: A major release family of the CUDA platform required by supported GPU-accelerated stages. Record the minimum compatible driver with the requirement.
-->
<!-- @tpl:formatting
Use this section for entries such as `3D`, `A/B`, `CUDA 12`, or versioned environment names that readers are likely to search for directly. Use this section if you need entries that do not fit cleanly under A-Z. Replace the following example with your own example.
-->

[Term Starting with a Number or Symbol]
: [Definition.]

## Related Documentation
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:example
- [Overview](/path/to/overview.md)
- [Architecture](/path/to/architecture-overview.md)
- [Quickstart](/path/to/quickstart.md)
-->

<!-- @tpl:formatting
Link only to the pages users most often need after looking up a term, such as the overview, architecture, quickstart, or workflow guide. Link to the most useful pages. Keep this short and practical. Replace the following example with your own text.
-->

- {doc}`Overview <../about/overview>`
- {doc}`../get-started/get-started-overview`
