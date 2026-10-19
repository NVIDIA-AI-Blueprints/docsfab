# Documentation Check Selection

Prefer checks in this order of authority:

1. Acceptance commands and repository instructions for the changed paths.
2. CI jobs and package scripts that publish or validate the same surface.
3. Selected DocsFab profile and format requirements.
4. Bounded generic syntax checks when no repository-native check exists.

Common checks include Markdown or reStructuredText syntax, formatting, spelling
or approved terminology, internal and external links, frontmatter, schemas,
navigation, includes, generated references, documentation builds, render smoke
checks, and bounded command or code-example validation.

For every omitted class, record `not-applicable`, `not-assessed`, or
`insufficient-evidence` with the reason. Never report an omitted class as
passing.

Repeated `1.` markers are valid CommonMark/GFM automatic numbering. A contrary
style finding requires the selected rule's stable ID and applicable
configuration locator, or an observed rendered ordering failure with its
artifact locator. A reviewer preference is an unverified question, not a lint
finding. Do not invent an additional linter or execute a package command that
the repository did not authorize.
