# Projection Patterns

Choose a view because it exposes a possible error, not because it is visually
appealing.

## Concept relationship

```mermaid
flowchart LR
    A[Workspace] -->|owns| B[Routing policy]
    A -->|owns| C[Credentials]
    A -->|records| D[Audit history]
```

Ask whether the concepts, verbs, direction, and ownership boundary match the
participant's model.

## FMC-inspired composition

Use rectangles for active agents, circles for passive stores, dotted arrows
for reads, and solid arrows for writes.

```mermaid
flowchart LR
    Creator[Product creator]
    Interviewer[Product-model interviewer]
    Transcript((Transcript))
    Claims((Attributed claims))

    Creator -->|answer| Interviewer
    Interviewer -->|write| Transcript
    Transcript -.->|read| Interviewer
    Interviewer -->|derive| Claims
```

Ask who can read or write each store, which channel is missing, and whether a
store has been mistaken for an actor.

## Sequence

```mermaid
sequenceDiagram
    participant P as Participant
    participant I as Interviewer
    participant R as Record
    I->>P: Ask free recall question
    P->>I: Explain model region
    I->>R: Preserve transcript and claims
    I->>P: Show provisional delta
    P->>I: Correct representation
    I->>R: Append correction
```

Ask whether the order is possible, which step can repeat, and where an
approval or wait is missing.

## State or decision boundary

```mermaid
flowchart LR
    Raw[Raw answer] --> Derived[Provisional claims]
    Derived --> Reflected[Reflected to participant]
    Reflected -->|correction| Revised[Revised participant model]
    Reflected -->|representation confirmed| Confirmed[Speaker confirmed]
    Confirmed -.->|does not imply| Verified[Behavior verified]
```

Ask which transitions are forbidden, who can authorize each transition, and
whether confirmation has been confused with verification.

## Rendering constraints

- Use bare, single-line labels without quotes, Markdown, `<br>`, or `\n`.
- Keep identifiers simple and unique.
- Put detail in a table below the diagram rather than long node labels.
- For complex diagrams, split by model region. Use ELK layout only when the
  target renderer supports Mermaid frontmatter configuration.
- Explain uncertain or disputed elements in text; do not rely on color.
