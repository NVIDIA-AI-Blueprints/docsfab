# Ready fixture

This repository is a deterministic fixture for DocsFab's repository-readiness
workflow. Maintainers use it to verify that documentation agents can discover
the project's purpose, validation command, source of truth, and contribution
rules.

Run `npm test` to validate the fixture. `package.json` is the source of truth
for supported commands. See `AGENTS.md` before changing documentation.
