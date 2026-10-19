# Minimal Conditional SRD Interview

Use the smallest interview that can produce a safe, reviewable SRD.

## Evidence pass

Before asking questions, inspect the request, repository instructions, implementation and test evidence, existing design records, issue or change description, and other approved sources. Build a compact working coverage map for the SRD sections. Do not ask the developer to repeat a supported fact.

Separate three states:

- **Known:** supported by an approved source or an explicit developer answer.
- **TBD:** missing but non-blocking; name the missing decision or owner.
- **Blocking:** absence would make the requested documentation scope, safety, compatibility, or acceptance criteria misleading.

Missing document-control ownership, review metadata, dates, or an organizational requirement-type reference normally remains non-blocking `TBD` for a `Development`-state draft. Treat it as blocking only when the request, repository policy, or selected profile requires it before the documentation run.

## One grouped interview round

Ask at most five compact prompts in the first round. Combine related missing facts and offer evidence-backed defaults when the repository supports them:

1. **Outcome and scope:** What problem must this solve, why is it needed, what are the primary functions, and what is explicitly out of scope?
2. **Users and use cases:** Who uses it, for which top tasks or flows, at what expected frequency or scale, and what outcome should each user reach?
3. **Measurable requirements:** What behaviors and success thresholds are required? Include performance, reliability, compatibility, telemetry, and acceptance signals only when applicable.
4. **Constraints and risk:** Which platforms, interfaces, dependencies, release constraints, security boundaries, legal or standards obligations, and test-automation needs apply?
5. **Ownership and evidence:** Who authors, reviews, and approves the SRD; what references are authoritative; and what early validation or research evidence is available?

Use plain conversation for free-form answers and a selectable interaction only
when the available choices are established by the source context. If a selector
is unavailable or fails, ask the same question once in plain text.

## One clarification round

Ask one follow-up round only when an answer creates a new blocking ambiguity or contradicts a higher-priority source. Group the remaining blockers. Do not interview for formatting, template bookkeeping, optional history, or facts that can safely remain `TBD`.

After that round:

- stop and report the blocking question when a safe SRD still cannot be drafted;
- otherwise produce the needed SRD sections with explicit `TBD` values and named evidence or decisions needed;
- do not infer approvers, dates, requirements, thresholds, platforms, security behavior, or release commitments.

Never infer non-applicability from silence. If approved evidence does not
establish whether a concern or activity applies, record `TBD` and the needed
decision. Keep unknown ownership explicit and do not fabricate approval or
evidence.

## Approval view

Show a compact coverage summary followed by the complete SRD draft. The summary identifies sources used, answered interview topics, remaining `TBD` items, and any `Not applicable` sections. Approval applies to the full displayed SRD, not only the summary.
