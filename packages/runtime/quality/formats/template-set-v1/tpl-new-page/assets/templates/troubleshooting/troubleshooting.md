---
title: "Troubleshooting [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

(troubleshooting-product-name)=
# Troubleshooting [Product Name]
<!-- @tpl:naming
Use title casing: Start with "Troubleshooting" followed by the [Product Name], such as Troubleshooting NeMo Retriever Embedding NIM. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the Troubleshooting template. Use the Troubleshooting template to help users resolve problems quickly. Each troubleshooting item should be concise, with clear instructions on how to resolve the issue. Do not include a lot of background information or context; link to related topic pages instead. Never say anything that blames the customer for doing something wrong. The troubleshooting page is the one place where passive voice is appropriate, because you want to avoid saying "you did this wrong". -->

<!-- @tpl:example
To get started, refer to:

- [Troubleshooting NeMo Retriever Embedding NIM](https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/troubleshoot.html)
- [Troubleshooting NeMo Retriever Extraction](https://docs.nvidia.com/nemo/retriever/latest/extraction/troubleshoot/)
- [Troubleshooting NeMo Microservices Evaluator](https://docs.nvidia.com/nemo/microservices/latest/troubleshooting/evaluator.html)
- [Troubleshooting NeMo Microservices Customizer](https://docs.nvidia.com/nemo/microservices/latest/troubleshooting/customizer.html)
-->

<!-- @tpl:naming
Do not rename the file if the troubleshooting guidance does not need to be grouped by use case, feature, or component. Otherwise, rename the file and save it in the appropriate project repository. The filename gets included in the URL. Try to name your file in a way that the content can change without having to change the filename (and the URL). For better SEO, use hyphens instead of underscores. Avoid putting product names in file names whenever possible. For example, instead of nemoretriever-parse, a product-agnostic name could be "advanced-ocr-parsing".
-->

<!-- @tpl:example
- troubleshooting-asr-nim.md
- troubleshooting-tts-nim.md
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introductory paragraph here.
-->
The following issues might arise when you work with [Product Name](../about/overview.md).

<!-- @tpl:optional
If your release notes have an "All Known Issues" section, add a note and cross-reference it here.
-->
:::{note}
For the full list of known issues, refer to [Known Issues](../release-notes/release-notes.md#all-known-issues).
:::

(troubleshooting-issue-name-1)=
## [Add an Issue Heading Here (Issue 1)]
<!-- @tpl:naming
Phrase the heading as the symptom the user observes (the error message text or what fails), not the internal cause or fix. Add this section alphabetically, not at the beginning or the end of the page.
-->

<!-- @tpl:formatting
Provide the troubleshooting item here.
-->
When you [scenario], you might see the following message: [error message].
When you [scenario], [issue] might occur.
To resolve this issue, [solution].
For more information, refer to [Related Topic](link.md).

<!-- @tpl:example
(troubleshooting-out-of-memory-on-deploy)=
## Out of Memory Issues When Deploying the nim-llm Service

If the wrong profile is selected automatically during deployment, you might see the following error: `torch.OutOfMemoryError: CUDA out of memory.` To resolve this issue, use the `NIM_MODEL_PROFILE` variable to set the correct profile. For more information, refer to the [Deployment Guide](/path/to/deployment-guide.md).
-->

(troubleshooting-issue-name-2)=
## [Add an Issue Heading Here (Issue 2)]
<!-- @tpl:naming
Phrase the heading as the symptom the user observes. Add this section alphabetically, not at the beginning or the end of the page.
-->

<!-- @tpl:formatting
Provide the troubleshooting item here.
-->
When you [scenario], you might see the following message: [error message].
When you [scenario], [issue] might occur.
To resolve this issue, [solution].
For more information, refer to [Related Topic](link.md).

(troubleshooting-issue-name-3)=
## [Add an Issue Heading Here (Issue 3)]
<!-- @tpl:naming
Phrase the heading as the symptom the user observes. Add this section alphabetically, not at the beginning or the end of the page.
-->

<!-- @tpl:formatting
Provide the troubleshooting item here.
-->
When you [scenario], you might see the following message: [error message].
When you [scenario], [issue] might occur.
To resolve this issue, [solution].
For more information, refer to [Related Topic](link.md).

<!-- @tpl:formatting
If additional troubleshooting items are needed, copy and paste the boilerplate sections above here.
-->

(troubleshooting-error-messages)=
## Error Messages
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Include this section if your product produces specific error messages.
-->

<!-- @tpl:formatting
Format the error messages as a table. Include as many of the following columns in your table as possible, and delete any columns you do not have or need: Error Code, Error Message, Description, and Solution or Workaround.
-->

| Error Code | Error Message | Description | Solution or Workaround |
| --- | --- | --- | --- |
| <error code> | <error message> | <description> | <solution> |
| <error code> | <error message> | <description> | <solution> |
| <error code> | <error message> | <description> | <solution> |

<!-- @tpl:example
| Error Message | Description | Solution or Workaround |
| --- | --- | --- |
| `Custom layer <name> returned non-zero initialization.` | This error can occur if the initialize() method of a plugin layer returns a non-zero value. | Refer to the implementation of the plugin layer to debug this error. For more information, refer to the [NVIDIA TensorRT Operators Reference](/path/to/link.md). |

| Error Code | Error Message |
| --- | --- |
| `0x30020005` | `Brev is not currently supported for remote installs from Windows.` |

| Error Code | Error Message | Description | Solution or Workaround |
| --- | --- | --- | --- |
| `500` | `Server Error` | An unexpected error occurred on the server. | Check the server logs for more information and contact Support if the issue persists. |
-->

## Related Topics
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Replace each path/to/... placeholder with the corresponding page path in the target documentation repository. Generally, DO NOT include pages in the Related Topics section that are already referenced on the page.
-->

- [Support Matrix](path/to/support-matrix.md)
- [Release Notes](path/to/release-notes.md)
- [Prerequisites](path/to/prerequisites.md)
- [Deployment Topic](path/to/deployment.md)
- [Related Topic 1](path/to/related-topic-1.md)
- [Related Topic 2](path/to/related-topic-2.md)
