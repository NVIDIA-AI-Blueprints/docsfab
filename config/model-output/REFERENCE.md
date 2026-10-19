# Model Output Rule Catalog

This reference describes the source catalog for host-enforced model output rules. A model reply, tool-call argument, and staged artifact are all model output. For the recorded rules and their operator guidance, refer to the [runtime model output rule reference](../../packages/runtime/docs/reference/contracts/model-output-rules.md).

The catalog owns the facts about a rule: its code, where it can be raised,
whether the model may correct it, the sentence the model sees, its failure
class, and what the operator does next. The predicate that detects a
violation stays in the validator that owns it.

## Files

| Path | `kind` | Holds |
| --- | --- | --- |
| `rules/<family>.yaml` | `docsfab-output-rules` | The rules one validator family raises |
| `grammars.yaml` | `docsfab-output-grammars` | Shared grammars for values a model authors or cites |
| `retry-policy.yaml` | `docsfab-retry-policy` | Replay modes and their hint suffixes for step retry and provider-turn replay |
| `recorded-codes.yaml` | `docsfab-recorded-codes` | Every code ever recorded, append-only, with the pinned security and authority codes |
| `contracts/<id>.yaml` | `docsfab-response-contract` or `docsfab-prose-step` | One reply contract: its shape, the rules it states, and host blocks |
| `../model-output-allowlist.json` | - | Reviewed exceptions to the gate, each with a rationale |

Each file declares `schemaVersion: 1`. Use block YAML only: the generator
runs before `npm ci` and falls back to a subset parser that refuses anything
the npm `yaml` parser could read differently, such as quoted scalars, flow
collections other than `[]` and `{}`, anchors, tabs, floats, `True`, a plain
scalar containing `:` followed by a space, and more-indented lines in a folded scalar. Write
sentences as folded `>-` scalars.

## Rule Families

A family file declares `family` (its file name), `rules`, and optionally:

- `replay`: the replay mode of the step that raises these codes. The mode's
  `statement` in `retry-policy.yaml` closes every retry hint of the family.
- `recordedPrefix`: the prefix every code of the family carries, such as
  `revision-accounting-`.
- `uses`: codes another family declares that this family's validator also
  raises. Each entry is a `code`, with optional extra `locations` and
  `atLocation` sentences for those locations. `RuleCodeOf<F>` includes them.
- `hostText`: host-authored sentences that are not rules, each an `id` and a
  `text`, such as fallback correction guidance.

A rule record has these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `code` | yes | The recorded kebab-case code, unique across the catalog and within the recorded code grammar (`inference.rejectionSegmentLength` characters). |
| `pattern`, `members` | no | `pattern: true` makes `code` a prefix ending in `-` and `members` the closed list of suffixes. The generator expands one record per member, so the code union stays closed. One fixture covers the family. |
| `locations` | yes | Contract locations where the code can be raised, within the recorded location grammar, such as `$` or `$.issueAccounting[].issueId`. |
| `kind` | yes | `syntax`, `shape`, `content`, `size`, `authority`, `disclosure`, `integrity`, or `host`. |
| `retry` | yes | `model-correctable` or `terminal`. The last four kinds must be `terminal`; the generator refuses anything else. |
| `reason` | yes | One sentence on why the rule has that retry disposition. |
| `failureClass`, `failureClassReason` | no | A class from `packages/runtime/src/operator/failure-class.ts`, with a one-sentence reason. Defaults by kind: `syntax` and `shape` are `contract-shape`; `content`, `authority`, and `disclosure` are `model-content`; `size` is `bound`. `integrity` and `host` must declare one. |
| `statement` | yes, except `host` rules and the catch-all | The model-facing rule sentence. The contract states it, and a correctable rejection repeats it as the retry hint. It may use `{limit:<name>}` and `{grammar:<id>}`, never a literal number. A `host` rule and the catch-all are never stated to the model and must not have one. |
| `hint` | no | `atLocation` maps a declared location to a sentence that replaces `statement` there. `hostDetail` names a host-rendered detail. |
| `outer` | no | The outer code this code is recorded under as an inner reason. Inner and outer must agree on whether they are terminal. |
| `catchAll` | no | `true` for the one `unknown` record: correctable, `failureClass: unknown`, no statement, exempt from stated-rule reach. |
| `aliases` | no | Earlier recorded spellings of this code, decoded on read only. |
| `operator` | yes | `kind` (`correct`, `recover`, `redirect`, `supply`, or `resume`), `meaning`, and `next`. |
| `fixtures` | yes | At least one rejected reply under `packages/runtime/test/fixtures/model-output/` that fires the code at a declared location. |
| `docs` | yes | The anchor in the generated reference: the code, without a trailing `-`. |

