---
name: interview-product-model
description: Elicit one participant's product mental model through an adaptive text or voice interview while preserving verbatim evidence, scope, uncertainty, and separate representation, behavior-verification, and intent-approval states. Use when interviewing a product creator, engineer, operator, product manager, or documentation owner to create an attributed participant-model snapshot for later comparison or shared-model work.
license: Apache-2.0 AND CC-BY-4.0
---

# Interview Product Model

Elicit an attributed model from one participant. Preserve what the participant
said separately from derived claims. Do not treat confidence, confirmation, or
consensus as proof of product truth.

Read [artifact-contract.md](references/artifact-contract.md) before creating
or updating interview artifacts.

## Establish the interview boundary

Before the first substantive question:

1. Name the product, version, model region, and reason for the interview.
2. Record the participant's identity, role, relationship to the product, and
   possible authority by claim kind. Do not call someone an authority merely
   because they are senior or confident.
3. Register the sources and known gaps that motivated the interview. Keep the
   provisional synthesis hidden until free recall is complete.
4. Agree on the capture channel and retention boundary. For voice, state
   whether audio exists, where it is retained, and whether the transcript is
   raw, corrected, or best-effort. Never imply that voice is being recorded
   when only transcription is available.
5. Create the four artifacts before continuing:
   `plan.md`, `transcript.md`, `claims.md`, and `model-snapshot.md` under
   `interviews/YYYY-MM-DD-<participant>-<topic>/`.

If the participant does not agree to a citable record, do not create an
interview artifact from the conversation. A normal uncited conversation is
not a substitute.

### Attach the interview item to a source lineage

Assign a stable `source_thread_id` for the identifiable origin and a separate
`item_id` for this interview. A person's thread can contain multiple
interviews, authored documents, corrections, and later decisions. The thread
is the lineage; the interview is one item within it.

Retain item-level author, contributors, capture time, version, scope, consent,
channel, and evidence state. Do not create a new person thread for every
session, and do not flatten multiple sessions into one current transcript.

If an artifact is cross-authored, preserve one stable artifact identity and
explicit contributor relations. Do not imply that every contributor asserted
every extracted claim. If the origin cannot be established, keep the artifact
in a standalone source thread until attribution is verified. Use
`$register-source-thread` when the lineage or item is not yet registered.

For a synthetic evaluation, label every answer and artifact as a test fixture,
store it with the pilot or evaluation rather than real interviews, and assign
it no participant or product authority. Never present a simulation as human
evidence.

## Ask for the participant's model first

Start with free recall. Ask one open question that lets the participant choose
their own concepts and boundaries, for example:

> Walk me through how this part of the product works and why it exists, using
> the distinctions you think matter.

Ask one question at a time. Reshape each next question from the prior answer.
Avoid a prepared questionnaire when it would prevent following a consequential
distinction.

Do not initially show:

- Another participant's model.
- A polished end-to-end diagram.
- Multiple-choice answers unless the answer space is genuinely closed.
- A proposed explanation that the participant can merely endorse.

## Run the elicitation loop

For each consequential answer:

1. Capture the question and answer verbatim in `transcript.md`. Preserve false
   starts and corrections when the channel provides them. Label a paraphrase
   as a paraphrase; never format reconstructed wording as a quote.
2. Ask for scope: product version, deployment, audience, workflow, time
   period, and exceptions.
3. Ask what the participant knows directly, observed, recalls, inferred, or
   heard from another person.
4. Ask for self-reported confidence using words, not invented percentages.
5. Extract the smallest independent provisional claims into `claims.md` and
   link each one to exact transcript evidence.
6. Classify each claim as behavior, intent, decision, rationale, hypothesis,
   non-goal, term, constraint, experience, or open question.
7. Keep these states separate:
   - `speaker_confirmation`
   - `behavior_verification`
   - `intent_approval`
   - `model_state`
8. After a coherent conceptual cluster or a material change, use
   `$reflect-model-delta`. Do not reflect after every sentence.
9. Challenge the account with one concrete scenario, boundary case,
   counterexample, failure, or impossible transition.
10. Record resulting corrections as new evidence. Never rewrite the earlier
    transcript or silently replace the earlier claim.

### Preserve participant-initiated interactions

The participant may introduce a concept, challenge the agent, request an
application of the emerging model, correct a public surface, or approve a
projection without answering an interviewer question. Preserve the actor,
direction, interaction kind, exact content, sequence, and related claim IDs.

Do not force participant-to-agent evidence into a question-answer record or
invent an interviewer prompt to satisfy a narrower storage schema. If the
control plane cannot represent the interaction faithfully, preserve it in the
append-only transcript, record the schema gap, and stop before writing a
misattributed event.

## Probe the regions that matter

Select probes based on the bounded topic rather than forcing every interview
through the same list:

- Purpose, audience, value, and success.
- Concepts, relationships, terminology, and boundaries.
- Actors, stores, channels, permissions, and ownership.
- States, triggers, sequence, waits, retries, and failure behavior.
- Supported workflows, variants, exceptions, and non-goals.
- Intended behavior versus implemented or observed behavior.
- Rationale, tradeoffs, alternatives, and historical constraints.
- Sources or people likely to contradict or refine the account.

Use correction-oriented follow-ups:

- What is wrong or missing from that interpretation?
- Where would that explanation break?
- Which version or deployment does that apply to?
- Is that current behavior, intended behavior, or both?
- What did you observe directly, and what are you inferring?
- Who would describe this differently, and why?
- What evidence would change your mind?

## Close with a model review

End when the bounded region is saturated, the participant asks to stop, or a
blocking dependency belongs with another source or authority.

1. Present a compact final delta, not one imposing comprehensive model.
2. Ask the participant to correct the representation of their view.
3. Record what they confirmed, corrected, declined to assess, or left
   unresolved.
4. List behavioral checks, intent decisions, other participants, and sources
   needed next.
5. Write a receipt naming the artifacts produced, model region covered,
   elapsed participant time when known, manual interventions, and unresolved
   items.

Participant confirmation may change only `speaker_confirmation`. It must not
silently change `behavior_verification`, `intent_approval`, or `model_state`.

## Refuse false canonicalization

Do not:

- Promote participant claims directly into a shared model.
- Merge multiple participants into one interview artifact.
- Convert silence or politeness into confirmation.
- Resolve a contradiction through majority vote.
- Treat a working implementation as proof of approved product scope.
- Treat an intent statement as proof of current behavior.
- Hide uncertainty to make the model read cleanly.

Stop on an artifact-write failure, missing consent for the intended capture,
or loss of transcript provenance. Surface the error instead of continuing with
an unauditable interview.
