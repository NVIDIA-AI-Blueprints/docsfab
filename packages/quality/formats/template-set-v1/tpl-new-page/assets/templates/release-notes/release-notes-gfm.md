---
title: "Release Notes for [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# Release Notes for [Product Name]
<!-- @tpl:naming
Use title casing: Start with "Release Notes for" followed by the [Product Name], such as Release Notes for NeMo Retriever Extraction. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the Release Notes template. Use the Release Notes template to document changes, new features, fixed issues, and known issues for each product release. There should only be one version in the release notes file. Users can find previous release notes by using the version switcher in the documentation or the links at the end of this page.

Exception 1: Include patch releases on the same page (in reverse chronological order).
Exception 2: If your documentation does not have a version switcher, include all versions on one page (in reverse chronological order). Over time, if this page becomes too long, keep one page for the most recent release notes, and move older release notes to a separate file or folder. Work with a technical writer to determine the best way to organize your release notes in this case. -->

<!-- @tpl:example
To get started, refer to [Release Notes for NVIDIA Speech NIM Microservices](https://docs.nvidia.com/nim/speech/latest/about/release-notes.html).
-->

<!-- @tpl:naming
Rename the file and save it in the appropriate project repository. The filename gets included in the URL. Try to name your file in a way that the content can change without having to change the filename (and the URL). For better SEO, use hyphens instead of underscores. Avoid putting product names in file names whenever possible. For example, instead of nemoretriever-parse, a product-agnostic name could be "advanced-ocr-parsing".
-->

<!-- @tpl:example
- release-notes-2.0-gfm.md
- release-notes-pb-6-gfm.md
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use headings, tables, or details blocks to present command variants.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
- Do not include full how-to procedures; link to guides and reference pages instead.
-->

Use these release notes to learn about the latest changes, features, fixed issues, and known issues for [Product Name](../about/overview-gfm.md).

<!-- @tpl:optional
If you have at least one PB release, include the following note.
-->
> **Note:**
> Some releases are labelled "Production Branch" or "(PB)". Production Branches provide reliable, stable versions of the NIM. Non-production branch releases (sometimes called Feature Branch (FB) releases) contain the latest features, improvements, and optimizations.


## Release [Number.Number.Number]
<!-- @tpl:formatting
Provide the release summary here.
-->
This release [focus / soul / spirit of the release]...

<!-- @tpl:example
This is a patch release of [Product Name]. This release <focus / soul / spirit of the release>...
This is the first generally available release for [Product Name]. This release <focus / soul / spirit of the release>...
This is a public beta release of [Product Name]. This release <focus / soul / spirit of the release>...
This release adds RTX6000 platform support, adds deployment by using NIM operator, improves vector database pluggability with the blueprint, and other changes.
NVIDIA NIM for LLMs 1.14.1 introduces enhancements to per-request metrics control, API request handling improvements, and validation fixes.
The NeMo Retriever extraction 25.09 release adds new hardware and software support, and other improvements.
The NeMo Retriever extraction 25.06 release focuses on accuracy improvements and feature expansions, including the following:
The NeMo Retriever extraction 25.6.3 release is a patch release that updates the client's dependency on pypdfium2 to the latest stable version.
-->

### Highlights
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Provide a list of key changes here. Don't include a fixed item if it is a fixed known issue. Add it to the fixed known issue section instead. Replace the following example with your own text.
-->

This release contains the following key changes:

- CVE fixes for high and critical vulnerabilities.
- You now see a message if a selected app doesn't have log output.
- For custom applications you can now set an optional field `StartTimeoutSeconds` for the time to wait for the application to start.
- The installer now uses the built-in `ver` command to validate Windows versions.
- Added functional support for [RTX Pro 6000 Blackwell Server Edition](link-gfm.md).
- Added support for [llama-3.2-nemoretriever-1b-vlm-embed-v1](link-gfm.md).
- Added support for custom vector database implementations. For details, refer to [Build a Custom Vector Database Operator](link-gfm.md).
- Improved developer experience in Kit 106.5 by providing clearer error messaging when API errors occur.
- Optimized TensorRT engine profiles for reduced GPU VRAM usage and improved cache utilization.
- Upgraded to use Triton Inference Server 25.08 to address CVEs.
- The `NIM_TRITON_OPTIMIZATION_MODE` environment variable is no longer supported.
- Fixed typos in the user interface.

### Support Matrix and Compatibility Updates
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Include this section if you have support matrix or compatibility updates for this release. Replace the following example with your own text.
-->

- Added support for B200. For details, refer to [Support Matrix](support-matrix-gfm.md).

### Fixed Known Issues
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Provide a list of known issues that have been fixed.
-->

This version fixes the following known issues:

- Fixed known issue 1. For more information, refer to [Page Title](link-gfm.md) or [Troubleshooting](../troubleshooting/troubleshooting-gfm.md).
- Fixed known issue 2. For more information, refer to [Page Title](link-gfm.md) or [Troubleshooting](../troubleshooting/troubleshooting-gfm.md).
- Fixed known issue 3. For more information, refer to [Page Title](link-gfm.md) or [Troubleshooting](../troubleshooting/troubleshooting-gfm.md).

For the full list of known issues, refer to [All Known Issues](#all-known-issues).

<!-- @tpl:example
- Fixed close-window handling for native title bars so that closing a window now follows expected shutdown behavior.
- Fixed file conflict status when Docker Compose is not updated immediately.
- Fixed bug where list-model-profiles command fails to run on hosts that don't have an NVIDIA GPUs, even when `NIM_CPU_ONLY` is set.
- Fixed bug where list-model-profiles command returns custom models that should not be used.
- Fixed regression for interaction with deformables.
- Fixed an issue where large text file ingestion failed.
- Fixed an issue where the vLLM profile was always chosen as the default. For details, refer to [Profile Selection](/path/to/link-gfm.md).
-->

## All Known Issues
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
If the current release has no known issues, replace the introduction and the list below with this single sentence: "Currently, there are no known issues for [Product Name]." Do not ship both the "no known issues" sentence and a list of known issues.
-->

<!-- @tpl:formatting
Provide a list of known issues here.
-->
This release includes the following known issues for [Product Name]:

- (New in version N.N.0) Known issue 1. [Page Title](link-gfm.md) or [Troubleshooting](../troubleshooting/troubleshooting-gfm.md).
- (New in version N.N.0) Known issue 2. [Page Title](link-gfm.md) or [Troubleshooting](../troubleshooting/troubleshooting-gfm.md).
- Known issue 3. [Page Title](link-gfm.md) or [Troubleshooting](../troubleshooting/troubleshooting-gfm.md).
- Known issue 4. [Page Title](link-gfm.md) or [Troubleshooting](../troubleshooting/troubleshooting-gfm.md).
- Known issue 5. [Page Title](link-gfm.md) or [Troubleshooting](../troubleshooting/troubleshooting-gfm.md).

<!-- @tpl:example
- Currently, Helm-based deployment is not supported for NeMo Guardrails.
- The `cancel` endpoint is not available for evaluation jobs.
- The `logs` endpoint is not available for evaluation jobs. Instead, use the `download-results` endpoint. For more information, refer to [Get Evaluation Results](/path/to/link-gfm.md).
- The `PATCH` method is not supported. For more information, refer to [API Reference](/path/to/link-gfm.md).
- The `list-model-profiles` command incorrectly lists compatible model profiles as incompatible. Select the profile that matches your hardware configuration. This bug does not impact automatic profile selection.
- The `persistence.enabled` value and all related dependent configuration flags are currently non-functional in the NIM Helm chart.
- If you override `NIM_TRITON_MAX_BATCH_SIZE`, a known TensorRT bug can occur in which a CUDA illegal memory access error is returned in the Triton response. If you must reduce VRAM usage, set `NIM_TRITON_OPTIMIZATION_MODE=vram_opt` to set the batch size to 1. For more information about setting this variable, refer to [Environment Variables](/path/to/link-gfm.md).
- The NeMo Retriever extraction pipeline does not support ingestion of batches that include individual files greater than approximately 400MB.
- FP8 profiles are not released due to accuracy degradations.
- LoRA is not supported.
- In tool calling, `tool_choice` is always set to `auto`. For more information, refer to [Tool Calling](/path/to/link-gfm.md).
-->

## Release Notes for Previous Versions
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
Include this section if you want to link directly to previous versions of the release notes.
-->

- [N.N.N](link-gfm.md)
- [N.N.N](link-gfm.md)
- [N.N.N](link-gfm.md)

## Related Topics
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Provide a list of links to related topics. Be sure to include correct page titles and file names for the links. Generally, DO NOT include pages in the Related Topics section that are already referenced on the page.
-->

- [Deployment Topic](deployment-gfm.md)
- [Troubleshooting](../troubleshooting/troubleshooting-gfm.md)
- [Related Topic](link-gfm.md)
- [Related Topic](link-gfm.md)
