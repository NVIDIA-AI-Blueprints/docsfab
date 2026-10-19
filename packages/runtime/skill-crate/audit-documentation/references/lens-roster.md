# Audit Lens Roster

## Minimum roster

Use each applicable lens for documentation-set scope. One qualified provider
may cover related lenses, but must return distinct findings for each lens. A
target-audience exercise needs a context that has not seen the documentation,
product-model oracle, authoring rationale, or prior findings.

| Lens | Primary questions | Principal coverage | Preferred provider |
| --- | --- | --- | --- |
| Technical verifier | Are consequential claims accurate, current, complete for scope, and grounded in approved sources? | Trustworthy information; safety and security | Engineer, technical reviewer, or clean technical agent with approved evidence |
| Product-model verifier | Do explanations preserve canonical components, relationships, invariants, boundaries, rationale, and uncertainty? | Conceptual fidelity, purpose, rationale, and visual explanation | Product-model steward or clean model-fidelity agent |
| Senior editor | Is the prose clear, coherent, concise, consistent, inclusive, and compliant with the selected style profile? | Clarity, terminology, editorial style, and audience fit | Senior technical editor or clean editorial agent |
| Information architect | Can readers predict where information lives, navigate without unsupported paths, and retrieve the authoritative topic? | Information architecture, findability, orientation, and delivery integrity | Information architect or clean retrieval and navigation agent |
| Task and recovery evaluator | Can a reader infer how to complete, verify, diagnose, and recover from realistic tasks? | Functional validity and effective-experience proxies | Independent operator or clean task-oriented agent |
| Target-audience participant | What mental model and intended behavior does the documentation actually produce? | Mental-model transfer and calibrated confidence | Representative human and separately configured clean agent |
| Constraint reviewer | Are accessibility, inclusion, privacy, security, policy, support, and localization requirements represented appropriately? | Cross-layer constraints | Qualified specialist or explicitly bounded clean reviewer |

## Lens contracts

Give every provider the frozen target, allowed delivery surface, declared
audience, prerequisites, outcomes, risk boundary, assigned dimensions, and only
the approved evidence needed for that lens. Require evidence, severity,
confidence, affected scope, and an acceptance condition. Instruct the provider
to report defects without rewriting the target.

Technical and product-model providers may inspect authoritative evidence.
Audience participants must not receive the private product model, answer key,
prior findings, or authoring context. Editors may receive style and terminology
profiles but must not treat personal preference as a defect.

## Coverage and independence

Create one coverage-matrix row per required dimension and constraint. Record
the provider, method, target paths, sample rule, evidence class, and result
locator. Uncovered rows remain `not-assessed`; do not hide them behind a broad
persona.

Record authorship, prior synthesis, provider, context, and known exposure in
the review manifest. A contaminated context is not a clean review merely
because it receives a new persona name. These declarations expose review
provenance; they do not prove isolation. Production context attestation and
evidence binding remain Beta work.
