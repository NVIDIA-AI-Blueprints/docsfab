---
title: "Third-Party Notices for DocsFab"
description: "Provenance and license notices for skill, template, and helper assets included in DocsFab."
template-source-version: "1.0.0"
---

# Third-Party Notices for DocsFab

<!-- Diataxis: reference. This page is the canonical resource entry. -->

This page identifies the governed skill, template, helper, and npm dependency records included with the DocsFab runtime package. The runtime locks record the staged assets and their provenance.

## Documentation Skills

[`skill-crate/lock.json`](../../skill-crate/lock.json) records each packaged skill's source path, version, declared license, interface, tool policy, and checksums. The current lock marks the skills as DocsFab-local and records the declared license as Apache-2.0 AND CC-BY-4.0. The `tpl-design-ia` skill is a separate catalog skill; it is not part of the template-set bundle.

## Documentation Template Set

The runtime quality bundle includes the `template-set-v1` files. The runtime `quality/` tree is generated from the canonical `packages/quality/` sources. [`quality/lock.json`](../../quality/lock.json) records the bundle source revision and the path and checksum of each staged file. The bundle includes the `tpl-pick`, `tpl-new-site`, `tpl-new-page`, and `tpl-lint` skills. Their instructions and documentation are licensed under CC-BY-4.0; scripts and source code are licensed under Apache-2.0. The bundle includes the dual-license text in `quality/formats/template-set-v1/LICENSE`.

## Roadmap Helper Bundles

Public source and npm distributions exclude the roadmap helper payloads. [`governed-assets/lock.json`](../../governed-assets/lock.json) contains only empty integrity metadata (`bundles: []`); no roadmap helper bundles are included.

## Runtime npm Dependencies

The DocsFab npm package does not bundle third-party packages. npm installs runtime dependencies from the registry. [`npm-shrinkwrap.json`](../../npm-shrinkwrap.json) records the build's resolved versions and each dependency's declared license. Release qualification also records the actual installed dependency tree. Each installed dependency carries its own license file. The package includes the root [`NOTICE`](../../../../NOTICE), which states that no Apache-2.0 runtime dependency pinned in the shrinkwrap includes a NOTICE file.

## Related Documentation

- [Documentation ownership and review](ownership-and-review.md)
- [Governed skills](../reference/operations/governed-skills.md)
