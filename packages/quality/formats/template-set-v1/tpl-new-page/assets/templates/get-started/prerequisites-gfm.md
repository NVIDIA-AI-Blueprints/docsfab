---
title: "[Product Name] Prerequisites"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# [Product Name] Prerequisites
<!-- @tpl:naming
Use title casing: Start with the [Product Name] followed by "Prerequisites", such as NIM for LLMs Prerequisites. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the Prerequisites template. Use it for a comprehensive requirements reference page that documents all system requirements, verified configurations, and preparation steps. Keep it separate from the Installation Guide so that users can reference requirements without re-reading installation steps. -->

<!--  @tpl:example
To get started, refer to [NIM for LLMs Prerequisites](https://docs.nvidia.com/nim/large-language-models/latest/get-started/prerequisites.html) and [Speech NIM Microservices Prerequisites](https://docs.nvidia.com/nim/speech/latest/get-started/prerequisites.html).
-->

<!-- @tpl:naming
Do not rename the file.
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use headings, tables, or details blocks to present command variants.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

To get started with [Product Name], you must complete the necessary prerequisites.

<!-- @tpl:formatting
Organize the various prerequisites into sections and subsections. Delete any sections or subsections below that do not apply.
-->

## Hardware
<!-- @tpl:naming
Do not rename this section.
-->

Verify that your machine meets the following hardware prerequisites.

<!-- @tpl:formatting
If the hardware prerequisites are minimal, subsections below do not apply, and you do not have other hardware prerequisites to add as a subsection, then simply summarize the prerequisites here using sentences and unordered lists.
-->

<!-- @tpl:example
The AlphaFold2-Multimer NIM is configured to run on a single GPU. The minimum GPU memory requirement for the AlphaFold2-Multimer NIM is 32GB. The AlphaFold2-Multimer NIM should run on any NVIDIA GPU that meets this minimum hardware requirement and has compute capability ≥ 8.0. The AlphaFold2-Multimer NIM also requires at least 1300GB of free hard drive space to store the various MSA databases required by endpoints exposed from the NIM.

To successfully run the AlphaFold2-Multimer NIM for short sequences / multimers, your system should have:

- One NVIDIA GPU with ≥ 32GB of VRAM and Compute Capability ≥ 8.0.
- At least 64 GB of RAM.
- A CPU with at least 24 available cores.
- At least 512GB of free SSD drive space.

For optimal performance on long sequences / multimers and multiple MSA databases, it's recommended that your system have:

- At least one NVIDIA GPU with 80GB of RAM (e.g. A100 80GB).
- At least 128GB of RAM.
- A CPU with at least 36 available cores.
- At least 512GB of free fast NVMe SSD drive space.
-->

### Compute
<!-- @tpl:naming
Do not rename this subsection.
-->

The following compute specifications are required:

- **CPU**: [Minimum specification, for example: Any modern x86_64 or ARM64 processor]
- **GPU**: [GPU requirements if applicable, for example: Not required for basic usage, NVIDIA GPU with 16GB+ VRAM for acceleration]
- **RAM**: [Memory requirements, for example: Minimum 8 GB (16 GB+ recommended)]
- **Storage**: [Disk space requirements, for example: Minimum 2 GB free disk space]

> **Note:**
> <!-- @tpl:formatting
> Add a note to clarify when GPU or advanced hardware is needed versus optional.
> -->


### Production Hardware
<!-- @tpl:naming
Do not rename this subsection.
-->

<!-- @tpl:optional
Include this section only when production deployments have different hardware requirements.
-->

The following production hardware is required:

<!-- @tpl:example
| Resource | Development | Production |
| --- | --- | --- |
| CPU | 8 cores | 32+ cores across workers |
| GPU | Optional for CPU-only text stages | NVIDIA GPU with workload-appropriate VRAM for accelerated stages |
| RAM | 16 GB | 64 GB+ per worker for large datasets |
| Storage | 20 GB local workspace | Shared object storage sized for input, output, and checkpoints |
-->

| Resource | Development | Production |
| --- | --- | --- |
| **CPU** | [Dev spec] | [Prod spec] |
| **GPU** | [Dev spec] | [Prod spec] |
| **RAM** | [Dev spec] | [Prod spec] |
| **Storage** | [Dev spec] | [Prod spec] |

## Software
<!-- @tpl:naming
Do not rename this section.
-->

Install the following software dependencies.

<!-- @tpl:formatting
If the software prerequisites are minimal, subsections below do not apply, and you do not have other software prerequisites to add as a subsection, then simply summarize the prerequisites here using sentences and unordered lists.
-->

<!-- @tpl:example
| Requirement | Description |
| --- | --- |
| Operating System | Ubuntu 22.04 LTS or later recommended |
| Container Toolkit | 1.14.0 or later |
| CUDA SDK | 12.9 or later |
| GPU Driver | 580 or later |
| Docker | 24.0 or later |
-->

### Operating System
<!-- @tpl:naming
Do not rename this subsection.
-->

The following operating systems are supported:

- **Linux**: [Supported versions, for example: Ubuntu 20.04+, CentOS 7+, or equivalent]
- **macOS**: [Supported versions, for example: 11.0+ for x86_64, 12.0+ for Apple Silicon]
- **Windows**: [Support status, for example: Using WSL2 (Ubuntu 20.04+ recommended)]

### Runtime Dependencies
<!-- @tpl:naming
Do not rename this subsection.
-->

The following runtime dependencies are required:

- **Python**: [Version requirements, for example: 3.10, 3.11, or 3.12 (required)]
- **[Dependency 2]**: [Description, for example: Git for cloning repositories]
- **[Dependency 3]**: [Description, for example: Docker for container deployments]

### GPU Software Stack
<!-- @tpl:naming
Do not rename this subsection.
-->

<!-- @tpl:optional
Include this section only when GPU acceleration is supported.
-->

The following GPU software stack is required:

<!-- @tpl:example
"GPU-accelerated stages such as semantic deduplication and embedding generation require CUDA 12 and an NVIDIA GPU with enough VRAM for the selected model and batch size. CPU-only workflows have no CUDA requirement."
-->

- **CUDA**: [Version requirements, for example: CUDA 12.0 or later]
- **cuDNN**: [Version requirements if applicable]
- **Driver**: [Minimum driver version]

## Verified Configurations
<!-- @tpl:naming
Do not rename this section.
-->

The following configurations have been tested and verified to work:

| Operating System | Architecture | Python Version | GPU | Status |
| --- | --- | --- | --- | --- |
| Ubuntu 22.04 LTS | x86_64 | 3.12 | NVIDIA A100 | ✅ Verified |
| Ubuntu 22.04 LTS | x86_64 | 3.11 | CPU-only | ✅ Verified |
| macOS 14+ | Apple Silicon | 3.12 | N/A | ✅ Verified |
| macOS 13+ | x86_64 (Intel) | 3.12 | N/A | ✅ Verified |
| Windows 11 | x86_64 (WSL2) | 3.12 | NVIDIA RTX | ✅ Verified |

## Network Access
<!-- @tpl:naming
Do not rename this section.
-->

Some features require network access for downloads, API calls, or license validation.

- **Internet Connection**: [Required/optional, for example: Required for downloading dependencies and accessing APIs]
- **Firewall**: [Any ports that need to be open]
- **Proxy**: [Proxy support status and configuration]

<!-- @tpl:formatting
If the network access prerequisites are minimal, then simply summarize the prerequisites here using sentences.
-->

<!-- @tpl:example
Internet access is required during installation to download Python packages. At runtime, network access is only needed if stages fetch remote models or read from object storage.
-->

### External API Service Access
<!-- @tpl:naming
Do not rename this subsection.
-->

<!-- @tpl:optional
Include this section only when the product requires external API access.
-->

Use the following external API services to gain the necessary access:

- **[Service 1]**: [Description, for example: OpenAI API key with available credits]
- **[Service 2]**: [Description, for example: Cloud storage access for datasets]

## Domain-Specific
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Include this section only when different features or domains have additional requirements beyond the base setup.
-->

Certain features or domains have additional requirements beyond the base setup.

<!-- @tpl:example
GPU-accelerated stages (semantic dedup, embedding similarity) require CUDA 12.0+ and an NVIDIA GPU with 16 GB+ VRAM. CPU-only workflows have no additional requirements.
-->

<!-- @tpl:formatting
Add one subsection for each domain or feature with unique requirements.
-->

### [Domain/Feature Name] Requirements
<!-- @tpl:naming
Do not rename this subsection.
-->

- **[Requirement]**: [Description]
- **[Requirement]**: [Description]

<!-- @tpl:example
### Video Curation

- **GPU**: NVIDIA GPU with 24 GB+ VRAM (decoding and aesthetic scoring run on device)
- **CUDA**: 12.0 or later, matching your installed driver
- **FFmpeg**: 6.0+ with NVDEC support for hardware-accelerated decoding
- **Disk**: 50 GB+ free for intermediate scene clips
-->

## Pre-Installation Checklist
<!-- @tpl:naming
Do not rename this section.
-->

Review the following checklist before installing [Product Name or Feature Name]:
<!-- @tpl:example
Review the following checklist before running the `pip install`. Skipping GPU driver setup is fine for CPU-only workflows.
-->

- [ ] **Operating system** meets minimum requirements
- [ ] **Python** [version] installed and accessible
- [ ] **[X] GB RAM** is available
- [ ] **[X] GB disk space** is available
- [ ] **[Optional] GPU** drivers installed (if using GPU acceleration)
- [ ] **Network access** is set up for required services
- [ ] **API credentials** have been obtained (if required)

<!-- @tpl:formatting
Update the checklist based on your specific prerequisites.
-->

## Troubleshoot Prerequisites
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Use this section to document common pre-installation issues and solutions. Only include a maximum of three issues. Cross-reference the full Troubleshooting Guide for your product to help users obtain additional troubleshooting guidance.
-->

If you encounter issues verifying your prerequisites, check these common solutions.

<!-- @tpl:formatting
If your Book has a general Troubleshooting section with a Prerequisites subsection, link to it here instead of duplicating content.
-->

<!-- @tpl:formatting
Document common pre-installation issues and solutions.
Limit to a maximum of three, then defer to the full troubleshooting section.
-->

<!-- @tpl:example
- Run `python --version` to confirm the supported interpreter is active.
- Run `df -h .` to confirm enough workspace storage is available.
- Run `nvidia-smi` to confirm the driver can see each required GPU.
-->

<details>
<summary>Python version not supported</summary>


```bash
# Check your Python version
python --version

# [Commands to install correct version if needed]
```

</details>


<details>
<summary>Insufficient disk space</summary>


```bash
# Check available disk space
df -h

# [Suggestions for freeing space or changing install location]
```

</details>


<details>
<summary>GPU not detected</summary>


```bash
# Check GPU availability
nvidia-smi

# [Common solutions for GPU issues]
```

</details>


## Next Steps
<!-- @tpl:naming
Do not rename this section.
-->

If you're ready to install [Product Name or Feature Name], proceed to the [Installation Guide](installation-gfm.md).
