# Example and Drift Checks

Use for executable examples or a change to a public interface. Select only
applicable rows; add evidence to the existing required-fact inventory rather
than creating a second audit. Stay within the approved sources and target.

| Surface | Compare with authoritative evidence |
| --- | --- |
| Imports and SDK calls | Canonical public import, actual symbol, positional/keyword parameters, supported package version. When authorized and already available, installed-version signature inspection can supplement source. Do not install a package or import code with side effects without authority. |
| JSON or API examples | Exact field names, nesting, value types, required/optional fields, and request versus response schema. A plausible example is not schema evidence. |
| CLI and configuration | Parser flags, defaults, override precedence, working directory, path resolution, and whether code adds a prefix already present in the example. |
| Complete procedure | Setup, placeholders and how to obtain values, imports, variables passed between blocks, ordered actions, expected output, and relevant cleanup/recovery. |
| Changed interface | Added, removed, renamed, or mismatched flags, fields, defaults, versions, service names, and metrics in the affected documentation. Confirm reader impact before requiring new prose. |

Check the installed version only when it is the declared target environment.
Source signatures and mock tests do not prove installed-package behavior.
Separate static inspection, schema validation, and executed behavior. Preserve
missing execution as a limitation rather than erasing a source-established
mismatch or fabricating an observed error message.

When verifying a correction, compare its exact candidate passage with the
originating fact and finding. Inspect adjacent clauses and affected examples
for lost conditions or changed semantics. Retain unresolved or regressed
originating IDs in the existing evidence fields. A changed snippet is not proof
that the whole procedure now works.
