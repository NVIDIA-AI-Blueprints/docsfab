---
title: "Observability Metrics for [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# Observability Metrics for [Product Name]
<!-- @tpl:naming
Use title casing and start with "Observability Metrics for" followed by [Product Name], such as Observability Metrics for NeMo Retriever Embedding NIM. Only page titles get denoted with a single hashtag (#).
-->

<!-- @tpl:optional
This is the Observability Metrics template. This template should only be used if there are observability metrics for your product that users can use to create dashboards, such as by using Grafana. This page supports an observability page. If you don't have many metrics, you can keep your observability metrics combined with your observability page. Reference topics document facts for lookup. Do not include step-by-step procedures in reference topics. You should link to tutorials and procedural topics instead.
-->

<!-- @tpl:example
To get started, refer to [Observability Metrics for Speech NIM Containers](https://docs.nvidia.com/nim/speech/latest/reference/observability.html) and [Observability Metrics for NeMo Retriever Embedding NIM](https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/observability.html).
-->

<!-- @tpl:naming
Do not rename this file if the observability metrics for your product are not grouped by component. Otherwise, rename this file and save it in the appropriate project repository. The filename gets included in the URL. Try to name your file in a way that the content can change without having to change the filename (and the URL). For better SEO, use hyphens instead of underscores. Avoid putting product names in file names whenever possible. For example, instead of nemoretriever-parse, a product-agnostic name could be "advanced-ocr-parsing".
-->

<!-- @tpl:example
- observability-metrics-asr-nim.md
- observability-metrics-tts-nim.md
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introductory paragraph here. Replace the following example with your own text.
-->
You can use the following observability metrics for [Product Name] to create dashboards, such as [Grafana](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/). For more information, refer to [Observability](path/to/observability).

## General Observability Metrics
<!-- @tpl:naming
Do not rename this section. Delete this heading completely if observability metrics do not exist for different types of use cases for your product. In that case, you will not need to organize this page into sections.
-->

The following table describes the observability metrics for [Product Name].

<!-- @tpl:formatting
Provide general observability metrics here using a table. Include as many of the following columns in your table as possible, and delete any columns you do not have or need. Replace the sample values in the table with your own.
-->

| Category | Name                     | Type or Unit | Valid Values | Example Value | Description |
|----------|--------------------------|--------------|--------------|---------------|-------------------------------|
| GPU      | `gpu_power_usage_watts`  | Watts        | -            | 250           | The GPU instantaneous power.  |
| GPU      | `gpu_utilization`        | Float        | 0.0-1.0      | 0.85          | The GPU utilization rate.     |
| GPU      | `gpu_memory_total_bytes` | Bytes        | -            | 85899345920   | The total GPU memory.         |

<!-- @tpl:formatting
Add more sections to present observability metrics for specific use cases.
-->

## [Add a Section Heading Here]
<!-- @tpl:naming
Use title casing for the heading. Section headings are denoted with a double hashtag (##).
-->

<!-- @tpl:formatting
Provide a section introduction here.
-->
The following observability metrics [insert a description here].

<!-- @tpl:example
## Library Mode Metrics

These observability metrics apply specifically when running [Product Name] in library mode.
-->

| Category | Name                     | Type or Unit | Valid Values | Example Value | Description |
|----------|--------------------------|--------------|--------------|---------------|-------------------------------|
| GPU      | `gpu_power_usage_watts`  | Watts        | -            | 250           | The GPU instantaneous power.  |
| GPU      | `gpu_utilization`        | Float        | 0.0-1.0      | 0.85          | The GPU utilization rate.     |
| GPU      | `gpu_memory_total_bytes` | Bytes        | -            | 85899345920   | The total GPU memory.         |

<!-- @tpl:formatting
If additional sections are needed, copy and paste the boilerplate sections above here.
-->

## Related Topics
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Provide a list of links to related topics. Be sure to include correct page titles and file names for the links. Generally, DO NOT include pages in the Related Topics section that are already referenced on the page.
-->

- [Deployment Topic](deployment.md)
- [API Reference](api-reference.md)
- [Environment Variables](../environment-variables/environment-variables.md)
- [Helm Chart Values](helm-parameters.md)
