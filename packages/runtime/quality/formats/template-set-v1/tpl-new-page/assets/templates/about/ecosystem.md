---
title: "How [Product Name] Fits Within [Broader Product Ecosystem Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

<!-- @tpl:naming
Keep this label as `ecosystem-label`; do not prefix it with the product name. Sibling pages, such as the Architecture Overview, cross reference this page with the {ref}`ecosystem-label`, so renaming it will break those cross-references.
-->

(ecosystem-label)=
# How [Product Name] Fits Within [Broader Product Ecosystem Name]
<!-- @tpl:naming
Use title casing: Start with "How [Product Name] followed by "Fits Within the [Broader Product Ecosystem Name]", such as How NeMo Gym Fits Within NeMo. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the Ecosystem template. Use it to explain how a product fits within the broader product ecosystem. -->

<!-- @tpl:example
To get started, refer to [NeMo Gym Ecosystem](https://docs.nvidia.com/nemo/gym/about/ecosystem).
-->

<!-- @tpl:formatting
Write one or two sentences positioning the product within the broader ecosystem.
Explain the parent ecosystem and how this product fits.
-->

<!-- @tpl:naming
Do not rename the file.
-->

<!-- @tpl:formatting
- Use in-page cards to present brief summaries to help navigate users to other content.
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

[Broader Product Ecosystem Name] is [description of what it is and what it does]. It includes the following products:

- **[Product 1 Name]**: [Brief description of its purpose]
- **[This Product Name]**: [Brief description highlighting its unique role]
- **[Product 3 Name]**: [Brief description of its purpose]

<!-- @tpl:formatting
Provide a detailed explanation of this product's specific role within the broader product ecosystem. What unique value does it provide? How does it complement other products? Include cross references to this product's Overview, Key Features, and Architecture Overview pages.
-->

<!-- @tpl:example
NVIDIA NeMo is a GPU-accelerated platform for training generative AI models and optimizing AI agents. It includes specialized libraries that span the model lifecycle end to end:

- **NeMo Gym**: Defines the environments (dataset, agent harness, and verifier) that agents are evaluated and trained
in (this library).
- **NeMo Curator**: Prepares, filters, and deduplicates training data at scale.
- **NeMo RL**: Runs scalable post-training (GRPO, DPO, and SFT) against those environments.

While NeMo Framework handles training and fine-tuning, NeMo Curator focuses exclusively on preparing the data those models consume. For more information about what NeMo Curator offers, refer to {doc}`Overview </path/to/overview>`, {doc}`Key Features </path/to/key-features>`, and {doc}`Architecture Overview </path/to/architecture-overview>`.
-->

## Compare Each Related Product's Purpose by Use Case
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Organize this section into subsections. Name each subsection after a primary use case and include a table with the related product names in the first column and their purpose in the second column. Use this section to help the user understand the differences between each product based on each use case. Provide an introductory sentence or paragraph that introduces the use cases for each product comparison. Replace the following example with your own text.
-->

Depending on your workflow, you may also find these NeMo libraries useful across data preparation, evaluation and training, and deployment.

### [Add the Name of the Use Case Here]
<!-- @tpl:naming
Use title casing and noun phrasing for the heading. For example: [Data](https://docs.nvidia.com/nemo/gym/main/about/ecosystem#data). Subsection headings are denoted with a triple hashtag (###).
-->

The following libraries offer data solutions:

| Library | Purpose |
|---------|---------|
| [NeMo Curator](https://github.com/NVIDIA-NeMo/Curator) | Offers scalable data preprocessing and curation. |
| [NeMo Data Designer](https://github.com/NVIDIA-NeMo/DataDesigner) | Generates synthetic training data from scratch or seed examples. |
| [NeMo Safe Synthesizer](https://github.com/NVIDIA-NeMo/Safe-Synthesizer) | Generates privacy-safe synthetic copies of sensitive datasets. |
| [NeMo Anonymizer](https://github.com/NVIDIA-NeMo/Anonymizer) | Detects and replaces sensitive data. |

### [Add the Name of the Use Case Here]
<!-- @tpl:naming
Use title casing and noun phrasing for the heading. For example: [Evaluation and Training](https://docs.nvidia.com/nemo/gym/main/about/ecosystem#evaluation--training). Subsection headings are denoted with a triple hashtag (###).
-->

The following libraries offer evaluation and training solutions:

| Library | Purpose |
|---------|---------|
| [NeMo Gym](https://github.com/NVIDIA-NeMo/Gym) | Evaluates and improves models and agents using environments *(this project)*. |
| [NeMo Evaluator](https://github.com/NVIDIA-NeMo/Evaluator) | Provides model evaluation and benchmarking. |
| [NeMo RL](https://github.com/NVIDIA-NeMo/RL) | Provides scalable post-training with GRPO, DPO, and SFT. |
| [NeMo Megatron-Bridge](https://github.com/NVIDIA-NeMo/Megatron-Bridge) | Provides pretraining and fine-tuning with Megatron-Core |
| [NeMo AutoModel](https://github.com/NVIDIA-NeMo/Automodel) | Streamlines and scales PyTorch native training for Hugging Face models. |

### [Add the Name of the Use Case Here]
<!-- @tpl:naming
Use title casing and noun phrasing for the heading. For example: [Deployment](https://docs.nvidia.com/nemo/gym/main/about/ecosystem#deployment). Subsection headings are denoted with a triple hashtag (###).
-->

The following libraries offer deployment solutions:

| Library | Purpose |
|---------|---------|
| [NeMo Agent Toolkit](https://github.com/NVIDIA/NeMo-Agent-Toolkit) | Connects and optimizes teams of AI agents. |
| [NeMo Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) | Enforces safety and policy rules. |
| [NeMo Retriever](https://github.com/NVIDIA/NeMo-Retriever) | Documents extraction and retrieval for RAG pipelines. |

## Choosing Between [Product Name] and [Most Commonly Confused Product]
<!-- @tpl:optional
Include this section only when readers commonly confuse this product with a nearby one and need help deciding between them.
-->

<!-- @tpl:example
| Product | Primary role | Typical handoff |
| --- | --- | --- |
| NeMo Curator | Prepare and validate training data. | Exports curated datasets to training workflows. |
| NeMo Framework | Train and fine-tune models. | Produces model checkpoints for deployment. |
| NVIDIA NIM | Serve optimized models for inference. | Exposes standard APIs to applications. |
-->

* **[Product 1 Name]**: [Brief description of purpose]
* **[This Product Name]**: [Brief description highlighting its unique role]
* **[Product 3 Name]**: [Brief description]

**[Product Name]'s Role**: [Detailed explanation of this product's specific role within the ecosystem. What unique value does it provide? How does it complement other products?]
