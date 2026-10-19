# Page Purpose and Source Collection

Use the pattern matching the approved reader task. These are research
questions, not mandatory headings, page counts, or new rubric thresholds.
Existing repository structure and the requested operation still control scope.

| Page purpose | Collect before outlining | Reader result |
| --- | --- | --- |
| Overview | Approved purpose, audience, supported use cases, current entry points | Explain what the product does, who needs it, and where to start. Link to detailed tasks instead of duplicating them. |
| Quickstart or tutorial | Supported environment, setup, minimal complete example, observable success, recovery | Get from the stated starting point to one recognizable outcome; separate later options from required steps. |
| Task or troubleshooting | Preconditions, ordered actions, expected state, failure signals, recovery and cleanup | Complete or diagnose a specific task without reconstructing prerequisites from scattered examples. |
| Architecture | Component roles, relationships, data and control flow, boundaries, supported topologies, relevant failure behavior | Understand how the system works and why a relationship matters. Do not infer support or design intent from code alone. |
| Feature or ecosystem | Supported capability and limits, integration boundaries, approved compatibility, task destinations | Decide applicability and find the next task. Do not invent comparative or performance claims. |
| Reference | Public declarations, defaults, precedence, schema shapes, versions, exceptions | Look up an exact fact without following an unrelated tutorial. |
| Release notes | Explicit comparison range and released versions, user-visible impact, approved disclosure, affected task pages | Understand what changed and what action is required. Keep entries short and link to detailed guidance. |

Declare what the audience knows from supplied evidence; do not assign an
enterprise role or invent prerequisites from a persona label. Missing material
sources or product decisions follow the skill's existing `needs-input` path.
An adequate existing overview does not need a replacement because a template
exists. Keep internal evidence locators in plan/run evidence unless the reader
needs the reference.

For release notes, distinguish reader impact from permission to disclose.
Do not treat every commit as a shipped user change or a security fix as an
automatic public announcement. Hold unsupported disclosure claims for the
accountable owner; this method grants neither publishing nor tracker access.
