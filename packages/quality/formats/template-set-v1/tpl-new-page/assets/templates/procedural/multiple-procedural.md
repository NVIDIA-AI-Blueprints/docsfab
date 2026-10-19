---
title: "TODO: Change this to the actual title of the page"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# [Add the Page Title Here]
<!-- @tpl:naming
Use title casing: Start with an active verb, such as Deploy NeMo Retriever Embedding NIM on Vertex AI. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the Procedural template for procedure topics that contain multiple procedures. To create procedure topics that only require one procedure, use the Template for Creating Procedure Topics with One Procedure. -->

<!-- @tpl:example
To get started, refer to [Deploy NeMo Retriever Embedding NIM on Vertex AI](https://docs.nvidia.com/nim/nemo-retriever/text-embedding/latest/deploying-vertex-ai.html).
-->

<!-- @tpl:naming
Rename the file and save it in the appropriate project repository. The filename gets included in the URL. Try to name your file in a way that the content can change without having to change the filename (and the URL). For better SEO, use hyphens instead of underscores. Avoid putting product names in file names whenever possible. For example, instead of nemoretriever-parse, a product-agnostic name could be "advanced-ocr-parsing".
-->

<!-- @tpl:example
- create-namespaces.md
- delete-namespaces.md
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
The introductory paragraph should explain the purpose of the procedure and the end goal. Procedural topics (task topics) help users complete tasks. Procedure topics with multiple procedures may include:

- Links to conceptual and reference material from the introductory paragraph
- Prerequisites
- A series of procedures that include only nine steps

## Prerequisites
<!-- @tpl:naming
Do not rename this section.
-->

Before you start, you must complete the following prerequisites:
<!-- @tpl:optional 
Provide the list of prerequisites here. Replace the following steps with your own.
-->

1. Start each step with an active verb.
2. Format the prerequisites as an ordered list.
3. Try to avoid “Ensure that”.

## [Add the First Procedure Heading Here]
<!-- @tpl:naming
Add the heading of the first procedure here (start with an active verb, such as Set Up the Working Environment). Section headings are denoted with a double hashtag (##).
-->

To [insert the title of the section heading here using sentence casing], complete the following steps:

<!-- @tpl:example 
"To set up the working environment, complete the following steps:"
-->

<!-- @tpl:formatting
Provide the steps for the procedure here. Replace the following steps with your own.
-->
1. Start each step with an active verb.

   <ol type="a">
    <li>Include nested ordered lists for steps that require the user to complete a series of actions formatted using HTML.</li>
    <li>Include multiple items in the list.</li>
        If you find yourself only adding one item, then consider rewriting the parent numbered item to include the item.
   </ol>

2. Include multiple steps.
   <!-- @tpl:formatting
   If you find yourself only adding one step, then you do not need an ordered list. You can simply present the information in paragraph form.
   -->
3. Add an unordered list after an ordered item that does not have the user follow a series of sequential actions, such as a
   list of parameter descriptions:

   - `image.repository`: Specifies the container/NIM to deploy.
   - `image.tag`: Defines the version of that container/NIM.

4. Include tables after steps for complex information.
   Do **not** try to duplicate reference information. Simply cross-reference any reference topics.
   
   <!--  @tpl:formatting 
   For easy maintenance and better readability, you can format the table in HTML instead of markdown: 

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
   Enter a hard return after the step and describe what happens after completing the step when necessary. 
9. Limit your procedure to nine steps.

## [Add the Second Procedure Heading Here]
<!-- @tpl:naming
Add the heading of the second procedure here (start with an active verb, such as Download and Push the Latest Embedding NIM Image). Section headings are denoted with a double hashtag (##).
-->

To [insert the title of the file here using sentence casing], complete the following procedure:

<!-- @tpl:example
"To download and push the latest embedding NIM image, complete the following:"
-->

<!-- @tpl:formatting
Provide the steps for the procedure here. Replace the following steps with your own.
-->
1. Start each step with an active verb.

   <ol type="a">
    <li>Include nested ordered lists for steps that require the user to complete a series of actions formatted using HTML.</li>
    <li>Include multiple items in the list.</li>
        If you find yourself only adding one item, then consider rewriting the parent numbered item to include the item.
   </ol>

2. Include multiple steps.
   <!-- @tpl:formatting
   If you find yourself only adding one step, then you do not need an ordered list. You can simply present the information in paragraph form.
   -->
3. Add an unordered list after an ordered item that does not have the user follow a series of sequential actions, such as a
   list of parameter descriptions:

   - `image.repository`: Specifies the container/NIM to deploy.
   - `image.tag`: Defines the version of that container/NIM.
   
4. Include tables after steps for complex information.
   Do **not** try to duplicate reference information. Simply cross-reference any reference topics.
   
   <!--  @tpl:formatting 
   For easy maintenance and better readability, you can format the table in HTML instead of markdown:

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
   Enter a hard return after the step and describe what happens after completing the step when necessary. 
9. Limit your procedure to nine steps.

<!-- @tpl:formatting
If additional procedures are needed, copy and paste the boilerplate sections above here.
-->

## Next Steps
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
The Next Steps section is only required when additional procedures follow this page. If no additional procedures follow this page, then the Next Steps section is not needed. The Next Steps section guides the user to the next procedural topic or tutorial. Replace the following next step with your own.
-->

Now that you have set up the project and dataset entities, learn how to upload and manage your project entity files using NeMo Data Store and Hugging Face by following the [Create Dataset Files tutorial](https://docs.nvidia.com/nemo/microservices/latest/manage-entities/tutorials/manage-dataset-files.html#entities-manage-dataset-files).
