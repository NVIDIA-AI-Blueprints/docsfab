---
title: Lint Documentation Skill in DocsFab
description: Run repository-native deterministic and policy-based documentation checks.
status: draft
---

The DocsFab `lint-documentation` skill selects the smallest complete
validation set from repository instructions, CI, package scripts,
profiles, and file formats. For more information, refer to [Checking and
Review Skills in DocsFab](index.md).

## Contract at a Glance

| Field | Contract |
| --- | --- |
| Mode | Read-only |
| Runtime binding | Deterministic-check step in `review-documentation`, `create-documentation`, `update-documentation`, and `restructure-documentation` |
| Primary output | Exact command evidence, findings, and untested scope |
| Does not establish | Technical truth, editorial quality, audience understanding, or release readiness |

## Check Selection and Evidence

Checks can cover syntax, formatting, style, links, metadata, navigation,
schemas, builds, rendering, commands, and examples. Each result records the
exact command, working directory, assumptions, exit status, relevant output,
and untested scope.

A passing check establishes only the rule it exercised. Build success does not
prove technical truth. Environment, dependency, network, credential, and tool
failures remain distinct from documentation failures.

## Boundaries

The skill reports structured findings without editing, scoring, publishing, or
performing SCM changes.

## Authoritative Sources

- [Skill contract](../../../../../packages/skills/lint-documentation/SKILL.md)
- [Check-selection guidance](../../../../../packages/skills/lint-documentation/references/check-selection.md)
- [Comprehensive review binding](../../../../../packages/runtime/workflows/review-documentation.json)
- [Create workflow binding](../../../../../packages/runtime/workflows/create-documentation.json)
- [Update workflow binding](../../../../../packages/runtime/workflows/update-documentation.json)
- [Restructure workflow binding](../../../../../packages/runtime/workflows/restructure-documentation.json)
