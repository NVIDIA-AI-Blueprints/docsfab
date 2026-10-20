# Template Catalog

Master index of all documentation templates in the NVIDIA template library. Use this to match a documentation goal to the right template.

## Templates by Section

### About (Product Understanding)

| Template | File | Diataxis Type | Use When |
|----------|------|---------------|----------|
| Product Overview (`overview`) | `about/overview` | Explanation | Landing page for the About section; introduces the product, core value, and navigation |
| Feature Page | `about/about-feature` | Explanation | Documenting an individual feature — capabilities, how it works, limitations |
| Procedural Task | `about/about-procedural-task` | Explanation | Explaining a task-oriented workflow within the product context |
| Architecture | `about/architecture-overview` | Explanation | Showing how components interact — diagrams, data flows, deployment topologies |
| Ecosystem | `about/ecosystem` | Explanation | Positioning the product within its ecosystem — integrations, related tools, comparison |
| Key Features | `about/key-features` | Reference | Comprehensive list of product features and optional developer tools |
| Core Concepts Overview | `about/core-concepts-overview` | Explanation | Landing page that introduces and summarizes a product's core concepts before readers dive into deeper conceptual topics |

### Get Started (Onboarding)

| Template | File | Diataxis Type | Use When |
|----------|------|---------------|----------|
| Getting Started Overview | `get-started/get-started-overview` | Tutorial | Landing page — choose your path, prerequisites overview, learning path |
| Quickstart | `get-started/quickstart` | Tutorial | Fast-track first experience — minimal steps to a working result |
| Prerequisites | `get-started/prerequisites` | Reference | Detailed system requirements, dependencies, and environment setup |
| Installation | `get-started/installation` | How-To | Comprehensive install guide — multiple methods (pip, source, container) |
| Beginner Tutorial | `get-started/beginner-tutorial` | Tutorial | Guided learning experience — step-by-step with explanations |

### Conceptual

| Template | File | Diataxis Type | Use When |
|----------|------|---------------|----------|
| Concepts Overview | `conceptual/overview` | Explanation | Landing page for a concepts collection, including an About > Core Concepts section |
| Conceptual | `conceptual/conceptual` | Explanation | General conceptual page that explains what something is or how it works |
| Conceptual Blended | `conceptual/blended-conceptual` | Explanation | Conceptual page with a small supporting procedure |

### Procedural (Standalone)

| Template | File | Diataxis Type | Use When |
|----------|------|---------------|----------|
| Single Procedural Task | `procedural/single-procedural` | How-To | Step-by-step guide for one task |
| Multiple Procedural Tasks | `procedural/multiple-procedural` | How-To | Page covering several related procedural tasks |

### Reference

| Template | File | Diataxis Type | Use When |
|----------|------|---------------|----------|
| Reference Overview | `reference/reference-overview` | Reference | Landing page for the reference section — API, CLI, configuration, and specification-style lookups |
| Environment Variables | `reference/environment-variables/environment-variables` | Reference | Documenting environment variables with names, defaults, and descriptions |
| Helm Chart Values | `reference/helm-parameters/helm-parameters` | Reference | Documenting Helm chart values — types and defaults |
| Observability Metrics | `reference/observability/observability-metrics` | Reference | Logging, observability endpoints, and metrics reference |
| Performance Benchmarks | `reference/performance/performance-benchmarks` | Reference | Reporting benchmark results — throughput, latency, and hardware configurations |

### Resources

| Template | File | Diataxis Type | Use When |
|----------|------|---------------|----------|
| Resources Overview | `resources/resources-overview` | Reference | Landing page for glossaries, support FAQs, and other supplementary lookup pages |
| Glossary | `resources/glossary` | Reference | Term definitions and domain vocabulary |
| Support and FAQs | `resources/support-and-faqs` | Reference | Support channels and frequently asked questions |

### Release Notes

| Template | File | Diataxis Type | Use When |
|----------|------|---------------|----------|
| Release Notes | `release-notes/release-notes` | Reference | Version changelog — new features, fixes, breaking changes, deprecations |

### Troubleshooting

| Template | File | Diataxis Type | Use When |
|----------|------|---------------|----------|
| Troubleshooting | `troubleshooting/troubleshooting` | How-To | Common issues, error messages, and solutions |

## Format Variants

Every template exists in up to four format variants:

| Suffix | Format | Target Platform |
|--------|--------|-----------------|
| `.md` | MyST Markdown | Sphinx / MyST documentation sites |
| `.rst` | reStructuredText | Sphinx RST documentation sites |
| `-gfm.md` | GitHub Flavored Markdown | GitLab/GitHub wikis, generic Markdown renderers |
| `.mdx` | Fern MDX | Fern documentation sites |

## Available Schemas

Structural validation schemas exist for these template types:

| Schema | Template | File |
|--------|----------|------|
| `about-feature` | Feature Page | `schemas/about-feature.yaml` |
| `about-procedural-task` | Procedural Task | `schemas/about-procedural-task.yaml` |
| `architecture` | Architecture | `schemas/architecture.yaml` |
| `ecosystem` | Ecosystem | `schemas/ecosystem.yaml` |
| `environment-variables` | Environment Variables | `schemas/environment-variables.yaml` |
| `features` | Key Features | `schemas/features.yaml` |
| `glossary` | Glossary | `schemas/glossary.yaml` |
| `helm-parameters` | Helm Chart Values | `schemas/helm-parameters.yaml` |
| `installation` | Installation | `schemas/installation.yaml` |
| `prerequisites` | Prerequisites | `schemas/prerequisites.yaml` |
| `procedural` | Procedural Tasks | `schemas/procedural.yaml` |
| `quickstart` | Quickstart | `schemas/quickstart.yaml` |
| `release-notes` | Release Notes | `schemas/release-notes.yaml` |
| `troubleshooting` | Troubleshooting | `schemas/troubleshooting.yaml` |
| `tutorial` | Beginner Tutorial | `schemas/tutorial.yaml` |

## Diataxis Quick Reference

| Type | Purpose | Template Examples |
|------|---------|-------------------|
| **Tutorial** | Learn by doing a guided lesson | Quickstart, Beginner Tutorial, Getting Started Overview |
| **How-To** | Accomplish a specific task | Installation, Procedural Tasks, Troubleshooting |
| **Explanation** | Understand concepts and architecture | Architecture, Ecosystem, Feature Page, Concepts |
| **Reference** | Look up specific information | Glossary, Key Features, Prerequisites, Release Notes, Environment Variables, Helm Chart Values, Observability |
