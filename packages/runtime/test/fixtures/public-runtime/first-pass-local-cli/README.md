<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Public first-pass examples

These small report examples were authored independently for the portable
first-pass tests. The guide and quickstart deliberately disagree about a name
and a JSON property. The export helper deliberately has an inaccurate ordinary
comment. Those disagreements exercise citation verification, executable-source
corroboration, saved choices, and the distinction between comments and code.

`helpers/public-qa-partition.ts` produces fresh support records through the
canonical knowledge gatherer using deterministic in-process responses. It does
not load or rewrite the retained internal QA records. The matching internal
test registrations continue to use the original fixture directory unchanged;
the public examples do not qualify that private corpus.

The shared test names retain their historical regression labels. The explicit
public or internal registration determines the input provenance; a label such
as `W0` does not make these new public examples historical QA evidence.
