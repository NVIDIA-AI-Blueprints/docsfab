---
title: "Helm Chart Values for [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# Helm Chart Values for [Product Name]
<!-- @tpl:naming
Use title casing: Start with "Helm Chart Values for" followed by [Product Name], such as Helm Chart Values for NeMo Retriever Text Reranking NIM. Only page titles get denoted with a single hashtag (#).
-->

<!-- @tpl:optional
This is the Helm Chart Values template. This template should only be used if there are Helm chart values for your product that users can specify in a Helm chart values file or by passing them directly to the Helm install/upgrade command. Reference topics document facts for lookup. Do not include step-by-step procedures in reference topics. You should link to tutorials and procedural topics instead.
-->

<!-- @tpl:example
To get started, refer to [Helm Chart Values for NeMo Retriever Text Reranking NIM](https://docs.nvidia.com/nim/nemo-retriever/text-reranking/latest/parameters.html).
-->

<!-- @tpl:naming
Do not rename this file if the Helm chart values for your product are not grouped by component. Otherwise, rename this file and save it in the appropriate project repository. The filename gets included in the URL. Try to name your file in a way that the content can change without having to change the filename (and the URL). For better SEO, use hyphens instead of underscores. Avoid putting product names in file names whenever possible. For example, instead of nemoretriever-parse, a product-agnostic name could be "advanced-ocr-parsing".
-->

<!-- @tpl:example
- helm-parameters-asr-nim-gfm.md
- helm-parameters-tts-nim-gfm.md
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use headings, tables, or details blocks to present command variants.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introductory paragraph here. Replace the following example with your own text.
-->
You can use the following Helm chart values to configure [Product Name]. You can specify these Helm chart values in your file or by passing them directly to the Helm install/upgrade command.

## General Helm Chart Values
<!-- @tpl:naming
Do not rename this section. Delete this heading completely if Helm chart values do not exist for different types of use cases for your product. In that case, you will not need to organize this page into sections.
-->

The following table describes the general Helm chart values for [Product Name].

<!-- @tpl:formatting
Provide general Helm chart values here using a table. Include as many of the following columns in your table as possible, and delete any columns you do not have or need. Replace the sample values in the table with your own.
-->

| Key                   | Type    | Valid Values                                      | Default Value | Example Value         | Description |
|-----------------------|---------|---------------------------------------------------|---------------|-----------------------|--------------------------------------------------------------------------------------------|
| `INGEST_LOG_LEVEL`    | Enum    | - `DEBUG` <br/> - `WARNING` <br/> - `ERROR` <br/> | `INFO`        | `DEBUG`               | The log level for the ingest service, which controls the verbosity of the logging output.  |
| `MESSAGE_CLIENT_PORT` | Integer | -                                                 | `8080`        | `7670`                | The port number on which the message broker is listening.                                  |
| `NVIDIA_API_KEY`      | String  | -                                                 | -             | `nvapi-*************` | An API key for NVIDIA-hosted NIM services.                                                 |

<!-- @tpl:example
| Key                              | Default    | Description         | Advantages           | Disadvantages            |
|----------------------------------|------------|---------------------|----------------------|--------------------------|
| `APP_NVINGEST_CHUNKOVERLAP`      | `150`      | Increase overlap to ensure smooth transitions between chunks. | - Larger overlap provides smoother transitions between chunks. <br/>  | - Might increase processing overhead. <br/> |
| `APP_NVINGEST_CHUNKSIZE`         | `512`      | Increase chunk size for more context. | - Larger chunks retain more context, improving coherence. <br/> | - Larger chunks increase embedding size, slowing retrieval. <br/> - Longer chunks might increase latency due to larger prompt size. <br/> |
| `APP_NVINGEST_ENABLEPDFSPLITTER` | `true`     | Set to `true` to perform chunk-based splitting of pdfs after the default page-level extraction occurs. Recommended for PDFs that are mostly text content. | - Provides more granular content segmentation. <br/> | - Can increase the number of chunks and slow down the ingestion process. <br/> |
-->

<!-- @tpl:optional
Add more sections to present Helm chart values for specific use cases.
-->

## [Add a Section Heading Here]
<!-- @tpl:naming
Use title casing for the heading. Section headings are denoted with a double hashtag (##).
-->

<!-- @tpl:formatting
Provide a section introduction here.
-->
These Helm chart values [insert a description here].

<!-- @tpl:example
## Library Mode

These Helm chart values apply specifically when running [Product Name] in library mode.

## Retrieval and Generation

Use the following Helm chart values to configure retrieval and generation for [Product Name].
-->

| Key                   | Type    | Valid Values                                      | Default Value | Example Value         | Description |
|-----------------------|---------|---------------------------------------------------|---------------|-----------------------|--------------------------------------------------------------------------------------------|
| `INGEST_LOG_LEVEL`    | Enum    | - `DEBUG` <br/> - `WARNING` <br/> - `ERROR` <br/> | `INFO`        | `DEBUG`               | The log level for the ingest service, which controls the verbosity of the logging output.  |
| `MESSAGE_CLIENT_PORT` | Integer | -                                                 | `8080`        | `7670`                | The port number on which the message broker is listening.                                  |
| `NVIDIA_API_KEY`      | String  | -                                                 | -             | `nvapi-*************` | An API key for NVIDIA-hosted NIM services.                                                 |

<!-- @tpl:example
| Key                              | Default    | Description         | Advantages           | Disadvantages            |
|----------------------------------|------------|---------------------|----------------------|--------------------------|
| `APP_NVINGEST_CHUNKOVERLAP`      | `150`      | Increase overlap to ensure smooth transitions between chunks. | - Larger overlap provides smoother transitions between chunks. <br/>  | - Might increase processing overhead. <br/> |
| `APP_NVINGEST_CHUNKSIZE`         | `512`      | Increase chunk size for more context. | - Larger chunks retain more context, improving coherence. <br/> | - Larger chunks increase embedding size, slowing retrieval. <br/> - Longer chunks might increase latency due to larger prompt size. <br/> |
| `APP_NVINGEST_ENABLEPDFSPLITTER` | `true`     | Set to `true` to perform chunk-based splitting of pdfs after the default page-level extraction occurs. Recommended for PDFs that are mostly text content. | - Provides more granular content segmentation. <br/> | - Can increase the number of chunks and slow down the ingestion process. <br/> |
-->

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

- [Deployment Topic](deployment-gfm.md)
- [API Reference](api-reference-gfm.md)
- [Environment Variables](../environment-variables/environment-variables-gfm.md)
