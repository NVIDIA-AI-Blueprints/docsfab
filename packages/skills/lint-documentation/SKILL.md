---
name: lint-documentation
description: Run deterministic and policy-based documentation checks selected from the repository's native toolchain. Use to validate formatting, syntax, links, metadata, navigation, schemas, builds, Markdown, reStructuredText, style rules, commands, and examples while returning structured findings without making a quality score or claiming technical truth.
license: Apache-2.0 AND CC-BY-4.0
---

# Lint Documentation

Run the smallest complete set of repository-native checks for the declared
change. Report signals; do not turn them into an opaque quality verdict.

## Required inputs

- Immutable target revision and changed paths.
- Repository instructions and supported documentation formats.
- Applicable profile, build configuration, and acceptance commands.
- Execution authority and environment limits.

## Workflow

1. Discover checks from repository instructions, CI, build files, package
   scripts, profiles, and file formats. Do not invent a parallel linter when a
   native check exists.
2. Build a validation matrix with each changed surface, applicable check,
   command, expected artifact, and reason for applicability.
3. Run authorized checks in a safe order: parsers and schemas, formatting and
   style, links and references, metadata and navigation, documentation build,
   render checks, then bounded command or example checks.
   Repeated `1.` markers are valid automatic Markdown numbering. Do not report
   them as a defect unless an actually selected rule or configuration supplies
   a stable rule ID and applies to the path, or an authorized render check
   observes incorrect ordering. Without that evidence, retain the allegation
   only as an unverified question. Do not invent a linter or run an undeclared
   package command to obtain it.
4. Capture exact command, working directory, environment assumptions, exit
   status, relevant output, and produced artifacts. Distinguish documentation
   failures from environment, dependency, network, credential, or tool defects.
5. Deduplicate only equivalent findings. Return stable IDs, precise locations,
   rule or command, severity, evidence, minimum correction, and untested scope.
6. Pass technical behavior questions to `verify-technical-accuracy` and the
   complete evidence package to `evaluate-document-quality` when requested.

## Decision rules

- In a composed DocsFab workflow, consume the isolated host executor's check
  results. Report the selected commands, exit status, and output; do not
  substitute a model's inspection for a command that did not run.
- If a native check, dependency, or supported isolation backend is unavailable,
  report it as unavailable with the reason and untested scope. Never fall back
  to unrestricted execution or claim the check passed.
- A passing linter establishes only the rules it checked.
- A documentation build is not proof that examples execute or claims are true.
- Do not weaken, skip, or replace a required check without recording the gap.
- Preserve warnings separately from failures and infrastructure limitations.
- Do not edit, score, publish, commit, push, or merge the documentation.