## Recorded Codes and Pins

Recorded codes live in run records, so a code keeps its spelling for as long
as those records exist.
`recorded-codes.yaml` lists every code the catalog has declared. The
generator refuses a declared code that is missing from it, and a listed code
that is neither declared nor in some rule's `aliases`. Append new codes; never
delete an entry. To rename a code, list the old spelling in the new rule's
`aliases`.

An entry with `pinned: disclosure` or `pinned: authority` fixes that code's
kind. The rule that declares it, or that aliases it after a rename, must keep
that kind and stay terminal. Anything else is a `pinned-code` gate finding.
Separately, a new code whose name contains a security or authority stem, such
as `credential` or `source-locator-membership`, must be kind `disclosure` or
`authority` (`pinned-terminal`).

## Contracts

A response contract names its `bindings` (workflow and step), the rule
families whose decoder reads the reply (`decoders`), its `shape` (the
model-authored fields only), and `render`, the contract text in order:

- `rule: <code>` renders the rule's statement, or its `atLocation` sentence
  when the contract's shape holds that location;
- `host: <name>` with a `label` renders a block the binder supplies from sealed
  host input;
- `note:` renders a fixed sentence.

Every stated rule of a decoder family that can be raised inside the shape must
be rendered, and every location a stated rule declares must lie inside some
contract's shape. A `docsfab-prose-step` declares a step whose reply no host
code parses, with `rationale`, `owner`, and `revisit`.

`outputMode` is `text-final`, `submit-tool` (the whole-answer tool), or
`records`. A contract without `canonical` may list `hostMinted` as plain field
names; none of them may appear in its shape.

## Records-Mode Contracts

A contract that declares `canonical` is a records-mode declaration. The model submits small judgment records, and the host
assembles the canonical artifact from them. The declaration classifies every
member of that artifact as exactly one of:

- a model record field;
- host-minted (`hostMinted`);
- host-derived by a named rule (`derive`);
- resolved by reference (`references` with `field`);
- composed from ordered host and model parts (`compose`).

It states no `title`, `shape`, or `render`: the generator builds each record's
shape from the canonical members. `config/model-output/contracts/quality-evaluation.yaml`
is the step 8 declaration.

| Field | Meaning |
| --- | --- |
| `canonical` | `members`: each canonical member, as a schema file under `packages/quality/schemas/`, or `keys:<set>` from the response-contract key registry (`src/execution/response-contract-keys.js`), with `nested` naming the key set under each nested location. `profile` is the profile selector, a host input. |
| `skeleton` | Named host inputs that enumerate fixed keys, never literals. |
| `records[]` | `type`; `from` (`<member>#<JSON pointer>`, `<member>#keys:<set>`, or `none`); `at` (the canonical locations it fills); `key` (`singleton`, `host-serial`, or `skeleton:<name>+<name>`, paired in order with `at`); `open` with `closedBy: <type>.<flag>`; `optional` with `default: empty`; `nullable`; `narrow` (record-relative member to source); `add` (record-only fields, each `{schema: <pointer>, array: true}`, `{enum: <source>, array: true}`, or `{const: <value>}`; `array` is optional). |
| `hostMinted[]` | `{field, source}`; `ledger.record-key` and `ledger.finding-order` are the ledger key of the record holding the member. |
| `derive[]` | `{field, rule: <owner>:<rule>, reads}`. `{<selector>}` in `field` splits one member by key, such as `$.evaluation.constraints.{required}.applicability`. |
| `references[]` | `{field or part, namespace, source: step:<step>.<artifact>, ids, unresolved}`. A `part` reference is a compose host part, written `reference:<part>`. |
| `compose[]` | `{field, parts}`: an ordered list of `{host: <owner>:<rule> or reference:<part>}` and `{model: <type>.<field>}` parts. A model part names an `add` field or the record's own field at that member. A model item byte-identical to a host item is dropped and counted. |
| `limits` | Limit names only: `openRecords`, `refusalsPerKey`, `recordBytes`, `messageBytes`. |

A location is `$`-rooted: `.name`, `.*` (every key), `.{selector}` (the keys a
selector picks), and `[]` (array items). Host inputs, selectors, and the
earlier-step artifacts a reference may name are registered in
`scripts/check-model-output.mjs` (`ANSWER_RECORD_HOST_INPUTS`,
`ANSWER_RECORD_SELECTORS`, `ANSWER_RECORD_STEP_ARTIFACTS`). A rule is
implemented once by its owner: `quality:*` rules in
`packages/quality/checks/quality_decision_policy.py` (`RULES`), and `runtime:*`
rules in `packages/runtime/src/contracts/derivations/`.

The generator refuses a records-mode declaration that fails any check:

