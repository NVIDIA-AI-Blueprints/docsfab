---
title: "Audit Documentation Workflow in DocsFab"
description: Run the fixed read-only DocsFab workflow that checks every documentation page against its governed template without calling a model.
status: draft
content.type: reference
---

`audit-documentation` is a read-only DocsFab runtime workflow that checks
every documentation page in scope against its governed template. The workflow
name matches the `audit-documentation` catalog skill, but the workflow does
not run that skill's model judgment. Its one step is a host operation, and it
never calls a model. For more information, refer to [Workflow Contracts in
DocsFab](index.md).

## Contract at a Glance

The following table summarizes the contract.

| Field | Contract |
| --- | --- |
| Use it when | You need to know which pages follow their templates, for example after a request such as "check if my docs follow our templates." |
| Mutation | None. The step is read-only. |
| Model calls | None. The local run binds a harness that refuses inference. |
| Scope | `documentation-set` by default: every public documentation page the repository inventory recognizes. `focused-set` when the run names pages, for example with `--context-path`. |
| Result | A per-page report with findings in the review-finding shape and host-counted coverage. |
| Excluded actions | Model-judged template rules, source-fact verification, cross-page set checks, edits, and publication. |

## Workflow Sequence

The fixed workflow has one read-only host step, `audit-template-conformance`. To invoke it, follow [Audit Pages Against Templates](../../workflows/audit-templates.md).

## Map Pages to Templates

The step maps each page to one governed template from the template catalog
before it checks the page. It applies the first rule that matches, and the
report records which rule decided:

1. `frontmatter`: a `template:` key always decides, such as
   `template: quickstart`. Without one, a `page_type` or `content_type` key
   decides only when its value names a catalog template; a generic value such
   as `concept` leaves the page to the path rules.
2. `filename`: a filename equal to a template keyword, such as
   `installation.md` or `architecture.md`.
3. `filename-suffix`: a filename that ends with a page-genre keyword, such as
   `runner-quickstart.md` or `setup-troubleshooting.md`. Only genre keywords
   (quickstart, installation, prerequisites, troubleshooting, release notes,
   glossary, environment variables, Helm parameters) count as suffixes.
   Subject keywords such as `architecture` do not, so `lens-architecture.md`
   stays unmapped.
4. `directory`: a `troubleshooting/` or `release-notes/` directory, because
   each holds one kind of template.

The step never guesses. It reports a page as `unmapped`, with one of the
following reasons, when no rule gives exactly one template.

| Reason | Meaning |
| --- | --- |
| `no-template-signal` | No frontmatter key, filename, or directory names a template. |
| `ambiguous-template-signal` | The rules name more than one template, such as `troubleshooting/installation.md`. |
| `unknown-declared-template` | A frontmatter key names a value that is not a catalog template. |
| `section-index` | The page is an `index.md` or `README.md` section landing page. |
| `unsupported-format` | The page is not Markdown or MDX. |

To audit an unmapped page, declare its template with a `template:` frontmatter
key. Most pages in a typical documentation tree carry no template signal, so
expect many unmapped pages until model-assisted mapping is available. A page
with MyST syntax, such as a directive fence, a role, or a `(label)=` target,
maps to the MyST variant of its template.

## Check Structure

For every mapped page, the step runs the following structural template rules
under the `docsfab:template-structural-blocking` policy.

| Rule | Severity |
| --- | --- |
| `missing-required-heading` | Error |
| `duplicate-h1` | Error |
| `wrong-section-order` | Warning |
| `unresolved-template-placeholder` | Warning |

A page fails when it has at least one error. The step reads the heading
structure that a reader sees. It ignores frontmatter lines, and when the page
has no Markdown H1, the frontmatter `title` counts as the H1, as Fern and
similar renderers display it.

## Read the Result

`docsfab runs show <run-id>` prints the coverage counts under `PRODUCT` and the
findings under `REVIEW FINDINGS`. Each finding has a `template:` code, the page
path, the template, and how the template was chosen. The `--json` output
lists the findings in `reviewFindings`, up to the review findings projection
limit of 256 findings and 128 KiB. A larger result names the omitted count as a
`review-findings-omitted` limitation, and the run record keeps every page's
result.

The coverage line counts pages enumerated, checked, passed, failed, unmapped,
and refused. Each refused page has its own line with the reason and the next
action, using one of the following codes.

| Code | Meaning |
| --- | --- |
| `page-too-large` | The page exceeds the `contentIndex.maxSourceBytes` operational limit, the content index source bound that the repository inventory applies to the same page. The line shows the page size, the limit's effective value, and how to raise it. For the default value and override, refer to [Operational Limits](../status-and-configuration/operational-limits.md). |
| `page-not-utf8` | The tracked bytes are not valid UTF-8. |
| `page-unreadable` | The tracked file could not be read at the selected revision. |

When the repository inventory cannot present every tracked entry as an
auditable page, the result says how many entries could not be audited and why.
For example, the workflow does not follow a tracked symbolic link. Text and
navigation indexing gaps do not hide a regular page, so they do not affect the
audit.

The product disposition follows host coverage, not a model claim, as the following table shows.

| Disposition | When |
| --- | --- |
| `ready` | Every enumerated page was checked and passed. |
| `not-ready` | At least one checked page failed its template. |
| `inconclusive` | No checked page failed, but some pages were unmapped or refused, or the inventory could not list every entry. |

The audit does not repair pages. Fix the failed pages or declare templates for
unmapped pages, then run the audit again.
