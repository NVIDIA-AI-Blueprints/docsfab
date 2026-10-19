---
title: "TODO: Change this to the actual title of the page"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# [Add the Page Title Here]
<!-- @tpl:naming
Use title casing and gerund or noun phrasing, such as Managing Namespaces (gerund phrasing) or Namespaces (noun phrasing). Only page titles get denoted with a single hashtag (#).
-->

<!-- @tpl:example
- Namespaces
- Managing Namespaces
- Managing Entities
- Data Upload for NeMo Retriever Extraction
-->

<!-- @tpl:formatting
This is the blended conceptual template. Use the blended conceptual template to explain concepts that contain procedural steps, features with embedded procedures, or processes that need conceptual framing before the steps. If you want to provide purely conceptual information, use the Conceptual Template. If you want to provide purely procedural information, use the Single Procedural Template.

When NOT to use: top-level product overview (overview.md), pure how-to tasks (use procedural task template), or standalone reference pages.

Example pages: Academic Benchmarks, About Managing Entities, Data Upload for NeMo Retriever Extraction, Namespaces, NeMo Guardrails Terminology, NeMo Studio Feature Overview.
-->

<!-- @tpl:example
To get started, refer to [Filtering](https://docs.nvidia.com/nemo/curator/latest/curate-video/process-data/filtering).
-->

<!-- @tpl:naming
Rename the file and save it in the appropriate project repository. The filename gets included in the URL. Try to name your file in a way that the content can change without having to change the filename (and the URL). For better SEO, use hyphens instead of underscores. Avoid putting product names in file names whenever possible. For example, instead of nemoretriever-parse, a product-agnostic name could be "advanced-ocr-parsing".
-->

<!-- @tpl:example
- creating-namespaces.md
- managing-workflows.md
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide the first paragraph here (Explain the "what"). Replace the following conceptual information with your own.
-->
Your first paragraph should name the concept, name the product, and link to the product overview page. You can mention the benefits of the concept, but do not describe it in detail yet. Ideally, the first paragraph should be no longer than two sentences, and the link to the product overview page should be the last thing in the paragraph. If there is a related page that the user should possibly visit instead, link to it in the first paragraph before the user invests time in reading this page.

<!-- @tpl:example
- To learn more about security and authentication, refer to [Product Name](/path/to/overview.md).
- To learn how [Product Name] handles and uploads data, refer to [Product Documentation](/path/to/overview.md).
- [Product Name](/path/to/overview.md) is typically installed and used as one part of a larger solution.
-->

<!-- @tpl:formatting
Provide the second paragraph here (Explain the "why"). Replace the following conceptual information with your own.
-->
Your second paragraph should start describing the concept in more detail. You can add more sections to describe different aspects of the concept. Explain why this information is relevant. Include background information or techniques for using the technology. Include use cases. You can also explain how the concept works and or how it fits into the larger ecosystem. Do not repeat information that already exists. Use links instead.

<!-- @tpl:example
Namespaces and projects are organizational entities that help you structure all other entities and files in a logical way. You can use namespaces and projects to organize other entities by user, team, or other criteria.
-->

<!-- @tpl:formatting
If the first and second paragraph only total three to four sentences, then combine them into a single paragraph.
-->
<!-- @tpl:visual-representation
Optionally, provide a diagram here. You can include a diagram to help explain the concept. The diagram should be placed after the introductory paragraphs. Add a sentence to introduce the diagram immediately before the diagram. Replace the following example with your own text and diagram.
-->

The following diagram shows how curation stages chain together in a pipeline, from raw input to curated output:

```{image} img-file-name-and-location.png
:width: 750px
```

## [Add a Heading for the First Conceptual Section Here]
<!-- @tpl:naming
Sections are optional. Use title casing for the heading. Section headings are denoted with a double hashtag (##).
-->

<!-- @tpl:formatting
Provide the conceptual information for this section here. Your first conceptual section should explain this aspect of the concept in one or two paragraphs. Subsection headings are denoted with a triple hashtag (###). Replace the following example with your own text.
-->
Each curation stage receives a batch of records, applies a scoring function, and passes records above the threshold to the next stage. Stages are stateless - they do not retain data between batches.

### [Add a Heading for a Subsection Here]
<!-- @tpl:naming
Subsections are optional. Use title casing for the heading. Subsection headings are denoted with a triple hashtag (###).
-->

<!-- @tpl:formatting
Provide the conceptual information for this subsection here. Your subsection should provide one or two sentences with more detail on a specific aspect. Replace the following example with your own text.
-->
Score thresholds are configurable per stage. A common pattern sets a lenient threshold during exploration and tightens it for production runs.

### How the [Insert the Name of the Concept Here Using Noun Phrasing] Works
<!-- @tpl:optional
Use this section to explain how the concept works. This can also be a subsection of another section on the page. Explain how the concept works from the user's point of view. You can also include implementation details or code examples for common use cases at a high level. You should link to other pages that provide granular architecture and implementation details.
-->

<!-- @tpl:formatting
Provide the conceptual information for this section here. Replace the following example with your own text.
-->
To interact with your projects, the server exposes a primary GraphQL API. By default, the server listens on http://localhost:10001. When installed on a remote location, you can access the server from your primary system using an SSH tunnel, with the server mapped to a different port.

## [Add a Heading for the Procedure Section Here]
<!-- @tpl:naming
Use title casing and start with an active verb, such as Enable Motion and Aesthetic Filtering. Section headings are denoted with a double hashtag (##).
-->

<!-- @tpl:formatting
Use this section when the topic contains ONE procedure (a maximum of nine steps). If you need multiple procedures, use the Template for Creating Procedure Topics with Multiple Procedures instead.
-->

<!-- @tpl:formatting
Provide an introductory paragraph here. Replace the following example with your own text.
-->
The introductory paragraph should explain the purpose of the procedure and the end goal. Procedural topics (task topics) help users complete tasks. Procedure topics with only one procedure may include:

- Links to conceptual and reference material from the introductory paragraph
- Prerequisites
- No more than nine steps

<!-- @tpl:optional
Provide the list of prerequisites here. Replace the following steps with your own.
-->
Before you start, you must complete the following prerequisites:

1. Start each step with an active verb.
2. Format the prerequisites as an ordered list.
3. Try to avoid "Ensure that."

To [insert the title of the file here using sentence casing], complete the following steps:

<!-- @tpl:example
To set up project entities for NeMo Platform, complete the following steps:
-->

<!-- @tpl:formatting
Provide the steps for the procedure here. Replace the following steps with your own.
-->
1. Start each step with an active verb.

   <ol type="a">
      <li>Include sub-numbered lists for steps that require the user to complete a series of actions formatted
      using HTML.</li>
      <li>Include multiple sub-numbered items in the list.</li>
      If you find yourself only adding one sub-numbered item, then consider rewriting the parent numbered item to
      include the sub-numbered item.
   </ol>

2. Include multiple steps.
   <!-- @tpl:formatting
   If you find yourself only adding one step, then you do not need a numbered list. You can simply present the
   information in paragraph form.
   -->
   
3. Add an unordered list after a numbered item that does not have the user follow a series of sequential actions,
   such as a list of parameter descriptors:

   - `image.repository`: Specifies the container/NIM to deploy.
   - `image.tag`: Defines the version of that container/NIM.
   
4. Include tables after steps for complex information.
   Do **not** try to duplicate reference information. Simply cross-reference any reference topics.
   
   <!--  @tpl:formatting 
   For easy maintenance and better readability, you
   can format the table in HTML instead of markdown: 

   <table>
   <thead>
     <tr>
       <th>Argument</th>
       <th>Description</th>
     </tr>
   </thead>
   <tbody>
     <tr>
       <td>
           <code>--enable-auto-tool-choice</code>
       </td>
       <td>
           <p>Allows the model to choose between generating text or calling a tool. Required for tool calling.</p>
       </td>
     </tr>
    <tr>
       <td>
           <code>--tool-call-parser &lt;parser&gt;</code>
       </td>
       <td>
           <p>Built-in parser name for extracting tool calls from model output. Must match the model’s tool calling format (for
           example, llama3_json for Llama 3.1 and 3.3).</p>
       </td>
     </tr>
     <tr>
       <td>
           <code>--tool-parser-plugin &lt;path&gt;</code>
       </td>
       <td>
           <p>Path to a custom tool-call parser file. Accepts an absolute path or a path relative to the model checkpoint
           directory (the path is used as-is — no basename stripping). Required only when no built-in parser fits your model.</p>
       </td>
     </tr>
   </tbody>
   </table>
   -->
   
5. Enter (Optional) at the beginning of a step to indicate if it is optional.
6. Add diagrams or screenshots for complex steps.
   <!-- @tpl:example
   ![Peer Review Process](../images/Peer Review Diagram.png)
   -->

   <!-- @tpl:visual-representation
   Do not include diagrams or screenshots after every step in the procedure.
   -->

7. Do **not** format steps as headings.
   <!-- @tpl:formatting
   All steps should be formatted as body text.
   -->

8. Include one sentence for each step.
   <!-- @tpl:formatting
   Enter a hard return after the step and describe what happens after completing the step when necessary.
   -->

9. Limit your procedure to nine steps.

## Best Practices
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Provide a list of best practices here. The more mature your product or feature becomes, the more likely you are to have best practices to share.
-->

Here are some best practices for using [insert the name of the concept here using noun phrasing].

- [Best Practice 1: When you use [Name of Concept], make sure to [best practice]. This [benefit of best practice]. For more information, refer to [Page Title](link.md).]
- [Best Practice 2: When you use [Name of Concept], make sure to [best practice]. This [benefit of best practice]. For more information, refer to [Page Title](link.md).]
- [Best Practice 3: When you use [Name of Concept], make sure to [best practice]. This [benefit of best practice]. For more information, refer to [Page Title](link.md).]

<!-- @tpl:example
Use namespaces to organize your entities and files in a logical way. You can use namespaces to group entities by user, team, or other criteria. For more information, refer to [Page Title](/path/to/link.md).
-->

<!-- @tpl:example
When you upload data to NeMo Retriever for extraction, make sure to format your data according to the supported formats and include all necessary metadata. For more information, refer to [Page Title](/path/to/link.md).
-->

<!-- @tpl:formatting
If you have a full page of best practices, add a link to it from here. For example: [Best Practices](https://docs.nvidia.com/deeplearning/tensorrt/latest/performance/best-practices.html).
-->
For more information, refer to [Best Practices](best-practices.md).

## Next Steps
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
The Next Steps section is only required when additional procedures follow this page. If no additional procedures follow this page, then the Next Steps section is not needed. The Next Steps section guides the user to the next procedural topic or tutorial. Replace the following next step with your own.
-->

Now that you have set up the project and dataset entities, learn how to upload and manage your project entity files using NeMo Data Store and Hugging Face by following the [Create Dataset Files tutorial](https://docs.nvidia.com/nemo/microservices/latest/manage-entities/tutorials/manage-dataset-files.html#entities-manage-dataset-files).

## Related Topics
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Provide a list of links to related topics. Be sure to include correct page titles and file names for the links. Generally, DO NOT include pages in the Related Topics section that are already referenced on the page.
-->

- [Related Conceptual Topic](link.md)
- [Procedure Topic](link.md)
- [Get Started](../get-started/get-started-overview.md)
- [Deployment Topic](deployment.md)
- [Troubleshooting](../troubleshooting/troubleshooting.md)
- [Marketing Page](link.md)
