---
title: "About [Feature Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# About [Feature Name]
<!-- @tpl:naming
Use title casing: Start with "About" followed by [Feature Name] (use noun phrasing), such as About Model Customization and Evaluation. Only page titles get denoted with a single hashtag (#).
-->

<!-- @tpl:formatting
This is the About Feature template. Use it for an individual feature that needs
dedicated explanation. For a comprehensive product feature catalog, use the
[Key Features template](key-features-gfm.md). For a high-level product introduction,
use the [Overview template](overview-gfm.md).
-->

<!-- @tpl:example
To get started, refer to [About NVIDIA TTS NIM Microservice](https://docs.nvidia.com/nim/speech/latest/tts/index.html).
-->

<!-- @tpl:naming
Rename the file and save it in the appropriate project repository. The filename gets included in the URL. Try to name your file in a way that the content can change without having to change the filename (and the URL). For better SEO, use hyphens instead of underscores. Avoid putting product names in file names whenever possible. For example, instead of nemoretriever-parse, a product-agnostic name could be "advanced-ocr-parsing".
-->

<!-- @tpl:example
- about-batch-synthesis-gfm.md
- about-data-stor-gfm.md
-->

<!-- @tpl:formatting
- Use a bulleted list of links to present brief summaries to help navigate users to other content.
- Use tables to organize complex information.
- Use headings, tables, or details blocks to present command variants.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- @tpl:formatting
Provide an introductory paragraph here that introduces the feature and its primary purpose. Explain what it is and why it matters in two to three sentences. Replace the following example with your own text.
-->

The NVIDIA Text-to-Speech (TTS) NIM microservice synthesizes natural-sounding speech from text. It packages pre-trained NeMo models with the full NVIDIA inference stack into self-contained containers that handle model download, optimization, and serving.

The NVIDIA TTS NIM microservice supports two synthesis modes:

- **Offline**: Generates the complete audio and returns it in a single response. Simpler to use, but subject to a 4 MB gRPC message size limit.
- **Streaming**: Returns audio in chunks as they are generated. Provides lower time-to-first-audio and handles arbitrarily long text.

**Key use cases and capabilities:**

<!-- @tpl:formatting
Provide a list or table of key feature use cases and capabilities:

- **[Use Case 1]**: [What users can do with this particular feature and why it matters]
- **[Use Case 2]**: [What users can do with this particular feature and why it matters]

Add more use cases and capabilities as needed. Replace the following example with your own text.
-->

The TTS NIM microservice supports the following use cases and capabilities:

- **Voice Selection and Emotional Styles**: Each TTS model includes multiple voices organized by language and locale. The Magpie Multilingual model provides voices with optional emotional style variants, such as `Magpie-Multilingual.EN-US.Aria.Happy` and `Magpie-Multilingual.FR-FR.Pascal.Calm`. For more information, refer to [Voice Selection and Emotional Styles](https://docs.nvidia.com/nim/speech/latest/tts/voices.html).
- **Voice Cloning**: The Magpie TTS Zeroshot and Magpie TTS Flow models clone a voice from a short reference audio recording (3–10 seconds, 16-bit mono WAV at 22.05 kHz or higher). Magpie TTS Flow also requires a transcript of the audio prompt. For more information, refer to [Voice Cloning](https://docs.nvidia.com/nim/speech/latest/tts/voice-cloning.html).
- **Batch Synthesis**: The WebSocket realtime client supports synthesizing speech from text files and processing multiple lines in parallel for higher throughput. For more information, refer to [Batch Synthesis](https://docs.nvidia.com/nim/speech/latest/tts/batch-synthesis.html).
- **SSML Customization**: The TTS NIM microservice supports a subset of Speech Synthesis Markup Language (SSML) for controlling phoneme pronunciation. For more information, refer to [Customizing TTS Models](https://docs.nvidia.com/nim/speech/latest/tts/customization.html).
- **Custom Pronunciation**: Define a text-based dictionary that maps words to IPA phonetic representations. The TTS model applies these custom pronunciations during synthesis. For more information, refer to [Phoneme Support](https://docs.nvidia.com/nim/speech/latest/tts/phoneme-support.html).

## How the [Insert the Name of the Feature Here Using Noun Phrasing] Works
<!-- @tpl:formatting
Use this section to explain how the feature works from a user's perspective. Focus on the workflow and what happens when users interact with the feature. You can also include implementation details or code examples. You should link to other pages that provide granular architecture and implementation details. Replace the following example with your own text.
-->

### [Key Part Name]
<!-- @tpl:example
"JsonlReader ingests `.jsonl` files into `DocumentBatch` tasks so later stages
can score, filter, and write results without each step re-implementing file
handling."
-->

Use specific names, for example: **Configuration Validation**, **Resource
Allocation**, **Progress Monitoring**, or **Result Export**.

<!-- @tpl:visual-representation
Replace the alt text in the `![...]` brackets with a description of what the
diagram shows. Do not force a fixed image width unless your specific image
requires one.
-->

![Diagram description](./_images/diagram-filename.png)

A typical pipeline composes the following stages in order:

1. Mono conversion normalizes channels and sample rate.
2. Voice activity detection (VAD) splits each file into speech segments.
3. Band filter drops segments that are not full-band (or not narrow-band, depending on the configured target).
4. UTMOS filters segments below a perceived-quality threshold.
5. SIGMOS filters segments by per-dimension quality scores (noise, overall, signal, coloration, discontinuity, loudness, reverb).
6. Segment concatenation merges surviving segments back together with configurable silence between them.
7. Speaker separation diarizes the concatenated audio and fans out one task per speaker.
8. Per-speaker filters rerun VAD/Band/UTMOS/SIGMOS on each speaker’s audio independently.
9. Timestamp mapping projects final segment boundaries back to positions in the original input file.

Each stage is independently usable. Use `AudioDataFilterStage` to compose all of them with a single YAML config, or assemble a custom subset stage-by-stage.

## Related Use Cases

This feature supports the following common scenarios.

<!-- @tpl:example
"Teams rely on this feature when they need to score millions of records, filter low-quality content, or standardize cleanup logic before publishing a dataset for training."
-->

<!-- @tpl:formatting
- Add one short subsection per use case.
Repeat the pattern below as needed.
-->

### [Use Case Name]
<!-- @tpl:example
"Quality filtering for text curation. A team ingests a JSONL corpus, applies heuristics like word count and non-alphanumeric ratio, and exports only the documents that pass."
-->

**Benefits**: [Specific benefit or capability], [Another benefit]

<!-- @tpl:example
- Choose Parakeet CTC for low-latency streaming in a supported language.
- Choose Parakeet TDT when word-level timestamps matter.
- Choose Canary when one deployment must support multiple languages.
-->

## Limitations and Considerations
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:optional
If applicable, provide a list of limitations and performance considerations for the feature. Replace the following example with your own text.
-->

**Current limitations**:
<!-- @tpl:formatting
- **[Limitation 1]**: Describe the limitation.
- **[Limitation 2]**: Describe the limitation.

Add more limitations as needed. Replace the following example with your own text.
-->

- **Shared Input Model**: Every branch receives the same input payload.
- **No Inter-branch Communication**: Branches execute independently and do not communicate during execution.
- **Appended Output Contract**: Downstream tools receive a text payload containing concatenated branch blocks.

**Performance considerations**:
<!-- @tpl:formatting
- **[Performance Consideration 1]**: Describe the performance consideration.
- **[Performance Consideration 2]**: Describe the performance consideration.

Add more performance considerations as needed. Replace the following example with your own text.
-->

- **Event-Based Scheduler Latency Tuning**: For latency-sensitive Linux workloads using `EventBasedScheduler`, you can isolate the scheduler’s dispatcher thread with `GXF_EBS_DISPATCHER_CPU_CORE=<core-id>`. This is separate from the scheduler `pin_cores` parameter, which only affects worker threads, and can reduce jitter when the dispatcher competes with time-critical work.
- **GPU-Resident Pipelines**: When using GPU-resident operators within a CUDA Graph, kernel transition latency is significantly lower (~0.5–2 µs), allowing for finer-grained operator decomposition.

## Get Started
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:formatting
Use a bulleted list of links to help users navigate to other pages to obtain more information about how to get started with the feature.
-->

If you're ready to start using [Feature Name], refer to the following:

- **[Provide the name of other pages here, such as a Quickstart Guide where users can navigate to learn more about how to get started with the feature.](../path/to/quickstart)** — Get up and running quickly with [Feature Name].
- **[Provide the name of other pages here, such as a Get Started Guide or Installation Guide where users can navigate to learn more about how to get started with the feature.](../path/to/user-guide)** — Learn how to use [Feature Name] in detail.

<!-- @tpl:formatting
Add more links as needed.
-->

## Comparison with Related Features
<!-- @tpl:naming
Do not rename this section.
-->

<!-- @tpl:example
| Approach | Best for | Trade-off |
| --- | --- | --- |
| `WordCountFilter` | Standard word-count rules with tested defaults and consistent metrics. | Less flexibility for product-specific rules. |
| Custom Pandas filter | Bespoke logic that does not fit a built-in stage. | You own validation, scaling, and metrics. |
-->

<!-- @tpl:optional
Include this section only if users have to choose between this feature and other related features. Otherwise, omit it.
-->

<!-- @tpl:formatting
Provide an introductory sentence here. Replace the following example with your own text.
-->
Compare the built-in WordCountFilter (one line of config, consistent metrics, and tested defaults) against a hand-written Pandas filter (full control, custom logic, but you own testing and metric collection).

<!-- @tpl:formatting
Use a list table to compare this feature with alternative approaches to determine the best fit.
-->

| Aspect | [Feature Name] | [Alternative Approach] |
| --- | --- | --- |
| **[Key Differentiator 1]** | [How this feature handles it] | [How the alternative handles it] |
| **[Key Differentiator 2]** | [How this feature handles it] | [How the alternative handles it] |
