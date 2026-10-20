---
name: reflect-model-delta
description: Reflect a small, evidence-linked change in an emerging participant or shared product model as concise prose, a targeted table, or an FMC-inspired Mermaid diagram, then elicit and preserve human corrections without implying factual verification or approval. Use during product-model interviews, reconciliation, or model review when an agent must test whether it represented a person's model accurately.
license: Apache-2.0 AND CC-BY-4.0
---

# Reflect Model Delta

Turn a small set of new or changed claims into a correction-seeking model view.
The reflection tests representation; it does not establish product truth.

Read [reflection-contract.md](references/reflection-contract.md) before writing
a packet. Read [projection-patterns.md](references/projection-patterns.md) when
a diagram could expose a relationship, boundary, state, or sequence error.

For a registered source case, bind the offered statement and scope to the full
prior claim-record digest and the exact source versions. A current, verified
owner decision for that exact offer can be reused without asking again.
Follow [Native Product Feedback Materialization](../converge-documentation/references/product-feedback-materialization.md)
when turning the decision into model and document candidates. Confirmation of
representation alone does not supply that decision authority.

## Check the inputs

Require:

- Participant or accountable reviewer identity and role.
- The bounded model region being tested.
- Claim IDs and exact evidence links for every reflected statement.
- The prior snapshot or an explicit statement that this is the first view.
- Known uncertainty, contradictions, and scope.

If a proposed statement has no claim or evidence link, label it as an agent
inference or omit it. Do not smuggle an inference into polished prose.

## Choose the smallest useful projection

Use prose only when it can test the model without hiding relationships. Add a
table or diagram only when it creates a specific correction opportunity.

| Question being tested | Preferred projection |
| --- | --- |
| Did I capture one to three atomic claims? | Concise prose plus claim list |
| Are two terms equivalent or distinct? | Concept table or small concept map |
| Who acts, stores information, or can read/write it? | FMC-inspired block view |
| In what order do actors interact? | Mermaid sequence diagram |
| Which states and transitions exist? | Mermaid state or flow view |
| Where does a decision branch by scope or condition? | Decision table or flowchart |
| Which sources or participants conflict? | Contradiction table |

Do not generate a diagram merely to make the reflection look complete.

## Build the reflection packet

Produce one packet for one coherent model delta:

1. Label it **Provisional reflection for correction**.
2. State the interview question or model region.
3. Write **What I heard** in attributed language.
4. List the added, changed, superseded, or still-open claim IDs.
5. Separate **Agent inferences and uncertainties** from participant claims.
6. Add the smallest useful projection and a claim-to-element trace table.
7. State scope, version, and known contradictions beside the projection.
8. Ask first: **What is wrong, missing, or misleading here?**
9. Ask one targeted challenge question about a boundary, counterexample,
   failure, or impossible transition.

Never ask only “Is this correct?” A fluent diagram and a yes/no prompt invite
passive assent.

## Process the response

When the participant responds:

1. Preserve the response verbatim in the interview transcript or review
   record.
2. Classify it as confirmed representation, correction, addition, scope
   change, uncertainty, declined assessment, or challenge result.
3. Update derived claims by appending a new version or superseding relation.
   Do not rewrite the evidence that led to the earlier view.
4. Update only `speaker_confirmation` when the participant confirms the
   reflection. Do not change behavior-verification, intent-approval, or
   canonical state without the appropriate evidence or authority.
5. Record which prose sentence, table row, node, edge, boundary, or state
   changed.
6. Show the revised delta when the correction is consequential. Do not repeat
   the whole model.

If the participant confirms their representation but disputes the product's
current behavior, preserve both facts.

## Diagram rules

- Label every view provisional and name the model version or checkpoint.
- Keep each diagram focused enough to discuss node by node or edge by edge.
- Use text or line patterns, not color alone, for uncertain and disputed
  elements.
- Map every meaningful element to one or more claim IDs below the diagram.
- Keep Mermaid labels short, unquoted, and on one line.
- Split a large diagram rather than shrinking or simplifying away ambiguity.
- Treat Mermaid syntax success as rendering evidence only, never semantic
  validation.
- Render the diagram with the same pinned renderer, theme, and approximate
  viewport used by the review surface. A parser exit code is not a visual QA
  result.
- Inspect the image itself for readable labels, distinct paths, unclipped
  content, spatial grouping, and a salient answer to the question the diagram
  is meant to test. Do not rely on color alone.
- Record `syntax_rendered`, `visually_legible`, and
  `conceptually_understood` separately. The first can be machine-verified; the
  latter two require human evidence.
- Ask the model source whether the projection represents their view, then test
  comprehension with a representative unfamiliar reader. Source approval
  does not establish novice comprehension.
- If a rendered diagram is illegible, preserve the rejected version or its
  receipt, record the visual failure, and revise the representation without
  changing claim status.

If a diagram fails to render, surface the error and repair it before showing
the packet. Do not replace the diagram silently with prose and claim that the
reflection was tested.

## Completion criteria

A reflection checkpoint is complete only when the record contains:

- The exact packet shown.
- The participant's exact response.
- Claim and projection changes caused by the response.
- The representation status of the bounded region.
- Remaining behavioral checks, authority decisions, contradictions, or open
  questions.

Do not promote a participant snapshot into a shared model. Reconciliation and
canonicalization are separate capabilities.
