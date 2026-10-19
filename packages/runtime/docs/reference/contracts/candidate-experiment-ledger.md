# Candidate experiment ledger contracts

Closed-schema identity for bounded candidate keep/discard / plateau stopping
under autonomous documentation experiments (`#226`). This is **not** the catalog
`evaluate` WorkflowStepKind owned by epic `#254` / investigation `#256`.

## Kinds

| Kind | Digest field | Role |
| --- | --- | --- |
| `docsfab-candidate-evaluation-vector` | `evaluationSha256` | Objective gates + quality vector |
| `docsfab-candidate-evaluator-record` | `recordSha256` | Evaluator identity, policy, inputs, commands run, results, independence |
| `docsfab-candidate-baseline` | `baselineSha256` | Source checkout + selected candidate baseline |
| `docsfab-candidate-attempt` | `attemptSha256` | Isolated disposable candidate attempt |
| `docsfab-candidate-keep-discard-decision` | `decisionSha256` | Lexicographic keep/discard |
| `docsfab-candidate-experiment-budget` | `budgetSha256` | Attempt/time/token/cost ceilings |
| `docsfab-candidate-plateau-policy` | `policySha256` | Consecutive non-improving limit |
| `docsfab-candidate-terminal-state` | `terminalSha256` | Bounded terminal (`budget-exhausted`, `plateau`, …) |
| `docsfab-candidate-experiment-ledger` | `ledgerSha256` | Append-only attempt/decision ledger |

## Lexicographic policy

Objective dimensions (`factual`, `citation`, `security`, `scope`, `mechanical`)
are hard gates. A failure always discards. Quality dimensions
(`clarity`, `coverage`, `style`) compare only after every objective gate passes;
style cannot offset an objective regression.

## Terminals

Budget exhaustion and plateau are successful **bounded** terminals
(`boundedSuccess: true`). They do not fabricate quality success. Identical
replay of the same attempt/decision digests does not duplicate ledger entries.

Decoders live under `src/autonomy/` (`decodeCandidateAttempt`,
`decodeCandidateKeepDiscardDecision`, `decodeCandidateExperimentLedger`,
`decodeCandidateTerminalState`).
