---
title: "Slack Output Limits in DocsFab"
description: "Look up message chunking, question evidence, and replay-window budgets for hosted Slack output."
status: draft
content.type: reference
---

Look up message chunking, question evidence, and replay-window budgets for hosted Slack output.

Slack live-agent answers use the following separate message-formatting settings.

<Markdown src="operational-limits-tables/slack-message-settings.md" />

Slack truncates message text above
[40,000 characters](https://docs.slack.dev/reference/methods/chat.postMessage/#truncating-content).
Its recommendation of 4,000 characters is a readability preference. You can lower
the chunk budget for shorter messages without reducing the total answer. DocsFab
reserves the actual sequence-marker width and preserves whitespace and Unicode
characters while splitting the answer. It no longer cuts the runtime answer to
2,700 characters or stops default delivery after three messages.
Remove a legacy positive total-chunk setting or set it to `0`. Use the message
chunk budget to control readability while preserving the complete answer.

Slack questions have the following separate input allowance.

<Markdown src="operational-limits-tables/slack-question-settings.md" />

This is DocsFab's qualified full-message capacity, not an asserted Slack inbound
limit. It preserves 40,000 four-byte Unicode characters. The event, combined
frozen inputs, and worker request reserve the actual JSON framing and escaping
space needed for that question. Questions over the configured allowance name
the byte count, limit, and next action. Reference repository files instead of
pasting additional material that does not fit.

A Slack question that names no `target=` reads only the documentation pages
that best match it. The following settings bound how many pages it approves and
how much of their text reaches the model.

<Markdown src="operational-limits-tables/slack-question-index-settings.md" />

Each approved page gets its whole text or an equal share of the per-question
allowance, so no page arrives as a few bytes. The answer names the approved
pages, marks any page passed only in part, and, when more pages matched, says
how many. The model's evidence and the run record show the same cut, and the
model can read the rest with its read tool.

You can continue using the same thread without a lifetime turn quota. Hosted
Slack turns remain one-shot jobs: include the required context in each question
or reference repository files. Submit the next question after the active turn
settles; duplicate Slack deliveries do not create another job.

The complete terminal record still must fit the existing 4 MiB read envelope,
including metadata. Citation metadata retains every approved path cited in the
answer. The separate runtime replay format has a 32 KiB, six-exchange window:
when an exchange does not fit, it is omitted whole and the next model prompt
reports the omission. The complete answer remains available for Slack delivery.
