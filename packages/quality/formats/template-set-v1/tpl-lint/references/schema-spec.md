# Schema Specification

Structural validation schemas define what headings, elements, and section ordering a documentation page should follow. Schemas are YAML files stored in `schemas/` at the template library root.

## Schema Format

```yaml
schema_version: "1.0"
name: quickstart
description: "Fast-track getting started experience"
source_template: "templates/get-started/quickstart.md"

structure:
  headings:
    h1:
      required:
        - pattern: "Quickstart|Quick Start"
          description: "Main title"
      max_count: 1
    h2:
      required:
        - pattern: "Before You (Start|Begin)"
          description: "Prerequisites section"
      optional:
        - pattern: "Troubleshooting"
          description: "Troubleshooting section"

  elements:
    - type: tab-set
      context: "within Steps section"
      required: true
    - type: grid
      context: "within What's Next section"
      required: true
      attributes:
        min_items: 2

  section_order:
    - "Prerequisites"
    - "Quickstart Steps"
    - "Minimal Code Example"
    - "What's Next"

severity:
  missing_required_section: error
  missing_optional_section: info
  wrong_section_order: warning
  missing_element: warning
  duplicate_h1: error

content:
  intro:
    max_sentences: 2
    must_include: ["time commitment", "outcome"]
  prerequisites:
    format: "bullet list"
    max_items: 5
```

## Key Fields

| Field | Required | Description |
|-------|----------|-------------|
| `schema_version` | Yes | Schema format version (currently "1.0") |
| `name` | Yes | Unique identifier for this document type |
| `description` | Yes | Human-readable description |
| `source_template` | Yes | Path to the source template file |
| `structure.headings` | Yes | Heading requirements by level (h1, h2, h3) |
| `structure.elements` | No | Required structural elements (grids, in-page tabs, admonitions) |
| `structure.section_order` | No | Expected order of H2 sections |
| `severity` | No | Severity overrides for validation rules |
| `content` | No | Content guidelines for AI and human review |

## Heading Requirements

Each heading level can have `required` and `optional` entries:

- **pattern**: Regex pattern to match heading text
- **description**: Human-readable description of this heading
- **max_count**: Maximum allowed occurrences (h1 is typically 1)

## Element Types

Supported structural elements:

| Type | Description |
|------|-------------|
| `admonition` | Note, warning, tip, important boxes |
| `tab-set` | In-page tabbed content panels (`tab-set` / `tab-item`) |
| `grid` | Card grid layouts |
| `dropdown` | Collapsible/expandable sections |
| `mermaid` | Mermaid diagram blocks |
| `list-table` | Structured tables |
| `image` | Image elements |
| `card` | Individual card elements |

## Available Schemas

| Schema File | Template Type |
|-------------|---------------|
| `quickstart.yaml` | Quickstart pages |
| `installation.yaml` | Installation guides |
| `tutorial.yaml` | Beginner tutorials |
| `about-feature.yaml` | Feature pages |
| `glossary.yaml` | Glossaries |
| `schema-spec.yaml` | Schema specification itself (meta-schema) |
