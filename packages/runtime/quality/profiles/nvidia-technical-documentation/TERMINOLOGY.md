<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: CC-BY-4.0
-->

# Technical documentation terminology

This file binds approved prose terms to the `nvidia-technical-documentation`
profile used by the DocsFab documentation set. Apply it with
`style-guide.md` and the DocsFab Fern overlay. It does not replace the
complete NVIDIA Writing and Style Guide for legal, trademark, brand,
localization, or product rules.

Literal code, identifiers, commands, URLs, and quoted terminal or API output
are exempt. Preserve field names from approved specifications and code even
when they differ from prose terminology.

| Use | Do not use |
|---|---|
| job (a catalog workflow with a stable UC identifier) | job to be done, jobs-to-be-done, JTBD |
| use case (a product goal DocsFab serves) | job, when naming a product goal |
| journey (a person, trigger, and path under a use case) | job, when naming a reader path |
| serves, uses, starts | hired, hires, hire, as a product metaphor |
| platform operation, usage mode | platform job, when distinguishing work that is not a catalog job |
| UC1 through UC11 | a twelfth catalog of use cases that duplicates those identifiers |

Person-first statements (**as a role, I want to…**, **so that**) remain the
voice for use cases, journeys, and catalog jobs. They are not Jobs-to-be-Done
product vocabulary.

Internal planning under `planning/design/use-case-matrix.md` keeps its working
hierarchy. Do not copy that Jobs-to-be-Done framing into `docs/`.
