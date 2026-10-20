# Practical Authoring Patterns

Read only the section needed for the approved change. These methods do not
expand the plan, imply product support, or replace a selected format or rubric.

## Reader Path and Presentation

Start with what the declared reader needs to accomplish and what they already
know. Lead with the shortest supported path to an observable result. Keep
setup, required steps, and verification together; link to advanced options.
An overview or feature page should orient and route readers, an architecture
page should explain relationships and data flow, and reference content should
support lookup. Do not invent rationale or add a page only to fill a template.

Use tables for real comparisons and tabs for mutually exclusive alternatives
when the renderer supports them. Do not hide sequential steps, prerequisites,
data-loss warnings, or security boundaries in tabs or collapsed sections.
Avoid creating a new dependency for presentation. Preserve the repository's
native syntax, accessible text, and existing useful structure.

## Complete Examples

Ground examples in the approved version's public interface. New examples can
compose verified operations; they need not exist verbatim in the source.
Clearly distinguish illustrative pseudocode from executable examples.

Include required imports, setup, working directory, and variables from earlier
blocks. Explain where placeholder values come from without supplying secrets.
Check argument names, schema fields and nesting, defaults, and path handling
against the bound sources. Separate commands from representative expected
output. Include cleanup or recovery when needed for the task. Do not claim an
example was executed without a matching command receipt.

Keep internal claim-to-source notes in the returned evidence. Preserve useful
reader-facing source links, but do not insert audit IDs or private maintenance
locators into the product page merely to prove the work.

## Corrections and Revisions

Apply the supported correction and inspect adjacent text for lost conditions,
changed returned values, or inconsistent examples. Check affected links,
anchors, navigation, includes, and metadata within the approved scope. A
necessary out-of-scope change requires a scope result, not an unauthorized edit.
Record applied and rejected originating finding IDs and unresolved consequences.
This author check does not replace the independently scheduled review.

## Release Notes

Use only the approved comparison range and release evidence. Describe reader
impact, required action, and supported version or compatibility changes. Link
to detailed documentation instead of copying implementation history.
Distinguish a change's relevance from approved external disclosure. Do not
announce an unshipped fix, expose private tracker details, or publish an
unapproved security disclosure. Retain uncertainty for the accountable owner;
writing a release-note draft does not authorize release or publication.
