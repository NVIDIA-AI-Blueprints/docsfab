---
title: "Performance Benchmarks for [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# Performance Benchmarks for [Product Name]
<!-- @tpl:naming
Use title casing: Start with "Performance Benchmarks for" followed by the [Product Name], such as Performance Benchmarks for NeMo Retriever Embedding NIM. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the Performance Benchmarks template. Use this template to document benchmark results that help engineers understand expected throughput, latency, and resource usage for common deployment scenarios. This page might support a separate performance page, or you can have a single performance page that also contains your benchmarks. A page about improving performance should go in the user guide section. A page about performance benchmarks should go in the reference section. Reference topics document facts for lookup. Do not include step-by-step procedures in reference topics. You should link to tutorials and procedural topics instead. -->

<!-- @tpl:example
To get started, refer to [Performance Benchmarks for NIM for Speech ASR](https://docs.nvidia.com/nim/speech/latest/reference/performances/asr/performance.html) and [Performance Benchmarks for NeMo Retriever Embedding NIM](https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/performance.html).
-->

<!-- @tpl:naming
Do not rename this file if you do not need to group the performance benchmarks for your product by component. Otherwise, rename this file and save it in the appropriate project repository. The filename gets included in the URL. Try to name your file in a way that the content can change without having to change the filename (and the URL). For better SEO, use hyphens instead of underscores. Avoid putting product names in file names whenever possible. For example, instead of nemoretriever-parse, a product-agnostic name could be "advanced-ocr-parsing".
-->

<!-- @tpl:example
- performance-asr-nim.md
- performance-tts-nim.md
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introductory paragraph here. Replace the following paragraph with your own.
-->
The performance benchmark results for [Product Name] are intended to help developers understand expected throughput, latency, and resource usage for common deployment scenarios.

## Benchmark Process
<!-- @tpl:naming
Do not rename this section. Section headings are denoted with a double hashtag (##).
-->

<!-- @tpl:optional
Include this section if you need to describe how benchmark tests were run or how readers can run them themselves.
-->

## Benchmark Results
<!-- @tpl:naming
Do not rename this section. Section headings are denoted with a double hashtag (##).
-->

<!-- @tpl:formatting
Provide the main benchmark results in a concise table. Replace the following example with your own text.
-->
The following table summarizes the performance benchmarks. Throughput is measured in `TODO: units`, and latency is measured in `TODO: units`. Actual performance may vary based on hardware configuration, model size, and other factors.

<!-- @tpl:example
There is no template for the table, because usually the benchmarks are auto-generated and provided by the engineering team. However, here is an example of how you can format the table.
-->

## Performance Best Practices
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Provide a list of performance best practices here. The more mature your product or feature becomes, the more likely you are to have best practices to share.
-->

The following are some best practices for performance.

- [Best Practice 1]
<!-- @tpl:example
When you tune performance, start by measuring baseline throughput and latency before changing configuration values.
-->
- [Best Practice 2]
<!-- @tpl:example
Use observability metrics to validate that changes improve the metrics you care about. For more information, refer to [Observability Metrics](/path/to/observability-metrics.md).
-->
- [Best Practice 3]

For more information, refer to [Best Practices](best-practices.md).

## Related Topics
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Provide a list of links to related topics. Be sure to include correct page titles and file names for the links. Generally, DO NOT include pages in the Related Topics section that are already referenced on the page.
-->

- [Performance Overview](performance-overview.md)
- [Support Matrix](support-matrix.md)
- [Observability Metrics](../observability/observability-metrics.md)
