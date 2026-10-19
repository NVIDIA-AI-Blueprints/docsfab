# Template Schemas

This directory contains machine-readable structural schemas derived from documentation templates.

## Purpose

These schemas enable:

1. **Automated validation** - Verify documents match their template's structure
2. **AI context** - Provide structure requirements to AI assistants
3. **CI enforcement** - Block PRs that violate structural requirements
4. **Auto-fix suggestions** - Generate scaffolding for missing sections

## Schema Files

| Schema | Template | Description |
|--------|----------|-------------|
| `quickstart.yaml` | `templates/get-started/quickstart.md` | Fast-track getting started |
| `installation.yaml` | `templates/get-started/installation.md` | Comprehensive installation guide |
| `tutorial.yaml` | `templates/get-started/beginner-tutorial.md` | Hands-on beginner tutorial |
| `about-feature.yaml` | `templates/about/about-feature.md` | Individual feature documentation |
| `glossary.yaml` | `templates/resources/glossary.md` | Lookup-oriented glossary and terminology reference |

## Schema Format

See `schema-spec.yaml` for the complete specification.

### Example Schema

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
        - pattern: "(Quickstart )?Steps"
          description: "Main steps"
        - pattern: "What'?s Next\\??"
          description: "Next steps"

  elements:
    - type: tab-set
      context: "within Steps section"
      required: true
    - type: grid
      context: "within What's Next section"
      required: true

  section_order:
    - "Prerequisites"
    - "Steps"
    - "What's Next"

severity:
  missing_required_section: error
  missing_element: warning
  wrong_section_order: warning
```

## Adding New Schemas

1. Create schema from template:
   ```bash
   python -m structural.extract_schema ../templates/get-started/new-template.md -o new-template.yaml
   ```

2. Review and refine the generated schema

3. Add entry to this README

## Validation

Schemas are validated against `schema-spec.yaml` during CI.

## Syncing to the upstream skill collection

Schemas are synced to the upstream skill collection's `schemas/` directory for use with the structural linter:

```bash
python scripts/sync_schemas.py
```
