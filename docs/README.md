# DocsFab Documentation

Use this guide to choose a task or find product details.

## Choose Your Next Step

| To… | Start here |
| --- | --- |
| Install DocsFab or configure a model | [Install DocsFab](get-started/installation.md) |
| Find a workflow before running it | [Discover Workflows](get-started/discover-workflows.md) |
| Review documentation in a conversation | [Live Agent Quickstart](get-started/live-agent-quickstart.md) |
| Create or update documentation with a named workflow | [Workflow Quickstart](get-started/runner-quickstart.md) |
| Configure models and output locations | [Configure DocsFab](configure/index.md) |
| Check readiness, limits, or local state | [Manage DocsFab](manage/index.md) |
| Look up supported platforms and requirements | [Support Matrix](reference/support-matrix.md) |
| Recover from an error | [Troubleshooting](troubleshooting.md) |

## Browse by Topic

| Path | What it covers |
| --- | --- |
| `about/` | Product overview, use cases, architecture overview, and core concepts, including trust |
| `get-started/` | Installation, workflow discovery, and first-use tutorials |
| `configure/` | Model routes, composition settings, and output locations |
| `workflows/` | Documentation tasks and product-knowledge procedures |
| `manage/` | Readiness, private state, limits, diagnostics, and recovery |
| `reference/` | Architecture and security contracts, support, CLI, configuration, results, and workflows |
| `resources/` | Terminology and evaluation guidance |
| `release-notes/` | Notes associated with release records |

## For Documentation Maintainers

Fern page titles come from YAML frontmatter. Do not add a Markdown H1 to those pages. Keep procedures in `configure/`, `workflows/`, and `manage/`; use `reference/` for syntax and supported values, and `troubleshooting.md` for symptom-led recovery.

Preview the site from the repository root with:

```bash
fern docs dev
```

Published navigation is defined in [`fern/docs.yml`](../fern/docs.yml). Follow the [documentation guidance](AGENTS.md) when editing these pages. Publication requires its separate authorized Fern setup.
