---
title: Conduct a Product-Model Interview in DocsFab
description: Conduct a bounded, consent-aware interview that captures missing intent and tests an emerging product model.
status: draft
---

Use a DocsFab product-model interview when existing evidence does not provide
enough intent, rationale, terminology, audience information, or system
relationships for the selected documentation target. For more information,
refer to [About DocsFab Workflows](index.md).

The current entry point is the agent-executed `interview-product-model` skill.
The interview captures one participant's model. It does not establish product
truth or merge the participant's claims into a shared model.

## What You Will Produce

Create one interview directory for one participant with these artifacts:

```text
interviews/YYYY-MM-DD-<participant>-<topic>/
├── plan.md
├── transcript.md
├── claims.md
└── model-snapshot.md
```

The transcript is the canonical record of what the participant said. The plan,
claim records, and participant-only model snapshot are derived views that link
to exact transcript evidence. Register the interview as a separate item in the
participant's stable source thread.

## In This Guide

Use the following links to prepare, conduct, close, and verify the interview:

- [Prerequisites](#prerequisites)
- [Conduct the Interview](#conduct-the-interview)
- [Close and Register the Interview](#close-and-register-the-interview)
- [Verify the Result](#verify-the-result)
- [Next Steps](#next-steps)

<a id="before-you-begin"></a>

## Prerequisites

Establish the product, version, model region, target documentation, known gaps,
participant identity, role, and possible authority by claim kind. Do not infer
authority from seniority or confidence. Register the sources and known gaps
that motivate the interview, but keep the provisional synthesis hidden until
free recall is complete.

Choose a text or voice capture channel and obtain explicit agreement for
attribution, citation, retention, access, and the transcript boundary before
substantive questioning. For voice, record whether audio exists, where it is
retained, and whether the transcript is raw, corrected, or best effort. Do not
imply that voice is being recorded when only transcription is available.

Create the interview plan, transcript, claim record, and model snapshot in the
repository-authorized interview directory. Assign a stable `source_thread_id`
to the participant and a distinct `item_id` to the interview. Keep one
participant in each interview source item.

If the participant does not agree to a citable record, do not create an
interview artifact from the conversation.

## Conduct the Interview

Complete the following steps during the bounded interview session.

<Steps>
  <Step title="Invite free recall">
    Invite free recall by asking the participant to explain the bounded topic
    in their own words before presenting the current model.
  </Step>
  <Step title="Ask one question at a time">
    Ask one question at a time. Follow information gaps and contradictions
    rather than completing a fixed questionnaire mechanically.
  </Step>
  <Step title="Capture the transcript">
    Capture each question and answer in the append-only transcript. Preserve
    participant-initiated additions, corrections, challenges, requests,
    approvals, and refusals as their own ordered events. Label paraphrases,
    and do not invent a question to make an event fit a question-and-answer
    schema.
  </Step>
  <Step title="Separate claim kinds">
    Separate what the participant says the product does, what they intend it
    to do, and what they believe another source means. Record the scope,
    directness, and self-reported confidence of each consequential claim. Do
    not treat role or confidence as behavior verification.
  </Step>
  <Step title="Reflect the emerging model">
    Reflect the emerging model periodically with a concise paraphrase, table,
    state diagram, flowchart, or component relationship diagram.
  </Step>
  <Step title="Ask what the reflection gets wrong">
    Ask the participant what the reflection gets wrong, oversimplifies, or
    omits. Preserve corrections as later interactions with direction and
    sequence.
  </Step>
  <Step title="Challenge consequential claims">
    Challenge consequential claims with edge cases, competing sources, or
    version boundaries. Route behavior questions to code, tests, or runtime
    evidence when appropriate.
  </Step>
  <Step title="Stop at the question budget">
    Stop at the question budget in the interview plan. Extend the interview
    only with participant agreement, or record remaining gaps for another
    session.
  </Step>
</Steps>

## Close and Register the Interview

Complete these steps to close the interview without promoting its claims into
the shared model:

<Steps>
  <Step title="Review claims with the participant">
    Review the captured claims and representation with the participant.
    Record confirmation, correction, dispute, or refusal without changing
    unrelated behavior or intent states.
  </Step>
  <Step title="Register the transcript">
    Register the transcript and derived claim artifacts in the participant's
    source thread, then make them available for synthesis with other
    independently inspectable evidence.
  </Step>
</Steps>

## Verify the Result

Confirm that the interview record contains the following:

- Participant identity, role, and authority hypothesis.
- Capture channel, consent, retention, and access boundary.
- Ordered questions, answers, reflections, corrections, and challenges.
- Exact participant content or an explicit paraphrase label.
- Separate representation, behavior, intent, and model states.
- Open questions, contradictory evidence, and next acquisition actions.

An interview can confirm a participant's mental model. It cannot establish
that the mental model matches the current implementation without independent
behavior evidence.

## Next Steps

After the interview passes verification:

<Steps>
  <Step title="Confirm registry validation">
    Confirm that `register-source-thread` validation passes, the registry
    delta identifies each retained representation, and prior thread items
    remain inspectable and unchanged.
  </Step>
  <Step title="Verify behavior claims">
    Verify behavior claims against the applicable product version, code,
    tests, or runtime observation.
  </Step>
  <Step title="Route intent and terminology decisions">
    Route intent and terminology decisions to an accountable authority when
    the participant does not own them.
  </Step>
  <Step title="Reconcile the source threads">
    [Reconcile the source threads](reconcile-source-threads.md) to compare the
    participant snapshot with other evidence and issue a new candidate model
    version when the conflict queue permits it.
  </Step>
</Steps>

## Related Topics

Use these topics to understand the evidence, registry, and model boundaries
that apply after the interview:

<CardGroup cols={2}>
  <Card
    title="A Result Grants No Authority"
    href="/about/core-concepts/documentation-jobs"
  >
    [A Result Grants No Authority](../about/core-concepts/documentation-jobs.md#a-result-grants-no-authority)
  </Card>
  <Card
    title="Source-Thread Registry in DocsFab"
    href="/reference/knowledge-and-delivery/knowledge/source-thread-registry"
  >
    [Source-Thread Registry in DocsFab](../reference/knowledge-and-delivery/knowledge/source-thread-registry.md)
  </Card>
  <Card
    title="Product Knowledge"
    href="/about/core-concepts/product-knowledge"
  >
    [Product Knowledge in DocsFab](../about/core-concepts/product-knowledge.md)
  </Card>
</CardGroup>