| Check | Refuses |
| --- | --- |
| G1 | A generated record shape that holds a member `hostMinted`, `derive`, `references`, or `compose` owns, except the record's own field a compose entry names as its model part. A member owned for some keys only is listed as conditional. |
| G2 | A `from`, `at`, or `field` that does not resolve in the canonical members, or an `at` that does not hold the record's `from`; an `add` field that collides with a member of `from`; an `add` value in none of the three forms. |
| G3 | A skeleton, source, narrowing, or selector that is not registered; a `reference:<part>` with no `references[]` part; a narrowing to an undeclared reference namespace; a rule another owner owns. |
| G4 | A canonical member, at any depth and split by selector, with no owner or more than one. A member inherits the owner of its nearest claimed ancestor; only a record's members can be carved out by another class. |
| G5 | A literal number in `limits` or in a narrowing. |
| G6 | An open set without `closedBy` (a `const: true` add field) and an `openRecords` limit; an optional record without a default. |

The generated runtime and knowledge mirrors carry each records-mode contract in
`OUTPUT_RECORD_CONTRACTS`: its record types with one generated JSON Schema
shape per `at` location, and its host-minted, derived, referenced, and composed
members. `DerivationRuleOf<C>` and `HostMintedSourceOf<C>` type the rules and
sources a contract names. `src/harness/answer-records.ts` reads only this table
and its caller's host inputs.

## Generated Outputs

`packages/runtime/scripts/check-model-output.mjs` renders:

- `packages/runtime/src/contracts/model-output.generated.ts`: `OUTPUT_RULES`,
  the families, aliases, host text, grammars, replay modes, and contracts; the
  `OutputRuleCode`, `RuleCodeOf<F>`, `CorrectableCodeOf<F>`,
  `TerminalCodeOf<F>`, `LocationOf<C>`, and `HostDetailOf<C>` types; and the
  raise functions `rejectOutput`, `rejectCorrectable`, and `rejectTerminal`.
  An undeclared code, or a location not declared for that code, does not
  compile, and `rejectTerminal` accepts only a terminal code of its family.
- `packages/knowledge/src/model-output.generated.mjs`: the same tables in plain
  JavaScript for the knowledge package.
- `packages/runtime/src/execution/response-contract-vocabulary.generated.json`:
  the response-contract key vocabulary.
- [`packages/runtime/docs/reference/contracts/model-output-rules.md`](../../packages/runtime/docs/reference/contracts/model-output-rules.md):
  the rule reference.

`packages/runtime/src/contracts/model-output.ts` reads the generated table:
contract text, retry hints, retry disposition, and failure classes.

## Commands and Checks

Run from `packages/runtime`:

```bash
npm run generate:model-output   # write every generated output
npm run check:model-output      # drift, coverage, and conformance
```

- **Drift** (`--check`): every generated output is byte-identical to a fresh
  generation. `runtime:derived:preflight` and `npm run check:pins` run it.
- **Coverage** (every run): every field is present and valid; the kind bounds
  the retry disposition; inner and outer codes agree; every code, alias, and
  location satisfies the recorded grammars; every recorded code is still
  declared or aliased; every fixture exists and records its code at a declared
  location; every stated rule a contract can raise is rendered; grammar
  examples hold, and every `flowsInto` edge is a subset in first-character
  class, rest class, and `maxLength`. The Vitest suite
  `test/model-output-catalog.test.ts` runs every fixture through its family's
  real decoder.
- **Conformance** (`--gate`, in `npm run check:static`):
  - `numeric-literal`: a number in a model-facing sentence;
  - `pinned-code` and `pinned-terminal`: see above;
  - `hand-written-row`: a catalog code, or a prefixed family's bare diagnostic
    code, keyed as an object property or a `Map` entry outside generated
    files;
  - `legacy-table`: a hand-written retry table, hint or correction catalog, or
    failure-class table, as an object literal or a `Map`, named `*_RETRYABILITY`,
    `*_RETRY`, `*_RETRY_TABLE`, `*_RULE_HINTS`, `*_RULES`, `*_HINTS`,
    `*_CORRECTIONS`, `*_REJECTION_CLASSES`, or `*_FAILURE_CLASSES`;
  - `grammar-literal`: a declared grammar's pattern outside generated files;
  - `skill-shape`: a contract's host key, quoted enum value, or illustrative
    grammar example in its bound step prompt or skill files.

Every finding needs an entry in `config/model-output-allowlist.json` with a
rationale. An entry that no longer matches a finding fails the gate, so the
allowlist only shrinks as families migrate. The table detector uses naming and
row heuristics: a differently named table whose keys are not catalog codes can
escape it. The freeze is enforced for migrated families and is review guidance
for the others.
