---
title: "Update One RST Page in DocsFab"
description: "Update top-level prose in one existing tracked reStructuredText page through the local patch path."
status: draft
content.type: how-to
---

Update top-level prose in one existing tracked reStructuredText page through the local patch path.

## Update One Existing RST Page

The CLI supports a narrow reStructuredText (RST) update when the selected page
is one existing tracked `.rst` file inside an effective documentation root
owned by one unambiguous Sphinx configuration. Use `--patch-only` for this
operation:

```bash
docsfab run update-documentation --repo /absolute/path/to/repository \
  --instruction "Update docs/guide.rst with the installation prerequisite from src/install.txt." \
  --source src/install.txt --patch-only
```

The request must name exactly one page. The plan cannot create or restructure
an RST page, update a second page, or change Sphinx configuration or navigation.
An RST update without `--patch-only` is refused before writing. Existing
Markdown and MDX updates keep their current behavior. This support applies to
`docsfab run`, not direct live-agent RST editing.

The writer can replace one ordinary top-level prose paragraph or insert one
between complete top-level blocks. The host identifies eligible regions from
the original page bytes, offers those regions to the writer, and applies only
the writer's selected region and proposed prose. The host verifies that every
other byte remains unchanged. A successful patch leaves the source checkout
unchanged.

This slice does not edit headings, labels, roles, comments, literal blocks,
tables, images, directive bodies, note or tab content, nested blocks, or
indented lists. It also does not add directives, roles, labels, or headings.
Keep the request within one ordinary prose paragraph when the page contains
these constructs.

The run records byte preservation, static structure comparison, static Sphinx
graph validation, and native-build status separately. Static checks cover
supported labels and `doc`/`ref` references, `toctree` and `include` targets,
and supported directive options. They do not execute `conf.py` or extensions.
The workflow does not run a native Sphinx build. A bounded opaque directive can
remain byte-identical while still being unvalidated; the result reports this
as the `opaque-directive` limitation and marks the static result `limited`.

Use these codes to resolve a refused update:

| Code | Meaning and remediation |
| --- | --- |
| `proposal-scope-input-invalid` | The request names a new, multiple, or out-of-scope RST target, or omits `--patch-only`. Name one existing eligible page and use `--patch-only`. |
| `rst-edit-region-unsupported` | The admitted page has no safe top-level prose region, or the proposal selects an unavailable region or adds unsupported RST syntax. Request one ordinary prose edit outside nested or directive content. |
| `rst-preservation-mismatch` | The candidate did not preserve the sealed page bytes or supported structure. Recheck the selected revision and narrow the prose change, then start a new run. |
| `missing-target` | A supported local reference, include, or toctree target is missing. Correct the tracked target within the Sphinx root, then rerun. |
| `path-escape` | A supported target resolves outside the Sphinx root. Keep the target within that root, then rerun. |
| `cycle` | The tracked toctree graph contains a cycle. Remove the cycle, then rerun. |
| `generated-content-target` | A toctree target depends on generated content outside this static check. Supply tracked source documentation or defer the update. |
| `duplicate-reference-label` | A label is defined in more than one tracked document. Make the labels unique, then rerun. |
| `malformed-directive` | A supported directive has malformed options. Correct the directive syntax, then rerun. |

The writer step receipt records the selected path and span, base and candidate
digests, unchanged-range count, and preservation-manifest digest. It also
records static structure and graph states, checked syntax, opaque limitations,
and `rstNativeBuild: not-run`. These receipts do not establish a native build
or customer-site qualification.

## Related

Use these topics for the supporting contracts and next actions.

- [Update Documentation Beside a Change](update-documentation-beside-a-change.md)
- [Documentation Generator Capabilities](../reference/status-and-configuration/generator-capabilities.md)
