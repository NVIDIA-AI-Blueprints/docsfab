# Discovery report data contract

The discovery test families share the version 0.2 serialized data vocabulary in
`contract.ts`. A family supplies a `DiscoveryRunIndex` and an independently
authored `DiscoveryExpectedManifest`. The manifest declares the family and its
finite result IDs, invariants, kinds, required invocation counts, native JUnit
testcase tuples, and required assertion IDs.

`validateDiscoveryRunIndex` checks the supplied inventory, nonnegative counts,
result outcomes, required identity strings, JUnit tuple identities, assertion
IDs, and lexical safety of relative artifact references. It also prevents a
passed index from containing failed, incomplete, zero-case, or shortfall
results. Property invocation counts remain separate from JUnit testcase counts:
one property result with 100 generated invocations identifies one native JUnit
testcase.

Validation does not execute tests or inspect Git, the filesystem, retained
artifacts, JUnit XML contents, hashes, or tool versions. A valid index therefore
does not prove runtime correctness, source provenance, or that the reported
execution occurred. The fixtures in the contract test are synthetic validator
inputs only.

Run the dependency-free contract controls at the Node 24.21.0 runtime floor:

```bash
node --test test/discovery-report-contract.test.mjs
```

Run the same controls through normal Vitest discovery and its native JUnit
reporter:

```bash
npm exec -- vitest run test/discovery-report-contract.test.mjs \
  --reporter=default --reporter=junit --outputFile.junit=/tmp/discovery-junit.xml
```

This suite belongs to the ordinary Vitest shards. Task #815 consumes this
validator and owns property execution, replay, and report production in
`replay.ts`. Task #818 owns verification of external artifact, JUnit, and
identity evidence. Those later components must not introduce a competing
validator or treat validation of supplied data as external evidence.
